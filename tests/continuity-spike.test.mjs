import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  checkpointTask,
  handoffTask,
  resumeTask,
  startTask,
  taskStatus
} from "../src/continuity/task-service.mjs";
import {
  acquireRepository,
  parseGitHubRepository,
  workRepository
} from "../src/continuity/workspace-service.mjs";
import { buildInteractiveInvocation, launchTask } from "../src/continuity/agent-launcher.mjs";

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function fixtureRepository() {
  const directory = await mkdtemp(join(tmpdir(), "aiviron-continuity-"));
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Aiviron Test");
  await git(directory, "config", "user.email", "aiviron@example.invalid");
  await writeFile(join(directory, "app.mjs"), "export const value = 1;\n");
  await git(directory, "add", "app.mjs");
  await git(directory, "commit", "-m", "initial fixture");
  return directory;
}

async function capsuleValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
  addFormats(ajv);
  const common = JSON.parse(await readFile(join(root, "schemas", "v1alpha1", "common.schema.json"), "utf8"));
  const capsule = JSON.parse(await readFile(join(root, "schemas", "v1alpha1", "handoff-capsule.schema.json"), "utf8"));
  ajv.addSchema(common);
  ajv.addSchema(capsule);
  return ajv.getSchema(capsule.$id);
}

test("task start creates an isolated branch and survives a fresh status read", async (t) => {
  const repo = await fixtureRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const started = await startTask({
    cwd: repo,
    objective: "Fix checkout timeout",
    agent: "codex",
    clock: () => new Date("2026-07-18T16:00:00.000Z")
  });

  assert.equal(started.task.currentAgent, "codex");
  assert.match(started.task.taskId, /^tsk_[a-f0-9]{32}$/);
  assert.match(started.task.repository.branch, /^aiviron\/fix-checkout-timeout-/);
  assert.equal(started.task.status, "in_progress");

  const reloaded = await taskStatus({ cwd: repo });
  assert.equal(reloaded.task.taskId, started.task.taskId);
  assert.equal(reloaded.snapshot.dirty, false, "Aiviron local state must not dirty the user's worktree");
  assert.equal(reloaded.drifted, false);
});

test("checkpoint emits a schema-valid content-addressed capsule", async (t) => {
  const repo = await fixtureRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await startTask({ cwd: repo, objective: "Fix checkout timeout", agent: "codex" });
  await writeFile(join(repo, "app.mjs"), "export const value = 2;\n");

  const result = await checkpointTask({
    cwd: repo,
    summary: "Implemented timeout guard",
    completed: ["Reproduced the timeout", "Implemented the guard"],
    nextActions: ["Add a regression test"],
    decisions: ["Keep the timeout at the service boundary"],
    clock: () => new Date("2026-07-18T16:10:00.000Z")
  });

  assert.equal(result.checkpoint.repository.dirty, true);
  assert.match(result.checkpoint.repository.dirtyDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.task.nextActions[0], "Add a regression test");

  const validate = await capsuleValidator();
  assert.equal(validate(result.capsule), true, JSON.stringify(validate.errors));
  for (const artifact of result.capsule.artifacts) {
    const hex = artifact.ref.digest.slice("sha256:".length);
    const bytes = await readFile(join(repo, ".ai", "state", "objects", "sha256", hex.slice(0, 2), hex.slice(2)));
    assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, artifact.ref.digest);
    assert.equal(bytes.byteLength, artifact.ref.size);
  }
});

test("handoff changes the active agent and resume reconstructs operational state", async (t) => {
  const repo = await fixtureRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await startTask({ cwd: repo, objective: "Fix checkout timeout", agent: "codex" });
  await writeFile(join(repo, "app.mjs"), "export const value = 2;\n");

  const handedOff = await handoffTask({
    cwd: repo,
    to: "claude",
    summary: "Codex limit reached after implementation",
    completed: ["Implemented timeout guard"],
    nextActions: ["Add regression test", "Run the full suite"],
    failures: ["First test command used the wrong package path"],
    clock: () => new Date("2026-07-18T16:20:00.000Z")
  });

  assert.equal(handedOff.task.previousAgent, "codex");
  assert.equal(handedOff.task.currentAgent, "claude");
  assert.equal(handedOff.capsule.compatibility.sourceAdapter.id, "codex");
  assert.match(handedOff.resumePacket, /Resume Aiviron task/);
  assert.match(handedOff.resumePacket, /Current agent: claude/);
  assert.match(handedOff.resumePacket, /Add regression test/);
  assert.match(handedOff.resumePacket, /First test command used the wrong package path/);

  const resumed = await resumeTask({ cwd: repo });
  assert.equal(resumed.task.taskId, handedOff.task.taskId);
  assert.equal(resumed.drifted, false);

  await writeFile(join(repo, "test.mjs"), "// new work after handoff\n");
  const drifted = await resumeTask({ cwd: repo, agent: "opensource-local" });
  assert.equal(drifted.task.currentAgent, "opensource-local");
  assert.equal(drifted.drifted, true);
  assert.match(drifted.resumePacket, /drift since checkpoint: yes/);
});

test("a second active task is rejected instead of overwriting continuity state", async (t) => {
  const repo = await fixtureRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await startTask({ cwd: repo, objective: "First task", agent: "codex", createTaskBranch: false });
  await assert.rejects(
    startTask({ cwd: repo, objective: "Second task", agent: "claude", createTaskBranch: false }),
    /already active/
  );
});

test("GitHub repository forms are detected without treating arbitrary paths as GitHub", () => {
  assert.deepEqual(parseGitHubRepository("openai/codex"), {
    owner: "openai",
    name: "codex",
    nameWithOwner: "openai/codex"
  });
  assert.equal(parseGitHubRepository("https://example.com/openai/codex.git"), null);
  assert.equal(parseGitHubRepository("/tmp/openai/codex.git"), null);
});

test("work clones a repository and starts its durable task in one operation", async (t) => {
  const source = await fixtureRepository();
  const parent = await mkdtemp(join(tmpdir(), "aiviron-work-parent-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const result = await workRepository({
    source,
    parentDirectory: parent,
    directory: "checkout-service",
    objective: "Fix checkout timeout",
    agent: "codex"
  });

  assert.equal(result.acquisition.mode, "clone");
  assert.equal(result.acquisition.destination, join(parent, "checkout-service"));
  assert.equal(result.environment.mode, "subscription-first");
  assert.deepEqual(result.environment.agents, ["codex", "claude"]);
  assert.equal(result.task.currentAgent, "codex");
  assert.match(result.task.repository.branch, /^aiviron\/fix-checkout-timeout-/);
  assert.match(await readFile(join(result.acquisition.destination, "AGENTS.md"), "utf8"), /subscription authentication/);
  assert.match(await readFile(join(result.acquisition.destination, "CLAUDE.md"), "utf8"), /task resume --agent claude/);

  const status = await taskStatus({ cwd: result.acquisition.destination });
  assert.equal(status.task.taskId, result.task.taskId);
  assert.equal(status.snapshot.dirty, true, "the generated environment is an intentional first-task change");
});

test("repository acquisition refuses an existing destination", async (t) => {
  const source = await fixtureRepository();
  const parent = await mkdtemp(join(tmpdir(), "aiviron-existing-parent-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await assert.rejects(
    acquireRepository({ source, parentDirectory: parent, directory: "." }),
    /Destination already exists/
  );
});

test("interactive launch adapters inject the resume packet without bypassing permissions", async (t) => {
  const repo = await fixtureRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await startTask({ cwd: repo, objective: "Fix checkout timeout", agent: "codex", createTaskBranch: false });

  const codex = await launchTask({ cwd: repo, agent: "codex", dryRun: true });
  assert.equal(codex.invocation.executable, "codex");
  assert.deepEqual(codex.invocation.args.slice(0, 2), ["--cd", codex.repoRoot]);
  assert.equal(codex.invocation.args.at(-1), "<RESUME_PACKET>");
  assert.ok(!codex.invocation.args.includes("--dangerously-bypass-approvals-and-sandbox"));

  const claude = buildInteractiveInvocation({
    agent: "claude",
    repoRoot: repo,
    taskId: codex.task.taskId,
    resumePacket: codex.resumePacket
  });
  assert.equal(claude.executable, "claude");
  assert.ok(claude.args.includes("--name"));
  assert.ok(!claude.args.includes("--dangerously-skip-permissions"));

  const local = buildInteractiveInvocation({
    agent: "codex-oss",
    repoRoot: repo,
    taskId: codex.task.taskId,
    resumePacket: codex.resumePacket,
    localProvider: "ollama"
  });
  assert.deepEqual(local.args.slice(0, 4), ["--oss", "--local-provider", "ollama", "--cd"]);
});

test("the Aiviron command parses start, handoff, and machine-readable resume", async (t) => {
  const repo = await fixtureRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const cli = join(root, "bin", "aiviron.mjs");

  const started = await execFileAsync(process.execPath, [
    cli,
    "task",
    "start",
    "--objective",
    "Fix checkout timeout",
    "--agent",
    "codex",
    "--no-branch"
  ], { cwd: repo, encoding: "utf8" });
  assert.equal(JSON.parse(started.stdout).currentAgent, "codex");

  const handoff = await execFileAsync(process.execPath, [cli, "task", "handoff", "--to", "claude"], {
    cwd: repo,
    encoding: "utf8"
  });
  assert.match(handoff.stdout, /Current agent: claude/);

  const resumed = await execFileAsync(process.execPath, [cli, "task", "resume", "--json"], {
    cwd: repo,
    encoding: "utf8"
  });
  assert.equal(JSON.parse(resumed.stdout).task.currentAgent, "claude");
});

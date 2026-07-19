import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { handoffTask, resumeTask, startTask } from "../src/continuity/task-service.mjs";
import { initializeEnvironment } from "../src/environment/generator.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function fixtureRepository() {
  const directory = await mkdtemp(join(tmpdir(), "aiviron-environment-"));
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Aiviron Test");
  await git(directory, "config", "user.email", "aiviron@example.invalid");
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }, null, 2)}\n`);
  await git(directory, "add", "package.json");
  await git(directory, "commit", "-m", "initial fixture");
  return directory;
}

test("Aiviron initializes a new subscription-first Git project", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "aiviron-new-project-"));
  const target = join(parent, "checkout-service");
  t.after(() => rm(parent, { recursive: true, force: true }));

  const result = await initializeEnvironment({
    cwd: parent,
    directory: "checkout-service",
    agents: ["codex", "claude"],
    clock: () => new Date("2026-07-18T18:45:00.000Z")
  });

  assert.equal(result.repoRoot, await realpath(target));
  assert.equal(result.gitInitialized, true);
  assert.equal(result.mode, "subscription-first");
  assert.deepEqual(result.agents, ["codex", "claude"]);
  assert.equal((await git(target, "rev-parse", "--is-inside-work-tree")).stdout.trim(), "true");

  const config = await readFile(join(target, ".ai", "config.yaml"), "utf8");
  assert.match(config, /mode: subscription-first/);
  assert.match(config, /required: false/);
  assert.match(config, /enabled: false/);
  assert.match(config, /packet: \.ai\/state\/continuation\/latest\.md/);
  assert.match(config, /automaticCheckpoint: interactive-cli-exit/);
  assert.doesNotMatch(config, /api[_-]?key/i);

  const agents = await readFile(join(target, "AGENTS.md"), "utf8");
  const claude = await readFile(join(target, "CLAUDE.md"), "utf8");
  assert.match(agents, /normal installed-app\/CLI subscription authentication/);
  assert.match(agents, /task resume --agent codex/);
  assert.match(agents, /continuation\/latest\.md/);
  assert.match(claude, /task resume --agent claude/);
  assert.equal(await readFile(join(target, ".ai", ".gitignore"), "utf8"), "state/\n");
  const profilePath = join(target, ".ai", "repository", "profile.json");
  const initialProfile = await readFile(profilePath, "utf8");
  const repeated = await initializeEnvironment({
    cwd: target,
    agents: ["codex", "claude"],
    clock: () => new Date("2026-07-18T19:45:00.000Z")
  });
  assert.equal(repeated.projectId, result.projectId);
  assert.equal(await readFile(profilePath, "utf8"), initialProfile);
  assert.ok(repeated.files.every((file) => file.action === "unchanged"));
});

test("initializer preserves human instructions and remains rerunnable", async (t) => {
  const repo = await fixtureRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await writeFile(join(repo, "AGENTS.md"), "# Existing repository rules\n\nKeep this paragraph.\n");

  const initial = await initializeEnvironment({ cwd: repo, agents: ["codex", "claude"] });
  const first = await readFile(join(repo, "AGENTS.md"), "utf8");
  assert.match(first, /Existing repository rules/);
  assert.match(first, /Keep this paragraph/);
  assert.equal(first.match(/aiviron:managed:start/g)?.length, 1);

  const repeated = await initializeEnvironment({ cwd: repo, agents: ["codex", "claude"] });
  const second = await readFile(join(repo, "AGENTS.md"), "utf8");
  assert.equal(repeated.projectId, initial.projectId);
  assert.match(second, /Existing repository rules/);
  assert.equal(second.match(/aiviron:managed:start/g)?.length, 1);
});

test("dry-run plans a new project without creating the directory", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "aiviron-init-dry-run-"));
  const target = join(parent, "planned-project");
  t.after(() => rm(parent, { recursive: true, force: true }));

  const result = await initializeEnvironment({ cwd: parent, directory: "planned-project", dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.gitInitialized, true);
  await assert.rejects(readFile(join(target, ".ai", "config.yaml")), /ENOENT/);
});

test("initializer refuses generated paths that cross a symbolic link", async (t) => {
  const repo = await fixtureRepository();
  const outside = await mkdtemp(join(tmpdir(), "aiviron-init-outside-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(repo, ".ai"));
  await symlink(outside, join(repo, ".ai", "repository"));

  await assert.rejects(initializeEnvironment({ cwd: repo }), /Refusing to write through symbolic link/);
  await assert.rejects(readFile(join(outside, "profile.json")), /ENOENT/);
});

test("generated environment carries a task from Codex to Claude without API state", async (t) => {
  const repo = await fixtureRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await initializeEnvironment({ cwd: repo, agents: ["codex", "claude"] });
  await git(repo, "add", ".ai", "AGENTS.md", "CLAUDE.md");
  await git(repo, "commit", "-m", "initialize subscription agent environment");

  await startTask({ cwd: repo, objective: "Fix checkout timeout", agent: "codex" });
  await writeFile(join(repo, "checkout.mjs"), "export const timeout = 30;\n");
  const handoff = await handoffTask({
    cwd: repo,
    to: "claude",
    summary: "Codex subscription limit reached",
    completed: ["Implemented the timeout default"],
    nextActions: ["Add the regression test"]
  });
  const resumed = await resumeTask({ cwd: repo });

  assert.equal(handoff.task.currentAgent, "claude");
  assert.equal(resumed.task.currentAgent, "claude");
  assert.match(resumed.resumePacket, /Codex subscription limit reached/);
  assert.match(resumed.resumePacket, /Add the regression test/);
  assert.doesNotMatch(resumed.resumePacket, /api[_-]?key|provider credential/i);
});

test("Aiviron CLI exposes initialization and continuity commands", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "aiviron-init-cli-"));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const aiviron = join(projectRoot, "bin", "aiviron.mjs");
  const created = await execFileAsync(process.execPath, [aiviron, "created", "--agents", "codex,claude"], {
    cwd: parent,
    encoding: "utf8"
  });
  assert.equal(JSON.parse(created.stdout).mode, "subscription-first");

  const planned = await execFileAsync(process.execPath, [aiviron, "init", "planned", "--dry-run"], {
    cwd: parent,
    encoding: "utf8"
  });
  assert.equal(JSON.parse(planned.stdout).dryRun, true);

  const version = await execFileAsync(process.execPath, [aiviron, "--version"], { encoding: "utf8" });
  assert.equal(version.stdout.trim(), "0.3.0");

  const primary = await execFileAsync(process.execPath, [aiviron, "primary", "--dry-run"], {
    cwd: parent,
    encoding: "utf8"
  });
  assert.equal(JSON.parse(primary.stdout).dryRun, true);

  const help = await execFileAsync(process.execPath, [aiviron, "task", "--help"], { encoding: "utf8" });
  assert.match(help.stdout, /aiviron task handoff/);
});

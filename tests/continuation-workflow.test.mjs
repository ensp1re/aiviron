import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { continueTask, prepareContinuation, switchTask } from "../src/continuity/continuation-service.mjs";
import { sha256 } from "../src/continuity/identity.mjs";
import { checkpointTask, startTask, taskStatus } from "../src/continuity/task-service.mjs";
import { initializeEnvironment } from "../src/environment/generator.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function fixtureRepository() {
  const directory = await mkdtemp(join(tmpdir(), "aiviron-continuation-"));
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Aiviron Continuation Test");
  await git(directory, "config", "user.email", "continuation@example.invalid");
  await writeFile(join(directory, "package.json"), `${JSON.stringify({
    name: "cache-service",
    type: "module",
    scripts: { test: "node --test" }
  }, null, 2)}\n`);
  await writeFile(join(directory, "cache.js"), "export const cacheTimeoutSeconds = 60;\n\nexport function cacheEntry(value) {\n  return { value, ttl: cacheTimeoutSeconds };\n}\n");
  await writeFile(join(directory, "cache.test.js"), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { cacheEntry } from './cache.js';\ntest('uses cache timeout', () => assert.equal(cacheEntry('x').ttl, 60));\n");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "initial cache service");
  await initializeEnvironment({ cwd: directory, agents: ["codex", "claude"], clock: () => new Date("2026-07-19T12:00:00.000Z") });
  await git(directory, "add", ".ai", "AGENTS.md", "CLAUDE.md");
  await git(directory, "commit", "-m", "initialize Aiviron");
  await startTask({ cwd: directory, objective: "Change cache timeout safely", agent: "codex", createTaskBranch: false, clock: () => new Date("2026-07-19T12:01:00.000Z") });
  return directory;
}

async function continuationValidator() {
  const schemaDirectory = join(projectRoot, "schemas", "v1alpha1");
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
  addFormats(ajv);
  const common = JSON.parse(await readFile(join(schemaDirectory, "common.schema.json"), "utf8"));
  const schema = JSON.parse(await readFile(join(schemaDirectory, "continuation-manifest.schema.json"), "utf8"));
  ajv.addSchema(common);
  ajv.addSchema(schema);
  return ajv.getSchema(schema.$id);
}

test("automatic continuation combines drift-aware task state with bounded repository context", async (t) => {
  const repo = await fixtureRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await checkpointTask({
    cwd: repo,
    summary: "Baseline before timeout change",
    nextActions: ["Update the timeout and its test"],
    clock: () => new Date("2026-07-19T12:02:00.000Z")
  });
  await writeFile(join(repo, "cache.js"), "export const cacheTimeoutSeconds = 120;\n\nexport function cacheEntry(value) {\n  return { value, ttl: cacheTimeoutSeconds };\n}\n");

  const result = await prepareContinuation({
    cwd: repo,
    agent: "codex",
    budgetTokens: 1536,
    clock: () => new Date("2026-07-19T12:03:00.000Z")
  });

  assert.equal(result.manifest.drifted, true);
  assert.ok(result.manifest.budget.usedTokens <= 1536);
  assert.ok(result.manifest.budget.usedTokens <= result.manifest.budget.orchestrationTokens + result.manifest.budget.contextTokens);
  assert.equal(result.manifest.sourceCheckpointId, result.task.checkpoints.at(-1).checkpointId);
  assert.match(result.packet, /Change cache timeout safely/);
  assert.match(result.packet, /cacheTimeoutSeconds/);
  assert.match(result.packet, /Repository drift since checkpoint: yes/);
  assert.ok((await stat(result.packetPath)).size > 0);
  assert.equal(await readFile(join(repo, ".ai", "state", "continuation", "latest.md"), "utf8"), result.packet);
  const validate = await continuationValidator();
  assert.equal(validate(result.manifest), true, JSON.stringify(validate.errors));
  const latestManifest = await readFile(join(repo, ".ai", "state", "continuation", "latest.json"), "utf8");
  const linked = await checkpointTask({ cwd: repo, summary: "Checkpoint after preparing continuation" });
  assert.equal(linked.capsule.contextManifest.digest, sha256(latestManifest));
  assert.equal((await git(repo, "status", "--porcelain")).stdout, " M cache.js\n");
});

test("continue and switch preserve the writer handoff and expose safe launch previews", async (t) => {
  const repo = await fixtureRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const continued = await continueTask({ cwd: repo, agent: "codex", budgetTokens: 1536, dryRun: true });
  assert.equal(continued.launched.invocation.executable, "codex");
  assert.equal(continued.launched.invocation.args.at(-1), "<CONTINUATION_PACKET>");
  assert.equal(continued.launched.invocation.promptDelivery, "workspace-file-reference");
  assert.equal(continued.checkpoint, null);
  await assert.rejects(
    continueTask({ cwd: repo, agent: "claude", budgetTokens: 1536, dryRun: true }),
    /use aiviron switch/
  );

  const appPreview = await switchTask({ cwd: repo, to: "codex-app", budgetTokens: 1536, dryRun: true });
  assert.equal(appPreview.preview, true);
  assert.deepEqual(appPreview.launched.invocation.args, ["app", appPreview.repoRoot]);
  assert.equal(appPreview.launched.invocation.promptDelivery, "workspace-file");
  assert.equal((await taskStatus({ cwd: repo })).task.currentAgent, "codex");

  const switched = await switchTask({
    cwd: repo,
    to: "claude",
    summary: "Move timeout work to Claude",
    nextActions: ["Implement the timeout change"],
    budgetTokens: 1536,
    launch: false,
    clock: () => new Date("2026-07-19T12:04:00.000Z")
  });
  assert.equal(switched.preview, false);
  assert.equal(switched.manifest.agent, "claude");
  assert.equal(switched.handoff.task.currentAgent, "claude");
  assert.equal(switched.launched, null);
  const status = await taskStatus({ cwd: repo });
  assert.equal(status.task.currentAgent, "claude");
  assert.equal(status.task.sequence, 1);
  assert.equal(status.task.checkpoints.at(-1).summary, "Move timeout work to Claude");
});

test("public CLI exposes one-command continuation and non-mutating switch previews", async (t) => {
  const repo = await fixtureRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const cli = join(projectRoot, "bin", "aiviron.mjs");

  const continued = await execFileAsync(process.execPath, [cli, "continue", "--agent", "codex", "--budget", "1536", "--dry-run", "--json"], { cwd: repo, encoding: "utf8" });
  const continuation = JSON.parse(continued.stdout);
  assert.equal(continuation.agent, "codex");
  assert.equal(continuation.preview, true);
  assert.equal(continuation.invocation.args.at(-1), "<CONTINUATION_PACKET>");
  assert.ok(continuation.budget.usedTokens <= 1536);

  const previewed = await execFileAsync(process.execPath, [cli, "switch", "--to", "claude", "--budget", "1536", "--dry-run", "--json"], { cwd: repo, encoding: "utf8" });
  const preview = JSON.parse(previewed.stdout);
  assert.equal(preview.preview, true);
  assert.equal(preview.agent, "claude");
  assert.equal(preview.handoffCheckpointId, null);
  assert.equal((await taskStatus({ cwd: repo })).task.currentAgent, "codex");
});

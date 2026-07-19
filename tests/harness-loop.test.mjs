import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { compileContext } from "../src/context/compiler.mjs";
import { addContextExpansion, checkContextScope } from "../src/context/scope.mjs";
import { checkpointTask, completeTask, recordTaskPlan, startTask } from "../src/continuity/task-service.mjs";
import { readCurrentTask } from "../src/continuity/store.mjs";
import { initializeEnvironment } from "../src/environment/generator.mjs";
import { verifyTask } from "../src/harness/verification.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function fixtureRepository() {
  const repo = await mkdtemp(join(tmpdir(), "aiviron-harness-"));
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Aiviron Harness Test");
  await git(repo, "config", "user.email", "harness@example.invalid");
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "package.json"), `${JSON.stringify({
    name: "focused-harness-fixture",
    type: "module",
    scripts: { test: "node -e \"process.exit(0)\"" }
  }, null, 2)}\n`);
  await writeFile(join(repo, "src", "selected.js"), "export const selected = 1;\n");
  await writeFile(join(repo, "src", "unrelated.js"), "export const unrelated = 1;\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial fixture");
  await initializeEnvironment({ cwd: repo, agents: ["codex"] });
  await git(repo, "add", ".ai", "AGENTS.md");
  await git(repo, "commit", "-m", "initialize Aiviron");
  return repo;
}

test("closed context scope blocks unrelated changes and allows explicit expansion", async (t) => {
  const repo = await fixtureRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await startTask({
    cwd: repo,
    objective: "Update the selected module",
    agent: "codex",
    acceptanceCriteria: ["The selected export equals 2"],
    files: ["src/selected.js"],
    createTaskBranch: false
  });
  const context = await compileContext({ cwd: repo, budgetTokens: 1024 });
  assert.equal(context.manifest.scope.mode, "closed");
  assert.ok(context.manifest.scope.files.some((entry) => entry.path === "src/selected.js" && entry.access === "read-write"));

  await writeFile(join(repo, "src", "selected.js"), "export const selected = 2;\n");
  assert.equal((await checkContextScope({ cwd: repo })).ok, true);

  await writeFile(join(repo, "notes.txt"), "outside scope\n");
  const blocked = await checkContextScope({ cwd: repo });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.violations, ["notes.txt"]);
  await assert.rejects(checkpointTask({ cwd: repo }), /outside the active context scope/);

  await addContextExpansion({ cwd: repo, file: "notes.txt", reason: "Task requires a migration note" });
  await compileContext({ cwd: repo, budgetTokens: 1024 });
  assert.equal((await checkContextScope({ cwd: repo })).ok, true);
});

test("plan, verification evidence, criteria, and completion form a gated task loop", async (t) => {
  const repo = await fixtureRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const started = await startTask({
    cwd: repo,
    objective: "Update the selected module",
    agent: "codex",
    acceptanceCriteria: ["The selected export equals 2"],
    files: ["src/selected.js"],
    createTaskBranch: false
  });
  const planned = await recordTaskPlan({ cwd: repo, steps: ["Change the selected export", "Run verification"] });
  await compileContext({ cwd: repo, budgetTokens: 1024 });
  await writeFile(join(repo, "src", "selected.js"), "export const selected = 2;\n");

  await assert.rejects(completeTask({ cwd: repo }), /Acceptance criteria are still pending/);
  const verification = await verifyTask({ cwd: repo });
  assert.equal(verification.receipt.status, "passed");
  assert.equal(JSON.parse(await readFile(verification.receiptPath, "utf8")).contextId, verification.task.contextScope.contextId);

  await checkpointTask({
    cwd: repo,
    summary: "Implementation and verification complete",
    completedCriteria: [started.task.acceptanceCriteria[0].id],
    completedSteps: planned.task.plan.steps.map((step) => step.id)
  });
  await writeFile(join(repo, "src", "selected.js"), "export const selected = 2; // final formatting\n");
  await assert.rejects(completeTask({ cwd: repo }), /changed after the latest successful verification/);
  await verifyTask({ cwd: repo });
  const completed = await completeTask({ cwd: repo });
  assert.equal(completed.task.status, "completed");
  assert.equal(completed.task.phase, "complete");
  await assert.rejects(readCurrentTask(repo), /No active Aiviron task/);
});

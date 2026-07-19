import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { checkContextScope, assertScopeCheck } from "../context/scope.mjs";
import { repositorySnapshot, resolveRepositoryRoot } from "../continuity/git.mjs";
import { opaqueId } from "../continuity/identity.mjs";
import { readCurrentTask, statePaths, writeJsonAtomic } from "../continuity/store.mjs";

const execFileAsync = promisify(execFile);

function active(task) {
  return task.status === "in_progress" || task.status === "active";
}

async function configuredCommands(repoRoot) {
  try {
    const profile = JSON.parse(await readFile(join(repoRoot, ".ai", "repository", "profile.json"), "utf8"));
    return profile.commands || [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function invocation(command) {
  const match = command.match(/^(npm|pnpm|bun) run ([A-Za-z0-9:_-]+)$/);
  if (match) return { executable: match[1], args: ["run", match[2]] };
  const yarn = command.match(/^yarn ([A-Za-z0-9:_-]+)$/);
  if (yarn) return { executable: "yarn", args: [yarn[1]] };
  throw new Error(`Verification command is not safely executable by Aiviron: ${command}`);
}

function selectCommands(commands, requested) {
  const byName = new Map(commands.map((entry) => [entry.name, entry]));
  if (requested?.length) {
    return requested.map((name) => {
      const entry = byName.get(name);
      if (!entry) throw new Error(`Unknown verification check: ${name}`);
      return entry;
    });
  }
  const preferred = ["test", "lint", "typecheck", "type-check", "check", "build"];
  return preferred.filter((name) => byName.has(name)).map((name) => byName.get(name));
}

export async function verifyTask({ cwd = process.cwd(), checks = [], clock = () => new Date() } = {}) {
  const repoRoot = await resolveRepositoryRoot(cwd);
  const task = await readCurrentTask(repoRoot);
  if (!active(task)) throw new Error(`Task ${task.taskId} is ${task.status}, not active`);
  assertScopeCheck(await checkContextScope({ cwd: repoRoot, task }));
  const selected = selectCommands(await configuredCommands(repoRoot), checks);
  if (!selected.length) throw new Error("No verification commands were detected; add a project script or complete with --waive-verification <reason>");

  const startedAt = clock().toISOString();
  const results = [];
  for (const check of selected) {
    const run = invocation(check.command);
    const commandStartedAt = clock().toISOString();
    try {
      const result = await execFileAsync(run.executable, run.args, {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true
      });
      results.push({
        name: check.name,
        command: check.command,
        status: "passed",
        exitCode: 0,
        startedAt: commandStartedAt,
        finishedAt: clock().toISOString(),
        output: `${result.stdout || ""}${result.stderr || ""}`.slice(-12000)
      });
    } catch (error) {
      results.push({
        name: check.name,
        command: check.command,
        status: "failed",
        exitCode: Number.isInteger(error.code) ? error.code : 1,
        startedAt: commandStartedAt,
        finishedAt: clock().toISOString(),
        output: `${error.stdout || ""}${error.stderr || ""}${error.message || ""}`.slice(-12000)
      });
      break;
    }
  }

  const receipt = {
    receiptId: opaqueId("ver"),
    taskId: task.taskId,
    startedAt,
    finishedAt: clock().toISOString(),
    status: results.length === selected.length && results.every((result) => result.status === "passed") ? "passed" : "failed",
    contextId: task.contextScope.contextId,
    repository: await repositorySnapshot(repoRoot, task.projectId),
    results
  };
  task.verification ||= { status: "not_run", receipts: [], waiver: null };
  task.verification.status = receipt.status;
  task.verification.receipts.push(receipt);
  task.phase = receipt.status === "passed" ? "review" : "execution";
  task.updatedAt = receipt.finishedAt;
  const paths = statePaths(repoRoot);
  const receiptPath = join(paths.tasks, task.taskId, "evidence", `${receipt.receiptId}.json`);
  await writeJsonAtomic(receiptPath, receipt);
  await writeJsonAtomic(join(paths.tasks, task.taskId, "task.json"), task);
  await writeJsonAtomic(paths.current, task);
  return { repoRoot, task, receipt, receiptPath };
}

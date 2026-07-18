import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createBranch,
  currentBranch,
  gitDirectory,
  originUrl,
  repositorySnapshot,
  resolveRepositoryRoot,
  workingPatch
} from "./git.mjs";
import { opaqueId, sha256, slugify, stableOpaqueId } from "./identity.mjs";
import { putObject, readCurrentTask, statePaths, writeJsonAtomic, writeTextAtomic } from "./store.mjs";

const schemaVersion = "are-task-state/v1alpha1";
const runtimeVersion = "0.1.0";

function now(clock) {
  return clock().toISOString();
}

async function ensureLocalStateExcluded(repoRoot) {
  const resolvedGitDir = resolve(repoRoot, await gitDirectory(repoRoot));
  const excludePath = join(resolvedGitDir, "info", "exclude");
  await mkdir(join(resolvedGitDir, "info"), { recursive: true });
  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!current.split(/\r?\n/).includes(".ai/state/")) {
    await appendFile(excludePath, `${current && !current.endsWith("\n") ? "\n" : ""}.ai/state/\n`);
  }
}

function unique(values) {
  return [...new Set((values || []).map((value) => value.trim()).filter(Boolean))];
}

export async function startTask({ cwd = process.cwd(), objective, agent, branch, createTaskBranch = true, clock = () => new Date() }) {
  if (!objective?.trim()) throw new Error("Task objective is required");
  if (!agent?.trim()) throw new Error("Agent identifier is required");
  const repoRoot = await resolveRepositoryRoot(cwd);
  await ensureLocalStateExcluded(repoRoot);

  try {
    const active = await readCurrentTask(repoRoot);
    if (active.status === "in_progress") {
      throw new Error(`Task ${active.taskId} is already active; resume or finish it before starting another task`);
    }
  } catch (error) {
    if (!/No active Arenv task exists/.test(error.message)) throw error;
  }

  const remote = await originUrl(repoRoot);
  const projectId = stableOpaqueId("prj", remote || repoRoot);
  const before = await repositorySnapshot(repoRoot, projectId);
  if (before.dirty) throw new Error("Refusing to start a task in a dirty worktree; checkpoint or stash existing changes first");

  const taskId = opaqueId("tsk");
  let selectedBranch = await currentBranch(repoRoot);
  if (createTaskBranch) {
    selectedBranch = branch || `are/${slugify(objective)}-${taskId.slice(-8).toLowerCase()}`;
    await createBranch(repoRoot, selectedBranch);
  }

  const createdAt = now(clock);
  const task = {
    schemaVersion,
    projectId,
    taskId,
    objective: objective.trim(),
    status: "in_progress",
    repository: {
      remote,
      root: repoRoot,
      branch: selectedBranch
    },
    currentAgent: agent.trim(),
    sessionId: opaqueId("ses"),
    sequence: 0,
    createdAt,
    updatedAt: createdAt,
    completed: [],
    nextActions: [],
    decisions: [],
    failures: [],
    checkpoints: []
  };
  const paths = statePaths(repoRoot);
  task.resumePath = join(paths.tasks, taskId, "resume.md");
  await writeJsonAtomic(join(paths.tasks, taskId, "task.json"), task);
  await writeJsonAtomic(paths.current, task);
  await writeTextAtomic(task.resumePath, renderResumePacket(task));
  return { repoRoot, task };
}

async function storeArtifacts(repoRoot, task, checkpoint, patch) {
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const entries = {
    objective: await putObject(repoRoot, `# Objective\n\n${task.objective}\n`, "text/markdown"),
    state: await putObject(repoRoot, json({ task, checkpoint }), "application/json"),
    changes: await putObject(repoRoot, patch, "text/x-diff"),
    evidence: await putObject(repoRoot, json({ repository: checkpoint.repository, summary: checkpoint.summary }), "application/json"),
    decisions: await putObject(repoRoot, json(task.decisions), "application/json"),
    failures: await putObject(repoRoot, json(task.failures), "application/json"),
    contextManifest: await putObject(repoRoot, json({ version: "continuity-spike/v1", sources: ["task", "git", "checkpoint"] }), "application/json"),
    nextActions: await putObject(repoRoot, json(task.nextActions), "application/json"),
    permissions: await putObject(repoRoot, json({ transferable: false, note: "Destination must reauthorize all effects." }), "application/json"),
    environment: await putObject(repoRoot, json({ platform: process.platform, arch: process.arch, node: process.version }), "application/json")
  };
  return entries;
}

function capsuleArtifacts(entries) {
  const names = {
    objective: "objective",
    state: "state",
    changes: "changes",
    evidence: "evidence",
    decisions: "decisions",
    failures: "failures",
    contextManifest: "context-manifest",
    nextActions: "next-actions",
    permissions: "permissions",
    environment: "environment"
  };
  return Object.entries(names).map(([field, name]) => ({ name, ref: entries[field] }));
}

export async function checkpointTask({
  cwd = process.cwd(),
  summary = "Checkpoint captured",
  completed = [],
  nextActions = [],
  decisions = [],
  failures = [],
  targetAgent,
  clock = () => new Date()
} = {}) {
  const repoRoot = await resolveRepositoryRoot(cwd);
  const task = await readCurrentTask(repoRoot);
  if (task.status !== "in_progress") throw new Error(`Task ${task.taskId} is ${task.status}, not in_progress`);

  task.completed = unique([...task.completed, ...completed]);
  task.nextActions = nextActions.length ? unique(nextActions) : task.nextActions;
  task.decisions = unique([...task.decisions, ...decisions]);
  task.failures = unique([...task.failures, ...failures]);
  task.sequence += 1;
  task.updatedAt = now(clock);

  const repository = await repositorySnapshot(repoRoot, task.projectId);
  const checkpoint = {
    checkpointId: opaqueId("chk"),
    sequence: task.sequence,
    createdAt: task.updatedAt,
    agent: task.currentAgent,
    summary: summary.trim() || "Checkpoint captured",
    repository
  };
  const patch = await workingPatch(repoRoot);
  const entries = await storeArtifacts(repoRoot, task, checkpoint, patch);
  const capsuleId = opaqueId("cap");
  const capsule = {
    apiVersion: "dev.create-agent/capsule/v1alpha1",
    kind: "HandoffCapsule",
    capsuleId,
    createdAt: checkpoint.createdAt,
    projectId: task.projectId,
    taskId: task.taskId,
    sourceSessionId: task.sessionId,
    sourceCheckpointId: checkpoint.checkpointId,
    repository,
    compatibility: {
      minimumRuntime: runtimeVersion,
      schemas: { capsule: "v1alpha1", taskState: "v1alpha1" },
      sourceAdapter: {
        id: task.currentAgent,
        version: "native-or-wrapper",
        digest: sha256(`adapter:${task.currentAgent}`)
      }
    },
    objective: entries.objective,
    state: entries.state,
    changes: entries.changes,
    evidence: entries.evidence,
    decisions: entries.decisions,
    failures: entries.failures,
    contextManifest: entries.contextManifest,
    nextActions: entries.nextActions,
    permissions: entries.permissions,
    environment: entries.environment,
    artifacts: capsuleArtifacts(entries),
    warnings: ["Prior permissions are audit-only and must be reauthorized by the destination runtime."]
  };

  const taskDir = join(statePaths(repoRoot).tasks, task.taskId);
  const capsulePath = join(taskDir, "capsules", `${capsuleId}.json`);
  await writeJsonAtomic(capsulePath, capsule);
  checkpoint.capsuleId = capsuleId;
  checkpoint.capsulePath = capsulePath;
  task.checkpoints.push(checkpoint);
  task.latestCapsule = capsulePath;
  if (targetAgent) {
    task.previousAgent = task.currentAgent;
    task.currentAgent = targetAgent;
    task.sessionId = opaqueId("ses");
  }
  await writeJsonAtomic(join(taskDir, "task.json"), task);
  await writeJsonAtomic(statePaths(repoRoot).current, task);
  return { repoRoot, task, checkpoint, capsule, capsulePath };
}

export function renderResumePacket(task, { drifted = false, snapshot } = {}) {
  const latest = task.checkpoints.at(-1);
  const lines = [
    `# Resume Arenv task ${task.taskId}`,
    "",
    `Objective: ${task.objective}`,
    `Status: ${task.status}`,
    `Current agent: ${task.currentAgent}`,
    `Branch: ${snapshot?.branch || task.repository.branch}`,
    `Checkpoint: ${latest ? `${latest.checkpointId} (${latest.summary})` : "none"}`,
    `Repository drift since checkpoint: ${drifted ? "yes — inspect before editing" : "no"}`,
    "",
    "## Completed",
    ...(task.completed.length ? task.completed.map((item) => `- ${item}`) : ["- Nothing recorded yet."]),
    "",
    "## Next actions",
    ...(task.nextActions.length ? task.nextActions.map((item) => `- ${item}`) : ["- Inspect the objective and current Git state, then choose the next verified action."]),
    "",
    "## Decisions",
    ...(task.decisions.length ? task.decisions.map((item) => `- ${item}`) : ["- None recorded."]),
    "",
    "## Known failures",
    ...(task.failures.length ? task.failures.map((item) => `- ${item}`) : ["- None recorded."]),
    "",
    "## Resume contract",
    "- Verify the current Git diff and relevant tests before making new changes.",
    "- Treat prior permissions as audit history; reauthorize effects in this runtime.",
    "- Continue this task unless the user gives a newer objective.",
    ...(snapshot ? ["", `Current revision: ${snapshot.head}`, `Dirty worktree: ${snapshot.dirty}`] : [])
  ];
  return `${lines.join("\n")}\n`;
}

export async function taskStatus({ cwd = process.cwd() } = {}) {
  const repoRoot = await resolveRepositoryRoot(cwd);
  const task = await readCurrentTask(repoRoot);
  const snapshot = await repositorySnapshot(repoRoot, task.projectId);
  const latest = task.checkpoints.at(-1);
  const drifted = Boolean(latest && JSON.stringify(latest.repository) !== JSON.stringify(snapshot));
  return { repoRoot, task, snapshot, drifted };
}

export async function handoffTask({ cwd = process.cwd(), to, summary, completed, nextActions, decisions, failures, clock } = {}) {
  if (!to?.trim()) throw new Error("Destination agent is required");
  const result = await checkpointTask({ cwd, summary: summary || `Handoff to ${to}`, completed, nextActions, decisions, failures, targetAgent: to.trim(), clock });
  const status = await taskStatus({ cwd: result.repoRoot });
  const resumePacket = renderResumePacket(status.task, status);
  await writeTextAtomic(status.task.resumePath, resumePacket);
  return { ...result, resumePacket };
}

export async function resumeTask({ cwd = process.cwd(), agent } = {}) {
  const repoRoot = await resolveRepositoryRoot(cwd);
  let task = await readCurrentTask(repoRoot);
  if (agent?.trim() && agent.trim() !== task.currentAgent) {
    task.previousAgent = task.currentAgent;
    task.currentAgent = agent.trim();
    task.sessionId = opaqueId("ses");
    task.updatedAt = new Date().toISOString();
    await writeJsonAtomic(join(statePaths(repoRoot).tasks, task.taskId, "task.json"), task);
    await writeJsonAtomic(statePaths(repoRoot).current, task);
  }
  const status = await taskStatus({ cwd: repoRoot });
  const resumePacket = renderResumePacket(status.task, status);
  await writeTextAtomic(status.task.resumePath, resumePacket);
  return { ...status, resumePacket };
}

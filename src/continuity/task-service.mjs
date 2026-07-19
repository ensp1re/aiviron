import { appendFile, mkdir, readFile, unlink } from "node:fs/promises";
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
import { addContextExpansion, assertScopeCheck, checkContextScope } from "../context/scope.mjs";

const schemaVersion = "aiviron-task-state/v1alpha1";
const runtimeVersion = "0.4.0";

function isActive(task) {
  return task.status === "in_progress" || task.status === "active";
}

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

export async function startTask({
  cwd = process.cwd(),
  objective,
  agent,
  branch,
  createTaskBranch = true,
  acceptanceCriteria = [],
  constraints = [],
  files = [],
  clock = () => new Date()
}) {
  if (!objective?.trim()) throw new Error("Task objective is required");
  if (!agent?.trim()) throw new Error("Agent identifier is required");
  const repoRoot = await resolveRepositoryRoot(cwd);
  await ensureLocalStateExcluded(repoRoot);

  try {
    const active = await readCurrentTask(repoRoot);
    if (isActive(active)) {
      throw new Error(`Task ${active.taskId} is already active; resume or finish it before starting another task`);
    }
  } catch (error) {
    if (!/No active Aiviron task exists/.test(error.message)) throw error;
  }

  const remote = await originUrl(repoRoot);
  const projectId = stableOpaqueId("prj", remote || repoRoot);
  const before = await repositorySnapshot(repoRoot, projectId);
  if (before.dirty) throw new Error("Refusing to start a task in a dirty worktree; checkpoint or stash existing changes first");

  const taskId = opaqueId("tsk");
  let selectedBranch = await currentBranch(repoRoot);
  if (createTaskBranch) {
    selectedBranch = branch || `aiviron/${slugify(objective)}-${taskId.slice(-8).toLowerCase()}`;
    await createBranch(repoRoot, selectedBranch);
  }

  const createdAt = now(clock);
  const criteria = unique(acceptanceCriteria.length ? acceptanceCriteria : [`Objective is implemented and verified: ${objective.trim()}`]);
  const task = {
    schemaVersion,
    projectId,
    taskId,
    objective: objective.trim(),
    status: "in_progress",
    phase: "planning",
    constraints: unique(constraints),
    acceptanceCriteria: criteria.map((text, index) => ({
      id: stableOpaqueId("ac", `${taskId}:${index}:${text}`),
      text,
      status: "pending",
      evidence: []
    })),
    plan: { status: "pending", steps: [] },
    verification: { status: "not_run", receipts: [], waiver: null },
    contextScope: { mode: "closed", files: [], expansions: [] },
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
  for (const file of unique(files)) {
    await addContextExpansion({ cwd: repoRoot, file, reason: "Selected when the task was created", clock });
  }
  const currentTask = files.length ? await readCurrentTask(repoRoot) : task;
  return { repoRoot, task: currentTask };
}

async function storeArtifacts(repoRoot, task, checkpoint, patch) {
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  let contextManifest = json({ version: "continuity-fallback/v1", sources: ["task", "git", "checkpoint"] });
  try {
    contextManifest = await readFile(join(repoRoot, ".ai", "state", "continuation", "latest.json"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const entries = {
    objective: await putObject(repoRoot, `# Objective\n\n${task.objective}\n`, "text/markdown"),
    state: await putObject(repoRoot, json({ task, checkpoint }), "application/json"),
    changes: await putObject(repoRoot, patch, "text/x-diff"),
    evidence: await putObject(repoRoot, json({ repository: checkpoint.repository, summary: checkpoint.summary }), "application/json"),
    decisions: await putObject(repoRoot, json(task.decisions), "application/json"),
    failures: await putObject(repoRoot, json(task.failures), "application/json"),
    contextManifest: await putObject(repoRoot, contextManifest, "application/json"),
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
  completedCriteria = [],
  completedSteps = [],
  targetAgent,
  clock = () => new Date()
} = {}) {
  const repoRoot = await resolveRepositoryRoot(cwd);
  const task = await readCurrentTask(repoRoot);
  if (!isActive(task)) throw new Error(`Task ${task.taskId} is ${task.status}, not active`);
  assertScopeCheck(await checkContextScope({ cwd: repoRoot, task }));

  task.completed = unique([...task.completed, ...completed]);
  task.nextActions = nextActions.length ? unique(nextActions) : task.nextActions;
  task.decisions = unique([...task.decisions, ...decisions]);
  task.failures = unique([...task.failures, ...failures]);
  const satisfiedCriteria = markRecords(task.acceptanceCriteria || [], completedCriteria, "acceptance criterion");
  markRecords(task.plan?.steps || [], completedSteps, "plan step");
  if (task.plan?.steps?.length) task.plan.status = task.plan.steps.every((step) => step.status === "completed") ? "completed" : "active";
  task.phase = task.verification?.status === "passed" ? "review" : task.plan?.status === "completed" ? "verification" : "execution";
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
  const verificationReceiptId = task.verification?.receipts?.filter((receipt) => receipt.status === "passed").at(-1)?.receiptId;
  for (const criterion of satisfiedCriteria) {
    criterion.evidence ||= [];
    criterion.evidence.push({ checkpointId: checkpoint.checkpointId, ...(verificationReceiptId ? { verificationReceiptId } : {}) });
  }
  const patch = await workingPatch(repoRoot);
  const entries = await storeArtifacts(repoRoot, task, checkpoint, patch);
  const capsuleId = opaqueId("cap");
  const capsule = {
    apiVersion: "dev.aiviron/capsule/v1alpha1",
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
    `# Resume Aiviron task ${task.taskId}`,
    "",
    `Objective: ${task.objective}`,
    `Status: ${task.status}`,
    `Phase: ${task.phase || "execution"}`,
    `Current agent: ${task.currentAgent}`,
    `Branch: ${snapshot?.branch || task.repository.branch}`,
    `Checkpoint: ${latest ? `${latest.checkpointId} (${latest.summary})` : "none"}`,
    `Repository drift since checkpoint: ${drifted ? "yes — inspect before editing" : "no"}`,
    "",
    "## Completed",
    ...(task.completed.length ? task.completed.map((item) => `- ${item}`) : ["- Nothing recorded yet."]),
    "",
    "## Acceptance criteria",
    ...((task.acceptanceCriteria || []).length ? task.acceptanceCriteria.map((item) => `- [${item.status === "satisfied" ? "x" : " "}] ${item.id}: ${item.text}`) : ["- None recorded."]),
    "",
    "## Execution plan",
    ...((task.plan?.steps || []).length ? task.plan.steps.map((item) => `- [${item.status === "completed" ? "x" : " "}] ${item.id}: ${item.text}`) : ["- No plan recorded yet. Use aiviron task plan --step <text>."]),
    "",
    "## Context scope",
    `- Mode: ${task.contextScope?.mode || "closed"}`,
    `- Context: ${task.contextScope?.contextId || "not compiled"}`,
    `- Writable files: ${(task.contextScope?.files || []).filter((item) => item.access === "read-write").map((item) => item.path).join(", ") || "none"}`,
    "- Do not inspect or edit repository files outside this scope. Expand with: npx aiviron context add --file <path> --reason <why>",
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
    "- Read the compiled packet, then work only with files in its closed context scope.",
    "- Run npx aiviron context check before checkpoint, handoff, verification, or completion.",
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

function markRecords(records, selectors, label) {
  const marked = [];
  for (const selector of unique(selectors)) {
    const record = records.find((item) => item.id === selector || item.text === selector);
    if (!record) throw new Error(`Unknown ${label}: ${selector}`);
    record.status = label === "plan step" ? "completed" : "satisfied";
    record.completedAt = new Date().toISOString();
    marked.push(record);
  }
  return marked;
}

export async function recordTaskPlan({ cwd = process.cwd(), steps = [], clock = () => new Date() } = {}) {
  const repoRoot = await resolveRepositoryRoot(cwd);
  const task = await readCurrentTask(repoRoot);
  if (!isActive(task)) throw new Error(`Task ${task.taskId} is ${task.status}, not active`);
  const planned = unique(steps);
  if (!planned.length) throw new Error("At least one --step is required");
  task.plan = {
    status: "active",
    steps: planned.map((text, index) => ({ id: stableOpaqueId("step", `${task.taskId}:${index}:${text}`), text, status: "pending" }))
  };
  task.phase = "execution";
  task.updatedAt = now(clock);
  const paths = statePaths(repoRoot);
  await writeJsonAtomic(join(paths.tasks, task.taskId, "task.json"), task);
  await writeJsonAtomic(paths.current, task);
  await writeTextAtomic(task.resumePath, renderResumePacket(task));
  return { repoRoot, task };
}

export async function completeTask({ cwd = process.cwd(), waiveVerification, clock = () => new Date() } = {}) {
  const repoRoot = await resolveRepositoryRoot(cwd);
  const task = await readCurrentTask(repoRoot);
  if (!isActive(task)) throw new Error(`Task ${task.taskId} is ${task.status}, not active`);
  assertScopeCheck(await checkContextScope({ cwd: repoRoot, task }));
  const pendingCriteria = (task.acceptanceCriteria || []).filter((item) => item.status !== "satisfied");
  if (pendingCriteria.length) throw new Error(`Acceptance criteria are still pending: ${pendingCriteria.map((item) => item.id).join(", ")}`);
  if (!(task.plan?.steps || []).length) throw new Error("Execution plan is missing; run aiviron task plan --step <text>");
  const pendingSteps = (task.plan?.steps || []).filter((item) => item.status !== "completed");
  if (pendingSteps.length) throw new Error(`Plan steps are still pending: ${pendingSteps.map((item) => item.id).join(", ")}`);
  if (task.verification?.status !== "passed") {
    if (!waiveVerification?.trim()) throw new Error("Verification has not passed; run aiviron verify or provide --waive-verification <reason>");
    task.verification ||= { status: "not_run", receipts: [], waiver: null };
    task.verification.status = "waived";
    task.verification.waiver = { reason: waiveVerification.trim(), recordedAt: now(clock) };
  } else {
    const receipt = task.verification.receipts?.filter((item) => item.status === "passed").at(-1);
    const snapshot = await repositorySnapshot(repoRoot, task.projectId);
    const fingerprint = (repository) => JSON.stringify({
      head: repository?.head,
      dirty: repository?.dirty,
      dirtyDigest: repository?.dirtyDigest || null,
      branch: repository?.branch
    });
    if (!receipt?.repository || fingerprint(receipt.repository) !== fingerprint(snapshot)) {
      throw new Error("Repository changed after the latest successful verification; run aiviron verify again");
    }
  }
  task.status = "completed";
  task.phase = "complete";
  task.completedAt = now(clock);
  task.updatedAt = task.completedAt;
  const paths = statePaths(repoRoot);
  await writeJsonAtomic(join(paths.tasks, task.taskId, "task.json"), task);
  await writeTextAtomic(task.resumePath, renderResumePacket(task));
  try {
    await unlink(paths.current);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { repoRoot, task };
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

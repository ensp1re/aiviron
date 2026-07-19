import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { compileContext } from "../context/compiler.mjs";
import { estimateTokens } from "../context/tokens.mjs";
import { buildInteractiveInvocation, launchPrompt } from "./agent-launcher.mjs";
import { stableOpaqueId } from "./identity.mjs";
import { putObject, writeJsonAtomic, writeTextAtomic } from "./store.mjs";
import { checkpointTask, handoffTask, renderResumePacket, taskStatus } from "./task-service.mjs";

const runtimeVersion = "0.4.0";
const supportedPurposes = new Set(["plan", "implement", "review", "debug", "handoff", "evaluate"]);

function continuationPrefix({ task, status, agent, purpose }) {
  const projected = { ...task, currentAgent: agent };
  return `# Aiviron automatic continuation\n\nDestination agent: ${agent}\nPurpose: ${purpose}\n\n${renderResumePacket(projected, status)}\n# Compiled repository context\n`;
}

function continuationSummary(result) {
  return {
    continuationId: result.manifest.id,
    taskId: result.manifest.taskId,
    agent: result.manifest.agent,
    purpose: result.manifest.purpose,
    drifted: result.manifest.drifted,
    budget: result.manifest.budget,
    packetPath: result.packetPath,
    manifestPath: result.manifestPath,
    contextManifestPath: result.context.manifestPath
  };
}

export async function prepareContinuation({
  cwd = process.cwd(),
  agent,
  purpose = "implement",
  budgetTokens = 4096,
  allowAgentChange = false,
  clock = () => new Date()
} = {}) {
  const budget = Number(budgetTokens);
  if (!Number.isInteger(budget) || budget < 512 || budget > 100000) throw new Error("Continuation budget must be an integer from 512 to 100000 tokens");
  if (!supportedPurposes.has(purpose)) throw new Error(`Unsupported continuation purpose: ${purpose}`);

  const status = await taskStatus({ cwd });
  if (status.task.status !== "in_progress") throw new Error(`Task ${status.task.taskId} is ${status.task.status}, not in_progress`);
  const destination = agent?.trim() || status.task.currentAgent;
  if (!destination) throw new Error("Destination agent is required");
  if (!allowAgentChange && destination !== status.task.currentAgent) {
    throw new Error(`Task belongs to ${status.task.currentAgent}; use aiviron switch --to ${destination} to preserve a handoff checkpoint`);
  }

  const prefix = `${continuationPrefix({ task: status.task, status, agent: destination, purpose })}\n`;
  const orchestrationTokens = estimateTokens(prefix);
  const contextBudget = budget - orchestrationTokens;
  if (contextBudget < 128) throw new Error(`Continuation metadata requires ${orchestrationTokens} tokens; increase --budget to at least ${orchestrationTokens + 128}`);

  const context = await compileContext({
    cwd: status.repoRoot,
    agent: destination === "codex-app" ? "codex" : destination,
    purpose,
    budgetTokens: contextBudget,
    clock
  });
  const packet = `${prefix}${context.rendering}`;
  const usedTokens = estimateTokens(packet);
  if (usedTokens > budget) throw new Error(`Compiled continuation exceeded its budget (${usedTokens}/${budget} tokens)`);

  const createdAt = clock().toISOString();
  const continuationId = stableOpaqueId("con", JSON.stringify({
    taskId: status.task.taskId,
    sequence: status.task.sequence,
    agent: destination,
    purpose,
    budget,
    contextId: context.manifest.id,
    repository: context.manifest.repository
  }));
  const [resumeRef, contextManifestRef, packetRef] = await Promise.all([
    putObject(status.repoRoot, renderResumePacket({ ...status.task, currentAgent: destination }, status), "text/markdown"),
    putObject(status.repoRoot, `${JSON.stringify(context.manifest, null, 2)}\n`, "application/json"),
    putObject(status.repoRoot, packet, "text/markdown")
  ]);
  const manifest = {
    apiVersion: "dev.aiviron/v1alpha1",
    kind: "ContinuationManifest",
    id: continuationId,
    taskId: status.task.taskId,
    createdAt,
    agent: destination,
    purpose,
    repository: context.manifest.repository,
    drifted: status.drifted,
    runtime: { id: "aiviron-continuation", version: runtimeVersion },
    budget: {
      maxTokens: budget,
      orchestrationTokens,
      contextTokens: context.manifest.budget.usedTokens,
      usedTokens
    },
    sourceCheckpointId: status.task.checkpoints.at(-1)?.checkpointId ?? null,
    resume: resumeRef,
    contextManifest: contextManifestRef,
    packet: packetRef,
    warnings: [
      ...(status.drifted ? ["Repository state has drifted since the latest checkpoint; inspect the diff before editing."] : []),
      ...(destination === "codex-app" ? ["Codex App opens the workspace; the continuation packet is delivered through .ai/state/continuation/latest.md."] : [])
    ]
  };

  const directory = join(status.repoRoot, ".ai", "state", "continuation");
  await mkdir(directory, { recursive: true });
  const manifestPath = join(directory, `${continuationId}.json`);
  const packetPath = join(directory, `${continuationId}.md`);
  await writeJsonAtomic(manifestPath, manifest);
  await writeTextAtomic(packetPath, packet);
  await writeJsonAtomic(join(directory, "latest.json"), manifest);
  await writeTextAtomic(join(directory, "latest.md"), packet);

  return { repoRoot: status.repoRoot, task: status.task, context, manifest, manifestPath, packetPath, packet };
}

async function launchContinuation(prepared, { localProvider, dryRun }) {
  const prompt = `Continue Aiviron task ${prepared.task.taskId}. Read and follow the complete continuation packet at .ai/state/continuation/latest.md before editing. Verify repository drift and reauthorize effects in this runtime.`;
  return launchPrompt({
    agent: prepared.manifest.agent,
    repoRoot: prepared.repoRoot,
    taskId: prepared.task.taskId,
    prompt,
    localProvider,
    promptDelivery: prepared.manifest.agent === "codex-app" ? "workspace-file" : "workspace-file-reference",
    dryRun,
    redaction: "<CONTINUATION_PACKET>"
  });
}

export async function continueTask({
  cwd = process.cwd(),
  agent,
  purpose,
  budgetTokens,
  localProvider,
  dryRun = false,
  launch = true,
  clock
} = {}) {
  const prepared = await prepareContinuation({ cwd, agent, purpose, budgetTokens, clock });
  if (!launch) return { ...prepared, summary: continuationSummary(prepared), launched: null, checkpoint: null, preview: false };
  const launched = await launchContinuation(prepared, { localProvider, dryRun });
  let checkpoint = null;
  if (!dryRun && launched.invocation.surface === "interactive-cli") {
    checkpoint = (await checkpointTask({
      cwd: prepared.repoRoot,
      summary: `Automatic checkpoint after ${prepared.manifest.agent} session`,
      clock
    })).checkpoint;
  }
  return { ...prepared, summary: continuationSummary(prepared), launched, checkpoint, preview: dryRun };
}

export async function switchTask({
  cwd = process.cwd(),
  to,
  summary,
  completed = [],
  nextActions = [],
  decisions = [],
  failures = [],
  purpose = "handoff",
  budgetTokens,
  localProvider,
  dryRun = false,
  launch = true,
  clock
} = {}) {
  if (!to?.trim()) throw new Error("Destination agent is required");
  const before = await taskStatus({ cwd });
  if (to.trim() === before.task.currentAgent) throw new Error(`${to.trim()} is already the current agent; use aiviron continue`);
  if (launch) {
    buildInteractiveInvocation({
      agent: to.trim(),
      repoRoot: before.repoRoot,
      taskId: before.task.taskId,
      prompt: "Aiviron launcher validation",
      localProvider
    });
  }

  if (dryRun) {
    const prepared = await prepareContinuation({ cwd, agent: to.trim(), purpose, budgetTokens, allowAgentChange: true, clock });
    const launched = launch ? await launchContinuation(prepared, { localProvider, dryRun: true }) : null;
    return { ...prepared, summary: continuationSummary(prepared), handoff: null, launched, checkpoint: null, preview: true };
  }

  const handoff = await handoffTask({ cwd, to: to.trim(), summary, completed, nextActions, decisions, failures, clock });
  const prepared = await prepareContinuation({ cwd: handoff.repoRoot, agent: to.trim(), purpose, budgetTokens, clock });
  if (!launch) return { ...prepared, summary: continuationSummary(prepared), handoff, launched: null, checkpoint: null, preview: false };

  const launched = await launchContinuation(prepared, { localProvider, dryRun: false });
  let checkpoint = null;
  if (launched.invocation.surface === "interactive-cli") {
    checkpoint = (await checkpointTask({
      cwd: prepared.repoRoot,
      summary: `Automatic checkpoint after ${prepared.manifest.agent} session`,
      clock
    })).checkpoint;
  }
  return { ...prepared, summary: continuationSummary(prepared), handoff, launched, checkpoint, preview: false };
}

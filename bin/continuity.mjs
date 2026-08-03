#!/usr/bin/env node

import {
  checkpointTask,
  completeTask,
  handoffTask,
  recordTaskPlan,
  resumeTask,
  startTask,
  taskStatus
} from "../src/continuity/task-service.mjs";
import { workRepository } from "../src/continuity/workspace-service.mjs";
import { launchTask } from "../src/continuity/agent-launcher.mjs";
import { initializeEnvironment } from "../src/environment/generator.mjs";
import { compileContext } from "../src/context/compiler.mjs";
import { inspectRepository } from "../src/intelligence/analyzer.mjs";
import { continueTask, switchTask } from "../src/continuity/continuation-service.mjs";
import { addContextExpansion, checkContextScope } from "../src/context/scope.mjs";
import { verifyTask } from "../src/harness/verification.mjs";
import { planDocumentation } from "../src/knowledge/planner.mjs";
import { checkDocumentation, generateDocumentation } from "../src/knowledge/service.mjs";

function parse(argv) {
  const [command, ...tokens] = argv;
  const options = { _: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (["no-branch", "no-launch", "json", "launch", "dry-run", "help", "explain", "no-cache", "changed"].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    index += 1;
    if (["completed", "next", "decision", "failure", "accept", "constraint", "file", "step", "criterion", "step-done", "check"].includes(key)) {
      options[key] ||= [];
      options[key].push(value);
    } else {
      options[key] = value;
    }
  }
  return { command, options };
}

function progressOptions(options) {
  return {
    summary: options.summary,
    completed: options.completed || [],
    nextActions: options.next || [],
    decisions: options.decision || [],
    failures: options.failure || [],
    completedCriteria: options.criterion || [],
    completedSteps: options["step-done"] || []
  };
}

function continuityUsage() {
  return `Aiviron continuity commands

Usage:
  aiviron init [directory] [--agents codex,claude] [--name <name>] [--dry-run]
  aiviron inspect [--json] [--no-cache]
  aiviron docs plan [--root <path>] [--json]
  aiviron docs init [--root <path>] [--dry-run] [--json]
  aiviron docs update [--root <path>] [--changed] [--dry-run] [--json]
  aiviron docs check [--root <path>] [--json]
  aiviron context build [--task <text>] [--budget <tokens>] [--for codex|claude|gemini] [--purpose <mode>] [--explain|--json]
  aiviron context add --file <path> --reason <why> [--budget <tokens>] [--for <agent>]
  aiviron context check [--json]
  aiviron verify [--check <package-script>] [--json]
  aiviron continue [--agent codex|claude|codex-app|codex-oss] [--budget <tokens>] [--purpose <mode>] [--local-provider ollama|lmstudio] [--no-launch|--dry-run] [--json]
  aiviron switch --to <agent> [--summary <text>] [--completed <text>] [--next <text>] [--budget <tokens>] [--no-launch|--dry-run] [--json]
  aiviron work <repository> --objective <text> --agent <id> [--directory <path>] [--fork auto|always|never]
  aiviron task start --objective <text> --agent <id> [--accept <criterion>] [--constraint <text>] [--file <path>] [--branch <name>] [--no-branch]
  aiviron task plan --step <text> [--step <text>]
  aiviron task status [--json]
  aiviron task checkpoint [--summary <text>] [--completed <text>] [--criterion <id>] [--step-done <id>] [--next <text>]
  aiviron task complete [--waive-verification <reason>]
  aiviron task handoff --to <agent> [--summary <text>] [--next <text>]
  aiviron task resume [--agent <id>] [--json]
  aiviron task launch --agent codex|claude|codex-oss [--local-provider ollama|lmstudio] [--dry-run]
`;
}

function renderContinuationResult(result) {
  const invocation = result.launched?.invocation;
  const handoff = result.handoff?.checkpoint;
  const automatic = result.checkpoint;
  return {
    ...result.summary,
    preview: result.preview ?? false,
    handoffCheckpointId: handoff?.checkpointId ?? null,
    invocation: invocation ?? null,
    automaticCheckpointId: automatic?.checkpointId ?? null
  };
}

function writeContinuationResult(result, json) {
  const output = renderContinuationResult(result);
  if (json || result.launched || result.handoff) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Continuation packet ready for ${output.agent}\nPacket: ${output.packetPath}\nManifest: ${output.manifestPath}\nBudget: ${output.budget.usedTokens}/${output.budget.maxTokens} tokens\n`);
}

function renderInspection(report) {
  const languages = report.languages.length ? report.languages.map((item) => `${item.name} (${item.files})`).join(", ") : "none detected";
  const commands = report.commands.length ? report.commands.map((item) => `  ${item.name}: ${item.command}`).join("\n") : "  none detected";
  return `Aiviron repository inspection\n\nRoot: ${report.repository.worktree}\nRevision: ${report.repository.head}\nBranch: ${report.repository.branch ?? "detached"}\nDirty: ${report.repository.dirty}\nFiles: ${report.inventory.indexedFiles} (${report.inventory.indexedChunks} chunks)\nSymbols: ${report.inventory.symbols}\nDependency edges: ${report.inventory.edges}\nLanguages: ${languages}\nMonorepo: ${report.shape.monorepo}\nTests: ${report.shape.hasTests}\nCI: ${report.shape.hasCi}\nContainers: ${report.shape.hasContainers}\nIndex: ${report.persisted ? report.indexPath : "in-memory"}\n\nCommands:\n${commands}\n`;
}

function renderDocumentationPlan(plan) {
  const capabilities = plan.capabilities.length ? plan.capabilities.map((item) => `  ${item.id}: ${Math.round(item.confidence * 100)}%`).join("\n") : "  none detected";
  const documents = plan.documents.map((item) => `  ${item.path}: ${item.reason}`).join("\n");
  return `Aiviron adaptive documentation plan\n\nRoot: ${plan.docsRoot}\nCapabilities:\n${capabilities}\n\nDocuments:\n${documents}\n`;
}

function renderDocumentationResult(result) {
  const files = result.files.map((item) => `  ${item.action}: ${item.path}${item.ownership === "human" ? " (human-owned)" : ""}`).join("\n");
  return `Aiviron project knowledge ${result.dryRun ? "preview" : "updated"}\n\nRoot: ${result.plan.docsRoot}\nManifest: ${result.manifestAction}\n${files}\n`;
}

function renderDocumentationCheck(result) {
  if (result.ok) return `Project knowledge is fresh (${result.summary.fresh}/${result.summary.documents} documents).\n`;
  return `Project knowledge needs attention (${result.issues.length} issues):\n${result.issues.map((item) => `  ${item.type}: ${item.document}${item.source ? ` <- ${item.source}` : ""}`).join("\n")}\n`;
}

async function main() {
  const { command, options } = parse(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(continuityUsage());
    return;
  }
  if (command === "init") {
    const result = await initializeEnvironment({
      directory: options._.shift() || ".",
      agents: options.agents?.split(","),
      name: options.name,
      dryRun: options["dry-run"]
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "work") {
    const source = options._.shift();
    const result = await workRepository({
      source,
      objective: options.objective,
      agent: options.agent,
      directory: options.directory,
      forkMode: options.fork || "auto",
      branch: options.branch
    });
    process.stdout.write(`${JSON.stringify({ acquisition: result.acquisition, environment: result.environment, task: result.task }, null, 2)}\n`);
    return;
  }
  if (command === "inspect") {
    const report = await inspectRepository({ persist: !options["no-cache"] });
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderInspection(report));
    return;
  }
  if (command === "docs") {
    const subcommand = options._.shift();
    if (subcommand === "plan") {
      const result = await planDocumentation({ docsRoot: options.root });
      process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : renderDocumentationPlan(result));
      return;
    }
    if (subcommand === "init" || subcommand === "update") {
      const result = await generateDocumentation({
        docsRoot: options.root,
        update: subcommand === "update",
        changedOnly: Boolean(options.changed),
        dryRun: Boolean(options["dry-run"])
      });
      process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : renderDocumentationResult(result));
      return;
    }
    if (subcommand === "check") {
      const result = await checkDocumentation({ docsRoot: options.root });
      process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : renderDocumentationCheck(result));
      if (!result.ok) process.exitCode = 2;
      return;
    }
    throw new Error(continuityUsage());
  }
  if (command === "context") {
    const subcommand = options._.shift();
    if (subcommand === "add") {
      const added = await addContextExpansion({ cwd: process.cwd(), file: options.file?.at(-1), reason: options.reason });
      const result = await compileContext({
        task: options.task || options.objective,
        budgetTokens: options.budget ? Number(options.budget) : 2048,
        agent: options.for || options.agent || added.task.currentAgent || "codex",
        purpose: options.purpose || "implement"
      });
      process.stdout.write(`${JSON.stringify({ added: added.path, exists: added.exists, contextId: result.manifest.id, scope: result.manifest.scope }, null, 2)}\n`);
      return;
    }
    if (subcommand === "check" || subcommand === "scope") {
      const result = await checkContextScope({ cwd: process.cwd() });
      if (options.json || subcommand === "scope") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(result.ok ? `Context scope valid (${result.changed.length} changed files).\n` : `Context scope violation: ${result.violations.join(", ")}\n`);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (subcommand !== "build") throw new Error(continuityUsage());
    const result = await compileContext({
      task: options.task || options.objective,
      budgetTokens: options.budget ? Number(options.budget) : 2048,
      agent: options.for || options.agent || "codex",
      purpose: options.purpose || "implement"
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ manifest: result.manifest, manifestPath: result.manifestPath, renderingPath: result.renderingPath, retrieval: result.retrieval }, null, 2)}\n`);
    } else if (options.explain) {
      process.stdout.write(`${JSON.stringify({
        contextId: result.manifest.id,
        budget: result.manifest.budget,
        items: result.manifest.items.map((item) => ({ source: item.source, score: item.score, tokens: item.tokenEstimate, reasons: item.reasons })),
        retrieval: result.retrieval
      }, null, 2)}\n`);
    } else {
      process.stdout.write(result.rendering);
    }
    return;
  }
  if (command === "verify") {
    const result = await verifyTask({ checks: options.check || [] });
    if (options.json) process.stdout.write(`${JSON.stringify({ receipt: result.receipt, receiptPath: result.receiptPath }, null, 2)}\n`);
    else process.stdout.write(`Verification ${result.receipt.status}: ${result.receipt.results.map((item) => `${item.name}=${item.status}`).join(", ")}\nReceipt: ${result.receiptPath}\n`);
    if (result.receipt.status !== "passed") process.exitCode = 1;
    return;
  }
  if (command === "continue") {
    const result = await continueTask({
      agent: options.agent,
      purpose: options.purpose || "implement",
      budgetTokens: options.budget ? Number(options.budget) : 4096,
      localProvider: options["local-provider"],
      dryRun: Boolean(options["dry-run"]),
      launch: !options["no-launch"]
    });
    writeContinuationResult(result, options.json);
    return;
  }
  if (command === "switch") {
    const result = await switchTask({
      to: options.to,
      ...progressOptions(options),
      purpose: options.purpose || "handoff",
      budgetTokens: options.budget ? Number(options.budget) : 4096,
      localProvider: options["local-provider"],
      dryRun: Boolean(options["dry-run"]),
      launch: !options["no-launch"]
    });
    writeContinuationResult(result, options.json);
    return;
  }
  if (command !== "task") throw new Error(continuityUsage());
  const subcommand = options._.shift();
  if (subcommand === "start") {
    const result = await startTask({
      objective: options.objective,
      agent: options.agent,
      branch: options.branch,
      createTaskBranch: !options["no-branch"],
      acceptanceCriteria: options.accept || [],
      constraints: options.constraint || [],
      files: options.file || []
    });
    process.stdout.write(`${JSON.stringify(result.task, null, 2)}\n`);
    return;
  }
  if (subcommand === "plan") {
    const result = await recordTaskPlan({ steps: options.step || [] });
    process.stdout.write(`${JSON.stringify(result.task.plan, null, 2)}\n`);
    return;
  }
  if (subcommand === "status") {
    const result = await taskStatus();
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write((await resumeTask()).resumePacket);
    return;
  }
  if (subcommand === "checkpoint") {
    const result = await checkpointTask(progressOptions(options));
    process.stdout.write(`${JSON.stringify({ checkpoint: result.checkpoint, capsulePath: result.capsulePath }, null, 2)}\n`);
    return;
  }
  if (subcommand === "complete") {
    const result = await completeTask({ waiveVerification: options["waive-verification"] });
    process.stdout.write(`${JSON.stringify({ taskId: result.task.taskId, status: result.task.status, completedAt: result.task.completedAt }, null, 2)}\n`);
    return;
  }
  if (subcommand === "handoff") {
    const result = await handoffTask({ to: options.to, ...progressOptions(options) });
    process.stdout.write(result.resumePacket);
    if (options.launch) await launchTask({ agent: options.to, localProvider: options["local-provider"] });
    return;
  }
  if (subcommand === "resume") {
    const result = await resumeTask({ agent: options.agent });
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(result.resumePacket);
    return;
  }
  if (subcommand === "launch") {
    const result = await launchTask({
      agent: options.agent,
      localProvider: options["local-provider"],
      dryRun: options["dry-run"]
    });
    if (options["dry-run"]) process.stdout.write(`${JSON.stringify(result.invocation, null, 2)}\n`);
    return;
  }
  throw new Error(continuityUsage());
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

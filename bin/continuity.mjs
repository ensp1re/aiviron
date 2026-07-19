#!/usr/bin/env node

import {
  checkpointTask,
  handoffTask,
  resumeTask,
  startTask,
  taskStatus
} from "../src/continuity/task-service.mjs";
import { workRepository } from "../src/continuity/workspace-service.mjs";
import { launchTask } from "../src/continuity/agent-launcher.mjs";
import { initializeEnvironment } from "../src/environment/generator.mjs";
import { compileContext } from "../src/context/compiler.mjs";
import { inspectRepository } from "../src/intelligence/analyzer.mjs";

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
    if (["no-branch", "json", "launch", "dry-run", "help", "explain", "no-cache"].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    index += 1;
    if (["completed", "next", "decision", "failure"].includes(key)) {
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
    failures: options.failure || []
  };
}

function continuityUsage() {
  return `Aiviron continuity commands

Usage:
  aiviron init [directory] [--agents codex,claude] [--name <name>] [--dry-run]
  aiviron inspect [--json] [--no-cache]
  aiviron context build [--task <text>] [--budget <tokens>] [--for codex|claude|gemini] [--purpose <mode>] [--explain|--json]
  aiviron work <repository> --objective <text> --agent <id> [--directory <path>] [--fork auto|always|never]
  aiviron task start --objective <text> --agent <id> [--branch <name>] [--no-branch]
  aiviron task status [--json]
  aiviron task checkpoint [--summary <text>] [--completed <text>] [--next <text>]
  aiviron task handoff --to <agent> [--summary <text>] [--next <text>]
  aiviron task resume [--agent <id>] [--json]
  aiviron task launch --agent codex|claude|codex-oss [--local-provider ollama|lmstudio] [--dry-run]
`;
}

function renderInspection(report) {
  const languages = report.languages.length ? report.languages.map((item) => `${item.name} (${item.files})`).join(", ") : "none detected";
  const commands = report.commands.length ? report.commands.map((item) => `  ${item.name}: ${item.command}`).join("\n") : "  none detected";
  return `Aiviron repository inspection\n\nRoot: ${report.repository.worktree}\nRevision: ${report.repository.head}\nBranch: ${report.repository.branch ?? "detached"}\nDirty: ${report.repository.dirty}\nFiles: ${report.inventory.indexedFiles} (${report.inventory.indexedChunks} chunks)\nSymbols: ${report.inventory.symbols}\nDependency edges: ${report.inventory.edges}\nLanguages: ${languages}\nMonorepo: ${report.shape.monorepo}\nTests: ${report.shape.hasTests}\nCI: ${report.shape.hasCi}\nContainers: ${report.shape.hasContainers}\nIndex: ${report.persisted ? report.indexPath : "in-memory"}\n\nCommands:\n${commands}\n`;
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
  if (command === "context") {
    const subcommand = options._.shift();
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
  if (command !== "task") throw new Error(continuityUsage());
  const subcommand = options._.shift();
  if (subcommand === "start") {
    const result = await startTask({
      objective: options.objective,
      agent: options.agent,
      branch: options.branch,
      createTaskBranch: !options["no-branch"]
    });
    process.stdout.write(`${JSON.stringify(result.task, null, 2)}\n`);
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

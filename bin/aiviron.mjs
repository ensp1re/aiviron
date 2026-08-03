#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const VERSION = "0.4.0";
const directory = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function usage() {
  return `Aiviron ${VERSION}

Usage:
  aiviron [directory] [--agents codex,claude] [--name <name>] [--dry-run]
  aiviron init [directory] [--agents codex,claude] [--name <name>] [--dry-run]
  aiviron inspect [--json]
  aiviron docs <plan|init|update|check> [--root <path>] [--changed] [--dry-run] [--json]
  aiviron context build [--task <text>] [--budget <tokens>] [--for <agent>] [--explain|--json]
  aiviron context add --file <path> --reason <why>
  aiviron context check [--json]
  aiviron verify [--check <script>] [--json]
  aiviron continue [--agent <id>] [--budget <tokens>] [--dry-run]
  aiviron switch --to <agent> [--summary <text>] [--next <text>] [--dry-run]
  aiviron work <repository> --objective <text> --agent <id> [options]
  aiviron task <start|plan|status|checkpoint|complete|handoff|resume|launch> [options]

Run "aiviron task --help" for continuity commands.
`;
}

if (args[0] === "--help" || args[0] === "-h") {
  process.stdout.write(usage());
  process.exit(0);
}

if (args[0] === "--version" || args[0] === "-v") {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const continuityCommand = ["inspect", "docs", "context", "verify", "continue", "switch", "work", "task"].includes(args[0]);
const script = join(directory, continuityCommand ? "continuity.mjs" : "init.mjs");
const forwardedArgs = args[0] === "init" ? args.slice(1) : args;
const result = spawnSync(process.execPath, [script, ...forwardedArgs], { stdio: "inherit" });

if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exitCode = result.status ?? 1;

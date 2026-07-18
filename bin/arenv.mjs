#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const VERSION = "0.1.0";
const directory = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function usage() {
  return `Arenv ${VERSION}

Usage:
  arenv [directory] [--agents codex,claude] [--name <name>] [--dry-run]
  arenv init [directory] [--agents codex,claude] [--name <name>] [--dry-run]
  arenv work <repository> --objective <text> --agent <id> [options]
  arenv task <start|status|checkpoint|handoff|resume|launch> [options]

Run "arenv task --help" for continuity commands.
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

const continuityCommand = args[0] === "work" || args[0] === "task";
const script = join(directory, continuityCommand ? "agentctl.mjs" : "create-agent.mjs");
const forwardedArgs = args[0] === "init" ? args.slice(1) : args;
const result = spawnSync(process.execPath, [script, ...forwardedArgs], { stdio: "inherit" });

if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exitCode = result.status ?? 1;

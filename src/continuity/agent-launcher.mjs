import { spawn } from "node:child_process";

import { resumeTask } from "./task-service.mjs";

export function buildInteractiveInvocation({ agent, repoRoot, taskId, resumePacket, localProvider }) {
  if (agent === "codex") {
    return {
      executable: "codex",
      args: ["--cd", repoRoot, resumePacket],
      cwd: repoRoot,
      surface: "interactive-cli"
    };
  }
  if (agent === "claude" || agent === "claude-code") {
    return {
      executable: "claude",
      args: ["--name", `Arenv ${taskId}`, resumePacket],
      cwd: repoRoot,
      surface: "interactive-cli"
    };
  }
  if (agent === "codex-oss") {
    const provider = localProvider || "ollama";
    if (!new Set(["ollama", "lmstudio"]).has(provider)) throw new Error(`Unsupported Codex OSS provider: ${provider}`);
    return {
      executable: "codex",
      args: ["--oss", "--local-provider", provider, "--cd", repoRoot, resumePacket],
      cwd: repoRoot,
      surface: "interactive-cli"
    };
  }
  throw new Error(`No interactive launcher adapter is registered for agent: ${agent}`);
}

export async function launchTask({ cwd = process.cwd(), agent, localProvider, dryRun = false } = {}) {
  const resumed = await resumeTask({ cwd, agent });
  const invocation = buildInteractiveInvocation({
    agent: resumed.task.currentAgent,
    repoRoot: resumed.repoRoot,
    taskId: resumed.task.taskId,
    resumePacket: resumed.resumePacket,
    localProvider
  });
  if (dryRun) return { ...resumed, invocation: { ...invocation, args: invocation.args.map((arg) => arg === resumed.resumePacket ? "<RESUME_PACKET>" : arg) } };

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      stdio: "inherit",
      shell: false,
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${invocation.executable} terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) throw new Error(`${invocation.executable} exited with code ${exitCode}`);
  return { ...resumed, invocation, exitCode };
}

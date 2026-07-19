import { spawn } from "node:child_process";

import { resumeTask } from "./task-service.mjs";

export function buildInteractiveInvocation({ agent, repoRoot, taskId, prompt, resumePacket, localProvider, promptDelivery = "argument" }) {
  const initialPrompt = prompt ?? resumePacket;
  if (agent === "codex") {
    return {
      executable: "codex",
      args: ["--cd", repoRoot, initialPrompt],
      cwd: repoRoot,
      surface: "interactive-cli",
      promptDelivery
    };
  }
  if (agent === "claude" || agent === "claude-code") {
    return {
      executable: "claude",
      args: ["--name", `Aiviron ${taskId}`, initialPrompt],
      cwd: repoRoot,
      surface: "interactive-cli",
      promptDelivery
    };
  }
  if (agent === "codex-oss") {
    const provider = localProvider || "ollama";
    if (!new Set(["ollama", "lmstudio"]).has(provider)) throw new Error(`Unsupported Codex OSS provider: ${provider}`);
    return {
      executable: "codex",
      args: ["--oss", "--local-provider", provider, "--cd", repoRoot, initialPrompt],
      cwd: repoRoot,
      surface: "interactive-cli",
      promptDelivery
    };
  }
  if (agent === "codex-app") {
    return {
      executable: "codex",
      args: ["app", repoRoot],
      cwd: repoRoot,
      surface: "desktop-app",
      promptDelivery: "workspace-file"
    };
  }
  throw new Error(`No interactive launcher adapter is registered for agent: ${agent}`);
}

export async function launchPrompt({ agent, repoRoot, taskId, prompt, localProvider, promptDelivery, dryRun = false, redaction = "<PROMPT>" }) {
  const invocation = buildInteractiveInvocation({ agent, repoRoot, taskId, prompt, localProvider, promptDelivery });
  if (dryRun) {
    return {
      invocation: {
        ...invocation,
        args: invocation.args.map((argument) => argument === prompt ? redaction : argument)
      },
      exitCode: null
    };
  }

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
  return { invocation, exitCode };
}

export async function launchTask({ cwd = process.cwd(), agent, localProvider, dryRun = false } = {}) {
  const resumed = await resumeTask({ cwd, agent });
  const launched = await launchPrompt({
    agent: resumed.task.currentAgent,
    repoRoot: resumed.repoRoot,
    taskId: resumed.task.taskId,
    prompt: resumed.resumePacket,
    localProvider,
    dryRun,
    redaction: "<RESUME_PACKET>"
  });
  return { ...resumed, ...launched };
}

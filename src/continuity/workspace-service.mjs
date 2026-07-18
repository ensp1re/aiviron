import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

import { startTask } from "./task-service.mjs";
import { initializeEnvironment } from "../environment/generator.mjs";

const execFileAsync = promisify(execFile);

async function run(executable, args, options = {}) {
  try {
    return await execFileAsync(executable, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      ...options
    });
  } catch (error) {
    const detail = error.stderr?.trim() || error.stdout?.trim() || error.message;
    throw new Error(`${executable} ${args.slice(0, 3).join(" ")} failed: ${detail}`);
  }
}

async function runOrNull(executable, args, options = {}) {
  try {
    return await run(executable, args, options);
  } catch {
    return null;
  }
}

export function parseGitHubRepository(source) {
  const patterns = [
    /^(?:https?:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i,
    /^(?:git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return { owner: match[1], name: match[2], nameWithOwner: `${match[1]}/${match[2]}` };
  }
  return null;
}

function repositoryName(source) {
  const github = parseGitHubRepository(source);
  if (github) return github.name;
  const withoutSlash = source.replace(/[\\/]$/, "");
  return basename(withoutSlash).replace(/\.git$/i, "") || "repository";
}

async function assertDestinationAbsent(destination) {
  try {
    await access(destination);
    throw new Error(`Destination already exists: ${destination}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function githubPermission(repository) {
  const { stdout } = await run("gh", ["repo", "view", repository, "--json", "viewerPermission,nameWithOwner"]);
  return JSON.parse(stdout);
}

async function authenticatedGitHubLogin() {
  const { stdout } = await run("gh", ["api", "user", "--jq", ".login"]);
  const login = stdout.trim();
  if (!login) throw new Error("GitHub CLI did not return an authenticated user login");
  return login;
}

async function acquireGitHubRepository({ source, github, destination, forkMode }) {
  const details = await githubPermission(github.nameWithOwner);
  const canPush = ["ADMIN", "MAINTAIN", "WRITE"].includes(details.viewerPermission);
  const shouldFork = forkMode === "always" || (forkMode === "auto" && !canPush);
  if (forkMode === "never" || !shouldFork) {
    await run("gh", ["repo", "clone", github.nameWithOwner, destination]);
    return { mode: "clone", source, repository: github.nameWithOwner, destination, viewerPermission: details.viewerPermission };
  }

  await run("gh", ["repo", "fork", github.nameWithOwner, "--clone=false"]);
  const login = await authenticatedGitHubLogin();
  const fork = `${login}/${github.name}`;
  await run("gh", ["repo", "clone", fork, destination]);
  const upstream = await runOrNull("git", ["remote", "get-url", "upstream"], { cwd: destination });
  if (!upstream) {
    await run("git", ["remote", "add", "upstream", `https://github.com/${github.nameWithOwner}.git`], { cwd: destination });
  }
  return {
    mode: "fork",
    source,
    repository: fork,
    upstream: github.nameWithOwner,
    destination,
    viewerPermission: details.viewerPermission
  };
}

export async function acquireRepository({
  source,
  parentDirectory = process.cwd(),
  directory,
  forkMode = "auto"
}) {
  if (!source?.trim()) throw new Error("Repository source is required");
  if (!new Set(["auto", "always", "never"]).has(forkMode)) throw new Error(`Invalid fork mode: ${forkMode}`);
  const destination = resolve(parentDirectory, directory || repositoryName(source));
  await assertDestinationAbsent(destination);
  const localSource = resolve(parentDirectory, source);
  const localExists = await runOrNull("git", ["-C", localSource, "rev-parse", "--git-dir"]);
  const github = localExists ? null : parseGitHubRepository(source);
  if (github) return acquireGitHubRepository({ source, github, destination, forkMode });

  await run("git", ["clone", "--", localExists ? localSource : source, destination]);
  return { mode: "clone", source, repository: source, destination, viewerPermission: null };
}

export async function workRepository({
  source,
  objective,
  agent,
  parentDirectory = process.cwd(),
  directory,
  forkMode = "auto",
  branch,
  clock
}) {
  const acquisition = await acquireRepository({ source, parentDirectory, directory, forkMode });
  const started = await startTask({ cwd: acquisition.destination, objective, agent, branch, clock });
  const environment = await initializeEnvironment({
    cwd: acquisition.destination,
    agents: ["codex", "claude"],
    clock
  });
  return { acquisition, environment, ...started };
}

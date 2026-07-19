import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const localStatePrefix = ".ai/state";

async function git(cwd, args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    });
    return stdout;
  } catch (error) {
    if (allowFailure) return null;
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

export async function resolveRepositoryRoot(cwd) {
  const output = await git(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (!output) throw new Error(`${cwd} is not inside a Git repository`);
  return realpath(output.trim());
}

export async function currentHead(repoRoot) {
  const output = await git(repoRoot, ["rev-parse", "HEAD"], { allowFailure: true });
  if (!output) throw new Error("The repository must have an initial commit before starting an Aiviron task");
  return output.trim();
}

export async function currentBranch(repoRoot) {
  const output = await git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true });
  return output?.trim() || "detached";
}

export async function originUrl(repoRoot) {
  const output = await git(repoRoot, ["remote", "get-url", "origin"], { allowFailure: true });
  return output?.trim() || null;
}

export async function gitDirectory(repoRoot) {
  const output = await git(repoRoot, ["rev-parse", "--absolute-git-dir"]);
  return output.trim();
}

export async function createBranch(repoRoot, branch) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch.includes("..") || branch.endsWith("/")) {
    throw new Error(`Unsafe Git branch name: ${branch}`);
  }
  await git(repoRoot, ["switch", "-c", branch]);
}

function isLocalStatePath(path) {
  return path === localStatePrefix || path.startsWith(`${localStatePrefix}/`);
}

async function trackedAndUntrackedPaths(repoRoot) {
  const output = await git(repoRoot, ["ls-files", "-co", "--exclude-standard", "-z"]);
  return [...new Set(output.split("\0").filter(Boolean).filter((path) => !isLocalStatePath(path)))].sort();
}

async function hashPath(repoRoot, path) {
  const absolute = resolve(repoRoot, path);
  const normalized = relative(repoRoot, absolute);
  if (normalized.startsWith(`..${sep}`) || normalized === "..") throw new Error(`Repository path escaped root: ${path}`);
  const hash = createHash("sha256");
  let stat;
  try {
    stat = await lstat(absolute);
  } catch (error) {
    if (error.code === "ENOENT") return hash.update("missing\0").digest("hex");
    throw error;
  }
  if (stat.isSymbolicLink()) {
    hash.update("symlink\0");
    hash.update(await readlink(absolute));
  } else if (stat.isFile()) {
    hash.update("file\0");
    hash.update(await readFile(absolute));
  } else {
    hash.update(`other:${stat.mode}\0`);
  }
  return hash.digest("hex");
}

async function worktreeDigest(repoRoot, paths) {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(await hashPath(repoRoot, path));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function repositorySnapshot(repoRoot, projectId) {
  const [head, branch, paths, statusOutput] = await Promise.all([
    currentHead(repoRoot),
    currentBranch(repoRoot),
    trackedAndUntrackedPaths(repoRoot),
    git(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  ]);
  const digest = await worktreeDigest(repoRoot, paths);
  const dirty = statusOutput
    .split("\0")
    .filter(Boolean)
    .some((record) => !isLocalStatePath(record.slice(3)));
  return {
    projectId,
    head: `git:${head}`,
    dirty,
    ...(dirty ? { dirtyDigest: digest } : {}),
    branch,
    worktree: repoRoot
  };
}

export async function workingPatch(repoRoot) {
  const tracked = await git(repoRoot, ["diff", "--binary", "HEAD"]);
  const untrackedOutput = await git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const untracked = untrackedOutput.split("\0").filter(Boolean).filter((path) => !isLocalStatePath(path));
  const sections = [tracked];
  for (const path of untracked.sort()) {
    const absolute = resolve(repoRoot, path);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      sections.push(`\nAiviron untracked artifact: ${path} (${stat.size} bytes; content omitted)\n`);
      continue;
    }
    const content = await readFile(absolute);
    sections.push(`\ndiff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`);
    sections.push(`AIVIRON-UNTRACKED-SHA256 ${createHash("sha256").update(content).digest("hex")}\n`);
  }
  return sections.join("");
}

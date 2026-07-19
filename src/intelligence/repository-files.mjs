import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const searchableExtensions = new Set([
  "", ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java",
  ".js", ".json", ".jsx", ".kt", ".kts", ".md", ".mjs", ".php", ".py", ".rb",
  ".rs", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml"
]);

const knownTextNames = new Set([
  "Dockerfile", "Gemfile", "Makefile", "Procfile", "Rakefile", "Justfile"
]);

function portablePath(root, absolute) {
  return relative(root, absolute).split(sep).join("/");
}

function safeAbsolute(root, path) {
  const absolute = resolve(root, path);
  const local = relative(root, absolute);
  if (local === ".." || local.startsWith(`..${sep}`)) throw new Error(`Repository path escaped root: ${path}`);
  return absolute;
}

async function gitPaths(repoRoot) {
  const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  });
  return [...new Set(stdout.split("\0").filter(Boolean))].sort();
}

function isSearchable(path) {
  const name = path.split("/").at(-1);
  return knownTextNames.has(name) || searchableExtensions.has(extname(name).toLowerCase());
}

export async function readRepositoryFiles(repoRoot, { maxFileBytes = 1024 * 1024 } = {}) {
  const files = [];
  const skipped = [];
  for (const path of await gitPaths(repoRoot)) {
    if (path === ".ai/state" || path.startsWith(".ai/state/")) continue;
    if (!isSearchable(path)) {
      skipped.push({ path, reason: "unsupported-extension" });
      continue;
    }
    const absolute = safeAbsolute(repoRoot, path);
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if (error.code === "ENOENT") {
        skipped.push({ path, reason: "missing" });
        continue;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      skipped.push({ path, reason: "symbolic-link" });
      continue;
    }
    if (!stat.isFile()) {
      skipped.push({ path, reason: "not-a-file" });
      continue;
    }
    if (stat.size > maxFileBytes) {
      skipped.push({ path, reason: "file-too-large", bytes: stat.size });
      continue;
    }
    const content = await readFile(absolute, "utf8");
    if (content.includes("\0")) {
      skipped.push({ path, reason: "binary-content" });
      continue;
    }
    files.push({ path: portablePath(repoRoot, absolute), absolute, bytes: stat.size, content });
  }
  return { files, skipped };
}

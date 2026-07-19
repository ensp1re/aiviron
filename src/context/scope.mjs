import { lstat } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";

import { changedPaths, resolveRepositoryRoot } from "../continuity/git.mjs";
import { readCurrentTask, statePaths, writeJsonAtomic } from "../continuity/store.mjs";

function uniqueByPath(entries) {
  const files = new Map();
  for (const entry of entries) {
    const current = files.get(entry.path);
    if (!current || current.access === "read-only" && entry.access === "read-write") files.set(entry.path, entry);
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function normalizeScopePath(repoRoot, input) {
  if (!input?.trim()) throw new Error("Context file path is required");
  const raw = input.trim().replace(/^repo:\/\/\//, "").replaceAll("\\", "/");
  if (raw.startsWith("/") || raw.includes("\0")) throw new Error(`Context path must be repository-relative: ${input}`);
  const normalized = posix.normalize(raw).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Context path escapes the repository: ${input}`);
  }
  const absolute = resolve(repoRoot, normalized);
  const local = relative(repoRoot, absolute);
  if (local === ".." || local.startsWith(`..${sep}`)) throw new Error(`Context path escapes the repository: ${input}`);
  return normalized;
}

export async function addContextExpansion({ cwd, file, reason = "Required to complete the active task", clock = () => new Date() }) {
  const repoRoot = await resolveRepositoryRoot(cwd);
  const task = await readCurrentTask(repoRoot);
  const path = normalizeScopePath(repoRoot, file);
  let exists = true;
  try {
    const stat = await lstat(join(repoRoot, path));
    if (!stat.isFile()) throw new Error(`Context path is not a regular file: ${path}`);
  } catch (error) {
    if (error.code === "ENOENT") exists = false;
    else throw error;
  }
  task.contextScope ||= { mode: "closed", files: [], expansions: [] };
  task.contextScope.mode = "closed";
  task.contextScope.expansions ||= [];
  const existing = task.contextScope.expansions.find((entry) => entry.path === path);
  if (existing) {
    existing.reason = reason.trim() || existing.reason;
    existing.updatedAt = clock().toISOString();
  } else {
    task.contextScope.expansions.push({
      path,
      reason: reason.trim() || "Required to complete the active task",
      addedAt: clock().toISOString(),
      existsAtAddition: exists
    });
  }
  task.updatedAt = clock().toISOString();
  await persistTask(repoRoot, task);
  return { task, path, exists };
}

export function scopeFilesFromContext(items, expansions = []) {
  const selected = items
    .filter((item) => item.status === "included" || item.status === "transformed")
    .filter((item) => item.source.startsWith("repo:///"))
    .map((item) => ({
      path: decodeURIComponent(item.source.slice("repo:///".length)),
      access: item.instruction ? "read-only" : "read-write",
      reason: item.reasons.join("; ")
    }));
  const explicit = expansions.map((entry) => ({ path: entry.path, access: "read-write", reason: `explicit expansion: ${entry.reason}` }));
  return uniqueByPath([...selected, ...explicit]);
}

export async function bindContextScope(repoRoot, task, manifest, clock = () => new Date()) {
  task.contextScope ||= { mode: "closed", files: [], expansions: [] };
  task.contextScope = {
    ...task.contextScope,
    mode: "closed",
    contextId: manifest.id,
    compiledAt: clock().toISOString(),
    files: scopeFilesFromContext(manifest.items, task.contextScope.expansions || [])
  };
  task.updatedAt = clock().toISOString();
  await persistTask(repoRoot, task);
  return task.contextScope;
}

export async function checkContextScope({ cwd, task: suppliedTask } = {}) {
  const repoRoot = await resolveRepositoryRoot(cwd);
  const task = suppliedTask || await readCurrentTask(repoRoot);
  const scope = task.contextScope;
  const changed = await changedPaths(repoRoot);
  if (!scope?.contextId) {
    const allowed = (scope?.expansions || []).map((entry) => entry.path).sort();
    const allowedSet = new Set(allowed);
    const violations = changed.filter((path) => !allowedSet.has(path));
    return {
      ok: violations.length === 0,
      mode: "closed",
      contextId: null,
      changed,
      allowed,
      violations,
      warning: "No compiled task context exists; build context before editing."
    };
  }
  const allowed = new Set((scope.files || []).filter((entry) => entry.access === "read-write").map((entry) => entry.path));
  const violations = changed.filter((path) => !allowed.has(path));
  return {
    ok: violations.length === 0,
    mode: scope.mode,
    contextId: scope.contextId,
    changed,
    allowed: [...allowed].sort(),
    violations
  };
}

export function assertScopeCheck(result) {
  if (result.ok) return;
  const paths = result.violations.length ? result.violations.join(", ") : "unknown";
  throw new Error(`Changed files are outside the active context scope: ${paths}. Revert them or run npx aiviron context add --file <path> --reason <why>, then rebuild context.`);
}

async function persistTask(repoRoot, task) {
  const paths = statePaths(repoRoot);
  await writeJsonAtomic(join(paths.tasks, task.taskId, "task.json"), task);
  await writeJsonAtomic(paths.current, task);
}

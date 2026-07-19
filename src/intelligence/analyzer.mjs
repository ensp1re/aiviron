import { execFile } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, posix, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { currentBranch, originUrl, repositorySnapshot, resolveRepositoryRoot } from "../continuity/git.mjs";
import { sha256, stableOpaqueId } from "../continuity/identity.mjs";
import { retrievalProfile, retrievalProfileRef } from "../context/retrieval-profile.mjs";
import { searchTokens } from "../context/tokens.mjs";
import { readRepositoryFiles } from "./repository-files.mjs";

const execFileAsync = promisify(execFile);
const indexVersion = "0.2.0";

const languageExtensions = new Map([
  [".c", "c"], [".cc", "cpp"], [".cpp", "cpp"], [".cs", "csharp"], [".go", "go"],
  [".h", "c-header"], [".hpp", "cpp-header"], [".java", "java"], [".js", "javascript"],
  [".jsx", "javascript"], [".kt", "kotlin"], [".kts", "kotlin"], [".mjs", "javascript"],
  [".php", "php"], [".py", "python"], [".rb", "ruby"], [".rs", "rust"], [".swift", "swift"],
  [".ts", "typescript"], [".tsx", "typescript"]
]);

const manifestNames = new Set([
  "package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "go.work",
  "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json"
]);

const symbolPatterns = {
  javascript: [
    [/(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, "function"],
    [/(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
    [/(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, "type"],
    [/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, "function"],
    [/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/, "constant"]
  ],
  typescript: [],
  python: [
    [/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/, "function"],
    [/^\s*class\s+([A-Za-z_][\w]*)/, "class"]
  ],
  go: [
    [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, "function"],
    [/^\s*type\s+([A-Za-z_][\w]*)\s+/, "type"]
  ],
  rust: [
    [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/, "function"],
    [/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)/, "type"]
  ],
  ruby: [
    [/^\s*def\s+(?:self\.)?([A-Za-z_][\w!?=]*)/, "function"],
    [/^\s*(?:class|module)\s+([A-Za-z_][\w:]*)/, "class"]
  ]
};
symbolPatterns.typescript = symbolPatterns.javascript;

function authority(path) {
  if (path === "AGENTS.md" || /^(?:CLAUDE|GEMINI)\.md$/.test(path)) return "instruction";
  if (/(^|\/)(generated|vendor|dist|build)(\/|$)/i.test(path)) return "generated";
  if (/(^|\/)(docs?)(\/|$)|(?:legacy|obsolete|stale)/i.test(path)) return "documentation";
  if (manifestNames.has(basename(path))) return "manifest";
  return "source";
}

function language(path) {
  return languageExtensions.get(extname(path).toLowerCase()) ?? null;
}

function sourceLines(content) {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function extractSymbols(path, content) {
  const detected = language(path);
  const patterns = symbolPatterns[detected] ?? [];
  const symbols = [];
  const seen = new Set();
  sourceLines(content).forEach((line, index) => {
    for (const [pattern, kind] of patterns) {
      const match = line.match(pattern);
      const key = match ? `${match[1]}:${index + 1}` : null;
      if (match && !seen.has(key)) {
        symbols.push({ name: match[1], kind, startLine: index + 1, endLine: index + 1 });
        seen.add(key);
      }
    }
  });
  return symbols;
}

function extractImports(path, content) {
  const detected = language(path);
  const patterns = [];
  if (detected === "javascript" || detected === "typescript") {
    patterns.push(/(?:from\s+|import\s*)["']([^"']+)["']/g, /require\(["']([^"']+)["']\)/g);
  } else if (detected === "python") {
    patterns.push(/^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm);
  } else if (detected === "ruby") {
    patterns.push(/^\s*require(?:_relative)?\s+["']([^"']+)["']/gm);
  } else if (detected === "rust") {
    patterns.push(/^\s*use\s+([A-Za-z_][\w:]*)/gm, /^\s*mod\s+([A-Za-z_][\w]*)/gm);
  } else if (detected === "c" || detected === "cpp" || detected === "c-header" || detected === "cpp-header") {
    patterns.push(/^\s*#include\s+["<]([^">]+)[">]/gm);
  } else if (detected === "go") {
    patterns.push(/^\s*import\s+["`]([^"`]+)["`]/gm);
  }
  const imports = [];
  for (const pattern of patterns) for (const match of content.matchAll(pattern)) imports.push(match[1]);
  return [...new Set(imports)];
}

function resolveImport(fromPath, specifier, knownPaths) {
  const candidates = [];
  if (specifier.startsWith(".")) {
    const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
    candidates.push(base);
    for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".rb", ".rs", ".go", ".c", ".h"]) candidates.push(`${base}${extension}`);
    for (const name of ["index.ts", "index.tsx", "index.js", "__init__.py", "mod.rs"]) candidates.push(`${base}/${name}`);
  } else if (/^[A-Za-z_][\w.]*$/.test(specifier)) {
    const base = specifier.replaceAll(".", "/");
    candidates.push(`${base}.py`, `${base}/__init__.py`, `${base}.rb`, `${base}.rs`);
  }
  return candidates.find((candidate) => knownPaths.has(candidate)) ?? null;
}

function chunks(lines) {
  const output = [];
  const size = retrievalProfile.lexical.chunkLines;
  const stride = size - retrievalProfile.lexical.overlapLines;
  for (let offset = 0; offset < lines.length; offset += stride) {
    const selected = lines.slice(offset, offset + size);
    if (!selected.length) break;
    output.push({ startLine: offset + 1, endLine: offset + selected.length, content: selected.join("\n") });
    if (offset + size >= lines.length) break;
  }
  return output;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertSafeStatePath(repoRoot, path) {
  const local = relative(repoRoot, path);
  if (local === ".." || local.startsWith(`..${sep}`)) throw new Error(`State path escaped repository: ${path}`);
  let cursor = repoRoot;
  for (const segment of local.split(sep)) {
    cursor = join(cursor, segment);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error(`Refusing to use symbolic-link state path: ${cursor}`);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
}

async function gitHead(repoRoot) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
    return stdout.trim();
  } catch {
    return null;
  }
}

function aggregateDigest(records) {
  return sha256(records.map((record) => `${record.path}\0${record.digest}`).join("\0"));
}

async function readPackageMetadata(records) {
  const rootPackage = records.find((record) => record.path === "package.json");
  if (!rootPackage) return { commands: [], packageManager: null, workspaces: [] };
  try {
    const pkg = JSON.parse(rootPackage.content);
    return {
      commands: Object.entries(pkg.scripts ?? {}).filter(([, command]) => typeof command === "string").sort(([left], [right]) => left.localeCompare(right)).map(([name, command]) => ({ name, command: `npm run ${name}`, underlying: command })),
      packageManager: typeof pkg.packageManager === "string" ? pkg.packageManager : null,
      workspaces: Array.isArray(pkg.workspaces) ? pkg.workspaces : Array.isArray(pkg.workspaces?.packages) ? pkg.workspaces.packages : []
    };
  } catch {
    return { commands: [], packageManager: null, workspaces: [], warning: "package.json is not valid JSON" };
  }
}

function repositoryShape(records, packageMetadata) {
  const paths = new Set(records.map((record) => record.path));
  const topLevel = new Map();
  for (const record of records) {
    const directory = record.path.includes("/") ? record.path.split("/")[0] : ".";
    topLevel.set(directory, (topLevel.get(directory) ?? 0) + 1);
  }
  const packageCount = records.filter((record) => basename(record.path) === "package.json").length;
  return {
    monorepo: packageMetadata.workspaces.length > 0 || paths.has("go.work") || packageCount > 1,
    hasTests: records.some((record) => /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(?:test|spec)\.[^/]+$/i.test(record.path)),
    hasCi: records.some((record) => /^(?:\.github\/workflows|\.gitlab-ci\.yml|\.circleci\/)/.test(record.path)),
    hasContainers: records.some((record) => /(^|\/)(?:Dockerfile|compose\.ya?ml|docker-compose\.ya?ml)$/i.test(record.path)),
    hasDocumentation: records.some((record) => /(^|\/)docs?\//i.test(record.path) || /^README(?:\.|$)/i.test(record.path)),
    topLevel: [...topLevel.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, files]) => ({ path, files }))
  };
}

function initializeDatabase(db) {
  db.exec(`
    DROP TABLE IF EXISTS metadata;
    DROP TABLE IF EXISTS files;
    DROP TABLE IF EXISTS symbols;
    DROP TABLE IF EXISTS edges;
    DROP TABLE IF EXISTS chunks;
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE files (path TEXT PRIMARY KEY, digest TEXT NOT NULL, bytes INTEGER NOT NULL, lines INTEGER NOT NULL, language TEXT, authority TEXT NOT NULL, content TEXT NOT NULL);
    CREATE TABLE symbols (path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL);
    CREATE TABLE edges (source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, specifier TEXT NOT NULL);
    CREATE VIRTUAL TABLE chunks USING fts5(path UNINDEXED, start_line UNINDEXED, end_line UNINDEXED, digest UNINDEXED, content, normalized, tokenize='unicode61 remove_diacritics 2');
    CREATE INDEX symbols_name ON symbols(name);
    CREATE INDEX edges_source ON edges(source);
    CREATE INDEX edges_target ON edges(target);
  `);
}

export async function createRepositoryIndex({ cwd = process.cwd(), persist = true, clock = () => new Date() } = {}) {
  const started = performance.now();
  const repoRoot = await resolveRepositoryRoot(cwd);
  const projectId = stableOpaqueId("prj", (await originUrl(repoRoot)) || repoRoot);
  const stateReady = await exists(join(repoRoot, ".ai", ".gitignore"));
  const indexPath = persist && stateReady ? join(repoRoot, ".ai", "state", "repository", "index.sqlite") : ":memory:";
  if (indexPath !== ":memory:") {
    await assertSafeStatePath(repoRoot, indexPath);
    await mkdir(dirname(indexPath), { recursive: true });
    if (await exists(indexPath)) {
      const cached = new DatabaseSync(indexPath);
      try {
        const reportRow = cached.prepare("SELECT value FROM metadata WHERE key = 'report'").get();
        const profileRow = cached.prepare("SELECT value FROM metadata WHERE key = 'profile'").get();
        const snapshot = await repositorySnapshot(repoRoot, projectId);
        const profileMatches = profileRow?.value === JSON.stringify(retrievalProfileRef);
        if (reportRow?.value && profileMatches && !snapshot.dirty) {
          const report = JSON.parse(reportRow.value);
          if (report.repository.head === snapshot.head) {
            report.generatedAt = clock().toISOString();
            report.repository = snapshot;
            report.performance = { scanMs: 0, indexMs: 0, totalMs: performance.now() - started, cacheHit: true };
            return { db: cached, report, records: [] };
          }
        }
      } catch {
        // A missing or old metadata layout falls through to a safe rebuild.
      }
      cached.close();
    }
  }
  const scanStarted = performance.now();
  const { files, skipped } = await readRepositoryFiles(repoRoot);
  const records = files.map((file) => {
    const lines = sourceLines(file.content);
    return {
      ...file,
      lines,
      digest: sha256(file.content),
      language: language(file.path),
      authority: authority(file.path),
      symbols: extractSymbols(file.path, file.content),
      imports: extractImports(file.path, file.content)
    };
  });
  const scanMs = performance.now() - scanStarted;
  const knownPaths = new Set(records.map((record) => record.path));
  const edges = [];
  for (const record of records) {
    for (const specifier of record.imports) {
      const target = resolveImport(record.path, specifier, knownPaths);
      if (target) edges.push({ source: record.path, target, kind: "imports", specifier });
    }
  }

  const indexStarted = performance.now();
  const db = new DatabaseSync(indexPath);
  initializeDatabase(db);
  const insertMetadata = db.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)");
  const insertFile = db.prepare("INSERT INTO files(path, digest, bytes, lines, language, authority, content) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertSymbol = db.prepare("INSERT INTO symbols(path, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)");
  const insertEdge = db.prepare("INSERT INTO edges(source, target, kind, specifier) VALUES (?, ?, ?, ?)");
  const insertChunk = db.prepare("INSERT INTO chunks(path, start_line, end_line, digest, content, normalized) VALUES (?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    insertMetadata.run("profile", JSON.stringify(retrievalProfileRef));
    for (const record of records) {
      insertFile.run(record.path, record.digest, record.bytes, record.lines.length, record.language, record.authority, record.content);
      for (const symbol of record.symbols) insertSymbol.run(record.path, symbol.name, symbol.kind, symbol.startLine, symbol.endLine);
      for (const chunk of chunks(record.lines)) {
        insertChunk.run(record.path, chunk.startLine, chunk.endLine, sha256(chunk.content), chunk.content, searchTokens(`${record.path}\n${chunk.content}`).join(" "));
      }
    }
    for (const edge of edges) insertEdge.run(edge.source, edge.target, edge.kind, edge.specifier);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  const indexMs = performance.now() - indexStarted;
  const packageMetadata = await readPackageMetadata(records);
  const languageCounts = new Map();
  for (const record of records) if (record.language) languageCounts.set(record.language, (languageCounts.get(record.language) ?? 0) + 1);
  const manifests = records.filter((record) => manifestNames.has(basename(record.path))).map((record) => record.path);
  const digest = aggregateDigest(records);
  const head = await gitHead(repoRoot);
  const repository = head
    ? await repositorySnapshot(repoRoot, projectId)
    : { projectId, head: "git:0000000", dirty: true, dirtyDigest: digest, branch: await currentBranch(repoRoot), worktree: repoRoot };
  const report = {
    schemaVersion: "aiviron-repository-index/v1alpha1",
    generatedAt: clock().toISOString(),
    generator: { id: "aiviron-repository-indexer", version: indexVersion, profile: retrievalProfileRef },
    repository,
    digest,
    persisted: indexPath !== ":memory:",
    indexPath: indexPath === ":memory:" ? null : indexPath,
    inventory: {
      indexedFiles: records.length,
      indexedBytes: records.reduce((sum, record) => sum + record.bytes, 0),
      indexedChunks: Number(db.prepare("SELECT count(*) AS count FROM chunks").get().count),
      symbols: records.reduce((sum, record) => sum + record.symbols.length, 0),
      edges: edges.length,
      skipped
    },
    languages: [...languageCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([name, files]) => ({ name, files })),
    manifests,
    commands: packageMetadata.commands,
    packageManager: packageMetadata.packageManager,
    workspaces: packageMetadata.workspaces,
    shape: repositoryShape(records, packageMetadata),
    warnings: packageMetadata.warning ? [packageMetadata.warning] : [],
    performance: { scanMs, indexMs, totalMs: performance.now() - started, cacheHit: false }
  };
  insertMetadata.run("report", JSON.stringify(report));
  return { db, report, records };
}

export async function inspectRepository(options = {}) {
  const result = await createRepositoryIndex(options);
  result.db.close();
  return result.report;
}

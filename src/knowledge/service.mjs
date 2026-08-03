import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { sha256 } from "../continuity/identity.mjs";
import { resolveRepositoryRoot } from "../continuity/git.mjs";
import { planDocumentation } from "./planner.mjs";

const serviceVersion = "0.1.0";
const managedStart = "<!-- aiviron:knowledge:start -->";
const managedEnd = "<!-- aiviron:knowledge:end -->";
const authoringNeeded = "<!-- aiviron:authoring-needed -->";
const manifestRelativePath = ".ai/knowledge/manifest.json";

async function readOrNull(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonOrNull(path) {
  const content = await readOrNull(path);
  if (content === null) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function safeAbsolute(repoRoot, path) {
  const absolute = resolve(repoRoot, path);
  const local = relative(repoRoot, absolute);
  if (!local || local === ".." || local.startsWith(`..${sep}`)) throw new Error(`Documentation path escaped repository: ${path}`);
  return absolute;
}

async function assertSafeWritePath(repoRoot, path) {
  const absolute = safeAbsolute(repoRoot, path);
  const local = relative(repoRoot, absolute);
  let cursor = repoRoot;
  for (const segment of local.split(sep)) {
    cursor = join(cursor, segment);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) throw new Error(`Refusing to write through symbolic link: ${cursor}`);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  return absolute;
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.aiviron-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o644, flag: "wx" });
  await rename(temporary, path);
}

function evidenceList(document) {
  if (!document.sources.length) return "- No source files were selected. Add evidence before treating this document as authoritative.";
  return document.sources.map((source) => `- \`${source.path}\``).join("\n");
}

function capabilitiesList(plan) {
  if (!plan.capabilities.length) return "No specialized project capabilities were detected.";
  return plan.capabilities.map((item) => `- ${item.label} (${Math.round(item.confidence * 100)}% confidence)`).join("\n");
}

function repositoryFacts(plan) {
  const languages = plan.repository.languages.length ? plan.repository.languages.map((item) => `${item.name} (${item.files})`).join(", ") : "No supported language was detected";
  const workspaces = plan.repository.workspaces.length ? plan.repository.workspaces.join(", ") : "Single workspace or no workspace declaration";
  return `- Languages: ${languages}\n- Workspaces: ${workspaces}\n- Monorepo: ${plan.repository.shape.monorepo ? "yes" : "no"}\n- Tests detected: ${plan.repository.shape.hasTests ? "yes" : "no"}\n- CI detected: ${plan.repository.shape.hasCi ? "yes" : "no"}\n- Containers detected: ${plan.repository.shape.hasContainers ? "yes" : "no"}`;
}

function commandsList(plan) {
  if (!plan.repository.commands.length) return "No package commands were detected.";
  return plan.repository.commands.map((item) => `- \`${item.command}\``).join("\n");
}

function documentLinks(document, plan) {
  const parentDepth = document.path.slice(plan.docsRoot.length + 1).split("/").length - 1;
  const prefix = parentDepth ? "../".repeat(parentDepth) : "";
  return plan.documents
    .filter((item) => item.path !== document.path)
    .map((item) => `- [${item.title}](${prefix}${item.path.slice(plan.docsRoot.length + 1)})`)
    .join("\n");
}

function managedBody(document, plan) {
  const common = `> This source-backed project document is managed by Aiviron. Source code remains the implementation authority.\n\n## Why this document exists\n\n${document.reason}\n\n## Source evidence\n\n${evidenceList(document)}`;
  if (document.module === "index") {
    return `> This directory is reusable project knowledge generated from repository evidence. It is intended to be committed with the project.\n\n## Documentation map\n\n${documentLinks(document, plan) || "No additional documents were selected."}\n\n## Detected capabilities\n\n${capabilitiesList(plan)}\n\n## Maintenance\n\nRun \`npx aiviron docs check\` to detect missing or stale documents.`;
  }
  if (document.module === "overview") return `${common}\n\n## Repository profile\n\n${repositoryFacts(plan)}\n\n## Detected capabilities\n\n${capabilitiesList(plan)}`;
  if (document.module === "development") return `${common}\n\n## Detected commands\n\n${commandsList(plan)}`;
  return common;
}

function authoringSection(document) {
  if (document.module === "index") return `${authoringNeeded}\n## Project guidance\n\nReplace this note with reviewed guidance that helps contributors navigate the project, then remove the \`aiviron:authoring-needed\` marker.`;
  if (document.module === "overview") return `${authoringNeeded}\n## Purpose and boundaries\n\nDescribe the project's verified purpose, users, entry points, and important boundaries, then remove the \`aiviron:authoring-needed\` marker.`;
  if (document.module === "architecture") return `${authoringNeeded}\n## Architecture map\n\nDescribe verified modules, control flow, and dependency relationships from the source evidence, then remove the \`aiviron:authoring-needed\` marker.`;
  if (document.module === "development") return `${authoringNeeded}\n## Setup and workflow\n\nDocument verified setup requirements, commands, and development constraints, then remove the \`aiviron:authoring-needed\` marker.`;
  return `${authoringNeeded}\n## Maintained knowledge\n\nDocument verified conventions, boundaries, and workflows for ${document.title.toLowerCase()}, then remove the \`aiviron:authoring-needed\` marker.`;
}

function renderDocument(document, plan) {
  return `# ${document.title}\n\n${managedStart}\n${managedBody(document, plan)}\n${managedEnd}\n\n${authoringSection(document)}\n`;
}

function upsertManagedBlock(existing, rendered, { update }) {
  if (existing === null) return { content: rendered, ownership: "aiviron", action: "create" };
  const start = existing.indexOf(managedStart);
  const end = existing.indexOf(managedEnd);
  if (start === -1 && end === -1) return { content: existing, ownership: "human", action: "preserve" };
  if (start === -1 || end === -1 || end < start) throw new Error("Documentation contains an incomplete Aiviron managed block");
  if (!update) return { content: existing, ownership: "aiviron", action: "unchanged" };
  const renderedStart = rendered.indexOf(managedStart);
  const renderedEnd = rendered.indexOf(managedEnd) + managedEnd.length;
  const replacement = rendered.slice(renderedStart, renderedEnd);
  const next = `${existing.slice(0, start)}${replacement}${existing.slice(end + managedEnd.length)}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  return { content: next, ownership: "aiviron", action: next === existing ? "unchanged" : "update" };
}

function stableManifest(value) {
  if (!value) return null;
  const { generatedAt: _generatedAt, updatedAt: _updatedAt, ...stable } = value;
  return stable;
}

function sameStableManifest(left, right) {
  return JSON.stringify(stableManifest(left)) === JSON.stringify(stableManifest(right));
}

function manifestDocument(document, ownership) {
  return {
    path: document.path,
    module: document.module,
    title: document.title,
    ownership,
    status: ownership === "human" ? "reviewed" : "generated",
    confidence: document.confidence,
    sources: ownership === "human" ? [] : document.sources
  };
}

export async function generateDocumentation({
  cwd = process.cwd(),
  docsRoot,
  update = false,
  changedOnly = false,
  dryRun = false,
  clock = () => new Date()
} = {}) {
  const repoRoot = await resolveRepositoryRoot(cwd);
  const plan = await planDocumentation({ cwd: repoRoot, docsRoot, clock });
  const manifestPath = await assertSafeWritePath(repoRoot, manifestRelativePath);
  const currentManifest = await readJsonOrNull(manifestPath);
  let selectedPaths = null;
  if (changedOnly && currentManifest) {
    const check = await checkDocumentation({ cwd: repoRoot, docsRoot: plan.docsRoot, clock });
    selectedPaths = new Set(check.issues.map((issue) => issue.document).filter(Boolean));
  }

  const writes = [];
  const documents = [];
  for (const document of plan.documents) {
    const absolute = await assertSafeWritePath(repoRoot, document.path);
    const existing = await readOrNull(absolute);
    const shouldUpdate = update && (!selectedPaths || selectedPaths.has(document.path));
    const result = upsertManagedBlock(existing, renderDocument(document, plan), { update: shouldUpdate });
    const previousRecord = currentManifest?.documents?.find((item) => item.path === document.path);
    documents.push(!update && result.action === "unchanged" && previousRecord ? previousRecord : manifestDocument(document, result.ownership));
    if (result.action === "create" || result.action === "update") writes.push({ path: absolute, relativePath: document.path, content: result.content, previous: existing, action: result.action });
  }

  const now = clock().toISOString();
  const proposedManifest = {
    schemaVersion: "aiviron-knowledge-manifest/v1alpha1",
    generatedBy: `aiviron-knowledge-service/${serviceVersion}`,
    generatedAt: currentManifest?.generatedAt || now,
    updatedAt: now,
    projectId: plan.projectId,
    docsRoot: plan.docsRoot,
    documents
  };
  const manifest = sameStableManifest(currentManifest, proposedManifest) ? currentManifest : proposedManifest;
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const currentManifestContent = await readOrNull(manifestPath);
  if (currentManifestContent !== manifestContent) writes.push({ path: manifestPath, relativePath: manifestRelativePath, content: manifestContent, previous: currentManifestContent, action: currentManifestContent === null ? "create" : "update" });

  if (!dryRun) {
    const completed = [];
    try {
      for (const write of writes) {
        await atomicWrite(write.path, write.content);
        completed.push(write);
      }
    } catch (error) {
      for (const write of completed.reverse()) {
        if (write.previous === null) await unlink(write.path).catch(() => {});
        else await atomicWrite(write.path, write.previous).catch(() => {});
      }
      throw error;
    }
  }

  return {
    schemaVersion: "aiviron-documentation-result/v1alpha1",
    dryRun,
    repoRoot,
    plan,
    manifest,
    manifestPath,
    files: plan.documents.map((document) => {
      const write = writes.find((item) => item.relativePath === document.path);
      const owned = documents.find((item) => item.path === document.path);
      return { path: document.path, action: write?.action || (owned?.ownership === "human" ? "preserve" : "unchanged"), ownership: owned?.ownership };
    }),
    manifestAction: writes.find((item) => item.relativePath === manifestRelativePath)?.action || "unchanged"
  };
}

function sourceMap(plan) {
  const sources = new Map();
  for (const document of plan.documents) for (const source of document.sources) sources.set(source.path, source.digest);
  return sources;
}

export async function checkDocumentation({ cwd = process.cwd(), docsRoot, clock = () => new Date() } = {}) {
  const repoRoot = await resolveRepositoryRoot(cwd);
  const manifestPath = safeAbsolute(repoRoot, manifestRelativePath);
  const manifest = await readJsonOrNull(manifestPath);
  const plan = await planDocumentation({ cwd: repoRoot, docsRoot: docsRoot || manifest?.docsRoot, clock });
  const issues = [];
  if (!manifest) {
    issues.push({ type: "missing-manifest", document: manifestRelativePath, message: "Project knowledge has not been initialized" });
    for (const document of plan.documents) issues.push({ type: "missing-document", document: document.path, message: "Expected adaptive documentation is missing" });
    return { schemaVersion: "aiviron-documentation-check/v1alpha1", ok: false, repoRoot, manifestPath, docsRoot: plan.docsRoot, issues, summary: { documents: 0, fresh: 0, stale: plan.documents.length } };
  }

  const currentSources = sourceMap(plan);
  const expected = new Map(plan.documents.map((document) => [document.path, document]));
  const recorded = new Map(manifest.documents.map((document) => [document.path, document]));
  let fresh = 0;
  for (const document of plan.documents) {
    const record = recorded.get(document.path);
    const content = await readOrNull(safeAbsolute(repoRoot, document.path));
    const exists = content !== null;
    if (!exists) issues.push({ type: "missing-document", document: document.path, message: "Documentation file is missing" });
    if (!record) {
      issues.push({ type: "unregistered-document", document: document.path, message: "Detected capability is not registered in the knowledge manifest" });
      continue;
    }
    if (record.ownership === "human") {
      if (exists) fresh += 1;
      continue;
    }
    if (content?.includes(authoringNeeded)) {
      issues.push({ type: "incomplete-document", document: document.path, message: "Replace the authoring prompt with verified project knowledge" });
      continue;
    }
    const plannedSources = new Map(document.sources.map((source) => [source.path, source.digest]));
    const recordedSources = new Map(record.sources.map((source) => [source.path, source.digest]));
    if ([...plannedSources.keys()].sort().join("\0") !== [...recordedSources.keys()].sort().join("\0")) {
      issues.push({ type: "source-set-changed", document: document.path, message: "The evidence selected for this document changed" });
      continue;
    }
    const stale = record.sources.find((source) => currentSources.get(source.path) !== source.digest);
    if (stale) {
      issues.push({ type: currentSources.has(stale.path) ? "stale-source" : "missing-source", document: document.path, source: stale.path, message: "Recorded source evidence changed or disappeared" });
      continue;
    }
    if (exists) fresh += 1;
  }
  for (const document of manifest.documents) {
    if (!expected.has(document.path)) issues.push({ type: "orphaned-document", document: document.path, message: "The capability is no longer selected; the file was preserved" });
  }
  return {
    schemaVersion: "aiviron-documentation-check/v1alpha1",
    ok: issues.length === 0,
    repoRoot,
    manifestPath,
    docsRoot: plan.docsRoot,
    issues,
    summary: { documents: plan.documents.length, fresh, stale: plan.documents.length - fresh }
  };
}

export { authoringNeeded, managedEnd, managedStart, manifestRelativePath };

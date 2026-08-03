import { posix } from "node:path";

import { createRepositoryIndex } from "../intelligence/analyzer.mjs";
import { detectCapabilities, manifestRecords } from "./capabilities.mjs";

const plannerVersion = "0.1.0";
const defaultDocsRoot = "docs/ai";

const moduleDefinitions = {
  api: { title: "Application API", reason: "API routes, schemas, or server framework signals were detected" },
  cli: { title: "Command-line interface", reason: "CLI entry points or argument-processing libraries were detected" },
  data: { title: "Data and persistence", reason: "Database schemas, migrations, or persistence libraries were detected" },
  deployment: { title: "Deployment and infrastructure", reason: "Deployment, container, CI, or infrastructure configuration was detected" },
  integrations: { title: "External integrations", reason: "External-service adapters or SDKs were detected" },
  library: { title: "Library API", reason: "A reusable package or exported library surface was detected" },
  operations: { title: "Operations and observability", reason: "Jobs, workers, monitoring, or observability signals were detected" },
  security: { title: "Security and identity", reason: "Authentication, authorization, or security-related code was detected" },
  testing: { title: "Testing strategy", reason: "Tests or test frameworks were detected" },
  ui: { title: "User interface", reason: "UI components, screens, styles, or application frameworks were detected" }
};

function uniqueSources(records, limit = 16) {
  const seen = new Set();
  const selected = [];
  for (const record of records) {
    if (!record?.path || seen.has(record.path)) continue;
    seen.add(record.path);
    selected.push({ path: record.path, digest: record.digest });
    if (selected.length >= limit) break;
  }
  return selected;
}

function coreDocuments(records, report, docsRoot) {
  const readmes = records.filter((record) => /(^|\/)README(?:\.|$)/i.test(record.path));
  const manifests = manifestRecords(records);
  const configs = records.filter((record) => /(^|\/)(?:Dockerfile|Makefile|Justfile|\.github\/workflows\/|\.gitlab-ci\.yml|compose\.ya?ml)/i.test(record.path));
  const source = records.filter((record) => record.language && !/(^|\/)(?:test|tests|spec|__tests__)(\/|$)/i.test(record.path));
  const documents = [
    {
      module: "index",
      path: posix.join(docsRoot, "README.md"),
      title: "Project knowledge",
      reason: "Provides the reusable entry point for agents and contributors",
      confidence: 1,
      sources: uniqueSources([...readmes, ...manifests], 8)
    },
    {
      module: "overview",
      path: posix.join(docsRoot, "overview.md"),
      title: "Project overview",
      reason: "Summarizes repository purpose, stacks, workspaces, and entry surfaces",
      confidence: 1,
      sources: uniqueSources([...readmes, ...manifests, ...source], 12)
    },
    {
      module: "architecture",
      path: posix.join(docsRoot, "architecture.md"),
      title: "Architecture",
      reason: "Maps the main modules and their relationships",
      confidence: report.inventory.indexedFiles > 1 ? 0.9 : 0.6,
      sources: uniqueSources([...manifests, ...source], 16)
    }
  ];
  if (report.commands.length || manifests.length || report.shape.hasTests) {
    documents.push({
      module: "development",
      path: posix.join(docsRoot, "development.md"),
      title: "Development workflow",
      reason: "Build, test, and repository commands were detected",
      confidence: 0.9,
      sources: uniqueSources([...manifests, ...configs, ...records.filter((record) => /test|spec/i.test(record.path))], 16)
    });
  }
  return documents;
}

function validateDocsRoot(docsRoot) {
  const normalized = posix.normalize(String(docsRoot || defaultDocsRoot).replaceAll("\\", "/")).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || normalized.startsWith("/")) {
    throw new Error(`Unsafe documentation root: ${docsRoot}`);
  }
  if (normalized === ".git" || normalized.startsWith(".git/") || normalized === ".ai/state" || normalized.startsWith(".ai/state/")) {
    throw new Error(`Documentation root cannot use repository metadata or local runtime state: ${docsRoot}`);
  }
  return normalized.replace(/\/$/, "");
}

export async function planDocumentation({ cwd = process.cwd(), docsRoot = defaultDocsRoot, clock = () => new Date() } = {}) {
  const root = validateDocsRoot(docsRoot);
  const indexed = await createRepositoryIndex({ cwd, persist: false, clock });
  const { db, report, records } = indexed;
  db.close();
  const eligible = records.filter((record) => !record.path.startsWith(`${root}/`) && !record.path.startsWith(".ai/state/") && !record.path.startsWith(".ai/knowledge/"));
  const capabilities = detectCapabilities(eligible, report);
  const documents = coreDocuments(eligible, report, root);
  for (const capability of capabilities) {
    const definition = moduleDefinitions[capability.id];
    if (!definition) continue;
    documents.push({
      module: capability.id,
      path: posix.join(root, capability.id, "README.md"),
      title: definition.title,
      reason: definition.reason,
      confidence: capability.confidence,
      sources: uniqueSources(capability.evidence, 16)
    });
  }
  return {
    schemaVersion: "aiviron-documentation-plan/v1alpha1",
    generatedBy: `aiviron-knowledge-planner/${plannerVersion}`,
    generatedAt: clock().toISOString(),
    projectId: report.repository.projectId,
    docsRoot: root,
    repository: {
      languages: report.languages,
      workspaces: report.workspaces,
      commands: report.commands,
      shape: report.shape
    },
    capabilities,
    documents: documents.sort((left, right) => left.path.localeCompare(right.path))
  };
}

export { defaultDocsRoot };

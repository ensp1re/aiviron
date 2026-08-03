import { basename } from "node:path";

const capabilityRules = [
  {
    id: "ui",
    label: "User interface",
    path: /(^|\/)(?:app|pages|views|components|screens|ui)(\/|$)|\.(?:jsx|tsx|css|scss|sass|vue|svelte)$/i,
    content: /(?:react|next\/|vue|svelte|solid-js|angular|swiftui|jetpack compose|flutter|react-native)/i
  },
  {
    id: "api",
    label: "Application API",
    path: /(^|\/)(?:api|routes?|controllers?|handlers?|endpoints?)(\/|$)|(?:openapi|swagger|graphql)/i,
    content: /(?:express|fastify|koa|hono|fastapi|flask|django|gin-gonic|actix-web|axum|graphql|openapi|swagger|@(?:get|post|put|patch|delete)\b)/i
  },
  {
    id: "data",
    label: "Data and persistence",
    path: /(^|\/)(?:data|database|db|models?|migrations?|schema)(\/|$)|\.(?:sql|prisma)$/i,
    content: /(?:postgres|mysql|sqlite|mongodb|redis|prisma|sequelize|typeorm|sqlalchemy|mongoose|diesel|drizzle-orm)/i
  },
  {
    id: "cli",
    label: "Command-line interface",
    path: /(^|\/)(?:bin|cli|commands?)(\/|$)|(?:^|\/)(?:main|cli)\.(?:js|mjs|ts|py|rb|go|rs)$/i,
    content: /(?:"bin"\s*:|commander|yargs|clap::|cobra|argparse|click\.command|thor\b)/i
  },
  {
    id: "library",
    label: "Library or package API",
    path: /(?:^|\/)(?:package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml)$/i,
    content: /(?:"exports"\s*:|"types"\s*:|\[project\]|\[lib\]|^module\s+|<packaging>jar<\/packaging>)/im
  },
  {
    id: "deployment",
    label: "Deployment and infrastructure",
    path: /(^|\/)(?:deploy|deployment|infra|terraform|k8s|kubernetes|helm)(\/|$)|(?:dockerfile|compose\.ya?ml|\.tf$|vercel\.json|netlify\.toml)/i,
    content: /(?:terraform\s*\{|apiVersion:\s*(?:apps|batch|v1)|FROM\s+[^\s]+|services:\s*$)/im
  },
  {
    id: "operations",
    label: "Operations and observability",
    path: /(^|\/)(?:ops|monitoring|observability|jobs?|workers?|queues?)(\/|$)|(?:prometheus|grafana|sentry)/i,
    content: /(?:opentelemetry|prometheus|grafana|sentry|datadog|bullmq|celery|sidekiq|cron\b)/i
  },
  {
    id: "security",
    label: "Security and identity",
    path: /(^|\/)(?:auth|authentication|authorization|security|identity)(\/|$)/i,
    content: /(?:oauth|openid|passport|next-auth|authjs|jsonwebtoken|bcrypt|argon2|spring-security|devise\b)/i
  },
  {
    id: "integrations",
    label: "External integrations",
    path: /(^|\/)(?:integrations?|connectors?|adapters?|webhooks?)(\/|$)/i,
    content: /(?:stripe|twilio|sendgrid|slack|github|googleapis|aws-sdk|@aws-sdk|azure|firebase|supabase)/i
  },
  {
    id: "testing",
    label: "Testing strategy",
    path: /(^|\/)(?:test|tests|spec|__tests__)(\/|$)|\.(?:test|spec)\.[^/]+$/i,
    content: /(?:vitest|jest|mocha|pytest|unittest|rspec|minitest|junit|playwright|cypress)/i
  }
];

function recordText(record) {
  return `${record.path}\n${record.content ?? ""}`;
}

function addEvidence(evidence, record, reason) {
  if (evidence.some((item) => item.path === record.path)) return;
  evidence.push({ path: record.path, digest: record.digest, reason });
}

function confidenceFor(evidence, pathMatches, contentMatches) {
  const score = 0.45 + Math.min(0.25, pathMatches * 0.1) + Math.min(0.25, contentMatches * 0.1);
  return Number(Math.min(0.99, score + (evidence.length >= 3 ? 0.05 : 0)).toFixed(2));
}

function inferredLibrary(records, detectedIds) {
  if (detectedIds.has("ui") || detectedIds.has("api") || detectedIds.has("cli")) return null;
  const manifest = records.find((record) => /(?:^|\/)(?:package\.json|pyproject\.toml|cargo\.toml|go\.mod|mix\.exs|pubspec\.yaml|package\.swift|build\.sbt)$/i.test(record.path));
  if (!manifest) return null;
  return {
    id: "library",
    label: "Library or package API",
    confidence: 0.55,
    evidence: [{ path: manifest.path, digest: manifest.digest, reason: "package manifest without an application entry surface" }]
  };
}

export function detectCapabilities(records, report) {
  const sourceRecords = records.filter((record) => !record.path.startsWith(".ai/state/") && !record.path.startsWith("docs/ai/") && !record.path.startsWith(".ai/knowledge/"));
  const capabilities = [];
  for (const rule of capabilityRules) {
    const evidence = [];
    let pathMatches = 0;
    let contentMatches = 0;
    for (const record of sourceRecords) {
      const pathMatch = rule.path.test(record.path);
      const contentMatch = rule.content.test(recordText(record));
      if (!pathMatch && !contentMatch) continue;
      if (pathMatch) pathMatches += 1;
      if (contentMatch) contentMatches += 1;
      addEvidence(evidence, record, pathMatch && contentMatch ? "path and content signal" : pathMatch ? "repository path signal" : "dependency or source signal");
      if (evidence.length >= 8) break;
    }
    if (!evidence.length) continue;
    capabilities.push({
      id: rule.id,
      label: rule.label,
      confidence: confidenceFor(evidence, pathMatches, contentMatches),
      evidence
    });
  }

  const ids = new Set(capabilities.map((item) => item.id));
  if (report?.shape?.hasTests && !ids.has("testing")) {
    const record = sourceRecords.find((item) => /test|spec/i.test(item.path));
    if (record) capabilities.push({ id: "testing", label: "Testing strategy", confidence: 0.7, evidence: [{ path: record.path, digest: record.digest, reason: "repository test layout" }] });
  }
  if ((report?.shape?.hasContainers || report?.shape?.hasCi) && !ids.has("deployment")) {
    const record = sourceRecords.find((item) => /docker|compose|\.github\/workflows|\.gitlab-ci|\.circleci/i.test(item.path));
    if (record) capabilities.push({ id: "deployment", label: "Deployment and infrastructure", confidence: 0.65, evidence: [{ path: record.path, digest: record.digest, reason: "container or CI configuration" }] });
  }
  const library = inferredLibrary(sourceRecords, new Set(capabilities.map((item) => item.id)));
  if (library && !capabilities.some((item) => item.id === "library")) capabilities.push(library);

  return capabilities.sort((left, right) => left.id.localeCompare(right.id)).map((capability) => ({
    ...capability,
    evidence: capability.evidence.sort((left, right) => left.path.localeCompare(right.path))
  }));
}

export function manifestRecords(records) {
  return records.filter((record) => ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "go.work", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "mix.exs", "pubspec.yaml", "Package.swift", "build.sbt"].includes(basename(record.path)));
}

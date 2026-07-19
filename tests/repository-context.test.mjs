import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { compileContext } from "../src/context/compiler.mjs";
import { startTask } from "../src/continuity/task-service.mjs";
import { initializeEnvironment } from "../src/environment/generator.mjs";
import { inspectRepository } from "../src/intelligence/analyzer.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function fixtureRepository() {
  const directory = await mkdtemp(join(tmpdir(), "aiviron-context-"));
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Aiviron Context Test");
  await git(directory, "config", "user.email", "context@example.invalid");
  await mkdir(join(directory, "src"), { recursive: true });
  await mkdir(join(directory, "test"), { recursive: true });
  await mkdir(join(directory, "docs"), { recursive: true });
  await mkdir(join(directory, "generated"), { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({
    name: "session-service",
    type: "module",
    scripts: { test: "node --test" }
  }, null, 2)}\n`);
  await writeFile(join(directory, "AGENTS.md"), "# Repository rules\n\nKeep session TTL validation at the configuration boundary.\n");
  await writeFile(join(directory, "src", "config.js"), "export const sessionTtlSeconds = 900;\n");
  await writeFile(join(directory, "src", "clock.js"), "export const skewSeconds = 0;\n");
  await writeFile(join(directory, "src", "session.js"), "import { skewSeconds } from './clock.js';\nimport { sessionTtlSeconds } from './config.js';\n\nexport function createSession(id) {\n  return { id, expiresIn: sessionTtlSeconds + skewSeconds };\n}\n");
  await writeFile(join(directory, "test", "session.test.js"), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { createSession } from '../src/session.js';\ntest('uses configured TTL', () => assert.equal(createSession('x').expiresIn, 900));\n");
  await writeFile(join(directory, "docs", "legacy-session.md"), "Legacy sessions used a 30 second TTL. This document is obsolete.\n");
  await writeFile(join(directory, "generated", "defaults.js"), "export const sessionTtlSeconds = 30;\n");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "initial fixture");
  await initializeEnvironment({ cwd: directory, agents: ["codex", "claude"], clock: () => new Date("2026-07-19T00:00:00.000Z") });
  await git(directory, "add", ".ai", "AGENTS.md", "CLAUDE.md");
  await git(directory, "commit", "-m", "initialize Aiviron");
  return directory;
}

async function schemaValidator(schemaName) {
  const schemaDir = join(projectRoot, "schemas", "v1alpha1");
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
  addFormats(ajv);
  const common = JSON.parse(await readFile(join(schemaDir, "common.schema.json"), "utf8"));
  const schema = JSON.parse(await readFile(join(schemaDir, schemaName), "utf8"));
  ajv.addSchema(common);
  ajv.addSchema(schema);
  return ajv.getSchema(schema.$id);
}

test("repository inspection persists an ignored SQLite intelligence index", async (t) => {
  const repo = await fixtureRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const first = await inspectRepository({ cwd: repo, clock: () => new Date("2026-07-19T00:10:00.000Z") });
  const second = await inspectRepository({ cwd: repo, clock: () => new Date("2026-07-19T00:11:00.000Z") });

  assert.equal(first.digest, second.digest);
  assert.equal(first.persisted, true);
  assert.ok(first.inventory.indexedFiles >= 10);
  assert.ok(first.inventory.indexedChunks >= first.inventory.indexedFiles);
  assert.ok(first.inventory.symbols >= 3);
  assert.ok(first.inventory.edges >= 2);
  assert.ok(first.languages.some((entry) => entry.name === "javascript"));
  assert.equal(first.shape.hasTests, true);
  assert.equal(first.commands[0].name, "test");
  assert.ok((await stat(first.indexPath)).size > 0);
  const validate = await schemaValidator("repository-index.schema.json");
  assert.equal(validate(first), true, JSON.stringify(validate.errors));
  assert.equal((await git(repo, "status", "--porcelain")).stdout, "");
});

test("repository inspection recognizes root-level test filenames", async (t) => {
  const repo = await fixtureRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await git(repo, "mv", "test/session.test.js", "session.test.js");
  await rm(join(repo, "docs", "legacy-session.md"));

  const report = await inspectRepository({ cwd: repo, persist: false });

  assert.equal(report.shape.hasTests, true);
  assert.equal(report.repository.dirty, true);
  assert.ok(report.inventory.skipped.some((entry) => entry.path === "docs/legacy-session.md" && entry.reason === "missing"));
});

test("hybrid context compilation is explainable, budgeted, and schema-valid", async (t) => {
  const repo = await fixtureRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await startTask({ cwd: repo, objective: "Change session TTL configuration safely", agent: "codex" });

  const result = await compileContext({
    cwd: repo,
    agent: "codex",
    budgetTokens: 512,
    clock: () => new Date("2026-07-19T00:20:00.000Z")
  });

  assert.ok(result.manifest.budget.usedTokens <= 512);
  assert.equal(result.manifest.repository.dirty, false);
  assert.equal(result.manifest.items[0].source, "repo:///AGENTS.md");
  assert.ok(result.manifest.items.some((item) => /src\/(?:config|session)\.js/.test(item.source)));
  assert.match(result.rendering, /sessionTtlSeconds/);
  assert.ok(result.retrieval.lexicalCandidates > 0);
  assert.ok(result.retrieval.structuralCandidates > 0);
  assert.ok((await stat(result.manifestPath)).size > 0);
  assert.ok((await stat(result.renderingPath)).size > 0);
  const validate = await schemaValidator("context-manifest.schema.json");
  assert.equal(validate(result.manifest), true, JSON.stringify(validate.errors));
  assert.equal((await git(repo, "status", "--porcelain")).stdout, "");

  const explicit = await compileContext({
    cwd: repo,
    task: "Change createSession behavior",
    agent: "codex",
    budgetTokens: 1024,
    clock: () => new Date("2026-07-19T00:21:00.000Z")
  });
  const dependency = explicit.manifest.items.find((item) => item.source === "repo:///src/clock.js");
  assert.ok(dependency);
  assert.ok(dependency.reasons.includes("dependency neighbor"));
});

test("public CLI exposes repository inspection and context explanations", async (t) => {
  const repo = await fixtureRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const cli = join(projectRoot, "bin", "aiviron.mjs");

  const inspected = await execFileAsync(process.execPath, [cli, "inspect", "--json"], { cwd: repo, encoding: "utf8" });
  assert.equal(JSON.parse(inspected.stdout).schemaVersion, "aiviron-repository-index/v1alpha1");

  const compiled = await execFileAsync(process.execPath, [cli, "context", "build", "--task", "Change session TTL configuration safely", "--budget", "512", "--for", "codex", "--explain"], { cwd: repo, encoding: "utf8" });
  const explanation = JSON.parse(compiled.stdout);
  assert.ok(explanation.budget.usedTokens <= 512);
  assert.ok(explanation.items.some((item) => item.source === "repo:///AGENTS.md"));
  assert.ok(explanation.retrieval.fusedCandidates > 0);
});

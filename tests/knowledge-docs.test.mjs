import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { compileContext } from "../src/context/compiler.mjs";
import { initializeEnvironment } from "../src/environment/generator.mjs";
import { planDocumentation } from "../src/knowledge/planner.mjs";
import { authoringNeeded, checkDocumentation, generateDocumentation } from "../src/knowledge/service.mjs";

const execFileAsync = promisify(execFile);
const fixedClock = () => new Date("2026-08-03T12:00:00.000Z");

async function put(root, path, content) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aiviron-knowledge-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await put(root, "package.json", `${JSON.stringify({
    name: "mixed-app",
    scripts: { test: "vitest", dev: "node src/server.mjs" },
    dependencies: { react: "1.0.0", express: "1.0.0", prisma: "1.0.0" },
    devDependencies: { vitest: "1.0.0" }
  }, null, 2)}\n`);
  await put(root, "README.md", "# Mixed application\n");
  await put(root, "src/components/App.tsx", "export function App() { return <main>Hello</main>; }\n");
  await put(root, "src/routes/users.mjs", "export function usersRoute(app) { app.get('/users', () => []); }\n");
  await put(root, "tests/app.test.mjs", "export const passes = true;\n");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["-c", "user.name=Aiviron", "-c", "user.email=aiviron@example.invalid", "commit", "-m", "fixture"], { cwd: root });
  return root;
}

async function markGeneratedDocsAuthored(root) {
  const manifest = JSON.parse(await readFile(join(root, ".ai/knowledge/manifest.json"), "utf8"));
  for (const document of manifest.documents.filter((item) => item.ownership === "aiviron")) {
    const path = join(root, document.path);
    const content = await readFile(path, "utf8");
    await writeFile(path, content.replace(authoringNeeded, "").replace(/Replace this note[^\n]*\n|Describe the project[^\n]*\n|Describe verified modules[^\n]*\n|Document verified setup[^\n]*\n|Document verified conventions[^\n]*\n/g, "Verified project guidance.\n"));
  }
}

test("plans documentation from capabilities rather than a fixed frontend/backend tree", async () => {
  const root = await fixture();
  const plan = await planDocumentation({ cwd: root, clock: fixedClock });
  const capabilities = new Set(plan.capabilities.map((item) => item.id));
  assert.ok(capabilities.has("ui"));
  assert.ok(capabilities.has("api"));
  assert.ok(capabilities.has("data"));
  assert.ok(capabilities.has("testing"));
  const paths = new Set(plan.documents.map((item) => item.path));
  assert.ok(paths.has("docs/ai/ui/README.md"));
  assert.ok(paths.has("docs/ai/api/README.md"));
  assert.ok(paths.has("docs/ai/data/README.md"));
  assert.ok(![...paths].some((path) => path.startsWith("docs/ai/backend/")));
  await assert.rejects(() => planDocumentation({ cwd: root, docsRoot: ".ai/state/docs", clock: fixedClock }), /cannot use repository metadata or local runtime state/);
});

test("falls back to capability-based library documentation for another language stack", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiviron-elixir-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await put(root, "mix.exs", "defmodule Sample.MixProject do\n  use Mix.Project\nend\n");
  await put(root, "lib/sample.ex", "defmodule Sample do\n  def hello, do: :world\nend\n");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["-c", "user.name=Aiviron", "-c", "user.email=aiviron@example.invalid", "commit", "-m", "fixture"], { cwd: root });
  const plan = await planDocumentation({ cwd: root, clock: fixedClock });
  assert.ok(plan.repository.languages.some((item) => item.name === "elixir"));
  assert.ok(plan.documents.some((item) => item.path === "docs/ai/library/README.md"));
  assert.ok(!plan.documents.some((item) => item.path.startsWith("docs/ai/ui/")));
});

test("generates reusable docs idempotently and preserves human-owned files", async () => {
  const root = await fixture();
  const human = "# Human UI guide\n\nDo not overwrite this.\n";
  await put(root, "docs/ai/ui/README.md", human);
  const first = await generateDocumentation({ cwd: root, clock: fixedClock });
  assert.equal(first.files.find((item) => item.path === "docs/ai/ui/README.md").action, "preserve");
  assert.equal(await readFile(join(root, "docs/ai/ui/README.md"), "utf8"), human);
  const manifest = JSON.parse(await readFile(join(root, ".ai/knowledge/manifest.json"), "utf8"));
  assert.equal(manifest.documents.find((item) => item.path === "docs/ai/ui/README.md").ownership, "human");
  const incomplete = await checkDocumentation({ cwd: root, clock: fixedClock });
  assert.ok(incomplete.issues.some((item) => item.type === "incomplete-document"));
  const second = await generateDocumentation({ cwd: root, clock: fixedClock });
  assert.ok(second.files.every((item) => ["unchanged", "preserve"].includes(item.action)));
  assert.equal(second.manifestAction, "unchanged");
});

test("detects stale source evidence and refreshes only affected knowledge", async () => {
  const root = await fixture();
  await generateDocumentation({ cwd: root, clock: fixedClock });
  await markGeneratedDocsAuthored(root);
  await put(root, "src/routes/users.mjs", "export function usersRoute(app) { app.get('/users', () => [{ id: 1 }]); }\n");
  const stale = await checkDocumentation({ cwd: root, clock: fixedClock });
  assert.equal(stale.ok, false);
  assert.ok(stale.issues.some((item) => item.type === "stale-source" && item.source === "src/routes/users.mjs"));
  await generateDocumentation({ cwd: root, update: true, changedOnly: true, clock: fixedClock });
  const fresh = await checkDocumentation({ cwd: root, clock: fixedClock });
  assert.equal(fresh.ok, true, JSON.stringify(fresh.issues));
});

test("makes fresh project knowledge available as a distinct context section", async () => {
  const root = await fixture();
  await initializeEnvironment({ cwd: root, directory: ".", agents: ["codex"], clock: fixedClock });
  await generateDocumentation({ cwd: root, clock: fixedClock });
  const result = await compileContext({ cwd: root, task: "Understand the application API and UI architecture", purpose: "document", budgetTokens: 4096, clock: fixedClock });
  assert.ok(result.manifest.items.some((item) => item.kind === "project-knowledge"));
  assert.ok(result.manifest.sections.some((section) => section.id === "project-knowledge"));
});

test("exposes adaptive documentation through the CLI", async () => {
  const root = await fixture();
  const cli = fileURLToPath(new URL("../bin/aiviron.mjs", import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, [cli, "docs", "plan", "--json"], { cwd: root });
  const plan = JSON.parse(stdout);
  assert.equal(plan.schemaVersion, "aiviron-documentation-plan/v1alpha1");
  assert.ok(plan.documents.some((item) => item.module === "api"));
});

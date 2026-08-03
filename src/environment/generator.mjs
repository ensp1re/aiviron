import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { stableOpaqueId } from "../continuity/identity.mjs";

const execFileAsync = promisify(execFile);
const generatorVersion = "0.4.0";
const repositoryProfileSchema = "aiviron-repository-profile/v1alpha1";
const managedStart = "<!-- aiviron:managed:start -->";
const managedEnd = "<!-- aiviron:managed:end -->";
const supportedAgents = new Set(["codex", "claude", "gemini"]);

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function run(executable, args, options = {}) {
  try {
    return await execFileAsync(executable, args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      ...options
    });
  } catch (error) {
    if (options.allowFailure) return null;
    const detail = error.stderr?.trim() || error.stdout?.trim() || error.message;
    throw new Error(`${executable} ${args.join(" ")} failed: ${detail}`);
  }
}

async function resolveProjectRoot(target, { dryRun }) {
  const existed = await pathExists(target);
  if (!existed) {
    if (!dryRun) {
      await mkdir(target, { recursive: true });
      await run("git", ["init", "-b", "main", target]);
      return { repoRoot: await realpath(target), gitInitialized: true };
    }
    return { repoRoot: target, gitInitialized: true };
  }
  const existing = await run("git", ["-C", target, "rev-parse", "--show-toplevel"], { allowFailure: true });
  if (existing?.stdout?.trim()) return { repoRoot: resolve(existing.stdout.trim()), gitInitialized: false };
  if (!dryRun) {
    await run("git", ["init", "-b", "main", target]);
    return { repoRoot: await realpath(target), gitInitialized: true };
  }
  return { repoRoot: await realpath(target), gitInitialized: true };
}

function normalizeAgents(agents) {
  const normalized = [...new Set((agents || []).map((agent) => agent.trim().toLowerCase()).filter(Boolean))];
  const selected = normalized.length ? normalized : ["codex", "claude"];
  for (const agent of selected) {
    if (!supportedAgents.has(agent)) throw new Error(`Unsupported generated agent projection: ${agent}`);
  }
  return selected;
}

async function detectRepository(repoRoot) {
  const detectors = [
    ["package.json", "javascript-typescript"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["Cargo.toml", "rust"],
    ["go.mod", "go"],
    ["Gemfile", "ruby"],
    ["pom.xml", "java"],
    ["build.gradle", "java-kotlin"]
  ];
  const languages = [];
  for (const [file, language] of detectors) {
    if (await pathExists(join(repoRoot, file))) languages.push(language);
  }
  let scripts = {};
  const packagePath = join(repoRoot, "package.json");
  if (await pathExists(packagePath)) {
    try {
      const pkg = JSON.parse(await readFile(packagePath, "utf8"));
      scripts = Object.fromEntries(Object.entries(pkg.scripts || {}).filter(([, value]) => typeof value === "string"));
    } catch {
      // An invalid manifest is evidence, but initialization should still produce a usable environment.
    }
  }
  const remote = await run("git", ["-C", repoRoot, "remote", "get-url", "origin"], { allowFailure: true });
  const head = await run("git", ["-C", repoRoot, "rev-parse", "HEAD"], { allowFailure: true });
  return {
    root: ".",
    remote: remote?.stdout?.trim() || null,
    revision: head?.stdout?.trim() ? `git:${head.stdout.trim()}` : null,
    detectedStacks: [...new Set(languages)],
    commands: Object.keys(scripts).sort().map((name) => ({ name, command: `npm run ${name}` }))
  };
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function renderConfig({ projectId, projectName, agents }) {
  return `# Aiviron configuration; human-owned after generation\napiVersion: dev.aiviron/v1alpha1\nkind: AgentEnvironment\nmetadata:\n  projectId: ${yamlString(projectId)}\n  name: ${yamlString(projectName)}\nspec:\n  mode: subscription-first\n  agents:\n${agents.map((agent) => `    - ${yamlString(agent)}`).join("\n")}\n  canonicalState: .ai\n  runtimeState: .ai/state\n  intelligence:\n    index: .ai/state/repository/index.sqlite\n    retrievalProfile: hybrid-frozen-v1\n  context:\n    defaultBudgetTokens: 2048\n    strategy: hybrid\n    scope: closed\n  knowledge:\n    docsRoot: docs/ai\n    manifest: .ai/knowledge/manifest.json\n    adaptive: true\n  continuation:\n    packet: .ai/state/continuation/latest.md\n    defaultBudgetTokens: 4096\n    automaticCheckpoint: interactive-cli-exit\n  providerApi:\n    required: false\n    enabled: false\n  sessions:\n    handoff: operational-capsule\n    writerLease: one-agent-per-worktree\n  privacy:\n    transferProviderTranscript: false\n    transferHiddenReasoning: false\n`;
}

function renderEnvironmentReadme({ projectName, agents }) {
  return `${managedStart}\n# AI working environment for ${projectName}\n\nThis is the shared project harness for ${agents.join(", ")}. The user works normally in an AI coding application; agents operate the Aiviron lifecycle themselves. Do not ask the user to manually run task, plan, context, verification, checkpoint, or completion commands. Use \`npx aiviron\` internally and consult \`npx aiviron --help\` or \`npx aiviron task --help\` when command details are needed.\n\n## Agent contract\n\nFor repository-changing work:\n\n1. Convert the user's request into an objective and observable acceptance criteria.\n2. Resume \`.ai/state/current.json\` when it represents the same unfinished task; otherwise start a task and record a focused plan.\n3. Compile bounded context before inspecting implementation files. Treat its repository file list as a closed scope.\n4. Do not inspect or edit files outside that scope. If another file is required, run \`npx aiviron context add --file <path> --reason <why>\` before using it.\n5. Implement the plan, run \`npx aiviron context check\`, and capture relevant verification with \`npx aiviron verify\`.\n6. Record completed criteria and plan steps. Complete only when the checks pass; otherwise leave a useful checkpoint for the next session or agent.\n\nReusable project knowledge lives in \`docs/ai/\` with provenance in \`.ai/knowledge/manifest.json\`. For documentation work, run \`npx aiviron docs plan\`, initialize missing files with \`npx aiviron docs init\`, compile source evidence with purpose \`document\`, and replace every \`aiviron:authoring-needed\` prompt with verified knowledge. Run \`npx aiviron docs check\` before completion. Preserve human-owned documents and expand the active task scope before changing knowledge files.\n\nKeep one writing agent per worktree. Persist objective progress, decisions, failures, evidence, and bounded next actions—not private reasoning, transcripts, authentication, or previous permissions.\n\nLocal indexes, context packets, receipts, and mutable task state live in \`.ai/state/\` and are excluded from Git. Stable environment files and project knowledge may be committed so every agent discovers the same project contract.\n${managedEnd}`;
}

function renderKnowledgePolicy() {
  return `# Generated by Aiviron ${generatorVersion}\napiVersion: dev.aiviron/knowledge-policy/v1alpha1\nkind: KnowledgePolicy\nspec:\n  docsRoot: docs/ai\n  selection: adaptive-capability-detection\n  provenance: source-digests\n  preserveHumanOwned: true\n  includeRuntimeState: false\n  verificationCommand: npx aiviron docs check\n`;
}

function renderContextPolicy() {
  return `# Generated by Aiviron ${generatorVersion}\napiVersion: dev.aiviron/context-policy/v1alpha1\nkind: ContextPolicy\nspec:\n  compiler:\n    strategy: hybrid\n    profile: hybrid-frozen-v1\n    defaultBudgetTokens: 2048\n  objectiveAndConstraintsRequired: true\n  gitStateRequired: true\n  evidenceProvenanceRequired: true\n  preferSourceOverSummary: true\n  scope:\n    mode: closed\n    expansion: explicit-and-recorded\n    enforceAt:\n      - checkpoint\n      - handoff\n      - verification\n      - completion\n  include:\n    - active-task\n    - changed-files\n    - decisions\n    - failures\n    - next-actions\n  exclude:\n    - hidden-reasoning\n    - provider-session-secrets\n`;
}

function renderSessionPolicy() {
  return `# Generated by Aiviron ${generatorVersion}\napiVersion: dev.aiviron/session-policy/v1alpha1\nkind: SessionPolicy\nspec:\n  workflow: specify-plan-execute-verify-review-complete\n  checkpoint: interactive-exit-and-handoff\n  writerLease: one-agent-per-worktree\n  destinationReauthorizesEffects: true\n  driftPolicy: inspect-before-editing\n  portableState:\n    - objective\n    - constraints\n    - acceptance-criteria\n    - execution-plan\n    - context-scope\n    - repository\n    - changes\n    - verification-evidence\n    - decisions\n    - failures\n    - next-actions\n`;
}

function renderProjection(agent) {
  const names = { codex: "Codex", claude: "Claude", gemini: "Gemini" };
  return `${managedStart}\n## Shared Aiviron environment\n\nThis repository uses the project harness in \`.ai/\`. ${names[agent]} must operate that harness automatically; the user should only need to describe work normally. Read \`.ai/README.md\` before repository-changing work.\n\nIf an active task exists, resume it when it matches the user's request, then compile its context for ${agent}. For a new repository-changing request, internally create the task with objective and acceptance criteria, record a focused plan, and compile context before inspecting implementation files.\n\nTreat compiled context as a closed scope. Inspect and edit only listed repository files. Expand deliberately with \`npx aiviron context add --file <path> --reason <why>\` before using another file. Before completion or handoff, check scope, run relevant verification, and persist criteria, plan progress, evidence, decisions, failures, and next actions.\n\nFor documentation tasks, use \`aiviron docs plan|init|check\` and context purpose \`document\`. Replace authoring prompts with verified knowledge and preserve human-owned docs. Never persist private reasoning, transcripts, authentication, or permissions.\n${managedEnd}`;
}

function upsertManagedBlock(existing, block) {
  if (existing === null || existing.trim() === "") return `${block}\n`;
  const start = existing.indexOf(managedStart);
  const end = existing.indexOf(managedEnd);
  if (start === -1 && end === -1) return `${existing.trimEnd()}\n\n${block}\n`;
  if (start === -1 || end === -1 || end < start) throw new Error("Native instruction file contains an incomplete Aiviron managed block");
  const suffix = end + managedEnd.length;
  return `${existing.slice(0, start)}${block}${existing.slice(suffix)}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

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

function reusableGeneratedAt(profile, projectId) {
  if (profile?.schemaVersion !== repositoryProfileSchema || profile.projectId !== projectId) return null;
  if (typeof profile.generatedAt !== "string" || !Number.isFinite(Date.parse(profile.generatedAt))) return null;
  return profile.generatedAt;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.aiviron-${process.pid}-${Date.now()}`;
  await writeFile(temporary, value, { encoding: "utf8", mode: 0o644, flag: "wx" });
  await rename(temporary, path);
}

async function assertSafeWritePath(repoRoot, path) {
  const local = relative(repoRoot, path);
  if (local === "" || local === ".." || local.startsWith(`..${sep}`)) throw new Error(`Generated path escapes the repository: ${path}`);
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
}

function ensureGitignoreState(existing) {
  if (existing === null) return "state/\n";
  const lines = existing.split(/\r?\n/);
  if (lines.includes("state/")) return existing;
  return `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}state/\n`;
}

async function planFile(repoRoot, path, content, { preserveExisting = false } = {}) {
  await assertSafeWritePath(repoRoot, path);
  const existing = await readOrNull(path);
  const finalContent = preserveExisting && existing !== null ? existing : content;
  return {
    path,
    relativePath: null,
    action: existing === null ? "create" : existing === finalContent ? "unchanged" : "update",
    content: finalContent,
    previous: existing,
    digest: digest(finalContent)
  };
}

export async function initializeEnvironment({
  cwd = process.cwd(),
  directory = ".",
  agents,
  name,
  dryRun = false,
  clock = () => new Date()
} = {}) {
  const target = resolve(cwd, directory);
  const selectedAgents = normalizeAgents(agents);
  const root = await resolveProjectRoot(target, { dryRun });
  const repoRoot = root.repoRoot;
  const projectName = name?.trim() || basename(repoRoot);
  const repository = await detectRepository(repoRoot);
  const projectId = stableOpaqueId("prj", repository.remote || repoRoot);
  const initializedAt = clock().toISOString();
  const profilePath = join(repoRoot, ".ai", "repository", "profile.json");
  await assertSafeWritePath(repoRoot, profilePath);
  const existingProfile = await readJsonOrNull(profilePath);
  const profile = {
    schemaVersion: repositoryProfileSchema,
    generatedBy: `aiviron/${generatorVersion}`,
    generatedAt: reusableGeneratedAt(existingProfile, projectId) || initializedAt,
    projectId,
    name: projectName,
    ...repository,
    selectedAgents,
    authentication: { mode: "installed-subscription", apiKeysRequired: false }
  };
  const environmentReadmePath = join(repoRoot, ".ai", "README.md");
  const environmentGitignorePath = join(repoRoot, ".ai", ".gitignore");
  await assertSafeWritePath(repoRoot, environmentReadmePath);
  await assertSafeWritePath(repoRoot, environmentGitignorePath);
  const existingEnvironmentReadme = await readOrNull(environmentReadmePath);
  const existingEnvironmentGitignore = await readOrNull(environmentGitignorePath);

  const candidates = [
    await planFile(repoRoot, join(repoRoot, ".ai", "config.yaml"), renderConfig({ projectId, projectName, agents: selectedAgents }), { preserveExisting: true }),
    await planFile(repoRoot, environmentReadmePath, upsertManagedBlock(existingEnvironmentReadme, renderEnvironmentReadme({ projectName, agents: selectedAgents }))),
    await planFile(repoRoot, profilePath, `${JSON.stringify(profile, null, 2)}\n`),
    await planFile(repoRoot, join(repoRoot, ".ai", "context", "policies.yaml"), renderContextPolicy(), { preserveExisting: true }),
    await planFile(repoRoot, join(repoRoot, ".ai", "knowledge", "policy.yaml"), renderKnowledgePolicy(), { preserveExisting: true }),
    await planFile(repoRoot, join(repoRoot, ".ai", "sessions", "policy.yaml"), renderSessionPolicy(), { preserveExisting: true }),
    await planFile(repoRoot, environmentGitignorePath, ensureGitignoreState(existingEnvironmentGitignore))
  ];
  const projectionPaths = { codex: "AGENTS.md", claude: "CLAUDE.md", gemini: "GEMINI.md" };
  for (const agent of selectedAgents) {
    const path = join(repoRoot, projectionPaths[agent]);
    await assertSafeWritePath(repoRoot, path);
    const existing = await readOrNull(path);
    candidates.push(await planFile(repoRoot, path, upsertManagedBlock(existing, renderProjection(agent))));
  }
  for (const candidate of candidates) candidate.relativePath = candidate.path.slice(repoRoot.length + 1);

  if (!dryRun) {
    const written = [];
    try {
      for (const candidate of candidates) {
        if (candidate.action === "unchanged") continue;
        await assertSafeWritePath(repoRoot, candidate.path);
        await atomicWrite(candidate.path, candidate.content);
        written.push(candidate);
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const candidate of written.reverse()) {
        try {
          if (candidate.previous === null) await unlink(candidate.path);
          else await atomicWrite(candidate.path, candidate.previous);
        } catch (rollbackError) {
          rollbackErrors.push(`${candidate.relativePath}: ${rollbackError.message}`);
        }
      }
      if (rollbackErrors.length) throw new Error(`${error.message}; rollback also failed: ${rollbackErrors.join("; ")}`);
      throw error;
    }
  }

  return {
    schemaVersion: "aiviron-init-result/v1alpha1",
    generatedAt: initializedAt,
    dryRun,
    repoRoot,
    gitInitialized: root.gitInitialized,
    projectId,
    projectName,
    mode: "subscription-first",
    agents: selectedAgents,
    files: candidates.map(({ relativePath, action, digest: contentDigest }) => ({ path: relativePath, action, digest: contentDigest })),
    nextSteps: [
      "Review and commit the generated project environment.",
      "Open the repository in your preferred AI coding agent.",
      "Describe the task normally; the agent operates the Aiviron harness.",
      "To switch agents, open the same repository and ask to continue the current task."
    ]
  };
}

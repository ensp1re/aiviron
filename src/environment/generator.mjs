import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { stableOpaqueId } from "../continuity/identity.mjs";

const execFileAsync = promisify(execFile);
const generatorVersion = "0.3.0";
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
  return `# Aiviron configuration; human-owned after generation\napiVersion: dev.aiviron/v1alpha1\nkind: AgentEnvironment\nmetadata:\n  projectId: ${yamlString(projectId)}\n  name: ${yamlString(projectName)}\nspec:\n  mode: subscription-first\n  agents:\n${agents.map((agent) => `    - ${yamlString(agent)}`).join("\n")}\n  canonicalState: .ai\n  runtimeState: .ai/state\n  intelligence:\n    index: .ai/state/repository/index.sqlite\n    retrievalProfile: hybrid-frozen-v1\n  context:\n    defaultBudgetTokens: 2048\n    strategy: hybrid\n  continuation:\n    packet: .ai/state/continuation/latest.md\n    defaultBudgetTokens: 4096\n    automaticCheckpoint: interactive-cli-exit\n  providerApi:\n    required: false\n    enabled: false\n  sessions:\n    handoff: operational-capsule\n    writerLease: one-agent-per-worktree\n  privacy:\n    transferProviderTranscript: false\n    transferHiddenReasoning: false\n`;
}

function renderEnvironmentReadme({ projectName, agents }) {
  return `${managedStart}\n# AI working environment for ${projectName}\n\nThis directory is the shared, provider-neutral project state for ${agents.join(", ")}. The installed agent application keeps its own native session, while this repository owns the durable task, repository index, compiled context, evidence, decisions, failures, Git state, and handoff packet.\n\n## Subscription-first contract\n\n- Use each installed agent through its normal account or subscription login.\n- Do not request an API key merely to use this environment.\n- Never treat a provider transcript or hidden reasoning as portable project state.\n- Keep one writing agent per worktree. Aiviron checkpoints before a switch.\n\n## Daily workflow\n\n\`\`\`bash\naiviron task start --objective "Describe the task" --agent codex\naiviron continue --agent codex\naiviron switch --to claude --summary "Ready to continue" --next "What remains"\n\`\`\`\n\n\`continue\` refreshes repository intelligence, compiles bounded context, checks drift, and launches the current agent. \`switch\` checkpoints first, projects the same task to the destination, and launches it with a fresh continuation packet. Use \`--no-launch\` to prepare state without opening an agent, or \`--dry-run\` to inspect a redacted launch.\n\nRepository intelligence, compiled packets, continuation packets, and mutable task data live in \`.ai/state/\` and are excluded from Git. Commit the rest of \`.ai/\` and the native instruction projections so every agent sees the same operating contract.\n${managedEnd}`;
}

function renderContextPolicy() {
  return `# Generated by Aiviron ${generatorVersion}\napiVersion: dev.aiviron/context-policy/v1alpha1\nkind: ContextPolicy\nspec:\n  compiler:\n    strategy: hybrid\n    profile: hybrid-frozen-v1\n    defaultBudgetTokens: 2048\n  objectiveAndConstraintsRequired: true\n  gitStateRequired: true\n  evidenceProvenanceRequired: true\n  preferSourceOverSummary: true\n  include:\n    - active-task\n    - changed-files\n    - decisions\n    - failures\n    - next-actions\n  exclude:\n    - hidden-reasoning\n    - provider-session-secrets\n`;
}

function renderSessionPolicy() {
  return `# Generated by Aiviron ${generatorVersion}\napiVersion: dev.aiviron/session-policy/v1alpha1\nkind: SessionPolicy\nspec:\n  checkpoint: interactive-exit-and-handoff\n  writerLease: one-agent-per-worktree\n  destinationReauthorizesEffects: true\n  driftPolicy: inspect-before-editing\n  portableState:\n    - objective\n    - repository\n    - changes\n    - evidence\n    - decisions\n    - failures\n    - next-actions\n`;
}

function renderProjection(agent) {
  const names = { codex: "Codex", claude: "Claude", gemini: "Gemini" };
  return `${managedStart}\n## Shared Aiviron environment\n\nThis repository uses a provider-neutral environment in \`.ai/\`. ${names[agent]} uses the user's normal installed-app/CLI subscription authentication; do not request a provider API key for ordinary work.\n\nAt the beginning of a task or after switching agents:\n\n1. Read \`.ai/README.md\`.\n2. If \`.ai/state/continuation/latest.md\` exists, read and follow that continuation packet. Otherwise, if \`.ai/state/current.json\` exists, run \`aiviron task resume --agent ${agent}\` and compile context with \`aiviron context build --for ${agent}\`.\n3. Inspect the current branch, Git status, diff, and relevant verification before editing.\n\nBefore switching agents, use \`aiviron switch --to <agent>\` from the controlling terminal. Persist objective progress, decisions, failures, evidence, and bounded next actions—not private reasoning or provider transcripts.\n${managedEnd}`;
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
      "Inspect the repository with: aiviron inspect",
      "Start work with: aiviron task start --objective \"...\" --agent codex",
      "Continue automatically with: aiviron continue --agent codex",
      "Switch automatically with: aiviron switch --to claude"
    ]
  };
}

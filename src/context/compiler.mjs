import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { sha256, stableOpaqueId } from "../continuity/identity.mjs";
import { putObject, readCurrentTask, writeJsonAtomic, writeTextAtomic } from "../continuity/store.mjs";
import { createRepositoryIndex } from "../intelligence/analyzer.mjs";
import { retrievalProfile, retrievalProfileRef } from "./retrieval-profile.mjs";
import { estimateTokens, searchTokens } from "./tokens.mjs";

const compilerVersion = "0.2.0";
const supportedPurposes = new Set(["plan", "implement", "review", "debug", "handoff", "evaluate"]);

function overlapCount(left, right) {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

function ftsQuery(tokens) {
  return tokens.slice(0, retrievalProfile.lexical.maxQueryTerms).map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

function sourcePenalty(path) {
  if (/(^|\/)(generated|vendor|dist|build)(\/|$)/i.test(path)) return retrievalProfile.lexical.generatedPenalty;
  if (/(^|\/)(docs?)(\/|$)|(?:legacy|obsolete|stale)/i.test(path)) return retrievalProfile.lexical.documentationPenalty;
  return 1;
}

function authorityWeight(path) {
  if (path === "AGENTS.md" || /^(?:CLAUDE|GEMINI)\.md$/.test(path)) return retrievalProfile.hybrid.instructionAuthority;
  if (/(^|\/)(generated|vendor|dist|build)(\/|$)/i.test(path)) return retrievalProfile.hybrid.generatedAuthority;
  if (/(^|\/)(docs?)(\/|$)|(?:legacy|obsolete|stale)/i.test(path)) return retrievalProfile.hybrid.documentationAuthority;
  if (/^(?:package\.json|pyproject\.toml|go\.work|.*\.mod)$/i.test(path)) return retrievalProfile.hybrid.manifestAuthority;
  return 1;
}

function candidateKey(candidate) {
  return `${candidate.path}:${candidate.startLine}:${candidate.endLine}`;
}

function fileContent(db, path, startLine, endLine) {
  const row = db.prepare("SELECT content, lines, authority, language FROM files WHERE path = ?").get(path);
  if (!row) return null;
  const lines = String(row.content).split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const boundedStart = Math.max(1, startLine);
  const boundedEnd = Math.min(Number(row.lines), endLine);
  const content = lines.slice(boundedStart - 1, boundedEnd).join("\n");
  return { content, startLine: boundedStart, endLine: boundedEnd, authority: row.authority, language: row.language };
}

function lexicalCandidates(db, queryTokens) {
  const query = ftsQuery(queryTokens);
  if (!query) return [];
  return db.prepare(`
    SELECT path, start_line AS startLine, end_line AS endLine, digest, content,
      bm25(chunks, 0.0, 0.0, 0.0, 0.0, ${retrievalProfile.lexical.contentWeight}, ${retrievalProfile.lexical.normalizedWeight}) AS rank
    FROM chunks
    WHERE chunks MATCH ?
    ORDER BY rank ASC, path ASC, start_line ASC
    LIMIT 64
  `).all(query).map((row) => ({
    path: row.path,
    startLine: Number(row.startLine),
    endLine: Number(row.endLine),
    digest: row.digest,
    content: row.content,
    estimatedTokens: estimateTokens(row.content),
    source: "lexical",
    reasons: ["lexical match"],
    rank: Number(row.rank) * sourcePenalty(row.path)
  })).sort((left, right) => left.rank - right.rank || left.path.localeCompare(right.path) || left.startLine - right.startLine);
}

function structuralCandidates(db, queryTokens) {
  const querySet = new Set(queryTokens);
  const fileScores = new Map();
  const candidates = [];
  const symbols = db.prepare("SELECT path, name, kind, start_line AS startLine, end_line AS endLine FROM symbols").all();
  const files = db.prepare("SELECT path, lines FROM files").all();
  for (const file of files) fileScores.set(file.path, overlapCount(searchTokens(file.path), querySet) * 2);
  for (const symbol of symbols) {
    const pathOverlap = overlapCount(searchTokens(symbol.path), querySet);
    const symbolOverlap = overlapCount(searchTokens(symbol.name), querySet);
    const kindOverlap = overlapCount(searchTokens(symbol.kind), querySet);
    const score = symbolOverlap * retrievalProfile.structural.symbolWeight +
      pathOverlap * retrievalProfile.structural.pathWeight +
      kindOverlap * retrievalProfile.structural.kindWeight;
    if (score <= 0) continue;
    fileScores.set(symbol.path, Math.max(fileScores.get(symbol.path) ?? 0, score));
    const expanded = fileContent(db, symbol.path, Number(symbol.startLine) - 3, Number(symbol.endLine) + 12);
    if (!expanded?.content) continue;
    candidates.push({
      path: symbol.path,
      startLine: expanded.startLine,
      endLine: expanded.endLine,
      content: expanded.content,
      digest: sha256(expanded.content),
      estimatedTokens: estimateTokens(expanded.content),
      source: "structural",
      reasons: [`symbol match: ${symbol.name}`],
      score
    });
  }
  for (const file of files) {
    const pathOverlap = overlapCount(searchTokens(file.path), querySet);
    if (pathOverlap <= 0) continue;
    const selected = fileContent(db, file.path, 1, Math.min(20, Number(file.lines)));
    if (!selected?.content) continue;
    candidates.push({
      path: file.path,
      startLine: selected.startLine,
      endLine: selected.endLine,
      content: selected.content,
      digest: sha256(selected.content),
      estimatedTokens: estimateTokens(selected.content),
      source: "structural",
      reasons: ["file path match"],
      score: pathOverlap * retrievalProfile.structural.filePathWeight
    });
  }

  const seeds = new Set([...fileScores.entries()].filter(([, score]) => score >= retrievalProfile.structural.seedMinimum).map(([path]) => path));
  const neighbors = new Set();
  for (const edge of db.prepare("SELECT source, target FROM edges").all()) {
    if (seeds.has(edge.source)) neighbors.add(edge.target);
    if (seeds.has(edge.target)) neighbors.add(edge.source);
  }
  for (const candidate of candidates) {
    if (neighbors.has(candidate.path)) {
      candidate.score += retrievalProfile.structural.dependencyNeighborBoost;
      candidate.reasons.push("dependency neighbor");
    }
  }
  const candidatePaths = new Set(candidates.map((candidate) => candidate.path));
  for (const path of neighbors) {
    if (candidatePaths.has(path)) continue;
    const file = files.find((candidate) => candidate.path === path);
    const selected = file ? fileContent(db, path, 1, Math.min(20, Number(file.lines))) : null;
    if (!selected?.content) continue;
    candidates.push({
      path,
      startLine: selected.startLine,
      endLine: selected.endLine,
      content: selected.content,
      digest: sha256(selected.content),
      estimatedTokens: estimateTokens(selected.content),
      source: "structural",
      reasons: ["dependency neighbor"],
      score: retrievalProfile.structural.dependencyNeighborBoost
    });
  }
  return candidates.sort((left, right) => right.score - left.score || left.estimatedTokens - right.estimatedTokens || left.path.localeCompare(right.path) || left.startLine - right.startLine);
}

function fuse(lexical, structural) {
  const records = new Map();
  const lists = [lexical, structural];
  const exactKeys = lists.map((list) => new Set(list.map(candidateKey)));
  const fileRanks = lists.map((list) => {
    const ranks = new Map();
    list.forEach((candidate, index) => { if (!ranks.has(candidate.path)) ranks.set(candidate.path, index + 1); });
    return ranks;
  });
  lists.forEach((list, listIndex) => {
    list.forEach((candidate, index) => {
      const id = candidateKey(candidate);
      const record = records.get(id) ?? { candidate, score: 0, sources: new Set(), reasons: new Set(candidate.reasons) };
      const weight = listIndex === 0 ? retrievalProfile.hybrid.lexicalWeight : retrievalProfile.hybrid.structuralWeight;
      record.score += weight / (retrievalProfile.hybrid.rrfK + index + 1);
      record.sources.add(listIndex === 0 ? "lexical" : "structural");
      const otherRank = fileRanks[1 - listIndex].get(candidate.path);
      if (otherRank && !exactKeys[1 - listIndex].has(id)) {
        record.score += retrievalProfile.hybrid.fileAgreementWeight / (retrievalProfile.hybrid.rrfK + otherRank);
        record.reasons.add("lexical and structural file agreement");
      }
      records.set(id, record);
    });
  });
  const ranked = [...records.values()].map((record) => ({
    ...record.candidate,
    score: record.score * authorityWeight(record.candidate.path),
    source: record.sources.size > 1 ? "hybrid" : [...record.sources][0],
    reasons: [...record.reasons]
  })).sort((left, right) => right.score - left.score || left.estimatedTokens - right.estimatedTokens || left.path.localeCompare(right.path) || left.startLine - right.startLine);
  const maximum = ranked[0]?.score || 1;
  return ranked.map((candidate) => ({ ...candidate, normalizedScore: candidate.score / maximum }));
}

function instructionPaths(agent) {
  if (agent === "claude") return ["AGENTS.md", "CLAUDE.md"];
  if (agent === "gemini") return ["AGENTS.md", "GEMINI.md"];
  return ["AGENTS.md"];
}

function mandatoryCandidates(db, agent) {
  const candidates = [];
  for (const path of instructionPaths(agent)) {
    const row = db.prepare("SELECT content, lines FROM files WHERE path = ?").get(path);
    if (!row) continue;
    const content = String(row.content).replace(/\n$/, "");
    candidates.push({
      path,
      startLine: 1,
      endLine: Number(row.lines),
      content,
      digest: sha256(content),
      estimatedTokens: estimateTokens(content),
      source: "instruction",
      reasons: ["mandatory agent instructions"],
      normalizedScore: 1,
      mandatory: true
    });
  }
  return candidates;
}

function overlaps(left, right) {
  return left.path === right.path && left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function markdownLanguage(path) {
  const extension = path.split(".").at(-1)?.toLowerCase();
  const aliases = { mjs: "js", cjs: "js", jsx: "jsx", tsx: "tsx", py: "python", rb: "ruby", rs: "rust", yml: "yaml" };
  return aliases[extension] ?? extension ?? "text";
}

function renderHeader({ query, repository, agent, purpose, strategy, profile }) {
  return `# Aiviron context packet\n\nObjective: ${query}\nConsumer: ${agent}\nPurpose: ${purpose}\nRepository: ${repository.head} on ${repository.branch ?? "detached"}\nRetrieval: ${strategy} (${profile.id}@${profile.version})\n`;
}

function renderCandidate(candidate) {
  const reasons = candidate.reasons.join("; ");
  const fence = candidate.content.includes("```") ? "````" : "```";
  return `\n## ${candidate.path}:${candidate.startLine}-${candidate.endLine}\n\nSource: ${candidate.source}; reasons: ${reasons}\n\n${fence}${markdownLanguage(candidate.path)}\n${candidate.content}\n${fence}\n`;
}

function packCandidates({ header, mandatory, ranked, budgetTokens }) {
  const selected = [];
  let rendering = header;
  for (const candidate of mandatory) {
    const block = renderCandidate(candidate);
    if (estimateTokens(rendering + block) > budgetTokens) {
      throw new Error(`Mandatory instructions exceed the ${budgetTokens}-token context budget; increase --budget`);
    }
    rendering += block;
    selected.push(candidate);
  }
  for (const candidate of ranked) {
    if (selected.some((current) => overlaps(current, candidate))) continue;
    const block = renderCandidate(candidate);
    if (estimateTokens(rendering + block) > budgetTokens) continue;
    rendering += block;
    selected.push(candidate);
  }
  return { selected, rendering, usedTokens: estimateTokens(rendering) };
}

async function resolveRequest(repoRoot, explicitQuery) {
  let task = null;
  try {
    task = await readCurrentTask(repoRoot);
  } catch (error) {
    if (!/No active Aiviron task exists/.test(error.message)) throw error;
  }
  const explicit = explicitQuery?.trim();
  const query = explicit || task?.objective?.trim();
  if (!query) throw new Error("Context objective is required; pass --task <text> or start an Aiviron task");
  const taskId = task?.taskId ?? stableOpaqueId("tsk", query);
  const details = explicit || (task ? [task.objective, ...(task.nextActions ?? []), ...(task.decisions ?? []), ...(task.failures ?? [])].join("\n") : query);
  return { query, queryText: details, taskId, task };
}

function repoUri(path) {
  return `repo:///${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function stateIsReady(repoRoot) {
  try {
    const stat = await lstat(join(repoRoot, ".ai", ".gitignore"));
    return stat.isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function compileContext({
  cwd = process.cwd(),
  task: explicitQuery,
  agent = "codex",
  purpose = "implement",
  budgetTokens = 2048,
  clock = () => new Date()
} = {}) {
  const started = performance.now();
  const budget = Number(budgetTokens);
  if (!Number.isInteger(budget) || budget < 128 || budget > 100000) throw new Error("Context budget must be an integer from 128 to 100000 tokens");
  if (!supportedPurposes.has(purpose)) throw new Error(`Unsupported context purpose: ${purpose}`);
  const indexed = await createRepositoryIndex({ cwd, persist: true, clock });
  const { db, report } = indexed;
  try {
    if (!await stateIsReady(report.repository.worktree)) throw new Error("Run aiviron init before building persistent context");
    const request = await resolveRequest(report.repository.worktree, explicitQuery);
    const queryTokens = searchTokens(request.queryText);
    const lexical = lexicalCandidates(db, queryTokens);
    const structural = structuralCandidates(db, queryTokens);
    const fused = fuse(lexical, structural);
    const mandatory = mandatoryCandidates(db, agent);
    const header = renderHeader({ query: request.query, repository: report.repository, agent, purpose, strategy: "rrf-fusion", profile: retrievalProfileRef });
    const packed = packCandidates({ header, mandatory, ranked: fused, budgetTokens: budget });
    const createdAt = clock().toISOString();
    const requestDigest = sha256(JSON.stringify({ query: request.queryText, agent, purpose, budget, repository: report.digest, profile: retrievalProfileRef }));
    const contextId = stableOpaqueId("ctx", requestDigest);
    const maximumScore = packed.selected.reduce((maximum, candidate) => Math.max(maximum, candidate.normalizedScore ?? 0), 1);
    const items = [];
    for (const candidate of packed.selected) {
      const content = await putObject(report.repository.worktree, candidate.content, "text/plain");
      const instruction = candidate.source === "instruction";
      items.push({
        id: stableOpaqueId("item", `${contextId}:${candidateKey(candidate)}`),
        source: repoUri(candidate.path),
        kind: instruction ? "project-instructions" : "repository-evidence",
        trust: instruction ? "trusted" : "mixed",
        sensitivity: "internal",
        instruction,
        provenance: [{ uri: repoUri(candidate.path), digest: candidate.digest, line: { start: candidate.startLine, end: candidate.endLine }, observedAt: createdAt }],
        score: Math.max(0, Math.min(1, (candidate.normalizedScore ?? 0) / maximumScore)),
        tokenEstimate: candidate.estimatedTokens,
        status: "included",
        reasons: candidate.reasons,
        transformationLevel: "L0",
        content
      });
    }
    const rendering = await putObject(report.repository.worktree, packed.rendering, "text/markdown");
    const instructionIds = items.filter((item) => item.instruction).map((item) => item.id);
    const evidenceIds = items.filter((item) => !item.instruction).map((item) => item.id);
    const sections = [];
    if (instructionIds.length) sections.push({ id: "project-policy", order: 0, mandatory: true, itemIds: instructionIds, tokenEstimate: items.filter((item) => item.instruction).reduce((sum, item) => sum + item.tokenEstimate, 0) });
    if (evidenceIds.length) sections.push({ id: "repository-evidence", order: 1, mandatory: false, itemIds: evidenceIds, tokenEstimate: items.filter((item) => !item.instruction).reduce((sum, item) => sum + item.tokenEstimate, 0) });
    const manifest = {
      apiVersion: "dev.aiviron/v1alpha1",
      kind: "ContextManifest",
      id: contextId,
      taskId: request.taskId,
      createdAt,
      requestDigest,
      repository: report.repository,
      compiler: { id: "aiviron-context-compiler", version: compilerVersion, digest: retrievalProfileRef.digest },
      consumer: { adapter: agent },
      purpose,
      budget: { maxTokens: budget, reserveOutput: 0, reserveTools: 0, usedTokens: packed.usedTokens },
      items,
      sections,
      renderings: [{ adapter: agent, content: rendering, tokenCount: packed.usedTokens }],
      warnings: [
        ...(report.repository.dirty ? ["Repository is dirty; evidence is bound to the recorded dirty digest."] : []),
        ...(report.inventory.skipped.length ? [`${report.inventory.skipped.length} repository entries were skipped by indexing policy.`] : [])
      ]
    };
    const contextDirectory = join(report.repository.worktree, ".ai", "state", "context");
    await mkdir(contextDirectory, { recursive: true });
    const manifestPath = join(contextDirectory, `${contextId}.json`);
    const renderingPath = join(contextDirectory, `${contextId}.md`);
    await writeJsonAtomic(manifestPath, manifest);
    await writeTextAtomic(renderingPath, packed.rendering);
    return {
      manifest,
      manifestPath,
      renderingPath,
      rendering: packed.rendering,
      retrieval: {
        strategy: "rrf-fusion",
        profile: retrievalProfileRef,
        queryTokens,
        lexicalCandidates: lexical.length,
        structuralCandidates: structural.length,
        fusedCandidates: fused.length,
        selectedItems: items.length,
        performanceMs: performance.now() - started
      }
    };
  } finally {
    db.close();
  }
}

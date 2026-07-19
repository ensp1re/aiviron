# Aiviron

**A shared project workspace for better AI-assisted development.**

Aiviron gives AI coding agents a consistent workspace for understanding a project, compiling relevant repository context, tracking the current task, preserving progress, and continuing work across tools and sessions.

Requires Git and Node.js 22.13 or newer.

```bash
# Initialize the current repository
npx aiviron .

# Inspect the repository and build its local intelligence index
npx aiviron inspect

# Start durable work
npx aiviron task start --objective "Implement the selected change" --agent primary

# Compile an explainable context packet under a fixed token budget
npx aiviron context build --for codex --budget 2048 --explain

# Checkpoint and switch agents later
npx aiviron task handoff --to next-agent \
  --summary "Implementation complete; verification remains" \
  --next "Run the focused regression suite"
```

Aiviron generates a canonical `.ai/` workspace plus agent instruction files without overwriting existing human instructions. Its local repository index, compiled context packets, and mutable task state stay in `.ai/state/` and are excluded from Git.

## Repository intelligence and context

`aiviron inspect` scans Git-visible text files, detects stacks, manifests, commands, repository shape, symbols, and local dependency edges, then builds a local SQLite FTS index. `aiviron context build` combines lexical and structural evidence using a frozen reciprocal-rank-fusion profile, keeps mandatory agent instructions, applies source-authority penalties, and packs the result under the requested token budget.

```bash
# Human-readable repository report
npx aiviron inspect

# Machine-readable report
npx aiviron inspect --json

# Use the active task objective
npx aiviron context build --for claude --purpose implement

# Or compile for an explicit objective
npx aiviron context build \
  --task "Trace session TTL configuration" \
  --for codex \
  --budget 4096
```

Every compiled packet has a schema-valid manifest with repository revision, dirty-state evidence, provenance, selection reasons, scores, content digests, and exact token accounting.

To acquire a repository and start a task in one operation:

```bash
npx aiviron work owner/repository \
  --objective "Implement the selected change" \
  --agent primary
```

The GitHub path uses the authenticated `gh` account. It clones directly when writable and otherwise creates and clones your fork. See the [workflow guide](docs/workflow.md) and [continuity guide](docs/continuity-spike.md).

## What Aiviron owns

Aiviron leaves each agent's interface and execution flow intact. It provides the shared project layer around them:

- repository-native agent instructions;
- deterministic repository inventory, symbols, and dependency edges;
- explainable, token-budgeted context packets;
- the active objective and current agent;
- Git revision, branch, diff, and drift evidence;
- checkpoints, decisions, failures, and next actions;
- portable handoff capsules and resume packets.

It does not copy private reasoning, chat history, authentication, or permissions between agents.

## Local development

```bash
npm install
npm test
npm run aiviron -- --dry-run
npm run aiviron -- .
npm run aiviron -- inspect
npm run aiviron -- task start --objective "Describe the task" --agent primary
npm run aiviron -- context build --for codex --explain
npm run aiviron -- task handoff --to next-agent
```

The public source includes the runtime, versioned schemas, focused documentation, and runtime tests.

## Current limits

- Continuity currently targets one worktree and one writing agent at a time.
- Repository indexing currently performs a safe full rebuild; incremental updates are planned.
- Structural extraction uses deterministic built-in language heuristics; parser-backed expansion is planned.
- Context compilation is explicit; native application lifecycle hooks are not yet connected.
- Checkpoints are explicit; automatic application lifecycle hooks are not yet connected.
- Switching tools may require opening the repository and asking the destination agent to continue.
- Prior permissions never transfer; the destination agent must reauthorize effects.

## License

MIT

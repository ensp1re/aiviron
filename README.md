# Aiviron

**A shared project workspace for better AI-assisted development.**

Aiviron gives AI coding agents a consistent workspace for understanding a project, compiling relevant repository context, tracking the current task, preserving progress, and continuing work across tools and sessions.

Requires Git and Node.js 22.13 or newer.

```bash
# Initialize the current repository
npx aiviron .

# Start durable work
npx aiviron task start --objective "Implement the selected change" --agent codex

# Refresh intelligence, compile context, and launch Codex
npx aiviron continue --agent codex

# Checkpoint, rebuild context, and launch Claude later
npx aiviron switch --to claude \
  --summary "Implementation complete; verification remains" \
  --next "Run the focused regression suite"
```

Aiviron generates a canonical `.ai/` workspace plus agent instruction files without overwriting existing human instructions. Its local repository index, compiled context packets, and mutable task state stay in `.ai/state/` and are excluded from Git.

## Automatic continuation

`aiviron continue` reconstructs the active task, detects repository drift, refreshes the local index, compiles relevant evidence under one total token budget, and launches the current agent with the combined packet. When an interactive CLI exits successfully, Aiviron captures an automatic checkpoint.

`aiviron switch` checkpoints before changing the writer, compiles a destination-specific packet, and launches the new agent. A dry run previews the redacted invocation without changing the active writer.

```bash
npx aiviron continue --agent codex
npx aiviron continue --agent codex-oss --local-provider ollama
npx aiviron switch --to claude
npx aiviron switch --to codex-app

# Prepare files without opening an agent
npx aiviron continue --no-launch

# Preview without launching or persisting a handoff
npx aiviron switch --to claude --dry-run --json
```

Codex and Claude CLIs receive a compact initial instruction to load `.ai/state/continuation/latest.md`; keeping the full packet out of process arguments avoids command-line size and process-list exposure. Codex App opens the repository and discovers the same packet through the generated `AGENTS.md`.

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
- automatic drift-aware continuation and checkpointed agent switching;
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
npm run aiviron -- task start --objective "Describe the task" --agent codex
npm run aiviron -- context build --for codex --explain
npm run aiviron -- continue --agent codex --dry-run
npm run aiviron -- switch --to claude --dry-run
```

The public source includes the runtime, versioned schemas, focused documentation, and runtime tests.

## Current limits

- Continuity currently targets one worktree and one writing agent at a time.
- Repository indexing currently performs a safe full rebuild; incremental updates are planned.
- Structural extraction uses deterministic built-in language heuristics; parser-backed expansion is planned.
- Built-in launch adapters currently cover Codex CLI, Claude Code, Codex OSS, and Codex App.
- Interactive CLI exits receive an automatic checkpoint; desktop-app sessions still require an explicit checkpoint or switch when work is ready to hand off.
- Codex App does not accept initial-prompt injection from its CLI launcher, so it discovers the latest packet through the generated repository instructions.
- Prior permissions never transfer; the destination agent must reauthorize effects.

## License

MIT

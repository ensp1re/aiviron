# Arenv

**Keep AI coding work portable across Codex, Claude Code, Gemini CLI, and local agents.**

Arenv creates repository-owned agent instructions and durable task state. You keep using each installed agent through its normal subscription login—no provider API keys or separate API billing required.

```bash
# Initialize the current repository
npx arenv .

# Start durable work
npx arenv task start --objective "Implement the selected change" --agent codex

# Checkpoint and switch agents later
npx arenv task handoff --to claude \
  --summary "Implementation complete; verification remains" \
  --next "Run the focused regression suite"
```

Arenv generates a canonical `.ai/` environment plus native `AGENTS.md`, `CLAUDE.md`, and optional `GEMINI.md` projections without overwriting existing human instructions. Mutable task state stays in `.ai/state/` and is excluded from Git.

To acquire a repository and start a task in one operation:

```bash
npx arenv work owner/repository \
  --objective "Implement the selected change" \
  --agent codex
```

The GitHub path uses the authenticated `gh` account. It clones directly when writable and otherwise creates and clones your fork. See the [subscription-first workflow](docs/subscription-first-workflow.md) and [continuity guide](docs/continuity-spike.md).

## What Arenv owns

Arenv deliberately leaves model loops and chat interfaces to the coding agents themselves. It owns the portable layer between them:

- repository-native agent instructions;
- the active objective and current agent;
- Git revision, branch, diff, and drift evidence;
- checkpoints, decisions, failures, and next actions;
- provider-neutral handoff capsules and resume packets.

It does not copy hidden reasoning, provider transcripts, authentication, subscription state, permissions, or API credentials between agents.

## Local development

```bash
npm install
npm test
npm run arenv -- --dry-run
npm run arenv -- . --agents codex,claude
npm run arenv -- task start --objective "Describe the task" --agent codex
npm run arenv -- task handoff --to claude
```

The public source includes the runtime, versioned schemas, focused documentation, and runtime tests. The legacy `create-agent` and `agentctl` executable aliases remain available for compatibility.

## Current limits

- Continuity currently targets one worktree and one writing agent at a time.
- Checkpoints are explicit; automatic application lifecycle hooks are not yet connected.
- Desktop-only switching requires opening the repository and asking the destination agent to continue.
- Prior permissions never transfer; the destination agent must reauthorize effects.

## License

MIT

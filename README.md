# Aiviron

**A shared project workspace for better AI-assisted development.**

Aiviron gives AI coding agents a consistent workspace for understanding a project, tracking the current task, preserving progress, and continuing work across tools and sessions.

```bash
# Initialize the current repository
npx aiviron .

# Start durable work
npx aiviron task start --objective "Implement the selected change" --agent primary

# Checkpoint and switch agents later
npx aiviron task handoff --to next-agent \
  --summary "Implementation complete; verification remains" \
  --next "Run the focused regression suite"
```

Aiviron generates a canonical `.ai/` workspace plus agent instruction files without overwriting existing human instructions. Mutable task state stays in `.ai/state/` and is excluded from Git.

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
npm run aiviron -- task start --objective "Describe the task" --agent primary
npm run aiviron -- task handoff --to next-agent
```

The public source includes the runtime, versioned schemas, focused documentation, and runtime tests.

## Current limits

- Continuity currently targets one worktree and one writing agent at a time.
- Checkpoints are explicit; automatic application lifecycle hooks are not yet connected.
- Switching tools may require opening the repository and asking the destination agent to continue.
- Prior permissions never transfer; the destination agent must reauthorize effects.

## License

MIT

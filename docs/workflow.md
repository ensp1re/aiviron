# Aiviron workflow

Aiviron creates a shared, repository-owned workspace that AI coding agents can use to understand the project and continue ongoing work.

## End-to-end flow

1. Initialize Aiviron in an existing repository or acquire a repository with `aiviron work`.
2. Aiviron creates canonical `.ai/` project state and agent instruction files.
3. Start a durable task on an isolated Git branch.
4. Continue automatically: Aiviron refreshes the index, compiles context, checks drift, and launches the current agent.
5. Work with the AI agent or tool you prefer.
6. Switch automatically: Aiviron checkpoints the current work and launches the destination with a fresh packet.
7. Resume later from the same repository-owned state.

```bash
npx aiviron .

npx aiviron task start \
  --objective "Implement the selected change" \
  --agent codex

npx aiviron continue --agent codex

npx aiviron switch \
  --to claude \
  --summary "Implemented the change" \
  --next "Run the focused regression suite"
```

To acquire a repository and start work in one operation:

```bash
npx aiviron work owner/repository \
  --objective "Implement the selected change" \
  --agent codex
```

## Workspace ownership

- `.ai/config.yaml` defines the project workspace.
- `.ai/repository/profile.json` records deterministic repository observations.
- `.ai/context/` and `.ai/sessions/` define portable context and handoff behavior.
- `.ai/state/repository/index.sqlite` stores the local FTS, symbol, and dependency index.
- `.ai/state/context/` stores compiled manifests and rendered context packets.
- `.ai/state/continuation/latest.md` is the current agent-ready continuation packet; adjacent manifests bind it to task, repository, budget, and provenance.
- `.ai/state/` also contains mutable task state, checkpoints, and resume packets; it is excluded from Git.
- Agent instruction files project the shared workspace into conventions that coding agents can discover.

Aiviron transfers the objective, repository revision and diff, evidence, decisions, failures, and bounded next actions. Private reasoning, chat history, authentication, and prior permissions stay with the original tool.

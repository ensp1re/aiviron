# Arenv workflow

Arenv creates a shared, repository-owned workspace that AI coding agents can use to understand the project and continue ongoing work.

## End-to-end flow

1. Initialize Arenv in an existing repository or acquire a repository with `arenv work`.
2. Arenv creates canonical `.ai/` project state and agent instruction files.
3. Start a durable task on an isolated Git branch.
4. Work with the AI agent or tool you prefer.
5. Checkpoint completed work, decisions, failures, verification, and next actions.
6. Resume later or hand the task to another agent using the repository-owned state.

```bash
npx arenv .

npx arenv task start \
  --objective "Implement the selected change" \
  --agent primary

npx arenv task checkpoint \
  --summary "Implemented the change" \
  --next "Run the focused regression suite"

npx arenv task handoff \
  --to next-agent \
  --summary "Implementation complete; verification remains"
```

To acquire a repository and start work in one operation:

```bash
npx arenv work owner/repository \
  --objective "Implement the selected change" \
  --agent primary
```

## Workspace ownership

- `.ai/config.yaml` defines the project workspace.
- `.ai/repository/profile.json` records deterministic repository observations.
- `.ai/context/` and `.ai/sessions/` define portable context and handoff behavior.
- `.ai/state/` contains mutable local task state, checkpoints, and resume packets; it is excluded from Git.
- Agent instruction files project the shared workspace into conventions that coding agents can discover.

Arenv transfers the objective, repository revision and diff, evidence, decisions, failures, and bounded next actions. Private reasoning, chat history, authentication, and prior permissions stay with the original tool.

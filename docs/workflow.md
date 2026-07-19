# Aiviron workflow

Aiviron creates a repository-owned workspace that AI coding agents use automatically.

## User workflow

Initialize the repository once:

```bash
cd your-repository
npx aiviron .
```

Open that folder in Codex, Claude, or another compatible coding agent and describe the work normally. No separate Aiviron task session or manual context workflow is required.

If you switch tools or reach a usage limit, open the same repository in the next agent and ask it to continue the current task.

## Agent workflow

Generated repository instructions direct the agent through the internal lifecycle:

1. Translate the request into an objective and observable completion criteria.
2. Resume matching unfinished state or create a new task record.
3. Record a bounded plan.
4. Compile task-relevant repository context.
5. Treat selected files as a closed scope and justify every expansion.
6. Implement and run repository verification.
7. Persist evidence, decisions, failures, progress, and remaining work.
8. Complete the task or leave a checkpoint another agent can resume.

The lower-level Aiviron commands implement this agent protocol. They remain available for diagnostics and advanced automation, but they are not the normal user interface.

## Workspace ownership

- `.ai/config.yaml` defines the project workspace.
- `.ai/repository/profile.json` records deterministic repository observations.
- `.ai/context/` and `.ai/sessions/` define portable context and handoff policy.
- `.ai/state/repository/index.sqlite` stores the local search, symbol, and dependency index.
- `.ai/state/context/` stores bounded context manifests and packets.
- `.ai/state/tasks/<task-id>/` stores mutable task state, plans, verification receipts, checkpoints, capsules, and resume packets.
- `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` project the shared contract into native agent instructions.

Mutable `.ai/state/` data is local and ignored by Git. Stable environment configuration and instruction projections may be committed.

Aiviron transfers project state rather than private model state. Authentication, permissions, private reasoning, and provider transcripts remain with their original tool.

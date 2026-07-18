# Subscription-first workflow

**Status:** primary product path
**Authentication:** owned by each installed agent application; no provider API key required by Arenv

## End-to-end flow

1. Run `arenv` in an existing repository or give `arenv work` a local/GitHub source.
2. The initializer creates canonical `.ai/` project state and small native projections such as `AGENTS.md` and `CLAUDE.md`.
3. Start a durable task on an isolated Git branch.
4. Open or launch Codex, Claude Code, or another supported installed agent using its normal subscription login.
5. The agent reads the native projection, restores the objective and operational state, inspects Git, and continues the task.
6. Checkpoint completed work, decisions, failures, verification, and next actions.
7. When a session or subscription limit is reached, hand off to another installed agent. The destination gets a fresh resume packet derived from repository-owned state rather than a converted provider transcript.

```bash
# Existing repository
npx arenv . --agents codex,claude
git add .ai AGENTS.md CLAUDE.md
git commit -m "initialize shared agent environment"

npx arenv task start --objective "Implement the selected change" --agent codex
npx arenv task launch --agent codex

# Later, when switching subscriptions/tools
npx arenv task handoff --to claude \
  --summary "Implementation complete; verification remains" \
  --next "Run the focused regression suite"
npx arenv task launch --agent claude
```

For a repository that has not been acquired yet:

```bash
npx arenv work owner/repository \
  --objective "Implement the selected change" \
  --agent codex
```

The GitHub path uses the authenticated `gh` account: it clones directly when writable and otherwise creates/clones the user's fork. The same command generates the shared environment on the new task branch.

## State ownership

- `.ai/config.yaml` selects the project profile and installed-subscription mode.
- `.ai/repository/profile.json` records deterministic local repository observations.
- `.ai/context/` and `.ai/sessions/` define portable context and handoff behavior.
- `.ai/state/` contains mutable local task state, capsules, patches, and resume packets; it is excluded from Git.
- `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` are adapter projections. Existing human content is preserved outside Arenv's managed block.

Arenv transfers objective, repository revision/diff, evidence, decisions, failures, and bounded next actions. It does not transfer hidden reasoning, provider authentication, subscription state, or prior permissions.

## Application surfaces

Interactive CLI launchers can inject the resume packet as the initial prompt while preserving each tool's normal sandbox and approval behavior. A desktop application that cannot accept an initial prompt programmatically can still open the repository: its native instruction file directs the agent to run `arenv task resume` before continuing.

## Optional API mode

The repository contains experimental provider-gateway and paid benchmark artifacts. They are useful only for deployments that explicitly choose direct provider APIs. They are not needed for project initialization, ordinary subscription-agent work, checkpoints, or handoffs.

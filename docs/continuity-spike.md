# Repository intelligence and continuity

**Status:** executable v0.2 vertical slice; contracts remain alpha
**Scope:** inspect one repository, compile bounded task context, keep one active task, checkpoint operational state, and resume it in another interactive agent runtime

## Initialize a project

```bash
npx aiviron . --agents codex,claude
# equivalent explicit command
npx aiviron init . --agents codex,claude
```

Initialization creates the provider-neutral `.ai/` environment and managed sections in `AGENTS.md` and `CLAUDE.md`. Existing human instructions outside the managed section are preserved. `--dry-run` returns the exact file plan without creating a directory, initializing Git, or writing files.

## Inspect and compile context

```bash
npx aiviron inspect
npx aiviron context build \
  --task "Trace the session timeout configuration" \
  --for codex \
  --budget 2048 \
  --explain
```

Inspection considers Git-visible text files, refuses symbolic-link content, detects manifests and runnable package scripts, extracts deterministic symbols and local import edges, and persists an ignored SQLite FTS index. Context compilation combines lexical and structural rankings with a versioned retrieval profile, includes the destination agent's instructions, and emits both a rendered packet and a schema-valid manifest under `.ai/state/context/`.

If a durable task is active, its objective, next actions, decisions, and failures become the context query. `--task` can supply an objective directly. `--explain` reports every included source, score, token estimate, and selection reason.

## One-command workspace start

```bash
npx aiviron work openai/codex \
  --objective "Fix the selected issue and verify the change" \
  --agent codex
```

For a GitHub repository, `--fork auto` is the default. The command asks the authenticated GitHub CLI for `viewerPermission`: it clones the source directly for `WRITE`, `MAINTAIN`, or `ADMIN`; otherwise it creates the user's fork, clones it as `origin`, and records the source as `upstream`. `--fork always` and `--fork never` override that decision. GitHub acquisition requires a working `gh` login. A local path or non-GitHub Git URL uses `git clone` directly.

The command refuses an existing destination, requires an initial commit, creates an `aiviron/<task>` branch, generates the shared environment, and refuses to replace another active task. The generated environment is an intentional initial change on the new task branch so the user can review and commit it with the project.

## Current task and checkpoints

```bash
npx aiviron task status

npx aiviron task checkpoint \
  --summary "Implemented the timeout guard" \
  --completed "Reproduced the failure" \
  --completed "Implemented the guard" \
  --next "Add the regression test"
```

Local continuity state is written under `.ai/state/` and excluded by both the generated `.ai/.gitignore` and the repository's local Git exclude file. It therefore does not dirty the user's feature branch. Each checkpoint captures:

- task objective, progress, decisions, failures, and next actions;
- exact Git head, branch, dirty state, and a content digest of the worktree;
- a patch artifact and environment facts;
- a v1alpha1 Handoff Capsule whose artifact references resolve through the content-addressed object store.

The human-readable packet is persisted at `.ai/state/tasks/<task-id>/resume.md`.

## Switch and launch

Create a handoff without launching anything:

```bash
npx aiviron task handoff \
  --to claude \
  --summary "Codex limit reached after implementation" \
  --next "Add the regression test"
```

Create the capsule and immediately enter the destination's interactive CLI:

```bash
npx aiviron task handoff --to claude --launch
```

Resume or launch independently:

```bash
npx aiviron task resume --agent codex
npx aiviron task launch --agent codex
npx aiviron task launch --agent claude
npx aiviron task launch --agent codex-oss --local-provider ollama
```

Launch adapters inject the resume packet as the first interactive prompt but preserve the runtime's normal approval and sandbox behavior. They do not pass bypass flags. Use `--dry-run` to inspect a redacted invocation without starting an agent.

## Current limits

- The spike provides same-worktree continuity. Cross-machine transport still needs a safe export/import and Git push/restore protocol.
- Repository indexing currently performs a full rebuild, and structural extraction uses built-in language heuristics.
- Context compilation is explicit; automatic prompt injection is not yet connected to agent applications.
- Checkpoints are explicit. Automatic lifecycle hooks have not been connected to agent applications.
- Codex and Claude interactive CLIs accept an initial prompt. The Codex desktop `app` launcher opens a workspace but does not expose initial-prompt injection in the installed CLI, so desktop-only switching still requires opening the workspace and issuing `continue`.
- The capsule transfers operational evidence, not provider transcripts or hidden reasoning.
- Handoff is sequential. Two agents must not edit one worktree concurrently.
- GitHub fork behavior has deterministic unit boundaries, but no live fork was created during tests.

## Verification

The focused tests use temporary Git repositories and cover safe initialization, deterministic repository indexing, strict report and context contracts, bounded hybrid retrieval, preserved native instructions, branch isolation, checkpoint content identities, agent switching, drift detection, duplicate-task refusal, local repository acquisition, and redacted launch construction. They never contact GitHub or start a model.

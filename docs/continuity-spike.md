# Repository intelligence and continuity

**Status:** executable v0.3 vertical slice; contracts remain alpha
**Scope:** inspect one repository, compile bounded task context, automatically continue one active task, checkpoint operational state, and switch it to another interactive agent runtime

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

## Continue automatically

```bash
npx aiviron continue --agent codex
```

This command refreshes the repository index, reconstructs the current task and drift state, allocates one total token budget between orchestration state and repository evidence, persists a `ContinuationManifest`, and launches the current agent. Successful interactive CLI exits create an automatic checkpoint.

Use `--no-launch` to build `.ai/state/continuation/latest.md` without opening an agent. Use `--dry-run --json` to inspect a redacted invocation.

## Switch and launch

Checkpoint, change the writer, compile fresh destination context, and launch in one operation:

```bash
npx aiviron switch \
  --to claude \
  --summary "Codex limit reached after implementation" \
  --next "Add the regression test"
```

Prepare the complete switch without opening the destination:

```bash
npx aiviron switch --to claude --no-launch
```

Resume or launch independently:

```bash
npx aiviron task resume --agent codex
npx aiviron task launch --agent codex
npx aiviron task launch --agent claude
npx aiviron task launch --agent codex-oss --local-provider ollama
```

Launch adapters inject a compact instruction to load the complete packet from `.ai/state/continuation/latest.md`, keeping the full context out of process arguments while preserving the runtime's normal approval and sandbox behavior. They do not pass bypass flags. Codex App opens the workspace and discovers the same file through generated repository instructions because its CLI launcher has no initial-prompt argument.

## Current limits

- The spike provides same-worktree continuity. Cross-machine transport still needs a safe export/import and Git push/restore protocol.
- Clean unchanged revisions reuse the local index; changed revisions receive a safe full refresh. Structural extraction uses built-in language heuristics.
- Successful Codex, Claude, and Codex OSS CLI exits are checkpointed automatically. Desktop applications return control when the workspace opens, so their later edits still require an explicit checkpoint or switch.
- Codex App opens the workspace but does not expose initial-prompt injection in its CLI launcher; generated repository instructions direct it to the persisted packet.
- The capsule transfers operational evidence, not provider transcripts or hidden reasoning.
- Handoff is sequential. Two agents must not edit one worktree concurrently.
- GitHub fork behavior has deterministic unit boundaries, but no live fork was created during tests.

## Verification

The focused tests use temporary Git repositories and cover safe initialization, deterministic repository indexing, strict report, context, and continuation contracts, bounded hybrid retrieval, drift-aware packet assembly, non-mutating switch previews, checkpointed writer changes, preserved native instructions, branch isolation, duplicate-task refusal, local repository acquisition, and redacted launch construction. They never contact GitHub or start a model.

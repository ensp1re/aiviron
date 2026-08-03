# Aiviron

**A ready-to-use workspace for AI coding agents.**

[![npm version](https://img.shields.io/npm/v/aiviron.svg)](https://www.npmjs.com/package/aiviron)

Aiviron prepares any Git repository so Codex, Claude, and other coding agents can understand the project, work with focused context, verify changes, preserve progress, and continue across tools or sessions.

It does not replace your AI application. It improves the environment around it.

## Quick start

Requires Git and Node.js 22.13 or newer.

```bash
cd your-repository
npx aiviron@latest .
```

Using `@latest` avoids running an older cached release. If you prefer a global command:

```bash
npm install --global aiviron@latest
aiviron .
```

Then open the repository in your preferred AI coding tool and prompt normally:

> Add password reset to the authentication flow.

That is the complete user workflow. You do not need to manually create Aiviron tasks, build context packets, record checkpoints, or operate a separate agent runner.

## What happens automatically

The generated project instructions teach the active agent to follow the shared harness:

```text
understand request
→ define completion criteria
→ select relevant files
→ create a focused plan
→ implement
→ verify
→ preserve task state and evidence
```

Context is closed by default. The agent is instructed to inspect and edit only files selected for the task. If another file becomes necessary, it records why, expands the scope, and rebuilds the bounded context before continuing.

Aiviron also checks changed files at lifecycle boundaries, so an agent cannot checkpoint, hand off, verify, or complete work with undeclared out-of-context changes.

## Switch agents without starting over

If you reach a Codex limit, close it and open the same repository in Claude. Then say:

> Continue the current task.

The destination agent reads the repository-owned task state, current plan, selected context, Git diff, decisions, failures, verification evidence, and remaining work. The same approach works in the opposite direction and with other agents that follow repository instructions.

Private reasoning, chat history, authentication, and previous permissions are never transferred.

## What Aiviron creates

Aiviron adds a small provider-neutral workspace without overwriting existing human instructions:

```text
.ai/
├── README.md
├── config.yaml
├── context/
├── knowledge/      reusable documentation policy and provenance
├── repository/
├── sessions/
└── state/          local, ignored runtime state

AGENTS.md           shared agent instructions
CLAUDE.md           Claude projection, when selected
GEMINI.md           Gemini projection, when selected
```

The generated environment provides:

- repository-native instructions for every selected agent;
- a local repository index with symbols and dependency relationships;
- explainable, token-budgeted context selection;
- closed task-specific file scope;
- acceptance criteria and focused execution plans;
- verification receipts bound to the exact repository state;
- durable checkpoints, decisions, failures, and next actions;
- portable session and agent handoffs;
- adaptive, source-controlled project knowledge.

Mutable state and compiled packets remain under `.ai/state/` and are excluded from Git. The stable environment configuration and instruction files can be committed so every agent sees the same project contract.

## Reusable project knowledge

Task context is local and temporary. Project knowledge is reusable: Aiviron can select documentation from the detected repository stack and store it under `docs/ai/` so it can be committed and shared.

The documentation structure is adaptive. Aiviron always considers an overview and architecture map, then adds only supported areas such as APIs, user interfaces, data, CLI behavior, library APIs, deployment, operations, security, integrations, and testing. It does not assume a frontend/backend project structure.

Agents operate the documentation protocol automatically. The lower-level commands are also available for diagnostics:

```bash
# Preview the documents selected from repository evidence
npx aiviron docs plan

# Create missing managed documents without overwriting human files
npx aiviron docs init

# Refresh source evidence for affected documents
npx aiviron docs update --changed

# Find missing, incomplete, stale, or orphaned documents
npx aiviron docs check
```

`.ai/knowledge/manifest.json` records document ownership and source digests. Aiviron updates only its managed evidence blocks. Human-owned files and agent-authored guidance outside those blocks remain unchanged.

## Context efficiency

Aiviron does not place the whole repository into every prompt. It selects relevant source evidence using lexical matches, symbols, file paths, and local dependency relationships, then packs that evidence under a fixed token budget.

Clean unchanged repositories reuse the local index without rereading every file. Only selected files enter the agent packet; verification programs may inspect whatever the project itself requires, but their source files are not copied into model context.

## Optional diagnostics

Normal work does not require these commands. They are available for inspection, debugging, and automation:

```bash
# Inspect detected repository structure and commands
npx aiviron inspect

# Explain what entered the bounded context
npx aiviron context build --task "Trace session expiration" --explain

# Inspect reusable project documentation
npx aiviron docs check

# Validate that changed files remain inside the active scope
npx aiviron context check

# Show the current durable task state
npx aiviron task status
```

The lower-level task, context, verification, continuation, and handoff commands are primarily the protocol used by generated agent instructions. They remain available for advanced workflows without becoming part of the everyday user experience.

## Working on a remote repository

You can also acquire a GitHub repository and prepare it in one operation:

```bash
npx aiviron work owner/repository \
  --objective "Implement the requested change" \
  --agent codex
```

Aiviron uses the authenticated `gh` account, cloning directly when writable and otherwise creating and cloning your fork.

## Local development

```bash
npm install
npm test
npm run aiviron -- .
```

## Current limits

- Aiviron coordinates one writing agent per worktree.
- Dirty or newly committed revisions currently receive a safe full index refresh.
- Structural extraction uses deterministic built-in language heuristics.
- Native desktop applications rely on generated repository instructions because they do not all expose lifecycle hooks.
- Previous permissions never transfer to another agent or session.

## License

MIT

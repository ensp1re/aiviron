# Adaptive project knowledge

Aiviron separates local task context from reusable project knowledge.

- `.ai/state/` contains ignored runtime state for the current checkout.
- `docs/ai/` contains project knowledge intended for version control.
- `.ai/knowledge/manifest.json` records ownership and source provenance.

## Capability-based selection

`aiviron docs plan` inspects repository paths, manifests, dependencies, commands, workspaces, and source signals. It selects a small core documentation set and adds capability modules only when evidence supports them.

Supported modules include API, UI, data, CLI, library, deployment, operations, security, integrations, and testing. A mixed monorepo can select several modules. An unfamiliar language still receives generic overview and architecture documents.

Each capability includes a confidence score and the files that supported the decision. Use `--json` to inspect the complete evidence.

## Safe generation

`aiviron docs init` creates missing documents and a knowledge manifest. Existing files without Aiviron markers are treated as human-owned and remain unchanged.

A generated document has two areas:

1. A managed evidence block that Aiviron can refresh.
2. An authoring area where the active agent records verified explanations and conventions.

The agent removes the `aiviron:authoring-needed` marker after replacing the prompt with source-backed knowledge. Future updates preserve this authored area.

## Freshness

`aiviron docs check` compares the manifest with the current repository. It reports:

- missing manifests or documents;
- incomplete authoring prompts;
- changed or missing source evidence;
- newly detected documentation modules;
- modules that are no longer detected.

Use `aiviron docs update --changed` to refresh only affected managed evidence blocks. Source code remains the final implementation authority.

## Context retrieval

Manifest-backed documents participate in normal context selection as project knowledge. Fresh generated knowledge receives more authority than ordinary documentation, while reviewed human knowledge receives slightly more. Stale knowledge is strongly down-ranked and produces a warning when selected.

Use context purpose `document` when compiling evidence for documentation work:

```bash
npx aiviron context build \
  --task "Document the authentication architecture" \
  --purpose document
```

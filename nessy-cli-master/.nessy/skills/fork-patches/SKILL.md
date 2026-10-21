---
name: fork-patches
description: Maintain nessy-cli fork patch documentation and code markers for
  local changes kept on top of upstream. Use when adding, changing, reviewing,
  or removing.
---

# Fork Patch Workflow

Use this skill for local nessy-cli changes that are intentionally kept as fork
patches on top of upstream. The goal is to make every fork-only behavior easy to
find, review during upstream merges, and remove when upstream accepts an
equivalent fix.

## Source Of Truth

First read `docs/fork-patches/README.md`. Treat it as the current project rule
for fork patches. Do not rely on stale memory of the table or file format.

## Extract Task ID from Branch Name

**BEFORE creating or updating a patch file:**

1. Run `git branch --show-current` to get the current branch name.
2. Extract the task ID from the branch name (e.g., `fix/update-standalone` → no ID, `feat/AIDT-6403-something` → `AIDT-6403`).
3. Use the extracted task ID in the `## AIDT` section of the patch file.
4. If no task ID found in branch name, ask the user for the task ID or use `-`.

**Example branch patterns:**
- `feat/AIDT-6403-description` → `AIDT-6403`
- `fix/AIDT-6362-something` → `AIDT-6362`
- `AIDT-6403-something` → `AIDT-6403`
- `fix/update-standalone` → no ID (ask user or use `-`)

## When To Apply

Apply this workflow when the change:

- Adds or changes fork-only behavior.
- Adds compatibility, local policy, MCP/tooling, prompt, runtime, or CLI behavior
  that upstream does not have.
- Updates an existing entry under `docs/fork-patches/`.
- Removes a fork patch because upstream now covers it.

Do not use this workflow for ordinary upstream-compatible fixes unless the user
explicitly asks to track them as a fork patch.

## Required Artifacts

For every active fork patch:

1. Create or update `docs/fork-patches/<slug>.md`.
2. Add or update one row in `docs/fork-patches/README.md`.
3. Mark the relevant code point with:

```ts
// [nessy-fork] <slug>
```

Use one stable slug everywhere. Prefer short kebab-case names that describe the
behavior, not the implementation detail.

## Patch Description

The patch file should stay concise and include:

- `# <slug>`
- `## AIDT` with the ticket id extracted from branch name (or `-` if not found)
- `## Зачем` explaining the behavior gap and why this fork patch exists
- `## Файлы` listing only files that are actually changed by the patch
- `## Откат` with practical removal steps for an upstream-equivalent fix
- `## Upstream` with current upstream/MR status, or `Не отправлен.`

Keep the description aligned with the live diff. If prompt files, tests, or
helpers were reverted, remove them from `## Файлы` and `## Откат`.

## Code Markers — CRITICAL RULE

**STRICT PROHIBITION: DO NOT MODIFY CODE IF ONLY MARKING IS REQUIRED**

When adding fork patch documentation for existing changes:

1. **DO NOT** change code logic, behavior, or structure.
2. **ONLY** add `// [nessy-fork] <slug>` comments at integration points.
3. **ONLY** update documentation files (`docs/fork-patches/*.md`, `README.md`).

**When code changes ARE allowed:**
- Adding new fork-only behavior (not just documenting existing).
- Removing a fork patch (cleaning up fork-specific code).
- User explicitly requests code changes alongside documentation.

**When code changes are FORBIDDEN:**
- Simply documenting existing fork-only changes (postfactum).
- Adding markers to code that already implements the fork behavior.
- Updating README.md or patch files without behavioral changes.

Place `[nessy-fork]` comments at integration points, not everywhere the behavior
flows. For shared helpers or focused tests, one marker near the top is enough.
Avoid noisy marker duplication.

Comments should identify the fork patch only. Do not use comments to narrate
the implementation or talk to the user.

## Validation

Before declaring the work done:

- Compare `git diff --name-only` with the patch file's `## Файлы`.
- Search the slug in code and docs to confirm the README row, patch file, and
  code marker agree.
- Run the focused tests for changed packages when behavior changed.
- Run `npm run build && npm run typecheck` for non-trivial TypeScript changes,
  unless the user explicitly limits verification.

## Removal

When removing a fork patch:

- Remove or adapt the fork-specific code.
- Remove obsolete `[nessy-fork] <slug>` markers.
- Remove the README row and patch file only after the behavior is no longer
  fork-only.
- Keep tests if they are still valid upstream-compatible regression coverage.

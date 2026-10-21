# S1, S2 — instruction files below the cwd, and what `/context` advises

Two new rows from step 3. Both are completeness, and both are about a user
being told something true but incomplete.

## 0. Method rules

1. `curl -s https://code.claude.com/docs/en/memory.md` and `.../context-window.md`
   (plus `debug-your-config.md`). Quote WHOLE lines — `memory.md:63` and `:157`
   say the same thing from two directions and `:447` adds the reload rule.
2. **Declared ≠ enforced.** Prove on **Pi**, the shipped default. Reproduce
   each gap before fixing.
3. **NUL bytes** — always `grep -a` for absence claims; never `head -N` a grep
   whose hit count you have not counted (a production call site sorting below
   the cut has already produced one false "dead code" finding in this audit).
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.** Check no other `bun test` is
   running before recording a new failure.
6. CDP may be on 9223 — do not kill or drive it; do not run
   `electron:build:servers`.

---

## 1. Task 1 — a subdirectory's instruction file loads when it is read (S1)

**Commit:** `feat(instructions): a subdirectory instruction file loads on demand`

`memory.md:157` whole: "Claude also discovers `CLAUDE.md` and `CLAUDE.local.md`
files in subdirectories under your current working directory. Instead of loading
them at launch, they are included when Claude reads files in those
subdirectories." `:63` states it from the other side; `:447`: nested files "are
not re-injected automatically; they reload the next time Claude reads a file in
that subdirectory."

Today discovery walks **ancestors only** (`capabilities/native-sources.ts:938-954`,
`ancestorsUpTo(...)`), and the one lazy channel is keyed strictly to rule files
with `paths:` frontmatter (`base-agent.ts:855-866`). A plain `AGENTS.md` or
`CLAUDE.md` in a package **below** the cwd is never loaded on any path. In a
monorepo — which this repo is — that is the common case: a package's own
instruction file never reaches the model.

- **Reuse the lazy channel that exists.** R28 built the on-read delivery hop for
  path-scoped rules (`consumePendingPathScopedRuleContext`, delivered on Pi at
  `pi-agent.ts:3798` and on the Claude backend by `7c2fc7c0`). A nested
  instruction file is the same shape: activated by a read under its directory,
  delivered once per generation. Do NOT build a second delivery mechanism.
- The activation predicate is directory containment, not a glob: a read of
  `packages/foo/src/x.ts` activates `packages/foo/AGENTS.md` and every
  instruction file between it and the cwd that is not already loaded eagerly.
- **`nested_traversal` exists as a `load_reason` with zero producers** — it is
  in the union (`automations/types.ts:822`) and nothing emits it. This is its
  reason to exist; emit it, and make the existing register string that claims
  "every nested instruction file is loaded eagerly" true or corrected.
- Bound it: an instruction file is loaded **once** per generation, and the
  number of distinct nested files a session can accumulate needs a cap with a
  stated number, or a deep monorepo turns every read into context growth.
- `AGENTS.md` is this repo's own spelling and is already in
  `PROJECT_INSTRUCTION_FILES` — keep all three names.
- **`pi-agent.ts` and `SessionManager.ts` are LOCKED to a sibling.** If the
  delivery hop needs either, land the discovery and activation halves and report
  the residual word for word.

**Gate:** reading a file under a subdirectory with its own instruction file
activates it once, emits `InstructionsLoaded` with `load_reason:
'nested_traversal'`, and the body reaches the model on Pi; a second read does
not re-activate; a file above the cwd still loads eagerly; the cap holds.
**Mutation:** remove the activation call → the on-read test goes red.

---

## 2. Task 2 — `/context` says what to do about it (S2)

**Commit:** `feat(context): the breakdown carries optimization suggestions`

`context-window.md:1616` whole: "The visualization uses representative numbers.
To see your actual context usage at any point, run `/context` for a live
breakdown by category with optimization suggestions, including which CLAUDE.md
and auto memory files loaded. Run `/memory` to open and edit those files."

We ship the breakdown, the loaded-file list and the over-limit warnings; there
is no suggestion producer anywhere (`ContextCategoryBreakdown` carries categories
and totals, no advisory field).

- Produce suggestions **beside the measurement**, in
  `pi-agent-server/src/context-categories.ts`, from the same numbers the rows
  are built from — so a suggestion can never disagree with the row above it.
- Keep the rule set small, honest and specific. Each suggestion must name the
  category it is about, the observed number that triggered it, and an action the
  user can actually take in this product. A suggestion pointing at a control we
  do not have is worse than none. Candidates the docs themselves supply: a
  context-heavy MCP server (tool search / `alwaysLoad` are real controls here —
  S14 shipped them), memory-file bloat (`/memory` equivalent), a skill set whose
  descriptions dominate (`disable-model-invocation` per `skills.md:339` — check
  we have it before suggesting it).
- **The R11 fix landed today** (`3335307a`): internal session tools are system
  tools, not MCP tools. Suggestions must be computed after that split or they
  will advise removing MCP servers a user does not have.
- i18n: keys in every locale file, parity + sorted green. The overlay's existing
  strings are the style to match.
- Playground: the overlay is a design surface — add the suggestion states.

**Gate:** a composition with a large MCP surface yields a suggestion naming that
category and its number; a small composition yields none; the totals and the
existing category rows are byte-identical to before. **Mutation:** force the
suggestion list empty → the new test goes red.

---

## 3. Task 3 — category strings

**Commit:** `docs(audit): what the instruction and context work leaves open`

Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 characters. At minimum: the nested-file cap you chose, and any
documented suggestion class you did not implement because the control does not
exist here.

### 3a. What this plan leaves

Four strings, each measured against the code as committed. One is the bound
Task 1 had to choose and could not avoid choosing. One corrects a register entry
that was wrong in the other direction — it claimed a gap did not exist. Two are
surfaces the tasks scoped out because the control a suggestion would have to
name does not exist here, or because the work belongs to the eager pass.

- documented, implemented under a stated bound — a nested instruction file is delivered once per capability generation, at most eight distinct files, each body truncated at 10 KB. A session that sweeps more packages than that gets the first eight in read order; a new generation or a compaction starts a fresh budget: `MAX_NESTED_INSTRUCTION_FILES`
- register correction — the entry reading "every nested instruction file is loaded eagerly at inventory time, so no traversal is lazy" was never true. Eager discovery walked ancestors only, and a file below the cwd loaded on no path. The union member now has a producer, the on-read containment walk. The register sits under docs/superpowers/specs, which this plan forbids editing: `nested_traversal`
- documented, not implemented — the documented suggestion set could name the custom-subagents row, and no suggestion does. The only per-capability enable control here is the Plugins page toggle, which reaches plugin-supplied subagents; a native markdown agent can be removed only by deleting its file, so the sentence would have no control to name: `custom_subagents`
- documented, not implemented — an at-path import inside a NESTED instruction file is not resolved. Import materialization belongs to the eager inventory pass, which never reaches below the cwd, and the lazy channel delivers the bytes on disk; so an import line in a package's own instruction file reaches the model as literal text rather than as the file it names: `include`

## 4. Gate

Focused suites per changed file; the capabilities, agent and pi-agent-server
aggregates once on the final diff; `bun run typecheck:all` **exit 0 with zero
`error TS`, stated explicitly**; `bun run lint`; i18n parity + sorted;
`git diff --check`.

Known-failing rows: `docs/superpowers/specs/2026-07-29-known-failing-tests.md`.

## 5. Constraints

- You own `packages/shared/src/capabilities/**`,
  `packages/shared/src/agent/base-agent.ts`,
  `packages/pi-agent-server/src/context-categories.ts`, and the renderer's
  context overlay plus its playground entry.
- **TWO SIBLING EXECUTORS run concurrently.** One owns `pi-agent.ts`,
  `mode-manager.ts`, `pre-tool-use.ts`, `permission-dsl.ts`, `pi-harness/**`,
  `SessionManager.ts`, `runtime-agent-definition.ts`. Another owns
  `packages/shared/src/mcp/**`, `auth/oauth.ts`, `agent/backend/types.ts`,
  `plugins/format-adapters/claude.ts`, `network-address-guard.ts` and the
  elicitation card. A third owns `pi-agent-server/src/index.ts`,
  `orchestrator/**`, `apps/electron/src/main/index.ts` and
  `config/sandbox-settings.ts`. **Stay out of all three.** Report residuals
  instead of editing.
- One commit per task, subjects exactly as given. **No `Co-Authored-By`.** No
  push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash of edited files.
  Restore mutation probes by re-edit or an `.orig` copy, **never git**.
- Do not touch `docs/superpowers/specs/` or the CDP checklist, nor
  `~/.nessy-agent/skills/r17-*` or `~/.nessy-agent/mcp/elicit-server.mjs`.
  No version bumps or release notes. Never write `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 6. Report

Commit shas; both gaps reproduced; the nested-file cap and its number; the
suggestion rules and, for each, the control in THIS product it points at;
residuals word for word; corrections to this plan; mutation probes with which
side went red; the explicit typecheck statement.

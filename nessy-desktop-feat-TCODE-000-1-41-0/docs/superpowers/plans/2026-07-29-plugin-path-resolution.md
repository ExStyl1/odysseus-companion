# B1a — Manifest component paths: resolve them, and contain them

Parity row **B1** in `docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md`,
first slice. Scoped from the B1 audit of 2026-07-29, whose findings are recorded
in `2026-07-29-b1-audit.md`.

**This one is not a missing feature. It is wrong behaviour, proven by execution.**

---

## 0. Method rules

1. **Re-fetch the contract yourself**: `curl -s https://code.claude.com/docs/en/plugins-reference.md`.
   Never a summarising fetch tool — it has invented field names twice in this
   series and both inventions shipped.
2. **The quotation is the identifier, not the line number.** Locate each quoted
   sentence by its text and report the line you found it at.
3. **Read around the quotation.** A sentence between two quoted ones can reverse
   their meaning.
4. **Declared ≠ enforced.** Name the consumer and prove it runs.
5. **Two git commands.** Pathspec on the `commit`, not only on `git add`; another
   agent is committing to this repo concurrently.

---

## 1. What is actually wrong

The audit ran our adapter over synthetic bundles rather than reading it. Three
measured results, each a quotation from the run:

- With `commands: ["./specialized/deploy.md"]` declared, **we emit
  `commands/default-cmd.md`** — the folder Claude does *not* scan — **and drop
  `./specialized/deploy.md`**, the file Claude *does* load. Same for `agents`.
  So for a real Claude plugin we do not under-load; **we load the wrong set.**
- With the docs' own verbatim example `"skills": ["./"]` (`:647`) and a root
  `SKILL.md`, Claude loads one skill and **we emit zero capabilities** — strictly
  fewer than if the author had omitted the field. A conforming plugin loads less
  than a non-conforming one.
- `"lspServers": "./.lsp.json"`, again the docs' own spelling, yields
  `plugin.format.claude_capability_incomplete`, zero LSP capabilities, **and**
  suppresses the `.lsp.json` default. Worse than the rest: absent *and*
  undeclared.

The cause is uniform. `addClaudeCustomPathDeferrals` (`claude.ts:1116`) detects
that a key is present and mints a `custom-<x>-path` record; the default directory
is then scanned unconditionally regardless. Every `readdir`/`readFile`/`existsSync`
in the adapter is rooted at a `CLAUDE_DEFAULT_*` constant. **Not one
manifest-supplied string ever reaches `join()`.** The only consumer of the
deferral record is a display string — `rpc/plugins.ts:151` →
`plugin-install-state.ts:45` → a `partial` badge.

**The machinery already exists and already runs — for the other format.** The
Codex adapter resolves manifest-declared string/array/record paths
(`normalizeCodexSkills`, `codex.ts:642`) and has a working replace-versus-extend
decision (`declaresDefaultPath`, `codex.ts:512`; `normalizeCodexDefaultSkills`,
`:632`-`:640`). The Claude adapter calls none of it and hardcodes
`const skillsDir = CLAUDE_DEFAULT_SKILLS_DIR` (`claude.ts:328`), while
`normalizeClaudePromptCommands`/`Agents`/`Workflows` take no manifest argument at
all.

So this is the series' recurring defect in its cross-adapter form: implemented on
one path, inert on the one that has to satisfy the contract. **Reuse the Codex
machinery. Do not write a third implementation.**

---

## 2. The contract

Quotations from `plugins-reference.md` § *Path behavior rules*, found at these
lines on 2026-07-29:

> **Replaces the default**: `commands`, `agents`, `workflows`, `outputStyles`,
> `experimental.themes`, `experimental.monitors`. For example, when the manifest
> specifies `commands`, the default `commands/` directory is not scanned. To keep
> the default and add more, list it explicitly:
> `"commands": ["./commands/", "./extras/"]`

(`:636`)

> **Adds to the default**: `skills`. The default `skills/` directory is always
> scanned, and directories listed in `skills` are loaded alongside it. Exception:
> for a marketplace entry whose `source` resolves to the marketplace root,
> declaring specific subdirectories replaces the default `skills/` scan

(`:637`)

> **Own merge rules**: hooks, MCP servers, and LSP servers. See each section for
> how multiple sources combine

(`:638`)

> When a plugin has both a default folder and the matching manifest key, Claude
> Code v2.1.140 and later warns about the ignored folder in `claude plugin list`
> and the `/plugin` detail view. The plugin still loads using the manifest paths.
> Claude Code doesn't warn when the manifest key points into the default folder,
> for example `"commands": ["./commands/deploy.md"]`, because that path names the
> folder explicitly.

(`:640`)

> All paths must be relative to the plugin root and start with `./`

(the "For all path fields" list, `:643`)

> When a skill path points to a directory that contains a `SKILL.md` directly,
> for example `"skills": ["./"]` pointing to the plugin root, the frontmatter
> `name` field in `SKILL.md` determines the skill's invocation name. This gives a
> stable name regardless of the install directory. If `name` is not set in the
> frontmatter, the directory basename is used as a fallback.

(`:647`)

> A plugin that has a `SKILL.md` at its root, no `skills/` subdirectory, and no
> `skills` manifest field is automatically loaded as a single-skill plugin in
> Claude Code v2.1.142 and later.

(`:649`)

Note the relationship between the last two, because the audit found we had it
backwards. `:649` is the case where there is **no** manifest field. `:647` is the
case where there **is** one and it points at the root. We implement `:649`
(`normalizeClaudeSingleRootSkill`) and use `input.skills !== undefined` to
*suppress* it — so a declared `skills` **subtracts**, when `:637` says it can only
ever add.

---

## 3. Tasks

### Task 1 — one resolver, with containment at the manifest seam

**Commit:** `feat(plugins): resolve manifest component paths, contained at the seam`

Build **one** shared resolver, used by every field, that:

- accepts the documented shapes: `string`, `string[]`, and for the own-rules
  fields an inline object;
- **validates containment BEFORE any `join()`.** Today
  `isClaudeCustomPathOverride` (`claude.ts:1151`) accepts any non-empty string,
  and the audit confirmed `"commands": ["../../../../etc"]` is classified as a
  valid override with `ok=true`. Both existing gates (`validatePluginRelativePath`,
  `schema.ts:210`; `isContainedRelative`, `projection-candidates.ts:97`) sit
  **downstream** and only ever see paths the adapter built from its own `readdir`
  results. **This task is the one that turns an inert string into a real read
  primitive, so the check must land in the same commit as the resolution — not
  the one after.** A plugin manifest is untrusted input.
- enforces the `./` prefix rule from `:643`, and decides — explicitly, recorded —
  what happens to a path that omits it. Reject, or normalise? Say which and why.
- expands a path to either a directory scan or a single file, since `:530`'s own
  examples include both (`"./custom/cmd.md"` and `"./commands/"`).

Prefer widening the Codex helpers to serve both adapters over duplicating them.
If they cannot be shared, say why in the commit body — a third implementation of
the same rule is how the next divergence gets built.

**Gate:** a containment test that is an actual escape attempt (`../../../etc`,
an absolute path, a symlink out of the bundle), asserting refusal **and** that
nothing was read.

---

### Task 2 — REPLACES, for the fields that replace

**Commit:** `feat(plugins): manifest paths replace the default folder they name`

Wire `commands`, `agents` and `workflows` to `:636`: when the key is present, the
default folder is **not** scanned, and the declared paths are.

`outputStyles`, `experimental.themes` and `experimental.monitors` are in the same
sentence but we have no such component surfaces at all, so their REPLACES
semantics cost nothing until those surfaces exist. Leave them deferred and say so
with a category string; do not build a resolver for a component that cannot be
loaded.

**Gate:** the audit's exact failing case as a test — `commands: ["./specialized/deploy.md"]`
plus a populated `commands/` folder must now yield `deploy.md` and **not**
`commands/default-cmd.md`. Assert both halves; asserting only that `deploy.md`
appears would pass while the wrong file is still loaded alongside it.

---

### Task 3 — EXTENDS, for `skills`, and the `["./"]` case

**Commit:** `feat(plugins): a declared skills path adds to the default scan`

`:637`: the default `skills/` scan **always** happens and declared directories
load alongside it. Remove the inversion where `input.skills !== undefined`
suppresses the root-skill layout.

Then `:647`: a skill path pointing at a directory containing `SKILL.md` directly
takes its invocation name from the frontmatter `name`, falling back to the
directory basename. `"skills": ["./"]` with a root `SKILL.md` must load one
skill — the docs' own example, which currently yields zero.

Both `:647` and `:649` must work, and they are different cases: `:649` is the
no-manifest-field layout we already have, `:647` is the declared-and-points-at-root
one we do not. Keep them distinguishable in the code, because collapsing them is
what produced the current inversion.

**The marketplace-root exception in the same sentence is NOT in this task.** The
audit established it is unrepresentable today — `rg '\bstrict\b' packages/shared/src/marketplace/`
returns nothing, and `marketplace/normalizers.ts:505` reads `skills`/`mcpServers`/`hooks`
only to harvest display strings for a catalog card, never as paths. Record it as
`documented, not implemented` with that reason and the prerequisite named. Do not
half-build it.

**Gate:** three tests — default-only, declared-plus-default (both present), and
`["./"]` with a root `SKILL.md`.

---

### Task 4 — `lspServers` in its documented string form

**Commit:** `fix(plugins): accept the documented lspServers path form`

`"lspServers": "./.lsp.json"` currently produces
`plugin.format.claude_capability_incomplete`, zero LSP capabilities, **and**
suppresses the `.lsp.json` default. The audit called this the worst of the ten
because it is absent *and* undeclared.

This neighbourhood already cost this repo a production bug — `AGENTS.md` records
that our adapter keyed LSP off `input.lsp` while Claude's field is `lspServers`
with a `.lsp.json` default, so official LSP plugins were neither imported nor
deferred. Read `docs/superpowers/specs/2026-07-25-claude-adapter-doc-gaps.md`
before touching it, and check whether that fix is complete or whether this is its
remainder.

**Gate:** the docs' own spelling loads an LSP capability; the default still loads
when the field is absent.

---

### Task 5 — the ignored-folder warning, without the false positive

**Commit:** `feat(plugins): warn about a default folder the manifest overrides`

`:640`'s warning, with its own stated exception: **no** warning when the manifest
key points into the default folder, because that path names the folder
explicitly. The audit found our current deferral fires there, so today it is a
false positive.

Route it wherever a user can actually see it. R30b just built a config-diagnosis
surface and the plugin detail view already renders a `partial` badge from the
deferral records; pick one, and say why.

**Gate:** three cases — override outside the default folder warns; override
naming a file inside it does not; no manifest key does not.

---

## 4. Gate

- Focused suites for every touched file, plus `packages/shared/src/plugins`.
- `bun run typecheck:all`, `bun run lint`, `git diff --check`.
- The format-adapter contract suite for **both** adapters — this plan touches
  shared helpers, and the Codex adapter is a live consumer of them. A Codex
  regression here would be invisible to a Claude-only run.

**Run every test from the repository ROOT.** A run from inside a package
directory bypasses the config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

Reproduce any pre-existing failure on a clean worktree at your base commit before
calling it pre-existing.

---

## 5. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
- No push, MR or tags. No `reset`, `rebase`, or `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- Pathspec on the commit itself.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- Another agent is concurrently editing `packages/server-core/src/sessions/`,
  `packages/pi-agent-server/src/orchestrator/` and `packages/shared/src/agents/`.
  Stay out of those; this plan's work is in `packages/shared/src/plugins/`.
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 6. Report

Commit shas and subjects; the line you found each quotation at; **every
correction to this plan** — the audit that produced it already overturned my
prior reading once, and the executors who report no corrections are the ones
whose units I later reopen; the before/after for each measured failing case in
§1; the category strings for what you deliberately did not build; and anything
out of scope but wrong.

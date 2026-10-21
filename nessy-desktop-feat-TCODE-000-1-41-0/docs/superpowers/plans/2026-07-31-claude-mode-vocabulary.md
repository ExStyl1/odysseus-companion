# Claude's mode model as the single source of truth — six of theirs plus Explore

**Owner decision 2026-07-31:** adopt Claude's permission-mode vocabulary, gates
and surfacing as ours, keeping `safe` ("Explore") as the ONE documented
extension. **Target: INTO 1.16.0, before the close-out** (owner: "давай V1 и V2
сделаем до close-out потому что это что ожидают юзеры"). Dispatch only after
the 2026-07-31-mode-table-and-labels executor has landed — it owns the same
files.

## Tracker

Update the row IN THE SAME COMMIT that lands the task. Status: ⬜ open ·
🔄 in flight · ✅ done · ⏸ parked.

| # | task | status | commit | note |
|---|---|---|---|---|
| T1 | Every read path bilingual (aliases first) | ✅ | 41dc4a98 | one null-prototype alias table in mode-types; both parsers delegate; five doors proven (headers, 4 nested fields, policy, frontmatter, automations) + 2 mutation probes red |
| T2 | The values flip (writers, pin ceremony, bundles) | ✅ | 5e8c5b76 | safe→explore, ask→default, allow-all→bypassPermissions; same ORDER positions; moved pins: session.spawn_session + automation.create/update fixture digests (NO static hash moved — correction to § 0-2); 3 more read doors found+aliased (workspace config, project defaults, config validators, renderer automations); bundles rebuilt |
| T3 | Claude's gates (bypass, auto ×2, dontAsk) | ✅ | 326477c9 | all four red-first; bypass leaves the default cycle + first-activation dialog; auto pauses on 3-in-a-row/20-total FRESH classifier blocks (cache replays feed the existing circuit, G3 override contract intact); auto write approval binds to acceptEdits' roots, no-roots fails closed; dontAsk denies WebFetch/WebSearch/browser unless a rule allows |
| T4 | Labels and surfaces | ✅ | e1c39432 | Manual / Bypass permissions in both locales; PERMISSION_MODE_AGENT_LABELS moved byte-equal in the same commit (pin green); dontAsk filtered from pickers; playground variants derive from PERMISSION_MODE_ORDER (all seven states); parity mutation probe red-then-restored |
| T5 | Category strings | ✅ | (this commit) | four rows, harvester-verified against the CAT regex (4 found); register regeneration left to the planner's closing pass (specs/ is planner-owned) |

**End state:** config values `default`, `acceptEdits`, `plan`, `auto`,
`dontAsk`, `bypassPermissions`, plus `explore` (today's `safe`). Every old
spelling (`ask`, `allow-all`, `safe`, `execute`, `ask-to-edit`, and Claude's
`manual`) is accepted FOREVER on every read path. Labels per surface use
Claude's words; Explore keeps its own. Nestor Cloud is untouched: its modes
come from the agent card catalog and our exhaustive mapping switch recompiles.

**Inputs:** the adversarially verified permission-modes audit (workflow
2026-07-31). Its site enumeration was verified against that day's HEAD; the
mode-table plan has edited some of those files since — **re-locate every site
by NAME, never by the line numbers quoted here.**

## 0. The four hazards this plan exists to not trip

1. **`PERMISSION_MODE_ORDER` is the clamp's index.** The array is a plain
   `PermissionMode[]`; its position IS the strictness rank
   `clampPermissionModeToParent` compares, and a wrong position is a silent
   widening with zero type errors. The renames keep seven positions with the
   same semantics — the order changes SPELLING only, never position.
2. **The `spawn_session` tool schema carries the mode enum, and tool SHAPE is
   pinned.** `PI_STATIC_MODEL_CONTRACT_HASHES` pins tool shapes; changing the
   enum values in the input schema is a shape change. The plan must carry the
   pin-update ceremony (the descriptor test asserts which hashes move and which
   must not), or live sessions die with `Pi execution manifest definition
   mismatch`. The enum also ships inside two gitignored subprocess bundles —
   `electron:build:servers` must be rerun before any live claim.
3. **Persisted spellings come back through FIVE doors**, and today's loader
   DELETES an unknown mode and falls back to `ask`: the two session JSONL
   header fields (normalized), four nested mode fields including
   `piChildRestrictions.permissionMode` (raw, never normalized — and the child
   clamp re-bases to 'ask' on an unknown parent spelling), managed policy
   (`list()` THROWS on the first unknown entry), agent frontmatter in user and
   plugin files, and automations. Task 1 makes every one of these
   alias-resolve BEFORE any writer changes spelling — that ordering is the
   whole safety argument.
4. **`'ask'`, `'plan'`, `'auto'` are homonyms of unrelated enums** (the
   `'allow'|'ask'|'deny'` rule action above all — ~41 occurrences). No scripted
   rename. Every edit is a reviewed hunk at a named site.

## 1. Method rules

1. `curl -s` the pages — `permission-modes.md`, `settings.md`,
   `tools-reference.md`, `auto-mode-config.md`. Quote WHOLE lines.
2. **Declared ≠ enforced**: every gate lands with a test that fails on today's
   code first. **NUL bytes**: `grep -a` always; never truncate an uncounted
   grep.
3. **Two git commands** — pathspec on the `commit`. One commit per task.
4. **Run every test from the repository ROOT.** `apps/cli` has its own
   typecheck — `typecheck:all` does not cover it, and cli holds four
   production `permissionMode: 'allow-all'` literals.
5. i18n labels are interpolated (`t(\`mode.${id}\`)`) — a wrong id renders a
   raw key with no error anywhere. Every label change is proven in the
   playground, which is a design surface.

## 2. Task 1 — every read path becomes bilingual (aliases FIRST)

**Commit:** `feat(modes): every mode read path accepts Claude and legacy spellings`

One shared alias table beside the union in `mode-types.ts`:
`default|manual|ask → the manual mode`, `bypassPermissions|allow-all|execute →
the bypass mode`, `explore|safe → explore`, plus the existing kebab aliases.
Consumed by BOTH parsers — `parsePermissionMode` and
`mapClaudeModeToPermissionMode` have disjoint sets today; after this task they
cannot disagree because neither owns a private list. Then thread it through the
five doors from § 0-3: session JSONL header normalization (alias-resolve before
the delete-unknown fallback), the four nested fields (normalize on load),
managed policy list parsing (accept both spellings for
`disabledPermissionModes` instead of throwing), agent frontmatter, automations
schemas. **No writer changes in this task** — old values keep being written;
everything merely learns to read both.

**Gate:** a session file, a managed policy, a child restriction and an agent
frontmatter carrying each old AND new spelling all load to the right mode; an
unknown string still falls back exactly as today. **Mutation:** remove one door
from the alias path → its fixture goes red.

## 3. Task 2 — the values flip (writers)

**Commit:** `feat(modes): the config vocabulary is Claude's — default, bypassPermissions, explore`

Rename in the union, `PERMISSION_MODE_ORDER` (same positions),
`PERMISSION_MODE_TO_CANONICAL`, and every literal list the audit enumerated —
locate each by name: the wire validators (core + protocol
`pi-harness-runtime`), `config/validators`, `automations/schemas`,
session-tools-core (`tool-defs`, `automation-management`,
`spawn-session-tool`), the Codex `config-writer` mode switch,
`config-defaults.json` (`permissionMode` AND `cyclablePermissionModes`),
`config/storage` defaults, `managed-policy` `DISABLEABLE_MODES`, apps/cli's
four literals, the i18n `mode.*` key families in every locale, the frozen
fixtures, and the Nestor mapping switch (mechanical respelling — the exhaustive
switch is the compile check). **The `spawn_session` schema change carries the
pin ceremony** (§ 0-2): update `PI_STATIC_MODEL_CONTRACT_HASHES` deliberately,
with the descriptor test asserting exactly which tool hashes moved.
`electron:build:servers` at the end; state that the bundles were rebuilt.

**Gate:** typecheck:all + apps/cli both exit 0 with zero `error TS`; the full
mode fixture matrix from Task 1 still loads right (old spellings now exercise
the alias path in anger); the contract-hash test names the moved hashes;
`grep -a` finds no production literal `'ask'`-as-mode or `'allow-all'` outside
the alias table (state the counts). **Mutation:** drop one site from the rename
→ typecheck or its suite goes red; drop the alias table → the persisted-session
fixture comes back WRONG, and that test is the release blocker.

## 4. Task 3 — Claude's gates

**Commit:** `feat(modes): bypass is gated, auto self-downgrades and binds writes, dontAsk narrows`

1. **bypassPermissions leaves the default cycle.** Reachable only after an
   explicit enable (settings toggle + responsibility dialog on first
   activation), mirroring `permission-modes.md`'s launch-only contract as
   closely as a desktop app can; a managed policy can forbid it outright
   (`DISABLEABLE_MODES` already carries it).
2. **auto self-downgrades**: 3 consecutive classifier blocks or 20 total →
   the session drops to the manual mode and says so
   (`permission-modes.md`: "If the classifier blocks an action 3 times in a
   row or 20 times total, auto mode pauses and Claude Code resumes
   prompting.").
3. **auto's write auto-approval binds to the workspace**: working directory +
   `additionalDirectories`, the same roots acceptEdits already uses — today it
   passes `autoAllowFileWrites: true` with no roots and `if (!roots) return
   true` approves a write anywhere on disk.
4. **dontAsk narrows to Claude's three sources** (allow rules, read-only set,
   hook allow): WebFetch/WebSearch/browser tools leave its auto-run set —
   `tools-reference.md` marks them permission-required.

**Gate:** each of the four proven by a test red on today's code; the
self-downgrade announces itself in the transcript; a write outside the roots
in auto prompts; dontAsk denies a WebFetch that no rule allows. **Mutation:**
per item, revert → its test goes red.

## 5. Task 4 — labels and surfaces

**Commit:** `feat(ui): mode labels speak Claude's vocabulary; Explore stays Explore`

Per-surface labels from Claude's tables: Manual / Accept edits / Plan / Auto /
Bypass permissions, `dontAsk` absent from every picker (settable via
config/flag/automation only, exactly as today's cycle already treats it),
Explore keeps its name and icon. The mode-table plan already made i18n the
single text source — this task only changes the WORDS, both locales, playground
states updated. Docs-site's permissions page is rewritten at that release's
close-out to mirror Claude's page plus one Explore section.

**Gate:** every picker and badge renders the new vocabulary in both locales;
parity + sorted green; the playground shows all seven. **Mutation:** revert one
locale's key → parity goes red.

## 6. Task 5 — category strings

**Commit:** `docs(audit): what the vocabulary migration keeps stricter than Claude`

Unwrapped, unbolded, backtick-terminated, under 400 characters. At minimum:
acceptEdits keeps our narrower filesystem set (no `rm`/`rmdir`/`sed`, no
env-prefix/wrapper acceptance) by bank decision; protected-path writes keep the
deny floor where Claude's auto routes them to the classifier; our plan mode
stays persistent where Claude's exits on approval; Explore itself.

## 7. Gate

Focused suites per task; sessions, agent, config, protocol and renderer
aggregates once on the final diff; typecheck:all + apps/cli separately, exit 0
stated; lint; i18n parity + sorted; `git diff --check`;
`electron:build:servers` rerun and stated. **Permission decisions, wire schema
and the contract pin are named risk triggers** — the expanded set once on the
final diff, plus one live CDP smoke: a session saved under the OLD spellings
before the migration loads and runs after it, mode intact.

## 8. Constraints

- **Do not start while 2026-07-31-mode-table-and-labels is executing.** Same
  files. Its landed shape (derived strictness order, shared write-mode
  predicate, i18n-only labels) is the base you rename on.
- One commit per task, subjects exactly as given. No `Co-Authored-By`. No
  push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash. Probes restored by
  re-edit or `.orig`, never git. `docs/superpowers/specs/` and the CDP
  checklist are planner-owned. No version bumps — this plan's release owns its
  own close-out. Never write `~/.nessy/dp_auth_creds.json`. English in code
  and commits.

## Category strings — what stays stricter than Claude (T5)

The vocabulary is Claude's; four behaviors deliberately are not. Each is a
recorded decision, harvested by the deviation register.

**acceptEdits keeps the narrower filesystem set.** `permission-modes.md` lists
`mkdir/touch/mv/cp/rm/rmdir` for acceptEdits and Claude accepts env-prefixed
and wrapper spellings of them. Our `ACCEPT_EDITS_FILESYSTEM_COMMANDS` set
carries no deletion commands and `isAutoApprovedFilesystemCommand` refuses any
composition characters, so a deletion or a wrapped command still prompts.
Category:
`documented, not implemented — Claude's acceptEdits auto-approves a filesystem set including rm and rmdir and tolerates env-prefixed and wrapper spellings; ours keeps the non-destructive subset with no env-prefix or wrapper acceptance, by bank decision, so a deletion or a wrapped command still prompts`

**Protected-path writes keep the deny floor.** Claude's auto routes
protected-path writes to the classifier; our `protectedPathOutcome` keeps
`deny` in dontAsk and a non-negotiable human prompt in every prompting mode,
with `bypassPermissions` the only documented escape. Category:
`documented, not implemented — Claude's auto mode routes protected-path writes to the classifier; our protected-path floor keeps the deny for dontAsk and a non-negotiable human prompt in every prompting mode, with bypassPermissions the only escape, so a protected write is never delegated to a model judge`

**Plan mode stays persistent.** Claude's plan mode exits when a plan is
approved; ours stays in plan until the session deliberately transitions
(acceptPlan's force-set, clamped for children, or an explicit mode change).
Category:
`documented, not implemented — Claude's plan mode exits on plan approval; ours stays persistent — accepting a plan transitions the session through one deliberate clamped force-set and re-entry is explicit, so a session never silently leaves plan merely because a plan was approved`

**Explore itself.** The seventh mode has no Claude counterpart and is the one
documented extension. Category:
`documented, not implemented — Explore is our seventh permission mode with no Claude counterpart: read-only exploration that grants scoped writes to the session plans and data folders only, incomparable with plan on the write axis, kept as the ONE documented extension to Claude's six-mode vocabulary`

## 9. Report

Commit shas; the alias matrix proven through all five doors; the moved contract
hashes, named; the four gates each red-then-green; the grep counts for dead
spellings; the live old-session smoke; what stayed stricter, word for word as
category strings; corrections to this plan; the explicit typecheck statement
including apps/cli; confirmation the subprocess bundles were rebuilt.

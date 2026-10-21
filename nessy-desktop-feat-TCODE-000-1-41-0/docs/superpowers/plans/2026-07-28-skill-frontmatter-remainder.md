# R30a — skill frontmatter and substitution remainder

**Status:** ready for execution
**Parity row:** R30 (Ord 9), first of three slices — see "What this slice is not"
**Branch:** `fix/renderer`
**Base:** `60dad0c4`

## Contract source

`code.claude.com/docs/en/skills.md` §"Frontmatter reference" (`:252`–`:268`) and
§"Available string substitutions" (`:294`–`:301`). Every claim below is quoted
from those lines; cite the line in each commit body.

## Verified state on HEAD — do not re-derive

`SkillMetadata` (`packages/shared/src/skills/types.ts`) carries `name`,
`description`, `whenToUse`, `allowedTools`, `disallowedTools`,
`disableModelInvocation`, `userInvocable`, `model`, plus our own `globs`,
`alwaysAllow`, `icon`. Missing from the documented table: **`arguments`,
`argument-hint`, `effort`, `context`, `agent`, `background`, `hooks`, `paths`,
`shell`**.

Substitution, `runtime-skill-content.ts:308`, is exactly one line:

```ts
: content.split('$ARGUMENTS').join(argumentsText);
```

So `$ARGUMENTS[N]`, `$N`, `$name`, `${CLAUDE_SESSION_ID}` and `${CLAUDE_EFFORT}`
all pass through as literal text, and the documented fallback — "If `$ARGUMENTS`
is not present in the content, arguments are appended as `ARGUMENTS: <value>`"
(`:294`) — does not happen, so a skill that takes arguments without naming the
placeholder silently loses them.

`${NESSY_SKILL_DIR}`/`${CLAUDE_SKILL_DIR}` and `${CLAUDE_PROJECT_DIR}` already
work (R17, `864f694d`). Follow that file's shape for the two new variables.

## What this slice is NOT

Do not start these; they are separate units and touching them here will make the
diff unreviewable:

- `context: fork` + `agent` + `background` — forked skill execution. Overlaps
  R29 (conversation forks) and needs that unit's threat model first.
- `hooks:` in skill frontmatter — belongs with R22's hook-types work.
- `shell: powershell` — needs the PowerShell tool, which we do not ship.
- The `/doctor`-class diagnosis surface and the subagent frontmatter fields —
  the other two slices of R30.

If you believe one of these is unavoidable to finish a task here, stop and report
rather than expanding.

## Tasks

### Task 1 — the argument contract

`arguments` (named positional; "Accepts a space-separated string or a YAML list.
Names map to argument positions in order") and `argument-hint` (autocomplete
hint, e.g. `[issue-number]`) become real `SkillMetadata` fields, parsed with the
same documented-and-camelCase leniency the existing fields get.

Then the full substitution set at the one seam that expands a skill body:

| Form | Meaning (`skills.md:294`–`:297`) |
| --- | --- |
| `$ARGUMENTS` | all arguments |
| `$ARGUMENTS[N]` | 0-based index |
| `$N` | shorthand for `$ARGUMENTS[N]` |
| `$name` | the name declared at that position in `arguments` |

Plus the fallback: **no `$ARGUMENTS` anywhere in the content → append
`ARGUMENTS: <value>`.** Read that rule literally — it is about the bare
`$ARGUMENTS` token, and a body using only `$0` still gets the append unless you
can show the docs say otherwise; say which reading you took.

Order matters and is a real trap: expand the longest form first, or `$ARGUMENTS`
eats the prefix of `$ARGUMENTS[0]`, and `$1` eats the prefix of `$issue` if a
name starts with a digit. Pin the ordering with a test that would fail under the
naive order.

`argument-hint` is display-only for now — parse and store it, and say in the
commit body where the autocomplete surface would consume it.

**Commit:** `feat(skills): named and indexed argument substitution`

### Task 2 — `${CLAUDE_SESSION_ID}` and `${CLAUDE_EFFORT}`

`:298` — the session ID, "useful for logging, creating session-specific files, or
correlating skill output with sessions". `:299` — the effort level, one of
`low|medium|high|xhigh|max`.

Emit the Nessy name with the Claude name as a compat alias, both in `${VAR}` and
bare `$VAR` form, exactly as R17 did for the skill directory — reuse that
expander rather than writing a third one. Host-derived only; never
`process.env`. When the host cannot supply a value the variable stays literal,
same as R17's rule.

**Commit:** `feat(skills): expand the session-id and effort variables`

### Task 3 — `effort`

`:262` — "Effort level when this skill is active. Overrides the session effort
level. Default: inherits from session. Options: `low`, `medium`, `high`, `xhigh`,
`max`; available levels depend on the model."

Treat it like the existing `model` restriction, which is the closest precedent in
the same record: validated at materialization, carried on the invocation record,
applied for the invoking turn and **not** persisted to settings. An unavailable
level must degrade the way an unavailable model does today — find that behaviour
and match it rather than inventing a second policy.

**Commit:** `feat(skills): honor the effort frontmatter field`

### Task 4 — `paths`

`:267` — "Glob patterns that limit when this skill is activated. Accepts a
comma-separated string or a YAML list. When set, Claude loads the skill
automatically only when working with files matching the patterns. Uses the same
format as path-specific rules."

"Same format as path-specific rules" is a direct instruction to reuse R28's
matcher (`packages/shared/src/agent/memory/rule-matching.ts`) — do not write a
second glob matcher. Note the scope precisely: `paths` limits **automatic**
activation only. A user or model explicitly invoking the skill is unaffected.
Getting that backwards would hide skills from their own invocation.

Also cover the interaction with our existing `globs` field on `SkillMetadata` —
if it already means this, say so and unify; if it means something else, say what,
and keep them distinct.

**Commit:** `feat(skills): gate automatic activation on the paths field`

### Task 5 — the `allowed-tools` propagation gaps R17b left behind

R17b made `allowed-tools` enforced. Four places still say or assume it is not:

1. `readPluginSkillFrontmatter` (`packages/shared/src/plugins/format-adapters/shared.ts:175`)
   **deliberately drops `allowed-tools`**, rationale "nothing enforces it yet".
   Now false. An imported Claude plugin skill is enforced at invocation but never
   populates `skillAllowedTools`, so the capability view under-reports it.
2. The same stale claim in comments at `skills/types.ts:32`
   ("enforcement is deliberately out of scope for P7"),
   `capabilities/types.ts:117`, `capabilities/views.ts:85`.
3. **Two tokenizers for one field**: `stringList`
   (`capabilities/runtime-skill-content.ts:272`, commas only) on the enforcement
   path vs `normalizeToolList` (`skills/storage.ts:117`,
   `/[^\s,()]+(?:\([^)]*\))?/g`) on the display path. They diverge on a comma
   inside a pattern — and after R17b a pattern can contain a comma. The docs say
   the field "Accepts a space- or comma-separated string, or a YAML list"
   (`:259`), so the enforcement path is the wrong one. Converge on one tokenizer
   that satisfies the documented spelling AND does not split inside `(...)`.
4. `skill_validate`'s `SkillMetadataSchema`
   (`packages/session-tools-core/src/validation.ts:197`) is `.passthrough()`, so
   a misspelled key or an unclosed `Bash(` validates clean. Make the fields this
   plan adds — and `allowed-tools` — actually checked, with an unknown-key
   warning rather than a hard failure (a skill written for a newer client must
   still load).

**Commit:** `fix(skills): converge the allowed-tools contract across paths`

### Task 6 — close-out

Append per-task shas, real gate numbers, the substitution-order answer from
Task 1, the `globs`-vs-`paths` answer from Task 4, and anything you found that
this plan got wrong about HEAD.

**Commit:** `docs(plans): close R30a with gate evidence`

## Close-out

**Status:** executed. Base was `eaaf67ab`, not the `60dad0c4` written above — the
concurrent R24 unit had already landed.

### Commits

| Task | Sha | Subject |
| --- | --- | --- |
| 1 | `2eae6d29` | `feat(skills): named and indexed argument substitution` |
| 2 | `0b8fc0fd` | `feat(skills): expand the session-id and effort variables` |
| 3 | `a63a382f` | `feat(skills): honor the effort frontmatter field` |
| 4 | `e6d0e88a` | `feat(skills): gate automatic activation on the paths field` |
| 5 | `46140ce3` | `fix(skills): converge the allowed-tools contract across paths` |
| 6 | this commit | `docs(plans): close R30a with gate evidence` |

### Contract verification

Every line cite in this plan was checked against
`curl -sL https://code.claude.com/docs/en/skills.md`, not against WebFetch.
**All are correct** — `:252`–`:268` is exactly the frontmatter table's rows,
`:294`–`:301` exactly the substitution table's rows, and each quoted sentence is
verbatim. Three prose rules the plan did not mention are also load-bearing and
are implemented:

- `:321` — indexed arguments use shell-style quoting; `$ARGUMENTS` is "the full
  argument string as typed".
- `:323` — a missing INDEXED placeholder "stays in the content unchanged", while
  a missing NAMED one "expands to an empty string". Deliberately asymmetric.
- `:325` — a single backslash escapes `$` before a digit, `ARGUMENTS` or a
  declared name; a doubled backslash does not.
- `:248` — boolean fields also accept `yes/no/on/off/1/0` in any case. Our
  `optionalBoolean` (`skills/storage.ts`) still accepts only `true`/`false`.
  **Reported, not fixed** — it is not one of the six tasks.

### The three reported decisions

**1. The append fallback's trigger.** Taken on the `$ARGUMENTS` FAMILY: the
append fires unless the body used `$ARGUMENTS` or `$ARGUMENTS[N]`. A body using
only `$0` or `$name` still gets `ARGUMENTS: <value>`. Both doc sentences name
that token and not "a placeholder" (`:294` "If `$ARGUMENTS` is not present in the
content"; `:454` "the skill doesn't include `$ARGUMENTS`"), and `$ARGUMENTS[N]`
literally contains the string. The other reading — any placeholder suppresses it
— would silently drop the append for a `$0`-only skill, which is the exact
failure the fallback exists to prevent, so it is the more expensive guess to get
wrong. An ESCAPED `\$ARGUMENTS` is not a placeholder and does not suppress.

**2. `globs` vs `paths`: they mean the same thing, and are now unified.** `globs`
is this repo's own pre-contract field, declared as "Optional file patterns that
trigger this skill". It is parsed in `skills/storage.ts`,
`plugins/runtime-projection.ts` and two Zod schemas, named in the skill editor's
frontmatter hint, asserted by one test — **and read by nothing**. It has never
had behaviour. Both spellings now populate one `paths` field; `globs` stays
accepted so existing skills and the editor hint keep working, and
`SkillMetadata.globs` still carries the raw declaration.

**3. Substitution ordering: longest match at one position, single pass.** At each
`$` the four forms are tried `$ARGUMENTS[N]` → `$ARGUMENTS` → `$name` → `$N`,
and a substituted value is never re-scanned. `$name` is checked before `$N` so a
declared name starting with a digit beats its own leading digits. Pinned by
`runtime-skill-content.test.ts` → "resolves every form in one pass, longest
placeholder first", which expands
`idx=$ARGUMENTS[0] all=$ARGUMENTS short=$1 named=$branch digitname=$1st` with
`arguments: branch other 1st`. Under naive left-to-right the first becomes
`a b c[0]` and the last `bst`.

Ordering between the two expanders also changed: **host variables now run BEFORE
arguments.** A host variable's value is a path, session id or effort level and
can never contain `$ARGUMENTS`; argument text is user- or model-supplied and very
much can contain `${CLAUDE_SKILL_DIR}`.

### What this plan got wrong about HEAD

- **Base sha.** `eaaf67ab`, not `60dad0c4`.
- **"An unavailable level must degrade the way an unavailable model does
  today."** An unavailable model does NOT degrade today. `base-agent.ts`
  `applySkillInvocationGrant` throws `Invoked skill model unavailable` when a
  skill's `model` differs from the session's — stricter than `:261`, which says
  the value "is not used and the session keeps its current model". The plan's own
  test list forbids a throw for `effort`, so `effort` follows the DOCUMENTED
  degrade and `model` was left alone. The divergence is reported, not fixed.
- **`readPluginSkillFrontmatter` was worse than described.** It dropped `paths`
  too, which meant Task 4's gate would have been native-skills-only. Fixed in
  Task 5 along with `allowed-tools`.

### Scope decisions the plan did not make

- **`paths` needs a trigger, and only Pi had one.** R28 wired
  `getPathScopedRulePreToolUseContext()` into `pi-agent.ts` only, so no `paths:`
  rule has ever fired under the Claude backend. Left alone, a `paths`-gated skill
  would be model-refused *forever* there. The one-line spread was added to
  `claude-agent.ts`. Codex and the Nestor cloud agent do not call
  `runPreToolUseChecks` at all, so `deliversPathScopedActivations` reports false
  and the field stays inert there — a dead skill is worse than an unenforced
  hint.
- **The listing states `paths`, it does not filter on it.** Filtering
  `buildSkillListingPart` per turn would re-stamp Pi's cached system prefix
  (#862). Enforcement is at invocation, which is not a cache input.
- **Multiple skills declaring `effort`: last wins.** The docs specify only the
  single-skill case; last-wins is the ordinary meaning of an override.
- **Declared argument names are never filtered or de-duplicated.** Order IS the
  position mapping, so dropping an entry would re-point every name after it.
- **The `RuntimeSkillHandle` golden fixture** in
  `packages/pi-agent-server/src/__tests__/harness-contract/fixtures/runtime-behavior.json`
  needed `paths` added. It belongs to Task 4 but was found after that commit
  landed, and amending is forbidden, so it rides this one.

### Gate

Run from the repo root.

| Check | Result |
| --- | --- |
| `bun run typecheck:all` | clean, all 8 packages |
| `bun run lint` | 0 errors (118 + 4 pre-existing warnings) |
| `git diff --check` | clean |
| `bun test` (final diff) | 8892 pass / 18 skip / **11 fail** / 8921 tests / 829 files |
| `bun test` (clean worktree at `eaaf67ab`) | 8859 pass / 18 skip / **16 fail** / 8893 tests / 828 files |
| `.isolated.ts` files (the root script's second half) | 153 pass / 4 fail, all 4 pre-existing |

Focused suites, final diff:

| Suite | Result |
| --- | --- |
| `packages/shared/src/capabilities` | 202 pass / 0 fail, 14 files |
| `packages/shared/src/skills` | 61 pass / 0 fail, 3 files |
| `packages/shared/src/{capabilities,skills,agent}` | 2009 pass / 3 skip / 0 fail, 180 files |
| `packages/shared/src/plugins/__tests__/format-adapters.test.ts` | 96 pass / 0 fail |
| `packages/session-tools-core` | 179 pass / 0 fail, 26 files |
| `packages/pi-agent-server/.../pi-harness-baseline` | 22 pass / 1 fail (pre-existing) |

**All 11 remaining failures are pre-existing, proven by running the same suites
in a clean `git worktree` at `eaaf67ab`:** the 7 `ensureStorageLayoutV2` cases,
both `config path default-root classification` cases, `managed paths with
NESSY_CONFIG_DIR`, and `Pi harness R0 baseline > executes golden foreground and
background process contracts`. The baseline additionally failed 4
environment-flaky cases (3 `headless server smoke test`, 1 `bash auto-background
real server e2e`) that the final run passed — hence 16 vs 11.

Under `.isolated.ts`, the 4 failures (`managed paths with NESSY_CONFIG_DIR`, 3 ×
`session branch rollback on preflight failure`) reproduce identically at
`eaaf67ab`.

**One failure was genuinely mine and is fixed in this commit:** `Pi harness R0
baseline > pins shipped materializer, lease, invalidation, catalog, trust,
storage, quiescence, and delete shapes`. It is a golden pin on
`RuntimeSkillHandle`'s field list, which Task 4 extended with `paths`. Doing its
job exactly as designed; the fixture was updated deliberately.

### Propagation of the same gaps found elsewhere — reported, not fixed

1. `packages/shared/src/config/validators.ts` carries a SECOND
   `SkillMetadataSchema` with the same four fields (`name`, `description`,
   `globs`, `alwaysAllow`). It is a plain `z.object`, so unknown keys are
   stripped silently — the same blind spot Task 5 fixed in
   `session-tools-core`. This is the validator the PreToolUse content check uses.
2. `optionalBoolean` (`skills/storage.ts`) accepts only `true`/`false`;
   `skills.md:248` documents `yes/no/on/off/1/0` in any case for every boolean
   field. A plugin skill written with `disable-model-invocation: yes` therefore
   reads as "not stated" and defaults to model-invocable.
3. R28's per-read rule trigger reaches only Pi and (now) Claude. Codex and the
   Nestor cloud agent never call `runPreToolUseChecks`, so `paths:` memory rules
   are inert there too.
4. `plugins/runtime-projection.ts:276` projects a plugin skill's `globs` into
   `LoadedSkill.metadata` but not `paths`. Display-only; the runtime path for
   plugin skills goes through the capability record, which Task 5 wired.
5. `packages/codex-protocol/generated/v2/SkillMetadata.ts` is a generated Rust
   contract with a completely different skill shape (`shortDescription`,
   `interface`, `dependencies`, `scope`). It shares only the type NAME with ours
   and was not touched.
6. `apps/electron/src/renderer/components/ui/EditPopover.tsx:165` tells the model
   editing SKILL.md frontmatter that the fields are "name, description, globs,
   alwaysAllow, requiredSources, icon" — none of the documented ones. It is also
   where `argument-hint` would surface if the `/` menu ever consumed it.

## Tests that must exist

- Substitution ordering: a body containing `$ARGUMENTS[0]`, `$ARGUMENTS`, `$0`
  and a `$name` in one string resolves each correctly (the case that fails under
  naive left-to-right replacement).
- The append fallback fires when no `$ARGUMENTS` token is present, and does not
  fire when one is.
- An unknown `$VAR` still stays literal after all of this (the R17 invariant).
- `allowed-tools: Read Grep` (space-separated, documented) and
  `allowed-tools: Bash(a,b)` (comma INSIDE a pattern) tokenize identically on the
  enforcement and display paths.
- A `paths`-gated skill is still invocable explicitly when no file matches.
- An `effort` value the model does not support degrades like an unavailable
  `model` does, not with a throw the user cannot act on.

## Gate

Affected packages during the loop: `capabilities`, `skills`, `agent`,
`session-tools-core`, plus `typecheck:all`, `lint`, `git diff --check`. Task 5
touches a plugin format adapter and a validation schema — run the plugin adapter
and skill-validation suites once on the final diff.

Tests from the REPO ROOT. Running a suite from a package directory bypasses the
config-dir isolation preload and will destroy the real
`~/.nessy-agent/config.json`; a guard fails the run, do not work around it.

## Live cases for the planner (do not run these yourself)

1. A skill with `arguments: [issue, branch]` invoked as `/skill 42 main` sees
   `$issue` = `42` and `$branch` = `main`.
2. A skill body with no `$ARGUMENTS` still receives `ARGUMENTS: 42`.
3. `${CLAUDE_SESSION_ID}` in a body resolves to the session actually shown in the
   app.
4. A `paths: ["*.py"]` skill is not auto-loaded in a TypeScript-only turn but is
   still invocable by name.
5. A plugin-imported skill's `allowed-tools` now shows in the capability view.

## Execution constraints

One commit per task with the subjects above; no `Co-Authored-By`; no push, MR or
tag; never `reset`/`rebase`/`amend`; pathspec-limited commits; no version bump or
release notes. Never `git checkout --` or `git stash` a file you are editing.
Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`.
You may edit this plan file.

**Another agent is concurrently executing R24 (MCP elicitation)** in
`packages/shared/src/mcp/`, the hook dispatcher, and the ask-user/question-card
surface. Stay out of those files. If a task here genuinely needs one, stop and
report instead of editing it.

Report any propagation of these contract gaps on other paths — do not fix it.

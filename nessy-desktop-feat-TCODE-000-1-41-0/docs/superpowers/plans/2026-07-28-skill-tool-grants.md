# R17b — parameterized `allowed-tools` in an invoked skill

**Status:** ready for execution
**Parity row:** R17 (blocks its close-out — R17's own live case 5 fails on HEAD)
**Branch:** `fix/renderer`
**Base:** `dcc329f9`

## Why this exists

R17 landed skill-directory expansion (`864f694d`), so a skill's
`allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)` now materializes to
`Bash(/Users/…/skills/<name>/scripts/render.sh *)` — the expansion half of the
documented pair works, proven live.

The other half does not. Live CDP pass 15 (2026-07-28), Ask mode, fixture skill
`~/.nessy-agent/skills/r17-dir`:

```
PreToolUse request from subprocess: Bash (sessionId=4370418e-…)
Tool blocked by permission mode {"toolName":"Bash","effectiveMode":"ask",
  "reason":"Tool \"Bash\" is outside the invoked skill tool ceiling."}
```

The skill asked for Bash with a command pattern and got **Bash denied outright**.
Same in `safe`/Explore, with the mode's own reason instead.

Cause — `packages/shared/src/agent/core/prerequisite-manager.ts:154`:

```ts
if (this.skillToolCeiling && !this.skillToolCeiling.has(toolName.toLowerCase())) {
```

Exact set membership on a lowercased **name**. The ceiling is built by
`narrowRuntimeSkillTools` (`packages/shared/src/capabilities/runtime-skill-content.ts:492`)
via `canonicalTool`, which lowercases the whole entry — so the entry is the
string `bash(/users/…/render.sh *)`, and the call's name `Bash` never matches it.

This is the recurring defect of the series, instance nineteen: **declared on one
path, enforced on another.** The restriction is parsed, variable-expanded,
digest-pinned into the invocation record and rendered — and the enforcement point
compares it against something it can never equal. Note the second-order damage:
the parameterized form is not merely un-granted, it is actively *denying* a tool
the skill author explicitly asked for. Every skill using the documented spelling
is broken today, including any imported Claude skill.

Contract source — `code.claude.com/docs/en/skills.md`: `:303` names the two
substitution sites (body + Bash rules in `allowed-tools`); `:309`/`:315` give the
canonical pair and state the rule "matches the exact command the skill body tells
Claude to run, so the script runs without prompting".

## Decisions already made — do not relitigate

1. **The mode ceiling wins over a skill grant.** A skill grant removes the
   *prompt* in a mode that would prompt (`ask`, `acceptEdits`). It does NOT widen
   a read-only mode: in `safe`/Explore the command stays blocked by the read-only
   allowlist, and in `plan` it stays blocked. This matches how Claude's plan mode
   behaves and keeps modes a real ceiling. Record it; do not implement a bypass.
2. **Nessy has no `Tool(pattern)` parser to reuse.** `matchesToolPattern`
   (`mode-manager.ts:214`) globs tool NAMES only; `permissions/default.json` uses
   regex `allowedBashPatterns`. So the parser is new. Keep it in one place and
   export it — do not inline the same parse at two call sites.
3. **Argument matching is Claude's prefix-glob, not a regex.** `Bash(cmd *)`
   matches a command that starts with `cmd ` (and `Bash(cmd)` matches exactly
   `cmd`). Do not evaluate author text as a regex — a skill author's `.` or `(`
   must not become a metacharacter, and a catastrophic pattern must not be
   reachable from a skill file.
4. **An unparameterized entry keeps today's meaning exactly.**
   `allowed-tools: Read, Grep` must still produce a bare-name ceiling with the
   same aliasing (`TOOL_ALIASES`), the same intersection semantics, and the same
   "empty intersection" throw. This is a superset change, not a rewrite.

## Tasks

### Task 1 — parse `Name(pattern)` and key the ceiling on the name

`packages/shared/src/capabilities/runtime-skill-content.ts`.

Add one exported parser: an `allowed-tools` entry is either a bare tool name or
`Name(pattern)`. Canonicalize the NAME through the existing `canonicalTool`
(so `Shell(…)` → `bash`, aliases unchanged), keep the pattern verbatim — it holds
a real filesystem path and must not be lowercased.

`narrowRuntimeSkillTools` intersects on canonical NAMES. Its return type has to
carry the patterns too; changing its shape is fine, but keep the existing
"empty intersection" throw and keep a bare entry's behaviour byte-identical.

Intersection rule when two invoked skills both restrict the same tool: the
result is the union of their patterns for that tool ONLY if both parameterized
it; if either named the tool bare, the bare (unpatterned) form wins for that
tool, because a bare name is the wider grant and intersection must not
*narrow* a tool one skill allowed unconditionally. If one skill omits the tool
entirely, it is out — unchanged.

**Commit:** `feat(skills): parse parameterized allowed-tools entries`

### Task 2 — enforce the ceiling on the name and the pattern

`packages/shared/src/agent/core/prerequisite-manager.ts`,
`packages/shared/src/agent/base-agent.ts:1969`.

`setSkillInvocationToolCeiling` takes the richer shape. `checkPrerequisites`
gains the tool input it already receives (`input?: Record<string, unknown>`) as
the pattern subject:

- tool name not in the ceiling → blocked, message unchanged (there are tests
  pinning that string).
- name in the ceiling, entry unparameterized → allowed, as today.
- name in the ceiling, entry parameterized, argument matches → allowed.
- name in the ceiling, entry parameterized, argument does NOT match → blocked
  with a distinct, actionable message naming the allowed pattern.

The argument subject for `Bash` is the command string. Derive it from the same
field the Pi gate populates — check `PI_TOOL_BINDINGS` / the Bash descriptor
rather than assuming `input.command`, and pin whatever you find with a test, so
a rename fails here instead of silently allowing everything.

**Commit:** `fix(skills): enforce parameterized allowed-tools at the ceiling`

### Task 3 — the grant: no prompt for a matching command

The pair only pays off if the matching command runs without prompting. Find the
seam where a tool call in `ask` mode becomes an approval request, and let a
skill-grant match settle it as allowed — without touching the read-only
allowlist path (decision 1).

State in the commit body exactly which seam you used and why the decision cannot
leak past the invoked turn: the ceiling is cleared by `clearSkillInvocation()`,
and the grant must have exactly the same lifetime. A grant that outlives its turn
is a worse bug than the one being fixed.

**Commit:** `feat(skills): honor a skill's Bash grant without prompting`

### Task 4 — close-out

Append to this file: per-task shas, gate output (real numbers), and the answer to
"what did the seam in Task 3 turn out to be". Do not touch
`docs/superpowers/specs/`, the parity audit, or `docs/testing/cdp-live-checklist.md`.

**Commit:** `docs(plans): close R17b with gate evidence`

## Tests that must exist

One representative positive and one negative per invariant, table-driven where
it helps. Minimum:

- `Bash(/abs/path/render.sh *)` allows `/abs/path/render.sh probe` and blocks
  `/abs/path/other.sh` and a prefix-adjacent `/abs/path/render.shX`.
- Author metacharacters are literal: a pattern containing `.` does not match an
  arbitrary character; a pattern containing `(` parses and matches literally.
- `allowed-tools: Read, Grep` produces the identical ceiling it does today
  (guard the no-regression case explicitly).
- Two invoked skills, one bare `Bash` and one `Bash(x *)` → bare wins for Bash.
- The grant does not survive `clearSkillInvocation()`.

## Gate

Affected-package only, per the Implementation-First Verification Budget: the
`capabilities`, `agent` and `session-tools-core` suites, `typecheck:all`,
`lint`, `git diff --check`. This touches a permission decision, which is a
listed immediate risk trigger — so run the permission/mode suites too, once, on
the final diff.

## Live case to re-drive after this lands (planner runs it, not you)

Fixture `~/.nessy-agent/skills/r17-dir` already exists on this machine:
`allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)` with the same
string in the body and a `scripts/render.sh` that echoes a token. In **Ask**
mode the script must run with no permission card and the token must come back;
in **Explore** mode it must stay blocked by the read-only allowlist.

## Close-out (2026-07-28)

**Status:** executed. Base `5761b58c` (the branch also picked up `d449c78b`,
docs-only, between the plan and Task 1).

| Task | Sha | Subject |
| --- | --- | --- |
| 1 | `73d44eba` | `feat(skills): parse parameterized allowed-tools entries` |
| 2 | `2a81032a` | `fix(skills): enforce parameterized allowed-tools at the ceiling` |
| 3 | `03c3aa14` | `feat(skills): honor a skill's Bash grant without prompting` |
| 4 | this commit | `docs(plans): close R17b with gate evidence` |

### The seam in Task 3

`evaluatePreToolUseChecks()` in `packages/shared/src/agent/core/pre-tool-use.ts`,
step 6 — the `if (promptInfo)` block inside the `ask | acceptEdits | auto`
branch, where the `PromptInfo` returned by `shouldPromptInAskMode` /
`shouldPromptInAutoMode` is turned into the `{ type: 'prompt' }` result.

That is the ONLY place in the codebase a tool call becomes an approval request.
`runPreToolUseChecks` is the sole producer of `{ type: 'prompt' }`, and both
backends (`pi-agent.ts`, `claude-agent.ts`) call it and only translate the union
into their own SDK shape — so one edit covers both runtimes and no backend can
drift out of it.

Placing the grant there is what makes decision 1 true by construction rather
than by a rule someone has to remember:

- `safe`/Explore and `plan` never reach the branch. Step 1's
  `shouldAllowToolInMode` already returned a block, so a grant cannot widen a
  read-only mode and the read-only allowlist (`isReadOnlyBashCommandWithConfig`,
  inside `shouldPromptInAskMode`) is untouched.
- Every approval floor returns earlier and is unreachable from the grant: the
  `EnterWorktree` worktree approval, `requiresUserInteraction`, and an explicit
  ask-rule prompt.
- `dontAsk` denies at step 1 and keeps its `dont_ask_would_prompt` marker.

**Why the grant cannot outlive the invoked turn.** It is not new state.
`PrerequisiteManager.skillGrantAllows()` reads `this.skillToolCeiling` — the
same single field the ceiling itself lives in — and returns `false` the instant
that field is null. There is no separate grant store to forget to clear, so the
grant has exactly the ceiling's lifetime: `clearSkillInvocation()` ends both, and
so does a non-preserving `resetReadState()`. Proven at the gate, not only on the
manager: `pre-tool-use-checks.isolated.ts` drives the REAL `PrerequisiteManager`
through `runPreToolUseChecks`, gets `allow` for the granted command, calls
`clearSkillInvocation()`, and gets `prompt` for the identical call.

### Decisions this plan did not make

1. **The argument matcher is reused, not new.** Decision 2 said "Nessy has no
   `Tool(pattern)` parser to reuse". That is not true on HEAD:
   `matchClaudeBashRule` (`agent/pi-harness/claude-bash-rule.ts`) already
   implements exactly decision 3's semantics — `*` as the only metacharacter,
   every other author character escaped literal, allow rules matching every
   subcommand, no glob rule crossing command substitution — and
   `claude-permission-rules.ts` already parses `Tool(specifier)` for permission
   RULE strings. Writing a second prefix-glob matcher would have been this
   series' own recurring defect. So Task 2 imports `matchClaudeBashRule`, and
   only the `allowed-tools` ENTRY parser (`parseSkillToolEntry`) is new — that
   one genuinely had no equivalent.
2. **A tool with no known argument subject keeps the bare, wider meaning.**
   `SKILL_GRANT_SUBJECT_FIELDS` covers Bash only. A parameterized entry for
   anything else (`Read(/x/*)`) is not denied — `allowed-tools` is a GRANT list,
   and denying a form we cannot subject-match would repeat the exact
   second-order damage this row fixes. A subject field we DO know but cannot
   read is a block, not an allow.
3. **Only the parameterized form grants a no-prompt run.** A bare `Bash` entry
   stays a ceiling member; treating it as a grant would hand every bare-`Bash`
   skill an unconditional shell.
4. **`current` gates names only.** `narrowRuntimeSkillTools`'s `current`
   argument (a child session's pinned `piAllowedTools`) is a runtime
   availability list, not an author's unconditional grant, so the bare-wins rule
   — which the plan scopes to "two invoked skills" — does not apply to it.
   Merging it as a bare entry erased every skill pattern the moment a child
   session pinned a tool list: the grant worked at the top level and silently
   vanished one level down. Caught while tracing the child path and corrected in
   `03c3aa14`.
5. **`dontAsk` is unchanged.** A granted command is still denied there, because
   the mode blocks at step 1 and decision 1 names only the prompting modes.

### Gate

Run from the repo root. All numbers are from the final diff at `03c3aa14`.

| Check | Result |
| --- | --- |
| `bun test packages/shared/src/capabilities packages/session-tools-core` | 362 pass, 0 fail, 1307 expect (40 files) |
| `bun test packages/shared/src/agent` | 1723 pass, 3 skip, 0 fail, 5707 expect (162 files) |
| `bun test ./…/prerequisite-manager.isolated.ts` | 30 pass, 0 fail |
| `bun test ./…/pre-tool-use-checks.isolated.ts` | 112 pass, 0 fail, 229 expect (was 108 at base) |
| `bun test packages/…/runtime-skill-content.test.ts` | 20 pass, 0 fail (was 14 at base) |
| `bun test …/skill-invocation.test.ts …/skill-tool-grant-subject.test.ts` | 9 pass, 0 fail |
| Permission/mode suites (27 files, risk trigger) | 637 pass, 11 skip, 0 fail |
| `bun run typecheck:all` | clean (9 projects) |
| `bun run lint` | 0 errors, 118 + 4 warnings — all pre-existing `Unused eslint-disable` |
| `git diff --check` | clean |
| `bun test` (whole repo) | 8792 pass, 18 skip, **11 fail** (827 files) |
| `.isolated.ts` sweep (8 files) | 4 fail, all in two files |

The permission/mode set was `mode-manager.test.ts`,
`SessionManager.permission-authority.test.ts`, `permission-remember.test.ts`,
`managed-policy-loader.test.ts`, `permission-service.test.ts`,
`call-llm-permissions`, `mode-manager-bash-hints`,
`permissions-config-migration`, `spawn-session-permission-mode-schema`,
`permission-mode-clamp`, `dont-ask-mode`, `mode-manager-path-boundary`,
`session-tool-safe-mode-permissions`, `browser-tools-permissions`,
`send-developer-feedback-permissions`, `permission-receipt`,
`claude-permission-rules`, `managed-policy`, `claude-bash-rule`,
`worktree-approval-floor`, `permission-dsl`, `monitor-bash-rules`,
`permission-context-boundary`, `permission-manager`,
`storage-permission-mode-normalization`, `jsonl-permission-mode-normalization`,
`previous-permission-mode`.

**Pre-existing failures**, all reproduced on a clean `git worktree` at
`5761b58c` with an identical fail set (the worktree was removed afterwards; no
`stash` and no `checkout --` was used at any point):

| Suite | Fails | Cause |
| --- | --- | --- |
| `workspaces/__tests__/storage-readiness.test.ts` | 7 | its `Bun.spawnSync` child trips the `CONFIG_DIR` isolation guard |
| `config/__tests__/paths-default-root.test.ts` | 2 | same guard, same mechanism |
| `workspaces/__tests__/paths-env.isolated.ts` | 1 | same guard |
| `pi-agent-server/…/pi-harness-baseline.test.ts` | 1 | golden process contract |
| `apps/electron/…/session-branch-rollback.isolated.ts` | 3 | `setAutomationSystem is not a function` in the test double |

### Defect propagation found on other paths — reported, NOT fixed

Scope was held to this plan. None of these break enforcement, which re-reads the
SKILL.md frontmatter at invocation time.

1. **`readPluginSkillFrontmatter` deliberately drops `allowed-tools`**
   (`plugins/format-adapters/shared.ts:175`), with the rationale "left out
   because nothing enforces it yet". That rationale is now stale. Consequence is
   display-only: an imported Claude plugin skill's grant is enforced (the
   materializer reads the file) but never appears in `skillAllowedTools`, so the
   capability view and any UI reading it under-report what the skill declares.
   The same stale "enforcement is out of scope / for display only" claim sits in
   `skills/types.ts:32`, `capabilities/types.ts:117` and `capabilities/views.ts:85`.
2. **Two different tokenizers parse the same field.** The enforcement path uses
   `stringList` (`runtime-skill-content.ts:272`), which splits on commas ONLY;
   the capability/display path uses `normalizeToolList`
   (`skills/storage.ts:117`), which tokenizes with
   `/[^\s,()]+(?:\([^)]*\))?/g`. They agree on the documented spelling and
   diverge on a pattern containing a comma (`Bash(cat a.txt, b.txt)`): the
   runtime splits it into two broken entries, the display path keeps it whole.
   Neither is a third implementation of the MATCHER, but it is a second
   implementation of the SPLIT.
3. **`skill_validate` does not know the field exists.** `SkillMetadataSchema`
   (`session-tools-core/src/validation.ts:197`) is `.passthrough()` with no
   `allowed-tools` entry, so a misspelled key or an unclosed `Bash(` validates
   clean and fails silently at runtime.
4. The Codex adapter's `frontmatter.tools` parsing (`codex.ts:1419`) is the
   AGENT importer, not skills — name lists only, nothing parameterized. Not
   affected.

## Execution constraints

One commit per task with the subject above; no `Co-Authored-By`; no push, MR or
tag; never `reset`/`rebase`/`amend`; pathspec-limited commits; no version bump or
release notes. Never `git checkout --` or `git stash` a file you are editing —
two executors in this series destroyed work that way. Run tests from the repo
root (the `CONFIG_DIR` isolation guard fails a suite run from a package
directory, by design). You may edit this plan file.

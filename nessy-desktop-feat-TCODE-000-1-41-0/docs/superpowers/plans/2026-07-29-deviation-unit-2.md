# Deviation Unit 2 — rule and grant specifier parsing

**Status:** closed
**Source:** `docs/superpowers/specs/2026-07-29-deviation-worklist.md` § 3, Unit 2
**Branch:** `fix/renderer`
**Base:** `8ee5fbbf`

Six rows, all about how a specifier string is compiled and matched. One commit
per row. No new persistence surface; five files touched.

## Contract source — re-fetched raw, cites verified against the fetched files

```
curl -sL https://code.claude.com/docs/en/permissions.md      # 567 lines
curl -sL https://code.claude.com/docs/en/sandboxing.md       # 505 lines
curl -sL https://code.claude.com/docs/en/skills.md           # 929 lines
curl -sL https://code.claude.com/docs/en/tools-reference.md
```

`permissions.md:210` — the prompt-anyway carve-out:

> **Commands the analysis can't parse**: when Claude Code can't fully parse a
> command, it asks for approval instead of treating the command as read-only.
> Commands longer than 10,000 characters always prompt because they exceed what
> the analysis parses.

`permissions.md:96` — parameter rules are deny/ask, on **any** tool:

> Deny and ask rules can match a top-level input parameter on any tool with
> `Tool(param:value)`. […] An allow rule for one parameter value wouldn't
> establish that the call is safe overall, so allow rules continue to use each
> tool's own specifier syntax.

`permissions.md:102` gives `Bash(run_in_background:true)` in the example table.
`permissions.md:106` — "The parameter name must be a direct field of the tool's
input". `permissions.md:108` — `*` wildcard, otherwise exact.
`permissions.md:110` — compared "against the literal input Claude sends".
`permissions.md:113` — `command` for Bash/PowerShell is excluded and warned.
`permissions.md:136`/`:138` — `Bash(ls:*)` is the trailing-wildcard form, and
`:*` "is only recognized at the end of a pattern".

`permissions.md:288`–`:296` — the settings-source anchor table for a single
leading slash; `:296` is the row a turn-scoped grant falls under
(`CLI flags, /permissions, or session rules` → `<original cwd>`).

`sandboxing.md:135` — the exact rule an administrator is told to write:

> To be prompted on every unsandboxed retry even in auto mode, add an ask rule
> for `Bash(dangerouslyDisableSandbox:true)`.

`skills.md:426` — `allowed-tools: Bash(git add *) Bash(git commit *) Bash(git
status *)`, i.e. permission-rule syntax verbatim. `skills.md:261` — the field
"Accepts a space- or comma-separated string, or a YAML list".

On command substitution the docs say **less** than our code assumed: it appears
only in the `bypassPermissions` circuit breaker (`permissions.md:63`), and
`:218`–`:224` explicitly gives up on argument-shaped Bash patterns, naming
`URL=http://github.com && curl $URL` as a variation it does not defend.

## The six rows, in commit order

| # | Row | Commit |
| - | --- | ------ |
| 1 | R1 — unparseable / >10 000-char Bash hard-denied | `cf4d0d0b` |
| 2 | R1 — glob + `$()` allow veto over-catches arithmetic | `5fb544a8` |
| 3 | R21/P10 — parameter matcher compares a string to a boolean | `6d492438` |
| 4 | R21/P10 — `Bash(param:value)` compiles to a dead command glob | `88aa47a7` |
| 5 | R17b — non-Bash parameterized `allowed-tools` loses its specifier | `2db3d4b3` |
| 6 | R17b — the second `SkillMetadataSchema` | `0e9cd8db` |

Rows 3 and 4 were committed in that order deliberately: without the coercion,
the routing fix could not be proven end to end, because the rule the docs tell
administrators to write compiles to `equals: 'true'` and meets a boolean.

## Direction proofs the unit was required to produce

**Row 1 must not turn any deny into an allow.** Proven by test, not argument
(`permission-dsl.test.ts`, "an unparseable or over-long Bash command prompts,
and never becomes an allow"): the sentinel enters selection as an `ask`
candidate, so `ACTION_WEIGHT` lets it only raise an outcome.

- allow-only program + unparseable command → `ask` (was `deny`)
- deny rule matching on its own terms + unparseable command → `deny`, rule id
  `deny-all` (unchanged)
- bare-tool allow + unparseable command → `ask`, never `allow`
- the same program + a parseable `git status` → `allow` (unchanged)
- no rules at all → no action; the gate prompts on its own (unchanged)

**Row 2 must state exactly what became matchable.** Measured differentially by
running every entry point of both scanners over 31 commands × 9 patterns ×
{allow, deny} plus `splitCompoundCommand`. Seven differences, all of them:

```
allow  Bash(sleep *)   sleep $((60*5))            no-match -> match
allow  Bash(echo *)    echo "$(( (1+2)*3 ))"      no-match -> match
allow  Bash(echo *)    echo $((RANDOM%3))         no-match -> match
allow  Bash(echo *)    echo $(())                 no-match -> match
allow  Bash(echo *)    echo $(( ))                no-match -> match
if     Bash(printf *)  echo $(printf `date -u`)   no-match -> match
if     Bash(date *)    echo $(printf `date -u`)   no-match -> match
```

The deny floor is untouched: the veto lives inside `if (ruleAction === 'allow')`
and never ran for deny or ask; no deny or ask result and no
`splitCompoundCommand` output changed anywhere in the differential. A
substitution nested inside arithmetic (`$(( $(id -u) ))`, `$(( \`id -u\` ))`)
stays vetoed, and `echo $((1+2)` stays unparseable.

The two `if` rows are a second defect the rewrite fixes: the old scanner kept
one shared `spanStart`, so a backtick nested inside a `$(…)` overwrote the
enclosing span's start and the hook filter received a truncated inner command.

## Gate evidence

Run from the repo root. `typecheck:all` could not be run in the working tree —
a concurrent agent's in-flight Unit 1 edits to `base-agent.ts` and
`capabilities/*` break it — so it was run in a detached worktree at this unit's
HEAD (`git worktree add --detach`, `node_modules` symlinked).

```
$ bun run typecheck:shared
(clean)

$ bun run typecheck:all              # in a clean worktree at 0e9cd8db
core, shared, server-core, server, session-tools-core, pi-agent-server: clean
apps/electron: 1 dual-identity error caused by the symlinked node_modules
resolving @nessy-agent/server-core to the main checkout — a worktree artifact,
not a repo error.
```

Permission suite (22 files):

```
$ bun test packages/shared/src/agent/pi-harness/{permission-dsl,claude-permission-rules,claude-bash-rule,permission-receipt,managed-policy}.test.ts \
    packages/shared/src/agent/core/__tests__/{permission-manager,permission-context-boundary}.test.ts \
    packages/shared/src/agent/__tests__/{permissions-config-migration,browser-tools-permissions,call-llm-permissions,send-developer-feedback-permissions,session-tool-safe-mode-permissions,spawn-session-permission-mode-schema,permission-mode-clamp}.test.ts \
    packages/shared/src/sessions/__tests__/{jsonl-permission-mode-normalization,previous-permission-mode}.test.ts \
    packages/shared/src/workspaces/__tests__/storage-permission-mode-normalization.test.ts \
    packages/server-core/src/pi-harness/permission-service.test.ts \
    packages/server-core/src/sessions/{SessionManager.permission-authority,permission-remember}.test.ts \
    apps/electron/src/renderer/event-processor/handlers/permission-mode-changed.test.ts \
    apps/electron/src/renderer/lib/__tests__/composer-permission-modes.test.ts
 209 pass, 0 fail, 742 expect() calls, 22 files
```

Mode suite (10 files):

```
 503 pass, 11 skip, 0 fail, 708 expect() calls, 10 files
```

Skill-grant suite (45 files, incl. `session-tools-core`):

```
 471 pass, 0 fail, 1 snapshot, 1533 expect() calls, 45 files

$ bun test ./packages/shared/src/agent/core/__tests__/prerequisite-manager.isolated.ts
 30 pass, 0 fail
```

Whole-package sweep of everything touched:

```
$ bun test packages/shared packages/server-core packages/session-tools-core
 7026 pass, 18 skip, 10 fail, 21213 expect() calls, 583 files
```

The ten failures are exactly the known pre-existing set — seven
`ensureStorageLayoutV2` cases, two `paths-default-root` cases, one
`managed paths with NESSY_CONFIG_DIR` — and nothing else.

## Deviations recorded

| Subject | Category |
| --- | --- |
| Unparseable / >10 000-char Bash command prompts (`permissions.md:210`) | `documented, implemented` |
| Glob allow rule vs command substitution | `documented, implemented` — the veto itself is a fail-closed choice **beyond** the docs, kept and now narrowed to code that actually executes |
| `Tool(param:value)` value comparison (`permissions.md:108`, `:110`) | `documented, implemented` |
| `Bash(param:value)` on deny/ask (`permissions.md:96`, `:102`; `sandboxing.md:135`) | `documented, implemented` |
| `Bash(description:…)` | `documented, not implemented — the Nessy Bash tool declares no `description` input (`runtime-backed-tools.ts` BASH_PARAMETERS: `command`, `timeout`, `run_in_background`), so the name stays a command pattern rather than a parameter rule that could never match` |
| Parameterized `allowed-tools` for non-Bash tools (`skills.md:426`) | `documented, implemented` |
| `/path` anchor for a skill grant | `documented, implemented` — `permissions.md:288`–`:296` has no skill row; the nearest documented row is session rules → original cwd, so it anchors at the workspace root |
| Skill frontmatter schema (`skills.md:252`–`:268`) | `documented, implemented` — one schema, shared with `session-tools-core` |

## Worklist claims that were wrong about the code

1. **Row R17b-schema** — "*probe: a misspelt `allowed-tool` + unclosed `Bash(`
   → `valid=true, 0 errors, 0 warnings`, while `session-tools-core` correctly
   errors*". The shared half is right; the core half is not. On that exact
   content `session-tools-core` returns `valid=true` with **one warning**
   (unknown field `allowed-tool`) and no error — its unbalanced-parenthesis
   check reads only the correctly spelled `allowed-tools` / `allowedTools` /
   `disallowed-tools` / `disallowedTools` keys, so a misspelt key never reaches
   it. Core errors only when the field name is spelled right. Measured both
   ways before and after.

2. **Row R1-unparseable** — the cites `permission-dsl.ts:617,701-707` are
   correct but incomplete as a fix scope. The `unsafe-shell` sentinel at
   `:701-707` is shared with a *second* producer at `:603`, the native
   structural matcher (`kind: 'bash'` with `executable`/`args`), whose refusal
   covers compound, substitution and glob syntax — not the documented
   carve-out. Changing both would have converted a managed-policy hard deny into
   a prompt. Only the `bashPattern` branch was moved; see propagation below.

Everything else the worklist asserted about these six rows reproduced exactly,
including the corrected R1 scope (a `Bash(rm *)` **deny** rule flips an
unrelated unparseable command to a terminal deny just as an allow rule does).

## Propagation found, not fixed

- **`permission-dsl.ts:603` — the native structural `bash` matcher still hard-
  denies.** A managed allow rule `{executable:'git', args:['status']}` against
  `git status && rm -rf x`, `echo $(whoami)` or `cat *.pem` returns a terminal
  `deny` with `invalid-document`, because `shellProgram` refuses any command
  containing `|&;<>$*?[`. Under Claude semantics an allow rule that does not
  match simply does not match, and the outcome falls through to the mode
  default. This is a managed-policy posture pinned by an existing test
  (`permission-dsl.test.ts`, "fails closed for compound, substitution and glob
  syntax") and belongs to whatever unit owns managed-policy matcher semantics —
  it is not the `permissions.md:210` carve-out.

- **`prerequisite-manager.ts` skill grants now inherit every rule-string
  posture, including the inert ones.** `Cd(path)` and `PowerShell(pattern)`
  entries in `allowed-tools` compile to nothing, so they behave as the bare,
  wider grant. Both are already live Unit 6 rows; closing them there closes
  this automatically, with no further change here.

- **`Bash(timeout:…)` compiles but our tool measures milliseconds** while
  `tools-reference.md:155` describes the Claude parameter in minutes ("up to 10
  minutes per command"). An imported `Bash(timeout:600000)` rule is written for
  our units, not Claude's. Worth a row if imported Claude settings are ever
  expected to carry it.

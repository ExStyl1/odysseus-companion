# Inert units U-C and U-D — hook descriptor drop-through, Claude rule plumbing

Closes the six rows in `2026-07-29-inert-worklist.md` §5 U-C and U-D. All commits
are on `fix/renderer`. They are one unit because U-C's path and U-D's module
overlap at the adapter/projection/matcher seam.

| Unit | Row | Commit |
| --- | --- | --- |
| U-C | `PluginHookDescriptor.args` — dropped in projection, no exec form, outside the trust hash | `943bacbd` |
| U-C | imported hook timeout read as `entry.timeoutMs` | `92aab886` |
| U-C | `PluginHookDescriptor.statusMessage` — dies at the resolver | `906638da` |
| U-D | `ParseClaudeRuleOptions.knownToolNames` never supplied, warning unreachable | `7987d4c6` |
| U-D | `ClaudeHookIfCall.sourceRoot` never supplied | `8826cfef` |
| U-D | `ClaudeHookIfResult.unparseableRule` has no reader | `efbeeb5f` |
| U-D | follow-up the differential caught: only `unknown_tool` refuses a managed rule | `f61778b7` |

## The contract, re-derived from the page

`curl -sL https://code.claude.com/docs/en/hooks.md` on 2026-07-29 returned **3169
lines**; `permissions.md` **567**; `plugins-reference.md` **1304**. Line numbers
below are from those fetches and are expected to rot.

hooks.md § Common fields, `:339`: "`timeout` … Seconds before canceling.
Defaults: 600 for `command`, `http`, and `mcp_tool`; 30 for `prompt`; 60 for
`agent`. `UserPromptSubmit` lowers the `command`, `http`, and `mcp_tool` default
to 30, and `MessageDisplay` lowers it to 10. `SessionEnd` hooks share a
1.5-second budget". `:2689` adds: "Timeouts set on plugin-provided hooks don't
raise the budget." `:340`: "`statusMessage` … Custom spinner message displayed
while the hook runs." Both are listed under **Common fields**, which `:336` scopes
to "all hook types".

hooks.md § Exec form and shell form, `:375`-`:379`: "A command hook runs as exec
form when `args` is set, and shell form when `args` is omitted … Claude Code
resolves `command` as an executable on `PATH` and spawns it directly with `args`
as the argument vector. There is no shell, so each `args` element is one argument
exactly as written … Special characters such as apostrophes, `$`, and backticks
pass through verbatim because there is no shell to interpret them." `:406`: path
placeholders "are substituted into `command` and into each `args` element as
plain strings" — the host does it, since there is no shell.

permissions.md `:281`: a `/path` pattern is "Path relative to the settings
source"; `:288`-`:294` lists the five sources it can anchor at. `:318`-`:322`
gives the allow-vs-deny depth rule for a single-segment relative pattern.

hooks.md `:336` (`if`): "Only evaluated on tool events: `PreToolUse`,
`PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, and `PermissionDenied`.
On other events, a hook with `if` set never runs."

## Did these rows undercount their real scope? Yes — four ways.

1. **`args` is dropped at THREE chokepoints, not two.** The row names
   `projectHook` and `RuntimeHookRegistration`. The third is the adapter reader:
   `readStringArray` collapses an empty array to `undefined`, so `"args": []` —
   which hooks.md uses in six of its own examples, and which means *exec form
   with no arguments* — silently became shell form before the projection ever
   saw it. `readHookArgsVector` replaces it on every hook path, including
   `schema.ts`, which the Claude adapter round-trips through.
2. **The 120s ceiling has a second copy.** The row cites `hook-command.ts:410`.
   `SessionManager.pluginCommandHookRunner` carried its own
   `Math.min(action.timeoutMs ?? 30_000, 120_000)`, and that is the one the
   production Pi path actually uses — the `hook-command.ts` runner is the
   non-Pi `allowDirectCommandRunner` fallback.
3. **`timeout` and `statusMessage` were command-branch-only in BOTH adapters.**
   The rows read as "wrong key" and "dies at the resolver". They are common
   fields, so a `prompt`, `agent`, `mcp` or `http` hook could never carry either
   one at all — `clampPromptHookTimeoutMs` has always received `undefined`.
4. **`knownToolNames` has seven call sites, and only three can use it.** The row
   names six; it misses `sandbox-permission-rules.ts:107`. More usefully: the
   unknown-tool branch requires `action !== 'allow'`, and four of the seven parse
   `allow` only (the skill grant, the hook `if` filter, the module's own filter
   evaluation, and the sandbox-root projection). Supplying the inventory at all
   seven would have been four dead arguments. It is supplied at the three that
   can parse a deny or ask.

## The owner question, and what the docs say about it

**A plugin hook's `if` filter anchors to the plugin's own root.** The docs do not
contradict it. permissions.md anchors `/path` "at a directory associated with the
settings source that defines it" and enumerates five sources — project settings,
local settings, user settings, `--settings <file>`, and CLI/session rules. A
plugin is not among them, and plugins-reference.md gives plugins no `permissions`
component at all, so the page is simply silent on plugin-provided rules.

The one sentence that looks like a counter-example is hooks.md's own `if` note
(`:352`): "a single-segment directory pattern like `Edit(src/**)` matches only
the `src` directory in the working directory". That is the **bare-relative**
anchor, which permissions.md `:282` already defines as cwd-relative for every
rule everywhere; it says nothing about the leading-slash form. Reading the
paragraphs around it confirms it is a depth note, not an anchor note.

So the owner ruling stands, recorded in the matcher as `ifSourceRoot`.

## U-C differential — 168 configurations, every one moved on at least one axis

`scratchpad/differential-uc.ts` (not committed — it imports reimplementations of
the two deleted adapter readers, the old action builder and the old trust hash).
3 events × 5 hook types × {absent, `[]`, `["lint.js","--fix"]`} args ×
{none, `timeout:300`, `timeoutSec:90`, `timeoutMs:7000`} × {statusMessage
absent, present} = **168 configurations**, args enumerated on `command` only.

| Axis | Moved | Directions |
| --- | --- | --- |
| spawn form | 48 | 48 `shell → exec`; **0 the other way** |
| timeout | 74 | 38 longer, 36 shorter |
| status label | 84 | 84 unreachable → reachable; 0 lost |
| trust hash | **168** | every one |

**Spawn form, 48.** Every `command` hook that declares `args` — including the
empty vector — stops being `sh -c "<command>"` and becomes a direct spawn. No
configuration went the other way: a hook with no `args` is untouched.

**Timeout, 74 of 168.** Longer: 6 × `30000 → 600000` (no declaration, the
documented `command`/`http`/`mcp_tool` default), 16 × `30000 → 300000` and
16 × `30000 → 90000` (a declared `timeout`/`timeoutSec` that used to be dropped
entirely). Shorter: 26 × `30000 → 1500` and 6 × `7000 → 1500` (`SessionEnd`'s
documented shared budget, which a plugin hook may not raise), 4 ×
`30000 → 7000` (a `timeoutMs` on a non-command type, previously dropped by the
command-branch-only reader). The remaining 94 are unchanged.

**Trust hash, 168 of 168 — every already-trusted plugin hook re-prompts once.**
`args` is now a key in the hashed object (`null` when absent), so the digest
moves even for a hook that declares none. Concretely: on the next projection each
installed hook fails `isTrusted`, is **skipped**, and raises
`plugin.hooks.untrusted_skipped` plus a trust requirement — the same path a
newly-installed hook takes. Nothing runs under stale trust and nothing is
deleted; the user re-approves once per hook. This is the intended cost: without
it, editing a trusted hook's argument vector — or adding one, which also changes
the spawn form — never re-prompted.

Fixtures moved rather than loosened: the pinned literal in
`hooks-automation.test.ts` is repinned from `59ec3821…` to `6d6ef62d…`, with the
reason recorded next to it.

## U-D differential

`scratchpad/differential-ud.ts` (not committed).

**Part A — `knownToolNames`: 342 configurations, 54 moved.** 38 rule strings ×
3 actions × 3 consuming sites.

| Direction | Count |
| --- | --- |
| Claude `settings.json`: installed silently → installed **and reported** | 18 |
| hook `updatedPermissions`: installed silently → installed **and reported** | 18 |
| managed Pi policy: installed silently → **refused and recorded** | 16 |
| managed Pi policy: installed silently → installed **and reported** | 2 |

Nothing moved in the other direction: no rule that used to be enforced stopped
being enforced except the 16 that matched no tool in the first place. The 18
distinct rules that moved per site are `Glob`, `Agent`, `KillShell`, `MultiEdit`
(documented Claude tools Nessy has no counterpart for), `StopTask`, `Baash`,
`Reed`, `Foo(bar:baz)` (typos), each × `deny` and `ask`, plus `EndConversation` ×
2, which reports but is **kept** — see below. Every `allow` is untouched by
construction, and `_`, `*` and `mcp__` names stay exempt: `some_tool`,
`notebook_edit`, `mcp__linter__lint`, `mcp__linter__*` and `*` did not move.

**The follow-up `f61778b7` exists because of this table.** Refusing on any
warning also stripped `deny EndConversation`, whose
`claude_rule.end_conversation_guarded` warning rides alongside a rule that is
genuinely enforceable — it records a consumer-side exception, not a dead match.
Only `claude_rule.unknown_tool` refuses.

**Part B — `sourceRoot`: 144 configurations, 21 moved, all in one direction.**
12 `if` rules × {bundle root, no root} × 6 tool calls.

All 21 are **always-ran → now filtered**; **0 configurations went from filtered
to running**. They are the four source-anchored rules (`Edit(/scripts/**)`,
`Read(/secrets/**)`, `Edit(/**)`, `Cd(/worktrees/**)`) against the five calls
each that should never have matched. `Edit(/scripts/**)` on a file inside the
bundle's own `scripts/` still runs — it used to run for the wrong reason (fail
open) and now runs for the right one. Hooks with **no** bundle root are
unchanged: they still fail open, and that is now what the registration
diagnostic says.

**The registration probe.** `unparseableRule` reports fail-open for exactly the
right set: `Edit(/scripts/**)`, `Read(/secrets/**)`, `Edit(/**)`,
`Cd(/worktrees/**)` when no root is supplied and not when one is; `???` and
`Write(docs/**)` always (they cannot be enforced at all); `Edit(src/**)`,
`Read(//etc/**)`, `Read(~/x/**)`, `Bash(git *)`, `Agent(reviewer)` and
`WebFetch(domain:x.dev)` never. The old check — `parseClaudeRuleString(...).rule`
— saw only the last two of those twelve.

## Decisions

**1. What renders an exec-form hook to the permission gate.** The sandboxed host
runner evaluates `Bash(...)` rules against the hook's command string. In exec
form that string is now `formatExecFormHookCommandLine(command, args)`, the
shell-equivalent rendering of the whole invocation with placeholders already
substituted — a rule reading only `node` would otherwise approve any script it is
handed. The spawn still takes the vector, never the rendering, and an approval
that comes back with a different line is refused rather than spawning the
original vector under an approval given for something else.

**2. Which placeholders exec form substitutes.** A closed list —
`NESSY_PLUGIN_ROOT`/`_DATA`, `NESSY_PROJECT_DIR`, `PLUGIN_ROOT`/`PLUGIN_DATA`,
and the three `CLAUDE_*` compat aliases — in brace form only. `expandEnvVars`
would have expanded any `$VAR`, which contradicts "`$` … pass through verbatim
because there is no shell to interpret them". A bare `$HOME` in an argument is
data.

**3. Exec form still goes through the host shell wrapper, without evaluating.**
The wrapper exists to bind bare `node` to the host runtime; dropping it for exec
form would break the documented `{"command":"node","args":[…]}` shape, which is
the page's own recommendation. So exec form runs `"$NESSY_HOOK_COMMAND" "$@"`
from positional parameters: a simple-command lookup, so the `node` function still
intercepts, and nothing is re-tokenized. Windows takes the vector as JSON in the
environment because PowerShell's `-Command` folds trailing positional arguments
into the script text.

**4. The documented timeout defaults apply to imported hooks only.** Resolved at
the two plugin action builders, not in `runHookCommand`, so stored native
automations keep the 30s default they were authored against. The 120s ceiling is
raised to 600s — the largest documented default — for everyone; it appears
nowhere in the page and on `PreToolUse` a truncated timeout is `success: false`,
which is a block, so the hook did not merely stop early, it denied the call.

**5. `statusMessage` gets a spinner, not a transcript entry.** The existing
`status` wire event appends a persisted `role: 'status'` message; a `PreToolUse`
hook fires on every tool call, so reusing it unchanged would bury the transcript.
`statusType: 'hook'` drives `currentStatus` only. The label is reported after
matching (a hook filtered out by its matcher or its `if` must not relabel the
spinner) and cleared by `executeAgentEvent` in a `finally`, so a hook that
blocked or threw still releases it. With no reporter injected the label is
carried and never shown — the pre-change behaviour.

**6. The managed loader refuses an unknown-tool rule; the other two report it.**
`parseManagedClaudeRulesV1` already keeps a `claudeRules` list of "only the
entries that actually compiled", because a rule string left there "would claim to
be enforced when it enforces nothing". Post-R25a a refusal there is a recorded
drop, never a fatal, and only the tolerant parser runs in production
(`managed-policy-loader.ts:371`, `managed-delivery.ts:210`). Claude
`settings.json` and a hook's `updatedPermissions` keep the rule and report,
which is what permissions.md's "startup warning" specifies.

## Deviations recorded

| Item | Category |
| --- | --- |
| `args` / exec form / shell form / placeholder substitution | `documented, implemented` |
| `timeout` in seconds, per-type and per-event defaults, `SessionEnd` budget | `documented, implemented` |
| `statusMessage` on all five hook types | `documented, implemented` |
| `if` filter source anchor for plugin hooks | `documented, implemented` — the anchor for a plugin-provided rule is not specified; owner decision 2026-07-29 |
| unknown-tool startup warning | `documented, implemented` |
| Exec-form bare-name-with-whitespace warning (hooks.md `:411`) | `documented, not implemented — the spawn failure surfaces as the hook error notice instead of a load-time warning` |
| `shell: "bash" \| "powershell"` common field | `documented, not implemented — neither adapter reads it; the host wrapper selects the platform shell itself and ignores the field when `args` is set, which is the documented behaviour for exec form only` |
| `MessageDisplay`'s 10s timeout lowering | `documented, not implemented — Nessy emits no MessageDisplay event (recorded in the U-B close-out)` |
| `SessionEnd` budget raised by a settings-file hook up to 60s | `documented, not implemented — Nessy has no settings-file hook tier that could raise it; a plugin hook may not raise it by contract, which is the case implemented` |
| Managed refusal instead of a warning for an unknown-tool rule | `documented, not implemented — permissions.md specifies a warning; the managed tier's own recorded posture strips an entry that enforces nothing, and the drop record is its admin-facing surface` |

## Gate evidence

Risk triggers per `AGENTS.md`: a shared hook wire shape, a trust hash and
permission-rule matching. Run once on the final diff, all from the repo root.

```
bun run typecheck:all      clean (core, shared, server-core, server,
                           session-tools-core, pi-agent-server, electron, ui)
bun run lint               0 errors, 122 warnings (118 electron, 4 shared)
                           — all pre-existing
```

Hook contract aggregate + permission/mode suites + plugin adapter suites:

```
bun test packages/shared/src/automations packages/shared/src/plugins \
         packages/shared/src/capabilities packages/shared/src/agent \
         packages/pi-agent-server/src/extensions \
         packages/server-core/src/pi-harness \
         apps/electron/src/renderer/event-processor
  3256 pass, 4 skip, 0 fail, 272 files, 25.30s
```

Full repository:

```
bun test
  9475 pass, 18 skip, 13 fail, 6 snapshots, 38179 expect(), 873 files, 292.13s
```

All failures are the documented pre-existing set (a second enumerating run
listed 14 — the load-sensitive e2e below):

| Count | Failure |
| --- | --- |
| 7 | `ensureStorageLayoutV2` |
| 2 | `config path default-root classification > treats an empty override as the default root` |
| 1 | `managed paths with NESSY_CONFIG_DIR` |
| 2 | `SessionManager Pi child orchestration composition` background-authority |
| 1 | `Pi harness R0 baseline > executes golden foreground and background process contracts` |
| 1 | `bash auto-background real server e2e > transitions on timeout, excludes sleep, and honors run_in_background` |

The last is the same load-sensitive class as the listed `bash tool-input timeout
real server e2e` — it asserts wall-clock transitions inside a 292s full-suite
run. In isolation:

```
bun test packages/pi-agent-server/src/tools/bash-auto-background-real-server.test.ts
  1 pass, 0 fail
```

New tests: 1 exec-form spawn through the real runner, 1 exec-form/shell-form
selection + placeholder scoping in `hook-command.test.ts`, 1 trust-hash
four-way distinctness, 2 in `plugin-hook-command.test.ts` (posix vector spawn,
Windows JSON vector), 1 adapter `timeout`-in-seconds table, 1 adapter Codex
`timeoutSec`, 1 adapter `statusMessage` on three types, 1 registration timeout
resolution table, 1 status report + clear, 2 renderer `handleStatus` arms,
1 `PERMISSION_RULE_TOOL_NAMES` coverage table, 2 managed-policy rows
(unknown-tool refused, `EndConversation` kept), 1 source-anchored `if` filter,
1 registration fail-open diagnostic.

## Where the list or my brief was wrong about the code

- **"six production call sites" for `knownToolNames` is wrong in both
  directions.** There are seven (`sandbox-permission-rules.ts:107` is missing
  from the list), and only three of them can ever reach the branch, because four
  parse `allow` only.
- **Two line cites decayed.** `hooks-automation.ts:676-695` for the trust hash is
  `:730`-`:757`; `hooks-automation.ts:1023-1035` for `hookIfFilterRuns` is
  `:1077`-`:1090`. Every other cite in these six rows checked out on HEAD,
  including `hooks.md:339`, which did not move.
- **"`args` … dropped at *two* independent chokepoints"** undercounts by one; see
  §"Did these rows undercount", item 1.
- **"the 30s default capped at 120s (`hook-command.ts:410`)"** names the non-Pi
  fallback runner. The production Pi path has its own copy of both numbers in
  `SessionManager`.

## Propagation found — reported, not fixed

1. **`packages/shared/src/plugins/projection-types.ts` is a dead duplicate.** It
   redeclares `PluginHookProjectionRecord` and its five siblings with **zero
   importers repo-wide** (`rg projection-types` returns nothing), and its hook
   record is already stale — no `async`, `asyncRewake`, `exitCodeContract`,
   `once`, `ifRule`, `prompt`, `model`, `agentName`, `mcpTool`, `http`, and now
   no `args`. A reader who greps for the record type has a 50% chance of editing
   the wrong one; this unit's `args` row would have looked done and shipped
   nothing. Delete-or-finish.
2. **The `shell` hook field is read by nobody.** hooks.md `:369` defines
   `"bash" | "powershell"` per hook, "Ignored when `args` is set". Neither
   adapter parses it, so a hook that needs PowerShell on a Windows host without
   Git Bash has no way to say so. Same shape as the rows in this unit.
3. **Bare `Agent` and `Glob` permission rules match nothing.**
   `PI_RUNTIME_AGENT_TOOL_ALIASES` maps `agent → subagent` and `glob → find` for
   **agent tool lists**, not for permission rules, and `permission-dsl.ts`
   compares the rule's `semanticId` against the request's `semanticId`/`toolName`
   with no alias step. So `deny Agent` — the documented spelling since Claude
   renamed `Task` → `Agent` — is inert. It is now *warned* about, which is the
   honest answer, but the parity gap is the missing alias.
4. **`readStringArray` collapses `[]` to `undefined` for MCP and LSP `args`
   too** (`schema.ts:530`/`:828`, `claude.ts:572`, `codex.ts:857`). For hooks
   that was a correctness bug because presence selects the spawn form; for MCP
   and LSP an empty vector and no vector spawn identically, so it is only latent.
   Named here so the next reader does not have to re-derive that difference.
5. **`clampPromptHookTimeoutMs` keeps a 60s ceiling** that hooks.md does not
   state for `prompt` hooks (it states a 60s *default* for `agent`). It now sits
   under the documented 30s default rather than over it, so it only binds a hook
   that declares more than 60s.

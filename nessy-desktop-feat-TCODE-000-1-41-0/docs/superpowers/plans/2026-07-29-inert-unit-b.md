# Inert unit U-B — the hook matcher contract

Closes the two rows in `2026-07-29-inert-worklist.md` §5 U-B. Both commits are on
`fix/renderer`.

| Row | Commit |
| --- | --- |
| 1 — nine documented matcher-bearing events resolve to `''` | `9a7dbf3e` |
| 2 — the `Notification` matcher reads the wrong field | `34bcb745` |

## The contract, re-derived from the page

`curl -sL https://code.claude.com/docs/en/hooks.md` on 2026-07-29 returned **3169
lines**. Every claim below is quoted from that fetch; line numbers are given
after the quotation and are expected to rot.

hooks.md § Matcher patterns, `:220`: "Each event type matches on a different
field", followed by a table. `:242`: "The matcher runs against a field from the
JSON input that Claude Code sends to your hook on stdin."

| Event | Matcher field | Documented vocabulary | Nessy |
| --- | --- | --- | --- |
| `PermissionDenied` | `tool_name` | tool names — "Matches on tool name, same values as PreToolUse" | carried by both emitters |
| `Setup` | `trigger` | `init`, `maintenance` — "the CLI flag that triggered setup" | **no counterpart** |
| `SessionEnd` | `reason` | `clear`, `resume`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled`, `other` | 2 of 6 |
| `PreCompact` | `trigger` | `manual`, `auto` | exact, from Pi's reason |
| `PostCompact` | `trigger` | `manual`, `auto` — "The same matcher values apply as for `PreCompact`" | exact, from Pi's reason |
| `ConfigChange` | `source` | `user_settings`, `project_settings`, `local_settings`, `policy_settings`, `skills` | **no counterpart** |
| `StopFailure` | `error` | `rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `unknown` | 8 of 10 reachable |
| `UserPromptExpansion` | `command_name` | "your skill or command names" | **no counterpart** |
| `FileChanged` | the changed file's **basename** | literal filenames | exact |
| `Notification` | `notification_type` | `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_complete`, `elicitation_response`, `agent_needs_input`, `agent_completed` | 1 of 8 |

Two details the worklist's summary did not carry, both load-bearing:

- **`FileChanged` matches the basename, not the path.** `:2462` — "when a watched
  file changes, the same value filters which hook groups run using the standard
  matcher rules against the changed file's basename."
- **`FileChanged`'s matcher has a second, separate role.** `:2460` — "the value is
  split on `|` and each segment is registered as a literal filename in the
  working directory". That half is a watch-list builder Nessy has no equivalent
  for; see Propagation.

## Row 1 — `9a7dbf3e`

`getMatchValueForSdkInput` (`packages/shared/src/automations/utils.ts`) now
answers six of the nine with the documented field. `PermissionDenied` was the
worst sub-case and is closed: both emitters (`pi-agent.ts` auto-mode classifier
denial, `permission-service.ts` deny path) already carried `tool_name`, and the
event's `decision.retry` was fully wired.

`PreCompact`/`PostCompact` needed the emitter too. Pi's own types declare
`reason: "manual" | "threshold" | "overflow"`
(`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:437,:448`,
"manual /compact, the context threshold, or context overflow recovery"), which
projects exactly onto the documented two values — both non-manual reasons are
context-driven, so both are `auto`. The bridge previously **discarded** the
reason on `PreCompact` (hardcoded `source: 'compact'`) and carried the raw Pi
spelling on `PostCompact`.

`SessionEnd` needed a payload it never had. `endLifecycle` takes an optional
`SessionEndReason` defaulting to the documented catch-all `other`; the three
`clearHistory()` overrides pass `clear`. No call site is forced to change.

`StopFailure` matches on a projection of Nessy's own `ErrorCode` onto the
documented ten (`rate_limited` → `rate_limit`, `provider_error` /
`service_unavailable` → `overloaded`, the four credential codes →
`authentication_failed`, `invalid_model` → `model_not_found`, `service_error` →
`server_error`, …). A code with no documented counterpart passes through
unchanged rather than collapsing to `unknown`, so `mcp_unreachable` and friends
stay reachable under their own names.

`MATCHERLESS_AGENT_EVENTS` also grew from the two task events to the eight
documented matcher-less events Nessy owns. `:264` — those "don't support matchers
and always fire on every occurrence. If you add a `matcher` field to these
events, it is silently ignored." Compared against `''` they were doing the exact
opposite: never firing. `TeammateIdle` and `MessageDisplay` have no Nessy event.
`SubagentStop` is deliberately not in the set — it matches on agent type.

## Row 2 — `34bcb745`

`:1998` — "Notification hooks receive `message` with the notification text, an
optional `title`, and `notification_type` indicating which type fired", and
`:1940` — the event "Matches on notification type". The matcher read
`input.message`.

Nessy's only notification producer is `ask_user` (two sites, both
`emitNotificationHook('Response requested', askUser.question)`). It reaches the
human through the permission-request channel — the comment at the call site says
so — and opens the same blocking approval card, so it is `permission_prompt`.
The other seven documented types have no Nessy emitter; a matcher naming one now
correctly never fires. Relabelling `ask_user` to make them fire would fire the
wrong hook.

## The three decisions

**1. Is adding `notification_type` a frozen-contract change? Yes — four rows moved.**

`AGENT_EVENT_CONTRACTS_V1` rows were rewritten deliberately, not extended by
accident:

| Row | `redactedPayload` before | after |
| --- | --- | --- |
| `Notification` | `['title','message']` | `['notification_type','title','message']` |
| `PreCompact` | `['source']` | `['trigger','source']` |
| `PostCompact` | `['source']` | `['trigger','source']` |
| `SessionEnd` | `[]` | `['reason']` |

Each new row is right because the documented matcher field was **absent from the
payload entirely** — the rows described a shape in which the documented matcher
could not be evaluated. `source` is kept alongside `trigger` on the two compact
rows because it carries Pi's three-value reason, which is strictly more
information than the documented two and has an existing shape; `trigger` is its
documented projection, not a rename.

Checked before moving them: `redactedPayload` has **no consumer outside
`types.ts` itself** (`rg redactedPayload` → the interface declaration and the 29
rows). It is a documentation contract, so the cost of a wrong row is a wrong
description, not a wrong redaction. The rows are still the single generated
inventory and stayed `as const satisfies readonly AgentEventContractV1[]`.

**2. What an unmatched documented matcher does at registration: an existing
diagnostic channel, not a new one.**

Reused `hookDiagnostic` / `PluginDiagnostic` in
`buildTrustedPluginHookAutomations` — the same channel that already carries
`plugin.hooks.once_ignored`, `plugin.hooks.if_non_tool_event`,
`plugin.hooks.async_rewake_deferred` and
`plugin.hooks.worktree_path_channel_unavailable`. Two new codes, both leaving
the hook registered:

- `plugin.hooks.matcher_never_matches` (**warning**) — the matcher is on `Setup`,
  `ConfigChange` or `UserPromptExpansion`, so it can never fire. The message
  names the documented vocabulary and why Nessy has no counterpart, and says
  "Remove the matcher to run on every occurrence."
- `plugin.hooks.matcher_ignored_event` (**info**) — the matcher is on one of the
  eight documented matcher-less events, where the field is ignored by contract
  and the hook fires anyway.

A matcher of `*` or empty is never diagnosed: it means match-all, so it is not a
dead filter.

`managedPiPolicyDrops` was considered and rejected: it is the managed-policy
delivery drop record in `storage-runtime.ts`, a different subsystem with a
different owner, and it is separately recorded as unreported (worklist §3.4).
The `HookErrorNotice` channel from deviation unit 1 was also rejected: it is an
**execution**-time channel keyed to a hook that ran and failed, and this is a
registration-time fact about a hook that will never run.

**3. Three of the nine should not get a matcher.**

Each is `documented, not implemented — <reason>`, with the cost stated:

- **`Setup` — `documented, not implemented — Nessy has no `--init`/`--maintenance`
  launch mode.** hooks.md scopes the event to `claude --init-only`, `claude -p
  --init` and `claude -p --maintenance`; Nessy's `Setup` fires once per Pi
  runtime start with `source: 'pi-runtime'`. Matching on `source` would make the
  undocumented value `pi-runtime` the vocabulary and leave `init` inert anyway.
  *Cost:* a `Setup` hook must be catch-all. Closing it properly means the event
  semantics, not the matcher — see Propagation.
- **`ConfigChange` — `documented, not implemented — our ConfigChange reports
  runtime session-config keys, not the five settings-file sources.** Ours fires
  on `model` / `authType` / `providerType` / `runtime` / `thinkingLevel` commits.
  Matching on `config_keys` would invent a vocabulary the page does not define.
  *Cost:* a `ConfigChange` hook must be catch-all and read `config_keys` itself.
- **`UserPromptExpansion` — `documented, not implemented — no command name in the
  payload.** hooks.md's event fires when "a user-typed command expands into a
  prompt"; Nessy's fires once per turn at `before_agent_start` with
  `source: 'pi-before-agent-start'`. There is no expanded command to name.
  *Cost:* the documented use case (block `/deploy` without an approval file)
  is unreachable; it needs the event, not the matcher.

## What became reachable — differential

408 configurations enumerated: 29 agent events × 8 matcher probes (absent, `*`,
empty, the documented positive value, a different documented value, `.*`, `^$`,
plus a legacy free-text probe on `Notification`) × 2 matcher modes (`claude`,
native). Each side evaluated against **its own** emitted payload, since three
emitters changed. **58 outcomes moved: 44 newly fire, 14 newly go silent.**

**44 newly fire, in two classes.**

*14 are the matcher arms themselves* — and every one is a `hit:` row. Not one
`miss:` row moved, so a wrong value still does not match:

| Event | matcher | claude | native |
| --- | --- | --- | --- |
| `PermissionDenied` | `Bash` | ✓ | ✓ |
| `Notification` | `permission_prompt` | ✓ | ✓ |
| `StopFailure` | `rate_limit` | ✓ | ✓ |
| `FileChanged` | `a.txt` | ✓ | ✓ |
| `PreCompact` | `auto` | ✓ | ✓ |
| `PostCompact` | `auto` | ✓ | ✓ |
| `SessionEnd` | `clear` | ✓ | ✓ |

*30 are the six events added to `MATCHERLESS_AGENT_EVENTS`* —
`UserPromptSubmit`, `PostToolBatch`, `Stop`, `CwdChanged`, `WorktreeCreate`,
`WorktreeRemove`, each 5 rows (claude hit/miss, native `*`/hit/miss). This is
the real widening: a matcher-bearing hook on those six previously never fired
and now fires on **every** occurrence, which is what `:264` specifies.

**14 newly go silent, in two classes.**

*12 are `^$` on the six events that gained a match value* (both modes). A regex
that only matches the empty string fired because the match value **was** the
empty string. That is the bug's shadow, not a feature.

*2 are the one real config break:* a `Notification` matcher written against the
free-text message (probe `Continue depl.*`) no longer fires, in both modes.
That is precisely the defect row 2 names — "a native regex matcher
substring-hits unrelated notifications" — but anyone who wrote one loses it.
There is one native emitter and one message shape (`ask_user`'s question), so
the exposure is a matcher written against a user's own question text.

Script: `scratchpad/differential.ts` (not committed — it imports a
reimplementation of the deleted predicate).

## Gate evidence

Risk triggers per `AGENTS.md`: shared hook wire shape and a
permission-adjacent decision. Run once on the final diff, all from the repo
root.

```
bun run typecheck:all                     clean (core, shared, server-core, server,
                                          session-tools-core, pi-agent-server,
                                          electron, ui)
bun run lint                              0 errors, 122 warnings (118 electron,
                                          4 shared) — all pre-existing
```

Hook contract aggregate + permission/mode suites:

```
bun test packages/shared/src/automations packages/shared/src/plugins \
         packages/shared/src/agent/__tests__ \
         packages/pi-agent-server/src/extensions \
         packages/server-core/src/pi-harness
  2355 pass, 3 skip, 0 fail, 187 files, 23.05s
```

Full repository:

```
bun test
  9456 pass, 18 skip, 14 fail, 6 snapshots, 38094 expect(), 872 files, 296.35s
```

All 14 failures are the documented pre-existing set:

| Count | Failure |
| --- | --- |
| 7 | `ensureStorageLayoutV2` |
| 2 | `config path default-root classification > treats an empty override as the default root` |
| 1 | `managed paths with NESSY_CONFIG_DIR` |
| 2 | `SessionManager Pi child orchestration composition` background-authority |
| 1 | `Pi harness R0 baseline > executes golden foreground and background process contracts` |
| 1 | `bash tool-input timeout real server e2e > timeout: 3000 …` |

The last one is not on the pre-existing list by name but is the same
load-sensitive class as the listed `TaskCreated exit 2` case: it asserts a 3s
deadline in a real-server e2e and failed at 9925ms inside a 296s full-suite run.
In isolation:

```
bun test packages/pi-agent-server/src/tools/bash-timeout-input-real-server.test.ts
  2 pass, 0 fail
```

Fixtures moved rather than loosened: `lifecycle-bridge.test.ts` now pins
`trigger: 'auto'` alongside `source` on both compact events and drives
`session_before_compact` with a real reason; `pi-agent-lifecycle-hooks.test.ts`
pins `notification_type: 'permission_prompt'` in the `Notification` payload.

New tests: 16 table-driven matcher rows plus 4 cases in `conditions.test.ts`
(the three unmatched events, the eight matcher-less events, `SubagentStop` as
the deliberate non-member, and `enabled: false` still winning over a
matcher-less event), 1 registration-diagnostic case in
`plugins/__tests__/hooks-automation.test.ts`, 1 `NESSY_NOTIFICATION_TYPE` case in
`sdk-bridge.test.ts`, 1 four-case Pi-reason projection in
`lifecycle-bridge.test.ts`.

## Deviations recorded

| Item | Category |
| --- | --- |
| `PermissionDenied`, `PreCompact`, `PostCompact`, `SessionEnd`, `StopFailure`, `FileChanged`, `Notification` matchers | `documented, implemented` |
| The eight matcher-less events | `documented, implemented` |
| `Setup` matcher | `documented, not implemented — Nessy has no --init/--maintenance launch mode; the documented vocabulary has no counterpart` |
| `ConfigChange` matcher | `documented, not implemented — our ConfigChange reports runtime session-config keys, not the five settings-file sources` |
| `UserPromptExpansion` matcher | `documented, not implemented — our event fires once per turn at agent start and carries no expanded command name` |
| `SessionEnd` values `resume`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled` | `documented, not implemented — no Nessy teardown path produces them` |
| `StopFailure` values `oauth_org_not_allowed`, `max_output_tokens` | `documented, not implemented — no Nessy ErrorCode maps to either` |
| `Notification` types other than `permission_prompt` | `documented, not implemented — no Nessy emitter` |

## Propagation found — reported, not fixed

1. **`PermissionDenied` over-fires from the permission service.** hooks.md: "This
   hook only fires in auto mode: it doesn't run when you manually deny a
   permission dialog, when a `PreToolUse` hook blocks a call, or when a `deny`
   rule matches." `pi-agent.ts` respects that (`permissionDeniedEligible()` gates
   on the guardian classifier or a `dontAsk` would-prompt block), but
   `packages/server-core/src/pi-harness/permission-service.ts` emits on **every**
   `outcome === 'deny'`, including a human clicking deny on the dialog. Now that
   the matcher works, those extra firings are visible to hooks that could not see
   them before. **Highest-consequence item on this list.**
2. **Payload field names diverge from the documented ones**, so a hook script
   reading the documented key gets nothing even where the matcher now works:
   `FileChanged` carries `path` (doc: `file_path`) and `change_kind` set to the
   tool name (doc: `event` ∈ `change` | `add` | `unlink`); `StopFailure` carries
   `error_code` (doc: `error`); `Setup` carries `source` (doc: `trigger`).
3. **`PermissionDenied`'s denial reason has two spellings across its own two
   emitters**: `pi-agent.ts` sets `error`, `permission-service.ts` sets `reason`.
   The documented field is `reason`.
4. **Documented payload fields with no emitter at all**: `PreCompact`'s
   `custom_instructions`, `PostCompact`'s `compact_summary`, `ConfigChange`'s
   `source` and `file_path`, `UserPromptExpansion`'s `expansion_type` /
   `command_name` / `command_args` / `command_source` / `prompt`, `StopFailure`'s
   `error_details` and `last_assistant_message`, `FileChanged`'s `watchPaths`
   output.
5. **Three events are semantically not Claude's event of the same name.** Nessy's
   `Setup` fires every session start (Claude's only under `--init-only` /
   `-p --init` / `-p --maintenance`); `UserPromptExpansion` fires once per turn
   (Claude's per slash-command or MCP-prompt expansion); `ConfigChange` reports
   runtime session config (Claude's watches settings files). These are the reason
   their matchers cannot be implemented, and each is its own unit.
6. **`FileChanged`'s matcher has an unimplemented second role.** hooks.md: the
   value "is split on `|` and each segment is registered as a literal filename in
   the working directory". Nessy's `FileChanged` is driven by file-mutating tool
   completion, not a disk watcher, so there is no watch list to build and no
   `watchPaths` output to honour.
7. **The matcher-syntax carve-out for two events is not implemented.** hooks.md:
   "`FileChanged` and `StopFailure` use a narrower exact-match set of letters,
   digits, `_`, and `|` only. A hyphen, space, or comma in a matcher for those
   two events keeps it on the regular-expression path, and only `|` separates
   alternatives." `matchesClaudeMatcher` applies the wide set uniformly, so on
   those two events a hyphenated or comma-separated matcher is treated as an
   exact-match list where the page says it is a regex.

## Where the list or my own brief was wrong about the code

- **The list's `hooks.md:229`/`:1986` cite for `Notification`'s
  `notification_type`.** The claim is right and the field is right; on the
  3169-line fetch those sentences are at `:230` and `:1998`. The page moved, as
  the audit's own "line cites decay" rule predicts. Same for `hooks.md:223-243`
  (the matcher table is `:220-264`) and `hooks.md:262` (`:264`).
- **The brief's "nine documented matcher-bearing events" undercounts the defect.**
  Six *more* events — `UserPromptSubmit`, `PostToolBatch`, `Stop`, `CwdChanged`,
  `WorktreeCreate`, `WorktreeRemove` — were broken by the same `''` in the same
  predicate, in the opposite direction: documented to always fire, and never
  firing with a matcher set. That is 30 of the 44 newly-firing configurations.
  A fix scoped strictly to the nine named rows would have left it.
- **`ChatDisplay`/`PermissionRequest` are untouched here** — that was U-A.

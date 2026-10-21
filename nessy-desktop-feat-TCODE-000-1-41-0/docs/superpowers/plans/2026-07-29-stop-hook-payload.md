# R27c — the Stop and SubagentStop hook payloads

**Status:** CLOSED 2026-07-29 — see "Close-out" at the foot of this file
**Parity row:** R27 (found while closing R27b; the cron store it needs now exists)
**Branch:** `fix/renderer`
**Base:** current HEAD

## Contract source — quoted from raw markdown, with line cites

`curl -sL https://code.claude.com/docs/en/hooks.md` (3162 lines). **Fetch it
yourself and re-read every cite.** Six of my cites in the R27b plan were off by
one or two lines and the executor caught all six — check mine and report any that
are wrong.

`:2183`:

> In addition to the common input fields, Stop hooks receive `stop_hook_active`,
> `last_assistant_message`, `background_tasks`, and `session_crons`. The
> `stop_hook_active` field is `true` when Claude Code is already continuing as a
> result of a stop hook. Check this value or process the transcript to avoid
> blocking on a condition that will never resolve. Claude Code overrides the hook
> and ends the turn after 8 consecutive blocks.

`:2185` — why `last_assistant_message` exists at all, which is the part that
makes it non-optional:

> For hooks that act on the just-completed turn, such as read-aloud or
> notification hooks, use this field rather than reading `transcript_path`: the
> transcript file isn't guaranteed to include the final message at Stop time on
> all versions.

`:2187` — "Both arrays are present when the task registry is reachable and are
empty when nothing is in flight or scheduled." Present-and-empty, not absent.

`:2189`–`:2201` — each `background_tasks` entry: `id`, `type` (a friendly label —
`shell`, `subagent`, `monitor`, `workflow`, `teammate`, `cloud session`,
`MCP task`, "falls back to the raw discriminant for unrecognized types"),
`status`, `description` (capped at 1000 chars with an in-string `… [+N chars]`
marker when clipped), plus the conditional `command` (shell only), `agent_type`
(subagent only), `server` and `tool` (monitor and MCP task only), `name`
(workflow only).

`:2203`–`:2209` — each `session_crons` entry: `id`, `schedule`, `recurring`
(`false` for one-shot, `true` for re-firing), `prompt` (same 1000-char cap and
marker). Sourced from `CronCreate`, `ScheduleWakeup` **and** `/loop`.

`:2039` — `SubagentStop` receives both arrays too, and: "Both arrays are scoped
to the **parent** session, not the subagent."

## Verified state on HEAD

`pi-agent.ts:6401`:

```ts
void this.emitAutomationEvent('Stop', { hook_event_name: 'Stop' })
```

That is the whole payload. **All four documented fields are missing**, not the
two the R27b close-out reported — `stop_hook_active` and `last_assistant_message`
are absent as well.

The pieces exist and are unconnected, which is this series' recurring shape:

- `session-monitor-service.ts` already models the `background_tasks` side and
  nothing consumes it.
- The cron store landed in R27b (`06ee02e0`) and persists exactly `id`,
  `schedule`, `recurring`, `prompt` — the four documented fields, no mapping
  needed.
- `stopHookEmittedForTurn` already tracks per-turn emission, which is adjacent to
  but NOT the same as `stop_hook_active` — read `:2183` carefully before reusing
  it. One is "have we emitted this turn", the other is "are we currently
  continuing *because* a stop hook told us to".

## Tasks

### Task 1 — the two arrays

Widen the Stop payload with `background_tasks` and `session_crons`, mapped from
the registry and the cron store. `:2187`'s "present when the registry is
reachable and empty when nothing is in flight" means an empty array, never an
absent key — a hook distinguishing "done" from "paused waiting on background
work" reads a missing key as neither.

Implement the 1000-character cap with the documented in-string marker
`… [+N chars]` for `description` and `prompt`. The marker text is part of the
contract; a plain truncation is a different string.

`type` is a friendly label, not our internal discriminant — map ours onto the
documented vocabulary and fall back to the raw discriminant for anything
unrecognised, exactly as `:2193` says.

**Commit:** `feat(hooks): carry background tasks and session crons into Stop`

### Task 2 — `last_assistant_message` and `stop_hook_active`

`last_assistant_message` is the text of the final response. `:2185` gives the
reason it must not be derived from the transcript: the transcript is not
guaranteed to contain the final message at Stop time. Take it from the turn we
just finished, not by re-reading a file.

`stop_hook_active` is `true` when we are continuing **because a stop hook said
to**. We already feed a blocking Stop hook's reason into the next turn
(`recordHookBlockFeedback`), so the state exists — find it rather than inventing
a second flag, and say in the commit body which one you used and why it is the
right one. If the 8-consecutive-block override at `:2183` is also missing, say so
and cost it; do not silently implement a different cap.

**Commit:** `feat(hooks): give Stop the assistant message and the active flag`

### Task 3 — `SubagentStop`, scoped to the parent

`:2039` — the same two arrays, **scoped to the parent session, not the
subagent**. Getting that backwards would report a child's empty registry as the
session's state, which is worse than omitting the field.

**Commit:** `feat(hooks): carry the parent's task and cron arrays into SubagentStop`

### Task 4 — close-out

Per-task shas, real gate numbers, which existing flag you used for
`stop_hook_active`, the disposition of the 8-block override, and any of my line
cites that were wrong.

**Commit:** `docs(plans): close R27c with gate evidence`

## The deviation rule applies

Read it at the top of
`docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md`. The 2026-07-29
audit found **zero** of 159 recorded deviations qualified for the impossibility
exception, and every one of the 24 challenged fell. So if you reach for "we
can't", expect it to be tested: produce a measurement or an SDK-type citation,
take the nearest existing equivalent rather than a shape of your own, and record
the result with one of the rule's three category strings verbatim.

## Tests that must exist

- Both arrays present and **empty** when nothing is in flight or scheduled — the
  `:2187` property, which a "only include when non-empty" implementation fails.
- A `description`/`prompt` over 1000 characters carries the exact `… [+N chars]`
  marker, with N correct.
- An unrecognised task discriminant falls back to the raw value rather than being
  dropped or mislabelled.
- `SubagentStop` reports the PARENT's arrays — a fixture where parent and child
  registries differ, asserting the parent's content.
- A one-shot cron reports `recurring: false` and a recurring one `true`.

## Gate

Affected packages during the loop: the hook/automation suites, `pi-agent`,
`session-tools-core`, plus `typecheck:all`, `lint`, `git diff --check`. **This is
a shared hook wire shape — a listed immediate risk trigger** — so run the hook
contract aggregate once on the final diff. Hook payload fixtures will move;
update the pin, never loosen the assertion.

Tests from the REPO ROOT. A suite run from a package directory bypasses the
config-dir isolation preload and will destroy the real
`~/.nessy-agent/config.json`; a guard fails the run, do not work around it.

## Execution constraints

One commit per task with the subjects above; no `Co-Authored-By`; no push, MR or
tag; never `reset`/`rebase`/`amend`; pathspec-limited commits; no version bump or
release notes. Never `git checkout --` or `git stash` a file you are editing.
Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`;
leave `~/.nessy-agent/skills/r17-*` and `~/.nessy-agent/mcp/elicit-server.mjs`
alone. You may edit this plan file.

Another agent is concurrently working in `scripts/build-server.ts` and the server
package — stay out of those.

Report any propagation of these gaps on other paths — do not fix it.

---

## Close-out (2026-07-29)

All four documented fields now ride `Stop`, and both arrays ride `SubagentStop`
scoped to the parent.

| Task | Commit | Subject |
| --- | --- | --- |
| 1 | `4bc0908a` | `feat(hooks): carry background tasks and session crons into Stop` |
| 2 | `9077bd21` | `feat(hooks): give Stop the assistant message and the active flag` |
| 3 | `5287fd49` | `feat(hooks): carry the parent's task and cron arrays into SubagentStop` |
| 4 | this commit | `docs(plans): close R27c with gate evidence` |

Base was `5b511846`. Three other agents landed commits between these; none
touched the same files.

### This plan's line cites were uniformly 7 lines low

`curl -sL https://code.claude.com/docs/en/hooks.md` now returns **3169** lines,
not the 3162 the plan recorded. Every cite in the plan is exactly 7 low, and the
quoted prose is verbatim correct in each case — the page gained 7 lines above
line 2020 since the plan was written, so this is staleness rather than
misreading. The corrected cites, used throughout the three commits:

| Plan | Actual | Content |
| --- | --- | --- |
| `:2183` | `:2190` | the four fields, `stop_hook_active`, the 8-block override |
| `:2185` | `:2192` | why `last_assistant_message` beats `transcript_path` |
| `:2187` | `:2194` | "present … and are empty when nothing is in flight" |
| `:2189`–`:2201` | `:2196`–`:2208` | the `background_tasks` entry table |
| `:2193` | `:2201` | "Falls back to the raw discriminant" |
| `:2203`–`:2209` | `:2210`–`:2217` | the `session_crons` entry table |
| `:2039` | `:2046` | SubagentStop's two arrays, parent-scoped |

One cite is off by more than the uniform shift: the plan's "Verified state on
HEAD" gives `pi-agent.ts:6401` for the bare `emitAutomationEvent('Stop', …)`.
On `5b511846` that line is **6439**. The quoted code was exact.

Two contract facts the plan did not carry, both used:

- `:2204` — `command` is *also* capped at 1000 characters.
- `:2267` — `hookSpecificOutput.additionalContext` "keeps the conversation going
  through the same loop protections as `decision: block`, namely the
  `stop_hook_active` input and the 8-consecutive-continuation cap". See the
  propagation list.

### `stop_hook_active` uses the existing block streak

`BaseAgent.hookBlockStreaks.get('Stop')`, read through a new
`isContinuingFromHookBlock()`. Not `stopHookEmittedForTurn`, which the R27b
close-out proposed: that means "have we emitted Stop this turn" and is true on
every turn, so it would report `true` unconditionally. The streak is the counter
`MAX_CONSECUTIVE_HOOK_BLOCKS` reads, which is what `:2190` requires — the field
and the cap are one sentence, so a flag sourced elsewhere could read `false`
while the cap was counting down.

### The 8-consecutive-block override already existed — nothing to cost

`MAX_CONSECUTIVE_HOOK_BLOCKS = 8` (`base-agent.ts:121`) with the streak check at
`:531`, pinned by `hook-block-decisions.test.ts:173` (blocks 1–8 delivered, 9th
suppressed, non-blocking result resets). Since a Stop block never re-runs the
turn here, "ends the turn" has no analogue and "stop re-injecting" is the
nearest equivalent, recorded as such in the code since R9. No different cap was
substituted.

### Deviations recorded

`documented, implemented`
: `background_tasks` and `session_crons` on `Stop` and on `SubagentStop`;
  present-and-empty; the `… [+N chars]` cap on `description` and `prompt`; the
  `type` friendly vocabulary with raw-discriminant fallback; `recurring` in both
  directions; parent scoping on `SubagentStop`; `stop_hook_active`;
  `last_assistant_message`; the 8-consecutive-block override.

`documented, not implemented — no host structure holds the value`
: `background_tasks[].command` (`:2204`). `ProcessStore.StoredProcess`
  (`process-store.ts:10-33`) persists handle/semanticId/profile/cwd and never
  the command line, and `backgroundShellCommands` maps shellId → shellId
  (`SessionManager.ts:16510`). Filling it is a process-store schema change.

`documented, not implemented — no host structure holds the value`
: `background_tasks[].name` (`:2208`). `piBackgroundTaskKinds` stores the kind
  and nothing beside it.

`documented, not implemented — outside R27c's four tasks`
: `SubagentStop.stop_hook_active`, `.last_assistant_message` and
  `.agent_transcript_path` (`:2044`). Task 3 scopes to the two arrays.

### Propagation found, not fixed

1. **`codex-agent.ts:578` and `nestor-cloud-agent.ts:284` still emit
   `{ hook_event_name: 'Stop' }` and nothing else.** All four documented fields
   are missing on both, exactly the gap R27c just closed on Pi. The `Stop`
   payload is now built from one shared helper, so both are a small change.
2. **`additionalContext` escapes the loop protections (`:2267`).**
   `recordHookBlockFeedback` counts only `decision: block|deny`, so a Stop hook
   that returns `hookSpecificOutput.additionalContext` never increments the
   streak: it reports `stop_hook_active: false` forever and never reaches the
   8-continuation cap. `:2267` is explicit that it rides the *same* two
   protections. This is the one propagation item that can produce an unbounded
   loop.
3. **`Stop` fires on user interrupt.** `:2180` — "Does not run if the stoppage
   occurred due to a user interrupt." `PiAgent.abort()` and `forceAbort()` both
   call `emitStopHookOnce()` unconditionally; the pre-existing test at
   `pi-agent-lifecycle-hooks.test.ts` drives it with `abort('user_stop')` and
   expects a `Stop`. Predates R27c.
4. **`StopFailure` matchers can never match.** `:2284` — the `error` field "is
   used for matcher filtering", with the vocabulary at `:2288`.
   `emitStopFailureHookOnce` sets `error_code`, not `error`, and
   `getMatchValueForSdkInput` has no `StopFailure` case at all, so it falls to
   `default: return ''`. `StopFailure` is also missing the optional
   `last_assistant_message` (`:2290`), which for this event carries the API
   error string rather than conversational output.

### Gate

Run from the repository root throughout.

| Check | Result |
| --- | --- |
| Hook contract aggregate (35 files) | **582 pass / 0 fail**, 1612 `expect()` calls |
| — new: `hook-task-registry.test.ts` | 12 pass, 16 expect() |
| — new: `hook-task-registry-projection.test.ts` | 15 pass, 24 expect() |
| — new: `subagent-stop-parent-scope.test.ts` | 2 pass, 14 expect() |
| — updated pin: `pi-agent-lifecycle-hooks.test.ts` | 20 pass, 58 expect() |
| `bun run typecheck:all` | clean, all 8 projects |
| `bun run lint` | 0 errors (118 + 4 pre-existing warnings) |
| `git diff --check` | clean |

The aggregate was run once on the final diff, per the shared-hook-wire-shape
risk trigger. The `Stop` payload fixture in
`pi-agent-lifecycle-hooks.test.ts` moved from `{hook_event_name}` to the full
shape — the pin was updated to the new exact object, never loosened, and the
empty-registry case asserts with `toEqual` so an "only include when non-empty"
implementation fails it.

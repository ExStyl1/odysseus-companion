# R27b — session-scoped scheduling

**Status:** ready for execution
**Parity row:** R27 (Ord 9), second slice. R27a closed.
**Branch:** `fix/renderer`
**Base:** current HEAD

## Contract source — quoted from raw markdown, with line cites

`curl -sL https://code.claude.com/docs/en/scheduled-tasks.md` (223 lines) and
`.../tools-reference.md` (465 lines). **Fetch both yourself and re-read every
cite.** Three of my cites in an earlier plan were off by a line or two and the
executor caught them; check mine and report any that are wrong. `WebFetch` is not
an acceptable substitute — it reconstructs "verbatim" text rather than returning
it, which is how this series once shipped three wrong field names.

**The tools** (`tools-reference.md:25`, `:46`; `scheduled-tasks.md:160`):

| Tool | Contract |
| --- | --- |
| `CronCreate` | "Schedule a new task. Accepts a 5-field cron expression, the prompt to run, and whether it recurs or fires once." Session-scoped, "restored on `--resume` or `--continue` if unexpired". |
| `CronList` | "List all scheduled tasks with their IDs, schedules, and prompts." |
| `CronDelete` | "Cancel a task by ID." |
| `ScheduleWakeup` | Reschedules the next iteration of a self-paced `/loop`, "between one minute and one hour out"; `stop: true` cancels the pending wakeup. "The pending wakeup appears in `session_crons` in Stop hook input." |

`scheduled-tasks.md:166` — "Each scheduled task has an 8-character ID you can
pass to `CronDelete`. A session can hold up to **50** scheduled tasks at once."

`:170` — "The scheduler checks **every second** for due tasks and enqueues them
at **low priority**. A scheduled prompt fires **between your turns, not while
Claude is mid-response**. If Claude is busy when a task comes due, the prompt
waits until the current turn ends." `:172` — "All times are interpreted in your
**local timezone**."

`:178`–`:182` — **jitter**, and it is deterministic, not random:

> Recurring tasks fire up to 30 minutes after the scheduled time (or up to half
> the interval, for tasks that run more often than hourly).

> One-shot tasks scheduled for the top or bottom of the hour fire up to 90
> seconds early.

> **The offset is derived from the task ID**, so the same task always gets the
> same offset.

`:187` — **seven-day expiry**: "Recurring tasks automatically expire 7 days after
creation. The task **fires one final time, then deletes itself.**"

`:191`–`:203` — the cron dialect. 5 fields, `minute hour day-of-month month
day-of-week`. Supported: `*`, single values, steps `*/15`, ranges `1-5`,
comma lists `1,15,30`. Day-of-week `0` or `7` for Sunday through `6` for
Saturday. **"Extended syntax like `L`, `W`, `?`, and name aliases such as `MON`
or `JAN` is not supported."** And the one that is easy to get backwards:

> When both day-of-month and day-of-week are constrained, a date matches if
> **either** field matches. This follows standard vixie-cron semantics.

`:208` — `CLAUDE_CODE_DISABLE_CRON=1` "disable[s] the scheduler entirely. The
cron tools and `/loop` become unavailable, and any already-scheduled tasks stop
firing."

`:212`–`:218` — the limits, each a real behaviour to implement:

- "Tasks only fire while Claude Code is running and **idle**."
- "**No catch-up for missed fires.** If a task's scheduled time passes while
  Claude is busy on a long-running request, it fires **once** when Claude becomes
  idle, not once per missed interval."
- "Starting a fresh conversation clears all session-scoped tasks. Resuming …
  restores tasks that have not expired: recurring tasks within seven days of
  creation, and one-shot tasks whose scheduled time has not yet passed."
- "Claude Code stores the scheduled task list in the project's `.claude`
  directory, and scheduling a task **fails with an error when that directory, or
  the task file inside it, is a symlink.**"

## The question this plan does not prejudge

**Does this ride our existing Automations scheduler, or stay separate?**

We ship Automations — user-authored, durable, app-level, with `Scheduled`,
`Event-based` and `Agentic` kinds in the sidebar. These cron tasks are
model-invocable, session-scoped, capped at 50, and self-delete after seven days.
They are not the same thing, and merging them by reflex would be wrong.

Investigate before you build, and put the answer in the Task 1 commit body:
which parts of the Automations scheduler are reusable (the timing wheel, the
persistence, the "fires between turns" gate), and which would import a lifetime
or an ownership model that contradicts the contract above. Reuse the mechanism if
it fits; do not reuse the *concept* if it does not.

## The deviation rule applies

Read the rule at the top of
`docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md`. Claude's docs
are the contract. Where the Pi SDK genuinely cannot express something, take the
nearest Pi-ecosystem equivalent, **demonstrate the impossibility with a
measurement or an SDK-type citation rather than asserting it**, and record it as
`documented, impossible on Pi — <equivalent shipped>`. Anything else moves toward
the documented behaviour.

`ScheduleWakeup` is where this will bite: it presupposes `/loop`, which we do not
have. Do not invent a loop mechanism to hang it on. Either implement the tool
against a real `/loop` if you find one is cheap and in scope, or record it as
`documented, not implemented — requires /loop, which is not in this slice`, and
say what `/loop` would cost. Do not ship a wakeup tool with nothing to wake.

## Tasks

### Task 1 — the cron expression parser and the schedule store

The dialect exactly as `:191`–`:203` describes, including the vixie-cron
DOM/DOW **or**-semantics and the explicit refusal of `L`, `W`, `?` and name
aliases — an unsupported token is an error, not a silent no-match.

The store is session-scoped, capped at 50, with 8-character ids. Symlinked
directory or task file is a **hard error** (`:218`), not a fall-through — this is
the same class as R20's task store, so look at how that one was built before
starting a second design.

**Commit:** `feat(scheduling): a session-scoped cron store with the documented dialect`

### Task 2 — the scheduler: jitter, expiry, no catch-up

Deterministic jitter derived from the task id (`:182`) — same task, same offset,
every time. Recurring: up to +30 min, or up to half the interval when the
interval is shorter than an hour. One-shot on the hour or half hour: up to 90 s
**early**. Test the derivation is stable across processes, not just within one.

Seven-day expiry that **fires one final time and then deletes itself** — the
final fire is part of the contract, not an off-by-one.

No catch-up: a task whose time passed during a long turn fires **once** on idle,
not once per missed interval. Fires between turns, never mid-response.

**Commit:** `feat(scheduling): deterministic jitter, seven-day expiry, no catch-up`

### Task 3 — the three tools, and the disable flag

`CronCreate`/`CronList`/`CronDelete` as session tools. Follow R27a's precedent
for projection and permission posture, and say which you chose and why —
scheduling a prompt is not a read-only act.

The disable flag turns off the scheduler, the tools **and** `/loop` together
(`:208`), and already-scheduled tasks stop firing. Use our env-var naming with
the Claude spelling as a compat alias, following the `claudeCompatPluginEnv`
precedent R17 used.

Restore-on-resume: recurring within seven days of creation, one-shot only when
its time has not passed. A fresh conversation clears everything.

**Commit:** `feat(scheduling): CronCreate, CronList and CronDelete session tools`

### Task 4 — `ScheduleWakeup`, or the recorded reason it waits

See "The deviation rule applies" above. If it ships, `stop: true` cancels and the
pending wakeup appears in the Stop hook input as `session_crons`. If it does not,
this task is a documented non-implementation with a costed follow-up, committed
as docs.

**Commit:** `feat(scheduling): ScheduleWakeup for a self-paced loop`

#### Disposition (executor, 2026-07-29)

**`documented, not implemented — requires /loop, which is not in this slice`.**

This is NOT the Pi-impossibility category. Nothing about the Pi SDK prevents
`ScheduleWakeup`; the tool has no host it can serve. `tools-reference.md:46`
defines it as "Reschedules the next iteration of a [self-paced `/loop`] … Claude
calls this at the end of each iteration to pick when the next one runs, between
one minute and one hour out; **you don't call it directly**." A tool the model is
documented never to call on its own, whose entire job is to re-arm an iteration
of a loop that does not exist, would be a no-op with a schema. Shipping it is the
worst of the three options the plan names.

**Evidence `/loop` is absent.** `rg --fixed-strings '/loop'` over `packages/` and
`apps/` returns four hits, all substrings (`loopback`, `nested/loop`,
`cache/loop keys`, `loop-guard`). There is no bundled-command or bundled-skill
mechanism to hang it on either: `handleSlashCommand` dispatches user-, project-
and plugin-authored commands, and `packages/shared/src/skills/` has no built-in
tier. `scheduled-tasks.md:35` calls `/loop` a "bundled skill", so the mechanism
is a prerequisite, not a detail.

**What is already paid for by R27b.** The fixed-interval half of `/loop`
(`:52`–`:60`) is now nearly free: convert an interval to a cron expression and
call `CronCreate`. The store, the once-a-second check, the between-turns gate,
the seven-day expiry and the `:216` restore sweep are all built and tested.

**Costed estimate for the `/loop` unit — four tasks.**

1. **A bundled-command tier** — the missing prerequisite. `:35` and `:43`
   together require a command that ships with the app, is model-invocable, and
   participates in the invocability gate `:43` describes ("a scheduled fire only
   runs skills that Claude is allowed to invoke on its own"; built-in commands,
   `disable-model-invocation: true` skills, `skillOverrides`-withheld skills and
   MCP prompts "reach Claude as plain text instead"). That gate is a delivery-path
   change in the scheduler as well as a registry change. Largest of the four, and
   the only one with blast radius outside scheduling.
2. **Fixed-interval `/loop`** — interval grammar (`:58`: leading `30m` or
   trailing `every 2 hours`; units `s`/`m`/`h`/`d`), seconds rounded up to a
   minute and non-cron-expressible intervals such as `7m`/`90m` rounded with the
   model told what it picked (`:60`), then `CronCreate`. Small, given Task 1.
3. **`loop.md`** — `:102`–`:120`: project file first (`<project>/.nessy-agent/loop.md`,
   our `.claude/loop.md`), then user (`<configDir>/loop.md`), re-read every
   iteration, truncated past 25 000 bytes; plus the built-in maintenance prompt
   (`:82`–`:88`) when neither a prompt nor a `loop.md` exists. Small, self-contained.
4. **The self-paced loop and `ScheduleWakeup` itself** — the tool with its
   `delay`/`stop` inputs; `stop: true` cancelling the pending wakeup (`:130`);
   the ~20-minute fallback wakeup when an iteration neither reschedules nor stops
   (`:130`); `Esc` clearing the pending wakeup while leaving directly-scheduled
   tasks alone (`:128`), which is an IPC and renderer path; and the scheduler
   change `:74` requires — a dynamic loop appears in the task list and is subject
   to the seven-day expiry but **the jitter rules do not apply to it**, so a
   per-task no-jitter flag has to reach `cronJitterOffsetMs`.

**Two prerequisites that are gaps in their own right, reported not fixed.**

- **`session_crons` is not in our Stop hook input.** `tools-reference.md:46` ends
  "The pending wakeup appears in `session_crons` in Stop hook input", and
  `hooks.md:2203`–`:2210` gives the entry four fields — `id`, `schedule`,
  `recurring`, `prompt` (the last capped at 1000 characters with the same
  `… [+N chars]` marker `background_tasks` uses). `pi-agent.ts:emitStopHookOnce`
  emits `{ hook_event_name: 'Stop' }` and nothing else, so neither `session_crons`
  nor `background_tasks` reaches a Stop hook today. R27b's store already persists
  exactly those four field names for this reason, so the projection is a field
  selection whenever the payload is widened.
- **`background_tasks` has the same gap.** `hooks.md:2187` — both arrays "are
  present when the task registry is reachable and are empty when nothing is in
  flight or scheduled". `session-monitor-service.ts` already defines
  `BackgroundTaskEntryV1` and caps descriptions to the documented shape, and
  nothing consumes it at Stop. Widening the payload once would close both.

### Task 5 — close-out

Per-task shas, real gate numbers, the Automations answer from Task 1, the
`ScheduleWakeup` disposition, and any of my line cites that were wrong.

**Commit:** `docs(plans): close R27b with gate evidence`

## Close-out (executor, 2026-07-29)

**Status: closed.** Base `f0976cea`, branch `fix/renderer`. A second agent was
committing to the same branch throughout, so the unit's commits are not
contiguous.

| Task | Sha | Subject |
| --- | --- | --- |
| 1 | `06ee02e0` | `feat(scheduling): a session-scoped cron store with the documented dialect` |
| 2 | `50e93f69` | `feat(scheduling): deterministic jitter, seven-day expiry, no catch-up` |
| 3 | `71f9e8ed` | `feat(scheduling): CronCreate, CronList and CronDelete session tools` |
| 4 | `d8aa3b17` | `docs(scheduling): ScheduleWakeup for a self-paced loop` |

Task 4's subject uses `docs(` where the plan wrote `feat(`. It ships no feature —
the plan's own Task 4 says the non-implementation case is "committed as docs" —
and a `feat` subject would have been a false changelog entry. Only the type
changed; the rest of the subject is verbatim.

### Line cites in this plan that were wrong

Six, all in the `scheduled-tasks.md` block, all verified against a fresh
`curl -sL https://code.claude.com/docs/en/scheduled-tasks.md` (223 lines, which
matches). `tools-reference.md:25` and `:46` are both correct.

| Plan says | Actually | Content |
| --- | --- | --- |
| `:166` | **`:168`** | the 8-character ID and the 50-task cap (`:166` is the `CronDelete` table row) |
| `:170` | **`:172`** | "checks every second … fires between your turns" (`:170` is the `## How scheduled tasks run` heading) |
| `:172` | **`:174`** | "All times are interpreted in your local timezone" |
| `:182` | **`:183`** | "The offset is derived from the task ID" (`:182` is blank; the jitter range should read `:178`–`:183`) |
| `:191`–`:203` | needs **`:204`** | the vixie-cron either-field rule the plan then quotes sits at `:204`, one line outside the cited range |
| `:218` | **`:217`** | the symlink refusal (`:218` is blank) |

Correct as written: `:178` (jitter lead-in), `:187` (seven-day expiry), `:191`
(dialect lead-in), `:202` (extended syntax), `:208` (the disable flag), `:212`
(limits lead-in), and the `:214`–`:217` bullets inside the `:212`–`:218` range.
All code comments in this unit cite the corrected numbers.

Three contract facts the plan did not carry, taken from the same fetch:
`:180`'s own example ("An hourly job scheduled for `:00` may fire anywhere up to
`:30`") is what puts an exactly-hourly job on the 30-minute ceiling rather than
on half its interval; `:183` makes "pick a minute that is not `:00` or `:30`" a
documented way to opt out of one-shot jitter, so zero offset is a real branch;
and `tools-reference.md:25`–`:27` mark all three tools "Permission required:
No", which the plan's "scheduling a prompt is not a read-only act" hint reads
against until the two axes are separated (see Task 3's commit body).

### Does this ride the existing Automations scheduler?

**Reuse the delivery gate. Do not reuse the scheduler or the persistence.**

Reused: the R3 between-turns gate
(`SessionManager.deliverMonitorEvent`/`flushPendingTaskNotifications`), which
already implements `:172` exactly — idle starts a turn, busy groups into one
delivery, before the first user prompt holds as first-turn context. The
scheduler produces into it through a two-method seam. Also reused, as an oracle
rather than as code: croner, the library Automations' `matchesCron` uses.

Not reused, with the measurement: `SchedulerService` aligns to the minute
boundary and ticks at 60 000 ms, while `:172` needs a per-second check and
`:181` needs a one-shot to fire up to 90 seconds early; it also emits per
workspace, not per session. `automations.json` is workspace-scoped, durable and
user-authored with no cap and no lifetime, against `:11`/`:216` (session-scoped,
cleared by a fresh conversation), `:168` (50) and `:187` (seven-day
self-delete). Merging them would have given user-authored Automations a
seven-day expiry, or given model-scheduled prompts app-level permanence.

And croner as a parser was rejected on a measurement, not a preference: it
ACCEPTS all six tokens `:202` requires us to refuse (`L`, `1W`, `?`, `MON`,
`JAN`, `1#2` all construct and return a `nextRun`), so a validating parser had
to exist regardless. It does already implement the `:204` OR reading, which
`cron-dialect-oracle.test.ts` pins as an independent check on ours.

### Deviations, in the audit rule's category strings

- `ScheduleWakeup` — `documented, not implemented — requires /loop, which is not
  in this slice`. Costed at four tasks above. Not the Pi category: nothing in
  the SDK prevents it, it simply has no host to serve.
- `CronCreate`, `CronList`, `CronDelete`, the dialect, the jitter, the seven-day
  expiry, the no-catch-up rule, the resume sweep and the disable flag — all
  `documented, implemented`.

No `documented, impossible on Pi` deviation was needed anywhere in this unit.

### Gate

Whole repository from the repo root: **9217 pass / 18 skip / 11 fail across 9246
tests in 852 files**. All 11 proven pre-existing on a clean detached worktree at
the base commit `f0976cea`:

- 10 in `shared` — the `ensureStorageLayoutV2` (7), `config path default-root
  classification` (2) and `managed paths with NESSY_CONFIG_DIR` (1) cases that
  assert on an unset `NESSY_CONFIG_DIR` the isolation preload necessarily sets.
  Clean worktree: 493 pass / 10 fail, same ten names.
- 1 in `pi-agent-server` — `Pi harness R0 baseline > executes golden foreground
  and background process contracts`, `isolationProfile` `workspace` vs
  `networked`. Clean worktree: 22 pass / 1 fail, identical diff.

Per package on the final diff: `session-tools-core` 259/0, `server-core` 928/0,
`pi-agent-server` 468/1, `shared` 5796/10. `typecheck:all` clean, `lint` 0
errors (118 + 4 pre-existing unused-disable warnings), `git diff --check` clean.

One rotating flake was seen once among the real-subprocess Pi tests and did not
reproduce on the immediate re-run (468/1 both times, 469 tests).

### Fixtures moved

`harness-contract/fixtures/tool-surface.json`: three `sessionTools` rows and
three regenerated `schemaContracts` entries, purely additive (63 insertions, 0
deletions), with `schemaContracts` re-ordered so its keys still match the row
order the ledger asserts. `pi-harness-baseline.test.ts`: the session-tool count
50 → 53, three `expectedSemanticIds`, three entries in the pi-only set.
`SessionManager.execution-observability.test.ts`: `piCronServices` added to the
hand-built cleanup fixture, which failed first and was fixed by adding the
field. No assertion was loosened.

### Reported, not fixed

1. **`session_crons` and `background_tasks` are absent from our Stop hook
   input.** `pi-agent.ts:emitStopHookOnce` emits `{ hook_event_name: 'Stop' }`
   only. `tools-reference.md:46` and `hooks.md:2183`–`:2210` require both arrays,
   with `session_crons` entries carrying `id`/`schedule`/`recurring`/`prompt`.
   `session-monitor-service.ts` already models the `background_tasks` side and
   nothing consumes it. R27b's store persists exactly those four names, so one
   payload widening closes both halves.
2. **`SESSION_TOOLS_REQUIRING_HOST_CALLBACK` is inconsistent for `pi-only`
   tools, pre-existing.** `Monitor`, the worktree pair, `Goal`/`GoalGet` and
   `PushNotification` are members; `list_mcp_resources`/`read_mcp_resource` are
   not, despite the same host dependency. The cron tools were left out to match
   the MCP-resource precedent and because membership is redundant for a
   `pi-only` tool — the `visibility` check already excludes them from the
   external surface — but the set's own doc comment describes a rule neither
   group follows consistently.
3. **`NESSY_DISABLE_CRON` is not in `docs-site`.** Consistent with existing
   practice rather than a new gap: neither `NESSY_ENABLE_TASKS` nor
   `NESSY_DISABLE_BACKGROUND_TASKS` appears in
   `docs-site/content/reference/config/environment-variables.md` either.
4. **Nothing renders a cron result.** `CronCreate`/`CronList`/`CronDelete` land
   on `structuredContent` and no renderer component reads it, the same state
   R27a's tools shipped in. Contract and bounds, no UI implied.

## Tests that must exist

- The dialect: `*/5 * * * *`, `0 9 * * 1-5`, `30 14 15 3 *` parse; `L`, `W`,
  `?`, `MON`, `JAN` are refused with an error naming the unsupported token.
- **DOM+DOW both constrained matches on either** — the case most likely to be
  implemented as AND. One fixture, both readings asserted apart.
- Jitter is stable for a given id across two independent computations, and lands
  inside the documented bound for both the recurring and one-shot cases.
- A recurring task at day 7 fires once more, then is gone.
- A task due during a busy turn fires exactly once on idle, not N times.
- 51st task is refused; a symlinked store path is a hard error.
- The disable flag removes the tools from the surface, not just their effect.

## Gate

Affected packages during the loop: `session-tools-core`, the agent tool-surface
suites, the session/store suites, plus `typecheck:all`, `lint`,
`git diff --check`. Adding session tools moves the harness manifest and
tool-surface fixtures — **update the pin, never loosen the assertion**, and say
which moved.

Tests from the REPO ROOT. A suite run from a package directory bypasses the
config-dir isolation preload and will destroy the real
`~/.nessy-agent/config.json`; a guard fails the run, do not work around it.

## Live cases for the planner (do not run these yourself)

1. `CronCreate` with `*/2 * * * *` fires between turns, not mid-response.
2. `CronList` shows the 8-character id; `CronDelete` with it cancels.
3. A task due while a long turn runs fires once when the turn ends.
4. The disable flag removes the three tools from the session's tool surface.

## Execution constraints

One commit per task with the subjects above; no `Co-Authored-By`; no push, MR or
tag; never `reset`/`rebase`/`amend`; pathspec-limited commits; no version bump or
release notes. Never `git checkout --` or `git stash` a file you are editing.
Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`;
leave `~/.nessy-agent/skills/r17-*` and `~/.nessy-agent/mcp/elicit-server.mjs`
alone. You may edit this plan file.

Report any propagation of these gaps on other paths — do not fix it.

# T6 — scheduling and Monitor on the codex-gateway card (2026-08-23)

Live verification for `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`
row **T6**. Evidence only: no source changed, nothing was committed from this run.
The rig is T4's (`2026-08-22-t4-claude-scheduling.md`), pointed at the other card.

## The rig

| What | Value |
| --- | --- |
| Tree | `feat/TCODE-000` @ `eeacecaac` (T1 `985b5916c`, T3, T5 `a3e8c7a52`+`d819c5449`, P3.10 `f90804d38` all in) |
| Build | `bun run electron:build:servers` **exit 0** at 01:43 local — the debt T5 and P3.10 both recorded as OWED, paid here first — then `NESSY_CDP_PORT=9223 bun run electron:dev`, which rebuilt `apps/electron/dist/main.cjs` at 01:44 before launching |
| Bundle carries the code under test | the staged `apps/electron/resources/session-mcp-server/index.js` (7.87 MB, 01:43) holds `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK = new Set(["Monitor","CronCreate","CronList","CronDelete","ScheduleWakeup","ProcessStop"])` — six members, the sixth being P3.10's; `--host-callback-port` appears in that bundle AND in `main.cjs` (T5's host half), and `monitor/stop` in both |
| Card | `codex-gateway` (`providerType: codex-runtime`), model `tgpt/qwen35-397b-a17b-fp8`; every session created fresh and switched onto it (`kind: connection-cross-runtime`, `from: pi`, `to: codex-runtime`) |
| Auth | existing `~/.nessy/dp_auth_creds.json`; JWT `exp` 1850374380 = 2028-08-20, read once and never written. No auth failure occurred on any turn |
| Theme | dark (`ensureDarkTheme` → `already-dark`) |
| Driver | a scratchpad case script over the repo's own `scripts/cdp/lib/*` (connect / composer / state / runtime-switch / viewport). Not committed — case (e) writes the policy it measures, so this run is operator-driven rather than a wave case |

Timestamps below are **UTC**, as the transcript stores them (local = UTC+3).

Sessions, so the transcripts can be re-read in the app (all in workspace
`d98cc70e-5063-4f1f-bc67-a563590d65f7`): a `d44fa016…`, b `1d0bcd81…`,
c `9708df23…`, d `ab54be63…`, e `5d592629…`, e2 `2a331d7f…`, f `c5a3d71b…`.

**One standing piece of noise, named so it is not read as a finding.** On a codex
session each `mcp__session__*` tool raises the app's own one-time approval card
the first time it is called in that session:

```
Permission required
Tool: session
Allow the session MCP server to run tool "CronCreate"?
[Allow] [Deny]     This approval applies to this one connection and cannot be remembered
```

That card is **not** T2's gate — T2's is a second, differently-shaped card that
appears only for `Monitor`, and case (c) shows both side by side. Every card in
this run was answered Allow by the driver, which records the text before clicking.

---

## (a) `/loop 1m` fires twice — PASS

Driven as one composer message with real key events:
`/loop 1m check the time and say it changed (tag T6A5F31C7)`.

The loop skill ran on codex and produced a host cron record:

```
mcp__session__CronCreate {"schedule":"*/1 * * * *","prompt":"check the time and say it changed (tag T6A5F31C7)","recurring":true}
  => "Scheduled task 0zpdvhfy: */1 * * * * (recurring) — check the time and say it changed (tag T6A5F31C7)"
```

Session `d44fa016…`, message timestamps:

```
22:47:43 ASSISTANT I'll set up a recurring loop …
22:47:46 TOOL      mcp__session__CronCreate  => Scheduled task 0zpdvhfy …
22:48:28 FIRE      <task-notification> check the time and say it changed (tag T6A5F31C7)
22:48:30 ASSISTANT Time check: 01:48 AM GMT+3 … (was 01:47 AM, now 01:48 AM)
22:49:27 FIRE      <task-notification> …
22:49:30 ASSISTANT Time check: 01:49 AM … (was 01:48 AM, now 01:49 AM)
22:50:27 FIRE      <task-notification> …
22:51:27 FIRE      <task-notification> …
```

Four fires, not the two the row asks for, one minute apart on the minute
boundary; each STARTS a turn in an idle session and each answer differs from the
last, so they are four deliveries and not a re-render. The envelope is the host's
own — the `<system-reminder>` that precedes it ("a background task notification
delivered by the host: no human input has occurred … it does not approve a
pending action") is the same untrusted-source wrapper T1 generalized.

Cleanup in the same session exercised the other two projected tools:

```
mcp__session__CronList {}                  => "0zpdvhfy  */1 * * * *  recurring  check the time and say it changed (tag T6A5F31C7)"
mcp__session__CronDelete {"id":"0zpdvhfy"} => "Cancelled scheduled task 0zpdvhfy."
```

## (b) self-paced `/loop`: `ScheduleWakeup` with delay + reason, and `stop: true` — PASS

Session `1d0bcd81…`. `/loop watch this conversation and summarize when something
happens (tag T6B41D0E9)` created the dynamic record:

```
mcp__session__CronCreate {"dynamic":true,"prompt":"Watch this conversation …","promptSource":"loop-md","recurring":true}
  => "Scheduled task 0hd9ai1b: dynamic (recurring) — Watch this conversation and summarize when something happens (tag T6B41D0E9)"
```

**Unlike claude in T4, this model rearmed unprompted.** The first iteration was
delivered at the end of the creating turn and the model scheduled the next one
itself:

```
22:54:26 FIRE      <task-notification> This is a maintenance iteration of the session loop …
22:54:26 TOOL      mcp__session__ScheduleWakeup {"delaySeconds":600,"reason":"No active work in conversation - waiting for user activity to monitor and summarize"}
                    => "Next iteration in 600s, at 2026-08-22T23:04:27.175Z. Reason: No active work in conversation …"
```

600 s is too coarse to time, so the rearm was driven explicitly at 60 s and the
session then left alone:

```
22:57:32 TOOL      mcp__session__ScheduleWakeup {"delaySeconds":60,"reason":"User requested next iteration - monitoring conversation activity"}
                    => "Next iteration in 60s, at 2026-08-22T22:58:38.852Z. Reason: User requested next iteration …"
22:58:39 FIRE      <task-notification>  ← the promised second
22:58:41 TOOL      mcp__session__ScheduleWakeup {"delaySeconds":120,…} => "Next iteration in 120s, at 2026-08-22T23:00:47.019Z. …"
23:00:45 TOOL      mcp__session__ScheduleWakeup {"stop":true} => "Self-paced loop ended — the pending wakeup is cancelled."
```

The stop landed **two seconds before** the 23:00:47.019 the host had promised
itself, and the session was then watched for 200 s across that instant: the
transcript stayed at 22 messages, start to finish. So on codex the self-paced
loop rearms, fires on time, and ends on `stop: true`.

The delivered iteration was the built-in maintenance prompt, not the model's own
text — the documented consequence of the model setting `promptSource: "loop-md"`
alongside a `prompt`, exactly as T4 recorded on claude.

## (c) FALSIFICATION — `Monitor` on `tail -f` starts and wakes the idle session — PASS

Session `9708df23…`, with `/tmp/t6-probe.log` created beforehand.

```
23:07:32 TOOL      mcp__session__Monitor {"command":"tail -f /tmp/t6-probe.log","description":"T6 probe watch"}
                    => "Started monitor
                        taskId: process_71ce582c64bb4e14832c04cc2881d522
                        timeoutMs: 300000
                        Events arrive as task notifications. Stop it with ProcessStop."
23:07:48 FIRE      <task-notification> t6 probe baseline 2026-08-22T23:05:27.3NZ
23:09:20 FIRE      <task-notification> T6C-WAKE-4471A2 appended at 2026-08-22T23:09:20.002571Z
23:09:22 ASSISTANT The Monitor watch detected a new entry in the log file: ``` T6C-WAKE-4471A2 … ```
```

`T6C-WAKE-4471A2` was appended **from a shell, after the session went idle**, and
arrived as a task-notification turn two seconds later. The wake is attributable
to the watch and to nothing on screen.

Two cards were raised on the starting turn, and their difference is what case (e)
asserts on:

```
1) Tool: session   Allow the session MCP server to run tool "Monitor"?   [Allow] [Deny]   ← the app's per-session MCP approval
2) Tool: Monitor   "Run this command as a Monitor watch: tail -f /tmp/t6-probe.log.
                    This approval covers this one watch and cannot be remembered."
                   tail -f /tmp/t6-probe.log                             [Allow] [Deny]   ← T2's host gate, no-rule path
```

Card 2 is T2's `permission_request` verbatim, reaching codex through T5's bridge.
Stopped afterwards from the same session:

```
23:10:58 TOOL      mcp__session__ProcessStop {"shell_id":"process_71ce582c…"} => "Stopped monitor\ntaskId: process_71ce582c…"
23:11:04 FIRE      <task-notification> Monitor process_71ce582c… exited with signal SIGTERM.
```

## (d) NEW since P3.10 — `ProcessStop` really ends a PERSISTENT watch — PASS

This is the case P3.10 shipped for and could not prove live, because the bundles
it ships in had not been restaged. Session `ab54be63…`.

```
23:14:11 TOOL      mcp__session__Monitor {"command":"tail -f /tmp/t6-probe.log","description":"T6 persistent probe","persistent":true}
                    => "Started monitor\ntaskId: process_903314c0f5da457384caec0dbf43a4a7\ntimeoutMs: 0\n…"
```

`timeoutMs: 0` is the persistent contract (`tool-defs.ts:867`) — no deadline, so
nothing but a stop can end it. A pre-stop append proves the watch is live rather
than merely registered:

```
23:16:03 (shell)   T6D-PRESTOP-8C21B4 appended at 2026-08-22T23:16:03.139258Z
23:16:0x FIRE      <task-notification> T6D-PRESTOP-8C21B4 …
```

Then the stop, and the falsification:

```
23:17:14 TOOL      mcp__session__ProcessStop {"shell_id":"process_903314c0f5da457384caec0dbf43a4a7"}
                    => "Stopped monitor\ntaskId: process_903314c0f5da457384caec0dbf43a4a7"
23:17:21 FIRE      <task-notification> Monitor process_903314c0… exited with signal SIGTERM.
23:18:43 (shell)   T6D-POSTSTOP-0-9F03E5 appended …
23:18:47 (shell)   T6D-POSTSTOP-1-9F03E5 appended …
23:18:51 (shell)   T6D-POSTSTOP-2-9F03E5 appended …
           watched 150 s → transcript count 18 → 18, no notification of any kind
```

Three post-stop appends produced zero wakes, and the OS process is gone as well —
`ps` filtered to `tail … t6-probe` returned 0 both immediately after the stop and
at the end of the run. The stop is a real teardown, not an unsubscribe.

## (e) a Bash deny rule refuses the same watch — PASS on enforcement, with a finding on honesty

Workspace layer written by hand (the operator's job, not the harness's):
`~/.nessy-agent/workspaces/d98cc70e…/permissions.json`

```json
{ "permissionDsl": { "version": 1, "rules": [
  { "id": "t6-no-tail", "action": "deny", "match": { "kind": "bash", "pattern": "tail:*" } } ] } }
```

Fresh session `5d592629…`, mode `default`, same prompt as (c):

```
23:22:07 TOOL      mcp__session__Monitor {"command":"tail -f /tmp/t6-probe.log","description":"T6 probe watch"}   (status: error)
                    => "[ERROR] Monitor command watch was denied by permission rule \"t6-no-tail\" (workspace)."
```

Reproduced in a second fresh session `2a331d7f…` at 23:31:49, byte-identical. No
watch started in either: `ps` filtered to `tail … t6-probe` was **0** after both.
Cards seen on those turns: only the `Tool: session` MCP approval — **no host-gate
card**, because a deny is terminal and is decided before any prompt. That is T2's
shape, now measured through T5's bridge.

**The finding.** The refusal is enforced but the model is not told. Asked to
report the outcome, the codex model answered — twice, in two independent sessions:

> *"The monitor command returned an empty result `{}`. … The `tail -f` command
> will continue running in the background."* (23:22:15)

> *"The `Monitor` MCP call **started a watch successfully** — it was **not
> refused**. The call returned an empty object `{}` with no error message or
> permission rule name."* (23:31:58)

Asked to paste the reply character for character it produced
`Wall time: 5.3182 seconds / Output: {}`. On claude (T4) the same rule produced
the opposite: the model relayed the rule name to the user. So the security half
holds on codex and the honesty half does not — a session can be told a watch is
running when the host refused to start one.

**This is not deny-specific, and the boundary was measured rather than assumed.**
A probe in the same session compared what the host recorded against what the
model reported:

| Tool | Host's recorded result | What the model reported |
| --- | --- | --- |
| `CronList` (empty) | `No scheduled tasks in this session.` | `{"tasks":[]}` |
| `ProcessStop` (bogus id) | `[ERROR] Unknown shell_id: process_doesnotexist_t6` | `{}` |
| `ProcessStop` (real stop) | `Stopped monitor\ntaskId: process_71ce…` | `{}` |
| `Monitor` (deny) | `[ERROR] … denied by permission rule "t6-no-tail" …` | `{}` |
| `CronCreate` | `Scheduled task 0zpdvhfy: */1 * * * * …` | id, schedule and prompt, all correct |
| `Monitor` (start) | `Started monitor\ntaskId: process_71ce…\ntimeoutMs: 300000` | taskId and timeoutMs, both correct |
| `ScheduleWakeup` | `Next iteration in 60s, at …` | delay and time, correct |
| `CronList` (non-empty) | the row verbatim | the row's four fields, correct |

Host-generated ids the model could not have invented arrive intact, so the
channel is not simply dead; but at least four measured replies — including one
refusal — reached the model as `{}` or as a confabulated JSON shape. Whether the
loss is in `structuredContent: {}` (`session-tools-core/src/response.ts:16,44`
sets it on every result and `response.ts:24-33` already records that `isError` is
invisible on this wire), in codex's MCP result rendering, or in the model, is not
settled by this run and is not T6's to settle. It is a candidate row.

## (f) CROSS-RUNTIME SURVIVAL — a `/loop 5m` created on Pi fires on codex — PASS

Session `c5a3d71b…`, **plain and non-worktree**, bound to a scratch project root
(`/private/tmp/t6-project`, an empty dir with one README; its trust gate answered
in the app, and the driver refuses to answer a gate naming any other path).

Created on the **Pi** card (`pi-api-key`):

```
23:37:51 TOOL      CronCreate {"schedule":"*/5 * * * *","prompt":"check the time and say it changed (tag T6F7B22D1)","recurring":true}
                    => "Scheduled task kp264ber: */5 * * * * (recurring) — check the time and say it changed (tag T6F7B22D1)"
```

On disk immediately after, `/private/tmp/t6-project/.nessy-agent/crons/c5a3d71b….json`:

```json
{ "schemaVersion": 1, "tasks": [ { "id": "kp264ber", "schedule": "*/5 * * * *",
  "recurring": true, "prompt": "check the time and say it changed (tag T6F7B22D1)",
  "createdAt": 1787441871997 } ] }
```

That path is T8's pre-check confirmed on the live app: the store anchored to
`managed.workingDirectory`, not to the workspace root (cases a–e, whose sessions
have no working directory, wrote to `~/.nessy-agent/workspaces/d98cc70e…/.nessy-agent/crons/`
instead). **No worktree was involved here, so the anchor does not move — which is
exactly why this variant is the one expected to work.**

The switch, and what followed:

```
23:40:05 SWITCH    switchRuntime → codex-gateway
                   => {"kind":"connection-cross-runtime","contextCarried":"handoff","from":"pi","to":"codex-runtime"}
23:40:07 (disk)    the record is still there, unchanged — same id, same createdAt
23:40:21 TOOL      mcp__session__CronList {} => "kp264ber  */5 * * * *  recurring  check the time and say it changed (tag T6F7B22D1)"
23:41:59 FIRE      <task-notification> check the time and say it changed (tag T6F7B22D1)
23:42:01 ASSISTANT Time Check ⏰ (tag T6F7B22D1) … The loop is working as scheduled
```

The record created by one runtime is listed and fired by the other. The fire
arrived at 23:41:59 rather than on a `*/5` boundary, which is T1's recorded D5
precision showing itself: the service re-arms **at the next agent build**, not at
switch completion, so the 23:40 boundary was caught up once the `CronList` turn
built the codex agent. T8's item (d) is the fix; nothing here contradicts it.

Asked which runtime was answering, the session said *"Codex CLI"* — a
self-report, not the detector; the detector is `activeConnection` reading
`codex-gateway` and the `connection-cross-runtime` result above.

---

## Verdicts

| Case | Verdict | One line |
| --- | --- | --- |
| (a) `/loop 1m` fires twice | **PASS** | `CronCreate */1 * * * *`; four fires 22:48:28 → 22:51:27, each a `<task-notification>` turn; `CronList`/`CronDelete` work |
| (b) self-paced `/loop` | **PASS** | `ScheduleWakeup {delaySeconds:60, reason:…}` fired at the promised second; `{stop:true}` ended it and 200 s across the pending due time added nothing. This model also rearmed unprompted, which claude's did not |
| (c) `Monitor` falsification | **PASS** | `mcp__session__Monitor` started (`taskId: process_71ce…`); an appended line woke the idle session; both cards observed, T2's verbatim |
| (d) persistent watch + `ProcessStop` | **PASS** | `timeoutMs: 0`; stop returned `Stopped monitor`, SIGTERM notification, three post-stop appends over 150 s produced zero wakes, OS process gone. P3.10 proven live |
| (e) deny rule | **PASS (enforcement)** + finding | `[ERROR] … denied by permission rule "t6-no-tail" (workspace).`, twice, no watch started, no host card — but the codex model was shown `{}` and reported the watch as running |
| (f) cross-runtime survival | **PASS** | `kp264ber` created on Pi, listed and fired on codex after the switch; plain project-root session, no worktree |

## State the run left behind

Checked rather than assumed:

- `~/.nessy-agent/workspaces/d98cc70e…/.nessy-agent/crons/*.json` — all five files
  (T4's three plus this run's a and b) read `tasks: []`. Cases c, d, e created no
  cron file at all, which is correct: they only ever armed monitors.
- The case (f) store lived inside the scratch project root and went with it —
  `/private/tmp/t6-project` removed, so `kp264ber` no longer exists anywhere. It
  was never deleted through the app: the dev app was killed by the runner's own
  background-task timeout at ~23:44, after all six cases were driven.
- `~/.nessy-agent/workspaces/d98cc70e…/permissions.json` deleted; it did not exist
  before this run and does not exist after it.
- `/tmp/t6-probe.log` removed; `ps` shows no `tail … t6-probe` process and no
  `codex-app-server`.
- `git status` is the two untracked `dp-auth*` peer files and nothing else; they
  were not touched.
- The seven `CDP T6-…` sessions are left in the sidebar, named, for re-reading.

## What this run leaves open

1. **A refusal that reaches the host but not the model** (case (e)). The gate
   holds; the session is told `{}` and concludes success. Same shape for three
   other measured replies. Candidate plan row — the table in (e) is the evidence,
   and `response.ts:24-33` is where the wire's own limitation is already written
   down.
2. **The codex model reaches for its native shell first.** In all three fresh
   sessions where the request named `Monitor` in prose, the first attempt was
   `Bash {"command":"/bin/zsh -lc 'tail -f /tmp/t6-probe.log'"}` and the model
   reported a PID as a "taskId"; naming `mcp__session__Monitor` explicitly got the
   right call every time. Cosmetic, but it spends a turn and leaves a real
   `tail -f` behind (each was killed during the run).
3. **The `tail:*` deny rule does not cover codex's own shell.** With `t6-no-tail`
   active, `/bin/zsh -lc 'tail -f /tmp/t6-probe.log'` raised only an ordinary
   shell card — *with* an `Always Allow` button — and ran. Most likely the rule
   matches on the command head and the head here is `/bin/zsh`, not `tail`; T4
   saw the same shape on Pi from the other direction. Worth an owner call on rule
   coverage, stated here as an observation rather than a diagnosis.
4. **`/loop` on Pi needed two turns.** `CronCreate` came back
   `Tool mcp__session__CronCreate not found`, the model loaded it with
   `mcp__tool_load`, then **claimed the loop was scheduled when nothing had been
   created**. A second, explicit turn created it. Pi-side deferred-tool wrinkle,
   outside T6's rows but on the same `/loop` path.
5. Not measured here: a second `*/5` boundary fire on codex (the app was killed
   first), the worktree variant of (f) — T8's known defect, deliberately not
   exercised — and anything on a packaged build; this was the dev app, as the row
   specifies.

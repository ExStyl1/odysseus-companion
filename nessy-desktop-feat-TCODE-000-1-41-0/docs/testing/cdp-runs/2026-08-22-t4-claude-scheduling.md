# T4 — scheduling and Monitor on the claude-gateway card (2026-08-22)

Live verification for `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`
row **T4**. Evidence only: no source changed, nothing was committed from this run.

## The rig

| What | Value |
| --- | --- |
| Tree | `feat/TCODE-000` @ `21cca654b` (T1 `985b5916c`, T2 `fae60f53c`+`81a6b624c`, T3 `904355447`+`441b4d504` all in) |
| Build | `bun run electron:build:servers` (exit 0, 19:17 local) **then** `NESSY_CDP_PORT=9223 bun run electron:dev`, which rebuilds `apps/electron/dist/main.cjs`, the session MCP server and the Pi agent server before launching |
| Bundle carries the code under test | `grep -c CLAUDE_CODE_DISABLE_CRON apps/electron/dist/main.cjs` → 3; the bundle's `CLAUDE_SESSION_DISALLOWED_TOOLS = Object.freeze([ "EnterPlanMode", "ExitPlanMode", "Skill", … "Monitor" ])` with T3's comment block intact |
| Card | `claude-gateway` (`providerType: claude-runtime`), model `tgpt/qwen35-397b-a17b-fp8`; every session created fresh and switched onto it (`kind: connection-cross-runtime`, `from: pi`, `to: anthropic`) |
| Auth | existing `~/.nessy/dp_auth_creds.json`; JWT `exp` 2028-08-20, never touched by this run |
| Theme | dark (`ensureDarkTheme` → `already-dark` on every case) |
| Driver | a scratchpad case script over the repo's own `scripts/cdp/lib/*` (connect / composer / state / runtime-switch / viewport). Not committed — the harness never writes the policy it measures, and cases (d)/(e) do exactly that, so this run is operator-driven rather than a wave case |
| Artifacts | `/tmp/nessy-cdp-artifacts/t4/` — `observations.jsonl` plus 26 screenshots (`case-a-fires.png`, `case-c-woken.png`, `case-d-denied.png`, `case-e-arm1..3.png`, `case-e-pi.png`, one `card-<ts>.png` per permission card). Ephemeral; the quoted lines below are the durable record |

Sessions, so the transcripts can be re-read in the app: a `cd701336…`, b `84524432…`,
b2 `446477fc…`, c `ba5a5eb2…`, d `1041b8bd…`, e `f9f54037…`, pi-control `07324cf4…`
(all in workspace `d98cc70e-5063-4f1f-bc67-a563590d65f7`).

**Two standing pieces of noise, named so they are not read as findings.** Every
assistant message ends with `OSTYLE-CDP-9241` — an output style this operator's
config still carries from an old AGT-4 fixture. And on a claude-runtime session
each `mcp__session__*` tool raises the SDK's own one-time approval card
(`Tool: mcp__session__CronCreate … Allow / Always Allow / Deny`) the first time
it is called in a session. That card is **not** T2's gate: it offers *Always
Allow*, T2's card does not (`noAlwaysAllow: true`). Both appear below and the
distinction is what case (d) asserts on.

---

## (a) `/loop 1m` fires twice — PASS

Driven, as one composer message with real key events:
`/loop 1m check the time and say it changed (tag T4ADAE66B)`.

The loop skill ran on claude and produced a host cron record:

```
mcp__session__CronCreate {"schedule":"* * * * *","prompt":"check the time and say it changed (tag T4ADAE66B)","recurring":true}
  => "Scheduled task nds3ry9a: * * * * * (recurring) — check the time and say it changed (tag T4ADAE66B)"
```

Session `cd701336…` timeline (message timestamps, UTC):

```
16:26:15 USER      /loop 1m check the time and say it changed (tag T4ADAE66B)
16:26:21 TOOL      mcp__session__CronCreate
16:26:30 ASSISTANT Scheduled a loop to run every minute. The task ID is `nds3ry9a` …
16:27:05 FIRE      <task-notification> check the time and say it changed (tag T4ADAE66B)
16:27:08 ASSISTANT The time is **19:27 GMT+3** on Saturday, August 22, 2026 …
16:28:05 FIRE      <task-notification> check the time and say it changed (tag T4ADAE66B)
16:28:09 ASSISTANT The time is **19:28 GMT+3** … The loop continues to run every minute.
```

Both fires arrive in the `<task-notification>` envelope the host writes
(`buildTaskNotificationDelivery`), one minute apart on the minute boundary, and
each STARTS a turn in an idle session — the delivery discipline T1 generalized.
The model's two answers differ (`19:27` → `19:28`), so the second fire is a
second delivery and not a re-render of the first.

Cleanup in the same session exercised the other two projected tools:

```
mcp__session__CronList {}        => "nds3ry9a  * * * * *  recurring  check the time and say it changed (tag T4ADAE66B)"
mcp__session__CronDelete {"id":"nds3ry9a"} => "Cancelled scheduled task nds3ry9a."
```

## (b) self-paced `/loop`: `ScheduleWakeup` with delay + reason, and `stop: true` — PASS, with one behaviour deviation recorded

Two arms, because the first one measured the MODEL and the row is about the PATH.

**Arm 1 (session `84524432…`) — unprompted.** `/loop watch this conversation and
summarize when something happens (tag T4BC0EA44)` created the dynamic record:

```
mcp__session__CronCreate {"dynamic":true,"prompt":"watch this conversation …","promptSource":"loop-md","recurring":true}
  => "Scheduled task ktw494nz: dynamic (recurring) — watch this conversation and summarize when something happens (tag T4BC0EA44)"
```

The first iteration was delivered as a task notification at the end of the
creating turn, exactly as the skill promises. The model then **summarised and
stopped without rescheduling**: no `ScheduleWakeup` in 420 s of polling. That is
a model-behaviour gap on this gateway model (`qwen35`), not a missing path —
arm 2 drives the same call and it works. Recorded, not scored against T3.

Worth quoting from the same turn, because it is positive evidence that the SDK's
own scheduler is suppressed while ours is offered: the model first tried the bare
name and got

```
CronCreate => <tool_use_error>Error: No such tool available: CronCreate.
CronCreate exists but is not enabled in this context. Use one of the available tools instead.</tool_use_error>
```

then retried as `mcp__session__CronCreate` and succeeded.

Asked to end the loop, arm 1 produced the `stop` half:

```
mcp__session__ScheduleWakeup {"stop":true} => "Self-paced loop ended — the pending wakeup is cancelled."
```

and 150 s later the notification count was unchanged (1 → 1).

**Arm 2 (session `446477fc…`) — the rearm path driven explicitly**, then left
alone to see whether the wakeup it scheduled actually fires:

```
16:43:51 TOOL      mcp__session__CronCreate  => "Scheduled task 1v5s833u: dynamic (recurring) — watch this conversation …"
16:43:59 FIRE      <task-notification> (first self-paced iteration, delivered at turn end)
16:44:11 TOOL      mcp__session__ScheduleWakeup {"delaySeconds":60,"reason":"Active conversation — user engaged, short wait appropriate for ongoing interaction"}
                    => "Next iteration in 60s, at 2026-08-22T16:45:17.191Z. Reason: Active conversation — user engaged, …"
16:45:17 FIRE      <task-notification>  ← the promised time, to the second
16:45:30 TOOL      mcp__session__ScheduleWakeup {"stop":true} => "Self-paced loop ended — the pending wakeup is cancelled."
```

Notifications went 1 → 2 across the scheduled delay and stayed at 2 for the 180 s
after the stop. So on claude the self-paced loop rearms, fires on time, and ends
on `stop: true`.

One host behaviour worth naming: the model passed BOTH a `prompt` and
`promptSource: "loop-md"`, and the delivered iteration was the built-in
maintenance prompt (`"This is a maintenance iteration of the ses…"`), not its own
text. That is the documented contract (`promptSource: "loop-md"` means the host
re-resolves the default prompt at every fire) applied to a model that set the
flag it should not have set. Product correct, model sloppy.

## (c) FALSIFICATION — `Monitor` on `tail -f` starts and wakes the idle session — PASS

This is the case T3's own comment names: bare `Monitor` sits in
`CLAUDE_SESSION_DISALLOWED_TOOLS`, and if the SDK matched that plain name against
`mcp__session__Monitor` the whole projection would be silently dead while every
static check still passed. The requirement was to observe a watch **actually
starting**.

It started. Session `ba5a5eb2…`, with `/tmp/t4-probe.log` created beforehand:

```
16:40:03 USER      Please call the Monitor tool now with command: tail -f /tmp/t4-probe.log …
16:40:06 TOOL      mcp__session__Monitor {"command":"tail -f /tmp/t4-probe.log","description":"T4 probe watch"}
                    => "Started monitor\ntaskId: process_dc0e66386d8945d78260e4dfd7f7617f\ntimeoutMs: 300000\n
                        Events arrive as task notifications. Stop it with ProcessStop."
16:40:21 FIRE      <task-notification> t4 probe baseline 2026-08-22T16:39:50.441Z
16:40:25 FIRE      <task-notification> T4C-WAKE-923024 appended at 2026-08-22T16:40:2…
16:40:29 ASSISTANT Received another task notification from the T4 probe monitor: ``` T4C-WAKE-923024 appended … ```
16:40:36 TOOL      mcp__session__ProcessStop {"shell_id":"process_dc0e66386d8945d78260e4dfd7f7617f"}
                    => "Stopped monitor\ntaskId: process_dc0e66386d8945d78260e4dfd7f7617f"
```

The line `T4C-WAKE-923024` was appended **from a shell, after the session went
idle**, and it arrived in the session as a task-notification turn four seconds
later. The wake is therefore attributable to the watch and to nothing on screen.

Two cards were raised during that turn, and their difference is the whole reason
case (d) can assert anything:

```
1) Tool: mcp__session__Monitor   MCP: session/Monitor    [Allow] [Always Allow] [Deny]   ← the SDK's per-session MCP approval
2) Tool: Monitor                 "Run this command as a Monitor watch: tail -f /tmp/t4-probe.log.
                                  This approval covers this one watch and cannot be remembered."
                                 tail -f /tmp/t4-probe.log   [Allow] [Deny]               ← T2's host gate, no-rule path
```

Card 2 is T2's `permission_request` verbatim: `toolName: 'Monitor'`, the command
on the card, and no *Always Allow* button (`noAlwaysAllow: true`). Both were
answered Allow. `ps` afterwards showed no surviving `tail -f /tmp/t4-probe.log`.

## (d) a Bash deny rule refuses the same watch, naming the rule — PASS

Workspace layer written by hand (the operator's job, not the harness's):
`~/.nessy-agent/workspaces/d98cc70e…/permissions.json`

```json
{ "permissionDsl": { "version": 1, "rules": [
  { "id": "t4-no-tail", "action": "deny", "match": { "kind": "bash", "pattern": "tail:*" } } ] } }
```

Same prompt, fresh session `1041b8bd…`, mode `default`:

```
mcp__session__Monitor {"command":"tail -f /tmp/t4-probe.log","description":"T4 probe watch"}
  => [ERROR] Monitor command watch was denied by permission rule "t4-no-tail" (workspace).      (status: error)
```

and the model relayed it: *"The Monitor command was blocked by a workspace
permission rule named **"t4-no-tail"** that explicitly denies `tail -f`
commands."*

Cards seen in that turn: only the SDK's `mcp__session__Monitor` approval. **No
host-gate card** (`/Run this command as a Monitor watch/` matched nothing) — a
deny is terminal and is decided before any prompt, which is exactly T2's shape.
The file was removed at the end of the run; `permissions.json` no longer exists
in that workspace.

## (e) allow rule + explore mode → a card: **NOT REPRODUCIBLE AS SPECIFIED** — the finding is an earlier gate

Rules for this case:

```json
{ "permissionDsl": { "version": 1, "rules": [
  { "id": "t4-allow-tail",  "action": "allow", "match": { "kind": "bash", "pattern": "tail:*"  } },
  { "id": "t4-allow-touch", "action": "allow", "match": { "kind": "bash", "pattern": "touch:*" } } ] } }
```

**Arm 1 — `tail -f`, session `f9f54037…`, mode `explore`.** No card appeared, and
no watch started either. The call came back refused by a gate that sits *in front
of* T2's:

```
mcp__session__Monitor {"command":"tail -f /tmp/t4-probe.log", …}
  => [ERROR] Session configuration changes are blocked in Explore. Switch to Manual or Bypass
     permissions mode (SHIFT+TAB) to create, update, or delete sources and agents.

     Effective mode: Explore
     Last mode change: user at 2026-08-22T16:41:57.633Z (modeVersion=2)
```

**Arm 2 — `touch /tmp/t4-probe-write.txt`, same session, same mode.** A command
the mode has a real opinion about (not on the read-only allowlist), so under the
row's premise it is the strongest case for a card. Identical refusal, again no
card.

That message is `mode-manager.ts:2478`, and its condition is the canonical tool
metadata: `Monitor` is declared `safeMode: 'block'`
(`packages/session-tools-core/src/tool-defs.ts:1099`, as are `CronCreate`,
`ScheduleWakeup` and `ProcessStop`), so `mcp__session__Monitor` is not in
`getSessionSafeAllowedToolNames()` and every read-only mode refuses it outright.
`SessionManager.authorizeMonitor` — and therefore T2's
`monitorCommandModeAllowsRule`, the "explore/plan → card, never a silent allow"
parity this case was written to observe — is never reached from a model tool call
in `explore`.

**Arm 3, the control on the same rig (mode `default`, same allow rule, same
command).** Without it, "no card in explore" would be equally true of a gate that
had stopped honouring allow rules at all:

```
mcp__session__Monitor {"command":"touch /tmp/t4-probe-write.txt","description":"T4 probe watch"}
  => "Started monitor\ntaskId: process_c41a093a8672482e8f54b538e274c1b4\ntimeoutMs: 300000 …"
cards: only the SDK's mcp__session__Monitor approval — no host-gate card
```

So the allow rule IS honoured and DOES suppress T2's card in a mode the primitive
permits. The half of T2 that a live claude session can reach behaves as built.

**Cross-runtime control (session `07324cf4…`, card `pi-api-key`, mode
`explore`).** Is the Explore refusal claude's, or the shared gate's? On Pi the
same prompt produced no Monitor call at all — the model reported the tool absent
from its list (*"looking at the available tools in my system prompt, I don't see a
'Monitor' tool listed"*) and fell back to plain `bash`. Same outcome (no watch
under a Monitor gate). **CORRECTED 2026-08-24 (P2.15 review, measured):** this was
NOT a safe-mode surface divergence — no offer surface filters by safeMode on ANY
runtime; Pi offers `Monitor` too. The Pi model's "I don't see a Monitor tool"
was a self-report artifact of DEFERRED tool loading: `mcp__session__Monitor` is
absent from the upfront keep-list (`harness-manifest.ts:239`), so with deferred
loading on it is signed and tool-searchable but not listed upfront — in every
mode, not only Explore. Offer-then-refuse is universal; parity holds. See row P2.15.

(That fallback also left a background `tail -f` running via Pi's own `bash`
tool — `tail` is on the shipped read-only allowlist, so Explore permits it. Killed
at the end of the run; noted because it shows the Monitor gate is not the only
way a watch-shaped command reaches a shell.)

---

## Verdicts

| Case | Verdict | One line |
| --- | --- | --- |
| (a) `/loop 1m` fires twice | **PASS** | `CronCreate * * * * *`; fires 16:27:05 and 16:28:05, each a `<task-notification>` turn; `CronList`/`CronDelete` work |
| (b) self-paced `/loop` | **PASS** (one behaviour deviation) | `ScheduleWakeup {delaySeconds:60, reason:…}` fired at the promised second; `{stop:true}` ended it and nothing fired for 180 s. Unprompted, the model ended its iteration without rescheduling — model gap, not a missing path |
| (c) `Monitor` falsification | **PASS** | `mcp__session__Monitor` started (`taskId: process_dc0e…`) with bare `Monitor` disallowed in the same build; an appended line woke the idle session |
| (d) deny rule | **PASS** | `[ERROR] Monitor command watch was denied by permission rule "t4-no-tail" (workspace).`, no host card |
| (e) allow rule + explore → card | **NOT REPRODUCIBLE AS SPECIFIED** | Explore refuses `mcp__session__Monitor` at the shared safe-mode gate before T2's gate; controls prove the allow rule works in `default`; the "Pi hides the tool in Explore" reading was a deferred-loading self-report artifact, not a safe-mode filter — CORRECTED, see P2.15 |

## State the run left behind

Checked rather than assumed, because a live cron outliving its run is the kind of
litter that shows up as someone else's flake:

- `~/.nessy-agent/workspaces/d98cc70e…/.nessy-agent/crons/{cd701336,84524432,446477fc}.json`
  all read `{"schemaVersion": 1, "tasks": []}` — every record created here is gone.
  (Incidental, and useful for T8: the store anchored to the WORKSPACE root, not to
  a session or worktree directory.)
- `~/.nessy-agent/workspaces/d98cc70e…/permissions.json` deleted; it did not exist
  before this run.
- No surviving `tail -f /tmp/t4-probe.log` process (`ps` clean; the one Pi's `bash`
  fallback started was killed).
- The seven `CDP T4-…` sessions are left in the sidebar, named, for re-reading.

## What this run leaves open

1. **T2's mode parity is unreachable from a model tool call.** Its explore/plan
   branch can only be exercised by a producer that arms a watch without passing
   `shouldAllowToolInMode` — a plugin monitor or a host-side arming path. Either
   the branch is defensive-only (say so in the code) or the safe-mode metadata for
   `Monitor` is the thing to revisit. Owner call; candidate plan row.
2. **Offer-then-refuse in read-only modes** — CORRECTED 2026-08-24 (P2.15): there
   is NO Pi/claude divergence; offer-then-refuse is universal across all three
   runtimes (Pi offers the blocked tools too). Whether read-only modes should stop
   OFFERING `safeMode:'block'` tools at all is a genuine design question, parked as
   an owner decision — it must be all-or-nothing across the runtimes and it costs
   the gate's instructive refusal. See row P2.15's parked follow-up.
3. **`qwen35` does not self-reschedule** a self-paced loop unprompted; the loop
   then dies at the documented 20-minute fallback. If self-paced `/loop` is meant
   to be usable on the gateway's default model, that is a prompt/skill question,
   not a scheduling one.
4. Not measured here: cron records surviving a runtime switch (T6's row),
   `CLAUDE_CODE_DISABLE_CRON` observed in a spawned child's environment (asserted
   by T3's unit tests and by the SDK's own *"CronCreate exists but is not enabled
   in this context"* refusal above), and anything on a packaged build — this was
   the dev app, as the row's own instructions specify.

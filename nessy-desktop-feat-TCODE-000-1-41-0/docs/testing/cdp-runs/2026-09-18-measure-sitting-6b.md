# 2026-09-18 — measure sitting 6b (WAVE I-12, lane SIT-6b) on the packaged 1.40.0, CLEAN environment

The rig rows measure sitting 5e left at the end of its list: `D1.134`, `D1.135`, `D1.133`, `D1.131`,
`D1.132`, `D1.137`, `D1.138`, `D1.136` and `D1.177` — each named in `2026-09-18-measure-sitting-5e.md` §10
with the rig it needs. A sibling sitting lane (SIT-6a) ran at the same time on ports 9262–9271 and owns
`scripts/cdp/README.md`, `scripts/cdp/lib/**` and the ten D1.356 cases; this lane owns **9272–9281**,
checklist ids **RS-97…RS-106** and `scripts/cdp/fixtures/agent-surfaces.ts`, and edited no lib file and no
existing case.

**Build under test.** `release/mac-arm64/Nessy Desktop.app`, **1.40.0** (`CFBundleShortVersionString` and
`CFBundleVersion` both read `1.40.0`), built by the controller from `61cfc4659`. Never rebuilt, never
removed. The repository tree carried four code lanes' uncommitted `packages/**` edits throughout; none of
them is in the artefact, which is why every reading here is taken off the packaged app and never off the
source.

**Rig.** Port **9272**, proven free with `lsof` before the first launch (`lsof -nP -iTCP:9272-9281` printed
no rows and exited 1 at 16:06). `NESSY_CONFIG_DIR` and `--user-data-dir` under this lane's scratchpad,
created for the run and never under `~`. The owner's profile was never launched; `dp auth login` / `logout`
were never run; no token was read, printed or committed. `NESSY_DEBUG=1` and `NESSY_PROXY_AUTH_DEBUG=1` on
every launch. Every launch used the `env -u` launcher from `scripts/cdp/README.md` with all thirteen names
deleted, and the CASE process got the same treatment.

---

## 0. The clean-environment control, printed once per run

The derivation re-run at HEAD in its boundary-aware form, never a copied list:

```sh
env | cut -d= -f1 | grep -E '^(CLAUDE|ANTHROPIC|NESSY|CODEX|PI|OTEL|DISABLE|MAX_|BASH_|MCP)' | sort |
  while read -r n; do
    c=$(git grep -aclP "(?<![A-Za-z0-9_])$n(?![A-Za-z0-9_])" -- packages apps | wc -l)
    [ "$c" -ne 0 ] && echo "$n -> $c file(s)"
  done
```

**Thirteen** names over the same 31-name candidate set, membership and counts identical to sittings 4, 5c
and 5e's: `ANTHROPIC_BASE_URL` 51, `CLAUDE_EFFORT` 19, `CLAUDE_CODE_DISABLE_CRON` 12,
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` 11, `CLAUDE_CODE_SUBAGENT_MODEL` 10, `DISABLE_AUTOUPDATER` 5,
`CLAUDE_CODE_EXECPATH` 4, `CLAUDE_CODE_OAUTH_SCOPES` 2, `CLAUDECODE` 2,
`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` 1, `CLAUDE_CODE_MESSAGING_SOCKET` 1,
`CLAUDE_CODE_MESSAGING_TOKEN` 1, `MCP_CONNECTION_NONBLOCKING` 1 (the entry `app-env.ts` records at
`files: 0` and deliberately does not block on).

**The app's own read-back**, through `ps eww` on the RUNNING app, scoped to this lane's own config dir:
`{"pids":4,"present":{},"controlSeen":true}` in every case of this sitting. Clean, with `NESSY_CONFIG_DIR`
seen in the same read as the positive control.

### Two rig facts this sitting adds before any row

* **A config dir seeded BEFORE its first boot blocks startup on a dialog.** Launching the packaged app
  against a directory that holds the fixture's files but no `config.json` answers
  `{"level":"error","scope":"boot","phase":"storage-readiness","code":"custom-root-reset-required",
  "message":"Storage readiness blocked: custom-root-reset-required. Startup is waiting on the storage
  dialog."}`, repeatedly, and never writes its own config. The order that works is **boot empty → quit →
  seed → boot again**, which is what this sitting did.
* **`rpc.createSession` took 26 339 ms and the renderer's own `sessions:get` timed out at 30 000 ms**,
  twice, at machine load 11–12 with four code lanes and a sibling sitting live. The renderer then shows
  *"Failed to load sessions … Request timeout: sessions:get (30000ms)"* and holds that state across a
  reload; a second reload cleared it. Every wall-clock number below carries that confound and is quoted
  with the load beside it.

---

## 1. D1.134 — the per-event hook matrix: claude and Pi fire the SAME eight events, and `/hooks` denies all of it (case `RS-97`, **PASS**)

The row asks for one command hook per event through our own tiers, and for every declaration-backed
`emitted` verdict to be replaced by an observed firing or non-firing. Measure sitting 5e could not drive it
because its `hooks.json` was deliberately parked — the `UserPromptSubmit` entry injects a codeword into
every prompt, which is the instrument this row needs and the contamination every other row must avoid. This
lane restored it, alone, and widened it.

### The instrument

`scripts/cdp/fixtures/agent-surfaces.ts` grew `--hook-matrix <dir>` (`7e76f61a2`): one command hook per
`AGENT_EVENTS` entry, each appending `<marker> <Event>` to `<dir>/<Event>.hit`. The event list is IMPORTED
(`AGENT_EVENTS`, derived from `AGENT_EVENT_CONTRACTS_V1`) rather than written out — a prose enumeration
beside a single source of truth ages silently — and it answers **32**; `packages/shared/src/automations/types.ts`
is byte-identical between the artefact commit `61cfc4659` and HEAD (`git diff --stat` empty), so the list is
the artefact's. The matrix REPLACES the three named hooks rather than joining them, because `addHook` drops
any earlier CDP hook for the same event and a matrix written beside them would have deleted AGT-6's entry
silently; AGT-6's codeword rides the matrix's `UserPromptSubmit` entry so that instrument survives, and only
that one event echoes to stdout.

**Why a file.** A hook's stdout only reports firing for the handful of events whose output is delivered
somewhere a case can read; a file append reports it for all 32 and survives the turn, the session and the
app. The reading is a DELTA per phase, never a total — one hits directory serves both arms, and a total
would be their sum.

**Positive control on the instrument itself**, taken before the app was launched: the emitted `PostToolUse`
command, run through `sh`, writes its own line to the `.hit` file it names.

### What fired, on the packaged 1.40.0

Four provocations per arm — a session start, a turn that runs `pwd` through the Bash tool, a model switch, a
second turn with no tool — same config dir, same hooks, same run:

| phase | claude (`claude-gateway`) | pi (`pi-api-key`) |
| --- | --- | --- |
| session start | — | — |
| the `/hooks` listing | — | — |
| turn with a tool call | `SessionStart` 1, `InstructionsLoaded` 1, `UserPromptSubmit` 1, `PreToolUse` 1, `PostToolUse` 1, `PostToolBatch` 1, `MessageDisplay` 5, `Stop` 1 | `SessionStart` 1, `InstructionsLoaded` 1, `UserPromptSubmit` 1, `PreToolUse` 1, `PostToolUse` 1, `PostToolBatch` 2, `MessageDisplay` 3, `Stop` 1 |
| model switch | — (`offered: 0`, see below) | — (`offered: 0`) |
| second turn | `UserPromptSubmit` 1, `MessageDisplay` 2, `Stop` 1 | `UserPromptSubmit` 1, `PostToolBatch` 1, `MessageDisplay` 1, `Stop` 1 |

**The union is identical on the two runtimes** — `InstructionsLoaded`, `MessageDisplay`, `PostToolBatch`,
`PostToolUse`, `PreToolUse`, `SessionStart`, `Stop`, `UserPromptSubmit` — with `claudeOnly: []` and
`piOnly: []`. That is the row's first named control (*the same hook set on Pi*) taken in the same run
against the same files, and it answers: on the host tier, **claude is not the silent runtime it was at
`SessionStart` in W19-r's headless rig.** `claude-agent.ts` emits `SessionStart` host-side since D1.155, and
this is that repair observed on a packaged build.

**Eight of 32 fired; the other twenty-four are `not-provoked`, not silent.** This run creates four moments
and no more, so `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `ElicitationResult`, `FileChanged`,
`McpElicitation`, `McpResult`, `Notification`, `PermissionDenied`, `PermissionRequest`, `PostCompact`,
`PostModelSwitch`, `PostToolUseFailure`, `PreCompact`, `PreModelSwitch`, `SessionEnd`, `StopFailure`,
`SubagentStart`, `SubagentStop`, `TaskCompleted`, `TaskCreated`, `UserPromptExpansion`, `WorktreeCreate` and
`WorktreeRemove` are recorded as unprovoked. Collapsing that into a silence would turn *we did not ask* into
*it does not work*, and `runtime-hook-events.ts` is explicit that a closed bundle does not support a
"never fires" claim. The model-switch phase is the clearest case: the card's catalogue answered `offered: 0`
models through `getLlmConnections`, so no switch happened and `PreModelSwitch`/`PostModelSwitch` were never
given a moment.

**The codeword reached the model.** The claude child's own first assistant message in the first drive reads
*"There's also a codeword mentioned in the hook context: CDP-PROMPT-HOOK-3CF724DDD7"* — so the
`UserPromptSubmit` hook's stdout is delivered into the claude turn, which is AGT-6's clause observed on
claude rather than on Pi.

### The registration control, and the finding it produced

The first draft used `getSessionCapabilityInventory` and it is the WRONG surface: on this build it answers
27 rows of `{ key, kind, logicalName, reason }` — MCP servers and capabilities, no hook among them — so a
walk for `{ event, tier }` finds nothing and its zero says nothing about hooks. Recorded in the case so the
next reader does not repeat it.

The right surface is the product's own `/hooks` (`slash-commands/hooks-command.ts`, P6.294 + P6.643), and
**it denies the whole matrix**. On BOTH runtimes, verbatim:

> `This session does not publish a hook listing, so nothing can be shown here.`
>
> `No hook has run in this session yet.`

**The control is the app's own output on the same profile in the same run**: `[NessyAgent] User SDK hooks
loaded: InstructionsLoaded, SessionStart, UserPromptSubmit, UserPromptExpansion, PreToolUse,
PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification,
MessageDisplay, PreModelSwitch, PostModelSwitch, SubagentStart, SubagentStop, TaskCreated, TaskCompleted,
StopFailure, Stop, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact,
PostCompact, ConfigChange, McpElicitation, McpResult, ElicitationResult, SessionEnd` — all 32, three times
in the log. And the hit files say eight of them ran.

**Re-asked AFTER the turns**, on the pi session that had just fired all eight, `/hooks` answers the same two
sentences. So neither half is a timing artefact: the bindings half reports the runtime published no listing
when 32 were loaded, and the run-report half reports no hook has run when eight had. This is
**P-6b-1** below, and it is the exact failure `/hooks` was built to prevent.

### Verdict

`RS-97` **PASS** on the packaged 1.40.0 at load ~11. Eight events observed firing on claude, the same eight
on Pi, twenty-four unprovoked and named, registration read from the app's own load line, and the product's
own listing surface contradicted by both. The row's SECOND named control — the same file with
`settingSources` narrowed — stays owed and is not a rig action: no product surface offers that option, so
narrowing it is a source change.

---

## 2. D1.138 — the delta frames are in the ARTEFACT, with producers AND readers, so the row needs no new capture (a READING, not a case)

The row asks whether `thinking_delta` frames reach the claude adapter and `toolcall_delta` frames the Pi
adapter, and measure sitting 5c recorded it as *"needs the adapter-level frame capture the row names"*. Both
arms are in fact already answered in the row's own note — R3 (2026-09-12) drove the claude arm PASS (*the
frames ARRIVE and nothing reads them, so reasoning appears as one finished row*) and W19-r answered the Pi
arm (*the SDK emits on the adapter this fork runs and our reader consumes it*). What was missing is the
same reading off THIS artefact, which is cheap and needs no session at all.

Counted over every file under the packaged app's own `dist` tree, with the instrument named beside the
number as §Traps requires — `grep -rao <needle> | wc -l`, so these are OCCURRENCES and not lines:

| needle | occurrences |
| --- | --- |
| `thinking_delta` | **50** |
| `toolcall_delta` | **25** |
| `content_block_delta` (control the question itself quotes) | 44 |
| `input_json_delta` (the same) | 25 |
| `ZZZ_FAKE_CONTROL_NAME` (the negative) | **0** |

`thinking_delta` is in `main.cjs`, `resources/pi-agent-server/index.js` and
`resources/session-mcp-server/index.js`; `toolcall_delta` in the first two.

**Producers and readers, both, read from the bytes at the offsets rather than from a count.** For
`toolcall_delta` the artefact carries three distinct `stream.push({ type: "toolcall_delta", contentIndex,
delta, partial })` sites — one folding `event.delta.partial_json`, one a `pushToolCallDelta(slot, delta)`
helper, one stringifying a completed `toolCall.arguments` — and `case "toolcall_delta"` occurs **4** times.
For `thinking_delta` the reader side is larger: `case "thinking_delta"` occurs **20** times, one of them
`this._emit("thinking", event.delta.thinking, content.thinking)` and another folding the delta into a
snapshot's content block.

So on the packaged 1.40.0 both frame families are present with a producer and a consumer, and the negative
control scores zero on the same instrument. **What this does NOT say** is whose consumer: a minified bundle
cannot distinguish the vendored SDK's own stream assembler from this fork's adapter by inspection, and
R3's live claude arm is what establishes that *nothing of ours* reads `thinking_delta`. The reading here
retires the row's outstanding clause — *the adapter-level frame capture* — as unnecessary rather than
undone: the frames are in the shipped artefact and both arms already carry a live verdict.

---

## 3. D1.131 — the claude arm has NO SUBJECT on this build, measured at the artefact's own commit

The row's rig is the Guardian's fourth precedence tier, *"Pi and claude"*. The Pi half has a case already
(`scripts/cdp/cases/w19r-c3-4.ts`, which implements both intents AND both hard-deny controls). The claude
half was never driven, and this sitting measured why it cannot be: **the Guardian judge is not on claude's
path at all.**

Read at `61cfc4659`, the commit the artefact was built from, with a positive control on the same instrument
and the same three files:

```sh
git grep -acn "guardianJudgePort" 61cfc4659 -- packages/shared/src/agent/{claude,pi,codex}-agent.ts
git grep -acn "sessionId"         61cfc4659 -- packages/shared/src/agent/{claude,pi,codex}-agent.ts
```

| file | `guardianJudgePort` | `sessionId` (the control) |
| --- | --- | --- |
| `pi-agent.ts` | **2** | 100 |
| `claude-agent.ts` | **0** (the file prints no row at all) | 78 |
| `codex-agent.ts` | **0** | 20 |

`git grep -c` prints nothing for a file that scores zero, which is why the control matters: it proves the
probe read all three. The non-test consumers of `agent/core/guardian-consult.ts` at HEAD are
`pi-agent.ts`, `mode-manager.ts`, `backend/types.ts` and `backend/codex/auto-review-breaker.ts` — codex
reaches the judge through the auto-review breaker, a different seam from the soft_deny/hard_deny rig this
row spells out, and claude reaches it from nowhere.

So D1.131's claude arm is **`n/a` with a measured reason**, not owed: there is no Guardian consult on the
claude path to drive a fourth-tier rig through. The Pi half remains the row's real question and is a
re-drive of an existing case.

---

## 4. D1.135 — `maxTurns: 1` does NOT stop the child, and on Pi every subagent is a background task already (case `RS-98`, PARTIAL)

The row has four arms; this case is (b) `maxTurns` and (c) `background`, which share one rig. Arms (a) — an
`agentId` captured and continued — and (d) — a codex spawned agent calling `list_sessions` — are named as
owed with the reason rather than driven badly: measure sitting 5e measured that only Pi mints a child
SESSION, claude delegates through the SDK's `Agent` tool and codex through `spawn_agent`/`wait_agent`, so
there is no child to re-address on two of three runtimes and the product offers no surface that hands back
an agent id.

### The instrument, and the two readings it takes

`fixtures/agent-surfaces.ts --subagent-probes <dir>` writes FOUR agent definitions in two pairs, each pair
one frontmatter line apart with an identical three-step body that appends `<name> step <n> <unix seconds>`
to `<dir>/<name>.log`: `cdp-capped` (`maxTurns: "1"`) against `cdp-uncapped`, `cdp-background`
(`background: "true"`) against `cdp-foreground`. Neither arm is legible in the parent's transcript — a
capped child that was cut off and one that finished both come back as one Agent tool result — so the child's
own file is the detector, and a pair rather than a number is the evidence.

**The first draft read that file ONCE, at the settle, and its own control caught it.** On Pi the spawner
answers `subagent:completed: Started background subagent task / task_id: … / agent_ids: …` and the parent
turn returns while the child is still working: the capped arm settled after **107 170 ms** and the case read
**0 lines**, while the same child went on to write all three, stamped `14:39:29`…`14:40:01 UTC`. The case
now keeps `probeAtSettle` and a second read taken once the log STOPS growing.

### What is measured

**H25 — `maxTurns: 1` did not cut the child off, and the PAIR was taken in one run.** On the pi card, same
config dir, same three-step body, the two definitions one frontmatter line apart:

| arm | lines the child wrote | parent settled | the child's own stamps |
| --- | --- | --- | --- |
| `cdp-capped` (`maxTurns: "1"`) | **6** | 373 562 ms | `14:44:38`, `14:45:13`, `14:45:28`, then `14:47:27`, `14:47:53`, `14:47:56` UTC |
| `cdp-uncapped` (THE CONTROL, no cap) | **3** | 75 530 ms | `14:49:58`, `14:50:00`, `14:50:04` UTC |

The capped child wrote **twice as many** lines as its uncapped twin — it ran the whole three-step body and
then ran it again — so the check `capped.lines < uncapped.lines` FAILED, which is the row's question
answered in the negative and not a rig failure. Both definitions were read back off disk before the drive
with their own frontmatter line asserted present or absent, so this is not a fixture that failed to write.
A third, independent drive of the capped agent earlier in the sitting reached step 3 as well.

**H26 — `background: true` has nothing to distinguish on Pi, because Pi backgrounds every subagent.** The
spawner's own tool result is *"Started background subagent task"* for `cdp-capped`, which declares no
`background` flag at all, and the parent settled 25–32 seconds before the child's lines were written. So the
flag's arm and its control would answer the same way for a reason that is not the flag — and that is a
finding about D1.135's `background` clause, not a failed measurement: on this runtime the field cannot be
observed to do anything because the default already does it. The row's own note anticipates this half
(*"decide whether Pi's DEPTH proxy in `packages/pi-agent-server/src/orchestrator/spawner.ts` is replaced or
named in a switch-cost row"*), and this is that proxy visible from the product side.

### Why the run is PARTIAL, with the rig readings that say so

H26's own pair was not reached: the app **exited** during the `cdp-background` arm — `cdp-socket-closed:
refusing to send Runtime.evaluate`, then `devtools-unreachable`, with no `Nessy Desktop` process left. It
did not crash: no diagnostic report was written for it, and its own log's last line is an ordinary
`[ws-rpc-server] Client disconnected`. That is the THIRD such exit on this profile during the sitting (plus
two on the second profile), and it is **P-6b-3** below.

The other rig reading is the cost of a turn. Measured on this rig, same card, same app, back to back
(`scratchpad/control6b.ts`): a PLAIN turn (*"Reply with the single word ready"*) **did not settle in
240 000 ms**, and a SUBAGENT turn immediately after it settled in **232 506 ms** with 26 messages. So a turn
here costs about four minutes at machine load 11–12, a single arm can exceed a four-minute budget, and the
`SESSION_BUSY` an earlier drive's second bind answered is the same fact from the other side. The case's arms
record `timedOut` instead of throwing, precisely so one slow arm does not cost the other three — and the
run above is why H25's pair survived at all.

---

## 5. D1.137 — BLOCKED, and the blocker is measured: no GitHub-backed registry can fetch its catalogue from this machine today (case `RS-99`)

`RS-99` is written and drove to the point the row's precondition fails, on a profile created for it whose
trust modal had never been touched.

What it established before blocking: `installedPlugins: []` and 110 capabilities on a fresh profile with
`generation ed67bf4f…`; `marketplace.addRegistry({ source: 'anthropics/claude-plugins-official' })` returned
**success** — `{ marketplaceId: 'registry-40f86fc1…', displayName: 'anthropics/claude-plugins-official',
alreadyAdded: false }` — and `listRegistries` lists it with `autoUpdate: true`.

And then: `marketplace.list({ kind: 'plugins', query: 'typescript-lsp' })` answers **0**, polled twelve
times over thirty seconds and again over two and a half minutes. Widened: `query: 'lsp'` → **0**,
`query: 'language'` → **0**, `query: 'typescript'` → **1** (`jest-to-zoya-migrator`, a `skills-market`
entry). The whole listing is `total: 168` with page 1 carrying 100 rows, **every one of them
`marketplaceId: 'skills-market'`** — which is exactly the 168 measure sitting 5e recorded for a fresh
profile with NO registry added. The official registry contributed nothing.

**The app says why, in a line a packaged build does not surface:**

```
[marketplace-registry] catalog fetch failed for "anthropics/claude-plugins-official"
  (registry-40f86fc1-…): plugin.install.repository_ref_unresolved
[marketplace-registry] upgrade did not happen for "anthropics/claude-plugins-official"
  (…): reason=fetch-failed diagnostics=plugin.install.repository_ref_unresolved
```

**The control, and it is the one that decides what this means.** The app itself offers a second registry,
`openai/skills`. Adding it answers success the same way — `{ marketplaceId: 'registry-c00022fc…',
displayName: 'openai/skills', alreadyAdded: false }` — and fails the same way:
`catalog fetch failed for "openai/skills" (…): plugin.install.repository_ref_unresolved`. **Both**
GitHub-backed registries fail identically, so the cause is this machine's reach to the source and not the
official repository — which measure sitting 5e reached successfully on the same build about four hours
earlier, recording 13 `*-lsp` listings.

So D1.137 is a **measured NULL**: J25's Pi cell stays `partial`, and its reason is now a reading rather than
an inference — the positive control P3.366 asked for (*an official `*-lsp` plugin installed in a TRUSTED
project*) cannot be assembled while no GitHub-backed registry can fetch. `RS-99` is written, committed and
runs to that blocker by itself; re-drive it when a registry syncs.

The product half of that is **P-6b-2** below and does not depend on the network: the add is reported as
having SUCCEEDED, the registry is listed with `autoUpdate: true`, and the only account of the failure is a
debug line a packaged build does not write.

---

## 6. The rows NOT driven, each with the reason and the premise re-taken

One line per row, in the order this lane's brief set them. A reason is a READING wherever this sitting took
one.

| row | subject, short | why not driven here |
| --- | --- | --- |
| D1.133 | A57 and A70 | Not reached — the sitting was STOPPED by the controller at D1.131. A70 was already measured at the 1.36.0 sitting; A57 needs a background subagent tripping an ask rule per runtime, and §4 adds a premise it will need: **on Pi every subagent is a background task already** (the spawner answers *"Started background subagent task"* for an agent declaring no flag), so "background" is not a condition A57's rig has to arrange there — it is the default, and the arm that has to be arranged is a FOREGROUND one. |
| D1.131 | the Guardian's fourth precedence tier | **Half of it is answered here (§3): the claude arm has NO SUBJECT** — `guardianJudgePort` scores 0 in `claude-agent.ts` and 2 in `pi-agent.ts` at the artefact's own commit, with `sessionId` 78/100 as the control. The Pi half is a re-drive of the EXISTING case `scripts/cdp/cases/w19r-c3-4.ts`, which already carries both intents and both hard-deny controls; this lane started it and was stopped mid-drive, so **nothing of that run is reported**. It is the cheapest row left: one existing case, one pi card, no new code. |
| D1.132 | the three standing MEASURE rows | Not reached. A22/P6.198 was driven at the 2026-09-12 rig day through `RS-13`; A19/P6.196 has a case (`RS-12`, codex-only) that was not run here; **A16/P6.194 has no case file at all** — a repo carrying a project-file `bypassPermissions`, per runtime, with a default-mode control — and that is the one piece of new code the row needs. |
| D1.136 | J5's Pi and codex cells from RS-06 | Not driven; unchanged. It is a restamp that waits on RS-06/P6.144 (the MCP connect-default flip across two relaunches with a revoked credential), which this lane did not run. One rig fact it can use: `MCP_CONNECTION_NONBLOCKING` is the INERT name — the product reads the posture from `NESSY_MCP_CONNECTION_NONBLOCKING` — so a lane's shell carries no confound into that row. |
| D1.177 | the Pi checkpoint arm end to end | Not reached. It is the largest rig in the list (six named skip reasons provoked, a rewind after a resume, and a drive past 100 checkpoints) and §4's measurement prices it: **a turn on this rig costs about four minutes**, and a hundred checkpoints is not a hundred turns but it is not few either. It needs a quiet box more than it needs new code. |

---

## 7. What ran, and where this sitting stopped

| case | row | verdict | file |
| --- | --- | --- | --- |
| RS-97 | D1.134 | **PASS** | `scripts/cdp/cases/rs-97.ts` |
| RS-98 (pi) | D1.135 | **PARTIAL** — H25 answered in the negative with its pair; H26 has no subject on Pi and its own pair was lost to an app exit | `scripts/cdp/cases/rs-98.ts` |
| RS-99 | D1.137 | **BLOCKED**, with the blocker measured and controlled | `scripts/cdp/cases/rs-99.ts` |
| *(readings, no case)* | D1.138 | answered in §2 | — |
| *(readings, no case)* | D1.131 (claude arm) | answered in §3 | — |

**Where it stopped.** The lane's list was `D1.134`, `D1.135`, `D1.133`, `D1.131`, `D1.132`, `D1.137`,
`D1.138`, `D1.136`, `D1.177`. Driven or answered: **`D1.134`, `D1.135` (partial), `D1.137` (a measured
NULL), `D1.138`, and `D1.131`'s claude arm**. **The controller stopped this lane at `D1.131`** — its Pi
half, an existing case, had been launched and was killed mid-drive, and **nothing of that run is reported**.
The next sitting starts there: `w19r-c3-4.ts` on a pi card, then `D1.132`'s A16 (the one row here needing
new code), then `D1.133`.

### Rig facts this sitting adds

* **A config dir seeded BEFORE its first boot blocks startup on the storage dialog** (`custom-root-reset-required`).
  Boot empty → quit → seed → boot again.
* **A turn costs about four minutes at load 11–12**, and a PLAIN turn can exceed 240 s while a SUBAGENT turn
  beside it settles in 232 s. Size every sitting budget against that, and never read a timeout as a hang
  without a plain-turn control taken in the same minute.
* **On Pi a subagent is a BACKGROUND task by default** — `"Started background subagent task"` for a
  definition declaring no flag — so the parent settles before the child has written anything. A case that
  reads a child's artefact once, at the settle, measures nothing.
* **`getSessionCapabilityInventory` is not a hook surface.** 27 rows of `{ key, kind, logicalName, reason }`
  on this build, no hook among them; `/hooks` is the surface, and §1 is what it answers.
* **`/hooks` submits on selection** and leaves the composer EMPTY — `expectComposer: ''`, like `/compact`.
* **The packaged app exited three times on one profile and twice on another** during sustained driving, with
  no crash report and an ordinary client-disconnect as its own last log line. Budget for a relaunch.

---

## 8. Proposed rows — product findings with evidence and a control, never fixes

**P-6b-1 — `/hooks` reports that the session publishes no hook listing, and that no hook has run, while 32
are loaded and eight have fired.** `size S`. **Evidence:** `RS-97` on the packaged 1.40.0. On a claude
session and a pi session, `/hooks` answers verbatim *"This session does not publish a hook listing, so
nothing can be shown here."* and *"No hook has run in this session yet."* **Control, on the same profile in
the same run:** the app's own `[NessyAgent] User SDK hooks loaded: <all 32 events>` line, three times in the
log, and the `.hit` files showing eight of those events firing. **Re-asked AFTER the turns**, on the pi
session that had just fired all eight, the two sentences are unchanged — so neither half is a timing
artefact. **Why it matters:** `slash-commands/hooks-command.ts` exists because *"there is no one place that
lists the hooks this session will actually run"*, and its own docblock insists the three states — no listing
published, an empty listing, rows — must not be collapsed. A user debugging a hook is told their hooks do
not exist. **Zone:** the `describeHookBindings` projection and its `HookRunStore` sibling; not this lane's.

**P-6b-2 — adding a marketplace registry reports SUCCESS while every catalogue fetch fails, and the only
account of the failure is a debug line a packaged build does not write.** `size S`. **Evidence:** `RS-99` on
a profile created for the run. `marketplace.addRegistry({ source: 'anthropics/claude-plugins-official' })`
returns `{ marketplaceId: 'registry-40f86fc1…', displayName: …, alreadyAdded: false }`; `listRegistries`
lists it with `autoUpdate: true`; and `marketplace.list` stays at the same `total: 168` `skills-market` rows
a fresh profile has with no registry at all — `query: 'lsp'` → 0, polled over two and a half minutes. The
app's own output says `[marketplace-registry] catalog fetch failed … plugin.install.repository_ref_unresolved`
and `upgrade did not happen … reason=fetch-failed`. **Control:** the OTHER registry the app itself offers,
`openai/skills`, added and failed identically — so the trigger is this machine's reach to the source, and
the finding is not about either repository. **What is the PRODUCT's** is the silence: the add is reported as
having worked and the registry is listed as live. **Why it matters:** it is exactly what blocked D1.137 here,
and a user would have no way to tell an added-and-empty registry from an added-and-syncing one.
**Zone:** the marketplace registry handler and whatever surface would carry its diagnostics; not this lane's.

**P-6b-3 — the packaged app EXITS during a sustained drive, with no crash and no message.** `size S to
diagnose`. **Evidence:** three exits on this lane's first profile (mid-`RS-97`, mid-control, mid-`RS-98`'s
third arm) and two on its second, each presenting as `cdp-socket-closed` then `devtools-unreachable` with no
`Nessy Desktop` process left. **Controls:** `~/Library/Logs/DiagnosticReports` holds **no** report for it
(so this is an orderly quit, not a crash), the app's own log's last line each time is an ordinary
`[ws-rpc-server] INFO Client disconnected`, and the machine was not out of memory (321 193 free pages at the
last one, load falling to 6.5). Twice the renderer window went first and the main process outlived it by
minutes, which is the same event seen earlier. **Why it matters:** an app that disappears mid-turn with no
message is indistinguishable from a hang for a user, and it cost this sitting one arm of D1.135 and two
relaunches. **Not claimed:** a cause. The readings are the exits, the absence of a crash report and the
absence of any log line. **Zone:** the main process's window lifecycle; not this lane's.

**P-6b-4 — a declared `maxTurns` does not bound a Pi subagent.** `size S`. **Evidence:** `RS-98` on the pi
card, §4: `cdp-capped` (`maxTurns: "1"`) wrote **6** lines and `cdp-uncapped` (no cap, identical body)
wrote **3**, in one run on one profile. **Controls:** both definitions read back off disk before the drive
with the frontmatter line asserted present or absent; a non-empty log on both arms; and a third,
independent drive of the capped agent earlier in the sitting which also reached step 3. **Why it matters:**
`normalizeMaxTurns` REFUSES an invalid value loudly, so a user has every reason to believe a valid one is
enforced — and an unbounded child is a cost and a safety surface, not only a missing feature. **Not
claimed:** where it is dropped. **Zone:** `packages/pi-agent-server/src/orchestrator/spawner.ts` and the
definition forwarding path; not this lane's.

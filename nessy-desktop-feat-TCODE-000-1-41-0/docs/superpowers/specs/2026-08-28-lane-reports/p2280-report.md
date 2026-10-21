# P2.280 — report

**Status:** DONE. **SHA:** `c640178d3` on `feat/TCODE-000`. **Base SHA recorded before starting:** `32631ac41f758381b3d08bca54f59d128394c215`.

---

## 1. The headline finding — a gate at the listing site cannot fire

This is the finding the dispatch said it would value most, and it came out that way. **The bridge's absence is not detectable at the moment any of the three surfaces is listed.** Two independent facts, either sufficient on its own.

**(a) The value does not exist yet.** The chain, measured on the tree:

| Step | Site |
| --- | --- |
| `withCapabilityRuntime` calls `createCapabilityTurn(managed)` … | `SessionManager.ts:7773` |
| … which builds the model-facing view, `/loop` decision included | `SessionManager.ts:5778` |
| … *then* calls `action(turn.runtime)`, which calls `getOrCreateAgent` | `SessionManager.ts:7776` |
| `managed.agent` is assigned only inside `getOrCreateAgentUnchecked` | `SessionManager.ts:15986` / `16008` |
| `startCallbackBridge()` runs later still, inside `createRuntime` ← `ensureRuntime()` ← the chat generator | `codex-agent.ts:1169` / `1122` / `2581` |

So on a fresh session the agent is `null` when the view is frozen, and the bridge has not been attempted even after the agent exists. The composer-catalog route is worse still: it resolves from `(resolver, context)` only — no agent is in scope at all.

**(b) No listing surface re-derives on a turn boundary.** Measured in the renderer:

- `refreshCapabilityViews` (composer catalog) deps: `[activeSessionWorkingDirectory, activeWorkspaceId, session.selected]` — `AppShell.tsx:1405`.
- `refreshCustomSlashCommands` (the `/` menu) deps add only `activeSessionConnection` — `AppShell.tsx:1464`.

Neither depends on anything that changes when a turn ends. **A bridge-state gate on the composer catalog would therefore be dead in the exact case it exists for**, so I did not add one — the measured reason is written into the comment at that call site instead, because a gate the next reader mistakes for enforcement is worse than no gate at all.

### What I did instead, and why it is not the same lie more politely

Applying the per-case discipline from the precedent lane rather than defaulting to a gate:

| Surface | Remedy | Why |
| --- | --- | --- |
| Model-facing turn view (`createCapabilityTurn`) | **Gate it** | This view is rebuilt on **every send**, so from the turn after a failed bridge the model stops being told it has a `loop` skill. It is also the surface whose removal makes *invocation* fail, not merely a menu row vanish (its own doc: "removes the skill rather than merely hiding a menu entry"). This gate genuinely runs. |
| `/` slash-command menu (`skillSlashCommands`) | **Gate it, partially** | Refresh-driven, not turn-driven — it fires on a session select, a working-directory change or a runtime switch. Wired anyway because the code documents both skill sites as sharing "the one condition"; splitting them is how the two halves of R39 would drift. Its weaker cadence is stated in the doc comment, not hidden. |
| Composer catalog (`capabilities.ts:188`) | **Neither** | Measured dead (above). Comment records the measurement. |
| The underlying fact | **Implement it** | Until this row the bridge's outcome was recorded **nowhere**. That was the deeper defect and is now fixed. |

### The residue, stated plainly

**Turn one of a bridge-less session still gets `/loop`.** It is not closable at any listing site, because the fact does not exist when the listing is made. I did not paper over this: `'not-started'` has its own test row, as a boundary and not an oversight, and the commit message says it.

---

## 2. Premise check — the row is correct, and I reproduced it

Measured on HEAD before changing anything (`getSessionToolNames`, projection `codex`, `externalStandaloneOnly: true`):

```
cron tool names       : CronCreate, CronList, CronDelete, ScheduleWakeup
unbridged codex count : 18
bridged   codex count : 26
cron present unbridged: []
cron present bridged  : ["CronCreate","CronList","CronDelete","ScheduleWakeup"]
delta                 : ["GoalGet","Goal","ProcessStop","Monitor","CronCreate","CronList","CronDelete","ScheduleWakeup"]
```

and `cronToolsAbsentFor('codex-runtime')` was `false`, so `/loop` was offered either way. The row's "not latent" correction is right: `startCallbackBridge`'s own catch is non-fatal by design.

**One thing the row could not know, and it is the deeper defect:** the failure was recorded *nowhere*. It went to `this.debug(...)`, which — per `getRecentAgentStderr`'s own doc in `SessionManager.ts`, the reason that buffer exists — "reaches neither the terminal nor a file: `debug()` routes through electron-log, whose transports the main process disables". So a session on 18 tools was indistinguishable from one on 26 from outside `CodexAgent`. Every remedy needs that fact to exist first.

Failure modes that reach it: `server.listen(0, '127.0.0.1')` throwing (`session-callback-bridge.ts:364`) — `EMFILE` is live here, given the documented Electron fd floor of 256 — and a config with no session/workspace identity, which omits the same `--host-callback-port` argument and so strips the surface identically.

---

## 3. What changed

**`packages/shared/src/agent/codex-agent.ts`**
- New exported `CodexSchedulingBridgeState = 'not-started' | 'active' | 'unavailable'`.
- `startCallbackBridge` records the outcome on all three arms (success, throw, identity early-return); `getSchedulingBridgeState()` publishes it; `teardownRuntime` resets to `not-started` (not a latch — `createRuntime` re-attempts).

**`packages/server-core/src/sessions/SessionManager.ts`**
- `cronToolsAbsentFor(provider, schedulingBridgeKnownAbsent = false)` — defaulted, so existing callers are unchanged.
- New `schedulingBridgeKnownAbsent(agent)` — duck-typed, mirroring `getRecentAgentStderr`'s probe of `getRecentStderr`; **only `'unavailable'` returns true**; a throwing accessor, a missing accessor and no agent all return `false`.
- `withoutLoopSkillWhereCronToolsAreAbsent(skills, provider, schedulingBridgeAbsent = false)`.
- Both skill call sites pass it (`createCapabilityTurn`, `skillSlashCommands` via its single caller).

**`packages/server-core/src/handlers/rpc/capabilities.ts`** — the bundled stale comment. `ec7e24a51`'s *"a shipping codex spawn carries `--host-callback-port`"* is deleted and replaced with the conditional truth plus the measurement for why no gate is added here.

**Anchors:** two `scheduled-tasks.md:208` page-line citations replaced with `scheduled-tasks.md#disable-scheduled-tasks` + the verbatim sentence — *"The cron tools and `/loop` become unavailable, and any already-scheduled tasks stop firing."*

---

## 4. Documentation category

**Category (a) for everything I implemented.** The T5 host-callback bridge, its failure semantics and the state machine are ours; no upstream page governs them. I did not go looking.

**Category (b) for `/loop`'s availability**, which *is* documented, and the two stale page-line anchors I replaced are that citation: `scheduled-tasks.md#disable-scheduled-tasks`. I did not re-derive that anchor — it was measured and landed by `ec7e24a51`, and I carried it verbatim to the two sites that still had `:208`.

---

## 5. Tests

New: `packages/shared/src/agent/__tests__/codex-scheduling-bridge-state.test.ts` (5 rows) — real `CodexAgent`, real listen on `127.0.0.1:0` for the `active` arm (no double), config-driven identity arm with **no mock in play at all**, module mocked with a spread and restored from a pre-mock reference for the throwing arm.

Extended: `loop-skill-runtime.test.ts` (+11 rows) — the predicate's three states, the four not-evidence cases, the two skill-filter arms, and a source-text wiring pin.

**Green (four-file set, quiet machine):** `52 pass, 0 fail, 175 expect() calls, Ran 52 tests across 4 files`.
**Green (two-file set, under the same load that was collapsing the file):** `23 pass, 0 fail, 42 expect() calls, Ran 23 tests across 2 files`.

### Re-break, against the absolute base SHA (never `HEAD~1`)

1. **Whole change reverted to `32631ac41`, tests kept:** `0 pass, 6 fail`. The five shared rows fail with `agent.getSchedulingBridgeState is not a function`. Both source files restored byte-exactly afterwards (sha256 verified).
2. **Targeted mutation — third argument dropped at `createCapabilityTurn`:** `50 pass, 2 fail`; the wiring row reports `Expected to contain: "schedulingBridgeKnownAbsent("` against the mutated call text. (The second failure is the neighbour flake in §7.)
3. **Bounded assertion verified to discriminate for EITHER call site**, evaluated directly: current `{n:2, all:true}`; site-1 mutation `{n:2, all:false}`; site-2 mutation `{n:2, all:false}`.

### A test row that measurement corrected

My first draft asserted that `withoutLoopSkill(SKILLS, undefined, true)` must **keep** the skill — "a stray `true` must not strip Pi/Claude". The predicate failed it (0.37 ms — a real failure, not a load artefact), and **the predicate is right**. Scoping the bridge condition to `provider === 'codex-runtime'` would plant a second copy of "which runtime owns a host-callback bridge" in a file that cannot see `CodexAgent` — the two-lists drift this suite's own history is a record of. The narrowing belongs in the accessor, which only `CodexAgent` publishes. The row now asserts the true behaviour, with that reasoning written down.

### Gates — all RAN, with proof of work

| Gate | Result |
| --- | --- |
| `bun test` (zone, via mutex) | `23 pass, 0 fail, 42 expect() calls` / `52 pass, 0 fail, 175 expect() calls` |
| `tsc --noEmit` server-core | exit 0, `error TS` count **0**, `Files: 3044`, `Lines: 706445` |
| `tsc --noEmit` shared | exit 0, `error TS` count **0**, `Files: 3270`, `Lines: 814769` |
| eslint (from each package dir, changed files only) | exit 0, **0 output lines**, both packages |
| `git diff --check` | exit 0 |

**Negative control on the typecheck gate**, because an exit status is not evidence: I injected `private readonly __p2280NegativeControl: number = 'not a number';` into `codex-agent.ts` and tsc reported `src/agent/codex-agent.ts(1062,20): error TS2322`. So the gate does cover my file, and it is clean. Reverted; 0 occurrences remain.

**Not run, deliberately:** full-repo suite, builds, packaging, live smokes — per the implementation-first verification budget; this is not a verification-wave boundary and touches no wire/schema/auth/migration surface.

---

## 6. An environmental failure I nearly misattributed — worth carrying

`loop-skill-runtime.test.ts` collapses into a single `(fail) (unnamed) … a beforeEach/afterEach hook timed out` under machine load. I initially read it as my own breakage and bisected toward my diff. **The control that settled it: HEAD's own unmodified copy of the file, run as a sibling, failed identically.** Cause: its `beforeAll` imports `SessionManager.ts` (1.3 MB, wide graph) and bun's default 5 s hook timeout is exceeded when other lanes are busy — measured at 5 s / 15 s / 22 s / 37 s under load, and 1.0 s idle.

The signature reads exactly like a real failure and is not one. Since I am extending that file and needed my rows to run, I gave the hook an explicit `60_000` budget with the measurement written above it. Verified: the same load that was collapsing the file now yields `23 pass, 0 fail`.

Not in the known-failing register (`grep` for `codex-callback-bridge-host` / `monitor/start` returns nothing) — and I did not edit that register, per the lane rules.

---

## 7. Concerns and things I did not touch

1. **The turn-1 residue is real and is not closed.** A codex session whose bridge fails on its very first turn is still offered `/loop`, and the model can still answer as though it scheduled. Closing it needs a remedy at a different layer than a listing gate — the two candidates I can see are both outside my zone: making the session MCP server advertise the four tools in a *refusing* state when unbridged (`session-tools-core` / `session-mcp-server`), or a bounded retry of the listen. I did not reach across.

2. **A seventh site of the P2.211 dead claim survives, outside my zone.** `apps/electron/src/renderer/components/app-shell/AppShell.tsx:1358-1364` still says the loop skill's cron tools "are `visibility: 'pi-only'`" — the exact claim `ec7e24a51` swept from six places. Worth a row.

3. **`getRecentAgentStderr`'s doc is stale in my file and I left it.** `SessionManager.ts:21809` says the buffer is empty for "a backend that keeps no buffer (claude/codex runtimes)"; codex has kept one since the BYO-QWEN change. In scope by file, out of scope by row — flagging rather than widening the diff.

4. **A neighbour suite is load-flaky.** `codex-callback-bridge-host.test.ts` → "monitor/start goes through T2's gate" times out at 5000 ms with `ECONNRESET` on `http://127.0.0.1:<port>/monitor/start`. It passed in my clean 52-test run and failed alone (20 pass / 1 fail) and in loaded runs. Not caused by this change — my diff touches no bridge route — but it is not in the known-failing register either.

5. **`skillSlashCommands`'s gate is honest but weak.** It fires on refresh, not per turn. I wired it for consistency with the model-facing site and said so in its doc; if the controller would rather have one enforcing site and no half-measure, dropping that one argument is a clean revert.

6. **The wiring pin is source text, not behaviour.** Neither call site is drivable from a unit test (`createCapabilityTurn` needs a live `SessionManager` with a resolved lease). The pin is the local precedent — `codex-callback-bridge-host.test.ts:643` reads `codex-agent.ts` as source text for the same reason — and I proved it discriminates under mutation at both sites, but it would not catch a call site that passes the argument and then ignores it.

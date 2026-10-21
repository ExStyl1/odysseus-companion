# P2.257 — `thread/fork` is bounded; the row's premise held, its analogy did not

Branch `feat/TCODE-000`. Zone: `packages/shared/src/agent/codex-agent.ts` + one new test file.

---

## 1. What shipped

`applySelectedPluginSkillRuntimePolicy` (`codex-agent.ts`) now runs its whole re-fork walk under one
budget:

- `thread/fork` and the `thread/start` it falls back to both go through P2.245's
  `requestWithinDeadline`.
- ONE budget (`CODEX_THREAD_REFORK_TIMEOUT_MS = 30_000`), started before the fork; the fallback leg
  spends `deadlineAt - performance.now()`, never a fresh budget.
- On expiry the method **throws**. It does not degrade — see §3.
- The sentinel check sits **outside** the `catch`, so a deadline can never take the `no rollout found`
  fallback arm.
- Both legs inherit `CODEX_DEADLINE_CHANNEL_MARGIN_MS` from the shared helper, so the **sentinel wins
  the tie** against the channel's own timer (the coordinator's two mid-task corrections; §5).

Tests: `packages/shared/src/agent/__tests__/codex-refork-deadline.test.ts` (new file, 7 tests).

Commit `b1fcf1577`, two files, on `feat/TCODE-000`.

---

## 2. The measurements — the row's analogy to P2.245 is REFUTED

The brief said: *"this is the same fix P2.245 landed"* and *"`thread/fork` runs on a WARM
connection"*. The second half is true and load-bearing. The first half is false, and importing
P2.245's constant would have been a defect.

Rig: the bundled binary `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`
(`0.148.0`), driven exactly the way `codex-inject-items-e2e.test.ts` drives it — real
`CodexRuntimeManager` spawn, real `AppServerClient`, loopback Responses stub, `writeCodexConfig`,
and the product's own `buildCodexRuntimeConfigOverride` payload on every fork. 2026-08-27.

### 2a. `thread/fork` warm, by history size

| rollout | n | min | p50 | max |
| --- | --- | --- | --- | --- |
| 1 turn | 8 | 239 ms | 337 ms | 498 ms |
| + ~0.9 MB injected | 6 | 531 ms | 636 ms | 803 ms |
| + ~2.7 MB injected | 6 | 874 ms | 920 ms | 1218 ms |
| + ~6.3 MB injected | 6 | 926 ms | 1003 ms | 1465 ms |
| + ~11.7 MB injected | 6 | 1238 ms | 1343 ms | 1509 ms |

An earlier independent run of the same shape agreed: 371–946 ms at a 1-turn rollout, 1179–1345 ms at
~1.1 MB.

**`thread/fork` is ~1000x more expensive than the call P2.245 bounded** (that poll: 0.05–0.97 ms).
P2.245's 5 s is ~5000x its slowest answer; 5 s here would be **3.3x** the slowest answer measured —
a bound sitting barely above the resting state, i.e. exactly the trap AGENTS.md records
("size thresholds against the floor, not zero").

Growth with history is **sublinear**: 13x the history costs ~3x the time. So a long session cannot
walk itself into the bound. What moves these numbers is the HOST — every run above shared the
machine with other test lanes, and the spread within one rollout size (239 → 498 ms for the
identical call) is that noise, not codex.

### 2b. The other two legs

- The `no rollout found` refusal — the ONLY route to the fallback leg — comes back in
  **0.53–1.13 ms** (n=3). The fallback therefore inherits essentially the whole budget.
- `thread/start` on a warm connection with the same config: **96–227 ms**, plus one 2538 ms sample
  taken while another lane's suite was running.

### 2c. MCP startup is NOT on the thread-boundary path

This was the one plausible source of a legitimately multi-second fork, since the product always
writes `[mcp_servers.session]` and users can add slow ones. Probed by pointing that entry at a stdio
command that says nothing for 60 s: `initialize` returned in **92 ms** and eight forks in
**324–729 ms**. A thread boundary does not wait on an MCP handshake.

(An earlier probe with a 3 s-silent server showed `initialize` at 2292 ms and one `thread/start` at
2538 ms. The 60 s probe refutes the MCP reading of those numbers; they were host load.)

### 2d. Why 30 s

~20x the slowest fork measured and ~12x the slowest thread boundary of any kind observed. The
asymmetry is what sets it: this call **cannot degrade** (§3), so a bound that fires early costs the
user a turn — P2.232's objection, alive here in a way it is not for P2.245's optional poll. What
defeats P2.232 here is not that the call is cheap (it is not) but that it runs on an already-warm
connection, so the 34.7 s cold-spawn spread is absent.

---

## 3. The shape: a budget for the walk, and a THROW rather than a degrade

**Walk, not per-call.** The two legs are strictly sequential and the second is reachable only
through the first. Two ceilings of T would hold the turn's head for 2 x T while each leg stayed "in
budget". One budget bounds what a user feels; nothing is starved, because the refusal that opens
leg two costs ~1 ms.

**Throw, not degrade — the one place this diverges from P2.245.** Its poll is optional: on expiry
the turn runs with an incomplete chip set. This walk is the ONLY thing that applies a drifted model
AND a drifted sandbox/permission layer (`buildCodexRuntimeConfigOverride` carries
`deniedReadPaths` + `writablePaths` + the permission profile). Continuing past a failed re-fork
would run the user's turn under the OLD permission profile — a silent widening whenever the drift
was a tightening. Failing the turn is already this method's shipped contract for a fork that errors
(`codex-runtime-handoff.test.ts`: "does not fall back on any other fork error").

**Two pieces of state a half-applied re-fork would corrupt**, both pinned by test 2:
`this.threadId` must still be the thread that holds the conversation, and `runtimeConfigSignature`
must still read STALE. A signature updated on the failure path would make every later turn skip the
re-fork and run under the old model and old sandbox policy for the rest of the session, with no
further attempt and no further error.

**The deadline must never take the fallback arm.** `thread/start` is a lossless replacement only for
a thread PROVEN empty by the `no rollout found` refusal; a fork that merely did not answer proves
nothing, and starting fresh would discard the whole conversation. The sentinel check is outside the
`catch` so this is true by construction rather than by how a timeout happens to be worded.

---

## 4. The three "do not"s

- **Did not classify absence by error code.** No `-32601`/`-32602`/`-32600` reasoning was added.
  `DEFINITIVE_REFUSAL_CODES` is untouched; P2.243's divergence is not widened. The deadline resolves
  a sentinel and the thrown message carries no `code` and no serde token, so it cannot reach either
  classifier.
- **Did not probe unsent params.** No speculative field was sent to any method, in either direction
  of the corrected rule (§5).
- **Did not import P2.245's timing.** Measured independently; the numbers refuted the analogy (§2).

---

## 5. The coordinator's mid-task correction, and what it changed here

Two parts arrived mid-task.

**(a) The unsent-params trap was inverted** — unknown field NAMES are silently accepted, while a
wrong TYPE on a real field or a MISSING required field is what returns a serde token and latches the
chips off. No impact on this row: no probe of any kind was sent.

**(b) The sibling's sentinel is production-dead, and MY FIRST VERSION INHERITED IT.** Handing both
timers the same value makes the CLIENT's rejection win every time on a real `AppServerClient` — it
arms its `setTimeout` inside `request`, before `requestWithinDeadline` can arm the race's. My first
version had exactly that, so on a real connection the user would have read
`app-server request thread/fork timed out after 30000ms` and my sentinel branch would have been
decoration.

I first fixed it locally: an optional `channelMarginMs` on `requestWithinDeadline`, **defaulting to
0** so P2.245's caller kept the behaviour it shipped with, passed explicitly from my two call sites.

**A third coordinator message then arrived, and it was right to.** The P2.245 wave landed
(`2644a82f3`, `7603a61d2`) converging on my name and making the margin **unconditional** — no
parameter, no default. A default of `0` is the defect itself with a longer fuse, and re-applying my
file from my own copy would have restored it. So the parameter is **withdrawn**: my call sites take
the shared helper's unconditional margin and pass four arguments.

Verified in the committed blob: `channelMarginMs` occurs **0** times,
`CODEX_DEADLINE_CHANNEL_MARGIN_MS` **6**, `CODEX_THREAD_REFORK_TIMEOUT_MS` **3**.

**The blind spot it came from is closed here, and pinned reciprocally.** P2.245's five tests all used
a double that DROPS the options argument, so the suite was green with and without the client-side
timer. The doubles in this file **honour `timeoutMs`** — a silent method rejects after exactly the
timeout the caller passed, with `AppServerClient`'s own wording, verbatim — and one test asserts the
surfaced message is the sentinel's and NOT the channel's. `ignoreChannelTimeout` keeps the dropping
channel as an explicit case rather than an accident. **Break B5 removes the shared margin and kills
three of these seven tests**, so the margin is now pinned from this side too.

---

## 6. Verification

`bun run typecheck:shared` — clean (no diagnostics).

`bun test .../codex-refork-deadline.test.ts` → **7 pass / 0 skip / 0 fail**, 22 expect() calls.

Final run, my file plus four sibling codex suites (`codex-runtime-handoff`, `codex-background-terminals`,
`codex-agent-lifecycle-hooks`, `codex-model-switch`):
**78 pass / 0 skip / 0 fail**, 5 files, 55 s. Nothing in the known-failing register
(`2026-07-29-known-failing-tests.md`) names any of them.

### 6a. Re-break campaign

Each break applied to the shipped file alone, suite re-run, file restored from a byte-checked copy.

| # | Break | Result |
| --- | --- | --- |
| B1 | remove the fork's deadline (back to bare `client.request`) | test 1 fails; the run then **hangs and never ends** — killed by an outer watchdog at 75 s having printed nothing further. Bun's own 5000 ms per-test timeout did **not** end it. |
| B2 | fallback leg gets a FRESH budget (per-call ceiling) | kills only test 4 — 487 ms elapsed against a 390 ms limit |
| B3 | let a timed-out fork take the `thread/start` fallback | kills tests 2, 3, 4, 6, 7 (2 pass / 5 fail) |
| B4 | record the drift as applied BEFORE the fork answers | kills only test 2 |
| B5 | remove the shared channel margin (the sibling's fix) | kills tests 2, 3, 7 — the channel's rejection wins and the sentinel branch goes dead |
| B6 | halve the fork's effective bound | kills tests 1, 4, 5 |

B1 is the strongest evidence and it is stronger than P2.245's break 4: there, removing the deadline
hung four tests **into bun's 5000 ms timeout**; here nothing ended the run at all. A hang is not a
red test — it is a run that prints nothing and never ends, and only an outer watchdog separates it
from a slow one. I used one.

B2 is the reason test 4 exists in its current form. Its **first** version passed under the per-call
break: with leg one refusing instantly, "a fresh budget" and "the remainder of a shared one" are the
same number. The refusal had to be given a cost (60% of the budget) before the two designs became
distinguishable. Exactly the shape P2.245 hit — a walk-vs-ceiling claim is unpinned until a break
forces the test that separates them.

B3's blast radius is wide because it is a structural change, not a value change: with the sentinel
allowed through, `result.thread?.id` is `undefined` and every test asserting the deadline's own
message fails. Every test it kills is one whose proposition it violates.

### 6b. Not re-run needlessly

Per the implementation-first budget: focused tests for the changed behaviour, the affected package's
typecheck, and the directly affected contract suites. No full-repo run, no build, no packaging.

---

## 7. What else is still unbounded — the "one step past" pass

Every `client.request` in `codex-agent.ts`, classified. **The brief named three follow-ons, all off
the per-turn path. There is a fourth that is ON it, and it is the one worth taking next.**

| call site | awaited? | on a per-turn path? | state |
| --- | --- | --- | --- |
| `thread/fork` + `thread/start` fallback | yes | **yes — every model / plugin / sandbox change** | **bounded by this row** |
| `thread/backgroundTerminals/list` | yes | yes — every turn | bounded by P2.245 |
| **`thread/inject_items`** | **yes** | **yes — the head of the first turn after a runtime switch** | **UNBOUNDED — new finding** |
| `thread/compact/start` | yes | yes — a `/compact` turn | UNBOUNDED, and legitimately long |
| `initialize`, `thread/start` (spawn) | yes | spawn only | UNBOUNDED — P2.232 owns them |
| `turn/start` | `void` | — | cannot hang a turn; leaks a pending entry on a silent server |
| `turn/steer` | not awaited directly | the turn's sink close waits on it | bounded by per-turn DETACHMENT + Stop; deliberate, documented |
| `thread/approveGuardianDeniedAction` | `void` | — | cannot hang a turn |
| `fuzzyFileSearch` | yes | no — completion popup | UNBOUNDED (named by P2.245) |
| `thread/backgroundTerminals/terminate` | yes, x4 sequential | no — Stop button | UNBOUNDED (named by P2.245) |
| `turn/interrupt` (in `abort()`) | yes | no — Stop path | UNBOUNDED (named by P2.245) |

### The fourth call, `thread/inject_items` — recommended as the next row

`deliverRuntimeHandoff` awaits `client.request('thread/inject_items', …)` with no bound, and
`chatImpl` awaits `deliverRuntimeHandoff` on the turn's critical path, **between the re-fork this row
just bounded and `turn/start`**. Same symptom, same path, one method further along.

Two things make it cheaper than this row rather than harder:

1. **It already degrades correctly on a throw.** Its `catch` falls back to the text handoff in the
   same turn. So unlike the fork, a deadline there wants the sentinel handled exactly like an error —
   take the fallback — and no new user-facing failure mode is introduced.
2. **Its bound is easy to justify:** it is an insert of already-materialised items, in the same
   family as the calls measured here.

It fires only when a runtime switch armed a payload — once per switch, not every turn — which is why
it is a smaller blast radius than this row, not a larger one. It was not in the brief's list.

`thread/compact/start` is the other awaited per-turn-path call, but it is P2.232-shaped rather than
P2.257-shaped: `app-server-client.ts` names it among the operations that "carry genuinely long
operations", it re-sends the conversation to the model, and a bound on it needs a cold-model
distribution the same way `initialize`/`thread/start` do. It should be attached to P2.232's row
rather than copied from this one.

---

## 8. Concerns

1. **30 s is a judgement, not a measurement.** The measurements bound the resting state (max 1509 ms
   warm, sublinear in history); the multiplier is chosen for the asymmetry in §2d. If a live session
   ever trips it, the fix is a progress signal, not a shorter bound — the same conclusion P2.245
   reached about its own.
2. **A wedged app-server now costs 30 s at the head of any turn that changes model or policy**, once,
   with no latch. Deliberate: a deadline is transient, and latching a re-fork off would mean running
   turns under a config the user did not choose.
3. **The margin was nearly re-armed to zero by my own copy.** Resolved (§5) and verified in the blob,
   but it is worth recording that the mechanism was a stale local copy of a file two lanes were
   editing — see concern 5.
4. **The host is the noise floor in every number here.** Other lanes' suites were running throughout;
   the within-condition spread is theirs, not codex's. The conclusions are drawn from maxima, which
   is the conservative direction, but a quiet machine would give tighter numbers.
5. **`codex-agent.ts` moved under me TWICE mid-task, and my own re-break loop was part of the
   problem.** `8cf4d726d` (a P2.195 doc block) landed first; then the whole P2.245 wave
   (`2644a82f3`, `7603a61d2`). Worse, my re-break script restored the file from a copy taken before
   both — which is very likely the "rewritten under it twice" the other lane measured. Both times the
   fix was the same: reset the file to HEAD and re-apply my two hunks, never write from the copy.
   Committed through an isolated `GIT_INDEX_FILE` with an `update-ref` old-value guard, then verified
   reciprocally — deletions against `7603a61d2` are mine alone, the P2.195 block is intact (1
   occurrence), and the sibling's margin is present and unconditional.

   **The general lesson, for whoever holds this file next:** a re-break campaign that restores from a
   saved copy is a *writer* to a file other lanes are editing, for as long as it runs. Restore from
   `git show HEAD:<path>` plus a re-applied patch, or hold the file for the duration — not both.

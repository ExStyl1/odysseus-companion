# P2.260 — `thread/inject_items` is bounded; the fallback it already had is now reachable

Branch `feat/TCODE-000`. Commit **`4c9738d8b`**, parent `aff63a1c6`. Two files:

- `packages/shared/src/agent/codex-agent.ts` (+108/−3)
- `packages/shared/src/agent/__tests__/codex-inject-items-deadline.test.ts` (new, 355 lines, 7 tests)

Committed with `git commit <pathspec>` on exactly those two paths. `codex-agent.ts` was
verified **clean in the working tree** before I touched it (both sibling lanes had
already committed), so the pathspec could only take my own content; the committed
diff is four hunks, all mine, and carries no sibling-lane markers and no
`Co-Authored-By`.

**Doc classification (the binding rule from `6d2298780`): category (a) — our own
implementation.** The defect and the fix are entirely this repo's code: `Promise.race`
ordering, `AppServerClient.request`'s opt-in `timeoutMs`, and how long a caller of ours
chooses to wait. `thread/inject_items` itself is a codex app-server RPC, but none of the
three Codex contract pages (`plugins/build/plugins.md`, `learn.chatgpt.com/docs/hooks.md`,
`plugins/deploy/submission-errors.md`) govern RPC timeout policy, and no Claude page is in
scope at all. **I did not go looking for a page to cite.**

---

## 1. Reproduced first, against the unbounded call

The whole defect is "a hung `thread/inject_items` cannot reach its own `try/catch`", so
that is what the reproduction had to show, and it is what the tests pin.

**Rig.** The new suite, run against `codex-agent.ts` with the deadline removed — i.e. the
shape that shipped at HEAD (`await this.client!.request('thread/inject_items', {…})`), the
sentinel check left in place but dead. Restored from `git show HEAD:<path>` plus a re-applied
patch each cycle, never from a saved whole-file copy (§6).

```
 2 pass
 5 fail
Ran 7 tests across 1 file. [7.93s]
```

The two decisive failures:

```
(fail) settles a silent inject instead of hanging the turn …
  expect(outcome.settled).toBe('value')   Expected: "value"   Received: "PENDING"   [2404 ms]

(fail) lets the SENTINEL win on a channel that honours timeoutMs …
  const line = debugLines.find(l => l.includes('[runtime-handoff] thread/inject_items'))
  expect(line).toBeDefined()              Received: undefined
```

`PENDING` is the watchdog: `deliverRuntimeHandoff` had not settled after 2 400 ms against a
double that accepted the request and never answered. And the `catch`'s **own debug line
never fired** — that is the reproduction stated exactly: the fallback existed, was correct,
and was unreachable.

**Mechanism, precisely.** `AppServerClient.request` (`packages/codex-agent-server/src/app-server-client.ts:90`)
arms a timer **only** when the caller passes `options.timeoutMs`, and settles otherwise on a
matching response or on `close()`. This call passed two arguments. So no timer, no
rejection, no `catch`, and `chatImpl` — which does
`effectiveMessage = await this.deliverRuntimeHandoff(effectiveMessage)` three lines above
`turn/start` — waits forever. The turn prints nothing and ends never.

---

## 2. The measurement, and why the bound is 30 s

**A distinct number was NOT invented.** `CODEX_INJECT_ITEMS_TIMEOUT_MS` is declared as an
**alias** of `CODEX_THREAD_REFORK_TIMEOUT_MS` (`= CODEX_THREAD_REFORK_TIMEOUT_MS`, not a
re-typed `30_000`), so the two cannot drift apart. `CODEX_DEADLINE_CHANNEL_MARGIN_MS` is
inherited unchanged from the shared helper — this row adds no margin logic of its own.

I measured anyway, because the brief asks for the number either way and because P2.257's
row was written by analogy and its analogy was wrong.

**Rig.** The bundled binary
`apps/electron/resources/bin/codex/darwin-arm64/codex-app-server` (reports `0.148.0`),
driven the way `codex-inject-items-e2e.test.ts` drives it — real `CodexRuntimeManager`
spawn, real `AppServerClient`, the shipped `writeCodexConfig`, and the product's own item
shape from `buildCodexInjectItems`. No provider is contacted (`thread/inject_items` starts
no turn). 2026-08-27, two runs, **111 samples**.

| payload | run 2 | run 1 |
| --- | --- | --- |
| 2 items, ~0.2 KB | 7.5–56.5 ms, p50 10 (n=20) | 24–876 ms (n=8) |
| 24 items, ~30 KB | — | 452–591 ms (n=8) |
| 200 items, ~407 KB | 19.4–106.5 ms, p50 32 (n=20) | 41–**15286** ms (n=6) |
| 600 items, ~2.4 MB | 49.9–119.2 ms (n=6) | 58–118 ms (n=6) |
| 1000 items, ~9.8 MB | 98.7–174.5 ms, p50 127 (n=10) | 145–170 ms (n=4) |
| cold first call, fresh thread | 267 ms | 2500 ms |

**Three findings.**

1. **The real work is 7–175 ms across a 50 000x payload range.** Sublinear, and orders of
   magnitude cheaper than `thread/fork` (P2.257: 239–1509 ms warm).
2. **It does not grow with the ROLLOUT.** Run 2 drove the rollout from 0 to **159 MB** and
   the per-call numbers stayed flat — the cost tracks the payload being inserted, not the
   thread's accumulated history. So a long session cannot walk itself into the bound.
3. **Run 1's scatter is the HOST, and I checked rather than assumed.** Run 1 produced a
   876 ms answer to a **200-byte** payload and one **15.3 s** sample at 407 KB, while its
   largest payloads were its fastest calls — an ordering that cannot be real work. Twenty
   repeats of that identical 407 KB call in run 2 topped out at 106.5 ms. Both runs shared
   the machine with four other test lanes (load average 9–15, ~23 concurrent `bun`
   processes) — the same caveat P2.257 recorded.

**Why 30 s and not P2.245's 5 s.** The asymmetry genuinely argues for a shorter bound:
unlike the re-fork, this call *degrades*, so a bound that fires early costs the
native-history upgrade rather than the turn. The measurement overrules it. 5 s would be
~29x the slowest honest answer but **would have fired on the 15.3 s sample** — a bound
sized below a floor this hardware had already been observed under, which is the
narrowing-knob trap AGENTS.md records. The 15.3 s sample is kept in the record rather than
discarded as an outlier, because it happened on real hardware and a user's laptop is a busy
machine too. 30 s is ~170x the slowest honest answer and ~2x the worst pathological one.

**Cost of that choice, stated plainly:** a wedged app-server now holds the head of a
handoff turn for 30 s once, then degrades. That is the concern in §7.

---

## 3. The fix shape — it does NOT throw, and how the sentinel reaches the `catch`

The brief was explicit and so is the code: **no new degradation path was designed, because
one already existed.**

```ts
try {
  const result = await requestWithinDeadline(
    this.client!, 'thread/inject_items', { threadId: this.threadId, items }, timeoutMs,
  );
  if (result === CODEX_REQUEST_TIMED_OUT) {
    throw new Error(`thread/inject_items did not answer within ${timeoutMs}ms`);
  }
  …
} catch (error) { /* the fallback that was already here */ }
```

**How the sentinel reaches the `catch`: it is converted to an `Error` *inside the `try`*.**
That is the whole mechanism, and it is deliberately the one thing P2.257 forbids itself.
The alternatives were both worse:

- returning the fallback from a sentinel branch **outside** the `try` would give this method
  two places for the text build, the `markRuntimeHandoffApplied('text')` call and the
  empty-text guard — three things to keep in sync instead of one;
- letting `requestWithinDeadline` reject instead of resolving a sentinel would undo the
  reason the sentinel exists (P2.245's comment: a deadline is the *absence* of an answer,
  not something a classifier may read).

`deliverRuntimeHandoff` therefore **never rejects on a deadline**. Test 2 asserts the
resolved value, not a rejection.

**Nothing classifies the thrown message, and I checked rather than assumed.** This method
has no capability latch; `isDefinitiveBackgroundTerminalsRefusal` belongs to a different
call; the `catch` only debug-logs what it caught. The message still carries no serde token
and no `code`, so it would read as transient if that ever changed.

**One existing line reworded.** The `catch`'s debug line said `thread/inject_items refused
(…)`. A request the app-server never answered was not *refused*, so it now reads `did not
deliver (…)`. `rg` over `packages/` finds that string in exactly one place — the source —
so no test, doc or checklist depended on the old wording.

---

## 4. The tests, and the blind spot they are built against

`codex-inject-items-deadline.test.ts`, 7 tests, 31 `expect()` calls. Patterned on
`codex-refork-deadline.test.ts`.

| # | Proposition |
| --- | --- |
| 1 | a silent inject **settles** — on a channel that DROPS `timeoutMs`, so only the race can save it |
| 2 | expiry **degrades and does not throw**: returns the exact text-fallback string, `applied === ['text']`, `pendingRuntimeHandoff` null, both debug lines present |
| 3 | the **sentinel wins the production race** on a `timeoutMs`-honouring channel, and the channel is still armed a whole margin later |
| 4 | **production takes the constant** — the only place the shipped number reaches the wire |
| 5 | a **slow-but-answering** inject is not degraded (`applied === ['native-inject']`) |
| 6 | the **success path leaks no timer**, with a positive control |
| 7 | a **real rejection still degrades exactly as before** — one fallback path, not two |

**The double honours `timeoutMs`** (three arguments, arms its own timer only when the caller
opted in, rejects with `AppServerClient`'s wording verbatim). `ignoreChannelTimeout` keeps
the option-dropping channel as an **explicit case** rather than an accident. That is the
blind spot this plan has been burned by twice: a double that drops the option is green with
the behaviour and without it.

**Hangs are turned into red tests, not quiet ones.** Every wedged-call assertion goes
through a `settleWithin` watchdog that resolves `'PENDING'`. This matters concretely: on
P2.257's break B1 the equivalent run **hung and never ended**, and bun's own 5 000 ms
per-test timeout did not end it. Under my watchdog the same class of regression comes back
as `Expected: "value"  Received: "PENDING"` in 2.4 s.

**Test 6 has a positive control on the same rig**, because an absence claim without one is
worthless. `setTimeout`/`clearTimeout` are wrapped for the duration of one delivery; a timer
is then armed *through the wrapper* and deliberately never cleared. The assertions are that
the detector **can** see that leak (`armed` contains it, `cleared` does not) and that no
other armed timer survived. Under re-break A the same test fails on `armed.length > 1` —
i.e. it also detects "no timer was armed at all", which is the state that would make the
absence vacuous.

**What is NOT covered, stated rather than implied.** There is no `chat()`-level deadline
test. `chatImpl` calls `deliverRuntimeHandoff` with one argument, so an end-to-end deadline
test would take the production 30 s — too slow and too flaky to be worth it. Test 4 pins
that `chatImpl`'s call arrives with production's budget, test 2 pins the exact returned
string, and `chatImpl` assigns that return value straight into `effectiveMessage`; the
existing `codex-runtime-handoff.test.ts` already drives the rejection path end-to-end
through `chat()` to `turn/start`.

---

## 5. Re-breaks — three, all of them killed something, and none redundant

Each break applied to the fixed file, suite re-run, file restored from `git show HEAD:` plus
the patch. The break script **refuses to apply if its anchor is not found exactly once**, so
a break can never silently apply nothing (which would report a surviving mutant as killed).

| # | Mutation | Result |
| --- | --- | --- |
| **A** | the deadline removed — the shape that shipped | **2 pass / 5 fail**: tests 1, 2, 3, 4, 6. Both hang tests returned `PENDING`; the `catch`'s debug line never fired. |
| **B** | `CODEX_DEADLINE_CHANNEL_MARGIN_MS` removed from the shared helper | **5 pass / 2 fail**: tests 2 and 3. The channel's rejection wins, so the surfaced line becomes `app-server request thread/inject_items timed out after Nms` and the sentinel branch goes dead. |
| **C** | the sentinel NOT routed into the `catch` (throw deleted, fall through) | **4 pass / 3 fail**: tests 1, 2, 3. Expiry gets recorded as `native-inject` and returns the bare prompt — the delivery the user was promised, silently reported as having happened. |

**B is the one worth reading twice.** It is the sibling's fix, not mine, and it kills two of
my tests — so the margin is now pinned from a third side. Note the shape of what it breaks:
under B the *outcome* is still a text fallback, so only the **debug line** can tell the two
apart. That is why test 3 asserts on wording rather than on the returned value, and it is
exactly the assertion whose absence let a dead sentinel ship green on P2.245.

---

## 6. Gate — and the contract each command proves

| Check | Command | Result |
| --- | --- | --- |
| the new bound behaves as specified, and the two siblings' bounds still do | `bun test` on `codex-inject-items-deadline`, `codex-runtime-handoff`, `codex-refork-deadline`, `codex-background-terminals` — through the mutex, on the **exact committed content** | **71 pass / 0 fail / 0 skip**, 4 files, 41.4 s |
| the changed call site did not break the wider codex contract set | same plus `codex-config-requirements`, `codex-thread-scoping` (pre-commit content, comment-only delta since) | **97 pass / 0 fail**, 6 files, 109.6 s |
| the new signature and the aliased constant typecheck | `bun run typecheck:shared` | **exit 0**, no diagnostics |
| style/lint on both changed files | `npx eslint` from `packages/shared` (the package owns the flat config; a root `eslint` call finds none) | **exit 0**, no output |
| no whitespace damage | `git diff --check` | **exit 0** |
| commit isolation | `git show --stat HEAD` + hunk/marker inspection | 2 files, 4 hunks, all mine, no `Co-Authored-By` |

**Not run, deliberately** (implementation-first budget): full-repo test, lint or typecheck,
builds, packaging, live smokes. Nothing outside `packages/shared/src/agent` changed, and the
only shared code path touched is `requestWithinDeadline`, whose other two callers are in the
four suites above. Nothing I ran appears in
`docs/superpowers/specs/2026-07-29-known-failing-tests.md`.

**The re-break writer trap, handled.** Restores went through
`git show HEAD:packages/shared/src/agent/codex-agent.ts > … && git apply <patch>`, re-reading
HEAD every cycle — never from a saved whole-file copy. That is P2.257's concern 5, and it is
what nearly re-armed the margin defect last night. The re-break driver also carries an
`EXIT` trap that restores the fixed file, so a killed run cannot leave a broken file behind.

**Host toolchain failure, and what it did and did not touch.** Xcode's licence stopped
`/usr/bin/git` and `/usr/bin/python3` on this machine around 17:38. It hit me twice — a
`git status` and a `python3` edit — both of which failed **loudly** with the licence message
and were re-run under `/opt/homebrew/bin`. **No re-break restore ran under the broken git:**
the restore script sets the corrected PATH itself and uses `set -e`, and the first re-break
was applied after the switch. I re-verified the file's state after every restore (the script
prints its own `git diff --stat`, which read `1 file changed, 99 insertions(+), 3 deletions(-)`
every cycle).

---

## 7. Concerns

1. **30 s is a judgement resting on one pathological sample.** The honest measurement says
   7–175 ms; the 15.3 s outlier is what rules out 5 s, and it was never reproduced in 20
   repeats of the identical call. If a quiet-machine re-measurement never sees anything
   above ~200 ms, the case for dropping this to 5 s (and folding it into
   `CODEX_BACKGROUND_TERMINALS_TIMEOUT_MS`'s "instant, local query" family) gets strong —
   this call degrades, so a shorter bound is cheap here in a way it is not for P2.257.
   I chose the conservative direction because a false degrade silently downgrades history
   the user was shown a promise about.
2. **A wedged app-server now costs 30 s at the head of a handoff turn**, once, then the
   text handoff carries the history and the turn proceeds. Deliberate, and strictly better
   than the forever it cost before — but it is 30 s of a turn that looks stalled, with no
   progress signal. Same conclusion both siblings reached: if this ever fires in a live
   session, the fix is a progress signal, not a shorter bound.
3. **The alias couples two numbers on purpose, and that is a trade.** Changing
   `CODEX_THREAD_REFORK_TIMEOUT_MS` now silently moves the inject's bound too. I judged
   drift the worse failure (two numbers for one judgement is a second rule to keep true),
   and the constant's comment says so explicitly — but a future row that wants them to
   differ must un-alias deliberately rather than by editing one literal.
4. **Every number in §2 was taken on a contended host.** Four other lanes were running
   throughout; the within-condition spread is theirs. Conclusions are drawn from maxima,
   which is the conservative direction, but a quiet machine would give tighter numbers and
   might change concern 1.
5. **`thread/compact/start` is still unbounded on a per-turn path** (`chatImpl`, the
   `/compact` branch). Confirmed still true on this HEAD. It is P2.232-shaped rather than
   this shape — `app-server-client.ts` names it among the operations that "carry genuinely
   long operations", and it re-sends the conversation to the model — so it needs a
   cold-model distribution, not a copy of this row. Left alone, as both siblings advised.
6. **The measurement probe is not committed.** It lives at
   `…/scratchpad/sdd2/p2260-measure-final.ts` (it needs the repo's `node_modules` to
   resolve `@nessy-agent/*`, so it must be copied into the tree to run — I ran it from
   `packages/shared/src/agent/__tests__/p2260-measure.probe.ts` and removed it before
   committing). Anyone re-measuring on a quiet machine can drop it back in place.

# P2.245 fix wave — the sentinel now wins, so the signal fires

Branch `feat/TCODE-000`. Commit SHA: **`2644a82f3d9c9af12def6d0c2bd2c54edb5508d0`**,
parent `b8e3f2478`. Blobs derived from `6d89100d6`; both my paths verified byte-identical
between that tree and the commit's parent, so nothing was rebuilt on stale content.
Two files: `packages/shared/src/agent/codex-agent.ts` (+79/-12 lines) and
`packages/shared/src/agent/__tests__/codex-background-terminals.test.ts` (+170).

**Committed through an isolated `GIT_INDEX_FILE`** (HEAD's tree, two blobs swapped,
`commit-tree`, `update-ref` with the old-value guard) because the P2.257 lane holds
`codex-agent.ts` in the working tree — a `git commit <pathspec>` would have taken
their uncommitted state. The working tree was then reconciled so the reverse cannot
happen either (see Correction 2).

**Doc classification (the plan's new brief rule, landed in `6d2298780` while this
lane ran):** this row is **category (a) — our own implementation**. `Promise.race`
ordering, `AppServerClient`'s opt-in `timeoutMs`, and the codex app-server's
`thread/backgroundTerminals/*` family are all either this repo's own code or
undocumented binary behaviour the row established by measurement. **No Claude or
Codex doc page governs it, and I did not go looking.**

---

## I1 — reproduced first, then closed

### Reproduction against the COMMITTED code

A double faithful to `AppServerClient.request` (three arguments; arms its own
`setTimeout` from `options.timeoutMs`; rejects with that class's exact message).
Scenario: page 1 answers `{data:[{processId:'1'}], nextCursor:'P1'}`, page 2 never
answers, budget 60 ms.

```
CALLS: 2
SEEN TIMEOUTS: [59.99970899999994, 59.70074999999997]
EVENTS: []
DEADLINE LINE: false
TRANSIENT LINE: true
DEBUG: ["Codex background-terminal poll failed transiently, will retry next turn
        (app-server request thread/backgroundTerminals/list timed out after
        59.70074999999997ms)."]
```

Identical to the reviewer's measurement in every particular, including the
fractional milliseconds of Minor 1 arriving in the same line.

### Mechanism, stated precisely

`client.request(...)` is evaluated first in the `Promise.race` **array literal**,
so `AppServerClient` registers its `setTimeout` before `requestWithinDeadline`
registers the sentinel's. Both were armed with the same `remainingMs`, so the
client's rejection was always due first and always won. The sentinel branch was
reachable only from a double that ignores `timeoutMs` — which all five tests were.

### Fix

`CODEX_DEADLINE_CHANNEL_MARGIN_MS = 50`, applied **inside**
`requestWithinDeadline`: the channel is handed `Math.ceil(timeoutMs) + 50`, the
race keeps the exact `timeoutMs`. Deliberately **not a knob** — every caller of
this helper is written around the sentinel arm, so a margin a caller could forget
to pass is the same defect with a longer fuse. The channel's timer stays armed
because it is the only thing that deletes the pending entry and its `reject`
closure from the client's map; it simply loses.

### Post-fix measurement (same scenario, same double, isolated rig)

```
RIG MARKER: p2245fix-wt-rig-6d89100d6      <- positive control, absent at HEAD
SEEN TIMEOUTS: [110, 109]                  <- whole ms, margin present
EVENTS: [{"type":"shell_backgrounded","toolUseId":"codex-bgterm:1","shellId":"1"}]
DEADLINE LINE: true
TRANSIENT LINE: false
DEBUG: ["Codex background-terminal listing did not answer within 60ms; the turn
        starts anyway and the set is treated as incomplete (announcements only,
        no completions). Retrying at the next turn boundary."]
```

Both consequences the review named are closed: the operator line fires, and the
page that had already arrived is announced instead of discarded.

---

## The false durable comment — corrected to the mechanism that holds

`CODEX_REQUEST_TIMED_OUT`'s doc said *"Resolving a sentinel means a deadline
cannot reach the classifier at all."* On the shipped channel that was false. It is
now corrected in place rather than deleted, and it records **both** mechanisms and
which one is load-bearing:

- the sentence is true **only because** the margin makes the sentinel win — stated
  as a dependency, with a `{@link}` to the constant;
- it did **not** win as first shipped, so every production deadline reached the
  `catch`;
- nothing latched even then, but by a **second, unclaimed** mechanism: the
  channel's `app-server request <method> timed out after <n>ms` carries no serde
  token and no `code`, so `isDefinitiveBackgroundTerminalsRefusal` returns false
  and P2.243's `DEFINITIVE_REFUSAL_CODES` never sees it;
- that second mechanism is kept as belt-and-braces, and named as **one reworded
  upstream message away from untrue** — which is the fragility the sentinel exists
  to remove.

The measured evidence for the second mechanism is in the reproduction above: the
message landed on the **transient** arm, not the definitive one.

`requestWithinDeadline`'s own doc gets the same treatment: its "TWO mechanisms"
paragraph described a race that could not win, and cited the option-dropping
doubles as if that were the point rather than half the coverage.

---

## I2 — the tests, and why the old five could not see any of this

The five that shipped drive a double whose `request` takes two arguments. They
pass **identically** with the production behaviour and without it. Added a second
double, `makeTimeoutHonouringAgent`, faithful to `AppServerClient.request`, and
five tests on it:

1. **the sentinel wins on a honouring channel** — deadline line present, transient
   line absent, and the page that arrived still announced;
2. **a deadline there is still transient** — no latch, `backgroundTerminalsUnsupported`
   still false after two walks;
3. **whole milliseconds, and more of them than the race gets** — `Number.isInteger`
   plus strictly greater than the caller's budget (Minor 1 + the margin);
4. **the DEFAULT budget on the wire is the 5 000 ms constant** (Minor 2 — every
   other test in the row passes its own small number, so nothing pinned the number
   production uses; a default drifting to `undefined` restores the exact hang);
5. **the loser's late rejection is not an unhandled rejection** — a
   `process.on('unhandledRejection')` capture across the margin window, because
   letting the sentinel win means the channel's timer now fires *after* the caller
   has moved on.

**(5) has a positive control, because an absence assertion without one is
worthless.** Ran the detector against a deliberate unhandled rejection AND
against a `Promise.race` whose loser rejects later, in the same runtime:
`CAPTURED: ["deliberate"]` — it fires for a real one and stays silent for the
race's loser, which is exactly the discrimination the test relies on. (Control
run under `bun <file>` rather than `bun test`; same process-level event.)

The block comment above the original five is corrected to say what each group
pins, so the next reader does not repeat the mistake.

---

## Re-breaks — both killed, and the first one demonstrates I2 directly

| Re-break | Mutation | Result |
| --- | --- | --- |
| **A** | the margin removed: `{ timeoutMs }` (the shape that shipped) | **44 pass / 3 fail** — the three new production-channel tests. **All five original P2.245 tests still PASSED**, which is I2 in one line. The probe printed `EVENTS: []`, `DEADLINE LINE: false` again. |
| **B** | margin kept, `Math.ceil` dropped | **46 pass / 1 fail** — exactly the whole-milliseconds test. Non-redundant. |

---

## Gate

Run in an **isolated `git worktree` at `6d89100d6`**, not the main tree: the P2.257
lane holds `codex-agent.ts` and rewrote it under me **twice** mid-edit (measured:
my applied edit was gone 30 s later, fully reverted). The worktree got its own
`node_modules` with `@nessy-agent/*` relinked to its **own** packages —
`realpath` confirmed — plus a marker export absent at HEAD, printed by the probe,
so every number above is provably from the tree I edited.

| Check | Result |
| --- | --- |
| zone suite + probe, fixed | **47 pass / 0 fail / 0 skip** (46 zone + 1 probe), 2 files |
| zone suite alone, on the EXACT commit content | **not run — cancelled, see below** |
| `typecheck:shared` on the exact commit content | **clean (exit 0)** |
| `git diff --check` | **clean (exit 0)** |
| `eslint` on both committed files | **clean (exit 0, no output)** |
| re-break A / B | 44/3 and 46/1 as above |
| commit artefact | 2 files, no sibling-lane content (`CODEX_THREAD_REFORK_TIMEOUT_MS`, `channelMarginMs`, rig marker: **0 hits** in the committed blob), no `Co-Authored-By` |

**The one gate I queued and then cancelled, stated plainly rather than quietly
dropped.** I wanted a suite run on the byte-exact commit content. The 47/0 run
above was on that content plus two provably inert additions — an appended
`export const P2245FIX_RIG_MARKER = "…"` (a module-level string literal, the rig's
positive control) and the extra probe file. I removed both, and `typecheck`,
`eslint` and `git diff --check` all ran on the exact artefact and are clean; the
suite rerun was queued behind another lane that held the `bun test` mutex for 20+
minutes. Since the delta cannot change a test result, and a queued run would have
blocked the mutex for four more minutes after I left, I cancelled it (both the run
and its waiters; no orphan processes, verified). **If a reviewer wants that number
anyway, the worktree at `scratchpad/sdd2/wt` still holds the exact content and is
one `bun test` away.**

Not run, deliberately (implementation-first budget): full-repo lint/test, builds,
packaging. Nothing outside `packages/shared/src/agent` changed, and no other suite
touches `requestWithinDeadline` — `codex-config-requirements.test.ts`'s
`{ timeoutMs: 25 }` assertion is on the **other** helper, which is untouched.

---

## Corrections and findings

**1. The brief's remedy was `{ timeoutMs: timeoutMs + 50 }`; I shipped
`Math.ceil(timeoutMs) + 50`.** Same tie-break, and it folds Minor 1 into the same
line: the number handed to the channel is the one an operator reads verbatim in
the channel's own message.

**2. The P2.257 lane had already added the same constant, and its default made it
inert.** Its uncommitted working tree carries
`CODEX_DEADLINE_CHANNEL_MARGIN_MS = 50` as an **opt-in parameter defaulting to 0**,
with a doc paragraph saying P2.245's caller keeps its shipped behaviour "because
correcting it is that row's review to land, not this one's". This is that landing.
I **converged on their name** rather than introducing a second constant, and my
commit applies it unconditionally. In the working tree I changed the default from
`0` to the constant and corrected the now-false DEFAULT-ZERO paragraph; both of
their explicit pass-throughs stay valid (it is a parameter, not an addend, so
nothing doubles). **If that lane re-applies its file from its own copy, it will
silently revert the default back to 0 and re-arm the defect on its two call
sites** — this is the single biggest risk in this hand-off.

**3. P2.138's `requestWithDeadline` has the same test blind spot and NO
behavioural defect.** Its doubles (`silent`) also ignore `timeoutMs`, so its race
arm is likewise never the winner on a real channel. But both arms reject with the
same no-`code` error and the same message text and value, so the outcome is
identical either way. Worth a row for the blind spot, not for a bug.

**4. The inverted `deny_unknown_fields` trap is not in this commit's artefacts.**
Checked with `grep -a`: `codex-agent.ts`'s only nearby claim is that an unsent
**required** field would arrive as serde `missing field` — which the corrected
measurement confirms IS a latching mechanism. The one `unknown field` string in
the test file simulates a `terminate` param-shape refusal, a different struct. The
inverted wording lives in the plan's row notes, which I was told not to edit.

**5. `thread/inject_items` (P2.260) and `thread/fork` (P2.257) were left alone**,
as instructed. My change is in the shared helper both will reuse, so both inherit
the margin the moment they adopt it.

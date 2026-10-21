# W3 — P2.304 (the detector) and P2.303 (the fourteenth-and-onward sites)

Base SHA recorded before any work: **`05733c4ad7c8f4b68dfbdf8e89c44191a9ea7ca2`** (branch `feat/TCODE-000`).
Runner: bun 1.3.14 (0d9b296a). Five other lanes live in the tree throughout.

---

## 1. The detector: design, and whether it actually detects

### 1.1 The premise is CONFIRMED, and it is stronger than P2.304 stated

Measured directly, with a positive control on the same rig:

| rig | user `process.on('unhandledRejection')` fires? |
| --- | --- |
| `bun run` (a plain process — i.e. **production**: Electron main, headless server) | **YES** |
| `bun test` 1.3.14 | **NO** |

Proof of work, verbatim from the probe:

```
PROBE listenerCount(unhandledRejection) before = 0
PROBE bun version = 1.3.14
PROBE listenerCount after register = 1
(fail) ... a genuinely floating rejection: does the listener see it?
```

and the positive control, same mechanism, plain process:

```
PLAIN escaped = ["PLAIN-FLOATING"]
PLAIN VERDICT = LISTENER-FIRED
```

`listenerCount` reads **0 before registration**, so the runner is *not* installing a
competing listener that happens to run first — it intercepts **below `process`**, and a user
listener is never consulted. So `expect(escaped).toEqual([])` **cannot fail**. It is a dead
assertion, and it is the one `detached-automation-event.test.ts:132` carried and that P2.192's
commit message cites as its proof.

### 1.2 A REFINEMENT that P2.304 did not have, and it cuts both ways

The runner is not *completely* blind, and saying so would have been an overstatement. Measured:

| when the escape lands | user listener fires | runner fails the test |
| --- | --- | --- |
| while the test body is still awaiting | no | **yes** — aborts the test, reports a failure |
| after the test body returns | no | **no — completely silent: `2 pass, 0 fail`, exit 0** |

Verbatim, the late-escape probe:

```
PROBE-C test body returned
PROBE-D ran (innocent bystander)
 2 pass
 0 fail
Ran 2 tests across 1 file.
```

So the family was not *entirely* untracked — but detection depended on whether `settle()`
happened to outlast the emission, and when the runner did catch one it named neither the site
nor the fix. That is consistent with a class that kept growing under repeated sweeps.

### 1.3 The detector that was built, and proof that it detects

**Design: run the scenario in a plain `bun` child process and read back what escaped there.**
Chosen over "hook where the runner hooks" because it measures *the surface production actually
has* rather than an artefact of the runner, and it needs no undocumented internals.

- `packages/shared/src/agent/__tests__/fixtures/floating-emission-probe.ts` — the child. Registers
  the listener, runs one named scenario, prints one `__PROBE__{"escapes":[…],"debug":[…]}` line.
- `packages/shared/src/agent/__tests__/floating-emission-escape.test.ts` — spawns it per scenario.

Three properties that the old detector lacked:

1. **Every assertion is a delta against a control that must fail.**
   `base:instructionsLoaded:rebroken` restores the pre-fix shape of
   `BaseAgent.emitDetachedAutomationEvent` **in place** (a bare `void`, no handler) and must
   still show an escape. Measured, after all fixes landed:
   `__PROBE__{"escapes":["log sink exploded"],"debug":[]}` — **the control still fails, so the
   suite is not vacuously green.**
2. **A canary test** asserts the in-process listener is *still* blind. If a future bun starts
   consulting user listeners, that test fails and tells you the subprocess harness can be
   simplified — the only circumstance in which that would be safe.
3. **A watchdog** (`PROBE_WATCHDOG_MS`, default 5 s). Some teardown paths never settle on their
   own; a detector that hangs is a detector people stop running.

**Does it detect? Yes — demonstrated in both directions.** Before the fixes it reported an
escape at every one of the six sites; after, zero escapes plus the required label at each.

### 1.4 P2.192 re-verified: its conclusion SURVIVES, its cited evidence does not

Re-broken in place rather than trusted:

| scenario | escapes |
| --- | --- |
| `base:instructionsLoaded` (fix present) | `[]` |
| `base:instructionsLoaded:rebroken` (pre-fix shape restored) | `["log sink exploded"]` |

So the fix genuinely closes the escape. The row's **claim was right**; only its **measurement**
was void. `detached-automation-event.test.ts` has been amended: the dead assertion is removed,
the test is renamed to what it actually proves (no *synchronous* throw), and the comment now
records the measurement so nobody re-trusts the old shape.

---

## 2. P2.303 — the six survivors. THREE OF THE SIX LINE NUMBERS WERE WRONG

The measurement wins; this is the more valuable half of the row.

| P2.303 said | what is actually there | the real site |
| --- | --- | --- |
| `codex-agent.ts:3334` | `if (this.client && this.threadId && turnId) {` | **`codex-agent.ts:3369`** `void this.emitStopHookOnce()` in `forceAbort()` |
| `codex-agent.ts:3799` | `this.sessionMcpAdvisorAdvertised = null;` | **`codex-agent.ts:3834`** `void this.endLifecycle()` in `destroy()` |
| `nestor-cloud-agent.ts:230` | correct | `void this.emitStopHookOnce()` in `abort()` |
| `nestor-cloud-agent.ts:237` | correct | `void this.emitStopHookOnce()` in `forceAbort()` |
| `nestor-cloud-agent.ts:370` | correct | `void this.endLifecycle()` in `destroy()` |
| `pi-agent.ts:9728` | **an ALREADY-GUARDED site** (`.catch(… reportAutomationEventFault('ConfigChange'…))` at `:9740`) | **`pi-agent.ts:9759`** `void this.endLifecycle()` in `destroy()` |

The two codex numbers are a consistent **−35 line** drift, which is what corroborates the
identification. The pi one is not drift — `9727`–`9740` is a **correctly fixed** site, so the
row would have sent a fixer to inspect a guard and call it a defect.

### The narrative was attached to the wrong file

P2.303's sharpest observation — *"eight lines above it the same method guards a different
floating promise"* with the comment *"a rejection must not surface as an unhandled promise"* —
is **not in `pi-agent.ts`**. That comment exists exactly once in the tree, at
**`codex-agent.ts:3360`**, and the bare sibling is at **`3369`**: eight lines, **same method
`forceAbort()`**. The story is real and precisely as told; it belongs to codex, not Pi.

### The fixes (all six, escape closed AND error labelled)

| site | fix |
| --- | --- |
| `codex-agent.ts` `forceAbort()` | `.catch(… reportDetachedEmissionFault('Automation event Stop', …))` |
| `codex-agent.ts` `destroy()` | `.catch(… reportDetachedEmissionFault('Session lifecycle end', …))` |
| `nestor-cloud-agent.ts` `abort()` / `forceAbort()` | routed through a new `emitStopHookOnceDetached()` |
| `nestor-cloud-agent.ts` `destroy()` | `.catch(… reportDetachedEmissionFault('Session lifecycle end', …))` |
| `pi-agent.ts` `destroy()` | `.catch(… reportAutomationEventFault('SessionEnd', …))` — reuses Pi's existing labelled channel |

**A naming trap that would have failed the build:** `BaseAgent.reportDetachedFault` is
**private**, so a subclass member of that name collides (TypeScript refuses a derived class any
member conflicting with a base one — the same collision `base-agent.ts:474` records for
`PiAgent.describeThrown`). Hence `reportDetachedEmissionFault`, and hence a local
`describe*ThrownValue` in each file: `base-agent.ts`'s `describeThrownValue` is module-private
and **not exported**. Both renderers are total (`String(Object.create(null))` raises — P2.65).

**Reachability differs per backend, and was measured rather than assumed.** `PiAgent` overrides
`debug()` with a try/catch (P2.66's broken-sink floor, `pi-agent.ts:10155`), so the throwing-host-sink
path that makes the emission reject on Codex and Nestor **cannot** reject it on Pi. `pi:destroy`
reported zero escapes under a throwing sink *for that reason and not because the site was
guarded* — which is exactly the kind of false negative that would have closed this row wrongly.
The reachability-independent variant (`:rejecting`, the same technique the P2.192 test uses)
shows the escape, and the fix is still required: "currently unreachable, because of a guarantee
one class away" is not a property a caller can rely on.

### Before / after, verbatim

Pre-fix (reproduction — the defect was seen before it was fixed):

```
codex:forceAbort:rejecting   {"escapes":["automation system is gone"],"debug":[]}
codex:destroy:rejecting      {"escapes":["automation system is gone"], …}
nestor:abort:rejecting       {"escapes":["automation system is gone"],"debug":[]}
nestor:forceAbort:rejecting  {"escapes":["automation system is gone"],"debug":[]}
nestor:destroy:rejecting     {"escapes":["automation system is gone"], …}
pi:destroy:rejecting         {"escapes":["automation system is gone"], …}
```

Post-fix:

```
codex:forceAbort:rejecting   {"escapes":[],"debug":["Automation event Stop could not be delivered: automation system is gone"]}
codex:destroy:rejecting      {"escapes":[],"debug":[…,"Session lifecycle end could not be delivered: automation system is gone"]}
nestor:abort:rejecting       {"escapes":[],"debug":["Automation event Stop could not be delivered: automation system is gone"]}
nestor:forceAbort:rejecting  {"escapes":[],"debug":["Automation event Stop could not be delivered: automation system is gone"]}
nestor:destroy:rejecting     {"escapes":[],"debug":[…,"Session lifecycle end could not be delivered: automation system is gone"]}
pi:destroy:rejecting         {"escapes":[],"debug":[…,"[pi] Pi automation event SessionEnd could not be delivered: …"]}
```

---

## 3. The sweep for a fifteenth — one found, one false positive recorded

Positive control on the sweep itself (`git grep`, byte-honest, not the wrapped `grep`):
`git grep -n "void this.emitStopHookOnce" -- …/codex-agent.ts` → returns the known site. Non-empty,
so the sweep below is worth something.

### FOUND — the fifteenth (one class, two lines), NOT fixed

**`pi-agent.ts:9484` and `pi-agent.ts:9515`** — `this._postCompactHookEmission = undefined;`

`_postCompactHookEmission` is assigned at `:4150` as `previous.then(() => this.emitPostCompactSessionStart())`,
with **no rejection handler**. `emitPostCompactSessionStart` awaits `emitAutomationEvent` and
`applyHookSessionDirectives`, both of which can reject. The one legitimate consumer (`:8922`)
awaits it — but **two paths drop it by assigning `undefined` without awaiting or catching**
(the workspace-change boundary and `clearHistory`). A rejected promise dropped with no observer
is an unhandled rejection. Same family, same file, third sweep.

### FALSE POSITIVE — recorded so it is not re-found

**`codex-agent.ts:1577`** `void Promise.allSettled([...steers]).then(() => sink.finish());` —
shape-matches (single-argument `.then` on a floating promise) but is **not** a defect:
`Promise.allSettled` never rejects, and `finish()` is `done = true; wake?.()` where `wake`
only calls a promise resolver, which cannot throw. Total.

Also checked and **guarded** (two-argument `.then`, so a rejection handler is present):
`codex-agent.ts:3251`, `pi-agent.ts:1870`, `pi-agent.ts:2066`, `pi-agent.ts:6385`.

---

## 4. Findings — each tagged, with its kind

1. **`[doc:none]` — bug.** P2.304 confirmed: the family's detector could not detect.
   Dead assertion replaced; working subprocess detector landed with a failing control.
2. **`[doc:none]` — bug (premise correction).** Three of P2.303's six line numbers are wrong,
   and `pi-agent.ts:9728` names an **already-guarded** site. The narrative belongs to
   `codex-agent.ts:3360/3369`, not Pi.
3. **`[doc:none]` — bug.** The six sites, fixed to escape-closed-and-labelled.
4. **`[doc:none]` — bug, NOT FIXED (new row).** The fifteenth: `pi-agent.ts:9484` / `:9515`
   drop a possibly-rejected `_postCompactHookEmission`.
5. **`[doc:none]` — bug, NOT FIXED, OUT OF ZONE (new row).** `BaseAgent.destroy()` throws
   **synchronously** when the host debug sink throws: `usage-tracker.ts:288` → `base-agent.ts:3365`
   calls `debug` unguarded inside `destroy()`. Measured — it aborted two probe scenarios before
   they reached the site under test. Hosts: `base-agent.ts`, `core/usage-tracker.ts`. **Pi is
   immune** (its `debug` override is belted); Codex and Nestor are not.
6. **`[doc:none]` — forgotten-vs-our-own-standard, NOT FIXED (new row).** Unlabelled `.catch`
   survivors in my zone — escape closed, failure silent:
   `nestor-cloud-agent.ts:233/240/372/382` (`.catch(() => undefined)`), `pi-agent.ts:9682`
   (`.catch(() => {})`), `pi-agent.ts:1911/1912/2065/2101`. Left alone deliberately to keep the
   diff scoped; adding debug lines to teardown paths can move other suites' expectations.
7. **`[doc:none]` — never-looked-at (new row).** `reportDetachedFault` is private in `BaseAgent`,
   so this fix had to duplicate it twice and duplicate `describeThrownValue` twice. Making the
   base helper `protected` and exporting the renderer would let all three collapse to a deletion.
   Blocked on `base-agent.ts`, which is out of zone.
8. **`[remote]` — never-looked-at.** `NestorCloudAgent` had **three** of the six sites, the most
   of any backend, and the nestor remote agent has no external corpus at all.

### STOP-AND-REPORT (out of zone, per the brief)

- **P2.284's outstanding label debt was NOT taken.** Its host is `SessionManager.ts`, which the
  brief names as a stop-and-report file. Untouched.
- Finding 5 needs `base-agent.ts` / `usage-tracker.ts`. Untouched.
- Finding 7 needs `base-agent.ts`. Untouched.

---

## 5. Gates — each with proof of work, none piped

| gate | result | proof |
| --- | --- | --- |
| `tsc --noEmit` (packages/shared) | **PASS** | exit 0, `grep -c "error TS"` = **0**, empty output. Positive control: the same command printed **4** errors minutes earlier (`AbortReason.UserRequested` did not exist), so the gate demonstrably fails when it should. |
| `eslint --format json` (6 changed files) | **PASS** | `files linted: 6 \| errorCount: 0 \| warningCount: 0`, exit 0. Used `--format json` and read `errorCount`, per the `--format unix` trap. |
| `git diff --check` | **PASS** | rc=0, no output. |
| `bun test` (detector + family tests) via mutex | **PASS** | `16 pass / 0 fail / 33 expect() calls / Ran 16 tests across 2 files. [268.01s]`, `EXIT=0`. Output redirected to a file and read whole — never piped. |

Not run, deliberately: full repo suite (brief says no full repo suite).

---

## 6. Test run

`bun scripts/bun-test-lock.ts run --label w3-detector -- bun test floating-emission-escape.test.ts detached-automation-event.test.ts`

The mutex was contended for ~11 minutes (held in turn by `P2.329-consumers`, `w5-p2272-green2`,
`P2.315-drift3`). The run acquired at 01:11:52 and completed:

```
bun test v1.3.14 (0d9b296a)
 16 pass
 0 fail
 33 expect() calls
Ran 16 tests across 2 files. [268.01s]
EXIT=0
```

268 s is a contention figure, not a clean-rig one — five lanes were live, and each of the 13
probe spawns loads the full shared module graph.

**Commit: `804b2d1882abbb65e949f66e0b51d8b02494efc8`** — six files, committed by explicit
pathspec, verified with `git show --stat`:
`codex-agent.ts`, `nestor-cloud-agent.ts`, `pi-agent.ts`,
`__tests__/detached-automation-event.test.ts`,
`__tests__/floating-emission-escape.test.ts` (new),
`__tests__/fixtures/floating-emission-probe.ts` (new).
Other lanes' modifications (`SessionManager.ts`, `pi-harness/*`, i18n, renderer) remained in the
working tree and are absent from the commit.

## 7. Housekeeping

- A 2.4 GB clone was created as a re-break rig and **removed** — the in-place monkeypatch
  re-break (`base:instructionsLoaded:rebroken`) turned out to be the better rig: it needs no
  second tree and it re-breaks the real production shape rather than an old commit's.
- Two worktrees (`nessy-fixwave`, `nessy-gate`) are registered by other lanes and were left alone.
- An earlier apparent "hang" of `codex:destroy:rejecting` (SIGKILL at 25 s, empty output) did
  NOT reproduce and was contention, not a hang. Recorded because timing under five live lanes is
  not evidence — the watchdog was kept regardless, on its own merits.

The probe rig itself was exercised **outside** the mutex throughout (it is `bun run`, not
`bun test`), which is where every before/after number in §2 comes from.

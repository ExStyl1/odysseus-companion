# X1 — P2.334 (the enabling refactor), P2.332, P2.333, P2.330, and a sixteenth site

**Commit: `f27ad5536`** — nine files, committed by explicit pathspec, verified with
`git show --stat`: the four backends, `base-agent.ts`, `core/usage-tracker.ts`, the probe, its
test, and one new codex test. Other lanes' modifications (`2026-07-30-parity-report.md`,
`scripts/build-parity-report.py`, `scripts/regenerate-deviation-register.py`) remained in the
working tree and are absent from the commit — re-verified after committing.

**Base SHA recorded before any work: `09b77d44903d0695afb278515ea9d51260f91e5b`** (branch
`feat/TCODE-000`). Runner: bun 1.3.14 (0d9b296a). Five other lanes live in the tree throughout.

Order followed as briefed: the private helper first. It was the right call and it paid twice —
see §1.

---

## 0. Summary of what changed, and the two places the rows were wrong

| Row | Verdict | Note |
| --- | --- | --- |
| P2.334 | **confirmed in part, CORRECTED in part** | The refactor is exactly as described. But **four of the nine "unlabelled" sites are already labelled** one to four lines away. Five were real. |
| P2.332 | **confirmed** | Fixed at the emission's CREATION rather than at the two drop sites the row names — strictly stronger, see §2. |
| P2.333 | **confirmed, and UNDERCOUNTED** | "Pi is immune; Codex and Nestor are not" is **four of four**, and Pi is affected in a way the row inverts. `ClaudeAgent` is the worst of them. |
| P2.330 | **confirmed** | Fixed in `codex-agent.ts` via `permissionProfile/list`. `[doc:codex]` cited. |
| — | **NEW: the sixteenth site** | A rejection handler that raw-interpolates its own error. Measured escaping, then fixed. |

---

## 1. The refactor first (P2.334's structural half) — and why the order mattered twice

`BaseAgent.reportDetachedFault` is now `protected`. That deleted, as the row predicted:

- `codex-agent.ts`: `describeCodexThrownValue` + `reportDetachedEmissionFault`
- `nestor-cloud-agent.ts`: `describeNestorThrownValue` + `reportDetachedEmissionFault`

Four copies of a ten-line helper, gone. Every call site now reads `this.reportDetachedFault(...)`.

**It paid a second time, unplanned.** P2.333's fix needs a belted report channel inside a
`catch` — and the belted channel *is* `reportDetachedFault`. Had it still been private, the
teardown fix would have had to grow a fifth copy in each of four backends. `runTeardownStep`
is `protected` for the same reason (§4), which is the same lesson one level up.

---

## 2. P2.332 — the fifteenth site, fixed at the source

`pi-agent.ts` `handleSubprocessEvent`, `compaction_end` arm. The stored promise now carries its
own handler:

```ts
this._postCompactHookEmission = previous
  .then(() => this.emitPostCompactSessionStart())
  .catch((error: unknown) => this.reportAutomationEventFault('SessionStart', error));
```

**Deviation from the row, deliberate: the handler is at the CREATION, not at `:9484`/`:9515`.**
Three things one `.catch` per drop site could not do:

1. It covers the **awaiting** consumer too, so a failed post-compaction hook can no longer abort
   the user's very next turn. `emitAutomationEvent`'s own docstring says automations must never
   break the agent flow; before this, the one legitimate consumer `await`ed a promise that could
   reject into prompt composition.
2. It **un-poisons the chain.** Overflow recovery compacts repeatedly and each compaction chains
   onto `previous`. A single rejection left standing propagates through every later `.then` and
   silently stops emitting `SessionStart`/`compact` for the rest of the session. That is a second
   defect the row does not name, and it is closed by the same line.
3. A future third dropper cannot reintroduce the escape.

Both drop sites carry a comment saying they are safe only because of that handler.

### Measured, through the probe, in both directions

| scenario | result |
| --- | --- |
| `pi:postCompactEmission:rebroken` (pre-fix line restored in place) | `{"escapes":["automation system is gone"],"debug":[],"thrown":[]}` — **the control fails, as required** |
| `pi:postCompactEmission` (real seam: `handleSubprocessEvent({type:'compaction_end',…})`) | `{"escapes":[],"debug":[…"[pi] Pi automation event SessionStart could not be delivered: …"],"thrown":[]}` |
| `pi:postCompactDrop` (seam **+ the real drop** via `setWorkspace`) | `{"escapes":[],"debug":[…same label…],"thrown":[]}` |

---

## 3. P2.334 — the nine, of which FIVE were real

The row lists nine `.catch` sites that "swallow without labelling". Measured one by one:

### Genuinely unlabelled — FIXED (5)

| site | fix |
| --- | --- |
| `nestor-cloud-agent.ts` `abort()` / `forceAbort()` / `destroy()` / `disposeForRestart()` (4) | routed through a new `reportCancelFault(what, error)` → `reportDetachedFault('Nestor remote cancel (<what>)', …)` |
| `pi-agent.ts` `emitStopHookOnce()` — `taskPort.notifyTurnEnd` | `.catch(error => this.reportDetachedFault('Task turn-end notice', error))` |

The nestor four matter more than "an operator lacks a name": there is **no server-side
close-session RPC**, so `cancel()` is the entire mechanism, and a swallowed rejection is a live
remote task nobody will ever hear about again (F23). That is the only failure on any of these
backends that leaves state behind **outside the process**.

### ALREADY at the family's full standard — premise correction, NOT fixed (4)

| site | where the name already comes from |
| --- | --- |
| `pi-agent.ts:2065` `void termination.catch(() => {})` | the `.catch` that BUILT `termination` (4 lines up) calls `logSubprocessCleanupFailure(error)` and re-throws to keep the barrier rejected |
| `pi-agent.ts:2101` `void retained.catch(() => {})` | `logSubprocessCleanupFailure(error)` three lines down — the method's own last statement |
| `pi-agent.ts:1911` `void attempt.ready.catch(() => {})` | `spawnSubprocess` **awaits** `attempt.ready`; `cancelSubprocessAttempt` rejects `ready` and `startup` with the SAME error under latches, so a handler here could only log the awaiter's failure a second time |
| `pi-agent.ts:1912` `void attempt.startup.catch(() => {})` | `ensureSubprocess()` **returns** `attempt.startup`; every caller awaits it |

These four exist so that the copy nobody awaited is not *also* an unhandled rejection. Adding a
debug line to any of them is a duplicate, not a label. **All four now carry a comment saying so**,
so the seventh sweep does not re-find them and "fix" them into double logging.

`logSubprocessCleanupFailure` is itself belted (`try { this.debug(...) } catch {}`), so the
existing label already meets the standard's second half.

### Measured

| scenario | result |
| --- | --- |
| `pi:taskTurnEnd` | `{"escapes":[],"debug":["[pi] Task turn-end notice could not be delivered: task registry is gone", …]}` |
| `nestor:cancelRejects` | `{"escapes":[],"debug":[…,"Nestor remote cancel (destroy) could not be delivered: remote cancel refused", …]}` |

Both were escape-closed before, so the delta measured is the **label**. The assertions can still
fail (a missing or misspelled label fails them), which is exactly the pre-fix state.

---

## 4. P2.333 — `destroy()` is total, and the row undercounted WHO

### The row's claim, re-measured

> "Pi is immune; Codex and Nestor are not."

**It is four of four, and each is affected differently.** Positive control on the discriminator:
`git grep "override debug("` over the four backends returns exactly one hit,
`pi-agent.ts:10247`.

| backend | affected? | why, measured |
| --- | --- | --- |
| **Claude** | **YES — worst** | does not belt `debug`, and chains `super.destroy()` **LAST**, so a throw anywhere in its prologue skipped the ENTIRE base cleanup |
| Codex | yes | does not belt `debug`; `super.destroy()` in the middle |
| Nestor | yes | does not belt `debug`; `super.destroy()` last |
| **Pi** | **immune to the named path, for a reason the row does not state** | it belts `debug` **and** it **never chains `super.destroy()`**, so `usageTracker.reset()` is not on its path at all — which leaves its own four steps with no base-class net underneath them |

`ClaudeAgent` is the case the coordinator's survey lane flagged, and the flag was right. The
sharper Claude harm is not the log line: it is that `stopConfigWatcher`, the permission
whitelists, the api-server retention, the **elicitation release** (a promise nobody would ever
resolve) and the **private MCP pool disconnect** (a real connection leak) all sat behind a
prologue that could throw.

### The harm, stated precisely

Not only "a teardown that should be best-effort can take the caller down". **Every step after the
throwing one was skipped.** A broken host log sink silently became a connection leak plus a
stranded elicitation. That is the expensive half and the row does not name it.

### The fix

- `BaseAgent.runTeardownStep(what, step)` — `protected`, `try`/`catch`, reports through the
  already-belted `reportDetachedFault`. A `try` rather than a `.catch` because every teardown step
  is **synchronous**: a synchronous throw skips the remaining statements, it does not become a
  rejection.
- Applied in `BaseAgent.destroy()` **and in all four overrides**
  (`claude-agent.ts`, `pi-agent.ts`, `codex-agent.ts`, `nestor-cloud-agent.ts`). `destroy()` is
  total at the PUBLIC surface or not at all — callers see the override, never `BaseAgent`.
- `UsageTracker.debug` is belted too. The base guard alone would leave this class's **other three
  callers** unprotected, and they are worse: `recordMessageUsage` / `recordTurnComplete` run on the
  per-message hot path, so the same sink would take down message accounting rather than teardown.
- **The contract is written into `destroy()`'s docstring**, as the row asked: *"TOTAL BY CONTRACT
  (P2.333): this method does not throw."* Decided that way because the alternative is unusable —
  `destroy()` is called from session teardown, restart paths and error handlers, i.e. exactly
  where no caller is left able to do anything with an exception.

### Measured, in both directions, four scenarios

| scenario | result |
| --- | --- |
| `base:destroy:usageSink:rebroken` (unbelted tracker `debug` **+** un-isolated step) | `{"escapes":[],"debug":[],"thrown":["log sink exploded"]}` — throws, **and `Base agent destroyed` is ABSENT** |
| `base:destroy:usageSink` | `{"escapes":[],"debug":["Base agent destroyed"],"thrown":[]}` |
| `claude:destroy:prologueThrows:rebroken` | `{"escapes":[],"debug":[],"thrown":["adapter close exploded"]}` — **base cleanup never reached** |
| `claude:destroy:prologueThrows` | `{"debug":["Teardown step claude loopback adapter could not be delivered: adapter close exploded","[UsageTracker] Usage tracker reset","Base agent destroyed"],"thrown":[]}` |
| `pi:destroy:stepThrows:rebroken` | `{"thrown":["subprocess kill exploded"]}`, `PiAgent destroyed` absent |
| `pi:destroy:stepThrows` | `{"debug":["[pi] Teardown step pi subprocess kill could not be delivered: subprocess kill exploded","[pi] PiAgent destroyed"],"thrown":[]}` |

The probe gained a **`thrown` channel** for this: a synchronous throw is not an unhandled
rejection and `escapes` cannot carry it.

---

## 5. P2.330 — the profile that fails open

### Premise: confirmed, and it is already measured in-tree

`docs/superpowers/specs/2026-08-28-codex-sandbox-enforcement.md` §3–§4 carries the measurement
(`rust-v0.148.0`, macOS arm64): the two rejected `extends` arms produced **no RPC error**, wrote
`Invalid configuration; using defaults` to **stderr only**, discarded the whole `config.toml`, and
the negative-control arm **read the decoy secret** while `permissionProfile/list` reported the
profile `allowed: false`.

Positive control that nothing in the runtime consulted it: `git grep -rn "permissionProfile"`
over `packages/shared` and `packages/server-core` returned **zero**; the only hits in the tree were
the protocol schemas, the adapter's own detector test, and the plan/spec prose.

### `[doc:codex]` citation

`learn.chatgpt.com/docs/permissions.md#configuration-spec` (anchor verified by `curl`ing the page **without** `.md` and
grepping `id="…"` — `id="configuration-spec"` is published), on `permissions.<name>.extends`,
verbatim:

> "Starts this profile from another named profile or the built-in `:read-only` or `:workspace`
> profile. Codex rejects `:danger-full-access`, unknown parents, and inheritance cycles."

The page says Codex **rejects**. It does **not** promise the rejection is legible to a client, and
measurement says it is not. So an `extends` accepted on this pin can be rejected by a future one
with no change of ours — which is the whole reason to verify in-band rather than trust the write.

### The fix

`CodexAgent.verifyPermissionProfileAccepted(client)`, called **after `initialize`/`initialized`
and before `thread/start`** — the same window `probeCodexConfigRequirements` uses, and the window
in which `config.toml` has been read but no thread exists yet.

- The declared profile name is **re-derived from `buildCodexRuntimeConfigOverride`**, the same
  builder that wrote it, so it cannot drift from the file. When no profile is declared (no
  filesystem policy → the writer omits `default_permissions`), it returns immediately.
- `cwd: this.workingDirectory` is passed, because `PermissionProfileListParams.cwd` is what
  "resolve[s] project config layers" — without it the answer describes a different layer stack.
- **`allowed !== true` on OUR profile → throw**, refusing the session. That state is unambiguous:
  either the binary refused the profile, or managed `allowed_permission_profiles` forbids selecting
  it. In **both**, the filesystem deny is not in force.
- **Everything else degrades** with a named debug line and starts the session: method absent,
  transport failure, profile missing from the listing. Same contract as
  `probeCodexConfigRequirements` ten lines above, and for the same reason — refusing on "we do not
  know" would brick codex sessions on version drift, a bigger hole than the one being closed.

Six tests in `__tests__/codex-permission-profile-verification.test.ts` cover refuse / accept /
`cwd` / method-absent / profile-absent / no-`data`.

**Not run: a live codex session.** This is a read-only-in-tests change; the shipped-binary half of
the contract is what the enforcement spec already measured. Recorded as a residual, §8.

---

## 6. THE SIXTEENTH SITE — a rejection handler that cannot render its own error

Found by **reading** the `void this.handle*Request(...)` neighbourhood, which no previous sweep
had entered. Every one of the five previous counts was a floor; this is the sixth increment.

### The shape

```ts
this.refreshAndPushTokens().catch(err => {
  this.debug(`Token refresh from parsePiError failed: ${err}`);   // ← raw interpolation
});
```

`${err}` is evaluated **before** `debug` is called, so `PiAgent`'s belted `debug` override cannot
help. `String(Object.create(null))` raises (P2.65, already the reason `describeThrownValue` exists
in this tree). The rejection handler therefore throws, the promise it returned rejects, and the
`.catch` result is floated — **a rejection handler that becomes an unhandled rejection**, which is
the family in miniature.

### Reproduced BEFORE fixing

Probe scenario `pi:tokenRefreshFault` — `refreshAndPushTokens` stubbed to reject with
`Object.create(null)`, then the real `parsePiError(new Error('401 unauthorized'))` with
`authType: 'oauth'`:

```
__PROBE__{"escapes":["No default value"],"debug":[],"thrown":[]}
```

After the fix:

```
__PROBE__{"escapes":[],"debug":["[pi] Token refresh from parsePiError failed: (unrenderable thrown value)"],"thrown":[]}
```

Control `pi:tokenRefreshFault:rebroken` rebuilds the pre-fix handler shape in place and still
reports `{"escapes":["No default value"]}` — so the assertion is not vacuous.

### All instances found and fixed

| file:site | floated? | severity |
| --- | --- | --- |
| `pi-agent.ts` `parsePiError` token refresh | **yes** | **unhandled rejection** (measured above) |
| `pi-agent.ts` `handleSubprocessEvent` auth-error token refresh | **yes** | unhandled rejection, same shape |
| `pi-agent.ts` `runEditFeedback` catch | **yes** (`void`-floated by its only caller) | unhandled rejection; `editFeedbackRunner` is a HOST callback, which is exactly where an unrenderable rejection comes from |
| `pi-agent.ts` `getPiAuth` catch | no (awaited) | breaks the method's `null on failure` contract into a throw |
| `pi-agent.ts` API-key catch | no | same |
| `pi-agent.ts` source-activation deny reason | no | throws out of a catch while building a user-visible message |
| `base-agent.ts` `generateTitle` / `regenerateTitle` catches | no | breaks the documented *"returns null if generation fails"* into a throw at the caller |

All eight now use the total renderer already present in each file
(`PiAgent.describeThrown` / `describeThrownValue`).

### Sweep method, and its recorded negatives

- `git grep` (byte-honest — the wrapped `grep` is `ugrep -G --ignore-files -I` and `-I` skips
  NUL-carrying files at exit 0), plus `/usr/bin/grep -an` for the interpolation sweep.
- **Literal directory pathspecs only.** A `packages/*/src` pathspec returns 0 files at exit 0 —
  confirmed as a live hazard by the coordinator; nothing in this sweep used one.
- Positive control on every absence claim (e.g. `git grep -c "\.catch(" pi-agent.ts` → 16 before
  claiming a pattern found nothing; an early `\s`-based regex returned empty **because `git grep`
  ERE has no `\s`**, not because the sites were absent — caught by that control).
- Recorded negatives, so they are not re-found: `codex-agent.ts:1561`
  (`Promise.allSettled(...).then(() => sink.finish())` — `allSettled` never rejects, `finish()` is
  total; already recorded by W3); `pi-agent.ts` `void this.handlePostToolUseRequest` /
  `handlePreCompactRequest` / `handleToolExecuteRequest` / `handleProcessStartRequest` /
  `handleChildSessionRequest` — each handler owns per-request child/attempt/epoch guards a `.catch`
  out here could not reuse, and `runEditFeedback` is total once its interpolation is fixed;
  `pi-agent.ts:2080` `void termination.then(ok, () => {})` is two-argument, so guarded.

---

## 7. Findings — each tagged, with its kind

1. **`[doc:none]` — bug.** P2.332 confirmed and fixed, at the emission's creation rather than the
   two drop sites. **A second defect closed by the same line:** a rejected link poisoned the whole
   compaction chain, so one failure stopped every later `SessionStart`/`compact` for the session.
2. **`[doc:none]` — forgotten-vs-our-own-standard, PARTIALLY REFUTED.** P2.334's nine are **five**.
   Four (`pi-agent.ts:1911/1912/2065/2101`) are already labelled one to four lines away; a handler
   at any of them is a duplicate. All four are now commented so the next sweep stops.
3. **`[doc:none]` — bug, and the row UNDERCOUNTS WHO.** P2.333 is **four of four**, not "Codex and
   Nestor". `ClaudeAgent` is the worst case (prologue throw skipped the entire base cleanup) and
   the row never names it; `PiAgent` is immune to the named path for a reason the row does not
   state (it never chains `super.destroy()`), which leaves its own steps unprotected. **The harm is
   also understated:** the caller taking a throw is the visible half; the skipped elicitation
   release and MCP pool disconnect are the expensive half.
4. **`[doc:codex]` — bug.** P2.330 confirmed and fixed, cited to
   `learn.chatgpt.com/docs/permissions.md#configuration-spec`. The page's contract is that Codex *rejects*; it says
   nothing about that rejection being legible, and it is not.
5. **`[doc:none]` — bug, NEW (the sixteenth site).** A rejection handler that raw-interpolates its
   own thrown value. Three floated instances are true unhandled rejections (one measured escaping
   before the fix); five more break a documented `null on failure` contract into a throw. Eight
   fixed.
6. **`[doc:none]` — never-looked-at.** `runTeardownStep` had to be `protected` for exactly the
   reason `reportDetachedFault` did. **The private-modifier-forces-duplication pattern is the
   recurring shape here, not an incident** — it has now caused four duplicate helpers (deleted this
   lane) and would have caused four more. Worth a rule: a belted report/guard helper on `BaseAgent`
   should be `protected` by default.
7. **`[doc:none]` — never-looked-at, NOT FIXED, out of zone.** `BaseAgent.destroy()`'s
   `mcpPool.disconnectAll()` is now wrapped **and** `.catch`-ed because those are two different
   failures (a rejected disconnect vs. a `disconnectAll` that throws before returning a promise).
   Whether the pool leak that a failed disconnect leaves behind is retried anywhere is **not**
   examined — nothing in these four files retries it.
8. **`[doc:none]` — never-looked-at, NOT FIXED.** `bun run typecheck:shared` covers
   `__tests__/**`; `tsc --noEmit -p packages/shared/tsconfig.json` run from the package directory
   compiled the same file list here, but a probe edit **after** my typecheck shipped a TS2683 that
   broke four other lanes' gates for a window. The lesson is not the tsconfig, it is the **timing**:
   re-run the gate after the LAST edit, not after the last source edit. Fixed within one action of
   being told; §8 records the cost.

---

## 8. Gates — each with proof of work, none piped

| gate | result | proof |
| --- | --- | --- |
| `bun run typecheck:shared` | **PASS** | `EXIT=0`, `grep -c 'error TS'` = **0**. Positive control that the gate reads my files: `tsc --listFiles` names all five sources plus both probe files. Second, involuntary positive control: this same command printed `floating-emission-probe.ts(421,7): error TS2683` before the fix — the gate demonstrably fails when it should. |
| `eslint --format json` (8 changed files) | **PASS** | `files linted: 8 | errorCount: 0 | warningCount: 0`, exit 0. `--format json` and `errorCount` read, per the `--format unix` trap. |
| `git diff --check` | **PASS** | rc=0, no output, over all nine committed paths |
| `bun test` (emission family + codex profile) via mutex | **PASS** | `35 pass / 0 fail / 68 expect() calls / Ran 35 tests across 3 files. [192.83s]`, `EXIT=0`. Redirected to a file and read whole — never piped. |
| `bun test` (base + usage-tracker + all codex + all nestor suites, 41 files) via mutex | **PASS after attribution** | `553 pass / 11 skip / 4 fail / Ran 568 tests across 41 files. [121.82s]`. The four are attributed below and are NOT mine. |
| probe scenarios (`bun run`, outside the mutex) | **PASS, both directions** | every before/after figure in §2–§6 |
| full repo suite / builds / packaging / live codex session | **NOT-RUN** | outside this lane's brief (implementation-first budget); the codex live half is recorded as a residual |

---

## 8b. The four failures, attributed rather than waved away

`codex-permission-rules.test.ts` (3) and `codex-permission-floors.test.ts` (1), every one of them
`this test timed out after 5000ms` at elapsed 5.0 / 7.1 / 10.0 / 10.9 s.

Neither file is in `docs/superpowers/specs/2026-07-29-known-failing-tests.md` (positive control:
the file reads, 377 lines), so the register gave no verdict and the failures had to be earned.

Three pieces of evidence, in increasing strength:

1. **My diff has no path to them.** `git grep` over both files for
   `startRuntime|AppServerClient|request(|thread/start` returns **zero** — they never reach the
   startup sequence where the new `permissionProfile/list` call lives, and nothing they exercise
   (the approval seam, `permissionsConfigCache`, `evaluatePermissionDslV1`) is touched by this
   commit.
2. **The failing SET MOVED between two runs of identical code** — 4 failures, then a different 2,
   with `codex-permission-floors` passing the second time. A deterministic breakage does not move.
3. **DECISIVE: `bun test --timeout 30000` on the same two files, same code → `40 pass / 0 fail /
   123 expect() calls / Ran 40 tests across 2 files. [56.92s]`, `EXIT=0`.** Only the clock changed.

So: contention against the default 5 s per-test timeout, under five live lanes (the run itself
queued behind `x3-guards` on the mutex). **Recorded as a finding of its own** — these two files are
timeout-fragile under lane contention and are not in the register, so the next lane to run them
will spend the same time I did. That is a register entry somebody should make; I did not, because
the brief forbids me that file.

## 9. Residuals and things deliberately not done

- **No live codex session was run for P2.330.** The binary-side measurement it rests on is
  `docs/superpowers/specs/2026-08-28-codex-sandbox-enforcement.md` (macOS arm64, `rust-v0.148.0`).
  Whether a real session now refuses correctly on a deliberately-broken `extends` is unmeasured —
  it is the natural CDP/live case for this row.
- **Subclass teardown beyond `destroy()`** — `disposeForRestart()` on Pi, Codex and Nestor is the
  path `SessionManager` actually takes for a restart, and it is **not** made total here. Same
  shape, different method. Named rather than fixed: out of the row's scope and a bigger diff.
- `SessionManager.ts`, `permission-dsl.ts`, `claude-bash-rule.ts`, `scripts/`, `protocol/` —
  untouched, per the brief. P2.284's outstanding label debt still lives in `SessionManager.ts`.
- The plan file was not edited (controller pins rows).

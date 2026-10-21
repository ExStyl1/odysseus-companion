# Y5 — P2.293 re-derived: thirty-four silent no-op setters, one rule

**Base SHA recorded before any work: `40b3c84a3955a7716bdaeef2c9098154ab52082a`.**
Branch `feat/TCODE-000`, shared tree. `[doc:none]` throughout — see §6.

---

## 0. The two numbers, first

**Count: 34, not 30, and not the row's 1.**
**Reachability: not reachable through any in-repo caller path on a healthy host; reachable
the moment `config.json` disappears after boot, which nothing in the app currently does —
because the only in-process deleter, `clearAllConfig()`, is itself dead code.**

Both differ from what I was handed, and the second one differs in the *uncomfortable*
direction from the original row (which said "unreachable, therefore harmless") **and** in a
small but real direction from X-11.

---

## 1. The count: 34

`packages/shared/src/config/storage.ts` has **44 functions that call `saveConfig()`**.
Enumerated by brace-balanced parse of every top-level function, not by grep
(`.../sdd2/y5/survey.py`, `guards.py`). They partition exactly:

| Group | N | Shape on absent config |
| :-- | --: | :-- |
| `saveConfig` itself | 1 | n/a — it is the writer |
| **Silent `void` no-op — the defect** | **34** | `if (!config) return;` in a `: void` function |
| Already returned a failure signal | 8 | `if (!config) return false;` (7) / warn + `return false` (1, `setGitBashPath`) |
| Resolver whose write is incidental | 1 | `resolveHeldModelThinkingLevel` — `return undefined` is a correct *answer* |

1 + 34 + 8 + 1 = 44. ✓

### Why the survey said 30 — the instrument, precisely

X-1's instrument was "`export function set*` whose body **within 6 lines** is
`if (!config) return;`". Two independent blind spots, and they are additive:

- **Three mutators do not start with `set`** — `clearGitBashPath` (`:1976`),
  `clearDismissedUpdateVersion` (`:2598`), `touchLlmConnection` (`:3033`).
- **One has its guard 9 lines in** — `setRetentionDays` (`:734`), because a
  `InvalidRetentionDaysError` validation block sits above the load.

30 + 3 + 1 = **34**. The arithmetic reproduces the survey's number exactly from its own
stated rule, so this is a instrument-scope difference, not a disagreement about the shape.

**Independent cross-check of the same number:** at the base SHA the literal string
`if (!config) return;` occurs **33** times in the file; `clearGitBashPath`'s guard is spelled
`if (!config || !config.gitBashPath) return;` and is the 34th. 33 + 1 = 34.

---

## 2. Reachability, re-derived from scratch

### 2.1 What actually makes `loadStoredConfig()` return null

Exactly one thing: **`config.json` does not exist**. Every other defect throws
`UnsupportedStorageLayoutError` — bad JSON, wrong `storageLayoutVersion`, a retired
`workspaces` key, a bad `workspaceRefs` array, an unregistered `activeWorkspaceId`, an
unknown top-level key (`storage.ts:933-1004`). The only other null is an ENOENT race between
`existsSync` and the read. So the no-op condition is narrow and precise.

### 2.2 The ordering IS enforced — on both hosts, and X-11 named only one

X-11 is right that the row's "an ordering nobody enforces" is false, and right that
`config.json` is not written at workspace creation. But X-11 cites only the **headless**
gate. Measured, there are two, and the desktop app — the actual product — uses the other one:

- **Headless** — `server-core/src/bootstrap/headless-start.ts:498-504` `ensureGlobalConfigExists`
  throws `HeadlessStorageReadinessError('corrupt-v2')` when `loadStoredConfig()` is null,
  called unconditionally at `:621`. This is X-11's citation, and it holds.
- **Electron** — `apps/electron/src/main/index.ts:417` awaits `ensureStorageLayoutV2` in a
  `while (true)` loop that only breaks on a non-`blocked` result. There is **no
  `ensureGlobalConfigExists` on this path at all**; the gate is the readiness installer
  itself. `ensureStorageLayoutV2` returns `ready` only when `inspectRoot(root) === 'v2'`
  (`storage-readiness.ts:439-466`), and `inspectRoot` (`:155-169`) returns `'unmarked'` when
  `config.json` is absent → the root is reinstalled (`installFreshRoot`) or the launch is
  blocked. `createStaging` (`:266-274`) writes `config.json` before the tree is accepted.

So on both hosts, by the time any setter can run, `config.json` exists. A reader who took
X-11's citation as *the* gate would conclude the desktop app is ungated. It is gated, by a
different mechanism.

### 2.3 The window, and how narrow it actually is

The gate is **boot-time only and never re-checked** — X-11's "unnamed reachable window", and
I confirm it. But I also measured the thing that decides whether that window is ever entered:

- **Nothing in-process deletes `config.json`.** `clearAllConfig()` (`storage.ts:1996`) is the
  only code that does, and it has **zero callers repo-wide** (positive control on the same
  rig: `setColorTheme` returns a live caller at
  `server-core/src/handlers/rpc/workspace.ts:301`).
- **No subprocess reaches a setter.** `pi-agent-server`, `session-mcp-server` and
  `codex-agent-server` bundle `storage.ts` (their `dist/` carries `setActiveWorkspace` etc.)
  but **zero** of the 34 are called from any of their `src` trees — positive control: those
  same trees do mention `getAdvisorEnabled`. This matters because `CONFIG_DIR` freezes at
  first import from `process.env.NESSY_CONFIG_DIR` (`config/paths.ts:19-21`), so a subprocess
  that did not inherit the override would compute a *different*, possibly non-existent root
  and no-op every write. That path is real in principle and unreached in practice today.
- **Every live direct caller is post-boot**: RPC handlers (`server-core/src/handlers/rpc/*`),
  electron IPC handlers, window/auto-update event handlers, and one boot-time cleanup
  (`clearGitBashPath` at `apps/electron/src/main/index.ts:676`, which is after the `:417`
  readiness gate).

**Verdict.** The original row's *conclusion* ("not live today") survives — as X-11 also
found. But it survives for a reason the row did not state and X-11 stated only half of, and
it is one wiring change away from being false: **if anyone ever wires up `clearAllConfig()`
as a "log out / reset" feature, all 34 setters become live silent no-ops in the same
session.** That is the honest statement of the risk, and it is why this was worth fixing
rather than closing as unreachable.

### 2.4 The framing correction, confirmed

X-11's third point holds and I reproduce it: `/advisor on` does **not** report success.
`base-agent.ts:4888` calls `setAdvisorEnabled(action === 'on')` and re-reads with
`getAdvisorEnabled()` on the very next line (`:4890`), which falls through to the bundled
default `false`. The user is told "off". A visibly wrong answer, not a silent success.

**Note this cuts against the row's own justification.** The row's stated reason for existing
is "the row that just landed exists precisely because a switch reported success while
changing nothing, and this is the same shape one layer down." It is *not* the same shape:
that one reported success, this one reports the truthful failure state for the wrong reason.
The defect is real, but it is a dropped write, not a false success.

---

## 3. The five "security-relevant" — three of them are dead code

The survey named five: `setAllowRemoteEvaluate` `:1233`, `setBypassPermissionsAcknowledged`
`:1283`, `setMacosSeatbeltBashSandboxEnabled` `:1318`, `setNetworkProxySettings` `:3133`,
`setActiveWorkspace` `:2015`. Measured against production callers:

| Setter | Direct production callers | Live? |
| :-- | --: | :-- |
| `setBypassPermissionsAcknowledged` | 1 (`rpc/settings.ts:600`, + renderer gate) | **yes** |
| `setNetworkProxySettings` | 1 (`main/network-proxy.ts:265`) | **yes** |
| `setAllowRemoteEvaluate` | **0** | no |
| `setMacosSeatbeltBashSandboxEnabled` | **0** | no (agrees with P2.305) |
| `setActiveWorkspace` | **0** | no |

So **two of the five are live**, not five. `setActiveWorkspace` is dead because the real
writer of `activeWorkspaceId` is elsewhere — `workspaces/service.ts:605`, operating on a
registry document. The storage-layer setter is a leftover.

**Method caution, recorded because it bit me:** my first caller sweep also reported
`setAdvisorModelId` and `setRespondToBashCommands` as having callers in
`config/validators.ts:278/:284`. Both are **comment text**, not calls. And my sweep initially
missed `setServerConfig`'s only caller because it is imported under an alias
(`apps/electron/src/main/index.ts:1111`, `const { setServerConfig: setConfig } = ...`) — a
call-shape grep cannot see an aliased call. Re-verified by bare-name search, which does catch
aliases because the import statement still names the original.

**Seven of the 34 setters have no production caller at all**: `setAllowRemoteEvaluate`,
`setMemoryEnabled`, `setMacosSeatbeltBashSandboxEnabled`, `setAdvisorModelId`,
`setUseAutoModeDuringPlan`, `setRespondToBashCommands`, `setActiveWorkspace`. Their getters
are live in several cases, so these are half-wired settings, not dead pairs.

---

## 4. The rule — argued, not applied

The brief asked me to decide once and justify against both failure modes rather than reach
for "restrictive = throw". Three candidates:

### (c) Create the config — rejected, and this is the strongest rejection

This is the one that looks helpful and is actually dangerous. `loadStoredConfig`'s own
docblock (`storage.ts:915-925`) documents the exact incident: before
`UnsupportedStorageLayoutError` existed, callers "treat a falsy return as *no config yet* and
write a fresh, empty config in its place — **destroying a real legacy config.json**". A
setter that creates on absence re-introduces that shape from inside the storage layer, where
the fail-closed guard cannot see it. It would also write a bare `config.json` **outside the
host lease** and outside `ensureStorageLayoutV2`'s staged tree install, which is the only
thing allowed to build a storage root (it creates `workspaces/`, `sessions/`, `plugins/` and
the layout marker atomically). A lone `config.json` in an otherwise-empty root is a state the
readiness installer would then have to classify. **Never create.**

### (b) Throw — rejected, and this is the judgement the brief asked for

The plan's standing rule resolves ambiguity toward the restrictive answer, and for a *reader*
that is clearly "throw". For a **setter** it is not, for a reason that is measured in this
tree rather than hypothetical:

- These 34 are called from **RPC handlers, window-zoom and auto-update event handlers, and
  boot-time cleanup**. `clearGitBashPath()` runs at `apps/electron/src/main/index.ts:676`
  during startup. A throw there converts "a stale Windows path was not cleared" into a dead
  boot — and `apps/electron/src/main/index.ts:194-205` documents that this app has already
  shipped a windowless silent hang, which is why `boot-fatal.ts` exists at all.
- `touchLlmConnection` records a *last-used timestamp* on every connection use. Throwing
  there would fail the user's message because a timestamp could not be written. That is
  strictly worse than not writing the timestamp.
- It is the failure mode a sibling lane spent today removing: X-9 in the same survey is
  `BaseAgent.destroy()` throwing synchronously into callers that call it in a bare `finally`
  with no enclosing catch. Adding 34 new throwers into event and teardown paths while another
  lane removes one is incoherent.

"Restrictive" here means *restrictive about what we are willing to do to the user's data and
the host's liveness*, not *maximally loud*. Throwing is loud and unsafe; refusing to create
is quiet and safe. Those are different axes and only the second one is the security axis.

### (a) Warn and continue — adopted, with the one addition that closes the actual defect

A warning alone does not fix "the caller believed state changed and it did not" — the caller
still cannot tell. The fix for that is to **hand the caller a value**, and the file already
does this: **9 of its 43 mutators already return `false` on this exact condition**, and
`setGitBashPath` already did both, with a docblock spelling it out — *"Returns false if the
config could not be loaded (path not persisted)."*

So the rule is not invented; it is the file's own established convention, generalised to the
34 siblings that were written without it:

> **A mutator whose backing store is absent must (1) never create it, (2) never throw,
> (3) warn unconditionally naming the setter, and (4) return `false`.**

**Cost check that made (4) affordable:** widening `: void` → `: boolean` requires **no caller
edits** — a discarded return value is legal, and every one of the ~20 live call sites is a
statement inside a block body, not a concise arrow in a `Promise<void>` slot (which would
have been the one shape that breaks, since `Promise<boolean>` is not assignable to
`Promise<void>`). I verified the shapes by reading the call sites and then confirmed by
typechecking all three affected packages. **Zero files outside my zone were touched.**

### The one documented exception

`resolveHeldModelThinkingLevel` (`:3020`) is left alone, with a comment explaining why. Its
*purpose* is to answer a question; the write is an incidental cache of which model the hold
is parked on. With no config there is no recorded explicit choice and no hold, so `undefined`
is the correct answer, not a swallowed write — and warning there would fire on every model
resolve while saying nothing true. The rule is scoped to *mutators whose purpose is to
persist a change*, and that scope is stated in the helper's docblock and pinned by a test.

---

## 5. What changed

`packages/shared/src/config/storage.ts`:

- New private helper `loadConfigForMutation(setter)` — the rule expressed **once**, with the
  full reasoning above in its docblock (why not create, why not throw, why not silent).
- **34** setters: `: void` → `: boolean`, guard routed through the helper, `return true` on
  the success path.
- **8** already-boolean mutators routed through the same helper so they warn too — the rule
  is now uniform across all 42, not just the 34 that were broken.
- Three had secondary bare returns needing distinct semantics, handled individually:
  `clearGitBashPath` (already-absent is the requested end state → `true`), `setActiveWorkspace`
  (unregistered id → `false`, no warning: a rejected write, not a store failure),
  `touchLlmConnection` (unknown slug → `false`).
- `setGitBashPath`'s bespoke `console.warn` folded into the shared channel.
- `resolveHeldModelThinkingLevel`: comment recording the exception.

`packages/shared/src/config/__tests__/setter-absent-config-rule.test.ts` (new): three
invariants, non-duplicative —

1. **Negative, real path**: config absent → returns `false`, warns naming the setter, does
   **not** throw, and `config.json` is **not created**. Run in a subprocess with its own
   `NESSY_CONFIG_DIR` because `CONFIG_DIR` freezes at import — no test doubles, so the suite
   cannot pass with the behaviour removed.
2. **Positive control, same rig**: config present → returns `true`, no warning, value
   persisted and re-read from disk.
3. **Structural**: no `if (!config) return;` survives anywhere in the file, and every
   `saveConfig()` caller routes through `loadConfigForMutation` (with the single named
   exception) — plus a vacuity guard asserting the scan actually found ≥40 routed mutators.
   This is what catches setter number 43 being written in the old shape.

Sampled behavioural cases are `setAdvisorEnabled` (the row's own symptom) and the **two live
security-relevant** ones, `setBypassPermissionsAcknowledged` and `setNetworkProxySettings`.

---

## 6. Documentation classification

**`[doc:none]`, explicitly.** This is our own storage layer. No Claude, Codex or Pi page
governs what a Nessy config setter does when `~/.nessy-agent/config.json` is missing —
`config.json` is a Nessy-private file with a Nessy-private v2 layout. Per the citation rule I
classified before writing code and did **not** go looking for a page to cite. Note this row
therefore does **not** count toward the plan's documented-contract coverage stopping rule.

---

## 7. Gates — with proof of work

Base SHA for all break-proofs: **`40b3c84a3955a7716bdaeef2c9098154ab52082a`** (absolute,
recorded before the first edit; never `HEAD~1`).

| Gate | Result | Proof |
| :-- | :-- | :-- |
| `tsc --noEmit` — `packages/shared` | **PASS** | exit 0, **0 diagnostic lines** |
| `tsc --noEmit` — `packages/server-core` | **PASS** | exit 0, **0 diagnostic lines** |
| `tsc --noEmit` — `apps/electron` | **PASS** | exit 0, only the `$ tsc --noEmit` echo line |
| `eslint --format json` (both changed files) | **PASS** | `files linted: 2`, `errorCount: 0`, `warningCount: 0` |
| `git diff --check` | **PASS** | exit 0, no output |
| `bun test` (new file, via mutex) | see §7.2 | |

Typechecks were run **after the last edit of any kind**, including the test file.
eslint used `--format json` and I read `errorCount` — not `--format unix`, which exits 2 with
a clean-looking empty file when the formatter is missing.

### 7.1 Break-proof against the absolute base SHA

The base `storage.ts` was materialised beside the live one (`git show <BASE>:...`), both
modules were invoked against an empty config dir, and the temp file was deleted immediately
after (verified absent; `git status` clean apart from my two intended paths):

```
=== module: storage.y5-baseproof.tmp (BASE 40b3c84a3) ===
  returns: [null,null,null]
  config.json created: false

=== module: storage (HEAD) ===
  [config] setAdvisorEnabled: config.json is absent — the change was NOT persisted.
  [config] setBypassPermissionsAcknowledged: config.json is absent — the change was NOT persisted.
  [config] setNetworkProxySettings: config.json is absent — the change was NOT persisted.
  returns: [false,false,false]
  config.json created: false
```

Base: three `undefined` returns, **zero output**. HEAD: three named warnings, three `false`.
Both leave `config.json` uncreated — the security invariant held before and still holds.
This is the defect reproduced before the fix, as required.

### 7.2 `bun test`

See the status line at the top of the returned summary. The mutex was under heavy contention
from eight concurrent lanes throughout this lane's run; the run was queued through
`bun scripts/bun-test-lock.ts run --label y5`, never bypassed, and never piped (a pipeline's
exit status is the last command's, and `pipefail` is off).

---

## 8. Findings to record — each tagged with kind

1. **`[doc:none]` · bug** — **P2.293's count is 34, not 1 and not 30.** All 34 fixed under one
   rule. The row's own instrument-scope gap is arithmetically explained in §1.

2. **`[doc:none]` · bug** — **The row's stated shape is wrong.** It claims "a switch reported
   success while changing nothing". `/advisor on` reports **"off"** (§2.4). The defect is a
   dropped write, not a false success, and the row's justification for its own existence
   rests on the wrong analogy.

3. **`[doc:none]` · never-looked-at** — **X-11's reachability citation covers only the
   headless host.** The electron host is gated by `ensureStorageLayoutV2` and has no
   `ensureGlobalConfigExists` at all (§2.2). Anyone reasoning from X-11 alone would conclude
   the desktop app is ungated.

4. **`[doc:none]` · never-looked-at** — **`clearAllConfig()` (`storage.ts:1996`) has zero
   callers repo-wide.** It is the only in-process deleter of `config.json`, so its deadness is
   the *entire* reason the 34 no-ops were unreachable. Wiring it up as a logout/reset feature
   would make all of them live in one commit. Now loud rather than silent, but the row should
   exist.

5. **`[doc:none]` · bug** — **Three of the survey's five "security-relevant" setters are dead
   code**: `setAllowRemoteEvaluate`, `setMacosSeatbeltBashSandboxEnabled`, `setActiveWorkspace`
   (§3). Only two are live. Prioritisation elsewhere on this plan should not inherit "five".

6. **`[doc:none]` · never-looked-at** — **Seven of the 34 setters have no production caller**
   (§3), several with live getters — half-wired settings. `setActiveWorkspace` in particular
   is superseded by `workspaces/service.ts:605`, which writes `activeWorkspaceId` through a
   different document. **Out of my zone; not touched.**

7. **`[doc:none]` · bug** — **`/advisor on` still answers "off" after this fix.**
   `base-agent.ts:4888` now *can* see the failure (`setAdvisorEnabled` returns `false`) but
   ignores the return value. The one-line improvement — report the persistence failure instead
   of re-reading the default — is in `packages/shared/src/agent/base-agent.ts`, **outside my
   zone and inside a file other lanes are working (X-9 touches its `destroy()`)**. Stopped and
   reporting rather than reaching across, per the zone rule.

8. **`[doc:none]` · never-looked-at (method)** — **Two instrument traps hit me and are worth
   recording** because both produce confident wrong answers: a call-shape grep cannot see an
   **aliased import** (`{ setServerConfig: setConfig }` at `main/index.ts:1111`), and
   comment text matched my caller regex twice (`validators.ts:278/:284`). Bare-name search
   plus comment-stripping is the instrument that survives both. Separately, on this host
   `timeout(1)` does not exist and a `nohup … &` completion notification reports the
   **launcher's** exit, not the job's.

---

## 9. Concerns

- **The `void` → `boolean` widening is behaviour-compatible but signature-visible.** Nothing
  broke (three package typechecks clean), and no caller file was edited. But 34 exported
  signatures changed in a shared package, and if another live lane has an in-flight edit to a
  `.d.ts` snapshot or an IPC-inventory generator that records return types, it will see a
  diff. I found no such generator covering these, but I did not sweep exhaustively for one.
- **Warning volume is unbounded by design.** `warn()` is unconditional (its own docblock says
  so). In the catastrophic state this fires per call — including `touchLlmConnection`, which
  is per-connection-use. I judged a dedupe cache to be more risk (its own lifecycle) than the
  spam, and the state is unrecoverable in-process anyway. Reversible if anyone disagrees.
- **`clearGitBashPath` semantics shifted slightly**: "no path stored" now returns `true`
  (requested end state reached) rather than falling out of a combined guard. I believe this
  is right, but it is a judgement, not a measurement.
- **I did not extend the sweep to `storage.ts`'s neighbours.** Other files under
  `packages/shared/src/config/` may carry the same shape against their own backing stores.
  My zone named "`storage.ts` and its neighbours", but eight lanes are live and widening a
  34-function mechanical change into sibling files without measuring them first is how the
  collision the brief warns about happens. **Recorded as unswept, not as clean.**

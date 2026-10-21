# P2.296 + P2.297 — report

**Direction chosen: BOTH, unified — collapse the two sets into one routing decision
(`channelLocality()`) so `REMOTE_ELIGIBLE` becomes load-bearing, AND make the complement empty
at COMPILE time so an unclassified channel cannot be built, with a runtime refusal in
`routed-client.ts` for the strings that never reach `RPC_CHANNELS` at all.** The brief offered
the two directions as alternatives; they close different holes and neither alone meets the
success criterion, so I did both. Detail in §2.

**Status:** DONE. Commit `9dfb39f28` on `feat/TCODE-000`, 6 files, +485/−38.
**Base SHA recorded before starting:** `8a1c6d3100fbd604ef0bf43c70521c21242a477d`.

---

## 0. The three measured facts hold — confirmed with my own positive control

Drove the real `RoutedClient` with two distinguishable stub transports (the stubs are the
*destinations*, not the decision — the router is real):

```
invoke totally:madeUpChannel          isLocalOnly=false isRemoteEligible=false -> WORKSPACE
invoke __transport:reconnected        isLocalOnly=false isRemoteEligible=false -> WORKSPACE
invoke window:getWorkspace            isLocalOnly=true  isRemoteEligible=false -> LOCAL
invoke sessions:get                   isLocalOnly=false isRemoteEligible=true  -> WORKSPACE
invoke workspace:importClaudePreview  isLocalOnly=false isRemoteEligible=true  -> WORKSPACE
invoke workspace:importClaudeApply    isLocalOnly=false isRemoteEligible=true  -> WORKSPACE
isChannelAvailable(UNKNOWN) = true
```

Positive controls on both sides (`window:getWorkspace` → LOCAL, `sessions:get` → WORKSPACE), so
the rig discriminates. `isRemoteEligible` call sites: **zero** outside its definition
(`REMOTE_ELIGIBLE_CHANNELS` appears only in the routing test and one server-core *test*
assertion). `isLocalOnly`: five, four of them production in `routed-client.ts`. All three facts
reproduce.

### One thing P2.282 did not surface, and it changed my design

`__transport:reconnected` **also routed through `RoutedClient` and was also unclassified.** It
is not in `RPC_CHANNELS`, so the exhaustiveness test never counted it and never will — it is
invisible to the guard that P2.282 restored. It is wired in `channel-map.ts:56`
(`onReconnected: listener('__transport:reconnected')`), emitted by `WsRpcClient.emitReconnected`,
and it drives the app's stale-session recovery after a workspace switch.

**This is the trap the brief warned about, in a second place.** A naive "throw on unclassified"
guard would have silently killed reconnect-driven stale recovery. So before designing anything I
swept every channel string that can reach the router:

| Source | Result |
| --- | --- |
| `CHANNEL_MAP` (all renderer API methods) | all `RPC_CHANNELS.*` except the one raw string above |
| `bootstrap.ts` direct `client.invoke(...)` — incl. 6 raw string literals (`'onboarding:startClaudeOAuth'`, `'chatgpt:startOAuth'`, `'chatgpt:cancelOAuth'` ×3, `'chatgpt:completeOAuth'`) | **all six ARE declared channels**, just written literally instead of via the constant. No breakage. |
| `oauth-orchestration.ts` dynamic `deps.invoke(channel, …)` | every call site passes `RPC_CHANNELS.oauth.*` |
| `isChannelAvailable('browser-pane:list')` in `BrowserTabStrip.tsx` | declared (`RPC_CHANNELS.browserPane.LIST`) |
| `handleCapability` (`client:openPath` etc.) | **not routed** — registers on both clients, never consults locality |

**Exactly one genuinely undeclared channel reaches the router.** That is what made a
fail-closed guard safe to ship, and it is why the fix declares
`TRANSPORT_INTERNAL_CHANNELS` rather than just throwing.

---

## 1. Why the row's framing needed one correction

The row says the exhaustiveness test "catches it at build time". It does not — it catches it at
**test time**, and only for channels that made it into `RPC_CHANNELS`. Two distinct failure
modes, and the row's proposed fixes address only the first:

- **(A)** a channel added to `RPC_CHANNELS`, unclassified → test-time only, and the test was red
  on this branch for the whole of `e815ad274`..`e6f9208f1`.
- **(B)** a channel string that never entered `RPC_CHANNELS` → invisible to the test *forever*.
  `__transport:reconnected` is a live instance of (B).

The fix therefore has to cover both, which is why it is not one of the two offered directions.

---

## 2. The design, and why each half is not optional

### Half 1 — `REMOTE_ELIGIBLE` becomes load-bearing (direction 2)

`channelLocality(channel): 'local' | 'workspace' | 'unclassified'` is now the **only** routing
decision, and `'workspace'` is reachable *only* through `REMOTE_ELIGIBLE_CHANNELS` membership.
`RoutedClient` calls it through one private `routeFor()`, used by `invoke`, `on` and
`onSequenced`, so no path can reacquire the old behaviour by consulting one set directly.

Adding a channel to `REMOTE_ELIGIBLE` is now the act that lets it leave the machine. Before, it
was a comment.

### Half 2 — the complement is empty at COMPILE time (stronger than direction 1)

The two set literals became `as const satisfies readonly RpcChannelValue[]` arrays with the sets
derived from them. Three assertions in `tsc`:

| What it catches | Mechanism | Error names the channel? |
| --- | --- | --- |
| channel in NEITHER set | `Exclude<RpcChannelValue, LOCAL[number] \| REMOTE[number]>` must be `never` | **yes** |
| channel in BOTH sets | `Extract<LOCAL[number], REMOTE[number]>` must be `never` | **yes** |
| a string in a set that is not a channel | `satisfies readonly RpcChannelValue[]` | yes |
| a new transport-internal pseudo-channel left unclassified | `satisfies Record<TransportInternalChannel, …>` | yes |

**This is what makes the mistake in the row's last sentence impossible rather than
discouraged.** A future engineer cannot add a channel and forget to classify it — the build
fails, by name, before any test runs. And they cannot add to `REMOTE_ELIGIBLE` and achieve
nothing, because that list is now the thing the router reads.

**Zero of the 350 classification lines were touched** — `git diff -U0 | grep '^[+-]\s*RPC_CHANNELS\.'`
is empty, so there is no transcription risk. Membership after: LOCAL_ONLY 152 + REMOTE_ELIGIBLE
198 = 350, exactly matching P2.282's post-fix arithmetic.

### Half 3 — runtime refusal (direction 1), for case (B)

`UnclassifiedChannelError` from `routeFor()`. **The brief's question — refuse, or route local?
I chose refuse**, for three reasons:

1. `RoutedClient` always *has* a local peer, so "route local" is available — but for a remote
   workspace it would execute the call on the **wrong machine**, silently. That is the same
   class of failure being removed, merely pointed the other way.
2. Every real channel is now classified at compile time, so an unclassified string is a
   programming error, not a user-reachable state. There is no legitimate call to preserve.
3. The error can name the fix. It does, including which list and what to do if the string is not
   an RPC channel at all.

**`isChannelAvailable` is the deliberate exception: it returns `false`, not a throw.** It is a
query used to hide UI (`useNotifications`, `useDirectoryPicker`, `BrowserTabStrip`); "there is no
server I would send this to" is the honest answer, and a throw there would take a render down.

### Half 4 — `__transport:reconnected` gets a decision instead of a fall-through

Declared in `TRANSPORT_INTERNAL_CHANNELS` (channels.ts) and classified `'workspace'` in
routing.ts, with a written reason: the reconnect that matters is the workspace connection's,
because that is the one whose downtime left session state stale. Same destination as before —
but now chosen, and totality-checked.

---

## 3. A defect I introduced and caught before commit — the prototype chain

Worth reporting in full because it is the fix reintroducing the bug it fixes.

The transport-internal lookup was first written as an object index:
`(TRANSPORT_INTERNAL_LOCALITY as Record<string, …>)[channel] ?? 'unclassified'`. Measured:

```
constructor        typeof=function -> [FUNCTION! not a locality]
__proto__          typeof=object   -> {}
toString           typeof=function -> [FUNCTION! not a locality]
valueOf            typeof=function -> [FUNCTION! not a locality]
hasOwnProperty     typeof=function -> [FUNCTION! not a locality]
genuinely:unknown  typeof=string   -> "unclassified"
```

An inherited member is **not** `'unclassified'`, so `?? 'unclassified'` never fires, `routeFor`
does not throw, and `isLocal = (x === 'local')` is false — **the call routes to the workspace
client.** The fail-open, back, for precisely the strings someone probing the boundary reaches
for first, inside the function written to close it.

Fixed with a `Map` built from `Object.entries` (own keys only; `Map.get`/`Set.has` have no
prototype chain). Pinned by two tests, one per layer, both of which fail under mutation C below.

`tsc` was green on the broken version. So was every other gate except the tests I wrote for it.

---

## 4. Do not break what you protect — exercised

- **The Claude-setup import path.** A dedicated test drives the real `RoutedClient` and asserts
  `workspace:importClaudePreview` and `workspace:importClaudeApply` reach the **workspace**
  client with the local→remote workspace-ID translation applied (`local-1` → `remote-1`), and
  that the local client sees neither. Under the re-break that restores the old routing
  (mutation A), **this test still passes** — proving it tests the feature, not the guard.
- **Reconnect plumbing.** A test asserts `__transport:reconnected` still subscribes on the
  workspace client and not the local one.
- Both survive every mutation that breaks the defect tests. That asymmetry is the evidence the
  guard is aimed at the right thing.

---

## 5. Gates — all run, with proof of work

| Gate | Result | Proof quoted from output |
| --- | --- | --- |
| `bun test` zone (mutex, `--label P2.296-final`) | **PASS** | `148 pass  0 fail  2361 expect() calls` / `Ran 148 tests across 10 files.` `EXIT=0` |
| `typecheck:shared` | **PASS** | `exit=0`, `errors=0` (grep count of `error TS`) |
| `apps/electron` typecheck | **PASS** | `exit=0`, `errors=0` |
| `packages/core` typecheck | **PASS** | `exit=0`, `errors=0` |
| `packages/server-core` typecheck | **PASS** | `exit=0`, `errors=0` |
| `apps/cli` typecheck | **PASS** | `exit=0`, `errors=0` |
| eslint, `packages/shared` (3 files) | **PASS** | `routing.ts errors=0 warnings=0`, `channels.ts errors=0 warnings=0`, `routing.test.ts errors=0 warnings=0` |
| eslint, `apps/electron` (2 files) | **PASS** | `routed-client.ts errors=0 warnings=0`, `routed-client.test.ts errors=0 warnings=0` |
| `git diff --check` | **PASS** | exit 0, no output |
| Full repo suite / builds / packaging / live | **NOT-RUN** | Out of the implementation-first budget; no shared wire/schema, migration, lock or build-infra change. Zone + all five affected typechecks were the expanded set. |

Zone suite covers `packages/shared/src/protocol/`, `apps/electron/src/transport/`,
`apps/electron/src/__tests__/transport.test.ts`, `apps/electron/src/preload/oauth-orchestration.test.ts`,
`packages/server-core/.../read-background-task-output.test.ts` (the one non-test-file consumer of
`REMOTE_ELIGIBLE_CHANNELS`). `rm -rf release` before the broad run.

**Note on the `typecheck:shared` warning in the brief:** it is now **clean, 0 errors**. The 4
errors P2.282 saw in another lane's uncommitted files are gone. Nothing to own.

**One near-miss on gate honesty:** the first eslint invocation used `--format unix` and exited
**2** — that was the formatter refusing to load, not a lint failure, and reported alongside an
empty output file it would have read as "clean". Re-run with `--format json` and per-file counts.

---

## 6. Re-break — three mutations against the recorded base SHA, plus behavioural mutants

Base files extracted with `git show 8a1c6d310:<path>`. Harness verified before use: base
`routing.ts`/`channels.ts`/`routed-client.ts` have **0** occurrences of `channelLocality`,
`UnclassifiedChannelError`, `TRANSPORT_INTERNAL_CHANNELS`; base `routed-client.ts` still shows
`isLocalOnly(channel)` at four sites. Never `HEAD~1`.

**Run 1 — the literal base files.** Both test files fail to *load*
(`Export named 'UnclassifiedChannelError' not found`). That proves the tests need the new API;
it does **not** prove they detect the old behaviour. Recorded as a weak result, not the evidence.

**Run 2 — behavioural mutants (new API kept, old logic restored).** This is the real re-break.

| Mutation | Effect | Result |
| --- | --- | --- |
| **A** — `routeFor` = `isLocalOnly ? 'local' : 'workspace'` (byte-equivalent to base behaviour) | fail-open restored | `18 pass, 3 fail` — invoke / subscribe / isChannelAvailable guards all fail. **The import-channel and reconnect tests still pass.** |
| **B** — `channelLocality` falls back to `'workspace'` | fail-open at the shared layer | `13 pass, 2 fail` — both "unclassified, not workspace" assertions fire |
| **C** — Map reverted to object index | prototype hole restored | `36 pass, 2 fail` — both prototype tests fire, nothing else |

**Compile-time guards, mutated on the real file and restored** (control clean before and after):

```
M1 unclassified channel     -> error TS2344: Type '"file:openDialog"' does not satisfy the constraint 'never'.
M2 double-classified        -> error TS2344: Type '"file:openDialog"' does not satisfy the constraint 'never'.
M3 foreign string in a list -> error TS2322: Type '"not:a-real-channel"' is not assignable to type 'RpcChannelValue'.
M4 unclassified pseudo-chan -> error TS1360: … does not satisfy the expected type 'Record<TransportInternalChannel, RoutedChannelLocality>'.
```

M1 and M2 **name the offending channel**. That is why the `Exclude`/`Extract` are written
inline: behind a named alias `tsc` prints only the alias.

---

## 7. Findings — each tagged and classified

**F1 — Routing was fail-OPEN and `REMOTE_ELIGIBLE` was inert.** `[doc:none]` ·
**never-looked-at**. The row's own subject. **FIXED** in `9dfb39f28`.

**F2 — `__transport:reconnected` is a routed channel that no guard can ever see.**
`[doc:none]` · **never-looked-at**, and **new** — P2.282 did not surface it. It reaches
`RoutedClient.on()` via `channel-map.ts:56`, is absent from `RPC_CHANNELS`, and is therefore
outside the exhaustiveness test's denominator permanently. It was crossing to the workspace
server by fall-through. **FIXED** — declared and classified. *Consequence worth keeping: the
exhaustiveness test's guarantee is bounded by `RPC_CHANNELS` membership, not by "what routes".*

**F3 — The fix's own transport-internal lookup was prototype-poisonable.** `[doc:none]` ·
**bug** (mine, caught pre-commit). §3. **FIXED**, pinned by two tests.

**F4 — `declare const X: T; const y: never = X` type-erases to a `ReferenceError`.**
`[doc:none]` · **bug** (mine, caught by the test run). The declaration erases, the assignment
does not; the module throws on import and `tsc --noEmit` stays green. Every test importing
`@nessy-agent/shared/protocol` failed to load. **FIXED** and written into the code comment,
because it is a trap the next person writing a type-level assertion here will walk into.
*Generalisable: `tsc --noEmit` cannot see a runtime-erasure bug — this is a fresh instance of
the repo's "a test double that makes the suite green either way" class.*

**F5 — Six raw channel-string literals in `bootstrap.ts` bypass `RPC_CHANNELS`.** `[doc:none]` ·
**never-looked-at**, NOT actioned — `bootstrap.ts` is outside my zone. Lines 368, 401, 414, 420,
425, 429 pass `'onboarding:startClaudeOAuth'` / `'chatgpt:*OAuth'` as literals. All six happen to
be declared channels today, so nothing is broken. But they are the shape of thing that becomes a
case-(B) miss the moment one of them is edited or a new one is added: the compile-time
classification guard keys off `RPC_CHANNELS` membership, and a literal is invisible to it. One
line each to replace with the constant. **Verdict recorded, not fixed.**

**F6 — `transport-locality.md` and `routing.ts` invert the word "remote".** `[doc:none]` ·
**never-looked-at** (P2.297). **FIXED** — see §8.

**F7 — `typecheck:shared` is clean.** Observation. The brief's caution is stale.

---

## 8. P2.297 — the two senses, and the rename recommendation

Both documents now name the distinction and point at each other:

- `docs/architecture/transport-locality.md` gains a **scope note at the top** (this record is
  about the *caller*, not about which server a channel runs on), an inline qualifier on the
  "Fail closed" bullet itself (the sentence a reader would otherwise carry across), and a
  **"Two senses of 'remote'"** section with a side-by-side table: question, decision input, what
  LOCAL/REMOTE mean, what unknown does, and who enforces it.
- `routing.ts`'s header states the inversion from the other side and links back.

**Recommended rename, and I do recommend one: rename the ROUTING sense, not the locality one.**
`REMOTE_ELIGIBLE_CHANNELS` → `WORKSPACE_OWNED_CHANNELS`, `isRemoteEligible` →
`isWorkspaceOwned`. Three reasons:

1. `RoutedClient`'s own fields are already `localClient` / `workspaceClient` — the runtime
   vocabulary is local/**workspace**, and only the classification table says "remote". The
   rename moves the table into line with the code it drives rather than the other way round.
2. `transport-locality.md` is where someone lands when they search "local" + "transport", and
   its sense (a phone is remote) is the one that matches ordinary usage.
3. The routing term is the newer and weaker of the two.

**Partially taken already, inside my zone:** `channelLocality()` returns
`'local' | 'workspace' | 'unclassified'`, so the decision point already speaks the unambiguous
word. **Not completed** because `REMOTE_ELIGIBLE_CHANNELS` has a consumer outside my zone
(`packages/server-core/src/sessions/__tests__/read-background-task-output.test.ts:314`) — per the
zone rule I stopped rather than reached across. The recommendation and its reason are written
into `transport-locality.md` so it is not lost.

---

## 9. Housekeeping

No worktrees or clones created (`git worktree list` untouched; the re-break used in-tree file
overlays under the test mutex with `trap`-guarded restore, and post-restore integrity was
verified by grep after every run). Scratch artefacts confined to the session scratchpad. Probe
test file removed before any commit. Commit made by explicit pathspec; `git show --name-only`
confirms exactly the 6 intended files and `git diff HEAD -- <those 6>` is empty.

One retry on `.git/index.lock` held by a concurrent lane (`e3f0a485c`) — waited it out, did not
remove the lock.

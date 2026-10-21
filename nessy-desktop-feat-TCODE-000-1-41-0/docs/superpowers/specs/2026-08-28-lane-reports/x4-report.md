# X4 — P2.325 (literals the guard cannot see) + P2.326 (an idiom that typechecks and throws)

**Status: DONE.** Commit `0790ad324` on `feat/TCODE-000`, 3 files, +104/−6.
**Base SHA recorded before starting: `09b77d44903d0695afb278515ea9d51260f91e5b`.**
Documentation classification: **`[doc:none]`** for both rows — our own transport and
typing idioms. No Claude, Codex or Pi page governs either. Stated explicitly per the
citation rule; I did not go looking.

---

## 0. Headline

| Row | Premise | Verdict |
| --- | --- | --- |
| P2.325 | six raw literals at 368/401/414/420/425/429 bypass `RPC_CHANNELS`, nothing broken today | **CONFIRMED exactly**, all six lines, all six declared. Fixed. |
| P2.326 | the erasure idiom typechecks green and throws on import | **CONFIRMED**, reproduced independently on a minimal pair. Swept: **0 unsafe instances today.** |

**The sweep's real finding is not an unsafe instance — it is that nothing enforced
import-safety.** `routing.ts` was caught in P2.296 only because tests happen to import it.
`packages/shared/src/version/version.ts` carries an ambient `declare const` and has **zero test
importers**, so the identical mistake there would have shipped green. That gap is now closed for
`protocol/` by an executable guard, and recorded (not fixed, out of zone) elsewhere.

---

## 1. P2.325 — confirmed, and one premise sharpened in the row's favour

Six literals, at exactly the six lines named:

| Line | Was | Now |
| --- | --- | --- |
| 368 | `'onboarding:startClaudeOAuth'` | `RPC_CHANNELS.onboarding.START_CLAUDE_OAUTH` |
| 401 | `'chatgpt:startOAuth'` | `RPC_CHANNELS.chatgpt.START_OAUTH` |
| 414, 420, 429 | `'chatgpt:cancelOAuth'` | `RPC_CHANNELS.chatgpt.CANCEL_OAUTH` |
| 425 | `'chatgpt:completeOAuth'` | `RPC_CHANNELS.chatgpt.COMPLETE_OAUTH` |

All six resolve to constants that already existed (`channels.ts:205, 225, 226, 227`), and
`RPC_CHANNELS` was already imported at `bootstrap.ts:48` — so this is six substitutions and no
new import. Post-fix, `client.invoke(` with a raw string literal is **absent** from the file
(the remaining literal `ipcRenderer.invoke('__dialog:…')` calls are Electron IPC, not RPC
channels, and never touch the router).

### The sharpening — it makes the row's scope exactly right

`git grep "new RoutedClient"` returns **one production construction: `bootstrap.ts:138`.**
Everything else is `routed-client.test.ts`. `apps/cli`, `apps/webui` and
`apps/electron/src/main/index.ts` all use a plain `WsRpcClient`, which makes no routing
decision at all.

So **these six were the only raw literals in the codebase that flowed through the guarded
router.** The row picked the right file, and the fix is complete rather than a sample of a
larger problem. (Literals elsewhere are F5 below — a real but different and lesser issue.)

### The durable half — the limitation in the guard's own comment

`routing.ts`'s `_everyChannelIsClassified` docblock gains a `KNOW WHAT THIS DOES NOT COVER`
paragraph stating the bound — the guarantee is `RPC_CHANNELS` membership, not what actually
routes — naming `__transport:reconnected` as the measured live instance, and drawing the
consequence for callers: write channels as constants, never literals, because a literal
typechecks against `invoke`'s `string` parameter and is invisible here.

**The `routing.ts` diff is comment-only: 17 added lines, all comment, zero deletions, zero
non-comment additions** (measured — `git diff -U0 | grep '^+[^+]' | grep -v '^+\s*(\*|/\*|\*/)'`
is empty). No behavioural risk on that file.

---

## 2. P2.326 — the mechanism, reproduced independently

I did not take P2.296's word for it. Minimal pair, both files compiled together:

```
tsc --noEmit --strict  bad.ts good.ts   ->  exit 0, NO OUTPUT (both green)
import good.ts  ->  imported OK, LOADED= true
import bad.ts   ->  THREW: ReferenceError | _unclassified is not defined
```

`declare` erases, the assignment does not. Confirmed under Bun 1.3.14, which is what the test
suite runs. The severity claim also holds: `bad.ts` never reaches its own `export const LOADED`
— the **whole module** is lost, and with it everything re-exporting it.

### The sweep — 15 instances of the idiom family, 0 unsafe

NUL-safe (`/usr/bin/grep -a`), each with a positive control.

| Shape | Count | Where | Verdict |
| --- | --- | --- | --- |
| **The dangerous spelling** `declare const X: T; const y: never = X` | **0** | — | P2.296 removed the only instance pre-commit |
| Ambient `declare const` (the erasing half) | 3 | `agent/options.ts:14`, `version/version.ts:1`, `agent/permissions-config.ts:1212` | **all import-safe** — see below |
| Module-scope type-level `never` assertions (safe `= true` spelling) | 6 constants / 3 modules | `protocol/routing.ts` (2), `transport/__tests__/channel-map-parity.test.ts` (2), `agent/backend/runtime-vocabulary.ts` (2) | all safe; real `= true` initialiser the emitter keeps |
| In-function `const _exhaustive: never = param` | 6 | processor.ts, useSessionSearch.ts, nestor-client.ts, composer-capabilities.ts, credentials/manager.ts, server-core sessions.ts | safe **by construction** — a real runtime binding (a narrowed parameter), inside a function body, not module scope |

Why each of the three ambient declares is safe, individually:

- `version/version.ts` and `agent/options.ts` — same `NESSY_AGENT_CLI_VERSION` build-time define.
  The reference is (a) inside a function body, so it does not run on import, and (b) guarded by
  `typeof X !== 'undefined'`, which is the one operator that does not throw on an undeclared
  identifier. Safe on **both** counts independently.
- `agent/permissions-config.ts` — `declare const normalizedContextBrand: unique symbol`, used
  only at `:1230` in a **type position** (`readonly [normalizedContextBrand]: …` inside a `type`
  alias). Type positions erase entirely; there is no emitted reference.

`runtime-vocabulary.ts` deserves a note in its favour: it not only uses the safe spelling but
exports `RUNTIME_VOCABULARY_ANCHORED = a && b`, which forces both constants to be live values.
That is the same instinct as this row, already applied there.

### The gap that was actually open

"Import-safe **or** covered by a test that imports the module" — I checked the second half too:

| Module | Test importers | Would the erasure trap have been caught? |
| --- | --- | --- |
| `protocol/routing.ts` | `routing.test.ts` | yes — and this is exactly how P2.296 caught it |
| `runtime-vocabulary.ts` | 4 | yes |
| `agent/permissions-config.ts` | 12+ | yes |
| `agent/options.ts` | 1 | yes |
| `channel-map-parity.test.ts` | is itself a test | yes |
| **`version/version.ts`** | **0** | **NO — it would have shipped green** |

So enforcement was **accidental**: it depended on some unrelated test happening to import the
module. That is the finding worth the row (F4).

### The fix — `packages/shared/src/protocol/__tests__/import-safety.test.ts`

Dynamically imports **every** module in `protocol/` and asserts it loads. Design choices, each
for a measured reason:

- **A directory scan, not a hand-written list** — the modules that most need this are the ones
  no other test imports, i.e. exactly the ones nobody would remember to add.
- **Dynamic `await import()`, not static** — a static import of a broken module takes the whole
  test *file* down before any test reports, and names the loader rather than the module. Dynamic
  means one named test fails and the other nine still report.
- **A scan-vacuity guard** — asserts the scan found `routing.ts`, `channels.ts`, `index.ts` and
  at least 8 modules. Without it, a mis-filtered scan yields `Ran 0 tests` and reads as green:
  the repo's own "a test double that drops the argument under test" trap. Mutation M2 below is
  the proof it is not decorative.
- **It asserts nothing about contents** — the invariant is "importing does not throw", and only
  an actual import can prove it. The file's docblock says so, and carries the transferable rule
  in the code as the brief asked: *a green typecheck is not a green import*, with the measured
  numbers.

Covers all 10 protocol modules by name: `capabilities, channels, dto, events, index,
pi-agent-view, pi-harness-runtime, routing, runtime-switch, types`.

---

## 3. Re-break — against the recorded base SHA, never `HEAD~1`

Both mutations applied to the real files under the test mutex, `trap`-guarded restore, integrity
verified after each (`diff -q` **IDENTICAL** to the pre-mutation copy; mutation marker count 0;
safe spelling count 1).

| Mutation | What it restores | Result |
| --- | --- | --- |
| **M1** — `_everyChannelIsClassified` rewritten in the erasing spelling in `routing.ts` | the P2.296 bug | **`2 fail`: `routing.ts imports without throwing`, `index.ts imports without throwing`** — by name, and `index.ts` demonstrates the barrel blast radius. `9 pass`. |
| **M2** — directory scan filter changed to match nothing | a vacuous suite | **`0 pass, 1 fail`** — the scan-vacuity guard fires. Without it this mutation reads as green. |

**The decisive measurement, and the whole point of the row:** under M1,
`bun run typecheck:shared` reported **`error TS` count = 0 for `protocol/`**. The single error in
that run was `src/agent/nestor-cloud-agent.ts(603,53): TS2304` — a **concurrent lane's
uncommitted file**, mid-edit, which had resolved by the next measurement. So `tsc` was clean on
the injected bug and only the runtime import test caught it. That is the row's claim, measured on
this repo rather than on my toy pair.

---

## 4. Gates — all run, proof of work quoted

| Gate | Result | Proof quoted from output |
| --- | --- | --- |
| `bun test` zone (mutex, `--label P2.325-326-final`), `protocol/` + `transport/` | **PASS** | `94 pass  0 fail` · `Ran 94 tests across 8 files.` · `EXIT=0` |
| `bun test` new file alone, junit reporter | **PASS** | `11 pass  0 fail` · `Ran 11 tests across 1 file.` — 1 vacuity guard + 10 modules, each named in the junit XML |
| `bun run typecheck:shared` | **PASS** | `EXIT=0`, `error TS count: 0` |
| `bun run typecheck:electron` | **PASS** | `EXIT=0`, `error TS count: 0` |
| eslint `packages/shared` (`--format json`, `errorCount` read) | **PASS** | `routing.ts errors=0 warnings=0`, `import-safety.test.ts errors=0 warnings=0` |
| eslint `apps/electron` (`--format json`) | **PASS** | `bootstrap.ts errors=0 warnings=0` |
| `git diff --check` (my 3 files) | **PASS** | `EXIT=0`, no output |
| Full repo suite / builds / packaging / live smoke | **NOT-RUN** | Outside the implementation-first budget: no shared wire/schema change (the six substitutions are byte-identical channel values), no auth/permissions, migration, lock or build-infra change. Zone tests + both affected package typechecks were the expanded set. |

Gate hygiene: every gate redirected to a file and inspected, never piped — `pipefail` is off and
a pipe would report the pipe's status. `--format json` with `errorCount` read, never
`--format unix`. `rm -rf release` before the broad run.

---

## 5. Findings — each tagged and classified

**F1 — Six raw channel literals in `bootstrap.ts` bypass `RPC_CHANNELS`.** `[doc:none]` ·
**never-looked-at**. The row's own subject; premise confirmed exactly. **FIXED** in `0790ad324`.

**F2 — `bootstrap.ts:138` is the ONLY production `RoutedClient`.** `[doc:none]` ·
**never-looked-at**. Premise sharpening in the row's favour: those six were the only raw literals
anywhere that reached the guarded router, so P2.325 is complete, not a sample. **Recorded.**

**F3 — The erasure idiom typechecks green and throws on import.** `[doc:none]` · **bug**
(P2.296's, already fixed) generalised. Mechanism independently reproduced; sweep found
**0 unsafe instances** across 15 members of the idiom family. **CONFIRMED, nothing to fix.**

**F4 — Import-safety enforcement was accidental, and `version.ts` is the hole.** `[doc:none]` ·
**never-looked-at**, and **NEW** — neither row states it. `routing.ts` was caught only because
unrelated tests import it; `packages/shared/src/version/version.ts` has **zero** test importers,
so the same mistake there ships green past every gate. **FIXED for `protocol/`** by the new
directory-scanning import test. **NOT fixed repo-wide** — the equivalent guard for
`packages/shared/src/version/`, `src/agent/` and `apps/electron/src/transport/` is outside my
zone. Cheap to replicate: the test file is ~40 lines of substance and parameterised by one
directory constant.

**F5 — Raw channel literals outside my zone, correctly framed.** `[doc:none]` ·
**never-looked-at**. NOT actioned. Counts measured: `apps/cli/src/index.ts` **86**,
`apps/webui/src/adapter/web-api.ts` **4**, `apps/electron/src/main/index.ts` **3**
(`sessions:export`, `sessions:exportRemoteTransfer`, `sessions:import`). **Important framing so
this is not over-escalated:** all three files use a plain `WsRpcClient`, never `RoutedClient`, so
they bypass **no routing guard** — the loss is only the typed constant and rename-safety, not
misrouting. Materially lower severity than P2.325 was. `apps/webui` is dormant per AGENTS.md.
**Verdict recorded, not fixed.**

**F6 — A transient `typecheck:shared` error belongs to another lane.** Observation, not a
finding of mine. `src/agent/nestor-cloud-agent.ts(603,53): TS2304: Cannot find name
'describeNestorThrownValue'` appeared in one measurement and was gone from the next; the file is
` M` in the working tree and the symbol had already changed underneath me. Flagged **only** so
nobody attributes it to `0790ad324`. Final typechecks: 0 errors.

---

## 6. Housekeeping

Commit made with `git commit --only` and three explicit pathspecs; `git show --stat HEAD` shows
exactly those three files. Seven other files (`base-agent.ts`, `codex-agent.ts`,
`usage-tracker.ts`, `nestor-cloud-agent.ts`, `pi-agent.ts`, `hook-env-file.ts`,
`sandbox-settings.ts`) and one untracked test remain modified and **uncommitted** in the working
tree — other lanes' work, verified intact after my commit. `git diff HEAD` on my three files is
empty.

No worktrees or clones created by me. `git worktree list` shows the shared tree plus two
pre-existing registrations (`nessy-fixwave`, `nessy-gate`) that were there before I started and
that I did not touch. Scratch artefacts confined to the session scratchpad; the minimal
erasure repro pair and all gate output files live there. No probe files left in the repo.

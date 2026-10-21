# Y1 — P2.346 + P2.249: the packaged-build guards that never run

**Status:** DONE. Both halves landed in one commit; P2.249's stated mechanism is **refuted**
and replaced with a measured one.

- Base SHA recorded before any edit: `40b3c84a3955a7716bdaeef2c9098154ab52082a`
- Commit: `908771110` — `fix(runtime): the packaged-build guards were dead in packaged builds`
- Files (exactly four, verified with `git show --stat` immediately after commit):
  - `apps/electron/src/main/index.ts` (+19/−2)
  - `apps/electron/src/main/__tests__/packaged-env-spelling.test.ts` (new, +55)
  - `packages/session-tools-core/src/runtime/resolve-script-runtime.ts` (+48/−3)
  - `packages/session-tools-core/src/runtime/resolve-script-runtime.test.ts` (+116/−1)

`[doc:none]` — our own packaging and our own env-var contract. **Said explicitly, as the brief
asks: no Claude, Codex or Pi documentation page governs `NESSY_IS_PACKAGED`, the
`resolveScriptRuntime` resolution order, or the packaged-mode PATH refusal.** The only
published contract is ours: `docs-site/content/server/headless.md:98` —
"| `NESSY_IS_PACKAGED` | no | `false` | `true` marks a packaged production build |". I did not
go looking upstream.

---

## 1. What a packaged build actually sets — read from the packaging scripts, not the code

This was the instruction that changed the answer, and it is worth stating first because both
halves of the row exist because someone reasoned from the code instead.

**Every packaging script that sets the variable writes the string `true`.** Two of them, both
in `scripts/build-server.ts`, both generators of shipped artefacts:

- `:645`, inside `createEntryScripts()`, into the generated `bin/nessy-server` launcher:
  `export NESSY_IS_PACKAGED=true`
- `:796`, inside `createDockerFiles()`, into the generated Dockerfile:
  `ENV NESSY_IS_PACKAGED=true`

**The three Electron packaging scripts never set it at all.** `apps/electron/scripts/build-dmg.sh`,
`build-win.ps1`, `build-linux.sh`: zero hits. `apps/electron/electron-builder.yml`: zero hits.
*Positive control on the same rig* (the absence rule): the same `grep -na` invocation over
`build-dmg.sh` returns **9** hits for `NESSY_FEATURE`. The grep works and the file is readable;
the variable genuinely is not there.

So for the desktop app the only writer is the app itself, from `app.isPackaged`, and there were
two writes with two vocabularies:

| Site | Value | When |
| --- | --- | --- |
| `apps/electron/src/main/index.ts:128` (pre-fix numbering) | `'1'` / `'0'` | module scope, at load |
| `apps/electron/src/main/index.ts:448` (pre-fix numbering) | `'true'` / `'false'` | inside `app.whenReady().then(...)` |

The whole-corpus writer/reader census (`git grep -na` with **literal directory pathspecs**, per
the measured `git grep -- 'packages/*/src'` trap; cross-checked against a plain recursive `grep -a`
that additionally surfaced two gitignored build artefacts — see §5):

| Site | Shape | Verdict |
| --- | --- | --- |
| `apps/electron/src/main/index.ts:128` | writes `'1'`/`'0'` | **the outlier write — fixed** |
| `apps/electron/src/main/index.ts:448` | writes `'true'`/`'false'` | canonical |
| `scripts/build-server.ts:645`, `:796` | write `true` | canonical, and authoritative |
| `packages/server/src/index.ts:70` | `??= 'false'` | canonical |
| `packages/server-core/src/runtime/platform-headless.ts:27,46` | `!== 'true'` | correct |
| `packages/server-core/src/runtime/platform-headless.ts:51` | `=== 'true'` | correct |
| `apps/electron/src/main/logger.ts:18-20` | `'true'` → false, `'false'` → true, else fall through | correct |
| `packages/session-tools-core/.../resolve-script-runtime.ts:67` | `=== '1'` | **the outlier read — fixed** |

Four writers, five readers, three vocabularies. `'true'`/`'false'` wins on every count: it is
what packaging emits, what the docs document, what three of the four readers compare against,
and what the app itself settles on within milliseconds of launch.

---

## 2. P2.346 — confirmed, and reproduced before fixing

**The premise holds.** `inferPackagedMode()` returned `process.env.NESSY_IS_PACKAGED === '1'`,
which is false for `'true'` — the value every packaged path supplies.

Reproduced against the real module, no mocks, no test double, calling
`resolveScriptRuntime('python3')` **with no context**, which is the production call shape
(`handlers/script-sandbox.ts:77` and `handlers/transform-data.ts:92` both call
`resolveScriptRuntime(args.language)` and pass nothing else):

```
--- no ctx supplied (the production shape) ---
NESSY_IS_PACKAGED='true'  (packaging scripts)  -> NO THROW  command="uv" source=env
NESSY_IS_PACKAGED='1'     (index.ts:128)       -> THROWS     Python/uv runtime from env is not an absolute/bundled path (...
NESSY_IS_PACKAGED unset                        -> NO THROW  command="uv" source=env
NESSY_IS_PACKAGED='false'                      -> NO THROW  command="uv" source=env
```

The first line is the live fail-open: the bare string `'uv'` is returned as the command, to be
resolved through `PATH` at spawn — the exact outcome the guard's own error text refuses
("Packaged builds do not allow PATH-based runtime resolution"). All three
`validatePackagedEnvRuntime` call sites (uv, node, bun) were behind that same dead flag, and so
were the three `if (!isPackaged)` PATH fallbacks, which became *reachable* in a packaged app.

Same probe after the fix:

```
NESSY_IS_PACKAGED='true'  (packaging scripts)  -> THROWS     Python/uv runtime from env is not an absolute/bundled path (...
NESSY_IS_PACKAGED='1'     (index.ts:128)       -> THROWS     Python/uv runtime from env is not an absolute/bundled path (...
NESSY_IS_PACKAGED unset                        -> NO THROW  command="uv" source=env
NESSY_IS_PACKAGED='false'                      -> NO THROW  command="uv" source=env
```

**The attacker-free route is real and I confirmed both ends of it.** `index.ts:125`
`const fallbackUv = bundledUvExists ? null : 'uv'`, written into `NESSY_UV` at `:132`. A packaged
build that shipped without its bundled `uv` binary therefore puts the bare string in the env var
by itself. A packaging defect alone is sufficient; nothing else is needed.

**Chain to a shipped artefact, not just to source.** The two staged subprocess bundles the
desktop app actually executes both compile the broken comparison:

```
apps/electron/resources/pi-agent-server/index.js:NESSY_IS_PACKAGED === "1"
apps/electron/resources/session-mcp-server/index.js:NESSY_IS_PACKAGED === "1"
```

Both are spawned by the main process (`pi-agent.ts:2163` via `buildPiSubprocessEnv`, which spreads
`process.env` — pinned by `packages/shared/src/agent/__tests__/claude-operator-ceiling-env.test.ts:39`),
long after the ready handler has set `'true'`. So the child inherits `'true'` and reads `=== "1"`.
Independently, the headless `bin/nessy-server` launcher exports `true` before the process even
starts, so that path needs no ordering argument at all.

---

## 3. P2.249 — the measurement wins; the row's mechanism is refuted

The row asked for the measurement first and flagged itself low-confidence. Good instinct: **the
window hypothesis is wrong, and the defect is worse than a window.**

- **Both writes confirmed**, at the stated lines, with the stated values. ✔
- **The named read confirmed** — `platform-headless.ts:51` is `=== 'true'`. ✔
- **"anything reading the variable between those two points sees `false` regardless of the truth"
  — refuted, twice over:**
  1. **No consumer runs in the window.** `logger.ts`'s `isDebugMode` is a *module-level const*
     evaluated when the module is imported, and `index.ts:82` imports it — so it reads
     **before** the first write, not between the two. `platform-headless.ts` is never loaded in
     the Electron main process (`apps/electron/src/runtime/platform-headless.ts` re-exports it and
     **has zero consumers under `apps/electron/src`**; the production caller is
     `server-core/src/bootstrap/headless-start.ts:519`, a different process).
     `packages/server/src/index.ts` is the headless entry, also a different process.
     `resolveScriptRuntime` is reached only from tool handlers, which run per session, long after
     ready. That is the measured "no consumer is in the window, and here is why" the row said
     would close it.
  2. **But the reader the row does not name is permanently wrong, not wrong in a window.**
     `resolve-script-runtime.ts:67` compared `=== '1'`, so it was *correct only inside the window*
     and wrong everywhere else — the exact inverse of the row's model. And in the headless server
     it is wrong from the first instruction, since the launcher never writes `'1'` at all.

So P2.249 and P2.346 are one defect seen from two sides, and P2.249's framing would have sent a
lane looking at the wrong reader for the wrong reason. Recording the correction is the more
valuable half.

---

## 4. The fix

**Reader** — `packages/session-tools-core/src/runtime/resolve-script-runtime.ts`. A named,
exported, documented parser replaces the inline comparison:

```ts
export function isPackagedEnvValue(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}
```

`'1'`/`'0'` stays accepted deliberately: builds already in the field write that form from the
Electron module scope, and their staged subprocess bundles inherit it. An **unrecognised** value
reads as *not packaged* — a deliberate choice, documented in the JSDoc: it matches every sibling
reader (`=== 'true'`, and `logger.ts`'s `'true'`/`'false'`-only branch), and the variable being
absent has to stay false or every dev run and every CI test would begin throwing. The
alternative (unknown ⇒ packaged) fails closed on a typo but diverges from four other readers;
I chose consistency and pinned the choice with a test rather than leaving it implicit. **This is
the one judgement call in the row that a reviewer might reverse** — it is a one-line change if so.

The JSDoc records *where the canonical spelling came from* (the two `build-server.ts` lines, the
absence in the Electron scripts, the docs-site row), so the next maintainer does not have to
re-derive it from the code, which is how this happened.

**Writer** — `apps/electron/src/main/index.ts`: the module-scope write becomes
`app.isPackaged ? 'true' : 'false'`. The variable now has one vocabulary for its whole lifetime.
Both writes carry a comment naming the other and naming the pinning test. The ready-handler write
is left in place (it is the documented export point for `logger.ts` and headless Bun); it is now
an idempotent re-assert.

No behavioural regression for the CDP `NESSY_IS_PACKAGED=false` debug lever: it is overwritten by
the app's own write exactly as before, only with `'false'` instead of `'0'`.

---

## 5. The acceptance bar — a test that does NOT supply `isPackaged`

This was the stated bar, and it is met. The blind spot was real: **all five pre-existing tests
pass `{ isPackaged: true | false }` explicitly**, so they exercised a branch no shipped caller
takes and were green with and without the defect.

Two new suites, kept deliberately separate from the old ones:

- `describe('packaged mode inferred from NESSY_IS_PACKAGED (no isPackaged supplied)')` — 7 tests,
  every one of them setting only the **env** and never the flag: the `'true'` fail-open (the live
  one), the legacy `'1'` spelling, an absolute-but-missing env runtime, the PATH-fallback block,
  and three negative/dev-path cases (`'false'`, absent, and explicit `ctx.isPackaged` still
  overriding the env).
- `describe('isPackagedEnvValue')` — 2 tests pinning the accepted spellings and the
  unknown-reads-as-false decision.

Plus `apps/electron/src/main/__tests__/packaged-env-spelling.test.ts` (3 tests), which asserts
against `index.ts`'s **source** that both writes use one vocabulary — the shape
`managed-update-registration.test.ts` and `storage-readiness-order.test.ts` already use for this
file, because nothing at runtime notices a second vocabulary: both spellings assign fine, and only
a guard three packages away can tell the difference. It carries its own positive control (an
assertion that the match list has length 2), so an empty regex match cannot make the other two
assertions vacuously pass.

### Break-test, against the absolute base SHA (never `HEAD~1`)

Both halves reverted to their `40b3c84a` expressions, one at a time, files restored from byte-copies
afterwards (`diff -q` confirmed identical):

| Break | Result |
| --- | --- |
| reader → `=== '1'` | **3 fail**, 11 pass — the three env-driven guard tests. `Ran 14 tests across 1 file.` The five old `isPackaged`-supplying tests **stayed green**, which is the blind spot demonstrated rather than asserted. The legacy-`'1'` test also stayed green, showing the suite discriminates rather than failing en masse. |
| writer → `'1'` : `'0'` at line 139 | **2 fail**, 1 pass. `Ran 3 tests across 1 file.` The surviving pass is the positive control. |

---

## 6. Gate — with proof of work, not exit statuses

Nothing below was piped; each command redirected to a file, and the quoted line is from that file.

| Gate | Result | Proof of work |
| --- | --- | --- |
| `bun test` on the zone, through the mutex (`bun scripts/bun-test-lock.ts run --label y1-final -- bun test packages/session-tools-core apps/electron/src/main/__tests__`) | **PASS** | `697 pass / 0 fail / 2230 expect() calls`, `Ran 697 tests across 65 files. [16.89s]` |
| `bun test` on the two changed test files (first run, through the mutex) | **PASS** | `17 pass / 0 fail / 34 expect() calls`, `Ran 17 tests across 2 files.` |
| `cd packages/session-tools-core && bun run tsc --noEmit` | **PASS** | exit 0, **0 output lines** — and a *positive control* proves the gate covers the changed file: a deliberate `const __positiveControl: number = isPackagedEnvValue(undefined)` produced `src/runtime/resolve-script-runtime.ts(301,7): error TS2322` and exit 2, then was removed. |
| `cd apps/electron && bun run typecheck` | **PASS** | exit 0, only the `$ tsc --noEmit` echo — same positive control on the new test file: `src/main/__tests__/packaged-env-spelling.test.ts(57,7): error TS2322`, exit 2, removed. |
| `eslint` from `packages/session-tools-core`, `--format json` (the `--format unix` trap) | **PASS** | `files=2 errors=0 warnings=0` — two files actually linted, and zero warnings means neither was silently ignored. |
| `eslint` from `apps/electron`, `--format json` | **PASS** | `files=2 errors=0 warnings=0` |
| `git diff --check` on the three tracked changed files | **PASS** | exit 0, no output |

**NOT-RUN, named:**

- **Full-repo `bun run typecheck:all` / `bun run lint` / whole `bun test`.** Per the
  implementation-first budget these belong to a verification-wave boundary, and running them here
  would measure eleven other lanes' uncommitted work, not mine. The two affected packages were
  typechecked and linted individually, with positive controls.
- **Packaged-build live smoke.** The definitive proof would be a packaged `.dmg` whose Python tool
  now refuses a PATH-resolved `uv`. Not run — see the concern below, it is not merely a budget call.
- **`bun run electron:build:servers`.** Deliberately not run; see concern 1.

Known-failing register (`docs/superpowers/specs/2026-07-29-known-failing-tests.md`) consulted before
attributing anything — no attribution needed, zero failures in the final run.

---

## 7. Findings to record

Each tagged with the documentation tag and the kind, per the standing rules.

### F1 — the row as executed `[doc:none]` · **bug**
`inferPackagedMode()` read `=== '1'` while every packaged artefact writes `'true'`, so all three
`validatePackagedEnvRuntime` guards were unreachable in packaged builds and the dev-only PATH
fallbacks were reachable. Reproduced, fixed, pinned by env-only tests, break-tested. **Closed by
`908771110`.** (This is P2.346 confirmed as stated — it is one of the minority of rows on this plan
that survived contact with measurement intact.)

### F2 — P2.249's mechanism is wrong `[doc:none]` · **bug** (in the row, not the code)
"Anything reading the variable between those two points sees `false` regardless of the truth" is
refuted: **no consumer runs in that window**, and the reader that *is* broken is broken permanently
and is not the one the row names. Detail and evidence in §3. The row's *concern* was sound and its
self-flagged low confidence was warranted; its model would have misdirected the fix.

### F3 — the fix does not reach a running app until the subprocess bundles are restaged `[doc:none]` · **never looked at**
`apps/electron/resources/pi-agent-server/index.js` and
`apps/electron/resources/session-mcp-server/index.js` still contain `NESSY_IS_PACKAGED === "1"`.
They are gitignored build artefacts (`.gitignore:11`), regenerated by
`bun run electron:build:servers` — nothing to commit, but this is exactly the measured trap that
"a main-process fix can be on disk and absent from the running app". **Anyone verifying this fix in
`electron:dev` or in a packaged build must restage first, or they will measure the old code and
conclude the fix did not work.** I did not run the restage: `apps/electron/resources/` is outside my
named zone, and a build that fails halfway would break the dev app for the other seven live lanes.

### F4 — five readers, three vocabularies, and no single definition `[doc:none]` · **never looked at**
Even after this fix the variable is parsed independently in four places
(`platform-headless.ts` twice, `logger.ts`, `packages/server/src/index.ts`,
`resolve-script-runtime.ts`), each with its own semantics for an unrecognised value.
`isPackagedEnvValue` is now a named parser but lives in `session-tools-core`, which the other three
do not import. **Not fixed** — consolidating it means touching `server-core`, `packages/server` and
`apps/electron/src/main/logger.ts`, three files outside my zone, and the standing rule is to stop and
report rather than reach across. The behaviour is currently consistent; the *structure* is not, and
this is precisely the shape that produced the defect in the first place. Recommend one row.

### F5 — an unrecognised value fails open, by choice `[doc:none]` · **bug** (latent, low severity)
`NESSY_IS_PACKAGED=treu` reads as *not packaged* and re-opens the fail-open. I chose this for
consistency with the four sibling readers rather than failing closed, documented it in the JSDoc, and
pinned it with a test so the choice is visible instead of accidental. No production path produces such
a value (the packaging scripts write a literal `true`), so I did not treat it as blocking. **Flagged
so the owner can reverse it — it is a one-line change and a test edit.**

### F6 — brief/zone correction `[doc:none]` · **never looked at**
The brief places `inferPackagedMode` and `validatePackagedEnvRuntime` under
`apps/electron/src/main/`. They are in
`packages/session-tools-core/src/runtime/resolve-script-runtime.ts`. The zone's second clause ("the
`NESSY_IS_PACKAGED` readers wherever they are") covers it, so I proceeded — but a controller pinning
the next row from the first clause alone would zone the wrong package. Worth correcting in place,
given a zoning slip has already caused one collision on this plan.

### F7 — a decayed doc anchor, noticed in passing `[doc:none]` · **forgotten-vs-doc** (ours)
`scripts/cdp/lib/runtime-session-log.ts:99` says the external `NESSY_IS_PACKAGED=false` lever is
"repaired downstream (`main/index.ts:119` overwrites…)". The write is at `:139` now (`:128` before my
change, and it has moved at least twice). The *sentence* is still true; only the number decayed —
the repo's own "quote sentences, not line numbers" rule, in miniature. **Not fixed:** `scripts/cdp/`
is outside my zone. One-line edit for whoever owns it.

---

## 8. Housekeeping

- Committed by explicit pathspec; `git show --stat --oneline HEAD` verified **exactly four files**
  and line counts matching my own diff. `git status` afterwards confirms the other lanes' twelve
  modified files and their untracked eslint configs are still dirty and untouched.
- `packages/session-tools-core/eslint.config.mjs` is another lane's untracked file. I *used* it to
  run the lint gate (read-only) and did **not** commit it. Note the coupling: my
  `lint:session-tools-core` evidence depends on that lane's config landing; if it is reverted, this
  package returns to unlintable and the gate becomes unrunnable rather than failing.
- No second tree needed; no worktrees created or left registered.
- No `Co-Authored-By` trailer. No push, no MR, no tag. Plan file not touched.
- Scratch artefacts (repro script, before/after probes, all gate logs, break-test logs) under
  `…/scratchpad/y1/`.

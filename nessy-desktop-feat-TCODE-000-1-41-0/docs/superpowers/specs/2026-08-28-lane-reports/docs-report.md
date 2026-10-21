# DOCS lane report — P2.284 + P2.290 + P2.289

**Commit:** `7819e375a` — `fix(watcher): the eighth floating emission, on the file the wrapped grep cannot see`
**Base SHA recorded before starting:** `f58f66a36f6314384fef1d4c535f7772dd0ca84b`
**Files committed (verified `git show --stat`, exactly five, nothing else):**

```
docs/superpowers/specs/2026-07-29-inert-contracts.md            |   2 +-
docs/superpowers/specs/2026-07-29-inert-worklist.md             |   4 +-
packages/server-core/src/projects/__tests__/project-capability-watcher.test.ts | 105 +++++
packages/server-core/src/projects/project-capability-watcher.ts | Bin 5677 -> 7251 bytes
packages/shared/src/capabilities/runtime-automations.ts         |  25 ++++-
```

(`Bin` on the watcher is the NUL byte, not a corruption — committed blob measured
at 1 NUL byte, same as before, and the containment is present in the blob.)

---

## Premise corrections, up front

Three things the brief said that the measurement contradicts. None changes the work;
all three change what the next reader should believe.

### 1. Only ONE of my two code files carries a NUL byte, not both

The dispatch said "both of your code files are among them". Measured by byte scan:

| File | NUL bytes | `file(1)` |
| --- | --- | --- |
| `packages/server-core/src/projects/project-capability-watcher.ts` | **1** (byte 1981, line 54) | `data` |
| `packages/shared/src/capabilities/runtime-automations.ts` | **0** | `Java source, UTF-8 text` |

The watcher's NUL is deliberate — it is the key separator in
`entryKey`: `` return `${workspaceId}\x00${projectKey}`; ``. `runtime-automations.ts`
is ordinary text and always was; a plain `grep` reads it fine.

This matters because the P2.284 row's whole "invisible" story applies to the watcher
only. My independent byte scan over 3,620 `.ts`/`.tsx` files under `packages/` and
`apps/` reproduced the 13-file NUL list exactly as P2.73's note enumerates it.
**Note the standing discrepancy I did not resolve:** P2.274's note says "Fourteen
tracked files carry a NUL" and "the fourteen-file NUL list", while the enumeration in
P2.73's note lists **13**, and my scan of `.ts`/`.tsx` under `packages`/`apps` finds
**13**. Either the 14th is outside that extension/path scope, or one of the two counts
is wrong. Cheap to settle; I did not, because it was outside the row.

### 2. `packages/shared/src/automations/runtime-automations.ts` does not exist

The real path is `packages/shared/src/capabilities/runtime-automations.ts`. There is
no `src/automations/runtime-automations.ts` (there *is* a `src/automations/` directory,
which is what makes the wrong path plausible). Line 317 in the real file is the line
the row describes, so the row is right about the content and wrong about the folder.

### 3. `git grep` does not *silently* skip a NUL file — and that distinction is the useful half

The lane rules say `git grep` is byte-honest here. Precisely: on a NUL-carrying file
`git grep -n <pat>` prints **`Binary file … matches`** — it finds the file and
withholds the lines. `git grep -na` prints the lines. The wrapped `grep` prints
*nothing* and exits 0. So `git grep` is safe for an **absence** claim (it never lies
about a hit existing) but still needs `-a` to give you the site. I used `-na`
throughout.

---

## P2.284 — the eighth floating-emission survivor

### The defect, reproduced before it was touched

`packages/server-core/src/projects/project-capability-watcher.ts`. `handleEvent` fires
the emission from a debounce timer:

```ts
entry.debounce = setTimeout(() => {
  entry.debounce = undefined;
  void this.emit(entry);            // :135 — the floating call the row names
}, this.options.debounceMs ?? 150);
```

and `emit` belted `revalidate` but not the host callback on its last line:

```ts
try {
  ok = (await this.options.revalidate(entry.target)).ok;
} catch { ok = false; }
if (entry.closed) return;
this.options.onInvalidate(entry.target, ok ? 'content' : 'identity');   // :148 — outside the try
```

`emit` is `async` and nobody holds it, so a throw from `onInvalidate` is a **rejection
with no failure channel** — the class exactly. It is the half most likely to throw:
the production `onInvalidate` is `SessionManager.ts:5642`, which iterates every live
session clearing `approvedFilesystemRoots` and then starts
`refreshPluginRuntime`.

Cost, measured against the hosts rather than asserted: both install an
`unhandledRejection` handler (`packages/server/src/index.ts:75`,
`apps/electron/src/main/index.ts:1564`), so it does **not** crash — it degrades to a
generic `[server] Unhandled rejection (caught, not crashing): …` line naming neither
the project nor the kind, and in a packaged Electron build `mainLog` writes nothing
at all outside debug mode.

**Line-number drift, for the record:** the row says `:135`; the floating `void
this.emit(entry)` is at `:135` and the unbelted statement is at `:148`. Substance
intact, both sites in one method.

### The fix, and why it is deliberately *not* the siblings' fix

The seven siblings (53849b319, 9a95ae0ff) each gave the fault a **label on a record
the class already wrote** — `emitDetachedAutomationEvent` routes to
`emitAutomationEvent`'s own `onError` on `this.debug`; `PiAgent`'s variant routes to
`surfaceSubprocessFault`. **This module has no record to label.** It imports
`node:fs` and `node:path` and nothing else, by design: the host owns all reporting.
The options are `revalidate`, `onInvalidate`, `debounceMs`, `watchImpl` — no logger,
no `onError`, and no `PlatformServices` singleton reachable from `projects/` without
importing `SessionManager` (circular).

So the fix is containment, with the reasoning written into the comment. **I did not
add an optional `onError`**, because the only production wiring point is
`SessionManager.ts` — outside this row's zone — and an option nothing passes is
precisely the inert shape P2.289 exists to warn about. See the open item below.

I also did **not** add a `.catch` on the floating call at `:135` as a second belt:
after this change `emit` is total (every statement is inside the try or is a plain
assignment/return), so that catch would be provably dead code. Same reason.

### The detector was the interesting part — and it invalidates an existing test

My first rig used `process.on('unhandledRejection')`, which is what both production
hosts install and therefore reads like the right seam. It is **inert under the test
runner**. Measured twice:

- Standalone probe (`scratchpad/rejprobe.test.ts`): a listener wrapped around a
  deliberately floated `Promise.reject(new Error('probe'))` collected `[]`, and bun
  failed the test with `error: probe` attributed to the test body.
- My own first control test asserted `expect(escaped).toEqual(['control escape'])`
  and failed with `Received: []`.

Under `bun test` v1.3.14 the runner intercepts the rejection before any user listener
and attributes it to the running test. So `expect(escaped).toEqual([])` **passes with
and without the behaviour under test** — vacuous.

The rig now asserts on the runner itself (an escape fails the test that caused it),
paired with `calls`/`kinds` assertions so a clean run means "contained", not "never
reached". Positive control for the escape half is the recorded pre-fix run, below.

> **FINDING — `[doc:none]`, kind: bug (in a test).**
> `packages/shared/src/agent/__tests__/detached-automation-event.test.ts:108-136`
> ("a host debug sink that throws does not become the failure it reports") ends in
> `expect(escaped).toEqual([])` built on `process.on('unhandledRejection')` at `:119`.
> That assertion is vacuous under `bun test` for the reason above. The test still
> fails on a regression — because the runner fails it — so this is not a live hole;
> it is an assertion that certifies nothing while reading as the strongest one in the
> file, and P2.192's commit message cites it as the measurement. Out of my zone; not
> touched. Cheap fix: drop the listener and say the runner is the detector.

### Evidence

**Reproduction, before any source edit** (tests written first, run against the
unmodified file):

```
(fail) … > a throwing host callback does not escape as an unhandled rejection
    error: host invalidation exploded
      at onInvalidate (…/project-capability-watcher.test.ts:180:19)
      at emit (…/project-capability-watcher.ts:148:18)
(fail) … > a throwing host callback does not stop the registry watching
(fail) … > a host callback that throws on identity loss is contained the same way
```

**Re-break against the absolute base SHA `f58f66a36`** (source restored with
`git show <sha>:<path> >`, never `git checkout -- <path>`, which rewrites the index):

```
 5 pass
 3 fail
 11 expect() calls
Ran 8 tests across 1 file. [4.73s]
```

3 of 3 new tests fail; the 5 pre-existing tests stay green — the negative control that
says they fail for the reason claimed and not from rig damage. NUL count measured at
1 before, during and after the restore round trip.

**After the fix:**

```
 8 pass
 0 fail
 14 expect() calls
Ran 8 tests across 1 file.
```

### The sibling sweep — and it found more survivors

Method: byte-honest scan of every `.ts`/`.tsx` under `packages/` and `apps/`
(3,620 files) for floating `void <call>(` statements, then narrowed by reading each
candidate rather than by pattern. Raw population: 347 statements, 311 non-test.
That number is not the class — most are UI event handlers. The class as P2.73/P2.192
track it is *an automation/lifecycle emission started with no rejection handler, whose
failure therefore has no channel at all*.

My heuristic produced false positives I had to clear by reading — `pi-agent.ts:9628`
and `:9696` looked bare because the `.catch` is 20 lines below the call; both are
correctly belted (`reportAutomationEventFault`). Worth stating, because a class sweep
keyed on one line shape over-reports as readily as it under-reports.

**Confirmed survivors beyond the eighth, all reached by reading the call chain:**

| # | Site | Why it is the class |
| --- | --- | --- |
| 9 | `packages/shared/src/agent/codex-agent.ts:3334` | `void this.emitStopHookOnce()` in `forceAbort`. `emitStopHookOnce` (`:3610`) memoises `this.emitAutomationEvent('Stop', …).then(() => undefined)` — **no `.catch` anywhere on the chain**. |
| 10 | `packages/shared/src/agent/codex-agent.ts:3799` | `void this.endLifecycle()` in `destroy()`. `endLifecycle` (`:3634`) awaits `this.stopHookForTurn` and `emitSessionEndOnce` → `await this.emitAutomationEvent('SessionEnd', …)`. Unbelted. |
| 11 | `packages/shared/src/agent/nestor-cloud-agent.ts:230` | `void this.emitStopHookOnce()` in `abort()`; producer at `:564` is the same memoised, uncaught shape. |
| 12 | `packages/shared/src/agent/nestor-cloud-agent.ts:237` | same, in `forceAbort()`. |
| 13 | `packages/shared/src/agent/nestor-cloud-agent.ts:370` | `void this.endLifecycle()` in `destroy()` → `emitAutomationEvent('SessionEnd')` at `:320`. |
| 14 | `packages/shared/src/agent/pi-agent.ts:9728` | `void this.endLifecycle()` in `destroy()` → `emitSessionEndOnce` → `await this.emitAutomationEvent('SessionEnd', …)` (the BASE method, not `emitAutomationEventDetached`). **In a file P2.73 and P2.76 both swept.** |

That `emitAutomationEvent` genuinely rejects is not my inference — `base-agent.ts:2354`
says so in its own comment ("one of the two reachable ways the detached emission below
could reject at all"), and `drainAutomationEvents` was checked and *cannot* reject
(`await tail` on a doubly-handled promise plus `Promise.allSettled`), so the rejection
on the `endLifecycle` sites comes from the `SessionEnd` emission specifically.

The sharpest one is #9. Eight lines above it, in the same method, `codex-agent.ts:3326`
guards a different floating promise with an explicit
`.catch(() => { /* turn may already be done */ })` and the comment *"a rejection must
not surface as an unhandled promise."* The very next emission has none.

> **FINDING — `[doc:none]`, kind: bug.** Six more floating-emission survivors of the
> P2.73/P2.192/P2.284 class, at the six sites above, in three files (`codex-agent.ts`,
> `nestor-cloud-agent.ts`, `pi-agent.ts`). All out of my zone; **not fixed**. The fix
> is in the family already: `BaseAgent.emitDetachedAutomationEvent` (`base-agent.ts:2289`)
> is `protected` and both subclasses extend `BaseAgent`; for the memoised
> `emitStopHookOnce` shape it is a `.catch` on the stored promise rather than a call
> swap. `reportDetachedFault` is `private` and would need widening to `protected`.
> Evidence level: read, not run — I did not build a live rig, because doing so needs
> edits in files another lane may hold.

Adjacent and **not** claimed: `pi-agent.ts:3519/3531/3670/3686/3699/4130`
(`void this.handleXRequest(…)`) are dispatch handlers, not emissions, and P2.65/P2.66's
belts may already cover them — I did not assess them. `automation-system.ts:871`
documents itself as never rejecting; I read the contract, did not re-verify the body.

---

## P2.290 — the over-cited doc shorthand

**Category (b).** Corrected `packages/shared/src/capabilities/runtime-automations.ts`.

### What the page actually says, fetched and anchored

Anchor derived from the **rendered** page (`curl https://code.claude.com/docs/en/hooks`
and grep `id="…"`), never from a slug rule. Note the URL shape: `code.claude.com/docs/hooks`
**404s**; the corpus path is `/docs/en/hooks`. Both anchors I used are published:
`id="bash-if-matching"` (an explicit `<span id>` — the kind AGENTS.md warns is absent
from the markdown heading list) and `id="common-fields"`. Both are in
`scripts/claude-doc-anchors.tsv` for `hooks` (139 sections).

Verbatim, `hooks.md#bash-if-matching`:

> "The filter also fails open, running your hook regardless of pattern, when the Bash
> command can't be parsed. Because the `if` filter is best-effort, use the permission
> system rather than a hook to enforce a hard allow or deny."

**Absence check with a positive control**, because the claim is that the page does *not*
cover the other case: `"fails open"` occurs **exactly once** on the page (the positive
control — the detector finds what exists), and nothing on the page addresses an `if`
**rule** that will not compile. So sentence one is the unparseable **command**, and only
that; the direction for an unparseable **rule** is ours.

### The edit

The line read:

```
// fail-open on an unparseable rule or command (if_unparseable_fail_open).
```

It now separates the halves — UPSTREAM (quoted, anchored, scoped to the command) from
OURS (the rule, with the reasoning: the same sentence's best-effort clause plus the
P2.270 hazard where failing closed would silently stop ordinary source-anchored hooks,
and no longer silent since P2.277's `reportUnparseableIfRule`). Wording matched to the
sibling P2.277 corrected, `claude-permission-rules.ts:232-244` ("READ THE QUOTED
SENTENCE NARROWLY").

The stale `if_unparseable_fail_open` reference went with it: that registration-time
report retired with the V1 bridge in F4 and was never replaced (P2.277's own finding).

### Sibling sweep for the same shorthand — with a positive control

`git grep -na` (byte-honest) over `packages`, `apps`, `docs` for
`"unparseable rule or command"` and `"unparseable command or rule"`: **zero hits**
besides the one I fixed. Positive control on the same rig: a search for a string I had
just written (`"unparseable COMMAND"`) returned `runtime-automations.ts:323`.

`if_unparseable_fail_open` survives in four places, all correctly scoped as history
(`hooks-automation.ts:721`, `hooks-automation.test.ts:1341`, my corrected line, and two
plan/spec docs).

Every `best-effort` mention near the `if` filter was read. Two are correctly scoped to
the command (`claude-bash-rule.ts:1606`, `:1831` — both about the parser's
`'unparseable'` return). One is borderline:

> **FINDING — `[doc:claude]`, kind: forgotten-vs-doc (borderline).**
> `packages/shared/src/plugins/__tests__/hooks-automation.test.ts:1369` says
> *"The direction stays open (hooks.md: the filter is best-effort)"* about a garbage
> `if` **RULE** (`ifRule: '???'`). It does not claim the page documents an unparseable
> rule, and "the filter is best-effort" is verbatim true, so it is a softer instance
> than the one this row fixed — but it is the same shape: an upstream sentence carrying
> a case it does not decide. Out of zone (that test file belongs to the hooks lane);
> **not touched**. One clause would settle it.

### In-zone extra, done and declared

`runtime-automations.ts:298` cited **`hooks.md § if`**, and no such section exists —
measured, a bare `id="if"` scores **0** on the rendered page. The page's own link target
for the `if` field is `#common-fields` (`hooks.md:350`, `:370`: "the [`if` field](#common-fields)").
Changed. This is one line, in the same function as the row's line, and the same defect
class (a citation that does not resolve), so I took it rather than leaving a dead
section reference beside a freshly corrected one.

**Anchor guard, with a positive control on this exact file.** `bun scripts/check-doc-anchors.ts`
exits 1 at HEAD, but all five findings belong to other files — `AGENTS.md:101`,
`AGENTS.md:102`, `SessionManager.ts:564`, `pi-runtime-agent-definition.test.ts:329`,
`session-command-seam.test.ts:420`, all `[page-not-snapshotted]`, all pre-existing.
Summary line: `doc anchors: 282 corpus citations verified against 7 pages snapshotted
2026-08-25`. To prove my anchors were actually checked rather than skipped, I planted a
`hooks.md` anchor spelled `#zz-probe-anchor-does-not-exist` in place of my good anchor and
re-ran. The page and the anchor are written apart here, and `⟨…⟩` stands in for the pair
inside the transcript below, because `check-doc-anchors.ts` scans this file too: it excludes
only its own two source files, so a verbatim copy of its output is read back as a live
citation of a dead anchor, and the run reports itself. The transcript is otherwise unaltered.

```
[anchor-not-a-section] hooks.md#⟨zz-probe-anchor-does-not-exist⟩
    packages/shared/src/capabilities/runtime-automations.ts:324 — not a section of hooks.md …
doc anchors: 281 corpus citations verified …
6 finding(s).
```

282 → 281 and a named finding on my line. File restored and byte-diffed identical.

**Not fixed, reported:** the same file carries four `hooks.md:<line>` citations
(`:104`, `:153`, `:178`, `:187` citing `hooks.md:614`/`:612`, and `:404` citing `:699`)
plus `settings.md:227`/`:608`. Those are the decaying kind AGENTS.md warns about and
P2.285 owns the class; converting them is a different row, not a one-line adjacency.

---

## P2.289 — three specs asserting a reader that now exists

All three corrected. **Category (a)** — no upstream page governs our own inert lists.

1. **`docs/superpowers/specs/2026-07-29-inert-contracts.md` row 36** — was "Seven write
   sites, zero readers anywhere including tests." Now carries the correction plus the
   specific instruction not to "simplify" a write site, because the producer's docblock
   requires every `unparseableRule: true` to stay paired with `run: true`.
2. **`docs/superpowers/specs/2026-07-29-inert-worklist.md`** cosmetic entry — struck
   through and marked DONE, naming the reader.
3. **Unit U-D** (`inert-worklist.md`) — the third clause ("surface `unparseableRule` as
   an author diagnostic") is recorded as landed in P2.277.

The reader, verified in code rather than from the plan: `hooks-automation.ts` keeps
`ifRuleUnparseable = ifFilter.unparseableRule` in the dispatch loop and
`reportUnparseableIfRule` pushes an operator-visible `hookErrors` notice quoting the
rule, deduplicated per matcher object; pinned by
`hooks-automation.test.ts` ("a garbage if rule fails open with a diagnostic and the hook
always runs", asserting `hookErrors` length 1, the quoted `"???"`, and `failed open`).

> **FINDING — `[doc:none]`, kind: bug (in a spec header).** While recording U-D I found
> the worklist's own header (`:5-13`) closes **all five** §5 units and verifies U-D by a
> single clause — `knownToolNames` is passed at three sites. U-D has four clauses. At the
> moment that header was written, **two of them were still open** (`sourceRoot` supply,
> `unparseableRule` surfacing); one still is (`warning` reachability). I noted this in
> the U-D entry. A header that closes a unit on one of four clauses is the same failure
> mode as the inert list itself.

### The survey you asked for — what else on those lists has since become live

Method: enumerate every named identifier from `inert-contracts.md` §2 (38 rows) and
`inert-worklist.md` §2/cosmetic, then `git grep -naw` each over `packages` and `apps`,
excluding tests, and **read** the hits rather than counting them.

**A detector failure first, since it nearly became a result.** My first pass used
`git grep -na -w -- "$s" -- 'packages/*/src' 'apps/*/src'` and returned **0 hits for all
34 symbols** — a clean, plausible, entirely false "nothing has changed". The positive
control caught it: `SEATBELT_TESTING_WILDCARD`, which certainly exists, also scored 0.
Two bugs — a doubled `--`, and `packages/*/src` not matching as a git pathspec.
`-- packages apps` works (11 hits for the control). **A survey without a positive
control on a symbol you know exists is worth nothing here.**

**Five entries are stale. Four of them in the dangerous direction — they name live code.**
Reported, **not fixed** (only the three named entries were in scope):

| Entry | Status at HEAD | Evidence |
| --- | --- | --- |
| `inert-contracts.md` **row 23** — `AgentDefinition.memory` / `AgentMemoryScope`: *"No directory is created, no MEMORY.md is injected, the spawner never reads the field. `agent-memory` appears nowhere in code."* | **LIVE — all three clauses false, and the last is byte-false.** | A whole module `packages/shared/src/agent/memory/agent-memory.ts` exports `AGENT_MEMORY_DIR = 'agent-memory'`, `AGENT_MEMORY_LOCAL_DIR`, `prepareAgentMemoryDirectory`, `formatAgentMemoryPromptBlock`; `SessionManager.ts:170` imports them and `:14214`/`:14251` calls both on the child-session spawn path; `child-session-port.ts:74` carries `memory?: AgentMemoryScope`. |
| `inert-contracts.md` **row 8** + `inert-worklist.md` §2 `ClaudeHookIfCall.sourceRoot` — *"never supplied"* | **LIVE.** | `hooks-automation.ts:1228` supplies it: `...(matcher.ifSourceRoot === undefined ? {} : { sourceRoot: matcher.ifSourceRoot })`, with a comment naming it as "the half that was declared and never supplied". Fed from `AutomationMatcher.ifSourceRoot`, set in `runtime-automations.ts`. This is U-D clause 1. |
| `inert-contracts.md` **rows 4 and 37** + `inert-worklist.md` §2 `PluginHookDescriptor.args` and cosmetic `statusMessage` — *"absent from `RuntimeHookRegistration`", "never read by `runtime-automations.ts`"* | **LIVE (U-C landed).** | `resolver.ts:422/424/426` declares `args`, `timeoutMs`, `statusMessage`; `:1455-1461` copies all three; `runtime-automations.ts:369` reads `hook.statusMessage` and `:401` reads `hook.args`. |
| `inert-contracts.md` **row 1**, second half — *"the uncallable `macosSeatbeltBashSandboxEnabled`"* | **LIVE.** | `getMacosSeatbeltBashSandboxEnabled()` (`config/storage.ts:1308`) is read in production by `claude-agent.ts:3075` and `pi-agent.ts:5389`. (The **first** half is unchanged and still an owner decision: `bash-seatbelt.ts:87` is still `SEATBELT_TESTING_WILDCARD = true`.) |
| `inert-contracts.md` **row 19** + `inert-worklist.md` cosmetic — `PiPermissionReceiptV1.policyMatch` | **DELETED — stale in the harmless direction.** | Zero hits in any `packages`/`apps` source (plain `grep -a`, no `-w`). `docs/superpowers/plans/2026-07-29-inert-unit-e.md:14` records `policyMatch \| **delete** \| 3a57a709`. The row still describes 14 live write sites. |

**Checked and still accurate** (so the lists are not wholesale rotten): rows 24
(`whenToUse` — `buildSkillListingPart` at `prompt-builder.ts:477` still does not read it;
the 11 hits are the workflow-loader's same-named, different-family field, §4's own trap),
26 (`requiredSources` — nothing but the EditPopover hint text), 27 (`structuredContent` —
still **0** readers across `apps/electron/src`, `packages/ui/src`, `apps/webui`), 32
(`AGENT_COLORS` — the new hits at `runtime-agent-definition.ts:908`/`:1327` are
validation, not display), 33 (`argumentHint` — still live on the prompt-command path,
inert on the skill path), 35 (`getValidationErrorMessage` — still one line), and
worklist `isManagedChannelServerAllowed` (one hit, its declaration).

Two smaller ones worth recording rather than losing:

> **FINDING — `[doc:none]`, kind: never-looked-at.** Row 28 says `thinkingBudget` has
> *"exactly one hit repo-wide — its declaration"*. It now has four, and the three new
> ones are worse than a reader: `apps/electron/resources/docs/llm-tool.md:41`, `:158`,
> `:209` are **shipped user-facing documentation** that documents the parameter,
> including a troubleshooting row "thinkingBudget without thinking → Add `thinking: true`".
> The field is still inert; the product now ships a page promising it works. The row's
> count is wrong and its consequence is understated.

> **FINDING — `[doc:none]`, kind: never-looked-at (minor).** `skillInfo.requiredSources`
> exists in both locales (`en.json:1950`, `ru.json:1982`) and no component reads it —
> a dangling i18n key for the inert field in row 26. Parity/sorted stay green either way.

---

## Gates — all run, with proof of work

I added no i18n keys, so `lint:i18n:*` were **NOT RUN** (nothing to check). No full repo
suite, per the implementation-first budget.

| Gate | Result | Proof quoted from the output |
| --- | --- | --- |
| Zone tests, through the mutex (`--label DOCS`) | pass | `116 pass / 1 skip / 0 fail / 267 expect() calls`, `Ran 117 tests across 3 files. [12.11s]` — watcher + `runtime-automations.test.ts` + `hooks-automation.test.ts` |
| Watcher suite alone, post-fix | pass | `8 pass / 0 fail / 14 expect() calls`, `Ran 8 tests across 1 file.` |
| Re-break at `f58f66a36` | fails as required | `5 pass / 3 fail / 11 expect() calls`, `Ran 8 tests across 1 file. [4.73s]` |
| `tsc --noEmit`, `packages/server-core` (run from the package dir) | pass | exit 0, **0 lines of output**, `grep -c 'error TS'` = **0** |
| `tsc --noEmit`, `packages/shared` (`bun run typecheck:shared`) | pass | exit 0 |
| eslint, from the package dir (not the repo root) | pass | `packages/shared/src/capabilities/runtime-automations.ts errors=0 warnings=0`; `packages/server-core/src/projects/project-capability-watcher.ts errors=0 warnings=0`; `…/__tests__/project-capability-watcher.test.ts errors=0 warnings=0` (JSON formatter, so "clean" is a counted result, not empty output; control: a bogus path errors with "No files matching the pattern") |
| `git diff --check` on my five paths | pass | exit 0, no output |
| `bun scripts/check-doc-anchors.ts` | exit 1, **none of it mine** | `282 corpus citations verified against 7 pages snapshotted 2026-08-25`; 5 pre-existing `[page-not-snapshotted]` findings in `AGENTS.md`, `SessionManager.ts`, and two test files. Positive-controlled on my own file (282 → 281 with a planted bad anchor). |

There is no `typecheck:server-core` script in the root `package.json` (the list is
`typecheck`, `:shared`, `:all`, `:build-scripts`, `:scripts`, `:electron`); I ran `tsc`
from `packages/server-core` directly.

---

## Open items for the controller

1. **P2.284 is closed at half the family's standard, by zone constraint.** The escape is
   gone; the **label** the other seven got is not there, because this module has no
   record and its only production host is `SessionManager.ts`. If the owner wants the
   full family treatment, it is an `onError?: (target, error) => void` on
   `ProjectCapabilityWatcherOptions` plus one wiring line at `SessionManager.ts:5642` —
   one row, two files. Doing it without the wiring would ship a dead option.
2. **Six more survivors of the same class** (table above). The eighth being fixed neatly
   is worth less than these six being on the tracker.
3. **A vacuous assertion in `detached-automation-event.test.ts:132`**, and the same
   `process.on('unhandledRejection')` pattern will be vacuous in any future bun-test rig.
4. **Five stale entries on the inert lists**, four naming live code. A sweep acting on
   row 23 today would delete the agent-memory module's reason to exist.
5. **The 13-vs-14 NUL-file count** discrepancy between P2.73's enumeration and P2.274's
   prose.

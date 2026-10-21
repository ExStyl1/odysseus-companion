# Measured Traps — Full Narratives

The one-per-trap summaries live in `AGENTS.md` § "Traps That Have Each Cost A
Real Measurement" — that list is the operating rule set; THIS file is where
each trap's full evidence lives (what was measured, when, what it cost, and
why the rule is shaped the way it is). Moved out of `AGENTS.md` verbatim on
2026-08-21 (owner request: keep the guide tight). When a new trap is added,
add its rule to `AGENTS.md` and its narrative here.


- **"Pre-existing" measured against your own base is not "pre-existing on
  `master`", and on a long-lived branch the difference is a red release.**
  Every executor followed the known-failing register's rule correctly —
  reproduce on a clean worktree at *your* base — and the register still grew to
  15 rows that `master` does not have, because a per-base check cannot see an
  accumulation. **Before any merge, compare against the target branch**, not
  against your base: `master`'s last pipeline being green while the branch is
  red is the whole finding, and it is invisible from inside the branch. Found
  2026-07-31, at the merge gate of a ~200-commit train.
- **Several source files carry a NUL byte, and plain `grep`/`rg` skips such a
  file SILENTLY.** Use `grep -a` for any absence claim. Four "this identifier
  does not exist" findings in this repo's audit history were this. And never
  pipe a grep through `head -N` before you know the hit count — a production
  call site sorting below the cut reads exactly like dead code.
- **`git commit <pathspec>` takes the file's WORKING-TREE state, not your
  hunks.** Two agents editing one file at overlapping times WILL cross, and each
  lands under the other's subject. Partial staging is interactive and therefore
  unavailable. Zone parallel work **by file**, not by subsystem; if two units
  need one file, run them in sequence.
- **Two concurrent `bun test` processes manufacture failures.** Several session
  suites mutate `process.env.NESSY_CONFIG_DIR` at module scope. Check nothing
  else is running before recording a new failure, and check
  `docs/superpowers/specs/2026-07-29-known-failing-tests.md`.
- **A `mock.module` without a spread is a package-wide amputation, and one
  without a restore is permanent for the process.** `mock.module` is global to
  the test process, so a replacement listing only the two exports one file needs
  un-implements every OTHER export of that module for some OTHER file in the same
  batch — **and you cannot choose which, because `bun test` ignores the order of the
  paths it is given** (P6.848, 2026-09-08; the narrative is at the end of this file).
  This paragraph used to say *"for every test file that loads afterwards"* and reasoned
  from `packages/server-core` sorting before `packages/shared`; the sort is real for a
  directory walk and says nothing about an explicit path list. Measured 2026-08-07: `sessions.memory.test.ts`
  stubbed `getMemoryEnabled` to `true`, and `agent-memory.test.ts`'s
  "is entirely inert when auto memory is off" then read `true` from the stub
  while its own `config.json` on disk said `false` — green alone, red in CI, and
  the failure pointed at memory rather than at the file that caused it. **Four
  rounds of static reasoning got this wrong**, because the code under test was
  never consulted; what settled it was printing the INSTALLED function's own
  source (`String(mod.getMemoryEnabled)` → `() => !0`). Bisection alone would not
  have found it either: no single file reproduces it, the pair has to load in
  order. Spread the real module AND restore it in `afterAll` — the pattern of
  `claude-gateway-adapter.test.ts:79`. The spread alone is not sufficient when
  the override is the point of the mock.
- **`bun run typecheck:all` covers `apps/cli` and `packages/codex-responses-adapter` only since 2026-08-13** — both spent their whole prior life outside the chain (the adapter had no tsconfig at all), which is how a real TS error sat unreported in the adapter's tests. On any base older than that, run them separately.
- **`typecheck:all` does not typecheck `packages/pi-agent-server`'s TESTS
  either**, so "typecheck:all exit 0" is not evidence that a test file you wrote
  in that package typechecks. `tsconfig.typecheck.json` there excludes
  `**/*.test.ts`; drop the exclusion and the package reports 567 errors
  (re-measured 2026-08-21; 429 at the first measurement — the backlog grows),
  ~50 test files' worth, overwhelmingly the same
  `const [x] = build(…); x.tools` shape (TS18048). One report has already cited that green exit for a test file
  carrying 15 real errors. Until the backlog is cleared, typecheck a test file
  you touch by pointing `tsc` at a config without the exclusion, and fix what it
  says.
- **A doc line number decays; the quoted sentence does not.** Upstream pages
  grow — six citations in one plan drifted by seven lines because the page grew
  between two fetches. Quote the sentence and read the WHOLE line: several
  defects here hid in the second sentence of a two-sentence line.
- **`electron:dev` runs the host AND the Pi subprocess from BUILT bundles.** A
  renderer change is picked up by Vite immediately; a main-process change is
  not, so a fix can be on disk and absent from the running app. And a dev build
  is not the shipped artifact: `resolveInterceptorBundlePath` preloads the `.ts`
  source when `!isPackaged` and `dist/interceptor.cjs` when packaged, returning
  `undefined` if the bundle is missing — the Pi subprocess then starts
  **unpatched, with no error**. Live evidence must come from a packaged build.
- **`rm -rf release` before `bun test`.** A dmg/AppImage build leaves the
  packaged copy of the renderer sources at `release/**/Resources/app/src/`, and
  `bun test` from the repo root COLLECTS them — 182 extra files whose path
  aliases no longer resolve. Measured 2026-08-05: 12 928 tests and 14 phantom
  failures with `release/` present, 11 464 and 4 without. Get the packaged
  evidence first, then delete the artifact, then run the wave.
- **`rm -rf packages/pi-agent-server/dist` (the stale-dist step of that
  package's suite) leaves the DEV app's Pi path broken until
  `cd packages/pi-agent-server && bun run build`.** The test run rebuilds
  `dist/index.js` but not the `dist/package.json` that `write-dist-package.ts`
  writes, so the host reads the wrapper's own version and refuses:
  `Unsupported Pi runtime 1.0.2; expected 0.84.0`. The turn then ends in
  ~700 ms with no tool row — which reads exactly like "the model chose not to
  dispatch". Measured 2026-08-21 (a live sitting's claim was lost to it):
  rebuild before any live sitting that follows that suite, whether or not the
  package's source was touched.
- **Electron does not inherit the shell's `ulimit -n`, and this machine's
  floor is 256.** A launcher that runs `ulimit -n 8192; bun run electron:dev`
  raises the limit for Bun and NOT for Electron (`launchctl limit maxfiles` is
  256 and Electron never raises its own), so an fd-hungry path fails in the
  app while every shell probe of the same operation succeeds. Measured
  2026-08-21: an 807-file `Promise.all` in `ProcessStore.list()` EMFILE-killed
  runtime switches for two sittings while the retention hypothesis looked
  right — the fix was bounding the fan-out, and no shell-side limit could have
  saved it.
- **A test prompt that names a tool and forbids calling it in the same
  sentence trips Pi's Guardian, and the wreckage reads like a product bug.**
  Guardian classifies the embedded do-not-call instruction as prompt
  injection (`Guardian denied this action [prompt_injection]`), the model
  then reloads WITHOUT the forbidden name, and the next turn's
  `Tool … not found` is indistinguishable from a deferral/dispatch defect.
  Cost a full MCP-W2 sitting 2026-08-21. Phrase live-case prompts positively
  ("load X now; you will call it on the next message"), and when a case
  fails on `Tool not found`, read the Guardian lines before diagnosing.
- **An empty `main.log` from a PACKAGED build is not evidence of anything.**
  `logger.ts` disables both electron-log transports outside debug mode, so a
  packaged launch writes no main.log on success OR failure. One close-out wave
  read "zero log lines" as "the app never ran its JS" and chased a phantom
  fresh-init defect for a night; the packaged boot was fine, and the real
  defect (an unhandled layout rejection idling windowless) was visible only in
  the DEV app's log. Boot-fatal errors now also write `<config dir>/logs/boot.log`
  — read that, or launch with the documented `NESSY_IS_PACKAGED=false` lever.
- **A finding that is an ABSENCE needs a positive control.** "X does not happen"
  proves nothing until something on the same rig makes X happen. One row here
  was refuted by measurement precisely because a control existed.
- **Four shapes an "unused identifier" sweep keeps missing.** Each produced a
  wrong dead-code finding in this repo's audit history. (1) **Getter/setter
  pairs** — grepping the config key lands on the dead setter and hides the live
  getter. (2) **Default-parameter reads** (`fn(x, source = CONST)`) — a `const`
  used only as a default value looks like a declaration to a call-site grep.
  (3) **Enforcement one layer up** — the identifier really is unwired while the
  *consequence* is false, because something upstream already stripped the
  record; verify the consequence separately from the identifier. (4)
  **Identically-named symbols in a sibling subsystem** — `disallowed-tools` is
  enforced for subagents and not for skills. Name the subsystem in the finding.
  And a sweep that reports identifiers must not also assert consequences it did
  not test: five surviving rows in one pass needed their consequence rewritten.
  **Before filing one, read the nine dated owner decisions indexed in
  `docs/superpowers/specs/2026-07-29-inert-worklist.md` §3** — a wildcard
  seatbelt pending GA, a model-allowlist filter deliberately kept off the
  persistence boundary, a parsed-but-unconsumed `autoMode` key, and six more.
  They are decisions with reasons, not defects, and one of them ("just call
  `isManagedModelAllowed` at the selection site") permanently destroys a user's
  model list if it is "fixed".
- **Collect a fan-out's results against what was DISPATCHED, not against what
  has ARRIVED.** A demotion pass counted refutations from the results present
  when it was written, and nothing flagged the challenger still running; its
  verdict refuted two more rows. Two other challengers died on API 529 and their
  re-run refuted four more. Every partial collection understated the damage.
- **An unchallenged verdict is weaker evidence than a challenged one, and the
  difference must stay visible.** Record "unchallenged" as its own state rather
  than folding it in with "confirmed" — in the one series that measured this,
  "unchallenged" turned out to mean "probably wrong".
- **A live case's DETECTOR is the thing most likely to be wrong, and a broken
  detector reports a product defect.** Measured 2026-08-08 while proving
  auto-compaction: three detectors in a row, each of which looked authoritative.
  (1) `ContextUsageSnapshot.lastCompaction` is declared in the type and is never
  filled on the Pi path — it reported "never compacted" through **twenty-seven**
  real compactions. (2) A transcript service-message match (AGT-6's method)
  reported a compaction that belonged to a PREVIOUS run, because the harness had
  fallen back to a reused session and the case scanned the whole transcript. (3)
  Reading `TokenUsage.contextTokens` where the threshold is compared against
  `ContextUsageSnapshot.inputTokens` compared two different counters. **A typed
  field is not a filled field; a marker in a reused session is history; two
  counters with similar names count different things.** Before filing "feature X
  never happens", confirm the negative against a source the feature writes
  itself — here the session's own `.pi-sessions/*.jsonl`, which settled it in
  one read. And prefer a detector the product actually promises (the context
  came back down) over a field that merely ought to be populated.
- **A narrowing knob set too aggressively manufactures its own failure.** The
  same run set `NESSY_AUTO_COMPACT_WINDOW=30000` to make a threshold reachable;
  a session's BASE context (system prompt plus capabilities) is ~46 000, so the
  threshold sat below the floor the session can ever reach, it compacted after
  every turn forever, and the numbers read exactly like "compaction is broken".
  Size a test knob against the system's resting state, not against zero.


## A syntax error anywhere in the program suppresses SEMANTIC diagnostics for every file in it (measured 2026-08-28)

A lane's positive control reported **nothing** — no error where it had deliberately planted one. The
cause was not its own file: **a concurrent lane was mid-write on an unrelated source file in the same
program**, and `tsc` stops at parse errors before it ever reports semantic ones.

So under parallel work, **the absence of a semantic error in a run that had any parse error is not
evidence.** The run looks like a pass. Nothing says "I did not get that far."

Two consequences, and the second is the expensive one: a green typecheck taken while another lane is
editing may have checked nothing, **and a positive control taken in the same conditions silently
validates the wrong thing** — the very instrument you are trusting to prove the check works.

Before believing a typecheck result under concurrency: confirm the run reported **zero parse errors**,
not merely zero errors overall, and re-run the control if any file in the program was dirty.


## The NUL-byte file set, ENUMERATED — and the wrong probe that keeps re-deriving it (re-measured 2026-08-28)

The rule is real: a plain `grep` skips a file containing a NUL byte **silently**, so any absence claim
over one is worthless. **The count is 14 tracked `.ts`/`.tsx` files.** Here they are, so nobody has to
guess again:

- `packages/server-core/src/bootstrap/storage-runtime.ts`
- `packages/server-core/src/handlers/rpc/capabilities.ts`
- `packages/server-core/src/projects/project-capability-watcher.ts`
- `packages/server-core/src/sessions/__tests__/workspace-project-contract-corpus.test.ts`
- `packages/shared/src/agent/base-agent.ts`
- `packages/shared/src/agent/core/guardian-consult.ts`
- `packages/shared/src/agent/memory/rule-matching.ts`
- `packages/shared/src/agent/permissions-config.ts`
- `packages/shared/src/marketplace/registry-source.ts`
- `packages/shared/src/marketplace/service.ts`
- `packages/shared/src/sessions/mirror/host.ts`
- `packages/shared/src/sessions/mirror/in-memory.ts`
- `packages/shared/src/telemetry/usage-metrics.ts`
- `scripts/ios-wire-enum-parity.ts`

**But the controller named the wrong files in briefs all day** — `mode-manager.ts` and
`permission-dsl.ts` are **not** in the set (0 NUL bytes each, verified), and lanes were told they were.
Harmless in effect, because `grep -a` is always safe — **and corrosive in practice**: a lane that
checks a named file, finds no NUL byte, and concludes the warning is folklore will stop applying a
rule that is true of fourteen other files.

**The probe that manufactures a false positive**, and it is the one that looks right:
`grep -qa $'\x00' <file>` under zsh. **A shell argument cannot carry a NUL**, so the pattern collapses
to the empty string and matches every line of every file. It once reported 6,449 affected files.

**Use a probe that reads bytes**, not a shell pattern:
`python3 -c "import sys;print(b'\x00' in open(sys.argv[1],'rb').read())" <file>`.


## A background formatter silently discards every edit made while it runs (measured 2026-08-28)

`scripts/sort-plan-tracker.py` reads the whole tracker, sorts it, and writes it back. Launched with
`nohup … &` and followed immediately by row edits, it **discarded four of them** — the edits landed
between its read and its write.

Everything about the failure is quiet. The sort reports success. `git diff` shows the sorted file. The
rows revert to `⬜` **while keeping their notes**, so each one still says *"CLOSED `<sha>`"* — the row
reads as closed to a human and as open to every counter. It was found days later by an unrelated pass,
not by the controller who caused it.

The general shape: **any whole-file rewriter run concurrently with edits to that file is a
lost-update race**, and a formatter is the easiest one to start in the background because it feels
read-only. It is not.

Two defences, and take both: **never background a whole-file rewriter you are still editing**, and
give the artefact a *consistency invariant a later pass can check* — here, a row whose note names a
commit while its sha cell is empty is a lost pin, and `plan-status.py` now reports it.


## Bun ignores a mid-process `HOME`, Node follows it — so `bun test` cannot see a whole defect class (measured 2026-08-28)

Measured on three runtimes with a passwd-entry control: **Node 24.4.1 and Electron 39.8.10 (Node
22.22.1, the binary we ship) both follow a `process.env.HOME` changed mid-process. Bun 1.3.14 ignores
it.**

The affected process — the one that both applies an administrator's `env` block and resolves the
credential path — is **Electron main, which is Node**. So a `bun test` written to assert the real
defect *cannot fail*: the runtime under the test does not have the behaviour under test.

This is a hole in the instrument, not in the product, and it is the dangerous kind: the test is
written, it runs, it is green, and it proves nothing. Same family as the assertion that passes
vacuously against `undefined`.

Work around it by testing the *latch* rather than `$HOME` — that is real coverage of our own code. But
**the end-to-end claim needs a Node-hosted check or a packaged live case**, and no amount of `bun test`
substitutes for it.

## A FAILED `git commit` leaves your work staged for whoever commits next (measured 2026-08-28)

The `git add` race has a second mechanism, and this one is invisible while it happens.

A lane's `git add` succeeded; the `git commit` in the same chain **failed on `cannot lock ref
'HEAD'`** — another lane held the ref. Its two new files stayed in the index, and the next lane to
commit carried them into **its own** commit, under its own message. The first lane discovered it only
by re-checking afterwards.

So the rule "commit by explicit pathspec" is not sufficient under concurrency: **a commit that does
not happen still leaves the index loaded.** Retrying does not help — by then the files are gone.

Prevention: the isolated-index recipe (`GIT_INDEX_FILE` + `commit-tree` + `update-ref` with an
old-value guard) never touches the shared index. Detection: `git show --stat` immediately after every
commit, and `git status` immediately after every failed one.


## `Date.parse` does not reject an impossible date — it rolls it forward (measured 2026-08-28)

`Date.parse('2026-02-31T00:00:00Z')` does **not** return `NaN` on this runtime. It rolls into March.

So the idiomatic validity check — parse it, and treat `NaN` as invalid — accepts **31 February**, and a
lane building an end-of-life notice was one step from publishing `Retired 2026-02-31` to users as a
label on a model.

The failure is silent and it is in the *validator*, which is the worst place for it: the code looks
like it is checking, the check runs, and it passes. Same family as the assertion that passes vacuously
against `undefined`.

**Round-trip instead of parsing**: format the parsed date back to ISO and require it to equal the
input. That rejects rolled dates, and it costs one line. Applies to any date arriving from a catalogue,
a config file or a header — anywhere the value is someone else's.


## Import ORDER in a renderer test turns a 0.6 s import into 42 s, and it surfaces as a hang (measured 2026-08-28)

In `slash-command-menu.test.tsx`, importing any `@nessy-agent/shared/*` subpath **before** the
component under test made that component's import cost **~42 s instead of ~0.6 s**. The symptom is
`(fail) (unnamed) … hook timed out` — **indistinguishable from a hang**, with no clue pointing at
import order.

Two things make this expensive. The failure names nothing you changed, so the natural first suspicion
is your own code. And the default 5 s hook timeout means **pre-existing tests in the same file are
exposed to the same hazard** the moment anyone adds an import above them — the file was one line away
from six mystery failures.

Mitigation used: order the component's import first, and set an explicit generous hook timeout so a
slow import fails as slow rather than as broken. If you see an unnamed hook timeout in a renderer
suite, check import order before anything else.


## The pathspec trap has an INDEX variant: `git add <one file>` also takes the working-tree state (measured 2026-08-28)

The recorded rule is that `git commit <pathspec>` takes the file's working-tree state, not your hunks.
Here is the variant that catches you even when you are being careful.

A lane ran `git diff --stat` to check a test file was clean, then `git add <that file>` and committed.
**Another lane edited the file in the window between those two commands**, so the `add` staged their
hunks along with its own and the commit shipped foreign work under this lane's message.

So the inspection and the staging are two separate reads of a moving tree, and **nothing about naming
one file protects you** — the pathspec rule is about *when* the content is read, not *how much* of it.

The repair the lane used is the one to copy: restore the file to `parent + my hunk only`, **index-only**,
so the other lane's code stays in the working tree for them to commit themselves. Do not `checkout` it
away.

Prevention: derive the blob from `HEAD` and apply your own edit to it (the isolated-index recipe), or
re-check `git diff` immediately before the `add` and `git show --stat` immediately after the commit —
which is how this was caught.


## "Spread AND restore" is NOT enough: restoring from the imported namespace restores the MOCK (measured 2026-08-28)

The recorded rule — *a `mock.module` without a spread amputates the module; without a restore it is
permanent* — is right and **incomplete**, and the gap costs manufactured failures in neighbouring
suites.

`mock.module` **mutates the imported namespace object in place**. So the idiomatic restore —
`import * as realPath from 'node:path'` at the top, then `mock.module('node:path', () => realPath)` in
an `afterEach` — **restores the mock**, because `realPath` is the very object that was mutated. The
restore runs, reports nothing, and leaves the mock installed for every later file in the process.

**Snapshot the real module before the first mock**: `const real = { ...mod }` at module scope, mock
from a spread of that snapshot, and restore from the snapshot — never from the live namespace. Cost
when missed: six manufactured failures in a suite the lane had not touched.


## A probe run inside a Claude Code session resolves a DIFFERENT binary than the app ships (measured 2026-08-28)

Measuring the SDK's behaviour from a lane running inside Claude Code, the SDK resolved **2.1.250**
while the app vendors **2.1.223** — because the child inherits **`CLAUDE_CODE_EXECPATH`** from the
session doing the measuring.

So the rig measures the harness, not the product, and every number it produces is about a binary the
user will never run. Nothing errors; the arms simply describe a different artefact.

**Sharpened 2026-08-28: scrubbing the CHILD's environment does not help — the resolution happens in
the PARENT.** A probe run from outside the package resolved the SDK through Bun's global cache
(`0.3.232`) and then picked binary `2.1.232` via an inherited `CLAUDE_CODE_EXECPATH`, producing **a
full set of confident wrong version numbers** before anyone noticed. Run the probe from inside the
package whose resolution you mean to measure, and assert the version you got.

**Pin the binary explicitly and scrub the environment** — every `CLAUDE*` and `ANTHROPIC*` key —
before any SDK measurement. The packaged app is unaffected; this is a measurement hazard, not a
shipped defect, which is precisely why it produces confident wrong numbers rather than a failure.

Same family as the dev-build trap: what you are running is not what ships, and only an explicit pin
tells you which one answered.


## A timeout tuned on the fast platform manufactures an absence on the slow one (measured 2026-08-28)

Probing whether the codex binary emits a config warning, a **5 s** wait returned "no warning" on
darwin-x64 under Rosetta. The warning was real; the binary had simply not got there yet. Raised to
**25 s**, it appeared.

The failure is not the timeout — it is that the probe was a **negative** one. A too-short wait on a
positive probe fails loudly (you were looking for something and did not get it). On an absence probe
it returns exactly the answer you were testing for, cleanly, with no signal that anything went wrong.
Rosetta, a loaded machine, and CI are all slower than the laptop the number was chosen on.

**An absence finding needs its positive control on the SLOW platform, not the fast one** — and the
control must be the same shape as the probe: run something that definitely does produce the output,
under the same timeout, on the same rig. Same family as the size-threshold trap (a narrowing knob set
below the system's resting state manufactures its own failure).


## A generator redirected onto its own output writes zero bytes, and two empty runs compare equal (measured 2026-08-28)

`bun scripts/refresh-nestor-model-windows.ts > <the file it generates>` produced **zero bytes**. The
shell truncates the redirect target before the process starts, and this repo's bun preload imports
that same file — so the script read an emptied module and emitted nothing.

The dangerous half is the check people write next. A refresh script is usually verified by running it
twice and diffing the outputs to prove determinism. **Two zero-byte outputs compare equal**, so the
determinism check passes *on emptiness* — a green signal produced by the failure itself. Same family
as the `not.toEqual(expect.arrayContaining([a,b]))` that passes when either element is absent.

Write to a temporary path and move it into place, and make the check assert a non-empty expected shape
(a row count, the provenance line) rather than only equality between two runs.


## An absence probe with a `head` in it cannot fail (measured 2026-08-28)

The rule "never `head -N` a grep before you know the hit count" already existed here. This is the
concrete mechanism, and it is worse than the rule sounds, because the truncation is not random.

`git grep … | head` reported `buildClaudeContextWindowWarning` as having **no non-test caller**. It
has one. The real caller was truncated away **because `git grep` sorts by path and the test file
sorts first** — so the probe filled its entire budget with the very files an "is this called from
production code?" question is trying to exclude.

That is the failure mode: a `head` on a sorted absence probe does not sample the hits, it keeps the
**alphabetically earliest** ones, and `__tests__/` beats almost everything. So the probe is not merely
unreliable — it is **biased precisely against the answer you are looking for**, and it returns a
confident, clean-looking empty result.

Count first (`grep -c`, `git grep -c`), then look. If output volume is the worry, filter by path
(`":!*__tests__*"`, `":!*.test.*"`) rather than truncating — a filter states what it excluded, a
`head` does not.


## A re-break campaign is a writer to the file it restores

Measured 2026-08-27, on `codex-agent.ts`, at a cost of two lanes each believing
the other had corrupted their work.

Zone rules on this plan assign a file to one lane, and every lane reads that as
"whoever is editing it". A lane proving its fix by **re-breaking** it is not
obviously editing anything — it reverts, runs, restores, and ends where it began.
But the restore is `cp`-shaped: it writes the whole file from a copy taken before
the loop started. For as long as that loop runs, the lane is a **writer**, and
every write silently discards whatever landed in the meantime.

What it looked like from the other side: a second lane made an edit and found it
**gone thirty seconds later, fully reverted**, twice. It concluded its neighbour
was rewriting the file under it — correct — and moved all its measurement into an
isolated worktree with its own `@nessy-agent/*` links, which cost it most of a
run. Neither lane was doing anything wrong by the rules as written.

Worse, this is the mechanism that nearly re-armed a defect. The re-breaking lane's
saved copy predated a sibling's fix, so each restore reinstated a parameter
default of `0` that the sibling had just made unconditional — and `0` was the bug.

So: a re-break loop takes the file's lock for its whole duration, not for the
instant of the edit. Either run it in a throwaway worktree, or restore from
`git show HEAD:<path>` re-read **each cycle** rather than from a copy taken once.
And if a file moves under you mid-campaign, reset to HEAD and re-apply your hunks
rather than restoring your copy over the top.

## The NUL-carrying files, enumerated — and the grep that hides them

`AGENTS.md` records the rule ("use `grep -a` for any absence claim") but never listed the
files, so nobody could tell whether their own sweep was affected. Measured repo-wide
2026-08-27 by reading bytes, not by grepping:

| File | NULs |
| --- | --- |
| `packages/server-core/src/bootstrap/storage-runtime.ts` | 2 |
| `packages/server-core/src/handlers/rpc/capabilities.ts` | 2 |
| `packages/server-core/src/projects/project-capability-watcher.ts` | 1 |
| `packages/server-core/src/sessions/__tests__/workspace-project-contract-corpus.test.ts` | 1 |
| `packages/shared/src/agent/base-agent.ts` | 1 |
| `packages/shared/src/agent/core/guardian-consult.ts` | 1 |
| `packages/shared/src/agent/memory/rule-matching.ts` | 1 |
| `packages/shared/src/agent/permissions-config.ts` | 1 |
| `packages/shared/src/marketplace/registry-source.ts` | 1 |
| `packages/shared/src/marketplace/service.ts` | 2 |
| `packages/shared/src/sessions/mirror/host.ts` | 2 |
| `packages/shared/src/sessions/mirror/in-memory.ts` | 7 |
| `packages/shared/src/telemetry/usage-metrics.ts` | 2 |
| `scripts/ios-wire-enum-parity.ts` | 4 |

**Fourteen, not one.** An earlier pass in this series checked a handful of named files,
found only `base-agent.ts`, and left the impression the problem was that narrow. Several of
these sit at the centre of permission, capability and storage work — `permissions-config.ts`
most of all.

**Why the wrapped `grep` hides them:** it is `ugrep -G --ignore-files -I`, and `-I` skips
binary files outright, returning **zero hits with exit 0**. A sweep over the list above
therefore reports a clean absence while never having opened the file. One lane lost ten
`withCapabilitySnapshot` call sites this way and caught it only with a positive control.

Two neighbouring shell traps measured in the same session, both of which return
"no results" for a search that never ran:

- `xargs rg` fails, because `rg` here is a shell function, not a binary on PATH.
- zsh does not word-split an unquoted `$DIRS`, so `grep <pat> $DIRS` searches **nothing**
  and exits 1 — indistinguishable from a genuine no-match.

And one of my own, same day: `grep -c $'\x00' <file>` cannot work, because a shell argument
cannot carry a NUL — the pattern collapses to the empty string and matches **every line of
every file**. It reported 6449 affected files with total confidence. Detect NUL bytes by
reading bytes (Python, `perl -0`), never by passing one as a pattern.

**The rule that survives all of this:** an absence claim needs a positive control on the
same rig — a search you know should hit, run the same way, hitting.

## A dated run narrative is a record, not a document — annotate, never rewrite

Question raised by P2.211 on 2026-08-27: `docs/testing/cdp-runs/…-run-narratives.md:653`
repeats a claim that has since been measured dead. Does a dated narrative get corrected?

**No. Controller ruling: never edit the measurement.** These files exist to say what was
observed on a given day, and a narrative silently updated to today's truth is no longer
evidence of anything — the one property that makes it worth keeping is that it was written
then. Rewriting it also destroys the ability to ask *when* a belief changed, which is
exactly the question a stale claim provokes.

**But do not leave a reader to be misled either.** Append a dated annotation beside the
line — "superseded YYYY-MM-DD: <what is true now>, see <current source>" — so the record
stays intact and the correction travels with it. Append-only, like the release notes.

The current truth lives in the current documents. A narrative that disagrees with them is
not a defect in the narrative.

## A piped gate reports the pipe's exit status, not the gate's

Measured 2026-08-27, after a lane reported that `bun-test-lock.ts run` "exits 0 without
running anything when it cannot acquire the mutex" and nearly recorded a green gate for a
test that never executed.

**The symptom was real. The diagnosis was wrong, and the difference matters** — a lane that
believes the lock tool is broken will stop trusting a tool that works.

Measured directly, with the lock genuinely held by another lane:

```
bun scripts/bun-test-lock.ts run --label victim --wait 2 -- echo "I ACTUALLY RAN"
  → bun-test-lock: not acquired — held by <lane> …
  → EXIT CODE: 3            ← correct. The command did not run and said so.

bun scripts/bun-test-lock.ts run --label victim2 --wait 2 -- echo "I ACTUALLY RAN" 2>&1 | tail -2
  → same stderr
  → PIPELINE EXIT CODE: 0   ← the trap
```

`pipefail` is off by default, so a pipeline's status is the **last** command's. `| tail`,
`| head`, `| tee`, `| grep` all return 0 for a gate that failed or never ran. And piping is
exactly what a lane does to keep output manageable — the same `tail` that lost eighty-two
failing test names on this branch.

So the exposure is not the lock: **any gate run through a pipe on this plan reported the
pipe's status.** A `typecheck | tail`, an `eslint | head`, a `bun test | tail -20` — each is
a green nobody measured.

**Remedies, in order of reliability:**

1. **Read the output for proof of work** — a `Ran N tests` line, a file count, a "0 errors".
   An exit status says a process ended; the output says what it did.
2. Redirect to a file and inspect the file (`cmd > out.txt 2>&1; echo $?`), which also
   avoids truncating a result before you know its size.
3. `set -o pipefail`, or read `${PIPESTATUS[0]}` — both work, both are easy to forget.

The general rule this belongs to: **a green you did not watch happen is not evidence.**

## `HEAD~1` on a shared branch tests the wrong tree, and reports a pass

Measured 2026-08-27. A lane re-breaking its own change used `HEAD~1` as the "before" state.
**Four other lanes had committed in the meantime**, so `HEAD~1` was not its parent — it was
somebody else's commit, which already contained the fix. The re-break therefore tested the
**already-fixed state**, found everything green, and reported a pass. It was caught only by
a sanity grep for its own marker.

This is the same shape the review-package rule already warns about (`BASE` must be the
commit recorded before dispatch, never `HEAD~1`, which silently truncates a multi-commit
task) — but it bites harder here, because the failure mode is a **false green** rather than
a short diff.

On a branch with concurrent lanes, a relative ref is not a reference to your own work:

- Record the absolute SHA of your starting point **before** you touch anything.
- Re-break against that SHA, or against `<your-commit>^` — never `HEAD~1`.
- After any re-break, grep the tree for your own marker to confirm which state you measured.

Related, same session: a lane's restore collided two `SKILL.md` backups **on basename** and
corrupted one. Back up by path, not by filename.

## A survey script that returns a clean "no hits" may have searched nothing

Measured 2026-08-27. A lane's first survey script reported **0 hits for all 34 symbols** —
plausible, tidy, and entirely the product of a **pathspec bug**. The script ran, exited 0, and
searched nothing. It was caught only because the lane ran a **positive control**: a symbol it
knew was present, through the same script, which also returned zero.

This is the third distinct mechanism on this branch that manufactures a false absence, after
the wrapped grep skipping NUL files and zsh not word-splitting an unquoted `$DIRS`. They have
nothing in common except the output: **a confident, well-formed, empty result.**

There is no way to tell these apart by looking at the result, which is why the rule is not
"be careful with globs" but: **every absence claim carries a positive control on the same
rig** — a search you know should hit, run the same way, hitting. If the control comes back
empty, the tool is lying and the finding is void.

Corollary measured the same day: `rg` cannot support an absence claim in this tree at all.
Use `git grep` (byte-honest on any ref here) or `/usr/bin/grep -a`.

## Under heavy lane contention, timing is not evidence

Measured 2026-08-28 with seven lanes running: test runs that take **0.8–1.6 s uncontended
took 41–114 s** waiting on the shared `bun test` mutex, with five other lane labels queued.

Nothing failed. That is the point — the numbers were all green and all useless for any claim
that depends on duration: "this path is slow", "this timed out", "the fix made it faster",
"the flake is load-dependent". On a branch running this many lanes, **a timing measurement is
only worth what its contention context says it is worth.**

So when a duration is part of a finding: say how many lanes were live, or take the
measurement in a second tree off the mutex, or re-run it once the branch is quiet and quote
that number instead. A duration with no contention context is not a measurement, and several
rows on this plan have had to be re-measured for exactly this reason.

## `eslint --format unix` exits 2 when the formatter is missing, and writes a clean-looking file

Measured 2026-08-28. A lane ran eslint with `--format unix`, got **exit 2**, and nearly
recorded a lint failure. The formatter was simply unavailable — **linting had not failed at
all.** Worse in the other direction: the run **wrote an empty output file**, which reads
exactly like a clean lint.

So this one produces a false red and a false green from the same invocation, depending on
which artefact you look at. Re-run with `--format json` and read the `errorCount`.

Related, same package family: **`packages/pi-agent-server` cannot be linted at all** — it has
no `eslint.config.*` and is not in the root `lint` chain. Any past "eslint clean" claim for
that package means nothing and should be read as NOT-RUN.

## Two lanes, one file: the hazard is symmetric, and the controller causes it

Measured 2026-08-28. A dispatch assigned `SessionManager.ts` to one lane and **failed to list
it as off-limits in another's brief**. Both edited it. Nothing was lost — but only because the
second lane noticed the first lane's hunks and built its commit through an isolated index,
then proved isolation on the committed blob.

Its own summary of the risk is the part to keep: **had the other lane committed first with a
plain pathspec, this lane's work would have landed silently inside their commit.** No error, no
conflict, no signal — `git commit <pathspec>` takes the file's working-tree state, so the
victim's work simply becomes part of someone else's change and is attributed to them.

Two rules follow, and the first is the controller's:

- **A file is off-limits by being named off-limits.** Assigning it to lane A does not protect
  it from lane B unless B's brief says so. Zone by explicit exclusion in every brief, not by
  implication from another dispatch.
- **A lane that finds a contested file should assume the collision is mutual.** Isolated index,
  then grep the committed blob for the other lane's markers — and check the marker is **absent
  at HEAD** first, or the isolation check false-passes.

## Brief a replacement lane from `git log`, not from the last thing you noticed

Measured 2026-08-28, and the error was the controller's. A lane died on a session limit. Its
replacement was told "everything but commit X is open" — **wrong by two commits.** The dead
lane had also landed a regex fix, a 74-page reconciliation, 55 re-verdicted rows and a whole
census, none of which appeared in the hand-off.

The replacement verified rather than repeated, and said so: *"a lane told 'everything is open'
redoes landed work rather than verifying it."* That is the cost — not a conflict, just a second
lane spending its run re-deriving a finished result, and possibly reaching a different answer
that then has to be reconciled with one nobody remembers exists.

The cause was looking at `git log --oneline -3` — the tip — instead of asking what **that lane**
had committed across its whole run. Before briefing a replacement:

```bash
git log --oneline --format='%h %s' <lane's first SHA>~1..HEAD -- <its zone paths>
```

Read every commit it made, not the ones that happen to be recent. A dead lane's last message
says where it stopped; only `git log` says what it finished.

## The documented way to fetch a Claude doc page was itself wrong

Measured 2026-08-28. `AGENTS.md` said pages are "fetchable as `<url>.md`". They are not:

```
404  https://code.claude.com/docs/hooks.md
200  https://code.claude.com/docs/en/hooks.md
```

The index's own URLs have always carried `/en/`. So the instruction every lane was given for
verifying a section anchor — curl the page, grep `id="…"` — **404s if followed literally**, and
a lane that hit that either found the working URL on its own and said nothing, or gave up and
cited from the markdown instead, which is the thing the anchor rule exists to prevent.

Corrected in `AGENTS.md`. The general shape is worth keeping: an instruction file is not
evidence either. This one had been wrong for as long as anyone had been quoting it, and it was
found by a lane doing the thing the instruction described.

## A quoted glob pathspec makes `git grep` search nothing

Measured 2026-08-28, and it invalidates advice this plan had been handing out.

`git grep` is byte-honest on NUL-carrying files, which is why several briefs told lanes to use
it instead of the wrapped `grep`. But the **pathspec** has its own trap:

```
git grep -l export -- 'packages/*/src'   →    0 files, exit 0
git grep -l export -- packages           → 1791 files
```

A quoted glob directory pathspec matches **nothing**, silently. `packages/*/src/**/*.ts`
undercounts by a smaller margin, which is worse — it looks like a plausible answer.

**Use literal directory pathspecs only**, or no pathspec plus a filter afterwards.

This is the **fourth** distinct mechanism on this branch that produces a confident, well-formed,
empty result — after the wrapped grep skipping NUL files, zsh not word-splitting an unquoted
`$DIRS`, and a survey script whose pathspec bug reported "0 hits for all 34 symbols" while
searching nothing. They have nothing in common except the output.

Which is why the rule is not "learn the four" but the one that catches all of them and the
fifth: **every absence claim carries a positive control on the same rig** — a search you know
should hit, run the same way, hitting.

## A positive control validates your instrument, not your premise

Measured 2026-08-28, and it cost a dispatched lane.

A row claimed a documented vendor exemption was quoted in our prose and implemented nowhere.
Its evidence was better than most: a grep of both enforcement sites for the vendor's keyword,
zero hits, **and a positive control confirming the search worked.**

The exemption was implemented. It had been for twenty days.

The control proved the **tool** was functioning. It said nothing about whether the **concept**
was present, because we spell the concept differently — the vendor's keyword corresponds to a
`max` effort level in our own vocabulary, recorded in a types file the search never touched.

So the rule this repo already carries — *every absence claim needs a positive control* — is
necessary and **not sufficient**. Add the second half:

**Before concluding a concept is absent, establish what WE call it.** Search for the behaviour,
the call sites that would implement it, and the tests that would pin it — not only the word the
documentation uses. A synonym is invisible to a keyword search and a positive control on the
keyword will never reveal one.

## A zsh glob with no match aborts the whole compound command

Measured 2026-08-28, and it nearly produced a false N/A in a report.

```
ls eslint.config* .eslintrc* 2>/dev/null || echo "none"
```

In zsh, a glob that matches nothing is an **error that aborts the command**, so the `||`
fallback runs and prints `none` — which reads exactly like "no config here". The package in
question **had** a config, was in the lint chain, and passed with zero errors.

This is the **sixth** measured mechanism on this branch that returns a confident wrong answer,
and it is the first that produces a wrong *positive* rather than a silent empty: the fallback
text is evidence of absence that the shell manufactured.

`setopt NULL_GLOB` fixes it, or test with `[ -f … ]`, or use `git ls-files`. But the durable
rule is the same one that catches all six: **a claim of absence needs a positive control** —
run the same command shape against a case you know exists, and check it says so.

## Two more ways a search returns a confident empty: capitals and optional calls

Measured 2026-08-28, both while checking whether a documented behaviour existed.

**A case-sensitive search misses a sentence-initial capital.** Looking for `ultracode` in a
page that opens a sentence with *"Ultracode is exempt…"* returns nothing. The word is there;
the search is not wrong about the string it was given.

**`name(` does not match `name?.()`.** An optional call is invisible to a call-shape search,
and this one nearly produced a false drift finding — a predicate that WAS consulted, reported
as unconsulted.

These are the seventh and eighth mechanisms on this branch that hand back a well-formed empty
result. The list is now long enough that memorising it is the wrong strategy:

- the wrapped `grep` skipping NUL-carrying files (exit 0)
- an unquoted `$DIRS` not word-splitting in zsh
- a pathspec bug searching nothing
- `git grep -- 'packages/*/src'` matching no files
- a zsh glob with no match aborting a compound command so its `||` fallback prints
- a positive control that validates the instrument rather than the premise
- case sensitivity against a capitalised first word
- `name(` against `name?.()`

**The rule that catches all eight, and the ninth: a positive control on the same rig, plus —
before concluding a concept is absent — establish what WE call it and how it would be
spelled.** A search proves the absence of a string. It never proves the absence of a concept.

## `git commit <pathspec>` also beats the INDEX, not just your hunks

Measured 2026-08-28, caught by the lane before it committed.

This repo already records that `git commit <pathspec>` takes the file's **working-tree** state
rather than your staged hunks. There is a second direction, and it is worse because it deletes
work rather than adding someone else's:

**`git add <new-file>` followed by `git commit <pathspec>` silently drops the staged new file**
if it is not covered by the pathspec. The pathspec wins over the index, the commit succeeds, and
the file is simply not in it.

So the rule is not "beware the working tree" but the stronger one: **with a pathspec, the index
is ignored in both directions.** Stage nothing and pass every path you mean, or verify with
`git show --stat` immediately after — which is already the standing rule here, and is what
caught this.

## `not.toEqual(expect.arrayContaining([a, b]))` passes when EITHER is absent

Measured 2026-08-28 by demonstration, not by reading: a gate assertion **stayed green with half
the gate deleted.**

`arrayContaining([a, b])` asserts the array holds **both**. Negating it therefore asserts only
that the array does **not hold both** — so it passes when `a` is present and `b` is gone, which
is exactly the half-broken state a security gate must catch.

The shape is seductive because it reads as "neither of these is present". It means "not both".

**Write one assertion per record.** If two conditions must each hold, they are two assertions
or one explicitly-combined condition — never a negated `arrayContaining`.

Worth a sweep: this is a vacuity pattern that survives review because the test is green and the
intent is obvious from the name. It joins the other measured vacuity on this branch — a
negative assertion against a function whose case-sensitive lookup could never return true.

## A DOM-lib type name typechecks green in one package and red in another

Measured 2026-08-29, **three times in one day, on three different lanes' code**, which is what makes
it a trap rather than a slip.

Stream and fetch types come from **different lib sets in different packages of this monorepo**, and
Bun's globals add a third shape. So the identical line is green under `packages/shared`'s tsconfig and
red under `packages/pi-agent-server`'s. A lane that verifies only its own package therefore ships a red
branch **for every other lane**, and the two who did had both reported their typecheck clean — truthfully.

The three instances:

| Name | Why it broke |
| --- | --- |
| `HeadersInit` | a DOM-lib name that **no package here loads**, so it typechecked nowhere — and still read as a normal global (`db76657bb`) |
| `Headers.entries()` | exists at runtime everywhere we run; **declared only under the DOM lib** (`836f09007`) |
| `ReadableStreamReadResult`, and `node:stream/web`'s reader vs the global one | the third lib set — Bun's reader carries `readMany`, which the `node:stream/web` one does not, so an assignment between two "the same" readers fails |

**Do not import DOM-only type NAMES.** Derive the type from the value — `Awaited<ReturnType<R['read']>>`,
`ConstructorParameters<typeof Headers>[0]` — or declare the minimal structural shape the code actually
uses. A structural `{ read(): Promise<{ done: boolean; value?: Uint8Array }> }` accepts the DOM reader,
the `node:stream/web` reader and Bun's, and is honest about what the function needs.

**Verify in BOTH packages before committing**, never only your own:
`cd packages/shared && bun run tsc --noEmit` and `cd packages/pi-agent-server && bun run typecheck`.

One replacement detail worth reading twice, because it silently inverts data: `Headers.forEach` takes
**`(value, name)`** — the reverse order of the `[name, value]` pairs `entries()` yields. Swapping one
for the other without flipping the destructuring produces a header map with names and values exchanged,
and every test that only counts entries stays green.

## `git stash` in a shared multi-lane tree pops SOMEBODY ELSE'S work

Measured 2026-08-29, by a lane that recovered from it fully and reported it rather than hiding it.

**The stash stack is global to the repository, not to your lane.** A lane tried to separate its own
edits from another lane's pre-existing errors with `git stash push -- <paths>`. The pathspec included
an **untracked** file, so the push **aborted** — leaving nothing stashed. The follow-up
`git stash pop` therefore popped **another session's stash**, producing two conflicted files that
belonged to a different lane entirely.

Two failure modes stacked: a `push` that silently does nothing on an untracked pathspec, and a `pop`
that always takes the top of a **shared** stack. Neither is visible from inside the lane.

**Never `git stash` while other lanes are running.** To isolate your own changes, commit them by
explicit path, or copy the file aside — both are lane-local. This joins the `git commit <pathspec>`
trap (which takes the file's working-tree state, not your hunks) and the `git add <one file>` index
race: **every git operation with a repository-global side effect is unsafe in this tree.**

Recovery, for the record: stage-2 blobs were verified byte-identical to `HEAD` before restoring, and
the stash list was confirmed unchanged at three entries. Verify both of those before believing a
recovery is complete — a restored working tree does not prove the stack was left intact.

## A wrong value survives because it is used as a test's EXEMPLAR, not asserted

Measured 2026-08-29 (P3.233). `autoCompactEnabled` was classified `unmeasured` with the reason
*"a product preference, not a restriction"* — both halves false against the page and the shipped
bundle. **No test ever asserted that verdict.** Instead, two other checks used the key as the
file's **exemplar of an `unmeasured` entry**, with comments saying so.

So the wrong classification was **load-bearing for two unrelated assertions while nothing pinned
it**: correcting the value broke two tests that were never about it, and searching for a test that
claimed it would have found none. A grep for the key looks like coverage and is the opposite —
those hits are the reason the error survived.

**Two consequences worth carrying:**

- **A value used as an exemplar is unverified by construction.** If a test needs "some entry of
  kind X", it will keep working when that entry stops being kind X. Pin the verdict separately from
  any use of it as a sample, and prefer an exemplar whose correctness is itself pinned elsewhere.
- **When you correct a classification and unrelated tests break, that is evidence about the tests,
  not about your fix.** Read what they were actually asserting before adjusting them; here the right
  move was to move the exemplar role to a different key and add the missing hard pin, and to say so
  in the commit rather than quietly re-point it.

Same family as the other vacuity shapes recorded here — a negated `arrayContaining`, a negative
assertion against a lookup that could never return true — all three are green tests that assert
less than their name implies.

## A runtime `process.env` assignment is invisible to every env SPREAD in Bun, and the unlock is STICKY (measured 2026-08-29, re-verified 2026-08-30, boundary corrected 2026-09-03)

P2.261/P2.383. On Bun 1.3.14, assigning a proxy variable at runtime puts it somewhere
`Object.keys` does not look:

| what | property read | `Object.keys` | `{...process.env}` |
| --- | --- | --- | --- |
| `process.env.HTTPS_PROXY = …`, name ABSENT at launch | the value | **absent** | **absent** |
| an ARBITRARY name, same shape | the value | present | present |
| a SHELL-INHERITED proxy variable — **the second condition, not a control** | the value | present | present |
| `delete` first, then assign | the value | present | present |

**Row 3 is the second half of the trigger, and reading it as a control is why this looks
machine-dependent.** TWO conditions are needed: the name must be one Bun pre-creates a slot
for, AND **it must be absent from the launch environment**. Overwriting an inherited value
was always visible; INTRODUCING one — the ordinary case for an administrator mandating a
proxy — was not. So a reader who tests by overwriting concludes there is no bug. The
enumerating command below shows this arm too: re-run 2026-09-03 with a genuinely set
`HTTPS_PROXY`, that name DROPS OFF the list (eight names, not nine) because it is then
enumerable and unaffected. Its "*was not re-run*" caveat is gone with it — the arm has been
driven, both ways.

**And `in` LIES for exactly these names.** `'HTTPS_PROXY' in process.env` is `true` in a
fresh process where it is unset — the slot pre-exists and only enumeration skips it — so
`in`, the natural way to write "was it present at launch", is wrong for every name under
discussion. One lane's own launch-was-clean check reported a dirty rig that was clean. Read
the value or the spread, never `in`.

The boundary is narrow, and the narrowness is what makes it survive: **everything you
would reach for as a control behaves normally.** Rows 1, 2 and 4 were re-run on 2026-08-30
and came back identical; row 3 was re-measured on 2026-09-01 and again on 2026-09-03, and
it is the second condition rather than a control — see the paragraph under the table.

**"Bun special-cases the proxy names" was this entry's own over-generalisation, and it was
wrong in both directions (P2.515, corrected 2026-09-03).** The affected set is not the six
proxy names. It is **seven, minus two, plus two**: those six PLUS
`NODE_TLS_REJECT_UNAUTHORIZED`, which is a TLS-verification name and no kind of proxy —
while **`ALL_PROXY`/`all_proxy` ARE proxy names and are NOT affected** — plus `TZ` and
`BUN_CONFIG_VERBOSE_FETCH`, which sit in no classification table at all. Do not trust that
sentence either. It is a reading with a date, and this tree has said five, six, eight,
fourteen and zero about sets of this kind. **The slots enumerate themselves, so the rule
needs no list — run the command:**

```sh
bun -e 'const s={...process.env};console.log(Object.getOwnPropertyNames(process.env).filter(n=>!(n in s)))'
```

Measured with it on 2026-09-03, Bun 1.3.14: nine names, exactly the seven-two-and-two above.
A managed `env` block carries ARBITRARY names, so the `delete` is unconditional rather than
gated on a list that cannot be complete.

**It is a production defect, not only a rig hazard.** `projectProxyEnv`
(`packages/shared/src/config/network-runtime.ts`) makes that assignment, and every
subprocess env in this tree is built by spreading `process.env` (`buildPiSubprocessEnv`,
`buildClaudeSubprocessEnv`, `CodexRuntimeManager.spawn`). So the projection reached Bun's
own `fetch`, which reads by property, **and nothing else**: the operator's proxy was there
when you looked for it and gone when a child needed it. Re-measured 2026-08-30 by spawning
a child with `{...process.env}` — after a plain assignment the child printed `ABSENT`;
after delete-then-assign it printed the value.

**The failure direction is a PASS**, which is why it cost a review before it cost a child:
P2.251's rig built its arms by spreading, and an arm went green having handed its child no
proxy at all.

**The stickiest part, and the reason an in-process test cannot see this: once a name has
been deleted, every later assignment to it stays visible for the rest of the process.** A
suite whose setup deletes the six proxy names — this one does, and so may the preload and
any neighbouring suite — passes the visibility assertion **with the fix removed**. The
detector has to be a **throwaway Bun child whose proxy names have never been deleted**. The
committed one is
`packages/shared/src/config/__tests__/fixtures/proxy-env-spread-probe.ts`; it is a checked-in
file rather than a string written at run time, and its header says why (a freshly created
temp script pays macOS's first-execution scan). Mutant with the `delete` removed: **exactly
one failure, the child arm** — which is itself the proof that the child is the only
instrument that sees it.

The fix is `delete` before assign — **including on the restore path**, because putting an
operator's original value back is an assignment like any other.

Same family as "a live case's DETECTOR is the thing most likely to be wrong", and a sibling
of the `HOME` entry above: both are places where Bun's env is not the env the rest of this
tree assumes it is.

## Reproducing a timing result does not validate it — a timing claim needs a SAME-MOMENT control (measured 2026-08-29)

P2.440, and the lane caught itself. While writing the administrator-owned skills tier tests
(`packages/shared/src/skills/__tests__/storage.test.ts`) it looked like a single
`process.env` write in the file-wide `beforeEach` took the file from **2 s green to 85 s
with timeouts**. The lane then did what looks like the right next step: it **reproduced the
slowdown with an unrelated variable name**, took the reproduction as confirmation, and wrote
the finding into a comment.

The finding was wrong. The control that killed it was **HEAD's unmodified test file, run in
the same minute**: 246 s, six failures, and **no env write anywhere in it**. The cause was
machine load — average 11, with fourteen lanes building.

**The lesson is about the INSTRUMENT, not about the test.** Repetition feels like validation
and is not: on a loaded box the second run inherits the same confound as the first, so
**repetition measures the load twice rather than the change once**. A reproduction only
rules out noise that is independent between runs, and lane contention is not.

So: **any timing claim needs a control run at the same moment on unmodified code, or it
invents a cause.** Not "run it again" — run the OTHER version, in the same minute, and
report both numbers. Read the load at that moment (`uptime`) and quote it beside the
duration, because the duration alone is not a reading anyone can re-derive later.

This sharpens the earlier entry "Under heavy lane contention, timing is not evidence", which
asks for contention CONTEXT beside a duration. Context is necessary and not sufficient: it
tells you the number is unreliable, while only the paired control tells you what the number
was caused by. The recipe in practice is in
`docs/superpowers/specs/2026-07-29-known-failing-tests.md` under
`instruction-excludes-envelope` (22.3 s with the lane's change, 20.6 s at HEAD, same minute
— so it was the module graph, not the diff). The corrected note now lives at the call site
in `storage.test.ts`, where the wrong one used to be.

## A mutation harness that fails to RESTORE invalidates every verdict after it — and it is one of a family of four instrument failures (measured 2026-08-30)

P2.452, and it is the third lane in two waves to hit the same shape (P2.449, P2.450). Every
verdict a re-break campaign produces is a claim about a mutant *relative to a baseline*. When
the restore half of the harness fails, the baseline is gone and **every later verdict is a
measurement of something nobody chose** — which is why this shape is worse than the other
three in the family: the others fail to kill one mutant, this one silently invalidates the
rest of the run.

The three instances, all on this plan, all found by the lane rather than by review:

| Row | What the harness did | What it cost |
| --- | --- | --- |
| P2.452 (z-w10) | replacement side was EMPTY, so the reverse swap searched for `''` and aborted — **after** the forward write | **three false `SURVIVES=YES` verdicts**; both files restored to hash-confirmed baselines and all six mutants rerun clean; the harness now refuses an empty side |
| P2.450 | reverse anchor was **not unique**; the swap-back landed in an unrelated block | baseline corrupted, caught by the hash check, runner rewritten to assert uniqueness in **both** directions before touching a file |
| P2.449 | reverse anchor matched two lines (a sibling switch already carried `case 'builtin': return 0;`), so the restore REFUSED | the file stayed mutated until repaired by line number; the harness now requires the reverse anchor to be **absent before mutating** |

The detector works prospectively, too, which is the argument for keeping it: P2.135's guard
**refused two edits whose reverse anchors were not unique**, before any bad revert could
happen.

**Re-measured 2026-08-30** on a throwaway fixture — a source file, a suite, a naive
swap-and-swap-back harness — because a method defect nobody can reproduce becomes folklore.
All three shapes still reproduce, and two details are sharper than the rows recorded:

- **The empty search string is not "not found", it is found everywhere.** In an ~110-byte
  fixture `''` occurred **114 times**, so it was the *uniqueness* branch that aborted, not a
  presence check — and the abort fired after the forward write had already landed.
- **The false survival comes from the harness's own success criterion.** A verdict read as
  *"the failure I expected did not appear"* can never be `KILLED` on a corrupted tree,
  because the suite dies **earlier, for an unrelated reason**. Measured: the identical mutant
  scored `SURVIVES=YES` on the corrupted tree, where the last line was
  `AttributeError: module 'subject' has no attribute 'LIMIT'`, and `KILLED` on the true
  baseline, where it was `FAIL: admin rank`. Read a verdict off the killing assertion's own
  message, never off the absence of one.

And one finding the rows do not have, which changes where the guard belongs: **a guard on the
reverse side can only report the corruption, never prevent it.** With a count guard on the
reverse anchor the restore refuses — and the file is still mutated, because the forward write
already happened. That is P2.449's outcome exactly. Measured on the same fixture with the
duplicate line placed *above* the mutation site, dropping the count guard is worse still: the
restore **reports success** and leaves the file wrong in **two places, in opposite
directions** — the unrelated block carrying the mutant value and the real site never reverted
— with nothing but the hash disagreeing.

So, in order of what actually holds:

1. **Do not restore by reverse string swap at all.** Write the whole pre-mutation file back
   from a copy taken at that cycle, then assert the hash. No reverse anchor exists to be
   empty, ambiguous, or already present, and all three instances above dissolve. Where the
   fix under test is committed, `git show HEAD:<path>` re-read each cycle is the same thing
   for free (see "A re-break campaign is a writer to the file it restores", which is the
   other half of this hazard — that entry is about the file's other lanes, this one is about
   your own baseline).
2. **Assert the file hash returns to baseline after every reverse swap.** This is the
   detector of last resort, and it is what caught P2.450; in P2.449 the reverse guard is what
   spoke up, and the hash is what tells you a refusal left the file mutated rather than
   harmlessly untouched. Cheap enough that there is no argument for skipping it.
3. **If a swap is unavoidable, run all three refusals BEFORE the forward write:** empty side,
   non-unique search anchor, reverse anchor already present in the file.

**The other three shapes in the family, so a lane can name what it is looking at:**

- **A dead control** — a mutant that changes nothing, so the green proves nothing. Recorded at
  P2.148 (a probe-name metric returning 0/0 at char level; the 600 000-input zero meant
  nothing until the probe was repaired), P2.190 (first probe returned false for everything),
  P2.224, P2.386 and P2.404 — where finding out *why* the control was dead was the row's real
  result.
- **A broken mutant** — P2.405: `false && a || b` parses as `(false && a) || b` and disabled
  nothing. **It reads exactly like a survivor.** Same failure class as a dead control, on the
  other side of the experiment.
- **A hung mutant is not a surviving one either** — P2.413: two input mutants hung a suite at
  0 % CPU and were recorded as unexplained rather than scored. The converse also happens and
  must not be scored either way without diagnosis: P2.138's break 4 hung the suite because it
  **reproduced the row's own failure in-process**, which was the finding.

Verify a mutant is live before trusting its verdict — P2.432 is the pattern: the mutant was
driven entirely through the test's INPUT and the effect was watched (real bytes 73 → 129, the
content visibly grew), so it was **neither a dead control nor a hang** before anyone read
`SURVIVES`.

**"Three lanes in two waves" is a reading with a date, not a fact** — this family grew by two
instances in a single evening. Rather than trusting the number here, grep the plan:
`grep -aon -E 'dead control|broken mutant|reverse anchor' docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`
prints the live set of rows, and each one carries its own measurement.

## A worktree with the parent's `node_modules` symlinked in measures the PARENT, silently (measured 2026-09-01)

P2.231, found by P2.199's reviewer and re-measured from scratch for this entry. The
throwaway `git worktree` is the standard isolation rig on this plan — almost every
independent measurement, positive control and mutant verdict is taken in one. It has a
failure mode with no error message.

`node_modules/@nessy-agent/*` are **relative** links (`shared -> ../../packages/shared`).
Symlink the parent's whole `node_modules` into the worktree and resolution follows the
directory symlink out to the parent first, then walks `../../packages/shared` **relative to
the parent** — so every workspace import lands in the tree you built the worktree to isolate
from. Third-party packages resolve fine, which is why the rig looks healthy.

Measured A/B/A on one worktree, one probe, one marker planted in the worktree's own
`packages/shared/src/agent/thinking-levels.ts`, changing nothing but the `node_modules` shape:

| `node_modules` shape | `@nessy-agent/shared/agent/thinking-levels` resolves to | worktree's marker |
| --- | --- | --- |
| `ln -s <parent>/node_modules <wt>/node_modules` | `<parent>/packages/shared/src/agent/thinking-levels.ts` | **ABSENT** |
| shadow (below) | `<wt>/packages/shared/src/agent/thinking-levels.ts` | `WORKTREE` |
| shadow restored after the trap | `<wt>/…` again | `WORKTREE` |

The A/B/A is the point: the third row rules out anything but the `node_modules` shape.
P2.199's reviewer measured the cost on real work the same afternoon — a mutation run read
**26 pass / 2 fail** under the trap and the true **24 / 4** under a shadow.

### The recipe, and it must be copied whole

```sh
WT=/tmp/wt                       # anywhere outside the repo
git worktree add --detach "$WT" HEAD
P=$(git rev-parse --show-toplevel)

mkdir -p "$WT/node_modules"
ln -s "$P"/node_modules/* "$WT/node_modules/"      # ONE call, never a loop — see below
rm "$WT/node_modules/@nessy-agent"                 # drop the parent's workspace scope
mkdir "$WT/node_modules/@nessy-agent"
for l in "$P"/node_modules/@nessy-agent/*; do      # repoint it at THIS tree
  ln -s "$WT/$(readlink "$l" | sed 's|^\.\./\.\./||')" \
        "$WT/node_modules/@nessy-agent/$(basename "$l")"
done
```

### Then assert provenance, before you trust any number

```sh
cd "$WT" && bun -e 'const p=Bun.resolveSync("@nessy-agent/shared/package.json",process.cwd());
  console.log(p.startsWith(process.cwd())?"OK isolated: "+p:"TRAP resolves to parent: "+p)'
```

An absence claim, a positive control or a mutant verdict taken in a worktree that has not
printed `OK isolated` is not evidence. Planting a distinctive marker in the worktree and
asserting the rig reads it back is the stronger form, and it is what the table above does —
**use an exported subpath.** A first attempt planted the marker at
`packages/shared/src/p2231-marker.ts` and imported `@nessy-agent/shared/src/p2231-marker.ts`;
it read `NOT FOUND` under the trap AND under the shadow, because that subpath is not in the
package's `exports` map. A control that fails identically in both arms is a **dead control**
and proves nothing in either direction.

Two notes on building it. The per-entry `ln -s` loop is the slow way: on a box at load ~12 it
got through 124 of 966 entries in two minutes and was killed, which reads exactly like a hung
rig — `ln -s <many sources> <dir>` in one call is instant. And `git worktree add` takes a ref
lock, so on a shared branch it can lose a race with a committing lane; retry rather than
concluding the worktree cannot be made.

**Re-examine any earlier verdict on this plan that rested on a worktree measurement** — this
trap has been available the whole time, and it is invisible in a report that does not print
provenance.

## A rig placed OUTSIDE the repo resolves a DIFFERENT package tree, and Bun fills the hole for you (measured 2026-09-06, both arms re-measured 2026-09-07)

P6.554, found by W6-f (its `W6f-N2`) while building the P6.114 rig. Same class as the
worktree-`node_modules` trap above — a rig that isolates itself out of the tree it was
built to measure — in a new place, and this one needs no worktree at all: it is the
default outcome of writing a measurement script in the scratchpad.

The rig lived under `/private/tmp/…/scratchpad/` and imported
`@anthropic-ai/claude-agent-sdk`. Bun resolved the name by walking up from the SCRIPT's
directory, found nothing, and **auto-installed `0.3.238` from its global cache**. Every
arm ran, every arm produced a plausible number, nothing failed and nothing warned. The
vendored package is coherently `0.3.233` / `claudeCodeVersion 2.1.233` — `package.json`,
`manifest.json`, `sdk.mjs` and the binary's own `--version` all agree — so every number
that rig produced describes a runtime this product does not ship.

**`env -i` does not help and never could: the cause is module resolution, not
environment.** Nor does a stack frame settle it — the frames named
`~/.bun/install/cache/@anthropic-ai/claude-agent-sdk@0.3.238@…/sdk.mjs`, which here was a
true signal, but the same frame shape appears for a correctly-resolved hardlinked
package, so a version read off a stack trace is evidence in neither direction.

Measured 2026-09-07, both arms, with `--no-install` so the probe cannot cause the very
install it is looking for:

| cwd of the rig | `@anthropic-ai/claude-agent-sdk/package.json` resolves to |
| --- | --- |
| the scratchpad | **UNRESOLVED** — the hole Bun fills on the next real run |
| the repo | `<repo>/node_modules/@anthropic-ai/claude-agent-sdk/package.json`, `0.3.233` |

`@nessy-agent/*` is unresolvable from the scratchpad in the same way. Whether the hole is
then filled loudly or silently is not a property of your rig: it depends on whether the
name exists in the registry Bun is configured for, and for a public package it is always
silent.

### The one-line provenance assertion — print it before any number is trusted

```sh
bun -e 'const p=Bun.resolveSync("@anthropic-ai/claude-agent-sdk/package.json",process.cwd());
  console.log(p.startsWith(process.cwd())?"OK vendored: "+p+" "+require(p).version:"TRAP resolves elsewhere: "+p)'
```

Run it with the rig's own cwd, name the package the rig actually imports, and put its
output in the report beside the durations. A number from a rig that has not printed its
provenance is not evidence — the same sentence as the worktree entry above, for the same
reason.

**For a rig that drives a CHILD process, assert the child's own self-report instead**, because
resolution is only half of it: the claude child announces
`claude-cli/<version> (external, sdk-ts, agent-sdk/<sdk version>)` in its `user-agent` —
recorded verbatim as `claude-cli/2.1.233 (external, sdk-ts, agent-sdk/0.3.233)` on the
bundle vendored at the time, and the two halves are the two self-reports, so at the
2026-09-12 bundle the pair to expect is `2.1.247` / `0.3.247` — and W6-f's
suite now captures that and compares it to the vendored `package.json` before trusting a
duration. Compare against what the vendored `package.json` says TODAY, never against the
number written in this sentence. That is the stronger form — it says *what answered*, not *what was found on disk*.

**What it has already cost.** P6.543 was born from a reading that the vendored binary
self-reports `claude_code_version: 2.1.238` while its manifest says `2.1.233`. Re-measured
in-repo on 2026-09-07 the two AGREE at `2.1.233`, and `2.1.238` occurs **zero** times in the
vendored binary. The row survived as a correction to the METHOD; the pair it was named for
did not.

**`2.1.238` was a real number even though the bundle had never reported it — it was the
PAGE's, which was AGENTS.md's bundle-lags-the-docs inversion in its live form (P6.835,
2026-09-08). THAT WINDOW HAS SINCE CLOSED; the paragraph is kept because the SHAPE of the
trap is the transferable part, and the closing is recorded at the end of it (C3.252,
2026-09-12).** `sub-agents.md`'s `<span id="inline-server-trust" />` section ends *"Before
v2.1.238, Claude Code loaded these servers without checking trust."* The child we vendor
self-reported `2.1.233` on both of its own reports when that was written, so a rig that
probed the shipped binary for that folder-trust check and found none had measured **the
child's age, not the gate's absence** — the same shape as the reading above, read the other
way round.

**The SDK lift this paragraph asked for has happened and the direction has FLIPPED**
(C3.252, 2026-09-12; the verdict was first recorded by C3.142 on 2026-09-11). The child we
vendor self-reports `2.1.247` on both of its own reports, which is PAST v2.1.238, so the
child gates inline-server trust itself. `runtime-agent-definition.ts`'s
`inlineServersTrusted` is therefore no longer the page leading the bundle: it is our own
fail-closed reading BESIDE a check the binary performs, and the difference to keep honest —
two enforcers of one rule — is the live question that paragraph predicted rather than a
hypothetical one. The TRAP itself is unaffected and is why this entry stays: a rig that
probes a shipped binary for a documented behaviour and finds none has measured the
artefact's age until someone reads the two self-reports.

## The isolate preload does NOT isolate under `bun <file>` or `bun run`, and the rig reports success (measured 2026-09-01)

P2.256, found by P2.225's review. This is the "a live case's DETECTOR is the thing most likely
to be wrong" family, and it is worse than most of that family because the detector reports
green: the rig reads `NESSY_CONFIG_DIR = <temp>` and concludes it is isolated while
`CONFIG_DIR` — the value every config getter actually uses — is frozen at the real
`~/.nessy-agent`, so the run picks up the machine's real config and output style.

The cause is preload ORDER, and it is not the isolate file's fault. `packages/shared/src/config/paths.ts`
resolves `CONFIG_DIR` **once, at import time**. The root `bunfig.toml` has a top-level
`preload` (`unified-network-interceptor.ts`, which imports `paths.ts` transitively) and that
list runs **ahead of any CLI `--preload`**. `[test].preload` is a separate list that puts
`isolate-shared-config-dir.ts` first, which is why `bun test` is fine and nothing else is.

Measured on this repo, `HOME` redirected to a scratch directory so the broken forms could not
touch a real config dir. Every row is one run of the same probe printing `NESSY_CONFIG_DIR`,
`CONFIG_DIR` and whether they differ:

| Invocation | Isolates? | What the rig sees |
| --- | --- | --- |
| `bun test` from the repo root | **YES** | `[test].preload` puts the isolate file first |
| `bun --preload … <file>` from the repo root | **NO** | `NESSY_CONFIG_DIR` = temp, `CONFIG_DIR` = real — **looks isolated** |
| `bun run --preload … <file>` from the repo root | **NO** | worse: the flag is swallowed by `bun run`, the preload never runs, `NESSY_CONFIG_DIR` is `null` |
| `NESSY_CONFIG_DIR=<dir> bun …` (exported before bun starts) | **YES** | works on every form above |
| `bun --preload … <file>` from a cwd with **no** bunfig | YES | the control that proves the cause |

The last row is the control: identical flags, identical probe, the only difference being
whether the repo's `bunfig.toml` was in scope — isolated outside, not isolated inside. That
rules out the isolate file, the flags and the probe, and leaves the top-level `preload`.

**So the copyable rule is: export the variable, do not rely on the preload to set it.**

```sh
NESSY_CONFIG_DIR=$(mktemp -d) bun --preload ./packages/shared/tests/setup/isolate-shared-config-dir.ts <file>
```

Keep the `--preload` even though the variable is already set: the isolate file's `mkdtemp`
half is skipped when `NESSY_CONFIG_DIR` is present, but it still calls `ensureConfigDir()`,
which performs the one-time seeding real startup does. Verified — the exported directory came
back holding `config-defaults.json`, `docs` and `tool-icons`, so the corrected recipe loses
nothing the broken one intended to provide.

`paths.ts` already refuses to run unisolated, but only under `process.env.NODE_ENV === 'test'`,
which `bun test` sets and `bun run` does not. **That is exactly why the `bun run` family is
silent**, and it is the argument for having the isolate file assert its own effect rather than
assume it: a rig that cannot verify it isolated should refuse to run instead of producing
clean-looking numbers.

## A foreground mutation run that hits the tool timeout leaves the tree MUTATED

Measured 2026-09-02 by lane W1-d, on itself: a re-break harness run in the **foreground** of a Bash
tool call hit the 120 s tool timeout (exit 143) **after the forward write and before the restore**.
The tool reported a timeout; the tree was left holding the mutant. The lane caught it only because its
next step re-checked the baseline hash.

This is the restore-failure family from 2026-08-29 (P2.449/450/452) entering through a different
door: there the reverse swap was wrong; here it simply **never ran**, because the process was killed.
Both leave a mutant in the tree with every later verdict silently invalidated — and a killed process
cannot report that it was killed.

**Run mutation harnesses as a background script with the restore INSIDE the script** (a `trap` on
EXIT, or a finally that writes the whole pre-mutation file back and asserts the hash), never as a
foreground tool call whose timeout is shorter than the run. And after any mutation run, foreground or
not, **assert the baseline hash before reading a single verdict** — the hash check is the only
instrument that sees a restore that did not happen.

## "Absent from Artifactory" needs a date and a 200-control — the mirror answers 403 for what it has not cached

Measured 2026-09-03 (S0-2, P3.224). On 2026-08-28 a query for `@openai/codex` read `dist-tags.latest`
as `0.147.0` and `0.148.0` as alpha-only. Re-measured five days later: **`latest` was `0.148.0` since
2026-08-18** — ten days *before* the reading that called it absent. The mirror is a lazily-refreshing
proxy running ~15 days behind upstream, and for a version it has not cached it answers **403, not
404**; cached siblings answer 200. So an "absent" reading is indistinguishable from "not yet pulled
through" unless the control is a cached neighbour returning 200 in the same minute.

**Any claim of the form "version X is not in Artifactory" carries its date and a 200-control**, or it
is a hypothesis about the mirror's cache, not about the registry. This plan's upgrade directive was
briefly wrong about codex on exactly this reading.

## A backgrounded harness's log reads truncated if you read it the instant the notification arrives

Measured 2026-09-03 (W2-o). A mutation/test harness run in the background writes its log through a
buffered pipe; the completion notification can arrive before the last buffer is flushed to disk, so a
read at that instant sees a **truncated** tail and reports a verdict that is missing — or, worse, the
previous run's tail. The lane's own note beside it: `cmd | tail; echo $?` reports **tail's** exit
status, which made a red `tsc` look green (the pipefail arm AGENTS.md already names).

**Read the log by its terminal marker, not by its arrival:** have the harness print a final sentinel
line (and its own exit status) as the last thing it does, and treat any read that lacks the sentinel as
not-yet-done — re-read, do not conclude.

## "Background script with the restore inside it" is necessary and NOT sufficient — two more failures

Measured 2026-09-03 (W2-a), both on a harness that already followed the wave-1 rule:

- **Two overlapping harness instances** — a second run started while the first still held the
  mutant — made a KILLED mutant read as a *survivor* and lost an edit: each instance's "baseline" was
  the other's mutated file. The harness needs a lock (a `mkdir`-style lock dir; refuse to start if it
  exists).
- **The 10-minute TOOL timeout killed a harness between forward write and restore** — the process, not
  a step inside it — leaving `docs/architecture/runtime-capability-gaps.md` holding a mutant; it was
  recovered from the harness's own backup copy. The killed run never printed its "restored" line, so a
  reader trusting that line would have seen nothing. Start the harness with `nohup … &` (or as a
  detached background Bash) so no tool timeout can reach it, and verify restoration POST HOC against the
  anchors and the baseline hash — never by the harness's own last line.

So the rule is now four parts: background + restore inside + lock against overlap + post-hoc hash check.

## A surface pin is the LAST edit to a pinned file, never a step in the middle

Measured 2026-09-03 (W2-j, `f96ce11cc` → `fb83385b4`). The lane re-pinned `check:surface` when the
change landed, then kept editing the same file (a type narrowing), so the committed pin hashed a file
that no longer existed and `pi-agent-server`'s `typecheck` was red at its first step for every later
lane — while the lane's own "typecheck clean" reading, taken before the later edits, was true when read.
Run the pin after the final edit and re-read the gate on the committed tree, not on the tree as it was
when the reading was taken.

## A source-state digest that covers comments makes every comment a contract change

Measured 2026-09-03 (W2-h, `46f102463`). `workflow.execute`'s source-state digest hashes the factory's
source INCLUDING comments, so recording a decision as a comment inside `createWorkflowTool` moved a
pinned contract hash and `check:surface` went red for a change that altered nothing the model sees. True
of all six source-state factories. Either write the comment outside the hashed span, or re-pin
deliberately with a body saying the model-facing declaration is byte-identical (W2-j's `fb83385b4` is the
form) — never treat the red as noise.

## A raw `||` in a tracker cell silently drops the row from `plan-status.py`

Measured 2026-09-03 (S2-0). The status script splits rows on unescaped pipes and requires nine fields;
a cell containing a literal `||` (a code fragment, a shell idiom) yields the wrong field count and the
row is skipped WITHOUT an error — the ledger total read 106 of 107. Escape pipes inside cells as `\|`,
and read the row count after any prose edit. `plan-status.py` now prints a warning naming the row when
the field count is wrong (added the same day), so the drop is loud rather than silent.

## Anything you STAGE is anyone's — a concurrent lane's commit took a whole staged index

Measured 2026-09-03 (W2-t / W2-y, `da6ad0281`). W2-t had eight files staged (six by `git add
<path>`, two locale files by `git apply --cached` of a filtered patch) and was waiting on
`.git/index.lock`; the lane holding the lock committed, and W2-t's staged files rode into that commit
under the other lane's message. Confirmed by the other lane (W2-y): it ran `git add <paths> && git commit`, and a bare
`git commit` takes the WHOLE shared index — so both halves were rule breaks, and the staged side is
the half a lane can control: **never stage ahead of your own commit**. Commit by pathspec in one step
(`git commit <paths> -m …`) with nothing pre-staged; for a locale file, write the filtered content to
the working tree and pathspec-commit it rather than `--cached`. And after any lock wait, read `git log
--stat -1` before assuming the commit you see is yours.

## A working-tree reading during a wave measures the neighbours' uncommitted files

Measured 2026-09-03 (W2-y): `check:surface` printed 6/6 green and then DRIFT on the same pin with no
commit between — another lane's uncommitted edit had arrived in the working tree. The same shape
produced P3.200's "five errors" that do not exist on any committed tree. Put `git status --short` beside
any working-tree measurement taken while lanes run, and attribute a red to a COMMIT (a worktree control
at your base) before recording it.

## Editing a file while its own mutation harness is mid-run: the restore wipes the edit

Measured 2026-09-03 (W2-v, `prompt-builder.ts`). The harness's whole-file write-back is exactly what
makes restores trustworthy — and it restores over ANY edit made after the baseline hash was taken. Here
it came out clean (tree back at baseline, edit re-applied, re-tested); the failure mode is a half-merged
file that still compiles. The lock the harness holds against a second harness must also hold against the
author: no edit to a file between the harness's baseline read and its restore.

## The mutation harness must hold the test lock across mutate → test → restore, and never read the token via `tail -1`

Measured 2026-09-03 (W2-u). A harness that takes the lock per test run releases it between the forward
write and the restore, so another lane's locked run measures the MUTANT. And reading the lock token with
`tail -1` of a log that has a trailing line orphaned the lock for about a minute (released by hand). Hold
one lock for the whole campaign; read the token from the lock's own output, by its marker.

## A test double cast to `never` is invisible to every interface change

Measured 2026-09-03 (W2-l, `claude-live-settings.test.ts`, 8 of 41 red). Two commits three days apart
changed the interface the double stands in for; the cast silenced the compiler, and no run went red
until the file ran ALONE (a batch amortised the failure into another suite's setup). And
`runtime-switch-session.test.ts` was never green solo on any machine — 161.9 s cold / 16.2 s warm against
a 5 s default — so "pre-existing" was true and useless. Type the double; give the hook its measured
budget.

## `mock.module` mutates the imported namespace IN PLACE, so a restore from the live binding restores the mock

Measured 2026-09-03 (W2-u, `9bdcc90a5`) on a throwaway two-file rig: after
`mock.module('node:path', () => winPath)`, the previously imported `hostPath` binding IS the mock
(`hostPath.join === winPath.join`), while a spread taken beforehand still answers `/a/b`. An `afterAll`
that restores with `() => hostPath` reinstalls win32 semantics for every later file in the same run — here
`mkdtempSync(join(tmpdir(), …))` became a RELATIVE backslash name and wrote ten fixture files into the repo
root. The spread must be the thing the restore reads; and the symptom check (no repo-root entry with a
backslash in its name) is cheap enough to run beside every wave.

## A caught import failure is not a contained one — bun keeps the failed record and it beats every later mock

Measured 2026-09-03 (W3-h, `202e8558f`). `scripts/barrel-import-safety.test.ts` imports 92 real barrels
inside try/catch; 16 reach a Vite-only specifier (`pdf.worker.min.mjs?url`) that bun resolves to a real
module with no `default`. The failed module record stays in the registry and wins over every later
`mock.module()` for that specifier — 21 renderer files, 30 of the gate's 68 reds, reproduced in BOTH
command orders. Mocking one layer moves the poison to the next (`DOMMatrix`, then `import.meta.glob`,
unmockable). Contain such probes in a CHILD PROCESS. Two siblings: `Bun.spawnSync` + `stdout:'pipe'`
deadlocks on a child that logs at import (presents as a hung suite); a test that "restores" `process.env`
with `delete` is a process-wide mutation (`home-latch.test.ts` left the whole run without a HOME).

## A backgrounded command's completion notification reports the WRAPPER's exit, not the job's

Measured 2026-09-03 (W3-c, and the controller the same day): `nohup bash -c '…' &` returns at once, so
the harness reports "completed (exit 0)" while the job it launched is still queued and has done nothing —
twice a mutation campaign read as finished with no mutant applied; the controller's gate waiter fired on
its own shell's exit. Read the job's LOG by its terminal sentinel and `pgrep` the job; the notification is
about the launcher. `setsid` does not exist on this host.

## A backtick inside `git commit -m "…"` is a command substitution under zsh

Measured 2026-09-03 (W3-d, `1c112ee45`). The message quoted identifiers in backticks, as house style
does; zsh executed them, one of them was `git ls-files`, and the whole repository listing landed in a
5 921-line commit message. The code in the commit is correct and the message is permanent (amending a
shared, moving history is forbidden). Write the message to a file and pass `-F <file>`.

## The locale-file rule binds only the sweeper — the swept lane loses its provenance

Measured 2026-09-03 (W3-g / W3-d, `1c112ee45`). W3-g wrote two locale keys, ran the gates green, and
before it committed, W3-d's pathspec commit of the locale files took them along with its own key: the keys
are correct at HEAD, and the commit that carries them describes a browser toast. The *commit only your
keys* rule cannot protect a lane whose keys are already in the working tree when a neighbour commits.
Until locale writes are serialised (one lane at a time, or a per-key file), a lane that adds keys should
commit them FIRST — before anything else — and say in its report which commit actually carries them.

## `git commit --amend` under concurrent lanes destroys ANOTHER lane's commit

Measured 2026-09-03 (P3.46, found by P3.31 as a REPAIRED INCIDENT and reported rather than buried).
A lane ran `git commit --amend` to fix up its own commit. Between that commit and the amend, **another
lane had committed on top** — so the amend rewrote the tip, which was not the lane's own commit, and
the neighbour's work was rewritten out of history.

Repaired the same turn: `git reset --soft <the neighbour's sha>` plus a path-scoped reset,
`git diff --stat <sha> HEAD` empty afterwards, the other lane's 4 files / 250 insertions intact.

The rule the lane briefs carried at the time banned `git commit -a` and said **nothing about
`--amend`**, and the two are not the same size of hazard: `-a` over-commits **your own** work and is
recoverable by anyone reading the diff; `--amend` **destroys someone else's** and leaves no diff to
read. `--amend` is safe only where you can prove your commit is still the tip, and under concurrent
lanes you cannot — the check and the amend are not atomic, which is the same gap as the pathspec
trap. **Never amend on a shared branch.** A follow-up commit costs one line of history and no risk.

Same family as *"`git stash` in a shared multi-lane tree pops SOMEBODY ELSE'S work"* and
*"Anything you STAGE is anyone's"*: three commands whose danger is invisible because they operate on
the shared parts of the repository — the tip, the stash, the index — rather than on your files.

## A locale key can be REVERTED by a concurrent commit with BOTH i18n lints green

Measured 2026-09-03 (P3.172, found by P3.42 the hard way). A concurrent lane staged a locale blob
rebuilt from an older base; two keys another lane had added were silently reverted, and
`lint:i18n:parity` and `lint:i18n:sorted` both stayed green over the loss.

**The reason is structural, not a bug in either gate.** Parity compares the locales **against each
other**, so a **SYMMETRIC** loss — the same key gone from `en` and `ru` — is invisible to it by
construction; sorted only checks ordering. The two lints together prove the locales are CONSISTENT.
Neither proves a key still EXISTS.

So: **verify a locale change against `HEAD`'s blob, not against a green lint.**
`git show HEAD:packages/shared/src/i18n/locales/en.json | grep -ac '"<your.key>"'` after the commit is
the whole check. The cheapest structural fix, if anyone builds one, is a **monotonic key-count
assertion** in the parity script — that is the one thing that would have caught this.

Adjacent honesty defect in the same gate, worth fixing whenever it is next touched: the parity gate
prints *"N keys each"* while the two locales legitimately differ in count (plural forms), so its own
summary line is false for one of them.

## No check-then-commit closes the index race — the isolated-index recipe does

Measured 2026-09-03 (P3.173, the generalisation P3.42 and P3.143 reached from opposite directions).
The standing rule is *commit by explicit pathspec*. It is correct and **still insufficient**, because
under concurrency the index and the tip are **shared mutable globals** and every safe-looking sequence
has a gap between two commands:

- another lane's `git add` lands between your check and your commit (P3.42, observed); and
- a **FAILED** commit leaves your own work staged for whoever commits next (P3.143, observed — see
  the `cannot lock ref 'HEAD'` entry above).

**A retry does not close either gap; a `git status` before the commit does not close either gap.** The
failure mode is not *the wrong files get committed*, it is *the index is a shared mutable global*.

**The standing procedure for any file you share with uncommitted work you do not own** — not a special
case, and used successfully by several lanes now:

1. reconstruct the intended content from `git show HEAD:<path>` plus your own edits, in a scratch file;
2. `diff` that against the working tree and confirm the ONLY difference is the other lane's known hunks;
3. stage the blobs into a **private `GIT_INDEX_FILE`**, so the shared index is never touched;
4. `write-tree` / `commit-tree`, then move the branch with a **compare-and-swap**
   `update-ref refs/heads/<branch> <new> <old>`;
5. `git reset -- <your own paths>` afterwards.

A private index removes the shared object; the CAS removes the check-then-act. Everything else is
mitigation. In the run this is taken from, **HEAD moved twice mid-flight** and the CAS caught it both
times, and step 5 was not hygiene — the shared index was holding a staged **revert** of the lane's own
commit, 657 deletions, which a later sibling's pathspec commit could have landed.

Two things to check afterwards, both of which have been got wrong: `grep -a` the **committed blob** for
the other lane's marker (and confirm the marker is absent at HEAD first, or the isolation check
false-passes), and read `git log --stat -1` rather than assuming the commit you see is yours.

## `await expect(p).resolves.…` has no effect, in 396 places — and the decision is to KEEP it

Measured 2026-09-03 (P3.252, found by P3.149 while REFUTING both readings the controller offered).
`tsc` reports `TS80007` — *"'await' has no effect on the type of this expression"* — on this shape.
Both obvious diagnoses are wrong: it is not a stale `await` left by a change, and it is not a
signature of ours that should be async. **The inaccurate declaration belongs to `bun-types`**
(`test.d.ts`, `resolves: Matchers<Awaited<T>>`), and on Bun 1.3.14
`expect(Promise.resolve(1)).resolves.toEqual(1)` returns **`undefined`**, so the `await` genuinely
awaits nothing.

**Count it before writing a rule about it.** `grep -ranoE "await expect\([^;]*\)\.(resolves|rejects)\."`
over tracked `.ts`/`.tsx` at HEAD: **396 occurrences across 120 files**. The row was opened about four
lines in one file. *A rule written for four lines and applied to four hundred* is how this tree's
stale-comment family started, and the count is the thing that turns the question from a fix into a
policy.

**The discriminating control, run both ways, because "style or correctness" turns on it.** Dropping
the `await` does NOT vacate the assertion:

- already-settled promise, `await` removed, wrong expectation → **1 pass / 1 fail**, the wrong one fails;
- **pending** promise (`setTimeout`, 20 ms), `await` removed — the case where a late failure could
  land after the test ended — `.resolves` wrong, `.rejects` wrong, and the awaited control:
  **0 pass / 3 fail**, all three attributed to their own test.

So bun settles the expectation against the test that made it whether or not you await, and the two
forms are behaviourally identical. **This is style, not correctness.**

**Decision, once for the tree (2026-09-03): KEEP the awaits.** They are the reader's cue that the
expectation is asynchronous, they cost nothing at runtime, and the alternative is a 396-site sweep
across 120 files for zero behavioural gain — the largest possible ratio of diff to value, in test
files several lanes hold at once. The price is an editor-level suggestion diagnostic: **`tsc` never
emits suggestion-level diagnostics**, so `typecheck:all` is legitimately green rather than hiding
this, and nothing in CI reads it. Do not "fix" a `TS80007` on this shape file by file, and do not
re-derive this: the answer is here.

## A row can be open against work that is already in HEAD, and the mechanism is the tracker's baseline

Measured across four rows now (P2.401 for the first three — P2.242, P3.50, P6.1 — plus P2.426, found
the same way on 2026-09-03). Each was dispatched as `⬜` and each turned out to be already landed.

**The mechanism is not carelessness, it is the baseline.** A row is written against the tracker's
pinned HEAD; the branch moves; the row now describes a tree that no longer exists. P6.1's fix
(`9e37e0b6b`) sits AFTER the pinned HEAD it was written against. P2.426 named two comments by file
and line — `codex-agent.ts` "This agent has no subprocess" and a `SessionManager` sentence saying
claude and codex keep no stderr buffer — and both had been corrected by `9790c7ce6` (P2.466) before
the lane opened them; the codex comment now reads **"This agent DOES have a subprocess"** and the
SessionManager one narrates its own correction. The lane's line numbers had drifted too, so the row
pointed at unrelated code, which is what a lane sees first and mistakes for a bad row.

The cost is small per row — every lane so far noticed inside its first few probes rather than
re-deriving the work — but it is paid **per row, silently**, and it scales with baseline drift.

Two cheap gates, and **the first belongs to the controller, not the lane:**

- for every `⬜` row that names a symbol, a file or a quoted sentence, verify it against HEAD **before
  dispatch** — a `grep -a` for the quoted sentence is usually the whole check; and
- **re-pin the tracker's baseline commit whenever a wave closes**, which is what stops the drift
  accumulating in the first place.

And for the lane: **measure the claim at HEAD before building anything.** A row closed by verification
is a result, pinned with the commit that closed it — not a row that was wrong.

## An unsplit shell variable handed to `bun test` matches zero files and exits 1 — byte-identical to a kill

Measured 2026-09-04 (W4-b). A mutation harness passed its file list as one quoted variable; `bun test`
found no such path, ran nothing, exited 1, and the harness recorded three KILLS before a dead control
(an unmutated run that must be green) exited 1 too. Always run the dead control FIRST, and read the
executed-test count of every verdict — a kill with zero tests executed is a broken instrument.

## The controller swept a lane's traps entries into its own pathspec commit — the shared-file hazard from the third side

Measured 2026-09-04 (`acaeb831f`): the controller committed this file by pathspec to record one entry
while W4-d had six uncommitted headings in it; all seven rode in under the controller's message. Content
correct, provenance wrong, no amend. The rule the wave briefs give lanes for locale files applies to EVERY
shared append-only file — this one, the registers, the known-failing list: `git diff HEAD <file>` before the
commit, and if the diff carries more than your hunk, commit ONLY your hunk (write the file back to HEAD +
your hunk, commit, then restore the neighbour's hunk) or wait.

## `${PIPESTATUS[0]}` is EMPTY under zsh — the pipefail mitigation fails in the same direction as the bug

Measured 2026-09-04 (W4-c). The lane rules said "read `PIPESTATUS`"; under zsh 5.9 (the shell lanes run)
`PIPESTATUS` does not exist — the array is `pipestatus`, 1-indexed — so the read yields an empty string
and a `[ -z ]` guard reads it as success, exactly like the piped `$?` it was meant to replace (bash gives
`7 0` where zsh gives nothing). Use `set -o pipefail` and read `$?`, or `${pipestatus[1]}` under zsh, and
prove the instrument with a planted red before trusting it. `scripts/check-pipeline-exit.ts` now gates
the shell scripts and the 18 manifests.

## The untracked-file trap from the READER side: a ledger built while the reader was untracked calls live keys dead

Measured 2026-09-04 (W4-e). `check-i18n-reachable` walks TRACKED files; a ledger regenerated while
`turn-preview.ts` (the reader of four `turnCard.*` keys) was still untracked labelled those keys dead, and
a deletion pass built on that ledger would have removed live text. The same mechanism P3.305 measured
for a red (an untracked neighbour makes a gate lie) — here it makes a deletion instrument lie. Regenerate
any reachability ledger on a tree with no untracked source, and diff the ledger against the previous one
before deleting anything it newly calls dead.

## The two-causes timeout rule has a THIRD outcome: a timer lottery over an I/O-bound module graph (measured 2026-09-07)

W7-ag, P6.652, on `apps/electron/src/renderer/pages/__tests__/plugin-info-diagnostics.test.ts`. Every
pre-budget arm was byte-restored from a saved copy and sha256-verified back to baseline (`89342bfa…`,
then `bbd70d9e…`), with `git status` clean after each — so the spread below is one file's bytes, not
one file's history.

| Run | Wall | Load | cpu |
| --- | ---: | --- | --- |
| with the budget | **354.41 s** | **7.59** | ~1 % — SLOWEST, at the LOWEST load |
| with the budget | 334.37 s | 10.67 | 0 % (2.00 s user, 1.27 s sys) |
| with the budget | 280.80 s | 12.10 | 1 % |
| with the budget | 148.50 s | 11.94 | 2 % |
| with the budget | **127.25 s** | **14.97** | 2 % — fastest COLD, at the HIGHEST load |
| pre-budget bytes | 248.05 s | 7.85 | 1 % |
| pre-budget bytes | 91.10 s | 10.25 | 2 % — **6 pass / 0 fail** |
| control, `-t` matching NOTHING, **0 cases run** | 53.87 s | 10.57 | 1 % (0.56 s user / 0.35 s sys) |
| with the budget, **WARM** (straight after `typecheck:electron`) | **2.19 s** | 10.36 | **90 %** |

Three things follow, and the first two contradict the rule that was written here before.

**1. Starvation is REFUTED for this file, not merely unproven.** The two-causes rule reads *"passes
alone at low load → starvation, register it"*. This file passes alone at low load **and is slowest
there** — 2.8x, running backwards against load — so the dichotomy hands out the wrong name. The same
bytes were read `0 pass / 1 fail` by two independent observers and `6 pass / 0 fail` by a third on the
same day: bun's budget is a TIMER that fires only when the transpile lets the loop breathe, so redness
is decided by where a yield lands, not by how busy the box is. **One green run at HEAD therefore does
not refute a member of this family**, and a lane that runs such a file once, sees green and deletes the
budget has measured the lottery rather than the file.

**2. The separating instrument is the zero-case control, not a load reading.**
`bun test <file> -t '<a name nothing matches>'` executes no cases and pays only the file's own
top-level module graph — 53.87 s here, against 0.56 s user and 0.35 s sys. It **splits** the cost
rather than totalling it: those 53.87 s are paid **before any hook timer exists** and are budgetable by
nothing at all, while the hook's dynamic `import()` is a second payment of the same order (54 591 ms
profiled). So read the control, then read `user`/`sys` beside the wall time — **cpu under ~2 % of wall
is I/O**, and a budget is the remedy for I/O, not for contention.

**3. The page cache makes the same work 162x faster, so a "reproduction" can measure the cache.** The
warm run straight after `typecheck:electron` finished in 2.19 s pegging 90 % of a core. A gate that
typechecks or greps the tree before running the suite sees a different file from one that runs it
first — a sufficient mechanism for the same bytes going red for two lanes and green for a third.
Never take a post-typecheck reading as the floor.

Consequence, executed as P6.677: the three earlier members of this family were filed class (c)
starvation on the strength of *"never failed alone, at any load"*, which is a statement about what was
observed and cannot separate starvation from the lottery. Their labels were re-derived from a zero-case
control each; the budgets were left alone.

## Waiting for a shared file to be released does not protect your hunk — the holder's pathspec commit sweeps it (measured 2026-09-07)

W7-ah had a 73-line `###` block ready for
`docs/superpowers/specs/2026-07-29-known-failing-tests.md`. The file carried four hunks: three were
W7-ag's live P6.652 paragraph, one was the block. The shared-file rule forbids committing a file that
carries another lane's hunk, so W7-ah **waited for the release** — the correct move by the rule as
written. W7-ag then committed with `git commit -F <msg> -- <paths>`, which takes the **working tree**,
and the waiting block rode in as `234e09383` under a subject about something else.

Content correct, provenance wrong, and no amend is available in a shared tree. This is the same
mechanism as *"Anything you STAGE is anyone's"* and *"The controller swept a lane's traps entries into
its own pathspec commit"*, from the third side: **the waiter is swept by the holder.** The two moves
that actually protect a hunk in a shared append-only file:

- keep the text **outside the tree** (the lane report, the scratchpad) until `git diff HEAD -- <file>`
  is empty, then write and commit it in one step; or
- **hand the text to the file's holder** and let it land in their commit deliberately, with the
  attribution stated in the message.

"Wait with the edit in the tree" is not one of them.

## A stale-count guard written as a substring of a number WORD matches the number that replaces it (measured twice, 2026-09-07)

W8-h, in `apps/electron/src/renderer/components/app-shell/input/__tests__/`. Twice in one wave, in the
same block:

- `expect(doc).not.toContain('Claude → Codex lists four')` — the count moved to **fourteen**, which
  CONTAINS `four`, so the guard went red on the corrected sentence (P6.391).
- `expect(doc).not.toContain('SIX rows are surfaced')` — the count moved to **TWENTY-SIX**, same shape,
  same failure.

The defect is worse than a false positive: the guard exists to catch a stale count, and it fires
exactly when the count has just been made current — so the signal is inverted precisely at the moment
someone is looking at it. `six`/`sixteen`, `SEVEN`/`SEVENTEEN`, `NINE`/`NINETEEN` and every
`TWENTY-`/`THIRTY-` compound are each one row away from the same behaviour.

Write a bounded match — `/…\bfour(?!teen)\b/` or an anchored regex — and **convert every bare
number-word guard in the block at once**: the second occurrence here was inside the block where the
first had already been fixed, because only the one that had fired was looked at.

## `--update` on a derived ledger reads the sibling lanes' uncommitted edits (measured 2026-09-07)

W8-h, on `scripts/i18n-unreachable-keys.txt` — a self-clearing tripwire that fails on drift in both
directions, which is exactly what makes a polluted regeneration durable. `--update` regenerates the
WHOLE list from a live scan of the working tree, so it records whatever every other lane is mid-edit at
that instant. The run produced twelve new lines: eight the lane's own, and **four
`settings.workflows.sizeGuideline.*` keys that a `--check` twelve minutes earlier had not listed**,
coming from a neighbour's half-written `AppSettingsPage.tsx`. The lane committed the generated output
**minus those four**; recording them would have handed a sibling's transient state to a future reader
as a stale record with no cause attached. (They were gone by the end of the wave — that lane landed its
reader, which is why the gate is green.)

The rule: regenerate any derived ledger **from a quiet tree**, or commit the generated output minus the
lines you did not cause, and **diff it against the previous version** before trusting it. Same family
as *"The untracked-file trap from the READER side"* below and *"A working-tree reading during a wave
measures the neighbours' uncommitted files"* above — a tree-scanning generator run mid-wave is a
measurement of the wave.

## The quoted-glob-in-a-docblock trap was written down and still cost two compile failures (paid again 2026-09-07)

Not a new trap — it is the one recorded on 2026-08-31 in AGENTS.md (a star followed by a slash inside a
block comment CLOSES it; quoting a documentation example that way yielded nine hard parse errors). It
is repeated here because W7-ai paid it **twice more** in one lane, in
`packages/shared/src/agent/mode-manager.ts`, on `.a*/credentials` and on a double-star
`credentials.enc` pattern.

The reason it recurs is structural rather than careless: the docblocks that most need to quote a glob
are the ones documenting glob-matching code — denied-path patterns, allow-write patterns, pathspecs —
so the trap sits waiting in precisely the file where the rule is most relevant. Write such an example
**out in words**, or move it to a line comment outside the block. Both of W7-ai's are now words, with
the reason recorded at the site so the next editor does not "tidy" them back into backticks.

## A decision that enumerates names must cite the list it was derived from (measured 2026-09-07)

W8-i, twice in one wave, and the novelty is the LOCATION: both were inside plan **decisions**, not
inside code comments, which is where the existing *"prose enumerations beside a single-source-of-truth
list age silently"* rule points.

- **P6.539** named **four** `OTEL_LOG_*` content opt-ins where the page's table carries **five**. The
  fifth is `OTEL_LOG_ASSISTANT_RESPONSES`, and its own page row explains why the omission both is easy
  and is not harmless — it falls back to the value of `OTEL_LOG_USER_PROMPTS` when unset, so with the
  prompts flag stripped an unset fifth name stays disabled and a four-name strip *looks* total. An
  operator who exported `OTEL_LOG_ASSISTANT_RESPONSES=1` **on its own** would have kept exporting every
  assistant turn through a strip this repo had recorded as complete. Bundle probe on the vendored
  2.1.233 (`grep -aoF`, i.e. OCCURRENCES — the instrument is named because LINES answers
  differently on a minified artefact, C3.294): the five names occur 11 / 8 / 8 / 8 / 6 times,
  control `ZZQQNOTAREALNAME` 0. Re-measured 2026-09-12 on the vendored 2.1.247 (C3.252) they
  occur 8 / 5 / 5 / 5 / 4 times, by LINES 6 / 4 / 4 / 4 / 4, control 0/0 — so all five are
  still in the binary we ship, which is the claim, and every number attached to it moved.
- **P6.530**'s done-means asked for a name to be **absent**, where absence re-enables the tool on
  Windows.

Neither is covered by any guard: a comment can be diffed against the constant beside it, a decision
cannot. The mitigation is one sentence per enumeration — **name the source the names came from** (the
bundle's own array, the page's table, the constant that holds the membership rule) — so the next reader
re-derives the set instead of re-counting a sentence. Where the enumeration is load-bearing, put the
rule in a constant with the membership question written above it, which is what P6.539's fix did.

## `toMatchObject` with an asymmetric matcher REPLACES the received property with the matcher (measured 2026-09-07)

W8-td, while fixing `P6.699`. bun 1.3.14. Three cases in one file, the second and third being the
controls that say what is responsible:

```
const received = { a: 'hello id_rsa.pem world', b: 1 }
expect(received).toMatchObject({ a: expect.stringContaining('id_rsa') })
   → typeof received.a === 'object', String(received.a) === '[object ExpectStringContaining]',
     JSON.stringify(received) === '{"a":{},"b":1}'

control 1 — same object, LITERAL expectation:  expect(received).toMatchObject({ b: 1 })
   → received.a is still the string

control 2 — same asymmetric matcher, toEqual:  expect(received).toEqual({ a: expect.stringContaining('id_rsa') })
   → received.a is still the string
```

So it is `toMatchObject`, not the matcher, and the received object is mutated in place by an assertion
that reads as a pure comparison.

**How it presents.** The assertion itself PASSES. What fails is the NEXT thing that touches the object —
in the case that found it, `expect(JSON.stringify(decision)).toContain('deniedPaths')` reported
`Received: {"decision":{"denied":{"rejection":{}}}}` for a rejection that had, one line earlier, been a
full sentence. Ten minutes were spent looking for a runtime that had stopped populating a field.

**The silent direction is the reason this is a trap and not a curiosity.** A later
`expect(obj.k).toBeDefined()` passes on the matcher; a later `toBeTruthy()` passes; a snapshot records
`{}`; a debug log prints `[object ExpectStringContaining]` and reads like a serialisation quirk. Only an
assertion that needs the CONTENT fails, and it fails pointing at the wrong layer.

**The rule: read the value into a local first, then assert on it.** One extra line, and it also makes
the assertion say what it means:

```
const rejection = String(decision.decision?.denied?.rejection ?? '')
expect(rejection).toContain('id_rsa.pem')
```

**Blast radius, measured the way P6.680 teaches:** the same-line grep
(`git grep 'toMatchObject([^)]*expect\.'`) finds **8** files, and a windowed scan over every tracked
`.test.ts`/`.test.tsx` finds **41 call sites across 22 files** of 1 892 — because the common spelling
puts the matcher on a later line. Whether a given site is harmed depends on whether anything reads the
object afterwards, which no grep can decide; the 41 is the exposure, not the defect count.

## A command-corpus count is a reading with a date, and the corpus is discoverable from nowhere (measured 2026-09-07)

**The count.** P2.91 measured the removal breaker's blast radius against **18 272** distinct Bash commands
actually issued by agents in this repo. Every posture decision the heredoc model rests on quotes numbers
derived from that figure. Re-taken from the same source on 2026-09-07: **19 619**. Nothing about the
instrument changed — the corpus is a copy of the local session transcripts, and transcripts accumulate.
The 4 391 heredoc commands, the 94 unparseable and the 37 expanding bodies in this wave are all readings
of THAT copy, taken on THAT day.

**The rule.** Quote the script's own output beside the date, never a number carried forward from an
earlier row. `NESSY_COMMAND_CORPUS=<dir> bun scripts/command-corpus.ts stats` prints the census; the copy's
`MANIFEST.json` carries `takenAt`, the source pattern and the file count, so a stale reading is visible
rather than plausible.

**Why it was invisible.** The copy lives OUTSIDE the repository, deliberately: transcripts are untrusted
data that may carry secrets, and the owner sitting (§1.6 = (A), 2026-09-05) settled on one scrubbed,
read-only copy. Nothing in the repo pointed at it. A lane that wanted the weighting had to find a previous
lane's report to learn the variable's name — and a lane that did not find it measured a designed adversarial
slice instead, which is honest but unweighted, and that is exactly how P2.91's number came to be quoted
for a year. `AGENTS.md` §Traps now names the variable and the reader.

**The derived half, so CI is not blind.** `scripts/heredoc-shape-slice.ts` reduces the corpus to counts —
a four-class histogram and five summed integers — and commits them at
`packages/shared/src/agent/pi-harness/__fixtures__/heredoc-shape-slice.json`. Strings in, integers out, so
"it must not emit command text" is a SHAPE and not a filter; its own test plants an invented
credential-shaped string and scans every 8-character window of it against the serialized slice, with an
empty-vs-one-command control so the absence cannot be satisfied by ignoring the input. That arm is
deliberately weaker than `split-diff`: `split-diff` proves nothing moved that should not have, the slice
proves the population has not changed shape.

## A generator script edited in a shared tree is LIVE for every neighbour before it is committed (measured 2026-09-07)

**What happened.** A lane had an uncommitted change to `scripts/ipc-inventory.ts`. A neighbouring lane ran
`bun run ipc:inventory` — the ordinary, correct thing to do when it changed a channel — and the generated
file briefly acquired a header line that exists in no commit. It lost it again when the first lane reverted
the script. Nothing broke, because that particular line had been made non-load-bearing for staleness. Had
it been folded into the staleness verdict, the neighbour would have committed a generated file that only an
uncommitted script could produce, and the next `--check` on any other machine would have called it stale.

**Why the existing traps do not cover it.** Every shared-file rule in this document is about a FILE two
lanes both write. This is a shared TOOL: only one lane writes the script, and the damage lands in a
different file, committed by someone who never touched it. `git status` shows the neighbour nothing wrong —
their diff is exactly the generated output of the command they were told to run.

**The rule.** A generator's working-tree state is executed by every other lane. So a generator change must
be safe to run before it is committed, or the generator must be committed FIRST and the regeneration
announced afterwards. When announcing a regeneration step in a report or a hand-off, say which commit
carries the generator.

## `--reporter=junit` is the instrument that separates a module-graph red from a test red (measured 2026-09-07)

W7-ae, P6.646, on `packages/pi-agent-server/src/__tests__/harness-contract/pi-harness-baseline.test.ts`.
The row arrived describing one named test — *"executes golden event and prompt producers with ordered
source contracts"* — that times out at bun's 5 000 ms default under wave load and passes alone. Every rule
in this document up to that point points the same way: run it at both load extremes, then price the file's
own graph with a zero-case control. Both were done. Neither says **where inside the file the seconds are**,
and that is the question a budget has to answer.

`bun test <file> --reporter=junit --reporter-outfile=<out.xml>` answers it directly: the JUnit XML carries a
`time=` attribute per test case, so the per-body cost and the file total stop being one number.

| Arm | Load | Reading |
| --- | --- | --- |
| whole file, per-test budget draft | 11.99 | 23 pass / 0 fail, **75.66 s** |
| whole file, `--reporter=junit` | 13.82 | 23 pass / 0 fail, **341.01 s** |
| whole file, final shape (`setDefaultTimeout`) | 13.23 | 23 pass / 0 fail, **1 323.00 ms** |
| W8-g's filtered arm, `-t` on the named test | 9.08 | 1 pass / 186 `expect()` calls, **542.83 s** |

**Under junit every one of the 23 bodies measures in milliseconds** — slowest three 152 ms, 100 ms, and
**65 ms for the golden producer itself**, the very case whose failure message names it. Three whole-file
loads differing by 15 % produced wall times differing by 258x. So the seconds are the import graph blocking
the loop, bun's budget is a TIMER, and **which test holds the window when it fires is an accident of
scheduling**.

**What it changed, and what it would have cost not to run it.** A per-test budget sized from the failure
message would have been set against a 65 ms body and left the other 22 tests exposed to the identical
mechanism — a fix that passes and protects nothing. The budget landed on the FILE instead
(`MODULE_GRAPH_BUDGET_MS = 900_000` via `setDefaultTimeout`), sized against the largest observed run total
(542.83 s), never zero and never a neighbour's constant.

**Where it sits among the other timing instruments**, because the three are not interchangeable:

- **load extremes** (the two-causes rule) separate contention from a cost inside the file — and on an
  I/O-bound graph they can return the same verdict twice by luck;
- **the zero-case control** (`-t` matching nothing) prices the module graph with **no case running at all**;
- **`--reporter=junit`** prices **every body inside** that graph.

A body in milliseconds under a file total in minutes is the signature of a module-graph red, and it is the
one reading that names the remedy: budget the file, not the test the failure happened to name.

## On this rig a timing claim needs `user`/`sys`, not `uptime` — the dominant cost is I/O wait (measured 2026-09-07)

W8-x, P6.560. The row asked why one `format-adapters` test needed a 30 s budget where bun's default is 5 s.
Profiling attributed the test honestly: one `normalizePluginBundle` costs 1.07–2.47 s and one
`normalizeCodexPluginManifest` 0.70–1.10 s (six calls of each, two runs), so the `it()` that does three costs **3 431 ms** cold in the
first run and **3 912 ms** in the second — the 30 s budget is correct and generous, and the 5 s default was
always marginal by construction.

**The remainder was never the normalize. It was the module import, and it reproduces**: importing
`packages/shared/src/plugins/format-adapters.ts` took **67 537 ms** and then **71 597 ms** in two runs whose
`uptime` sat in the same narrow band around 10. Reproducible at that size is not a cold-transpile artefact.

The instrument that named the term was `/usr/bin/time -p`, not the load average:

```
--- CONTROL: a trivial module (types.ts) ---   real  3.58   user 0.03   sys 0.02
--- SUBJECT: plugins/schema.ts alone      ---   real 23.17   user 0.08   sys 0.05
```

**0.13 s of CPU for 23 s of wall.** The five-way decomposition of `schema.ts`'s own imports
(`real 48.54 user 1.07 sys 0.09`) prints the diagnosis itself: `semver` alone **17 558.8 ms**, `croner`
2 130.9 ms, and bun's own `warn: Slow filesystem detected` naming `~/.bun/install/cache`. The volume is
local APFS and ordinary directory traversal on it is normal, so the cost is **per-file-open latency under
concurrency** — many lanes opening many small files at once — not a slow medium and not CPU contention.

**Why the existing rule was not enough.** *"Read the load at that moment (`uptime`) and quote it beside the
duration"* asks for the one number that is blind to this: a process burning 0.5 % of a core for a minute
contributes almost nothing to a load average, and a box at load 10 that is 90 % I/O wait behaves nothing
like a box at load 10 that is compute-bound. Every wave-6/7/8 duration taken on this rig therefore carries
an I/O confound that no load reading can report, and two lanes attributed such a duration to their own diff.

**The rule.** Quote `user` and `sys` beside `real` — one `/usr/bin/time -p` — for any duration a decision
rests on. cpu under a couple of percent of wall means I/O, and I/O is budgeted, not optimised; a
comparable `user` on both arms is what makes two durations comparable at all. This is the same reading the
timer-lottery entry above asks for, generalised off `bun test` and onto every timing claim.

## `-I` and `-a` are opposites and the last one wins, so `git grep -anI` is not the absence check AGENTS.md prescribes (measured 2026-09-08)

Born from W9-f's proposed row 1 (P6.755). The claim as filed: `git grep -anI skipWebFetchPreflight --
packages apps` returned **0** where `git grep -an` returned **13**, including the live call site — a
lane trusting the first would have rebuilt a shipped feature.

**The headline does not reproduce at HEAD, and the mechanism does.** Both halves matter, so both are
recorded.

### The mechanism, on a controlled two-file probe

Two files in a throwaway directory, the same needle in both, one of them carrying a NUL byte:

```sh
printf 'line one NEEDLE here\n' > plain.txt
printf 'head NEEDLE early\n\000\nlater NEEDLE after nul\n' > withnul.txt
```

| Command | `withnul.txt` lines returned |
| --- | --- |
| `grep -rn NEEDLE .` | 0 (and no notice at all) |
| `grep -rna NEEDLE .` | 2 |
| `grep -rnaI NEEDLE .` | **0** |
| `grep -rnIa NEEDLE .` | 2 |
| `git grep -n NEEDLE` | 0 lines, but prints `Binary file withnul.txt matches` |
| `git grep -na NEEDLE` | 2 |
| `git grep -naI NEEDLE` | **0** |
| `git grep -nIa NEEDLE` | 2 |

So `-a` and `-I` are not a modifier and a filter; they are the same switch written twice, and the LAST
occurrence wins in both tools. `-anI` is `-I`. The bullet AGENTS.md has carried since 2026-08-29 — *use
`grep -a` for any absence claim* — is undone by a letter typed after it, in the same command, with no
diagnostic.

**The `-I` arm is strictly worse than the default arm.** Plain `git grep -n` still emits `Binary file
… matches`, which is a visible hint that something was skipped; `-I` removes that line too. The output
of a `-I` run is therefore indistinguishable from a genuine absence, from inside the run.

**And the local `grep` is not GNU grep.** This rig's is `ugrep 7.8.4` (`grep --version`), which prints
no binary notice at any flag setting — so for `grep`, plain `-rn` and `-rnI` produce byte-identical
output and neither says anything was skipped. Any flag semantics reasoned from GNU grep's manual is a
guess here; run `grep --version` before trusting one.

### Why the filed numbers do not reproduce

At HEAD (2026-09-08), over tracked blobs:

```
git grep -anI skipWebFetchPreflight -- packages apps | wc -l   -> 16
git grep -an  skipWebFetchPreflight -- packages apps | wc -l   -> 16
```

and at `c20c6671c`, the wave's base, 15 and 15. The reason is in the sibling bullet: `bun
scripts/check-nul-bytes.ts` reports **0 of 4578** tracked files carrying a NUL byte, since P2.415
escaped the last two. Over tracked sources the two flags **cannot** diverge today, so the 0-vs-13
reading was either taken over a different corpus or against a tree that still carried an unescaped NUL
byte. Recorded as refuted rather than carried forward.

The divergence that does survive is outside the tracked set — build output and `node_modules` under the
same two directories:

```
grep -rn  skipWebFetchPreflight packages apps | wc -l   -> 27
grep -rnI skipWebFetchPreflight packages apps | wc -l   -> 27
grep -rna skipWebFetchPreflight packages apps | wc -l   -> 32
```

Five lines only `-a` sees, and `-I` is indistinguishable from no flag at all — which is the same trap
one level out: it looks like a complete answer.

### The rule

Never pass `-I` in the same command as `-a`. State the CORPUS an absence claim was made over — `git
grep` reads tracked blobs only, so "absent from `git grep`" and "absent from the working tree" are
different claims, and the second needs `grep -rna` or an `xargs` over `git ls-files` plus the untracked
files. And keep the positive control from §"A positive control validates your instrument, not your
premise": the probe above is one, and it costs two `printf`s.

## A stale-NAME guard on a bare identifier fails on the commit that removes the name (measured 2026-09-08)

Born from W9-f's P6.665 (proposed row 2, P6.756). Third habitat of the substring family, after
P6.675 and P6.736, and after the number-word entry above.

The `/agents` overlay rendered `agent.diagnosticCodes` under a heading keyed `agents.tools` — a lie
about its own subject, since `SafeCapabilitySummary` has no tool list and `toSafeSummary` fills that
field from `cap.diagnostics.map(d => d.code)`. The fix renamed the key to `agents.diagnostics` and
wrote a comment on the renamed line explaining why the old name was wrong. The guard written to hold
the rename was:

```ts
expect(agentsOverlay).not.toContain('agents.tools')
```

It went red on `6d6d5fece` — the commit that deleted the only reader — because the comment justifying
the deletion contains the deleted name. As with the number-word guards, the signal is inverted at
exactly the moment someone is looking at it: the guard reports "still there" on the commit that
removed it, and the natural next move is to delete the explanation, which is the one artefact worth
keeping.

**Guard the CALL, not the identifier**, and pair it with a presence assertion for the successor. What
is in the tree at HEAD:

```ts
expect(agentsOverlay).toContain("t('agents.diagnostics')")
expect(agentsOverlay).not.toContain("t('agents.tools')")
expect(en['agents.diagnostics']).toBeDefined()
expect(en['agents.tools']).toBeUndefined()
```

`t('…')` is syntax the prose around it does not carry, so the guard reads code and not the comment
beside it; the locale halves catch the other direction, a rename that leaves the spent key behind for
the unreachable-key ledger to meet later; and the presence assertion means the pair cannot be
satisfied by deleting both. The general shape: **a guard whose subject is a name must match something
only the machine writes** — a call, an import, a JSX attribute — because every other occurrence of that
name in the file is documentation, and documentation about a removal necessarily names the removed
thing.

## A comment asserting what a DIFFERENT module does not do has no guard, and the module that falsifies it has no reason to look (measured 2026-09-08)

Born from W9-a's P6.551 (proposed row 1, P6.759). Sibling of §"A wrong value survives because it is
used as a test's EXEMPLAR, not asserted": both are claims that no machine reads, but this one is worse,
because the person who falsifies it is in a different file and has no reason to be looking.

`codexDeclinesAgentToolGrant` (`packages/shared/src/capabilities/resolver.ts`) carried a docblock whose
whole point was to state a residue precisely — which half of the predicate needs a seam and why. Its
words:

> a FILE-based (native) agent's grant is in the markdown frontmatter, and the resolver never opens the
> file. `markdownAgentRecords` (`capabilities/native-sources.ts`) hashes the file and reads nothing out
> of it

Both sentences were TRUE when written, and both were FALSE at HEAD. P6.602 (`ec4bc3173`, 2026-09-06)
taught `pinnedAgentMetadata` — the function `markdownAgentRecords` calls — to parse the frontmatter
with `matter()` for `description`. The file was already open, and had been for two days.

**What it cost.** The stale premise was not decorative: it was the premise of a whole plan row.
P6.551 was written from it, sized **M**, and priced two seams against each other — a synchronous
frontmatter parse per agent file on every inventory scan, or carrying
`materializePiRuntimeAgentDefinitions`' per-session verdict back into the capability layer, which would
first have had to answer what `active` means for a definition denied on one session and live on
another. Neither cost existed. When W9-a finally read the code instead of the comment, the row closed
as an **XS refutation** plus one boolean on the record (`16ae99cc9`). A size-M budget line, a
controller decision, and a re-zoning note ("zone spans `SessionManager.ts` + the capability layer —
not a `resolver.ts`-only lane") were all spent on a cost of zero.

**Why the ordinary defences did not fire, all three of them.**

1. *It is not a stale doc anchor.* Every rule this repo has about decaying references is about
   pointing at a moving target — a line number, a page section. This claim pointed at nothing; it
   ASSERTED a behaviour, and an assertion has no anchor to check.
2. *It is not testable from where it lives.* A test in `resolver.test.ts` cannot fail because
   `native-sources.ts` started reading a file. The claim's subject and the claim's home are different
   modules, and nothing in between changed shape.
3. *The falsifying commit was in the same file and still walked past it.* This is the sharp part.
   `ec4bc3173` KNEW the premise was a premise: it corrected **two** docblocks in
   `pi-harness/runtime-agent-definition.ts` that asserted it, in the same commit, in its own words —
   *"the resolver hashes the file and reads nothing out of it"* → *"That is no longer true"*. And it
   EDITED `resolver.ts`, adding a comment at the agent binding. The third copy of the same premise sat
   roughly 650 lines above that edit, in the same file, and survived. The author searched for the
   sentences they remembered writing, not for the claim.

**The fix that generalises, and it is already in the tree.** A cross-module negative claim needs a
BACK-POINTER in the module it is about, so the next person to change that module meets the claim
without having to go looking for it. `16ae99cc9` put one there — `pinnedAgentMetadata`'s own docblock
in `native-sources.ts` now names `codexDeclinesAgentToolGrant`, says what its docblock used to claim,
and says why the claim is dead:

> `codexDeclinesAgentToolGrant`'s docblock said a file-based agent's grant "is not knowable here"
> because `markdownAgentRecords` "hashes the file and reads nothing out of it". That was true of the
> record and NOT of this function

Rules, in order of strength:

- **Do not assert another module's behaviour at all when you can read it instead** — name the function
  and let the reader look. A `{@link}` costs nothing and cannot go stale into a false statement; it
  can only fail to resolve, which a typechecker and an IDE both notice.
- **If you must assert it, leave the back-pointer** in the asserted module, in the same commit. One
  sentence: *X in Y asserts that this function does Z; change it and go correct X.* That is the only
  artefact placed where the falsifying edit will happen.
- **If the assertion is load-bearing — a plan row, a size, a decision — pin it with a test**, in the
  ASSERTED module's suite. `native-agent-tool-grant.test.ts` is what that looks like here: the
  frontmatter arm and the catalog arm in one file, so the two modules can no longer drift apart
  silently.
- **When you falsify a premise, grep the CLAIM and not the sentence — and grep it SHORT.** The
  instrument was one command away: over the parent tree, `git grep -an 'hashes the file' --
  ':(glob)packages/**/*.ts'` returns exactly **three** hits — the two `ec4bc3173` corrected and the one
  it did not. The longer, more natural phrase returns only **two**: `git grep -an 'reads nothing out of
  it'` misses `runtime-agent-definition.ts:1267`, where the same words are wrapped across a line break
  (`reads` / `nothing out of it`). A grep for a claim written in prose is a grep against an arbitrary
  line-wrap, so **pick the shortest distinctive fragment that cannot straddle a newline**, and read the
  hit count as a floor rather than an answer. (Both pathspecs need `:(glob)` — a bare `**` is read
  without glob magic and silently drops files; §"A quoted glob pathspec makes `git grep` search
  nothing".)

## A second, NESTED `pdfjs-dist` defeats the `mock.module` stub every renderer test copies — and the polyfill that covers it is the half nobody copies (measured 2026-09-08)

**AGENTS.md carries the rule. This is what it cost and how it was measured.**

Found by W9-y while gating P6.773. A render test for `SourcesManagementRow` was written and thrown
away; the evidence is committed in the docblock of
`apps/electron/src/renderer/components/info/__tests__/local-mcp-disabled-surfaces.test.tsx`
(`5cb47993c`), and the numbers below are that lane's, re-derived here where they could be.

### The two failures, in order

1. **113 s, then `a beforeEach/afterEach hook timed out`** — from a file whose only hook is a
   `beforeAll`. See §"the misnomer" below.
2. **136 s, then `ReferenceError: DOMMatrix is not defined`** — after the stubs were added.

### Why the stub does not cover it

`mock.module` keys on the **resolved module**, not on the specifier text. The test stubs
`pdfjs-dist`, which resolves to the top-level copy. `react-pdf` — which the row's barrel reaches
transitively — resolves `pdfjs-dist` from **its own** `node_modules`, so it loads a different file
that no stub of the bare specifier touches. Both copies exist at HEAD and they are not even the same
version:

```sh
node_modules/pdfjs-dist/package.json                       5.7.284
node_modules/react-pdf/node_modules/pdfjs-dist/package.json 5.4.296
```

That second copy really executes, and it wants a DOM. The thing that makes it survivable is the
**global `DOMMatrix` polyfill** sitting a few lines below the stubs in
`apps/electron/src/renderer/pages/__tests__/capability-info-pages.test.tsx` — visually part of the
same block, logically the half that does the work, and the half a reader copying "the three
`mock.module` lines" leaves behind.

**It is not optional anywhere in this tree**, which is the strongest argument for copying the block
whole. Nineteen tracked files stub `pdfjs-dist`; every one of them also carries `DOMMatrix`:

```sh
comm -23 <(git grep -ln "mock.module('pdfjs-dist'" -- apps packages | grep -v node_modules | sort) \
          <(git grep -ln 'DOMMatrix'                -- apps packages | grep -v node_modules | sort)
# → empty
```

### And weigh the 136 s before reaching for a render test at all

The question these tests were asking — *does the value reach the component* — is answerable by a
source-text assertion that costs seconds and cannot be satisfied by a value dropped on the way
(`local-mcp-disabled-surfaces.test.tsx` → 10 cases, 22.58 s including its own module graph). The
render alternative buys a real DOM at 136 s plus three module mocks that, without a spread, leak to
every later file in the process. For a component whose input is a prop, the cheap instrument is also
the honest one.

## The `beforeEach/afterEach` misnomer, sighted twice more on one day (measured 2026-09-08)

AGENTS.md has recorded since 2026-09-01 that bun prints `a beforeEach/afterEach hook timed out` for
the `beforeAll`/`afterAll` family too. Two more sightings on 2026-09-08, **both on files that declare
no `beforeEach` at all**:

| File | Hook time | State |
| --- | --- | --- |
| W9-y's discarded `SourcesManagementRow` render test | 113 s | thrown away |
| `apps/electron/src/renderer/playground/__tests__/sources-management-registry.test.ts` | 79 936 ms | registered red (W9-t, P6.745) |

`grep -c beforeEach` on the second file returns **0**; its only hook is the `beforeAll` that does
three dynamic `import()`s of playground registries plus the row list.

**So the message is not evidence about which hook family ran.** Read the file: a suite that declares
no `beforeEach` is telling you the timeout is its `beforeAll`, and the remedy is that hook's own
budget set against a measured floor — not a per-test timeout, and not a rewrite of a `beforeEach`
that does not exist.

## `bun test` IGNORES the order of the paths it is given, so a blast-radius probe run the obvious way measures nothing (measured 2026-09-08)

The spreadless-`mock.module` trap above has said *"every LATER test file"* since 2026-08-07. It is
the natural wording — `mock.module` is installed when the amputating file loads, so the files
after it are the victims — and it invites exactly one experiment: **put the consumer first and
watch it pass.** That experiment cannot fail, and its passing is not a refutation of anything.

**Measured by W9-an on bun 1.3.14 while closing P6.844**, with two throwaway in-tree probes (a
spreadless `mock.module` of a real module in one file, an `import * as ns` consumer in the other)
plus an `a`/`m`/`z` control:

- the consumer listed **FIRST** on the command line still received the amputated one-key namespace
  and failed — the amputation is process-global, exactly as the rule says;
- the three-file control produced the **same execution order under two different CLI orders**, and
  that order was neither the given one nor alphabetical.

It cost **three inconclusive readings** in that lane before the cause was seen. Two suites run
"amputator first, consumer second" both passed, which reads as a refutation of the trap and is not
one.

**Re-run independently 2026-09-08 (W9-ao, P6.848), on the same bun 1.3.14, with a four-file control
chosen so the answer cannot be mistaken for a rule.** Four trivial files — `alpha`, `beta`,
`gamma`, `delta`, each logging its own name, no repo imports — handed to `bun test` in three
different orders:

| Order given on the command line | Order executed |
| --- | --- |
| `alpha beta gamma delta` | `beta gamma alpha delta` |
| `delta gamma beta alpha` | `beta gamma alpha delta` |
| `gamma alpha delta beta` | `beta gamma alpha delta` |

`Ran 4 tests across 4 files` all three times. **The executed order is invariant under the CLI order,
and it is neither the given order, nor alphabetical, nor reverse-alphabetical.** That last clause is
why the four-file control was worth running: the original `a`/`m`/`z` reading came out `z m a`,
which a reader could reasonably file as *"bun reverses the list"* and then plan around. There is
nothing to plan around.

**Two consequences, and the second is the one that changes what you do.**

1. **The honest statement of the spreadless-mock trap is *"some OTHER file in the batch, and you
   cannot choose which"***, not *"every later file"*. `AGENTS.md` §Traps now says so.
2. **The fix can never be "order the batch."** Ordering is not an available operation. The remedies
   are the ones the trap already names — spread the real module, restore it in `afterAll` — plus
   the one this measurement adds: **to see whether a file is a victim, run that file ALONE**, and
   read the executed-test COUNT rather than the pass count, because a batch that silently ran a
   different set is the failure mode next door.

**A note on what this does NOT say.** It is not a claim about *why* bun picks the order it picks —
nothing here probed that, and a cause invented from three readings would be the invented answer this
file exists to prevent. What is measured is that the order is stable across runs, independent of the
argument order, and not derivable from the names.

## A timing A/B needs a PAIRED, ALTERNATING pair of arms — the same bytes spread 22x on the page cache alone (measured 2026-09-08)

`AGENTS.md` §Traps already carries two rules about timing on this rig: a timing claim needs a control
run at the same moment on unmodified code, and on this box `uptime` is the wrong instrument on its own
because the dominant cost is I/O wait. **W9-bg's P6.901 measurement shows both together are still not
enough**, and the failure is not subtle.

### What was measured

The four `session-mcp-server` harness suites, every arm byte-restored between runs (`shasum -a 256`
matching on both sides; no `git checkout --` / `restore` / `stash` on any file), each run
`24 pass / 0 fail`, `186 expect()`, **4 FILES**:

| Bytes | Load | Wall | user / sys |
| --- | --- | --- | --- |
| before (26 children) | 14.46 → 9.01 | 961.71 s | 19.23 / 7.37 |
| pooled (10 children) | 14.49 → 8.92 | **719.08 s** | 5.07 / 2.15 |
| pooled, control | 36.55 | **32.58 s** | 2.27 / 0.91 |
| pooled, A/B serial r1 | 9.86 | 497.59 s | 5.34 / 2.15 |
| pooled, A/B serial r2 | 44.29 | 34.58 s | 5.46 / 1.88 |
| pooled, final | 25.81 → 11.72 | 232.00 s | 4.05 / 1.62 |

**Rows 2 and 3 are the finding: identical COMMITTED bytes, 719.08 s at load 14.49 and 32.58 s at load
36.55.** A 22x spread, running BACKWARDS against load, at under 1 % cpu on both. Nothing about the code
changed between them.

### Why "a control run at the same moment" does not cover it

"The same moment" is minutes wide on a suite whose cost is a cold module graph, and the page cache moves
across that window by more than any change these rows make. The before/after pair W9-bg committed was
taken adjacent — which is *good* practice against load drift and *bad* practice against the cache,
because the after-run inherits the before-run's warm cache and looks faster for a reason that has
nothing to do with the diff. That lane's commit message therefore claimed "25 % faster", and its own
report corrects it, because a message cannot be amended.

### The instrument

**Alternate: A, B, A, B, and compare ADJACENT runs.** Two arms taken once each — however carefully
timed — are one cache reading. W9-bg's own alternating pair is what produced the only defensible
wall-clock number in the row (a warm-up worth 11 % and 18 %, same sign twice) — and even that gain was
later withdrawn for a different reason (see the concurrency note below).

**And prefer the STRUCTURAL claim whenever one is available.** What survives from that row with no
confound at all is not a duration: the child count fell from 26 to 10, and the four suites are
`24 pass / 0 fail` with the same `expect()` and FILE counts before and after. A structural claim needs
no control run, no alternation and no load reading, and it does not decay when the machine is busy.

### The concurrency note, recorded because the next lane will have the same idea

Because the boot is I/O wait, starting the pooled boots concurrently instead of lazily looks free. It
measured as a real gain in the paired A/B above and was committed (`07d105be7`) — and a verification
run on those committed bytes went red at **240 610 ms**, exactly `READY_TIMEOUT_MS`. **Seven cold boots
competing for one disk are not seven boots taken one at a time**, so the warm-up invalidated the very
measurement its window was sized against. Reverted in `5c47a2bf9`. The prerequisite (a measured N-way
boot floor, under the concurrency the warm-up creates) is P6.909.

## zsh does not word-split an unquoted `$VAR`, so `bun test $FILES` runs ZERO files and exits 0 (measured 2026-09-08)

`AGENTS.md` §Traps says *"`bun test` given a path that does not exist RUNS THE REST AND SAYS NOTHING"*.
This is one step further along, and the exit code is just as quiet.

W9-bg's first A/B attempt passed its four test paths through an unquoted parameter expansion:

```sh
FILES="a.test.ts b.test.ts c.test.ts d.test.ts"
bun test $FILES     # zsh passes ONE argument, not four
```

zsh — unlike bash — does **not** perform word splitting on an unquoted parameter expansion. `bun test`
therefore received a single filter string matching nothing, ran **zero files**, and returned **green in
0.45 s**. Nothing in the output said so except the FILE COUNT (`Ran 0 tests across 0 files`), which is
why AGENTS.md's rule about reading the FILE COUNT rather than the pass count is the instrument here too.

**The same shape appears outside `bun test`.** The controller met it the same day on
`git diff -- $FILES`, which produced an empty patch — indistinguishable from *"this file has no
changes"*, and acted on as if it were. Any command whose "nothing matched" answer is a success is
exposed: `git diff`, `git grep`, `wc -l`, a `for` loop over the same variable.

**The fix**: use a real array and quote it (`FILES=(a b c d)` … `bun test "${FILES[@]}"`), or list the
paths literally in the command. **The check**: read the FILE COUNT — a green run over zero files and a
green run over four are the same exit status and the same three lines of output.

## An unescaped `|` in a LEDGER cell drops the row, and the guard that names it prints on the other stream (measured 2026-09-08, re-measured 2026-09-09)

The tracker half of this is already above (§"A raw `||` in a tracker cell…", 2026-09-03), and its last
sentence says the drop is now loud rather than silent. W9-bn paid it twice anyway on the CAPABILITY
LEDGER — once with a TypeScript union and once with a regex alternation written verbatim into a `Why`
cell — and both times wrote it up as silent. **That half is refuted, and the refutation is the useful
part**: `b3e92c8ca` (2026-09-03) added the warning, it is an ancestor of every W9-bn commit, and on a rig
copy of the ledger it fires exactly as written:

```
  ⚠ ledger row J27 has 10 fields, not 9 — an unescaped `|` in a cell; the row is SKIPPED
```

What is real is **where** it fires. The warning goes to **stderr**; the count table a lane reads after
its own commit goes to **stdout**. The clean ledger already prints one stderr line of its own (the seven
retired ids), so the warning is one more line in a place nobody is looking, and any invocation that
captures, redirects or pipes only stdout drops it entirely.

And the stdout damage is shaped like ordinary work. One pipe injected into one cell, measured
2026-09-09 against the same ledger with and without it:

| | clean | one unescaped `\|` |
| --- | ---: | ---: |
| rows | **632** | **631** |
| Pi partial / remainder | 132 / 410 | 131 / 409 |
| Claude covered | 142 | 141 |
| Codex covered | 95 | 94 |
| Host no-verdict / remainder | 519 / 564 | 518 / 563 |
| ИТОГО covered / partial / всего | 484 / 428 / 2528 | 482 / 427 / 2524 |

Six columns move by one, and one-by-one is exactly the size of a verdict a lane has just moved. A lane
reading its own deltas sees its work; only the row TOTAL says a row left the file.

**The rule**: escape every pipe inside a cell as `\|`, and read the row TOTAL — not the deltas — after
every ledger commit. **The correction to carry forward**: do not repeat "silently" about this one. The
guard speaks; it speaks on stderr.

## A REPAIR of a citation can CREATE a finding — the identifier check reads the first backticked token, not the right one (measured 2026-09-08, mechanism 2026-09-09)

`findDriftedIdentifierCitations` (`scripts/check-ledger-citations.ts`) charges a citation with the
identifier its own sentence attaches to it, and `attachedIdentifier` defines "attaches" as *the first
backticked token after the anchor, before a sentence break*. That is right for the ordinary cell and
wrong for the shape a repair naturally takes, which is **two anchors and two identifiers in one
sentence**.

W9-bn wrote a two-anchor repair in the natural order — identifier, path, sibling identifier, sibling
line — and the gate fired at once, against a correction that was entirely right. Re-measured 2026-09-09
by calling the exported function on the two forms:

| Text after the anchor | `attachedIdentifier` returns |
| --- | --- |
| the flowing form: `…`, `` `isForkAgentName` `` `` `:437` `` | **`isForkAgentName`** — the FAR identifier, 26 lines outside the ±5 window |
| the parenthesised form: `…` `` (`FORK_AGENT_NAME`) `` and `` `:437` `` `` (`isForkAgentName`) `` | **`FORK_AGENT_NAME`** — the near one, correct |

So the surviving form is **one citation, one parenthesised identifier**, repeated: anchor, `(NAME)`,
sibling anchor, `(ITS NAME)`. It reads slightly worse and it is the only form a containment check can
parse.

This is the same family as the rule in AGENTS.md §"Upstream Docs Are Contracts" that a correction
spelling out the dead anchor re-creates the finding it repairs (P6.890, measured three times in one
sweep). Both come from the same limitation: **a guard reading prose beside a citation cannot tell which
citation the prose is about.** Put the pairing in the punctuation, where a machine can see it.

## A citation sweep RACES the shared tree, and one session's sweep lost that race nine times (measured 2026-09-08)

W9-bn re-read 36 far anchors across six batches. Between its first commit and its last — about forty
minutes — sibling lanes committed into the very files it was citing. Re-read from the index 2026-09-09:

| File | at the sweep's first commit | at its last |
| --- | ---: | ---: |
| `packages/server-core/src/sessions/SessionManager.ts` | 34 287 | 34 297 |
| `packages/shared/src/agent/claude-agent.ts` | 10 731 | 10 767 |

Anchors derived twenty minutes earlier were already wrong when the gate ran, and **the gate reported
them as NEW findings against the lane's own repair** — which reads exactly like the repair having been
done badly, in a batch where everything else was a real defect. It happened nine times in the one
session, four of them in a single batch, on citations that had nothing to do with the batch.

It is §"A working-tree reading during a wave measures the neighbours' uncommitted files" with the clock
added: the reading was correct when it was taken, and correctness expired. The mitigation is cheap and
belongs at the end rather than at the start of the batch:

- **Re-derive every anchor from the INDEX (`git show HEAD:<path>`) immediately before the commit**, never
  from the working tree and never from when the batch was planned.
- **The cited file's own line count is the tell.** Record it when you derive an anchor; if it has moved
  when you go to commit, every anchor into that file is suspect.

## A `-c` probe with no file argument reads stdin — it hangs a runner, and its output is one line either way (measured 2026-09-08, re-measured 2026-09-09)

Two defects in one shape, and the quiet one is worse than the hang.

**The hang.** `grep -c <pattern>` with no file argument reads standard input. A runner that spawns it
with an ordinary pipe and then waits gets a process that never returns — W9-bn's first probe runner hung
for an hour on exactly these. Re-measured 2026-09-09 on this rig's `grep` (ugrep 7.8.4): still running
after 3 s with stdin an unwritten pipe; exits 1 and prints `0` with `stdin=DEVNULL`. Every probe runner
needs `stdin=DEVNULL`, unconditionally — it costs nothing on a probe that names a file.

**The quiet one.** A runner that measures a probe by counting OUTPUT LINES cannot read a `-c` probe at
all. `grep -ac <pat> <file>` prints one line, and so does `grep -c <pat>` with no file: the line-count
answer is **1** in both cases, and never the number the probe was asking for. Four of that sweep's 45
"stated 0, now non-zero" refutations were this artefact rather than a refutation — a runner reporting
`1` against a declaration of `0`, which looks precisely like a stale count.

It is P6.920's own finding arriving from the instrument side: **a bare number has no unit**, and a
runner that assumes one unit for every probe manufactures disagreements in whichever direction its
assumption is wrong. Parse the number a `-c` prints; count lines only for a probe that lists lines.

## A bare `.isolated.ts` path is a FILTER, and beside one matching filter the drop is silent (measured 2026-09-10)

W9-ce handed `bun test` fourteen paths and read `Ran 81 tests across 13 files` — one file short, with
nothing in the output naming the missing one. W9-cf re-measured the mechanism at HEAD on three files in
`packages/shared/src/workspaces/__tests__/`, bun 1.3.14:

| Command | Output | Exit |
| --- | --- | ---: |
| `bun test <bare paths-env.isolated.ts>` | `The following filters did not match any test files` + the two notes + the remedy | 1 |
| `bun test <bare A.isolated.ts> <bare B.isolated.ts>` | the same block, both filters listed | 1 |
| `bun test ./paths-env.isolated.ts` | `Ran 2 tests across 1 file.` | 0 |
| `bun test <bare lifecycle.test.ts> <bare paths-env.isolated.ts>` | `Ran 35 tests across 1 file.` — the isolated file unnamed | 0 |
| `bun test <bare lifecycle.test.ts> zzz-no-such-filter-zzz` | `Ran 35 tests across 1 file.` — byte-identical | 0 |
| `bun test ./A.isolated.ts <bare B.isolated.ts>` | `Ran 3 tests across 2 files.` — the bare one RAN | 0 |
| `bun test ./A.isolated.ts <bare nonexistent>` | `Ran 2 tests across 1 file.` | 0 |

Three separate facts, and only the first is the one people know:

1. **A filter only matches what bun already counts as a test file.** bun says so itself — *"Tests need
   `.test`, `_test_`, `.spec` or `_spec_` in the filename"*. So a bare `.test.ts` path works, but by
   accident: it is a substring filter that happens to match itself. A bare `.isolated.ts` path matches
   nothing, because nothing in this tree is named that way and a test file.
2. **The loudness depends on the OTHER arguments, not on the broken one.** If every filter fails, bun
   prints the block, lists them, and exits 1 — it even prints the fix, `bun test ./<path>`. If ONE
   filter matches, the failures are not mentioned at all and the run is green. A dropped real file and
   a typo'd nonsense string produce the same output, which is why row 4 and row 5 above are identical.
3. **`./` is a mode switch for the whole argument list, not a per-argument prefix.** With one
   `./`-prefixed path present, the bare siblings are resolved as paths and DO run (row 6) — and a
   nonexistent path reverts to the older trap of being skipped in silence (row 7).

`package.json`'s `test:isolated` survives only because `find .` emits `./`-prefixed paths; written with
`find packages apps` it would have been running nothing, greenly, since the day it was added.

This sits one step past AGENTS.md's existing *"a path that does not exist runs the rest and says
nothing"*: there the path was absent, here it is present and silently reinterpreted as something else.
The instrument is the same one as for every member of that family — **read the FILE COUNT of every run**
— and the prevention is one character: `./` on every path handed to `bun test`.

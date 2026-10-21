# Known-failing tests on `fix/renderer`

> **CORRECTION 2026-07-31, and it is the important line in this file.**
> Every row below was verified honestly against the rule two paragraphs down —
> reproduced on a clean worktree at the executor's own base commit. Nobody was
> careless. But nobody measured against **master**, and master's last pipeline
> (118808921) is **GREEN**, while this branch was green through 2026-07-26 and
> red from 2026-07-27 onward. So "known-failing" has been meaning
> *known-failing on this branch* — and that is not the same thing as
> pre-existing. **Every row here is a bug this branch introduced.** The rule
> below is not wrong; it is insufficient on a long-lived branch, because the
> per-base check cannot see an accumulation. Fixing these is a release gate,
> not an option: a row leaves this file by being FIXED, never by being
> re-verified.

Kept because executors keep re-deriving it, and because a wrong attribution goes
both ways: calling your own breakage "pre-existing" ships a bug, and calling a
pre-existing failure yours wastes a run chasing it.

**The rule stays what it was:** a failure is pre-existing only when you have
reproduced it on a clean worktree at *your* base commit. Use
`git worktree add`, never `git stash` — a stash of a file you are editing is one
of the standing prohibitions in this series. This list tells you what to expect;
it does not excuse you from checking.

Last extended 2026-07-31 by the planner from the mode-table executor's gate
(base `6440a1af`, verified in a temporary worktree, removed after use); before
that 2026-07-29 by the S5 executor at base `57f064b5`, rows above verified by
the S4 executor at `6619ddd9`.

## The shape: an unnamed lifecycle-hook timeout (2026-08-28, corrected 2026-09-01)

Two suites still show it, so record the **shape** rather than accumulating one entry per suite:
`pi-agent-pretool-hook-decision.test.ts` and `mode-block-reason.test.ts`. The third,
`context-usage-after-switch.test.ts`, **left this file by being fixed** — see the entry below, and read
it before diagnosing either of the two that remain, because the reason it was here was not the reason
this heading gave.

**It reports as `(fail) (unnamed)`** — no test name, no assertion, nothing pointing at a cause. That is
the misattribution shape: the natural first suspicion is your own diff.

Before attributing an unnamed hook timeout to yourself: **run the suite alone.** If it passes, you are
in this family. **If it FAILS alone, you are not** — run it alone before believing any story about
contention, because one of the three suites here was diagnosed as a contention failure for four days
and was failing alone the whole time.

### `beforeEach/afterEach` in that line is BUN'S WORDING, not the file's (measured 2026-09-01, P3.180)

This entry used to say `context-usage-after-switch.test.ts` "loses a `beforeEach`/`afterEach`". **That
suite contains no `beforeEach` and no `afterEach`** — it has a `beforeAll` and an `afterAll` and
nothing else. The wording came from bun, which prints

    (fail) (unnamed) [5004.62ms]
      ^ a beforeEach/afterEach hook timed out for this test.

for a `beforeAll` **and** for an `afterAll`. Measured on bun 1.3.14 with two throwaway files whose only
hook was a 6 s `beforeAll` and a 6 s `afterAll` respectively, plus a third file of the same shape whose
hook finished in 50 ms as the positive control: both timed out at ~5 002 ms with that exact sentence,
and the control passed (2 pass / 2 fail across 3 files).

Worth correcting rather than leaving, because it sent a reader looking for the wrong thing: grep the
suite for the hook this register named and you find nothing, and conclude the entry is stale. Read
every `(fail) (unnamed)` as *some* lifecycle hook, never as `beforeEach` specifically.

## Removed 2026-09-01 by being FIXED: `context-usage-after-switch.test.ts` (P3.180)

**It was never a contention failure, and it was never 5/0 alone for long.** Registered 2026-08-28 as
"5/0 alone; loses a hook when sharing a process with three others, reproduced twice". Profiled step by
step on 2026-09-01 at load 7.8, the hook is one thing and one thing only:

| Step of the `beforeAll` | Cost |
| --- | --- |
| `await import('../SessionManager.ts')` — 27 286 lines plus its graph | **44 668 ms** |
| `await import('./test-session-manager.ts')` | 52 ms |
| `await import('@nessy-agent/shared/config/storage')` | 0 ms |
| read + write the frozen config dir | 0 ms |

Against bun 1.3.14's default hook budget of **5 000 ms** — a **9×** overrun with nothing else in it.

**Why it masqueraded as contention.** bun's budget is a TIMER, so it can only fire when the transpile
lets the loop breathe. A 1 s heartbeat armed beside that import ticked **13 times in 44.7 s**, with one
gap of **31 512 ms**. Whether a run goes red is therefore decided by where those few yields land
relative to the 5 s mark — not by how busy the box is. The measurements that make this stick, all under
`scripts/bun-test-lock.ts` on the same day:

| Condition | Load (1 min) | Result |
| --- | --- | --- |
| alone, 04:44 | 7.06 | 5 pass / 0 fail, 52.54 s |
| + 3 server-core siblings in one process | 9.40 | 131 pass / 0 fail, 1.66 s |
| whole `packages/server-core/src/sessions/` tree, 87 files | 9.98 | no failure in this suite, 256 s |
| + the same 3 siblings, under 24 manufactured CPU spinners | 41 → 118 | 131 pass / 0 fail, **81.64 s** |
| alone, 05:2x — **three runs for three** | 7.9 / 8.6 / 8.0 | `(fail) (unnamed)` at 44 591 ms, 5 242 ms, 30 921 ms |

Rows two and four are a control pair: byte-identical work, a **49×** wall-time spread, the same
131 pass / 0 fail. And the last row is the one that ends the contention story — **it fails ALONE, three
times for three, at a LOWER load than the batch that passed**, with `SessionManager.ts` hashed before
and after each run to prove no sibling lane edited it mid-flight.

**Fix:** an explicit budget on that one hook — `MODULE_GRAPH_HOOK_BUDGET_MS = 120_000`, set against the
measured floor (44.7 s at load 7.8, 57.2 s at load 82) rather than against zero, because a knob set near
the resting state manufactures its own failures. Three runs alone after the fix: 5 pass / 0 fail each.
The three-suite gate went from 143 pass / 1 fail to **148 pass / 0 fail**.

**What to carry to the two suites still listed above:** their diagnosis — "a suite budget below its own
resting runtime under contention" — is the right shape, but *under contention* was doing no work in
this one's case and may be doing none in theirs. Both report NAMED tests measuring 5.0–7.9 s against a
5 000 ms budget, which is the same overrun one level down. Raising a budget is the register's own
prescribed remedy for this family; what was missing was measuring the floor first.

## Registered and FIXED the same day: three more module-graph budgets (2026-09-07, W7-ac / P6.630, W7-ae / P6.646)

The first two were **observed by lane W7-l2 on 2026-09-06 and were in no register**, and the third by
W8-g on 2026-09-07 — which is the failure this file exists to prevent: a lane meeting any of them has to
re-derive the whole diagnosis. The count in this heading went two → three the day it was written; read
the table, never the number.

| Suite | How it presents | Measured alone |
| --- | --- | --- |
| `packages/server-core/src/sessions/__tests__/monitor-command-gate.test.ts` | `0 pass / 1 fail`, `(unnamed)`, "a beforeEach/afterEach hook timed out" — the `beforeAll` that imports `SessionManager.ts`, with all 33 tests unrun | W7-l2: 32 tests with `--timeout 300000`, the eight filtered P6.191 rows in **1.365 s**. W7-ac: **481.96 s** 33 pass / 0 fail at load 14.75 on first touch of the graph; **1.35 s** minutes later at load 11.69; the hook's own import probed at **39 ms** warm |
| `packages/shared/src/config/__tests__/workflow-settings.test.ts` | a NAMED failure — `"loads a config.json that sets workflow.disableWorkflows"`, whose `Bun.spawnSync` child imports `storage.ts` and its graph | W7-l2: fails at load 15.5, passes in **17.46 s** with `--timeout 120000`. W7-ac: **77.84 s** for all 11 tests at load 10.07, **99.46 s** for that ONE case filtered at load 10.00 |
| `packages/pi-agent-server/src/__tests__/harness-contract/pi-harness-baseline.test.ts` | a NAMED failure — `"executes golden event and prompt producers with ordered source contracts"` times out at the 5 000 ms default while its 22 siblings pass; the graph is the Pi runtime tool surface `check:surface` measures at **336 s of imports** and declines to pull into a typecheck | W8-g: that one test filtered, **1 pass / 186 expect() calls in 542.83 s** at load 9.08. W7-ae: the WHOLE file **23 pass / 0 fail** in **75.66 s** at load 11.99, **341.01 s** at load 13.82 and **1.32 s** at load 13.23 — a **258x** spread on byte-identical work across three loads that differ by 15 % — with every test BODY in milliseconds (junit reporter; slowest three 152 ms, 100 ms, and **65 ms** for the golden producer itself) |
| `packages/shared/src/plugins/__tests__/format-adapters.test.ts` | W8-b met it as `84.72 s` with **three unrelated fails** at load ~12, then `1.40 s` with none minutes later on the same tree — a 60x spread | W7-ag 2026-09-07: **166 pass / 0 fail** four times for four — **101.84 s** at load 9.08, **64.42 s** at load 7.11, **58.58 s** at load 7.77, and **4.46 s** at load **12.01** after the budget landed. Separating control: `-t` matching NOTHING, so zero cases run, still **35.06 s** at load 9.87 |
| `apps/electron/src/renderer/pages/__tests__/plugin-info-diagnostics.test.tsx` — the family's first `apps/electron` RENDERER member | `0 pass / 1 fail`, `(unnamed)`, "a beforeEach/afterEach hook timed out" — the `beforeAll` that dynamically imports `PluginInfoPage`, with all 6 tests unrun | W8-a: the file at HEAD verbatim fails, **92.8 s** against a 34.6 s control at load 12.7. W7-ag 2026-09-07: hook profiled at 2 ms i18next + **54 591 ms** for `import('../PluginInfoPage')` + 0 ms; after the budget **6 pass / 0 fail** in **354.41 s** at load **7.59**, 334.37 s at load 10.67, 280.80 s at load 12.10 and **127.25 s** at load **14.97**; the same bytes PRE-BUDGET, **6 pass / 0 fail** in 248.05 s at load 7.85 and 91.10 s at load 10.25 |
| `apps/electron/src/renderer/components/ui/__tests__/slash-command-menu.test.tsx` — the composer's offered-vs-dispatchable tripwire, and the SECOND renderer member | `0 pass / 1 fail`, `(unnamed)`, "a beforeEach/afterEach hook timed out" — the `beforeAll` that dynamically imports `../slash-command-menu` and six shared subpaths, with all 12 tests unrun | W8-tail2 2026-09-07: 177.8 s and 122.1 s hook timeouts at load 13–14 against 12 pass / 0 fail in 100.17 s at load 12. W8-tail3 2026-09-07: the file at HEAD `(fail) (unnamed)` with the hook abandoned at **137.4 s** inside a 213.26 s run at load 10.15 (0.94 s user / 0.59 s sys, **under 1 %** CPU); zero-case control **41.83 s** at load 12.14 (0.51 / 0.30, **1 %**); after the budget **12 pass / 0 fail** in 81.59 s at load 11.55, 48.21 s at load 10.93 and **32.88 s at load 17.40** |

**Fixed, because the register's own prescribed remedy for this family is the budget and the floor was
measured first:** `MODULE_GRAPH_HOOK_BUDGET_MS = 600_000` on the one hook (the shape its two siblings in
that same directory already use), and `setDefaultTimeout(300_000)` in the config suite, and `MODULE_GRAPH_BUDGET_MS = 900_000`
via `setDefaultTimeout` in the harness-contract suite (its floor is the 542.83 s run total, not the 65 ms
test body — see the next bullet). Each carries the
readings above at the site, so the next reader does not have to find this file to know why the number is
what it is.

**THE THREE CONSTANTS NOW LIVE IN ONE MODULE (P6.638, 2026-09-08):
`packages/shared/src/testing/module-graph-budgets.ts`, imported as
`@nessy-agent/shared/testing/module-graph-budgets`.** Seven suites had grown seven hand-written numbers
— 120 000, 120 000, 600 000, 600 000, 600 000, 900 000, 300 000 — and this file records that copying a
neighbour's constant manufactured a red once; a seventh suite would have rediscovered the same thing a
seventh time. Three exports rather than one, because the family has three budget SHAPES and the name is
the only thing at a call site that says which cost is being budgeted:
`MODULE_GRAPH_HOOK_BUDGET_MS` (the third argument of the hook that pays the import),
`MODULE_GRAPH_BUDGET_MS` (`setDefaultTimeout`, when the cost is spread across the file) and
`MODULE_GRAPH_CASE_BUDGET_MS` (`setDefaultTimeout`, when the per-CASE work is what runs long).

Deliberately NOT a repo-wide `[test] timeout` in `bunfig.toml` (controller decision 2026-09-07): that
would raise the budget for every suite in the repo, hiding a genuine hang everywhere to fix seven files.

**The module carries the SIZING RULE and the ZERO-CASE-CONTROL RECIPE, not just the numbers** — size
against the largest observed run TOTAL, never a warm reading and never a per-case floor; price the graph
with `bun test <file> -t '<matches nothing>'` first and read `user`/`sys` beside the wall time, because
under ~2 % cpu is I/O and not contention. Each suite's own measured readings stay at its own site; the
rule that turns a reading into a number lives in the module. **Add a caller by importing it, and if a
measured floor does not fit one of the three, declare a local constant WITH the reading rather than
rounding up into one of these.**

**Three things worth carrying, all of which would have produced a wrong budget:**

- **Copying the sibling constant would have manufactured a red.** `context-usage-after-switch.test.ts`
  and `cold-session-branching.test.ts` next door both use `120_000`, set against a 44.7 s floor.
  `monitor-command-gate.test.ts` has measured **481.96 s** for the whole file — four times that
  constant — because it also imports `@nessy-agent/shared/agent` at the top level before the hook runs
  at all. The right number is this file's own measurement, never the neighbour's.
- **The FILTERED run was SLOWER than the full one**, in both suites: 99.46 s for one case versus 77.84 s
  for eleven, and 481.96 s versus 1.35 s for the identical 33. So a per-test cost read off a filtered
  run is not a per-test cost — it is the module graph, and the spread on byte-identical work here is
  **~350x**. Anyone bisecting a budget by filtering will read the graph twice and call it the test.
- **The test the failure NAMES is not the test the budget is for** (W7-ae, `pi-harness-baseline.test.ts`).
  Under the junit reporter every one of that file's 23 bodies measures in milliseconds — 65 ms for the very
  case that times out at 5 000 ms — while the file's own run total swings 75.66 s → 341.01 s on byte-identical
  work, over three loads spanning 11.99 to 13.82 — so contention does not explain the spread and the warm
  module cache does. bun's budget is a TIMER, so the
  seconds belong to the import graph blocking the loop and WHICH test is holding the window when it fires is
  an accident. Budgeting only the named test would have left the other 22
  exposed to the identical mechanism, and would have been sized against 65 ms. The budget is the FILE's, and
  it is sized against the largest observed run total.

**~~Neither has ever failed alone, at any load, so by AGENTS' two-causes rule both are class (c),
starvation.~~ RELABELLED 2026-09-07 (`P6.677`, W8-td) — the evidence behind that sentence cannot
distinguish starvation from the timer lottery, and a direct measurement says lottery for all three.**
The budgets are UNCHANGED: what moves is the name, not the number.

**The reading, one zero-case control per suite** (`bun test <file> -t 'zzz-no-such-case-W8td'` — zero
cases executed, so it prices the module graph and nothing else), each run twice, sequentially, alone,
`user`/`sys` from zsh's `time`:

| Suite | run 1 | run 2 (repeat) | cpu of wall | verdict |
| --- | --- | --- | --- | --- |
| `monitor-command-gate.test.ts` | **275.17 s** (1.65 user / 0.89 sys, **0.9 %**), load 10.23 | **1.51 s** (0.76 / 0.50, **80 %**), load 8.24 | 0.9 % cold | **lottery** — 175x on byte-identical work |
| `workflow-settings.test.ts` | **72.01 s** (0.63 / 0.37, **1.3 %**), load 8.75 | **0.49 s** (0.37 / 0.24, **118 %**), load 8.24 | 1.3 % cold | **lottery** — 146x |
| `pi-harness-baseline.test.ts` | **2.62 s** (1.15 / 0.60, **65 %**), load 8.48 | **26.49 s** (1.25 / 0.66, **7.2 %**), load 8.24 | 7.2 % on the SLOW arm | **lottery** — 10x, and the SLOW run came at the LOWER load |

**Three things this settles, and the third is why "starvation" was the wrong name.**

1. **Total CPU is invariant across a 100x+ swing in wall time.** Every suite spends 1.0–2.5 s of CPU
   whatever the wall clock does. A starved process needing 2.5 s of CPU cannot take 275 s to get it on
   an 8-CPU box at load 10 — that is ~1.25x oversubscription, not 100x. The wall is spent blocked, not
   descheduled.
2. **The third suite ran SLOWER on the repeat, at a LOWER load** — 2.62 s then 26.49 s as the load fell
   from 8.48 to 8.24. So the direction is not even monotonic in load, which is the same
   backwards-against-load signature `P6.652` measured on the renderer member (354.41 s at load 7.59
   against 127.25 s at load 14.97). Whichever suite's pages the fleet happens to have evicted is what
   decides the number.
3. **"Never failed alone, at any load" is a statement about what was observed, not about a mechanism**,
   and `P6.652` produced the same-bytes green/red pair that shows why: bun's budget is a TIMER on the
   event loop, so redness is decided by where a yield lands during an I/O-bound import, not by how busy
   the box is. Starvation would require a low-load control that is fast **and CPU-bound**; every cold
   arm above is slow and CPU-IDLE, and every fast arm is a warm cache.

**What does NOT change:** the budgets (`MODULE_GRAPH_HOOK_BUDGET_MS = 600_000`,
`setDefaultTimeout(300_000)`, `MODULE_GRAPH_BUDGET_MS = 900_000`) all stand — the remedy for an
I/O-bound graph is the same as the remedy this family was already given, and each is sized against its
own largest observed run total. What changes is what a reader concludes on meeting one: **do not go
looking for the process that stole the CPU. Nothing did.** Price the graph with the zero-case control,
read `user`/`sys` beside the wall time, and treat any reading taken straight after a typecheck, a
tree-wide grep or a previous run of the same file as the WARM floor rather than the floor.

**A fourth suite, and the one whose cost is measurable WITHOUT running a single test** (W7-ag,
`P6.653`, 2026-09-07). `format-adapters.test.ts` was given `MODULE_GRAPH_CASE_BUDGET_MS = 300_000` via
`setDefaultTimeout`, sized against its largest observed run total (101.84 s) exactly as the bullet above
prescribes. Two things it adds to the family:

- **The control is cheaper than anyone had made it.** `bun test <file> -t '<matches nothing>'` executes
  ZERO cases and still costs **35.06 s** of the file's 58.58 s. That is the module graph priced directly,
  with no filtered-run confound and no bisecting — and it turns "is this file's cost its graph or its
  tests?" into one command. The remaining ~23 s is 166 cases of real temp-directory work, ~140 ms each,
  so a budget sized off a per-case reading would have been ~1 s and would have manufactured the very red
  it exists to prevent.
- **The fastest run of five came at the HIGHEST load** — 4.46 s at load 12.01 against 101.84 s at load
  9.08, a 23x spread on byte-identical work. Same conclusion as `pi-harness-baseline.test.ts`'s 258x:
  load does not explain these numbers, the warm module cache does, and a lane that "reproduces" a slow
  reading by running it twice has measured the cache, not the change.

It has never failed alone at any load here either, so it is class (c) with the separating control run.

**A fifth suite, and the one that proves the red is a LOTTERY and not a state** (W7-ag, `P6.652`,
2026-09-07). `plugin-info-diagnostics.test.tsx` was given `MODULE_GRAPH_HOOK_BUDGET_MS = 600_000` on its
one `beforeAll`, sized against the largest observed run total (354.41 s). Three things it adds:

- **ONE GREEN RUN OF THE PRE-BUDGET BYTES DOES NOT REFUTE THE ROW.** Those bytes — byte-restored and
  sha256-verified back to baseline after each arm — ran **6 pass / 0 fail** twice, in **91.10 s at load
  10.25** and again, deliberately at low load, in **248.05 s at load 7.85**, on the same box and the same
  day as two independent observations of the identical bytes at `0 pass / 1 fail` (W8-a's, and this lane's
  own in its first session). So a lane that runs one of these files once, sees
  green and deletes the budget has measured the lottery, not the file. bun's budget is a TIMER that only
  fires when the transpile lets the loop breathe: the same 5 000 ms default was met once and missed twice
  on bytes that never changed. **This is the first same-bytes green/red pair recorded for the family**,
  and it is what makes "never failed alone at any load" a weaker statement than it reads.
- **The `-t '<matches nothing>'` control SPLITS the cost, it does not just total it.** Here it costs
  **53.87 s at load 10.57** with zero cases run — and that is this file's OWN top-level graph (react,
  react-dom/server, i18next), which is paid *before any hook timer exists* and is therefore budgetable by
  nothing at all. The hook's dynamic import of the page graph is a second, separate payment of the same
  order (54 591 ms profiled). A file can pay the graph twice in two phases, and only the second phase can
  be given a budget.
- **The wall time is not compute, and STARVATION IS REFUTED rather than merely unproven.** Six runs of the
  same bytes place the **slowest at the LOWEST load and the fastest at the HIGHEST** — 354.41 s at load 7.59
  against 127.25 s at load 14.97, a 2.8x spread running *backwards* against load — and every one burned
  under 1 % CPU (`2.00 s user / 1.27 s system` for the 334 s run). The sibling lanes are not taking cores
  away from it. **This is the point at which the family's standing label stops fitting**: AGENTS' two-causes
  rule reads *"passes alone at low load → starvation, register it"*, and this file passes alone at low load
  **and is slowest there**, so the rule's dichotomy hands out the wrong name. The mechanism is bun's budget
  being a TIMER on the event loop, which a blocking transpile does not advance — 54 s of wall clock can cost
  0 ms of budget until a yield lands past the 5 s mark. The three earlier members of this table were filed
  as class (c) on the strength of *"never failed alone"*; that evidence cannot distinguish starvation from
  the timer lottery, and this row is the first to separate them.
- **The cost is I/O, not transpile CPU — and one command flips the file between the two.** A seventh run,
  taken immediately after `bun run typecheck:electron` had walked these same sources into the page cache,
  finished in **2.19 s at load 10.36 — pegging 90 % of a core**, against under 2 % for every cold run. That
  is a **162x** spread on byte-identical work, and it says the slow runs are waiting on reads rather than
  computing. Two consequences: a lane that "reproduces" one of these numbers by running it twice has measured
  the cache; and a gate that typechecks or greps the tree before running the suite will see a completely
  different file from one that runs it first, which is a plausible reason the same bytes went red for two
  lanes and green for this one.

The six case bodies were deliberately left on bun's default: all six passed inside every run above, so the
seconds are the graph and not the cases. Not entered as a red — after the budget it is green — this row
exists so the next lane meeting a renderer-suite hook timeout does not re-derive the diagnosis.

**A sixth suite, and the one that shows what the unnamed failure COSTS** (W8-tail3, `P6.730`,
2026-09-07). `slash-command-menu.test.tsx` — the composer menu's offered-vs-dispatchable tripwire —
was given `MODULE_GRAPH_HOOK_BUDGET_MS = 600_000` on its one `beforeAll`, sized against its own
measured hook ceiling of 137.4 s, and its imports were wrapped in a `loadStep` helper. Three things
it adds to the family:

- **The price of `(unnamed)` is now countable: three rows shipped inert behind this one message.**
  W8-tail2 found `/mcp` and `/diff` reaching the composer menu with no dispatch entry at all, and
  `/hooks` unasserted — exactly what this file exists to catch — because the tripwire had been failing
  as `(fail) (unnamed)` with no test name and no import name for as long as anyone had looked. The
  register's standing advice was to size the budget; this member says the NAMING is half the remedy,
  because an unnamed red is an unactionable red, and an unactionable red gets skipped rather than fixed.
- **A heartbeat names the import, and a timeout cannot.** `loadStep(name, () => import(name))` starts a
  30 s `setInterval` (unref'd) that writes `[slash-command-menu] still importing <name> after <n>s` to
  stderr and is cleared on resolution. Because bun abandons a timed-out hook without unwinding it, the
  heartbeat keeps ticking and the last stderr lines name the pending import. It fired for real inside a
  GREEN run — `still importing ../slash-command-menu after 43s`, 12 pass / 0 fail in 48.21 s — which is
  both the positive control for the mechanism and a direct reading of the one import that dominates the
  hook. `console.log` would not do: only the pending step matters, and only after the fact.
- **The backwards-against-load signature reproduces on a THIRD member.** 81.59 s at load 11.55, 48.21 s
  at load 10.93, **32.88 s at load 17.40** — the fastest run at the highest load, on byte-identical work,
  every one of them burning 2–5 % of wall in CPU. The zero-case control puts ~42 s of the file's cost in
  its own top-level graph, before the hook's timer exists, so this file also pays the graph in two phases
  and only the second is budgetable.

Its 12 case bodies are left on bun's default: all 12 pass inside every run above, so the seconds are the
graph and not the cases. Not entered as a red — after the budget it is green.

## Two more renderer members of the module-graph family, and NEITHER was in this file (2026-09-08, W9-as / P6.859)

Both were observed by lane W9-ap on 2026-09-08 inside a fourteen-file batch and recorded nowhere, which
is the failure this file exists to prevent. Both are the family above — a `beforeAll` paying a DYNAMIC
import — and in both the import cannot be lifted to the top of the file the way AGENTS.md's rule 24
prescribes, because `mock.module` stubs (A) and the same hoisting problem (B) require it to stay dynamic.
The budget is the only knob, and both are now on the shared
`MODULE_GRAPH_HOOK_BUDGET_MS` (`packages/shared/src/testing/module-graph-budgets.ts`) rather than a
hand-written number.

| Suite | How it presents | Measured alone at HEAD `cf1613619` |
| --- | --- | --- |
| `apps/electron/src/renderer/playground/__tests__/capability-detail-registry.test.ts` | `0 pass / 1 fail`, `(unnamed)`, "a beforeEach/afterEach hook timed out" — the `beforeAll` that dynamically imports `../registry/capability-detail`, whose template pulls `@nessy-agent/ui`'s markdown overlay, react-pdf and pdfjs; all 8 tests unrun | Hook abandoned at **100 799.27 ms** inside a **144.08 s** run at load 9.23, 1.32 s user / 0.92 s sys (**1.6 % of wall**). Zero-case control **34.20 s, 0 cases executed**, 0.65 / 0.37 at load 8.72 (2.9 %). Minutes later, byte-identical, **8 pass / 0 fail in 1.041 s** at the HIGHER load 12.89 at 134 % cpu — a **138x** spread decided by the page cache |
| `apps/electron/src/renderer/pages/__tests__/plugin-info-signin.test.tsx` | green whenever it runs alone; it fails only inside a multi-file batch, and its `beforeAll` carried NO third argument at all, i.e. bun's 5 000 ms default | **3 pass / 0 fail** in 1.500 s, 1.373 s and 1.352 s at load 13.3; zero-case control **547 ms, 0 cases executed**; every reading ABOVE 100 % cpu (1.30 user + 0.82 sys against 1.40 s wall) — cpu-bound and warm, so none of these is the floor. The floor is its directory-sibling's: W7-ag profiled the identical `import('../PluginInfoPage')` at **54 591 ms**, **11x** the default this hook was running on |

**The row's premise was wrong in one place, and it matters for the next reader.** W9-ap recorded
`capability-detail-registry`'s hook as running "against a 5 000 ms budget". It was **60 000 ms**, and has
been since the file was created (`b1571ad0a`) — so the hook did not merely exceed the default, it exceeded
an explicit budget twelve times the default by another **1.7x**. A budget that is already explicit is the
harder case, because it looks decided.

**`plugin-info-signin` is the cheap end of the family and is registered anyway**, with its solo readings
recorded as NOT the floor. The register's own `paths-security-env.isolated.ts` entry is the opposite
verdict on a superficially similar file — 43x above its measured floor, deliberately unchanged — and the
difference is which floor applies: `paths-security-env` was measured against ITS OWN graph, while this
hook pays an import its sibling has already been measured paying for 54.6 s. Do not read the 1.4 s
readings as "the budget was fine".

**Neither is entered as a red:** after the budget both are green.

## `mode-block-reason.test.ts` — one case times out under batch load (2026-08-28)

`"Bash stays with its own rejection family…"` times out at 5000 ms while measuring **5.4–6.8 s** under
batch load; alone it passes 12/0. Reproduced **with the finding lane's own file removed from the
batch**, so it is pre-existing.

Same class and the same file under test as the registered `pi-agent-pretool-hook-decision` row:
`mode-manager.ts`, a suite budget below its own resting runtime under contention. Every lane touching
the permission floor sees red it did not cause.


## `pi-agent-pretool-hook-decision.test.ts` — 15 of 47 time out on a clean baseline (2026-08-28)

Measured by the P3.76 lane on an untouched tree: **15 failures of 47, every one
`timed out after 5000ms`, with the tests themselves measuring 5.0–7.9 s.** So the suite's own
budget sits below its resting runtime — the narrowing-knob trap, in a test file.

**Why it matters more than an ordinary flake:** this suite covers `mode-manager.ts`, which is the
permission floor. Every lane that touches that file sees 15 red tests it did not cause, and the
honest reactions — investigate, or assume it was you — both cost real time. It manufactures a fake
regression precisely where a real one would matter most.

Check here before attributing it to yourself. Raise the timeout or split the suite; do not
"fix" the code it points at.


## Rows removed 2026-08-25 by being fixed (runtime-parity-closure P2.174)

Both `server-core` rows recorded 2026-08-22 at P0.1 are gone. They were the SAME
defect in two hand-built session stubs, and the whole of the "two failures whose
pair rotates" reported at P2.174. Measured in a detached worktree at `c257eec7f`
carrying only these two edits, with `scripts/bun-test-lock.ts` held:
**2091 pass / 0 fail on three consecutive runs of `bun test packages/server-core/`.**

| Was | Cause | Verdict |
| :-- | :-- | :-- |
| `monitor-ws-approval` — `the command source is not double-gated here (Pi) > a command watch raises no approval of its own` | Its hand-built stub omitted `backgroundShellCommands`, a REQUIRED field of `ManagedSession` (`SessionManager.ts:1754`) initialised for every production session (`:1984`). A command watch reaches the process supervisor, whose `notifyChanged` calls `SessionManager`'s `onChanged`, which fires `void this.reconcileEndedBackgroundShells(managed)` — the `void` on an async call turns the stub's TypeError into an UNHANDLED REJECTION rather than a caught error. The `as unknown` cast on the stub is why the compiler could not object. Same omission as the two stubs fixed in `e9e691c2` (row for `5287fd49`); the ten sibling stubs in that directory all carry the field. | Test defect, deterministic, re-broken: with the one line reverted the file gives 12 pass / 1 fail and the directory gives 3 fail then 2 fail on identical source. No assertion weakened, no skip widened. |
| `filesystem-scope-revocation` — `filesystem scope receipts (P6) > revokes one receipt by id and reports false for unknown receipts` | Never its own failure. It passes 2/0 alone and only ever failed as the LANDING SITE of the rejection above — bun charges an unhandled rejection to whichever test is running when it lands, which is why the second member of the "pair" rotated (a third victim, `EVERY detected command is a run-only invocation and NEVER installs` in `pi-harness/formatter-registry.test.ts`, appeared in one run). A probe in the clean worktree attributed six such rejections to a SECOND stub with the identical omission, `__tests__/managed-policy-reread.test.ts:67`, reached through process RECOVERY: it registers `workspace-1:session-1`, and a leftover supervised process under that key — left in the shared durable store because the first stub's TypeError had broken its own drain — is recovered by whichever manager comes later. | Fixed by fixing both stubs. |

**It is not a serialisation problem, so it is not P2.161's.** It reproduces with
the lock held and nothing else running; the shared mutable state is a promise
rejection crossing a test boundary inside ONE process, plus a durable process
record outliving the manager that wrote it — not the module-scope `process.env`
mutation two concurrent `bun test` runs cause.

**The `managed-policy-reread` line is a required field restored, NOT a fix with a
demonstration behind it, and the distinction is the useful part.** Reverting it
again gives 0 TypeErrors and 2091/0 twice, on source identical to a state that
gave 6 TypeErrors and a failure — because bun's file order varies between runs
and the leftover record only exists when `monitor-ws-approval` ran first. So the
first stub is the cause and the second is a latent hazard on an ordering nobody
can summon on demand. Do not read its green as proof of anything.

**Two mis-readings this row cost, both worth writing down.** (1) The old entry's
`12/1` meant *12 pass / 1 fail*; it was read downstream as "fails 12 of 13",
which turned a one-line stub omission into a suite nobody could afford to open.
Write pass/fail counts with the words. (2) A first pass recorded
`WsRpcServer lifecycle > rejects invalid token with 4005` here as a new
load-sensitive intermittent. It is not: `server-lifecycle.test.ts` was being
REWRITTEN by another lane, uncommitted, in the same working tree. It does not
appear at all in the clean worktree. Check `git status` before attributing a
failure on a tree five lanes share — this file's own rule about measuring at a
clean base applies to concurrent lanes, not just to `master`.

**Scope, per this file's own correction above: `master` was NOT measured.** These
two rows leave by being fixed, so that comparison is no longer owed for them; it
remains owed for the rows below.

## feat/TCODE-000, recorded 2026-08-23 (runtime-parity-closure P2.3 fix wave)

**CLOSED 2026-09-04 (W5-j, P3.355). All eighteen are fixed; the counts below
were stale and the diagnosis was wrong in a way worth keeping.** At HEAD
`dd6be7559` the file measured `183 pass / 18 fail`, 201 tests — not the
`110 / 18`, 128 tests this entry carried, which is what happens when a suite
grows for a year with nothing running it. After the fix: **205 pass / 0 fail,
201 → 205 tests, 1 FILE**, at load 15.8. The `-18` came apart into THREE causes,
each with its own separating control, and no assertion was weakened to get
there.

**Cause 1, fifteen of eighteen — stale mode vocabulary, and the file's own
header had already said so.** `mockEffectivePermissionMode` fed
`getPermissionModeDiagnostics`, whose value `runPreToolUseChecks` reads
VERBATIM: the mock replaces the very function that would have folded a legacy
alias. So the pre-2026-07-31 spellings (`safe`, `ask`, `allow-all`) reached the
gate unnormalized, `isInteractiveWritePermissionMode` accepts only
`default`/`acceptEdits`/`auto`, and every one of those tests skipped the branch
it was named for and fell through to `allow`. **Separating control:** migrating
the literals alone (`safe`→`explore`, `ask`→`default`,
`allow-all`→`bypassPermissions`, plus the three doubles keyed on `mode ===
'safe'` where production probes with `'explore'`) took the file from `183/18` to
`198/3` with **no previously-passing test broken** — exactly the fifteen, and
nothing else. Two of the fifteen were the sharpest form: `shouldPromptInAskMode
> MCP mutations > prompts for MCP mutations` and `shouldPromptInAutoMode >
prompts for MCP and API mutations` mocked `shouldAllowToolInMode` on
`mode === 'safe'` while `pre-tool-use.ts` asks it with `'explore'`, so the two
cases named for the MCP-mutation prompt asserted nothing about it. **The union
at the top of the file is now the product's own `PermissionMode`**, so the next
drift is a compile error: planted `'safe'` back into the `beforeEach` and `tsc
-p packages/shared/tsconfig.json` reported
`TS2322: Type '"safe"' is not assignable to type 'PermissionMode'` — file hash
returned to baseline after the restore. **The trap this row named held:** the
six step-6 cases ALSO pass `permissionMode: 'default'` into `createInput`, and
that field is read only by the `[ModeSync]` debug line — `effectivePermissionMode
= diagnostics.permissionMode` at `pre-tool-use.ts:1540`. Fixing them there would
have changed nothing.

**Cause 2, two of eighteen — NOT vocabulary, and the product was right.**
`shouldPromptInAskMode > … auto-allows file write tools when requested by
acceptEdits` and `shouldPromptInAutoMode > auto-allows file write tools` called
those functions directly with `autoAllowFileWrites: true` and NO
`autoAllowWriteRoots`/`cwd`. That is the pre-fix unbounded shape;
`isInsideAutoAllowRoots` now FAILS CLOSED with no roots, in its own words *"a
caller that supplies none gets no auto-approval at all"*, because the old
behaviour auto-approved a write anywhere on disk. The tests were asserting
behaviour deliberately removed. Fixed by driving them the way
`runPreToolUseChecks` drives them (roots built from working directory /
workspace root / plans / data / additional directories, `cwd` beside them), and
**the fail-closed half is now pinned as its own case** rather than lost — plus
the outside-every-root half, and the `auto` twin. The shape the row asked about
— a session whose caller can name no root — prompts, which is the safe
direction.

**Cause 3, one of eighteen — a premise a deliberate commit removed, in a file
nothing ran.** `runPreToolUseChecks > step 2: source blocking > allows a
collision-qualified Source MCP tool from the pinned runtime view` built a
two-record collision and read a live wire name off the SOURCE. `8e27f1a23`
(*"connect a duplicate MCP name once, from the nearest scope"*) ended that
shape: the scoped tier picks one winner, which keeps the BARE name, and shadows
the rest out of the runtime view. Driven directly at HEAD, `toAgentRuntime`
returns `sources: []` and one `mcpServers` entry `mcp:ws:fs` under wire name
`fs`, with `capability.collision.mcp-scope-precedence` naming the winner. **The
commit's own message says it rewrote *"two tests [that] pinned the old
two-survivor shape"* — this was the third, and it was invisible because
`.isolated.ts` is not a filename `bun test` discovers.** Not a product defect;
the subject survives as a case driving the wire name the resolver actually
mints, and the collision's documented outcome is pinned beside it with the
`mcpServers` assertions as the positive control for the emptiness one.

**`master` is still NOT measured** for this file, and per this file's own rule
that comparison remains owed at the close-out gate — but it is now a much
cheaper question: the file is green.

**The seventeen names below are STRUCK — all green at `205 pass / 0 fail`.** They
are kept rather than deleted because the causes above are keyed to them, and
because a reader comparing a run against this file must be able to diff BY NAME,
which is this file's own rule.

| Test (all struck 2026-09-04) | Suite |
| :-- | :-- |
| ~~`EnterWorktree approval floor > is skipped by allow-all, our bypassPermissions`~~ | `pre-tool-use-checks.isolated` |
| ~~`protected-path floor > allows the write in allow-all, unlike the removal circuit breaker`~~ | `pre-tool-use-checks.isolated` |
| ~~`protected-path floor > permits the worktrees carve-out and leaves siblings alone`~~ | `pre-tool-use-checks.isolated` |
| ~~`runPreToolUseChecks > debug callback > calls onDebug when tool is blocked by mode`~~ | `pre-tool-use-checks.isolated` |
| ~~`runPreToolUseChecks > pipeline ordering > permission check runs before source blocking`~~ | `pre-tool-use-checks.isolated` |
| ~~`runPreToolUseChecks > step 1: permission mode check > blocks when shouldAllowToolInMode returns not allowed`~~ | `pre-tool-use-checks.isolated` |
| ~~`runPreToolUseChecks > step 6: ask-mode prompt decision > includes modifiedInput in prompt when transforms changed the input`~~ | `pre-tool-use-checks.isolated` |
| ~~`runPreToolUseChecks > step 6: ask-mode prompt decision > keeps ask-mode Bash prompt on the original command while passing sandboxed input`~~ | `pre-tool-use-checks.isolated` |
| ~~`runPreToolUseChecks > step 6: ask-mode prompt decision > omits modifiedInput in prompt when no transforms applied`~~ | `pre-tool-use-checks.isolated` |
| ~~`runPreToolUseChecks > step 6: ask-mode prompt decision > prompts for Edit in ask mode`~~ | `pre-tool-use-checks.isolated` |
| ~~`runPreToolUseChecks > step 6: ask-mode prompt decision > prompts for bash commands in ask mode`~~ | `pre-tool-use-checks.isolated` |
| ~~`runPreToolUseChecks > step 6: ask-mode prompt decision > prompts for file write tools in ask mode`~~ | `pre-tool-use-checks.isolated` |
| ~~`shouldPromptInAskMode > MCP mutations > prompts for MCP mutations (blocked in safe mode)`~~ | `pre-tool-use-checks.isolated` |
| ~~`shouldPromptInAskMode > file write tools > auto-allows file write tools when requested by acceptEdits`~~ | `pre-tool-use-checks.isolated` |
| ~~`shouldPromptInAutoMode > auto-allows file write tools`~~ | `pre-tool-use-checks.isolated` |
| ~~`shouldPromptInAutoMode > prompts for MCP and API mutations`~~ | `pre-tool-use-checks.isolated` |
| ~~`workflow launch consent > never prompts in allow-all, matching "bypass permissions: the run starts immediately"`~~ | `pre-tool-use-checks.isolated` |

The eighteenth, `runPreToolUseChecks > step 2: source blocking > allows a
collision-qualified Source MCP tool from the pinned runtime view`, is the one
already listed under `fix/renderer` below (also struck). It is not duplicated
here; count 17 + 1 when you compare against a run — and note the case NO LONGER
EXISTS under that name: it was rewritten as *"allows a Source MCP tool addressed
by the wire name the resolver minted"* plus a second case for the collision's
documented outcome, so a by-name diff against an old run will report it missing
rather than passing.

## feat/TCODE-000, recorded 2026-09-04 (wave 5, P3.354 — the ten unreachable suites)

Ten `*.isolated.ts` suites reached CI through nothing, and `bun run test` was red
at HEAD, so the loop that DID reach them was one nobody could run green. Both
halves are closed; what follows is what each of the ten measured on the way, so
the next reader does not re-derive it.

**The mechanism was DISCOVERY, and the correction matters.** `bun test` collects
by filename and says so itself when a filter misses — *"Tests need \".test\",
\"_test_\", \".spec\" or \"_spec_\" in the filename"* — while
`bun test ./path/x.isolated.ts` runs fine. It is not a refusal to take a
filename. The halfway case is the dangerous one: a path WITHOUT a leading `./`
is read as a filter, matches nothing, and — alongside other paths — runs the
rest and says nothing, which is AGENTS.md's own trap.

**Wired, in the order that cannot leave a red loop behind:** the two real reds
were diagnosed and fixed and the two timeouts were controlled FIRST, then the
root `test` script was split (`bun test && bun run test:isolated`) and
`.gitlab-ci.yml`'s `test` job gained a third line, `bun run test:isolated`. Not
`bun run test`, which would double-run the whole repo suite. The script prints
the FILE COUNT and refuses to report success on zero files. Proven end to end:
`test:isolated: 10 suite file(s)`, ten green, exit 0 — and proven to still fail
with a planted assertion failure.

**Two rows FIXED here** and struck below: the 18 of
`pre-tool-use-checks.isolated.ts` (P3.355, see the block above) and
`session-branch-rollback.isolated.ts` ×3 (doubles gone short of a host seam).

**One row REGISTERED, and it is a load flake, not a defect:**
`packages/shared/src/workspaces/__tests__/paths-security-env.isolated.ts`, its
single case *"uses only the active root for classification, docs, logo,
prerequisites, and session-tool validation"*. It spawns one `bun --eval` child
and declares its own 30 000 ms budget. **Measured, both ends: three consecutive
solo runs of 636 ms, 717 ms and 681 ms at load 22.6 — and two timeouts at
>30 000 ms (`exitCode: null`, the child killed) inside multi-suite loops at
loads 7-11.** A 40x+ spread on identical code with the higher-load arm passing,
which is this tree's starvation signature; the budget is already 43x the
measured floor, so re-budgeting is not the answer and the file is deliberately
UNCHANGED. It is now inside CI's path, so if a runner reproduces it the budget
is the knob and this entry is the place to say so. It appeared in NO register
section before today.

**One suite RE-BUDGETED against a measured floor**, and this one WAS a real
gate defect rather than a flake:
`packages/shared/src/config/__tests__/retention-failsafe.isolated.ts` reported
`0 pass / 7 fail`, seven bare timeouts at bun's 5 000 ms default with no
assertion behind any of them. Every case spawns a `bun --eval` child that
imports `config/storage.ts` and `sessions/storage.ts`. With the budget lifted to
180 000 ms it is `7 pass / 0 fail` three times over: 41.97 s at load 9.6,
80.86 s at load 17.5, 64.66 s at load 12.2 — **6.0-11.6 s per case, i.e. the
default sits BELOW the floor on every reading**. Given an explicit
`RETENTION_SUBPROCESS_BUDGET_MS = 60_000`, roughly 5x the slowest reading: a
ceiling on a hang, not a performance assertion, and deliberately not set near
the resting state. The earlier reading of `0/7` here against `1/6` in a source
reading was the same signature and is now explained.

**RE-BUDGETED AGAIN 2026-09-08 (W9-as, P6.857): 60 000 ms → 180 000 ms, because
5x a happy-path per-case reading was 5x the wrong quantity.** W9-ap measured the
same file at `3 pass / 4 fail`, 452.89 s, at load 7.04 **while holding the test
mutex** — every failure a bare timeout at `[6037x ms]` with
`expect(code, out).toBe(0)` receiving `-1`, i.e. the child killed at exactly the
budget. That matters beyond this file: it is the FIRST path `test:isolated`'s
`find` returns and the loop is `|| exit 1`, so this red made a green isolated
gate impossible and a red one said nothing about the other nine suites.

**Today's signature is a 5x LOTTERY on identical bytes, not a standing red.**
Re-measured at HEAD `4aec25064`, three whole-file runs on one afternoon: 43.58 s
at load 10.5, 214.78 s at load 11.2, 216.87 s at load 9.3 — **`7 pass / 0 fail`
all three times**, so W9-ap's four failures did NOT reproduce, and the spread
runs backwards against load. `user`+`sys` never exceeded **2.7 %** of wall
(4.05 s + 1.61 s against 216.87 s), so it is I/O, never cpu contention.

**The separating instrument is the zero-case control**, and it is what re-derived
the budget: `bun test <file> -t '<a name nothing matches>'` → **30.97 s wall, 0
tests executed, 0.54 s user / 0.19 s sys** at load 13.5. The file's own import
graph costs ~31 s before any case runs, and each case pays a load of the same
class inside its `bun --eval` child — which is the quantity the per-case budget
is actually spent on. 180 000 ms is ~6x that price, the old ratio applied to the
right number; the docblock carries the reading. Do not read this entry as "the
suite is flaky": at 60 000 ms it was a real gate stop, and at 180 000 ms it is
green with room for a 5x I/O excursion.

**The other six were green throughout** and are recorded so the denominator is
visible: `auto-update-managed-gate` 19/0, `notifications-routing` 5/0,
`session-partitions-proxy` 2/0, `sessions-annotations` 3/0,
`prerequisite-manager` 31/0, `paths-env` 2/0.

## fix/renderer (historical)

| Test | Suite |
| :-- | :-- |
| ~~`runPreToolUseChecks > step 2: source blocking > allows a collision-qualified Source MCP tool from the pinned runtime view`~~ | **STRUCK 2026-09-04 (W5-j, P3.355).** Its premise was removed on purpose by `8e27f1a23`, whose own message says it rewrote the two tests that pinned the old two-survivor shape — this was the third, invisible because `.isolated.ts` is not a filename `bun test` discovers. Rewritten to the documented outcome; the case no longer exists under this name. |
| ~~`session-branch-rollback.isolated` (×3)~~ | **STRUCK 2026-09-04 (W5-j, P3.354): 4 pass / 0 fail, 1 FILE, at load 10.5.** Three hand-built agent doubles and one persistence-queue stub had gone short of the host seam while nothing ran the file: `SessionManager` grew `setAutomationSystem` (in `withCapabilityRuntime`'s `finally`), `drainAutomationEvents` (in `disposeManagedAgentRuntime`'s drain), `dispose` (the name the disposal path calls; `BaseAgent.dispose` is an alias for `destroy`, and the doubles declared only `destroy`) and `sessionPersistenceQueue.clearDeleteFence` (on `createSession`'s happy path). Each defect MASKED the next, so the file reported one cause at a time across four runs. Production was never affected. **RECURRED and re-struck 2026-09-10 (W9-bq, at the wave gate): 0 pass / 4 fail, then 1 pass / 3 fail, then 4 pass / 0 fail in 51.03 s.** Two more members of the same seam, both from `6e0ef8cf5`: `sessionPersistenceQueue.onWriteFailure` (subscribed in `SessionManager`'s CONSTRUCTOR, so its absence failed every case before any assertion) and `loadConfigDefaults().defaults`, which the double omitted entirely — three cases then reported `undefined is not an object` where their own assertion should have spoken. The second fix is the durable one: the double now spreads the real `FALLBACK_CONFIG_DEFAULTS` constant instead of hand-listing a shape, so the next key added to that seam arrives without anyone editing this file. **The standing lesson is the runner, not the file:** `test:isolated` is the ONLY thing that runs a `.isolated.ts`, `bun test` never collects one, and this file is therefore invisible to every gate a lane runs — which is why its doubles rot between wave gates and why the same entry has now been struck twice. |
| `conformance — live gateway > non-stream text` and `> streaming text surfaces reasoning in a reasoning item, never in output_text` | `codex-responses-adapter` — needs live gateway credentials; inside `bun run test:shared:all` |
| `capability-info-pages` (×6) | `apps/electron` renderer — **cross-file only.** The file passes **7/7 run alone**; it fails 6 only inside a full renderer-suite run, so this is a mock leak from another file, not a defect in the page. Reproduced twice by two independent executors on clean worktrees at bases `799bfda1` and `<the same run's base>` — 1017 pass/6 fail and 1020 pass/6 fail, the SAME six. **Not yet measured against `master`**, which per this file's own correction is the only check that decides whether it is ours; that comparison is on the close-out list. Do not chase it from inside a feature zone. |

### Rows removed 2026-08-07 at the merge gate

Every row below left this file the only way a row may: by being FIXED. The
gate that forced it is the one this file's own correction describes — `master`
pipeline 119773080 is GREEN while branch pipeline 120468629 was red with
eleven cases, so all eleven were the branch's, whatever each per-base check
had concluded. Commits `35daefe80` and `5c0ea8a14`.

| Was | Cause | Verdict |
| :-- | :-- | :-- |
| `SessionManager Pi child orchestration composition` (×2), `background shell tracking > deleteSession kills every registered background shell`, `filesystem scope receipts (P6) > surfaces trusted project config diagnostics`, `SessionManager project mutation > rejects a follow-up send while deletion owns the active-turn boundary`, `SessionManager backend config project trust` (×2) | **ONE line.** `resolveBackendContext` fell back to `getAvailableProviders()[0] ?? 'pi'`, an availability list ordered by BUILD FLAG. `ee84fe4e5` made the coding runtimes default-on, so its head flipped `pi`→`anthropic` and every session with no resolvable connection silently became a Claude session with no endpoint and no credential. Seven suites saw it; none of them is about backends, which is why per-suite blame kept missing it. | Product defect. Fallback is now `'pi'` outright. |
| `fixed Pi lifecycle bridge > freezes a complete per-hook semantic contract` | The repo has TWO frozen hook rosters in two packages. R32 grew the shared inventory by `MessageDisplay` and `DirectoryAdded` and updated only `format-adapters.test.ts`. Verified before re-freezing that both events are owned and emitted elsewhere, so this hides no bridge gap. | Stale golden. |
| `registerSystemCoreHandlers OPEN_URL` (×2) | Predate R43, which stamps internally-routed `nessy://` links `origin: 'external'` on purpose — OPEN_URL carries markdown-link clicks from model output. | Stale golden; the expectation now carries the field and the reason. |
| `resolveMcpDynamicHeaders > kills a hanging helper at the deadline` | Settlement was gated on `close`, which waits for the stdio PIPES; a helper that backgrounds work leaves descendants holding them, and the SIGKILL escalation is inert then because the shell already exited. Measured: four `sleep` processes survived every timed-out helper. Real impact — `McpClientPool.connect` awaits this before degrading to static headers, so the CONNECTION hung. | Product defect. Settles at the deadline, signals its own process group, timer no longer unref'd. **The CI trigger itself is still unproven** (passes in 258 ms locally, timed out at 15 s on the runner); the fix covers both candidate mechanisms and the next pipeline is the measurement. |

**NOT a row, and the distinction cost a re-run:** `Pi runtime cwd transaction >
keeps PREPARE private, refreshes generation auth, and restores a failed COMMIT`
(`packages/pi-agent-server/src/__tests__/pi-runtime-cwd-transaction.test.ts`)
failed once inside a full `bun test` and passed **3/3 run alone at the same
commit**, and passed inside the pre-T0 worktree's own run. It is a real-server
timing test that loses a race under full-suite load — flaky, not failing. Re-run
it alone before you write it down.

**Re-measured 2026-08-08, and the 3/3 above no longer holds.** Flagged by an
executor as 1 pass / 2 fail across three solo runs; the orchestrator's own three
solo runs at the same commit gave **2 pass / 1 fail**. The two measurements
disagree on the rate and agree on the finding: it now fails ALONE, which is the
condition this note was written to rule out. It is still not a row — a row means
reproducible — but "re-run it alone and it passes" is no longer a safe
disposition, so treat a solo failure here as unresolved rather than as proof.
**Worth its own verdict**: the same race that only showed under full-suite load
now shows without it, which usually means the margin shrank rather than that the
test got worse.

**DIAGNOSED AND FIXED 2026-08-14, after it failed the first post-merge master
pipeline (121410987, 13 080 pass / 1 fail) and blocked the 1.25.1 release
jobs.** The race was never in the product: the test's own pre-assert wait was
VACUOUS. The startup sequence already logs an `apply_overrides` for session 1
(the retry config), so `waitForLog(type === 'apply_overrides' && sessionId ===
1)` was satisfied before the model change wrote anything, and under load the
assertion then read the log before the compaction-carrying entry landed — the
CI diff shows exactly that (received array holds the retry entry and no
compaction entry). The wait now requires `overrides.compaction` to be present —
the same entry the assertion consumes. Probes: matcher made unsatisfiable → the
wait times out and the test reds (122 s); restored → 3/3 solo green. This also
explains every historical shape above: "fails under load" and "fails alone" were
both the subprocess writing the second marker later than the vacuous wait.

**Third measurement, 1.21.3 close-out (2026-08-08 evening): 3 pass / 1 fail
solo**, plus one failure inside the full run and two consecutive solo failures
taken immediately after that run finished — which then passed once the machine
was idle. Three independent measurements now read 1/3, 2/3 and 3/4; the spread
itself is the signal that this is load-sensitive rather than broken. One caution
learned here: a solo re-run taken while the machine is still busy from the full
suite is not a solo run. **And a genuine regression hides well behind this note.**
The compaction reserve change made this test fail 0/3 while the register would
have explained it away as the known flake; what separated them was measuring the
other side too — `git stash` gave 3/3 at the same moment. Measure both sides
before reaching for this paragraph.

**New intermittent, measured 2026-08-09 (1.22.0 close-out wave):** `login >
cancels via signal, killing the dp child (SIGTERM)`
(`packages/shared/src/auth/dp/__tests__/dp-api.test.ts`) failed once inside a
full `bun test` and passed **4/4 run alone** immediately afterwards. It kills a
child process and asserts on the signal, so it is timing-sensitive by
construction and loses under full-suite load. Not a row — not reproducible — but
recorded so the next full run does not spend the time re-deriving it.

Its independence from that run's changes was checked rather than assumed, which
is the discipline the paragraph above exists to enforce: the test imports only
`dp-api.ts`, `errors.ts` and its own fake, and none of the wave's commits touch
`auth/dp` or any child-process path.

**A second intermittent, confirmed from a saved CI dump after the pipeline id
404'd:** `Pi ProcessSupervisor > awaits close finalization instead of marking an
already-removed child lost`
(`packages/server-core/src/pi-harness/process-supervisor.test.ts:1040`). It
failed once on branch pipeline #120680972 (`fix/compact`, job `test`, 12 580
pass / 1 fail) and was **6/6 green locally** when first recorded — that line is
now STALE. Re-measured 2026-08-23 during P2.22's review: **6 runs of the shipped
file → 1 failure; 6 runs of the PARENT's version of the same file → 2 failures**,
so it flakes locally and P2.22's commit did not cause it. Treat it as an
intermittent of the same family as the `interaction-tools` entry below: a
combined run may charge it as a third `(fail)` line without any new defect.

The assertion detail is the useful part, and it names the race rather than the
symptom: the case asserts the store's final status is `exited` and CI read
`stopped`. Both are terminal, so this is not a lost child — it is the two
finalisation paths landing in the other order. The test spins two 50×2 ms polls
waiting first for a handle and then for the supervisor to drop it, then calls
`stop()` and releases the flush; on a slow runner the stop's own status can win
the write. Not a row — one occurrence, not reproducible — but recorded with its
mechanism so the next reader does not start from "flaky".

**Also not a row, and it will look like 14 failures if you skip this:** a
`bash apps/electron/scripts/build-dmg.sh` leaves `release/mac-arm64/Nessy
Desktop.app/…/app/src/**` in the tree, and `bun test` from the repo root
**collects the packaged copy of every renderer test** — 182 extra files, path
aliases that no longer resolve, 14 fail / 6 errors that exist nowhere in the
source. `rm -rf release` before the wave. (T8, 2026-08-05: 12928 tests collected
with `release/` present, 11464 without.)

**SUPERSEDED 2026-09-04 (W5-j, P3.354) — the `.isolated.ts` suites now run in
CI, so read this paragraph as history.** It used to say: neither remaining
`.isolated.ts` row runs under `bun test`, because no `*.test.ts` imports either
file, so they executed only through the second loop of `bun run test`, which
CI's `test` job did not call. That was true of TEN suites, not two.

The mechanism is DISCOVERY and not a refusal to take a filename: `bun test`
collects by filename and prints its own rule when a filter misses — *"Tests need
\".test\", \"_test_\", \".spec\" or \"_spec_\" in the filename"* — while
`bun test ./path/to/x.isolated.ts` runs fine. (Beware the halfway case:
`bun test packages/…/x.isolated.ts` WITHOUT the leading `./` is read as a
FILTER, matches nothing, and says so; alongside other paths that is the
run-the-rest-silently trap AGENTS.md names.)

Now: the root `test` script is `bun test && bun run test:isolated`, the second
half is its own script, and `.gitlab-ci.yml`'s `test` job runs it as a third
line — `bun run test:isolated`, not `bun run test`, which would double-run the
whole repo suite. The script prints the FILE COUNT and refuses to report success
on zero files, because a green run over nothing is the failure this whole entry
is about. Proven end to end 2026-09-04: `test:isolated: 10 suite file(s)`, all
ten green, exit 0. The live-gateway rows still sit inside `test:shared:all` and
were always in CI's path.

### Rows removed 2026-07-31 by being fixed

The `bun test` half of the list is gone — all of it was this branch's own, as
the correction above predicted, and none of it needed an assertion weakened or
a skip widened. One cause per commit:

| Was | Cause | Commit |
| :-- | :-- | :-- |
| `ensureStorageLayoutV2` (×7) | The `bun --eval` probe children inherited `NODE_ENV=test` and tripped the default-root guard in `config/paths.ts`. The guard is right; the inherited claim was not. Isolation comes from their disposable `HOME`, since these cases must resolve the DEFAULT root. | `d6c5db81` |
| `config path default-root classification` (×2), `managed paths with NESSY_CONFIG_DIR` | Same inherited `NODE_ENV`; `paths-default-root` also gained the disposable `HOME` it lacked. | `5743d9ba` |
| `Pi harness R0 baseline > executes golden foreground and background process contracts` | Stale golden. `d214cb63` (2026-07-28, owner decision) moved foreground bash to `networked` and updated the three other assertions but not this fixture, captured 2026-07-26. Shipped behaviour was the right side. | `c1f88e9b` |
| `SessionManager Pi child orchestration composition` (×2) | `5287fd49` put `hookTaskRegistryInput(...)` in the SubagentStop payload; it iterates `managed.backgroundShellCommands`, which two hand-built parent stubs never had. `ChildSessionService.observe()` swallows emit errors, so the event vanished instead of throwing. Blamed in a worktree: green at `5287fd49^`, red at `5287fd49`. | `e9e691c2` |
| session-mirror shifting member | Not env cross-talk. `SessionManager.cleanup()` is async and persists live sessions; four mirror suites dropped that promise in a synchronous `afterEach`, so a dispatch started under one test's mirror config and recreated `MIRROR_ROOT` during the next. Teardown now awaits cleanup, then `sessionMirrorIdle()`. | `db492dcb` |
| `bash tool-input timeout real server e2e` (never listed) | Surfaced mid-pass: the test read the process store the instant `ALL_DONE` hit the log, but the supervisor writes `exited` several awaits later from `'close'`. Instrumented, 1 of 4 idle runs already lost that race. | `5fb7caf8` |

## Why this file exists rather than a line in the tracker

I gave the S4 executor a one-item list. It found five more, and said so. I then
gave the S5 executor the six-item list, and it found seven more. S6 then found
two more that no earlier run had surfaced, because they need live gateway
credentials and sit inside `test:shared:all`. **Three times running the list I
handed over was short**, which is the argument for writing it down
rather than passing it along by memory — and also the argument for the rule at
the top: expect these, but still check. Two earlier units in this series reported
"all failures pre-existing" against a list I had given them, and neither could
have known the list was incomplete.

## Not on this list

Archive-tree artefacts. The S2 executor found that `headless server smoke test`
(×3) and `PiAgent maxAgentTurns` (×6) fail in an isolated archive tree and
**pass** in the real repository — a parallel-load artefact of how that run was
staged, not a repository failure. S6 added `settings default thinking RPC
handlers` (×2) to the same category — they fail in a copy tree and pass in the
real repository.

S10 found one that runs the **other** way: `Pi runtime cwd transaction > keeps
PREPARE private…` fails deterministically in a clean worktree at the base commit
and passes deterministically in the real repository. So a worktree reproduction
is evidence, not proof — this row would have been called "pre-existing" by the
very procedure this file prescribes.

**The same warning applies to TYPECHECKS, and more sharply.** B1d established
that a `git worktree` sharing `node_modules` cannot give a clean typecheck read
here: `@nessy-agent/*` resolves back into the **live repo**, so a shared-package
typecheck reads whatever a concurrent agent has uncommitted — proven by the
absolute real-repo path appearing in the error. `apps/cli` is the exception,
because its tsconfig uses relative `paths`. So a worktree typecheck is evidence
only for packages whose resolution stays inside the worktree; for the rest,
either repoint the links or wait for a quiet tree.

**And one gate gap worth repeating because two units hit it:**
`bun run typecheck:all` does **not** cover `apps/cli`, which has its own script.
A CLI change ships untypechecked unless it is run explicitly.

If you are running from a copy rather than the repo, expect extra failures that
mean nothing, and prefer running from the repo. When a concurrent agent has the
tree mid-edit, an isolated `git worktree` at your own HEAD is the way to get a
clean read — S6 hit exactly this, with another unit's half-written
`hook-command.ts` producing 25 failures that were not theirs.

## Not on this list — manufactured by concurrent runs (added 2026-07-30)

Two concurrent `bun test` processes in this repo manufacture failures: several
session suites mutate `process.env.NESSY_CONFIG_DIR` at module scope, so an
overlapping run produces extra failures (`durable-approvals`,
`permission-remember`, `fuzzy-file-search`, `queue-ops` as `(unnamed)`, a
retention `REPRODUCTION (pre-fix)`) that are green in isolation and absent from
a clean single run. Before recording a new failure, check no other `bun test`
is running.

### Order-dependent mock leak, added 2026-07-30 — FIXED 2026-09-20 in `380693f50` (D1.442, lane WI-cd)

**FIXED:** the narrow stub in `sessions.search-content.test.ts` now spreads the real barrel and restores it from a snapshot in `afterAll`; the four files below (a third victim, `sessions.shell-context-fold.test.ts`, did not exist when this entry was written and reproduced the identical failure) run together at 20 pass / 0 fail, `Ran 20 tests across 4 files`, and the whole `handlers/rpc` chunk is 10/10 on the first chunked CI run after it. The entry is kept for its mechanism; the line it cited (the 16th line of that file when written) is the `mock.module` call, the 37th line after the fix — named in words so no citation gate re-fires.

`packages/server-core/src/handlers/rpc/sessions.search-content.test.ts` (its `mock.module` call) used to call
`mock.module('@nessy-agent/server-core/services', …)` with a NARROW stub. In a
single run that mock leaks and breaks two innocent files with
`SyntaxError: Export named 'isUsableGitBashPath'/'resizeImageForAPI' not found`:

- `packages/server-core/src/handlers/rpc/system.open-url.test.ts`
- `packages/server-core/src/handlers/rpc/sessions.shell-command.test.ts`
- `packages/server-core/src/handlers/rpc/sessions.shell-context-fold.test.ts` (the third victim, born after this entry)

Proven order-dependent: the two victims pass together (12/12) and fail the
moment the mocking file joins the run. `services/index.ts` is unchanged since
its baseline, so this is the mock's shape, not a regression. **Before recording
either victim as a new failure, check whether the search-content file was in the
same run.**

## feat/TCODE-000, recorded 2026-08-23 (runtime-parity-closure, P2.5 re-review)

| Test | Suite |
| --- | --- |
| (intermittent, file-level error) `error: complete-event-failed` thrown asynchronously | `packages/server-core/src/sessions/SessionManager.interaction-tools.test.ts:275` |

Shape: in a combined `bun test packages/server-core/src/sessions/` run, the file's own DELIBERATE `complete-event-failed` throw occasionally escapes asynchronously; bun charges it as a file-level error and TWO tests do not run (one of them `filesystem-scope-revocation`'s registered failure — so the totals read 1 fail + 1 error instead of 2 fail). The file passes 8/8 in isolation; a clean re-run of the directory shows the normal 2-fail shape. First diagnosed at T10's gate ("the loose error is the file's OWN deliberate throw"), run down independently at P2.5's re-review (git log confirmed the directory untouched by the chain). Cause: unknown async escape, pre-existing relative to this plan and nothing stronger; `master` unmeasured (defer to P5.4).

## feat/TCODE-000, recorded 2026-08-29 (runtime-parity-closure, P3.232)

| Test | Suite |
| --- | --- |
| `guardian judge core — verdict sanitization at the boundary > collapses a multiline / ANSI-laden reason to a single bounded line and drops an unknown category` | `packages/pi-agent-server/src/orchestrator/guardian-runner.test.ts` |

**FIXED 2026-08-29 by lane z13 while closing P3.249 — kept here with the
diagnosis, because the shape is instructive and because the register is where
someone will look next time this assertion moves.**

Shape: DETERMINISTIC, not load-dependent — 15 pass / 1 fail on two consecutive
runs, in the working tree and again in a clean `git worktree add` at the lane's
own base (`9d3c04c79`, removed after use), with the file run **alone** so no
concurrent-run or mock-leak explanation applies. Attributed by the y5 lane while
closing P3.232, which touches neither the guardian nor reason sanitization; it is
recorded rather than fixed because the sanitizer is another lane's surface.
Independently reproduced by z13 at ITS base (`24d5807ad`) in a clean worktree,
same 15/1 and the same assertion, so the attribution holds across two bases.

Cause, and the reason nothing was widened to clear it: `sanitizeReason`
(`guardian-judge-core.ts`) runs `neutralizeHarnessMarkers` FIRST, and since
P2.226 that function STRIPS C0/C1 control characters rather than replacing them
— line terminators deliberately excluded, per `INVISIBLE_LEAD`'s own note. So by
the time `sanitizeReason`'s `[\u0000-\u001f…] -> ' '` replace runs, the ESC bytes
are already GONE (deleted, joining `LINE` to `[0m`) while `\n` and `\r\n` are
still there and still become spaces. The expectation encoded the pre-P2.226
pipeline, where every control became a space. The test's SECURITY assertion —
`expect(result.reason).not.toMatch(/[\r\n\u001b]/)` — passed before the fix and
passes after it; only the byte-equality line was stale.

## feat/TCODE-000, recorded 2026-08-27 (runtime-parity-closure, P2.219)

The three `PowerShell plans folder exception` assertion failures registered here
on 2026-08-25 are **GONE — fixed, and RE-VERIFIED 2026-08-29 (P2.394)**:
`powershell-validator.ts` now decides a Windows-shaped path pair with
`path.win32` semantics, and `packages/shared/tests/mode-manager.test.ts` runs
**471 pass / 0 fail in 66.3s** on an idle machine with the oracle installed
(pwsh 7.6.5, `/opt/homebrew/bin/pwsh`). The command in full, because "re-run it"
is not a command:

```
bun scripts/bun-test-lock.ts run --label <lane> -- bun test packages/shared/tests/mode-manager.test.ts
```

Positive control on the same rig, so the green is not the oracle being absent:
the `PowerShell plans folder exception` family alone — the block the three
retired failures lived in, eleven cases in it now — runs **11 pass / 0 fail in 75.5s**
(`… -- bun test packages/shared/tests/mode-manager.test.ts -t "PowerShell plans folder exception"`).
Seven seconds a test IS the pwsh spawn; a skipped family returns instantly.

### The retired entry, and why hunting for it reads like finding a phantom

Recorded because a lane went looking for the entry this section replaced, could
not find what it named, and reported the register as carrying a phantom. Both
halves of that are traps a register manufactures on its own:

- **The entry is not in this file and has not been since 2026-08-27.** Its
  numbers — *430 pass / 3 fail with pwsh present, 433 / 0 without* — were
  deleted by `d6d6adbc6`, the same commit that fixed the defect, and replaced by
  this section. They are still live in the plan's own `P2.219` row, which is a
  different file: **the plan row is the surviving copy of a retired register
  entry**, so a lane reading the row and grepping here finds nothing and
  concludes the register invented it. **Before calling an entry a phantom,
  `git log -S '<the number>' -- <this file>`** — it names both the commit that
  wrote the entry (`a280c6bc7`) and the one that retired it, and a retired entry
  is otherwise indistinguishable from an invented one.
- **The 433-test suite it named no longer exists at that size, and that proves
  nothing.** It is this same file. On 2026-08-26 it had 186 `it`/`test`
  callsites, 11 of them skipped, and the entry recorded 433 tests; it has 199
  callsites with 2 skipped and measures 471 now, after `d6d6adbc6` un-skipped
  twelve win32-only cases and `6ec034b64` added more. **A test COUNT is not an
  identifier.** Every measurement in this file cites the FILE and the COMMAND
  for that reason — a total is a reading with a date on it, and this one moved
  by 38 inside two commits.

What replaces the three failures is a different animal, and it was sitting
underneath them the whole time:

| Test | Suite |
| --- | --- |
| (load-dependent) `validatePowerShellCommand` — 2 cases | `packages/shared/tests/mode-manager.test.ts` |
| (load-dependent) `extractPowerShellWriteTarget` — 9 cases | `packages/shared/tests/mode-manager.test.ts` |
| (load-dependent) `isReadOnlyBashCommand (full integration) > should allow legitimate command: npm search test-runner` — 1 case | `packages/shared/tests/mode-manager.test.ts` |
| (load-dependent) `plan mode hands a non-read-only shell command up for approval` — up to all five cases | `packages/shared/src/agent/__tests__/mode-manager-plan-shell-review.test.ts` |

**The family above was NAMED WRONG IN BOTH DIRECTIONS until 2026-09-03 (P2.240),
and both errors cost something.** It read *"the whole `extractPowerShellWriteTarget`,
`validatePowerShellCommand` and `PowerShell plans folder exception` family"*.

Measured by P2.219's reviewer, which crushed the `parseCommand` ceiling to
**150 ms** so that EVERY parse spawn fails — the positive control that separates
"this test needs the spawn" from "this test is in the same file":

- **12 tests go red**, and they are the three rows now in the table:
  `validatePowerShellCommand` (2), `extractPowerShellWriteTarget` (9), and
  `isReadOnlyBashCommand (full integration) > should allow legitimate command:
  npm search test-runner` (1).
- **ZERO come from `PowerShell plans folder exception`.** That whole describe
  passes with every spawn broken, because `getDeniedPathViolation` tries
  `extractBashWriteTarget` FIRST and it covers all of them. So the register was
  inviting a real plans-folder regression to be waved off as "the machine" —
  which is the one thing a register must never do.
- And it OMITTED the `npm search test-runner` case, which genuinely can fail
  this way and now has nowhere else to be filed.

Shape: one parser spawn costs roughly **0.5–0.9s idle** on this host (pwsh
7.6.5, `/opt/homebrew/bin/pwsh`) — and that figure is a READING WITH A DATE, not
a constant: **0.69–0.88s** when this entry was written, **520–592ms** when
P2.219's reviewer re-measured the same rig. It moves with the machine and with
the load, so re-measure before quoting it (P2.253c). `parseCommand`'s own
`spawnSync` ceiling is **10s**, and THAT is a fixed number in the code — it is
the one the duration rule below turns on, which is why the rule survives the
spawn cost drifting. With several lanes running tests concurrently, spawns reach that
ceiling, `parseCommand` returns `success: false`, and the caller answers `null`
— which surfaces as an ordinary ASSERTION failure (`Expected: "C:\\…" Received:
null`), not as a timeout, so it reads exactly like a product defect.

Measured, same tree, same commit: **471/0 in 61s** on an idle machine;
**446 pass / 25 fail in 276s** under five concurrent lanes, and the failures are
cleanly bimodal — the ones that are real fail in **under 3.3s**, the load
artifacts all fail at **≥10s**, the spawn ceiling. **Sort a red run of this file
by duration before attributing anything: ≥10s is the machine, not the code.**

**READ THAT RULE ONE-DIRECTIONALLY — its converse is unsafe (P2.240,
2026-09-03).** *≥10s ⇒ the machine* holds. *<10s ⇒ the code* does NOT.
`parseCommand` returns `success: false` on **any** `result.error`, not only
`ETIMEDOUT`, so an `EAGAIN`/`EMFILE` under a five-lane fan-out fails **FAST** and
produces the identical `Received: null` assertion. The reviewer's 150 ms ceiling
injection is the positive control for that shape: **11 of its 12 spawn-caused
failures completed in 160–240 ms**, indistinguishable from a real wrong answer by
duration. A quick failure is therefore unattributed, not exonerated — re-run it
alone with the lock held before calling it a defect.
The bun-side half of this (a 5s default per-test timeout, below the file's
resting cost) is fixed in-file by `setDefaultTimeout(30_000)`; the spawnSync
ceiling is deliberately NOT raised, because it is production behaviour and a
user's shell validation must not hang for 30s. Re-run the file alone, with
`scripts/bun-test-lock.ts` held and nothing else running, before recording a
failure from it.

`mode-manager-plan-shell-review.test.ts` is the same family reached through a
different door: every `shouldAllowToolInMode('Bash', …)` runs
`getDeniedPathViolation`, which calls `extractPowerShellWriteTarget` on EVERY
command whose bash write-target came back null — with no `looksLikePowerShell`
gate in front of it — so a plain POSIX command pays a pwsh spawn. **Measured
2026-08-27 on this one file, alone, lock held: `HEAD` 2 pass / 5 fail (25s);
the same file with P2.219's fixes 6 pass / 1 fail (40s).** It is pre-existing
and P2.219 moves it in the right direction; the ungated spawn itself is a real
product cost on any host with `pwsh` and is NOT fixed here — gating it would
make the denied-path check fail OPEN, which is the wrong direction, so it needs
a row of its own.

**Re-measured 2026-08-29 (P2.394), same command, idle, lock held: 7 pass / 0
fail in 53.5s** — the same seven cases as the `6 pass / 1 fail` above, none of
them red now. So that reading is history and this row stays in the table for its
LOAD dependence alone. The spawn cost is unchanged and sits in the wall clock:
seven tests, 53.5s.

## The three permission suites' 5s timeouts under lane contention (2026-08-29)

`codex-permission-rules`, `pi-agent-pretool-hook-decision` and `claude-permission-mode` fail on a
broad `packages/shared/src/agent/__tests__` run while lanes are working. Measured by lane w4:
**3666 pass / 16 fail**, every one of the 16 a **5s timeout** and **none in a hook path** — i.e. none
related to the change being verified.

**The control is what makes this recordable rather than a guess**, and it is the register's own
method done properly: a `git worktree add` at the lane's base commit (`5094873bd^`) scores **33 fail**
on the same three files — **worse without the change**. So the run improved and still showed red, which
is the exact reading a bare pass/fail count would have inverted.

Same family as the pwsh-spawn shape above: the failure is the machine, not the code. Two other lanes
hit a sibling of it the same day — `bun --eval` child spawns at the 5000 ms default, where the identical
child costs 0.37 s CPU but 33.6 s wall at 1 % CPU and produces the asserted output; the suite passes
1/0 with `--timeout 120000`.

**Before recording a red from any of these: re-run the file alone with `scripts/bun-test-lock.ts` held,
and if you must attribute a failure while lanes run, take a worktree control at your base.** A red run
compared against nothing is not evidence — comparing against the base is what turned "16 failures" from
an accusation into a measurement.


## `instruction-excludes-envelope.test.ts` — 4 of 4 time out, and the blocker is the import (2026-08-29)

Same family as the two sections above, recorded because it isolates the cost one step further than
"the machine is busy". Lane x5, on `feat/TCODE-000`:

- The suite spawns one `bun --eval` per case, and each subprocess imports `instruction-excludes.ts`.
  Under concurrent lane load that import measures **20–30 s wall while burning 0.5 s of CPU** — the
  process is blocked, not computing.
- **A/B'd in the same minute** against the file at HEAD: 22.3 s with the lane's change, 20.6 s
  without. So it is the module graph, not the diff.
- **Positive control on the same rig:** importing `storage.ts` alone costs **0.38 s**. The cost
  arrives with `instruction-excludes.ts`'s graph — which reaches `pi-harness/permission-dsl.ts`, and a
  spawn under that graph is the pwsh shape this register already names.
- The trap it manufactures: the file at HEAD passed **4/4 in 1.73 s** in a quiet window and failed
  **2/4** minutes later on the same rig, so a lane that runs the control once and believes it will
  attribute the red to itself. Run it twice, or A/B in the same minute.

**Fixed rather than registered as permanent:** the suite's own budget is now `SUBPROCESS_BUDGET_MS`
(60 s, after one case overran a 30 s budget at 39.7 s), with the measurement written at the constant.
The entry stays because the underlying blocking import is unchanged and other suites importing that
graph will show the same shape.


## The settings-page suites — the blocker is `@nessy-agent/ui`, and the whole class is affected (2026-08-29)

The same shape as the section above, one package further out. Lane z11, on `feat/TCODE-000`:

- `apps/electron/src/renderer/pages/settings/__tests__/` holds two suites that load their page under
  test inside a `beforeAll` (`app-settings-managed-updates.test.ts`, `ai-settings-reconnect.test.ts`).
  The import reaches `@nessy-agent/ui`, and under concurrent lane load it BLOCKS: the hook is killed
  before a single assertion runs, so the suite reports **0 pass, 1 fail, `(fail) (unnamed)`** — the
  misattribution shape this file already names, with the extra sting that the failure names a
  lifecycle hook and not the import inside it.
- Readings on the same rig, minutes apart: `app-settings-managed-updates.test.ts` **43.5 s** and
  **46.6 s** to the timeout, then **177.9 s** on the run that completed once its budget allowed it.
- **Positive control, and it is what settles attribution:** `ai-settings-reconnect.test.ts` is
  untouched at HEAD, has the identical import shape, and failed the same way at **102.8 s**. So this
  is the class, not any lane's diff.
- **Reverting the lane's own change did not clear it** — the file at HEAD failed identically at
  44.5 s, which is the cheaper control to run first.

**Half fixed, half registered.** `app-settings-managed-updates.test.ts` now carries
`PAGE_IMPORT_BUDGET_MS` (240 s), with the measurement written at the constant, and passes 14/0.
`ai-settings-reconnect.test.ts` is unchanged — it was outside that lane's zone — so it stays a live
member of this class and needs the same one-line budget from whoever next holds it.


## Two unregistered flakes, and the reason the fail COUNT is not the signal (2026-08-30)

P2.412, P2.419 and O4 of `docs/superpowers/specs/2026-08-28-out-of-scope-register.md`, recorded
together because they are one family with one cause and one wrong fix. The family itself is already
described three sections up ("The three permission suites' 5s timeouts under lane contention"); what
these two add is the **reproduce triple** — isolation, under load, and the CPU-vs-wall reading — for
two suites that were being hit by lanes and were in no register at all.

Measured on 2026-08-30 with **fourteen sibling lanes running**, load average 9–30 on 8 CPUs.

### The commands, and what each one does

| | reproduces in isolation | reproduces under load |
| --- | --- | --- |
| **P2.412** `bun test packages/server-core/src/bootstrap/__tests__/builtin-dp-mcp-capability-projection.test.ts` | **no** — 7/7, 3 of 3 runs, 1.21–1.33 s | — |
| **P2.412** `bun test packages/server-core/src/bootstrap/__tests__/` (22 files) | — | **yes, 1 of 3 runs** |
| **P2.419** `bun test packages/shared/src/agent/__tests__/codex-permission-floors.test.ts` | **no** — 18/18, 3 of 3 runs | — |
| **P2.419** `bun test packages/shared/src/agent/__tests__/codex-*.test.ts` (38 files) | — | **yes, 1 of 3 runs** |

### The readings

| run | wall | CPU (user+sys) | CPU | verdict |
| --- | --- | --- | --- | --- |
| P2.419 file alone, run 1 | **165.78 s** | 3.15 s | **1.9 %** | 18/18 **PASS** |
| P2.419 file alone, runs 2–3 | 1.94 s / 1.68 s | 2.24 s / 2.04 s | ~100 % | 18/18 PASS |
| P2.412 directory, run 1 | 2.49 s | 2.34 s | ~94 % | 155/0 PASS |
| P2.412 directory, run 2 | 16.38 s | 2.30 s | 14 % | **1 timeout at 5000 ms** |
| P2.412 directory, run 3 | **180.91 s** | 3.54 s | **2.0 %** | 155/0 **PASS** |
| P2.419 codex batch, run 3 | **312.34 s** | 2.87 s | **0.9 %** | **1 timeout at 5000 ms** |

O4's independent reading of the same shape, from two lanes on 2026-08-28: the identical child costs
**0.37 s CPU against 33.6 s wall at 1 % CPU** and produces the asserted output; the suite passes 1/0
with `--timeout 120000`.

### What the numbers say, and it is not what a fail count says

**A starved run can PASS at 165 s or FAIL at 16 s.** Those are two rows of the same table above. The
process is never slow — every run costs 2–4 s of CPU — it is *descheduled*, and whether you see a
failure depends only on **where the stall lands**: during module load, and the suite passes late;
inside a test's own 5 s window, and that test times out.

That is the whole explanation for the reading P2.419 was opened over. The row recorded **3 fail of 3**
at one commit and **2 of 3** on a later tree — worse at baseline than after the change, which ruled out
the obvious attribution and looked like a mystery. Measured here it is **1 of 3**, and in isolation
**0 of 3**. All four readings are of the same stochastic starvation. **The fail count measures the
machine's scheduling, not the code**, so a lane comparing its count against a recorded count is
comparing two samples of noise.

Corroborating how thin the margin is: the P2.419 timeout measured **5146.73 ms** against a 5000 ms
budget — a 2.9 % overshoot. It is sitting on the threshold, which is this repo's own recorded trap of a
threshold sized against an idle machine.

### The named suite is not special — P2.412's correction

P2.412 names `builtin-dp-mcp-capability-projection.test.ts`. The timeout this lane reproduced in that
directory was **a different suite**: `storage-runtime-policy.test.ts` ›
*"blocks a renamed remote .mcp.json server by its URL pattern"*, at **14172.76 ms**. Any suite in the
directory can take the stall; which one does is arbitrary. **Do not treat the suite named in this
register as the defective one** — that is how a phantom entry misdirects the next lane (P2.394).

### The wrong fix, and it is the tempting one

**Raising the timeout.** A job costing 0.37 s of CPU that takes 33.6 s of wall clock does not need a
bigger budget; it needs not to be starved. A larger number makes the red go away while leaving every
suite in the class blind to a real regression that is genuinely slow. Where a budget IS raised it must
carry its measurement at the constant, as `PAGE_IMPORT_BUDGET_MS` does in the section above.

### Before recording a red from either of these

1. Re-run the file alone. Both pass 3 of 3 that way.
2. If you must attribute while lanes run, take a `git worktree add` control at your base — the method
   the permission-suites section above proves out.
3. **Check the failure's SHAPE before assigning it to this family.** In the same batch runs this lane
   measured five failures in `codex-event-adapter`/`claude-agent` territory
   (`CodexAgent.approveGuardianDeniedAction`, `CodexAgent.approveGuardianDenial`) that are **not** this
   class: they fail in **1–8 ms with assertions**, not at a 5000 ms timeout, and they came from a
   sibling lane's in-flight working tree. A timeout at ~5000 ms with near-zero CPU is this family;
   a millisecond-scale assertion failure is somebody's diff.

## Four more rows, five suites, and only two of them are the family (2026-08-30)

P2.424, P2.435, P2.438 and P2.376 of `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`,
measured together on 2026-08-30 with **twelve sibling lanes running, load average 6.7–37 on 8 CPUs**.

Recorded in one section because the useful result is the **split**, and it did not fall where the rows
predicted. Four suites were sent here as suspected members of the starvation family described three
sections up. **Two of the five are:** P2.435 and P2.438. **Three are not**, and each failed for its own
reason a bigger timeout would have hidden:

- **P2.424** was a knob set to one millisecond, below the measured floor of the thing it timed. Fixed.
- **P2.376b** was a documented contract that had genuinely drifted. Fixed at `c10b33a8f` by another
  lane while this section was being written — which is the strongest possible evidence it was never
  a flake.
- **P2.376a** is a live guard, still red, answering correctly.

**So the base rate matters: of four rows opened as "probably the flake family", half were real.** The
family is a real phenomenon and its forbidden fix is still forbidden, but "timeout under load" is a
symptom that a real defect can wear, and P2.424 wore it for two lanes before anyone measured the floor.

Every command below runs from the repo root, and each row states the three things P2.394 proved an
entry is useless without: **the exact command, whether it reproduces in isolation, and whether it
reproduces under load.** A test COUNT is not an identifier — see P2.376a below, whose count moved
three times in three days while the defect stayed the same one.

### The four at a glance

Every command below runs **one file, alone, in its own `bun test` process**, so "isolation" here is not
the file-alone-versus-batch axis it was for P2.412/P2.419 — two of these five fail that way on every
run. The variable that moves the other three is the **fleet**.

**A true idle box was never obtained, and no row here claims one.** Load was sampled continuously for
the length of this lane and never fell below **6.7** on 8 CPUs. The right-hand column is load 6.8–9.3,
which is *quieter*, not *quiet*. Where an un-starved cost is asserted it comes from **CPU time** — the
one quantity on this box that does not move with the fleet (`/usr/bin/time -p`, `user`+`sys`, which
include reaped children).

| | command | load 9–37 | load 6.8–9.3 | verdict |
| --- | --- | --- | --- | --- |
| **P2.424** | `bun test packages/server-core/src/pi-harness/otlp-telemetry.test.ts -t "uses the configured timeout"` | at the old 1 ms value **13 of 15 fail** (load 37); at 250 ms **3 of 3 pass** (load 27), whole file 14/14 (load 35) | — | **test defect — FIXED, registered so it is not re-opened** |
| **P2.435** | `bun test packages/shared/src/config/__tests__/default-thinking-level.test.ts` | **2 of 19 fail** (load 15.1 and 17.8) | never sampled below load 9.0; 17 passes spread over load 9.0–16.5 at **9.76 s to 86.69 s** for the same ~13 s of CPU | starvation |
| **P2.438** | `bun test packages/pi-agent-server/src/__tests__/pi-auto-compaction-instructions.test.ts` | 2 of 2 runs fail | **2 of 3 runs fail**, and the one clean pass came at a HIGHER load than the run where all four failed | starvation |
| **P2.376a** | `bun test scripts/check-doc-anchors.test.ts` | fails, 145 findings | **fails, 145 findings** | **real — a live guard nobody is answering. SUPERSEDED 2026-08-31 by P2.376a's own fix and P2.472: now **2 of 25** fail, the assertion answers **7**, and the `page-not-snapshotted` class is structurally gone. Match on the enumerated reasons below, never on any count in this row.** |
| **P2.376b** | `bun test packages/server-core/src/sessions/__tests__/runtime-capability-gaps-doc.test.ts` | fails in 0.74 ms | **fails in 0.74 ms** at `acacafce6`; **5/0 at `e4c8fd7a1`** | **real — a documented contract drifted; FIXED at `c10b33a8f` by another lane mid-measurement** |

### P2.424 — a knob below the floor, and it is NOT this family

`otlp-telemetry.test.ts` › *"uses the configured timeout and awaits a partial shutdown flush"* set
`OTEL_EXPORTER_OTLP_TIMEOUT = '1'`, one millisecond, and then asserted the request had been delivered.
It is registered here only so the next lane does not re-open it: **it was a defect in the test and it
is fixed**, and it does not belong with the three below.

The floor was measured directly rather than inferred — a loopback POST of the same shape, timed from
the moment `AbortSignal.timeout` starts ticking to the moment the server has the body, at load 15:

| | min | p50 | p90 | max |
| --- | --- | --- | --- | --- |
| one loopback delivery | 0.64 ms | **1.46 ms** | 1.80 ms | 3.47 ms |

So the budget sat **below the median cost of the thing it was timing**, and the delivery was lost
outright in **9 of 40** and **2 of 25** sampled attempts. A sweep over the same probe: `1ms` → 23/25,
and `5ms`, `10ms`, `25ms`, `50ms`, `100ms`, `250ms` → 25/25 each.

Two things were wrong, and the second one is the more interesting:

1. The knob. Now `250` — ~70× the worst delivery measured under load, still two orders of magnitude
   below `DEFAULT_TIMEOUT_MS` (10 s) so it can only have come from the env var. The measurement is
   written at the constant, as this file's own rule requires.
2. **The collector's auto-200 is EAGER**, so the case's "delayed response"
   (`setTimeout(() => response.end(), 30)`) never delayed anything. The fallback
   `if (!response.writableEnded) response.writeHead(200).end()` runs synchronously the moment the
   handler returns, so the 200 was already on the wire and the handler's timer later fired against an
   ended response. Whether the abort or the reply won was a coin flip — which means the case's own
   name was never being tested. `collector()` now takes `'defer'` from a handler that wants to hold
   the response, and the case holds it, so the export can only end by the configured timeout.

**Mutant, under the same load:** the fixed case passes 3 of 3 at load 27 and the file passes 14/14 at
load 35; setting the value back to `'1'` fails **13 of 15** at load 37. Nothing else in the file moved.

### P2.435 — a subprocess-per-observation suite, and reducing the count cannot save it

**Reproduce:** `bun test packages/shared/src/config/__tests__/default-thinking-level.test.ts`.
Nineteen runs on 2026-08-30, the file always **alone** in its `bun test` process: **17 pass, 2 fail**.
The two failures came at load 17.8 and 15.1, but load does not separate the samples — a run passed at
16.5 — which is the family's own point that the fail count measures the machine's scheduling and not
the code. It has **two distinct failure modes**, which is why a lane that meets one and reads a
register entry describing the other will think it has found something new:

| mode | what it looks like | measured |
| --- | --- | --- |
| **timeout** | `supports every thinking level` — *this test timed out after 120000ms* | **157962.28 ms**, whole file 249.79 s |
| **exit** | `holds a model default across a restart…` — `Error: subprocess failed (exit 1)` | **27305.02 ms**, well inside the 120 s budget |

The CPU-versus-wall readings put it in the family, and this suite gives the cleanest statement of the
family's whole argument, because its CPU cost barely moves while its wall clock moves by 9×:

| load | wall | CPU (user+sys) | CPU % | outcome |
| --- | --- | --- | --- | --- |
| 10.1 | **9.76 s** | 12.31 s | **126 %** | 9/0 — effectively un-starved |
| 9.0 | 12.25 s | 14.30 s | 117 % | 9/0 |
| 10.5 | 25.29 s | 12.87 s | 51 % | 9/0 |
| 9.1 | **86.69 s** | 13.22 s | **15 %** | 9/0 |
| 17.8 | 189.81 s | 13.70 s | 7.2 % | **1 fail (exit)** |
| 15.1 | 249.79 s | — | — | **1 fail (timeout)** |

**The whole nine-test file costs ~13 s of CPU and can finish in 9.76 s.** Its single heaviest test then
times out against a **120 s** budget at 157962 ms. Unlike the rest of the family this suite is
*genuinely* expensive; what starvation does is multiply an already-large fixed cost, and no budget
short of absurd survives 7 % CPU.

**The row asked whether it needs a subprocess per test. It needs one per fresh MODULE state, and that
is not the same question.** `packages/shared/src/config/storage.ts` freezes the config directory at
import — `const CONFIG_FILE = join(CONFIG_DIR, 'config.json')` at module scope — so one process can
only ever see one config dir. Nine tests need nine; the suite spawns **32**, because
`supports every thinking level` alone does set+read for each of the six `THINKING_LEVEL_IDS`.

**Measured, cutting them does not fix it, so the suite was left alone.** A bounded fan-out of the
identical child — 72 spawns at concurrency 12, then 160 at concurrency 32 — produced **0 failures**
in 232 spawns, at p50 786 ms / 1.9 s and **max 24.9 s for a single spawn**. A spawn costs ~0.45 s of
CPU, so the failing test's twelve are ~5 s of the file's ~13 s.

The arithmetic that decides it: the most aggressive honest reduction of that test is **7 spawns**
(set each of the six levels in its own child, assert each against `config.json` on disk, then one
child to prove the reload — the general cross-process round-trip is already owned by
`round-trips persisted value across processes`). That is ~3 s of CPU. At **2.1 %**, the worst
efficiency measured anywhere on this box today, 3 s of CPU is **143 s of wall clock** — still past the
120 s budget, having given up five assertions to get there. **A reduction that cannot beat the
starvation is the same paper-over as raising the budget, one step further from the seam**, so the
right disposition is this entry and no code change.

**The exit-1 mode is recorded as unexplained, deliberately.** Its child's stderr was not captured, and
it did not come back: 10 targeted reruns of that one case (`-t "holds a model default"`) and the 232
spawns above all passed. What was searched is written here so the next lane starts past it, not so it
counts as diagnosed.

### P2.438 — baseline-confirmed and starved, which are not alternatives

**Reproduce:** `bun test packages/pi-agent-server/src/__tests__/pi-auto-compaction-instructions.test.ts`.
Five runs, **four with failures, and a different set each time** — the family's signature. The column
that matters is the last one:

| run | load | outcome | wall | CPU | CPU % |
| --- | --- | --- | --- | --- | --- |
| 1 | 13.9 | 2 fail — `routes composed instructions…` 121102.58 ms, `permits instruction replacement…` 120306.47 ms | 318.57 s | 8.56 s | **2.7 %** |
| 2 | 11.7 | 1 fail — `preserves the model-derived threshold…` 90062.18 ms (the case the row names) | 156.71 s | — | — |
| 3 | **7.6** | **4 pass, 0 fail** | 68.70 s | 6.02 s | **8.8 %** |
| 4 | 8.9 | 2 fail — 120226.37 / 125541.86 ms | 256.48 s | 8.22 s | **3.2 %** |
| 5 | **6.8** | **0 pass, 4 fail** — 90255.27 / 120316.52 / 120127.02 / 120273.13 ms | 473.91 s | 9.87 s | **2.1 %** |

**Load does not order the outcomes.** The only clean sweep came at load 7.6 and the total wipeout came
at 6.8 — lower. This is the same stochastic starvation P2.412/P2.419 measured, and it is why a lane
comparing its fail count against a count in this file is comparing two samples of noise.

Note also that even the **passing** run is starved: 6.02 s of CPU spread across 68.70 s of wall clock.
A green run here is not evidence of a healthy machine, only of a stall that landed between the
deadlines instead of inside one.

**The row's caution about this one needs inverting.** Its lane confirmed the failure on an unmodified
tree and concluded it might not be the family. Stashing removes YOUR DIFF; it does not remove the
FLEET. A clean-tree reproduction while twelve lanes run is evidence of *pre-existing*, and says nothing
about *starved* — the two are independent, and this suite is both.

The deadlines that fire are the tests' **own** `setTimeout` rejections (90 s, 120 s, 120 s, 30 s), not
bun's per-test budgets (105 s, 150 s), so a lane reading only bun's numbers will look for the wrong
constant.

**What the 90 s is paying for, since the row asked: not module load.** Each case spawns the real
`pi-agent-server` entrypoint, and that graph costs **0.44–0.46 s warm** (`@earendil-works/pi-ai/compat`
120–133 ms, `@earendil-works/pi-coding-agent` 310–346 ms). The one 15.5 s reading of that same import
was itself starved — 0.67 s CPU against 15.53 s wall, **4.3 %**. Against ~8.6 s of CPU for the whole
four-case file, a 90 s deadline is roughly 10× the un-starved cost of everything the file does.

### P2.376 — two red suites that are NOT flakes, and must not be filed as any

Both were re-measured on a **clean-HEAD `git worktree`** at `acacafce6` (never a stash — the standing
prohibition at the top of this file), and both failed there identically to the working tree. Both fail
with **assertions in milliseconds**, which this file's own rule already separates from the family: a
timeout at a budget with near-zero CPU is starvation; a millisecond-scale assertion is a real answer.

**(b) was fixed by another lane during this measurement — see the end of this section.** Only (a) is
still red. The pair is kept together because the contrast is the lesson.

**(a) `bun test scripts/check-doc-anchors.test.ts`** — 1 of 19 fails, in **2532.82 ms** in the working
tree and **38871.18 ms** on the clean worktree (the difference is starvation; the verdict is identical).
The guard asserts zero findings and gets **145**, sampling as 88 `[page-not-snapshotted]`,
45 `[page-not-in-corpus]`, 10 `[anchor-not-a-section]`.

**The count is not the identifier, and this entry exists mostly to say so.** It was recorded as 141,
then 142, and measures 145 here — three readings in three days, none of them wrong when written,
because every lane that adds a spec citation moves it. A lane matching its own number against a number
in this file is comparing two samples of a moving quantity. **Match on the assertion and the
categories, never on the total.**

#### (a) re-measured 2026-08-31 after P2.376a landed and P2.472 fixed the citations

**Everything quantitative in the paragraph above is now wrong, including the category split — and the
split is wrong STRUCTURALLY, not by drift.** Kept above rather than rewritten, because the reason it
went wrong is the entry's own lesson. What replaces it:

- **The suite is 25 tests, not 19, and how many fail DEPENDS ON LOAD** — which is the whole point of
  the timing note below. At load 18.2: **2 of 25**. At load 9.97, the quietest moment this lane could
  find: **1 of 25**. The one that fails in both is the assertion; the one that comes and goes is a bare
  timeout. A lane recording "2 fail" as the signature would send the next lane hunting a second defect
  that does not exist.
- **The assertion is unchanged and is the identifier:** `expect(audit.findings.map(…)).toEqual([])`
  in *"has no dead section anchor, and nothing pinned"*. It answers **7**.
- **`page-not-snapshotted` is gone as a class.** Those 88 were pages this repo cited with an anchor and
  had never snapshotted; `--refresh` took the snapshot from 7 pages to 98 (`6b52af0a2`), so they became
  *checked* citations. A lane looking for that category will not find it, and its absence is the fix
  working rather than the guard weakening.
- **The remaining 7 are enumerated, and an enumeration does not move with citation churn the way a
  count does.** Four `[anchor-not-a-section]` and three `[page-not-in-corpus]`:

| # | subject | why it is red |
| --- | --- | --- |
| 1 | `permissions.md` › `#configuration-spec` | a **Codex** anchor (live: `## Configuration spec`, `learn.chatgpt.com/docs/permissions.md`), cited bare from the plan tracker `:2705` — bare, it is checked against Claude's page of the same name |
| 2 | `permissions.md` › `#migrate-from-older-sandbox-settings` | same class, same page, tracker `:2681` (live: `## Migrate from older sandbox settings`) |
| 3 | `plugins-reference.md` › `#plugin-json-fields` | genuinely dead, and deliberately preserved: the tracker's P2.443 row *quotes it as the wrong anchor that row fixed*, so the dead string is history the tracker is keeping |
| 4 | `hooks.md` › `#top-level-decision` | **LIVE** — a `<Tab title="Top-level decision">` id, 1 of the rendered page's 1 148, no numeric twin. The guard declines to slugify tab titles because a duplicate takes a numeric suffix no rule predicts, so a wrong slug could BLESS a dead citation while a missing one only over-reports. Its blind spot, not a defect |
| 5 | `notifications.md` › `#configure-desktop-notifications` | **Codex** page, in neither Claude corpus nor this repo; cited bare from the tracker `:3172` |
| 6 | `prompting.md` › `#steering-and-queuing` | **Codex** page, cited bare from the tracker `:3173` and from `packages/server-core/src/sessions/SessionManager.ts:23299` |
| 7 | `page.md` › `#section` | the P2.472 row's own prose, tracker `:2847` — the row NAMES the defect shape it is fixing, and the scanner reads the example as a citation |

  **Six of the seven live in files a lane fixing this is forbidden to edit** — five in the plan tracker,
  one in a `SessionManager.ts` pinned to another lane — and the seventh is the blind spot above.
  P2.472 rewrote every in-zone citing site — **19 citations in 18 files**: 12 for #5, 2 for #6, 3 for
  #1/#2, plus one genuinely dead Claude anchor (`memory.md` › `#how-claude-looks-up-memories`, re-pointed at
  the live `#how-claude-md-files-load` that carries the citer's own claim) and one dropped `agent-sdk/`
  prefix — and the count still fell only 9 → 7, because a finding is keyed on the anchor and one
  surviving citer keeps it red.
- **Nothing is pinned, and that is deliberate.** `PINNED_DEAD` cannot suppress `page-not-in-corpus` at
  all, so pinning could not reach green; and #4 is live, so pinning it would be the exact error that
  produced four of the six pins this list has ever held.

**The second failure is starvation, and the same file supplies its own control.** *"scans the repo
through git, and finds citations in it"* fails with a bare `timed out after 5000ms` and **zero assertion
failures** — this file's own signature for the family. Measured at load 18.2 falling to 14.0: that test
**118 879 ms**, the sibling assertion **34 481 ms**, the whole file **197.86 s**, against **4.18 s of
total CPU** (`user 2.19` + `sys 1.99`) — **2.1 %**. Three controls, none of which needs an idle box:

1. `runAudit()` is **uncached** (`collectCitations()` re-reads every file on every call) and **two tests
   in the same process call it**. One reported 34 481 ms; the other, *"checked something"*, passed
   **inside** the 5 000 ms budget on identical work, same tree, same moment.
2. The audit as a script — the work the 5 s budget times — is **1.25 s wall / 0.75 s CPU** at load 12.32.
3. **The lower-load run, which is the control this entry was told to get and the one that settles it.**
   At load 9.97 (against 18.2 for the run above) the pure-timeout failure **did not reproduce: 24 pass,
   1 fail**, and the survivor is the assertion. Note what it did NOT do — get faster: the file took
   **248.25 s** against 197.86 s, and the assertion test **243 656 ms** against 34 481 ms, for **4.75 s
   of CPU** across 327 s of wall (`user 2.45` + `sys 2.30`) — **1.5 %**. So wall time on this box is not
   even monotonic in load average, which is the reason this file forbids reading a duration as a cost.

So the timeout is load, not cost. **A true idle box was still never obtained** — load sampled across this
lane ran **9.18 to 34.14** on 8 CPUs and never reached idle, so control 3 is *quieter*, not *quiet*.
Nothing here is therefore filed as a fix: raising the budget is still the forbidden fix, and the
assertion in (a) above remains the verdict this suite is reporting.
**Every anchor named above is written `page.md` › `#anchor`, split on purpose.** A contiguous
`<page>.md#<anchor>` is what the guard's scanner matches, so naming a dead anchor in prose CITES it — this
entry scored its own eighth finding that way and the guard caught it before the commit. The guard
excludes only its own two files (`SELF`); a register that discusses dead anchors has to split the token
instead, because widening that exclusion list would blind the guard to real citations in the same file.

#### (c) re-measured 2026-09-07 (W8-td, `P6.680`) — the suite is 40 tests, ONE assertion is red, and the timeout's name changed

**Everything quantitative in (a) is superseded again.** Match on the assertion, never on any count here
either.

- **The suite is 40 tests** (13 added by `P6.680`) and **2 failed** on entry, of which **one was a
  stale pin with nothing to do with the tree**: `expect(SNAPSHOT.sections.size).toBe(98)` while the
  snapshot's own `# Pages:` header says **102**, moved by refreshes ending at `2ab52a56f`, which did not
  update the pin. Fixed in place as an in-zone residue. A stale exact pin standing beside a live finding
  is how both get skimmed.
- **The findings assertion answers THREE, and none of the three is an `anchor-not-a-section`** — the
  category (a) enumerated four of. Every site is now listed by the guard itself (`P6.680`), so the
  citers are quoted rather than hunted:

| kind | subject | every citer, from the guard's own output |
| --- | --- | --- |
| `page-not-snapshotted` | `desktop.md` | `apps/electron/src/renderer/actions/definitions.ts:146`, `apps/electron/src/renderer/hooks/useTranscriptVerbosity.ts:4` (both from `0ca7636a4`) |
| `page-not-snapshotted` | `agent-sdk/permissions.md` | `packages/shared/src/agent/__tests__/permission-mode-clamp.test.ts:103`, `packages/shared/src/agent/mode-types.ts:161` (both from `59731c0ac`) |
| `page-not-in-corpus` | the tracker's own example of the citation SHAPE, `page` + `.md#section` | `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` — unchanged since (a), and lanes do not edit the tracker |

  **Both `page-not-snapshotted` rows are one online `--refresh` away and are NOT citation defects**: the
  pages are real, cited correctly, and simply absent from a snapshot taken before those two commits
  landed. `--refresh` rewrites the whole snapshot from the network, so it belongs in a deliberate commit
  of its own rather than inside a lane — proposed as a row rather than done here.
- **The second failure in (a) — the bare 5 000 ms timeout — was filed as starvation, and that label is
  withdrawn** by `P6.677` (see the module-graph section above): the zero-case control shows this class of
  cost is I/O with total CPU flat across a 100x swing in wall time. The reading for THIS suite on
  2026-09-07: the whole file **197.99 s** wall for **1.31 s user / 0.92 s sys — 1.1 % cpu** at load 8.28,
  with the live-tree scan test alone at 157 896 ms inside its 300 000 ms budget. Nothing starved it.
- **The escape now exists**, so this entry no longer has to spell the token apart to discuss it: a line
  carrying the marker `doc-anchor:example` has its references skipped and counted. This line uses it, and
  its reference is `page.md#section` — the exact string the tracker is reported for. <!-- doc-anchor:example -->
  If the tracker's holder ever marks that line the same way, finding three retires without editing the
  prose that names the defect.


**(b) `bun test packages/server-core/src/sessions/__tests__/runtime-capability-gaps-doc.test.ts`** —
1 of 5 fails, in **0.74 ms** on the clean worktree. `send_agent_message` sits on the absent side of the
`22 session tools are absent` row in `docs/architecture/runtime-capability-gaps.md` and is present on
the bridged codex surface. Measured off `getSessionToolNames`:

| surface | doc says | really |
| --- | --- | --- |
| external standalone, no bridge | 18 | **18** |
| + host-callback bridge | 26 (eight crossed) | **27 (nine crossed)** |
| + advisor consult | 27 | **28** |

The ninth is `send_agent_message`, and it crossed in **`6173c9778`** (2026-08-28,
*"a codex session could list its peer sessions and not message one"*) — one day after P2.211 corrected
that same row. That commit updated `packages/session-tools-core/src/scheduling-projection.test.ts` and
did not touch the doc, so **the narrow guard was red for two days and worked exactly as designed.**

**FIXED at `c10b33a8f` (2026-08-30), by another lane, while this entry was being written.** The row
now reads `21 session tools are absent`, moves `send_agent_message` to the crossed side, and says
**NINE** carried by the bridge and **27** advertised — which is exactly the middle column of the table
above, independently arrived at. Re-measured at `e4c8fd7a1`: **5 pass, 0 fail.**

It is written up anyway, and this is the point of the entry: **the guard was never a flake and its
red was never noise.** It was neither stochastic nor timing — a 0.74 ms assertion that would have
failed on every run on every machine until the row was corrected, which is what eventually happened.
An entry that had filed it under the starvation family would have taught the next lane to ignore
precisely the signal that closed it.

## `packages/shared/src/agent/__tests__/claude-live-settings.test.ts` — CLOSED 2026-09-03 (W2-l)

**Attributed and fixed; not a product defect and not a flake.** The suite's own `fakePool` duck was
missing two methods `createSourceProxyServers` grew after it was written: `alwaysLoadProxyToolNames`
(`ff28207ea`, P2.454, 2026-08-31) and `getInstructions` (`6acef70b7`, 2026-08-29). Both are on the real
`McpClientPool`; the duck is cast through `as never`, so TypeScript could not fail the build when the
interface it stands in for grew, and the calls threw at runtime instead.

That is exactly the 8-of-41 split W2-b measured: the eight are the cases that go through
`makeAgentWithPool`, and no other case enters that path. Both stubs answer empty — no case in this file
is about the always-load pin or about server instructions, and inventing content would make the duck
assert things its own suite does not test.

**The durable lesson, which is bigger than the entry:** a test double cast to `never` is invisible to
every interface change, so a production read added to the code under test turns green suites red with
no signal about why, and the failure names the DUCK's caller rather than the commit that widened the
interface. Two commits three days apart landed here and neither run was red until a lane ran this file
alone.

## `runtime-switch-session.test.ts` — PROFILED and CLOSED 2026-09-03 (W2-l)

W2-h's reading was right and its diagnosis was the right half of AGENTS.md's pair: not starvation, an
expensive module import inside a hook. **Profiled outside the runner** (`bun -e`, so no lock and no test
contention), with the load quoted beside each reading as the timing rule asks:

| reading | load | what dominates |
| --- | --- | --- |
| **161.9 s** | 7.78 | cold transpile cache; the first `await import` pays the whole graph |
| **16.2 s** | 10.53 | warm; `SessionManager.ts` alone is the 16.2 s, `platform-headless.ts` after it costs 0.1 ms |

Five more imports follow in the same hook and are free once the first has landed. Both readings are far
past bun's 5 s default, so the file was never green solo on any machine; a BATCH pays the import in some
other file first and the hook then costs nothing, which is why it passed there and looked like
contention.

**Fixed with an explicit budget set against the measured floor** — `beforeAll(fn, 240_000)`, above the
COLD reading because a cold cache is the ordinary state of a fresh checkout or a CI runner. Not zero and
not unbounded: a genuine hang still fails, four minutes later, instead of being reported as an import
that got slower.

**Two things worth carrying, both re-measured here on a throwaway suite:** `beforeAll(fn, ms)` IS
supported in Bun 1.3.14 (a 6.5 s hook passes at 12 s and fails at the default), and the runner prints
*"a beforeEach/afterEach hook timed out"* for the `beforeAll` family too, reporting **zero tests
executed** with exit 1 — so read the executed-test COUNT, never the message's hook kind.

## `pi-auto-compaction-thrashing.test.ts` — the fourth member of the timeout shape, and NOT its family (P3.199, W2-y, 2026-09-03)

Registered with the distinction the row asked for, because without it this entry would make the
starvation family above misleading. **The budget it blows is INSIDE the scenario**, a
`setTimeout(..., 120_000)` around a real child Pi server in `runScenario`, not the suite runner's
hook budget. Two consequences a reader must not have to re-derive:

- **Raising a bun test timeout does nothing to it.** The three suites in the shape above lose a
  lifecycle hook; this one rejects its own promise.
- **It does not present as `(fail) (unnamed)`.** It reports `thrashing scenario timeout` followed by
  the protocol trace it collected. If you are looking at an unnamed hook timeout, you are not here.

**The budget is not the trap it looks like.** Measured 2026-09-03, three consecutive runs of the whole
file (2 tests, one child server each), `uptime` read beside each: **4.96 s at load 11.79, 5.65 s at
12.69, 7.81 s at 13.83 — 2/2 pass every time.** That is ~2.5–4 s per scenario against 120 s, so
**30× to 48× headroom**, and the AGENTS.md trap this row was filed under — "a narrowing test knob set
below the system's RESTING state manufactures its own failure" — does not apply. Lowering the number
toward the floor would manufacture the failure it is being blamed for. It is left where it is, and the
reading is now in a comment beside the constant.

So if this file times out, it is AGENTS.md's *first* cause (starvation under parallel load), not a
mis-set knob. **The low-load arm of the separating control is still owed:** a quiet box was not
obtainable — eleven other lanes were running for the whole window — so what is measured is three
points across load 11.8→13.8, not the two extremes the rule asks for.

## `pi-harness-baseline.test.ts` — 3 red at the stage-2 base, and all three are pins a landed commit moved (P3.198, W2-y, 2026-09-03)

**STRUCK 2026-09-03 (G-1): FIXED by `2db95a6bb`** — the three pins were re-pinned deliberately on a
quiet tree, and the file is absent from the full gate's failure set at `03dd3b1fb` (1 603 files).
Kept for the diagnosis below, and because the seam it names — an excluded test file that can be
FAILING and silent — is unchanged.

Pre-existing at `6bb67c143` on a clean tree — no worktree control was needed, because the tree carried
no modifications when the run was taken. Deterministic, not timing: three concrete assertion diffs in
1.4–4.4 ms each.

| Failing case | What moved | Commit |
| --- | --- | --- |
| pins all MCP rows against the actual current client surface | `NessyMcpClient.prototype` gained `getInstructions` | `6acef70b7` |
| compares effective availability with current registries, filters, and live builders | `SESSION_TOOLS_REQUIRING_HOST_CALLBACK` gained `list_sessions` and `get_session_info` | `c197a8bb4` (P3.222) |
| pins golden approval, modes, abort, resume, and compact ordering | `handle.compact(msg.customInstructions)` became a multi-line call, so the ordered-marker text no longer matches | `413354e4b` |

**Why three commits could each leave this red and each be green for their lane.** The file is on
`tsconfig.typecheck.json`'s exclusion list, so no typecheck contains it, and its only other reader is
root `bun test`, which CI runs and no lane runs in an implementation loop. That is P2.255's seam, not
the typecheck exclusion's — a pin comparing two runtime values is red whether or not the compiler saw
the file. The exclusion's own cost is narrower and still real: when such a test breaks for a TYPE
reason, the error naming the cause is not reported either.

**A fourth failure appeared and vanished inside the same hour and is NOT in this table**: the
`agent.subagent` source-state digest, which was a neighbouring lane's uncommitted edit to
`orchestrator/subagent-tool.ts`. `check:surface` printed `6/6 match live source` and, twenty minutes
later, the same pin as DRIFT, with no commit in between. **Anything measured over the working tree
during a parallel wave needs `git status` read beside it before it is recorded here.**

Not fixed here: the file is outside W2-y's zone. It is three pin updates for whoever holds it.

## `lint:conditional-expect` — red at the stage-2 base `6bb67c143`, direct run green (read 2026-09-03, W2-r)

**STRUCK 2026-09-03 (W2-y, P3.305, `6a4fd8b03`):** not a red — the reading was over another lane's two
UNTRACKED files; green on a clean worktree at base. `--check` now labels `[untracked]`. Kept for the shape.

`bun run lint:conditional-expect` (the chain step) exits 1 while `bun scripts/check-conditional-expect.ts`
run directly exits 0 on the same tree. The flagged files were unmodified by the 22 commits since base and
the checker predates them. P3.305 (W2-y) owns the diagnosis; until then a red here is not new.
## Readings taken over a parallel wave's WORKING TREE — three measured false reds in one day (P3.305, W2-y, 2026-09-03)

Not a failing test: a failing *method*, and it produced three separate "pre-existing red" reports in one
afternoon of stage 2, each of which dissolved on contact with `git status`. Recorded here because this
register is where the next lane looks before chasing a red.

| Reported as | Actually |
| --- | --- |
| `lint:conditional-expect` RED at the stage-2 base, three hits (P3.305) | **Green** on a clean worktree at `6bb67c143`. Both flagged files were **UNTRACKED**, written minutes earlier by two other lanes; the scanner walks the filesystem, so it sees them. |
| `format-adapters.test.ts` carries 5 type errors no typecheck reports | The file is TRACKED, is a root file of `packages/shared/tsconfig.json` (830 of 830 in program) and `tsc --noEmit` is **exit 0, zero output**. Positive control: a planted type error in that exact file **is** reported. It was modified-uncommitted when measured and was fixed in `3f4347375`. |
| `agent.subagent` source-state pin DRIFT | `check:surface` printed `6/6 match live source` twenty minutes earlier with **no commit between** — `orchestrator/subagent-tool.ts` was modified-uncommitted by another lane. |

**The rule, and it is cheap.** During a wave, any verdict about the tree needs `git status` read beside
it, and any "pre-existing at base" claim needs the clean-worktree control AGENTS.md already mandates —
which for a self-contained scanner is a bare `git worktree add --detach <base>` with no `node_modules` at
all, so the objection about a worktree measuring its parent does not arise. Assert provenance anyway: the
run above compared the checker's SHA-256 in the worktree against the parent's before believing it.

`bun scripts/check-conditional-expect.ts --check` now labels a hit `[untracked]` so this particular
instance cannot recur silently.

**A fourth, and it was mine.** A restore-harness copies its baseline at start and writes it back at exit;
editing the same file while it runs races the restore. Zone your own parallel work by FILE too.

## `pi-auto-compaction-thrashing.test.ts` — the HIGH-load arm, measured (P3.199 addendum, W2-y, 2026-09-03)

The entry above owed the second arm of AGENTS.md's separating control. It is now measured, and it
settles the diagnosis:

| condition | result |
| --- | --- |
| the file alone, load 11.8 / 12.7 / 13.8 | **2 pass / 0 fail**, 4.96 s / 5.65 s / 7.81 s |
| inside a 5-file batch, load 13-20, with **nine** concurrent unlocked `bun test` processes | **both scenarios blow the 120 s budget** — 120 165 ms and 120 239 ms |

Same scenario, a 15x to 24x inflation. *Passes alone at low load, fails under contention* is AGENTS.md's
**starvation** verdict, so the 120 s budget is confirmed as NOT the fault: it sits 30x-48x above the
measured floor and lowering it toward that floor would manufacture the failure it is being blamed for.

Treat a red here as **no reading** unless the box is quiet. And note what produced it: nine `bun test`
processes running at once, i.e. lanes not taking `scripts/bun-test-lock.ts`. The mutex is advisory
(P2.255), and this is what advisory costs.

## `advisor-gate-projection.test.ts` — hard-coded surface counts 45/44 against a live 46 (read 2026-09-03, W2-u)

**STRUCK 2026-09-03 (G-1): FIXED by `2db95a6bb`**, the same re-pinning commit; absent from the full
gate's failure set at `03dd3b1fb`. W2-p no longer owes this one.

Registry-count drift: the surface grew during stage 2 (W2-n's `ReviewDiff`, W2-l's bindings) and this
suite pins literal counts with zero references to the gate it names. Not a behaviour red. W2-p re-derives
the counts on the quiet tree (the fix is the `runtime-switch-costs-surface-counts.test.ts` shape — derive,
never hard-code); until then a red here is not new.

## `check:surface` — `agent.subagent` / `workflow.execute` pins moved by LANDED commits (read 2026-09-03, W2-l2)

`pi-agent-server`'s `bun run typecheck` exits 1 on its first link, `check:surface`: the source-state pins for
`agent.subagent` and `workflow.execute` moved with `83fbac7cf` and `f1ee13a16` (W2-z's P2.115/P2.163), both
files clean in the tree — so the earlier entry that read this drift as a false red from an uncommitted
neighbour is INVERTED for these two: they owe a deliberate re-pin (`check:surface -- --pin`, model-facing
declaration hashed before and after, W2-j's `fb83385b4` is the form). W2-p on the quiet tree.

## The full gate at `03dd3b1fb` — 68 red + 2 errors, attributed row by row (G-1, 2026-09-03)

The verification-wave-2 boundary gate. **Attribution summary: 30 of the 70 lines are ONE
Vite-only specifier, 10 are starvation or cross-file, 26 are deterministic assertion failures
(9 of them fixed here), and 3 are real-server e2e suites on a box that never went idle.**

**Method, and the two controls AGENTS.md asks for.** Every `(fail)` line was grouped by the file
header above it, and every file was then run **ALONE** under `scripts/bun-test-lock.ts` with
`uptime` and `git status --porcelain | wc -l` read beside each run. The tree carried **one**
untracked path for the whole window — `scripts/cdp/cases/pkg-4.ts`, W2-p7's CDP case — so the
false-red-over-a-working-tree failure mode P3.305 records above does not apply to any row here.
Load never fell below **9.6** and never rose above **13.8** on 8 CPUs, so the low-load arm of the
starvation control is *quieter*, not *quiet*, and every row that needed it says so.

**One log-fidelity caveat, and it is the reading this file's own rule demands.** The captured log
holds **66** `(fail)` lines against a reported **68 fail**, and the two reported `errors` are
separately marked `# Unhandled error between tests`. The 2-line shortfall is unexplained — most
likely interleaved stdout — so the numbers below are counted from the 66 plus the 2 named error
blocks. **Read the FILE COUNT, not the fail count**: 1 603 files, 21 323 tests, 3 824 s.

### The single largest cause: one Vite-only specifier, 30 lines, and NOT the class's own ordering

**STRUCK 2026-09-03 (W3-h, P3.316, `202e8558f`): the mechanism G-1 named (five process-wide `mock.restore()` sites) is REFUTED — each prepended to the 21 files ran 217–224/0. The poisoner is `scripts/barrel-import-safety.test.ts`: a caught import failure leaves a failed module record in bun's registry that beats every later `mock.module()` for the specifier, in both command orders. Contained in a child process (`scripts/barrel-import-probe.ts`); after: 313/0 in both orders, 0 pdfjs lines. These 21 files were never proven green, only un-runnable — expect surfaced reds in the next full gate.**
`SyntaxError: Missing 'default' export in module '…/pdfjs-dist/build/pdf.worker.min.mjs?url'` —
**28 `(fail)` lines plus BOTH `errors`**, over 21 renderer files. The `?url` suffix is a Vite
resource query bun cannot resolve at all; `scripts/barrel-import-safety.test.ts`'s header records
the carve-out and the 16 barrels that reach it. **Every one of the 21 files already carries its own
`mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))`.**

Two measurements settle what it is:

| condition | result |
| --- | --- |
| all 21 affected files in ONE `bun test` process, load 11.4 | **217 pass / 0 fail, 21 files, 1.56 s** |
| `plugins-browse-count.test.ts` alone, load 11.2 → 9.0 | 13 pass / **1 fail** — and the failure is a 5 s timeout at **65 776 ms**, i.e. starvation, with no pdfjs error anywhere |

So it is **not** ordering inside the class, and not a defect in any of the 21 files: the poisoner is
a file OUTSIDE the class somewhere in the 1 603. **Candidate mechanism, measured only as far as the
call sites — not proven:** `mock.restore()` restores module mocks **process-wide**, and the tree has
exactly five call sites, all in `server-core`/`shared` —
`SessionManager.execution-observability.test.ts:7` (an `afterEach`, so it fires per test),
`sessions/__tests__/agent-view-runtime-neutral.test.ts:35`, `sessions/ephemeral-session.test.ts:26`
and `:197`, and `packages/shared/src/sessions/__tests__/ephemeral-session.test.ts:20`. A renderer
file whose stub is wiped can never re-link the specifier, because there is nothing real behind it.

**What this retires:** the `capability-info-pages (×6)` row in the `fix/renderer` table above is
this class. It reports **1** unnamed fail now, not 6, and that row's own conclusion — *"a mock leak
from another file, not a defect in the page"* — was right about the shape and wrong about the file.
Do not chase it from inside a renderer zone; the fix is one host-level stub, or the removal of the
`?url` imports from `packages/ui`, which `barrel-import-safety.test.ts`'s
`viteOnlyCarveOutIsStillNeeded` is already waiting for.

### Green in this run — entries above that this gate did not reproduce

Recorded because a register only earns its keep if a fixed row leaves it, and because five of these
were fixed by `2db95a6bb` and `6a4fd8b03` while the entries stayed:

| Entry | Status at `03dd3b1fb` |
| --- | --- |
| `pi-harness-baseline.test.ts` — 3 pins moved (P3.198) | **GREEN.** Re-pinned by `2db95a6bb`; absent from the failure set. |
| `advisor-gate-projection.test.ts` — 45/44 against a live 46 | **GREEN.** Same commit; absent from the failure set. |
| `pi-auto-compaction-thrashing.test.ts` (P3.199) | **GREEN** inside the full run — the 120 s in-scenario budget held at load 7–9, which is the arm its addendum above owed. |
| `mode-manager.test.ts` pwsh family, `mode-manager-plan-shell-review.test.ts` | **GREEN.** No pwsh-shaped failure anywhere in the run. |
| `pi-agent-pretool-hook-decision.test.ts`, `mode-block-reason.test.ts`, `codex-permission-rules`, `claude-permission-mode` | **GREEN.** None of the four appears; the "15 of 47" reading is a load reading, not a property of the suites. |
| P2.412 `builtin-dp-mcp-capability-projection`, P2.419 `codex-permission-floors`, P2.435 `default-thinking-level`, P2.438 `pi-auto-compaction-instructions` | **GREEN.** The whole starvation family sat quiet at load 7–9. |
| `sessions.search-content.test.ts`'s two mock-leak victims (`system.open-url`, `sessions.shell-command`) | **GREEN.** |
| `SessionManager.interaction-tools.test.ts`'s `complete-event-failed` escape | **Did not fire.** Both `errors` in this run are the pdfjs class. |

`pre-tool-use-checks.isolated.ts`'s 18 are unaffected: no `*.test.ts` imports the file, so root
`bun test` never collects it. **(2026-09-04, W5-j: all 18 are now fixed and the file runs in CI
through `bun run test:isolated` — see the P3.355 block near the top of this file. Root `bun test`
still does not collect it, and that is by design: it runs one file per invocation.)**

### `check-doc-anchors.test.ts` (P2.376a) — the enumeration moved 7 → 2, and one of the two is new

**Correction 2026-09-03 (W3-h, P3.318, `202e8558f`): this suite is NOT network-dependent — no `fetch`, no `await`; `--refresh` is the only online path and no test calls it. The ~420 s was three whole-repo scans, now memoised (first test ~207 s cold, the other 24 in 18.7 s); budget 300 000 ms against the slower of two readings that disagreed 100×. It stays in `bun test`.**

The assertion still answers, and per that entry's own rule this is matched on the ENUMERATION and
never on a count. It now reports **two**, of which only one is the known blind spot:

1. `hooks.md` › `#top-level-decision` — unchanged, and still the guard's declared blind spot (a
   `<Tab title=…>` id it declines to slugify).
2. `plugins-reference.md` › `#plugin-manifest` — **new, and genuinely dead.** Probed against the
   RENDERED page with AGENTS.md's own recipe (2026-09-03): `plugins-reference` publishes
   `id="plugin-manifest-schema"` and no `id="plugin-manifest"`. **Fixed here** — the sole in-zone
   citer was a docblock in `packages/shared/src/plugins/managed-plugin-key.ts:44`, re-pointed at
   `#plugin-manifest-schema`, whose `## Plugin manifest schema` section carries the citer's own
   quoted sentence (*"Unique identifier in kebab-case…"*, the `name` row of its §Required fields).
   The sibling citer in `2026-08-28-runtime-feature-inventory.md:423` already spelled it correctly.

The other two `(fail)` lines from this file are its two documented bare timeouts (139 523 ms and
142 883 ms against a 5 000 ms budget), the starvation half that entry already measures.

**And the answer to "does it belong in a full local run at all":** it makes live HTTPS requests to
`code.claude.com` for the corpus it audits. It is the only network-dependent suite in the 1 603, it
costs ~420 s of the run's wall clock on its own, and its verdict is about DOCUMENTATION rather than
about this tree's behaviour. It is a guard worth keeping and a poor citizen of `bun test`; moving it
behind its own script (as `lint:chain` does for `check-nul-bytes`) would remove two permanent
timeouts and one network dependency from every full gate. Not done here — it is a gate-shape
decision, not a test defect.

## `check-doc-anchors.test.ts` (P2.376a) — CLOSED 2026-09-03 (W4-c): one finding left, and the guard was the one that was wrong

Read at the wave-4 base `16b34edb1`: **1 of 25 fails in 1 755 ms**, whole file 3.40 s (W3-h's
memoisation held), and the assertion answers **one** finding, not two — the dead `#plugin-manifest` anchor of
`plugins-reference` was fixed by W3-h at `202e8558f`. (Spelled apart on purpose: this guard scans
every tracked `.md`, so writing a dead anchor here in its full citation form RE-CREATES the finding
the sentence is reporting as closed — and so does writing a placeholder in that form, which is the
second way this paragraph tripped it. Measured 2026-09-03 — the first draft of this entry did exactly
that and the suite reported it against this file. `check-doc-anchors.ts` and its own test are in
`SELF` for this reason; the register is not.) Per this entry's own rule the match is on the ENUMERATION and never on
a count, and the enumeration has now run 141 → 142 → 145 → 7 → 2 → **1**.

**The last one was the guard over-reporting a LIVE anchor, and it is measured rather than argued.**
`hooks.md#top-level-decision` comes from a `<Tab title="Top-level decision">`, and `sectionSlugs`
deliberately declines to slugify tab titles: they are DERIVED text, they repeat within and across pages,
and a duplicate takes a numeric suffix no slug rule predicts, so minting slugs for them would let the
guard BLESS a dead citation — worse than missing one. So the anchor could never be derived, and
`--refresh` could not fix it either: refreshing re-derives from the same markdown and changes nothing,
which is exactly what `changelog.md#2-1-248` did until `<Update label>` was admitted.

Probed the only non-circular way, against the RENDERED page (2026-09-03): `GET
https://code.claude.com/docs/en/hooks` — 200, 2 824 283 bytes, **752 distinct `id="…"` values**, and
`top-level-decision` is one of them (`panel-top-level-decision-0` is its panel sibling). The citation is
correct and the snapshot is blind.

**Fixed by the mirror of `PINNED_DEAD` rather than by a slug rule.** `KNOWN_LIVE_UNDERIVABLE` in
`scripts/check-doc-anchors.ts` holds anchors that ARE live and that `sectionSlugs` cannot derive, each
with the rendered-page probe that settled it; a listed anchor counts as verified, because the page's own
`id` is stronger evidence than the snapshot it is missing from. Two findings guard the list itself, the
same way `PINNED_DEAD`'s do: `known-live-anchor-now-derivable` when the snapshot grows the section, and
`known-live-anchor-uncited` when nothing in the tree cites it any more. The list is one entry long.

**The BUDGET is a separate reading, and after the fix it is the ONLY thing still red.** Two runs at
wave load, eight lanes concurrent: in a four-file batch the live-tree case took **620 506 ms against
its 300 000 ms budget** and printed a timeout line BESIDE a real assertion failure; alone, after the
fix, it took **424 707 ms and printed the timeout line with NO assertion output at all** — 27 pass /
1 fail over 28 tests. That difference is the verdict: the body is synchronous, so it runs to
completion and bun reports the overrun afterwards, and a run with no assertion line is a run whose
assertion passed. **The live tree carries no dead section anchor; what is left is a timer.** W3-h set that budget against a
206 992 ms cold reading, above the slower of two that disagreed 100x; a concurrent wave is a third
regime again. The number's job is to stop a spurious timeout line, and it does not do that under
wave load — a quiet-tree re-read at close-out is what should set it, not a lane's guess taken while
seven neighbours are compiling.

**What was NOT done, and why it is a decision rather than an omission.** The general fix — slugify tab
titles and admit the ones whose slug is unique on the page, the clause that makes `<Update label>` safe —
needs a corpus-wide non-circular validation and a full `--refresh`, which rewrites the snapshot every
lane's citations are judged against. That is a corpus operation and a gate-shape decision, not a test
fix, and mid-wave it would move eight lanes' verdicts at once.

### RE-OPENED in wave 8, and this lane's share re-closed 2026-09-07 (W7-ah, P6.663): the enumeration ran 1 → 21 → 14 → 1

Per this entry's own rule the match is on the ENUMERATION, never on a count, and the enumeration has
now run 141 → 142 → 145 → 7 → 2 → 1 → 21 → 14 → **1**. Three holders split the 14: the tracker's own
quoted examples (controller, `5ab6d5ae1`), the `packages/shared/**` plus `apps/electron` sites (this
lane, `ad5b600d4` / `56a008ab8` / `ba2c4f3d6`), and the ledger-and-denominator ones (W8-x, W8-doc1),
all three landing within the same hour.

**The one that is left is the tracker itself, at `2026-08-22-runtime-parity-closure.md:4849` — the row
that commissioned this work, quoting the dead anchor it is about.** That anchor has exactly two citers
left: that row, which only the controller may edit, and `server-core/src/handlers/rpc/settings.ts:683`,
whose replacement is verified and identical to the one this lane already landed in
`config/__tests__/config-doctor.test.ts` — the sentence "The line confirms which files Claude Code
read; it doesn't show which file supplied each key." is verbatim on `settings.md`, under the section
"Confirm what loaded", whose id the rendered page publishes and which is in the snapshot. It was not
taken here because that file carried another lane's uncommitted hunks at the time, and a pathspec
commit takes the working tree, not your hunks. **Because the guard reports one citer per anchor, the
finding does not clear until BOTH land** — which is the whole point of the paragraph below.

**The measurement worth carrying, and it changes how this list is read: the guard reports ONE CITER
PER ANCHOR.** A finding list is therefore a floor on SITES, not a census of them. Fixing the single
site a finding names does not clear the finding — it reveals the NEXT file citing the same dead
anchor, and the count barely moves. Four of this lane's six enumerated sites behaved that way, and
every reveal was itself in `packages/shared/**`: the marketplace `headersHelper` anchor had a second
citer in `plugins/__tests__/marketplace-url-credential.test.ts`, the permissions one in
`pi-harness/permission-dsl.ts`, the memory one TWICE in `config/config-doctor.ts`, and the Fable one
in a lane report nobody had enumerated. Six enumerated sites were eight real ones. **Grep the anchor
across the tree before calling a site the last one**, with `git grep -anI -F`.

**Four kinds of rot were in the six, and only one is the "renamed section" the guard's message
assumes.** (1) A pure slug error: memory's too-large section hyphenates `claude` and `md` apart and
two citers did not — anchor only, both quoted sentences already verbatim. (2) A section that never
had an `id` at all: the marketplace table our tier's row sits in is under an `h5`, and only
`h2`/`h3`/`h4` publish ids, so no `--refresh` could ever have minted it; both citers now hang on the
enclosing `h4`. (3) A page SPLIT, one page further on than AGENTS.md's: the shell-command approval
class — "settings that execute shell commands, such as `apiKeyHelper`, `statusLine`, and
`otelHeadersHelper`" — is verbatim-unchanged but now lives on `server-managed-settings.md`, and is on
no part of the settings reference at all, whose 301 sections were checked. (4) A PHANTOM QUOTE, the
class this guard explicitly cannot catch: the permissions cite quoted a `deny` rule as "applied first
and cannot be overridden", words on no fetchable revision of that page. Its two live successors say
what the citer actually needed and say it better — the workspace-trust section states that `allow`
rules and `additionalDirectories` entries grant capability and so wait on the trust dialog, while
"`deny` and `ask` rules aren't affected, since they only restrict", which is exactly the contract
P6.193's compiler branch implements and its test pins.

**The trap this entry already warned about, sprung TWICE more on the lane reading the warning, in its
two different ways.** First: a comment saying "this anchor used to be X and is dead" RE-CREATES the
finding when X is written in its full citation form, because the guard scans every tracked file — and
it does not matter whether the file is Markdown or TypeScript. Two of the six fixes came back red on
the first re-run for exactly that. Then, on the SECOND re-run, a finding for a page named `page`,
pointing at the note added to explain the first: the note had written the SHAPE of a citation as a
placeholder, in the normal one-token form, and the guard cannot tell a stand-in from a real one. That
is the second way this entry already records, and it is worth restating because it is the one that
survives the obvious fix. Both notes now describe the shape in words instead, and every superseded
anchor here is spelled APART: page name and section name in separate spans of prose. It costs a
sentence, and it is the difference between a closed finding and a relocated one. (`check-doc-anchors.ts`
itself uses the placeholder freely and is right to — it is in the guard's own `SELF` list. Nothing else
is.)

**A cheap instrument would have caught all three, in seconds rather than three re-runs.** An offline
check of a chosen file set's citations against the two TSVs the guard already reads takes under two
minutes over `packages/shared` + `apps/electron` (2 504 files, 1 065 citations) where the full-tree
guard took 5 to 18 MINUTES of wall clock under wave load. Its false positives are cheap to read: an
anchor containing a `/` needs the slash admitted to the pattern, and the guard's own
`KNOWN_LIVE_UNDERIVABLE` entry shows up because a naive check does not know that list. Proposed as a
`--paths` flag on the guard rather than a second script.

**Anchors were verified against the RENDERED page, never a slug rule**, per AGENTS.md: `curl` the URL
without the `.md` suffix and grep for `id=`. All eight replacements resolve; the verbatim sentences
were read from the `.md` twin at the same moment. **The budget half of this entry is untouched and
still stands** — this lane's runs took 5–8 minutes of wall clock for under one second of CPU at load
12–15, which is the starvation regime the entry above describes, not a new red.

## `check-generator-faithfulness.test.ts` — still red at `16b34edb1`, still the two generated artifacts

Re-measured 2026-09-03 (W4-c): `bun scripts/check-generator-faithfulness.ts` exits **1** with exactly two
findings, `docs/superpowers/specs/2026-07-30-parity-report.md` and
`docs/testing/parity-wave-verification-checklist.md`, unchanged in kind from the entry above. The parity
report reads every plan's FULL TEXT as a glob, so the wave-4 brief commit alone moves it — the drift is
the documented behaviour of that generator, not a defect in it, and the remedy is P5.4's regeneration on
a quiet tree. **Not a flake and not load-dependent:** the same two, byte for byte, at loads 15 and 25.

The suite's *budget* half is closed: `P2.348` replaced five `git archive` + `tar` extractions per call
with one plus an exact restore, measured interleaved at the same moment over three rounds —
7032/6994/7474 ms before against 3605/3727/4146 ms after, identical verdicts — so the 120 s budget is no
longer the coin-flip the row recorded at 193 s on a busy box.

### Deterministic, red ALONE, and FIXED here (9 failures over 5 files)

Each was red alone in milliseconds-to-seconds, so none is this file's starvation family.

| File | Was | Now | Cause |
| --- | --- | --- | --- |
| `packages/shared/src/agent/__tests__/runtime-capability-drift.test.ts` | 28 pass / **5 fail** | **34 pass / 0 fail** | Three causes, one file. **(a) O31's comment-stripper, twice and in OPPOSITE directions** — `stripCommentsForCounting` ended a template literal at the first NESTED backtick, and an apostrophe in the prose after it (`app's`) then opened a phantom `'…'` that swallowed live code: `codex-agent.ts:2207`'s `writeCodexConfig({` read as absent, and `:2124`/`:2277`'s `this.config.piRuntimeAgentDefinitions` read as absent so `codex-runtime` dropped out of the derived set while `AGENT_DEFINITION_DISPATCH` admits it. The scanner now descends into `${…}` as code; the fixture in *"descends into `${…}` and survives a nested template followed by an apostrophe"* pins both halves. **(b) two `ReviewDiff` probes with no port bound** — `ReviewDiff` is advertised by `SessionToolFilterOptions.reviewDiffPort` and by nothing else (`isOfferedByHostPorts`, and `tool-defs.ts`'s own comment beside `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK` says the gate applies "on every projection"), so a probe that omits the port reads a live tool as a stale name. A separate `widestSurface()` was added rather than folding the port into `claudeSurface()`/`piSurface()`, because the containment rows compare PROJECTIONS. **(c) one single-line source pin** on `getSessionToolDefs({ includeDeveloperFeedback`, which `e21e4a46b` made multi-line by adding the `reviewDiffPort` spread — matched across the line break now. |
| `packages/server-core/src/sessions/__tests__/workspace-browse-mcp-tools.test.ts` | 4 pass / **4 fail** | **8 pass / 0 fail** | The `claude-live-settings.test.ts` shape exactly: a `fakePoolFactory` duck cast `as unknown as McpClientPool`, missing a method the production path grew. `627c7af05` (P3.246) made `WorkspaceMcpPoolRegistry` call `pool.subscribeConnectionVerdictChanged(…)` **at pool creation**, so the duck threw before `sync` was ever reached and all four cases read `{ status: 'refused', reason: 'error' }` out of the registry's fail-soft catch — with `syncCalls.length` at 0, which is what named the site. Stubbed with `hasLeaser`/`dropLeaser`/`notifyRootsChanged` alongside, all four of which the registry calls. |
| `packages/shared/src/agent/__tests__/adjacent-backend-frozen-contract.test.ts` | 6 pass / **2 fail** | **8 pass / 0 fail** (see below) | Two stale goldens, both verified owned-and-emitted before re-freezing. `text_complete` gained `isThinking?` (`a6d56aabc`, produced by `5800696b9`, read on all four event adapters and in `packages/ui/.../turn-utils.ts`). And **P3.272's request/response PAIR** — `denied_paths_request` (`index.ts:551`, sent at `:2670`) and `denied_paths_response` (`:384`, handled at `:5119`, sent from two `pi-agent.ts` sites), `36bf207fe`, round-tripped by `pi-denied-result-paths.test.ts`. **Worth carrying:** the two `expect`s are separate, so the inbound failure MASKED the outbound one and one commit's pair read as two unrelated drifts one run apart. |
| `scripts/check-generator-faithfulness.test.ts` | 6 pass / **3 fail** | 8 pass / **1 fail** | The completeness half worked as designed: `scripts/plan-status.py` was a `.py` in `scripts/` in neither list. It is a REPORTER — it `io.open`s the parity-closure plan and the capability ledger for reading, prints the two axes, and writes nothing — so it is registered in `NOT_GATED` with that reason. **The surviving failure is NOT a test defect and is left:** two generated artifacts have drifted from their generators, `docs/superpowers/specs/2026-07-30-parity-report.md` and `docs/testing/parity-wave-verification-checklist.md`. The parity report reads every plan's FULL TEXT as a glob, so it goes stale on any plan commit (AGENTS.md), and regenerating both is stage 0.1 / P5.3's row on a clean tree. |

### Deterministic, red ALONE, and NOT fixed — findings, with the scope filter applied

Every one of these is a real answer from a live guard, in 0.3–10 ms with an assertion, on a file
whose fix lands outside a test file or requires a per-runtime capability claim.

| File | The assertion | What moved, and why it was not fixed here |
| --- | --- | --- |
| `apps/electron/.../input/__tests__/runtime-capability-drift.test.ts` | ~~`runtime-switch-costs rows match their enforcement sites`~~ | **RESOLVED 2026-09-07 (P6.683, W8-y) — 13 pass / 0 fail over 1 FILE.** All seven named below are grounded, and so is an EIGHTH the entry could not have named: `projectMcpApproval` shipped after the seven were enumerated, which is the standing argument for grounding every row rather than the known-missing ones. Probes, each at the site the row's own docblock names, each with a control that fails when the needle stops measuring: `autoDenialBreaker` (`autoClassifierBlocks` per agent source); `codexReviewer` (`codexAutoReviewEnabled` in the codex config writer — the needle is the SETTING NAME because `auto_review` scores 1 in `pi-agent.ts` and that hit is PROSE); `gatewayFeatureFlags` (INVERTED, and the needle carries its colon because the bare name is a COMMENT in `codex-agent.ts`); `codexBuiltinAgents` (the enforcement site is a 178 MB UNTRACKED vendored binary that exists on no CI machine, so it is derived from the gaps document carrying the verbatim measurement, exactly as `toolMemoryCap` is); `forkSubagent` (the host default reaches only the Pi execution manifest); `subagentModelOrder` (three runtimes, three sources, claude INVERTED on the `_FORCE` gate); `subagentMemory` (both vendor cells INVERTED — the presence of the thing that makes the store a DIFFERENT one); `projectMcpApproval` (a code literal on the claude side, the absence of all three key names on the other). **Two things the entry did not know and the next reader needs.** (1) The file was ALSO red for an unrelated reason: `c324a0b8e` withheld `TodoWrite` from the codex surface (P6.303), which broke the `appActions` mechanism assertion FIRST and hid the derivation failures behind it — the tool is now subtracted from the row's grounds by the name of its mechanism, `SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT`, and measured, it is absent from the PI projection too, so counting it made the row fire on `anthropic → pi` over a tool neither side offers. The sibling `packages/shared/.../runtime-capability-drift.test.ts` was red from the same commit and is fixed in the same pass (41 pass / 0 fail over 1 FILE). (2) The case now carries an EXPLICIT 60 s budget: it reads twenty-odd sources including `SessionManager.ts` and was measured at 24.3 s at load 16 against well under a second at load 1.5, so the 5 s default made its verdict a function of what the rest of the machine was doing. |
| ~~`packages/server-core/src/sessions/SessionManager.orchestration.test.ts`~~ | ~~`never auto-fetches server-controlled MCP resource inventories into Pi startup context` — `Received: ""`~~ | **STRUCK 2026-09-04 (close-out, C-1): 39 pass / 0 fail across 1 FILE at load 18.9.** Fixed by `ba4c1b023`, which did BOTH halves this entry asked for rather than the visible one: the anchor was re-spelled to `const piContextResources = runtimeReadsComposedInstructionContext(provider)` (P2.451's replacement), AND an `expect(composition.length).toBeGreaterThan(100)` was added AHEAD of the two claims it protects. The second half is why this is struck rather than merely green — the original defect was a vacuous PASS on the sibling `not.toContain('listContextResources')`, and a re-anchor alone would have restored the visible failure while leaving nothing able to tell a re-anchored pin from a dead one. |
| `packages/server-core/src/sessions/__tests__/claude-worktree-port-binding.test.ts` | `binds claudeWorktreePort on the backend config, gated on anthropic` | Same shape as the three `pi-harness-baseline` pins: the pinned single line became a multi-line ternary at `SessionManager.ts:17711`. The subject never moved. One-line re-pin, on W2-l's file's text. |
| `packages/shared/src/agent/__tests__/denied-path-line-terminator.test.ts` | `the two deny-path calls cross and the grant call stops` — expects `globToRegex(pattern, 'stop')` | A source pin on a call whose spelling moved; the received text is `matchesAllowedWritePath`'s body, i.e. the right file. `pi-harness/` is W2-u's zone. |
| ~~`packages/shared/src/agent/__tests__/claude-tool-search-observability.test.ts`~~ | ~~`the claude event adapter reads neither block, and still reads the ones it knows` — `not.toContain('getContextUsage')`~~ | **STRUCK 2026-09-04 (W5-j, P3.357): 8 pass / 0 fail, 1 FILE. And the diagnosis on this line was FALSE — worth keeping, because acting on it would have written a false product claim.** It was not an absence a landed commit filled. All four `getContextUsage` mentions inside `backend/claude/` are COMMENT lines (three docblock, one `//`); the pin broke on prose, not on a read. The one real call site is `refreshSdkContextWindow` in `claude-agent.ts` — one directory up and outside this test's `readdirSync` scope — and it consumes a DIFFERENT surface: `applySdkContextUsage` reads only `model` and `rawMaxTokens`. The three fields P2.457 is about (`categories[].isDeferred`, `mcpTools[].isLoaded`, `deferredBuiltinTools[].isLoaded`) are read NOWHERE in our source, measured repo-wide, the only other hits being Pi's unrelated `isDeferredMcpCandidate` and a renderer avatar's React state. So flipping to `toContain` would have PASSED on a docblock and recorded that the claude event adapter reads `getContextUsage` when it does not. Fixed by re-spelling that ONE pin as a CODE match (comment-only lines dropped) — P3.256's precedent verbatim — plus a control asserting the prose still exists so the pin cannot be satisfied by deleting the explanation, and a second control that the comment stripper leaves real code behind. Its two siblings (`tool_search_tool_result`, `server_tool_use`) are absent in EVERY form here and keep the stronger `not.toContain`; the codex adapter remains the only other file speaking `server_tool_use`, re-verified. |
| `packages/shared/src/agent/__tests__/read-deny-binds-edit-and-write.test.ts` | `DIVERGENCE: a Read ALLOW also grants Edit and Write, which the page does not say` — `Expected "allow", Received "no-match"` | The divergence this row RECORDS was removed on purpose: W2-e's P3.214 took out the `Read`-allow widening. So the test is now the only thing asserting the old behaviour. Updating a recorded-divergence row is a statement about the product's posture; W2-e owns it. |
| `packages/shared/src/agent/__tests__/base-agent.test.ts` | `CONTROL: an unmetered runtime that DID price a turn is not unenforceable` — `sessionCostUsd` expected 3, got 0 | A control, which is the worst place to have a red: it is what proves the row above it is not vacuous. Cost accounting is W2-i's (P2.258, P3.98/P3.122). |
| `packages/shared/src/agent/__tests__/codex-permission-profile-verification.test.ts` | `accepts, and says so, when the profile is in force` — the `codex permission profile "…" accepted` debug line is not emitted | An observability assertion, not a gate one: the accept path no longer says so. `codex-agent.ts` is W2-s's. |
| `packages/server-core/src/sessions/SessionManager.agent-view.test.ts` | `orders, paginates and redacts …` — page 1 item 0 is `session-c`/`idle`, not `session-a`/`needs_input` | An ORDERING change in the agent view, which is a product claim on W2-l's file. |
| `packages/server-core/src/sessions/__tests__/connect-on-startup.test.ts` | `policy ON (default): a fresh session connects its workspace servers before any send` | T10's own guard. Reproduced alone at 9.4 ms. Sits on the same `WorkspaceMcpPoolRegistry` surface `627c7af05` changed; not the same duck (this file's stub differs), so it needs its own read. **CLOSED 2026-09-04 (W5-d, P3.356): read, and it was the GUARD and not the product.** `627c7af05` (P3.246) made the registry subscribe to connection verdicts AT POOL CREATION, so this file's duck threw `pool.subscribeConnectionVerdictChanged is not a function` from `lease()` before `sync` was ever reached — reproduced red at HEAD, deterministic, 61 ms. The duck now carries that method AND `notifyRootsChanged` (unreachable from `lease`, added so the next arrival does not break it one call deeper), and the case no longer stops at re-anchoring: it asserts the sync it saw was the SESSION-START one — one pool, for this session's workspace root, under the registry's `browse:sha256(workspaceId)` leaser id. Green with a complete duck, so the default-ON connect-at-session-start policy is NOT regressed. Two mutants in `workspace-mcp-pool-registry.ts` (the browse leaser id; the resolved workspace root) each take it red, with a no-op dead control green first and a post-hoc hash back at baseline. |
| `apps/electron/src/main/handlers/__tests__/registration.test.ts` and `registration-profiles.test.ts` | `unexpected` channels: `notification:getSettings`, `notification:setSettings` | **Two RPC channels are registered that the declaration table does not declare** — the same both-lists-must-agree shape as `lspServers` in AGENTS.md. Which side is authoritative is a wire-surface decision (either the declaration gains the two, or the handlers stop registering them), and it is in nobody's declared stage-2 zone. Reproduced alone, 1.2–1.8 ms, two independent files. | **CLOSED 2026-09-03 (W3-f, `0b6f3eada`, P3.317): declared; both files green at HEAD.**

### Green alone — starvation or cross-file, in this run only

| File | Alone | In the full run |
| --- | --- | --- |
| `packages/shared/src/mcp/__tests__/client-transport.test.ts` | 20 pass / 0 fail, 0.6 s | 1 fail at 5.7 ms — a millisecond assertion, so NOT the starvation shape; unresolved, and the likeliest reading is a cross-file interaction like the pdfjs class rather than load. | **RESOLVED 2026-09-03 (W3-h, `202e8558f`): `home-latch.test.ts` deleted `process.env.HOME` and never restored it — the whole run lacked a HOME; restore fixed, 32/0.**
| `packages/shared/src/config/__tests__/claude-vendored-sdk-contract.test.ts` | 6 pass / 0 fail, 0.6 s | 1 fail at **15 026 ms** against a 5 s budget — starvation. |
| `packages/shared/src/agent/__tests__/powershell-cmdlet-gate.test.ts` | 8 pass / 0 fail, 5.5 s | 1 fail at **16 468 ms** — the pwsh-spawn shape this file already documents: past `parseCommand`'s own 10 s `spawnSync` ceiling the extractor answers `null` and it reads as an ordinary assertion failure. Its own `LIVE_TIMEOUT` is 120 s, so it is not a bun budget. |
| `packages/shared/src/config/__tests__/preferences-ui-language.test.ts` | 15 pass / **1 fail**, 20.5 s | 1 fail at 15 394 ms. **Red alone too** — carried here rather than in the fixed table because its single failure is `resolveTitleLanguageName` returning an auto-detect answer for an explicit English UI language, which is a product read on `config/`. |
| `apps/electron/.../app-shell/__tests__/SessionMenu.test.tsx` | 1 pass / 0 fail | `(fail) (unnamed)` at 66.6 ms |
| `apps/electron/.../app-shell/__tests__/PendingAuthNotice.test.tsx` | 14 pass / 0 fail | 1 fail at **12 143 ms**; the file's own docblock already names the pdfjs specifier as its hazard. |
> **SHARPENED and RESOLVED 2026-09-18 (D1.110, `97a427dce`, WI-w).** Not "green alone": the file was RED alone at HEAD (17 925 ms against the default per-test timer, a module-graph cost); the budget is now sized against the measured floor with the zero-case control quoted beside it. 2 pass / 0 fail across 1 file after.


### The three real-server e2e suites — red alone at load 10, and no quiet arm was obtainable

| File | Alone | Reading |
| --- | --- | --- |
| `packages/pi-agent-server/src/tools/bash-auto-background-real-server.test.ts` | 0 pass / 1 fail, **81 840 ms** at load 11.4 | The `1s` timeout transition never fired — the command completed (`tick-0`…`tick-7`) instead of being moved to the background. An 81 s wall clock for a 1 s deadline is the box, but the assertion is about a DOCUMENTED transition, so this is not classifiable without a quiet arm. |
| `packages/pi-agent-server/src/tools/bash-timeout-input-real-server.test.ts` | 1 pass / 1 fail, **82 609 ms** at load 10.0 | `Expected "background", Received undefined`. This is the suite whose vacuous-wait defect was diagnosed and fixed on 2026-08-14 (see the long entry above); the fix is not what is failing — nothing was waited for at all. |
| `packages/pi-agent-server/src/__tests__/pi-runtime-cwd-transaction.test.ts` | 0 pass / 1 fail, **1 931 ms** at load 10.0 | The register's long-standing intermittent, whose own entry says a solo failure is "unresolved rather than proof". Four historical readings are 1/3, 2/3, 3/4 and now 0/1. |

All three spawn a real child Pi server. Load on this box never fell below 9.6 for the whole window,
so the separating control AGENTS.md prescribes — the same batch at two load extremes — could not be
taken. **A red from any of the three at load ≥ 9 is no reading.**

### `lint:conditional-expect` — a genuine new red, and the inverse of the entry above it

The `STRUCK` entry above is about a reading over two UNTRACKED files. **This is not that.** Both
flagged files are TRACKED and CLEAN, and the three hits were added by two landed commits that did
not re-record the baseline: `8a44d24bc` (`powershell-cmdlet-gate.test.ts:142`) and `989ff839c`
(`claude-vendored-sdk-contract.test.ts:174` and `:215`). Read in full, all three are the checker
header's own legitimate shapes and none is the defect it hunts:

| Site | Shape | Why |
| --- | --- | --- |
| `powershell-cmdlet-gate.test.ts:142` | **(c) environment gate** | `isPowerShellAvailable()` is a tool-present probe. Asserting its value would assert the rig; the `it()` immediately above it is the declared control and asserts its TYPE. |
| `claude-vendored-sdk-contract.test.ts:174` | **(c) environment gate** | `existsSync(binaryPath)` — the shape the header names by example. Only the host platform's binary package is installed, and the block asserts the discriminator inside itself before returning. |
| `claude-vendored-sdk-contract.test.ts:215` | **(b) documented two-outcome acceptance** | `atLeast(shippedVersion, REQUIRED_VERSION)` is the contract: BOTH branches assert, with the version the page names quoted at the line, so there is no branch in which the assertion vanishes. |

Accepted with `--update-baseline` rather than rewritten. **And one trap collected on the way:** a
backgrounded `bun scripts/check-conditional-expect.ts --check; echo "REAL_EXIT=$?"` reported the
wrapper's exit **0** on the line after printing `REAL_EXIT=1`. Read the command's own `$?`, never
the harness's — the third member of the `&&`-chain / pipefail family AGENTS.md lists.

## Five more load-fragile suites, and why "flaky" is the wrong word for four of them (P2.240, W3-e, 2026-09-03)

Each of these was measured by a lane that nearly attributed it to its own diff.
They are collected here rather than as five one-line rows because they share one
property that a list of file names does not carry: **a single run cannot
attribute a failure in any of them.** An entry that only names the file leaves
the next lane to re-spend exactly what the last one spent proving the red was not
theirs — which is the cost this section exists to stop, and the argument for
recording them before the next wave rather than at close-out.

| Suite | Shape | What a single run cannot tell you |
| --- | --- | --- |
| `packages/shared/src/agent/__tests__/pi-agent-guardian-consult.test.ts` | **0 to 4 failures, a DIFFERENT set each run, always 30 s timeouts** | Measured five times by P2.85's lane, and decisively: the failures appear **on the parent commit as well as the changed one**. Run A alone showed 3 failures with the lane's fix and 0 without — which **would have convicted an innocent diff**; reversing the order showed the *parent* implementation producing the worst result of all five runs. |
| `packages/shared/src/agent/__tests__/codex-permission-rules.test.ts` | 4 failures at bun's 5 s default | **40 pass / 0 fail** for the same code at `--timeout 30000` (x1). Already named in *"The three permission suites' 5s timeouts under lane contention"* above; repeated here because that section is about a broad-directory run and this reading is about the file alone. |
| `packages/shared/src/agent/__tests__/codex-permission-floors.test.ts` | 4 failures at bun's 5 s default | Same measurement, same pair (x1). The file appears above only as a *green* row in P2.419's readings table, so a lane hitting it red found nothing that said "known". |
| `packages/server-core/src/sessions/__tests__/codex-callback-bridge-host.test.ts` → `monitor/start goes through T2's gate` | load-flaky with **`ECONNRESET`** | Not a timeout, so it does not match any shape this file described before. Same family regardless: it needs a second run in the other order before it means anything. **SCOPE CORRECTED 2026-09-10 (W9-bq, P6.801): this row is about ONE CASE and an `ECONNRESET`, and it does NOT describe the whole-file red that lane met — a `beforeAll` with no budget dying on bun's 5 000 ms default, which reports `0 pass / 1 fail` and runs no case at all. A lane meeting THAT and finding this row would conclude, wrongly, that the file was known-flaky under load. That second shape was deterministic, not flaky, and is fixed rather than registered — see the entry below.** |
| `packages/server-core/src/sessions/runtime-switch.test.ts` → `gatewayDpCredentialsPresent` | a **5000 ms limit against 14.9 s under batch load** (P2.283) | Timeout-fragile, and it will keep manufacturing failures for any lane that BATCHES it — the file is quick alone (39 pass / 0 fail in 2.71 s, lock held, load 12, 2026-09-03). Batching is the condition, not the file. |

**The entry rule these five share, and it is the entry, not a footnote:** *a
single run of this file cannot attribute a failure; run it twice, in both orders,
and compare against the parent commit.* Filing any of them as merely "flaky"
loses the only instruction that makes the red actionable.

### Two that are NOT in the table, because they were fixed rather than registered

Recorded so the next lane does not go looking for entries that should not exist:

- `loop-skill-runtime.test.ts` collapsed under load into a fake
  `(unnamed) hook timed out`, and **HEAD's own unmodified copy failed
  identically** — which is how the lane cleared itself. Root cause was a
  `beforeAll` importing the **1.3 MB** `SessionManager.ts` past bun's 5 s
  default; fixed in-file with an explicit budget and the measurement written
  into a comment beside it. This is the *"a single module import in one hook"*
  shape AGENTS.md now names, not contention.
- The three `PowerShell plans folder exception` assertion failures: retired
  2026-08-27, and the section above records both why hunting for the retired
  entry reads like finding a phantom and why the family it named was wrong.
- `codex-callback-bridge-host.test.ts`'s whole-file red (P6.801, W9-bq,
  2026-09-10) — the SAME shape as `loop-skill-runtime.test.ts` above, in the
  same directory, and it is the third member of that family. Its `beforeAll`
  body is one `await import('../SessionManager.ts')` and it carried NO budget
  argument at all. **Measured ALONE on a quiet tree at load 7.5**, which is what
  makes it deterministic rather than flaky: the zero-case control
  (`-t` matching nothing) prices the file's STATIC graph at **55.86 s with 0
  cases executed**, user 1.70 / sys 1.08 — 5 % cpu, so I/O — and the full run
  is **59.44 s wall, `0 pass / 1 fail`**, the junit body carrying
  `time="5.0024"` and `<failure type="TimeoutError" />`. Fixed in place with
  `MODULE_GRAPH_HOOK_BUDGET_MS`, not registered. Two things worth carrying:
  bun's message names a `beforeEach/afterEach` hook and this file declares
  neither, so the output alone points at the wrong hook family (AGENTS.md's own
  misnomer trap); and the register's ECONNRESET row above describes a DIFFERENT
  failure of the same file, which is why that row now says so in its own text.
- `packages/shared/src/agent/__tests__/floating-emission-escape.test.ts`
  (P6.782, W9-bq, 2026-09-10) — **24 pass / 7 fail cold at 1 997 s, every
  failure a timeout with zero assertion failures**, and it was in no entry here.
  It is NOT the module-graph family despite looking like it: the zero-case
  control returns **15.32 s with 0 cases executed** (user 0.71 / sys 0.42) and
  junit puts the file at **1 489.09 s** with **1 473.71 s inside the 31 bodies**
  — the graph is 1 % of the run, and every case pays a `bun run` CHILD whose own
  cold graph is the cost. The per-case budget was **180 000** against a probe
  child measured at **234 s cold** (P2.335), i.e. below its own floor, so which
  cases went red was decided by which side of the timer they landed on. Fixed
  rather than registered: one file-level `PROBE_CASE_BUDGET_MS = 600_000` (2.6x
  the largest observed per-case cost) replaces 24 copies of the old literal, and
  the one case that ran FIVE probes in a single body — junit **249.45 s**
  against ~51 s for its siblings — became five cases of the ordinary size, so no
  case needs a budget five times its neighbours'. 31 pass / 0 fail across 1 file
  on the quiet arm at load ~11 before the change; the split makes it 35.

### The production ceiling this section keeps pointing at is still 10 s, on purpose

`parseCommand`'s own `spawnSync` ceiling was deliberately left at 10 s by P2.219:
**raising it hides a real hang and lowering it manufactures more failures**, and
a user's shell validation must not hang for 30 s. So the register's duration rule
is a *human* discriminator and remains one until the expiry says what it is —
a distinct failure the reader cannot mistake for a wrong answer. That change is a
product change in the validator, tracked by P2.240 and **not** made here.

## `storage.test.ts` walks the DEVELOPER'S OWN `~/.agents/skills`, so its runtime is a property of the machine (W4-f, recorded by the close-out lane 2026-09-04)

`packages/shared/src/skills/__tests__/storage.test.ts` ▸ *"loadAllSkills > should load
workspace and project skills alongside any existing global skills"* times out at 5000 ms —
7731 ms in a five-file batch, 12451 ms alone.

**Machine-dependent AND load-dependent, and the first word is the one that matters.** The rig
calls `getExistingGlobalSlugs()`, which reads the developer's real `~/.agents/skills`.
Measured on this box: a **cold** `loadAllSkills` over those 73 real skills (804 KB) costs
**8491 ms** at load 26, while two warm repeats cost **123 ms and 154 ms** — identical code
path, so the cost is cold page-cache I/O, not logic. Nothing in the change that surfaced it
(one `??` in front of a call that already ran) touches the duration.

**This is the P2.455/P2.461 family one layer further out**: not a rig whose CONTENT depends on
the machine, but a rig whose RUNTIME does. So the duration rule that discriminates the
starvation family cannot settle this one — a colleague with four skills never sees it and a
colleague with four hundred sees it every run, at any load.

**The fix is the seam, not a bigger budget.** P2.461 already gave the loader one:
`loadAllSkills(root, project, { adminSkillsDirs: [] })` plus a fixture global root removes the
real home from the measurement entirely. Raising the budget instead would pin a number that is
a property of whoever runs it, which is the shape this register exists to stop.

---

## The close-out gate, 2026-09-04 (C-2, 1.34.0)

`bun test` on the final tree: **21 889 pass / 62 fail / 61 skip / 1 todo over
22 013 tests in 1 650 FILES, 5 640 s**, load 6.9–7.7 throughout. The file count is
the reading that matters — a green run over fewer files is indistinguishable from
a green run over all of them, which is why it is quoted beside the pass count.

Every one of the 62 was attributed, and the population is **20 files**, not 62
independent defects. Four classes:

### (a) Mine, fixed in this close-out — 27 lines over 3 files

| File | Cases | What |
| :-- | --: | :-- |
| `SessionManager.orchestration.test.ts` | 1 | P3.374's emitter fires the model-switch pair around the model commit, so the fixture sees FIVE events, not three. The expectation now pins the ORDER (Pre before the write, Post after), which is the property worth holding. |
| `lifecycle-bridge.test.ts` | 1 | Two assertions, one case: the pair joined the shared inventory (`REQUIRED_HOOKS`) and `PreModelSwitch` joined the decision-bearing set. Both rosters are projections of `AGENT_EVENT_CONTRACTS_V1`; neither is this bridge's own emission list. |
| `check-generator-faithfulness.test.ts` | 1 | The parity report drifted again AFTER its regeneration, because the sitting page this close-out added is itself an input to the report's citation census. Regenerated; `--check` is clean. |

### (b) A stale test double, pre-existing at `fdade6f3a`, fixed in place — 25 cases, ONE line

`non-pi-projection-host-side-fields.test.ts` builds a `piProcessSupervisor`
double by hand. `07e047eaa` added a production call to
`piProcessSupervisor.listRunning`; the double was not extended, so
`getPiHarnessRuntimeSnapshot` threw *"listRunning is not a function"* and took 25
cases with it. **Not a product defect** — `ProcessSupervisor.listRunning` exists
and delegates to the store exactly as `countRunning` does. Fixed by adding the
method to the double, with the attribution written at the site. 30 pass / 0 fail
after.

### (c) STARVED, and the control is decisive — 27 cases over 6 files

`user-settings-strict-report.test.ts` (10), `openai-compat.test.ts` (8),
`respond-to-bash-commands.test.ts` (2), `session-mirror-settings.test.ts` (2),
`cron-scheduler.test.ts` (1), `powershell-cmdlet-gate.test.ts` (1),
`PendingAuthNotice.test.tsx` (1).

Every one of these spawns a real subprocess and every failure is a **timeout with
zero assertion failures**. The separating control AGENTS.md asks for was run and
it separates cleanly:

| run | budget | result |
| :-- | :-- | :-- |
| the three config files, alone, load 6.9 | bun's 5 000 ms default | **3 pass / 14 fail** |
| the same three, alone, load 6.5, minutes later | `--timeout 60000` | **17 pass / 0 fail** |
| the four singletons + `openai-compat`, alone | `--timeout 60000` | pass |

So the code is right and the DEFAULT is wrong for a case that spawns a child on
this box: one `bun -e` child costs 5–10 s here. **Registered rather than budgeted**,
deliberately: a budget must be set against a measured floor, the floor is a
property of the machine (the same reasoning the `storage.test.ts` entry above
records), and none of these files is in this lane's zone. Whoever owns them should
give each an explicit budget with the measurement beside it — not raise the global
default, which would hide the starvation class this register exists to name.

### (d) Real, pre-existing, and NOT flipped here — 3 cases over 3 files

- `codex-cost-declaration.test.ts` ▸ *"keeps saying it about the RUNTIME, so a
  decorated turn still uses the per-turn wording"*. Production now emits the
  PERMANENT wording (*"this runtime does not report spending at all"*); the
  assertion still expects the per-turn sentence. Attributed to **`90fbcfc1e`**
  (pre-existing at `fdade6f3a`, verified with `merge-base --is-ancestor`). The
  test's OWN comment predicted this: *"this assertion is expected to change to the
  permanent wording, and its green is not a reason to leave it alone."* Not flipped
  here, because flipping an assertion writes a product claim (P2.457's lesson) and
  the file is in no lane's zone.
- `base-agent.test.ts` ▸ *"CONTROL: an unmetered runtime that DID price a turn is
  not unenforceable"* — expects the session cost to be 3, gets 0. Same family
  (`8bfb12497` / `90fbcfc1e`, both pre-existing): a runtime that reports no cost
  now counts nothing, and the CONTROL was written against the older behaviour.
  Same reason for not flipping it.
- `pi-runtime-cwd-transaction.test.ts` ▸ *"keeps PREPARE private, refreshes
  generation auth, and restores a failed COMMIT"* — **73 355 ms against a 60 000 ms
  budget**, so it is NOT class (c): raising the budget did not save it. It needs
  profiling, not a number.

`check-doc-anchors.test.ts` ▸ *"the live tree"* is the fourth, and it is the
known network suite (P3.318, ~420 s of live requests); it is red on any box
without the network the anchors live on, and `check-minified-citations.test.ts`
(P3.309's binary probe) is the fifth of the same shape.

## `claude-setup-import.test.ts` — class (c) STARVED, and it now carries a budget instead of a red (P6.625, W7-ab, 2026-09-06)

`packages/shared/src/capabilities/__tests__/claude-setup-import.test.ts`. Registered here because
the two readings that first surfaced it are the exact signature this register exists to name, and
because the remedy landed with the entry: the file sets `setDefaultTimeout(60_000)` and the reason
is written above the call.

### The readings, all four, with the load beside each

| Condition | Load (1 min) | Result | Whole file |
| --- | --- | --- | --- |
| alone, `--timeout 60000` (W7-u, after P6.442 added 6 cases) | 13.29 | **45 pass / 0 fail / 1 file** | 19.33 s |
| alone, bun's 5 000 ms default (W7-u) | 13.29 | **40 pass / 5 fail / 1 file** | — |
| alone, bun's 5 000 ms default (W7-ab, cold graph) | **14.13** | **45 pass / 0 fail / 1 file** | **22.67 s** |
| in a four-file batch with three `capabilities/__tests__` siblings, default budget, warm graph | 12.12 | **105 pass / 0 fail / 4 files** | **2.09 s** |

All five failures in the second row were **timeouts with ZERO assertion failures**, and every one of
them was a PRE-EXISTING case (instruction / mcp / hook / conflict / idempotency) rather than one of
the six the same commit added.

### What the four rows say together, and it is not "flaky"

The third row is the one that changes the diagnosis. At a HIGHER load than the red reading, alone,
on the SAME default budget, the file is green — and the fourth row runs the same suite plus three
others in **2.09 s** once the module graph is warm. So the cost is the **cold import**, not any one
case and not the box being busy: a 22.67 s cold total against a 5 000 ms per-test budget means a red
is decided by where the transpiler happens to yield, which is `context-usage-after-switch.test.ts`'s
mechanism (P3.180) on a different suite. Reading a fail COUNT here tells you about the cache, not
about the code.

That is also why the remedy is a **budget** and not a row saying "expect five reds": the reds are
not reproducible on demand, so a register entry alone would rot into a phantom the next reader
cannot confirm. 60 s is the budget the file was measured green under, and ~2.6x the 22.67 s cold
floor — set against a measurement, never zero, and never by raising the global default, which would
hide the whole class.

### `native-sources.test.ts` is the same family, measured on the same rig, and has NO budget yet

Recorded here rather than fixed, because it is a second subject: in a three-file batch at load 7.84
`packages/shared/src/capabilities/__tests__/native-sources.test.ts` gave **59 pass / 1 fail / 3
files**, the single fail being *"a dropped layer is PROBED, not consumed — a later import of the
same file still loads"* timing out at 5 000 ms with no assertion failure. Alone at `--timeout 60000`,
load 9.66: **46 pass / 0 fail / 1 file** in **23.32 s** — the same cold-import shape and almost the
same floor. Whoever next owns that file should give it the same explicit budget with its own
measurement beside it.

## `sources-management-registry.test.ts` — red at HEAD, red ALONE at low load, and NOT caused by the change that found it (W9-t, P6.745, 2026-09-08)

> **RESOLVED 2026-09-08 by W9-an (P6.844) — GREEN, and the remedy was not a budget.**
> `bun test apps/electron/src/renderer/playground/__tests__/sources-management-registry.test.ts`
> now reports **6 pass / 0 fail, Ran 6 tests across 1 file [20.5 s, load 9.46,
> 0.70 s user / 0.36 s sys]**, against `0 pass / 1 fail` and zero cases executed on the
> same command an hour earlier at load 9.08. The entry below asked whoever next owned
> `playground/` to take a quiet-tree reading of the `beforeAll` and give the file its own
> `setDefaultTimeout`; the smaller answer was to stop loading the module graph it was
> timing. The suite reached the `@nessy-agent/ui` BARREL through
> `playground/registry/entity-lists.tsx`, and the barrel's own graph ends at the Vite-only
> `pdfjs-dist/build/pdf.worker.min.mjs?url` specifier bun cannot resolve — which is why the
> file carried two `mock.module` stubs, a `DOMMatrix` shim and three dynamic imports inside
> the hook. `entity-lists.tsx` now takes `Spinner` and the tooltip trio from their own
> subpaths, the carve-out is deleted and the three imports are static top-level ones, so the
> graph loads at FILE LOAD, outside bun's 5 000 ms per-test timer. No budget was added.
> The reading below stays as the diagnosis it was.


`apps/electron/src/renderer/playground/__tests__/sources-management-registry.test.ts`. Found while
gating P6.745, which puts `SourceStatusIndicator` on `SourceAvatar`'s pip and therefore adds one
module to this suite's import graph. The obvious conclusion — "the new import broke it" — is wrong,
and the control says so.

### The three readings, with the load beside each

| Condition | Load (1 min) | Result | Hook time |
| --- | --- | --- | --- |
| six-file batch, working tree WITH the P6.745 edit | ~10 | **69 pass / 1 fail / 6 files** | 95 744 ms |
| alone, working tree WITH the P6.745 edit | 9.36 | **0 pass / 1 fail / 1 file** | 52 324 ms |
| **alone, both edited files written back to HEAD content** (the control) | 10.88 | **0 pass / 1 fail / 1 file** | 24 511 ms |

Every failure is the same one: *"a beforeEach/afterEach hook timed out for this test"* with **zero
assertion failures** — and the hook is really a `beforeAll` (bun prints the same message for the
`beforeAll`/`afterAll` family, the misnomer AGENTS.md §Traps records).

### What the control settles, and what it does not

**It settles blame.** At HEAD content, at a HIGHER load, alone, the suite still fails: 24.5 s of
`beforeAll` against bun's 5 000 ms default. The red is pre-existing, not P6.745's.

**It does not exonerate the change.** The same hook cost 52.3 s with the extra module — roughly
double — and that is a real cost even though it changed no verdict. The hook does three dynamic
imports of playground registries plus the row list; one more component in that graph is measurable.
Both numbers are single readings on a loaded box, so the ratio is indicative, not a measurement of
the module's cost.

### The remedy is a BUDGET, and it is deliberately not set here

This is the class §`claude-setup-import.test.ts` above already diagnoses: a cold module graph
against a per-test timer. The documented fix is an explicit budget set against the measured floor.
It is NOT applied here because the floor observed so far spans **24.5 s to 95.7 s** across three
readings, and a budget picked from that range would be a guess wearing a measurement's clothes —
the failure mode the neighbouring entries were written to stop. Whoever next owns
`apps/electron/src/renderer/playground/` should take a quiet-tree reading of the `beforeAll` and
give the file its own `setDefaultTimeout` with that number beside it.

Restore discipline for the control run: both files were copied to a scratch path first, written back
from `git show HEAD:<path>`, and restored by copying the saved bytes back — with `shasum -a 256`
matching the pre-control hashes on both files afterwards. No `git checkout --`/`restore`/`stash` was
used on any file.

## `apps/cli/src/plugin.test.ts` — a red beside a concurrent run whose stated CAUSE is refuted (P6.626)

**Observed 2026-09-06 (W7-u):** `apps/cli/src/plugin.test.ts` beside a background `bun test` gave
**32 pass / 4 fail** with three `ENOENT`s raised from `computeNormalizedBundleHash` walking the staged
bundle, then **36 / 0** twice when run alone. The row born from it (P6.626) proposed that the defect was
a FIXED staging path under the config directory shared by two `bun test` processes, and the controller's
decision was: *fix the race if it is a shared staging path, else register.*

### It is not a shared staging path — read at HEAD, every site

| Site | Path |
| --- | --- |
| `plugins/source-resolver.ts` `createPluginStagingArea` | `mkdtemp(join(base, 'nessy-plugin-stage-'))` |
| `plugins/acquisition.ts` repository extract | `mkdtemp(join(staged.stageDirectory, 'repository-extract-'))` |
| `plugins/store-v2.ts` repair | `` `${cachePath}.repair.${randomUUID()}` `` |
| `plugins/store-v2.ts` retire | `` `${cachePath}.retired.${randomUUID()}` `` |
| `plugins/store-v2.ts` install | `` `${cachePath}.staging.${randomUUID()}` `` |
| `plugins/adapter-migration.ts` | `mkdtemp(join(tmpdir(), 'nessy-plugin-adapter-migration-'))` |

Every one is unique per call. The suite's own roots are unique too: `plugin.test.ts` builds a fresh
`mkdtempSync` directory per `beforeEach` and passes `baseTempDir: join(dir, 'staging')` and
`rootDirectory: join(dir, 'plugins')` explicitly, so it never touches the config dir at all — and
`bunfig.toml`'s `[test]` preload points `NESSY_CONFIG_DIR` at a private temp directory per PROCESS
anyway. There is no fixed shared path to fix, and no sweeper: `nessy-plugin-stage` appears in four files,
one of them the creator and three of them assertions.

### And it did not reproduce at HEAD

Measured 2026-09-08 (W9-j), the suite now at **46 cases**:

| Condition | Result | Wall | Load |
| --- | --- | --- | --- |
| alone | 46 pass / 0 fail | 68.48 s | 6.74 |
| beside one concurrent `bun test packages/shared/src/plugins/__tests__/` | 46 / 0 | 76.60 s | — |
| beside two concurrent suites (`plugins/`, `capabilities/`) | 46 / 0 | 139.88 s | — |

`1.52 s user / 1.40 s sys` against 68.5 s wall on the solo run — **4 % cpu**, the I/O signature of the
module-graph family this file already documents, not the contention one.

### So what this entry records is a refutation, not a flake

Three things a later lane needs, and the third is the point:

1. **The proposed cause is measured false.** Do not "fix the shared staging path"; there is none.
2. **The failure is not reproducible at HEAD** under deliberate concurrency, at two load levels. The
   suite grew from 36 to 46 cases in between, so something in that span may have closed it — most
   plausibly W7-aa's P6.622, which is the change that freed this file.
3. **A count is not an identifier.** W7-u's *32/4* and *36/0* are both counts of a suite that no longer
   has that many cases, so a lane meeting *"46 / 2"* tomorrow cannot match it against either number. If
   this recurs, record the CASE NAMES and whether the `ENOENT` path is still inside
   `computeNormalizedBundleHash` — that is the one detail from W7-u specific enough to be re-checked, and
   it is what would separate a real cross-process race from an `afterEach` `rmSync(dir)` overtaking async
   work that outlived its own `it()`.


## The wave-9 gate's whole-repo run, 2026-09-10 (W9-bq) — 153 failures, and only three of them survive being run alone

`rm -rf release && bun scripts/bun-test-lock.ts run --label W9-bq -- bun test`, the
mutex held, the tree QUIET (no other lane running, `git status` empty):

> **25 824 pass / 153 fail / 1 error, 6 snapshots, 95 485 expect() calls, Ran 26 054 tests
> across 2 029 files. [5 894.95 s]** — `user 723.68 / sys 220.02` against 98 minutes of wall,
> **16 % cpu**, which is the whole-run signature this file keeps describing: I/O, not CPU.

**Read the FILE COUNT, and read the shape before the number.** The 153 land in 79 files, most
of them one or two apiece, and the classification instrument is one run of the file ALONE — a
pass alone is a pass whatever the load, so it needs no quiet window to be decisive. Eight files
were sampled, chosen as the largest clusters:

| file | in the whole run | ALONE | verdict |
| --- | ---: | --- | --- |
| `agent/__tests__/codex-mcp-elicitation.test.ts` | 14 | 37 pass / 1 fail, 61.10 s | 13 cross-file, 1 real |
| `sessions/__tests__/background-result-delivery.test.ts` | 11 | **17 pass / 0 fail**, 186.88 s | cross-file |
| `model-fetchers/__tests__/openai-compat.test.ts` | 8 | **32 pass / 0 fail**, 31.73 s | cross-file |
| `sessions/__tests__/agent-config-budget-anchors.test.ts` | 7 | **7 pass / 0 fail**, 114.61 s | cross-file |
| `markdown/__tests__/official-markdown-math-foundation.test.ts` | 5 | **6 pass / 0 fail**, 46.80 s | cross-file |
| `i18n/__tests__/locale-parity.test.ts` | 3 | 4 pass / **3 fail**, 14.23 s | **REAL** |
| `config/__tests__/validators-stored-config.test.ts` | 3 | 20 pass / **3 fail**, 12.62 s | **REAL** |
| `agent/__tests__/instructions-loaded.test.ts` | 4 | 2 pass / **4 fail** | **REAL** |

**23 of the 153 carry one message**, `providerTypeToAgentProvider: no arm for runtime "nessy"`,
spread over eleven `server-core/src/sessions` files — and the two largest of those (33 and 15
occurrences) are **green alone**. That message is therefore a symptom of the cross-file class,
not a missing arm: `factory.ts`'s switch throws by design on an unclassifiable runtime, and
something in a whole-repo run is handing it one.

### The ones that were REAL and deterministic — ALL THREE now landed (W9-cc)

Each failed ALONE at load 7–8, which by AGENTS.md's two-cause rule settled it: not starvation.
**The table above is the record of that run, not an open list.** Nothing from it is open:

- **P6.972** `config/__tests__/validators-stored-config.test.ts` — the schema was right; its test's
  hand-listed fixture had fallen behind `neverPersistSessions` and now reads the shipped asset.
- **P6.973** `i18n/__tests__/locale-parity.test.ts` — the missing `_one`, plus the completeness pass
  `lint:i18n:parity` had structurally been unable to run.
- **P6.974** `agent/__tests__/instructions-loaded.test.ts` — `transcript_path` is a DOCUMENTED common
  input field (`hooks.md#common-input-fields`, and the page's own `InstructionsLoaded` example carries
  it), filled host-side by P6.300; no leak, four stale assertions, and a case that now pins the value.

## ~~`runtime-capability-drift.test.ts` — RED AT HEAD on `sessionAgent` / `anthropic → pi`~~ — CLOSED `e0e728081` (P6.1018, 2026-09-10); the cause was a row that came TRUE (registered by W10-b)

`apps/electron/src/renderer/components/app-shell/input/__tests__/runtime-capability-drift.test.ts`,
case *"fires exactly the rows the enforcement sites imply, per direction"* — **12 pass / 1 fail over
1 FILE** at `6fb422f48`, and the same one red after P6.928 added a row to the table
(`d3d0cb134`, 13 pass / 1 fail; the extra pass is P6.928's own).

**It is not P6.928's, and the proof does not need a second checkout.** The failing pair is the FIRST
one the loop compares — `AGENT_PROVIDERS` is `anthropic, pi, codex-runtime, nestor-cloud-agent`, so
`anthropic → pi` is compared before anything else — and the message names `sessionAgent`, a row
P6.928 does not touch. Read out of the INDEX rather than the working tree, `git show HEAD:` of
`runtime-switch-costs.ts` parses to 34 rows with no `readFence`, and its `sessionAgent` cell is
`{pi:false, anthropic:true, codex-runtime:false}` — which fires `measured` on `anthropic → pi`. So the
mismatch exists with the row absent.

**The cause is `fb011ffcb` (P6.940 clause 2, 2026-09-09) — *"a Pi session can run AS an agent,
composed by the host because Pi has no such option"*.** `sessionAgentOn`'s Pi arm derives the absence
as *the host key's reader exists in `storage.ts` AND neither the Pi turn path nor `SessionManager.ts`
names it*, and P6.940 made `SessionManager.ts` name `getSessionAgentName` three times — measured at
HEAD, in the index, not in a neighbour's tree: `git show HEAD:packages/server-core/src/sessions/SessionManager.ts`
scores **3**, `pi-agent.ts` scores **0**. So the derivation says Pi HAS the capability and the cost
row still says it does not.

**The derivation is right and the ROW is stale, which makes this a product defect rather than a test
defect.** The dialog tells a user switching claude → Pi that they lose the ability to run the session
as one of their agents; since `fb011ffcb` they keep it. Fixing it is a contract change on someone
else's row — the cell, the `anthropic → pi` count (7 → 6), the claim tally, the gaps document's **Pi**
section row *"A session cannot run AS one of its agents"* and its `[switch: sessionAgent]` annotation,
which the parity test's totality rule then requires to be retired rather than merely reworded. That is
a row, not a lane's in-place residue; proposed by W10-b.

**CLOSED by P6.1018, `e0e728081` (W10-l, 2026-09-10), and the entry is kept because the diagnosis is
the transferable half.** The row's Pi cell now says `true`, so `anthropic → pi` drops `sessionAgent`
(7 rows → 6) and `pi → codex-runtime` gains it (23 → 24) with the table's own size unmoved; the claim
tally goes `true` 51 → 52 / `false` 44 → 43; the drift derivation makes Pi a POSITIVE from BOTH ends of
its own seam (`resolvePiSessionAgentPin` plus `SessionManager.ts` passing the key's value in) rather
than an absence that would flip to `true` the day the `storage.ts` export were renamed; and the gaps
document's **Pi**-section row is RETIRED as `CLOSED` rather than reworded, because the parity suite's
annotation rule refuses a `[switch: <id>]` on a row that no longer fires into its section. Measured
after: the six switch-cost suites are **107 pass / 0 fail across 6 FILES**, 32.38 s at load 10.06
(`user 1.57 / sys 0.61`), against **12 pass / 1 fail over 1 FILE** for the drift file alone at
`f40ed326f`.

**What to keep from it.** A capability closed HOST-SIDE moves a cost cell exactly as a native one
does — native-first's second half is the switch verdict, and here it came a day late. And the failure
mode is generic to this file: a per-direction case that goes red on the FIRST pair it compares masks
every later pair, so a lane touching `runtime-switch-costs.ts` should read the PAIR NAME in the
failure before assuming the red is its own.

## 2026-09-11 — the Pi lift (W11-pi): one resolution and one contention reading

**Resolved:** `packages/pi-agent-server/src/__tests__/live-manifest-contract.test.ts` was **4/6 red at
HEAD from `d0e61e7ff` (2026-09-10) to `75811952f` (2026-09-11)** — not a rig fault: that commit rewrote
`review`'s model-visible `background` description and re-pinned only the source-state digest, leaving
`PI_STATIC_MODEL_CONTRACT_HASHES.review` stale, and `harness-manifest.ts` builds the PRODUCTION manifest
from it, so every live Pi session carrying `review` died on its first turn with `Pi execution manifest
model contract mismatch for review` (reproduced as a real-server `prompt_error`). Bisected against HEAD's
own `review-tool.ts` bytes (hash-verified restore) before the repair; re-pinned in the constant and the
fixture row, both bundles rebuilt, 6/6 after. The guard that would have refused the half-pin is P6.1077.

**Contention reading (not a finding, recorded so it is not re-measured):**
`pi-runtime-adapter.test.ts > confines direct createAgentSession use to the adapter` timed out at
6 168 ms against the 5 000 ms default inside a four-file batch at load 9.09, then ran **30 pass / 0 fail
alone in 71.20 s at load 7.99** (`user 1.56 sys 0.80` — 3 % cpu, I/O not CPU contention). Same shape as
the `pi-harness-baseline` entry: the cost is the module graph, not the test body; it did not recur in any
later run of the same file.

**CORRECTION 2026-09-17 (WB-d, wave A2, DA1.30 `02f17e3ad`): the sentence above is refuted — it DID recur, twice
on 2026-09-14**, at 14 171 ms and 18 071 ms against the 5 000 ms default, inside file totals of 201 s and 311 s
at `user 1.57 / sys 0.63` (0.7 % of wall — I/O, not CPU; same class as before, the case walks and reads every
production `.ts` in the package). The case now carries an explicit 60 s budget with that measurement in its
docblock; 30 pass / 0 fail after. Entry retained as a contention reading, not a finding.

## 2026-09-11 — the 1.36.0 wave gate (waves 12-a…e): 57 real reds, every one resolved, and the entries this retires

The whole-repo run on the quiet tree after the three lifts: **26 003 pass / 178 fail across 2 040 files** (6 862 s).
Run alone, 25 files went green (the cross-file class) and 57 stayed red; five lanes took the 57 by area and
closed all of them — 47 test-premise moves (a landed commit moved a pin, a count, a minified name, a contract
sentence, a default), 6 code fixes (`usage-metrics.ts`'s record of a metric already on the wire; the Swift
wire-enum mirror missing `CONNECTION_GATEWAY_ONLY`; two session verbs registered and declared nowhere; the
hotkey grammar refusing the app's own `alt+enter`; `check-generator-faithfulness`'s own `extractHead` running
generators outside a repository — a FALSE drift), 2 fixture corrections (the bash rig's never-background
kind), 1 gate budget class (five subprocess-import suites given a FILE budget against a measured 140x I/O
lottery), and 1 live-gateway change (the pinned conformance model is RETIRED upstream — see the next block).
Reports: `nessy-wf-checkpoints/work/lane-reports/lane-W12-{a,b,c,d,e}-report.md`, each with the cause commit
per file.

**Entries this RETIRES (the description no longer fits any red at HEAD; the file is green alone):**
- `read-deny-binds-edit-and-write.test.ts` — its row (`DIVERGENCE: a Read ALLOW also grants Edit and Write`) was already converted to a closure record (P3.214, `97bbaccac`); today's only red was the two-projection count, fixed `c6ad1c6ac` (W12-a).
- class (d), the `codex-cost-declaration.test.ts` bullet — the product claim it waited on was made by `90fbcfc1e`; 4/0 alone, `63b8b1ee1` (W12-a).
- `base-agent.test.ts` (the budget CONTROL, `sessionCostUsd` 3 vs 0) — `8bfb12497` is a landed decision (P2.258's refusal) the control never caught up with; fixed `bb1e0dcc7` (W12-b).
- `claude-worktree-port-binding.test.ts` — the standing diagnosis (the multi-line ternary) is spent and passes; today's red was the other control, `notificationPort: provider === 'pi'`, removed on purpose by `1ee02327b`; fixed `49f0bcf3b` (W12-c).
- P2.435 `default-thinking-level.test.ts` — RESOLVED and its "starvation" verdict REFUTED: zero-case control 70.83 s at 1.0 % cpu; junit per body 16.8–122 s for one child; 678.42 s wall for 19.0 s CPU at load ~15 against 31.47 s 9/0 at load 6.8 the same day — the third outcome, a timer lottery; budget 120 s → 300 s and the twelve-child case restructured to seven (`497df858a`, W12-d).
- class (c) "STARVED, and the control is decisive" — the `respond-to-bash-commands` line is ANSWERED for that file plus four siblings with the identical signature (`c513d7313`, W12-d: 28 pass / 0 fail across 5 files [821.72 s]); the remaining class-(c) files (`user-settings-strict-report`, `openai-compat`, `session-mirror-settings`, `cron-scheduler`, `powershell-cmdlet-gate`, `PendingAuthNotice`) still owe theirs (P6.1086).
- `check-doc-anchors.test.ts` (not a network red — the snapshot pin 104 → 106 after the 2026-09-11 refresh, `dcc108a00`), `check-generator-faithfulness.test.ts` (ONE artifact, and the drift was FALSE — `86f34a2e9`), `check-minified-citations.test.ts` (no network; the SDK lift reassigned two of three pinned names, `c4ef99a90`), `bash-auto-background-real-server.test.ts` and `bash-timeout-input-real-server.test.ts` ("the command completed" is refuted — 8 of 25 ticks is the timeout firing; the fixture is a documented never-background kind since `d67af6f1e`; `f60dcd2bf`, `97648da02`) — all W12-e.

**`conformance.test.ts` — the standing "needs a JWT" reading is REFUTED: the rig HAS credentials.** The gateway
answers `404 {"error":{"code":404,"message":"Модель tgpt/qwen35-397b-a17b-fp8 больше не поддерживается,
выполните /auth и выберете доступную модель /model"…}}` — the pinned model is RETIRED upstream. The live
catalogue holds two models, `tgpt/qwen36-35b-a3b-fp8` (alias `fast`) and `tgpt/deepseek-v4-flash-0731`
(alias `coder`), neither flagged `is_default`; a third live case only WARNS when it finds no tool call, so it
was GREEN on the 404's empty SSE stream. The id is now read from the catalogue (`is_default` → `coder` → first)
and logged on every live run: 16/0 across 1 file (`61c419cfa`, W12-e). The product-side consequence (a stored
default that the gateway retired) is P6.1080.

**`registration.test.ts` / `registration-profiles.test.ts` — the CLOSED entry (P3.317, the two notification
channels) is a different pair; the same CLASS recurred 2026-09-11:** `sessions:reconnectMcpServer` and
`sessions:getMcpServerStatuses` registered and declared nowhere, hidden by a 284 698 ms per-test `await import()`
against a 120 000 ms budget (zero-case control 32.99 s at 0.54 s user); fixed with the declarations and a
hoisted import (`59ad1034c`, W12-e).

**Observed and did NOT reproduce (notes, not entries):** `rewind.test.ts` — one timeout at 5 003.55 ms with zero
assertion failures, then `targetExistedAtRewind: false` in the next case, green twice afterwards; hypothesis: the
first case's `finally` does not run on timeout and the second is the landing site (W12-c). `registration.test.ts`'s
`document.createElement is not a function` — green alone twice, the pdfjs/`DOMMatrix` cross-file class (W12-e).

## 2026-09-11 — `model-fetchers/__tests__/service.test.ts`: 5 subprocess timeouts under a 7-file batch, and it is CONTENTION (W12-f, not an entry)

Measured both ways on the same bytes. In a 7-file batch at load ~11–13 the file's `Bun.spawnSync` cases
reported `exitCode: null` against their own 120 000 ms budget — **64 pass / 5 fail, Ran 69 tests across
7 files [501.23s]** — and three of the five named are the pre-existing BYO-metadata-sync cases the lane
never touched. Run ALONE on the same bytes: **16 pass / 0 fail, Ran 16 tests across 1 file [12.49s]** at
load 16.85 — a 40x wall-time spread on a HIGHER load average, i.e. the AGENTS.md I/O signature rather
than CPU contention. The file's rig spawns a fresh `bun` per case against a temp config; seven concurrent
test files starve it. Not a new red; the cross-file class.

## 2026-09-11 — `composer-permission-modes.test.ts` was 2 of 17 RED for one hour, a real regression between two wave-13 commits (RESOLVED, not an entry)

`mode.bypassPermissionsFullDesc` was re-cut by `e9ea5840e` (W13-i, P6.1099) from 50 → 82 chars (en) and
54 → 107 (ru) against the picker's measured one-line budgets of 78 / 72, and the RU replacement opened with
`без запросов`, one of the three absolutes that suite's `banned` table exists to keep out of a runtime-less
surface. Green at `e9ea5840e~1` on the same test bytes; found by W13-k running the suite as a value-agnostic
control for a different key. Re-cut inside both gates by the controller with `runtime-behavior.json`'s
`modeGoldenBehavior` row and the verbatim pin in `bypass-permissions-copy.test.ts` moved in the same commit
(`git log -1 -- packages/shared/src/i18n/locales/en.json`): 17/0, 4/0 and 23/0 across 1 file each. The lesson
is the AGENTS.md §Traps bullet born the same day: a copy change needs the copy GATES run, not only the copy
test — the two live in different packages.

## 2026-09-11 — `test:doc-tools` is RED on this rig for a reason the rig owns, and GREEN with native TLS (the 1.36.0 gate; a note, not an entry)

`validate:ci` → `validate:dev` → `test:doc-tools` failed **12 + 2 of 19** with one cause repeated: the smoke tests
run the document tools through `uv run`, this rig's `uv` (the pyenv shim, 0.7.8) resolves PyPI through the
corporate TLS-intercepting proxy and rejects its certificate — `invalid peer certificate: UnknownIssuer`, with uv's
own remedy in the message (`--native-tls`). Re-run as `UV_NATIVE_TLS=1 bun run test:doc-tools`: **Ran 19 tests in
1097.255 s — OK**. The other five `validate:ci:chain` steps passed on the same tree (typecheck:all, test:shared:all,
lint 763 s, ipc:inventory:check, check:coverage-map), so the 1.36.0 gate is green on code and red on this rig's
CA store. `.gitlab-ci.yml` keeps `test-doc-tools` disabled until the runner mirrors exist (`UV_INDEX_URL`,
`UV_PYTHON_INSTALL_MIRROR`), so CI does not see it either way. Not registered as an entry: nothing in the tree is
wrong, and the packaged app stages its own pinned `uv` (`packaged-plugin-runtime.test.ts`), whose CA behaviour on
a corporate network is the open question P6.1107 records.

**Follow-through 2026-09-11 (P6.1107, `655c0fd1b`):** the harness (`apps/electron/resources/scripts/tests/_tool_test_harness.py`)
now sets `UV_NATIVE_TLS=1` itself, as does every uv the app launches (`session-tools-core/src/runtime/sandbox-env.ts`,
`shared/src/agent/backend/internal/runtime-resolver.ts`); re-run with the flag ABSENT from the shell:
**Ran 19 tests in 553.611s — OK, exit 0.** `validate:ci` is green end to end on a corporate rig without the operator
knowing the flag. Not an entry.

**Re-measured 2026-09-12 at the 1.37.0 close-out (CO1, inside `validate:ci`, the flag ABSENT from the shell):** `Ran 19 tests in 25.741s … OK` — the 553 s and 1097 s readings above were wall times on a loaded, I/O-bound rig (that `validate:ci` ran 26.2 min at 20 % cpu), not the suite's cost; the verdict is unchanged, green. Still not an entry.

## 2026-09-13 — wave 19: one timeout at load and one attribution corrected (W19-a, W19-f hand-backs; entries by the controller)

**`packages/server-core/src/handlers/rpc/__tests__/connection-delete-live-session.test.ts` › *"finds every loaded session bound to the slug, and no others"*** — timed out at **5001.75 ms** at load 13.22 and PASSED on the re-run at load 11.65 (W19-a, 2026-09-12). The body opens with a dynamic `await import('../../../sessions/SessionManager.ts')` — the rule-24 shape, a 34k-line module graph charged to the 5 s per-test timer; the sibling case one later performs the same import and never fails because the module is then cached. Not caused by C3.368 (one optional field on the method that case calls); did not recur in any later run of the file. Class: rule 24 (dynamic import inside a test). Fix owned by coverage-plan **C3.402** (a static top-level import, with its own before/after file-count reading, because the suite mutates module-scope config in `beforeAll`).
> **RETIRED 2026-09-17 (D1.147, `889c3698a`, WI-s).** The dynamic `await import(...SessionManager.ts)` in both cases of that describe is now one static top-level import, so the 34k-line graph is charged to the file's load and to no per-test timer. Measured with `--reporter=junit`: the describe cost `time=0.107` with its slowest body at 107.7 ms and now reads `time=0`, no body in the file above 18.5 ms; 13 pass / 0 fail / 22 expect() across 1 file before and after.

**`scripts/check-doc-anchors.test.ts` › *"the live tree"* (P2.376a family) — the attribution above is SPENT, and the budget moved.** The existing entry calls this case *"the known network suite (P3.318, ~420 s of live requests)"*; the gate is offline-by-snapshot (`scripts/claude-doc-anchors.tsv`, read from disk) and W19-f's two readings were taken with no network request at all. What the ~420 s measures is the WHOLE-TREE citation scan (the file's own header prices it at 5–18 minutes of wall for 1–2 s of CPU): **409 590 ms** whole-file (`Ran 47 tests across 1 file`, the live-tree case PASSED inside it) and **432 703 ms** for the case alone, which timed out against the 300 000 ms budget — the budget had fallen BELOW the resting state. `REPO_SCAN_TIMEOUT_MS` is 600 000 since `dea1fb0a4` (W19-f, C3.338, 2026-09-12) with both readings dated beside it; the assertion passed on both instruments. Class (c) STARVED / I/O-bound, not a network red on this rig.

## Wave A of the dp-auth plan and the 1.38.0 close-out (2026-09-13) — five blocks handed back by lane WA-r (regression triage), applied by the controller


### Block A — the 1.38.0 close-out whole-repo run, and the seven that passed alone (2026-09-13)

## The 1.38.0 close-out single-process run (2026-09-13, HEAD `28237285a`…`c68f56db0`)

The controller ran the whole repo in ONE `bun test` process and stopped it at **100 files of ~2144**
(3.75 files/min on this box; `real 2705.40 / user 387.74 / sys 129.59`, load 5.10 → 8.25 across the
window). It ended `bun-test-split: the test run was KILLED (signal SIGTERM)`, so it proved nothing
about the 2044 files it never reached — recorded here because the SHAPE of what it did reach is the
thing this register exists to carry. **60 `(fail)` lines over 19 files.** Re-run ALONE at
`c68f56db0`, **seven of the nineteen passed**, which is the cross-file class, not a defect in any of
them:

| File | Alone | In the 100-file run |
| --- | --- | --- |
| `packages/shared/src/__tests__/interceptor-packaging-contract.test.ts` | 10 pass / 0 fail, 1 FILE, 264 ms | 3 fail at 0.79–5.61 ms — millisecond assertions, so NOT starvation. **Explained and FIXED at source**: `c68f56db0` grew the derived closure to eight files while `electron-builder.yml` and the pin stayed at seven. |
| `packages/shared/src/config/__tests__/managed-env.test.ts` | 37 pass / 0 fail, 1 FILE, 257 ms | 1 fail. **Explained and FIXED at source** by the same commit (`GCE_METADATA_ROOT` pinned in the withhold-set test and not in the reviewed table). |
| `packages/pi-agent-server/src/orchestrator/subagent-real-server.test.ts` | 1 pass / 0 fail, 1 FILE, 1.13 s | 1 fail at **120 134.59 ms** — a real-server e2e against its own 120 s budget; the starvation family. |
| `packages/pi-agent-server/src/orchestrator/workflow-real-server.test.ts` | 3 pass / 0 fail, 1 FILE, 3.34 s | 1 fail at **120 057.57 ms** — same. |
| `packages/shared/src/config/__tests__/session-mirror-settings.test.ts` | 5 pass / 0 fail, 1 FILE, 707 ms | 2 fail at **12 916 ms** and **5 010 ms** — the second is bun's 5 s default exactly; it drives a subprocess config load. Starvation. |
| `packages/shared/src/agent/__tests__/claude-restricted-mode-collision.test.ts` | 4 pass / 0 fail, 1 FILE, 560 ms | 1 fail at **15 343 ms** — the C3.15 tripwire case, which reads the vendored binary. Starvation, and worth knowing because a tripwire firing spuriously reads as a runtime-lift finding. |
| `packages/shared/src/agent/__tests__/codex-mcp-elicitation.test.ts` | 39 pass / 0 fail, 1 FILE, 339 ms | 11 fail at 0.29–0.48 ms across two describes — SUB-MILLISECOND, so this is the cross-file amputation class (a `mock.module` without a spread or without a restore somewhere else in the batch), never load. |

**The reading that transfers:** a `(fail)` inside a 100-file single-process run carries no
attribution at all. Seven of nineteen files were innocent; of the twelve that were not, two were
already-landed source drift and one (`process-supervisor.test.ts`) failed a DIFFERENT case in the
batch from the two it failed alone. Read the per-case DURATION first — sub-millisecond means
cross-file, five-plus seconds against a 5 000 ms budget means starvation — and only then run the
file alone.

### Block B — `process-supervisor.test.ts`: a THIRD symptom of the registered case, one failure that was never its own, and a whole-file arm that is no reading at all

**Extends the 2026-08-23 entry for `Pi ProcessSupervisor > awaits close finalization instead of
marking an already-removed child lost`.** That entry records the case asserting `exited` and reading
`stopped` — *"the two finalisation paths landing in the other order"*. Measured again at the 1.38.0
close-out (2026-09-13), the same race has a third and louder ending: `stop()` reaches
`stopRecovered` and **throws `process-recovery-identity-mismatch`**, marking the record `lost`.
**3 pass / 2 fail over five runs of the case ALONE** under the test mutex at load 8.5–9.6.

The mechanism, one step past the old entry: `stop()` takes its `record` through
`await store.assertOwner(…)` and only then consults `this.completions`, while the close handler
writes the terminal status BEFORE it resolves — and so before it deregisters — that completion. The
test released its flush gate on the line after `stop()` was called, which lands inside that window.

**The file's SECOND failure in the controller's alone run was never its own.**
`append failure remains lost after process close` is **1 pass / 0 fail ×2 alone** and was charged
with the previous case's unhandled rejection: the throw abandons `starting`, the `finally` removes
the store root, and the still-in-flight `start` rejects `ENOENT` on a path inside it. The 1.34 ms
duration is the tell — too short to have spawned its child. **A `(fail)` reported between tests in
this file belongs to the case ABOVE it until proven otherwise.**

**And the whole-file arm of this suite is NO READING on a loaded box.** Three runs of the SAME
committed bytes, same mutex, load 8.0–9.2: **41 pass / 5 fail / 1 error at 167.49 s**, then
**28 pass / 18 fail / 7 errors at 354.16 s**, then — once the sibling lanes drained —
**46 pass / 0 fail at 2.74 s**. `user 4.10 / 3.44 / 1.36` against those walls is 1–2 % cpu in the
two red runs; thirteen of the eighteen failures are at 5000–5003 ms, i.e. bun's default budget
exactly. **A 128x wall-time spread and 0→18 failures on identical bytes**: attribute nothing from a
whole-file run of this suite at load ≥ 8. The `-t` filtered arm (0.43–0.45 s) is the instrument.

**The cascade is closed at `710a08633`; the RACE IS NOT, and a six-run reading said otherwise.**
That commit marks `starting` handled the moment it exists and orders the gate release after the
store double's `assertOwner`, and six runs then gave 5 pass / 1 fail. A **25-run hunt of the case
alone at load 12.39 gives 16 pass / 9 fail** — indistinguishable from the 3 pass / 2 fail before it.
The nine split **6 `process-recovery-identity-mismatch` + 3 `exited`/`stopped`**, i.e. this entry's
new symptom and this entry's original one, both still live. **The dominant six cannot be fixed from
the test at all:** when `stop()` reaches that branch the close handler has already written the
terminal status, so the source hunk below (re-read the record before treating it as a recovery)
makes 6 of the 9 impossible. The other 3 are the case's own 50 × 2 ms child-departure poll giving
up. **The production race is NOT closed** — it is real and narrow, and it is OLD: the `else await this.stopRecovered(…)` branch
dates to `b1571ad0a` (2026-07-23), so this is in no sense a 1.38.0 regression. A `stop()` landing in
the milliseconds around a background child's normal exit records `lost` and throws at its caller.
Its source fix is a proposed row, not a test change.

### Block C — `pi-runtime-cwd-transaction.test.ts`: the DETERMINISTIC half is fixed, and the entry is CORRECTED rather than struck (2026-09-13)

**This file's red at the 1.38.0 close-out was NOT the intermittent this register describes, and
treating it as one would have left a landed regression in place.** Historical readings are 1/3, 2/3,
3/4 and 0/1. Measured under the test mutex it was **0 pass / 1 fail in 3 of 3 runs ALONE** at load
7.29–7.35 — 1.86 / 1.92 / 2.00 s wall against **user 2.09–2.17**, i.e. over 100 % cpu and a real
assertion, which is neither the starvation family nor the load-fragile one.

Deterministic, and the cause was in the test. `56ab8aeb1` (C3.385) made `handleSetThinkingLevel`
publish the level Pi actually holds after its own clamp, reading `piSession.thinkingLevel`. The real
session has that member (a `thinkingLevel` getter in the Pi SDK's `dist/core/agent-session.d.ts`,
present at the installed 0.84.4); this file's session double carried the value only on
`agent.state.thinkingLevel`, so the host read `undefined`, published the INIT config's level instead,
and the PREPARE candidate was then created carrying `off` where the case asserts `max`. Production
was never affected. Fixed at `0ebcbe550` by giving the double the getter.

**The file STAYS in this register, and this is the honest half.** After the fix it is **2 pass /
1 fail** over three runs at load 8.2–8.9: green at 46.14 s and 129.11 s, and red at **294.23 s with
the case at 122 246.77 ms — one of the file's own 120 000 ms in-test helper deadlines — at
`user 2.78 / sys 1.14` against `real 294.23`, i.e. **1.3 % cpu**. That is the entry two sections up,
*"The three real-server e2e suites"*, whose own rule is that **a red from any of the three at
load ≥ 9 is no reading**. So the sequence here is: a deterministic assertion failure was hiding
inside a file everyone already expected to flake, and removing it returns the file to its previous
disposition — it does not make it green on a busy box.

**The instrument worth carrying, because four earlier readings assumed the wrong one:** the received
log showed `set_thinking_level {sessionId: 2, level: "max"}` recorded BEFORE the candidate's
`session_create {… thinkingLevel: "off"}`. Ordering was never the explanation. And the separator
between the two failure modes is `user` against `real` — over 100 % cpu at ~2 s is a real assertion
to diagnose; 1.3 % cpu at ~300 s is the box.

### Block D — a PRECONDITION that reads as a product regression: the vendored ripgrep

**Not a row, and it will look like a denied-path regression if you skip this.**
`packages/shared/src/agent/__tests__/pi-denied-result-paths.test.ts` (and any other suite driving a
real search) prepends `node_modules/@vscode/ripgrep/bin` to the child's PATH, because this host has
no system `rg`. That binary is produced by a **trusted postinstall**, which
`bun install --frozen-lockfile` alone does not run. With it absent, the three real-search cases fail
carrying the tool's own refusal text — *"This tool requires `rg` (ripgrep), which is not available on
this host… exit 127, sh: rg: command not found"* — including the P3.272 POSITIVE CONTROL, so it
presents as *"the control's premise no longer holds"*, i.e. as a runtime lift having taken over the
filtering natively. It has not.

Measured 2026-09-13: the controller's alone run at 16:49 had 3 fail over 5; the binary's mtime is
**16:59**, when the 1.38.0 dmg build ran `bun pm trust @vscode/ripgrep`; two runs after that,
**5 pass / 0 fail, 1 FILE, 829 ms and 479 ms** at load 7.29. Check
`ls node_modules/@vscode/ripgrep/bin/rg` before believing any denied-path or search red.

### Block E — `registry-source.test.ts`, a vacuous wait rather than a marketplace change

`packages/shared/src/marketplace/__tests__/registry-source.test.ts` ▸ *"removing a marketplace leaves
its installed plugins installed (L103)"*. **4 pass / 1 fail over five runs ALONE** at load 7.7–14.9
at the 1.38.0 close-out — an intermittent, and `registry-source.ts` is unchanged in the behaviour it
pins (nine commits since 2026-09-01, none touching `remove`, `removeDiskEntry` or `diskPath`).
`remove()` ends in `void this.removeDiskEntry(…)`, whose `rm()` settles on the fs threadpool, and the
case waited exactly one `Bun.sleep(0)` tick for it. Fixed at `4fc8388f2` by polling the observable
the assertion consumes, bounded at 2 s inside the 5 s case budget so a real regression still reds as
an assertion and not as a timeout.

## 2026-09-17 — wave C: one contention reading on the stdio-teardown positive control

**Contention reading (not a finding, recorded so it is not re-measured):**
`packages/shared/src/mcp/__tests__/managed-stdio-transport.test.ts > unsupervised stdio teardown > POSITIVE CONTROL: on the managed transport itself, each fix arm sleeps past its own descendant` (DA3.13, `c1bf9a971`) timed out with **zero assertion failures** twice in one hour — at 5 120 ms and 12 369 ms against the 5 000 ms default — while four lanes shared the test mutex, and the SAME bytes passed in a 46-file run (535 pass / 0 fail, `real 141.03 user 3.63 sys 1.38`) the same hour (WC-c). The arm is real-clock by design (~5 s of sleeps: the 2 000 ms graceful step + 1 200 ms settle) and is deliberately the one arm in that file that can go red on a slow box. Register verdict: contention; give it an explicit budget against the measured floor if it recurs alone at low load.

## 2026-09-17 — wave I-1: a load lottery on `scripts/plan-status-marker-census.test.ts` (WI-e hand-back, applied by the controller)

| File | Green reading | Red reading | What was measured |
| --- | --- | --- | --- |
| `scripts/plan-status-marker-census.test.ts` | **8 pass / 0 fail, 3.83 s** (load 10.20) | **up to 8 fail, 601–747 s** (load 7–11) | **A LOAD LOTTERY on the same bytes; the failure is `Bun.spawnSync(python3)` never returning inside the per-case 60 s budget, so `expect(proc.exitCode).toBe(0)` receives `null`.** Measured 2026-09-17 (WI-e, D1.85) four times inside one hour: 54.76 s at load 10.8; **746.98 s / 7 fail**; **601.25 s / 5 fail**; then **3.83 s / 8 pass at load 10.20**. Every red burns `user 2.0–2.4` / `sys 1.0–1.2` against 850–1 060 s wall — ~0.3 % cpu, the I/O signature, not CPU contention — and the file's wall time is its own graph: one `cpSync` of `plan-status.py` plus one `python3` spawn PER CASE. Separating instrument: the two D1.85 cases alone (`-t 'D1.85'`) answer **2 pass in 1.98 s at load 11.54**, the highest load of the four. Re-run the file alone and read the pass count against the case list before recording a red. |

## 2026-09-17 — wave C2: the ten `auth/dp` suites lose the per-test timer lottery in bulk when the page cache is cold (C2-b hand-back, applied by the controller)

**Contention / cold cache, same family as the `dp-api.test.ts` intermittent above it; DA1.67's measurement is the cause.** `packages/shared/src/auth/dp/__tests__/*` run as one batch: **17 fail / 9 errors** at 19:26 (load 7.99, `real 622.47 user 3.70 sys 2.59`, 535.73 s of test time), **2 fail / 1 error** on the next run of the identical bytes, and `e2e.test.ts` **6/6 three times** run ALONE at 49.93 / 46.63 / 1.26 s. The separating instrument is the zero-case control: `bun test <the 11 files> -t '<matches nothing>'` is **118.55 s with 0 tests executed**, so the graph and not the tests is the wall time, and cpu is ~1 % of it throughout. Not caused by the lane (its only dp edit is two CA arms and a docblock in `dp-exec-env-proxy.test.ts`, 6/6 in 240 ms alone). Fix if it recurs: an explicit per-file budget against the measured floor; the structural fix is DA1.72 (splitting `config/storage.ts`).

**An INSTRUMENT caveat rather than a failing test (C2-b, cost fifteen minutes):** a FOREGROUND bash command that the harness moves to the background at its 120 s timeout can end up parked — `bun run lint:i18n:reachable 2>&1 | tail -6` sat at **0.0 % cpu with 1.23 s of cpu time, no children and no `.git/index.lock`, for fifteen minutes**, and the same gate re-run as a background command writing to a FILE finished normally and green. Read a timeout-then-backgrounded pipeline as an artefact of that transition before reading it as a slow gate.

### `gateway-fixture-tri-states.test.ts` — the ledger sweep cannot see the ROTATED gateway ids

| case | cause | note |
| --- | --- | --- |
| `apps/electron/src/renderer/components/apisetup/__tests__/gateway-fixture-tri-states.test.ts` → `the ledger of fixtures that still restate the card by hand` (both cases) | the sweep greps `NESSY_GATEWAY_MODEL_IDS`, which P6.1080 ROTATED | PRE-EXISTING and unregistered. Measured 2026-09-18 by WI-ap as an A/B: with my three D1.322 files restored to HEAD the pair runs **13 pass / 2 fail**, the same two. The sweep finds **16** files against the ledger's `>= 34`, and names `packages/shared/src/config/__tests__/mini-model-degradation.test.ts` as unlisted. AGENTS.md §Gateway Facts records ~400 fixture occurrences of the RETIRED id `tgpt/qwen35-397b-a17b-fp8`, deliberately not renamed — those are exactly the files the sweep can no longer see, so the split it reproduces is no longer P3.179's. Not a flake and not load-dependent. |

**Controller 2026-09-18:** registered from WI-ap's A/B (13 pass / 2 fail with its files restored to HEAD — the same two); the fix is D1.335 (sweep for the retired id beside the live ones, re-derive the ledger from a quiet tree).

**RETIRED 2026-09-18 by `de40c55dc` (WI-as, D1.335):** the sweep now reads both generations of the card's ids; the union corpus reproduces the registered ledger entry for entry (36 candidates / 19 omitters), the dead `all - omitting >= 2` assertion deleted, 10 pass / 0 fail across 1 file. The entry stays as history.

## A CI reading, 2026-09-19 (WI-bs) — `process-supervisor.test.ts` fires its registered race on the runner

**Not a new entry; a dated reading against the one Block B already carries.**
`Pi ProcessSupervisor > awaits close finalization instead of marking an already-removed child lost`
failed on CI job 630555493 (pipeline 126355866, commit `ac9ae50da`) with exactly the registered
symptom — `stopRecovered` throwing `process-recovery-identity-mismatch` from
`packages/server-core/src/pi-harness/process-supervisor.ts` at its identity guard, reached through
`stop()` — after **29.16 ms**, so the case's own 5 000 ms owner-read deadline was never approached and
this is the ordering race rather than starvation.

Three things worth having beside the existing entry:

- **It is not the isolation skip.** The same commit gates four ceiling cases in this file behind the
  product's own `probeIsolationCapabilities`, and this case is none of them: it passes
  `resolveIsolation` explicitly, so it never consults a backend. It also failed on the run BEFORE
  those skips existed.
- **It survives the 1.38.0 close-out hardening.** The case's own comments describe the timer wait
  added to order `releaseFlush()` strictly after `stop()`'s completion lookup; the 29 ms failure shows
  the owner read DID land (otherwise the loop would have spun to its deadline) and the throw happened
  anyway, so the window the hardening closed is not the only one.
- **It is not reproducible on the developer box in this lane's runs.** The file answered 46 pass /
  0 fail alone three times on 2026-09-19 (before the skips, after them, and after the budget change),
  which is consistent with Block B's own 25-run measurement rather than a refutation of it.

Left registered rather than chased: the residual window is inside `stop()`'s await chain, the two
previous hardenings each closed a different one, and this lane's subject was the CI job rather than
this race. It is the one failure that can still red `test` intermittently, and it is named as such in
`work/lane-reports/lane-WI-bs-report.md`.

## `agent-message-delivery.test.ts` (2) — a real product defect, NOT contamination (WI-bs, 2026-09-19)

**FIXED 2026-09-20 in `de7c1dbeb` (D1.416, WI-bu): the second resolve site forwards `options?.askUserAnswer`; the file answers 54 pass / 0 fail alone. This block stays as the record of the diagnosis.**

**Reproduced ALONE at HEAD, which is what this register's rule asks for:**
`bun scripts/bun-test-lock.ts run --label WI-bs -- bun test ./packages/server-core/src/sessions/__tests__/agent-message-delivery.test.ts`
answers **52 pass / 2 fail, `Ran 54 tests across 1 file` [80.34s]**, at `371b688fa` and again at the two
earlier heads this lane measured. It fails identically on CI (jobs 630520568, 630550597, 630555493,
630556769). **It is therefore not the whole-repo class and the per-package split of the `test` job's
first line would not have touched it** — that hypothesis was tested and refuted rather than assumed.

The two cases:

- `P6.182 … (c) Approve delivers that one message; Deny drops it, and both tell the sender` —
  after `approve(...)`, `h.receiver.pendingTaskNotifications` is `undefined` where `['first']` is
  expected.
- `P6.182 … (d) an expiry is a drop, not an approval, and reports 'expired' to the sender` — the
  sender is told *"was declined by its user and was not delivered"* where the case asserts
  *"expired without an answer"*.

**The defect is in `SessionManager.respondToPermission`, and it is user-visible:** approving a held
cross-session message delivers NOTHING and tells the sender it was declined; an expiry is also reported
as declined. `raiseCrossSessionApprovalDialog` registers a resolver whose third parameter is the
`askUserAnswer`, and decides expired/approved/denied from it. `respondToPermission` has TWO resolve
sites: the early one forwards `options?.askUserAnswer` but is guarded by
`!this.pendingPermissionRequests.has(requestId)`, and `countHostRaisedCard` (D1.355) now registers
host-raised cards there — so this card takes the SECOND site, which passes `undefined`. That site's own
comment explains the `undefined` is deliberate *for an ordinary Pi tool card*; it was true when written,
and the population reaching it grew underneath it.

The negative that proves the resolver IS reached: the sibling case
`(c) dismissing the dialog drops it too` passes, because `allowed: false` reaches `'denied'` correctly
without needing the answer.

**Fix: one argument**, at the second `directResolver.resolve(...)` in `respondToPermission` — forward
`options?.askUserAnswer` instead of `undefined` (or forward it only for the cross-session resolver).
Not taken by WI-bs because `SessionManager.ts` was held by another lane for the whole of that lane's
window (WI-br, then WI-bt's safety hotfix). Expected to return the file to 54/0.

## 2026-09-24 — the pi-agent-server real-server starvation family, measured with its cause (WJ-lift hand-back; F1.587 by WJ-bs; applied by WJ-co-ledger 2026-09-25)

**A dated reading of the family the P3.199 entries above belong to, not a new failing test.** WJ-lift's
text, verbatim:

> 2026-09-24 (WJ-lift, F1.255 Pi 0.85.1). The pi-agent-server real-server starvation family was measured with its cause. A copy of `pi-auto-compaction-thrashing.test.ts` at a 900 s in-scenario budget saw the child `bun --preload … src/index.ts` print `ready` at +115.8 s and +81.0 s (load 8.4–11.5). The child ran at 1.4–2.2 % cpu, 2.36 s of cpu in 96 s. macOS `sample` put 2 313 of 2 319 main-thread samples in `openat`. The scenario then completed in about 2 s, green. Taken alone (not the probe copy), the unmodified file red both scenarios at 120 s with an EMPTY protocol trace — no `ready` line inside the budget. That is the signature of this cause, and it means "no reading", not a regression. `pi-session-lineage-real-server`'s beforeAll `Bun.build` took 204 s by hand (1.3 s user) against its 240 s hook. Through `NESSY_PI_SERVER_ENTRYPOINT` with that prebuilt bundle: 7/7.

**F1.587 (`667f8d4cc`, WJ-bs, 2026-09-24) changes how these four suites fail, not whether the box is
slow.** `packages/pi-agent-server/src/__tests__/pi-auto-compaction-thrashing.test.ts`,
`pi-auto-compaction-instructions.test.ts`, `pi-provider-verdict-retry-real-server.test.ts` and
`pi-session-lineage-real-server.test.ts` (same directory) now time each scenario from the child's
first `ready` rather than from the spawn: `packages/pi-agent-server/src/__tests__/support/real-server-clock.ts`
(`startRealServerClock`) arms the boot budget at the spawn and swaps to the suite's own answer budget
at the first `ready`, and the lineage prebuild takes the shared module-graph hook budget. The answer
budgets are the old numbers and no assertion moved. So **a red on these four files now names its
phase, BOOT or ANSWER**: a BOOT expiry is this entry's cause (no reading), an ANSWER expiry is a
reading of the behaviour under test. Evidence in the commit: one locked run, 20 pass / 0 fail over
5 files at load 18.9 → 12.1, with the answer arms passing at 135–373 s from the spawn — each past the
spawn clock and the per-test budget it used to run under.

## 2026-09-20 — `scripts/cdp/harness.test.ts`, one `Malformed_HTTP_Response` from the loopback stub (F1.185, WJ-x hand-back; applied by WJ-co-ledger 2026-09-25)

WJ-x's text, verbatim:

> `scripts/cdp/harness.test.ts` › *the loopback stub upstream > streams when asked* — one red in five directory runs, `Malformed_HTTP_Response`, load 6.61 (WJ-j, 2026-09-20). Cause UNNAMED. The one path measured to produce that exact error (a second process binding 127.0.0.1 on the stub's wildcard port, 2026-09-23) is closed by `65181b204` (the stub binds 127.0.0.1). Port-0 picks never collided (0/3000, 0/1500) and 1500 back-to-back runs reproduced nothing. If it recurs after `65181b204`, the shadow is excluded.

Left registered with its cause unnamed, as the text says: one fix closed the one mechanism measured to
produce the error, and the flake itself was never reproduced to tie it to that mechanism.

## 2026-10-01 — `process-supervisor.test.ts`'s close-finalization case: the "poll half" was the poll reading "not spawned yet" as "already left" (CI-k3, pipeline 127598882)

**Closes the test half of the entry Block B and the 2026-09-19 CI reading carry.** CI job 637310626
failed `Pi ProcessSupervisor > awaits close finalization instead of marking an already-removed child
lost` with the ORIGINAL symptom (`exited` expected, `stopped` read) after **8.35 ms** for the whole
case — far below the 500 × 2 ms departure poll, so the poll did not give up: it never waited.

The mechanism: `ProcessStore.create` writes the record first and then still writes the log file, its
mode and the running marker; only after that does `start()` spawn and put the child in `children`. The
case's handle poll (`store.list`) can see the record inside that tail, and its departure poll asked
only `children.has(handle)` — false for a child not spawned YET, read as "already left". `stop()` then
either found the freshly spawned child and stamped it `stopped`, or found nothing at all and took
`stopRecovered` (`lost` + `process-recovery-identity-mismatch`) — this register's two symptoms of the
case, one window.

Measured with a scratch copy of the case whose store delays `create`'s return by N ms (8 runs per
cell, under the test lock): the OLD poll gives 8/8 `exited` at 0–1 ms, then `3 exited / 1 stopped /
4 lost` at 2 ms, `1 stopped / 7 lost` at 3 ms and 8/8 `lost` at 5, 8 and 30 ms; the NEW poll — wait
until the handle is in `completions` and not in `children`, i.e. spawned, closed, and its
finalization parked on the case's flush gate — gives 8/8 `exited` in every cell (56/56). Fixed in the
test in the commit that adds this section; the case then answered 20/20 under `--rerun-each 20` and
the file 46 pass / 0 fail alone. The production hunk in `stop()` (re-read before treating "no child
and no completion" as a recovery) is unchanged and still needed.

**The same window is a production defect, proposed as a row (not fixed here).** A `stop()` that lands
between `create` and the spawn — a handle `list` already shows — finds no child, no completion and a
`running` record, so `stopRecovered` marks it `lost` and throws; `start()` then spawns anyway. Probe
(same 30 ms widening, a `setInterval` child): `stop()` threw `process-recovery-identity-mismatch`,
the record read `lost`, `start()` returned `isRunning: false`, and the child was ALIVE and still in
`children` 200 ms later; a second `stop()` resolved (the record is no longer `running`) and left it
alive. Old (the `stopRecovered` branch dates to `b1571ad0a`), narrow, and not this plan's regression.

## 2026-10-04 — `script-action-row.test.tsx` is green alone and fails 3 arms after any earlier suite initialised react-i18next: `setI18n` is a process global (UA12.167)

**An isolation artefact, not a product defect — every per-file run is green.** The suite rendered with
`renderToStaticMarkup` and asserted that i18n LABELS render as their literal KEYS ("i18n is not
initialised here, so labels render as their keys" said its header) — a premise about the ABSENCE of an
i18next instance. But `react-i18next`'s `setI18n` is a process global: once ANY earlier suite in the
same `bun test` process ran `.use(initReactI18next).init()`, the components' `useTranslation()` resolved
against that instance and TRANSLATED the keys, so three arms failed — the script row's positive arm
(`automations.script.unapproved`/`automations.script.approve`) and the refresh bar's two key-asserting
arms (`pages.refresh.runNow`, `pages.refresh.stateChanged`).

Measured at the 1.42.0 final gate and reproduced for this row under the test lock: the victim alone
**8 pass / 0 fail**; the pair `board-derive.test.tsx` (the polluter) + the victim → **24 pass / 3 fail**,
the identical three arms, in that order; the batch's other 16 files 190/0 (final-gate lane, 2026-10-04).

Fixed in the commit that adds this section, with the kanban suites' own pattern: the suite now creates
ITS OWN instance — `createInstance()`, `.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en' })`
with deliberately NO resources, so `t` returns the key exactly as the assertions read it — and every
render goes through `<I18nextProvider i18n={i18n}>`, which overrides the process-global default. The
premise is no longer the absence of an instance but the presence of THIS one. Readings after the fix:
victim alone **8 pass / 0 fail**; the same polluter+victim pair **27 pass / 0 fail**. Any future suite
that asserts keys-as-keys must mount its own provider instance rather than relying on i18n being
uninitialised.

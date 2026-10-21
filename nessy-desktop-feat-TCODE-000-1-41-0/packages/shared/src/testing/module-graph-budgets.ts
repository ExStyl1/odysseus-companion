/**
 * P6.638 — the ONE site for the module-graph timer budgets, and the sizing rule
 * that has to travel with them.
 *
 * ## The family this exists for
 *
 * Six suites in this repo import a module graph rooted at `SessionManager.ts` or
 * `config/storage.ts`, and that import is I/O against bun's 5 s default timer.
 * Each of them had grown its own hand-written constant — 120 000, 120 000,
 * 600 000, 600 000, 600 000, 900 000, 300 000 — and the register recorded that
 * COPYING A NEIGHBOUR'S NUMBER manufactured a red once. A seventh suite would
 * have rediscovered the same thing a seventh time.
 *
 * ## Why a shared constant and NOT a repo-wide `[test] timeout`
 *
 * Controller decision, 2026-09-07. A `[test] timeout` in `bunfig.toml` would
 * raise the budget for every suite in the repo, which hides a genuine hang
 * everywhere in exchange for fixing seven files. The constants here stay
 * VISIBLE at each call site and the register can point at one place.
 *
 * ## Why THREE shapes and not one
 *
 * W7-ae's correction, folded in as spec: the family has two budget SHAPES that a
 * single `…_HOOK_…` name would have mis-described for a third of its callers,
 * and `format-adapters.test.ts` has a third.
 *
 * - {@link MODULE_GRAPH_HOOK_BUDGET_MS} — the third argument of a
 *   `beforeAll`/`beforeEach` that pays the import.
 * - {@link MODULE_GRAPH_BUDGET_MS} — `setDefaultTimeout(…)`, when the cost is
 *   spread across the whole file rather than concentrated in one hook.
 * - {@link MODULE_GRAPH_CASE_BUDGET_MS} — `setDefaultTimeout(…)` for a suite
 *   whose per-CASE work, not its import, is what runs long.
 *
 * They are separate exports rather than one neutral name because the name is the
 * only thing at the call site that says WHICH cost is being budgeted, and a
 * reader who cannot tell those apart cannot size the next one.
 *
 * ## THE SIZING RULE — read this before changing a number or adding a caller
 *
 * **Size against the largest observed run TOTAL, never a warm reading, never a
 * per-case floor.** Three separate measurements say why:
 *
 * - A warm reading is the page cache, not the file. `plugin-info-diagnostics.test.tsx`
 *   measured **2.19 s** straight after `typecheck:electron` had warmed the cache
 *   and **354.41 s** cold — **162x** on the same bytes (W7-ag, 2026-09-07).
 * - Wall time on this family does not track load. The same file measured
 *   **354.41 s at load 7.59** and **127.25 s at load 14.97** — a 2.8x spread
 *   running BACKWARDS against load, every cold run under 2 % cpu.
 * - So *"it passes alone at low load, therefore starvation"* hands out the wrong
 *   name on an I/O-bound graph.
 *
 * ## THE ZERO-CASE CONTROL — price the graph before choosing a number
 *
 * Run the file with a filter that matches nothing. Bun still loads the file and
 * executes zero cases, so what comes back is the STATIC top-level graph's price
 * with the tests subtracted:
 *
 * ```sh
 * bun test <file> -t '<a name nothing matches>'
 * ```
 *
 * On `plugin-info-diagnostics.test.tsx` that returned **53.87 s with 0 cases
 * executed**, at 0.56 s user / 0.35 s sys. **Read `user`/`sys` beside the wall
 * time**: cpu under ~2 % of wall is I/O, and a budget for I/O is not a budget
 * for contention. Take the reading on a COLD tree — never straight after a
 * typecheck or a tree-wide grep, which is the cache and not the file.
 *
 * **What it does NOT price, corrected 2026-09-10 (P6.1001).** Where the hook's
 * import is DYNAMIC — which is this whole family — a zero-case run never pays it:
 * with no case selected bun skips the describe, so the hook does not run and its
 * `await import(...)` is never reached (bun says so itself, `skipping 6 tests`).
 * The control is therefore a LOWER bound on the file, not an upper bound on the
 * hook's own import; measured the same day, the full run cost **3.4x** the
 * zero-case run on identical bytes. That makes every budget sized UP from a
 * control safer rather than wrong, and it is worth knowing before quoting one.
 *
 * A caller whose measured floor does not fit one of the three numbers below
 * should declare its own constant beside its `setDefaultTimeout` WITH its
 * reading written down, rather than rounding itself up into one of these.
 *
 * ## THEN WRITE THE READING DOWN — `scripts/module-graph-hook-costs.txt`
 *
 * P6.1000. A reading taken and left in a lane report is a reading the next lane
 * re-takes: the three cluster controls this family was sized from sat in one
 * report for two days, and P6.997 measured its own member at 252.2 s — 0.42 of
 * the hook budget below — with nowhere to put the number. Append it there as
 * `<file> <ms> <date> <load>` (`-` for a load you did not record), one line per
 * reading, never editing somebody else's; `check-module-graph-hooks` prints the
 * largest per file beside the budget it has to fit, with the ratio, and warns
 * once a member has measured past half of it.
 *
 * That warning is the only instrument in this tree that can say a number below
 * has been OUTGROWN. These three are sized against readings, and a reading
 * nobody wrote down cannot size anything.
 */

/**
 * A `beforeAll`/`beforeEach` that pays a `SessionManager.ts`-rooted import.
 *
 * 600 000 ms. Sized against the largest observed cold run TOTAL in the family
 * (354.41 s on `plugin-info-diagnostics.test.tsx`, W7-ag 2026-09-07) with room
 * for a graph that keeps growing, and NOT against the two 120 000 readings the
 * `server-core` pair used: those two are the same shape on a smaller graph, and
 * one budget that covers the largest member is the point of having one site.
 *
 * ## Re-measured and deliberately NOT raised — P6.1001, 2026-09-10
 *
 * The cost ledger warns that this member sits at 0.59 of its budget, which reads
 * as 1.7x of head over the family's largest. Re-measured on the same bytes: the
 * whole file runs end to end in **1 089 ms and 1 194 ms** at load 8.8, 6 pass /
 * 0 fail — **325x below** the reading above, whose load was 7.59. The load
 * average did not move; the CPU SHARE did, from about 2 % then to about 140 %
 * (`user+sys` over `real`) now. So the 0.59 is a reading of an I/O-STARVATION
 * regime this rig sometimes enters, not of a graph that has grown, and the head
 * this number carries is margin against that regime rather than slack about to
 * run out.
 *
 * Raising it would buy nothing and would cost what the ceiling is for: a hung
 * hook has to be heard about, and sizing UP is a cost rather than a free margin.
 * Every reading and the two paired alternating arms are written down in
 * `scripts/module-graph-hook-costs.txt`, in the comment block at its foot — as
 * prose rather than as ledger lines, because they are WARM readings and that
 * file's own rule refuses one.
 */
export const MODULE_GRAPH_HOOK_BUDGET_MS = 600_000

/**
 * `setDefaultTimeout(…)` for a file whose import cost is spread across its cases
 * rather than concentrated in one hook.
 *
 * 900 000 ms — higher than the hook budget on purpose, because this one is a
 * PER-CASE ceiling multiplied by however many cases the file has, and the
 * failure it prevents is the last case timing out on a graph the first case
 * already paid for.
 */
export const MODULE_GRAPH_BUDGET_MS = 900_000

/**
 * `setDefaultTimeout(…)` for a suite whose per-CASE work is what runs long — the
 * import is ordinary and the cases are not.
 *
 * 300 000 ms. Deliberately the smallest of the three: a case budget sized like
 * an import budget would let a genuinely hung case sit for a quarter of an hour
 * before anyone heard about it, which is the whole objection to the repo-wide
 * `[test] timeout` this module exists instead of.
 */
export const MODULE_GRAPH_CASE_BUDGET_MS = 300_000

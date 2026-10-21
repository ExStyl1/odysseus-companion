import { beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets';

/**
 * P6.997 — the `import.meta.main` guard's only importer.
 *
 * ## What this file is the control for
 *
 * P3.291 measured a mutation SURVIVOR: `index.ts` supplies P3.272's
 * `filterDeniedResultPaths` to every `LocalToolRuntime` it builds, and dropping
 * that one option left every suite in this repo green — because `main()` ran at
 * module scope, so no test could import the module without starting a server on
 * the runner's stdin. W2-p added `if (import.meta.main) { main() }` and measured
 * both sides of it (through this package's own build, and on the packaged 1.33.0
 * bundle where it was re-broken with `if (true)` to reproduce the pre-fix
 * behaviour), closing the row with the sentence *"a test may now import the
 * module"*.
 *
 * Nothing did. Measured 2026-09-10 over the package, `from '../index.ts'` scored
 * **0** files: every other reference is either a source-text read or a path
 * handed to a spawned child. So the guard could have been deleted and nothing
 * would have gone red — the fix and the survivor were both unguarded. This file
 * is the importer, and it is deliberately the only one.
 *
 * ## What each case would catch
 *
 * - Delete the guard, and the NEGATIVE case goes red rather than hanging:
 *   `main()` attaches a readline to `process.stdin` and installs
 *   `uncaughtException` / `unhandledRejection`, so the three deltas below stop
 *   being zero inside the runner's own process.
 * - Drop the option, and the POSITIVE case goes red: it reads the
 *   `createRuntime` block of the very module it imported, and its re-break arm
 *   proves the assertion is not satisfied by the comment that names the same
 *   identifier two lines above the option.
 *
 * ## The three signals, and why not "no listeners at all"
 *
 * Measured on this import (2026-09-10, plain `bun` process): `uncaughtException`
 * 0 → 0, `unhandledRejection` 0 → 0, `process.stdin` `data` 0 → 0 — and `SIGINT`
 * **0 → 1**. Something in the module graph registers a SIGINT listener at import
 * time; `main()` does not. So a blanket *"the import adds no process listener"*
 * would be false today, and the three signals asserted here are exactly the ones
 * `main()` installs and nothing else in the graph touched. That claim gets its
 * own positive control in the third case, because AGENTS.md asks one of every
 * absence finding: the case does to THIS process what `main()` does to the
 * subprocess and all three move (0/0/0 → 1/1/1), then puts them back.
 *
 * ## The cost, and the budget
 *
 * Four readings of the SAME import, all 2026-09-10, and they span **100x** — the
 * spread is the page cache, not the load:
 *
 * - **222.8 s** at load 7.67, `user 2.36` / `sys 1.11` against `real 227.82`.
 * - **252.2 s** at load 11.40, `user 2.44` / `sys 1.03` against `real 255.35` —
 *   the second run of the same probe, and SLOWER than the first, so a warm graph
 *   is not what this depends on.
 * - **~2.5 s** under `bun test` taken straight after those two, `real 2.87`.
 * - **88.5 s** under `bun test` again after one `typecheck:scripts` in between,
 *   `real 95.35`, `user 2.32` / `sys 1.08`.
 *
 * Around 1 % cpu on every cold reading, so this is the I/O-bound module-graph
 * family `packages/shared/src/testing/module-graph-budgets.ts` exists for and not
 * contention — and the 2.5 s reading is the trap that module warns about, a
 * measurement of the cache rather than of the file. Sized, per its rule, against
 * the largest observed TOTAL: it is paid in a `beforeAll` under
 * {@link MODULE_GRAPH_HOOK_BUDGET_MS}, and 600 000 ms against 255 s is the
 * headroom that rule asks for.
 *
 * ## The residue, stated rather than guarded
 *
 * The negative case is a DELTA across the import, which is what makes it robust
 * to whatever a sibling file in the same `bun test` process has already done.
 * The cost of that shape: were a second file in the same batch ever to import
 * `../index.ts` first, the module would be cached, the delta would be zero for
 * free, and this case would pass vacuously. That is why this is the only
 * importer — and if a second one is ever added, this comment is the reason to
 * make it a child process instead.
 */

const serverSource = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');

/** Exactly the three things `main()` installs, and nothing the graph also touches. */
function snapshot() {
  return {
    uncaughtException: process.listenerCount('uncaughtException'),
    unhandledRejection: process.listenerCount('unhandledRejection'),
    stdinData: process.stdin.listenerCount('data'),
  };
}

let before: ReturnType<typeof snapshot> | undefined;
let after: ReturnType<typeof snapshot> | undefined;
let imported: unknown;

beforeAll(async () => {
  // Snapshot and import with nothing in between: `bun test` runs the files of a
  // batch in ONE process, so a snapshot taken at module scope could be separated
  // from the import by another file's hooks.
  before = snapshot();
  imported = await import('../index.ts');
  after = snapshot();
}, MODULE_GRAPH_HOOK_BUDGET_MS);

/** The option line itself — the comment two lines above names the same identifier. */
const OPTION_LINE = /^\s*filterDeniedResultPaths,$/m;

describe('the pi-agent-server entrypoint is importable, and importing it starts nothing', () => {
  it('supplies filterDeniedResultPaths to every LocalToolRuntime it builds', () => {
    expect(imported).toBeDefined();

    const start = serverSource.indexOf('const createRuntime = (');
    const end = serverSource.indexOf('const createExecutor = (', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = serverSource.slice(start, end);

    expect(block).toContain('new LocalToolRuntime({');
    expect(OPTION_LINE.test(block)).toBe(true);

    // P3.291's mutant M5, re-broken here: with the option line removed the
    // assertion above must fail, so it cannot be passing on the comment beside
    // it or on the function declaration further down the file.
    expect(OPTION_LINE.test(block.replace(OPTION_LINE, ''))).toBe(false);
  });

  it('does not run main() on import — no readline on stdin, no process handlers', () => {
    expect(before).toBeDefined();
    expect(after).toEqual(before!);
    expect(after!.stdinData).toBe(before!.stdinData);

    // The guard is what makes the assertion above possible; naming it here makes
    // the failure legible when someone removes it.
    expect(serverSource).toContain('if (import.meta.main) {');
  });

  // AGENTS.md: an ABSENCE finding needs a positive control on the same rig. The
  // case above says three numbers did not move; this one does to THIS process
  // exactly what `main()` does to the subprocess — a readline on `process.stdin`
  // and the two handlers — and shows all three move, then puts them back.
  it('and those three signals are the ones main() moves, so the absence above is not free', () => {
    const onUncaught = () => {};
    const onUnhandled = () => {};

    const clean = snapshot();
    const readline = createInterface({ input: process.stdin });
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);
    const started = snapshot();

    readline.close();
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
    process.stdin.pause();

    expect(started.uncaughtException).toBe(clean.uncaughtException + 1);
    expect(started.unhandledRejection).toBe(clean.unhandledRejection + 1);
    expect(started.stdinData).toBeGreaterThan(clean.stdinData);
    // Restored, so this case cannot make the runner or a sibling file wrong.
    expect(snapshot()).toEqual(clean);
  });
});

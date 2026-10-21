#!/usr/bin/env bun
/**
 * The child process `barrel-import-safety.test.ts` runs its imports in.
 *
 * WHY A CHILD AND NOT AN `await import` IN THE TEST. Measured 2026-09-03
 * (`P3.316`), and it is the largest single cause of the full gate's reds.
 *
 * The barrel scan imports 92 real production barrels. 16 of them reach
 * `packages/ui`'s two Vite-only imports of
 * `pdfjs-dist/build/pdf.worker.min.mjs?url`, which bun's loader resolves to the
 * real `node_modules` file — a module with no `default` export — so the graph
 * fails to link. The scan CATCHES that, by design. What catching it does not do
 * is contain it: bun keeps the failed module record for the rest of the
 * process, and a later file's `mock.module()` on the same specifier loses to
 * it. So 30 of the gate's 68 reds were 21 renderer suites that each declare
 * their own `mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', …)` and
 * pass 217/0 as a group with this scan absent — 116/30 with it, in BOTH
 * command orders, which is what says "module registry" rather than "file
 * sequence".
 *
 * Two things were measured before choosing containment, because the obvious fix
 * is to declare the mock in the scan itself:
 *
 *   * Mocking the worker URL there MOVES the poisoning one layer down. The real
 *     `pdfjs-dist` then evaluates and throws `ReferenceError: DOMMatrix is not
 *     defined` — 46 reds, 16 here and 30 in the same suites, whose own
 *     `mock.module('pdfjs-dist', …)` now loses to THAT record.
 *   * Adding the renderer suites' `DOMMatrix` stub too moves it down again:
 *     `apps/electron/src/renderer/context/ThemeContext.tsx` calls Vite's
 *     `import.meta.glob`, which bun has no equivalent for at all, so four
 *     suites that mock `@/context/ThemeContext` inherit ITS failed record
 *     (289/9, all nine `import.meta.glob is not a function`).
 *
 * Three layers, and the third cannot be mocked — `import.meta.glob` is a
 * compile-time transform, not a module. So the fix is not another stub: it is
 * that a scan whose whole purpose is to provoke import failures must not
 * provoke them inside the process every other suite shares. The failures stay
 * exactly as they were, in a process that exits.
 *
 * The candidate mechanism the attribution lane proposed — the tree's five
 * process-wide `mock.restore()` call sites — is REFUTED: each of the five,
 * prepended to the same 21 files, ran 217-224 pass / 0 fail.
 *
 * PROTOCOL. `bun scripts/barrel-import-probe.ts <out.json> <barrel>...`, paths
 * relative to the repo root, one JSON array written to `<out.json>`. Results go
 * to a FILE and not to stdout: a barrel is free to print, and a scan whose
 * verdicts share a channel with its subjects' output is a parser waiting to
 * misread one.
 *
 * Every side effect is behind `import.meta.main`. A fixture whose module body
 * ends in a process exit kills the test runner AT IMPORT TIME and reports exit
 * 0 with zero tests executed (measured 2026-09-01 on a sibling), so the reader
 * can import the type and the function without running either.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface BarrelProbeResult {
  /** Repo-relative path, exactly as it was passed in — the reader keys on it. */
  name: string
  /** True only for an import that resolved to a module object. */
  ok: boolean
  /** The thrown message, verbatim, so the reader decides what is acceptable. */
  message: string
}

/**
 * Import each barrel in order, recording rather than throwing.
 *
 * Sequential on purpose: a barrel pulls a whole subsystem, and the failure this
 * guard exists for is an evaluation error whose blame is the module being
 * evaluated. Importing in parallel would interleave the graphs and let one
 * barrel's failure be reported against another.
 */
export async function probeBarrels(repoRoot: string, names: readonly string[]): Promise<BarrelProbeResult[]> {
  const results: BarrelProbeResult[] = []
  for (const name of names) {
    try {
      const mod = (await import(join(repoRoot, name))) as Record<string, unknown> | undefined
      results.push(
        mod === undefined || mod === null
          ? { name, ok: false, message: 'the import resolved, and to nothing: no module object' }
          : { name, ok: true, message: '' },
      )
    } catch (error) {
      results.push({ name, ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}

if (import.meta.main) {
  const [outPath, ...names] = process.argv.slice(2)
  if (outPath === undefined || names.length === 0) {
    console.error('usage: bun scripts/barrel-import-probe.ts <out.json> <repo-relative barrel>...')
    process.exit(2)
  }
  const repoRoot = join(import.meta.dir, '..')
  writeFileSync(outPath, JSON.stringify(await probeBarrels(repoRoot, names)), 'utf-8')
  process.exit(0)
}

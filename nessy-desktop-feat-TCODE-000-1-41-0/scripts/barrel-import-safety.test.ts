/**
 * The files with the widest blast radius are the ones nothing loads.
 *
 * Tests import LEAVES. A barrel — a file whose body is nothing but re-exports —
 * is imported by production code and by almost nothing else, so the one file
 * kind whose failure takes a whole subsystem down on import is the one kind our
 * test topology systematically never touches. Three were proven unreachable by
 * mutation (`apps/electron/src/transport/index.ts`,
 * `packages/shared/src/agent/backend/{claude,pi}/index.ts`): the suites passed
 * 47/0 and 446/0 across 35 files while a module-killing bug sat in them.
 *
 * The four `import-safety.test.ts` scans that landed for that finding cover
 * four DIRECTORIES (`shared/src/agent`, `shared/src/protocol`,
 * `shared/src/version`, `electron/src/transport`). This file covers the
 * remainder, and it is scoped by SHAPE rather than by location: every barrel in
 * the tree, wherever it is, including one added tomorrow by someone who has
 * never read this file.
 *
 * Measured 2026-08-29, over the 2431 tracked non-test modules under
 * `packages/*` and `apps/*`:
 *
 *   92  barrels
 *   49  reachable from some test through a static runtime import
 *   43  reachable from none
 *    3  of those 43 covered by the four directory scans (dynamically imported,
 *       which is why a static reachability walk does not see them)
 *   40  guarded by nothing at all — the hole this file closes
 *
 * Of those 40, 26 are fully evaluated here and 14 are link-only for the reason
 * below; two further barrels that a test DOES reach are link-only too, for 16
 * in all. Cost measured on the same day: 155s cold, 19.6s warm — a barrel pulls
 * a whole subsystem, so this is a slower guard than the four leaf scans and
 * still cheap against the failure it catches.
 *
 * WHY A SCAN AND NOT A LIST, same reason as the four siblings: the protection a
 * list gives is a coincidence of topology that nobody owns and nothing
 * announces when it stops holding. A list of 92 paths is a topology someone has
 * to maintain, and nobody was maintaining the one we already had.
 *
 * WHAT THIS CATCHES. Type ERASURE, primarily — a binding that exists for the
 * type system and not for the emitter, referenced from a position the emitter
 * keeps:
 *
 * ```ts
 * declare const _unclassified: Exclude<Channel, Classified>  // erased
 * const _assert: never = _unclassified                       // NOT erased
 * ```
 *
 * `tsc --noEmit` is green on that module and it throws `ReferenceError` the
 * instant anything imports it — and, through the barrel, so does every module
 * behind it.
 *
 * THE ONE CARVE-OUT, AND WHAT IT COSTS. 16 of the 92 barrels reach
 * `packages/ui`'s two Vite-only imports of
 * `pdfjs-dist/build/pdf.worker.min.mjs?url`. Vite resolves the `?url` suffix;
 * bun does not, so those graphs fail to LINK under `bun test` and cannot be
 * evaluated here at all. They are not skipped by name — a failing import is
 * accepted only when the error message itself names a Vite resource query, so
 * any OTHER failure in those same barrels is a red test.
 *
 * Be precise about what that leaves uncovered: linking happens before
 * evaluation of any module in the graph, so for those 14 a link defect (a
 * missing export) still surfaces here, while an evaluation defect — the
 * erasure shape above, the one this file exists for — is masked. The carve-out
 * is a stated hole, not a pass. Closing it means removing the `?url` imports
 * from the renderer graph, which is a production change and not this guard's
 * job; `viteOnlyCarveOutIsStillNeeded` below goes red the day someone does it,
 * so the hole cannot quietly outlive its reason.
 *
 * AND THE CARVE-OUT IS PAID IN A CHILD PROCESS, since 2026-09-03 (`P3.316`).
 * Catching a link failure does not contain it: bun keeps the failed module
 * record for the rest of the run, and a later suite's `mock.module()` on the
 * same specifier loses to it. That is what made 30 of the full gate's 68 reds
 * — 21 renderer suites that pass 217/0 as a group with this file absent and
 * 116/30 with it, in both command orders. The imports therefore happen in
 * `barrel-import-probe.ts`, whose docblock carries the whole measurement and
 * the two deeper layers that mocking the specifier here would have exposed
 * instead of fixing. Verdicts are unchanged: the child throws exactly what an
 * in-process import threw, and every assertion below reads the same messages.
 */
import { beforeAll, describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, existsSync, rmSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { BarrelProbeResult } from './barrel-import-probe.ts'

const REPO_ROOT = join(import.meta.dir, '..')

/** The two `workspaces` globs in the root package.json, and nothing else — every barrel found sits under one of them. */
const ROOTS = ['packages', 'apps']

const SKIPPED_DIRS = new Set([
  'node_modules', 'dist', 'release', 'out', 'coverage', '.git', '.vite', '__snapshots__', 'build',
])

/**
 * A barrel is a file whose body, once comments are removed, is re-exports and
 * nothing else. Detecting the SHAPE rather than the NAME matters twice over:
 * `apps/electron/src/renderer/components/ui/drawer.tsx` and
 * `apps/electron/src/runtime/platform.ts` are barrels that are not called
 * `index.ts`, and plenty of `index.ts` files hold real code and are therefore
 * not barrels — they get their coverage from whatever imports that code.
 */
const REEXPORT = /export\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z0-9_$]+)?|\{[^}]*\})\s*from\s*['"][^'"]+['"]\s*;?/g

function isBarrel(source: string): boolean {
  const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  if (body.match(REEXPORT) === null) return false
  return /^;*$/.test(body.replace(REEXPORT, '').trim())
}

function scanBarrels(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      // `__tests__` is skipped for the same reason the four sibling scans skip
      // it, plus one this file is exposed to that they are not: it holds
      // fixtures that are BROKEN ON PURPOSE. A barrel there has no production
      // blast radius, and importing a deliberately-throwing probe would turn
      // this guard red for a defect that is the point of the fixture. Zero of
      // the 92 sit there today; the skip is so that stays a non-event.
      if (entry.name !== '__tests__') scanBarrels(full, found)
      continue
    }
    if (!entry.isFile()) continue
    if (!/\.tsx?$/.test(entry.name)) continue
    // `.test.ts` is excluded for a reason stronger than tidiness: importing a
    // test file RUNS it, so a scan that swept them in would re-execute a large
    // slice of the suite as a side effect of this one file.
    if (/\.d\.ts$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue
    if (isBarrel(readFileSync(full, 'utf-8'))) found.push(full)
  }
  return found
}

const BARRELS = ROOTS.flatMap(root => scanBarrels(join(REPO_ROOT, root)))
  .map(file => relative(REPO_ROOT, file))
  .sort()

/**
 * Vite rewrites `…?url` / `?raw` / `?worker` / `?inline` into an asset URL.
 * Bun has no such resolver, so the specifier reaches the module loader intact
 * and the graph fails to link. Matching the MESSAGE rather than skipping the
 * FILE is the whole point: it is derived from what actually went wrong, so a
 * genuine defect in one of these barrels is still a red test.
 */
const VITE_RESOURCE_QUERY = /\?(url|raw|worker|inline)\b/

/**
 * One budget for the whole probe, not one per barrel.
 *
 * The floor measured 2026-09-03 at load 19-29 on 8 CPUs: 21.8 s for the 92
 * barrels in process, 45.4 s with the 16 carve-out graphs actually evaluated.
 * 300 s is that floor with room for a cold module cache — the same run cost
 * 155 s cold on 2026-08-29 — set against the measurement rather than at zero,
 * because a budget below the resting state manufactures its own failure.
 */
const PROBE_TIMEOUT_MS = 300_000

/**
 * The budget of `viteOnlyCarveOutIsStillNeeded`, which reads every `.ts`/`.tsx`
 * file under `packages/ui/src` and had none of its own, so bun's 5 s default
 * applied (F1.972). That walk is per-file-open latency, not work: 197 files, 2
 * hits, priced alone at `real 15.96 user 0.03 sys 0.03` (CI-d2, 2026-09-26,
 * where the test went red at 10 972 ms against 5 000) and at `real 98.04`,
 * `82.44`, `83.26`, each `user 0.04 sys 0.04`, at load 9-10 later that day.
 * 300 s is about three times the worst of those. The walk is synchronous, so
 * bun's timer cannot stop it early anyway; the budget only decides whether a
 * walk that finished is still reported red, and below the resting state it
 * manufactures that red.
 */
const VITE_SCAN_TIMEOUT_MS = 300_000

const PROBE = join(import.meta.dir, 'barrel-import-probe.ts')

/** Filled by the `beforeAll` below; empty until then, and empty is a failure. */
const RESULTS = new Map<string, BarrelProbeResult>()

/** Non-empty when the child could not be run or read at all — reported once, not 92 times. */
let probeFailure = ''

/**
 * `accepted`, or the reason this barrel is not — as a string, so the one
 * assertion per barrel prints the thrown message rather than a boolean.
 */
function verdict(name: string): string {
  const result = RESULTS.get(name)
  if (result === undefined) return `the probe reported no result for ${name}`
  if (result.ok) return 'accepted'
  // Linked-but-not-evaluated. See the carve-out paragraphs in the header: a
  // link defect here would carry a different message and still fail.
  if (VITE_RESOURCE_QUERY.test(result.message)) return 'accepted'
  return result.message
}

describe('every barrel in the tree imports at runtime', () => {
  beforeAll(() => {
    const out = join(tmpdir(), `barrel-import-probe-${process.pid}-${Date.now()}.json`)
    // The child inherits the top-level `preload` (the electron stub), not
    // `[test].preload`, so the config isolation `bun test` gets is passed
    // explicitly: a barrel that resolves CONFIG_DIR at import time must not
    // reach the real `~/.nessy-agent`.
    const env = { ...process.env, NESSY_CONFIG_DIR: process.env.NESSY_CONFIG_DIR ?? join(tmpdir(), 'barrel-probe-config') }
    // Console output goes to a FILE, never to a pipe. Barrels log at import
    // (`[SourceServerBuilder] Building public API server for alpha`, and more),
    // and `spawnSync` does not drain a pipe while it waits — so `stdout: 'pipe'`
    // filled the buffer and DEADLOCKED, which presents as a hung suite with no
    // error and no timeout report (measured here, 2026-09-03, before this line).
    const log = join(tmpdir(), `barrel-import-probe-${process.pid}-${Date.now()}.log`)
    const logFd = openSync(log, 'w')
    let run: ReturnType<typeof Bun.spawnSync>
    try {
      run = Bun.spawnSync(['bun', PROBE, out, ...BARRELS], {
        cwd: REPO_ROOT,
        env,
        timeout: PROBE_TIMEOUT_MS,
        stdout: logFd,
        stderr: logFd,
      })
    } finally {
      closeSync(logFd)
    }
    try {
      const raw = existsSync(out) ? readFileSync(out, 'utf-8') : ''
      if (raw === '') {
        probeFailure =
          `the probe wrote no results (exit ${String(run.exitCode)}, signal ${String(run.signalCode)}). `
          + `output tail: ${readFileSync(log, 'utf-8').slice(-2000)}`
        return
      }
      for (const entry of JSON.parse(raw) as BarrelProbeResult[]) RESULTS.set(entry.name, entry)
    } finally {
      rmSync(out, { force: true })
      rmSync(log, { force: true })
    }
  }, PROBE_TIMEOUT_MS + 30_000)

  /**
   * The probe is the single point of failure this file now has, so it is
   * asserted before anything reads it: a child that wrote nothing would make
   * every barrel below fail with the same unhelpful message, and a child that
   * wrote a SHORT list would leave the missing ones silently unchecked.
   */
  test('the probe ran, and reported every barrel the scan found', () => {
    expect(probeFailure).toBe('')
    expect(RESULTS.size).toBe(BARRELS.length)
  })

  /**
   * The vacuity control for the 92 assertions below, and it is needed in BOTH
   * directions. `verdict` answers `accepted` for an import that succeeded AND
   * for one that failed with a Vite message — so a probe that reported every
   * barrel as a Vite failure, and a probe that reported every barrel as fine
   * without importing anything, would each turn this whole file green. The two
   * populations are therefore counted: most barrels must genuinely EVALUATE,
   * and the carve-out must stay the small stated hole rather than growing into
   * the file's answer.
   *
   * Floors and a ceiling, not exact numbers — 92 barrels and 16 carve-outs on
   * 2026-08-29, both of which move as the tree does — set either side of the
   * measured values rather than at zero.
   */
  test('most barrels evaluate, and the Vite carve-out stays a small minority', () => {
    const reported = [...RESULTS.values()]
    const evaluated = reported.filter(result => result.ok)
    const carvedOut = reported.filter(result => !result.ok && VITE_RESOURCE_QUERY.test(result.message))
    expect(evaluated.length).toBeGreaterThan(50)
    expect(carvedOut.length).toBeGreaterThan(0)
    expect(carvedOut.length).toBeLessThan(30)
  })

  /**
   * A scan that matches nothing makes every assertion below vacuous and the
   * file green — the same shape as a test double that drops the argument under
   * test, and it looks exactly like success. Asserted, not assumed.
   */
  test('the scan actually found the barrels it is meant to guard', () => {
    // The three proven-unreachable by mutation, which is what opened this row.
    expect(BARRELS).toContain('apps/electron/src/transport/index.ts')
    expect(BARRELS).toContain('packages/shared/src/agent/backend/claude/index.ts')
    expect(BARRELS).toContain('packages/shared/src/agent/backend/pi/index.ts')
    // A barrel that is not named `index.ts`, so a scan narrowed to that
    // filename fails here instead of passing with the shape half-covered.
    expect(BARRELS).toContain('apps/electron/src/runtime/platform.ts')
    // Both workspace roots, so losing one fails loudly.
    expect(BARRELS.some(name => name.startsWith('packages/'))).toBe(true)
    expect(BARRELS.some(name => name.startsWith('apps/'))).toBe(true)
    // Floor set below the measured 92 and far above any single package's
    // share, so losing the recursion fails here rather than passing quietly.
    expect(BARRELS.length).toBeGreaterThanOrEqual(80)
  })

  /**
   * The carve-out's own staleness guard. It exists because `packages/ui` reaches
   * a Vite-only specifier; the day that stops being true the carve-out is
   * silently accepting failures for a reason that no longer exists, so this
   * goes red and says to delete it.
   */
  test('viteOnlyCarveOutIsStillNeeded', () => {
    const uiDir = join(REPO_ROOT, 'packages/ui/src')
    expect(existsSync(uiDir)).toBe(true)
    const offenders = scanForViteQueries(uiDir)
    expect(offenders.length).toBeGreaterThan(0)
  }, VITE_SCAN_TIMEOUT_MS)

  for (const name of BARRELS) {
    // One test per barrel, still: the probe records rather than throws, so a
    // broken barrel is one named red and the other 91 keep reporting.
    test(`${name} imports without throwing`, () => {
      expect(verdict(name)).toBe('accepted')
    })
  }
})

function scanForViteQueries(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      scanForViteQueries(full, found)
      continue
    }
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue
    for (const match of readFileSync(full, 'utf-8').matchAll(/from\s*['"]([^'"]+)['"]/g)) {
      if (VITE_RESOURCE_QUERY.test(match[1] as string)) found.push(`${relative(REPO_ROOT, full)} → ${match[1] as string}`)
    }
  }
  return found
}

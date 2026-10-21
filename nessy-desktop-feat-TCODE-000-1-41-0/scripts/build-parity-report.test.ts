/**
 * The parity report's stamp is a property of its INPUTS, not of the day it ran.
 *
 * D1.422. `scripts/build-parity-report.py` wrote the clock into its header, and
 * `scripts/check-generator-faithfulness.ts` — a case of CI's `test` job —
 * reproduces every committed artifact byte-for-byte from HEAD. So on the day after
 * any regeneration that gate went red on this one artifact with the date as the
 * only differing bytes: measured 2026-09-20 against the unfixed generator, `first
 * differs at line 10 of 574`, `2026-09-19` against `2026-09-20`, 7 of 8 artifacts
 * identical. A red that recurs on a calendar tick is a merge blocker in disguise,
 * and at the moment a reviewer meets it it is indistinguishable from a real drift.
 *
 * HOW THE CLOCK IS INJECTED, and why the generator carries no test-only knob.
 * Python's `date.today()` is LOCAL time, so two timezones 25 hours apart are never
 * on the same calendar date — at any instant, with no library and no monkeypatch.
 * Measured 2026-09-20 at 02:52 local against the unfixed generator: Kiritimati
 * stamped 2026-09-20 and Midway stamped 2026-09-19, and its line 10 moved with
 * them. The first case below is therefore a real failing arm rather than a knob
 * the old code would have ignored and passed — the trap a knob-shaped arm walks
 * into is that the code under test never reads it, so both runs agree and the arm
 * is green on the very defect it was written for. It carries its own control
 * anyway, because a pair of timezones that happened to agree about the day would
 * make it pass vacuously.
 *
 * WHY THE EXTRACTION CASES OVERWRITE ONE FILE. `extractHead()` archives HEAD, and
 * these arms have to measure the generator in the WORKING TREE — the thing being
 * edited. So the extraction's copy of the generator is replaced by the working
 * tree's and nothing else is touched: the isolation is the gate's own, imported
 * from the gate, so that if the gate's extraction ever changes these arms follow.
 */

import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { copyFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  REPO,
  SKIP_MEANING,
  extractHead,
  gitAvailable,
  pythonExecutable,
} from './check-generator-faithfulness.ts'

// Two `git archive` + `tar` extractions and six python runs. Sized against the
// measured floor — about 9 s at load 16 on 2026-09-20 — and never against zero.
setDefaultTimeout(180_000)

const python = pythonExecutable()
const canRun = python !== undefined && gitAvailable()
if (!canRun) console.warn(`[parity report stamp] ${SKIP_MEANING}`)

const GENERATOR = 'scripts/build-parity-report.py'
const ARTIFACT = 'docs/superpowers/specs/2026-07-30-parity-report.md'
/** The five inputs the generator names in its own provenance paragraph. */
const STAMP_INPUTS = [
  'docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md',
  'docs/superpowers/specs/2026-07-29-deviation-register.md',
  'scripts/claude-doc-pages.tsv',
  'docs/superpowers/plans',
  'docs/superpowers/specs/2026-07-31-claude-coverage-map.md',
]
const PROVENANCE_PREFIX = '**Every number below is a snapshot of FIVE inputs, taken '
/** The phrase the clock branch, and only the clock branch, prints. */
const CLOCK_MARKER = 'FROM THE CLOCK'
/** 25 hours apart, so they are never on the same calendar date. */
const EAST = 'Pacific/Kiritimati'
const WEST = 'Pacific/Midway'

function generate(cwd: string, tz: string): string {
  const run = Bun.spawnSync([python as string, GENERATOR], {
    cwd,
    env: { ...process.env, TZ: tz },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (run.exitCode !== 0) {
    throw new Error(`${GENERATOR} exited ${run.exitCode} in ${cwd}: ${run.stderr.toString().slice(0, 400)}`)
  }
  return run.stdout.toString()
}

function provenanceLine(report: string): string {
  const line = report.split('\n').find(candidate => candidate.startsWith(PROVENANCE_PREFIX))
  if (line === undefined) throw new Error('the generated report carries no provenance line')
  return line
}

function stampOf(report: string): string {
  const line = provenanceLine(report)
  const found = /\b\d{4}-\d{2}-\d{2}\b/.exec(line)
  if (found === null) throw new Error(`the provenance line carries no date: ${line.slice(0, 160)}`)
  return found[0]
}

/** What `date.today()` answers under `tz`, read from the same interpreter. */
function calendarDay(tz: string): string {
  const run = Bun.spawnSync(
    [python as string, '-c', 'import datetime;print(datetime.date.today().isoformat())'],
    { env: { ...process.env, TZ: tz }, stdout: 'pipe', stderr: 'pipe' },
  )
  return run.stdout.toString().trim()
}

describe('the parity report stamp — D1.422', () => {
  it.skipIf(!canRun)('does not move with the calendar', () => {
    // The control first: a pair of timezones that agreed about the day would let
    // the assertion below pass against a generator that reads the clock.
    expect(calendarDay(EAST)).not.toBe(calendarDay(WEST))
    const east = generate(REPO, EAST)
    const west = generate(REPO, WEST)
    // Byte-identity, not stamp-identity: the whole artifact has to reproduce, which
    // is what the faithfulness gate asks of it.
    expect(west).toBe(east)
  })

  it.skipIf(!canRun)('stamps the newest committed change among its five inputs', () => {
    const dated = Bun.spawnSync(['git', 'log', '-1', '--format=%cs', '--', ...STAMP_INPUTS], {
      cwd: REPO,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(dated.exitCode).toBe(0)
    const newest = dated.stdout.toString().trim()
    expect(newest).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(stampOf(generate(REPO, EAST))).toBe(newest)
  })

  it.skipIf(!canRun)('preserves the committed stamp where the inputs have no readable history', () => {
    // The arm that keeps CI green, and the reason the fix is not simply
    // git-or-clock. The faithfulness gate runs the generator inside an extraction
    // it turns into a work tree with `git init` plus `git add -Af` and NO COMMIT,
    // so `git log` there exits 128 — measured 2026-09-20, "your current branch
    // 'master' does not have any commits yet". A generator that fell back to the
    // clock in that position would be red on EVERY day, regeneration day included.
    const workspace = extractHead()
    try {
      copyFileSync(join(REPO, GENERATOR), join(workspace.dir, GENERATOR))
      const committed = stampOf(readFileSync(join(workspace.dir, ARTIFACT), 'utf-8'))
      const east = generate(workspace.dir, EAST)
      const west = generate(workspace.dir, WEST)
      // Both timezones, so this cannot pass by the committed stamp and one day's
      // clock reading happening to coincide.
      expect(stampOf(west)).toBe(stampOf(east))
      expect(stampOf(east)).toBe(committed)
      // A preserved reading is not re-labelled as a clock reading. The needle is
      // one this generator really can spell — the case below is its control.
      expect(provenanceLine(east)).not.toContain(CLOCK_MARKER)
    } finally {
      workspace.discard()
    }
  })

  it.skipIf(!canRun)('says so in the header when it has neither a history nor a committed artifact', () => {
    const workspace = extractHead()
    try {
      copyFileSync(join(REPO, GENERATOR), join(workspace.dir, GENERATOR))
      rmSync(join(workspace.dir, ARTIFACT))
      // Read the day either side of the run: at 25 hours of separation the only way
      // these disagree is a midnight landing mid-case, and then both are honest.
      const before = calendarDay(WEST)
      const report = generate(workspace.dir, WEST)
      const after = calendarDay(WEST)
      expect(provenanceLine(report)).toContain(CLOCK_MARKER)
      expect([before, after]).toContain(stampOf(report))
    } finally {
      workspace.discard()
    }
  })
})

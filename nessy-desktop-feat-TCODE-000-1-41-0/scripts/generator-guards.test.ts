/**
 * The two guards added to the close-out's generators (`P2.339`, `P2.340`).
 *
 * `check-generator-faithfulness.test.ts` next door asks "does each generator
 * still reproduce its artifact?". It cannot ask what these cases ask, because
 * both defects were FAITHFUL: the generator reproduced its output perfectly and
 * the output was wrong. One counted a quotation as a record; the other counted a
 * file the repository does not have. In each case the number came out looking
 * exactly like a measurement.
 *
 * So each case here plants the defect and asserts the guard SAYS SOMETHING. A
 * guard proved only by its silence is indistinguishable from no guard, and this
 * plan has already shipped one absence check that matched nothing at all.
 *
 * WHAT A SKIP MEANS. Both cases need `python3` and `git`. The CI image is
 * `nodejs-22` and carries no Python, so they skip there BY DESIGN, exactly as
 * the faithfulness gate does — and a skipped case is NOT a passed case. The
 * `SKIP_MEANING` case in that file is the one that runs when Python is absent.
 */

import { describe, expect, it } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO, SKIP_MEANING, gitAvailable, pythonExecutable } from './check-generator-faithfulness.ts'

const python = pythonExecutable()
const canRun = python !== undefined && gitAvailable()
if (!canRun) console.warn(`[generator guards] ${SKIP_MEANING}`)

const PREFIX = join(tmpdir(), 'nessy-generator-guards-')

/**
 * Remove a directory this process created under the OS temp dir.
 *
 * The prefix is re-checked here rather than trusted from the caller, for the
 * reason recorded next door: an agent in this repo destroyed unrecoverable user
 * data on 2026-08-25 by pointing a recursive delete at a real home directory.
 */
function discard(dir: string): void {
  if (!dir.startsWith(PREFIX) || dir === PREFIX) {
    throw new Error(`refusing to delete ${dir}: not one of this gate's temporary directories`)
  }
  rmSync(dir, { recursive: true, force: true })
}

interface Run {
  code: number
  stdout: string
  stderr: string
}

function run(dir: string, script: string, args: string[] = []): Run {
  const proc = Bun.spawnSync([python!, join(dir, 'scripts', script), ...args], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }
}

const RECORD = 'the widget surface has no analogue in Nessy today'

describe('P2.339 — a quoted deviation is not a deviation', () => {
  it.skipIf(!canRun)('goes RED, and names the file, when a spec quotes a recorded verdict', () => {
    // A synthetic two-file corpus rather than a copy of HEAD: the defect is a
    // property of the harvester's regex, so the smallest corpus that can carry
    // one record and one quotation of it proves the same thing in a fraction of
    // the time — and cannot go stale when another lane commits a plan.
    const dir = mkdtempSync(PREFIX)
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      mkdirSync(join(dir, 'docs/superpowers/plans'), { recursive: true })
      mkdirSync(join(dir, 'docs/superpowers/specs'), { recursive: true })
      cpSync(
        join(REPO, 'scripts/regenerate-deviation-register.py'),
        join(dir, 'scripts/regenerate-deviation-register.py'),
      )
      // The record, written the way a plan writes one.
      writeFileSync(
        join(dir, 'docs/superpowers/plans/2026-01-01-real-plan.md'),
        `# Real plan\n\n## Deviations recorded\n\n- **documented, not implemented** — ${RECORD}.\n`,
      )

      const clean = run(dir, 'regenerate-deviation-register.py')
      expect(clean.code).toBe(0)
      expect(clean.stdout).toContain('TOTAL 1')
      writeFileSync(join(dir, 'docs/superpowers/specs/2026-07-29-deviation-register.md'), clean.stdout)

      // Positive control: with only the record present, the guard is quiet.
      const before = run(dir, 'regenerate-deviation-register.py', ['--check'])
      expect(before.code).toBe(0)
      expect(before.stdout).toContain('up to date (1 records)')

      // Now the defect, in the shape that actually shipped: a survey file quotes
      // the plan's verdict verbatim and attributes it to the plan that owns it.
      writeFileSync(
        join(dir, 'docs/superpowers/specs/2026-01-02-survey.md'),
        '# Survey\n\n| 93 | `analytics` | ⬜ | The plan at `2026-01-01-real-plan.md:5` already'
        + ` records this as "documented, not implemented — ${RECORD}." so the row stays ⬜. |\n`,
      )

      const after = run(dir, 'regenerate-deviation-register.py', ['--check'])
      // 1. The count is no longer what the committed register says.
      expect(after.code).toBe(1)
      expect(after.stderr).toContain('STALE')
      expect(after.stderr).toContain('+TOTAL 2')
      // 2. And the diff NAMES the file that grew a deviation, which is the whole
      //    tell — a survey records none of its own.
      expect(after.stderr).toContain('2026-01-02-survey.md')
      // 3. The citation warning fires too, naming the file it was taken from.
      expect(after.stderr).toContain('look like a CITATION')
      expect(after.stderr).toContain('2026-01-01-real-plan.md')
    } finally {
      discard(dir)
    }
  }, 60_000)

  it.skipIf(!canRun)('still counts a record a plan writes about a SIBLING plan', () => {
    // The measured limit of the citation heuristic, pinned so nobody promotes it
    // to a filter. Requiring a record's syntactic context — the fix originally
    // proposed — drops ~89 real records that live in prose, and rejecting
    // anything quoted drops the ones a plan presents as a literal category
    // string. The warning is allowed to be wrong; the COUNT is not allowed to
    // silently shrink, so a flagged candidate is still harvested.
    const dir = mkdtempSync(PREFIX)
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      mkdirSync(join(dir, 'docs/superpowers/plans'), { recursive: true })
      mkdirSync(join(dir, 'docs/superpowers/specs'), { recursive: true })
      cpSync(
        join(REPO, 'scripts/regenerate-deviation-register.py'),
        join(dir, 'scripts/regenerate-deviation-register.py'),
      )
      writeFileSync(
        join(dir, 'docs/superpowers/plans/2026-01-03-quoting-plan.md'),
        '# Plan\n\nThe cache rows are already in the register under `2026-01-04-sibling.md`.\n\n'
        + `## The prompt cache\n\n- \`documented, not implemented — ${RECORD}.\`\n`,
      )
      const out = run(dir, 'regenerate-deviation-register.py')
      expect(out.code).toBe(0)
      // Flagged for a human...
      expect(out.stderr).toContain('look like a CITATION')
      // ...and counted anyway.
      expect(out.stdout).toContain('TOTAL 1')
      expect(out.stdout).toContain(RECORD)
    } finally {
      discard(dir)
    }
  }, 60_000)
})

describe('P2.340 — an untracked plan is not an input', () => {
  it.skipIf(!canRun)('ignores an untracked plan, names it, and absorbs it only when told to', () => {
    // This one needs the real corpus: the parity report asserts hard on the
    // tracker's shape, so a synthetic tree cannot exercise it. HEAD is extracted
    // into a throwaway repo so the planted file is genuinely untracked and no
    // other lane's working tree can move the numbers underneath the comparison.
    const dir = mkdtempSync(PREFIX)
    try {
      const tar = join(dir, 'head.tar')
      expect(
        Bun.spawnSync(['git', 'archive', '--format=tar', '-o', tar, 'HEAD', 'scripts', 'docs'], {
          cwd: REPO, stdout: 'pipe', stderr: 'pipe',
        }).exitCode,
      ).toBe(0)
      expect(Bun.spawnSync(['tar', '-xf', tar, '-C', dir], { stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0)
      rmSync(tar)
      // `git archive HEAD` ships the COMMITTED generator, which is the right
      // input for the faithfulness gate and the wrong one here: this case tests
      // the guard, so it must run the working tree's script. Copied in before the
      // commit below, so the script is tracked and only the planted plan is not.
      cpSync(
        join(REPO, 'scripts/build-parity-report.py'),
        join(dir, 'scripts/build-parity-report.py'),
      )
      for (const args of [
        ['init', '-q', '.'],
        ['add', '-A'],
        ['-c', 'user.email=guard@test', '-c', 'user.name=guard', 'commit', '-qm', 'head'],
      ]) {
        expect(Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0)
      }

      const driftLines = (r: Run): number =>
        r.stderr.split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length

      // The baseline is deliberately NOT asserted green: the committed report
      // goes stale the moment any lane commits a plan, and this case is about
      // the guard, not about the artifact's freshness today.
      const baseline = run(dir, 'build-parity-report.py', ['--check'])
      expect(baseline.stderr).not.toContain('untracked input(s) EXCLUDED')

      // Plant an untracked plan that certainly contributes: a copy of a real one.
      cpSync(
        join(dir, 'docs/superpowers/specs/2026-07-31-claude-coverage-map.md'),
        join(dir, 'docs/superpowers/plans/2026-12-31-planted-untracked-plan.md'),
      )

      const guarded = run(dir, 'build-parity-report.py', ['--check'])
      // 1. The verdict is unmoved — a genuine drift is still distinguishable.
      expect(driftLines(guarded)).toBe(driftLines(baseline))
      expect(guarded.code).toBe(baseline.code)
      // 2. And the exclusion is stated, by name. Silence about an absorbed file
      //    is how the original defect reached the committed report.
      expect(guarded.stderr).toContain('untracked input(s) EXCLUDED')
      expect(guarded.stderr).toContain('2026-12-31-planted-untracked-plan.md')

      // 3. The defect, reintroduced deliberately: the old behaviour absorbs the
      //    file and manufactures drift — but now says so instead of implying the
      //    committed tree moved.
      const absorbed = run(dir, 'build-parity-report.py', ['--check', '--include-untracked'])
      expect(driftLines(absorbed)).toBeGreaterThan(driftLines(guarded))
      expect(absorbed.code).toBe(1)
      expect(absorbed.stderr).toContain('UNTRACKED plans/specs are being read as inputs')
      expect(absorbed.stderr).toContain('CAUTION')
    } finally {
      discard(dir)
    }
  }, 180_000)
})

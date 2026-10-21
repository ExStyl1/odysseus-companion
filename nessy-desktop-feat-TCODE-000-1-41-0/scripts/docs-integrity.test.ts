/**
 * A truncated doc file is a silent loss, so this makes it a red test.
 *
 * TWICE IN ONE DAY (2026-08-15) a one-line Python idiom in an agent's own
 * tooling emptied a tracked document and committed it at 0 bytes:
 *
 *     open(p,'w').write(open(p).read().replace(...))
 *
 * Python truncates on `open(p,'w')` BEFORE evaluating the argument, so the read
 * that follows returns `""` and the write stores `""`. The script exits 0 and
 * the commit looks entirely ordinary. It took the active plan file, and an hour
 * later it took the live-audit checklist — in the very commit whose message
 * explained the first incident. Knowing the trap was demonstrably not enough,
 * which is why this is a test and not another paragraph of prose.
 *
 * The check is deliberately dumb: a size floor and a header marker per file.
 * It cannot tell a thoughtful deletion from a bad one and does not try — its
 * whole job is to notice that a document went from hundreds of kilobytes to
 * nothing, which is the failure that actually happened. A file that legitimately
 * shrinks below its floor should have its floor lowered in the same commit,
 * deliberately.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')

/** Long-lived documents whose loss would be expensive and quiet. */
const GUARDED: Array<{ path: string; minBytes: number; marker: string }> = [
  {
    // Owner rule 2026-08-20 made this ONE case×runs table: run narratives
    // moved to docs/testing/cdp-runs/ and the pre-table history to the
    // archive below, so the old 50 KB floor now guards a shape that no
    // longer exists. ~24.7 KB at the restructure; the floor protects
    // against silent emptying, not against the table being a table.
    path: 'docs/testing/cdp-live-checklist.md',
    minBytes: 15_000,
    marker: '# CDP live-audit checklist',
  },
  {
    // Where the checklist's pre-2026-08-18 narratives live now — its loss
    // would be exactly the quiet, expensive loss this guard exists for.
    path: 'docs/testing/cdp-runs/2026-07-30--2026-08-17-run-narratives.md',
    minBytes: 40_000,
    marker: '#',
  },
  {
    path: 'docs/README.md',
    minBytes: 1_000,
    marker: '#',
  },
  {
    path: 'AGENTS.md',
    minBytes: 10_000,
    marker: '# Nessy Desktop Agent Guide',
  },
]

describe('guarded documents are not empty', () => {
  for (const { path, minBytes, marker } of GUARDED) {
    it(`${path} still has its content and its header`, () => {
      const full = join(REPO, path)
      expect(existsSync(full)).toBe(true)
      // Size first: the failure mode is 0 bytes, and reporting the byte count
      // makes a truncation obvious at a glance instead of "marker not found".
      const bytes = statSync(full).size
      expect(bytes).toBeGreaterThan(minBytes)
      expect(readFileSync(full, 'utf8')).toContain(marker)
    })
  }
})

describe('every CDP case file is named in the checklist', () => {
  /**
   * The checklist is the owner-mandated ONE table that decides what live
   * evidence is owed (2026-08-20). A case file that no row names is invisible
   * to that decision, and the loss is silent in both directions: nine
   * `nca-*.ts` cases sat on disk for three weeks while their rows still read
   * `— (case owed)`, which that file's own legend defines as "the driver case
   * itself is not yet written" — so the whole nestor-cloud-agent block would
   * have been dropped from a close-out sitting as un-writable rather than
   * un-run (P3.359).
   *
   * Deliberately one-directional: a row may exist with no file (an obligation
   * recorded before the case is written, which is what `— (case owed)` is
   * FOR), but a file with no row is a case nobody can decide to run.
   */
  const casesDir = join(REPO, 'scripts', 'cdp', 'cases')
  const checklist = readFileSync(join(REPO, 'docs/testing/cdp-live-checklist.md'), 'utf8')
  const caseFiles = readdirSync(casesDir).filter(name => name.endsWith('.ts'))

  it('finds case files to check at all', () => {
    // Positive control: an empty glob would make the assertion below vacuous —
    // the exact shape of failure this repo's register warns about.
    expect(caseFiles.length).toBeGreaterThan(20)
  })

  it('names every case file in the checklist table', () => {
    const unnamed = caseFiles.filter(name => !checklist.includes(`\`${name}\``))
    expect(unnamed).toEqual([])
  })
})

describe('no plan file is empty', () => {
  /**
   * The same accident from the other side, and deliberately ONLY about size.
   *
   * A first version of this also asserted `## Tracker` in every plan, and 91 of
   * them failed: the tracker rule is an owner decision from 2026-07-31 and the
   * plans written before it never had one. Enforcing a later policy
   * retroactively is a different argument from "this file was destroyed", and
   * mixing them would have made the guard unusable on the day it was written.
   * The ACTIVE plan is checked for its tracker below, where the rule applies.
   */
  const dir = join(REPO, 'docs/superpowers/plans')
  const plans = readdirSync(dir).filter(name => name.endsWith('.md'))

  it('finds plans to check at all', () => {
    // The positive control: a glob that silently matched nothing would make
    // every assertion below vacuous.
    expect(plans.length).toBeGreaterThan(5)
  })

  for (const name of plans) {
    it(`${name} is not empty`, () => {
      expect(statSync(join(dir, name)).size).toBeGreaterThan(500)
    })
  }
})

describe('the active plan keeps its tracker', () => {
  /**
   * AGENTS.md: "A plan without a live tracker is not ready to dispatch." That
   * applies to the plan being executed, which is also the file an agent edits
   * dozens of times a day and therefore the one most exposed to a bad write.
   *
   * Repointed 2026-10-02 (UA1.1) from `2026-08-14-runtime-icons-plates-model-sync.md`,
   * a plan closed long ago, to the 1.42.0 upstream-adoption plan — the one the
   * controller now pins rows into several times an hour. Repointed again
   * 2026-10-15 (UB1.1) to the 1.43.0 upstream-adoption plan promoted that day.
   */
  const ACTIVE = 'docs/superpowers/plans/2026-10-14-upstream-adoption-0-15-1.md'

  it(`${ACTIVE} has content and a Tracker section`, () => {
    const full = join(REPO, ACTIVE)
    expect(existsSync(full)).toBe(true)
    expect(statSync(full).size).toBeGreaterThan(50_000)
    expect(readFileSync(full, 'utf8')).toContain('## Tracker')
  })
})

describe('no tracker table is cut in half by a blank line', () => {
  /**
   * A GFM table ENDS at the first blank line, so a blank inside a long Note
   * cell terminates the table there and renders every row below it as loose
   * paragraph text. The failure is invisible in raw markdown — which is how an
   * agent reads the file — and total in rendered view, which is how the owner
   * reads it. One such blank hid fifteen of a plan's seventeen rows until the
   * owner opened it and asked where the tracker had gone.
   *
   * Mechanically detectable, so it is detected here instead: within a tracker
   * table, a row that does not end in `|` has been split, and the next line is
   * either its continuation or the break.
   */
  const dir = join(REPO, 'docs', 'superpowers', 'plans')
  const plans = readdirSync(dir).filter(name => name.endsWith('.md'))

  it('finds plans to check at all', () => {
    // The positive control this file already applies to its sibling sweeps: a
    // glob matching nothing would make every assertion below vacuously true.
    expect(plans.length).toBeGreaterThan(0)
  })

  for (const name of plans) {
    it(`${name} keeps every tracker row inside its table`, () => {
      const lines = readFileSync(join(dir, name), 'utf8').split('\n')
      const broken: string[] = []

      for (const [index, line] of lines.entries()) {
        // Only rows of a table whose header is the tracker's own shape; a
        // narrative table elsewhere in the plan is not this check's business.
        if (!line.startsWith('|') || line.trim().endsWith('|')) continue
        const next = lines[index + 1] ?? ''
        if (next.trim().length === 0) {
          broken.push(`${name}:${index + 2} — row starting at line ${index + 1} is split by a blank line`)
        }
      }

      expect(broken).toEqual([])
    })
  }
})

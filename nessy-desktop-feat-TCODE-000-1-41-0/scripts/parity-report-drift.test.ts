/**
 * F1.108 — a stale parity report NAMES the input that moved.
 *
 * The faithfulness case (`check-generator-faithfulness.test.ts`) could only say that the
 * report differs and list every input the generator has, so a red caused by a controller's
 * plan commit read exactly like the calendar drift D1.422 closed. These arms pin the part that
 * is new — the sorting of changed paths into the generator's own input classes, and a message
 * that names them — without Python or a `git archive`, so they run on any machine. The
 * end-to-end half (a real regeneration against HEAD) is the script's own run, recorded in the
 * row: at the moment it was built the report WAS stale from plan commits, which is the row's
 * control happening by itself.
 */
import { describe, expect, it } from 'bun:test'
import { SPEC_NAMES_CLASS, driftMessage, movedInputs } from './parity-report-drift.ts'

describe('parity-report-drift (F1.108)', () => {
  it('sorts changed paths into the classes the generator reads', () => {
    const moved = movedInputs([
      { status: 'M', path: 'docs/superpowers/plans/2026-09-18-integrations-followup-1.41.0.md' },
      { status: 'A', path: 'docs/superpowers/plans/2026-09-23-upstream-adoption-0-13-4-board-planning-pages.md' },
      { status: 'M', path: 'docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md' },
      { status: 'M', path: 'scripts/claude-doc-pages.tsv' },
      { status: 'A', path: 'docs/superpowers/specs/2026-09-23-new-spec.md' },
    ])
    expect([...moved.keys()].sort()).toEqual(['a plan', 'the Claude doc-page snapshot', 'the parity audit tracker', SPEC_NAMES_CLASS].sort())
    expect(moved.get('a plan')).toHaveLength(2)
  })

  it('ignores what the generator does not read: a spec content edit, a data file, source code', () => {
    const moved = movedInputs([
      { status: 'M', path: 'docs/superpowers/specs/2026-09-07-settings-anchor-rot-disposition.md' },
      { status: 'A', path: 'docs/superpowers/specs/data/phase2-verdicts/f999.json' },
      { status: 'M', path: 'packages/shared/src/agent/pi-agent.ts' },
      { status: 'M', path: 'docs/superpowers/plans/README.txt' },
    ])
    expect(moved.size).toBe(0)
  })

  it('the message names the report, the moved plan, and the remedy', () => {
    const message = driftMessage({
      detail: 'first differs at line 12 of 500 (produced 501 lines)',
      since: { sha: 'abc1234', date: '2026-09-23' },
      moved: movedInputs([{ status: 'M', path: 'docs/superpowers/plans/2026-09-18-integrations-followup-1.41.0.md' }]),
      regenerate: 'python3 scripts/build-parity-report.py > docs/superpowers/specs/2026-07-30-parity-report.md',
    })
    expect(message).toContain('docs/superpowers/specs/2026-07-30-parity-report.md')
    expect(message).toContain('a plan: 1 file(s) — docs/superpowers/plans/2026-09-18-integrations-followup-1.41.0.md')
    expect(message).toContain('since the report was last committed (abc1234, 2026-09-23)')
    expect(message).toContain('python3 scripts/build-parity-report.py >')
  })

  it('a drift with NO moved input says the generator or its environment moved — the other half', () => {
    const message = driftMessage({
      detail: 'first differs at line 3 of 500 (produced 500 lines)',
      since: { sha: 'abc1234', date: '2026-09-23' },
      moved: new Map(),
      regenerate: 'python3 scripts/build-parity-report.py > x',
    })
    expect(message).toContain("NONE of the generator's inputs changed")
    expect(message).not.toContain('a plan:')
  })
})

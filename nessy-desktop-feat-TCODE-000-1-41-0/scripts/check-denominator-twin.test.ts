import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

import {
  censusTwin,
  verdictWord,
  REPO_ROOT,
  ROW_ID,
  SPLIT_CELLS,
  TWIN_DOC,
  TWIN_FIELDS,
  VERDICT_COLUMNS,
  VERDICT_VOCABULARY,
} from './check-denominator-twin'

function rootScripts(): Record<string, string> {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')).scripts as Record<string, string>
}

/** A well-formed row: twelve cells, edges included. */
const row = (id: string, pi: string, claude: string, codex: string) =>
  `| ${id} | a capability | \`page\` | ${pi} | ${claude} | ${codex} | BUILDABLE | M | none | \`path\` symbol \`Name\` |`

describe('censusTwin (C3.341)', () => {
  it('counts a well-formed table and says nothing about it', () => {
    const census = censusTwin([
      '| proposed ledger id | capability | source | Pi | Claude | Codex | klass | size | native | evidence |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      row('A13', '`absent`', '`n/a`', '`n/a`'),
      // Backticks are typography and the header says so: half the real cells
      // wear them and half do not, and both spellings are the same verdict.
      row('A14', 'have', 'have', '`have`'),
      row('A15', '`partial`', 'unknown', '`n/a`'),
    ].join('\n'))

    expect(census.rows).toBe(3)
    expect(census.findings).toEqual([])
  })

  it('reports a row split by an unescaped pipe — the positive control, and the row itself', () => {
    // C3.320's C17: an unescaped `|` inside a `grep -ao … | wc -l` took that row
    // to thirteen fields, and nothing said so for an unknown length of time.
    const census = censusTwin([
      row('A13', '`absent`', '`n/a`', '`n/a`'),
      '| C17 | a capability | `page` | `have` | `have` | `have` | MEASURE | S | none | `grep -ao x | wc -l` |',
    ].join('\n'))

    expect(census.rows).toBe(2)
    expect(census.findings).toHaveLength(1)
    expect(census.findings[0]?.kind).toBe('fields')
    expect(census.findings[0]?.rowId).toBe('C17')
    expect(census.findings[0]?.at).toBe(13)
    expect(census.findings[0]?.line).toBe(2)
  })

  it('an ESCAPED pipe is not a finding — the negative control the splitter must respect', () => {
    const census = censusTwin(
      '| C17 | a capability | `page` | `have` | `have` | `have` | MEASURE | S | none | `grep -ao x \\| wc -l` |',
    )

    expect(census.rows).toBe(1)
    expect(census.findings).toEqual([])
  })

  it('reports a verdict outside this file\'s own vocabulary, and names the column', () => {
    // The ledger's first word is `covered`; here it is spelled `have`, and a
    // mirrored edit that forgets the mapping is exactly what C3.320 swept
    // fifteen of by hand.
    const census = censusTwin(row('B6', '`covered`', '`have`', '`have`'))

    expect(census.findings).toHaveLength(1)
    expect(census.findings[0]?.kind).toBe('verdict')
    expect(census.findings[0]?.at).toBe(VERDICT_COLUMNS[0])
    expect(census.findings[0]?.cell).toBe('`covered`')
  })

  it('does not read the verdict cells of a row whose fields are already wrong', () => {
    // With the split shifted, every column index names a different cell, so a
    // verdict finding derived from it is noise on top of a defect: one row, one
    // finding.
    const census = censusTwin(
      '| C17 | a capability | `page` | `covered` | `covered` | `covered` | MEASURE | S | none | a | b |',
    )

    expect(census.findings).toHaveLength(1)
    expect(census.findings[0]?.kind).toBe('fields')
  })

  it('a line that is not a row is not a row — the header, the rule and the prose', () => {
    expect(censusTwin([
      '| proposed ledger id | capability | source | Pi | Claude | Codex | klass | size | native | evidence |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      'A13 is a row id but this line is prose about it.',
      '| map | denominator swept | what that is |',
    ].join('\n'))).toEqual({ rows: 0, findings: [] })

    expect(ROW_ID.test('A13')).toBe(true)
    expect(ROW_ID.test('capability')).toBe(false)
    expect(ROW_ID.test('~~F20~~')).toBe(false)
  })

  it('strips the typography and nothing else', () => {
    expect(verdictWord('`have`')).toBe('have')
    expect(verdictWord(' have ')).toBe('have')
    expect(verdictWord('`n/a`')).toBe('n/a')
    expect(verdictWord('`have` (see below)')).toBe('have` (see below)')
  })
})

describe('the twin gate and plan-status.py cannot drift apart', () => {
  it('spells the cell separator exactly as `plan-status.py` does', () => {
    // W17-b paid for the alternative: a hand-rolled splitter that read `\\` as
    // an escaped BACKSLASH disagreed with this regex on a `\|` inside a cell and
    // SKIPPED the row. One dialect, one regex — and when they must change, both
    // change in one commit.
    const python = readFileSync(join(REPO_ROOT, 'scripts/plan-status.py'), 'utf-8')
    expect(python).toContain("SPLIT = re.compile(r'(?<!\\\\)\\|')")
    expect(SPLIT_CELLS.source).toBe('(?<!\\\\)\\|')
  })

  it('reads the REAL document, so the unit tests above are not a green run over nothing', () => {
    // The positive control on the same rig: hand-made strings would pass with
    // the reader returning nothing at all.
    const census = censusTwin(readFileSync(join(REPO_ROOT, TWIN_DOC), 'utf-8'))

    expect(census.rows).toBeGreaterThan(400)
    // Deliberately NOT asserted: that today's census is zero. The gate already
    // fails on that, and a test saying the same thing would make one ledger
    // commit produce two reds for one cause.
    expect(TWIN_FIELDS).toBe(12)
    expect(VERDICT_VOCABULARY).toEqual(['have', 'partial', 'absent', 'n/a', 'unknown'])
  })

  it('takes the vocabulary from the document that declares it, not from this file', () => {
    // The five words are the twin's OWN, stated in its header; a sixth word
    // added there and not here would make the gate refuse a legal cell, and a
    // word dropped there would make it accept an illegal one. Neither is
    // catchable by a test that only reads the constant beside it.
    const header = readFileSync(join(REPO_ROOT, TWIN_DOC), 'utf-8').slice(0, 4000)
    for (const word of VERDICT_VOCABULARY) expect(header).toContain(`\`${word}\``)
  })
})

describe('the step is armed (a gate nothing runs is not a gate)', () => {
  it('lint:denominator-twin runs the script in its gating form', () => {
    expect(rootScripts()['lint:denominator-twin']).toContain('scripts/check-denominator-twin.ts')
    // Without `--check` the script is a REPORTER that always exits 0 — the one
    // edit that would leave every assertion above green and the tree unguarded.
    expect(rootScripts()['lint:denominator-twin']).toContain('--check')
  })

  it('lint:chain runs lint:denominator-twin', () => {
    expect(rootScripts()['lint:chain']).toContain('bun run lint:denominator-twin')
  })
})

/**
 * D1.85 — the driven marker `ʳ` exists in the capability ledger and must NOT
 * exist here.
 *
 * The twin's vocabulary is its own and is MARKER-LESS: `check-denominator-twin`
 * already says so in the sentence it prints on a verdict finding, and the sixth
 * marker added to `scripts/plan-status.py` on 2026-09-17 changed nothing about
 * that. This case is the pin on the boundary, because the natural mistake once a
 * marker means something is to carry it across: the capability ledger's
 * `covered ʳ` has no spelling here at all, and a `have ʳ` cell is a finding
 * rather than a stronger claim. The unmarked twin of the same row is the control
 * in the same census, so a reader that stopped seeing verdicts altogether would
 * fail this case instead of passing it.
 */
describe('D1.85 — the twin stays marker-less', () => {
  it('refuses a verdict cell wearing the driven marker, and accepts its unmarked twin', () => {
    const census = censusTwin([
      row('A13', '`have ʳ`', '`have`', '`n/a`'),
      row('A14', '`have`', '`have`', '`n/a`'),
    ].join('\n'))

    expect(census.rows).toBe(2)
    expect(census.findings).toHaveLength(1)
    expect(census.findings[0]?.kind).toBe('verdict')
    expect(census.findings[0]?.rowId).toBe('A13')
    expect(census.findings[0]?.at).toBe(4)
    expect(verdictWord(census.findings[0]?.cell ?? '')).toBe('have ʳ')
    // The vocabulary is the WORD, and the marker is not part of any word here.
    expect(VERDICT_VOCABULARY).not.toContain('have ʳ')
  })
})

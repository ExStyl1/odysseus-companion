#!/usr/bin/env bun
/**
 * check-denominator-twin — the denominator-gaps twin has 525 rows of twelve
 * fields each, and until this existed NOTHING read one of them.
 *
 * C3.341, born from W18-a's proposed row 4 (2026-09-12).
 *
 * ## The defect
 *
 * `scripts/plan-status.py` guards the capability ledger: a row whose cells do
 * not split into nine fields is reported and SKIPPED, because an unescaped `|`
 * inside a cell silently drops it out of every count. Its twin, the denominator
 * sweep, is written in the same table dialect with twelve fields — and no
 * script parses it. `check-ledger-citations.ts` reads it, but for its CITATIONS
 * rather than its rows, so a row that stops being a row is invisible there too.
 *
 * That is not theoretical. C3.320 found C17's evidence cell carrying an
 * unescaped `|` inside a `grep -ao … | wc -l`, so that row split into THIRTEEN
 * fields; it had been that way for an unknown length of time and was found by a
 * hand census. The same defect in the LEDGER moves a coverage percentage and is
 * caught in seconds. P6.935 priced it there: one injected pipe takes the row
 * total 632 → 631 and moves six other published numbers with it.
 *
 * ## What it checks, stated so nobody assumes more
 *
 *  1. **FIELD COUNT.** Every row whose second cell is a capability id must split
 *     into exactly twelve cells, edges included — the same convention
 *     `plan-status.py` uses for its nine.
 *  2. **VERDICT VOCABULARY.** Cells 4, 5 and 6 (Pi, Claude, Codex) must be one
 *     of the five words this file's own header declares: `have`, `partial`,
 *     `absent`, `n/a`, `unknown`. Backticks are accepted on either side because
 *     the header calls them typography and says so deliberately — about half of
 *     the 1 575 verdict cells wear them, and normalising them would bury the one
 *     kind of change that carries meaning. THE WORD is the contract.
 *
 * It does NOT check that a verdict is true, that it agrees with the capability
 * ledger's mirror of the same row, or that a row exists at all. A row deleted
 * outright is invisible here, deliberately: a row-count pin would have to be
 * raised by every lane that writes a denominator row, and a ratchet that is
 * routinely raised teaches its readers to raise it. The count is PRINTED on the
 * summary line instead — a description with a date, which is the owner's 2026-09-10
 * rule for a census that must not gate.
 *
 * ## Why it re-uses `plan-status.py`'s regex rather than a better one
 *
 * W17-b paid for the alternative: a hand-rolled splitter that treated `\\` as an
 * escaped BACKSLASH disagreed with `(?<!\\)\|` on a `\|` inside a cell, split
 * one Why in two, and moved a pipe past a sentence — nine fields became ten and
 * the row was SKIPPED. One dialect, one regex, spelled the same way in both
 * gates. When they disagree the answer is to change both, in one commit.
 *
 * ## The measured start: GREEN, with no baseline and nothing to forgive
 *
 * At HEAD on 2026-09-12: **525 rows, every one of them twelve fields, and 0 of
 * the 1 575 verdict cells outside the vocabulary.** So this gate lands with no
 * baseline file at all — the one shape a baseline would hide is the shape it
 * exists to catch, and there was nothing to record.
 *
 * Usage:
 *   bun scripts/check-denominator-twin.ts            # report, always exit 0
 *   bun scripts/check-denominator-twin.ts --check    # the gate: exit 1 on any finding
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GateSafetyRefusal } from './gate-safety'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The one document this gate reads. Its ledger twin is `plan-status.py`'s subject. */
export const TWIN_DOC = 'docs/superpowers/specs/2026-09-05-denominator-gaps.md'

/**
 * The cell separator, spelled EXACTLY as `scripts/plan-status.py` spells it.
 *
 * See the header: a re-derivation of this rule has already cost a dropped row.
 */
export const SPLIT_CELLS = /(?<!\\)\|/

/** A capability id — `plan-status.py`'s `CAP_ID`, same shape. */
export const ROW_ID = /^[A-Z]\d+$/

/** Twelve cells, edges included: `['', id, capability, source, Pi, Claude, Codex, klass, size, native, evidence, '']`. */
export const TWIN_FIELDS = 12

/** The Pi / Claude / Codex cells, by index into the split. */
export const VERDICT_COLUMNS: readonly number[] = [4, 5, 6]

/** The five words the file's own header declares, and no sixth. */
export const VERDICT_VOCABULARY: readonly string[] = ['have', 'partial', 'absent', 'n/a', 'unknown']

export type TwinFindingKind = 'fields' | 'verdict'

export interface TwinFinding {
  readonly kind: TwinFindingKind
  /** 1-based line in the document. */
  readonly line: number
  readonly rowId: string
  /** For a field finding, the count found; for a verdict finding, the column index. */
  readonly at: number
  /** The cell as written, for a verdict finding. */
  readonly cell?: string
}

export interface TwinCensus {
  readonly rows: number
  readonly findings: readonly TwinFinding[]
}

/** The verdict word a cell carries, with the typography stripped and nothing else. */
export function verdictWord(cell: string): string {
  return cell.trim().replace(/^`+/, '').replace(/`+$/, '').trim()
}

export function censusTwin(text: string): TwinCensus {
  const findings: TwinFinding[] = []
  let rows = 0
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (!line.startsWith('| ')) continue
    const cells = line.split(SPLIT_CELLS).map(cell => cell.trim())
    const rowId = cells[1]
    if (rowId === undefined || !ROW_ID.test(rowId)) continue
    rows += 1
    if (cells.length !== TWIN_FIELDS) {
      // The row is reported and its verdict cells are NOT read: with the fields
      // shifted, every column index below names a different cell, and a second
      // finding derived from a known-broken split is noise on top of a defect.
      findings.push({ kind: 'fields', line: index + 1, rowId, at: cells.length })
      continue
    }
    for (const column of VERDICT_COLUMNS) {
      const cell = cells[column] as string
      if (VERDICT_VOCABULARY.includes(verdictWord(cell))) continue
      findings.push({ kind: 'verdict', line: index + 1, rowId, at: column, cell })
    }
  }
  return { rows, findings }
}

const COLUMN_NAME: Record<number, string> = { 4: 'Pi', 5: 'Claude', 6: 'Codex' }

export function main(argv: readonly string[]): number {
  const check = argv.includes('--check')
  const file = join(REPO_ROOT, TWIN_DOC)
  if (!existsSync(file)) {
    throw new GateSafetyRefusal(
      `REFUSED: ${TWIN_DOC} is missing — a pass here would mean nothing was read.`,
    )
  }
  // The ARTIFACT, so the working tree: this gate's subject is the change in
  // front of you, and one that cannot see an uncommitted edit is useless. The
  // rule and its exception are written out in `check-ledger-citations.ts`.
  const census = censusTwin(readFileSync(file, 'utf-8'))
  if (census.rows === 0) {
    throw new GateSafetyRefusal(
      `REFUSED: ${TWIN_DOC} yielded no rows — the matcher is broken, not the document, and a green run `
      + 'here would report that nothing is wrong with a file nothing was read from.',
    )
  }

  for (const finding of census.findings) {
    if (finding.kind === 'fields') {
      console.log(
        `${TWIN_DOC}:${finding.line}  row ${finding.rowId} has ${finding.at} fields, not ${TWIN_FIELDS}`
        + ' — an unescaped `|` inside a cell. Write it as `\\|`; every reader of this table counts'
        + ' fields, so the row is silently a different row until you do.',
      )
      continue
    }
    console.log(
      `${TWIN_DOC}:${finding.line}  row ${finding.rowId}, the ${COLUMN_NAME[finding.at] ?? finding.at}`
      + ` cell reads ${JSON.stringify(finding.cell ?? '')} — not one of `
      + `${VERDICT_VOCABULARY.join(' / ')}. This file's vocabulary is its own and is MARKER-LESS; the`
      + " capability ledger's `covered` is spelled `have` here.",
    )
  }

  console.log(
    `check-denominator-twin: ${census.findings.length} finding(s) over ${census.rows} row(s) and `
    + `${census.rows * VERDICT_COLUMNS.length} verdict cell(s) in ${TWIN_DOC}. The row count is a`
    + ' reading with a date, not a pin: a deleted row is invisible here, by design.',
  )

  return check && census.findings.length > 0 ? 1 : 0
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    if (error instanceof GateSafetyRefusal) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  }
}

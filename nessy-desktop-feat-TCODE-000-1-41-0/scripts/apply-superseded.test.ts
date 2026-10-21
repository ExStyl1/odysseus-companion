/**
 * The `superseded` marker of the coverage-95 apply JSONs — C3.342, born from
 * W18-a's proposed row 5 (2026-09-12).
 *
 * ## What it is for
 *
 * `docs/superpowers/specs/2026-09-11-coverage-95-apply/<F>.json` is the frozen
 * evidence record of one question family: its `ledger_edits` say which ledger
 * cell moves from which word to which. A cell can be promoted LATER, on evidence
 * the family never saw — and then re-applying that family's edit DEMOTES a
 * correct cell. Three have happened: L4 and L39 codex (C3.290, `dcb9f8dd4`) and
 * M33 codex.
 *
 * Until this row the warning lived in the readme's `problems` array as a
 * sentence, and a sentence is exactly as strong as the next reader's attention.
 * One of the two written on 2026-09-12 was already WRONG when this test was
 * built: it asserted M33's codex cell reads `covered ᵗ` at HEAD, and the cell has
 * read `partial ᵗ` since the denominator sweep was admitted (`0f92d31a0`). The
 * substance survived — never re-apply that edit — but the fact beside it had
 * rotted unread, which is the whole argument for a marker something re-reads.
 *
 * ## What this file checks, and what it deliberately does not
 *
 * For every `superseded` entry: the named ledger row exists, its cell reads the
 * entry's `head_word`, and it does NOT read the `stale_to` the family's evidence
 * JSON still carries — plus that the evidence JSON really carries that edit, so
 * an entry cannot be written about an edit nobody would apply. The prose pointer
 * and the array are required to exist together, in both directions, so the next
 * lane cannot go back to a sentence and cannot leave the human reader of
 * `problems` with no sign that the array is there.
 *
 * It does NOT check that a cell SHOULD be superseded: only a lane reading the
 * evidence can decide that. It reports the cells somebody has already decided
 * about, and it goes red the day one of them is demoted.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APPLY_DIR = 'docs/superpowers/specs/2026-09-11-coverage-95-apply'
const LEDGER = 'docs/superpowers/specs/2026-08-28-capability-ledger.md'

/** `scripts/plan-status.py`'s own splitter — one dialect, one regex. */
const SPLIT_CELLS = /(?<!\\)\|/
/** `plan-status.py`'s `MOVED_COLUMN`, by index into a nine-field ledger row. */
const LEDGER_COLUMN: Record<string, number> = { Pi: 3, Claude: 4, Codex: 5 }
const LEDGER_FIELDS = 9

interface SupersededEntry {
  readonly row: string
  readonly column: string
  readonly stale_to: string
  readonly head_word: string
  readonly promoted_by: string
  readonly found_by: string
  readonly why_en: string
}

/** The verdict a ledger row carries in one column, or undefined if the row is gone. */
function ledgerCell(text: string, rowId: string, column: string): string | undefined {
  const index = LEDGER_COLUMN[column]
  if (index === undefined) return undefined
  for (const line of text.split('\n')) {
    if (!line.startsWith('| ')) continue
    const cells = line.split(SPLIT_CELLS).map(cell => cell.trim())
    if (cells.length !== LEDGER_FIELDS || cells[1] !== rowId) continue
    return cells[index]
  }
  return undefined
}

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, relative), 'utf-8')) as Record<string, unknown>
}

const READMES = readdirSync(join(REPO_ROOT, APPLY_DIR))
  .filter(name => name.endsWith('-readme.json'))
  .sort()

/** Every `superseded` entry in the corpus, with the file it came from. */
const ENTRIES: { file: string, entry: SupersededEntry }[] = READMES.flatMap(file => {
  const parsed = readJson(`${APPLY_DIR}/${file}`).superseded
  return Array.isArray(parsed) ? parsed.map(entry => ({ file, entry: entry as SupersededEntry })) : []
})

describe('the superseded marker is machine-readable (C3.342)', () => {
  it('reads the real corpus, so the assertions below are not a green run over nothing', () => {
    // The positive control, as dated prose rather than a declared number: 32
    // files, 16 of them readmes, answered 3 superseded entries on 2026-09-12.
    // A count asserted here would be a ratchet on a document every ledger lane
    // writes, and the next lane would raise it rather than read it.
    expect(READMES.length).toBeGreaterThan(0)
    expect(ENTRIES.length).toBeGreaterThan(0)
  })

  it('every entry still reads its head word in the ledger, and not the stale one', () => {
    // One assertion over all of them, naming each cell it read: a per-entry case
    // would report the FIRST demotion and hide the rest, and the shape this
    // guards against (a family re-applied wholesale) moves several at once.
    const ledger = readFileSync(join(REPO_ROOT, LEDGER), 'utf-8')
    const read = ENTRIES.map(({ file, entry }) => ({
      file,
      cell: `${entry.row}/${entry.column}`,
      word: ledgerCell(ledger, entry.row, entry.column),
    }))
    const expected = ENTRIES.map(({ file, entry }) => ({
      file,
      cell: `${entry.row}/${entry.column}`,
      word: entry.head_word,
    }))

    expect(read).toEqual(expected)
    // The demotion this marker exists to prevent, stated in its own right: no
    // cell reads the word the stale edit would write it back to.
    for (const [index, { entry }] of ENTRIES.entries()) {
      expect(read[index]?.word).not.toBe(entry.stale_to)
    }
  })

  it('every entry names an edit its evidence JSON really carries', () => {
    // Without this the array could describe an edit nobody would ever apply,
    // and every assertion above would still pass.
    const found = ENTRIES.map(({ file, entry }) => {
      const evidence = readJson(`${APPLY_DIR}/${file.replace('-readme.json', '.json')}`)
      const items = (evidence.items ?? []) as { ledger_edits?: { row?: string, column?: string, to?: string }[] }[]
      const edits = items.flatMap(item => item.ledger_edits ?? [])
        .filter(edit => edit.row === entry.row && edit.column === entry.column)
      return { cell: `${entry.row}/${entry.column}`, to: edits.length === 1 ? edits[0]?.to : `${edits.length} edits` }
    })

    expect(found).toEqual(ENTRIES.map(({ entry }) => ({ cell: `${entry.row}/${entry.column}`, to: entry.stale_to })))
  })

  it('a prose pointer and the array exist together, in both directions', () => {
    for (const file of READMES) {
      const readme = readJson(`${APPLY_DIR}/${file}`)
      const problems = (readme.problems ?? []) as string[]
      const array = Array.isArray(readme.superseded) ? readme.superseded : []
      const pointed = problems.some(problem => problem.toLowerCase().includes('superseded'))

      // A `problems` sentence saying SUPERSEDED with no array is the shape this
      // row replaced: a fact nothing re-reads. An array with no sentence leaves
      // the human reader of `problems` with no sign that it is there.
      expect({ file, pointed }).toEqual({ file, pointed: array.length > 0 })
    }
  })
})

describe('the reader itself', () => {
  // Nine fields, edges included — `plan-status.py`'s shape: id, capability, the
  // three verdicts, Why, Switch.
  const table = [
    '| id | capability | Pi | Claude | Codex | Why | Switch |',
    '| Z1 | a capability | `covered ᵗ` | `partial ʰ` | `absent ʰ` | why | switch |',
  ].join('\n')

  it('finds a cell by row and column name', () => {
    expect(ledgerCell(table, 'Z1', 'Pi')).toBe('`covered ᵗ`')
    expect(ledgerCell(table, 'Z1', 'Claude')).toBe('`partial ʰ`')
    expect(ledgerCell(table, 'Z1', 'Codex')).toBe('`absent ʰ`')
  })

  it('returns undefined rather than a wrong cell — the negative control', () => {
    expect(ledgerCell(table, 'Z2', 'Pi')).toBeUndefined()
    expect(ledgerCell(table, 'Z1', 'Host')).toBeUndefined()
    // A row broken by an unescaped pipe is NOT nine fields, so it is not read at
    // all: `check-denominator-twin.ts` and `plan-status.py` are what report it,
    // and a cell silently taken from a shifted split would be worse than none.
    expect(ledgerCell('| Z1 | a | `covered ᵗ` | b | c | d | e | f | g |', 'Z1', 'Pi')).toBeUndefined()
  })
})

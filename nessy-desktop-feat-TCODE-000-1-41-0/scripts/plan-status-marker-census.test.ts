/**
 * P6.945 — the provenance markers now have a reader, and this is what
 * proves it reads them. D1.85 (2026-09-17) added the sixth, `ʳ` (driven), and
 * its two arms are the last `describe` in this file.
 *
 * `plan-status.py` VALIDATED a marker's shape and scored it nowhere: `verdict()`
 * strips the backticks and takes the leading word, so no marker moved a number,
 * and `check-coverage-map.ts` — which defines four of the five — enforces them
 * over the two coverage maps and never over the ledger. The doc-only marker had
 * no reader in the tree at all. The census printed under the coverage table is
 * that reader.
 *
 * A synthetic three-row ledger rather than a copy of HEAD, for the reason the
 * sibling generator guard gives next door: the property under test belongs to
 * the extractor, so the smallest corpus that can carry one cell of each marker
 * proves it in a fraction of the time and cannot go stale when another lane
 * commits to the real ledger. The run against the REAL ledger is the row's own
 * gate evidence, not a case here.
 *
 * WHAT A SKIP MEANS. This needs `python3`, which the CI image (`nodejs-22`) does
 * not carry, so it skips there BY DESIGN — and a skipped case is not a passed
 * case. `SKIP_MEANING` next door is the sentence that says so. `git` is NOT
 * needed: the script's two `git` calls sit behind their own `try`, and a
 * synthetic tree exercises the caught path.
 */

import { describe, expect, it } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REPO, SKIP_MEANING, pythonExecutable } from './check-generator-faithfulness.ts'

const python = pythonExecutable()
if (python === undefined) console.warn(`[plan-status marker census] ${SKIP_MEANING}`)

const PREFIX = join(tmpdir(), 'nessy-plan-status-census-')

/**
 * Remove a directory this process created under the OS temp dir. The prefix is
 * re-checked here rather than trusted from the caller, for the reason recorded
 * in the sibling guard: an agent in this repo destroyed unrecoverable user data
 * on 2026-08-25 by pointing a recursive delete at a real home directory.
 */
function discard(dir: string): void {
  if (!dir.startsWith(PREFIX) || dir === PREFIX) {
    throw new Error(`refusing to delete ${dir}: not one of this gate's temporary directories`)
  }
  rmSync(dir, { recursive: true, force: true })
}

/**
 * A tree shaped like the files `plan-status.py` reads, and nothing else.
 *
 * `planRows` is D1.104's parameter: that check resolves a `ᵗ` cell's `Why`
 * against the tracker rows of FOUR plans, and a synthetic tree carries only the
 * one planted here — the reader skips a plan file that is absent, which is what
 * makes a three-row fixture possible at all.
 */
function plant(ledgerRows: readonly string[], planRows: readonly string[] = ['| P6.1 | a row | ✅ | `abc1234` | note |']): string {
  const dir = mkdtempSync(PREFIX)
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'docs/superpowers/plans'), { recursive: true })
  mkdirSync(join(dir, 'docs/superpowers/specs'), { recursive: true })
  cpSync(join(REPO, 'scripts/plan-status.py'), join(dir, 'scripts/plan-status.py'))
  writeFileSync(
    join(dir, 'docs/superpowers/specs/2026-08-28-capability-ledger.md'),
    ['| id | cap | Pi | Claude | Codex | why | switch |',
      '|---|---|---|---|---|---|---|',
      ...ledgerRows, ''].join('\n'),
  )
  writeFileSync(
    join(dir, 'docs/superpowers/plans/2026-08-22-runtime-parity-closure.md'),
    ['# Plan', '', ...planRows, ''].join('\n'),
  )
  return dir
}

function run(dir: string): { out: string; err: string } {
  const outcome = invoke(dir)
  expect(outcome.code).toBe(0)
  return { out: outcome.out, err: outcome.err }
}

/**
 * The same call WITHOUT the exit-code assertion, because D1.104's
 * `--check-verdicts` is a gate and its whole subject is the code it returns.
 */
function invoke(dir: string, ...args: readonly string[]): { out: string; err: string; code: number } {
  const proc = Bun.spawnSync([python as string, join(dir, 'scripts/plan-status.py'), ...args], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { out: proc.stdout.toString(), err: proc.stderr.toString(), code: proc.exitCode ?? -1 }
}

function census(dir: string): string {
  return run(dir).out
}

describe('P6.945 — the marker census', () => {
  it.skipIf(python === undefined)('counts every marker per column, and prints its own denominator', () => {
    // One cell of each of the five, plus an unmarked verdict and a dash, spread
    // across the three runtime columns so a census that read one column, or
    // summed the columns into one number, would disagree.
    const dir = plant([
      '| A1 | one | `covered ᵗ` | `partial ʰ` | `absent` | why | `UNIFORM` |',
      '| A2 | two | `absent ˢ` | `covered ᵏ` | `n/a ᵈ` | why | `HONEST` |',
      '| A3 | three | — | `absent ʰ` | `partial` | why | `SILENT` |',
    ])
    try {
      const out = census(dir)

      expect(out).toContain('| `ᵗ` трекер | 1 | 0 | 0 | **1** |')
      expect(out).toContain('| `ʰ` вручную | 0 | 2 | 0 | **2** |')
      expect(out).toContain('| `ˢ` перенесён | 1 | 0 | 0 | **1** |')
      expect(out).toContain('| `ᵏ` проба | 0 | 1 | 0 | **1** |')
      // The doc-only marker: the one with no other reader anywhere in the tree,
      // which is why a zero here has to be a counted zero and not an absence.
      expect(out).toContain('| `ᵈ` док | 0 | 0 | 1 | **1** |')
      // The dash cell and the two verdicts written without a marker.
      expect(out).toContain('| `—` без маркера | 1 | 0 | 2 | **3** |')
      // A census, not a sample: three rows times three runtime columns. The Host
      // column is deliberately absent — a switch verdict carries no marker.
      expect(out).toContain('| ИТОГО ячеек | 3 | 3 | 3 | **9** |')
    } finally {
      discard(dir)
    }
  }, 60_000)

  it.skipIf(python === undefined)('reads the marker only INSIDE the backticks, so prose cannot inflate it', () => {
    // The reason `marker()` goes through `VERDICT_CELL` instead of scanning the
    // cell for one of the five characters: a verdict cell may carry free prose
    // after the backticks, and this ledger's prose talks ABOUT the markers. A
    // scanner would score the sentence and the census would drift away from the
    // shape check that shares the regex.
    const dir = plant([
      '| A1 | one | `covered` this is not a ᵏ probe | `partial ʰ` | — | why | `UNIFORM` |',
    ])
    try {
      const out = census(dir)

      expect(out).toContain('| `ᵏ` проба | 0 | 0 | 0 | **0** |')
      expect(out).toContain('| `ʰ` вручную | 0 | 1 | 0 | **1** |')
      expect(out).toContain('| `—` без маркера | 1 | 0 | 1 | **2** |')
      expect(out).toContain('| ИТОГО ячеек | 1 | 1 | 1 | **3** |')
    } finally {
      discard(dir)
    }
  }, 60_000)

  it.skipIf(python === undefined)('leaves every line of the coverage table above it untouched', () => {
    // The census is APPENDED, never merged: the controller parses the coverage
    // table, and a table that grew a column would be read as a changed schema.
    const dir = plant([
      '| A1 | one | `covered ᵗ` | `partial ʰ` | `absent` | why | `UNIFORM` |',
    ])
    try {
      const lines = census(dir).split('\n')

      expect(lines[0]).toBe(
        '| рантайм | покрыто | частично | нет вердикта | отсутствует | н/п | остаток | всего | покрытие |',
      )
      expect(lines[1]).toBe('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
      expect(lines[2]).toBe('| **Pi** | 1 | 0 | 0 | 0 | 0 | **0** | 1 | **100%** |')
      // Pi covered, Claude partial, Codex absent, Host UNIFORM → covered: two
      // covered, one partial, one absent over four cells, and (2 + 0.5) / 4.
      expect(lines[6]).toBe('| ИТОГО | 2 | 1 | 0 | 1 | 0 | **2** | 4 | **62%** |')
      // ...and the census starts only after the blank line that ends it — with
      // the P6.949 sentence that says it is a description, not a gate, first.
      expect(lines[7]).toBe('')
      expect(lines[8]).toBe('Перепись маркеров — описание на сегодня, не утверждение: без пина, не гейт (P6.949).')
      expect(lines[9]).toBe('| маркер | Pi | Claude | Codex | всего |')
    } finally {
      discard(dir)
    }
  }, 60_000)
})

/**
 * C3.44 — the `moved:` annotation, and the quiet failure it ends.
 *
 * The owner's 2026-09-10 ruling relocates work out of the parity-closure plan
 * with verdicts intact. A relocated cell is neither covered nor owed in THIS
 * ledger, and before this reader existed it was counted anyway — measured
 * 2026-09-12, both spellings, because the row's own premise said an annotation
 * "would score as silence" and that holds for only one of them. The annotation
 * written AFTER the verdict word scored a plain `absent` with no warning at all
 * (the quiet failure: the exclusion simply did not happen); the annotation
 * written INSTEAD of the verdict scored `no-claim` and tripped the shape check
 * by name, which is loud. Both arms are cases here, so a future edit cannot make
 * the quiet one quiet again without one of them going red.
 */
describe('C3.44 — a cell moved to another plan', () => {
  it.skipIf(python === undefined)('leaves the denominator, keeps its verdict word, and is named on stderr', () => {
    // Pi: one moved cell beside one covered and one absent; Claude: the same
    // cell moved, everything else covered. A scorer that counted the moved cell
    // would read Pi 1/3 and Claude 2/3 instead of 1/2 and 2/2.
    const dir = plant([
      '| A1 | moved | `absent ʰ` `moved: D1.36` | `absent ʰ` `moved: D1.36` | `covered ᵗ` | why | `UNIFORM` |',
      '| A2 | plain | `covered ᵗ` | `covered ᵗ` | `covered ᵗ` | why | `SILENT` |',
      '| A3 | plain | `absent ʰ` | `covered ᵗ` | `n/a ʰ` | why | `UNIFORM` |',
    ])
    try {
      const { out, err } = run(dir)

      // Three rows stay three rows: the row total is what `всего` prints, and a
      // moved cell must not take a row out of the file.
      expect(out).toContain('| **Pi** | 1 | 0 | 0 | 1 | 0 | **1** | 3 | **50%** |')
      expect(out).toContain('| **Claude** | 2 | 0 | 0 | 0 | 0 | **0** | 3 | **100%** |')
      // The verdict word is still READ: the census counts the moved cell's own
      // marker, so the cell totals stay at the row total.
      expect(out).toContain('| ИТОГО ячеек | 3 | 3 | 3 | **9** |')
      expect(err).toContain('2 ledger cell(s) MOVED to a named row of another plan')
      expect(err).toContain('A1/Pi → D1.36; A1/Claude → D1.36')
      // Nothing about it is a warning: a relocation is a fact, not a defect.
      expect(err).not.toContain('⚠')
    } finally {
      discard(dir)
    }
  }, 60_000)

  it.skipIf(python === undefined)('treats a `moved:` in the WHY cell as a pointer — nothing leaves the arithmetic', () => {
    // B10's shape: the verdicts are covered BY CODE and only the evidence day
    // was relocated. A pointer that excluded the cells would claim three covered
    // cells out of the denominator and read as a coverage gain.
    const dir = plant([
      '| A1 | residue moved | `covered ᵗ` | `covered ᵗ` | `covered ᵗ` | parked on row `moved: D1.96` of the other plan | `UNIFORM` |',
    ])
    try {
      const { out, err } = run(dir)

      expect(out).toContain('| **Pi** | 1 | 0 | 0 | 0 | 0 | **0** | 1 | **100%** |')
      expect(err).toContain('1 ledger row(s) whose RESIDUE is relocated')
      expect(err).toContain('A1 → D1.96')
      expect(err).not.toContain('MOVED to a named row')
    } finally {
      discard(dir)
    }
  }, 60_000)

  it.skipIf(python === undefined)('still refuses the annotation written INSTEAD of the verdict', () => {
    // The loud half of the 2026-09-12 measurement, kept as a case so the
    // exclusion cannot be bought by deleting the word it excludes: a cell that
    // carries only the annotation has no verdict to keep readable, so it scores
    // as a no-claim — "nobody measured it" — and says so by name.
    const dir = plant([
      '| A1 | annotation only | `moved: D1.36` | `covered ᵗ` | `covered ᵗ` | why | `UNIFORM` |',
    ])
    try {
      const { out, err } = run(dir)

      expect(err).toContain('⚠ ledger row A1: verdict cell 3 is not a verdict')
      expect(out).toContain('| **Pi** | 0 | 0 | 1 | 0 | 0 | **1** | 1 | **0%** |')
      expect(err).not.toContain('MOVED to a named row')
    } finally {
      discard(dir)
    }
  }, 60_000)
})

/**
 * D1.85 — the driven marker `ʳ`, the sixth, and the typo that must not pass.
 *
 * The owner's decision (2026-09-17) asked for a marker that says a cell rests
 * on a live arm on the packaged build whose report names the controls — a thing
 * the ledger could previously only say in prose, which is D1.85's whole
 * subject. The decision named the glyph `ᵈ`; `ᵈ` was already the doc-only
 * marker and wore 32 cells the day the row was executed, so the definition was
 * carried word for word onto a free character and the reason sits beside
 * `VERDICT_CELL` in `plan-status.py`.
 *
 * Both arms matter and they fail in OPPOSITE directions. If the class does not
 * carry `ʳ`, every correct driven cell warns by name and is censused as
 * unmarked — a gate crying wolf on the cells it was built for. If the class
 * carried something looser (say a whole character class), the ASCII `r` a
 * reader will eventually type instead of the superscript would pass silently
 * and the census would go on reading zero driven cells.
 */
describe('D1.85 — the driven marker', () => {
  it.skipIf(python === undefined)('counts a `ʳ` cell as driven and still scores its verdict word', () => {
    // One driven cell per column, beside the marker it most often replaces
    // (`ᵗ`, a landed commit) so a census that scored the new one INSTEAD of the
    // old — or in place of it — would disagree with both lines at once.
    const dir = plant([
      '| A1 | one | `covered ʳ` | `covered ᵗ` | `partial ʳ` | why | `UNIFORM` |',
      '| A2 | two | `covered ᵗ` | `absent ʳ` | `n/a ᵈ` | why | `HONEST` |',
    ])
    try {
      const { out, err } = run(dir)

      expect(out).toContain('| `ʳ` прогон | 1 | 1 | 1 | **3** |')
      expect(out).toContain('| `ᵗ` трекер | 1 | 1 | 0 | **2** |')
      // The doc-only marker is untouched by the sixth: the glyph it was nearly
      // given away to still counts its own cell.
      expect(out).toContain('| `ᵈ` док | 0 | 0 | 1 | **1** |')
      // The verdict word is read exactly as it is under any other marker —
      // Pi: two covered; Claude: one covered, one absent; Codex: one partial.
      expect(out).toContain('| **Pi** | 2 | 0 | 0 | 0 | 0 | **0** | 2 | **100%** |')
      expect(out).toContain('| **Claude** | 1 | 0 | 0 | 1 | 0 | **1** | 2 | **50%** |')
      expect(err).not.toContain('is not a verdict')
    } finally {
      discard(dir)
    }
  }, 60_000)

  it.skipIf(python === undefined)('refuses the bare ASCII `r` — the typo the superscript invites', () => {
    // `covered r` is what a reader types when the superscript will not come out
    // of their keyboard, and it is exactly the cell that must not pass as
    // driven: it claims the strongest provenance this file has in a spelling no
    // reader scores. A correct driven cell in the next column is the control
    // that the run itself was fine.
    //
    // MEASURED, and the first draft of this case had it wrong in a way worth
    // keeping: the typo does NOT lose its verdict. `verdict()` takes the leading
    // word whatever follows it, so the cell still scores `covered` — what it
    // loses is the MARKER, and what it gains is the shape check's warning by
    // name. That is the honest failure shape: loud on stderr, censused as
    // unmarked, and never counted among the driven cells it was trying to join.
    const dir = plant([
      '| A1 | one | `covered r` | `covered ʳ` | — | why | `UNIFORM` |',
    ])
    try {
      const { out, err } = run(dir)

      expect(err).toContain('⚠ ledger row A1: verdict cell 3 is not a verdict')
      // The verdict word survives the typo — the warning is the report on it.
      expect(out).toContain('| **Pi** | 1 | 0 | 0 | 0 | 0 | **0** | 1 | **100%** |')
      expect(out).toContain('| **Claude** | 1 | 0 | 0 | 0 | 0 | **0** | 1 | **100%** |')
      // Censused as unmarked rather than as driven: a cell the shape check has
      // already warned about must not also inflate the count it lied about.
      expect(out).toContain('| `ʳ` прогон | 0 | 1 | 0 | **1** |')
      expect(out).toContain('| `—` без маркера | 1 | 0 | 1 | **2** |')
    } finally {
      discard(dir)
    }
  }, 60_000)

  it.skipIf(python === undefined)('D1.197 — prints the rig-artefact RATIO under the census, and never fails on it', () => {
    // Two driven cells in one row whose why-cell cites a case file, one driven
    // cell in a row that cites none, and a NON-driven cell in a row that does
    // cite one. The last is the arm that separates "counts `ʳ` cells" from
    // "counts rows carrying a path": if the denominator were rows, or the
    // numerator any cited row, this would read 3 of 4 or 2 of 2.
    const dir = plant([
      '| A1 | one | `covered ʳ` | `covered ʳ` | — | driven by `scripts/cdp/cases/rs-11.ts` | `UNIFORM` |',
      '| A2 | two | `covered ʳ` | — | — | the control is the session read back FROM THE APP | `HONEST` |',
      '| A3 | three | `covered ᵗ` | — | — | see `scripts/cdp/cases/rs-99.ts` | `HONEST` |',
    ])
    try {
      const { out, err } = run(dir)

      expect(out).toContain('`ʳ` с артефактом стенда: 2 из 3')
      expect(out).toContain('перепись, не гейт')
      // NOT a gate: the two cells with no artefact are exactly the shape the
      // measurement says would fire on correct cells, and nothing warns.
      expect(err).not.toContain('scripts/cdp')
      expect(err).not.toContain('is not a verdict')
    } finally {
      discard(dir)
    }
  }, 60_000)

  it.skipIf(python === undefined)('D1.197 — a counted ZERO, so a reader can tell it from a sample', () => {
    // The negative control: with no driven cell at all the line still prints,
    // and says which kind of zero it is. A census that printed nothing here
    // would be indistinguishable from a census that stopped running.
    const dir = plant(['| A1 | one | `covered ᵗ` | — | — | see `scripts/cdp/cases/rs-11.ts` | `UNIFORM` |'])
    try {
      const out = census(dir)
      expect(out).toContain('`ʳ` с артефактом стенда: 0 из 0 (ни одной ячейки с этим маркером).')
    } finally {
      discard(dir)
    }
  }, 60_000)
})

/**
 * D1.104 — the VERDICT-WORD check: `plan-status.py` read a cell's SHAPE and
 * never its truth, and `ᵗ` is the one marker whose truth the file's own grammar
 * makes checkable — it means *"a tracker row says this landed"*, so that row has
 * to exist and has to be closed.
 *
 * Measured over the live ledger BEFORE a line of it existed: 486 rows wear `ᵗ`,
 * 481 named a closed row, 0 named only open ones, 5 named no row at all. That 1 %
 * is why this one gates where D1.197's `ʳ` arm was REFUSED — an artefact gate
 * would have fired on 8 of 14 correct cells, which is the cry-wolf shape.
 *
 * The census prints on every run; the exit code is behind `--check-verdicts`, so
 * one lane's ledger edit cannot redden another lane's status read. Both halves
 * are cases here, because "it prints" and "it gates" are two claims.
 */
describe('D1.104 — a tracker verdict checked against its tracker row', () => {
  it.skipIf(python === undefined)('counts a `ᵗ` row whose Why names a CLOSED tracker row as backed', () => {
    const dir = plant(
      ['| A1 | one | `covered ᵗ` | `covered ᵗ` | `covered ᵗ` | landed by P6.42 | `UNIFORM` |'],
      ['| P6.42 | the row that landed it | ✅ | `abc1234` | note |'],
    )
    try {
      expect(run(dir).out).toContain('`ᵗ` со ссылкой на ЗАКРЫТУЮ строку трекера: 1 из 1 (все опираются на закрытую строку)')
      // ...and the gate is silent on a file with nothing to say.
      expect(invoke(dir, '--check-verdicts').code).toBe(0)
    } finally {
      discard(dir)
    }
  }, 60_000)

  it.skipIf(python === undefined)('names a `ᵗ` row whose only tracker row is still OPEN', () => {
    // The falsehood the check exists for, and it is not a shape: the cell says a
    // tracker row landed this, and the tracker row says it has not.
    const dir = plant(
      ['| A1 | one | `covered ᵗ` | `—` | `—` | landed by P6.42 | `UNIFORM` |'],
      ['| P6.42 | not done yet | ⬜ |  | note |'],
    )
    try {
      expect(run(dir).out).toContain('`ᵗ` со ссылкой на ЗАКРЫТУЮ строку трекера: 0 из 1 · без опоры: A1')
      const gated = invoke(dir, '--check-verdicts')
      expect(gated.code).toBe(1)
      expect(gated.err).toContain('✗ A1 — every tracker row it names is still open: P6.42(open)')
    } finally {
      discard(dir)
    }
  }, 60_000)

  it.skipIf(python === undefined)('separates "names nothing" from "names an id no plan carries"', () => {
    // Two different repairs: one cell has to grow a citation, the other has a
    // citation pointing at a row that is not in any of the four plans — a typo,
    // or a plan this reader does not read. Reporting them as one class would
    // send a lane to the wrong repair.
    const dir = plant([
      '| A1 | silent | `covered ᵗ` | `—` | `—` | no row id at all here | `UNIFORM` |',
      '| A2 | dangling | `covered ᵗ` | `—` | `—` | landed by P9.99 | `UNIFORM` |',
    ])
    try {
      const gated = invoke(dir, '--check-verdicts')
      expect(gated.code).toBe(1)
      expect(gated.err).toContain('✗ A1 — names no tracker row at all')
      expect(gated.err).toContain('✗ A2 — names only ids no plan carries: P9.99')
    } finally {
      discard(dir)
    }
  }, 60_000)

  it.skipIf(python === undefined)('NEGATIVE — a row with no `ᵗ` cell is not checked, and the default run never gates', () => {
    // Both halves of the boundary. A hand-read verdict claims no tracker row, so
    // demanding one of it would be the cry-wolf shape; and the offender above is
    // still present here, so the exit 0 is the FLAG's doing and not an empty
    // population.
    const dir = plant([
      '| A1 | hand-read | `covered ʰ` | `absent ʰ` | `n/a ʰ` | no row id at all here | `UNIFORM` |',
      '| A2 | tracker | `covered ᵗ` | `—` | `—` | no row id at all here | `UNIFORM` |',
    ])
    try {
      const plain = invoke(dir)
      expect(plain.code).toBe(0)
      // One of the two rows is checked, not both.
      expect(plain.out).toContain('`ᵗ` со ссылкой на ЗАКРЫТУЮ строку трекера: 0 из 1 · без опоры: A2')
      expect(plain.err).not.toContain('✗ A1')
      expect(invoke(dir, '--check-verdicts').code).toBe(1)
    } finally {
      discard(dir)
    }
  }, 60_000)

  it.skipIf(python === undefined)('warns when one capability id is used by two rows', () => {
    // Found while measuring D1.104 and fixed in the same commit: the live ledger
    // carries `J60` twice. Nothing here could see it — `provenance_warnings`
    // reads `denominator` links and never the id column — so every per-row count
    // was right and every id-keyed reading of the file was wrong.
    const dir = plant([
      '| A1 | first | `covered ᵗ` | `—` | `—` | P6.1 | `UNIFORM` |',
      '| A1 | second, same id | `absent ʰ` | `—` | `—` | P6.1 | `UNIFORM` |',
      '| A2 | unique | `covered ᵗ` | `—` | `—` | P6.1 | `UNIFORM` |',
    ])
    try {
      const { out, err } = run(dir)
      expect(err).toContain('⚠ ledger id A1 appears on more than one row')
      expect(err).not.toContain('⚠ ledger id A2')
      // The rows are still counted — the warning reports a defect, it does not
      // refuse to answer the question the command was asked.
      expect(out).toContain('| ИТОГО ячеек | 3 | 3 | 3 | **9** |')
    } finally {
      discard(dir)
    }
  }, 60_000)
})

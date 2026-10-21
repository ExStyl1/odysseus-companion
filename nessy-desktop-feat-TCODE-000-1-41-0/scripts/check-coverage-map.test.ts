/**
 * The enforcing reader for `check-coverage-map.ts`.
 *
 * CI runs `bun test`; it does not run `validate:ci`, and its Python job is
 * disabled. So a doc guard that lives only in a CLI has no reader — the exact
 * shape of defect the coverage map already had three of. This file is the
 * reader: it asserts the live document is sound, and it asserts the checker
 * actually FAILS on each defect class, because a guard that cannot go red is
 * indistinguishable from no guard.
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  auditCoverageMap,
  cellCount,
  CODEX_KNOWN_DUPLICATE_SLUGS,
  CODEX_MAP,
  CODEX_MAP_PATH,
  CODEX_TSV_PATH,
  CODEX_VERDICTS,
  EVIDENCE_MARKERS,
  KNOWN_DUPLICATE_IDS,
  main,
  type MapShape,
  MAP_PATH,
  MAPS,
  parseCell,
  RUNTIMES,
  SINGLE_COLUMN,
  TSV_PATH,
} from './check-coverage-map.ts'

const HEADER = '| # | Страница Claude | Что она задаёт | Pi | claude | codex | Состояние и доказательство |'
const SEPARATOR = '| --- | --- | --- | --- | --- | --- | --- |'

/** One well-formed row of the real table's shape. */
function row(id: number, slug: string, verdict = '🟩ᵗ', evidence = 'строки: R1 ✅'): string {
  const axis = verdict.includes('|') ? verdict : [verdict, verdict, verdict].join(' | ')
  return `| ${id} | [\`${slug}\`](https://code.claude.com/docs/en/${slug}.md) | What it sets | ${axis} | ${evidence} |`
}

function legend(counts: Partial<Record<string, string>> = {}): string[] {
  const stated = { '🟩': '1 | 1 | 1', '🟨': '0 | 0 | 0', '🟥': '0 | 0 | 0', '⏸': '0 | 0 | 0', '⬜': '0 | 0 | 0', ...counts }
  return Object.entries(stated).map(([glyph, count]) => `| ${glyph} | meaning | ${count} |`)
}

function map(rows: readonly string[], counts?: Partial<Record<string, string>>, marker?: number): string {
  return [
    '# Map', '', '| | Meaning | Pi | claude | codex |', '| :-- | :-- | --: | --: | --: |', ...legend(counts), '',
    HEADER, SEPARATOR, ...rows, ...(marker === undefined ? [] : ['', `<!-- rows: ${marker} -->`]), '',
  ].join('\n')
}

/**
 * A snapshot whose own `Snapshot:` header agrees with its data.
 *
 * That header is now checked, because `AGENTS.md` tells every reader to trust it
 * over any count written in prose and nothing verified it: `codex-doc-pages.tsv`
 * claimed 139 pages while holding 138 unique slugs. A fixture that skipped the
 * line would make every other test in this file carry one extra error.
 */
function tsv(...slugs: readonly string[]): string {
  const pages = slugs.length === 0 ? ['alpha'] : slugs
  const unique = new Set(pages).size
  return [
    `# Format: <slug>\\t<page title>.  Snapshot: 2026-08-29, ${unique} pages.`,
    ...pages.map(slug => `${slug}\t${slug} page`),
    '',
  ].join('\n')
}

const TSV = tsv('alpha')

describe('check-coverage-map', () => {
  it('passes on the document as it stands', () => {
    // The CI reader. A structural regression in the map turns this red, which is
    // the only channel the document has: nothing else reads it.
    const audit = auditCoverageMap(readFileSync(MAP_PATH, 'utf-8'), readFileSync(TSV_PATH, 'utf-8'))
    expect(audit.errors).toEqual([])
    // Positive control that the audit really parsed the table rather than
    // finding nothing to complain about: 230 rows, each contributing one cell to
    // each of the three runtime columns, every column summing to the legend.
    expect(audit.rows).toBe(230)
    for (const runtime of RUNTIMES) {
      const total = Object.values(audit.counted[runtime]!).reduce((sum, count) => sum + count, 0)
      expect(total).toBe(230)
    }
    // The headline numbers. These are the figures the owner's first goal is
    // reported against, so they are pinned: moving one means a row's verdict
    // changed, and that belongs in a diff someone read.
    //
    // Re-pinned 2026-08-28 (P2.316 + P2.317), and the pin did its job — it is how
    // the re-verdict announced itself. Was P5.0's 73/34/14/5/67 · 59/45/20/2/67 ·
    // 44/54/26/2/67. Moved by 55 rows re-verdicted from
    // `docs/superpowers/specs/2026-08-28-claude-sweep-triage.md`: 8 too-green, 25
    // too-red, and the 23 ⬜ cells whose "страница не открывалась" is false for all
    // 23 (phase 1 read 174/174 on 2026-07-31). Nine of those ⬜ rows were wrongly
    // subtracted from the denominator, which is why ⬜ falls 67 → 59 on every
    // column; ⏸ falls to 1 because three parked rows were parked on a row about a
    // different page's subject. The codex column moves most because the `ˢ` census
    // found 9 of 12 unjustified markers over-crediting claude and codex, not Pi.
    //
    // Re-pinned again in the SECOND P2.316 pass (was 82/41/10/1/59 · 65/51/18/0/59 ·
    // 39/70/25/0/59), moved by exactly one row in all three columns: row 97
    // `plugin-relevance` 🟩ᵗˢ → 🟨ʰˢ. The first pass measured that its `ᵗ` was
    // unearned — no plan and no tracker row cites the page, positive control
    // `plugin-dependencies` → 2 plans and 2 tracker hits — wrote that finding into
    // the cell, and left the glyph alone, so every counter kept reading 🟩. A cell
    // whose own prose refutes its glyph is still a wrong cell. Demoting it closes
    // the last non-weekly disagreement with the parity report's §3a crosswalk.
    //
    // Re-pinned 2026-10-01 (F1.1033 follow-up, CM-1; was 81/42/10/1/59 ·
    // 64/52/18/0/59 · 38/71/25/0/59 over 193 rows): the corpus grew 191 → 210
    // when the plugin docs moved under `plugins/`. Seven rows MOVED to the
    // successor their old URL now serves, verdicts untouched; nine split
    // successors (rows 192-200) carry a labelled COPY of their source row's
    // verdict — so the four new Pi 🟩 are copies, not measurements; ten new pages
    // (201-210) got their own, seven of them an unmarked 🟥 recording a MISSING
    // verdict and `claude-projects` a ⬜. The map's header says the same.
    //
    // Re-pinned 2026-10-09 (F1.1275 + F1.1276, BK-2; was 85/48/18/1/60 ·
    // 64/62/26/0/60 · 38/81/33/0/60): the nine copies were re-read and given
    // their own verdicts by the legend's citation rule — Pi loses the copied 🟩
    // of rows 194 and 200 (no closed row cites those pages) and gains 195, 196
    // and 199; claude and codex gain 192, 193, 195 and 196 — and the seven
    // unread pages (202-204, 206, 208-210) were read: each 🟥 became a 🟨.
    //
    // Re-pinned the same day (F1.1275 follow-up, BK-2-fix; was 68/64 claude,
    // 42/83 codex): row 192 `plugins/components` goes back to 🟨ʰ on claude and
    // codex. F1.502 fixed the fork's own cron monitor (idle ticks are still
    // skipped, now said in /tasks), not runtime delivery, and the delivery rows
    // P6.175 and P6.176 do not cite the page.
    //
    // Re-pinned 2026-10-17 (UB12.95; was 86/54/11/1/60 · 67/65/20/0/60 ·
    // 41/84/27/0/60 over 212 rows): the corpus grew 210 → 228 and rows 211-228
    // joined, none of them a 🟩. Ten `plugins/mods/*` (eight 🟥ʰˢ, `gallery` and
    // `interface` ⬜), five Code Review service pages and `hipaa-setup` ⬜,
    // `code-review-local` 🟨ʰ/🟥ʰ/🟥ʰ (row 34's split as a labelled copy) and
    // `auto-mode-classifier-billing` an unmarked 🟥 on Pi and codex with ⏸ on
    // claude (UB8.1). No existing row's verdict moved.
    expect(audit.counted.Pi).toEqual({ '🟩': 86, '🟨': 55, '🟥': 20, '⏸': 1, '⬜': 68 })
    expect(audit.counted.claude).toEqual({ '🟩': 67, '🟨': 65, '🟥': 29, '⏸': 1, '⬜': 68 })
    expect(audit.counted.codex).toEqual({ '🟩': 41, '🟨': 84, '🟥': 37, '⏸': 0, '⬜': 68 })
    expect(audit.repaired).toBeUndefined()
  })

  it('counts fields the way a GFM parser does — an escaped pipe is not a separator', () => {
    expect(cellCount('| a | b |')).toBe(4)
    // The defect: a `|` inside a backtick span still splits the cell.
    expect(cellCount('| a | `x|y` |')).toBe(5)
    // The fix, and the reason it is invisible: `\|` renders as `|` and counts as text.
    expect(cellCount('| a | `x\\|y` |')).toBe(4)
  })

  it('reports a row whose cell count does not match its header', () => {
    const audit = auditCoverageMap(map([row(1, 'alpha', '🟩ᵗ', 'matched `a|b` here')]), TSV)
    expect(audit.errors.some(error => error.includes('against a 9-field header'))).toBe(true)
  })

  it('accepts the same row once the pipe is escaped', () => {
    const audit = auditCoverageMap(map([row(1, 'alpha', '🟩ᵗ', 'matched `a\\|b` here')]), TSV)
    expect(audit.errors).toEqual([])
  })

  it('reports rows orphaned by a blank line, which render as literal text', () => {
    const text = [
      map([row(1, 'alpha')]),
      '| 2 | [`beta`](https://x/beta.md) | What | ⬜ | ⬜ | ⬜ | note |',
      '',
    ].join('\n')
    const audit = auditCoverageMap(text, TSV)
    expect(audit.errors.some(error => error.includes('no header and separator above them'))).toBe(true)
  })

  it('recomputes a drifted legend tally and offers the corrected text', () => {
    const audit = auditCoverageMap(map([row(1, 'alpha')], { '🟩': '7 | 1 | 1' }), TSV)
    expect(audit.errors.some(error => error.includes('legend says 🟩 = 7/1/1 (Pi/claude/codex), the tables hold 1/1/1')))
      .toBe(true)
    expect(audit.repaired).toContain('| 🟩 | meaning | 1 | 1 | 1 |')
    // The repair touches the tally cells and nothing else.
    expect(audit.repaired?.split('\n').filter(line => line.startsWith('| 1 |')))
      .toEqual([row(1, 'alpha')])
  })

  it('recomputes the row-count marker, which had drifted by nineteen', () => {
    const audit = auditCoverageMap(map([row(1, 'alpha')], undefined, 174), TSV)
    expect(audit.errors.some(error => error.includes('the row marker says 174, the tables hold 1'))).toBe(true)
    expect(audit.repaired).toContain('<!-- rows: 1 -->')
  })

  it('reports a snapshot page that has no row at all', () => {
    const audit = auditCoverageMap(map([row(1, 'alpha')]), tsv('alpha', 'gamma'))
    expect(audit.errors).toEqual(['page `gamma` is in the snapshot and has no row'])
  })

  // The other direction, and the one that was missing. A map row for a page the
  // snapshot does not carry means the DENOMINATOR is stale — which is how the
  // codex corpus grew from 138 to 147 with nobody noticing, twice, and how the
  // Claude count read 174 through two growths to 191.
  it('reports a row whose page has left the snapshot, and stays quiet on the two pinned ones', () => {
    const stale = auditCoverageMap(map([row(1, 'alpha'), row(2, 'delta')], { '🟩': '2 | 2 | 2' }), TSV)
    expect(stale.errors).toEqual(['row page `delta` is in no snapshot line — the TSV is stale or the slug is wrong'])

    const retired = auditCoverageMap(
      map([row(1, 'alpha'), row(2, 'ultraplan')], { '🟩': '2 | 2 | 2' }),
      TSV,
    )
    expect(retired.errors).toEqual([])
  })

  it('reports a snapshot whose own page count disagrees with its data lines', () => {
    const lying = TSV.replace('1 pages', '9 pages')
    const audit = auditCoverageMap(map([row(1, 'alpha')]), lying)
    expect(audit.errors.some(error => error.includes('the Snapshot line says 9 pages, the file holds 1 unique slugs')))
      .toBe(true)

    // The exact shape the codex snapshot carried: a slug listed twice, so the
    // line count is right and the page count is not. The message must say which.
    const duplicated = auditCoverageMap(
      map([row(1, 'alpha')]),
      ['# Format: <slug>\\t<page title>.  Snapshot: 2026-08-29, 2 pages.', 'alpha\tA', 'alpha\tA', ''].join('\n'),
    )
    expect(duplicated.errors.some(error => error.includes('2 data lines — a slug is listed twice'))).toBe(true)

    const headerless = auditCoverageMap(map([row(1, 'alpha')]), ['# comment', 'alpha\tA', ''].join('\n'))
    expect(headerless.errors.some(error => error.includes('no `Snapshot: <date>, <n> pages` line'))).toBe(true)
  })

  it('reports a NEW duplicate row number while the two pinned ones stay quiet', () => {
    const collision = auditCoverageMap(
      map([row(4, 'alpha'), row(4, 'beta')], { '🟩': '2 | 2 | 2' }),
      TSV,
    )
    expect(collision.errors.some(error => error.startsWith('# 4 is used by 2 rows'))).toBe(true)

    // The boundary: 35 and 103 are the two de-indexed pages that borrowed a live
    // page's ordinal. They are pinned, so they must NOT be reported — and the
    // day someone renumbers them, this set is lowered in that same commit.
    const pinned = auditCoverageMap(
      map([row(35, 'alpha'), row(35, 'beta')], { '🟩': '2 | 2 | 2' }),
      TSV,
    )
    expect(pinned.errors.filter(error => error.includes('is used by'))).toEqual([])
    expect(KNOWN_DUPLICATE_IDS).toEqual(new Set([35, 103]))
  })

  it('reports a row that carries no verdict glyph and one that carries no page slug', () => {
    const noGlyph = auditCoverageMap(map([row(1, 'alpha', 'built')], { '🟩': '0 | 0 | 0' }), TSV)
    expect(noGlyph.errors.some(error => error.includes('no verdict glyph'))).toBe(true)
    const noSlug = auditCoverageMap(map(['| 1 | plain text | What | 🟩ᵗ | 🟩ᵗ | 🟩ᵗ | note |']), TSV)
    expect(noSlug.errors.some(error => error.includes('names no [`page-slug`]'))).toBe(true)
  })

  it('reads a per-runtime cell as a glyph plus at most one evidence marker and an optional ˢ', () => {
    expect(parseCell(' 🟩ᵗ ')).toEqual({ verdict: '🟩', evidence: 'ᵗ', shared: false })
    expect(parseCell('🟨ᵏˢ')).toEqual({ verdict: '🟨', evidence: 'ᵏ', shared: true })
    // 🟥/⏸/⬜ record an absence, and the map has rows whose absence is itself
    // unmeasured — a marker there would manufacture evidence, so it is optional.
    expect(parseCell('🟥')).toEqual({ verdict: '🟥', shared: false })
    expect(parseCell('⬜')).toEqual({ verdict: '⬜', shared: false })
    // A claim of coverage must name its evidence class.
    expect(parseCell('🟩')).toContain('no evidence marker')
    expect(parseCell('🟨')).toContain('no evidence marker')
    // ˢ says "this cell repeats one measurement" — it is not itself a measurement.
    expect(parseCell('🟥ˢ')).toContain('no evidence marker before it')
    // Two evidence markers would make the class ambiguous, and an unknown marker
    // is how a private convention becomes a silent third vocabulary.
    expect(parseCell('🟩ᵗᵏ')).toContain('carries `ᵏ`')
    expect(parseCell('🟩ˣ')).toContain('carries `ˣ`')
    expect(EVIDENCE_MARKERS).toEqual(['ᵗ', 'ᵏ', 'ʰ'])
  })

  it('reports a coverage claim in a runtime column that names no evidence class', () => {
    const audit = auditCoverageMap(map([row(1, 'alpha', '🟩ᵗ | 🟩 | 🟥')], { '🟩': '1 | 1 | 0', '🟥': '0 | 0 | 1' }), TSV)
    expect(audit.errors.some(error => error.includes('row 1 claude cell — `🟩` claims coverage'))).toBe(true)
    // The Pi and codex cells parsed fine, so the failure is localised to one cell.
    expect(audit.errors.filter(error => error.includes('cell —'))).toHaveLength(1)
  })

  it('reports runtime columns that are out of the pinned order', () => {
    const swapped = map([row(1, 'alpha')])
      .replace(HEADER, HEADER.replace('| Pi | claude | codex |', '| codex | claude | Pi |'))
    const audit = auditCoverageMap(swapped, TSV)
    expect(audit.errors.some(error => error.includes('the axis order is pinned to Pi / claude / codex'))).toBe(true)
    expect(RUNTIMES).toEqual(['Pi', 'claude', 'codex'])
  })
})

/**
 * The codex map, which ran ungated for a week while its verdicts moved.
 *
 * P5.2 recorded the hole in as many words: the checker "hardcodes `MAP_PATH` …
 * it never opens the codex map. So the codex map's counts, glyph legality and
 * row completeness are gated by nothing." These tests are the reader that
 * document did not have — and they assert the SHAPE differences deliberately,
 * because the failure mode of a second map sharing one checker is that the
 * checker silently declines to check it (a three-count legend regex simply does
 * not match a one-count legend line, and a non-match is not an error).
 */
const CODEX_HEADER = '| | Страница | Что она задаёт | У нас | Состояние |'
const CODEX_SEPARATOR = '| --: | :-- | :-- | :-- | :-- |'

function codexRow(id: number, slug: string, verdict = '⛔', note = 'цитат 0'): string {
  return `| ${id} | [\`${slug}\`](https://learn.chatgpt.com/docs/${slug}.md) | What it sets | ${verdict} | ${note} |`
}

function codexMap(rows: readonly string[], counts: Partial<Record<string, string>> = {}, marker?: number): string {
  const stated = { '🟩': '0', '🟨': '0', '🟥': '0', '⏸': '0', '⛔': '1', ...counts }
  return [
    '# Codex map', '', '| | Meaning | Count |', '| :-- | :-- | --: |',
    ...Object.entries(stated).map(([glyph, count]) => `| ${glyph} | meaning | ${count} |`), '',
    CODEX_HEADER, CODEX_SEPARATOR, ...rows,
    ...(marker === undefined ? [] : ['', `<!-- rows: ${marker} -->`]), '',
  ].join('\n')
}

describe('check-coverage-map — the codex map', () => {
  it('passes on the document as it stands, and really parsed it', () => {
    const audit = auditCoverageMap(
      readFileSync(CODEX_MAP_PATH, 'utf-8'),
      readFileSync(CODEX_TSV_PATH, 'utf-8'),
      CODEX_MAP,
    )
    expect(audit.errors).toEqual([])
    // Positive control that the audit parsed the table rather than finding
    // nothing to complain about: every row lands in the single verdict column.
    const tally = audit.counted[SINGLE_COLUMN]!
    const total = Object.values(tally).reduce((sum, count) => sum + count, 0)
    expect(total).toBe(audit.rows)
    expect(audit.rows).toBeGreaterThan(100)
    expect(audit.repaired).toBeUndefined()
  })

  it('tallies a one-count legend, which the three-count pattern cannot even match', () => {
    const audit = auditCoverageMap(codexMap([codexRow(1, 'alpha')]), tsv('alpha'), CODEX_MAP)
    expect(audit.errors).toEqual([])
    expect(audit.counted[SINGLE_COLUMN]).toEqual({ '🟩': 0, '🟨': 0, '🟥': 0, '⏸': 0, '⛔': 1 })

    const drifted = auditCoverageMap(codexMap([codexRow(1, 'alpha')], { '⛔': '73' }), tsv('alpha'), CODEX_MAP)
    expect(drifted.errors.some(error => error.includes('legend says ⛔ = 73 (У нас), the tables hold 1'))).toBe(true)
    expect(drifted.repaired).toContain('| ⛔ | meaning | 1 |')
  })

  it('accepts ⛔ and rejects ⬜ — the two maps do not share a vocabulary', () => {
    expect(parseCell('⛔', CODEX_MAP)).toEqual({ verdict: '⛔', shared: false })
    expect(parseCell('⬜', CODEX_MAP)).toContain('no verdict glyph')
    // And the mirror, so neither map quietly inherits the other's glyph set.
    expect(parseCell('⛔')).toContain('no verdict glyph')
    expect(CODEX_VERDICTS).toEqual(['🟩', '🟨', '🟥', '⏸', '⛔'])
  })

  it('takes a bare 🟩/🟨 here and refuses an evidence marker, the opposite of the Claude map', () => {
    // The codex map argues the case in its own preamble: every page was read
    // whole and probed with a positive control, so a per-cell evidence class
    // would be uniform. Requiring one would manufacture a distinction the pass
    // did not draw — and carrying one would assert it.
    expect(parseCell('🟩', CODEX_MAP)).toEqual({ verdict: '🟩', shared: false })
    expect(parseCell('🟨', CODEX_MAP)).toEqual({ verdict: '🟨', shared: false })
    expect(parseCell('🟩ᵗ', CODEX_MAP)).toContain('draws no per-cell evidence class')
    expect(parseCell('🟩ˢ', CODEX_MAP)).toContain('draws no per-cell evidence class')
    // Unchanged on the Claude side, where the marker is the whole point.
    expect(parseCell('🟩')).toContain('no evidence marker')
  })

  it('lets `windows/windows-app` hold two rows and reports any other duplicate slug', () => {
    // Upstream's own index lists that page twice and the map mirrors the index,
    // so the duplicate is DATA. The Claude map's twin hazard is a duplicate
    // NUMBER, which is why the two are pinned in different sets.
    const pinned = auditCoverageMap(
      codexMap([codexRow(1, 'windows/windows-app'), codexRow(2, 'windows/windows-app')], { '⛔': '2' }),
      tsv('windows/windows-app'),
      CODEX_MAP,
    )
    expect(pinned.errors).toEqual([])

    const other = auditCoverageMap(
      codexMap([codexRow(1, 'alpha'), codexRow(2, 'alpha')], { '⛔': '2' }),
      tsv('alpha'),
      CODEX_MAP,
    )
    expect(other.errors.some(error => error.startsWith('page `alpha` has 2 rows'))).toBe(true)
    expect(CODEX_KNOWN_DUPLICATE_SLUGS).toEqual(new Set(['windows/windows-app']))
  })

  it('still catches the invisible failures on this map — the pipe and the blank line', () => {
    const piped = auditCoverageMap(
      codexMap([codexRow(1, 'alpha', '⛔', 'matched `a|b`')]), tsv('alpha'), CODEX_MAP,
    )
    expect(piped.errors.some(error => error.includes('against a 7-field header'))).toBe(true)

    const orphaned = auditCoverageMap(
      [codexMap([codexRow(1, 'alpha')]), codexRow(2, 'alpha'), ''].join('\n'),
      tsv('alpha'),
      CODEX_MAP,
    )
    expect(orphaned.errors.some(error => error.includes('no header and separator above them'))).toBe(true)
  })

  it('audits both maps from one list, so neither can be added and left unread', () => {
    expect(MAPS.map(shape => shape.name)).toEqual(['claude map', 'codex map'])
    for (const shape of MAPS) {
      const audit = auditCoverageMap(
        readFileSync(shape.mapPath, 'utf-8'),
        readFileSync(shape.tsvPath, 'utf-8'),
        shape,
      )
      expect(audit.errors, `${shape.name}: ${audit.errors.join(' · ')}`).toEqual([])
    }
  })
})

/**
 * P6.876 — the CLI's default mode, which used to be the mutating one.
 *
 * These cases drive a THROWAWAY copy on purpose. Both shipped documents are
 * converged, so a bare run over the real paths writes nothing whatever the flag
 * does: a test pointed at them would pass with the fix reverted, which is the
 * vacuous shape this repo keeps measuring. The copy carries a planted legend
 * drift, so "wrote nothing" is a claim about the flag rather than about a file
 * that had nothing to repair.
 */
describe('check-coverage-map — the CLI mutates only under --write', () => {
  /** A drifted map plus its snapshot in a scratch directory, and the shape that reads them. */
  function driftedShape(dir: string): MapShape {
    const mapPath = join(dir, 'map.md')
    const tsvPath = join(dir, 'pages.tsv')
    // The legend claims 🟥 = 1 where the table's single row is ⛔, so the audit
    // has something to repair and the two modes are distinguishable.
    writeFileSync(mapPath, codexMap([codexRow(1, 'alpha')], { '🟥': '1' }))
    writeFileSync(tsvPath, tsv('alpha'))
    return { ...CODEX_MAP, mapPath, tsvPath }
  }

  /** `main` reports through the console; the assertions are the return code and the bytes. */
  function silenced<T>(run: () => T): T {
    const { log, error } = console
    console.log = () => {}
    console.error = () => {}
    try {
      return run()
    } finally {
      console.log = log
      console.error = error
    }
  }

  it('leaves the document byte-identical on a bare run and under --check, while still reporting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coverage-map-readonly-'))
    try {
      const shape = driftedShape(dir)
      const before = readFileSync(shape.mapPath, 'utf-8')
      // The drift is real, not an artefact of the helper's defaults.
      expect(before).toContain('| 🟥 | meaning | 1 |')

      for (const argv of [[], ['--check']]) {
        expect(silenced(() => main(argv, [shape]))).toBe(1)
        expect(readFileSync(shape.mapPath, 'utf-8')).toBe(before)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rewrites the derived tallies under --write, and only those', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coverage-map-write-'))
    try {
      const shape = driftedShape(dir)
      const before = readFileSync(shape.mapPath, 'utf-8')

      // Still exit 1 — the write repairs the numbers, it does not bless them.
      expect(silenced(() => main(['--write'], [shape]))).toBe(1)
      const after = readFileSync(shape.mapPath, 'utf-8')
      expect(after).not.toBe(before)
      expect(after).toContain('| 🟥 | meaning | 0 |')
      // One line moved: the row text is never rewritten.
      const changed = after.split('\n').filter((line, index) => line !== before.split('\n')[index])
      expect(changed).toEqual(['| 🟥 | meaning | 0 |'])

      // Converged now, so a second --write is a no-op and exits clean.
      expect(silenced(() => main(['--write'], [shape]))).toBe(0)
      expect(readFileSync(shape.mapPath, 'utf-8')).toBe(after)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

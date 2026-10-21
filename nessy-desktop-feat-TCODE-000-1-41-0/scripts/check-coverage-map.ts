#!/usr/bin/env bun
/**
 * check-coverage-map.ts — structural guard for the Claude coverage map.
 *
 * `docs/superpowers/specs/2026-07-31-claude-coverage-map.md` is a 193-row table
 * that AGENTS.md points at as the place citations are checked against, and it
 * is the one document in this repo whose failures are all invisible:
 *
 *  - A `|` inside a cell's text is a CELL SEPARATOR in GFM, even inside a
 *    backtick span. Fourteen rows carried `grep`/regex alternations and quoted
 *    upstream table fragments, so they rendered with 8-12 columns against a
 *    7-field header — the evidence cell sliced into pieces, the verdict glyph
 *    landing under a different column. The page still renders; it renders WRONG.
 *  - A blank line ENDS a table. Twelve rows sat below one (one row after
 *    `## Параллелизм`, eleven after `## Вне продукта`) with no header and no
 *    separator above them, so they rendered as a literal paragraph of pipes and
 *    were not part of any table at all.
 *  - The legend tally is hand-maintained derived data. It drifted once already:
 *    exact at 73/31/13 before `80d53ff28`, wrong in two cells after it, because
 *    that commit flipped one row's verdict without recounting. The
 *    `<!-- rows: N -->` marker at the foot of the tables is the same class and
 *    had drifted further — it said 174 while the tables held 193.
 *  - P5.0 replaced the single `У нас` verdict with a THREE-COLUMN runtime axis
 *    (Pi / claude / codex), which adds two failures of its own. Three adjacent
 *    single-glyph cells can silently swap — nothing in a diff distinguishes
 *    `🟩 | 🟥 | 🟥` from `🟥 | 🟥 | 🟩`, and the row's meaning inverts — so the
 *    header's runtime labels are pinned here in order. And a cell may carry an
 *    evidence marker after its glyph; the marker is the whole reason a reader
 *    can tell a measured cell from a derived one, so an unknown marker, a
 *    doubled evidence marker, or a 🟩/🟨 cell with no marker at all is an error.
 *
 * None of these is visible in a diff, none breaks a build, and the document has
 * no other reader that would notice. So the derived numbers are RECOMPUTED here
 * and everything else is REPORTED, never rewritten — repairing a row's text is
 * an editorial act, and a script that reflows cells would be the next invisible
 * failure.
 *
 * Usage:  bun scripts/check-coverage-map.ts            # report drift, write nothing
 *         bun scripts/check-coverage-map.ts --check     # the same; kept, and explicit
 *         bun scripts/check-coverage-map.ts --write     # rewrite the derived tallies
 *
 * P6.876 — EVERY invocation is read-only unless `--write` is passed, and it was
 * not always so. The rewrite used to be the DEFAULT, which made the natural
 * first command ("is the map still well-formed?") the mutating one: W9-au ran
 * it bare to inspect the codex map and silently rewrote two derived legend
 * lines of a shared document while six lanes held the tree. A diagnostic-
 * looking front door that writes is the generator-in-a-shared-tree trap
 * (AGENTS.md §Traps, W8-td) with no warning attached, so the flag now carries
 * the mutation, as `--pin` does in
 * `packages/pi-agent-server/src/harness/source-state-contract.ts` and
 * `--update-baseline` does in `scripts/check-ledger-citations.ts`.
 *
 * The precedent this follows is `scripts/sort-locales.ts` (the `--check` half
 * of a repo gate); `scripts/sort-plan-tracker.py` is the OTHER convention
 * (fix by default, `--check` in CI) and is deliberately not followed any more,
 * because that script is invoked on a plan a lane is holding while this one
 * reads two documents nobody owns. Its enforcing reader is
 * `scripts/check-coverage-map.test.ts`, because `bun test` is what CI actually
 * runs — a guard wired only into a script nobody invokes would be the same
 * class of defect it exists to catch.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const HERE = import.meta.dir ?? new URL('.', import.meta.url).pathname
export const MAP_PATH = resolve(HERE, '..', 'docs', 'superpowers', 'specs', '2026-07-31-claude-coverage-map.md')
export const TSV_PATH = resolve(HERE, 'claude-doc-pages.tsv')

/** The five verdict glyphs, in legend order. */
export const VERDICTS = ['🟩', '🟨', '🟥', '⏸', '⬜'] as const
export type Verdict = (typeof VERDICTS)[number]

/**
 * The runtime axis, in COLUMN ORDER — the order is the contract.
 *
 * A per-runtime cell is one glyph, so three of them side by side are three
 * indistinguishable tokens: a reordered header would silently re-attribute
 * every one of 193 rows, and no diff of the row text would show it. The labels
 * are therefore checked against the header of every map table.
 */
export const RUNTIMES = ['Pi', 'claude', 'codex'] as const
export type Runtime = (typeof RUNTIMES)[number]

/**
 * What a per-runtime cell may carry after its glyph, and why a cell without one
 * is an error.
 *
 * The map's own evidence hierarchy says a tracker row outranks a code probe,
 * because a probe proves an IDENTIFIER EXISTS and not that the behaviour works
 * — this fork has shipped three identifiers that were parsed and never read
 * (`memoryType`, `suppressOutput`, `terminalSequence`) and a function with zero
 * production call sites that looked like a fix. Splitting one verdict into three
 * multiplies that hazard by three, so the class of evidence travels IN the cell:
 *
 *  - `ᵗ` a tracker row — a closed plan row that discharged the page's contract
 *        on this runtime;
 *  - `ᵏ` a code probe only — an identifier exists on this runtime's path;
 *        the behaviour is NOT proven;
 *  - `ʰ` a hand check made for this pass — a named seam was read;
 *  - `ˢ` (scope, not evidence) the implementing seam is host-level and sits on
 *        all three runtimes' paths, so this cell REPEATS one measurement rather
 *        than being a third independent one.
 *
 * `ˢ` is orthogonal and may follow any of the three, e.g. `🟩ᵗˢ`.
 */
export const EVIDENCE_MARKERS = ['ᵗ', 'ᵏ', 'ʰ'] as const
export const SCOPE_MARKER = 'ˢ'
export type EvidenceMarker = (typeof EVIDENCE_MARKERS)[number]

/**
 * `#` values carried by two rows each, and why this is pinned rather than fixed.
 *
 * `agent-sdk/slash-commands` and `ultraplan` are pages that LEFT the snapshot
 * (the first absorbed into `agent-sdk/skills.md` on 2026-08-09), and each was
 * kept as a row by borrowing an ordinal that a live page already used: 35 is
 * also `github-actions`, 103 is also `settings`. Renumbering them would restore
 * "a row and a number" but invalidate two live citations outside this document
 * (`2026-08-22-weekly-changelog-findings-w30-w32.md:451` names "map row 103";
 * `2026-07-29-inert-contracts.md:12` names "row 35"), so it is an owner-level
 * edit, not a repair. Pinned so a NEW collision is caught; lower this set in the
 * same commit that renumbers them, deliberately.
 */
export const KNOWN_DUPLICATE_IDS = new Set([35, 103])

/* ------------------------------------------------------------------------- *
 * The SECOND map, and why one script now audits two documents.
 *
 * P5.2's sweep recorded it plainly: "The codex map has no checker.
 * `scripts/check-coverage-map.ts` hardcodes `MAP_PATH = …/2026-07-31-claude-
 * coverage-map.md` … it never opens the codex map. So the codex map's counts,
 * glyph legality and row completeness are gated by nothing." Everything in this
 * file's opening docblock — the invisible `|`, the blank line that ends a table,
 * the hand-maintained legend tally that drifts on the first flipped verdict —
 * applies to `2026-08-22-codex-coverage-map.md` word for word, and that document
 * ran ungated for a week while its verdicts moved.
 *
 * The codex map is a DIFFERENT SHAPE, and the differences are the reason this is
 * a spec rather than a second hardcoded path:
 *
 *  - ONE verdict column (`У нас`), not a three-runtime axis. The map states why
 *    in its own preamble: its product context is fixed to the codex runtime, so
 *    a Pi column there would be degenerate. So there is no column order to pin.
 *  - `⛔` ("not our surface") replaces `⬜`. That glyph is the whole reason the
 *    document exists — "a bulk 'not our surface' verdict nobody measured is
 *    unusable; here every ⛔ names why".
 *  - NO evidence marker, deliberately, and the map argues the case: every page
 *    was read whole and every claim probed against HEAD with a positive control,
 *    so a per-cell evidence class would be uniform and therefore noise. Requiring
 *    one here would manufacture a distinction the pass did not make.
 *  - One slug legitimately carries TWO rows. `windows/windows-app` is listed
 *    twice by UPSTREAM's own index, and the map mirrors the index faithfully, so
 *    the duplicate is data rather than a defect. The Claude map's twin hazard is
 *    duplicate `#` NUMBERS; here it is a duplicate SLUG, so the two are pinned
 *    in different sets.
 * ------------------------------------------------------------------------- */

export const CODEX_MAP_PATH = resolve(HERE, '..', 'docs', 'superpowers', 'specs', '2026-08-22-codex-coverage-map.md')
export const CODEX_TSV_PATH = resolve(HERE, 'codex-doc-pages.tsv')

/** The codex map's five verdict glyphs, in legend order. `⛔` where Claude has `⬜`. */
export const CODEX_VERDICTS = ['🟩', '🟨', '🟥', '⏸', '⛔'] as const

/**
 * Slugs upstream's own index lists twice, so the map carries two rows for them.
 *
 * `windows/windows-app` appears at rows 11 and 137 with a byte-identical subject
 * and verdict. Collapsing them would make the map disagree with the snapshot it
 * is audited against; pinning the slug keeps a NEW duplicate visible.
 */
export const CODEX_KNOWN_DUPLICATE_SLUGS: ReadonlySet<string> = new Set(['windows/windows-app'])

/**
 * What differs between two coverage maps, so the audit below can read either.
 *
 * Everything NOT in here is shared, because every failure this file was built
 * for is a property of the GFM table and not of the subject.
 */
export interface MapShape {
  /** Names the map in every message the checker prints. */
  readonly name: string
  readonly mapPath: string
  readonly tsvPath: string
  /** Legend order. The legend line's glyph must be one of these. */
  readonly verdicts: readonly string[]
  /**
   * Verdict column labels in COLUMN ORDER, or `undefined` for a single unlabelled
   * verdict column. When present the order is pinned against every table header:
   * adjacent single-glyph cells are indistinguishable tokens and a reordered
   * header would silently re-attribute every row.
   */
  readonly columns?: readonly string[]
  /** Field count of a map-table header line, `|`-split (both empties included). */
  readonly headerFields: number
  /** What column 1 of a map-table header reads, trimmed. */
  readonly headerKey: string
  /** Whether a 🟩/🟨 cell must name its evidence class. False for a whole-pass map. */
  readonly evidenceRequired: boolean
  readonly knownDuplicateIds: ReadonlySet<number>
  readonly knownDuplicateSlugs: ReadonlySet<string>
  /**
   * Pages that LEFT the snapshot and whose rows are kept on purpose.
   *
   * The row-without-a-snapshot-line check below is the half that catches a stale
   * denominator, and it would otherwise go red on the two rows this file's
   * `KNOWN_DUPLICATE_IDS` docblock already explains: `agent-sdk/slash-commands`
   * was absorbed into `agent-sdk/skills.md` on 2026-08-09 and `ultraplan` left
   * the index, and both rows are deliberately retained. A guard that fires on a
   * documented, deliberate state is a guard someone disables — measured in this
   * repo at 23 false positives out of 31 (P2.211).
   */
  readonly knownRetiredSlugs: ReadonlySet<string>
}

export const CLAUDE_MAP: MapShape = {
  name: 'claude map',
  mapPath: MAP_PATH,
  tsvPath: TSV_PATH,
  verdicts: VERDICTS,
  columns: RUNTIMES,
  headerFields: 9,
  headerKey: '#',
  evidenceRequired: true,
  knownDuplicateIds: KNOWN_DUPLICATE_IDS,
  knownDuplicateSlugs: new Set(),
  knownRetiredSlugs: new Set(['agent-sdk/slash-commands', 'ultraplan']),
}

export const CODEX_MAP: MapShape = {
  name: 'codex map',
  mapPath: CODEX_MAP_PATH,
  tsvPath: CODEX_TSV_PATH,
  verdicts: CODEX_VERDICTS,
  headerFields: 7,
  headerKey: '',
  evidenceRequired: false,
  knownDuplicateIds: new Set(),
  knownDuplicateSlugs: CODEX_KNOWN_DUPLICATE_SLUGS,
  knownRetiredSlugs: new Set(),
}

export const MAPS: readonly MapShape[] = [CLAUDE_MAP, CODEX_MAP]

/** The single column an axis-less map tallies under, so results stay one shape. */
export const SINGLE_COLUMN = 'У нас'

/** A `|` that is not backslash-escaped — i.e. an actual GFM cell separator. */
const CELL_SEPARATOR = /(?<!\\)\|/
const SEPARATOR_ROW = /^\|[\s:|-]+\|$/
const ROW_NUMBER = /^\s*\d+\s*$/
const PAGE_SLUG = /\[`([^`]+)`\]/
const ROW_MARKER = /^<!-- rows: (\d+) -->$/

/**
 * The legend line for a map with `n` count columns.
 *
 * Built per shape rather than written once: the codex legend has ONE count
 * column, and the three-group regex this file used to hardcode simply does not
 * match it — so a hardcoded legend pattern does not fail loudly on the second
 * map, it silently declines to check it. That is the same class of defect as a
 * doc guard with no reader.
 */
function legendRow(shape: MapShape): RegExp {
  const glyphs = shape.verdicts.join('|')
  const counts = (shape.columns ?? [SINGLE_COLUMN]).map(() => '\\s*(\\d+)\\s*\\|').join('')
  return new RegExp(`^\\|\\s*(${glyphs})\\s*\\|(.*)\\|${counts}\\s*$`)
}

/**
 * The snapshot's own `Snapshot: <date>, <n> pages` line, checked against its data.
 *
 * `AGENTS.md` tells every reader to trust this line over any count written in
 * prose — "read the TSV's own `Snapshot:` line, not this one". Nothing checked
 * it, and it was wrong: `codex-doc-pages.tsv` said 139 pages while holding 139
 * data lines and 138 UNIQUE slugs, because upstream lists `windows/windows-app`
 * twice. A denominator that counts a page twice overstates coverage by exactly
 * the pages nobody has opened, which is the failure this fork has now paid for
 * on both doc corpora.
 */
const SNAPSHOT_LINE = /^#.*Snapshot:\s*(\d{4}-\d{2}-\d{2}),\s*(\d+)\s+pages/

/** Fields a GFM parser sees in one table line (leading/trailing empties included). */
export function cellCount(line: string): number {
  return line.split(CELL_SEPARATOR).length
}

/** Every maximal run of consecutive lines starting with `|`, as [start, end] 0-based. */
function tableBlocks(lines: readonly string[]): Array<[number, number]> {
  const blocks: Array<[number, number]> = []
  let start: number | undefined
  lines.forEach((line, index) => {
    if (line.startsWith('|')) {
      if (start === undefined) start = index
      return
    }
    if (start !== undefined) {
      blocks.push([start, index - 1])
      start = undefined
    }
  })
  if (start !== undefined) blocks.push([start, lines.length - 1])
  return blocks
}

export interface ParsedCell {
  verdict: string
  evidence?: EvidenceMarker
  shared: boolean
}

/**
 * Read one verdict cell, or say why it is not one.
 *
 * On the Claude map a 🟩 or 🟨 cell claims coverage, so it must name the evidence
 * class behind the claim. 🟥/⏸/⬜ record the absence of coverage or of a verdict,
 * and the map has rows whose absence is itself unmeasured (`whats-new/2026-w33`
 * states in words that the page was never read and no probe was run) — a marker
 * there would manufacture evidence, so it is optional and only carried when the
 * row really measured the absence.
 *
 * On the codex map NO cell carries a marker (`shape.evidenceRequired: false`) and
 * that is a claim about the pass, not a relaxation: every page was read whole and
 * probed with a positive control, so the class is uniform. A marker appearing
 * there is still an error — it would assert a distinction the map does not draw.
 */
export function parseCell(raw: string, shape: MapShape = CLAUDE_MAP): ParsedCell | string {
  const cell = raw.trim()
  const verdict = shape.verdicts.find(glyph => cell.startsWith(glyph))
  if (!verdict) return `no verdict glyph in \`${cell}\``
  let rest = cell.slice(verdict.length)
  let evidence: EvidenceMarker | undefined
  const marker = EVIDENCE_MARKERS.find(candidate => rest.startsWith(candidate))
  if (marker) {
    evidence = marker
    rest = rest.slice(marker.length)
  }
  let shared = false
  if (rest.startsWith(SCOPE_MARKER)) {
    shared = true
    rest = rest.slice(SCOPE_MARKER.length)
  }
  if (rest.length > 0) return `\`${cell}\` carries \`${rest}\` after its glyph and markers`
  if (!shape.evidenceRequired && (evidence !== undefined || shared)) {
    return `\`${cell}\` carries an evidence marker, but the ${shape.name} draws no per-cell evidence class`
  }
  if (shared && evidence === undefined) {
    return `\`${cell}\` is marked shared-host (\`${SCOPE_MARKER}\`) with no evidence marker before it`
  }
  if (shape.evidenceRequired && evidence === undefined && (verdict === '🟩' || verdict === '🟨')) {
    return `\`${cell}\` claims coverage with no evidence marker (${EVIDENCE_MARKERS.join(' ')})`
  }
  return { verdict, shared, ...(evidence === undefined ? {} : { evidence }) }
}

export type VerdictTally = Record<string, number>

export interface CoverageMapAudit {
  /** Everything wrong. Empty means the document is structurally sound. */
  errors: string[]
  /** Rows counted per verdict column, per verdict, from the tables themselves. */
  counted: Record<string, VerdictTally>
  /** How many rows the tables hold. */
  rows: number
  /** Cells resting on each evidence class — the report the runtime axis exists to make. */
  evidence: Record<string, Record<EvidenceMarker | 'none', number>>
  /** Cells that repeat a host-level measurement rather than making their own. */
  shared: Record<string, number>
  /** The document with corrected derived numbers, or `undefined` when exact. */
  repaired?: string
}

function emptyTally(shape: MapShape): VerdictTally {
  return Object.fromEntries(shape.verdicts.map(glyph => [glyph, 0]))
}

/**
 * Audit the map text against itself and against the page snapshot.
 *
 * `tsvText` is the map's page snapshot, which each map's own header calls the
 * DENOMINATOR: a page in the snapshot with no row is a page nobody verdicted,
 * and that absence is the failure the map exists to make visible. It is now
 * audited in the other direction too — a row for a page the snapshot does not
 * carry means the snapshot is stale, which is how a corpus grows silently.
 */
export function auditCoverageMap(
  mapText: string,
  tsvText: string,
  shape: MapShape = CLAUDE_MAP,
): CoverageMapAudit {
  const errors: string[] = []
  const lines = mapText.split('\n')
  const columns = shape.columns ?? [SINGLE_COLUMN]
  const LEGEND_ROW = legendRow(shape)
  const counted: Record<string, VerdictTally> = Object.fromEntries(
    columns.map(column => [column, emptyTally(shape)]),
  )
  const evidence: CoverageMapAudit['evidence'] = Object.fromEntries(
    columns.map(column => [column, { 'ᵗ': 0, 'ᵏ': 0, 'ʰ': 0, none: 0 }]),
  )
  const shared: Record<string, number> = Object.fromEntries(columns.map(column => [column, 0]))
  const slugRows = new Map<string, number[]>()
  const numberRows = new Map<number, string[]>()
  let rows = 0

  for (const [start, end] of tableBlocks(lines)) {
    const header = lines[start] ?? ''
    const separator = end > start ? lines[start + 1] ?? '' : ''
    if (!SEPARATOR_ROW.test(separator)) {
      // A row group with no header/separator is not a table: GFM renders it as a
      // paragraph of literal pipes, which is how twelve rows went missing.
      errors.push(
        `L${start + 1}-${end + 1}: ${end - start + 1} table row(s) with no header and separator above them`
        + ` — a blank line ends a table, so these render as literal text: ${header.slice(0, 60)}…`,
      )
      continue
    }
    const want = cellCount(header)
    if (cellCount(separator) !== want) {
      errors.push(`L${start + 2}: separator has ${cellCount(separator)} fields, header has ${want}`)
    }
    // A map table's runtime columns are three interchangeable-looking glyphs, so
    // the header order is the only thing that says which is which. An axis-less
    // map has one verdict column and therefore nothing to reorder.
    const headerFields = header.split(CELL_SEPARATOR).map(field => field.trim())
    const isMapTable = want === shape.headerFields && headerFields[1] === shape.headerKey
    if (isMapTable && shape.columns) {
      const labels = headerFields.slice(4, 4 + shape.columns.length)
      if (labels.join('|') !== shape.columns.join('|')) {
        errors.push(
          `L${start + 1}: runtime columns read ${labels.join(' / ')}`
          + ` — the axis order is pinned to ${shape.columns.join(' / ')}`,
        )
      }
    }
    for (let index = start + 2; index <= end; index += 1) {
      const line = lines[index] ?? ''
      const got = cellCount(line)
      if (got !== want) {
        errors.push(
          `L${index + 1}: ${got} fields against a ${want}-field header`
          + ' — escape a literal `|` inside a cell as `\\|` (a backtick span does NOT protect it):'
          + ` ${line.slice(0, 60)}…`,
        )
        continue
      }
      const fields = line.split(CELL_SEPARATOR)
      const first = fields[1] ?? ''
      if (!isMapTable || !ROW_NUMBER.test(first)) continue
      rows += 1
      columns.forEach((column, offset) => {
        const parsed = parseCell(fields[4 + offset] ?? '', shape)
        if (typeof parsed === 'string') {
          errors.push(`L${index + 1}: row ${first.trim()} ${column} cell — ${parsed}`)
          return
        }
        counted[column]![parsed.verdict] = (counted[column]![parsed.verdict] ?? 0) + 1
        evidence[column]![parsed.evidence ?? 'none'] += 1
        if (parsed.shared) shared[column] = (shared[column] ?? 0) + 1
      })
      const slug = PAGE_SLUG.exec(fields[2] ?? '')?.[1]
      if (!slug) {
        errors.push(`L${index + 1}: row ${first.trim()} names no [\`page-slug\`] in column 2`)
      } else {
        slugRows.set(slug, [...(slugRows.get(slug) ?? []), index + 1])
      }
      const id = Number(first.trim())
      numberRows.set(id, [...(numberRows.get(id) ?? []), slug ?? `L${index + 1}`])
    }
  }

  for (const [slug, at] of slugRows) {
    if (at.length > 1 && !shape.knownDuplicateSlugs.has(slug)) {
      errors.push(`page \`${slug}\` has ${at.length} rows (lines ${at.join(', ')})`)
    }
  }
  for (const [id, pages] of numberRows) {
    if (pages.length > 1 && !shape.knownDuplicateIds.has(id)) {
      errors.push(`# ${id} is used by ${pages.length} rows (${pages.join(', ')}) — a row's number is its key`)
    }
  }

  const snapshotLines = tsvText.split('\n')
    .filter(line => line.trim().length > 0 && !line.startsWith('#'))
    .map(line => line.split('\t')[0] ?? '')
  const snapshot = new Set(snapshotLines)
  for (const slug of snapshot) {
    if (!slugRows.has(slug)) errors.push(`page \`${slug}\` is in the snapshot and has no row`)
  }
  // The other direction, and it is the one nobody checked: a row whose page has
  // LEFT the snapshot (or was never in it) means the map and its denominator
  // disagree, and the map is the louder document. Both codex corpus growths were
  // found by a person re-fetching the index by hand.
  for (const slug of slugRows.keys()) {
    if (!snapshot.has(slug) && !shape.knownRetiredSlugs.has(slug)) {
      errors.push(`row page \`${slug}\` is in no snapshot line — the TSV is stale or the slug is wrong`)
    }
  }
  // The snapshot's own header line, which `AGENTS.md` tells readers to trust over
  // any count in prose. It counted a duplicate slug as a page for a week.
  const snapshotLine = tsvText.split('\n').find(line => SNAPSHOT_LINE.test(line))
  if (!snapshotLine) {
    errors.push(`${shape.tsvPath}: no \`Snapshot: <date>, <n> pages\` line — the file's own count is what readers are told to trust`)
  } else {
    const stated = Number(SNAPSHOT_LINE.exec(snapshotLine)![2])
    if (stated !== snapshot.size) {
      errors.push(
        `${shape.tsvPath}: the Snapshot line says ${stated} pages, the file holds ${snapshot.size} unique slugs`
        + (snapshotLines.length === stated ? ` (${snapshotLines.length} data lines — a slug is listed twice)` : ''),
      )
    }
  }

  // The tallies and the row marker: derived data, so they are recomputed rather
  // than trusted. Three columns means three numbers per legend line, and a
  // column whose numbers do not sum to the row count is a parse failure the
  // per-cell errors above will already have named.
  const rewritten = [...lines]
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const marker = ROW_MARKER.exec(line)
    if (marker) {
      if (Number(marker[1]) !== rows) {
        errors.push(`L${index + 1}: the row marker says ${marker[1]}, the tables hold ${rows}`)
        rewritten[index] = `<!-- rows: ${rows} -->`
      }
      continue
    }
    const match = LEGEND_ROW.exec(line)
    if (!match) continue
    const glyph = match[1]!
    const stated = columns.map((_, offset) => Number(match[3 + offset]))
    const want = columns.map(column => counted[column]![glyph] ?? 0)
    if (stated.join('/') === want.join('/')) continue
    errors.push(
      `L${index + 1}: legend says ${glyph} = ${stated.join('/')}`
      + ` (${columns.join('/')}), the tables hold ${want.join('/')}`,
    )
    rewritten[index] = `|${line.split(CELL_SEPARATOR)[1]}|${match[2]}| ${want.join(' | ')} |`
  }
  const joined = rewritten.join('\n')
  const repaired = joined === mapText ? undefined : joined

  return { errors, counted, rows, evidence, shared, ...(repaired === undefined ? {} : { repaired }) }
}

export function report(shape: MapShape, readOnly: boolean): number {
  const mapText = readFileSync(shape.mapPath, 'utf-8')
  const audit = auditCoverageMap(mapText, readFileSync(shape.tsvPath, 'utf-8'), shape)
  const label = shape.name

  if (audit.repaired !== undefined && !readOnly) {
    writeFileSync(shape.mapPath, audit.repaired)
    console.log(`${label}: derived numbers rewritten from the tables`)
  }
  for (const error of audit.errors) console.error(`${label}: ${error}`)
  console.log(`${label}: ${audit.rows} rows`)
  for (const column of shape.columns ?? [SINGLE_COLUMN]) {
    const tally = shape.verdicts.map(glyph => `${glyph} ${audit.counted[column]![glyph]}`).join('  ')
    const classes = shape.evidenceRequired
      ? '  — evidence '
        + EVIDENCE_MARKERS.map(marker => `${marker}${audit.evidence[column]![marker]}`).join(' ')
        + ` none${audit.evidence[column]!.none}, shared-host ${audit.shared[column]}`
      : ''
    console.log(`${label}: ${column.padEnd(6)} ${tally}${classes}`)
  }
  if (audit.errors.length === 0) return 0
  console.error(
    `${label}: ${audit.errors.length} problem(s)`
    + (readOnly ? ' — rerun with --write to rewrite the tallies; row text is never rewritten' : ''),
  )
  return 1
}

/**
 * `maps` is injectable so the read-only default can be asserted against a
 * throwaway copy: the shipped documents are converged, so a bare run over THEM
 * writes nothing whatever the flag does, and a test driving the real paths
 * would pass with the fix removed.
 */
export function main(argv: readonly string[], maps: readonly MapShape[] = MAPS): number {
  // Read-only unless `--write`. `--check` is still accepted — `package.json`'s
  // `check:coverage-map` and a dozen documents spell it — and now names the
  // default rather than selecting it.
  const readOnly = !argv.includes('--write')
  // Both maps are reported even when the first is broken: a script that stops at
  // the first bad document teaches the reader that the second one is fine.
  return maps.map(shape => report(shape, readOnly)).reduce((worst, code) => worst || code, 0)
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))

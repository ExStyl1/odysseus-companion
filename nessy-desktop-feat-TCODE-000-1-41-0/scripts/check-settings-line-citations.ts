/**
 * check-settings-line-citations — a RATCHET on the one class of anchor no other
 * guard in this tree can see: `settings.md:<line>`.
 *
 * P6.746.
 *
 * ## Why a ratchet, and why here
 *
 * `settings.md` SPLIT (measured 2026-08-25): the page is now scope / precedence /
 * how-to-edit, the key-by-key reference is `settings-reference.md`, the
 * managed-policy invalid-value material is `managed-settings.md`, and some of it
 * landed on `server-managed-settings.md`. So every `settings.md:<line>` citation in
 * this tree is dead **at the page level**, and renumbering cannot fix one of them.
 * The disposition — which are worth converting, which are deliberately frozen, and
 * the verified successor anchor plus today's verbatim sentence for the most-cited
 * ones — is `docs/superpowers/specs/2026-09-07-settings-anchor-rot-disposition.md`.
 * Read that before converting a citation; this script does not convert anything.
 *
 * `check-doc-anchors.ts` says so itself, in its own §WHAT THIS GUARD CANNOT CATCH:
 * "it cannot see any line-numbered anchor at all". It resolves `page.md#section` (doc-anchor:example)
 * against a snapshot of published ids; a line number has no id to resolve. So the
 * repo's one anchor gate is structurally blind to this whole population, and the
 * population MOVED during wave 9 with nothing to notice.
 *
 * The marker on that sentence is `check-doc-anchors.ts`'s per-occurrence
 * placeholder escape (`PLACEHOLDER_MARKER`), and it has to sit on the SAME line as
 * the reference. `page.md` is in no corpus, so without it the sentence EXPLAINING
 * the gate was the gate's only tree-wide finding — which is exactly how it read
 * until P6.871.
 *
 * ## What it counts, and why that scope
 *
 * `packages/**` + `apps/**` — the **FOLLOWABLE** bucket of the disposition spec:
 * source comments a developer reading the code will actually follow. Everything
 * else that carries these citations is **FROZEN** by that spec and deliberately so:
 * generated sweep artifacts under `docs/superpowers/specs/data/`, dated spec
 * records, plan rows (the tracker, which no lane writes), dated run narratives.
 * Ratcheting the whole tree would go red on every plan commit — a gate that cries
 * wolf is a gate people stop running.
 *
 * The instrument is `git grep -a`, byte-honest and the one the AGENTS.md census
 * command uses. A wrapped `grep -r` is not: it hid 25 of 835 hits in one pass and
 * timed out walking `node_modules` in the next. Occurrences, not lines: a line can
 * carry two citations, and a line count would silently under-report the day one
 * does. (Measured 2026-09-08: the two readings agree exactly at this scope, which
 * is why the AGENTS.md line-count form and this one give the same number today.)
 *
 * ## The pin
 *
 * `PINNED_CENSUS` below is the ONLY place the number lives. It is not quoted in
 * prose anywhere — this tree has said 827, 828, 835, 767 and 772 about this same
 * problem, each correct on the day it was written, which is the whole reason the
 * number is a constant under a gate instead of a sentence.
 *
 * The gate fails on a RISE only. A fall is the intended direction: it prints the
 * new value and asks the converting commit to lower the pin in the same change.
 *
 * ## One thing to check before believing a rise
 *
 * `git grep` with no revision reads the **working tree** of tracked files, so in
 * this shared tree a rise can be a neighbour lane's uncommitted mid-edit rather
 * than anything your commit did. Re-run the same census against the index —
 * `git grep --cached -ahoI -E "$R" -- packages apps | wc -l`, or `--cached` here —
 * before concluding the count really moved.
 *
 * ## Why the working tree stays the DEFAULT (P6.936, measured 2026-09-09)
 *
 * P6.936 proposed flipping every tree-scanning gate to the index, from P6.933's
 * finding on the sibling citation gate. Refused here, with the reason, because
 * this gate's subject INCLUDES the runner's own edit: converting citations and
 * lowering the pin happen in ONE commit, so a run that cannot see the conversion
 * cannot produce the number the conversion is supposed to write. An index default
 * would make the gate silently answer the previous commit's question.
 *
 * The gate the proposal came from does something different, and better: it splits
 * the two reads. `check-ledger-citations.ts` reads the DOCUMENTS it is checking
 * from the working tree (that is the change in front of you) and the files those
 * documents make claims ABOUT from the index (a neighbour's mid-edit is not your
 * finding). Every other census script in `scripts/` has only ONE read, where the
 * artifact and the subject are the same file — and for those the working tree is
 * the only honest default. The recoverable half is already here: a rise PRINTS the
 * `--cached` re-run instruction, which is what AGENTS.md prescribes.
 *
 * Usage:
 *   bun scripts/check-settings-line-citations.ts            # report, always exit 0
 *   bun scripts/check-settings-line-citations.ts --check    # exit 1 if the census ROSE
 *   bun scripts/check-settings-line-citations.ts --cached   # count the index, not the worktree
 *
 * D1.99 added a SECOND, non-blocking census over every page of the Claude corpus
 * — see the block on {@link CORPUS_PATTERN}. Both run on every invocation; only
 * the settings one can fail the gate.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GateSafetyRefusal } from './gate-safety'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The census regex, character for character the one in AGENTS.md §"Upstream Docs
 * Are Contracts". The leading class catches the sibling page spellings
 * (`server-managed-settings.md`, `managed-settings.md`) that a bare
 * `settings\.md` would count as the same page.
 */
export const CITATION_PATTERN = '[A-Za-z0-9_-]*settings\\.md:[0-9]+(-[0-9]+)?'

/** The FOLLOWABLE bucket of the disposition spec — source, not documentation. */
export const CENSUS_PATHSPEC: readonly string[] = ['packages', 'apps']

/**
 * The last reading, and the ONLY place this number is written down.
 *
 * Re-derive it with the AGENTS.md census command rather than trusting this
 * comment; lower it in the same commit that converts citations. Do not raise it
 * to make a red run green — a rise is a new dead line-numbered anchor, which is
 * the thing this gate exists to stop.
 */
export const PINNED_CENSUS = 0

export interface CensusResult {
  /** Every matched citation, in `git grep` scan order. */
  citations: string[]
  /** Occurrences — the number the pin compares against. */
  occurrences: number
  /** Distinct citation strings, for the report line. */
  distinct: number
}


/**
 * ==========================================================================
 * D1.99 — THE SAME ROT, ONE PAGE WIDER: every page of the Claude corpus.
 *
 * The census above watches ONE page because that page SPLIT, which makes its
 * line anchors dead rather than merely stale. P6.1037 asked what the same regex
 * finds when the page name is not pinned, and the answer is that `settings.md`
 * was **14 % of a class nothing measures**. Re-measured 2026-09-17 from a tree
 * whose working copy and index AGREE (both readings below are the same number,
 * which is the control that says no neighbour's mid-edit is in it):
 *
 * **2 186** `<page>.md:<line>` occurrences under `packages` + `apps` over **561**
 * files, **2 133** of them naming a page in the snapshotted index, over 635
 * distinct citation strings and 57 distinct pages: `skills.md` 237, `mcp.md` 234,
 * `hooks.md` 177, `sub-agents.md` 172, `plugins-reference.md` 118, `memory.md`
 * 112, `model-config.md` 89. (P6.1037 read 2 219 / 2 162 / 562 on 2026-09-10 —
 * a reading with a date, exactly as this file's header says about every number
 * in it.)
 *
 * ## Why this pin does NOT fail the gate, and the settings one does
 *
 * The row that asked for it said so and the distinction is the whole design:
 * those pages **have not split**. An anchor into `hooks.md:184` is DECAYED — the
 * page is live, the section is live, the number may even still be right — where
 * every `settings.md:<line>` is DEAD at the page level and renumbering cannot
 * repair one. Failing a lane's commit for writing a citation that may be correct
 * today is the cry-wolf shape AGENTS.md names, and it would land in a wave where
 * seven lanes are writing docblocks. So a RISE prints, loudly, and returns 0.
 *
 * Flipping it is one line ({@link corpusRiseIsFatal}) the day the owner wants
 * the stronger posture, and the flip is stated here rather than hidden so the
 * next reader knows it is a POSTURE and not an oversight.
 *
 * ## Two limits, both stated rather than fixed
 *
 *  - **The denominator is a SNAPSHOT.** {@link DOC_PAGES_FILE} is dated in its
 *    own header, and a corpus refresh moves this census with no source file
 *    touched — the same property `build-parity-report.py` has for the same
 *    reason. Read the TSV's `Snapshot:` line, never a count in prose.
 *  - **The match is by BASENAME, so nine pages are conflated.** The index's 191
 *    slugs carry 182 distinct basenames; `agent-sdk/hooks` and `hooks` are two
 *    pages with one filename, and eight more pairs like it. For a census of "how
 *    many line anchors point into the corpus" that loses nothing — both members
 *    are in the corpus — and it would matter only to a per-page breakdown, which
 *    this gate does not publish.
 * ==========================================================================
 */
export const CORPUS_PATTERN = '[A-Za-z0-9_.-]+\\.md:[0-9]+(-[0-9]+)?'

/** The page denominator, snapshotted; see the block above for what that costs. */
export const DOC_PAGES_FILE = 'scripts/claude-doc-pages.tsv'

/**
 * The corpus page FILENAMES, read from the snapshot.
 *
 * A slug may carry a directory (`agent-sdk/hooks`); the basename is what a
 * citation spells, so that is what this returns. It refuses an empty read rather
 * than reporting a census of zero: a gate whose denominator silently became
 * empty would print `0 in-corpus citations` and read as a fully converted tree.
 */
export function corpusPageNames(root: string = REPO_ROOT): Set<string> {
  const text = readFileSync(join(root, DOC_PAGES_FILE), 'utf8')
  const names = new Set<string>()
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue
    const slug = (line.split('\t')[0] ?? '').trim()
    if (slug !== '') names.add(`${slug.split('/').pop() as string}.md`)
  }
  if (names.size === 0) {
    throw new GateSafetyRefusal(
      `REFUSED: ${DOC_PAGES_FILE} yielded no page names — every citation would read as out-of-corpus and the `
      + 'census would print a zero that means nothing was read.',
    )
  }
  return names
}

/**
 * The last reading, and the ONLY place this number is written down.
 *
 * Never set it BELOW what the tree carries: this pin's whole job is to be the
 * number a rise is measured against, and a pin under the tree manufactures a
 * permanent rise that teaches the next reader to ignore the line.
 *
 * 2138 -> 1879, measured 2026-10-01 (F1.1033), worktree AND `--cached` agreeing at
 * 1879 / 546 distinct. NOT a repair: the corpus refresh dropped the retired plugin
 * pages (plugins-reference, plugin-marketplaces, discover-plugins, plugins, …) from
 * claude-doc-pages.tsv, so their 259 line-numbered citations stopped counting here.
 * (Before: 2133 -> 2138 on 2026-09-19, WI-bs, CI job 630520568.)
 */
export const PINNED_CORPUS_CENSUS = 1879

/**
 * The posture, in one place. `false` = a rise is REPORTED and the gate still
 * exits 0; see the block above for why that is the right default for a decayed
 * anchor and the wrong one for a dead page.
 */
export const corpusRiseIsFatal = false

/** The wide census: every `<page>.md:<line>` under the pathspec that names a corpus page. */
export function corpusCensus(
  root: string = REPO_ROOT,
  pathspec: readonly string[] = CENSUS_PATHSPEC,
  options: CensusOptions = {},
  pages: ReadonlySet<string> = corpusPageNames(root),
): CensusResult {
  const all = census(root, pathspec, options, CORPUS_PATTERN)
  const citations = all.citations.filter(
    token => pages.has((token.split(':')[0] ?? '').split('/').pop() as string),
  )
  return { citations, occurrences: citations.length, distinct: new Set(citations).size }
}

export interface CensusOptions {
  /** Count the index instead of the working tree — the neighbour-mid-edit control. */
  cached?: boolean
  /**
   * Search a plain directory with no git index at all. Used only by the tests,
   * which plant a citation in a scratch file that no index knows about.
   */
  noIndex?: boolean
}

/**
 * The `git grep` argv for one half of the report, pathspec excluded.
 *
 * ONE builder for both halves because they had DRIFTED: the count honoured
 * `--cached` and the file list did not, so a `--cached` run printed an index
 * count above a WORKING-TREE list of files and nothing in the output said the
 * two came from different trees (measured 2026-09-09, P6.936). `-ahoI` prints
 * one line per OCCURRENCE, `-acI` one `path:count` line per FILE — the only
 * difference between the halves.
 */
export function censusArgs(
  half: 'occurrences' | 'files',
  options: CensusOptions = {},
  pattern: string = CITATION_PATTERN,
): string[] {
  const args = ['grep', half === 'occurrences' ? '-ahoI' : '-acI', '-E']
  if (options.cached === true) args.push('--cached')
  if (options.noIndex === true) args.push('--no-index')
  args.push(pattern, '--')
  return args
}

/**
 * Run the census under `root` over `pathspec`.
 *
 * `git grep` exits 1 when it matches nothing, which is a legitimate result here
 * (a fully converted tree), so a status of 1 is read as "no citations" and any
 * other non-zero status is re-thrown.
 */
export function census(
  root: string = REPO_ROOT,
  pathspec: readonly string[] = CENSUS_PATHSPEC,
  options: CensusOptions = {},
  pattern: string = CITATION_PATTERN,
): CensusResult {
  const args = [...censusArgs('occurrences', options, pattern), ...pathspec]

  let out: string
  try {
    out = execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status === 1) out = ''
    else throw error
  }

  const citations = out.split('\n').filter((line) => line !== '')
  return { citations, occurrences: citations.length, distinct: new Set(citations).size }
}

export type Verdict = 'unchanged' | 'fell' | 'rose'

/** The ratchet itself: only a RISE is a failure. */
export function verdict(occurrences: number, pinned: number = PINNED_CENSUS): Verdict {
  if (occurrences > pinned) return 'rose'
  if (occurrences < pinned) return 'fell'
  return 'unchanged'
}

/** Which files carry the citations, most-cited first — named so a rise is actionable. */
function citingFiles(root: string, pathspec: readonly string[], options: CensusOptions = {}): string[] {
  let out: string
  try {
    out = execFileSync('git', [...censusArgs('files', options), ...pathspec], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    if ((error as { status?: number }).status === 1) return []
    throw error
  }
  return out
    .split('\n')
    .filter((line) => line !== '')
    .sort((a, b) => Number(b.split(':').pop()) - Number(a.split(':').pop()))
}

function main(): void {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const cached = args.includes('--cached')

  const result = census(REPO_ROOT, CENSUS_PATHSPEC, { cached })
  const where = cached ? 'index' : 'working tree'
  const outcome = verdict(result.occurrences)

  console.log(
    `check-settings-line-citations: ${result.occurrences} line-numbered settings-page citations ` +
    `(${result.distinct} distinct) under ${CENSUS_PATHSPEC.join(', ')} in the ${where}; pin is ${PINNED_CENSUS}.`,
  )

  if (outcome === 'fell') {
    console.log(
      `  It FELL by ${PINNED_CENSUS - result.occurrences}. Lower PINNED_CENSUS to ` +
      `${result.occurrences} in scripts/check-settings-line-citations.ts, in the same commit.`,
    )
  }

  if (outcome === 'rose') {
    console.error(
      `  It ROSE by ${result.occurrences - PINNED_CENSUS}. Every one of these anchors is dead at the ` +
      'PAGE level — settings.md split, so a line number cannot be renumbered into a live one. Cite ' +
      '`page.md#<section>` plus the verbatim sentence instead; the verified successor anchors are in ' +
      'docs/superpowers/specs/2026-09-07-settings-anchor-rot-disposition.md.',
    )
    if (!cached) {
      console.error(
        '  Before believing it: this counted the WORKING TREE, and a sibling lane\'s uncommitted edit ' +
        'to a tracked file is visible here. Re-run with --cached to count the index instead.',
      )
    }
    console.error('  Files carrying them, most-cited first:')
    for (const line of citingFiles(REPO_ROOT, CENSUS_PATHSPEC, { cached }).slice(0, 10)) {
      console.error(`    ${line}`)
    }
    if (check) process.exit(1)
  }

  reportCorpusCensus(cached, check)
}

/**
 * D1.99's half of the report. It runs AFTER the settings half and never before:
 * the settings class is dead at the page level and is the one a reader must act
 * on, so it keeps the top of the output.
 */
function reportCorpusCensus(cached: boolean, check: boolean): void {
  const wide = corpusCensus(REPO_ROOT, CENSUS_PATHSPEC, { cached })
  const where = cached ? 'index' : 'working tree'
  const outcome = verdict(wide.occurrences, PINNED_CORPUS_CENSUS)

  console.log(
    `check-settings-line-citations: ${wide.occurrences} line-numbered citations of a page in `
    + `${DOC_PAGES_FILE} (${wide.distinct} distinct) under ${CENSUS_PATHSPEC.join(', ')} in the ${where}; `
    + `pin is ${PINNED_CORPUS_CENSUS}.`,
  )

  if (outcome === 'fell') {
    console.log(
      `  It FELL by ${PINNED_CORPUS_CENSUS - wide.occurrences}. Lower PINNED_CORPUS_CENSUS to `
      + `${wide.occurrences} in scripts/check-settings-line-citations.ts, in the same commit that converted `
      + 'them — a fall you did not cause is a reading, not a repair.',
    )
  }

  if (outcome === 'rose') {
    // NON-BLOCKING by design, and the reason is one line up in the code as well
    // as in the header: these pages have NOT split, so the anchor is decayed
    // rather than dead and a lane may have written a correct one today.
    console.log(
      `  It ROSE by ${wide.occurrences - PINNED_CORPUS_CENSUS}. These pages have not split, so this is `
      + 'DECAY rather than death and the gate does not fail on it — but a `page.md#<section>` anchor plus '
      + 'the verbatim sentence is the form that survives, and a line number has a measured half-life of '
      + 'about two days (AGENTS.md §"Upstream Docs Are Contracts").',
    )
    if (!cached) {
      console.log(
        '  This counted the WORKING TREE; re-run with --cached before concluding the count really moved.',
      )
    }
    if (check && corpusRiseIsFatal) process.exit(1)
  }
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    if (error instanceof GateSafetyRefusal) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  }
}

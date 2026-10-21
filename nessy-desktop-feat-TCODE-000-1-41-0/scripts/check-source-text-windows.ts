/**
 * check-source-text-windows — a RATCHET on fixed-size windows into source TEXT.
 *
 * D1.241.
 *
 * ## The class, and why a sweep cannot close it
 *
 * A test that reads a module's own source and asserts on a region of it has to
 * bound that region somehow, and the cheap way is a character count:
 * `src.slice(start, start + 2_000)`. Such a window is a stale-count guard
 * wearing a number and it rots in BOTH directions — it grows past the region and
 * starts matching the neighbour, or the region grows past it and the positive
 * assertion goes red against correct code. Either way the red lands on a case
 * named for something else. `3fb393853`'s window rotted three times (the spread
 * it looked for moved 1 225 -> 1 526 -> 2 127) and the 1.36.0 wave gate reported
 * the file red while the source under it was right.
 *
 * D1.111 converted fourteen of them behind {@link bracedRegionImport}. What that
 * row measured while doing it is the reason THIS file exists: between its census
 * at HEAD and the census after its own commit the count went 47 -> 34 for the
 * fourteen, **plus one NEW window** that a sibling lane had written in the same
 * wave, and an hour later the count was 36 — three more born from sibling
 * commits. The class is not a backlog that shrinks to zero. It regrows at the
 * rate people write source-text tests, so a sweep without a ratchet is a reading
 * with a date, which is what this repo's §Traps says about every number in prose.
 *
 * ## What it counts, and why the pin is over TEST files only
 *
 * The pattern is D1.111's census regex character for character — the one in
 * `source-regions.ts`'s own header, which is the worklist a converting lane
 * follows. The PINNED half narrows it to test files (`*.test.ts`, `*.test.tsx`,
 * `*.isolated.ts`), because "a fixed-size window into source text" is a claim
 * about a TEST reading a module, and a production module slicing a string by a
 * number is ordinary code this gate has no opinion about.
 *
 * The WIDE half prints beside it, unpinned, so the narrowing is visible rather
 * than assumed. Today the difference is exactly ONE line and it is
 * `packages/shared/src/testing/source-regions.ts`'s docblock spelling the
 * anti-pattern it replaces — i.e. the wide census counts the fix's own
 * description of the bug (and, from this commit, this file's own too). That is
 * the strongest available argument for the narrow pin, and it is why the wide
 * number is REPORTED and never gated: an exclusion list would be a second thing
 * to maintain, and the day it went wrong it would go wrong silently.
 *
 * ## The conversion this gate is asking for
 *
 * `bracedRegion` from `@nessy-agent/shared/testing/source-regions` (or
 * `'../../testing/source-regions.ts'` inside `packages/shared`): it returns from
 * the anchor to the `}` that closes the first `{` at or after it, so the
 * assertion is bounded by the thing it was always about and no number has to be
 * maintained.
 *
 * **And the boundary control is not optional, which is why the failure message
 * says so.** A brace scan that runs away returns the rest of the file, and a
 * POSITIVE assertion over the rest of the file passes for a match anywhere in
 * the module — silently, which is worse than the window it replaced. Every
 * caller adds one `not.toContain` naming a declaration that sits BELOW the
 * region — below, because a brace scan only runs FORWARD, so a control anchored
 * ABOVE the region can never fail. Four of four of D1.111's own first drafts had
 * exactly that bug and all four passed. `check-braced-region-controls.ts`
 * (D1.243) is the gate for that half.
 *
 * For a MINIFIED bundle do NOT brace-match — braces inside a minified string do
 * not balance textually. Bound the region with an end ANCHOR read out of the
 * bundle, as `powershell-tool-settings-route.test.ts` now does.
 *
 * ## Before believing a rise
 *
 * `git grep` with no revision reads the WORKING TREE of tracked files, so in
 * this shared tree a rise can be a neighbour lane's uncommitted mid-edit rather
 * than anything your commit did. `--cached` re-runs the same census against the
 * index; the failure message says so. (Measured 2026-09-17 at HEAD `b377320e6`:
 * the two readings agreed, 35 and 35, which is the control that says no
 * neighbour's edit was in the pin.)
 *
 * The instrument is `git grep -a` over OCCURRENCES, not lines: a line can carry
 * two windows and a line count would under-report the day one does.
 *
 * Usage:
 *   bun scripts/check-source-text-windows.ts            # report, always exit 0
 *   bun scripts/check-source-text-windows.ts --check    # exit 1 if the census ROSE
 *   bun scripts/check-source-text-windows.ts --cached   # count the index, not the worktree
 */

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GateSafetyRefusal } from './gate-safety'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * D1.111's census regex, character for character.
 *
 * `slice(<identifier>, <identifier> + <3-or-more digits>)`. The three-digit
 * floor is deliberate: `s.slice(i, i + 2)` is a two-character read, not a
 * window into a region, and counting it would bury the population this gate is
 * about under ordinary string arithmetic.
 */
export const WINDOW_PATTERN = 'slice\\([A-Za-z_][A-Za-z0-9_.]*, *[A-Za-z_][A-Za-z0-9_.]* *\\+ *[0-9_]{3,}\\)'

/** {@link WINDOW_PATTERN} with the receiver it is sliced off, for the scan shape below. */
const RECEIVED_WINDOW = `[A-Za-z_][A-Za-z0-9_.]*\\.${WINDOW_PATTERN}`

/**
 * A window that bounds a REGEX SCAN rather than a region — D1.289.
 *
 * `pattern.exec(text.slice(windowStart, at + 512))` is not the class this gate
 * is about and no conversion exists for it. The region such a call means is
 * bounded by the PATTERN'S OWN CAPTURES; the number bounds how far the scan
 * looks, so it cannot rot in either direction the way a region window does — too
 * small and the `exec` returns null and the case fails loudly on its own
 * assertion, too large and it costs time and nothing else. Both sites in the
 * tree scan a 233 MB minified binary where an unanchored pattern costs 12 s per
 * scan and blows the per-test budget, and `bracedRegion` cannot be used on a
 * minified artefact at all: its braces do not balance textually.
 *
 * Both directions are matched, because both are the ordinary spelling:
 * `re.exec(<window>)` / `re.test(<window>)`, and `<window>.match(re)` /
 * `.matchAll(re)` / `.search(re)`. Only the first occurs today; the second is
 * covered so the next author writing the natural form is not handed a red with
 * no resolution. A shape NOT matched here simply stays in the gated census,
 * which is the safe direction for a rule to be incomplete in.
 *
 * **Why a shape and not a marker comment.** The alternative the row offers is an
 * opt-out marker the sites carry. It reads the same but it costs an edit to
 * every exempt TEST FILE, where a shape costs one census; and a marker is a
 * claim a reader makes about their own code, which this gate would then have to
 * take on trust. The shape is read off the call itself.
 *
 * ERE, not PCRE: `git grep -E` is POSIX extended, where `(?:…)` is not a
 * non-capturing group. Plain groups only.
 */
export const SCAN_BOUND_PATTERN =
  `(exec|test)\\(${RECEIVED_WINDOW}|${RECEIVED_WINDOW}\\.(match|matchAll|search)\\(`

/** The import a converting commit adds — named in the failure message, not guessed at. */
export const bracedRegionImport = '@nessy-agent/shared/testing/source-regions'

/**
 * The PINNED scope: test files under `packages` and `apps`.
 *
 * `:(glob)` on every one of them. A bare `**` pathspec is read WITHOUT glob
 * magic by git and silently drops files — AGENTS.md §Traps records it costing a
 * count of 24 where the answer was 25.
 */
export const TEST_PATHSPEC: readonly string[] = [
  ':(glob)packages/**/*.test.ts',
  ':(glob)packages/**/*.test.tsx',
  ':(glob)packages/**/*.isolated.ts',
  ':(glob)apps/**/*.test.ts',
  ':(glob)apps/**/*.test.tsx',
  ':(glob)apps/**/*.isolated.ts',
]

/** The WIDE scope, reported and never gated — see the header. */
export const WIDE_PATHSPEC: readonly string[] = ['packages', 'apps']

/**
 * The last reading, and the ONLY place this number is written down.
 *
 * Re-derive it with a run of this script rather than trusting any sentence: the
 * sibling row said "seven" where the tree held 47, and this repo has published
 * 7, 46, 47, 36 and 35 about the same population inside one day.
 *
 * Lower it in the SAME commit that converts windows. Do not raise it to make a
 * red run green — a rise is a new number nobody will maintain, which is the
 * thing this gate exists to make deliberate.
 *
 * 9 -> 7 on 2026-09-18 (D1.289) with NO conversion: the two {@link
 * SCAN_BOUND_PATTERN} sites left the gated population, so this is the same tree
 * measured with the right denominator. A pin lowered this way is the one case
 * where the fall message's "converted them" does not apply — say so in the
 * commit, as that one did.
 */
export const PINNED_CENSUS = 7

/**
 * D1.275 — how far the pin may sit ABOVE the tree before that is itself a
 * failure.
 *
 * A ratchet only stops a RISE, so a pin nobody lowers drifts upward silently:
 * `d620b1279` converted five windows and left this pin where it was, and the
 * gate then tolerated five NEW ones without a word. The fall message below has
 * always asked for the lowering, and it was written the same day and still
 * missed — a lane converting files in its own zone has no reason to run a gate
 * it did not know existed.
 *
 * Two is the allowance rather than zero, deliberately: a lane that converts a
 * site and commits before running the gate is the normal case and should read a
 * reminder, not a red. Sustained drift is what a ratchet cannot see on its own,
 * and it is what this refuses.
 */
export const SLACK_ALLOWANCE = 2

/** D1.275 — the pin is this far above the tree, which is what nobody lowered. */
export function slackExceeded(occurrences: number, pinned: number = PINNED_CENSUS, allowance: number = SLACK_ALLOWANCE): boolean {
  return pinned - occurrences > allowance
}

export type Verdict = 'unchanged' | 'fell' | 'rose'

/**
 * The ratchet itself: only a RISE is a failure.
 *
 * Extracted so the three-way decision has a test that does not need the repo's
 * own count — a suite that asserted the live census against the pin would go red
 * the moment a sibling lane wrote a window, which is a control that cries wolf
 * rather than one that can fail for the right reason.
 */
export function verdict(occurrences: number, pinned: number = PINNED_CENSUS): Verdict {
  if (occurrences > pinned) return 'rose'
  if (occurrences < pinned) return 'fell'
  return 'unchanged'
}

export interface CensusResult {
  /** Every matched window, in `git grep` scan order. */
  windows: string[]
  /** Occurrences — the number the pin compares against, scan bounds already out. */
  occurrences: number
  /** Files carrying at least one, for the report line. */
  files: number
  /** Windows bounding a regex SCAN, excluded from {@link occurrences} — D1.289. */
  scanBounds: number
}

export interface CensusOptions {
  /** Count the index instead of the working tree — the neighbour-mid-edit control. */
  cached?: boolean
  /** Search a plain directory with no git index. Used only by the tests. */
  noIndex?: boolean
  /** Root to scan. Defaults to the repo. Used only by the tests. */
  root?: string
  /** Pathspec to scan. Defaults to {@link TEST_PATHSPEC}. */
  pathspec?: readonly string[]
}

function grep(args: readonly string[], options: CensusOptions): string {
  const argv = ['grep', ...(options.noIndex === true ? ['--no-index'] : options.cached === true ? ['--cached'] : []), ...args]
  try {
    return execFileSync('git', argv, {
      cwd: options.root ?? REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    // `git grep` exits 1 with no output when nothing matches; that is a reading,
    // not a failure. Any other status is a real error and must not read as zero.
    const status = (error as { status?: number }).status
    if (status === 1) return ''
    throw error
  }
}

export function census(options: CensusOptions = {}): CensusResult {
  const pathspec = options.noIndex === true ? ['.'] : [...(options.pathspec ?? TEST_PATHSPEC)]
  const windows = grep(['-ahoI', '-E', WINDOW_PATTERN, '--', ...pathspec], options)
    .split('\n')
    .filter(line => line !== '')
  const files = grep(['-alI', '-E', WINDOW_PATTERN, '--', ...pathspec], options)
    .split('\n')
    .filter(line => line !== '')
  // D1.289 — the scan bounds are SUBTRACTED rather than filtered out of
  // `windows`, because the two censuses are two greps over the same bytes and
  // the second one's matched text carries its `exec(` prefix. The subtraction
  // is arithmetic over occurrence counts, which is the only thing both numbers
  // are: `git grep -aho` counts OCCURRENCES, so a line carrying two is two here
  // and two there.
  const scanBounds = grep(['-ahoI', '-E', SCAN_BOUND_PATTERN, '--', ...pathspec], options)
    .split('\n')
    .filter(line => line !== '')
    .length
  return { windows, occurrences: windows.length - scanBounds, files: files.length, scanBounds }
}

/** Which files carry them, most-windows-first — named so a rise is actionable. */
export function windowFiles(options: CensusOptions = {}): string[] {
  const pathspec = options.noIndex === true ? ['.'] : [...(options.pathspec ?? TEST_PATHSPEC)]
  return grep(['-acI', '-E', WINDOW_PATTERN, '--', ...pathspec], options)
    .split('\n')
    .filter(line => line !== '')
    .sort((a, b) => Number(b.split(':').pop()) - Number(a.split(':').pop()))
}

function main(argv: readonly string[]): number {
  const check = argv.includes('--check')
  const cached = argv.includes('--cached')

  const result = census({ cached })

  // A census that finds NOTHING while the pin expects a population is the probe
  // having broken — the pathspec magic dropped, the regex mangled — not the
  // class having emptied. Refuse rather than print a triumphant zero, which is
  // the shape of a gate that has silently stopped gating.
  //
  // D1.289: the test is on the RAW match count, never on the gated number. A
  // tree whose every remaining window is a scan bound is a real zero and the
  // intended end state; a raw zero is the probe.
  if (result.windows.length === 0 && PINNED_CENSUS > 0) {
    throw new GateSafetyRefusal(
      `REFUSED: the source-text-window census found ZERO windows where it expects ${PINNED_CENSUS}. `
      + 'That is the probe failing, not the class emptying — check that the `:(glob)` magic is still on '
      + 'every pathspec (a bare `**` is read literally by git and silently drops files) and that the '
      + 'regex still reads as it does in `packages/shared/src/testing/source-regions.ts`.',
    )
  }

  const where = cached === true ? 'index' : 'working tree'
  console.log(
    `check-source-text-windows: ${result.occurrences} fixed-size source window(s) across `
    + `${result.files} test file(s) in the ${where} (pin ${PINNED_CENSUS}).`,
  )
  if (result.scanBounds > 0) {
    console.log(
      `  ${result.scanBounds} further window(s) bound a REGEX SCAN (\`re.exec(text.slice(a, a + N))\`) and are`
      + '\n  NOT in that number: the region such a call means is bounded by the pattern\'s own captures, so'
      + '\n  the count cannot rot in either direction, and no conversion exists for it (D1.289).',
    )
  }

  const wide = census({ cached, pathspec: WIDE_PATHSPEC })
  console.log(
    `  Wide census (all of ${WIDE_PATHSPEC.join(' + ')}, NOT gated): ${wide.occurrences} across `
    + `${wide.files} file(s) — the difference is non-test source, which this gate has no opinion about.`,
  )

  const outcome = verdict(result.occurrences)

  if (outcome === 'rose') {
    console.log('')
    console.log(`REFUSED: ${result.occurrences - PINNED_CENSUS} new fixed-size source window(s).`)
    console.log(
      '  A `src.slice(start, start + N)` into source text is a stale-count guard wearing a number.'
      + '\n  It rots in BOTH directions and the red lands on a case named for something else.',
    )
    console.log(
      `  The conversion is \`bracedRegion\` from \`${bracedRegionImport}\` (or`
      + "\n  `'../../testing/source-regions.ts'` inside packages/shared): it returns from the anchor to"
      + '\n  the `}` that closes the first `{` at or after it, so no number has to be maintained.',
    )
    console.log(
      '  AND THE BOUNDARY CONTROL COMES WITH IT. A brace scan that runs away returns the rest of the'
      + '\n  file, and a positive assertion over the rest of the file passes for a match anywhere in the'
      + '\n  module. Add one `expect(region).not.toContain(...)` naming a declaration BELOW the region —'
      + '\n  below, because a scan only runs forward, so an anchor declared ABOVE it can never fail —'
      + '\n  `bun scripts/check-braced-region-controls.ts` is the gate for that half (D1.243).',
    )
    console.log(
      '  For a MINIFIED bundle do not brace-match at all: its braces do not balance textually. Bound'
      + '\n  the region with an end anchor read out of the bundle.',
    )
    console.log(
      '  If the window is genuinely the right tool here, raise PINNED_CENSUS in'
      + '\n  `scripts/check-source-text-windows.ts` and say why in the commit.',
    )
    if (cached !== true) {
      console.log(
        '  And before believing the rise at all: this counted the WORKING TREE, so a sibling lane\'s'
        + '\n  uncommitted edit to a tracked file is in it. Re-run with `--cached` to read the index.',
      )
    }
    console.log('  Files carrying them, most-windows-first:')
    for (const line of windowFiles({ cached }).slice(0, 10)) console.log(`    ${line}`)
    return check ? 1 : 0
  }

  if (outcome === 'fell') {
    console.log('')
    console.log(
      `  ${PINNED_CENSUS - result.occurrences} fewer than the pin — the intended direction.`
      + `\n  Lower PINNED_CENSUS to ${result.occurrences} in the SAME commit that converted them.`,
    )
    // D1.275 — the fall message alone has already failed to get a pin lowered.
    // Past the allowance the slack IS the finding: the ratchet is holding a
    // number the tree left behind, and it will tolerate that many new sites in
    // silence.
    if (slackExceeded(result.occurrences)) {
      console.log(
        `  REFUSED: the pin is ${PINNED_CENSUS - result.occurrences} above the tree, more than the`
        + ` stated allowance of ${SLACK_ALLOWANCE}.`
        + `\n  Lower PINNED_CENSUS to ${result.occurrences}. Until then this gate would accept`
        + `\n  ${PINNED_CENSUS - result.occurrences} new site(s) without saying anything.`,
      )
      return check ? 1 : 0
    }
  }

  return 0
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

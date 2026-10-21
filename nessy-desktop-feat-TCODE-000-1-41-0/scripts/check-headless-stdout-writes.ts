/**
 * check-headless-stdout-writes — a RATCHET on the stream that is a PROTOCOL.
 *
 * D1.257.
 *
 * ## The defect this exists to stop happening again
 *
 * In the headless server, stdout is not a log stream. It is a handshake:
 * `packages/server/src/index.ts` writes `NESSY_SERVER_URL=` and
 * `NESSY_SERVER_TOKEN=` there for the CLI's spawner to parse, one of them a
 * bearer token, and until D1.211 the spawner took one line and discarded the
 * rest. D1.232 (`59764e737`) moved the headless logger's `info` and `debug` off
 * that stream, and its own docblock states the posture: diagnostics are stderr,
 * output is stdout.
 *
 * What nothing stops is the NEXT one. A `console.log` written anywhere in
 * `packages/server-core` or `packages/server` lands on the handshake stream, it
 * compiles, and in `bun test` and in `electron:dev` it looks exactly like a log
 * line. That is the shape of the two defects D1.232 and D1.211 were each born
 * from, and the shape `check-dropped-log-sink.ts` was built for on the other
 * host, which is why this is its sibling rather than a new idea.
 *
 * ## THREE method names, not one — measured, not assumed
 *
 * The row names `console.log`. In Node and Bun `console.info` and
 * `console.debug` are ALIASES of it and write the same fd 1 — which is how
 * WI-n's stdout capture came to carry a DEBUG line (D1.232). A census of the one
 * spelling would therefore have reported a clean stream while three
 * `console.info` calls in `bootstrap/storage-runtime.ts` and one `console.debug`
 * in `runtime/platform.ts` were writing to it. The pattern spells all three
 * rather than matching `console\\.\\w+`: `warn` and `error` already go to
 * stderr and are not this gate's subject, and a gate that counted them would
 * cry wolf on every correct diagnostic.
 *
 * ## Why a ratchet and not a rule
 *
 * Some of the population is CORRECT. The handshake lines themselves are
 * `console.log`, and so is `--print-token`'s one line of output; a rule would
 * have to decide which writes are protocol and which are diagnostics, and no
 * scanner can read that off a call site. So this counts the population and fails
 * on a RISE. The existing calls are not findings and are not asked to move; a
 * NEW one is a decision, made once, by whoever is adding it, with this gate's
 * message as the question.
 *
 * ## What it CANNOT catch — read this before quoting it as assurance
 *
 *  - **An indirect write.** `process.stdout.write`, a logger whose sink is
 *    stdout, a library that prints — none is matched. `runtime/platform.ts`'s
 *    `CONSOLE_LOGGER` (the pre-initialisation fallback, `info: console.log`) is
 *    matched only because it spells the call itself; a scoped logger built on
 *    top of it is invisible here.
 *  - **The renderer and the Electron host.** Scope is the two server packages,
 *    because they are the ones whose stdout is a protocol. The Electron host's
 *    equivalent question is which sink a packaged build DROPS, and that is
 *    `check-dropped-log-sink.ts`.
 *  - **Tests.** Excluded by pathspec: a test printing to stdout is printing to
 *    the test runner.
 *
 * ## Before believing a rise
 *
 * `git grep` with no revision reads the WORKING TREE of tracked files, so in a
 * shared tree a rise can be a neighbour's uncommitted edit. `--cached` re-runs
 * the same census against the index; the failure message says so.
 *
 * Usage:
 *   bun scripts/check-headless-stdout-writes.ts            # report, always exit 0
 *   bun scripts/check-headless-stdout-writes.ts --check    # exit 1 if the census ROSE
 *   bun scripts/check-headless-stdout-writes.ts --cached   # count the index, not the worktree
 */

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GateSafetyRefusal } from './gate-safety'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The three console methods that write fd 1.
 *
 * Spelled out rather than `console\\.\\w+` so that `warn` and `error` — which
 * go to stderr and are the CORRECT destination for a diagnostic — are not
 * counted, and so that a fourth stdout alias appearing in a future runtime is a
 * deliberate edit here rather than something a wildcard swallowed silently.
 */
export const STDOUT_WRITE_PATTERN = 'console\\.(log|info|debug)\\('

/** The two packages whose stdout is a protocol. Tests excluded. */
export const CENSUS_PATHSPEC: readonly string[] = [
  'packages/server-core/src',
  'packages/server/src',
  ':(exclude)**/__tests__/**',
  ':(exclude)**/*.test.ts',
]

/**
 * The last reading, and the ONLY place this number is written down.
 *
 * Measured 2026-09-17 at HEAD `0775d865f`: 17 calls over 4 files — 7 in
 * `handlers/rpc/transfer.ts`, 6 in `packages/server/src/index.ts` (of which the
 * two handshake lines and `--print-token`'s output are correct protocol writes),
 * 3 in `bootstrap/storage-runtime.ts`, 1 in `runtime/platform.ts`.
 *
 * Lower it in the same commit that moves a call to the platform logger. Do not
 * raise it to make a red run green: a rise is a new write onto the handshake
 * stream, which is the thing this gate exists to make deliberate.
 */
export const PINNED_CENSUS = 15

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

/** The ratchet itself: only a RISE is a failure. */
export function verdict(occurrences: number, pinned: number = PINNED_CENSUS): Verdict {
  if (occurrences > pinned) return 'rose'
  if (occurrences < pinned) return 'fell'
  return 'unchanged'
}

export interface CensusResult {
  /** Every matched call, in `git grep` scan order. */
  calls: string[]
  /** Occurrences — the number the pin compares against. */
  occurrences: number
  /** Files carrying at least one, for the report line. */
  files: number
}

export interface CensusOptions {
  /** Count the index instead of the working tree — the neighbour-mid-edit control. */
  cached?: boolean
  /** Search a plain directory with no git index. Used only by the tests. */
  noIndex?: boolean
  /** Root to scan. Defaults to the repo. Used only by the tests. */
  root?: string
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
  const pathspec = options.noIndex === true ? ['.'] : [...CENSUS_PATHSPEC]
  const calls = grep(['-ahoI', '-E', STDOUT_WRITE_PATTERN, '--', ...pathspec], options)
    .split('\n')
    .filter(line => line !== '')
  const files = grep(['-alI', '-E', STDOUT_WRITE_PATTERN, '--', ...pathspec], options)
    .split('\n')
    .filter(line => line !== '')
  return { calls, occurrences: calls.length, files: files.length }
}

/** Which files carry them, most-calls-first — named so a rise is actionable. */
export function callingFiles(options: CensusOptions = {}): string[] {
  const pathspec = options.noIndex === true ? ['.'] : [...CENSUS_PATHSPEC]
  return grep(['-acI', '-E', STDOUT_WRITE_PATTERN, '--', ...pathspec], options)
    .split('\n')
    .filter(line => line !== '')
    .sort((a, b) => Number(b.split(':').pop()) - Number(a.split(':').pop()))
}

function main(argv: readonly string[]): number {
  const check = argv.includes('--check')
  const cached = argv.includes('--cached')

  const result = census({ cached })

  // A census that finds NOTHING while the pin expects a population is the probe
  // having broken — the packages moved, the pathspec mangled — not the class
  // having emptied. The handshake lines alone guarantee a non-zero answer.
  if (result.occurrences === 0 && PINNED_CENSUS > 0) {
    throw new GateSafetyRefusal(
      `REFUSED: the headless-stdout census found ZERO calls where it expects ${PINNED_CENSUS}. `
      + 'That is the probe failing, not the population emptying — `packages/server/src/index.ts` writes '
      + 'the NESSY_SERVER_URL= and NESSY_SERVER_TOKEN= handshake lines with console.log and always will, '
      + `so a zero means ${CENSUS_PATHSPEC.slice(0, 2).join(' or ')} was not read.`,
    )
  }

  const where = cached === true ? 'index' : 'working tree'
  console.log(
    `check-headless-stdout-writes: ${result.occurrences} console.log/info/debug call(s) across `
    + `${result.files} file(s) of the server packages in the ${where} (pin ${PINNED_CENSUS}).`,
  )

  const outcome = verdict(result.occurrences)

  if (outcome === 'rose') {
    console.log('')
    console.log(`REFUSED: ${result.occurrences - PINNED_CENSUS} new write(s) onto the headless server's stdout.`)
    console.log(
      '  In that host stdout is a PROTOCOL, not a log stream: `packages/server/src/index.ts` writes'
      + '\n  NESSY_SERVER_URL= and NESSY_SERVER_TOKEN= there for the CLI spawner to parse, one of them a'
      + '\n  bearer token. A diagnostic on that stream is interleaved with the handshake.',
    )
    console.log(
      '  `console.info` and `console.debug` are ALIASES of `console.log` in Node and Bun and write the'
      + '\n  same fd — which is how a DEBUG line reached a stdout capture in D1.232.',
    )
    console.log(
      '  If the line is a diagnostic, route it through the platform logger'
      + '\n  (`deps.platform.logger.info(...)`): `createConsoleLogger` in'
      + '\n  `packages/server-core/src/runtime/platform-headless.ts` writes every level to stderr,'
      + '\n  timestamped and level-padded.',
    )
    console.log(
      '  If the line really is protocol OUTPUT — a new handshake field, a --print-* command — raise'
      + '\n  PINNED_CENSUS in `scripts/check-headless-stdout-writes.ts` and say so in the commit.',
    )
    if (cached !== true) {
      console.log(
        '  And before believing the rise at all: this counted the WORKING TREE, so a sibling lane\'s'
        + '\n  uncommitted edit to a tracked file is in it. Re-run with `--cached` to read the index.',
      )
    }
    console.log('  Files carrying them, most-calls-first:')
    for (const line of callingFiles({ cached }).slice(0, 10)) console.log(`    ${line}`)
    return check ? 1 : 0
  }

  if (outcome === 'fell') {
    console.log('')
    console.log(
      `  ${PINNED_CENSUS - result.occurrences} fewer than the pin — the intended direction.`
      + `\n  Lower PINNED_CENSUS to ${result.occurrences} in the SAME commit that moved them.`,
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

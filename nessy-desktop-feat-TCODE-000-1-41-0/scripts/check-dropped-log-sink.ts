/**
 * check-dropped-log-sink — a RATCHET on the one sink a packaged build throws away.
 *
 * DA1.65.
 *
 * ## The defect this exists to stop happening a third time
 *
 * `apps/electron/src/main/logger.ts` sets BOTH `log.transports.file.level` and
 * `log.transports.console.level` to `false` whenever `isDebugMode` is false — and
 * a packaged build always is, because `--debug` is eaten by Node before the app
 * sees it. So every `platform.logger` call in the Electron host writes NOTHING in
 * the builds those lines exist for. The silence is the app's DELIBERATE posture
 * (the dedicated auto-update log exists because of it) and it stays; what this
 * gate is about is which sink the NEXT diagnostic picks.
 *
 * It has now been the same mistake twice, in two different rows: DA2.6 and DA1.58
 * each added a line an operator was meant to be able to read, to a sink that
 * drops it. Neither had anything to notice — the call compiles, the method
 * exists, and in `bun test` and in `electron:dev` the line APPEARS, because
 * `isDebugMode` is true in both. Only a packaged build is silent, and by then
 * nobody is looking for a line that was never there.
 *
 * The sink that is not dropped is `createLogger` (`@nessy-agent/shared/utils`):
 * gated by `NESSY_DEBUG=1`, writing to stderr, and mirrored into electron-log in
 * the main process — so a dev build still keeps it in `main.log`. The neighbours
 * an operator DOES see in a packaged run (`[ws-rpc-server]`, `[dp-auth]`,
 * `[ConfigWatcher]`) are all on it.
 *
 * ## Why a ratchet and not a rule
 *
 * A rule would have to decide which lines are "credential-lifecycle or
 * user-facing", and no scanner can read that off a call site: the two that
 * mattered were `Saved …` and a discard sentence, both spelled like the 74
 * around them. A gate that guesses would cry wolf on legitimate debug chatter,
 * and AGENTS.md is explicit that a gate people stop running is worse than none.
 *
 * So this counts the POPULATION and fails on a RISE. The existing calls are not
 * findings and are not asked to move; a NEW one is a decision, made once, by
 * whoever is adding it — with this gate's message as the question. Lowering the
 * pin when a call moves to `createLogger` is the intended direction, and the
 * gate prints the new number for that commit to write.
 *
 * ## What it counts, and why that scope
 *
 * `apps/electron/src/main` + `packages/server-core/src`, tests excluded. Both
 * halves are needed and neither is arbitrary: `main/**` is the host itself, and
 * the RPC handlers under `server-core` run INSIDE that host with
 * `deps.platform.logger` bound to the same dropped electron-log — which is
 * exactly where DA1.58's two credential lines were. The headless server is
 * unaffected (`platform-headless.ts` supplies a console logger that always
 * writes), so this gate is about one deployment of shared code, not about the
 * code being wrong.
 *
 * The instrument is `git grep -a` over occurrences, not lines: a line can carry
 * two calls, and a line count would under-report the day one does. `-a` and never
 * `-I` — AGENTS.md records that the two are opposites and the last one wins.
 *
 * ## The SCOPED ALIAS, and why the ratchet now follows it (F1.177)
 *
 * It was the same mistake a THIRD time, and this gate watched it happen.
 * DA2.15's model-target disclosure was routed to `sessionLog.warn` —
 * `createScopedLogger(platform.logger, 'session')`, the same dropped transport
 * one name along — and the pattern above scores a local alias as ZERO. So the
 * census read 76 of a real population of 649: the direct spelling is 12 % of the
 * dropped sinks in this scope and the aliases are the other 88 %.
 *
 * The alias arm was ADDED rather than declined, and the reason is that declining
 * would have been the gate lying about its own coverage. The three arguments
 * that were weighed:
 *
 *  - *It would cry wolf on ordinary chatter.* It would — and so does the direct
 *    census, over the same kind of population, deliberately (see "Why a ratchet
 *    and not a rule"). An alias call is not a different KIND of line; it is the
 *    same line spelled through a binding, and the gate has no business treating
 *    a spelling as a decision.
 *  - *It re-pins a large number.* It does not: the alias census has its own pin,
 *    so `PINNED_CENSUS` keeps meaning exactly what it meant and the two rises
 *    are reported separately — they have different remedies. A direct call moves
 *    to `createLogger` on its own; an alias call can move on its own OR the whole
 *    BINDING can move, which would move hundreds at once and is a much larger
 *    decision than this gate should quietly absorb.
 *  - *A name list ages.* Which is why there is none. The alias NAMES are derived
 *    from the tree every run, by finding the bindings whose base is
 *    `platform.logger`; a new scoped alias is picked up with no edit here, and a
 *    rename of `createScopedLogger` empties the list, which is a REFUSAL below
 *    and not a triumphant zero.
 *
 * ## What the alias arm still CANNOT see — the residue, stated
 *
 * A logger PASSED somewhere. `new PrivilegedExecutionBroker(sessionLog)` hands
 * the dropped sink to an object that then calls it through a field of its own,
 * and no grep over call sites can follow that hop. Such a line is dropped in a
 * packaged build and is invisible to both censuses. There is no cheap instrument
 * for it; it is recorded here so the next reader does not mistake a green run
 * for a proof that every dropped line is counted.
 *
 * ## Before believing a rise
 *
 * `git grep` with no revision reads the WORKING TREE of tracked files, so in a
 * shared tree a rise can be a neighbour's uncommitted edit. `--cached` re-runs the
 * same census against the index; the failure message says so.
 *
 * Usage:
 *   bun scripts/check-dropped-log-sink.ts            # report, always exit 0
 *   bun scripts/check-dropped-log-sink.ts --check    # exit 1 if the census ROSE
 *   bun scripts/check-dropped-log-sink.ts --cached   # count the index, not the worktree
 */

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GateSafetyRefusal } from './gate-safety'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every level `PlatformServices['logger']` offers. Spelled out rather than
 * `\w+` so a rename of the interface makes this gate go VACUOUS-and-loud
 * (the refusal below) instead of quietly matching nothing.
 */
export const DROPPED_SINK_PATTERN = 'platform\\.logger\\.(debug|info|warn|error)\\('

/** The host, and the shared handlers that run inside it. Tests excluded. */
export const CENSUS_PATHSPEC: readonly string[] = [
  'apps/electron/src/main',
  'packages/server-core/src',
  ':(exclude)**/__tests__/**',
  ':(exclude)**/*.test.ts',
]

/**
 * The last reading, and the ONLY place this number is written down — for the
 * reason the sibling ratchet gives: a count quoted in prose is stale within a
 * day of being written.
 *
 * Lower it in the same commit that moves a call to `createLogger`. Do not raise
 * it to make a red run green: a rise is a new diagnostic in a sink a packaged
 * build drops, which is the whole thing this gate exists to make deliberate.
 */
export const PINNED_CENSUS = 76

/**
 * The binding whose base is the dropped sink. Matching the BASE rather than the
 * name is the whole point: `createScopedLogger(CONSOLE_LOGGER, …)` — the
 * module-load fallback every one of these aliases is initialised with — is NOT
 * dropped, and a name list would have had to keep the two apart by hand.
 */
export const SCOPED_ALIAS_BINDING_PATTERN = '[A-Za-z_$][A-Za-z0-9_$]* = createScopedLogger\\(platform\\.logger'

/**
 * The alias population's own pin, separate from `PINNED_CENSUS` because the two
 * rises have different remedies (see the docblock). Lower it in the same commit
 * that moves an alias call to `createLogger`; raising it is a decision to add a
 * diagnostic a packaged build throws away, and belongs in the commit message.
 */
export const PINNED_ALIAS_CENSUS = 622

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
  const argv = ['grep', ...(options.noIndex ? ['--no-index'] : options.cached ? ['--cached'] : []), ...args]
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
  const pathspec = options.noIndex ? ['.'] : [...CENSUS_PATHSPEC]
  const occurrences = grep(['-ahoI', '-E', DROPPED_SINK_PATTERN, '--', ...pathspec], options)
    .split('\n')
    .filter(line => line !== '')
  const files = grep(['-alI', '-E', DROPPED_SINK_PATTERN, '--', ...pathspec], options)
    .split('\n')
    .filter(line => line !== '')
  return { calls: occurrences, occurrences: occurrences.length, files: files.length }
}

export interface AliasCensusResult extends CensusResult {
  /** The alias names discovered in the tree, deduped and sorted. */
  names: string[]
}

/**
 * The scoped-alias half. Two greps: the bindings give the NAMES, the names give
 * the calls. A tree with no such binding yields no names and therefore no
 * pattern — and an empty alternation would match every `.warn(` in the scope, so
 * the zero is returned rather than searched for.
 */
export function aliasCensus(options: CensusOptions = {}): AliasCensusResult {
  const pathspec = options.noIndex ? ['.'] : [...CENSUS_PATHSPEC]
  const names = [...new Set(
    grep(['-ahoI', '-E', SCOPED_ALIAS_BINDING_PATTERN, '--', ...pathspec], options)
      .split('\n')
      .filter(line => line !== '')
      .map(line => line.slice(0, line.indexOf(' '))),
  )].sort()
  if (names.length === 0) return { calls: [], occurrences: 0, files: 0, names }

  const pattern = `(${names.join('|')})\\.(debug|info|warn|error)\\(`
  const occurrences = grep(['-ahoI', '-E', pattern, '--', ...pathspec], options)
    .split('\n')
    .filter(line => line !== '')
  const files = grep(['-alI', '-E', pattern, '--', ...pathspec], options)
    .split('\n')
    .filter(line => line !== '')
  return { calls: occurrences, occurrences: occurrences.length, files: files.length, names }
}

function main(argv: readonly string[]): number {
  const check = argv.includes('--check')
  const cached = argv.includes('--cached')

  const result = census({ cached })
  const aliases = aliasCensus({ cached })

  // A census that finds NOTHING is the instrument having broken — the interface
  // renamed, the directories moved — not the population having emptied. Refuse
  // rather than report a triumphant zero, which is the shape of a gate that has
  // silently stopped gating.
  if (result.occurrences === 0 && PINNED_CENSUS > 0) {
    throw new GateSafetyRefusal(
      'REFUSED: the dropped-sink census found ZERO calls where it expects '
      + `${PINNED_CENSUS}. That is the probe failing, not the population emptying — `
      + 'check that `PlatformServices` still spells its logger `platform.logger` and '
      + `that ${CENSUS_PATHSPEC.slice(0, 2).join(' and ')} still exist.`,
    )
  }

  // The same refusal for the alias half, and it is the one most likely to fire:
  // the names are DERIVED, so a rename of `createScopedLogger` or a change to how
  // the base is spelled empties the list and the census would otherwise report a
  // clean zero over a population of hundreds.
  if (aliases.names.length === 0 && PINNED_ALIAS_CENSUS > 0) {
    throw new GateSafetyRefusal(
      'REFUSED: the scoped-alias census found NO binding of a scoped logger to '
      + `platform.logger where it expects ${PINNED_ALIAS_CENSUS} call(s) through one. `
      + 'That is the probe failing — check that the binding is still spelled '
      + '`<name> = createScopedLogger(platform.logger, …)`.',
    )
  }

  console.log(
    `check-dropped-log-sink: ${result.occurrences} platform.logger call(s) across `
    + `${result.files} file(s) in the Electron host's reach (pin ${PINNED_CENSUS}).`,
  )
  console.log(
    `  plus ${aliases.occurrences} call(s) across ${aliases.files} file(s) through the `
    + `scoped alias(es) ${aliases.names.join(', ')} (pin ${PINNED_ALIAS_CENSUS}).`,
  )

  if (aliases.occurrences > PINNED_ALIAS_CENSUS) {
    console.log('')
    console.log(
      `REFUSED: ${aliases.occurrences - PINNED_ALIAS_CENSUS} new call(s) through a scoped alias `
      + `of platform.logger (${aliases.names.join(', ')}).`,
    )
    console.log(
      '  Same dropped transport as above, one name along — which is how DA2.15\'s',
      '\n  model-target disclosure was written nowhere for a month (F1.177). If the line',
      '\n  is a credential-lifecycle or user-facing diagnostic, route it through',
      '\n  `createLogger(\'<scope>\')`. If it is ordinary debug chatter, raise',
      '\n  PINNED_ALIAS_CENSUS and say so in the commit — and note that moving the',
      '\n  BINDING instead would move every call through it at once, which is a much',
      '\n  larger decision than this number.',
    )
    console.log(
      '  And before believing the rise: `git grep` reads the WORKING TREE, so a',
      '\n  neighbour lane\'s uncommitted edit counts. Re-run with `--cached`.',
    )
    if (check) return 1
  } else if (aliases.occurrences < PINNED_ALIAS_CENSUS) {
    console.log(
      `  ${PINNED_ALIAS_CENSUS - aliases.occurrences} fewer than the alias pin — the intended`,
      `\n  direction. Lower PINNED_ALIAS_CENSUS to ${aliases.occurrences} in the SAME commit.`,
    )
  }

  if (result.occurrences > PINNED_CENSUS) {
    console.log('')
    console.log(
      `REFUSED: ${result.occurrences - PINNED_CENSUS} new platform.logger call(s).`,
    )
    console.log(
      '  In a PACKAGED Electron build that sink writes nothing: `main/logger.ts` sets',
      '\n  every electron-log transport to `level = false` outside debug mode, and a',
      '\n  packaged build is always outside it. The line will appear in `bun test` and',
      '\n  in `electron:dev` and be absent in the build it was written for.',
    )
    console.log(
      '  If it is a credential-lifecycle or user-facing diagnostic, route it through',
      '\n  `createLogger(\'<scope>\')` (@nessy-agent/shared/utils): stderr under',
      '\n  NESSY_DEBUG=1, mirrored into electron-log in the main process. DA2.6 and',
      '\n  DA1.58 were each this mistake, found only after shipping.',
    )
    console.log(
      '  If it is ordinary debug chatter and the silence is fine, raise PINNED_CENSUS',
      '\n  in `scripts/check-dropped-log-sink.ts` and say so in the commit.',
    )
    console.log(
      '  And before believing the rise at all: `git grep` reads the WORKING TREE, so a',
      '\n  neighbour lane\'s uncommitted edit counts. Re-run with `--cached` to read the',
      '\n  index instead.',
    )
    return check ? 1 : 0
  }

  if (result.occurrences < PINNED_CENSUS) {
    console.log('')
    console.log(
      `  ${PINNED_CENSUS - result.occurrences} fewer than the pin — the intended direction.`,
      `\n  Lower PINNED_CENSUS to ${result.occurrences} in the SAME commit.`,
    )
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

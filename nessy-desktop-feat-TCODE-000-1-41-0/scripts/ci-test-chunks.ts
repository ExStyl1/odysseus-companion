/**
 * ci-test-chunks — run the repository's test suite as one bun process PER
 * DIRECTORY, and refuse to report success unless every tracked test file ran
 * in exactly one of them.
 *
 * D1.437 / D1.440. CI's `test` job ran the whole repository in ONE `bun test`
 * process. Five consecutive runs on bun 1.3.9 died with
 * `panic(main thread): Segmentation fault at address 0x0` after ~530-570 s at
 * ~1 300 of ~2 270 files (Peak RSS 2.3 GB), printing no `Ran N tests` line at
 * all — so the job failed without naming a single test, and roughly 970 files
 * were never reached by any of the five. The lift to bun 1.3.14 stopped the
 * crash (pipeline 126374378: `Ran 28813 tests across 2274 files`, 66 fail), and
 * that reading is exactly why the split still belongs here:
 *
 *   1. **A crash localises.** The next one takes out one directory's process.
 *      The other ~156 still run and still report, and the job log names the
 *      chunk that died on the banner line printed before it started.
 *   2. **The batch composition is smaller.** AGENTS.md records two failure
 *      modes that are properties of the BATCH and not of any file in it — a
 *      `mock.module` without a spread-and-restore amputates a module for some
 *      other file in the same process (and `bun test` IGNORES the order of the
 *      paths it is given, so "run the amputator last" is not available), and a
 *      module-scope env mutation leaks to every later file. 66 of the CI run's
 *      failures were exactly this: 58 of them pass when the file is run alone.
 *   3. **The coverage guard makes "it ran" checkable.** A single process
 *      reports one `Ran N tests across M files` line that nobody compares to
 *      anything. Here the summed file count is compared to `git ls-files`, and
 *      a mismatch is a named failure rather than a smaller number that reads
 *      like an answer (AGENTS.md: a path that does not exist runs the rest and
 *      says nothing; a bare path is a FILTER, not a path).
 *
 * ## The chunk is the DIRECTORY, and the file list is explicit
 *
 * A chunk is every test file in one directory — no depth constant, no list to
 * maintain, and a new directory is a new chunk the day it appears. Two
 * deliberate choices, both of which the obvious alternative gets wrong:
 *
 *   * **The child is handed explicit `./`-prefixed FILE paths, never the
 *     directory.** Handing `bun test ./packages/shared/src` a directory would
 *     sweep every nested directory with it, so `packages/shared/src/agent`
 *     would run twice and `Ran N across M` would double-count while looking
 *     right. Explicit files make the partition decidable before anything runs.
 *     Every argument carries `./` because with no `./`-prefixed argument every
 *     argument is a FILTER — and one matching filter beside a non-matching one
 *     is silently green over a smaller set (AGENTS.md, measured twice).
 *   * **The denominator is git's, not the filesystem's.** `git ls-files` plus
 *     `git ls-files --others --exclude-standard`, so a lane's brand-new,
 *     not-yet-committed test file is IN scope while the runner's own caches are
 *     not: `.gitlab-ci.yml`'s `.bun-cache` anchor keeps `.cache/bun/` inside
 *     the checkout, and a gate that walks the filesystem there sees hundreds of
 *     vendored test files that exist on no developer machine (measured
 *     2026-09-19, WI-bs: 2 662 files on the runner against 2 318 locally).
 *
 * `*.isolated.ts` files are outside this runner by construction: they carry
 * neither `.test.` nor `.spec.` in the name, so bun does not treat them as test
 * files and neither does the pattern here. They are the ELEVEN-file
 * `bun run test:isolated` list (P3.354), which the job still runs afterwards,
 * one process per file — that is where a suite goes when it cannot share a
 * process even with its own directory.
 *
 * ## What it refuses to call a pass
 *
 * Counted per chunk from bun's own JUnit reporter, not from a grep of its
 * console output:
 *
 *   - a chunk whose exit status is non-zero, or which was KILLED by a signal
 *     (a killed run proved nothing; 134 is Bun's OOM abort — P2.353);
 *   - a chunk that wrote no JUnit report at all (the shape a crash takes);
 *   - a chunk that ran a different SET of files than it was planned — a file
 *     that did not run, or one that ran in a chunk that did not plan it;
 *   - a file in no chunk, or in two chunks;
 *   - a summed file count that is not the tracked count.
 *
 * Every chunk runs even after one goes red, and the red chunks are named last,
 * because a runner that stops at its first red is a gate that stops gating
 * (`run-gates.ts`, P2.222).
 *
 * The one thing read from the console rather than the report is an IMPORT
 * DEATH (F1.135): the child's output is teed, and a `SyntaxError: Export named
 * 'X' not found in module 'M'` is printed under that chunk's result line with
 * the chunk's own files that stub `M` — see {@link ImportDeath}. It changes no
 * verdict; the chunk was already red.
 *
 * ## A green chunk prints ONE line; a red chunk prints everything (F1.59)
 *
 * The child's output is buffered, not streamed. A GREEN chunk — PASS, a JUnit
 * report, every planned file ran, no import death — prints only its result
 * line; a RED chunk prints its whole output above that line. MR !49's `test`
 * job at `ce468be1d` crossed GitLab's 8 MiB trace cap (8.49 M characters, read
 * by the MR reader on 2026-09-25) inside chunk 155 of 160, so chunks 155-160
 * and this runner's own summary — the only place the fail total and the
 * red-chunk list live — never reached the log. Most of what it carried was
 * the streamed output of every chunk, green ones included.
 *
 * The red half is bounded too, because one red chunk can carry megabytes (a
 * source-text assertion's `Received:` dump, timestamped product logging), and
 * the failure this fixes is precisely "many reds at once". {@link
 * chunkOutputToPrint} prints a red chunk in full while the job-wide
 * {@link RED_OUTPUT_BUDGET_CHARS} (less a reserve) covers it, then only the
 * head and the tail of each further red chunk with a line counting what was
 * left out, and once the whole budget is spent only that line. The red output
 * printed is therefore at most the budget plus one short line per chunk, so
 * the summary block always reaches the log. A run stopped by SIGTERM/SIGINT
 * prints the in-flight chunk's buffer unfiltered before exiting, so a chunk
 * killed from outside still shows what it said; a SIGKILL cannot be caught and
 * loses that one chunk's output (its banner line still names it).
 *
 * Usage:
 *   bun scripts/ci-test-chunks.ts            # run every chunk
 *   bun scripts/ci-test-chunks.ts --list     # print the plan, run nothing
 *   bun scripts/ci-test-chunks.ts --root <repo-relative dir>
 *
 * `--root` exists for `ci-test-chunks.test.ts`, which drives this script over a
 * throwaway git repository. It is repo-relative on purpose: `gate-safety.ts`
 * refuses an absolute path anywhere near a child process's argv.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseJUnit } from './bun-test-split.ts'
import {
  GateSafetyRefusal,
  assertInsideRepo,
  assertNoHomeOrRootPath,
  createGateScratchDir,
} from './gate-safety.ts'
import { type Verdict, classifyRun, killedExplanation } from './gate-verdict.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * What bun treats as a test file. Deliberately the same shape as bun's own
 * default, so this runner and a bare `bun test` disagree about nothing:
 * `.test.`/`.spec.` in the basename, `.ts`/`.tsx`.
 */
const TEST_FILE_PATTERN = /(?:^|\/)[^/]*\.(?:test|spec)\.tsx?$/

/**
 * Directories `bun test` never reaches from the repo root and git may still
 * list. `.references/` is vendored upstream source we do not run (AGENTS.md
 * forbids modifying it), `release/` is packaging output whose presence is
 * itself a known source of phantom failures, and `node_modules/` is here for
 * the untracked half of the enumeration.
 */
const EXCLUDED_PREFIXES: readonly string[] = ['node_modules/', '.references/', 'release/']

export interface ChunkPlan {
  /** The directory every file in this chunk lives in. */
  readonly root: string
  /** Repo-relative, POSIX separators, sorted. */
  readonly files: readonly string[]
}

export interface ChunkOutcome {
  readonly root: string
  readonly verdict: Verdict
  /** The files bun's JUnit report says it ran. Empty when no report was written. */
  readonly ranFiles: readonly string[]
  readonly reportWritten: boolean
  readonly pass: number
  readonly skip: number
  readonly todo: number
  readonly fail: number
  /** Wall time for this chunk's child, in milliseconds. */
  readonly durationMs: number
  /** Files that died at IMPORT, read off the child's own output (F1.135). */
  readonly importDeaths?: readonly ImportDeath[]
}

/**
 * One `SyntaxError: Export named 'X' not found in module 'M'.` line.
 *
 * F1.135 (D1.442-C). Three chunks of the first chunked CI run (job 126377033)
 * went RED with ZERO failing tests: a file died while LINKING, so its tests
 * never ran, and the chunk's result line read like any other red. In every
 * measured instance the export was present at HEAD and a hand-listed
 * `mock.module` elsewhere in the same process had removed it — the amputator
 * AGENTS.md's spread-and-restore rule is about — and nothing in the victim
 * could say where to look. So the runner reads the line bun already prints and
 * names the chunk's own files that stub `M`.
 *
 * Only this shape. The run's fourth import-time line, `Missing 'default'
 * export in module '…pdf.worker.min.mjs?url'`, was measured NOT to be an
 * amputation (a static import hoisted above the file's own stub), so naming a
 * stub for it would send the reader to the wrong file.
 */
export interface ImportDeath {
  readonly exportName: string
  /** The module path exactly as bun printed it — absolute on the machine that ran it. */
  readonly module: string
  /** How many times the child printed it (one per victim file, plus reprints). */
  readonly count: number
}

const IMPORT_DEATH_PATTERN = /Export named '([^']+)' not found in module '([^']+)'/

/**
 * Characters of RED chunks' output the whole job may print (F1.59) — a hard
 * cap: {@link chunkOutputToPrint} never spends more than is left. GitLab's
 * trace cap is 8 MiB; this leaves ~2 MiB for the job's own lines, every
 * chunk's banner, result and shortening line, `test:isolated` after it, and
 * the summary block. Characters, not bytes: this output is ASCII in practice,
 * and the margin covers the rest.
 */
export const RED_OUTPUT_BUDGET_CHARS = 6 * 1024 * 1024

/**
 * The part of the budget a FULL print may not use, so the head and the tail
 * of the red chunks after a large one still fit: 1 MiB is sixteen more
 * shortened chunks at {@link RED_OUTPUT_EDGE_CHARS} from each end.
 */
export const RED_OUTPUT_EDGE_RESERVE_CHARS = 1024 * 1024

/** Characters kept from EACH end of a red chunk's output once it is shortened. */
export const RED_OUTPUT_EDGE_CHARS = 32 * 1024

/**
 * What the job log gets of one chunk's buffered output (F1.59): nothing for a
 * green chunk; all of a red chunk while `budgetLeft`, less the edge reserve,
 * covers it; otherwise its head and tail (at most {@link RED_OUTPUT_EDGE_CHARS}
 * each, and never more than `budgetLeft` together) around a line counting what
 * was left out — only that line once the budget is spent. `spent` is what this
 * chunk takes out of the budget, and it never exceeds `budgetLeft`.
 */
export function chunkOutputToPrint(
  output: string,
  red: boolean,
  budgetLeft: number,
): { text: string; spent: number } {
  if (!red || output.length === 0) return { text: '', spent: 0 }
  if (output.length <= budgetLeft - RED_OUTPUT_EDGE_RESERVE_CHARS) return { text: output, spent: output.length }
  const edge = Math.min(RED_OUTPUT_EDGE_CHARS, Math.floor(Math.max(0, budgetLeft) / 2))
  if (output.length <= 2 * edge) return { text: output, spent: output.length }
  // `slice(-0)` is the WHOLE string, so a spent budget takes no tail explicitly.
  const head = output.slice(0, edge)
  const tail = edge === 0 ? '' : output.slice(-edge)
  const kept = edge === 0 ? 'none of it is printed' : `${edge} from each end are printed, above and below`
  const note =
    `\n    OUTPUT SHORTENED  ${output.length - 2 * edge} of ${output.length} character(s) of this red chunk ` +
    `not printed (${kept}): the job's red-output budget of ${RED_OUTPUT_BUDGET_CHARS} characters keeps the ` +
    'log under GitLab\'s 8 MiB trace cap so the summary reaches it. Run this chunk locally for the rest.\n'
  return { text: `${head}${note}${tail}`, spent: 2 * edge }
}

/** Every distinct import death in a child's output, in first-seen order. */
export function findImportDeaths(output: string): ImportDeath[] {
  const seen = new Map<string, { exportName: string; module: string; count: number }>()
  for (const line of output.split('\n')) {
    const match = IMPORT_DEATH_PATTERN.exec(line)
    if (match === null) continue
    const exportName = match[1] ?? ''
    const module = match[2] ?? ''
    const key = `${exportName}\0${module}`
    const entry = seen.get(key)
    if (entry === undefined) seen.set(key, { exportName, module, count: 1 })
    else entry.count += 1
  }
  return [...seen.values()]
}

const MOCK_MODULE_SPECIFIER = /mock\.module\(\s*(['"`])([^'"`$]+)\1/g

/**
 * The chunk's files whose `mock.module(<literal>, …)` RESOLVES to the module
 * bun named — resolved from each file's own directory with bun's resolver, so
 * a tsconfig alias (`@/config/…`) and a workspace specifier
 * (`@nessy-agent/server-core/services`) both land on the path bun printed.
 *
 * The printed path is absolute on the machine that ran the child (`/builds/…`
 * on the runner), so a resolved path matches when it is the same path or when
 * the printed one ENDS with the resolved path's repo-relative form — which is
 * also what lets a job log be replayed against a checkout.
 *
 * These are CANDIDATES, never a verdict: a stub with a spread and a restore
 * names the module too. A non-literal first argument (a computed path) is not
 * read, and a specifier that does not resolve is skipped.
 */
export function stubsNamingModule(
  modulePath: string,
  chunkFiles: readonly string[],
  runRoot: string,
): string[] {
  const printed = toPosix(modulePath).replace(/\?.*$/, '')
  const names: string[] = []
  for (const file of chunkFiles) {
    const absolute = join(runRoot, file)
    let source: string
    try {
      source = readFileSync(absolute, 'utf-8')
    } catch {
      continue
    }
    for (const match of source.matchAll(MOCK_MODULE_SPECIFIER)) {
      const specifier = match[2] ?? ''
      let resolved: string
      try {
        resolved = toPosix(Bun.resolveSync(specifier, dirname(absolute)))
      } catch {
        continue
      }
      const repoRelative = toPosix(relative(runRoot, resolved))
      const same = printed === resolved || (!repoRelative.startsWith('../') && printed.endsWith(`/${repoRelative}`))
      if (same) {
        names.push(file)
        break
      }
    }
  }
  return names
}

/** The lines printed under a chunk's result line for its import deaths. */
export function describeImportDeaths(
  deaths: readonly ImportDeath[],
  chunkFiles: readonly string[],
  runRoot: string,
): string[] {
  const lines: string[] = []
  for (const death of deaths) {
    const shown = death.module.startsWith(`${runRoot}/`) ? relative(runRoot, death.module) : death.module
    lines.push(
      `    IMPORT DEATH  export '${death.exportName}' not found in ${shown} (printed ${death.count}x) — ` +
      'a file died while linking, so its tests never ran; this is not a test red.',
    )
    const stubs = stubsNamingModule(death.module, chunkFiles, runRoot)
    if (stubs.length > 0) {
      lines.push(
        `      stubbed in this chunk by: ${stubs.join(', ')} — a mock.module without spread-and-restore ` +
        'removes exports for the other files in the process (AGENTS.md); read these first.',
      )
    }
  }
  return lines
}

/**
 * The output of the chunk currently running, in arrival order, so a SIGTERM or
 * SIGINT can print it before the runner exits (F1.59). `null` between chunks.
 */
let inFlightOutput: string[] | null = null

/**
 * Collect a child's stream into `sink` as it arrives — stdout and stderr land
 * in the same array, in arrival order — and hand every complete line to
 * `onLine`. Nothing is printed here: {@link chunkOutputToPrint} decides.
 */
async function tee(
  stream: ReadableStream<Uint8Array>,
  sink: string[],
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  let pending = ''
  for await (const bytes of stream) {
    const text = decoder.decode(bytes, { stream: true })
    sink.push(text)
    pending += text
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  }
  const rest = decoder.decode()
  if (rest.length > 0) sink.push(rest)
  pending += rest
  if (pending.length > 0) onLine(pending)
}

/** `a\b` on Windows is nobody's path here, but the normalisation is free. */
function toPosix(path: string): string {
  return path.split('\\').join('/')
}

export function isTestFile(path: string): boolean {
  if (!TEST_FILE_PATTERN.test(path)) return false
  return !EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))
}

/**
 * The test files git knows about, committed or not, with ignored paths left
 * out. Both halves matter and they fail in opposite directions — see the
 * header.
 */
export function enumerateTestFiles(cwd: string): string[] {
  const listed = new Set<string>()

  for (const args of [['ls-files', '-z'], ['ls-files', '--others', '--exclude-standard', '-z']]) {
    const run = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    if (run.exitCode !== 0) {
      throw new Error(
        `ci-test-chunks: \`git ${args.join(' ')}\` failed in ${cwd} (exit ${run.exitCode}).\n` +
        `  ${new TextDecoder().decode(run.stderr).trim()}\n` +
        '  The denominator for the coverage guard comes from git, so a runner that\n' +
        '  cannot ask git has no denominator and must not report a pass.',
      )
    }
    for (const entry of new TextDecoder().decode(run.stdout).split('\0')) {
      if (entry.length === 0) continue
      const path = toPosix(entry)
      if (isTestFile(path)) listed.add(path)
    }
  }

  return [...listed].sort()
}

/** One chunk per directory. The only rule, and it needs no maintenance. */
export function planChunks(files: readonly string[]): ChunkPlan[] {
  const byDirectory = new Map<string, string[]>()
  for (const file of [...files].sort()) {
    const root = toPosix(dirname(file))
    const bucket = byDirectory.get(root)
    if (bucket === undefined) byDirectory.set(root, [file])
    else bucket.push(file)
  }
  return [...byDirectory.keys()]
    .sort()
    .map((root) => ({ root, files: byDirectory.get(root) ?? [] }))
}

/**
 * Every way the run can be incomplete while every chunk still exits 0, as a
 * list of sentences. Empty means the plan covered the tree and the children
 * ran exactly what they were handed.
 *
 * Pure on purpose: the four shapes it names are the ones that cannot be
 * produced on demand from a fixture tree (a file in no chunk is a bug in
 * `planChunks`, not a state a fixture can be built in), so this is where its
 * test drives them.
 */
export function verifyCoverage(
  plans: readonly ChunkPlan[],
  outcomes: readonly ChunkOutcome[],
  allFiles: readonly string[],
): string[] {
  const problems: string[] = []

  const plannedIn = new Map<string, string[]>()
  for (const plan of plans) {
    for (const file of plan.files) {
      const roots = plannedIn.get(file)
      if (roots === undefined) plannedIn.set(file, [plan.root])
      else roots.push(plan.root)
    }
  }

  for (const file of allFiles) {
    const roots = plannedIn.get(file)
    if (roots === undefined) {
      problems.push(`${file} is in NO chunk — it would never run, and nothing else would say so.`)
    } else if (roots.length > 1) {
      problems.push(`${file} is in ${roots.length} chunks (${roots.join(', ')}) — it would be counted twice.`)
    }
  }

  const known = new Set(allFiles)
  for (const [file, roots] of plannedIn) {
    if (!known.has(file)) {
      problems.push(`${file} is planned in ${roots.join(', ')} but is not a tracked test file.`)
    }
  }

  const outcomeByRoot = new Map(outcomes.map((outcome) => [outcome.root, outcome]))
  let ranTotal = 0

  for (const plan of plans) {
    const outcome = outcomeByRoot.get(plan.root)
    if (outcome === undefined) {
      problems.push(`chunk ${plan.root} (${plan.files.length} file(s)) produced no outcome at all.`)
      continue
    }

    ranTotal += outcome.ranFiles.length

    if (plan.files.length > 0 && outcome.ranFiles.length === 0) {
      problems.push(
        `chunk ${plan.root} ran ZERO of its ${plan.files.length} file(s) — ` +
        'a green run over nothing is not a gate.',
      )
      continue
    }

    const ran = new Set(outcome.ranFiles)
    const missing = plan.files.filter((file) => !ran.has(file))
    if (missing.length > 0) {
      problems.push(
        `chunk ${plan.root} did not run ${missing.length} of its ${plan.files.length} file(s): ` +
        `${missing.join(', ')}.`,
      )
    }

    const planned = new Set(plan.files)
    const unexpected = outcome.ranFiles.filter((file) => !planned.has(file))
    if (unexpected.length > 0) {
      problems.push(
        `chunk ${plan.root} ran ${unexpected.length} file(s) it was not handed: ${unexpected.join(', ')}.`,
      )
    }
  }

  if (ranTotal !== allFiles.length) {
    problems.push(
      `the chunks ran ${ranTotal} file(s) where git lists ${allFiles.length}. ` +
      'The summed file count IS the coverage check; a number that is merely plausible is not an answer.',
    )
  }

  return problems
}

/**
 * Bun writes the JUnit `file` attribute relative to its own cwd; older writers
 * have used an absolute path. Both are normalised back to repo-relative here
 * so the coverage comparison is between two things of the same kind.
 */
export function normalizeReportedFile(reported: string, runRoot: string): string {
  const posix = toPosix(reported)
  const withoutDot = posix.startsWith('./') ? posix.slice(2) : posix
  if (!withoutDot.startsWith('/')) return withoutDot
  return toPosix(relative(runRoot, withoutDot))
}

async function runChunk(
  plan: ChunkPlan,
  index: number,
  total: number,
  runRoot: string,
  scratchFromRoot: string,
  budget: { left: number },
): Promise<ChunkOutcome> {
  const reportArg = `${scratchFromRoot}/chunk-${index}.xml`
  assertNoHomeOrRootPath('the JUnit report path', reportArg)

  const args = plan.files.map((file) => `./${file}`)
  for (const arg of args) assertNoHomeOrRootPath('a `bun test` path', arg)

  // Printed BEFORE the child starts, so a chunk that crashes without printing a
  // summary is still named in the job log by the line above its wreckage.
  console.log(`\n=== chunk ${index}/${total}: ${plan.root} (${plan.files.length} file(s))`)

  const startedAt = Date.now()
  // Piped and BUFFERED rather than inherited: the runner reads the one line
  // shape it has to name — an import death (F1.135) — without a second run,
  // and prints the output only if the chunk is red (F1.59, see the header).
  const child = Bun.spawn(
    ['bun', 'test', ...args, '--reporter=junit', `--reporter-outfile=${reportArg}`],
    { cwd: runRoot, stdin: 'inherit', stdout: 'pipe', stderr: 'pipe' },
  )
  const deathLines: string[] = []
  const keep = (line: string): void => {
    if (IMPORT_DEATH_PATTERN.test(line)) deathLines.push(line)
  }
  const collected: string[] = []
  inFlightOutput = collected
  await Promise.all([tee(child.stdout, collected, keep), tee(child.stderr, collected, keep)])
  await child.exited
  const durationMs = Date.now() - startedAt
  const verdict = classifyRun(child.exitCode, child.signalCode)
  const importDeaths = findImportDeaths(deathLines.join('\n'))

  const reportPath = join(runRoot, reportArg)
  const outcome: ChunkOutcome = existsSync(reportPath)
    ? (() => {
        const cases = parseJUnit(readFileSync(reportPath, 'utf-8'))
        const count = (state: string): number => cases.filter((one) => one.state === state).length
        return {
          root: plan.root,
          verdict,
          ranFiles: [...new Set(cases.map((one) => normalizeReportedFile(one.file, runRoot)))].sort(),
          reportWritten: true,
          pass: count('pass'),
          skip: count('skip'),
          todo: count('todo'),
          fail: count('fail'),
          durationMs,
          importDeaths,
        }
      })()
    : { root: plan.root, verdict, ranFiles: [], reportWritten: false, pass: 0, skip: 0, todo: 0, fail: 0, durationMs, importDeaths }

  // Printed as soon as the chunk ends rather than only in the final summary,
  // because a run that is KILLED from outside — a CI job timeout, a lane
  // stopping a long measurement — would otherwise print no verdict at all and
  // the operator would be left parsing bun's own output to learn how far it
  // got. With this, every chunk that finished has said so.
  const shortfall = plan.files.length - outcome.ranFiles.length
  const output = collected.join('')
  const red = outcome.verdict.kind !== 'pass' || !outcome.reportWritten || shortfall !== 0 || importDeaths.length > 0
  const printed = chunkOutputToPrint(output, red, budget.left)
  budget.left = Math.max(0, budget.left - printed.spent)
  if (printed.text.length > 0) process.stdout.write(printed.text.endsWith('\n') ? printed.text : `${printed.text}\n`)
  // Cleared only once the output is decided, so a runner-side throw above it
  // still prints the chunk's buffer (see `main`).
  inFlightOutput = null
  console.log(
    `--- chunk ${index}/${total} ${plan.root}: ${outcome.verdict.label} — ` +
    `${outcome.ranFiles.length}/${plan.files.length} file(s)` +
    `${shortfall === 0 ? '' : ` (${shortfall} DID NOT RUN)`}, ` +
    `${outcome.pass} pass / ${outcome.skip} skip / ${outcome.todo} todo / ${outcome.fail} fail` +
    `${outcome.reportWritten ? '' : ', NO JUnit report'} [${(durationMs / 1000).toFixed(2)}s]` +
    `${red ? '' : ` (green: ${output.length} character(s) of output not printed)`}`,
  )
  for (const line of describeImportDeaths(importDeaths, plan.files, runRoot)) console.log(line)

  return outcome
}

interface Options {
  readonly listOnly: boolean
  readonly root: string
}

export function parseArgs(argv: readonly string[]): Options {
  let listOnly = false
  let root = '.'

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--list') {
      listOnly = true
    } else if (arg === '--root') {
      const value = argv[index + 1]
      if (value === undefined) throw new GateSafetyRefusal('REFUSED: --root needs a value.')
      root = value
      index += 1
    } else {
      throw new GateSafetyRefusal(`REFUSED: unknown argument ${JSON.stringify(arg ?? '')}.`)
    }
  }

  return { listOnly, root }
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv)
  const runRoot = assertInsideRepo(REPO_ROOT, options.root)

  const files = enumerateTestFiles(runRoot)
  const plans = planChunks(files)

  console.log(
    `ci-test-chunks: ${files.length} test file(s) in ${plans.length} chunk(s) ` +
    `(one per directory), from \`git ls-files\` under ${relative(REPO_ROOT, runRoot) || '.'}.`,
  )

  if (options.listOnly) {
    for (const plan of plans) console.log(`  ${String(plan.files.length).padStart(4)}  ${plan.root}`)
    return 0
  }

  if (files.length === 0) {
    console.error(
      'ci-test-chunks: git lists no test files at all. A green run over nothing is not a\n' +
      '  gate, so this is a failure — the same refusal `test:isolated` makes.',
    )
    return 1
  }

  const scratch = createGateScratchDir(runRoot, 'ci-test-chunks')
  const outcomes: ChunkOutcome[] = []
  const budget = { left: RED_OUTPUT_BUDGET_CHARS }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (inFlightOutput !== null) process.stdout.write(inFlightOutput.join(''))
      console.log(`\nci-test-chunks: stopped by ${signal}; the output above is the chunk in flight, unfiltered.`)
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }

  try {
    for (const [index, plan] of plans.entries()) {
      try {
        outcomes.push(await runChunk(plan, index + 1, plans.length, runRoot, toPosix(scratch.fromRepoRoot), budget))
      } catch (error) {
        // A runner-side throw (an unreadable report) is this chunk's red, never
        // the end of the job: the summary must still print. A gate-safety
        // refusal still ends the run with its own exit status 2.
        if (error instanceof GateSafetyRefusal) throw error
        const message = error instanceof Error ? error.message : String(error)
        if (inFlightOutput !== null) process.stdout.write(inFlightOutput.join(''))
        inFlightOutput = null
        console.log(`--- chunk ${index + 1}/${plans.length} ${plan.root}: RUNNER ERROR — ${message}`)
        outcomes.push({
          root: plan.root,
          verdict: { kind: 'fail', exitCode: null, signal: null, label: 'RUNNER ERROR' },
          ranFiles: [], reportWritten: false, pass: 0, skip: 0, todo: 0, fail: 0, durationMs: 0,
        })
      }
    }
  } finally {
    rmSync(scratch.absolute, { recursive: true, force: true })
  }

  const problems = verifyCoverage(plans, outcomes, files)
  const redChunks = outcomes.filter(
    (outcome) => outcome.verdict.kind !== 'pass' || !outcome.reportWritten,
  )

  const totals = outcomes.reduce(
    (sum, one) => ({
      pass: sum.pass + one.pass,
      skip: sum.skip + one.skip,
      todo: sum.todo + one.todo,
      fail: sum.fail + one.fail,
      files: sum.files + one.ranFiles.length,
      ms: sum.ms + one.durationMs,
    }),
    { pass: 0, skip: 0, todo: 0, fail: 0, files: 0, ms: 0 },
  )

  console.log('')
  console.log('=== ci-test-chunks summary')
  console.log(
    `  ${totals.pass} pass / ${totals.skip} skip / ${totals.todo} todo / ${totals.fail} fail ` +
    `across ${totals.files} file(s) in ${plans.length} chunk(s); git lists ${files.length}.`,
  )
  console.log(`  ${(totals.ms / 1000).toFixed(1)}s in the chunk children. Slowest:`)
  for (const outcome of [...outcomes].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)) {
    console.log(
      `    ${(outcome.durationMs / 1000).toFixed(2).padStart(9)}s  ${outcome.root} ` +
      `(${outcome.ranFiles.length} file(s))`,
    )
  }

  for (const outcome of redChunks) {
    const noReport = outcome.reportWritten ? '' : ' — NO JUnit report was written'
    const deaths = outcome.importDeaths?.length ?? 0
    const died = deaths === 0 ? '' : ` — ${deaths} IMPORT DEATH(s), see the chunk's result line`
    console.log(`  RED  ${outcome.root}: ${outcome.verdict.label}${noReport}${died} (${outcome.fail} fail)`)
    if (outcome.verdict.kind === 'killed') {
      console.log(`       ${killedExplanation(`chunk ${outcome.root}`, outcome.verdict)}`)
    }
  }

  for (const problem of problems) console.log(`  COVERAGE  ${problem}`)

  if (redChunks.length === 0 && problems.length === 0) {
    console.log('  every chunk passed and every tracked test file ran in exactly one of them.')
    return 0
  }

  console.log(
    `\nci-test-chunks: FAILED — ${redChunks.length} red chunk(s), ${problems.length} coverage problem(s).`,
  )
  return 1
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)))
  } catch (error) {
    if (error instanceof GateSafetyRefusal) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  }
}

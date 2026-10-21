/**
 * The reader for `ci-test-chunks.ts`.
 *
 * Two halves, because the runner has two kinds of claim and only one of them
 * can be driven from a fixture tree:
 *
 *   * **End to end, over a throwaway git repository** — the plan comes out of
 *     git, one chunk passes, one chunk fails, the exit status is the failing
 *     one, and the summary names the red chunk by its directory. This is also
 *     where the JUnit report's `file` attribute is read for real, because that
 *     attribute is what the coverage guard compares against and a wrong guess
 *     about its shape would make every comparison vacuous.
 *   * **`verifyCoverage` directly** — a file in no chunk, a file in two chunks,
 *     a chunk that ran zero files and a chunk that ran a file it was never
 *     handed. None of the four can be produced from a fixture tree: each is a
 *     bug in the planner or in bun, so a test that could stage one would be
 *     testing a backdoor rather than the guard.
 *
 * Every arm below would pass against a runner that reported success on an
 * incomplete run, which is the failure this whole script exists to refuse.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test'

import {
  type ChunkOutcome,
  type ChunkPlan,
  RED_OUTPUT_BUDGET_CHARS,
  RED_OUTPUT_EDGE_CHARS,
  RED_OUTPUT_EDGE_RESERVE_CHARS,
  chunkOutputToPrint,
  describeImportDeaths,
  enumerateTestFiles,
  findImportDeaths,
  isTestFile,
  normalizeReportedFile,
  planChunks,
  stubsNamingModule,
  verifyCoverage,
} from './ci-test-chunks.ts'
import { createGateScratchDir } from './gate-safety.ts'

// The fixture spawns real `bun test` children — small graphs, but several of
// them, and this box is I/O-bound (AGENTS.md). Sized against the FILE's largest
// observed run rather than against any one case, which is what the per-test
// default cannot express.
setDefaultTimeout(180_000)

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const scratchDirs: string[] = []

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (run.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(run.stderr)}`)
  }
}

function write(root: string, relativePath: string, body: string): void {
  const absolute = join(root, relativePath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, body)
}

const PASSING = `import { expect, it } from 'bun:test'\nit('passes', () => { expect(1).toBe(1) })\n`
const FAILING = `import { expect, it } from 'bun:test'\nit('fails on purpose', () => { expect(1).toBe(2) })\n`

/**
 * A throwaway git repository under the repo's own gitignored cache — the one
 * place a repo-relative path can reach, which is what `gate-safety.ts` demands
 * of anything handed to a child process.
 */
function makeFixture(options: { withFailure: boolean }): { root: string; fromRepoRoot: string } {
  const scratch = createGateScratchDir(REPO_ROOT, 'ci-test-chunks-fixture')
  scratchDirs.push(scratch.absolute)

  // TRACKED, in two different directories, so the plan has two chunks.
  write(scratch.absolute, 'alpha/one.test.ts', PASSING)
  write(scratch.absolute, 'beta/two.test.ts', options.withFailure ? FAILING : PASSING)
  // UNTRACKED and not ignored — a lane's brand-new file. It must be IN scope.
  write(scratch.absolute, 'alpha/fresh.test.ts', PASSING)
  // IGNORED — the runner's own cache on CI, which must be OUT of scope.
  write(scratch.absolute, '.gitignore', 'cached/\n')
  write(scratch.absolute, 'cached/vendored.test.ts', FAILING)
  // Not a test file at all, by bun's own naming rule.
  write(scratch.absolute, 'alpha/helper.ts', 'export const x = 1\n')
  // The isolated mechanism's naming: `bun test` does not treat it as a test
  // file, and neither does this runner. `test:isolated` runs it afterwards.
  write(scratch.absolute, 'alpha/solo.isolated.ts', PASSING)

  git(scratch.absolute, 'init', '--quiet')
  git(scratch.absolute, 'add', '--', 'alpha/one.test.ts', 'beta/two.test.ts', 'alpha/helper.ts')

  return { root: scratch.absolute, fromRepoRoot: scratch.fromRepoRoot }
}

async function runRunner(fromRepoRoot: string, ...extra: string[]): Promise<{
  exitCode: number
  output: string
}> {
  // The child stands in for the CI job's own line, which runs with NO
  // `NODE_ENV`. Inheriting this runner's `NODE_ENV=test` hands it a state CI
  // never has: the repo's config-dir guard refuses a `bun <file>` process under
  // it, because the root `bunfig.toml` preload isolates `CONFIG_DIR` under
  // `bun test` and NOT under `bun <file>` (AGENTS.md §Traps). Measured — all
  // four cases below failed on that refusal, with the runner exiting 1 for a
  // reason that had nothing to do with the chunks.
  //
  // `delete` and not an `undefined` assignment: this list is spread into the
  // child, and a name assigned rather than deleted stays readable by property
  // while dropping out of the spread, which is the other half of the same trap.
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.NODE_ENV

  const child = Bun.spawn(
    ['bun', 'scripts/ci-test-chunks.ts', '--root', fromRepoRoot, ...extra],
    { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe', env },
  )
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  // The exit status comes from the PROCESS, never from a shell pipeline
  // (AGENTS.md: a `| tail` reports tail's status, not the gate's).
  const exitCode = await child.exited
  return { exitCode, output: `${stdout}\n${stderr}` }
}

describe('isTestFile — the same names bun itself treats as test files', () => {
  it('accepts .test/.spec in ts and tsx, and nothing else', () => {
    expect(isTestFile('packages/shared/src/a/__tests__/b.test.ts')).toBe(true)
    expect(isTestFile('apps/electron/src/renderer/c.test.tsx')).toBe(true)
    expect(isTestFile('scripts/d.spec.ts')).toBe(true)
    expect(isTestFile('packages/shared/src/a/helper.ts')).toBe(false)
    expect(isTestFile('docs/a.test.md')).toBe(false)
  })

  it('leaves the `test:isolated` suites out, by their NAME and not by a list', () => {
    // They carry neither `.test.` nor `.spec.`, which is exactly why a bare
    // `bun test` never picks them up either. Two real ones from the tree.
    expect(isTestFile('packages/shared/src/workspaces/__tests__/paths-env.isolated.ts')).toBe(false)
    expect(isTestFile('apps/electron/src/main/__tests__/notifications-routing.isolated.ts')).toBe(false)
  })

  it('drops the directories a run from the repo root never reaches', () => {
    expect(isTestFile('node_modules/beautiful-mermaid/dist/a.test.ts')).toBe(false)
    expect(isTestFile('.references/upstream/b.test.ts')).toBe(false)
    expect(isTestFile('release/mac-arm64/c.test.ts')).toBe(false)
  })
})

describe('planChunks — one chunk per directory, and a real partition', () => {
  const files = [
    'packages/shared/src/agent/__tests__/b.test.ts',
    'packages/shared/src/agent/__tests__/a.test.ts',
    'packages/shared/src/agent/core/__tests__/c.test.ts',
    'scripts/d.test.ts',
  ]

  it('groups by directory and sorts both levels', () => {
    expect(planChunks(files).map((plan) => plan.root)).toEqual([
      'packages/shared/src/agent/__tests__',
      'packages/shared/src/agent/core/__tests__',
      'scripts',
    ])
    expect(planChunks(files)[0]?.files).toEqual([
      'packages/shared/src/agent/__tests__/a.test.ts',
      'packages/shared/src/agent/__tests__/b.test.ts',
    ])
  })

  it('puts every file in exactly one chunk — a nested directory is its OWN chunk', () => {
    // The whole reason the child is handed explicit files: a chunk ROOT of
    // `…/agent/__tests__` would sweep `…/agent/core/__tests__` with it.
    const planned = planChunks(files).flatMap((plan) => plan.files)
    expect(planned.sort()).toEqual([...files].sort())
    expect(new Set(planned).size).toBe(files.length)
    expect(verifyCoverage(planChunks(files), [], files)).not.toEqual([])
  })
})

describe('normalizeReportedFile — both shapes bun has written', () => {
  it('strips a leading ./ and relativises an absolute path', () => {
    expect(normalizeReportedFile('./a/b.test.ts', '/repo')).toBe('a/b.test.ts')
    expect(normalizeReportedFile('a/b.test.ts', '/repo')).toBe('a/b.test.ts')
    expect(normalizeReportedFile('/repo/a/b.test.ts', '/repo')).toBe('a/b.test.ts')
  })
})

describe('verifyCoverage — the four shapes no fixture tree can stage', () => {
  const plan = (root: string, ...files: string[]): ChunkPlan => ({ root, files })
  const ran = (root: string, ...ranFiles: string[]): ChunkOutcome => ({
    root,
    verdict: { kind: 'pass', exitCode: 0, signal: null, label: 'PASS' },
    ranFiles,
    reportWritten: true,
    pass: ranFiles.length,
    skip: 0,
    todo: 0,
    fail: 0,
    durationMs: 1,
  })

  it('says nothing when the plan covered the tree and every chunk ran it', () => {
    expect(verifyCoverage(
      [plan('a', 'a/x.test.ts'), plan('b', 'b/y.test.ts')],
      [ran('a', 'a/x.test.ts'), ran('b', 'b/y.test.ts')],
      ['a/x.test.ts', 'b/y.test.ts'],
    )).toEqual([])
  })

  it('names a file in NO chunk', () => {
    const problems = verifyCoverage(
      [plan('a', 'a/x.test.ts')],
      [ran('a', 'a/x.test.ts')],
      ['a/x.test.ts', 'b/y.test.ts'],
    )
    expect(problems.some((line) => line.includes('b/y.test.ts') && line.includes('NO chunk'))).toBe(true)
  })

  it('names a file in TWO chunks', () => {
    const problems = verifyCoverage(
      [plan('a', 'a/x.test.ts'), plan('b', 'a/x.test.ts')],
      [ran('a', 'a/x.test.ts'), ran('b', 'a/x.test.ts')],
      ['a/x.test.ts'],
    )
    expect(problems.some((line) => line.includes('a/x.test.ts') && line.includes('2 chunks'))).toBe(true)
  })

  it('names a chunk that ran ZERO files — the green run over nothing', () => {
    const problems = verifyCoverage(
      [plan('a', 'a/x.test.ts')],
      [ran('a')],
      ['a/x.test.ts'],
    )
    expect(problems.some((line) => line.includes('chunk a ran ZERO'))).toBe(true)
  })

  it('names a chunk that ran a file it was never handed', () => {
    const problems = verifyCoverage(
      [plan('a', 'a/x.test.ts')],
      [ran('a', 'a/x.test.ts', 'a/sneaked.test.ts')],
      ['a/x.test.ts'],
    )
    expect(problems.some((line) => line.includes('was not handed') && line.includes('a/sneaked.test.ts'))).toBe(true)
  })

  it('names the summed count when it is not the tracked count', () => {
    // The shape that survives every per-chunk check: each chunk ran what it was
    // handed, and the PLAN was short. The sentence has to say both numbers.
    const problems = verifyCoverage(
      [plan('a', 'a/x.test.ts')],
      [ran('a', 'a/x.test.ts')],
      ['a/x.test.ts', 'b/y.test.ts'],
    )
    expect(problems.some((line) => line.includes('ran 1 file(s) where git lists 2'))).toBe(true)
  })
})

describe('chunkOutputToPrint — a green chunk prints nothing, a red one everything the budget allows (F1.59)', () => {
  it('prints nothing of a green chunk, and all of a red one while the budget covers it', () => {
    const roomy = RED_OUTPUT_EDGE_RESERVE_CHARS + 1_000
    expect(chunkOutputToPrint('(pass) a\n', false, roomy)).toEqual({ text: '', spent: 0 })
    expect(chunkOutputToPrint('(fail) b\n', true, roomy)).toEqual({ text: '(fail) b\n', spent: 9 })
  })

  it('keeps the head and the tail of a red chunk past the budget, and counts what it left out', () => {
    const output = `HEAD${'x'.repeat(RED_OUTPUT_EDGE_CHARS * 3)}TAIL`
    const printed = chunkOutputToPrint(output, true, RED_OUTPUT_EDGE_RESERVE_CHARS)
    expect(printed.text.startsWith('HEAD')).toBe(true)
    expect(printed.text.endsWith('TAIL')).toBe(true)
    expect(printed.text).toContain(`OUTPUT SHORTENED  ${output.length - 2 * RED_OUTPUT_EDGE_CHARS} of ${output.length} character(s)`)
    expect(printed.spent).toBe(2 * RED_OUTPUT_EDGE_CHARS)
  })

  it('never spends more than the budget, however many chunks are red — the summary must fit', () => {
    // The failure this guards is "many reds at once": 200 red chunks of 100 k
    // characters each is 20 M, over twice GitLab's 8 MiB cap.
    const output = `HEAD${'x'.repeat(100_000)}TAIL`
    let left = RED_OUTPUT_BUDGET_CHARS
    let printedChars = 0
    let notesOnly = 0
    for (let chunk = 0; chunk < 200; chunk += 1) {
      const printed = chunkOutputToPrint(output, true, left)
      expect(printed.spent).toBeLessThanOrEqual(left)
      left -= printed.spent
      printedChars += printed.text.length
      if (printed.spent === 0) {
        notesOnly += 1
        // A spent budget prints the counting line alone — `slice(-0)` would be the whole output.
        expect(printed.text).not.toContain('HEAD')
        expect(printed.text).not.toContain('TAIL')
        expect(printed.text).toContain(`OUTPUT SHORTENED  ${output.length} of ${output.length} character(s)`)
      }
    }
    // Positive control: the loop did reach a spent budget, so the arm above ran.
    expect(notesOnly).toBeGreaterThan(0)
    expect(printedChars).toBeLessThan(RED_OUTPUT_BUDGET_CHARS + 200 * 400)
  })
})

describe('end to end, over a throwaway git repository', () => {
  it('enumerates tracked AND untracked files, and never an ignored one', () => {
    const fixture = makeFixture({ withFailure: false })
    expect(enumerateTestFiles(fixture.root).sort()).toEqual([
      'alpha/fresh.test.ts',
      'alpha/one.test.ts',
      'beta/two.test.ts',
    ])
  })

  it('--list prints the plan and runs nothing', async () => {
    const fixture = makeFixture({ withFailure: true })
    const { exitCode, output } = await runRunner(fixture.fromRepoRoot, '--list')
    expect(exitCode).toBe(0)
    expect(output).toContain('3 test file(s) in 2 chunk(s)')
    expect(output).toContain('alpha')
    expect(output).toContain('beta')
    // Nothing ran, so no chunk banner and no summary.
    expect(output).not.toContain('=== ci-test-chunks summary')
  })

  it('passes when every chunk passes, and says the coverage was exact', async () => {
    const fixture = makeFixture({ withFailure: false })
    const { exitCode, output } = await runRunner(fixture.fromRepoRoot)
    expect(exitCode).toBe(0)
    expect(output).toContain('across 3 file(s) in 2 chunk(s); git lists 3.')
    expect(output).toContain('every chunk passed and every tracked test file ran in exactly one of them.')
    // F1.59: a green chunk's own output stays out of the job log — its result
    // line is all that is printed, and it says what it left out.
    expect(output).not.toContain('(pass)')
    expect(output).toMatch(/--- chunk 1\/2 alpha: PASS .* \(green: \d+ character\(s\) of output not printed\)/)
    // The cost is REPORTED rather than left for somebody to time by hand: this
    // split trades wall time (one module graph per chunk) for localisation, and
    // an operator deciding whether that trade still holds needs the number.
    expect(output).toMatch(/s in the chunk children\. Slowest:/)
  })

  it('fails on a red chunk, NAMES it, and still runs the other one', async () => {
    const fixture = makeFixture({ withFailure: true })
    const { exitCode, output } = await runRunner(fixture.fromRepoRoot)
    expect(exitCode).toBe(1)
    expect(output).toContain('RED  beta')
    expect(output).toContain('1 red chunk(s), 0 coverage problem(s)')
    // The point of the split: the OTHER chunk still ran and still reported, so
    // one red localises instead of ending the job. Read out of the summed
    // totals, which only a chunk that finished contributes to.
    expect(output).toContain('across 3 file(s) in 2 chunk(s); git lists 3.')
    // And the banner for each chunk is printed BEFORE its child, which is what
    // names a chunk that crashes without printing a summary of its own.
    expect(output).toContain('=== chunk 1/2: alpha (2 file(s))')
    expect(output).toContain('=== chunk 2/2: beta (1 file(s))')
    // ...while the RESULT line is printed as soon as that chunk ends, so a run
    // killed from outside (a CI job timeout) still says how far it got and
    // which chunks were clean. Both halves are asserted because only the pair
    // brackets a chunk that dies between them.
    expect(output).toMatch(/--- chunk 1\/2 alpha: PASS — 2\/2 file\(s\), 2 pass \/ 0 skip \/ 0 todo \/ 0 fail \[\d+\.\d\ds\]/)
    expect(output).toMatch(/--- chunk 2\/2 beta: FAIL \(exit 1\) — 1\/1 file\(s\), 0 pass \/ 0 skip \/ 0 todo \/ 1 fail \[\d+\.\d\ds\]/)
    // F1.59: the RED chunk's output is printed in full, the green one's is not.
    expect(output).toContain('(fail) fails on purpose')
    expect(output).not.toContain('(pass) passes')
  })

  it('names an IMPORT DEATH under the chunk\'s result line, with that chunk\'s own stub of the module (F1.135)', async () => {
    const scratch = createGateScratchDir(REPO_ROOT, 'ci-test-chunks-import-death')
    scratchDirs.push(scratch.absolute)
    // A victim that dies while LINKING because the name is not exported. That is
    // deterministic, where a real amputation's victim depends on bun's own file
    // order — and the line bun prints is the same one either way.
    const victim = `import { absent } from './lib'\nimport { expect, it } from 'bun:test'\nit('never runs', () => { expect(absent).toBe(1) })\n`
    write(scratch.absolute, 'gamma/lib.ts', 'export const present = 1\n')
    write(scratch.absolute, 'gamma/victim.test.ts', victim)
    write(scratch.absolute, 'gamma/stubber.test.ts', `import { expect, it, mock } from 'bun:test'\nmock.module('./lib', () => ({ present: 2 }))\nit('passes', () => { expect(1).toBe(1) })\n`)
    // The same death in a chunk that stubs NOTHING: the death is named, and no
    // stub line is invented for it.
    write(scratch.absolute, 'delta/lib.ts', 'export const present = 1\n')
    write(scratch.absolute, 'delta/victim.test.ts', victim)
    git(scratch.absolute, 'init', '--quiet')
    git(scratch.absolute, 'add', '--', 'gamma', 'delta')

    const { exitCode, output } = await runRunner(scratch.fromRepoRoot)
    expect(exitCode).toBe(1)
    expect(output).toContain("IMPORT DEATH  export 'absent' not found in gamma/lib.ts")
    expect(output).toContain("IMPORT DEATH  export 'absent' not found in delta/lib.ts")
    expect(output).toContain('stubbed in this chunk by: gamma/stubber.test.ts —')
    expect(output.split('\n').filter((line) => line.includes('stubbed in this chunk by:'))).toHaveLength(1)
    // The summary names the kind of red, so nobody goes looking for a failing assertion.
    // A chunk whose EVERY file died writes no JUnit report at all (measured), and says so first.
    expect(output).toMatch(/RED {2}delta: FAIL \(exit 1\) — NO JUnit report was written — 1 IMPORT DEATH\(s\)/)
    expect(output).toMatch(/RED {2}gamma: FAIL \(exit 1\) — 1 IMPORT DEATH\(s\)/)
  })

  it('refuses a tree with no test files rather than reporting a green', async () => {
    const scratch = createGateScratchDir(REPO_ROOT, 'ci-test-chunks-empty')
    scratchDirs.push(scratch.absolute)
    write(scratch.absolute, 'alpha/helper.ts', 'export const x = 1\n')
    git(scratch.absolute, 'init', '--quiet')
    git(scratch.absolute, 'add', '--', 'alpha/helper.ts')

    const { exitCode, output } = await runRunner(scratch.fromRepoRoot)
    expect(exitCode).toBe(1)
    expect(output).toContain('git lists no test files at all')
  })
})

describe('import deaths replayed from the CI log that had them (F1.135, job 126377033)', () => {
  // Verbatim lines from that job's log (D1.442): three chunks red with ZERO
  // failing tests. The fifth line is the shape this runner deliberately does
  // NOT treat as an amputation — see `ImportDeath`.
  const LOG = [
    "SyntaxError: Export named 'getStateIconStyle' not found in module '/builds/nessy-desktop/nessy-desktop/apps/electron/src/renderer/config/session-status-config.tsx'.",
    "SyntaxError: Export named 'resizeImageForAPI' not found in module '/builds/nessy-desktop/nessy-desktop/packages/server-core/src/services/index.ts'.",
    "SyntaxError: Export named 'resizeImageForAPI' not found in module '/builds/nessy-desktop/nessy-desktop/packages/server-core/src/services/index.ts'.",
    "SyntaxError: Export named 'isUsableGitBashPath' not found in module '/builds/nessy-desktop/nessy-desktop/packages/server-core/src/services/index.ts'.",
    "SyntaxError: Missing 'default' export in module '/builds/nessy-desktop/nessy-desktop/node_modules/pdfjs-dist/build/pdf.worker.min.mjs?url'.",
  ].join('\n')
  const SERVICES = '/builds/nessy-desktop/nessy-desktop/packages/server-core/src/services/index.ts'
  const chunkFiles = (root: string): readonly string[] =>
    planChunks(enumerateTestFiles(REPO_ROOT)).find((plan) => plan.root === root)?.files ?? []

  it('reads the named-export shape only, once per module and name, with a count', () => {
    expect(findImportDeaths(LOG).map((death) => [death.exportName, death.count])).toEqual([
      ['getStateIconStyle', 1],
      ['resizeImageForAPI', 2],
      ['isUsableGitBashPath', 1],
    ])
    expect(findImportDeaths('(pass) nothing died here\n')).toEqual([])
  })

  it('names the two amputators D1.442 found, from the log line and this checkout alone', () => {
    const [statusConfig] = findImportDeaths(LOG)
    const appShell = chunkFiles('apps/electron/src/renderer/components/app-shell/__tests__')
    const rpc = chunkFiles('packages/server-core/src/handlers/rpc')
    // Positive controls on the enumeration itself: a missing chunk would make both reads vacuous.
    expect(appShell.length).toBeGreaterThan(10)
    expect(rpc.length).toBeGreaterThan(5)
    expect(stubsNamingModule(statusConfig!.module, appShell, REPO_ROOT)).toEqual([
      'apps/electron/src/renderer/components/app-shell/__tests__/SessionMenu.test.tsx',
    ])
    expect(stubsNamingModule(SERVICES, rpc, REPO_ROOT)).toEqual([
      'packages/server-core/src/handlers/rpc/sessions.search-content.test.ts',
    ])
  })

  it('names nothing over a chunk with no such stub, and still names the death', () => {
    const marketplace = chunkFiles('apps/electron/src/renderer/components/marketplace/__tests__')
    expect(marketplace.length).toBeGreaterThan(0)
    expect(stubsNamingModule(SERVICES, marketplace, REPO_ROOT)).toEqual([])
    const lines = describeImportDeaths(findImportDeaths(LOG).slice(1, 2), marketplace, REPO_ROOT)
    expect(lines).toHaveLength(1)
    // F1.59 CI: on the runner the checkout IS `/builds/nessy-desktop/nessy-desktop`,
    // so the line shows the module relative to the run root — the rule
    // `describeImportDeaths` applies to a path under it — and pinning the
    // absolute form was red there (pipeline 127302104). Expected under both.
    const shown = SERVICES.startsWith(`${REPO_ROOT}/`) ? SERVICES.slice(REPO_ROOT.length + 1) : SERVICES
    expect(lines[0]).toContain(`IMPORT DEATH  export 'resizeImageForAPI' not found in ${shown} (printed 2x) — `)
  })
})

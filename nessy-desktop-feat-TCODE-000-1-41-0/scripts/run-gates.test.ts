/**
 * Tests for `run-gates.ts` — P2.222.
 *
 * The claim the runner makes is not "the gate passes"; it is "you have seen
 * every step". So the case that matters is the one an `&&` chain gets wrong: a
 * red in the MIDDLE, with steps after it. Each case builds a synthetic repo
 * whose package.json is the chain and whose steps are `echo`s, so the assertion
 * is about the runner and not about any real compiler.
 */

import { describe, expect, test, afterAll } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const COPIED = ['run-gates.ts', 'gate-safety.ts', 'gate-verdict.ts', 'gate-projects.ts']

const created: string[] = []
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

function buildFakeRepo(scripts: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'run-gates-'))
  created.push(root)

  mkdirSync(join(root, 'scripts'), { recursive: true })
  for (const file of COPIED) cpSync(join(SCRIPT_DIR, file), join(root, 'scripts', file))

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fake', scripts }, null, 2))
  return root
}

/**
 * Spawned with a RELATIVE script path and `cwd`, so nothing this suite executes
 * carries an absolute path — the same rule the runner enforces on itself.
 */
async function run(
  root: string,
  args: string[],
): Promise<{ code: number; out: string; stdout: string }> {
  const proc = Bun.spawn(['bun', 'scripts/run-gates.ts', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, out: `${stdout}\n${stderr}`, stdout }
}

/**
 * One budget per case, set against the measured floor (F1.972). A case is 4-6
 * cold `bun` starts in a row (the runner, one `bun run` per step, one more per
 * `bun -e` step), and on a starved box a start is I/O wait, not work: the
 * three-echo positive control took 24 984 ms inside `bun test` (CI-d2,
 * 2026-09-26), where the two cases with `bun -e` steps went red at the old
 * 30 s (one exited 143, SIGTERM at the budget). Priced alone the same day at
 * load ~10: the green chain `real 14.44 user 0.03 sys 0.03`, the two-red chain
 * `real 12.72 user 0.04 sys 0.05`. 120 s is about three times the ~37 s a
 * six-start case costs at CI-d2's rate, and still ends a hung runner.
 */
const CASE_TIMEOUT_MS = 120_000

const GREEN = {
  'step-one': 'echo STEP_ONE_RAN',
  'step-two': 'echo STEP_TWO_RAN',
  'step-three': 'echo STEP_THREE_RAN',
  chain: 'bun run step-one && bun run step-two && bun run step-three',
}

describe('run-gates', () => {
  test('positive control — an all-green chain passes and says how many steps', async () => {
    const { code, out } = await run(buildFakeRepo(GREEN), ['chain'])
    expect(code).toBe(0)
    expect(out).toContain('GATE chain: PASSED — 3 of 3 steps green.')
    expect(out).toContain('STEP_THREE_RAN')
  }, CASE_TIMEOUT_MS)

  test('a red in the MIDDLE does not stop the steps after it', async () => {
    // This is the whole row. Under `&&`, `step-three` never runs and nothing
    // says so: the operator sees one error and a non-zero exit, and cannot tell
    // the difference between "one package is broken" and "one package is broken
    // and ten were never looked at".
    const root = buildFakeRepo({
      ...GREEN,
      'step-two': 'bun -e "console.log(\'STEP_TWO_RAN\'); process.exit(3)"',
    })
    const { code, out } = await run(root, ['chain'])

    expect(code).toBe(1)
    expect(out).toContain('STEP_THREE_RAN')
    expect(out).toContain('GATE chain: FAILED — 1 of 3 steps red: step-two FAIL (exit 3)')
  }, CASE_TIMEOUT_MS)

  test('every step gets a verdict word, red ones included', async () => {
    const root = buildFakeRepo({
      ...GREEN,
      'step-one': 'bun -e "process.exit(1)"',
      'step-three': 'bun -e "process.exit(2)"',
    })
    const { code, out } = await run(root, ['chain'])

    expect(code).toBe(1)
    expect(out).toContain('step-one')
    expect(out).toContain('FAIL (exit 1)')
    expect(out).toContain('FAIL (exit 2)')
    expect(out).toContain('step-two')
    expect(out).toContain('PASS')
  }, CASE_TIMEOUT_MS)

  test('a step killed mid-run is KILLED, not a number next to the passes', async () => {
    // P2.353: a run that never finished must not be one glance away from one
    // that finished clean.
    const root = buildFakeRepo({
      ...GREEN,
      'step-two': 'bun -e "process.kill(process.pid, 9)"',
    })
    const { code, out } = await run(root, ['chain'])

    expect(code).toBe(1)
    expect(out).toContain('KILLED')
    expect(out).toContain('It did NOT finish, so it proved nothing')
    expect(out).toContain('STEP_THREE_RAN')
  }, CASE_TIMEOUT_MS)

  test('the verdict is the LAST thing printed, so a `| tail` still shows it', async () => {
    // P2.275: `pipefail` is off by default, so a piped run reports the pipe's
    // status. The exit code may not survive; the output has to.
    const root = buildFakeRepo({ ...GREEN, 'step-two': 'bun -e "process.exit(1)"' })
    const { out, stdout } = await run(root, ['chain'])

    // stdout alone: the two streams interleave in a terminal but are captured
    // separately here, and the claim is about what a reader sees LAST.
    const lines = stdout.trimEnd().split('\n')
    expect(lines.slice(-3).join('\n')).toContain("pipe's exit status, not the gate's")
    expect(out).toContain('GATE chain: FAILED')
  }, CASE_TIMEOUT_MS)

  test('refuses a step it cannot run independently rather than running it in order', async () => {
    // The old `typecheck:all` was a chain of RELATIVE cds. Accepting one would
    // silently reintroduce the ordering dependency this runner removes.
    const root = buildFakeRepo({
      ...GREEN,
      chain: 'cd packages/core && bun run step-one && cd ../shared && bun run step-two',
    })
    const { code, out } = await run(root, ['chain'])

    expect(code).toBe(2)
    expect(out).toContain('cannot execute independently')
    expect(out).not.toContain('STEP_ONE_RAN')
  }, CASE_TIMEOUT_MS)

  test('refuses a step naming a home directory, and runs nothing first', async () => {
    const root = buildFakeRepo({ ...GREEN, chain: 'bun run step-one && rm -rf ~/anywhere' })
    const { code, out } = await run(root, ['chain'])

    expect(code).toBe(2)
    expect(out).toContain('REFUSED')
    expect(out).toContain('`~` home reference')
    expect(out).not.toContain('STEP_ONE_RAN')
  }, CASE_TIMEOUT_MS)

  test('refuses a chain name the root package.json does not define', async () => {
    const { code, out } = await run(buildFakeRepo(GREEN), ['no-such-chain'])
    expect(code).toBe(2)
    expect(out).toContain('no "no-such-chain" script')
  }, CASE_TIMEOUT_MS)

  test('a red step names the TSCONFIG it ran, in the table AND in the verdict', async () => {
    // P2.390. The nickname `typecheck:scripts` and the package named in the
    // diagnostic's path were two different things, and the summary carried only
    // the nickname — so two lanes guessed two different owners, both wrong. The
    // verdict is the line that survives a `| tail`, so it is the line that has
    // to carry the answer.
    const root = buildFakeRepo({ ...GREEN, 'step-two': 'cd pkg && bun run tsc --noEmit' })
    const { code, out } = await run(root, ['chain'])

    expect(code).toBe(1)
    expect(out).toContain('step-two — pkg/tsconfig.json')
    expect(out).toContain('step-two failed under: pkg/tsconfig.json')
    expect(out).toContain("A diagnostic's FILE PATH is not its owner")
    expect(out).toMatch(/GATE chain: FAILED[^\n]*step-two [^\n]*\[pkg\/tsconfig\.json\]/)
    expect(out).toContain('STEP_THREE_RAN')
  }, CASE_TIMEOUT_MS)

  test('a red step that runs no compiler gets no tsconfig label and no ownership note', async () => {
    // The negative half: a label that guesses is worse than no label, and the
    // ownership paragraph under a lint failure would be noise claiming to be
    // guidance.
    const root = buildFakeRepo({ ...GREEN, 'step-two': 'bun -e "process.exit(1)"' })
    const { code, out } = await run(root, ['chain'])

    expect(code).toBe(1)
    expect(out).toContain('GATE chain: FAILED — 1 of 3 steps red: step-two FAIL (exit 1)')
    expect(out).not.toContain('failed under:')
    expect(out).not.toContain("is not its owner")
  }, CASE_TIMEOUT_MS)

  test('--list prints the steps without running any of them', async () => {
    const { code, out } = await run(buildFakeRepo(GREEN), ['chain', '--list'])
    expect(code).toBe(0)
    expect(out).toContain('3 steps in chain.')
    expect(out).not.toContain('STEP_ONE_RAN')
  }, CASE_TIMEOUT_MS)
})

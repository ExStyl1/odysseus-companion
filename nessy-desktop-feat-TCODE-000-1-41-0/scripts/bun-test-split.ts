/**
 * bun-test-split — run `bun test` and report what it actually asserted.
 *
 * P2.246. A lane reported "86 pass / 0 fail across 7 files" for a run that had
 * printed `83 pass / 3 skip / 86 ran`. The number came from bun's last line —
 *
 *   Ran 86 tests across 7 files.
 *
 * — and `Ran` is pass + skip + todo + fail, not pass. So the report was
 * probably right for that rig and wrong as written, and it mattered: the 3
 * skips gated on a gitignored binary, i.e. the skipped tests were exactly the
 * ones guarding the assumption the row was about. A skip is not a pass; it is a
 * test that asserted NOTHING, and which tests skip is a property of the rig,
 * not of the branch.
 *
 * This prints the split and NAMES the skips, so a brief can quote a line that
 * cannot be misread. The names come from bun's own JUnit reporter (`<skipped/>`
 * per test case, `message="TODO"` distinguishing `test.todo`); bun's console
 * reporter prints counts only.
 *
 * Usage:
 *   bun scripts/bun-test-split.ts [bun test args ...]
 *
 * The normal console output still streams through untouched — this only adds
 * the trailing block. Exit status is bun's, and a run killed by a signal is
 * called KILLED rather than left as a number (P2.353).
 */

import { readFileSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GateSafetyRefusal,
  assertNoHomeOrRootPath,
  createGateScratchDir,
} from './gate-safety.ts'
import { classifyRun, killedExplanation } from './gate-verdict.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface TestCase {
  name: string
  file: string
  state: 'pass' | 'skip' | 'todo' | 'fail'
}

/** Bun's JUnit output is machine-generated and flat, so this reads it directly. */
export function parseJUnit(xml: string): TestCase[] {
  const cases: TestCase[] = []

  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attributes = match[1] ?? ''
    const body = match[3] ?? ''
    const name = /\bname="([^"]*)"/.exec(attributes)?.[1] ?? '(unnamed)'
    const file = /\bfile="([^"]*)"/.exec(attributes)?.[1] ?? '(unknown file)'

    let state: TestCase['state'] = 'pass'
    if (body.includes('<failure') || body.includes('<error')) state = 'fail'
    else if (/<skipped\b[^>]*message="TODO"/.test(body)) state = 'todo'
    else if (body.includes('<skipped')) state = 'skip'

    cases.push({ name, file, state })
  }

  return cases
}

export function renderSplit(cases: readonly TestCase[]): string[] {
  const count = (state: TestCase['state']): number => cases.filter((c) => c.state === state).length
  const files = new Set(cases.map((c) => c.file)).size
  const skipped = cases.filter((c) => c.state === 'skip' || c.state === 'todo')

  const lines = [
    '',
    `bun test split: ${count('pass')} pass / ${count('skip')} skip / ${count('todo')} todo / ` +
    `${count('fail')} fail — ${cases.length} ran across ${files} files.`,
    "Quote THIS line, not bun's `Ran N`: `Ran` counts skips and todos, so it is not a pass count.",
  ]

  if (skipped.length > 0) {
    lines.push('')
    lines.push(`${skipped.length} test(s) asserted nothing on this rig:`)
    for (const test of skipped) {
      lines.push(`  ${test.state === 'todo' ? 'todo' : 'skip'}  ${test.file} — ${test.name}`)
    }
    lines.push(
      'A skip gated on an artifact (a gitignored binary, a built bundle) skips on the rigs',
      'that lack it and runs on the rigs that have it, so this count is a property of THIS',
      'machine. Say which, and why, wherever this run is reported.',
    )
  }

  return lines
}

function main(argv: readonly string[]): number {
  for (const arg of argv) assertNoHomeOrRootPath('a `bun test` argument', arg)

  const scratch = createGateScratchDir(REPO_ROOT, 'bun-test-split')
  const reportFile = join(scratch.absolute, 'junit.xml')
  // Relative to the CHILD's cwd, so the argv this script executes carries no
  // absolute path. See createGateScratchDir for why that matters.
  const reportArg = relative(process.cwd(), reportFile)
  assertNoHomeOrRootPath('the JUnit report path', reportArg)

  try {
    const run = Bun.spawnSync(
      ['bun', 'test', ...argv, '--reporter=junit', `--reporter-outfile=${reportArg}`],
      { cwd: process.cwd(), stdio: ['inherit', 'inherit', 'inherit'] },
    )

    const verdict = classifyRun(run.exitCode, run.signalCode)
    if (verdict.kind === 'killed') {
      console.error(`\nbun-test-split: ${killedExplanation('the test run', verdict)}`)
      return 1
    }

    let xml: string
    try {
      xml = readFileSync(reportFile, 'utf-8')
    } catch {
      console.error(
        '\nbun-test-split: bun wrote no JUnit report, so the pass/skip/fail split is unknown.\n' +
        '  Reporting the run without it would be exactly the guess this script exists to\n' +
        `  replace, so it fails. (bun exited ${verdict.exitCode}.)`,
      )
      return 1
    }

    for (const line of renderSplit(parseJUnit(xml))) console.log(line)
    return verdict.exitCode ?? 1
  } finally {
    rmSync(scratch.absolute, { recursive: true, force: true })
  }
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

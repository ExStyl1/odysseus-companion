#!/usr/bin/env bun
/**
 * i18n-locale-pin-census.ts — which English-copy suites would go red in a process whose shared
 * i18n singleton was left on Russian? (F1.283, from F1.103 / D1.424)
 *
 * WHY. The i18n instance is a module-scope SINGLETON shared by every test file bun runs in one
 * process. A suite that switches it to `ru` and does not switch it back (some do, on purpose)
 * leaves every later file asserting English copy on Russian strings — and bun ignores the CLI
 * order of the files it is given (AGENTS.md §Traps), so "run it after X" cannot reproduce the
 * victim on demand. F1.103 settled it once, by hand: 2 342 test files, 87 asserting English
 * copy on an assertion line, 31 already pinning a language, the other 56 run in ONE process
 * under a preload that leaves the singleton on 'ru' — 1 346 tests, 7 failing, all in one file
 * (`settings-tiers-session-notice.test.ts`, pinned since). This makes that census a command to
 * run at a wave boundary. It is deliberately NOT a `lint:chain` step: its `--run` arm runs
 * suites, which costs minutes, and a chain step that runs suites is a chain nobody runs.
 *
 * MODES (default is the static census, which runs nothing):
 *
 *   bun scripts/i18n-locale-pin-census.ts             # the census: candidates, pinned, unpinned
 *   bun scripts/i18n-locale-pin-census.ts --run       # + run the unpinned ones under the 'ru' preload
 *   bun scripts/i18n-locale-pin-census.ts --control   # the positive control (below), and nothing else
 *
 * `--run` and `--control` go through `scripts/bun-test-lock.ts` like every suite in this tree,
 * and their exit code is the process's own — never piped (AGENTS.md: a piped gate reports the
 * pipe).
 *
 * THE CONTROL (`--control`). An instrument that cannot go red proves nothing. It copies a suite
 * that PINS English in a `beforeAll` (`claude-session-permission-grant.test.ts`, WI-bs's
 * recipe) to a scratch file beside it with the pin stripped, runs both under the 'ru' preload,
 * and passes only when the scratch copy FAILS and the pinned original PASSES. The scratch copy
 * has to sit beside the original because its relative imports must resolve, so it lives in
 * the SHARED tree: it is written only once the test lock is HELD (the whole control runs as
 * one locked child, `--control-locked`, never by hand) and removed in a `finally`, so no
 * other lane's `git status` or locked directory run can meet it.
 *
 * WHAT IT CANNOT SEE. The candidate list is a heuristic: an English locale VALUE fragment (at
 * least 12 characters, containing a space, differing from the Russian value) appearing on a
 * line that asserts (`expect(`, `.toContain(`, `.toBe(`, `.toMatch(`, `toEqual(`). A suite that
 * builds its expected English from `t()` at runtime, or asserts copy that is not in `en.json`,
 * is invisible here — and correctly so for the first kind, which cannot be a victim.
 *
 * A RED IS NOT A VICTIM UNTIL IT PASSES WITHOUT THE PRELOAD. The census reads, and `--run`
 * executes, WORKING-TREE bytes, so in a shared tree a neighbour's uncommitted failing arm reads
 * exactly like a locale victim — measured 2026-09-24, the first `--run` reported one "victim"
 * that was a sibling lane's deliberate red, added minutes earlier. So every file red under 'ru'
 * is re-run WITHOUT the preload, and only one that then passes is reported as a victim; one red
 * both ways is listed apart, and does not fail the census.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPO = resolve(dirname(new URL(import.meta.url).pathname), '..')
const EN = join(REPO, 'packages/shared/src/i18n/locales/en.json')
const RU = join(REPO, 'packages/shared/src/i18n/locales/ru.json')
const I18N = join(REPO, 'packages/shared/src/i18n/index.ts')
/** A suite that pins English in a hook — the control's subject. */
export const CONTROL_SUITE = 'packages/shared/src/agent/__tests__/claude-session-permission-grant.test.ts'

const ASSERTION = /expect\(|\.toContain\(|\.toBe\(|\.toMatch\(|toEqual\(/
const PIN = /changeLanguage\(|createInstance\(|lng:\s*['"]/
/** {@link PIN} for `git grep -E`, which does not honour `\s` on this rig (AGENTS.md §Traps, the `\b` sibling). */
const PIN_GIT = `changeLanguage\\(|createInstance\\(|lng:[[:space:]]*['"]`

/** English value fragments worth matching: long enough to be copy, and not also the Russian value. */
export function englishFragments(en: Record<string, unknown>, ru: Record<string, unknown>): Map<string, string> {
  const fragments = new Map<string, string>()
  for (const [key, value] of Object.entries(en)) {
    if (typeof value !== 'string' || ru[key] === value) continue
    for (const raw of value.split(/\{\{[^}]*\}\}|<[^>]*>|\$t\([^)]*\)/)) {
      const part = raw.trim().replace(/^[ .,:;]+|[ .,:;]+$/g, '')
      if (part.length >= 12 && part.includes(' ') && !fragments.has(part)) fragments.set(part, key)
    }
  }
  return fragments
}

export interface Candidate {
  file: string
  keys: string[]
  pinned: boolean
}

/** One file's verdict: the locale keys whose English copy it asserts, and whether it pins. */
export function classify(file: string, source: string, fragments: Map<string, string>): Candidate | null {
  const asserting = source.split('\n').filter(line => ASSERTION.test(line)).join('\n')
  const keys = new Set<string>()
  for (const [fragment, key] of fragments) if (asserting.includes(fragment)) keys.add(key)
  if (keys.size === 0) return null
  return { file, keys: [...keys].sort(), pinned: PIN.test(source) }
}

function gitLines(args: string[]): string[] {
  const out = Bun.spawnSync(['git', ...args], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' })
  return out.stdout.toString().split('\n').filter(Boolean)
}

const TEST_PATHSPEC = ['--', '*.test.ts', '*.test.tsx']

/**
 * The census reads through `git grep`, never by opening every file: on this rig opening 2 000+
 * files costs minutes of I/O wait (AGENTS.md §Traps — the first draft of this script took
 * 108 s that way) while `git grep` answers in well under a second. `git grep` without
 * `--cached` reads the WORKING-TREE bytes of tracked files, which is what the suites run.
 */
export function census(): { total: number; candidates: Candidate[] } {
  const fragments = englishFragments(JSON.parse(readFileSync(EN, 'utf8')), JSON.parse(readFileSync(RU, 'utf8')))
  const total = gitLines(['ls-files', ...TEST_PATHSPEC]).length
  const assertingByFile = new Map<string, string[]>()
  for (const line of gitLines(['grep', '-a', '-E', ASSERTION.source, ...TEST_PATHSPEC])) {
    const at = line.indexOf(':')
    const file = line.slice(0, at)
    assertingByFile.set(file, [...(assertingByFile.get(file) ?? []), line.slice(at + 1)])
  }
  const pinned = new Set(gitLines(['grep', '-a', '-l', '-E', PIN_GIT, ...TEST_PATHSPEC]))
  const candidates: Candidate[] = []
  for (const [file, lines] of assertingByFile) {
    const verdict = classify(file, lines.join('\n'), fragments)
    if (verdict) candidates.push({ ...verdict, pinned: pinned.has(file) })
  }
  candidates.sort((a, b) => a.file.localeCompare(b.file))
  return { total, candidates }
}

/**
 * The preload's source: the state a sibling file can leave behind — the singleton initialised
 * (react binding and all) and on 'ru'.
 *
 * Every import is an ABSOLUTE path resolved from the repo. The preload is written to a temp
 * directory, and a bare specifier there resolves from THAT directory: measured 2026-09-23, a
 * bare `react-i18next` from the temp dir made bun fetch a copy into its own install cache,
 * which then failed on `Cannot find package 'react'` — so every run under the preload died
 * before a test ran, and the control reported the PINNED original red as well (AGENTS.md
 * §Traps, the rig placed outside the repo).
 */
export function russianPreloadSource(): string {
  const reactI18next = Bun.resolveSync('react-i18next', dirname(I18N))
  return [
    '// Written by scripts/i18n-locale-pin-census.ts (F1.283) — never committed.',
    `import { initReactI18next } from ${JSON.stringify(reactI18next)}`,
    `import { i18n, setupI18n } from ${JSON.stringify(I18N)}`,
    'if (!i18n.isInitialized) setupI18n([initReactI18next])',
    "await i18n.changeLanguage('ru')",
    '',
  ].join('\n')
}

function writeRussianPreload(): { path: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-locale-census-'))
  const path = join(dir, 'left-on-ru.ts')
  writeFileSync(path, russianPreloadSource())
  return { path, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * One `bun test` run under the preload (`null`: no preload, the victim check); the exit code
 * and output are the process's own. `label` set: the run takes the test lock itself. `label`
 * null: the CALLER holds it (`--control-locked` only).
 */
function runUnderRussian(preload: string | null, files: readonly string[], label: string | null): { exitCode: number; output: string } {
  const test = ['bun', 'test', ...(preload === null ? [] : ['--preload', preload]), ...files.map(file => `./${file}`)]
  const run = Bun.spawnSync(
    label === null ? test : ['bun', 'scripts/bun-test-lock.ts', 'run', '--label', label, '--', ...test],
    { cwd: REPO, stdout: 'pipe', stderr: 'pipe' },
  )
  return { exitCode: run.exitCode ?? 1, output: `${run.stdout.toString()}\n${run.stderr.toString()}` }
}

/** Files named on a `(fail)` line, read from the per-file headers bun prints before its reprint block. */
export function failingFiles(output: string): string[] {
  const failing = new Set<string>()
  let current: string | null = null
  for (const line of output.split('\n')) {
    if (/ tests? failed:$/.test(line.trim())) break // bun reprints every failure at the end (AGENTS.md §Traps)
    const header = line.match(/^(\S+\.test\.tsx?):$/)
    if (header) current = header[1]!
    if (current && line.includes('(fail)')) failing.add(current)
  }
  return [...failing].sort()
}

/** Red under 'ru' AND without the preload is not a locale victim (see the header): split the two. */
export function separateVictims(redUnderRussian: readonly string[], redWithoutPreload: readonly string[]): { victims: string[]; redRegardless: string[] } {
  const regardless = new Set(redWithoutPreload)
  return {
    victims: redUnderRussian.filter(file => !regardless.has(file)),
    redRegardless: redUnderRussian.filter(file => regardless.has(file)),
  }
}

/** The control, run INSIDE the test lock (see `--control`, which is how it is invoked). */
function controlLocked(): boolean {
  const original = join(REPO, CONTROL_SUITE)
  const scratch = original.replace(/\.test\.ts$/, '.locale-census-control.test.ts')
  const source = readFileSync(original, 'utf8')
  const unpinned = source.replace(/await i18n\.changeLanguage\('en'\)/g, '/* pin stripped by the F1.283 control */')
  if (unpinned === source) {
    console.error(`control: ${CONTROL_SUITE} no longer pins with await i18n.changeLanguage('en') — update CONTROL_SUITE.`)
    return false
  }
  const preload = writeRussianPreload()
  try {
    writeFileSync(scratch, unpinned)
    const stripped = runUnderRussian(preload.path, [scratch.slice(REPO.length + 1)], null)
    const pinned = runUnderRussian(preload.path, [CONTROL_SUITE], null)
    console.log(`control: the unpinned scratch copy under 'ru' exited ${stripped.exitCode} (must be non-zero); the pinned original exited ${pinned.exitCode} (must be 0).`)
    if (pinned.exitCode !== 0) console.log(`control: the pinned original's output, last lines:\n${pinned.output.trim().split('\n').slice(-15).join('\n')}`)
    return stripped.exitCode !== 0 && pinned.exitCode === 0
  } finally {
    rmSync(scratch, { force: true })
    preload.dispose()
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const label = args.includes('--label') ? args[args.indexOf('--label') + 1] ?? 'locale-census' : 'locale-census'
  if (args.includes('--control-locked')) {
    const ok = controlLocked()
    console.log(ok ? 'control: OK — the instrument can go red.' : 'control: FAILED — the instrument cannot be trusted.')
    process.exit(ok ? 0 : 1)
  }
  if (args.includes('--control')) {
    // The whole control is ONE locked child, so its scratch file exists only while the lock is held.
    const run = Bun.spawnSync(
      ['bun', 'scripts/bun-test-lock.ts', 'run', '--label', `${label}-control`, '--', 'bun', 'scripts/i18n-locale-pin-census.ts', '--control-locked'],
      { cwd: REPO, stdout: 'inherit', stderr: 'inherit' },
    )
    process.exit(run.exitCode ?? 1)
  }
  const { total, candidates } = census()
  const unpinned = candidates.filter(candidate => !candidate.pinned)
  console.log(`locale census: ${total} test files, ${candidates.length} assert English copy on an assertion line, ${candidates.length - unpinned.length} pin a language, ${unpinned.length} do not.`)
  if (!args.includes('--run')) {
    for (const candidate of unpinned) console.log(`  ${candidate.file}  [${candidate.keys.slice(0, 3).join(', ')}${candidate.keys.length > 3 ? ', …' : ''}]`)
    process.exit(0)
  }
  const preload = writeRussianPreload()
  try {
    const run = runUnderRussian(preload.path, unpinned.map(candidate => candidate.file), label)
    const summary = run.output.split('\n').filter(line => /^\s*\d+ (pass|fail)$|^Ran \d+ tests? across \d+ files?/.test(line.trim()))
    for (const line of summary) console.log(`  ${line.trim()}`)
    if (run.exitCode === 0) {
      console.log(`locale census: all ${unpinned.length} unpinned English-copy suites pass with the singleton left on 'ru'.`)
      process.exit(0)
    }
    const redUnderRussian = failingFiles(run.output)
    if (redUnderRussian.length === 0) {
      console.error(`locale census: the run exited ${run.exitCode} with no failing file named — read it by hand:\n${run.output.trim().split('\n').slice(-20).join('\n')}`)
      process.exit(1)
    }
    const plain = runUnderRussian(null, redUnderRussian, label)
    const { victims, redRegardless } = separateVictims(redUnderRussian, failingFiles(plain.output))
    if (redRegardless.length > 0) {
      console.log(`locale census: ${redRegardless.length} suite(s) are red WITHOUT the preload too — not locale victims (a neighbour's mid-edit or a real red; the census reads working-tree bytes):`)
      for (const file of redRegardless) console.log(`  - ${file}`)
    }
    if (victims.length === 0) {
      console.log(`locale census: no suite fails because the singleton was left on 'ru'.`)
      process.exit(0)
    }
    console.error(`locale census: ${victims.length} suite(s) fail with the singleton left on 'ru' and pass without it — each should pin 'en' in an awaited beforeAll:`)
    for (const victim of victims) console.error(`  - ${victim}`)
    process.exit(1)
  } finally {
    preload.dispose()
  }
}

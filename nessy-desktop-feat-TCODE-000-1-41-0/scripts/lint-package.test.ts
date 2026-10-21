/**
 * Tests for `lint-package.ts` — P2.358.
 *
 * The negative case is the row: a lint run that linted NOTHING and exited 0.
 * It is built rather than described, because the interesting half is what the
 * raw command does — measured here on ESLint 9.39.4, `npx eslint <target>
 * --no-error-on-unmatched-pattern` over a directory with no lintable file
 * exits 0 and prints ZERO BYTES. That is byte-identical to a package that
 * linted eight hundred files clean, and it is what this wrapper turns into a
 * refusal.
 *
 * The fixture lives under `node_modules/.cache/` rather than a temp directory
 * because `npx` finds ESLint by walking up to a `node_modules/.bin` — from
 * `/var/folders` there is none, and the test would measure npx's failure to
 * resolve rather than anything about this script.
 */

import { describe, expect, test, afterAll } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGateScratchDir } from './gate-safety.ts'
import { declaredTargets } from './lint-package.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const created: string[] = []
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

/** A package with an eslint config and a `src/` holding exactly `files`. */
function buildFixture(files: Record<string, string>): string {
  const dir = createGateScratchDir(REPO_ROOT, 'lint-package')
  created.push(dir.absolute)

  writeFileSync(join(dir.absolute, 'eslint.config.mjs'), 'export default [{ files: ["**/*.ts"] }]\n')
  mkdirSync(join(dir.absolute, 'src'), { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir.absolute, 'src', name), body)
  }

  return dir.fromRepoRoot
}

/**
 * `NODE_ENV` is dropped from the child. The repo's `bunfig.toml` preloads a
 * config-dir isolation guard that refuses to run with `NODE_ENV=test` outside a
 * `bun test` root — inherited, it kills the child before it reaches any of the
 * behaviour under test, and the suite would be measuring the guard.
 */
function childEnv(): Record<string, string | undefined> {
  const env = { ...process.env }
  delete env.NODE_ENV
  return env
}

async function lint(args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', 'scripts/lint-package.ts', ...args], {
    cwd: REPO_ROOT,
    env: childEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, out: `${stdout}\n${stderr}` }
}

describe('lint-package', () => {
  test('positive control — a package with a lintable file reports the count and passes', async () => {
    const dir = buildFixture({ 'a.ts': 'export const a = 1\n' })
    const { code, out } = await lint([dir, 'src'])

    expect(code).toBe(0)
    expect(out).toContain('1 files linted, 0 errors, 0 warnings')
  }, 120_000)

  test('a run that linted 0 files FAILS, where raw ESLint exits 0 and prints nothing', async () => {
    const dir = buildFixture({ 'notes.txt': 'not code\n' })

    const raw = Bun.spawnSync(
      ['npx', 'eslint', 'src', '--no-error-on-unmatched-pattern'],
      { cwd: join(REPO_ROOT, dir), env: childEnv(), stdout: 'pipe', stderr: 'pipe' },
    )
    // The control for the claim: without this wrapper there is nothing to see.
    expect(raw.exitCode).toBe(0)
    expect(raw.stdout.length + raw.stderr.length).toBe(0)

    const { code, out } = await lint([dir, 'src', '--no-error-on-unmatched-pattern'])
    expect(code).toBe(1)
    expect(out).toContain('linted 0 FILES')
  }, 120_000)

  test('D1.304 — with no target, the package\'s own lint script declares it', () => {
    // `apps/electron` is the one package that declares a target, and the bare
    // form used to die parsing the staged server bundles it reaches without one
    // (`resources/pi-agent-server/index.js` is 25.8 MB). Measured on the same
    // rig: `npx eslint` on the 8.6 MB sibling alone, capped at 512 MB, gives
    // `FATAL ERROR: Reached heap limit` and exit 134.
    expect(declaredTargets('apps/electron')).toEqual(['src'])
    // A trailing slash is the same package, because a caller writes one.
    expect(declaredTargets('apps/electron/')).toEqual(['src'])
    // THE NEGATIVE, and it is the common case: fifteen of the sixteen `lint:*`
    // scripts pass no target, so the lookup must answer `null` and leave the
    // historical `.` default in place rather than inventing one.
    expect(declaredTargets('packages/shared')).toBeNull()
    expect(declaredTargets('scripts')).toBeNull()
    // A directory no lint script names is not a declaration either.
    expect(declaredTargets('packages/no-such-package')).toBeNull()
  })

  test('D1.304 — an EXPLICIT target still wins, so the chain step is untouched', async () => {
    // The whole risk of the change: `lint:electron` passes `src` and must lint
    // exactly what it lints today. Driven on a fixture rather than on
    // `apps/electron`, so the arm costs a second and cannot go red on a
    // sibling lane's warning. The real proof for `apps/electron` is the file
    // COUNT, 1002 both ways, recorded in the commit.
    const dir = buildFixture({ 'a.ts': 'export const a = 1\n' })
    const { code, out } = await lint([dir, 'src'])
    expect(code).toBe(0)
    expect(out).toContain('1 files linted')
    // The declaration line belongs only to the bare form.
    expect(out).not.toContain('no target given')
  }, 120_000)

  test('refuses a package directory outside the repo instead of linting it', async () => {
    const { code, out } = await lint(['../..'])
    expect(code).toBe(2)
    expect(out).toContain('REFUSED')
  }, 60_000)
})

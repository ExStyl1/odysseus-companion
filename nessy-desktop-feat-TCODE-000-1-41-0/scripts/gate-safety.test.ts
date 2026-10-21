/**
 * Tests for `gate-safety.ts`.
 *
 * The guard exists so that no gate runner can be talked into executing a string
 * that names a home directory or the filesystem root. A guard nobody has seen
 * fire is a comment, so both halves are pinned here: the refusals, and the
 * repo-relative strings these runners genuinely pass, which must NOT trip it.
 * A guard that cries wolf gets loosened, and a loosened guard is the hole.
 */

import { describe, expect, test, afterAll } from 'bun:test'
import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GateSafetyRefusal,
  assertInsideRepo,
  assertNoHomeOrRootPath,
  createGateScratchDir,
} from './gate-safety.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

describe('assertNoHomeOrRootPath', () => {
  // Spelled without a real user name on purpose: this file is itself a string
  // in the repo, and the point is the SHAPE, not any particular home.
  const refused = [
    '~',
    '~/anywhere',
    'cd ~/anywhere && rm -rf .',
    '$HOME',
    '${HOME}/anywhere',
    'rm -rf $HOME',
    '/',
    '/etc/passwd',
    'cat /Users/someone/.ssh/id_rsa',
    'eslint --format "/absolute/formatter.mjs"',
  ]

  for (const value of refused) {
    test(`refuses ${JSON.stringify(value)}`, () => {
      expect(() => assertNoHomeOrRootPath('a probe', value)).toThrow(GateSafetyRefusal)
    })
  }

  const allowed = [
    'lint:core',
    'typecheck:pi-agent-server',
    'bun run lint:electron',
    'cd apps/electron && bun run lint',
    'packages/server-core',
    './scripts/eslint-lint-proof-formatter.mjs',
    '../../scripts/lint-package.ts',
    'src',
    '.',
    '--no-error-on-unmatched-pattern',
    'https://example.invalid/x',
  ]

  for (const value of allowed) {
    test(`allows ${JSON.stringify(value)}`, () => {
      expect(() => assertNoHomeOrRootPath('a probe', value)).not.toThrow()
    })
  }
})

describe('assertInsideRepo', () => {
  test('accepts a real package directory and returns its resolved path', () => {
    expect(assertInsideRepo(REPO_ROOT, 'packages/core')).toBe(join(REPO_ROOT, 'packages/core'))
  })

  test('refuses a path that climbs out of the repo', () => {
    expect(() => assertInsideRepo(REPO_ROOT, '../..')).toThrow(GateSafetyRefusal)
  })

  test('refuses a SYMLINK out of the repo, which a prefix compare would accept', () => {
    // The reason containment is decided by `realpath`: `<repo>/<link>` has the
    // repo as a textual prefix while pointing anywhere at all.
    const dir = createGateScratchDir(REPO_ROOT, 'safety-symlink')
    scratch.push(dir.absolute)
    const outside = join(dir.absolute, 'outside')
    mkdirSync(outside, { recursive: true })

    const link = join(dir.fromRepoRoot, 'escape')
    symlinkSync(resolve(REPO_ROOT, '..'), join(REPO_ROOT, link))

    expect(() => assertInsideRepo(REPO_ROOT, link)).toThrow(GateSafetyRefusal)
  })

  test('refuses an absolute path even when it IS inside the repo', () => {
    // Containment is not the only question. An absolute path is refused because
    // of what it can become, not because of where it points today.
    expect(() => assertInsideRepo(REPO_ROOT, join(REPO_ROOT, 'packages/core')))
      .toThrow(GateSafetyRefusal)
  })
})

describe('createGateScratchDir', () => {
  test('lands inside the repo and yields a relative path safe to execute', () => {
    const dir = createGateScratchDir(REPO_ROOT, 'safety-probe')
    scratch.push(dir.absolute)

    expect(dir.fromRepoRoot.startsWith('node_modules/.cache/nessy-gates/')).toBe(true)
    expect(() => assertNoHomeOrRootPath('the scratch path', dir.fromRepoRoot)).not.toThrow()
    expect(assertInsideRepo(REPO_ROOT, dir.fromRepoRoot)).toBe(dir.absolute)
  })
})

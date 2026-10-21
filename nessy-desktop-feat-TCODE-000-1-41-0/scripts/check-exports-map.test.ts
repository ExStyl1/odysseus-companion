/**
 * Tests for `check-exports-map.ts`.
 *
 * P2.448. The gate exists because an `exports` map is enforced by exactly one
 * of the three resolvers that read this repo — Vite — so a missing subpath is
 * invisible to `typecheck:all` and `bun test` and shows up only as a packaged
 * build that will not build.
 *
 * Two things therefore have to be pinned, and the second is the one that rots:
 *
 *   1. the MATCHING rules, which are Node's subpath-pattern rules and are easy
 *      to get subtly wrong in the direction that lets a violation through;
 *   2. the ARMING — that the step is in `lint:chain` and is not carrying the
 *      flag that turns it into a reporter. A present, green, useless gate is
 *      the failure mode this repo has already measured twice, and it is
 *      indistinguishable from a working one until the day it matters.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  codeSitesOnly,
  findDangling,
  findUnexported,
  isExported,
  readPackageExports,
  splitSpecifier,
  stripComments,
  type PackageExports,
} from './check-exports-map.ts'
import { GateSafetyRefusal } from './gate-safety.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function rootScripts(): Record<string, string> {
  return JSON.parse(readFileSync(`${REPO_ROOT}/package.json`, 'utf8')).scripts as Record<string, string>
}

/** A package whose map carries one exact key, one pattern, and one rename. */
function fixture(): PackageExports {
  return readPackageExports('packages/fixture', {
    name: '@nessy-agent/fixture',
    exports: {
      '.': './src/index.ts',
      './statuses': './src/statuses/index.ts',
      './agent/backend/*': './src/agent/backend/*.ts',
    },
  }) as PackageExports
}

describe('isExported follows Node subpath rules', () => {
  const pkg = fixture()

  test.each([
    ['.', true],
    ['./statuses', true],
    ['./agent/backend/anthropic', true],
  ])('%s -> exported=%s', (subpath, expected) => {
    expect(isExported(pkg, subpath as string)).toBe(expected)
  })

  test.each([
    // The five that blocked the renderer were all of this shape: a real module,
    // one prefix away from a key that exists, and carried by no pattern.
    ['./config/notification-timing', false],
    ['./statuses/storage', false],
    // A pattern's `*` must capture at least one character — `./a/*` does not
    // match `./a/`. Getting this wrong is how a gate goes quietly permissive.
    ['./agent/backend/', false],
    ['./agent/backend', false],
  ])('%s -> exported=%s', (subpath, expected) => {
    expect(isExported(pkg, subpath as string)).toBe(expected)
  })
})

describe('splitSpecifier', () => {
  test.each([
    ['@nessy-agent/shared', '@nessy-agent/shared', '.'],
    ['@nessy-agent/shared/statuses', '@nessy-agent/shared', './statuses'],
    ['@nessy-agent/shared/sessions/mirror/host', '@nessy-agent/shared', './sessions/mirror/host'],
  ])('%s', (specifier, name, subpath) => {
    expect(splitSpecifier(specifier as string)).toEqual({ name, subpath })
  })
})

describe('findUnexported', () => {
  const packages = new Map([['@nessy-agent/fixture', fixture()]])

  test('reports an imported subpath the map does not carry, with every site', () => {
    const found = findUnexported(packages, [
      { file: 'apps/electron/src/renderer/App.tsx', line: '3', specifier: '@nessy-agent/fixture/config/timing' },
      { file: 'apps/electron/src/main/index.ts', line: '9', specifier: '@nessy-agent/fixture/config/timing' },
    ])

    expect(found).toEqual([
      {
        packageName: '@nessy-agent/fixture',
        subpath: './config/timing',
        sites: ['apps/electron/src/main/index.ts:9', 'apps/electron/src/renderer/App.tsx:3'],
      },
    ])
  })

  test('a self-import is exempt — it resolves relatively and never reads the map', () => {
    const found = findUnexported(packages, [
      { file: 'packages/fixture/src/thing.ts', line: '1', specifier: '@nessy-agent/fixture/config/timing' },
    ])

    expect(found).toEqual([])
  })

  test('an exported subpath and an unknown package are both silent', () => {
    const found = findUnexported(packages, [
      { file: 'apps/electron/src/main/index.ts', line: '1', specifier: '@nessy-agent/fixture/statuses' },
      { file: 'apps/electron/src/main/index.ts', line: '2', specifier: '@nessy-agent/not-a-package/x' },
    ])

    expect(found).toEqual([])
  })
})

describe('a specifier quoted in a comment is not an import site (P6.822)', () => {
  const SPEC = '@nessy-agent/shared/not-a-real-subpath'

  test('a `//` probe line naming an unexported subpath is blanked', () => {
    const stripped = stripComments(`// probe: import x from '${SPEC}'\nconst y = 1\n`)

    expect(stripped.split('\n')[0]).not.toContain(SPEC)
    expect(stripped.split('\n')[1]).toBe('const y = 1')
  })

  test('a docblock line naming it is blanked, and the line count is unchanged', () => {
    const source = `/**\n * import x from '${SPEC}'\n */\nconst y = 1\n`
    const stripped = stripComments(source)

    expect(stripped).not.toContain(SPEC)
    // Line numbers have to survive: `git grep` reports a LINE, and the filter
    // addresses the stripped text by that number.
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length)
  })

  test('a real import survives — the negative control', () => {
    const source = `import { a } from '${SPEC}'\nawait import('${SPEC}')\n`

    expect(stripComments(source)).toBe(source)
  })

  // The measured regression. `scripts/build/interceptor-pairing.ts`'s
  // `stripComments` runs its BLOCK pass first; copied here verbatim it ate four
  // live `import('@nessy-agent/…')` calls in
  // `apps/electron/src/renderer/components/ui/__tests__/slash-command-menu.test.tsx`,
  // because a `//` line there quotes a subpath GLOB whose star-slash opened a
  // block comment that the next docblock's terminator closed 66 lines later.
  // Line comments are stripped first, so the glob leaves with the line quoting
  // it. Assembled from pieces below so this file never carries the sequence.
  test('a `//` line quoting a subpath glob does not swallow the code beneath it', () => {
    const glob = `@nessy-agent/shared/${'*'}`
    // The import sits BETWEEN the glob and the next block terminator — that
    // ordering is the whole defect, and a fixture whose terminator precedes the
    // import passes under BOTH pass orders (measured; the first version of this
    // test did exactly that and the mutant survived it).
    const source = `// prose about ${glob} subpaths\n`
      + `import { a } from '${SPEC}'\n`
      + `/** a docblock whose terminator sits below that import ${'*'}/\n`
    const stripped = stripComments(source)

    expect(stripped.split('\n')[1]).toContain(SPEC)
  })

  // Wiring: the strip is applied where the grep rows become sites. Driven with
  // a fake reader, because the whole-tree call reads ~800 files and measured
  // 221 s under wave load — the timeout that shape produces carries no
  // assertion and names no cause.
  test('codeSitesOnly keeps the code hit and drops the comment hit in one file', () => {
    const source = `// probe: import x from '${SPEC}'\nimport { a } from '${SPEC}'\n`
    const rows = [
      `src/a.ts:1:from '${SPEC}'`,
      `src/a.ts:2:from '${SPEC}'`,
      'not a grep row at all',
    ]

    expect(codeSitesOnly(rows, () => source)).toEqual([
      { file: 'src/a.ts', line: '2', specifier: SPEC },
    ])
  })
})

describe('findDangling', () => {
  test('reports a key whose target file is not on disk', () => {
    const pkg = readPackageExports('packages/fixture', {
      name: '@nessy-agent/fixture',
      exports: { './gone': './src/gone.ts' },
    }) as PackageExports

    expect(findDangling(new Map([[pkg.name, pkg]]), REPO_ROOT)).toEqual([
      { packageName: '@nessy-agent/fixture', subpath: './gone', target: './src/gone.ts' },
    ])
  })

  test('a real target is silent — the positive control for the check above', () => {
    const pkg = readPackageExports('scripts', {
      name: '@nessy-agent/fixture',
      exports: { './self': './check-exports-map.ts' },
    }) as PackageExports

    expect(findDangling(new Map([[pkg.name, pkg]]), REPO_ROOT)).toEqual([])
  })

  // gate-safety's refusal, exercised through this script's own reuse of it. An
  // absolute path in a manifest is never a legitimate export target, and the
  // guard is the reason a hand-edited map cannot point the check outside the
  // tree. Spelled as a SHAPE — this file is itself a string in the repo.
  test('refuses an export target naming the filesystem root', () => {
    const pkg = readPackageExports('packages/fixture', {
      name: '@nessy-agent/fixture',
      exports: { './escape': '/etc/passwd' },
    }) as PackageExports

    expect(() => findDangling(new Map([[pkg.name, pkg]]), REPO_ROOT)).toThrow(GateSafetyRefusal)
  })
})

describe('the step is armed', () => {
  test('lint:exports-map runs the script', () => {
    expect(rootScripts()['lint:exports-map']).toContain('scripts/check-exports-map.ts')
  })

  // The inverse of the `--check` flags the other scanners need: this gate fails
  // by default, and `--list` is what would turn it into a reporter that always
  // exits 0. A step that quietly grew the flag would be green forever.
  test('lint:exports-map does NOT carry --list, which would disarm it', () => {
    expect(rootScripts()['lint:exports-map']).not.toContain('--list')
  })

  test('lint:chain runs lint:exports-map', () => {
    expect(rootScripts()['lint:chain']).toContain('bun run lint:exports-map')
  })
})

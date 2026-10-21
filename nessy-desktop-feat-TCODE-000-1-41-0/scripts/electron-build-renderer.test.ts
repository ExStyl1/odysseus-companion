/**
 * Tests for the renderer build's externalization refusal — P6.981.
 *
 * The rule these pin is written in `apps/electron/vite.config.ts`'s own header:
 * *"the renderer build must print **zero** `has been externalized for browser
 * compatibility` warnings. It printed 282 before P6.971 and 0 after."* Nothing
 * enforced it until this script did, and the reason the pin can be
 * zero-tolerance is that the true count IS zero — the reproducer
 * `bun run electron:build:renderer` stays green.
 *
 * Every case here plants a synthetic warning. Running a real build to test the
 * refusal would take ~10 s and could only ever prove the NEGATIVE case, since
 * the tree has no positive one — which is exactly the shape of assurance the
 * traps spec warns about.
 *
 * That this file can exist at all is the second half of the change: the build
 * body now sits behind `import.meta.main`, so importing the two pure functions
 * here runs no build and can never reach the script's `process.exit`. A module
 * body that exits kills the runner at IMPORT time and reports exit 0 with ZERO
 * tests executed (AGENTS.md §Traps).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  EXTERNALIZED_MARKER,
  externalizedRefusal,
  findExternalizedWarnings,
} from './electron-build-renderer'

/** Vite's real wording, from the P6.971 measurement that counted 282 of them. */
const WARNING = (module: string, importer: string): string =>
  `Module "${module}" has been externalized for browser compatibility, imported by `
  + `"${importer}". See https://vite.dev/guide/troubleshooting.html`
  + `#module-externalized-for-browser-compatibility for more details.`

describe('findExternalizedWarnings', () => {
  test('POSITIVE — the shape vite really prints, module and importer both read', () => {
    const output = [
      'vite v6.4.3 building for production...',
      WARNING('node:crypto', '/repo/packages/shared/src/mcp/mcp-wire-name.ts'),
      WARNING('fs', '/repo/packages/shared/src/config/storage.ts'),
      'built in 9.61s',
    ].join('\n')

    expect(findExternalizedWarnings(output)).toEqual([
      { module: 'node:crypto', importer: '/repo/packages/shared/src/mcp/mcp-wire-name.ts' },
      { module: 'fs', importer: '/repo/packages/shared/src/config/storage.ts' },
    ])
  })

  test('NEGATIVE — a clean build yields nothing, which is the state this pins', () => {
    const output = [
      'vite v6.4.3 building for production...',
      'transforming...',
      '830 modules transformed.',
      'rendering chunks...',
      'built in 9.61s',
    ].join('\n')

    expect(findExternalizedWarnings(output)).toEqual([])
  })

  test('ANSI colour does not hide a warning — vite colours its own output', () => {
    // Spelled as an escape sequence, never the byte: a raw control character in
    // a source file is invisible in every diff, review and grep.
    const ESC = '\u001B'
    // A colour run sits mid-sentence in a real terminal build, and a matcher
    // reading the coloured bytes would report a clean build.
    const coloured = `${ESC}[33m${WARNING('path', '/repo/x.ts')}${ESC}[39m`

    expect(findExternalizedWarnings(coloured)).toEqual([
      { module: 'path', importer: '/repo/x.ts' },
    ])
  })

  test('BOUNDARY — a line carrying the marker in an unknown shape is still reported', () => {
    // The direction that would make this gate quiet is a warning the parser
    // cannot read being dropped. It comes back with the raw line as its module
    // and no importer, so the refusal still fires and still says something.
    const found = findExternalizedWarnings(`  something ${EXTERNALIZED_MARKER} somehow  `)

    expect(found).toHaveLength(1)
    expect(found[0]?.importer).toBeUndefined()
    expect(found[0]?.module).toBe(`something ${EXTERNALIZED_MARKER} somehow`)
  })
})

describe('externalizedRefusal', () => {
  test('names every module once, with its importer, and says where the fix belongs', () => {
    const message = externalizedRefusal([
      { module: 'node:crypto', importer: '/repo/a.ts' },
      { module: 'node:crypto', importer: '/repo/b.ts' },
      { module: 'fs', importer: undefined },
    ])

    // The count is of WARNINGS and the list is of MODULES: 282 warnings sat
    // behind a handful of modules, so collapsing them into one number would
    // have hidden which module to cut.
    expect(message).toContain('3 "has been externalized for browser compatibility" warning(s)')
    expect(message).toContain('over 2 module(s)')
    expect(message).toContain('  node:crypto  <- /repo/a.ts')
    expect(message).toContain('\n  fs\n')
    expect(message).not.toContain('/repo/b.ts')
    expect(message).toContain('apps/electron/vite.config.ts')
  })
})

describe('the subject exists', () => {
  test("the marker is still the sentence `vite.config.ts`'s header quotes", () => {
    // A guard matching a string the config's rule no longer names is a rule
    // nobody agreed to, so the marker is read back from the file that states
    // the rule rather than asserted against itself. The sentence WRAPS in that
    // docblock — the marker is split across two lines there — so the comparison
    // is against the unwrapped text rather than against a shorter needle that
    // would keep passing after the sentence changed.
    const config = readFileSync(join(import.meta.dir, '..', 'apps/electron/vite.config.ts'), 'utf-8')
    const unwrapped = config.replace(/\n\s*\*\s?/g, ' ')

    expect(unwrapped).toContain(EXTERNALIZED_MARKER)
    expect(unwrapped).toContain('must print **zero**')
  })
})

describe('every electron-renderer build path reaches the gate', () => {
  // P6.981 shipped the refusal; P6.991 found that it only refuses what routes
  // THROUGH it. `build-win.ps1` ran `vite build --config apps/electron/vite.config.ts`
  // itself, so a Windows packaged build printed the warnings and shipped, and
  // `apps/electron/package.json`'s `build:renderer` (reached by that package's own
  // `build`/`build:win`) was a second way around. These pin the routing rather than
  // the refusal, because the refusal was already correct on the day it was bypassed.
  const read = (rel: string): string =>
    readFileSync(join(import.meta.dir, '..', rel), 'utf-8')

  /** Every file that decides how the electron renderer gets built. */
  const ENTRY_POINTS = [
    'apps/electron/scripts/build-win.ps1',
    'apps/electron/scripts/build-dmg.sh',
    'apps/electron/scripts/build-linux.sh',
    'apps/electron/package.json',
    'package.json',
  ] as const

  test('POSITIVE — each platform script reaches the gate, directly or through electron:build', () => {
    expect(read('apps/electron/scripts/build-win.ps1')).toContain('bun run electron:build:renderer')
    // mac and linux never had their own renderer step: they run the whole chain.
    expect(read('apps/electron/scripts/build-dmg.sh')).toContain('bun run electron:build')
    expect(read('apps/electron/scripts/build-linux.sh')).toContain('bun run electron:build')
    expect(read('package.json')).toContain('bun run electron:build:renderer')
  })

  test("POSITIVE — the electron package's own build:renderer is the gated script", () => {
    const pkg = JSON.parse(read('apps/electron/package.json')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['build:renderer']).toBe('bun run ../../scripts/electron-build-renderer.ts')
  })

  test('NEGATIVE — no entry point drives apps/electron/vite.config.ts itself', () => {
    // Both halves must sit on ONE line, so the surrounding prose (which names the
    // script, never the invocation) cannot fire this. The offending lines are the
    // assertion's value rather than a count, so a failure names what to fix.
    for (const entry of ENTRY_POINTS) {
      const offenders = read(entry)
        .split('\n')
        .filter((line) => /vite\s+build/.test(line) && line.includes('apps/electron/vite.config.ts'))
      expect({ entry, offenders }).toEqual({ entry, offenders: [] })
    }
  })
})

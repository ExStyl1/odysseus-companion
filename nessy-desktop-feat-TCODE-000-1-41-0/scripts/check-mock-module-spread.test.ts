import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, setDefaultTimeout } from 'bun:test'

import {
  BASELINE_FILE,
  REPO_ROOT,
  TRAPS_SECTION,
  TRAPS_SPEC,
  classifyCapture,
  codeTokenOffsets,
  findMockModuleSites,
  candidateFiles,
  importsBelowTopLevelMock,
  isNarrowFirstPartyFinding,
  narrowOrigin,
  RATCHET_BASELINE_FILE,
  RATCHET_KINDS,
  readBaseline,
  readRatchetBaseline,
  staleBaselineEntries,
  testFiles,
} from './check-mock-module-spread'

/**
 * Two of these cases enumerate the tree (`git ls-files` over ~2 000 test files
 * plus a read of the baseline), which is I/O against bun's 5 000 ms default
 * timer — the same family the sibling guard indexes.
 *
 * Readings 2026-09-10 at load 6.6-9.5: the guard binary itself, doing strictly
 * more work than any case here (a `git grep`, a `git ls-files`, and a read of
 * all 100 candidate files), returned in **12.31 s** wall at `user 0.37 sys 0.24`
 * — **5 % cpu**, so this is I/O and not contention. 300 000 ms is ~24x that,
 * sized against a whole-file total on a cold tree rather than a warm per-case
 * floor, and deliberately no larger: a genuinely hung case still has to be heard
 * about. Its own constant rather than one of `module-graph-budgets.ts`'s three
 * because none of those names describes a cost that is not a module graph, and
 * that module's docblock says to declare one WITH its reading written down.
 */
const GATE_IO_BUDGET_MS = 300_000
setDefaultTimeout(GATE_IO_BUDGET_MS)

const site = (lines: readonly string[]) => findMockModuleSites('f.test.ts', lines.join('\n'))

describe('findMockModuleSites', () => {
  it('reports a restore from a LIVE namespace — the positive control, and the shape all three baselined files have', () => {
    // `clipboard-uri-containment.test.ts` is exactly this, and its own comment
    // recites the INCOMPLETE half of the rule while doing the corrected-away thing.
    const found = site([
      "const realChildProcess = await import('child_process');",
      "mock.module('child_process', () => ({ ...realChildProcess, execSync: () => '' }));",
      'afterAll(() => {',
      "  mock.module('child_process', () => realChildProcess);",
      '});',
    ])

    expect(found).toHaveLength(2)
    expect(found[0]?.kind).toBe('live-spread')
    expect(found[1]?.kind).toBe('restore-live')
    expect(found[1]?.line).toBe(4)
    expect(found[1]?.specifier).toBe('child_process')
  })

  it('reports a bare `import * as` handed straight back — the same defect without the dynamic import', () => {
    const found = site([
      "import * as realPath from 'node:path';",
      "afterEach(() => { mock.module('node:path', () => realPath) });",
    ])

    expect(found).toHaveLength(1)
    expect(found[0]?.kind).toBe('restore-live')
  })

  it('NEGATIVE — the documented snapshot shape is not a finding, in either half of the recipe', () => {
    const found = site([
      "import * as configStorage from '../../config/storage.ts';",
      'const realStorage = { ...configStorage };',
      "mock.module('../../config/storage.ts', () => ({ ...realStorage, getLlmConnection: () => null }));",
      "afterAll(() => { mock.module('../../config/storage.ts', () => realStorage) });",
    ])

    expect(found.map(found_ => found_.kind)).toEqual(['snapshot', 'restore-snapshot'])
  })

  it('NEGATIVE — a spread of an inline `await import` is priced as live-spread and NOT failed', () => {
    // Correct at mock time: a spread copies the values as they are then. Only
    // the RESTORE is wrong, which is why this kind exists separately.
    const found = site(["mock.module('x', () => ({ ...(await import('x')), f: () => 1 }));"])

    expect(found).toHaveLength(1)
    expect(found[0]?.kind).toBe('live-spread')
  })

  it('a factory that is an object literal with no spread is `narrow` — priced, never a finding', () => {
    const found = site(["mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: () => ({}) }));"])

    expect(found).toHaveLength(1)
    expect(found[0]?.kind).toBe('narrow')
  })

  it('a hand-built stub object handed back by name is NOT a live namespace', () => {
    // `SessionMenu.test.tsx` does this four times. A passthrough of a fabricated
    // object is a narrow stub, not a handle on the mutated namespace.
    const found = site([
      'const statusConfigMock = { getStatus: () => null };',
      "mock.module('@/config/session-status-config', () => statusConfigMock);",
    ])

    expect(found).toHaveLength(1)
    expect(found[0]?.kind).toBe('unresolved')
  })

  it('does not take `mock.module` when it is the tail of a longer identifier', () => {
    expect(site(["myMock.modulexyz('a', () => b)"])).toEqual([])
  })
})

/**
 * F1.133 (origin D1.442-A) — the pdfjs `?url` recipe's FOURTH rule: a static
 * import is hoisted above every statement of the module body, so a top-level
 * `mock.module` cannot beat a STATIC import in the same file, wherever the
 * import is written. `MarketplaceComponents.test.tsx` carried all three stubs
 * and the polyfill and was still red ALONE for its whole life; at `47c70c7ee` it
 * had nine static value imports written below its stubs (re-read 2026-09-23 with
 * `git show`, archive ref only — which is why the arm below plants its shape
 * instead of reading history).
 */
describe('importsBelowTopLevelMock (F1.133)', () => {
  const below = (lines: readonly string[]) => importsBelowTopLevelMock(lines.join('\n')).map(hit => hit.line)

  it('POSITIVE — the MarketplaceComponents shape: static value imports written below a top-level stub', () => {
    expect(below([
      "import { describe, it } from 'bun:test'",
      "mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))",
      "mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: {} }))",
      "import { MarketplaceBrowseCard } from '@/components/marketplace/MarketplaceBrowseCard'",
      'import {',
      '  MarketplaceBrowsePage,',
      '  type MarketplaceBrowseSection,',
      "} from '@/components/marketplace/MarketplaceBrowsePage'",
      "import * as ns from './x'",
      "import './side-effect'",
    ])).toEqual([4, 5, 9, 10])
  })

  it('NEGATIVE — type-only imports, the dynamic-import fix, imports above, and a mock inside a hook are not findings', () => {
    expect(below([
      "import { a } from './above'",
      "mock.module('x', () => ({ f: () => 1 }))",
      "import type { T } from './types'",
      "import { type A, type B } from './types'",
      "const { C } = await import('./after-the-mock')",
      'beforeAll(() => {',
      "  mock.module('y', () => ({}))",
      '})',
    ])).toEqual([])
    // No top-level mock at all: an import anywhere is ordinary.
    expect(below([
      'beforeAll(() => {',
      "  mock.module('y', () => ({}))",
      '})',
      "import { late } from './late'",
    ])).toEqual([])
  })

  it('NEGATIVE — a commented-out or quoted `mock.module(` at the start of a line opens no region', () => {
    expect(below([
      "// mock.module('dead', () => ({}))",
      '/*',
      "mock.module('in-a-block-comment', () => ({}))",
      '*/',
      'const doc = `',
      "mock.module('in-a-template', () => ({}))",
      '`',
      "import { fine } from './fine'",
    ])).toEqual([])
  })
})

/**
 * F1.134 (origin D1.442-B) — the priced `narrow` class split by specifier kind.
 * Three narrow stubs of FIRST-PARTY modules with no restore cost four chunk-level
 * CI reds and 56 pollution failures (D1.440-B, D1.442), so a narrow stub of a
 * first-party module in a file that SHARES a process is now a ratcheted finding.
 * What stays priced, by the row's own CONTROL: a package (`pdfjs-dist` and its
 * worker, `electron`, `node:*`), the app's `logger`, and anything in an
 * `.isolated.ts` file — `test:isolated` runs one process per file, so its stubs
 * cannot reach another file.
 */
describe('narrow stubs split by specifier kind (F1.134)', () => {
  const narrow = (file: string, specifier: string) =>
    findMockModuleSites(file, `mock.module('${specifier}', () => ({ only: () => 1 }))`)[0]!

  it('names a specifier a PACKAGE or FIRST-PARTY by how it resolves', () => {
    for (const specifier of ['pdfjs-dist', 'pdfjs-dist/build/pdf.worker.min.mjs?url', 'electron', 'node:fs', 'react-pdf', 'bun:test']) {
      expect(`${specifier} -> ${narrowOrigin(specifier)}`).toBe(`${specifier} -> package`)
    }
    for (const specifier of ['../logger', './x.ts', '@/context/ThemeContext', '@nessy-agent/shared/sources', '/abs/path']) {
      expect(`${specifier} -> ${narrowOrigin(specifier)}`).toBe(`${specifier} -> first-party`)
    }
  })

  it('POSITIVE — a narrow first-party stub in a shared-process test file is a finding', () => {
    expect(isNarrowFirstPartyFinding(narrow('a.test.tsx', '@/context/ThemeContext'))).toBe(true)
    expect(isNarrowFirstPartyFinding(narrow('a.test.ts', '../../config/preferences.ts'))).toBe(true)
  })

  it('NEGATIVE — the row\'s three controls stay priced, and so does an .isolated.ts file and a spread', () => {
    for (const specifier of ['pdfjs-dist', 'pdfjs-dist/build/pdf.worker.min.mjs?url', 'electron', '../logger', '../../logger.ts']) {
      expect(`${specifier}: ${isNarrowFirstPartyFinding(narrow('a.test.ts', specifier))}`).toBe(`${specifier}: false`)
    }
    expect(isNarrowFirstPartyFinding(narrow('a.isolated.ts', '../notifications'))).toBe(false)
    // A name that merely ENDS in "logger" is not the logger.
    expect(isNarrowFirstPartyFinding(narrow('a.test.ts', '../event-logger.ts'))).toBe(true)
    const spread = findMockModuleSites('a.test.ts', [
      "import * as theme from '@/context/ThemeContext'",
      'const real = { ...theme }',
      "mock.module('@/context/ThemeContext', () => ({ ...real, useTheme: () => ({}) }))",
    ].join('\n'))[0]!
    expect(spread.kind).toBe('snapshot')
    expect(isNarrowFirstPartyFinding(spread)).toBe(false)
  })

  it('on the REAL tree, the three controls are present as narrow stubs and none of them is a finding', () => {
    const sites = candidateFiles().flatMap(file => findMockModuleSites(file, readFileSync(join(REPO_ROOT, file), 'utf-8')))
    const narrowSites = sites.filter(entry => entry.kind === 'narrow')
    for (const control of [/^pdfjs-dist$/, /^electron$/, /(^|\/)logger(\.ts)?$/]) {
      const present = narrowSites.filter(entry => control.test(entry.specifier))
      expect(`${String(control)}: ${present.length > 0}`).toBe(`${String(control)}: true`)
      expect(present.filter(isNarrowFirstPartyFinding).map(entry => `${entry.file}:${entry.line}`)).toEqual([])
    }
  })
})

describe('codeTokenOffsets', () => {
  // The first draft searched the raw text and counted SEVEN extra sites in this
  // tree, every one a commented-out `mock.module(` call, all of them landing in
  // the `narrow` population the guard PRICES. A priced number that counts
  // commented-out code is a number nobody can act on.
  it('does not take a commented-out call — the measured miss, in both comment shapes', () => {
    const found = site([
      "// mock.module('dead', () => ({ a: 1 }));",
      '/*',
      " * mock.module('also-dead', () => ({ b: 2 }));",
      ' */',
      "mock.module('alive', () => ({ c: 3 }));",
    ])

    expect(found).toHaveLength(1)
    expect(found[0]?.specifier).toBe('alive')
    expect(found[0]?.line).toBe(5)
  })

  it('does not take an occurrence inside a string or a template literal', () => {
    const text = 'const doc = "mock.module(x)"; const t = `mock.module(y)`; mock.module(z)'
    expect(codeTokenOffsets(text, 'mock.module')).toEqual([text.lastIndexOf('mock.module')])
  })
})

describe('classifyCapture', () => {
  it('separates the three resolutions the finding turns on', () => {
    expect(classifyCapture('const real = { ...ns };', 'real')).toBe('snapshot')
    expect(classifyCapture("const real = await import('x');", 'real')).toBe('live')
    expect(classifyCapture("import * as real from 'x';", 'real')).toBe('live')
    // A hand-built object and an unknown name are both "not a live handle", and
    // neither is a finding — the guard reports them as `unresolved` rather than
    // guessing, so it cannot quietly under-report.
    expect(classifyCapture('const real = { a: 1 };', 'real')).toBe('unknown')
    expect(classifyCapture('const other = 1;', 'real')).toBe('unknown')
  })

  it('an alias of a namespace import is live, an alias of anything else is not', () => {
    expect(classifyCapture("import * as ns from 'x';\nconst real = ns;", 'real')).toBe('live')
    expect(classifyCapture('const fake = 1;\nconst real = fake;', 'real')).toBe('unknown')
  })
})

describe('staleBaselineEntries', () => {
  it('reports a baselined file that is no longer a finding, sorted and deduped', () => {
    expect(staleBaselineEntries(['b.ts', 'a.ts', 'b.ts'], ['b.ts'])).toEqual(['a.ts'])
  })

  it('NEGATIVE — says nothing when every entry is still a finding, and a NEW finding is not stale', () => {
    expect(staleBaselineEntries(['a.ts'], ['a.ts', 'fresh.ts'])).toEqual([])
  })
})

describe('the subject exists', () => {
  it('the narrative this guard enforces is still in the traps spec', () => {
    // A guard whose recorded reason has been deleted is a rule nobody agreed to,
    // and `main` refuses rather than running. This is the same assertion, so the
    // refusal cannot be reached only in production.
    expect(readFileSync(join(REPO_ROOT, TRAPS_SPEC), 'utf-8')).toContain(TRAPS_SECTION)
  })

  it('every baselined file is still a test file in scope — and today the baseline is EMPTY', () => {
    const inScope = new Set(testFiles())
    const baseline = readBaseline()
    // The loop is vacuous ON PURPOSE since P6.982 converted all three original
    // entries: the gate is a zero-tolerance pin now. `inScope` carries the
    // vacuity assertion instead, because an empty DENOMINATOR is the reading
    // that would make this control meaningless — an empty baseline is the goal.
    expect(inScope.size).toBeGreaterThan(0)
    for (const file of baseline) {
      expect(inScope.has(file) ? file : `${file} is baselined and is no longer in scope`).toBe(file)
    }
  })

  it('the baseline keeps a preamble, so `--update-baseline` has something to preserve', () => {
    expect(readFileSync(join(REPO_ROOT, BASELINE_FILE), 'utf-8').startsWith('#')).toBe(true)
  })

  it('every RATCHET line names a known kind and a test file still in scope (F1.133)', () => {
    const inScope = new Set(testFiles())
    // The vacuity control is the DENOMINATOR, as above: an empty ratchet is the
    // end state it is walking towards, not a broken read.
    expect(inScope.size).toBeGreaterThan(0)
    expect(readFileSync(join(REPO_ROOT, RATCHET_BASELINE_FILE), 'utf-8').startsWith('#')).toBe(true)
    for (const entry of readRatchetBaseline()) {
      const [kind, file, ...extra] = entry.split(' ')
      expect(extra).toEqual([])
      expect(RATCHET_KINDS as readonly string[]).toContain(kind as string)
      expect(inScope.has(file as string) ? file : `${String(file)} is ratcheted and no longer in scope`).toBe(file)
    }
  })
})

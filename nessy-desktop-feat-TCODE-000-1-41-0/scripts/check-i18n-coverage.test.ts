import { describe, expect, it } from 'bun:test'

import {
  compareToBaseline,
  extractRefs,
  findMissing,
  formatMissing,
  isResolved,
  isScannedPath,
  KNOWN_MISSING,
  scannedFiles,
} from './check-i18n-coverage'

/**
 * UA1.11 — the ported i18n coverage gate. The positive arm (a literal key that
 * exists passes) and the negative arm (a missing key fails, naming the file AND
 * the line) run through the same pure `findMissing` the gate's `main` runs, over
 * texts that stand in for the blobs it reads, so neither arm needs git.
 */
const EN = new Set(['common.save', 'chat.items_one', 'chat.items_other', 'common.select'])

describe('check-i18n-coverage', () => {
  it('passes a file whose literal keys all exist (and the plural base through _one + _other)', () => {
    const texts = new Map([
      ['apps/electron/src/renderer/A.tsx', "const a = t('common.save')\nconst b = t(\"chat.items\", { count: 2 })\n"],
    ])
    const result = findMissing(texts, EN)
    expect(result.totalRefs).toBe(2)
    expect(result.missing).toEqual([])
  })

  it('fails a missing key and names the file and the line of its first reader', () => {
    const texts = new Map([
      ['packages/ui/src/B.tsx', "import x from 'y'\n\nexport const B = () => t('common.gone')\n"],
      ['packages/ui/src/C.tsx', "i18n.t('common.gone')\n<Trans i18nKey=\"also.gone\" />\n"],
    ])
    const { missing } = findMissing(texts, EN)
    expect(missing).toEqual([
      { file: 'packages/ui/src/B.tsx', line: 3, key: 'common.gone' },
      { file: 'packages/ui/src/C.tsx', line: 2, key: 'also.gone' },
    ])
    const report = formatMissing(missing, false).join('\n')
    expect(report).toContain('packages/ui/src/B.tsx:3\n  → common.gone')
    expect(report).toContain('2 missing key(s)')
  })

  it('reads no key out of a comment, a template literal or a dotted call', () => {
    const text = [
      "// t('in.a.line.comment')",
      "/** renders t('in.a.docblock') once */",
      'const dynamic = t(`chat.${id}`)',
      "const other = obj.t('not.a.bare.call')",
      "const real = t('common.save')",
    ].join('\n')
    expect(extractRefs('f.ts', text)).toEqual([{ file: 'f.ts', line: 5, key: 'common.save' }])
  })

  it('needs BOTH plural forms for a base key', () => {
    expect(isResolved('chat.items', EN)).toBe(true)
    expect(isResolved('chat.items', new Set(['chat.items_one']))).toBe(false)
  })

  it('splits a run against the baseline: unrecorded is fresh, a recorded key no longer missing is stale', () => {
    const baseline = new Map([['old.key', 'reason'], ['kept.key', 'reason']])
    const verdict = compareToBaseline(
      [{ file: 'a.ts', line: 1, key: 'kept.key' }, { file: 'b.ts', line: 2, key: 'new.key' }],
      baseline,
    )
    expect(verdict.fresh.map(ref => ref.key)).toEqual(['new.key'])
    expect(verdict.stale).toEqual(['old.key'])
    expect(formatMissing(verdict.fresh, false, verdict.stale).join('\n')).toContain('stale KNOWN_MISSING entry: old.key')
    // Every recorded entry carries its reason.
    for (const reason of KNOWN_MISSING.values()) expect(reason.length).toBeGreaterThan(20)
  })

  it("keeps upstream's exclusions and our roots", () => {
    expect(isScannedPath('apps/electron/src/renderer/components/X.tsx')).toBe(true)
    expect(isScannedPath('apps/webui/src/App.tsx')).toBe(true)
    expect(isScannedPath('apps/electron/src/renderer/components/__tests__/X.tsx')).toBe(false)
    expect(isScannedPath('apps/electron/src/renderer/playground/X.tsx')).toBe(false)
    expect(isScannedPath('packages/ui/src/registry/X.tsx')).toBe(false)
    expect(isScannedPath('packages/shared/src/x.test.ts')).toBe(false)
    expect(isScannedPath('packages/shared/src/x.d.ts')).toBe(false)
    expect(isScannedPath('packages/server-core/src/x.ts')).toBe(false)
    expect(isScannedPath('apps/electron/src/x.json')).toBe(false)
  })

  it('enumerates the tracked tree, not nothing', () => {
    // The anti-vacuum control on the enumeration the gate runs: a pathspec that
    // stopped matching would make every run an empty green. A floor, not a count
    // (1 466 files on 2026-10-02).
    const files = scannedFiles()
    expect(files.length).toBeGreaterThan(500)
    expect(files).toContain('apps/electron/src/renderer/components/ServerDirectoryBrowser.tsx')
    expect(files.every(isScannedPath)).toBe(true)
  })
})

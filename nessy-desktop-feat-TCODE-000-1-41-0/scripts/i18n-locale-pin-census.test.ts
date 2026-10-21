/**
 * F1.283 — the locale census's pure halves: which file is a candidate, whether it pins, and
 * which files a `bun test` run failed. The half that runs suites (`--run`, `--control`) costs
 * minutes and goes through the test lock, so it is the script's own run, recorded in the row;
 * these arms keep the parsing honest without it.
 */
import { describe, expect, it } from 'bun:test'
import { isAbsolute } from 'node:path'
import { classify, englishFragments, failingFiles, russianPreloadSource, separateVictims } from './i18n-locale-pin-census.ts'

const fragments = englishFragments(
  { 'a.long': 'Nothing was disabled for this session', 'b.same': 'Identical in both locales', 'c.short': 'Short one' },
  { 'a.long': 'Ничего не было отключено', 'b.same': 'Identical in both locales', 'c.short': 'Коротко' },
)

describe('i18n-locale-pin-census (F1.283)', () => {
  it('matches English copy only on an assertion line, and only copy that differs in Russian', () => {
    expect([...fragments.keys()]).toEqual(['Nothing was disabled for this session'])
    const asserting = "expect(text).toContain('Nothing was disabled for this session')"
    expect(classify('x.test.ts', asserting, fragments)).toEqual({ file: 'x.test.ts', keys: ['a.long'], pinned: false })
    expect(classify('y.test.ts', "const note = 'Nothing was disabled for this session'", fragments)).toBeNull()
  })

  it('a file that pins a language in a hook is marked pinned', () => {
    const source = "beforeAll(async () => { await i18n.changeLanguage('en') })\nexpect(t).toBe('Nothing was disabled for this session')"
    expect(classify('z.test.ts', source, fragments)?.pinned).toBe(true)
  })

  it('reads failing FILES from the per-file headers, and stops at bun\'s end-of-run reprint', () => {
    const output = [
      'packages/a/one.test.ts:',
      '(pass) one > works',
      'packages/b/two.test.ts:',
      "error: expect(received).toBe(expected)(fail) two > glued onto the dump",
      '(fail) two > plain',
      'packages/c/three.test.ts:',
      '(pass) three > works',
      '',
      '2 tests failed:',
      '(fail) two > glued onto the dump',
      '(fail) two > plain',
    ].join('\n')
    // The reprint block would otherwise attribute both failures to the LAST header (three).
    expect(failingFiles(output)).toEqual(['packages/b/two.test.ts'])
  })

  it('a file red WITHOUT the preload too is not a victim — a neighbour\'s mid-edit red reads like one', () => {
    expect(separateVictims(['a.test.ts', 'b.test.ts'], ['b.test.ts'])).toEqual({ victims: ['a.test.ts'], redRegardless: ['b.test.ts'] })
    expect(separateVictims(['a.test.ts'], [])).toEqual({ victims: ['a.test.ts'], redRegardless: [] })
  })

  it('the preload imports only ABSOLUTE paths — it is written to a temp dir, where a bare specifier resolves elsewhere', () => {
    const specifiers = [...russianPreloadSource().matchAll(/^import .* from (".*")$/gm)].map(match => JSON.parse(match[1]!) as string)
    expect(specifiers.length).toBe(2)
    expect(specifiers.filter(specifier => !isAbsolute(specifier))).toEqual([])
    expect(specifiers.some(specifier => specifier.includes('/node_modules/react-i18next/'))).toBe(true)
  })
})

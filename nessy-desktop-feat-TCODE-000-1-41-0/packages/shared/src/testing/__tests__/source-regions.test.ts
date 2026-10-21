/**
 * D1.111 — the guard for the brace matcher the converted suites now depend on.
 *
 * Nine test files stopped bounding their source reads with a character count and
 * started bounding them with {@link bracedRegion}. That moves the failure mode
 * rather than removing it: a matcher that ran away would return the rest of the
 * file and make every POSITIVE assertion in those suites pass for a match
 * anywhere in the module — silently, which is worse than the windows it
 * replaced. Each caller carries its own boundary control for that; this file
 * pins the matcher itself, so the nine controls are not the only thing standing
 * between a bug here and nine vacuously green suites.
 */
import { describe, expect, it } from 'bun:test'
import { bracedRegion } from '../source-regions.ts'

// One fixture with the three shapes the callers actually read: a method body, a
// NESTED block inside it, and a sibling that must stay outside every region.
const SOURCE = [
  'class Example {',
  '  private first(a: string): void {',
  '    if (a) {',
  '      this.inner()',
  '    }',
  '    this.tail()',
  '  }',
  '',
  '  private second(): void {',
  '    this.other()',
  '  }',
  '}',
].join('\n')

describe('bracedRegion', () => {
  it('returns the declaration through its own closing brace, nesting included', () => {
    const region = bracedRegion(SOURCE, SOURCE.indexOf('private first('))
    expect(region).toContain('this.inner()')
    expect(region).toContain('this.tail()')
    expect(region.endsWith('}')).toBe(true)
  })

  it('STOPS at that brace — the whole point, and the one failure the callers cannot see', () => {
    // The negative half. A matcher that counted only the FIRST `}` would stop at
    // the nested block and lose `this.tail()`; one that never balanced would run
    // to the end of the file and swallow `second`. Both are asserted, because
    // the two bugs fail in opposite directions and one case cannot catch both.
    const region = bracedRegion(SOURCE, SOURCE.indexOf('private first('))
    expect(region).not.toContain('private second(')
    expect(region).not.toContain('this.other()')
  })

  it('takes the first `{` at or after the anchor, so a declaration line is a valid anchor', () => {
    // `const x = async (\n  a: string,\n): Promise<void> => {` — the callers'
    // other shape, where the anchor is many characters and one newline above the
    // brace that opens the body.
    const arrow = 'const run = async (\n  a: string,\n): Promise<void> => {\n  use(a)\n}\nconst after = 1'
    const region = bracedRegion(arrow, arrow.indexOf('const run'))
    expect(region).toContain('use(a)')
    expect(region).not.toContain('const after = 1')
  })

  it('REFUSES rather than returning something plausible', () => {
    // Each of the three is a real caller mistake: an `indexOf` that missed
    // (which is why every caller also asserts its anchor), an anchor past the
    // last block, and a truncated read.
    expect(() => bracedRegion(SOURCE, -1)).toThrow('the anchor was not found')
    expect(() => bracedRegion(SOURCE, SOURCE.length - 1)).toThrow('no `{`')
    expect(() => bracedRegion('function a() { if (b) {', 0)).toThrow('unbalanced braces')
  })
})

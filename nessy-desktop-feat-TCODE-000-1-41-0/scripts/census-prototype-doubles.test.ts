/**
 * D1.274 — the census can tell a SITE from a comment about one, which is the
 * whole row: the naive grep answered 51 after nine conversions had taken the
 * real population from 46 to 38.
 */
import { describe, expect, test } from 'bun:test'
import { census, isCommentLine } from './census-prototype-doubles.ts'

describe('D1.274 · the prototype-double census', () => {
  test('a comment mentioning the phrase is not a site', () => {
    expect(isCommentLine(' * a bare prototype double — Object.create(SessionManager.prototype)')).toBe(true)
    expect(isCommentLine('  // replaced Object.create(SessionManager.prototype)')).toBe(true)
    expect(isCommentLine('  /* Object.create(SessionManager.prototype) */')).toBe(true)
    // The site itself, in every shape it is actually written in.
    expect(isCommentLine('  const manager = Object.create(SessionManager.prototype) as SessionManager')).toBe(false)
    expect(isCommentLine('const m = Object.create(SessionManager.prototype)')).toBe(false)
  })

  test('the two readings are reported separately, and the instrument can see the tree', () => {
    const result = census()
    // The positive control FIRST: a census that matched nothing would satisfy
    // every relation below, which is how an absence reading disarms itself.
    expect(result.lines.length).toBeGreaterThan(0)
    expect(result.codeSites).toBeGreaterThan(0)
    expect(result.codeFiles).toBeGreaterThan(0)
    // No number is pinned, on purpose — the population is MEANT to fall as
    // D1.242 converts files, and a pin here would redden on every conversion.
    expect(result.codeSites + result.commentLines.length).toBe(result.lines.length)
    expect(result.codeFiles).toBeLessThanOrEqual(result.codeSites)
  })
})

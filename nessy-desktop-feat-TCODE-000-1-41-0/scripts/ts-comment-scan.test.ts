/**
 * Tests for `ts-comment-scan.ts` — P2.492.
 *
 * Two of these pin cases that a first version of the module got wrong against
 * this very repo, which is why they are here rather than in the gate's suite:
 * an escaped slash inside a regular expression, and an apostrophe in JSX text.
 * Both made the scanner lose its place and then report a confident finding
 * dozens of lines away.
 */

import { describe, expect, test } from 'bun:test'

import { blankComments, blockComments, scanSpans, slashStartsRegex, unterminatedSpans } from './ts-comment-scan'

/** Built at runtime so this file never contains the sequence in its own prose. */
const STAR = '*'
const OPEN = `/${STAR}`
const CLOSE = `${STAR}/`

describe('ts-comment-scan', () => {
  test('a path pattern inside a block comment ends it early', () => {
    const src = `/${STAR}${STAR}\n * scans packages/${STAR}/package.json\n ${CLOSE}\nconst a = 1\n`

    const comments = blockComments(src)
    expect(comments).toHaveLength(1)
    // The comment stops at the glob's own slash, not at the closer the author
    // wrote — everything after it is code, which is the whole defect.
    expect(src.slice(comments[0]!.end)).toStartWith('package.json')
  })

  test('the same sequence inside a string is not a comment at all', () => {
    const src = `const globs = ['packages/${STAR}/package.json', 'apps/${STAR}/package.json']\n`

    expect(blockComments(src)).toEqual([])
    expect(blankComments(src)).toBe(src)
  })

  test('an escaped slash in a regex does not open a line comment', () => {
    // Measured: `check-exports-map.ts` line 313. Without regex support the two
    // adjacent slashes read as `//`, the rest of the line vanished, and the
    // scanner reported an unterminated block comment sixty lines later.
    const src = "const t = target.replace(/^\\.\\//, '')\nconst after = 1\n"

    expect(unterminatedSpans(src)).toEqual([])
    expect(blankComments(src)).toBe(src)
  })

  test('a slash after a value divides, after an operator it opens a pattern', () => {
    expect(slashStartsRegex('a / b', 2)).toBe(false)
    expect(slashStartsRegex('f() / 2', 4)).toBe(false)
    expect(slashStartsRegex('x = /re/', 4)).toBe(true)
    expect(slashStartsRegex('return /re/.test(s)', 7)).toBe(true)
  })

  test('an apostrophe in JSX text is not a string', () => {
    // Two files in this repo open with one of these; before the recovery branch
    // they were the only source the scanner could not read.
    const src = '<p>I\'ll explore the codebase</p>\nconst after = 1\n'

    expect(unterminatedSpans(src)).toEqual([])
    expect(blankComments(src)).toBe(src)
  })

  test('a string may still carry a backslash-newline continuation', () => {
    const src = "const s = 'abc\\\ndef'\nconst after = 1\n"

    expect(unterminatedSpans(src)).toEqual([])
  })

  test('blanking keeps length and line numbers', () => {
    const src = `const a = 1 // note\n/${STAR} block ${CLOSE}\nconst b = 2\n`
    const blanked = blankComments(src)

    expect(blanked.length).toBe(src.length)
    expect(blanked.split('\n').length).toBe(src.split('\n').length)
    expect(blanked).toContain('const a = 1')
    expect(blanked).not.toContain('note')
    expect(blanked).not.toContain('block')
  })

  test('a nested template interpolation does not lose its place', () => {
    const src = 'const s = `a ${b(`c ${d} e`)} f`\nconst after = 1\n'

    expect(unterminatedSpans(src)).toEqual([])
    expect(scanSpans(src).map((s) => src.slice(s.start, s.end)).join('')).toBe(src)
  })

  test('spans are contiguous and reproduce the input', () => {
    const src = `${OPEN}${STAR} doc ${CLOSE}\nconst a = 'x' // t\nconst b = \`y \${a} z\`\n`
    const spans = scanSpans(src)

    let cursor = 0
    for (const span of spans) {
      expect(span.start).toBe(cursor)
      cursor = span.end
    }
    expect(cursor).toBe(src.length)
  })

  test('an empty block comment is a comment and nothing more', () => {
    const src = `${OPEN}${CLOSE}\nconst a = 1\n`

    expect(blockComments(src)).toHaveLength(1)
    expect(unterminatedSpans(src)).toEqual([])
  })
})

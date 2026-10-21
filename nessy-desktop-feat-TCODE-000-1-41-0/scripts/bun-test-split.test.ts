/**
 * Tests for `bun-test-split.ts` — P2.246.
 *
 * The defect was arithmetic, not tooling: a report said "86 pass / 0 fail" for
 * a run bun had described as `83 pass / 3 skip / 86 ran`. `Ran N` is the sum,
 * so the number that reads most like a pass count is the one that is not one.
 *
 * The parsing and the rendering are pure, so they are pinned directly. The
 * fixture below is bun's own JUnit output, kept verbatim rather than
 * paraphrased — including the `message="TODO"` attribute that is the only thing
 * separating a `test.todo` from a `test.skip`.
 */

import { describe, expect, test } from 'bun:test'

import { parseJUnit, renderSplit } from './bun-test-split.ts'

const BUN_JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" assertions="1" failures="1" skipped="2" time="1.83">
  <testsuite name="a.test.ts" file="a.test.ts" tests="3" failures="1" skipped="2" time="0">
    <testcase name="one passes" classname="" time="0.00004" file="a.test.ts" line="2" assertions="1" />
    <testcase name="the bundled binary is signed" classname="" time="0" file="a.test.ts" line="3" assertions="0">
      <skipped />
    </testcase>
    <testcase name="three is a todo" classname="" time="0" file="a.test.ts" line="4" assertions="0">
      <skipped message="TODO" />
    </testcase>
  </testsuite>
  <testsuite name="b.test.ts" file="b.test.ts" tests="1" failures="1" skipped="0" time="0">
    <testcase name="four fails" classname="" time="0.1" file="b.test.ts" line="9" assertions="1">
      <failure message="expected 1 to be 2" />
    </testcase>
  </testsuite>
</testsuites>`

describe('parseJUnit', () => {
  test('separates pass, skip, todo and fail', () => {
    const cases = parseJUnit(BUN_JUNIT)
    expect(cases).toHaveLength(4)
    expect(cases.map((c) => c.state)).toEqual(['pass', 'skip', 'todo', 'fail'])
  })

  test('keeps the file each case came from, so a skip can be chased', () => {
    const skipped = parseJUnit(BUN_JUNIT).find((c) => c.state === 'skip')
    expect(skipped?.file).toBe('a.test.ts')
    expect(skipped?.name).toBe('the bundled binary is signed')
  })
})

describe('renderSplit', () => {
  const lines = renderSplit(parseJUnit(BUN_JUNIT)).join('\n')

  test('states the split, and says outright that `Ran N` is not a pass count', () => {
    expect(lines).toContain('1 pass / 1 skip / 1 todo / 1 fail — 4 ran across 2 files.')
    expect(lines).toContain('not a pass count')
  })

  test('NAMES what was skipped — the row turned on which tests those were', () => {
    // The three skips in the original report gated on a gitignored binary, i.e.
    // they were exactly the tests guarding the assumption being reported on.
    expect(lines).toContain('skip  a.test.ts — the bundled binary is signed')
    expect(lines).toContain('todo  a.test.ts — three is a todo')
    expect(lines).toContain('property of THIS')
  })

  test('says nothing about skips when there are none', () => {
    const clean = renderSplit(parseJUnit(
      '<testsuites><testsuite name="c" file="c.test.ts">' +
      '<testcase name="ok" file="c.test.ts" />' +
      '</testsuite></testsuites>',
    )).join('\n')

    expect(clean).toContain('1 pass / 0 skip / 0 todo / 0 fail — 1 ran across 1 files.')
    expect(clean).not.toContain('asserted nothing')
  })
})

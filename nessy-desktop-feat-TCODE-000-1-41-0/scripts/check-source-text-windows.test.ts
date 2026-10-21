/**
 * Tests for `check-source-text-windows.ts` — D1.241.
 *
 * The positive controls run over a SCRATCH directory rather than over the repo,
 * for the reason AGENTS.md gives about mutation harnesses: a control that plants
 * a window in the real tree has to restore it exactly, and a restore that misses
 * silently invalidates every later verdict. `census({ noIndex, root })` exists
 * for that and for nothing else.
 *
 * The real-tree arm is deliberately the WEAK one — "the probe can see something"
 * — and carries NO number. A declared count here would be a second ratchet
 * beside `PINNED_CENSUS`, and it would go red the moment a sibling lane writes a
 * source-text test, which is the cry-wolf shape AGENTS.md records wave 17 paying
 * for six times. The same reason the sibling gate's test says so.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  census,
  PINNED_CENSUS,
  SCAN_BOUND_PATTERN,
  SLACK_ALLOWANCE,
  slackExceeded,
  TEST_PATHSPEC,
  verdict,
  WIDE_PATHSPEC,
  WINDOW_PATTERN,
} from './check-source-text-windows'

function scratch(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'source-text-windows-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body, 'utf-8')
  return root
}

describe('check-source-text-windows', () => {
  test('counts every window, not every line', () => {
    const root = scratch({
      'a.test.ts': [
        "const body = src.slice(start, start + 2_000)",
        "const x = a.slice(i, i + 1600); const y = b.slice(j, j + 400)",
      ].join('\n'),
    })
    try {
      const result = census({ noIndex: true, root })
      // Three windows over two lines — the whole reason the instrument counts
      // OCCURRENCES: a line count would have answered 2.
      expect(result.occurrences).toBe(3)
      expect(result.files).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the three-digit floor holds: a two-character read is not a window', () => {
    const root = scratch({
      'b.test.ts': [
        // NEGATIVE: ordinary string arithmetic, which is most of what `slice`
        // is used for. Counting these would bury the population.
        'const pair = s.slice(i, i + 2)',
        'const nibble = s.slice(at, at + 64)',
        // POSITIVE, on the same instrument in the same file, so the zero above
        // is the floor working and not the probe failing to read the file.
        'const region = s.slice(at, at + 100)',
      ].join('\n'),
    })
    try {
      expect(census({ noIndex: true, root }).occurrences).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('`bracedRegion(src, at)` is not a window — the conversion makes the count fall', () => {
    const root = scratch({
      'c.test.ts': [
        'const body = bracedRegion(src, src.indexOf(NEEDLE))',
        "expect(body).not.toContain('theNextDeclaration(')",
      ].join('\n'),
    })
    try {
      expect(census({ noIndex: true, root }).occurrences).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('D1.289 — a window bounding a REGEX SCAN leaves the gated count, in both directions', () => {
    const root = scratch({
      'd.test.ts': [
        // The two scan shapes. The region each means is bounded by the
        // pattern's own captures, so the number cannot rot in either direction.
        'const hit = pattern.exec(text.slice(windowStart, at + 512))',
        'const all = text.slice(at, at + 256).match(/x/)',
        // POSITIVE CONTROL on the same instrument in the same file: an ordinary
        // region window, so the two zeros above are the shape being recognised
        // and not the probe failing to read the file.
        'const region = text.slice(callIndex, callIndex + 400)',
      ].join('\n'),
    })
    try {
      const result = census({ noIndex: true, root })
      expect(result.scanBounds).toBe(2)
      expect(result.windows).toHaveLength(3)
      expect(result.occurrences).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('D1.289 — the scan shape is ERE, and a `slice` that is merely NEAR an exec still counts', () => {
    // The boundary. `(?:…)` is a PCRE non-capturing group and `git grep -E` is
    // POSIX extended, where it is not one — a pattern written that way would
    // match nothing and silently subtract zero forever.
    expect(SCAN_BOUND_PATTERN).not.toContain('(?:')
    const root = scratch({
      'e.test.ts': [
        // Not a scan bound: the window is a REGION and the exec is its own
        // call on the next line. Subtracting this would hide a convertible site.
        'const region = text.slice(at, at + 400)',
        'const hit = pattern.exec(region)',
      ].join('\n'),
    })
    try {
      const result = census({ noIndex: true, root })
      expect(result.scanBounds).toBe(0)
      expect(result.occurrences).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the pinned scope is TEST files and the wide scope is not — and both carry `:(glob)`', () => {
    // Load-bearing, and the reason is a measured trap rather than a preference:
    // a `**` pathspec handed to `git grep` WITHOUT `:(glob)` is read with no
    // glob magic and silently drops files, so a scope written the obvious way
    // would answer a smaller number that looks like an answer.
    for (const spec of TEST_PATHSPEC) expect(spec.startsWith(':(glob)')).toBe(true)
    expect(TEST_PATHSPEC.some(spec => spec.endsWith('*.test.tsx'))).toBe(true)
    expect(TEST_PATHSPEC.some(spec => spec.endsWith('*.isolated.ts'))).toBe(true)
    expect(WIDE_PATHSPEC).toEqual(['packages', 'apps'])
  })

  test('the pattern is D1.111\'s census regex, with the digit floor in it', () => {
    // A `[0-9]+` here would match `s.slice(i, i + 2)` and the gate would drown.
    expect(WINDOW_PATTERN).toContain('[0-9_]{3,}')
    expect(WINDOW_PATTERN).not.toContain('[0-9]+\\)')
  })

  test('the ratchet fails on a RISE and asks for a lower pin on a FALL', () => {
    // The gate's whole decision, tested without the repo's own count in it: a
    // suite that compared the live census against the pin would go red the
    // moment a sibling lane wrote a window, and that is a control that cannot
    // fail for the right reason.
    expect(verdict(36, 35)).toBe('rose')
    expect(verdict(35, 35)).toBe('unchanged')
    expect(verdict(34, 35)).toBe('fell')
    // And the default argument really is the pin, so the exported helper and
    // the gate cannot drift apart.
    expect(verdict(PINNED_CENSUS)).toBe('unchanged')
    expect(verdict(PINNED_CENSUS + 1)).toBe('rose')
  })

test('D1.275 — a pin the tree left behind is a FAILURE past the stated allowance', () => {
    // A ratchet only stops a rise, so a pin nobody lowers drifts upward in
    // silence and then tolerates that many new sites. Same shape as `verdict`
    // above: driven on numbers, never on the live census, so a sibling lane's
    // commit cannot make this case red for the wrong reason.
    expect(slackExceeded(35, 35)).toBe(false)
    expect(slackExceeded(34, 35)).toBe(false)
    // At the allowance it is still a reminder, not a red.
    expect(slackExceeded(33, 35)).toBe(false)
    expect(slackExceeded(32, 35)).toBe(true)
    // A RISE is the other gate's business and must not read as slack.
    expect(slackExceeded(36, 35)).toBe(false)
    // The default arguments really are the pin and the allowance, so the helper
    // and the gate cannot drift apart.
    expect(SLACK_ALLOWANCE).toBeGreaterThan(0)
    expect(slackExceeded(PINNED_CENSUS - SLACK_ALLOWANCE)).toBe(false)
    expect(slackExceeded(PINNED_CENSUS - SLACK_ALLOWANCE - 1)).toBe(true)
  })

  test('the real tree is scanned and the probe can see it', () => {
    // No number, on purpose — see this file's docblock. The pin is the ratchet;
    // this is only the control that the census is not vacuous, which is what
    // makes the script's own zero-refusal meaningful.
    expect(census().occurrences).toBeGreaterThan(0)
    expect(PINNED_CENSUS).toBeGreaterThan(0)
  })
})

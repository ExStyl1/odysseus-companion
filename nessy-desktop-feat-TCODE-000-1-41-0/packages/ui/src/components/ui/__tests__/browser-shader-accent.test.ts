/**
 * UB13.3 (R7-06) — BrowserShader reads `--accent-raw` (the theme accent as solved 8-bit hex)
 * and darkens it ×0.7 in JS; until this row it read the `--accent-rgb` triplet the theme no
 * longer emits (an invalid property CSS silently drops → the dithering fell back to blue).
 *
 * packages/ui has no RTL/jsdom harness, so the reader is guarded at source level and the row's
 * positive runs the REGEX LIFTED FROM THE SOURCE against `#336699` — the component's own
 * pattern, not a copy — plus the early-return lines that make an empty/non-hex value safe.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, '../BrowserShader.tsx'), 'utf8')

describe('BrowserShader accent (UB13.3: --accent-raw)', () => {
  it('positive: the source hex regex maps #336699 to [36, 71, 107] at the 0.7 darken', () => {
    expect(source).toContain("getPropertyValue('--accent-raw')")
    const lifted = source.match(/raw\.match\((\/\^#.*?\/[a-z]*)\)/)
    expect(lifted, 'the raw.match(/…/) literal').not.toBeNull()
    const re = new RegExp(lifted![1]!.slice(1, lifted![1]!.lastIndexOf('/')), lifted![1]!.slice(lifted![1]!.lastIndexOf('/') + 1))
    const match = '#336699'.match(re as RegExp)!
    expect(match).not.toBeNull()
    const [r, g, b] = match.slice(1).map((hex) => Math.round(parseInt(hex, 16) * 0.7))
    expect([r, g, b]).toEqual([36, 71, 107])
    expect(source).toContain('* 0.7')
  })

  it('negative: an empty or non-hex --accent-raw returns early — no colour, no throw', () => {
    // `if (!match) return` is the arm that leaves FALLBACK_COLOR in place for '' and non-hex
    expect(source).toContain('if (!match) return')
    // the removed triplet must not come back through the JS reader either
    expect(source).not.toContain('--accent-rgb')
  })
})

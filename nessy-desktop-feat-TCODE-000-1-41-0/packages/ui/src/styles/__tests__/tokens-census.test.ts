/**
 * UB13.2's CSS census (source-level) over the INERT token layer.
 *
 * tokens.css/base.css land 1:1 from v0.15.1 and are imported by nothing until
 * UB13.3 switches renderer/index.css over (`git grep -F 'styles/tokens.css'`
 * lists test files and the no-raw-palette-colors docblock only). Until then
 * this test is the files' only reader, so the census reads them as text.
 *
 * Positive: every token class the Phase 14–15 rows name is defined — plain
 * classes as selectors in base.css, Tailwind-generated utilities through their
 * `@theme` tokens in tokens.css. `in-data-compact` is the documented boundary:
 * it is Tailwind v4's native `in-` + `data-` composition (upstream v0.15.1
 * ships consumers — ChatHeader.tsx and five more — with NO definition in any
 * stylesheet), so the files must NOT define it; the arm pins that reading.
 *
 * Negative: no brand string anywhere, and no hard-coded hex outside the theme
 * blocks — tokens.css may carry hex only inside its `:root`/`.dark` blocks
 * (the default theme's solved values); base.css carries exactly the two
 * `linear-gradient(#fff 0 0)` mask lines of the `.shadow-panel-focused` ring
 * (an alpha mask, not a colour choice — upstream v0.15.1's own exception,
 * pinned here so any OTHER hex fails).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = import.meta.dir
const tokens = readFileSync(join(dir, '..', 'tokens.css'), 'utf-8')
const base = readFileSync(join(dir, '..', 'base.css'), 'utf-8')

/** Spans of the `:root {…}` / `.dark {…}` blocks (brace-matched), where theme hex may live. */
function themeBlockSpans(css: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const selector = /(?:^|\n)(:root|\.dark)(?:\s*,\s*(?:\.dark|:root))?\s*\{/g
  let m: RegExpExecArray | null
  while ((m = selector.exec(css)) !== null) {
    let depth = 1
    let i = m.index + m[0].length
    while (depth > 0 && i < css.length) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
      i++
    }
    spans.push([m.index, i])
    selector.lastIndex = i
  }
  return spans
}

describe('UB13.2 token census (inert add)', () => {
  it('defines the plain utility classes in base.css', () => {
    for (const cls of ['field-surface', 'popover-styled', 'motion-press', 'state-overlay', 'keycap']) {
      expect(base).toMatch(new RegExp('\\.' + cls + '(?![\\w-])'))
    }
  })

  it('defines the theme-generated utilities through their @theme tokens in tokens.css', () => {
    // bg-raised  ← --color-raised; text-label-sm ← --text-label-sm;
    // h-control  ← --spacing-control; shadow-elev-1 ← --shadow-elev-1.
    for (const token of ['--color-raised:', '--text-label-sm:', '--spacing-control:', '--shadow-elev-1:']) {
      expect(tokens).toContain(token)
    }
  })

  it('does not define in-data-compact (Tailwind-native in- + data- composition, boundary)', () => {
    expect(tokens).not.toMatch(/in-data-compact/)
    expect(base).not.toMatch(/in-data-compact/)
  })

  it('carries the rebranded headers (Nessy, default theme "Default"), never the upstream brand', () => {
    expect(tokens).toContain('Nessy design tokens')
    expect(tokens).toContain('default theme "Default"')
    expect(base).toContain('every Nessy UI')
    for (const css of [tokens, base]) {
      expect(css.toLowerCase()).not.toContain('craft')
    }
  })

  it('keeps hard-coded hex inside the theme blocks only', () => {
    const hex = /#[0-9a-fA-F]{3,8}\b/g
    const spans = themeBlockSpans(tokens)
    expect(spans.length).toBeGreaterThanOrEqual(2) // :root and .dark must both parse
    let m: RegExpExecArray | null
    while ((m = hex.exec(tokens)) !== null) {
      const inside = spans.some(([a, b]) => m!.index >= a && m!.index < b)
      expect({ hex: m[0], inside }).toEqual({ hex: m[0], inside: true })
    }
    while ((m = hex.exec(base)) !== null) {
      const lineStart = base.lastIndexOf('\n', m.index) + 1
      const line = base.slice(lineStart, base.indexOf('\n', m.index))
      expect(line).toContain('linear-gradient(#fff 0 0)')
    }
  })
})

/**
 * UB4.24 (B3-26; upstream v0.15.0/v0.15.1 `SessionProjectColorWrapper.tsx`) —
 * the project colour stripe no longer paints over sticky group headers.
 *
 * The v0.13.4 copy UA5.9 landed drew the stripe at `z-10`; upstream's redesign
 * rows are full-bleed and the sticky group headers scroll over them at
 * `z-sticky` (20), so a z-10 stripe painted THROUGH a passing header. The
 * v0.15.0 fix drops the stripe to `z-[1]` — above the row's own fill, below
 * every sticky header — and moves the stripe-tint onto its own overlay div so
 * the tint cannot stack with the stripe on one element.
 *
 * Instrument: `renderToStaticMarkup` (no DOM needed); the component's imports
 * are React plus a type-only `ProjectColorTreatment`, so the graph is clean.
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionProjectColorWrapper } from '../SessionProjectColorWrapper'

function render(color: string | null | undefined, treatment: 'stripe' | 'stripe-tint' = 'stripe'): string {
  return renderToStaticMarkup(
    <SessionProjectColorWrapper color={color} treatment={treatment as never}>
      <div data-testid="row">row</div>
    </SessionProjectColorWrapper>,
  )
}

describe('UB4.24 · the project stripe stays under the sticky headers', () => {
  it('THE ROW: a coloured row draws the stripe at z-[1] — below z-sticky (20), above the row fill', () => {
    const markup = render('#6366f1')
    expect(markup).toContain('z-[1]')
    expect(markup).not.toContain('z-10')
    expect(markup).toContain('#6366f1')
    expect(markup).toContain('row')
  })

  it('the stripe-tint treatment draws the tint as its own overlay under the children', () => {
    const markup = render('#6366f1', 'stripe-tint')
    expect(markup).toContain('color-mix(in srgb, #6366f1 6%, transparent)')
    expect(markup).toContain('pointer-events-none absolute inset-0')
  })

  it('CONTROL: a row without a project renders children only — no stripe, no tint, no wrapper', () => {
    for (const color of [null, undefined]) {
      const markup = render(color)
      expect(markup).not.toContain('z-[1]')
      expect(markup).not.toContain('#')
      expect(markup).toContain('row')
    }
  })
})

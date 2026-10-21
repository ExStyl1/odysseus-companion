/**
 * UB13.9 — the tooltip timing contract: 500 ms before the first tooltip, instant for the next
 * 300 ms (skipDelayDuration), a 6 px side offset and the floating material. The row's arms are
 * value assertions on the primitives' defaults, plus the App-level arm: the timing "only holds
 * once App.tsx's `<TooltipProvider delayDuration={0}>` is dropped" — so the app source must not
 * override the provider anywhere (the guard can fail: the override existed until this row).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const tooltip = readFileSync(join(import.meta.dir, '../tooltip.tsx'), 'utf8')

describe('tooltip timing (UB13.9, design spec §5)', () => {
  it('positive: the provider defaults are 500/300 and an explicit delayDuration still overrides them', () => {
    expect(tooltip).toContain('delayDuration = 500')
    expect(tooltip).toContain('skipDelayDuration = 300')
    expect(tooltip).toContain('skipDelayDuration={skipDelayDuration}')
    // the spread AFTER the defaults keeps an explicit prop authoritative
    expect(tooltip.indexOf('delayDuration={delayDuration}')).toBeGreaterThan(
      tooltip.indexOf('delayDuration = 500'),
    )
  })

  it('positive: the floating material — sideOffset 6, bg-floating, elev-2, the motion-tooltip preset', () => {
    expect(tooltip).toContain('sideOffset = 6')
    expect(tooltip).toContain('motion-tooltip')
    expect(tooltip).toContain('bg-floating')
    expect(tooltip).toContain('shadow-elev-2')
  })

  it('negative: no caller overrides the timing — the app mounts the provider bare', () => {
    const app = readFileSync(
      join(import.meta.dir, '../../../../../apps/electron/src/renderer/App.tsx'),
      'utf8',
    )
    expect(app).toContain('<TooltipProvider>')
    expect(app.includes('delayDuration={0}'), 'the 0 ms override must stay dropped').toBe(false)
    // subpath consumers (the barrel trap) import from './ui/tooltip', never the barrel — nothing
    // else in either tree mounts a second provider with an override
    expect(tooltip).toContain('export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }')
  })
})

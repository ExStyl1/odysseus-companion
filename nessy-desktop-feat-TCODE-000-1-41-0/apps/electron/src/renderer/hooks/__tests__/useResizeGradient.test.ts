/**
 * UB14.46 — useResizeGradient taken 1:1 from v0.15.1: the resize indicator fades on the motion
 * tokens (`--dur-fast`, `--ease-out`, packages/ui tokens.css) instead of a literal 150 ms ease-out,
 * so it follows the token scale (and the Motion preference that drives it) like every other surface.
 */
import { describe, expect, it } from 'bun:test'
import { getResizeGradientStyle } from '../useResizeGradient'

const TOKEN_TRANSITION = 'opacity var(--dur-fast) var(--ease-out)'

describe('getResizeGradientStyle — the fade reads the motion tokens', () => {
  it('positive: both the hidden and the shown style transition on --dur-fast / --ease-out', () => {
    const hidden = getResizeGradientStyle(null, 400)
    const shown = getResizeGradientStyle(120, 400)
    expect(hidden).toMatchObject({ opacity: 0, background: 'none' })
    expect(hidden.transition).toBe(TOKEN_TRANSITION)
    expect(shown.opacity).toBe(1)
    expect(shown.transition).toBe(TOKEN_TRANSITION)
  })

  it('negative: no style carries a literal duration or easing any more', () => {
    for (const style of [getResizeGradientStyle(null, 0), getResizeGradientStyle(10, 400), getResizeGradientStyle(390, 400)]) {
      expect(String(style.transition)).not.toMatch(/\d+ms|ease-out(?!\))/)
    }
  })
})

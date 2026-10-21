/**
 * UB13.5's own row arms, beside the copied upstream tests (kept 1:1):
 * - positive: SPRING/TWEEN/DURATION/EASE resolve through the `@nessy-agent/ui/motion` SUBPATH
 *   export, never the barrel (R6's barrel trap — the barrel reaches pdfjs-dist workers);
 * - negative control: in bun's no-DOM environment `prefersReducedMotion()` takes the
 *   `typeof document === 'undefined'` arm → true, and the play primitives short-circuit to
 *   empty/null before touching any element — the reduced-motion guarantee the row names.
 */
import { describe, expect, it } from 'bun:test'
import { flipTransform, playFlip, playSlideX, prefersReducedMotion, snapshotRects, type FlipTarget } from '../flip'

describe('UB13.5 row arms', () => {
  it('exports SPRING/TWEEN/DURATION/EASE through the @nessy-agent/ui/motion subpath (positive)', async () => {
    const motion = await import('@nessy-agent/ui/motion')
    for (const group of [motion.SPRING, motion.TWEEN, motion.DURATION, motion.EASE]) {
      expect(typeof group).toBe('object')
      expect(Object.keys(group as object).length).toBeGreaterThan(0)
    }
  })

  it('reduced motion short-circuits the play primitives (negative control)', () => {
    expect(prefersReducedMotion()).toBe(true)
    const el = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      isConnected: true,
    } as unknown as HTMLElement
    const before = snapshotRects([el])
    // A moved target must still animate nothing under reduced motion — and never reach el.animate.
    const targets: FlipTarget[] = [{ el }]
    expect(playFlip(before, targets)).toEqual([])
    expect(playSlideX(el, 40, 0)).toBeNull()
  })

  it('flipTransform stays a pure geometry function the control can fail on (boundary)', () => {
    expect(flipTransform({ left: 238, top: 50, width: 900, height: 800 }, { left: 6, top: 50, width: 1132, height: 800 })).toBe('translate(232px, 0px)')
  })
})

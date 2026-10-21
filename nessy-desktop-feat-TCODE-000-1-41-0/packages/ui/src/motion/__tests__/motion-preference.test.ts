/**
 * UB13.4 (OQ-R5.1 (a)) — the Motion preference is a tri-state `system | reduced | full`.
 *
 * `isMotionPreference` is the guard every reader (ThemeContext's boot resolver, the cross-window
 * sync) funnels through: a valid stored value reads back as itself; anything else — including a
 * stale or hand-edited value — falls to the caller's default instead of being trusted. The
 * provider arm is source-guarded (packages/ui has no RTL/jsdom harness): `html[data-motion]` is
 * how tokens.css/base.css honour the setting next to `prefers-reduced-motion`.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MOTION_PREFERENCES, isMotionPreference } from '../MotionPreference'

describe('isMotionPreference (UB13.4)', () => {
  it('positive: every declared preference passes, reduced included', () => {
    expect(MOTION_PREFERENCES).toEqual(['system', 'reduced', 'full'])
    for (const p of MOTION_PREFERENCES) {
      expect(isMotionPreference(p), p).toBe(true)
    }
    expect(isMotionPreference('reduced')).toBe(true)
  })

  it('negative: \'fast\' and undefined are not preferences (the control)', () => {
    expect(isMotionPreference('fast')).toBe(false)
    expect(isMotionPreference(undefined)).toBe(false)
    expect(isMotionPreference(null)).toBe(false)
    expect(isMotionPreference(true)).toBe(false)
    expect(isMotionPreference('REDUCED')).toBe(false) // case-sensitive storage, no silent coercion
  })

  it('the provider stamps html[data-motion] (source guard; no DOM harness in packages/ui)', () => {
    const src = readFileSync(join(import.meta.dir, '../MotionPreference.tsx'), 'utf8')
    expect(src).toContain('root.dataset.motion = preference')
    expect(src).toContain("delete root.dataset.motion")
    expect(src).toContain('<MotionConfig reducedMotion={REDUCED_MOTION[preference]}>')
  })
})

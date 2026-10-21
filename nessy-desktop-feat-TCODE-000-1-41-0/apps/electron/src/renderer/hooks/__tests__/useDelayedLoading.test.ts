/**
 * UB14.46 — useDelayedLoading (v0.15.1, added in v0.15.0): a loading placeholder appears only
 * after 200 ms and, once shown, stays at least 400 ms, so a fast load renders its content directly
 * and a slow one gets a steady skeleton instead of a flash.
 *
 * The hook runs unmodified on the real reconciler (`fixtures/render-hook.ts`) under bun's fake
 * timers, which also move `Date.now()` — the hook measures the minimum visible time with it.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { useDelayedLoading } from '../useDelayedLoading'
import { renderHook, type RenderedHook } from './fixtures/render-hook'

const T0 = 1_700_000_000_000

let mounted: RenderedHook<boolean, boolean> | null = null

function mount(isLoading: boolean): RenderedHook<boolean, boolean> {
  mounted = renderHook((loading: boolean) => useDelayedLoading(loading), isLoading)
  return mounted
}

function advance(hook: RenderedHook<boolean, boolean>, ms: number): void {
  hook.act(() => {
    jest.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  jest.useRealTimers()
})

describe('useDelayedLoading — the skeleton waits 200 ms', () => {
  it('positive: a load still running reports loading only once 200 ms have passed', () => {
    const hook = mount(true)
    expect(hook.current).toBe(false)
    advance(hook, 199)
    expect(hook.current).toBe(false)
    advance(hook, 1)
    expect(hook.current).toBe(true)
  })

  it('negative: loads finishing in 100, 150 and 199 ms never show the skeleton', () => {
    for (const loadMs of [100, 150, 199]) {
      const hook = mount(true)
      advance(hook, loadMs)
      hook.rerender(false)
      advance(hook, 1_000)
      expect({ loadMs, shown: hook.history.includes(true) }).toEqual({ loadMs, shown: false })
      hook.unmount()
      mounted = null
    }
  })
})

describe('useDelayedLoading — once shown, the skeleton stays 400 ms', () => {
  it('positive: a 300 ms load keeps the skeleton from 200 ms to exactly 600 ms', () => {
    const hook = mount(true)
    advance(hook, 200)
    expect(hook.current).toBe(true)
    advance(hook, 100)
    hook.rerender(false)
    // Shown at 200 ms, the load ended at 300 ms: it must stay until 600 ms, not hide now.
    expect(hook.current).toBe(true)
    advance(hook, 299)
    expect(hook.current).toBe(true)
    advance(hook, 1)
    expect(hook.current).toBe(false)
  })

  it('boundary: a load longer than the minimum hides as soon as it finishes', () => {
    const hook = mount(true)
    advance(hook, 200)
    advance(hook, 500)
    expect(hook.current).toBe(true)
    hook.rerender(false)
    expect(hook.current).toBe(false)
  })
})

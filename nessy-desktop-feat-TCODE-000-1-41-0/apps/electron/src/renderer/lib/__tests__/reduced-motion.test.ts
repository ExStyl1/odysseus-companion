/**
 * P6.473's `prefersReducedMotion` key, as the UB13.4 boot migration reads it.
 *
 * Since UB12.40 the module holds only `readReducedMotionSetting`; the attribute, the OS-query
 * resolver and the React reader are retired (their absence is pinned in
 * `motion-legacy-retired.test.tsx`). What still matters is the read's own rule: only a real
 * boolean counts, so a hand-edited `"true"` can never migrate a user to 'reduced'.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { readReducedMotionSetting } from '../reduced-motion'
import * as storage from '../local-storage'

/** bun test has no localStorage; the module reaches for it lazily, so a Map stub after the imports is enough. */
const memory = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
  key: (index: number) => [...memory.keys()][index] ?? null,
  get length() {
    return memory.size
  },
} satisfies Storage

describe('readReducedMotionSetting', () => {
  afterEach(() => {
    storage.remove(storage.KEYS.prefersReducedMotion)
  })

  it('reads back a stored boolean, and reports an unwritten setting as null', () => {
    expect(readReducedMotionSetting()).toBeNull()
    storage.set(storage.KEYS.prefersReducedMotion, true)
    expect(readReducedMotionSetting()).toBe(true)
    storage.set(storage.KEYS.prefersReducedMotion, false)
    expect(readReducedMotionSetting()).toBe(false)
    storage.remove(storage.KEYS.prefersReducedMotion)
    expect(readReducedMotionSetting()).toBeNull()
  })

  it('treats a non-boolean hand-edit as UNSET rather than coercing it to the strongest value', () => {
    // A hand-edited `"true"` must not become `true`: a truthy string would
    // silently migrate the user to the reduction they never asked for.
    storage.set(storage.KEYS.prefersReducedMotion, 'true')
    expect(readReducedMotionSetting()).toBeNull()
    storage.set(storage.KEYS.prefersReducedMotion, 1)
    expect(readReducedMotionSetting()).toBeNull()
  })
})

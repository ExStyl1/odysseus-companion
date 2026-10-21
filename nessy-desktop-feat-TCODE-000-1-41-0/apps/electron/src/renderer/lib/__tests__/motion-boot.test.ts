/**
 * UB13.4 (OQ-R5.1 (a)) — the Motion boot resolver and the one-way P6.473 migration.
 *
 * `resolveBootMotion` decides what ThemeProvider boots with: a valid stored Motion value reads
 * back as itself; a theme record without one migrates `prefersReducedMotion=true`
 * (`nessy-prefersReducedMotion`, P6.473) to `'reduced'` exactly once; otherwise `'system'`.
 * The legacy read goes through the real `readReducedMotionSetting`/`storage` pair (seeded through the
 * storage module, since UB12.40 retired P6.473's writer), with
 * `globalThis.localStorage` stubbed by a Map (bun test has none) — the same module the renderer
 * runs, not a copy.
 *
 * The pre-paint arm is a source guard on both HTML entries: the script must read OUR storage key
 * `nessy-theme` (the local-storage PREFIX), never upstream's `craft-theme`.
 */
import { describe, expect, it, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveBootMotion } from '../motion-preference'
import { readReducedMotionSetting } from '../reduced-motion'
import * as storage from '../local-storage'

const store = new Map<string, string>()

describe('resolveBootMotion (UB13.4, OQ-R5.1 (a))', () => {
  beforeEach(() => {
    store.clear()
    ;(globalThis as any).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
  })

  it("positive: a stored 'reduced' reads back as 'reduced' with no migration", () => {
    expect(resolveBootMotion('reduced', null)).toEqual({ motion: 'reduced', migrated: false })
    expect(resolveBootMotion('system', true)).toEqual({ motion: 'system', migrated: false })
    expect(resolveBootMotion('full', null)).toEqual({ motion: 'full', migrated: false })
  })

  it('positive: a stored prefersReducedMotion=true migrates to reduced exactly once', () => {
    storage.set(storage.KEYS.prefersReducedMotion, true)
    expect(readReducedMotionSetting()).toBe(true)
    expect(resolveBootMotion(undefined, readReducedMotionSetting())).toEqual({
      motion: 'reduced',
      migrated: true,
    })
  })

  it("negative (control): 'system' with the OS not asking and no legacy flag leaves motion full — i.e. system", () => {
    storage.set(storage.KEYS.prefersReducedMotion, false) // the documented "same as unset"
    expect(resolveBootMotion(undefined, readReducedMotionSetting())).toEqual({
      motion: 'system',
      migrated: false,
    })
    expect(resolveBootMotion(undefined, null)).toEqual({ motion: 'system', migrated: false })
  })

  it('negative: an invalid stored value ("fast") is not trusted; the legacy flag still applies', () => {
    expect(resolveBootMotion('fast', null)).toEqual({ motion: 'system', migrated: false })
    expect(resolveBootMotion('fast', true)).toEqual({ motion: 'reduced', migrated: true })
  })

  it('the pre-paint scripts read nessy-theme, never craft-theme (both HTML entries)', () => {
    for (const name of ['index.html', 'playground.html']) {
      const html = readFileSync(join(import.meta.dir, '../../', name), 'utf8')
      expect(html, name).toContain("localStorage.getItem('nessy-theme')")
      expect(html, name).not.toContain('craft-theme')
      expect(html, name).toContain("classList.replace('light', 'dark')")
    }
  })
})

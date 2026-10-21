/**
 * P6.473's `prefersReducedMotion` key — now only the INPUT of UB13.4's one-way boot migration.
 *
 * P6.473 gave the documented setting (`settings-reference.md` § `prefersReducedMotion`) a reader
 * above the OS media query: a hand-set `nessy-prefersReducedMotion` key, stamped on `<html>` as
 * `data-reduced-motion` for CompactPanelTransition and the task-list CSS. Upstream v0.15.1's Motion
 * preference (System / Reduced / Full, Settings › Appearance; `<html data-motion>` through
 * `MotionPreferenceProvider`) replaced it (UB13.4, OQ-R5.1 (a)), and UB12.40 retired that reader:
 * `startReducedMotionSync`, `usePrefersReducedMotion` and the `data-reduced-motion` CSS rule are gone,
 * because they did not know 'full' and kept the compact slide and the task list reduced under it.
 *
 * What stays is the read ThemeProvider makes once at boot (`resolveBootMotion`,
 * `lib/motion-preference.ts`): a theme record without a Motion value migrates a stored `true` to
 * 'reduced', then the provider removes the key. Nothing else reads it, so a key that lingers beside
 * a stored Motion value changes nothing.
 */

import * as storage from './local-storage'

/**
 * The stored setting, or `null` when it was never set. A non-boolean value in
 * storage (a hand-edit that wrote `"true"`) is treated as UNSET rather than
 * coerced: a truthy string must not silently become the strongest value.
 */
export function readReducedMotionSetting(): boolean | null {
  const raw = storage.get<unknown>(storage.KEYS.prefersReducedMotion, null)
  return typeof raw === 'boolean' ? raw : null
}

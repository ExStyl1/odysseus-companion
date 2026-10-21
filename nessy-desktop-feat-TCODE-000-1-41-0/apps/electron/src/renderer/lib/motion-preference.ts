/**
 * UB13.4 (OQ-R5.1 (a)) — the Motion preference the theme provider boots with.
 *
 * Upstream v0.15.1 persists `motion: 'system' | 'reduced' | 'full'` inside the theme record
 * (`nessy-theme`, our local-storage PREFIX) and reads it straight back. We ALSO carry P6.473's
 * older `prefersReducedMotion` boolean (`nessy-prefersReducedMotion`, `lib/reduced-motion.ts`);
 * when the theme record has no Motion value yet, that boolean migrates ONE WAY to `'reduced'`
 * (default `'system'`). The caller persists the migrated value into the theme record, removes
 * the old key, and logs once — `migrated` is true for exactly one boot.
 *
 * `resolveBootMotion` is pure so a bun test can pin all three arms without a DOM or the storage
 * module. Settings › Appearance writes the preference with ThemeContext's `setMotion`, as upstream's
 * page does (UB15.9; UB12.40 retired the wrapper that also cleared P6.473's key and attribute).
 */
import { isMotionPreference, type MotionPreference } from '@nessy-agent/ui/motion'

export interface BootMotion {
  motion: MotionPreference
  /** True when this boot performed the one-way P6.473 migration (persist + remove + log). */
  migrated: boolean
}

export function resolveBootMotion(
  storedMotion: unknown,
  legacyReducedMotion: boolean | null,
): BootMotion {
  if (isMotionPreference(storedMotion)) return { motion: storedMotion, migrated: false }
  if (legacyReducedMotion === true) return { motion: 'reduced', migrated: true }
  return { motion: 'system', migrated: false }
}

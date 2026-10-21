/**
 * UB14.47 (upstream v0.15.1:apps/electron/src/preload/bootstrap.ts `getWindowVibrancy`, Apache-2.0):
 * the native material behind this window, read from the launch argument the main process sets
 * (`main/window-material.ts` `windowVibrancyArguments`, passed as `webPreferences.additionalArguments`).
 *
 * Read synchronously so the renderer's first paint already knows whether its canvas may be translucent
 * (ThemeContext sets `data-vibrancy` only when this returns a material). Upstream parses inline in
 * `bootstrap.ts`; ours is a pure function over `argv` so `preload/window-vibrancy.test.ts` can pin it.
 */
import type { WindowVibrancy } from '../shared/types'
import { WINDOW_VIBRANCY_ARG } from '../main/window-material'

/** The material named by `--nessy-window-vibrancy=`, or null for a missing or unknown value (opaque). */
export function readWindowVibrancy(argv: readonly string[]): WindowVibrancy | null {
  const value = argv.find(arg => arg.startsWith(WINDOW_VIBRANCY_ARG))?.slice(WINDOW_VIBRANCY_ARG.length)
  return value === 'under-window' || value === 'mica' ? value : null
}

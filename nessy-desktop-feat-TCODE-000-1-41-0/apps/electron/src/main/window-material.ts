/**
 * UB14.47 (B3-17; upstream v0.15.0 "Windows", v0.15.1:apps/electron/src/main/window-manager.ts and
 * v0.15.1:apps/electron/src/preload/bootstrap.ts, Apache-2.0): which native material sits behind a
 * window, and how the main process tells the renderer about it.
 *
 * Upstream keeps the build gate inline in `window-manager.ts`; ours lifts it here as pure functions so
 * the gate and the launch-argument spelling are testable without Electron
 * (`main/__tests__/window-material.test.ts`, `preload/window-vibrancy.test.ts`). `window-manager.ts`
 * reads the OS build and logs; the preload (`preload/window-vibrancy.ts`) parses the argument back.
 *
 * Electron applies `backgroundMaterial` only on Windows 11 22H2 (build 22621) and later (the
 * `setBackgroundMaterial` note in Electron 39's `electron.d.ts`: "only supported on Windows 11 22H2 and
 * up"), yet asking for it on an older build still makes the web contents transparent (upstream's
 * v0.15.0 comment). Windows 10 and Windows 11 21H2 (build 22000) therefore get no material at all (no
 * Acrylic either), and the renderer paints its canvas solid there (ThemeContext sets `data-vibrancy`
 * only over a material; `packages/ui/src/styles/base.css` is translucent only under it).
 */
import type { WindowVibrancy } from '../shared/types'

/** First Windows build (11 22H2) on which Electron applies `backgroundMaterial`. */
export const WINDOWS_BACKGROUND_MATERIAL_MIN_BUILD = 22621

/**
 * Launch argument carrying the material to the renderer (rebranded from upstream's
 * `--craft-window-vibrancy=`). `preload/window-vibrancy.ts` is its only reader.
 */
export const WINDOW_VIBRANCY_ARG = '--nessy-window-vibrancy='

/** The Windows build number from `os.release()` (`"10.0.<build>"`); 0 when it cannot be read. */
export function windowsBuildNumber(osRelease: string): number {
  const build = parseInt(osRelease.split('.')[2] || '0', 10)
  return Number.isFinite(build) ? build : 0
}

/** Mica behind the window on Windows 11 22H2+ (build 22621+), else none. */
export function windowsBackgroundMaterialForBuild(build: number): 'mica' | undefined {
  return build >= WINDOWS_BACKGROUND_MATERIAL_MIN_BUILD ? 'mica' : undefined
}

/**
 * The material the renderer may paint translucently over: macOS always has the window's
 * `under-window` vibrancy; Windows only when `windowsBackgroundMaterialForBuild` granted Mica;
 * any other platform has none.
 */
export function windowVibrancyFor(
  platform: NodeJS.Platform,
  windowsBackgroundMaterial: 'mica' | undefined,
): WindowVibrancy | undefined {
  if (platform === 'darwin') return 'under-window'
  if (platform === 'win32') return windowsBackgroundMaterial
  return undefined
}

/** `webPreferences.additionalArguments` for a window: the material, or nothing for an opaque window. */
export function windowVibrancyArguments(vibrancy: WindowVibrancy | undefined): string[] {
  return vibrancy ? [`${WINDOW_VIBRANCY_ARG}${vibrancy}`] : []
}

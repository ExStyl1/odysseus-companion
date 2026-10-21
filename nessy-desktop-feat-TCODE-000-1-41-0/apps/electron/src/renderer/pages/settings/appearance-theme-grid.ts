/**
 * UB15.9 (ours) — the two numbers and the one list Settings › Appearance hands v0.15.1's `ThemeGrid`, kept out of the
 * page so a bun test can read them (the page itself only renders inside the app shell and Vite's `import.meta.glob`).
 *
 * Upstream v0.15.1 `AppearanceSettingsPage.tsx` builds the tiles inline (`themeGridOptions`) and seeds the loading
 * placeholders with `let lastPresetTileCount = 16`, ITS bundled preset count. Ours is derived instead: the page counts
 * the files Vite lists under `apps/electron/resources/themes` at build time (seven since UB13.17), so adding or
 * retiring a bundled preset can never leave the grid reserving the wrong number of rows.
 */
import type { PresetTheme } from '@config/theme'
import type { ThemeGridOption } from '@/components/settings/ThemeGrid'

/** The id a bundled preset file carries (`…/themes/codex.json` → `codex`), as ThemeContext's BUNDLED_THEMES derives it. */
export function presetIdFromPath(path: string): string {
  return (path.split('/').pop() ?? '').replace('.json', '')
}

/** The preset tiles these ids draw: every preset but `default`, whose tile the grid always shows as the built-in theme. */
export function presetTileCount(ids: readonly string[]): number {
  return ids.filter(id => id !== 'default').length
}

/**
 * The grid's tiles: the built-in default plus every preset, carrying the SAME values the app-theme dropdown used
 * (`'default'`, then each preset id but `default`), so `setColorTheme` receives exactly what it received before.
 */
export function appThemeGridOptions(presets: readonly PresetTheme[], defaultLabel: string): ThemeGridOption[] {
  return [
    { value: 'default', label: defaultLabel },
    ...presets
      .filter(p => p.id !== 'default')
      .map(p => ({ value: p.id, label: p.theme.name || p.id, theme: p.theme })),
  ]
}

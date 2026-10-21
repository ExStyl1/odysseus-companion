/**
 * UB15.9 — Settings › Appearance's Color theme section: v0.15.1's `ThemeGrid` replaces the app-theme dropdown.
 *
 * The page renders only inside the app shell, and it (like ThemeContext) reads Vite's `import.meta.glob`, which bun
 * cannot evaluate. So the arms run through the real pieces the page hands the grid — `appThemeGridOptions`,
 * `presetTileCount`, `presetIdFromPath` (`pages/settings/appearance-theme-grid.ts`) over the REAL bundled presets in
 * `apps/electron/resources/themes`, and the real `ThemeGrid` — and the page's wiring is pinned by source match (the
 * `settings-page-shell.test.ts` instrument). A tile's click is fired by rendering `ThemeGrid` inside a probe under
 * `renderToStaticMarkup` (which runs its hooks) and calling the `onClick` of each `button` in the element tree it
 * returned: the repo has no DOM library.
 *
 * The Motion arms of this row live where their harnesses are: `lib/__tests__/reduce-motion-toggle.test.ts` (the
 * write path, "'system' with the OS not asking leaves motion full", and the page's Motion wiring) and
 * `context/__tests__/theme-overrides.test.tsx` ("'reduced' persists across restart", through the real provider).
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PresetTheme, ThemeFile } from '@config/theme'
import { ThemeGrid, type ThemeGridProps } from '@/components/settings/ThemeGrid'
import { appThemeGridOptions, presetIdFromPath, presetTileCount } from '../appearance-theme-grid'

const PAGE_DIR = dirname(fileURLToPath(new URL('../AppearanceSettingsPage.tsx', import.meta.url)))
const PAGE = readFileSync(join(PAGE_DIR, 'AppearanceSettingsPage.tsx'), 'utf8')
const THEMES_DIR = resolve(PAGE_DIR, '../../../../resources/themes')
const BUNDLED_FILES = readdirSync(THEMES_DIR).filter(file => file.endsWith('.json')).sort()

/** The bundled presets as `loadPresetThemes()` hands them to the page: id = file name, theme = the parsed file. */
const BUNDLED: PresetTheme[] = BUNDLED_FILES.map(file => ({
  id: file.replace('.json', ''),
  path: join(THEMES_DIR, file),
  theme: JSON.parse(readFileSync(join(THEMES_DIR, file), 'utf8')) as ThemeFile,
}))

/** HEAD's app-theme dropdown options before UB15.9 (`themeOptions`): 'default', then every preset but 'default'. */
function oldDropdownValues(presets: readonly PresetTheme[]): string[] {
  return ['default', ...presets.filter(p => p.id !== 'default').map(p => p.id)]
}

/** Render the real grid and hand back what it returned, so a test can fire a tile's onClick. */
function renderGrid(props: ThemeGridProps): { markup: string; buttons: React.ReactElement<{ onClick: () => void }>[] } {
  let tree: React.ReactNode = null
  function Probe() {
    tree = ThemeGrid(props)
    return null
  }
  renderToStaticMarkup(<Probe />)
  const buttons: React.ReactElement<{ onClick: () => void }>[] = []
  const walk = (node: React.ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!React.isValidElement(node)) return
    if (node.type === 'button') buttons.push(node as React.ReactElement<{ onClick: () => void }>)
    walk((node.props as { children?: React.ReactNode }).children)
  }
  walk(tree)
  return { markup: renderToStaticMarkup(<ThemeGrid {...props} />), buttons }
}

const gridProps = (overrides: Partial<ThemeGridProps>): ThemeGridProps => ({
  value: 'default',
  onValueChange: () => {},
  options: [],
  mode: 'dark',
  darkOnlyLabel: 'Dark',
  ...overrides,
})

const PLACEHOLDER = /<div aria-hidden="true" class="flex min-w-0 flex-col gap-1\.5 rounded-lg p-1\.5 inset-ring inset-ring-border">/g

describe('Settings › Appearance colour theme grid (UB15.9)', () => {
  it('POSITIVE CONTROL — the bundled presets are read for real', () => {
    expect(BUNDLED.length).toBeGreaterThan(0)
    expect(BUNDLED.map(p => p.id)).toContain('codex')
  })

  it('positive: each tile calls setColorTheme with the same id the dropdown used', () => {
    // A planted `default` preset proves the grid drops it exactly as the dropdown did (the built-in tile stands for it).
    const presets = [...BUNDLED, { id: 'default', path: '/planted/default.json', theme: { name: 'Planted' } as ThemeFile }]
    const options = appThemeGridOptions(presets, 'Default')
    expect(options.map(o => o.value)).toEqual(oldDropdownValues(presets))

    const calls: string[] = []
    const { buttons } = renderGrid(gridProps({ options, onValueChange: value => calls.push(value) }))
    expect(buttons).toHaveLength(options.length)
    for (const button of buttons) button.props.onClick()
    expect(calls).toEqual(oldDropdownValues(presets))

    // The page hands the grid exactly that: these options, and ThemeContext's own setter.
    expect(PAGE).toContain('() => appThemeGridOptions(presetThemes, t("common.default"))')
    expect(PAGE).toMatch(/<ThemeGrid\s+value=\{colorTheme\}\s+onValueChange=\{setColorTheme\}\s+options=\{themeGridOptions\}\s+mode=\{resolvedMode\}\s+overrides=\{appThemeOverrides\}/)
  })

  it('negative (Done means): no SettingsMenuSelect remains for the app theme', () => {
    expect(PAGE).not.toMatch(/<SettingsMenuSelect\s+value=\{colorTheme\}/)
    expect(PAGE).not.toContain('const themeOptions = ')
    // control: the needle is spelled as HEAD spelled the dropdown it retires
    expect('<SettingsMenuSelect\n                      value={colorTheme}').toMatch(/<SettingsMenuSelect\s+value=\{colorTheme\}/)
  })

  it('boundary: while presets load, the grid reserves exactly our bundled preset count, and nothing below shifts', () => {
    const bundledCount = presetTileCount(BUNDLED_FILES.map(file => presetIdFromPath(`../../../../resources/themes/${file}`)))
    expect(bundledCount).toBe(BUNDLED.filter(p => p.id !== 'default').length)

    // The page seeds the count from the glob over that same directory, never a hard-coded number (the catch is
    // bun's: it has no import.meta.glob, and only the tests and the playground sweep import the page under bun).
    expect(PAGE).toContain('let lastPresetTileCount = bundledPresetTileCount()')
    const glob = PAGE.match(/return presetTileCount\(Object\.keys\(import\.meta\.glob\('([^']+)\/\*\.json', \{ eager: true, import: 'default' \}\)\)\.map\(presetIdFromPath\)\)/)
    expect(glob).not.toBeNull()
    expect(resolve(PAGE_DIR, glob![1]!)).toBe(THEMES_DIR)
    expect(PAGE).not.toMatch(/lastPresetTileCount = \d/)
    expect(PAGE).toContain('lastPresetTileCount = presetTileCount(themes.map(p => p.id))')
    expect(PAGE).toContain('placeholderCount={presetsLoaded ? 0 : lastPresetTileCount}')

    // Loading: the built-in tile plus `bundledCount` inert tiles; loaded: the built-in tile plus every preset tile.
    const loading = renderGrid(gridProps({ options: appThemeGridOptions([], 'Default'), placeholderCount: bundledCount }))
    expect(loading.markup.match(PLACEHOLDER) ?? []).toHaveLength(bundledCount)
    expect(loading.buttons).toHaveLength(1)
    const loaded = renderGrid(gridProps({ options: appThemeGridOptions(BUNDLED, 'Default'), placeholderCount: 0 }))
    expect(loaded.markup.match(PLACEHOLDER) ?? []).toHaveLength(0)
    expect(loading.buttons.length + bundledCount).toBe(loaded.buttons.length)
  })

  it('negative (control): a supportedModes [dark] preset carries the dark-only caption in light mode; a two-mode one does not', () => {
    const caption = '<span class="shrink-0 font-normal text-tertiary">Dark</span>'
    const darkOnly = BUNDLED.filter(p => JSON.stringify(p.theme.supportedModes) === '["dark"]').map(p => p.id)
    expect(darkOnly).toContain('haze')
    const { markup } = renderGrid(gridProps({ options: appThemeGridOptions(BUNDLED, 'Default'), mode: 'light' }))
    const tileOf = (label: string) => markup.match(new RegExp(`<button [^>]*>(?:(?!</button>).)*<span class="truncate">${label}</span>(?:(?!</button>).)*</button>`))?.[0] ?? ''
    expect(tileOf('Haze')).toContain(caption)
    expect(tileOf('Codex')).not.toBe('')
    expect(tileOf('Codex')).not.toContain(caption)
    expect(markup.split(caption).length - 1).toBe(darkOnly.length)
  })
})

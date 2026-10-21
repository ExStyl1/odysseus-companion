/**
 * UB15.9 — v0.15.1's `ThemeGrid` (taken 1:1; upstream ships no test for it), rendered with `renderToStaticMarkup`
 * like the sibling settings primitives. The swatches are solved by the same role engine that paints the app
 * (`resolveTheme` → `resolveThemeRoleInput` → `deriveThemeRoles`), so the arms read REAL bundled presets from
 * `apps/electron/resources/themes` rather than hand-written colours.
 *
 * The plan's amended boundary ("an option whose colours do not parse renders the neutral placeholder swatch") was
 * measured false at HEAD: `resolveThemeRoleInput` drops every colour `isParseableColor` rejects and falls back to the
 * default theme, so such a tile previews the DEFAULT theme's roles, and the solver did not throw on any of 12
 * malformed inputs probed (transparent, zero alpha, out-of-gamut, out-of-range hsl/oklch/oklab). Both halves are
 * pinned below: the unparseable tile previews the default, and the neutral swatch is the `catch` arm, reached by a
 * theme whose colour read itself throws.
 */
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ThemeFile } from '@config/theme'
import { ThemeGrid, type ThemeGridOption } from '../ThemeGrid'
import codex from '../../../../../resources/themes/codex.json'
import haze from '../../../../../resources/themes/haze.json'

const CODEX: ThemeGridOption = { value: 'codex', label: 'Codex', theme: codex as ThemeFile }
const HAZE: ThemeGridOption = { value: 'haze', label: 'Haze', theme: haze as ThemeFile }
const DEFAULT: ThemeGridOption = { value: 'default', label: 'Default' }

function render(options: ThemeGridOption[], mode: 'light' | 'dark', extra: { placeholderCount?: number; value?: string } = {}): string {
  return renderToStaticMarkup(
    <ThemeGrid
      value={extra.value ?? 'default'}
      onValueChange={() => {}}
      options={options}
      mode={mode}
      darkOnlyLabel="Dark"
      aria-label="Color theme"
      placeholderCount={extra.placeholderCount}
    />,
  )
}

/** Each tile's markup, in order (a tile is one `<button …>…</button>` — the grid nests no other button). */
function tiles(markup: string): string[] {
  return markup.match(/<button [^>]*>.*?<\/button>/g) ?? []
}

/** The five swatch colours a tile paints: paper, navigator strip, text line, tertiary line, accent dot. */
function swatch(tile: string): string[] {
  return [...tile.matchAll(/style="background:([^"]+)"/g)].map(m => m[1]!)
}

const NEUTRAL_SWATCH = '<span aria-hidden="true" class="block h-[54px] rounded-sm bg-fill-hover"></span>'
const DARK_ONLY_CAPTION = '<span class="shrink-0 font-normal text-tertiary">Dark</span>'

describe('ThemeGrid (UB15.9, v0.15.1 taken 1:1)', () => {
  it('positive: the codex tile in dark mode paints codex.json\'s own dark navigator #101010 and paper #212121', () => {
    const [tile] = tiles(render([CODEX], 'dark'))
    const [paper, navigator] = swatch(tile!)
    expect({ navigator, paper }).toEqual({ navigator: '#101010', paper: '#212121' })
    // control: the same tile in light mode paints codex.json's light surfaces, so the mode is what moved them
    const [lightPaper, lightNavigator] = swatch(tiles(render([CODEX], 'light'))[0]!)
    expect({ navigator: lightNavigator, paper: lightPaper }).toEqual({ navigator: '#f9f9f9', paper: '#ffffff' })
  })

  it('positive: haze (supportedModes [dark], scenic) shows the dark-only caption in light mode and previews dark', () => {
    const [codexTile, hazeTile] = tiles(render([CODEX, HAZE], 'light'))
    expect(hazeTile).toContain(DARK_ONLY_CAPTION)
    // negative (control): a light + dark theme carries no caption
    expect(codexTile).not.toContain(DARK_ONLY_CAPTION)
    // haze previews dark in light mode: its swatch is the one it paints in dark mode
    expect(swatch(hazeTile!)).toEqual(swatch(tiles(render([HAZE], 'dark'))[0]!))
  })

  it('the selected tile is pressed and ringed in the accent; the others carry the hairline', () => {
    const [codexTile, hazeTile] = tiles(render([CODEX, HAZE], 'dark', { value: 'codex' }))
    expect(codexTile).toMatch(/^<button type="button" aria-pressed="true" class="[^"]*inset-ring-2 inset-ring-accent-solid"/)
    expect(hazeTile).toMatch(/^<button type="button" aria-pressed="false" class="[^"]*inset-ring inset-ring-border"/)
  })

  it('boundary: a tile whose colours do not parse renders without throwing and previews the default theme', () => {
    const broken: ThemeGridOption = {
      value: 'broken',
      label: 'Broken',
      theme: { background: 'not-a-colour', foreground: 'zzz', accent: 'oklch(nope)', paper: '#12', navigator: 'var(--x)' } as ThemeFile,
    }
    for (const mode of ['light', 'dark'] as const) {
      const [defaultTile, brokenTile] = tiles(render([DEFAULT, broken], mode))
      expect(brokenTile).toContain('<span class="truncate">Broken</span>')
      expect(swatch(brokenTile!)).toHaveLength(5)
      expect(swatch(brokenTile!)).toEqual(swatch(defaultTile!))
    }
  })

  it('boundary: a theme whose solve throws still gets its tile, with the neutral swatch, and its neighbours keep theirs', () => {
    const throwing = {
      value: 'throws',
      label: 'Throws',
      theme: Object.defineProperty({}, 'background', {
        enumerable: true,
        get() {
          throw new Error('planted: the solve throws')
        },
      }) as ThemeFile,
    }
    const [codexTile, throwingTile] = tiles(render([CODEX, throwing], 'dark'))
    expect(throwingTile).toContain(NEUTRAL_SWATCH)
    expect(throwingTile).toContain('<span class="truncate">Throws</span>')
    expect(swatch(codexTile!)).toHaveLength(5)
  })

  it('boundary: placeholderCount={3} renders three inert tiles (no button, hidden from assistive tech); 0 renders none', () => {
    const markup = render([], 'dark', { placeholderCount: 3 })
    expect(tiles(markup)).toEqual([])
    const placeholders = markup.match(/<div aria-hidden="true" class="flex min-w-0 flex-col gap-1\.5 rounded-lg p-1\.5 inset-ring inset-ring-border">/g) ?? []
    expect(placeholders).toHaveLength(3)
    expect(markup.split(NEUTRAL_SWATCH).length - 1).toBe(3)
    // control: no placeholders by default
    expect(render([], 'dark')).not.toContain(NEUTRAL_SWATCH)
  })
})

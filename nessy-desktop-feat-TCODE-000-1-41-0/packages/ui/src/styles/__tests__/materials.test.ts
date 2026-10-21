/**
 * UB13.8 — Materials: raised, sunken, floating, paper, navigator; elevation and annotation
 * tokens. The CSS landed with the token layer (UB13.2) and the annotation tokens were swept in
 * UB13.3 (`--shadow-color: var(--info)`); this row owns the material set's verification and its
 * playground entry.
 *
 * Arms:
 * - positive: every material utility is defined (`.shadow-elev-0…3` through the @theme map,
 *   `.popover-styled`, `.field-surface`, `.keycap`, `.switch-track`, `.skeleton`, and the
 *   `[data-sonner-toast]` block), and the four elevation shadow names sit in UB13.14's
 *   `nessy-styles/no-nonstandard-shadows` allow-list in BOTH eslint configs.
 * - negative (control, COMPUTED with the solver itself): the annotation highlight wash —
 *   `annotationColorToCss`'s default is `color-mix(in srgb, var(--info) 10%, transparent)`, i.e.
 *   the THEME's info hue, so it moves per preset — laid over a typical white page must keep
 *   black text and over a typical dark page white text at WCAG AA (4.5:1) for EVERY bundled
 *   preset × mode. This is the row's "keeps its contrast on every preset" control; the packaged
 *   DialogContent `shadow-elev-3` + floating-radius computation is UB13.16's sitting arm.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { contrastRatio, deriveThemeRoles, over, parseColor } from '@nessy-agent/shared/config'

const UI_STYLES = join(import.meta.dir, '..')
const tokens = readFileSync(join(UI_STYLES, 'tokens.css'), 'utf8')
const base = readFileSync(join(UI_STYLES, 'base.css'), 'utf8')
const rendererCss = readFileSync(
  join(import.meta.dir, '../../../../../apps/electron/src/renderer/index.css'),
  'utf8',
)
const uiEslint = readFileSync(join(import.meta.dir, '../../../eslint.config.mjs'), 'utf8')
const electronEslint = readFileSync(
  join(import.meta.dir, '../../../../../apps/electron/eslint.config.mjs'),
  'utf8',
)

describe('materials: the utility set is defined (UB13.8)', () => {
  it('positive: every elevation and material utility exists', () => {
    for (const elev of ['--shadow-elev-0', '--shadow-elev-1', '--shadow-elev-2', '--shadow-elev-3']) {
      expect(tokens.includes(`${elev}: var(--elev-`), elev).toBe(true)
    }
    for (const util of ['.popover-styled {', '.field-surface {', '.keycap {', '.switch-track {', '.skeleton {']) {
      expect(base.includes(util), util).toBe(true)
    }
    // the floating material's radius is the token scale (--radius-lg 12px), not a per-component value
    expect(tokens).toContain('--radius-lg: 12px;')
    expect(rendererCss.includes('[data-sonner-toast]')).toBe(true)
  })

  it('positive: the four elevation shadow names sit in the UB13.14 allow-list, both configs', () => {
    for (const [name, cfg] of [['packages/ui', uiEslint], ['apps/electron', electronEslint]] as const) {
      for (const elev of ['0', '1', '2', '3']) {
        expect(cfg.includes(`'shadow-elev-${elev}'`), `${name} shadow-elev-${elev}`).toBe(true)
      }
    }
  })
})

describe('materials: the annotation highlight keeps its contrast on every preset (control)', () => {
  const REPO_ROOT = resolve(import.meta.dir, '../../../../..')
  const THEMES_DIR = join(REPO_ROOT, 'apps/electron/resources/themes')
  const BLACK = parseColor('#000000')
  const WHITE = parseColor('#ffffff')

  it('the control can fail: white text on a 60% wash breaks AA on a typical page (instrument check)', () => {
    // Positive control on the INSTRUMENT: the same arithmetic with the WRONG pairing (white text
    // on a 60% info wash over a white page) must sit far below 4.5 — proving the 10% passes
    // below are measurements against the wash's real colour, not a tautology.
    const info = parseColor('#c47f17') // paper's info
    expect(contrastRatio(WHITE, over(info, 0.6, WHITE))).toBeLessThan(4.5)
  })

  for (const file of readdirSync(THEMES_DIR).filter((f) => f.endsWith('.json'))) {
    const theme = JSON.parse(readFileSync(join(THEMES_DIR, file), 'utf-8'))
    const modes = theme.supportedModes?.length ? theme.supportedModes : (['light', 'dark'] as const)
    for (const mode of modes as ('light' | 'dark')[]) {
      it(`${file.replace('.json', '')}/${mode}: the info wash at 10% keeps page text at AA`, () => {
        const eff = mode === 'dark' && theme.dark ? { ...theme, ...theme.dark } : theme
        const { vars } = deriveThemeRoles(
          {
            background: eff.background,
            foreground: eff.foreground,
            accent: eff.accent,
            info: eff.info,
            success: eff.success,
            destructive: eff.destructive,
            paper: eff.paper,
            navigator: eff.navigator,
            popover: eff.popover,
            popoverSolid: eff.popoverSolid,
          },
          mode,
        )
        const info = parseColor(vars['--info-raw']!)
        // annotationColorToCss: color-mix(in srgb, var(--info) 10%, transparent), over the page
        const overWhite = contrastRatio(BLACK, over(info, 0.1, WHITE))
        const overDark = contrastRatio(WHITE, over(info, 0.1, parseColor('#1c1b1a')))
        expect(overWhite).toBeGreaterThanOrEqual(4.5)
        expect(overDark).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})

/**
 * UB12.97 — every colour utility the renderer's sources spell names a colour the renderer's stylesheet defines.
 *
 * The instrument, its scope and its residue are documented in `./colour-role-census.ts`. In one line: Tailwind's own
 * compiler, loaded on `renderer/index.css`, judges every colour-shaped class token the renderer and `packages/ui`
 * spell in code (comments dropped by Bun's transpiler), and a class that generates no CSS is a red — it draws nothing.
 *
 * Positive: after UB12.97's re-spellings (WorkspacePicker's `bg-sidebar` → `bg-navigator`, the label-row mock's
 * `bg-sidebar` → `bg-raised`, the overlay openers' `text-accent-foreground` → `text-on-accent` on `bg-accent-solid`)
 * the census is empty, and it demonstrably read the files those re-spellings live in. Negative: a planted `bg-warning`
 * and `bg-sidebar` are flagged, while `border-default`, `ring-offset-paper` and `text-label-sm` (names that resolve only
 * through a Tailwind v4 namespace or the type scale) are not; the same planted names in comments are not read at all.
 */

import { beforeAll, describe, expect, it } from 'bun:test'
import {
  CENSUS_ROOTS,
  COLOUR_CENSUS_HOOK_BUDGET_MS,
  NOT_A_CLASS,
  RENDERER_STYLESHEET,
  colourClassTokens,
  loadColourVocabulary,
  runColourCensus,
  type ColourCensus,
  type ColourVocabulary,
} from './colour-role-census'

let vocabulary: ColourVocabulary
let census: ColourCensus

beforeAll(async () => {
  vocabulary = await loadColourVocabulary()
  census = await runColourCensus(vocabulary)
}, COLOUR_CENSUS_HOOK_BUDGET_MS)

/**
 * Tailwind's default palette resolves (a raw palette colour is `nessy-styles/no-raw-palette-colors`' concern, not this
 * census'); spelled in parts so that rule does not read this needle as a use.
 */
const PALETTE_CLASS = ['bg', 'red', '500'].join('-')

/** A planted source: the given class list in a JSX attribute, a plain string and a template literal. */
const planted = (classes: string) =>
  `export function Planted() {\n  const extra = '${classes}'\n  return <div className="${classes}" data-x={\`${classes}\`}>{extra}</div>\n}\n`

describe('the colour census over the renderer (UB12.97)', () => {
  it('POSITIVE CONTROL — the census read both trees, the stylesheet chain and the files UB12.97 re-spelled', () => {
    for (const root of CENSUS_ROOTS) {
      expect({ root, read: census.files.filter(file => file.startsWith(`${root}/`)).length > 100 }).toEqual({ root, read: true })
    }
    // The re-spelled names were met in the files that now spell them: the census cannot be vacuous about them.
    const spelledIn = (token: string) => census.tokens.get(token) ?? []
    expect(spelledIn('bg-navigator')).toContain('apps/electron/src/renderer/components/workspace/WorkspacePicker.tsx')
    expect(spelledIn('bg-raised')).toContain('apps/electron/src/renderer/playground/registry/label-badges.tsx')
    expect(spelledIn('text-on-accent')).toContain('apps/electron/src/renderer/playground/registry/turn-card.tsx')
    // The compiler read the renderer's stylesheet and what it imports; base.css' plain rules were collected.
    expect(vocabulary.stylesheets[0]).toBe(RENDERER_STYLESHEET)
    for (const sheet of ['packages/ui/src/styles/tokens.css', 'packages/ui/src/styles/base.css', 'node_modules/tailwindcss/index.css']) {
      expect({ sheet, read: vocabulary.stylesheets.some(path => path.endsWith(sheet)) }).toEqual({ sheet, read: true })
    }
    expect(vocabulary.plainClasses.has('field-surface')).toBe(true)
  })

  it('POSITIVE — no colour class anywhere in the renderer or packages/ui names a colour the stylesheet lacks', () => {
    expect(census.unresolved).toEqual({})
  })

  it('NEGATIVE — a planted bg-warning and bg-sidebar are flagged; border-default, ring-offset-paper and text-label-sm are not', () => {
    const source = planted('flex bg-warning hover:bg-sidebar border border-default ring-offset-2 ring-offset-paper text-label-sm')
    const tokens = colourClassTokens(source, 'tsx')
    // Each of the three spellings (attribute, string, template) is read.
    expect(tokens.filter(token => token === 'bg-warning')).toHaveLength(3)
    expect([...new Set(tokens.filter(token => !vocabulary.resolves(token)))]).toEqual(['bg-warning', 'hover:bg-sidebar'])
    expect(vocabulary.unresolved(`border-default ring-offset-paper text-label-sm border-separator/60 inset-ring-[var(--info-border)] divide-default ${PALETTE_CLASS}`)).toEqual([])
    expect(vocabulary.unresolved('bg-sidebar text-accent-foreground text-warning border-warning/30 bg-info-tint')).toEqual(['bg-sidebar', 'text-accent-foreground', 'text-warning', 'border-warning/30'])
  })

  it('CONTROL — a dead name in a comment or a template substitution is not a class; code punctuation is not a class', () => {
    const source = [
      '/** UB12.84 replaced border-warning/30 bg-warning/10 text-warning here. */',
      '// bg-sidebar drew nothing',
      'export const tone = (t: string) => `bg-${t}-tint text-info`',
      "export const svg = '<path stroke-width=\"2\" />'",
    ].join('\n')
    expect(colourClassTokens(source, 'ts')).toEqual(['text-info'])
  })

  it('the not-a-class list checks itself: every entry is still met by the census and still generates no CSS', () => {
    for (const token of Object.keys(NOT_A_CLASS)) {
      expect({ token, met: census.notAClassMet.has(token), resolves: vocabulary.resolves(token) }).toEqual({ token, met: true, resolves: false })
    }
  })
})

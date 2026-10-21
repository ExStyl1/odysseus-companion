/**
 * UB13.19 — the Primitives and Toasts registries. Arms:
 * positive — the Primitives entries are REGISTERED (the render arm is
 * `registry-render.test.ts`, whose child fixture enumerates `componentRegistry` by construction —
 * importing the registry in-process pulls the ui barrel and pdfjs' ?url worker, which bun cannot
 * load; that is why the render arm lives in the child);
 * boundary (the row's negative) — the Design Tokens entry names EVERY `DERIVED_ROLE_VARS` role:
 * a role added to the solver without a swatch FAILS HERE, against the solver's own constant.
 * UB12.27 — the rebrand arm: no upstream brand string ships in the Primitives source (the playground
 * is a rollup input); its control plants the old working-folder value in a copy of the source.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DERIVED_ROLE_VARS } from '@nessy-agent/shared/config'

const primitivesSource = readFileSync(
  join(import.meta.dir, '../registry/primitives.tsx'),
  'utf8',
)
const registryIndex = readFileSync(join(import.meta.dir, '../registry/index.ts'), 'utf8')
const toastsSource = readFileSync(join(import.meta.dir, '../registry/toasts.tsx'), 'utf8')

/** UB12.27: 1-based line numbers of every upstream brand spelling (`craft-agents`, `craftagents`,
 * `craft-agent`), case-insensitive — comments included, since a comment is where a pasted path hides. */
function upstreamBrandLines(source: string): number[] {
  return source.split('\n').flatMap((line, i) => (/craft-?agents?/i.test(line) ? [i + 1] : []))
}

describe('the Primitives registry (UB13.19)', () => {
  it('positive: primitivesComponents is registered in the index, ahead of toasts', () => {
    expect(registryIndex).toContain("import { primitivesComponents } from './primitives'")
    expect(registryIndex).toContain('...primitivesComponents,')
    expect(registryIndex.indexOf('...primitivesComponents,')).toBeLessThan(
      registryIndex.indexOf('...toastsComponents,'),
    )
    expect(registryIndex).toContain("['Primitives', 'Marketplace',")
  })

  it('positive: the row\'s flagship entries exist (source-level ids)', () => {
    for (const id of ['primitives-tokens', 'primitives-buttons', 'primitives-fields', 'primitives-menu', 'primitives-dialog', 'primitives-tooltip-popover']) {
      expect(primitivesSource, id).toContain(`id: '${id}'`)
    }
  })

  it('boundary (the row\'s negative): the Design Tokens entry swatches EVERY DERIVED_ROLE_VARS role', () => {
    expect(DERIVED_ROLE_VARS.length).toBe(30) // the solver's role list
    // the swatch grid renders the CONSTANT ITSELF (DERIVED_ROLE_VARS.map), so coverage is by
    // construction: a role the solver adds gets a swatch without a registry edit — and the grid
    // cannot drift from the solver the way a hand list would.
    expect(primitivesSource).toContain('DERIVED_ROLE_VARS.map((role)')
    expect(primitivesSource).toContain('background: `var(${role})`')
  })

  it('the toasts registry took the solids and the undo toast (div 0 upstream)', () => {
    expect(toastsSource).toContain("color: 'bg-success-solid'")
    expect(toastsSource).toContain("color: 'bg-destructive-solid'")
    expect(toastsSource).toContain("id: 'undo'")
    expect(toastsSource).not.toMatch(/bg-(green|red|amber|blue|purple|cyan)-500/)
  })

  it('UB14.20: the Decision Card entry carries both tones, the hosted material and the narrow card as variants', () => {
    const entry = primitivesSource.slice(primitivesSource.indexOf("id: 'primitives-decision-card'"))
    expect(primitivesSource).toContain("id: 'primitives-decision-card'")
    expect(primitivesSource.indexOf("id: 'primitives-decision-card'")).toBeLessThan(primitivesSource.indexOf("id: 'primitives-motion'"))
    for (const variant of ["tone: 'info', standalone: true, narrow: false", "tone: 'danger', standalone: true, narrow: false", "tone: 'info', standalone: false", "narrow: true"]) {
      expect(entry, variant).toContain(variant)
    }
    expect(primitivesSource).toContain("from '@/components/app-shell/input/structured/DecisionCard'")
  })

  it('UB12.27 positive: no upstream brand string ships in the Primitives source; the demo folder is ours', () => {
    expect(upstreamBrandLines(primitivesSource)).toEqual([])
    expect(primitivesSource).toContain('<Input defaultValue="~/Workspace/nessy-desktop" aria-label="Working folder" />')
  })

  it('UB12.27 control: a planted upstream working folder in a copy of the source is reported, in any case', () => {
    // plant at the demo's Input (the anchor occurs once), not at the header comment that names the folder
    const successor = 'defaultValue="~/Workspace/nessy-desktop"'
    expect(primitivesSource.split(successor).length).toBe(2)
    const line = primitivesSource.split('\n').findIndex((l) => l.includes(successor)) + 1
    for (const planted of ['defaultValue="~/Workspace/craft-agents"', 'defaultValue="~/Workspace/Craft-Agents"']) {
      expect(upstreamBrandLines(primitivesSource.replace(successor, planted)), planted).toEqual([line])
    }
  })

  it('imports go through subpaths, never the barrel (R6)', () => {
    expect(primitivesSource).toContain('@nessy-agent/ui/motion')
    expect(primitivesSource).toContain('@nessy-agent/ui/ui/tooltip')
    expect(primitivesSource).not.toMatch(/from\s+'@nessy-agent\/ui'/)
  })
})

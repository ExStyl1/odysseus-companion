/**
 * P6.445 — the cost breakdown's design surface.
 *
 * The states this entry carries are reachable in a real session only by running
 * two different backends for long enough to spend money on each, so the
 * playground is the only place a reviewer can see them side by side — which is
 * this repo's own rule for a design surface, and the reason the row's UI is a
 * component rather than eight lines inside a 3000-line file.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { modelCostRows } from '../../components/app-shell/ChatDisplay.usage-format'
import {
  USAGE_COST_SHAPE_IDS,
  USAGE_COST_SHAPE_LABELS,
  USAGE_COST_SHAPE_TOTALS,
  USAGE_COST_SHAPES,
} from '../registry/usage-cost-data'

/**
 * The entry MODULE is deliberately not imported: it pulls `@/components/info`
 * and, transitively, the app's whole renderer graph including `pdfjs-dist`'s
 * worker URL import, which bun cannot evaluate. That is exactly why the fixtures
 * were split into `usage-cost-data.ts` — the states can be asserted for real,
 * and the wiring that cannot be imported is asserted against the source text.
 */
function source(name: string): string {
  return readFileSync(join(import.meta.dir, '..', 'registry', name), 'utf-8')
}

describe('session cost breakdown playground entry', () => {
  it('is wired into registry/index so it actually renders', () => {
    const index = source('index.ts')
    expect(index).toContain("import { usageCostComponents } from './usage-cost'")
    expect(index).toContain('...usageCostComponents,')
    expect(source('usage-cost.tsx')).toContain("category: 'Chat'")
  })

  /**
   * The four backend shapes, and the one that matters is `gateway-unpriced`:
   * the row exists because an unpriced model was indistinguishable from a free
   * one. A design surface that could not show it would not be reviewing the
   * change.
   */
  it('carries every backend shape, each with a label and a session total', () => {
    // `gateway-managed` joined the list in P6.537: the SAME unpriced gateway
    // record with an operator price table deployed, so the playground draws the
    // before and the after side by side.
    expect([...USAGE_COST_SHAPE_IDS])
      .toEqual(['claude-two-models', 'gateway-unpriced', 'gateway-managed', 'pi-no-map', 'mixed'])
    for (const id of USAGE_COST_SHAPE_IDS) {
      expect(USAGE_COST_SHAPE_LABELS[id].label).toBeTruthy()
      expect(USAGE_COST_SHAPE_TOTALS[id]).toBeTruthy()
    }
  })

  /**
   * The fixtures go through the SHIPPED `modelCostRows`, so what the playground
   * draws is what a session draws. Asserting the rows here is what stops the
   * design surface from showing a state the product cannot produce.
   */
  it('produces the state each shape claims when run through the shipped resolver', () => {
    expect(modelCostRows(USAGE_COST_SHAPES['claude-two-models']).map(row => row.basis)).toEqual(['list', 'list'])
    expect(modelCostRows(USAGE_COST_SHAPES['gateway-unpriced']).map(row => row.basis)).toEqual(['unknown'])
    expect(modelCostRows(USAGE_COST_SHAPES['gateway-unpriced'])[0]!.costUsd).toBeNull()
    expect(modelCostRows(USAGE_COST_SHAPES['pi-no-map'])).toEqual([])
    expect(modelCostRows(USAGE_COST_SHAPES.mixed).map(row => row.basis)).toEqual(['list', 'unknown'])
  })
})

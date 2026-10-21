/**
 * P6.445 — the cost-breakdown playground's fixtures, in a module with no
 * component imports.
 *
 * Split out for the same reason `settings-blocked-tools-data.ts` is: importing
 * the entry itself pulls `@/components/info` and, transitively, the app's whole
 * renderer graph — `pdfjs-dist`'s worker URL import included, which bun cannot
 * evaluate. A test that wants to assert the states exist should not have to
 * boot a PDF worker to do it.
 *
 * The fixtures are in the shape the record actually persists —
 * `Record<model, PersistedModelUsage>` — so the entry can pass them through the
 * real `modelCostRows` and show the shipped ordering and basis rules rather than
 * a hand-written approximation of them.
 */

import type { ManagedModelPricing } from '@config/managed-model-prices'

/** One fixture per backend shape a cost record can take. */
export type UsageCostShapeId =
  | 'claude-two-models'
  | 'gateway-unpriced'
  | 'gateway-managed'
  | 'pi-no-map'
  | 'mixed'

interface FixtureModelUsage {
  inputTokens: number
  outputTokens: number
  costUsd: number
  costReporting: string
}

/** Display order, and the order the entry's variants follow. */
export const USAGE_COST_SHAPE_IDS: readonly UsageCostShapeId[] = [
  'claude-two-models',
  'gateway-unpriced',
  'gateway-managed',
  'pi-no-map',
  'mixed',
]

/**
 * P6.537 — the operator's price table, per shape.
 *
 * Only `gateway-managed` deploys one, and that is the whole demonstration: the
 * SAME unpriced gateway record reads "Not reported" without a table and a
 * managed figure with one. We bundle no prices, so every other shape's entry is
 * `undefined` — which is also what ships.
 */
export const USAGE_COST_SHAPE_PRICING: Record<UsageCostShapeId, ManagedModelPricing | undefined> = {
  'claude-two-models': undefined,
  'gateway-unpriced': undefined,
  'gateway-managed': {
    overrides: { 'tgpt/qwen35-397b-a17b-fp8': { input: 0.4, output: 1.6 } },
  },
  'pi-no-map': undefined,
  mixed: undefined,
}

const SONNET = { inputTokens: 128_400, outputTokens: 9_120, costUsd: 0.8134, costReporting: 'reported' } as const
const QWEN = { inputTokens: 96_200, outputTokens: 7_400, costUsd: 0, costReporting: 'unsupported' } as const

export const USAGE_COST_SHAPES: Record<UsageCostShapeId, Record<string, FixtureModelUsage> | undefined> = {
  // Two models, both priced from the runtime's own bundled list table.
  'claude-two-models': {
    'claude-sonnet-4-5-20250929': SONNET,
    'claude-haiku-4-5-20251001': { inputTokens: 41_900, outputTokens: 2_300, costUsd: 0.0412, costReporting: 'reported' },
  },
  // The case the row exists for: nothing priced this model, so it must read as
  // unpriced rather than as free.
  'gateway-unpriced': { 'tgpt/qwen35-397b-a17b-fp8': QWEN },
  // P6.537 · the identical record, with an operator price table deployed. The
  // figure is the operator's, the label says so, and nothing about the record
  // changed — which is the point: the runtime still reported no cost.
  'gateway-managed': { 'tgpt/qwen35-397b-a17b-fp8': QWEN },
  // Pi reports a total and names no model, so there is no map to break down.
  'pi-no-map': undefined,
  // Where a basis label earns its place: one priced neighbour and one not.
  mixed: { 'claude-sonnet-4-5-20250929': SONNET, 'tgpt/qwen35-397b-a17b-fp8': QWEN },
}

/** The variant label and blurb for each shape, so the test can pin them too. */
export const USAGE_COST_SHAPE_LABELS: Record<UsageCostShapeId, { label: string; description: string }> = {
  'claude-two-models': { label: 'claude, two models', description: 'Both priced from the runtime\'s bundled list table' },
  'gateway-unpriced': { label: 'Gateway model, unpriced', description: 'The case the row exists for: no price was reported, so no figure is shown' },
  'gateway-managed': {
    label: 'Gateway model, managed price',
    description: 'P6.537 · the same unpriced record with an operator-supplied price table deployed. The figure is the organization\'s contracted rate, the basis label says so, and we bundle no prices at all — a wrong entry produces a confidently wrong figure, which is exactly why the label is part of the row.',
  },
  'pi-no-map': { label: 'Pi — no per-model map', description: 'Pi names no model, so the breakdown says so instead of implying one' },
  mixed: { label: 'Mixed basis', description: 'One priced neighbour and one unpriced — where the basis label earns its place' },
}

/** The session total each shape is shown beside, as the overlay formats it. */
export const USAGE_COST_SHAPE_TOTALS: Record<UsageCostShapeId, string> = {
  'claude-two-models': '$0.85',
  'gateway-unpriced': 'Not reported',
  'gateway-managed': '$0.05',
  'pi-no-map': '$0.41',
  mixed: '$0.81 (partial)',
}

import { describe, expect, it } from 'bun:test'
import { parseManagedModelPricing } from '@config/managed-model-prices'
import { formatUsageCostRow, modelCostRows } from '../ChatDisplay.usage-format'

/**
 * P6.537 — the managed basis becomes reachable, and the cost surface stops
 * reading a gateway model as free.
 *
 * P6.445 declared `managed` in `CostBasis` and left it unreachable on purpose,
 * writing that *"a row that has to invent the vocabulary as well as the table is
 * a row that will invent it differently"*. This suite is the other end of that:
 * the table exists, the label is reached, and the figure it produces is the one
 * the session total shows.
 */
const GATEWAY_MODEL = 'tgpt/qwen35-397b-a17b-fp8'

// The gateway reports tokens and no cost at all — the case the whole row exists
// for, and the reason `costReporting` is not `'reported'` here.
const GATEWAY_USAGE = {
  [GATEWAY_MODEL]: { inputTokens: 1_000_000, outputTokens: 500_000 },
}

const OPERATOR_TABLE = parseManagedModelPricing({
  overrides: { [GATEWAY_MODEL]: { input: 0.4, output: 1.6 } },
}).pricing

describe('the managed price table reaches the cost readout', () => {
  it('prices a model the runtime reported nothing for, and labels it managed', () => {
    const [row] = modelCostRows(GATEWAY_USAGE, OPERATOR_TABLE)
    expect(row!.basis).toBe('managed')
    expect(row!.costUsd).toBeCloseTo(0.4 + 0.8, 10)
  })

  it('moves the session total off nothing, which is the row\'s own done_means', () => {
    const labels = { unavailable: 'Not reported', partialSuffix: '(partial)' }
    // The positive control that this suite measures a CHANGE rather than an
    // always-true property. With no table the same session shows NOTHING —
    // `resolveCostDisplay` hides a row it has no figure for — and a backend that
    // explicitly reports no cost support says "Not reported". Both are the
    // honest states P6.445 shipped, and neither is a number.
    expect(formatUsageCostRow({ modelUsage: GATEWAY_USAGE } as never, 'en-US', labels, undefined))
      .toEqual({ visible: false, value: '' })
    expect(formatUsageCostRow(
      { modelUsage: GATEWAY_USAGE, costReporting: 'unsupported' } as never, 'en-US', labels, undefined,
    )).toEqual({ visible: true, value: 'Not reported' })

    const priced = formatUsageCostRow({ modelUsage: GATEWAY_USAGE } as never, 'en-US', labels, OPERATOR_TABLE)
    expect(priced.visible).toBe(true)
    expect(priced.value).toContain('1.2')
    expect(priced.value).not.toContain('Not reported')
  })

  it('a partially priced session says so rather than under-reporting silently', () => {
    const labels = { unavailable: 'Not reported', partialSuffix: '(partial)' }
    const mixed = { ...GATEWAY_USAGE, 'unlisted-model': { inputTokens: 9_000_000 } }
    const out = formatUsageCostRow({ modelUsage: mixed } as never, 'en-US', labels, OPERATOR_TABLE)
    expect(out.value).toContain('(partial)')
    expect(modelCostRows(mixed, OPERATOR_TABLE).find(r => r.model === 'unlisted-model')!.basis)
      .toBe('unknown')
  })

  it('negative — with no table deployed nothing changes at all', () => {
    const rows = modelCostRows(GATEWAY_USAGE, undefined)
    expect(rows[0]!.basis).toBe('unknown')
    // An unpriced model is NULL, never zero: a zero and an absence are the same
    // lie at either scale.
    expect(rows[0]!.costUsd).toBeNull()

    const listed = modelCostRows(
      { m: { inputTokens: 1, outputTokens: 1, costUsd: 0.3, costReporting: 'reported' } },
      undefined,
    )
    expect(listed[0]!.basis).toBe('list')
    expect(listed[0]!.costUsd).toBe(0.3)
  })

  it('the operator\'s table outranks the runtime\'s list price, as the page specifies', () => {
    const { pricing } = parseManagedModelPricing({ multiplier: 0.85 })
    const [row] = modelCostRows(
      { m: { inputTokens: 1, outputTokens: 1, costUsd: 2, costReporting: 'reported' } },
      pricing,
    )
    expect(row!.basis).toBe('managed')
    expect(row!.costUsd).toBeCloseTo(1.7, 10)
  })
})

describe('modelCostRows reads an old record keyed by the [1m] selector (F1.1279)', () => {
  it('shows one line under the bare claude id, and a non-claude bracketed id as written', () => {
    const rows = modelCostRows({
      'claude-opus-4-8[1m]': { inputTokens: 10, outputTokens: 1 },
      'claude-opus-4-8': { inputTokens: 5, outputTokens: 2 },
      'tgpt/qwen3[beta]': { inputTokens: 1, outputTokens: 1 },
    }, undefined)

    expect(rows.map(r => r.model).sort()).toEqual(['claude-opus-4-8', 'tgpt/qwen3[beta]'])
    expect(rows.find(r => r.model === 'claude-opus-4-8')).toMatchObject({ inputTokens: 15, outputTokens: 3 })
  })
})

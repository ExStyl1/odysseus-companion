import { describe, expect, it } from 'bun:test'
import { formatContextUsage, formatUsageCostRow } from '../ChatDisplay.usage-format'

const labels = { unavailable: 'Not reported', partialSuffix: '(partial)' }

describe('ChatDisplay usage overlay cost row', () => {
  it('says cost is not reported instead of rendering a zero', () => {
    // A Nestor Cloud / Nessy Gateway / Codex turn: the record's costUsd is 0
    // because nothing reported one. The row must not read as "$0.00".
    const row = formatUsageCostRow({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      contextTokens: 100,
      costUsd: 0,
      costReporting: 'unsupported',
    }, 'en-US', labels)

    expect(row).toEqual({ visible: true, value: 'Not reported' })
    expect(row.value).not.toContain('0.00')
    expect(row.value).not.toContain('$')
  })

  it('renders a reported amount', () => {
    expect(formatUsageCostRow({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      contextTokens: 100,
      costUsd: 1.5,
      costReporting: 'reported',
    }, 'en-US', labels)).toEqual({ visible: true, value: '$1.50' })
  })

  it('marks a mixed total as partial rather than complete', () => {
    expect(formatUsageCostRow({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      contextTokens: 100,
      costUsd: 2,
      costReporting: 'partial',
    }, 'en-US', labels)).toEqual({ visible: true, value: '$2.00 (partial)' })
  })

  it('keeps a pre-marker record hidden, as before', () => {
    expect(formatUsageCostRow({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    }, 'en-US', labels)).toEqual({ visible: false, value: '' })
  })
})

describe('ChatDisplay usage overlay formatting', () => {
  it('shows known model capacity when current fill is unknown', () => {
    expect(formatContextUsage({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
      contextUsage: {
        inputTokens: null,
        contextWindow: 131_072,
        contextWindowSource: 'runtime',
        source: 'unavailable',
      },
    }, 'en-US', 'Unavailable')).toBe('? / 131,072')
  })

  // The two DTO shapes the Context row has to serve, both measured live on
  // 2026-08-15 (F5's re-run). The Pi one is the control: the same occupancy in
  // a claude/codex-shaped record used to render `0 / 240,000 (0%)`, because
  // `ensureTokenUsage` initialises `contextTokens` to 0 and `??` took it.
  const PI_SHAPED = {
    inputTokens: 132_377,
    outputTokens: 1_412,
    totalTokens: 133_789,
    // Written by `applyContextUsageSnapshot`, the Pi-only path.
    contextTokens: 132_377,
    costUsd: 0,
    contextWindow: 240_000,
  }

  const GATEWAY_SHAPED = {
    // F6 made this correct on claude-runtime and codex-runtime…
    inputTokens: 132_377,
    outputTokens: 38,
    totalTokens: 132_415,
    // …while this stayed at its initialiser, because nothing outside Pi writes it.
    contextTokens: 0,
    costUsd: 0.29291,
    contextWindow: 240_000,
  }

  it('reads the same occupancy from a Pi-shaped and a claude/codex-shaped record', () => {
    expect(formatContextUsage(PI_SHAPED, 'en-US', 'Unavailable')).toBe('132,377 / 240,000 (55%)')

    const gateway = formatContextUsage(GATEWAY_SHAPED, 'en-US', 'Unavailable')
    expect(gateway).toBe('132,377 / 240,000 (55%)')
    // The measured pre-fix reading. The donut, which reads `inputTokens`, was
    // showing 55% on the same session at the same moment.
    expect(gateway).not.toBe('0 / 240,000 (0%)')
  })

  it('says the fill is unknown rather than zero when no counter observed one', () => {
    // A session before its first turn: 0 is the initialiser on BOTH fields, so
    // there is nothing to report — and "0 / 240,000 (0%)" would be a claim.
    expect(formatContextUsage({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
      contextWindow: 240_000,
    }, 'en-US', 'Unavailable')).toBe('? / 240,000')
  })

  it('shows unavailable instead of zero when both fill and capacity are unknown', () => {
    expect(formatContextUsage({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
      contextUsage: {
        inputTokens: null,
        contextWindow: null,
        contextWindowSource: 'unavailable',
        source: 'unavailable',
      },
    }, 'en-US', 'Unavailable')).toBe('Unavailable')
  })
})

/**
 * P6.445 — the cost readout names a model, a price basis and a caveat.
 *
 * MEASURED at HEAD before the change: `grep -arn modelUsage apps packages/ui`
 * scored 1 — the CLI's JSON envelope — against `costUsd` → 9 files. So the
 * per-model split was on disk, persisted by the claude adapter, and reached no
 * renderer at all: the app showed one number for a session that may have run
 * three models.
 *
 * The row's `done_means` has three clauses and says "removing any of the three
 * fails a test". They are the three describes below.
 */
import { COST_BASIS_KEYS, modelCostRows } from '../ChatDisplay.usage-format'
import enLocale from '@nessy-agent/shared/i18n/locales/en.json'
import ruLocale from '@nessy-agent/shared/i18n/locales/ru.json'

describe('P6.445 · (1) the per-model split', () => {
  it('turns the persisted map into one row per model, dearest first', () => {
    const rows = modelCostRows({
      'claude-haiku-4-5': { inputTokens: 900, outputTokens: 30, costUsd: 0.02, costReporting: 'reported' },
      'claude-sonnet-4-5': { inputTokens: 1200, outputTokens: 340, costUsd: 0.51, costReporting: 'reported' },
    })

    expect(rows.map(row => row.model)).toEqual(['claude-sonnet-4-5', 'claude-haiku-4-5'])
    expect(rows[0]).toEqual({
      model: 'claude-sonnet-4-5', inputTokens: 1200, outputTokens: 340, costUsd: 0.51, basis: 'list',
    })
  })

  it('is empty for a backend that reports no map at all — Pi names no model', () => {
    expect(modelCostRows(undefined)).toEqual([])
    expect(modelCostRows({})).toEqual([])
  })

  it('orders by name when two models cost the same, so the list does not shuffle', () => {
    const rows = modelCostRows({
      zeta: { inputTokens: 1, outputTokens: 1, costUsd: 0.1, costReporting: 'reported' },
      alpha: { inputTokens: 1, outputTokens: 1, costUsd: 0.1, costReporting: 'reported' },
    })
    expect(rows.map(row => row.model)).toEqual(['alpha', 'zeta'])
  })
})

describe('P6.445 · (3) the price basis, so an unpriced model is visibly not a free one', () => {
  it('marks an unpriced gateway model unknown and gives it NO figure', () => {
    const [row] = modelCostRows({
      'tgpt/qwen35-397b-a17b-fp8': { inputTokens: 4000, outputTokens: 200, costUsd: 0, costReporting: 'unsupported' },
    })

    expect(row!.basis).toBe('unknown')
    // The whole row: a zero and an absence are the same lie, so there is no
    // number to mistake for one.
    expect(row!.costUsd).toBeNull()
  })

  it('marks a runtime-priced model as a LIST price, which is what it is', () => {
    expect(modelCostRows({ m: { inputTokens: 1, outputTokens: 1, costUsd: 0.3, costReporting: 'reported' } })[0]!.basis)
      .toBe('list')
  })

  /**
   * `managed` is declared and unreachable until P6.537 builds the operator table
   * (owner decision 2026-09-05 D11 = A). Declared HERE because this file is
   * where a basis becomes a user-visible word, and a row that has to invent the
   * vocabulary as well as the table invents it differently.
   */
  it('declares all three bases, each with a string in BOTH locales', () => {
    expect(Object.keys(COST_BASIS_KEYS).sort()).toEqual(['list', 'managed', 'unknown'])
    for (const key of Object.values(COST_BASIS_KEYS)) {
      expect((enLocale as Record<string, string>)[key]).toBeTruthy()
      expect((ruLocale as Record<string, string>)[key]).toBeTruthy()
    }
  })
})

describe('P6.445 · (2) the estimate caveat', () => {
  /**
   * `agent-sdk/cost-tracking.md` opens with a Warning that the figures are
   * estimates. Every number this overlay draws is one — a published price
   * applied to a reported token count — and saying so is the difference between
   * a usage readout and an invoice a user might act on.
   */
  it('exists in both locales and says it is not a bill', () => {
    for (const locale of [enLocale, ruLocale] as Array<Record<string, string>>) {
      expect(locale['usage.costEstimateCaveat']).toBeTruthy()
      expect(locale['usage.costPerModelUnavailable']).toBeTruthy()
    }
    expect(enLocale['usage.costEstimateCaveat']).toContain('estimates')
    expect(enLocale['usage.costEstimateCaveat']).toContain('not a bill')
  })
})

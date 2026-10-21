/**
 * P6.445 — the cost group's body: the per-model split, the price basis and the
 * caveat.
 *
 * ## Why this is a component and not eight lines inside `ChatDisplay`
 *
 * It was eight lines inside `ChatDisplay`, and that is where the defect lived:
 * a single number with no model, no basis and no caveat, in a 3000-line file
 * nobody opens to review a cost readout. The three things this row adds are
 * exactly the three a reviewer has to LOOK at — an unpriced model must not read
 * as a free one — so they live in a component the playground can draw in every
 * state, which is this repo's own rule for a design surface.
 *
 * Presentational and IPC-free by construction: it takes rows and a `t`, holds no
 * state, and reads no atom. That is what lets the playground entry beside it
 * show the states a real session takes days to produce.
 */
import * as React from 'react'
import { Info_GroupedList } from '@/components/info'
import { COST_BASIS_KEYS, formatUsageCost, formatUsageNumber, type ModelCostRow } from './ChatDisplay.usage-format'

export interface UsageCostBreakdownProps {
  /** The session total, already formatted and already honest about absence. */
  totalValue: string
  /** One row per model, dearest first. Empty for a backend that reports no map. */
  rows: readonly ModelCostRow[]
  locale: string
  t: (key: string) => string
}

export function UsageCostBreakdown({ totalValue, rows, locale, t }: UsageCostBreakdownProps): React.ReactElement {
  return (
    <>
      <Info_GroupedList.Item>
        <div className="flex items-center justify-between gap-4 text-sm">
          <span className="text-muted-foreground">{t('usage.costUsd')}</span>
          <span className="font-mono text-foreground">{totalValue}</span>
        </div>
      </Info_GroupedList.Item>

      {rows.map(row => (
        <Info_GroupedList.Item key={row.model}>
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="min-w-0 truncate text-muted-foreground" title={row.model}>{row.model}</span>
            <span className="shrink-0 font-mono text-foreground">
              {formatUsageNumber(row.inputTokens, locale)}
              {' / '}
              {formatUsageNumber(row.outputTokens, locale)}
              {' · '}
              {/*
                A model nothing priced shows the "not reported" wording and NO
                figure. `$0.00` and a missing row are the same lie in different
                voices, and on this fork — gateway, Nestor Cloud, codex — the
                unpriced case is the common one.
              */}
              {row.costUsd === null ? t('usage.costUnavailable') : formatUsageCost(row.costUsd, locale)}
              {' · '}
              {t(COST_BASIS_KEYS[row.basis])}
            </span>
          </div>
        </Info_GroupedList.Item>
      ))}

      {rows.length === 0 && (
        <Info_GroupedList.Item>
          <p className="text-xs text-muted-foreground">{t('usage.costPerModelUnavailable')}</p>
        </Info_GroupedList.Item>
      )}

      {/*
        NOT optional decoration. `agent-sdk/cost-tracking.md` opens with a
        Warning that these are estimates, and every figure above is one: a
        published price applied to a reported token count, not a bill anyone
        issued.
      */}
      <Info_GroupedList.Item>
        <p className="text-xs text-muted-foreground">{t('usage.costEstimateCaveat')}</p>
      </Info_GroupedList.Item>
    </>
  )
}

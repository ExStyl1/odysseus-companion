/**
 * Playground registry for the SESSION COST BREAKDOWN (P6.445).
 *
 * The states this draws are the ones a real session takes days to reach and
 * that a reviewer most needs to see side by side, because the row's whole claim
 * is that they must not look alike: a claude session that ran two priced models,
 * a gateway session whose model NOTHING priced, a Pi session that names no model
 * at all, and the mixed case where a basis label earns its place.
 *
 * IPC-free: `t` resolves against the real English bundle, so the strings on show
 * are the shipped strings rather than placeholders. The fixtures live in
 * `usage-cost-data.ts` and go through the real `modelCostRows`, so the ordering
 * and the basis rules are the shipped ones.
 */

import * as React from 'react'
import enLocale from '@nessy-agent/shared/i18n/locales/en.json'
import { Info_GroupedList } from '@/components/info'
import { UsageCostBreakdown } from '@/components/app-shell/UsageCostBreakdown'
import { modelCostRows } from '@/components/app-shell/ChatDisplay.usage-format'
import type { ComponentEntry } from './types'
import {
  USAGE_COST_SHAPE_IDS,
  USAGE_COST_SHAPE_LABELS,
  USAGE_COST_SHAPE_TOTALS,
  USAGE_COST_SHAPES,
  USAGE_COST_SHAPE_PRICING,
  type UsageCostShapeId,
} from './usage-cost-data'

const strings = enLocale as Record<string, string>
const t = (key: string): string => strings[key] ?? key

interface Knobs {
  shape: UsageCostShapeId
  totalValue: string
}

function CostBreakdownPreview({ shape, totalValue }: Knobs) {
  return (
    <div className="w-[520px] overflow-hidden rounded-[8px] border border-border bg-background">
      <Info_GroupedList>
        <Info_GroupedList.Group label={t('usage.cost')} variant="success">
          <UsageCostBreakdown
            totalValue={totalValue}
            rows={modelCostRows(USAGE_COST_SHAPES[shape], USAGE_COST_SHAPE_PRICING[shape])}
            locale="en-US"
            t={t}
          />
        </Info_GroupedList.Group>
      </Info_GroupedList>
    </div>
  )
}

const KNOBS: ComponentEntry['props'] = [
  {
    name: 'shape',
    description: 'Which backend produced the record — the per-model map is a property of the backend, not of the session',
    control: {
      type: 'select',
      options: USAGE_COST_SHAPE_IDS.map(id => ({ label: USAGE_COST_SHAPE_LABELS[id].label, value: id })),
    },
    defaultValue: USAGE_COST_SHAPE_IDS[0],
  },
  {
    name: 'totalValue',
    description: 'The session total as the overlay already formats it — "Not reported" is its honest third state',
    control: { type: 'string' },
    defaultValue: USAGE_COST_SHAPE_TOTALS['claude-two-models'],
  },
]

export const usageCostComponents: ComponentEntry[] = [
  {
    id: 'usage-cost-breakdown',
    name: 'Session Cost Breakdown',
    category: 'Chat',
    description:
      'The usage overlay\'s cost group (P6.445): the session total, one line per model fed from the persisted modelUsage, each naming its price basis, and the estimate caveat. An unpriced model must be visibly unpriced — not $0.00, and not a missing line.',
    component: CostBreakdownPreview,
    layout: 'centered',
    props: KNOBS,
    variants: USAGE_COST_SHAPE_IDS.map(id => ({
      name: USAGE_COST_SHAPE_LABELS[id].label,
      description: USAGE_COST_SHAPE_LABELS[id].description,
      props: { shape: id, totalValue: USAGE_COST_SHAPE_TOTALS[id] },
    })),
  },
]

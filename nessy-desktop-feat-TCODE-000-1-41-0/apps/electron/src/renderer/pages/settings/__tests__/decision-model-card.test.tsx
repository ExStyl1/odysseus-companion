/**
 * UB6.5 — the Decision model card's named tests, at two scales.
 *
 * Pure (decision-model-shared.ts): the usage-note wordings are the row's added tests —
 * {withOutcome: 30, changed: 0} ends with "has not changed anything"; boundary
 * {withOutcome: 29} → no suffix; {withOutcome: 0} → the checks-only line — and the
 * connection-test description is the honest-failure wording ("Failed: …") rather than a
 * fabricated state.
 *
 * Rendered (DecisionModelCard through renderToStaticMarkup, the
 * IsolationNetworkPosture.test.tsx harness): the row's positive — enabling with Laya
 * reachable shows the server running line; the negative — a failed test shows the honest
 * failure, and the advanced expander stays closed by default.
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@nessy-agent/ui/components/tooltip'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import type { DecisionLayerStatus, DecisionTestResult, DecisionToggleUsage } from '@nessy-agent/shared/decisions'
import { DECISION_NO_CHANGE_MIN_CHECKS, decisionTestDescription, decisionUsageNote, buildDecisionFeatureGroups, filterReportedGroups } from '../decision-model-shared'
import { DecisionModelCard } from '../DecisionModelCard'

const t = ((key: string, opts?: Record<string, unknown>) => {
  let out = (en as Record<string, string>)[key] ?? key
  for (const [k, v] of Object.entries(opts ?? {})) out = out.replaceAll(`{{${k}}}`, String(v))
  return out
}) as (key: string, opts?: Record<string, unknown>) => string

function usageLine(withOutcome: number, changed = 0, calls = 30, failures = 0): DecisionToggleUsage {
  return { calls, failures, changed, withOutcome }
}

describe('decision usage note (UB6.5 added tests)', () => {
  it('a feature with outcomes shows checks · changed · failed, and 30 unchanged checks end with "has not changed anything"', () => {
    const line = decisionUsageNote(usageLine(30, 0), t)!
    expect(line).toContain('checks: 30')
    expect(line).toContain('changed: 0')
    expect(line.endsWith('has not changed anything')).toBe(true)
    // boundary: one check short of the claim stays a plain line
    expect(decisionUsageNote(usageLine(DECISION_NO_CHANGE_MIN_CHECKS - 1, 0), t)).not.toContain('has not changed anything')
    // a feature that changed something never carries the suffix
    expect(decisionUsageNote(usageLine(5, 2), t)).not.toContain('has not changed anything')
  })

  it('negative (control): a feature with no answered checks shows the checks-only line; no calls shows no note', () => {
    const checksOnly = decisionUsageNote(usageLine(0, 0, 4, 1), t)!
    expect(checksOnly).toContain('checks: 4')
    expect(checksOnly).not.toContain('changed:')
    expect(decisionUsageNote(undefined, t)).toBeUndefined()
  })
})

describe('decision test description (UB6.5)', () => {
  it('positive: a connected Laya test reads "Connected · model · ms"', () => {
    const ok: DecisionTestResult = { ok: true, provider: 'laya', endpoint: 'http://127.0.0.1:8000/v1/systemone', model: 'auto', latencyMs: 210, noul: 0.93 }
    expect(decisionTestDescription(ok, t)).toBe('Connected · auto · 210 ms')
  })

  it('negative (control): a failure is reported honestly as "Failed: <message>"', () => {
    const failed: DecisionTestResult = { ok: false, failure: { kind: 'unconfigured', message: 'Decision model: no API key stored for TypeSafe AI (direct). Add one in Settings > AI > Decision model' } }
    const line = decisionTestDescription(failed, t)
    expect(line.startsWith('Failed:')).toBe(true)
    expect(line).toContain('no API key stored')
    expect(decisionTestDescription(null, t)).toContain('canned yes/no question')
  })
})

describe('advanced feature groups (UB6.5: adopted features only)', () => {
  it('carries no dropped feature and filters to what a remote reports', () => {
    const groups = buildDecisionFeatureGroups(t)
    const features = groups.flatMap(g => g.toggles.map(row => row.feature))
    expect(features).not.toContain('guardedMode')
    expect(features).not.toContain('adaptiveThinking')
    expect(features).not.toContain('largeResults')
    expect(features).toContain('decideTool')
    expect(features).toContain('taskVerdicts')
    // a remote on an older version reports fewer features: only its toggles are shown
    const filtered = filterReportedGroups(groups, { decideTool: true, taskVerdicts: false })
    expect(filtered.flatMap(g => g.toggles.map(row => row.feature))).toEqual(['decideTool', 'taskVerdicts'])
    // every toggle names what is sent (the row's wording rule)
    for (const group of groups) {
      for (const row of group.toggles) expect(row.tooltip.length).toBeGreaterThan(40)
    }
  })
})

// ---------------------------------------------------------------------------
// The rendered card (the row's positive/negative through the real component)
// ---------------------------------------------------------------------------

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en as Record<string, string> } },
    interpolation: { escapeValue: false },
  })
})

const STATUS: DecisionLayerStatus = {
  settings: {
    enabled: true,
    provider: 'laya',
    deadlineMs: 1500,
    features: { decideTool: true, taskVerdicts: true, semanticLabels: true, turnOutcome: false, guardedMode: false, riskBadges: false, automationConditions: false, taskRepairs: false, smartTitles: false, adaptiveThinking: false, midTurnMessages: false, largeResults: false, suggestions: false },
  },
  providersWithKey: [],
  reusableConnections: [],
  presets: [
    { id: 'laya', label: 'Laya (local, open source)', baseUrl: 'http://127.0.0.1:8000', defaultModel: 'auto', keyPlaceholder: 'Optional: the LAYA_API_KEY you started the server with', docsUrl: 'https://github.com/NandhaKishorM/laya', requiresKey: false, local: true, installHint: 'pip install "laya[serve]" && laya-serve' },
    { id: 'typesafe', label: 'TypeSafe AI (direct)', baseUrl: 'https://api.typesafe.ai', defaultModel: 'jev-1.13.0', keyPlaceholder: 'TypeSafe API key', docsUrl: 'https://docs.typesafe.ai', requiresKey: true },
  ],
}

function baseProps(): React.ComponentProps<typeof DecisionModelCard> {
  return {
    status: STATUS,
    usage: {},
    testResult: null,
    testing: false,
    probe: null,
    probing: false,
    advancedOpen: false,
    onAdvancedOpenChange: () => {},
    modelDraft: '',
    baseUrlDraft: '',
    keyDraft: '',
    onModelDraftChange: () => {},
    onBaseUrlDraftChange: () => {},
    onKeyDraftChange: () => {},
    onUpdate: () => {},
    onCommitField: () => {},
    onKeySourceChange: () => {},
    onSaveKey: () => {},
    onRemoveKey: () => {},
    onTest: () => {},
    onProbe: () => {},
  }
}

function renderCard(props: Partial<React.ComponentProps<typeof DecisionModelCard>>): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <TooltipProvider>
      <DecisionModelCard {...baseProps()} {...props} />
    </TooltipProvider>
    </I18nextProvider>,
  )
}

describe('DecisionModelCard rendered (UB6.5)', () => {
  it('positive: Laya reachable shows the server running line with its loaded checkpoints', () => {
    const html = renderCard({
      probe: { provider: 'laya', baseUrl: 'http://127.0.0.1:8000', url: 'http://127.0.0.1:8000/health', reachable: true, status: 200, latencyMs: 12, health: { status: 'ok', loaded: ['laya-multilingual'] } },
    })
    expect(html).toContain('Running at http://127.0.0.1:8000')
    expect(html).toContain('laya-multilingual')
    expect(html).toContain('https://github.com/NandhaKishorM/laya')
    // reachable → no install hint (that line belongs to the negative arm)
    expect(html).not.toContain('Install and start it with:')
  })

  it('negative (control): nothing reachable shows the honest unreachable line and the install hint', () => {
    const html = renderCard({
      probe: { provider: 'laya', baseUrl: 'http://127.0.0.1:8000', url: 'http://127.0.0.1:8000/health', reachable: false, latencyMs: 5 },
    })
    expect(html).toContain('Not reachable at http://127.0.0.1:8000. Start the server, then re-check.')
    expect(html).toContain('Install and start it with:')
  })

  it('negative (control): a failed test shows the honest failure, and Advanced stays closed by default', () => {
    const failed: DecisionTestResult = { ok: false, failure: { kind: 'unconfigured', message: 'Decision model: no API key stored for TypeSafe AI (direct).' } }
    const html = renderCard({ testResult: failed })
    expect(html).toContain('Failed:')
    expect(html).toContain('no API key stored')
    expect(html).not.toContain('checks:') // the usage notes load only when Advanced opens
    const open = renderCard({ advancedOpen: true, usage: { decideTool: { calls: 12, failures: 0, changed: 3, withOutcome: 10 } } })
    expect(open).toContain('checks: 12')
  })
});

/**
 * UB15.11 — the card on v0.15.1's material (the restyle UB6.5 left to this row): every button `secondary md`, the
 * install hint and privacy note on `text-label-sm text-tertiary`, the Advanced expander on `EXPANDER_ROW_CLASS`
 * with an in-place body and `border-subtle` hairlines between its groups.
 */
describe('DecisionModelCard on the v0.15.1 material (UB15.11)', () => {
  const unreachable = { provider: 'laya', baseUrl: 'http://127.0.0.1:8000', url: 'http://127.0.0.1:8000/health', reachable: false, latencyMs: 5 } as const
  /** Every <button> opening tag in the markup. */
  const buttonTags = (html: string) => html.match(/<button[^>]*>/g) ?? []

  it('positive: the Advanced row is the shared expander row, the buttons are md, the notes are tertiary', () => {
    const html = renderCard({ probe: unreachable })
    // The expander is the one disclosure button that opens no popup (the key-source select's trigger also
    // carries aria-expanded, with aria-haspopup beside it).
    const disclosures = (markup: string) =>
      buttonTags(markup).filter(tag => tag.includes('aria-expanded') && !tag.includes('aria-haspopup'))
    const advanced = disclosures(html)
    expect(advanced).toHaveLength(1)
    expect(advanced[0]).toContain('aria-expanded="false"')
    expect(advanced[0]).toContain('min-h-14')
    expect(advanced[0]).toContain('hover:bg-fill-hover')
    // Docs, Re-check and Test: the md control height, never the sm one.
    const actions = buttonTags(html).filter(tag => tag.includes('data-slot="button"'))
    expect(actions.length).toBeGreaterThanOrEqual(3)
    expect(actions.filter(tag => !tag.includes('h-control ') || tag.includes('h-control-sm'))).toEqual([])
    expect(html).toContain('class="-mt-1 px-3.5 pb-3 text-label-sm text-tertiary"') // the install hint
    expect(html).toContain('class="-mt-1 px-3.5 pb-3.5 text-label-sm text-tertiary"') // the privacy note
  })

  it('negative (control): no pre-redesign ink remains, and the groups mount only when Advanced opens', () => {
    const closed = renderCard({ probe: unreachable })
    expect(closed).not.toContain('text-foreground/55')
    expect(closed).not.toMatch(/text-\[\d+px\]/)
    expect(closed).not.toContain('border-t border-subtle')
    const open = renderCard({ advancedOpen: true })
    expect(buttonTags(open).filter(tag => tag.includes('aria-expanded="true"') && !tag.includes('aria-haspopup'))).toHaveLength(1)
    expect(open).toContain('border-t border-subtle')
    expect(open).toContain('text-label-sm font-medium text-tertiary')
  })
})

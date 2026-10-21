/**
 * UB6.5 — the Decision model card in the playground (category Settings): the six states
 * the row names, swept in dark. The card is the REAL presentational component
 * (`DecisionModelCard`) with fixture status/probe/test/usage — the same props the page
 * wires from `window.electronAPI`. "Off" is the control: it proves the shipped default is
 * quiet (the advanced summary reads "Turn on the decision model…" and every toggle is
 * disabled), not an empty card.
 */

import * as React from 'react'
import type { ComponentEntry } from './types'
import { DecisionModelCard } from '@/pages/settings/DecisionModelCard'
import type { DecisionLayerStatus, DecisionServerProbe, DecisionTestResult, DecisionToggleUsage } from '@nessy-agent/shared/decisions'

const FEATURES = { decideTool: true, taskVerdicts: true, semanticLabels: true, turnOutcome: false, guardedMode: false, riskBadges: false, automationConditions: false, taskRepairs: false, smartTitles: false, adaptiveThinking: false, midTurnMessages: false, largeResults: false, suggestions: false }

function status(enabled: boolean, provider: DecisionLayerStatus['settings']['provider'], overrides: Partial<DecisionLayerStatus['settings']> = {}): DecisionLayerStatus {
  return {
    settings: { enabled, provider, deadlineMs: 1500, features: { ...FEATURES, ...overrides } },
    providersWithKey: [],
    reusableConnections: [
      { slug: 'openrouter-main', name: 'OpenRouter (personal)', provider: 'openrouter' },
    ],
    presets: [
      { id: 'typesafe', label: 'TypeSafe AI (direct)', baseUrl: 'https://api.typesafe.ai', defaultModel: 'jev-1.13.0', keyPlaceholder: 'TypeSafe API key', docsUrl: 'https://docs.typesafe.ai', requiresKey: true },
      { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', defaultModel: 'typesafe/jev-1.13', keyPlaceholder: 'sk-or-v1-...', dashboardUrl: 'https://openrouter.ai/settings/keys', docsUrl: 'https://openrouter.ai/typesafe/jev-1.13', requiresKey: true },
      { id: 'vercel-ai-gateway', label: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh/typesafe', defaultModel: 'typesafe-ai/jev', keyPlaceholder: 'AI Gateway API key', docsUrl: 'https://vercel.com/docs/ai-gateway', requiresKey: true },
      { id: 'laya', label: 'Laya (local, open source)', baseUrl: 'http://127.0.0.1:8000', defaultModel: 'auto', keyPlaceholder: 'Optional: the LAYA_API_KEY you started the server with', docsUrl: 'https://github.com/NandhaKishorM/laya', requiresKey: false, local: true, installHint: 'pip install "laya[serve]" && laya-serve' },
      { id: 'custom', label: 'Custom (Jev-compatible server)', baseUrl: '', defaultModel: 'jev-1.13.0', keyPlaceholder: 'API key (optional for local servers)', requiresKey: false, local: true },
    ],
  }
}

const LAYA_OK: DecisionServerProbe = { provider: 'laya', baseUrl: 'http://127.0.0.1:8000', url: 'http://127.0.0.1:8000/health', reachable: true, status: 200, latencyMs: 9, health: { status: 'ok', loaded: ['laya', 'laya-multilingual'], device: 'mps' } }
const LAYA_DOWN: DecisionServerProbe = { provider: 'laya', baseUrl: 'http://127.0.0.1:8000', url: 'http://127.0.0.1:8000/health', reachable: false, latencyMs: 120 }
const TEST_CONNECTED: DecisionTestResult = { ok: true, provider: 'laya', endpoint: 'http://127.0.0.1:8000/v1/systemone', model: 'auto', latencyMs: 187, noul: 0.95 }
const TEST_FAILED: DecisionTestResult = { ok: false, provider: 'typesafe', endpoint: 'https://api.typesafe.ai/v1/systemone', failure: { kind: 'unconfigured', message: 'Decision model: no API key stored for TypeSafe AI (direct). Add one in Settings > AI > Decision model' } }

const USAGE: Partial<Record<string, DecisionToggleUsage>> = {
  decideTool: { calls: 41, failures: 1, changed: 12, withOutcome: 38 },
  taskVerdicts: { calls: 7, failures: 0, changed: 0, withOutcome: 30 },
  semanticLabels: { calls: 3, failures: 3, changed: 0, withOutcome: 0 },
}

function Card(props: Partial<React.ComponentProps<typeof DecisionModelCard>>): React.ReactElement {
  return (
    <div className="max-w-3xl">
      <DecisionModelCard
        status={status(true, 'laya')}
        usage={{}}
        testResult={null}
        testing={false}
        probe={LAYA_OK}
        probing={false}
        advancedOpen={false}
        onAdvancedOpenChange={() => {}}
        modelDraft=""
        baseUrlDraft=""
        keyDraft=""
        onModelDraftChange={() => {}}
        onBaseUrlDraftChange={() => {}}
        onKeyDraftChange={() => {}}
        onUpdate={() => {}}
        onCommitField={() => {}}
        onKeySourceChange={() => {}}
        onSaveKey={() => {}}
        onRemoveKey={() => {}}
        onTest={() => {}}
        onProbe={() => {}}
        {...props}
      />
    </div>
  )
}

type State = 'off' | 'laya-down' | 'laya-ok' | 'custom' | 'test-failing' | 'advanced-usage'

function Preview({ state }: { state: State }): React.ReactElement {
  switch (state) {
    case 'off':
      return <Card status={status(false, 'typesafe')} />
    case 'laya-down':
      return <Card probe={LAYA_DOWN} />
    case 'laya-ok':
      return <Card testResult={TEST_CONNECTED} />
    case 'custom':
      return <Card status={status(true, 'custom')} probe={{ provider: 'custom', baseUrl: 'http://127.0.0.1:9000', url: 'http://127.0.0.1:9000/health', reachable: true, status: 200, latencyMs: 4 }} />
    case 'test-failing':
      return <Card status={status(true, 'typesafe')} probe={null} testResult={TEST_FAILED} />
    case 'advanced-usage':
      return <Card advancedOpen usage={USAGE} />
  }
}

export const settingsDecisionModelComponents: ComponentEntry[] = [
  {
    id: 'settings-decision-model',
    name: 'Decision model card',
    category: 'Settings',
    description:
      'UB6.5: the Settings > AI decision-model card — master switch off by default, the five provider presets with the Laya probe and install hint, the connection test (connected / honest failure), and the Advanced toggles (adopted features only) with tooltips naming what is sent and the per-toggle 7-day usage note',
    component: Preview,
    layout: 'top',
    props: [
      {
        name: 'state',
        description: 'Which card state to render',
        control: {
          type: 'select',
          options: [
            { value: 'off', label: 'Master switch off (the shipped default)' },
            { value: 'laya-down', label: 'Laya selected, server down (install hint)' },
            { value: 'laya-ok', label: 'Laya running, test connected' },
            { value: 'custom', label: 'Custom Jev-compatible server' },
            { value: 'test-failing', label: 'Test failing honestly (no key)' },
            { value: 'advanced-usage', label: 'Advanced open with per-toggle usage' },
          ],
        },
        defaultValue: 'laya-ok',
      },
    ],
    // UB15.11 — every state as a variant, so the registry render sweeps the restyled card in all six (dark).
    variants: [
      { name: 'Master switch off', props: { state: 'off' } },
      { name: 'Laya down (install hint)', props: { state: 'laya-down' } },
      { name: 'Custom server', props: { state: 'custom' } },
      { name: 'Test failing honestly', props: { state: 'test-failing' } },
      { name: 'Advanced open with usage', props: { state: 'advanced-usage' } },
    ],
  },
]

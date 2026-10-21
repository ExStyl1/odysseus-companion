/**
 * U3 CapabilityMcpToolsSection (renderer) + toMcpToolsState mapping.
 *
 * Placeholder-not-hidden: the section title ("Tools") ALWAYS renders. Its
 * states — collapsed(load) / loading / ok(table) / empty / error(retry) /
 * refused(disabled|disconnected|no-session) — each render their expected
 * surface. `toMcpToolsState` maps the RPC result to the UI state (ok, error,
 * and the pass-through refusal reasons).
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
// Import the component + mapping directly (not via the info barrel) so this
// test does not transitively pull Info_Markdown → pdfjs-dist worker URLs that
// bun cannot resolve in isolation.
import {
  CapabilityMcpToolsSection,
  type CapabilityMcpToolsState,
} from '@/components/info/CapabilityMcpToolsSection'
import { repeeksOnCapabilityChange, toMcpPeekState, toMcpToolsState } from '@/components/info/useCapabilityMcpTools'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const KEYS = [
  'sourceInfo.tools', 'sourceInfo.toolsDesc', 'sourceInfo.loadTools',
  'sourceInfo.noToolsReported', 'sourceInfo.failedToLoadTools',
  'sourceInfo.toolsDisabledPlaceholder', 'sourceInfo.toolsDisconnected',
  'sourceInfo.toolsNoSession', 'sourceInfo.toolsError',
  'capabilityDetail.retry', 'common.name', 'common.description',
]

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: Object.fromEntries(KEYS.map((k) => [k, k])) } },
    interpolation: { escapeValue: false },
  })
})

function render(state: CapabilityMcpToolsState): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <CapabilityMcpToolsSection state={state} onLoad={() => {}} onRetry={() => {}} />
    </I18nextProvider>,
  )
}

describe('CapabilityMcpToolsSection', () => {
  it('collapsed: shows the Load affordance and never the tools table', () => {
    const html = render({ status: 'collapsed' })
    expect(html).toContain('sourceInfo.tools') // title always present
    expect(html).toContain('data-testid="mcp-tools-load"')
    expect(html).not.toContain('data-testid="mcp-tool-row"')
  })

  it('loading: shows a skeleton, no table', () => {
    const html = render({ status: 'loading' })
    expect(html).toContain('data-testid="mcp-tools-loading"')
    expect(html).not.toContain('data-testid="mcp-tool-row"')
  })

  it('ok: renders a name/description row per tool (description optional)', () => {
    const html = render({ status: 'ok', tools: [{ name: 'search_code', description: 'Find code' }, { name: 'list_repos' }] })
    expect(html).toContain('common.name')
    expect(html).toContain('common.description')
    expect(html).toContain('search_code')
    expect(html).toContain('Find code')
    expect(html).toContain('list_repos')
    expect((html.match(/data-testid="mcp-tool-row"/g) ?? []).length).toBe(2)
    expect(html).not.toContain('mcp-tools-empty')
  })

  it('UB14.59: a loaded list states its count beside the title, the name in mono', () => {
    const html = render({ status: 'ok', tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] })
    expect(html).toContain('tabular-nums">3</span>')
    expect(html).toContain('<code class="break-all font-mono text-mono-ui font-medium text-foreground">a</code>')
  })

  it('UB14.59 control: no count while there is no list (collapsed, loading, failed, refused)', () => {
    for (const state of [
      { status: 'collapsed' },
      { status: 'loading' },
      { status: 'error' },
      { status: 'refused', reason: 'disabled' },
    ] as CapabilityMcpToolsState[]) {
      expect(render(state)).not.toContain('tabular-nums')
    }
    // The failure is a plain message on the secondary role, in the card's own inset.
    expect(render({ status: 'error' })).toContain('<p class="text-label text-secondary">sourceInfo.failedToLoadTools</p>')
  })

  it('ok with zero tools: explicit empty placeholder (section still present)', () => {
    const html = render({ status: 'ok', tools: [] })
    expect(html).toContain('sourceInfo.tools')
    expect(html).toContain('data-testid="mcp-tools-empty"')
    expect(html).toContain('sourceInfo.noToolsReported')
  })

  it('error: fail-soft placeholder + retry affordance', () => {
    const html = render({ status: 'error' })
    expect(html).toContain('data-testid="mcp-tools-error"')
    expect(html).toContain('data-testid="mcp-tools-retry"')
    expect(html).toContain('sourceInfo.failedToLoadTools')
  })

  it('refused disabled: explanatory placeholder (no retry)', () => {
    const html = render({ status: 'refused', reason: 'disabled' })
    expect(html).toContain('data-testid="mcp-tools-refused"')
    expect(html).toContain('sourceInfo.toolsDisabledPlaceholder')
    expect(html).not.toContain('data-testid="mcp-tools-retry"')
  })

  it('refused disconnected: explanatory placeholder', () => {
    const html = render({ status: 'refused', reason: 'disconnected' })
    expect(html).toContain('sourceInfo.toolsDisconnected')
  })

  it('refused no-session: explanatory placeholder', () => {
    const html = render({ status: 'refused', reason: 'no-session' })
    expect(html).toContain('sourceInfo.toolsNoSession')
  })
})

describe('toMcpToolsState', () => {
  it('maps ok to the loaded table state', () => {
    expect(toMcpToolsState({ status: 'ok', tools: [{ name: 't' }] })).toEqual({ status: 'ok', tools: [{ name: 't' }] })
  })
  it('maps the error refusal to the error UI state', () => {
    expect(toMcpToolsState({ status: 'refused', reason: 'error' })).toEqual({ status: 'error' })
  })
  it('passes through the disabled/disconnected/no-session refusal reasons', () => {
    expect(toMcpToolsState({ status: 'refused', reason: 'disabled' })).toEqual({ status: 'refused', reason: 'disabled' })
    expect(toMcpToolsState({ status: 'refused', reason: 'disconnected' })).toEqual({ status: 'refused', reason: 'disconnected' })
    expect(toMcpToolsState({ status: 'refused', reason: 'no-session' })).toEqual({ status: 'refused', reason: 'no-session' })
  })
})

describe('toMcpPeekState (auto-peek on detail open)', () => {
  it('a warm pool (ok) shows the tools table immediately — no Load click', () => {
    expect(toMcpPeekState({ status: 'ok', tools: [{ name: 't' }] })).toEqual({ status: 'ok', tools: [{ name: 't' }] })
  })
  it("a cold pool ('disconnected') falls back to the collapsed Load affordance", () => {
    // Peek never connects, so a cold pool keeps today's collapsed "Load tools"
    // button (whose click fires the full connecting call) — NOT the
    // 'disconnected' placeholder.
    expect(toMcpPeekState({ status: 'refused', reason: 'disconnected' })).toEqual({ status: 'collapsed' })
  })
  it("a recorded connect failure ('failed') states the failure instead of offering Load", () => {
    // Unlike a cold pool, a failed server will not be retried until its config
    // changes, so collapsing it to a "Load tools" button would just fail again
    // and tell the user nothing about why.
    expect(toMcpPeekState({ status: 'refused', reason: 'failed' })).toEqual({ status: 'refused', reason: 'failed' })
  })
  it('every other outcome maps exactly like the full call', () => {
    expect(toMcpPeekState({ status: 'refused', reason: 'disabled' })).toEqual({ status: 'refused', reason: 'disabled' })
    expect(toMcpPeekState({ status: 'refused', reason: 'no-session' })).toEqual({ status: 'refused', reason: 'no-session' })
    expect(toMcpPeekState({ status: 'refused', reason: 'error' })).toEqual({ status: 'error' })
  })
})

// F1.1259 (origin: the final sitting SIT2-a, TRIAGE D-12) — the built-in dp servers prefix every tool description
// with `|mcp-tool-attestation|<base64>|/mcp-tool-attestation|`, and the Tools table showed it raw. The table drops
// a LEADING envelope for display only; the description the model receives is untouched (this is a renderer cell).
describe('F1.1259 — the Tools table hides the dp attestation envelope', () => {
  const ENVELOPE = '|mcp-tool-attestation|eyJhdHRlc3RhdGlvbiI6ICJ4In0=|/mcp-tool-attestation|'

  it('a description led by the envelope shows only its text', () => {
    const html = render({ status: 'ok', tools: [{ name: 'dp_gitlab_job', description: `${ENVELOPE}\nRun a job` }] })
    expect(html).not.toContain('mcp-tool-attestation')
    expect(html).not.toContain('eyJhdHRlc3RhdGlvbiI6')
    expect(html).toContain('Run a job')
  })

  it('CONTROL: an envelope that does not lead the text, and a plain description, are shown as written', () => {
    const html = render({ status: 'ok', tools: [
      { name: 'quoted', description: `Explains ${ENVELOPE} blocks` },
      { name: 'plain', description: 'Find code' },
    ] })
    expect(html).toContain(`Explains ${ENVELOPE} blocks`)
    expect(html).toContain('Find code')
  })
})

// F1.1251 (origin: the final sitting SIT2-a, TRIAGE D-1) — an open MCP source page re-reads its tools when its
// workspace's capabilities change (a source or a built-in dp server switched on or off), instead of keeping the
// list it peeked on open until the page is re-opened. The re-read is a PEEK (never a connect), and it does not
// supersede a Load the user started.
describe('F1.1251 — the tools hook re-peeks on a capability change of its workspace', () => {
  const change = (workspaceId: string) => ({ workspaceId, generation: '', reasonCode: 'builtin-dp-mcp-changed', effect: 'refresh-before-next-turn' as const })

  it('a change in the page\'s own workspace re-peeks from any settled state', () => {
    for (const state of [{ status: 'ok', tools: [] }, { status: 'collapsed' }, { status: 'refused', reason: 'disabled' }, { status: 'error' }] as CapabilityMcpToolsState[]) {
      expect({ state: state.status, repeek: repeeksOnCapabilityChange(change('ws-1'), 'ws-1', state) }).toEqual({ state: state.status, repeek: true })
    }
  })

  it('CONTROL: another workspace\'s change, or a Load in flight, does not', () => {
    expect(repeeksOnCapabilityChange(change('ws-2'), 'ws-1', { status: 'ok', tools: [] })).toBe(false)
    expect(repeeksOnCapabilityChange(change('ws-1'), 'ws-1', { status: 'loading' })).toBe(false)
  })

  it('the hook subscribes to capabilities.onChanged and re-runs a peek through the predicate', () => {
    const source = readFileSync(fileURLToPath(new URL('../useCapabilityMcpTools.ts', import.meta.url)), 'utf8')
    expect(source).toContain('window.electronAPI.capabilities.onChanged(')
    expect(source).toContain('repeeksOnCapabilityChange(event, context.workspaceId, stateRef.current)')
  })
})

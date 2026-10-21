/**
 * U1 skill/source detail-page composition (nothing-lost).
 *
 * The pages compose CapabilityDetailTemplate from the SafeCapabilityDetail; the
 * async getDetail/preview roundtrips run in effects that a static render does
 * not execute, so this test drives the exact props the pages build (metadata
 * via the shared builders, diagnostics, and the CapabilityResources kind
 * section) through the template and asserts that everything the pre-U1 pages
 * displayed is still rendered:
 *   - type/scope/status rows + server safeFields
 *   - source connector origin + auth-timing rows
 *   - diagnostics
 *   - the CapabilityResources management section (Open/Edit affordances)
 * plus the eager-content states (loading skeleton / error+retry / empty
 * placeholder) mapped by the content panel.
 */

import * as React from 'react'
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  SafeCapabilityContextRef,
  SafeCapabilityDetail,
} from '@nessy-agent/shared/protocol/capabilities'
import { AppShellProvider, type AppShellContextType } from '@/context/AppShellContext'
import { buildSkillMetadata, buildSourceMetadata } from '../capability-info-metadata'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { materializeBuiltinDpMcpServers } from '@nessy-agent/shared/mcp/builtin-dp-servers'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// CapabilityResources → EditPopover transitively imports ThemeContext, which
// runs Vite's `import.meta.glob` at module scope (unavailable under bun). Stub
// the theme module before the info-barrel import below.
mock.module('@/context/ThemeContext', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: () => {} }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}))

// Info_Markdown (via CapabilityContentPanel/CapabilityResources) transitively
// imports pdfjs-dist; its worker URL import is unresolvable under bun.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

let CapabilityDetailTemplate: typeof import('@/components/info')['CapabilityDetailTemplate']
let CapabilityResources: typeof import('@/components/info')['CapabilityResources']
let Info_Section: typeof import('@/components/info')['Info_Section']

// Passthrough translations so assertions key on stable i18n keys.
const KEYS = [
  'common.type', 'skillInfo.scope', 'sourceInfo.scope', 'sessionMenu.status',
  'sourceInfo.connector', 'sourceInfo.connectorProvidedBy', 'sourceInfo.connectorAuthTiming',
  'sourceInfo.connectorAuthOnInstall', 'sourceInfo.connectorAuthOnFirstUse',
  'sourceInfo.documentation', 'skillInfo.instructions', 'common.open', 'common.editFile',
  'capabilityDetail.about', 'capabilityDetail.metadata', 'capabilityDetail.diagnostics',
  'capabilityDetail.noContent', 'capabilityDetail.noMetadata', 'capabilityDetail.noDiagnostics',
  'capabilityDetail.contentUnavailable', 'capabilityDetail.retry',
  'plugins.origin.acquisition.unknown', 'plugins.origin.format.unknown',
  'sourceInfo.unavailable.sourceDisabled',
]

let testI18n: I18nInstance
const t = ((key: string) => key) as (key: string, options?: Record<string, unknown>) => string

beforeAll(async () => {
  const info = await import('@/components/info')
  CapabilityDetailTemplate = info.CapabilityDetailTemplate
  CapabilityResources = info.CapabilityResources
  Info_Section = info.Info_Section

  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: Object.fromEntries(KEYS.map((k) => [k, k])) } },
    interpolation: { escapeValue: false },
  })
}, MODULE_GRAPH_HOOK_BUDGET_MS)

const context: SafeCapabilityContextRef = { workspaceId: 'ws' }
const appShellValue = { isCompactMode: false } as unknown as AppShellContextType

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <AppShellProvider value={appShellValue}>{node}</AppShellProvider>
    </I18nextProvider>,
  )
}

const skillDetail: SafeCapabilityDetail = {
  summary: {
    key: 'skill:demo', kind: 'skill', logicalName: 'demo', displayName: 'Demo Skill',
    description: 'A demo skill.', origin: 'native', scope: { kind: 'workspace', workspaceId: 'ws' },
    state: 'active', readOnly: false, trustState: 'not-required', credentialState: 'not-required',
    selectedAsUnqualifiedAlias: true, diagnosticCodes: [],
  },
  safeFields: [{ label: 'plugin', value: 'acme/tools' }],
  // Plugin-tier (read-only) resource: CapabilityResources renders its Open
  // (preview) affordance without an EditPopover, which a static render can't
  // host. The EditPopover Edit affordance is CapabilityResources' own
  // unchanged behavior; U1 only re-hosts CapabilityResources in the kind slot.
  resources: [{ ref: { scope: 'skill', tier: 'plugin', pluginInstanceId: 'p', capabilityId: 'demo', file: 'instructions' }, canPreview: true, canEdit: false, canOpen: false }],
  diagnostics: [{ severity: 'warning', code: 'cred-expiring', messageKey: 'Credential expiring soon' }],
}

const sourceDetail: SafeCapabilityDetail = {
  summary: {
    key: 'source:gh', kind: 'source', sourceType: 'mcp', logicalName: 'GitHub', description: 'GitHub source.',
    origin: 'plugin', connectorOrigin: { pluginKey: 'gh', connectorId: 'github', serverName: 'github', authTiming: 'ON_FIRST_USE' },
    scope: { kind: 'workspace', workspaceId: 'ws' }, state: 'active', readOnly: false,
    trustState: 'trusted', credentialState: 'ready', selectedAsUnqualifiedAlias: true, diagnosticCodes: [],
  },
  safeFields: [{ label: 'transport', value: 'http' }],
  // canEdit:false keeps the static render EditPopover-free (see skill fixture);
  // Open/Edit-File buttons still render, proving the resources section survives.
  resources: [
    { ref: { scope: 'source', workspaceId: 'ws', sourceId: 'GitHub', file: 'config' }, canPreview: false, canEdit: false, canOpen: true },
    { ref: { scope: 'source', workspaceId: 'ws', sourceId: 'GitHub', file: 'guide' }, canPreview: true, canEdit: false, canOpen: true },
  ],
  diagnostics: [],
}

// Mirror the pages' composition exactly.
function renderSkillPage(detail: SafeCapabilityDetail) {
  return render(
    <CapabilityDetailTemplate
      summary={detail.summary}
      displayName="Demo Skill"
      avatar={<span />}
      content={{ status: 'loaded', markdown: '# Instructions body' }}
      metadata={buildSkillMetadata(detail, t)}
      diagnostics={detail.diagnostics}
      kindSections={
        <Info_Section title={t('skillInfo.instructions')}>
          <CapabilityResources context={context} detail={detail} />
        </Info_Section>
      }
    />,
  )
}

function renderSourcePage(detail: SafeCapabilityDetail) {
  return render(
    <CapabilityDetailTemplate
      summary={detail.summary}
      displayName="GitHub"
      avatar={<span />}
      content={{ status: 'loaded', markdown: '# Guide body' }}
      metadata={buildSourceMetadata(detail, t)}
      diagnostics={detail.diagnostics}
      kindSections={
        <Info_Section title={t('sourceInfo.documentation')}>
          <CapabilityResources context={context} detail={detail} />
        </Info_Section>
      }
    />,
  )
}

describe('skill detail page composition — nothing lost', () => {
  it('renders type/scope/status + safeFields, diagnostics, content body, and the resources section', () => {
    const html = renderSkillPage(skillDetail)
    // Metadata rows preserved.
    expect(html).toContain('common.type')
    expect(html).toContain('skillInfo.scope')
    expect(html).toContain('sessionMenu.status')
    // Server safeField preserved.
    expect(html).toContain('plugin')
    expect(html).toContain('acme/tools')
    // Diagnostic preserved.
    expect(html).toContain('Credential expiring soon')
    // Eager content body rendered inline (loaded state).
    expect(html).toContain('Instructions body')
    // CapabilityResources management section present (Open preview affordance).
    expect(html).toContain('skillInfo.instructions')
    expect(html).toContain('common.open')
    // No absolute path leaks into the rendered markup.
    expect(html).not.toContain('/Users')
  })
})

describe('source detail page composition — nothing lost', () => {
  it('renders type/scope/status + connector origin + auth timing + safeFields + resources', () => {
    const html = renderSourcePage(sourceDetail)
    expect(html).toContain('common.type')
    expect(html).toContain('sourceInfo.scope')
    expect(html).toContain('sessionMenu.status')
    // Connector origin + auth timing rows preserved (source-specific).
    expect(html).toContain('sourceInfo.connector')
    expect(html).toContain('sourceInfo.connectorAuthTiming')
    // Server safeField preserved.
    expect(html).toContain('transport')
    expect(html).toContain('http')
    // Eager guide content inline.
    expect(html).toContain('Guide body')
    // Resources section present with Open (guide preview) + Edit-File affordances.
    expect(html).toContain('sourceInfo.documentation')
    expect(html).toContain('common.open')
    expect(html).toContain('common.editFile')
    expect(html).not.toContain('/Users')
  })
})

describe('metadata builders', () => {
  it('skill metadata orders type/scope/status then appends safeFields', () => {
    const rows = buildSkillMetadata(skillDetail, t)
    expect(rows.map((r) => r.label)).toEqual(['common.slug', 'common.type', 'skillInfo.scope', 'sessionMenu.status', 'plugin'])
    expect(rows[1].value).toBe('skill')
  })

  it('UB14.59: the skill slug row renders the logical name in mono; a source has no slug row', () => {
    const html = renderSkillPage(skillDetail)
    expect(html).toContain('<span class="font-mono text-mono-ui">demo</span>')
    expect(buildSourceMetadata(sourceDetail, t).map((r) => r.label)).not.toContain('common.slug')
  })

  it('source metadata includes connector + auth-timing rows only when present', () => {
    const withConnector = buildSourceMetadata(sourceDetail, t)
    expect(withConnector.map((r) => r.label)).toContain('sourceInfo.connector')
    expect(withConnector.map((r) => r.label)).toContain('sourceInfo.connectorAuthTiming')

    const bare: SafeCapabilityDetail = {
      ...sourceDetail,
      summary: { ...sourceDetail.summary, connectorOrigin: undefined },
    }
    const withoutConnector = buildSourceMetadata(bare, t)
    expect(withoutConnector.map((r) => r.label)).not.toContain('sourceInfo.connector')
    // Uppercased transport type preserved.
    expect(withoutConnector[0].value).toBe('MCP')
  })
})

describe('content panel state mapping', () => {
  it('renders the loading skeleton', () => {
    expect(render(
      <CapabilityDetailTemplate summary={skillDetail.summary} displayName="x" avatar={<span />}
        content={{ status: 'loading' }} />,
    )).toContain('data-testid="content-loading"')
  })

  it('renders the error placeholder with a retry affordance', () => {
    const html = render(
      <CapabilityDetailTemplate summary={skillDetail.summary} displayName="x" avatar={<span />}
        content={{ status: 'error', onRetry: () => {} }} />,
    )
    expect(html).toContain('data-testid="content-error"')
    expect(html).toContain('capabilityDetail.retry')
  })

  it('renders the empty placeholder when there is no content', () => {
    expect(render(
      <CapabilityDetailTemplate summary={skillDetail.summary} displayName="x" avatar={<span />}
        content={{ status: 'empty' }} />,
    )).toContain('data-testid="content-empty"')
  })
})

/**
 * F1.499 (1) + F1.461 — what SourceInfoPage says about a built-in dp MCP server
 * that cannot run.
 *
 * GET_DETAIL (`withBuiltinDpAvailability`, `handlers/rpc/capabilities.ts`)
 * answers a built-in dp row two ways, pinned server-side by
 * `builtin-dp-detail-unavailable-reason.test.ts`: dp MISSING → the
 * materializer's own `builtin_dp_mcp.dp_not_found` sentence REPLACES the
 * resolver's reason; dp PRESENT → the detail as resolved, where a server nobody
 * switched on (every built-in ships off) carries `source-disabled`. This page
 * half shows each answer reaching the metadata description — the sentence as
 * written, and the OFF code translated rather than printed raw, which it was
 * until `source-disabled` joined `UNAVAILABLE_REASON_KEYS`.
 *
 * The page loads the detail in an effect a static render does not run, so this
 * composes the template the way the page does (as the two describes above do)
 * and pins, from the page's own source, that the page hands the RPC's summary
 * and diagnostics to the template untouched — the only step the mirror assumes.
 */
describe('SourceInfoPage — a built-in dp MCP server that cannot run (F1.461, F1.499)', () => {
  /** React's text escaping, so the sentence is compared as the markup carries it. */
  const escapeHtml = (text: string) => text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
  // The list row's own join (`messages.join(' ')`), which GET_DETAIL reuses.
  const DP_MISSING_SENTENCE = materializeBuiltinDpMcpServers({ enabled: {}, runtimeEnv: {}, resolveDpPath: () => null })
    .diagnostics.map((diagnostic) => diagnostic.message).join(' ')

  function builtinDpJiraDetail(unavailableReason: string): SafeCapabilityDetail {
    return {
      summary: {
        key: 'builtin:mcp:dpJira', kind: 'mcp', logicalName: 'dpJira', origin: 'builtin',
        scope: { kind: 'builtin' }, state: 'disabled', unavailableReason, readOnly: false,
        trustState: 'not-required', credentialState: 'not-required',
        selectedAsUnqualifiedAlias: true, diagnosticCodes: [],
      },
      safeFields: [],
      resources: [],
      diagnostics: [],
    }
  }

  function renderSourceInfoPage(detail: SafeCapabilityDetail) {
    return render(
      <CapabilityDetailTemplate
        summary={detail.summary}
        displayName="dpJira"
        avatar={<span />}
        content={{ status: 'empty' }}
        metadata={buildSourceMetadata(detail, t)}
        diagnostics={detail.diagnostics}
      />,
    )
  }

  it('dp missing: the page says why the server cannot start, in the materializer\'s own words', () => {
    expect(DP_MISSING_SENTENCE).toContain('need the `dp` CLI')
    const html = renderSourceInfoPage(builtinDpJiraDetail(DP_MISSING_SENTENCE))
    expect(html).toContain(escapeHtml(DP_MISSING_SENTENCE))
    expect(html).not.toContain('source-disabled')
    expect(html).not.toContain('sourceInfo.unavailable.sourceDisabled')
  })

  it('dp present, switched off: the OFF reason is translated, never the raw code, and no dp sentence', () => {
    const html = renderSourceInfoPage(builtinDpJiraDetail('source-disabled'))
    expect(html).toContain('sourceInfo.unavailable.sourceDisabled')
    expect(html).not.toContain('source-disabled')
    expect(html).not.toContain('need the `dp` CLI')
  })

  it('the page hands the RPC\'s summary and diagnostics to the template untouched', () => {
    const page = readFileSync(join(import.meta.dir, '..', 'SourceInfoPage.tsx'), 'utf8')
    expect(page).toContain('setDetail(await window.electronAPI.capabilities.getDetail(context, capabilityKey))')
    expect(page).toContain('const summary = detail?.summary')
    expect(page).toContain('summary={summary ?? EMPTY_SUMMARY}')
    expect(page).toContain('diagnostics={detail?.diagnostics}')
    // No rewrite of the reason on the way: the page never names the field.
    expect(page).not.toContain('unavailableReason')
  })
})

/**
 * U4 SourcesManagementRow + SourcesManagementRowList (renderer state matrix).
 *
 * Management-panel identity (R2): every row is the ONE Sources card —
 * status-bearing avatar, name, the category derived from the row, and the
 * description (owner reports 2026-08-01; since UB12.74 the title meta and line
 * 2 of v0.15.1's row anatomy) — plus state;
 * enablement lives in the row MENU (owner decision 2026-07-19 — the
 * AutomationMenu pattern; a disabled row dims), api/local are display-only.
 * Placeholder-not-hidden: awaiting-auth / error / empty each render an
 * explicit surface, never vanish.
 *
 * Imported directly (not via the info barrel) so this test does not transitively
 * pull Info_Markdown → pdfjs-dist worker URLs bun cannot resolve in isolation.
 *
 * This file used to record itself as a KNOWN RED that threw at module load
 * (`SourcesManagementRow` → `EntityRow` → `styled-dropdown` → the
 * `@nessy-agent/ui` barrel's Vite-only `pdf.worker.min.mjs?url`). It loads:
 * `styled-dropdown` takes its primitives from a subpath now, and on 2026-10-16
 * (UB12.74) this file ran green beside eight others before any edit. The
 * Plugins subsection's cross-panel gate is the per-subsection arm in
 * `app-shell/__tests__/source-card.test.tsx`, which renders this row through
 * the subsection's own `pluginRowSummary` projection.
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  SourcesManagementRow,
  type SourcesManagementRowProps,
} from '@/components/info/SourcesManagementRow'
import {
  SourcesManagementRowList,
  type SourcesManagementRowEntry,
} from '@/components/info/SourcesManagementRowList'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'

const KEYS = [
  'sourcesList.typeMcp', 'sourcesList.typeApi', 'sourcesList.typeLocal', 'sourcesList.pluginBadge',
  'sourcesManagement.awaitingAuth', 'sourcesManagement.toggleFailed',
  'sourcesManagement.scopeWorkspace', 'sourcesManagement.scopeProject',
  'sourcesManagement.enable', 'sourcesManagement.disable',
  'sourcesManagement.stateEnabled', 'sourcesManagement.stateDisabled',
  'sourcesManagement.noPluginsInstalled',
  'sourceInfo.connectorProvidedBy',
  'plugins.origin.format.nessy', 'plugins.origin.format.codex', 'plugins.origin.format.claude',
  'plugins.origin.format.unknown', 'plugins.origin.acquisition.repository',
  'plugins.origin.acquisition.nessyMarketplace', 'plugins.origin.acquisition.externalMarketplace',
  'plugins.origin.acquisition.unknown',
]

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        translation: {
          ...Object.fromEntries(KEYS.map((k) => [k, k])),
          // Interpolated key used by PluginOriginBadge/connector line.
          'sourceInfo.connectorProvidedBy': 'Provided by connector {{connector}}',
        },
      },
    },
    interpolation: { escapeValue: false },
  })
})

const mcpSummary: SafeCapabilitySummary = {
  key: 'source:github',
  kind: 'mcp',
  logicalName: 'GitHub',
  displayName: 'GitHub',
  description: 'Repositories and issues over the GitHub MCP server.',
  origin: 'plugin',
  presentation: { format: 'nessy', acquisition: 'nessy-marketplace' },
  connectorOrigin: { pluginKey: 'gh', connectorId: 'github', serverName: 'github', authTiming: 'ON_FIRST_USE' },
  scope: { kind: 'workspace', workspaceId: 'ws' },
  state: 'active',
  readOnly: false,
  trustState: 'trusted',
  credentialState: 'ready',
  selectedAsUnqualifiedAlias: true,
  diagnosticCodes: [],
}

const apiSummary: SafeCapabilitySummary = {
  ...mcpSummary,
  key: 'source:linear',
  kind: 'source',
  sourceType: 'api',
  logicalName: 'Linear',
  displayName: 'Linear',
  description: 'Linear GraphQL API.',
  origin: 'native',
  presentation: undefined,
  connectorOrigin: undefined,
}

function renderRow(props: Partial<SourcesManagementRowProps> = {}): string {
  const merged: SourcesManagementRowProps = {
    summary: mcpSummary,
    displayName: mcpSummary.displayName!,
    avatar: <span data-testid="mock-avatar" />,
    ...props,
  }
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <SourcesManagementRow {...merged} />
    </I18nextProvider>,
  )
}

describe('SourcesManagementRow', () => {
  // UB14.59 — the title, not the row, carries the disabled state: the AutomationsListPanel
  // pattern since UB14.44 (the solved tertiary text is AA; a 50% row was not).
  const TITLE_TERTIARY = /data-slot="entity-row-title" class="[^"]*\btext-tertiary\b/

  it('enablement kind: enabled row does not dim; no display-only chip', () => {
    const html = renderRow({ enablement: { enabled: true, scope: 'workspace' } })
    expect(html).toContain('data-testid="sources-management-row"')
    expect(html).not.toMatch(TITLE_TERTIARY)
    expect(html).not.toContain('opacity-50')
    expect(html).not.toContain('data-testid="row-display-only-state"')
  })

  it('disabled row reads dimmer through its tertiary title, never a 50% row', () => {
    const html = renderRow({ enablement: { enabled: false, scope: 'project' } })
    expect(html).toMatch(TITLE_TERTIARY)
    expect(html).not.toContain('opacity-50')
  })

  it('display-only kind (api): shows the management state chip', () => {
    const html = renderRow({ summary: apiSummary, displayName: 'Linear' })
    expect(html).toContain('data-testid="row-display-only-state"')
    expect(html).toContain('sourcesManagement.stateEnabled')
  })

  it('is the ONE card: the category derived from the row as the title meta, the description on line 2 (UB12.74)', () => {
    // Owner report 2026-08-01: the acquisition badge beside the name
    // ("Figma  ⊙ External marketplace") and the connector provenance line are
    // GONE — acquisition belongs in the badge row or nowhere, and the badge row
    // was already ruled provenance-free. The summary still CARRIES both, so
    // this is the card refusing to render them, not a missing input.
    const html = renderRow({ enablement: { enabled: true, scope: 'workspace' } })
    expect(mcpSummary.presentation).toBeDefined()
    expect(mcpSummary.connectorOrigin).toBeDefined()
    expect(html).toMatch(/data-slot="entity-row-meta"[^>]*><span data-testid="source-card-meta-mcp">sourcesList\.typeMcp<\/span>/)
    expect(html).not.toContain('source-category-badge-')
    const lineTwo = html.slice(html.indexOf('data-slot="entity-row-subtitle"'))
    expect(lineTwo).toContain('data-testid="source-card-description"')
    expect(lineTwo).toContain('Repositories and issues over the GitHub MCP server.')
    expect(html).not.toContain('plugins.origin.acquisition.nessyMarketplace')
    expect(html).not.toContain('Provided by connector github')
  })

  it('awaiting-auth: renders an explicit inline note INSIDE the row (placeholder-not-hidden)', () => {
    const html = renderRow({ enablement: { enabled: true, scope: 'workspace', awaitingAuth: true } })
    expect(html).toContain('data-testid="row-awaiting-auth"')
    expect(html).toContain('sourcesManagement.awaitingAuth')
  })

  it('enablement-in-flight: pending shows a spinner', () => {
    const html = renderRow({ enablement: { enabled: true, scope: 'workspace', pending: true } })
    expect(html).toContain('data-testid="row-enablement-pending"')
  })

  it('failed enablement: generic error note when error === true', () => {
    const html = renderRow({ enablement: { enabled: false, scope: 'workspace', error: true } })
    expect(html).toContain('data-testid="row-enablement-error"')
    expect(html).toContain('sourcesManagement.toggleFailed')
  })

  it('failed enablement: renders the caller-provided error string verbatim', () => {
    const html = renderRow({ enablement: { enabled: false, scope: 'workspace', error: 'Network unreachable' } })
    expect(html).toContain('data-testid="row-enablement-error"')
    expect(html).toContain('Network unreachable')
    expect(html).not.toContain('sourcesManagement.toggleFailed')
  })
})

function renderList(rows: SourcesManagementRowEntry[]): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <SourcesManagementRowList title="Plugins" rows={rows} />
    </I18nextProvider>,
  )
}

describe('SourcesManagementRowList', () => {
  it('populated: renders one row per entry', () => {
    const rows: SourcesManagementRowEntry[] = [
      { id: 'a', summary: mcpSummary, displayName: 'GitHub', enablement: { enabled: true, scope: 'workspace' } },
      { id: 'b', summary: apiSummary, displayName: 'Linear' },
    ]
    const html = renderList(rows)
    expect((html.match(/data-testid="sources-management-row"/g) ?? []).length).toBe(2)
    expect(html).not.toContain('data-testid="sources-management-empty"')
  })

  it('empty: renders the honest placeholder, section still present', () => {
    const html = renderList([])
    expect(html).toContain('Plugins') // optional section title, when one is passed
    expect(html).toContain('data-testid="sources-management-empty"')
    expect(html).toContain('sourcesManagement.noPluginsInstalled')
    expect(html).not.toContain('data-testid="sources-management-row"')
  })
})

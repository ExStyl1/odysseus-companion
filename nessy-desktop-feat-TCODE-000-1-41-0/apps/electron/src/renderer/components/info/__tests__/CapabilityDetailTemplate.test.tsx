/**
 * U1 universal capability detail template — renderer contract.
 *
 * Proves the placeholder-not-hidden principle (every common section renders
 * for every kind, with an explicit placeholder when data is absent), that the
 * content panel switches across all four states, and that a file-ref chip
 * fires its callback (invoked at the element-tree level; no DOM needed).
 */

import * as React from 'react'
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import type {
  CapabilityContentFileRef,
  CapabilityContentPanelStatus,
} from '../CapabilityContentPanel'
import { AppShellProvider, type AppShellContextType } from '@/context/AppShellContext'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

// Info_Markdown transitively imports pdfjs-dist; its worker URL import is
// unresolvable under bun — stub it before the dynamic imports below.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

// react-pdf (via @nessy-agent/ui's markdown overlay) bundles its own pdfjs
// which references DOMMatrix at module scope — shim it under bun.
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

let CapabilityDetailTemplate: typeof import('../CapabilityDetailTemplate')['CapabilityDetailTemplate']
let connectionStatePill: typeof import('../CapabilityDetailTemplate')['connectionStatePill']
let Info_HeaderMenu: typeof import('../Info_HeaderMenu')['Info_HeaderMenu']
let capabilitySummaryConnectionStatus: typeof import('../../ui/source-status-indicator')['capabilitySummaryConnectionStatus']
let capabilitySummaryDisplayStatus: typeof import('../../ui/source-status-indicator')['capabilitySummaryDisplayStatus']
let SourceAvatar: typeof import('../../ui/source-avatar')['SourceAvatar']
let CapabilityContentPanel: typeof import('../CapabilityContentPanel')['CapabilityContentPanel']
let ContentFileRefChips: typeof import('../CapabilityContentPanel')['ContentFileRefChips']

// Passthrough translations: the values equal the keys so assertions can key on
// the stable i18n keys rather than English copy.
const KEYS = [
  'capabilityDetail.about',
  'capabilityDetail.metadata',
  'capabilityDetail.diagnostics',
  'capabilityDetail.noContent',
  'capabilityDetail.noMetadata',
  'capabilityDetail.noDiagnostics',
  'capabilityDetail.contentUnavailable',
  'capabilityDetail.retry',
  'capabilityDetail.readOnly',
  'capabilityDetail.dedupInertComponents',
  'plugins.origin.acquisition.unknown',
  'plugins.origin.acquisition.repository',
  'plugins.origin.format.claude',
  'plugins.origin.format.unknown',
  'sourceInfo.unavailable.duplicatesBuiltin',
  'sourceInfo.unavailable.duplicatesEndpoint',
  'sourceInfo.unavailable.managedDenied',
  'sourceInfo.unavailable.sourceDisabled',
  'sourceInfo.unavailable.unusableWireName',
  'sourceInfo.technicalDetails',
  'sourceStatus.failed.label',
  'sourceStatus.untested.label',
  'sourceStatus.connected.label',
  'sourcesList.statusAuthRequired',
  'sourcesList.statusConnected',
  'sourcesList.statusDisabled',
  'sourcesList.statusDisconnected',
  'sourcesList.statusNotTested',
  'common.more',
]

let testI18n: I18nInstance

beforeAll(async () => {
  const panel = await import('../CapabilityContentPanel')
  const template = await import('../CapabilityDetailTemplate')
  CapabilityContentPanel = panel.CapabilityContentPanel
  ContentFileRefChips = panel.ContentFileRefChips
  CapabilityDetailTemplate = template.CapabilityDetailTemplate
  connectionStatePill = template.connectionStatePill
  Info_HeaderMenu = (await import('../Info_HeaderMenu')).Info_HeaderMenu
  SourceAvatar = (await import('../../ui/source-avatar')).SourceAvatar
  capabilitySummaryConnectionStatus = (await import('../../ui/source-status-indicator')).capabilitySummaryConnectionStatus
  capabilitySummaryDisplayStatus = (await import('../../ui/source-status-indicator')).capabilitySummaryDisplayStatus

  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        translation: {
          ...Object.fromEntries(KEYS.map((k) => [k, k])),
          // UB14.48 — the one interpolated title: the key, then the name, so both are assertable.
          'sourceInfo.connectionErrorTitle': 'sourceInfo.connectionErrorTitle {{name}}',
        },
      },
    },
    interpolation: { escapeValue: false },
  })
}, MODULE_GRAPH_HOOK_BUDGET_MS)

function summaryOf(kind: SafeCapabilitySummary['kind'], overrides: Partial<SafeCapabilitySummary> = {}): SafeCapabilitySummary {
  return {
    key: `${kind}:mock`,
    kind,
    logicalName: `${kind} mock`,
    displayName: `${kind} Detail`,
    description: `${kind} tagline`,
    origin: 'native',
    scope: { kind: 'workspace', workspaceId: 'ws' },
    state: 'active',
    readOnly: false,
    trustState: 'not-required',
    credentialState: 'not-required',
    selectedAsUnqualifiedAlias: true,
    diagnosticCodes: [],
    ...overrides,
  }
}

// PanelHeader (used by Info_Page.Header) reads leadingAction + isCompactMode
// from the AppShell context; a minimal value is enough for a static render.
const appShellValue = { isCompactMode: false } as unknown as AppShellContextType

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <AppShellProvider value={appShellValue}>{node}</AppShellProvider>
    </I18nextProvider>,
  )
}

const KINDS: SafeCapabilitySummary['kind'][] = ['skill', 'source', 'mcp', 'app']

describe('CapabilityDetailTemplate — common sections per kind', () => {
  for (const kind of KINDS) {
    it(`renders all common sections with placeholders for kind=${kind} when data is absent`, () => {
      const html = render(
        <CapabilityDetailTemplate
          summary={summaryOf(kind)}
          displayName={`${kind} Detail`}
          avatar={<span />}
          content={{ status: 'empty' }}
          metadata={[]}
          diagnostics={[]}
        />,
      )

      // The four common sections are always present.
      expect(html).toContain('capabilityDetail.about')
      expect(html).toContain('capabilityDetail.metadata')
      expect(html).toContain('capabilityDetail.diagnostics')

      // Absent data → explicit placeholders, never a missing section.
      expect(html).toContain('capabilityDetail.noContent')
      expect(html).toContain('capabilityDetail.noMetadata')
      expect(html).toContain('capabilityDetail.noDiagnostics')
    })
  }

  it('renders metadata rows and diagnostics when present (no placeholder)', () => {
    const html = render(
      <CapabilityDetailTemplate
        summary={summaryOf('skill')}
        displayName="Skill Detail"
        avatar={<span />}
        content={{ status: 'loaded', markdown: 'Body text here' }}
        metadata={[{ label: 'Version', value: '1.2.3' }]}
        diagnostics={[{ severity: 'warning', code: 'x', messageKey: 'A diagnostic line' }]}
      />,
    )
    expect(html).toContain('Version')
    expect(html).toContain('1.2.3')
    expect(html).toContain('A diagnostic line')
    expect(html).toContain('Body text here')
    expect(html).not.toContain('capabilityDetail.noMetadata')
    expect(html).not.toContain('capabilityDetail.noDiagnostics')
    expect(html).not.toContain('capabilityDetail.noContent')
  })

  it('slots a kind-specific section between content and metadata', () => {
    const html = render(
      <CapabilityDetailTemplate
        summary={summaryOf('mcp')}
        displayName="MCP Detail"
        avatar={<span />}
        content={{ status: 'loaded', markdown: 'guide' }}
        kindSections={<div>KIND_SPECIFIC_STUB</div>}
      />,
    )
    expect(html).toContain('KIND_SPECIFIC_STUB')
  })

  it('translates a recognized `unavailableReason` code (T4: `duplicates-builtin`) instead of leaking it raw', () => {
    const html = render(
      <CapabilityDetailTemplate
        summary={summaryOf('mcp', { state: 'disabled', unavailableReason: 'duplicates-builtin' })}
        displayName="MCP Detail"
        avatar={<span />}
        content={{ status: 'empty' }}
      />,
    )
    expect(html).toContain('sourceInfo.unavailable.duplicatesBuiltin')
    expect(html).not.toContain('duplicates-builtin')
  })

  it('translates a recognized `unavailableReason` code (T4b: `duplicates-endpoint`) instead of leaking it raw', () => {
    const html = render(
      <CapabilityDetailTemplate
        summary={summaryOf('mcp', { state: 'disabled', unavailableReason: 'duplicates-endpoint' })}
        displayName="MCP Detail"
        avatar={<span />}
        content={{ status: 'empty' }}
      />,
    )
    expect(html).toContain('sourceInfo.unavailable.duplicatesEndpoint')
    expect(html).not.toContain('duplicates-endpoint')
  })

  it('P3.218: translates `managed-denied` rather than the user\'s own OFF wording', () => {
    // The row's whole point. A managed denial and a user's own OFF both arrive
    // as `sourceEnabled: false`, so until the resolver split them this page
    // showed `source-disabled` for a decision the user cannot change — and the
    // toggle it invited them to flip reverts.
    const html = render(
      <CapabilityDetailTemplate
        summary={summaryOf('mcp', { state: 'disabled', unavailableReason: 'managed-denied' })}
        displayName="MCP Detail"
        avatar={<span />}
        content={{ status: 'empty' }}
      />,
    )
    expect(html).toContain('sourceInfo.unavailable.managedDenied')
    // NOT the raw code: without the map entry `unavailableReasonText` falls
    // through to `base = reason`, which is what a user would have read.
    expect(html).not.toContain('managed-denied')
    // …and NOT the user's own OFF wording, which is the sentence this row exists
    // to stop showing here.
    expect(html).not.toContain('sourceInfo.unavailable.sourceDisabled')
  })

  it('F1.499 (1): translates the user\'s own OFF (`source-disabled`) instead of leaking the raw code', () => {
    // The resolver's `!enabled` verdict for a server the user switched off
    // (`resolver.ts`: `record.managedDenied ? 'managed-denied' : 'source-disabled'`).
    // Without a map entry `unavailableReasonText` falls through to `base = reason`,
    // and the detail page's metadata description read `source-disabled`.
    const html = render(
      <CapabilityDetailTemplate
        summary={summaryOf('mcp', { state: 'disabled', unavailableReason: 'source-disabled' })}
        displayName="MCP Detail"
        avatar={<span />}
        content={{ status: 'empty' }}
      />,
    )
    expect(html).toContain('sourceInfo.unavailable.sourceDisabled')
    expect(html).not.toContain('source-disabled')
    // Not the managed-denial wording either: the two OFFs stay distinct.
    expect(html).not.toContain('sourceInfo.unavailable.managedDenied')
  })

  it('F2: appends the inert-components note when the matching dedup diagnostic carries safeArgs.inertComponents', () => {
    const html = render(
      <CapabilityDetailTemplate
        summary={summaryOf('mcp', { state: 'disabled', unavailableReason: 'duplicates-builtin' })}
        displayName="MCP Detail"
        avatar={<span />}
        content={{ status: 'empty' }}
        diagnostics={[{
          severity: 'info',
          code: 'capability.dedup.builtin-identity',
          messageKey: 'capability.dedup.builtin-identity',
          safeArgs: { inertComponents: 'hook:PreToolUse, skill:tracker-skill' },
        }]}
      />,
    )
    expect(html).toContain('sourceInfo.unavailable.duplicatesBuiltin')
    expect(html).toContain('capabilityDetail.dedupInertComponents')
  })

  it('does not append the inert-components note when the matching dedup diagnostic carries no safeArgs', () => {
    const html = render(
      <CapabilityDetailTemplate
        summary={summaryOf('mcp', { state: 'disabled', unavailableReason: 'duplicates-builtin' })}
        displayName="MCP Detail"
        avatar={<span />}
        content={{ status: 'empty' }}
        diagnostics={[{ severity: 'info', code: 'capability.dedup.builtin-identity', messageKey: 'capability.dedup.builtin-identity' }]}
      />,
    )
    expect(html).toContain('sourceInfo.unavailable.duplicatesBuiltin')
    expect(html).not.toContain('capabilityDetail.dedupInertComponents')
  })

  it('falls back to the raw string for an unrecognized `unavailableReason` (pre-existing gap, unchanged)', () => {
    const html = render(
      <CapabilityDetailTemplate
        summary={summaryOf('mcp', { state: 'disabled', unavailableReason: 'shadowed-by-mcp-precedence' })}
        displayName="MCP Detail"
        avatar={<span />}
        content={{ status: 'empty' }}
      />,
    )
    expect(html).toContain('shadowed-by-mcp-precedence')
  })

  it('F3: shows the unusable-wire-name reason read directly off the diagnostic, with no `unavailableReason` to key off', () => {
    // Unlike the T4/T4b dedup reasons, `capability.mcp.unusable-wire-name`
    // never disables the capability — the summary stays active/no reason —
    // so this exercises the diagnostics-only fallback branch.
    const html = render(
      <CapabilityDetailTemplate
        summary={summaryOf('mcp')}
        displayName="MCP Detail"
        avatar={<span />}
        content={{ status: 'empty' }}
        diagnostics={[{
          severity: 'warning',
          code: 'capability.mcp.unusable-wire-name',
          messageKey: 'capability.mcp.unusable-wire-name',
          safeArgs: { server: 'my server.v2' },
        }]}
      />,
    )
    expect(html).toContain('sourceInfo.unavailable.unusableWireName')
  })

  it('shows no unavailable reason when neither `unavailableReason` nor the unusable-wire-name diagnostic is present', () => {
    const html = render(
      <CapabilityDetailTemplate
        summary={summaryOf('mcp')}
        displayName="MCP Detail"
        avatar={<span />}
        content={{ status: 'empty' }}
        diagnostics={[]}
      />,
    )
    expect(html).not.toContain('sourceInfo.unavailable.unusableWireName')
  })
})

/**
 * UB14.48 (R7-04 amendment) — a failed `source_test` shows on the detail page. The page renders through
 * this template, so the verdict arrives on the summary: the pip on the real `SourceAvatar` turns
 * `failed`, and the stored reason is an alert titled with the source's name, its text under
 * Technical details (v0.15.1 `SourceInfoPage.tsx`'s connection-error banner).
 */
describe('CapabilityDetailTemplate — UB14.48 the stored connection verdict', () => {
  const renderSource = (overrides: Partial<SafeCapabilitySummary>): string => {
    const summary = summaryOf('source', { sourceType: 'mcp', ...overrides })
    return render(
      <CapabilityDetailTemplate
        summary={summary}
        displayName="GitHub"
        avatar={<SourceAvatar source={summary} fluid showStatus />}
        content={{ status: 'empty' }}
      />,
    )
  }

  it('a stored `error` renders `failed` plus the connection-error alert with its reason', () => {
    const html = renderSource({
      state: 'active',
      credentialState: 'ready',
      lastTestStatus: 'failed',
      connectionError: '  HTTP 502 from https://mcp.example.com/…  ',
    })
    expect(html).toContain('data-source-status="failed"')
    expect(html).toContain('data-testid="connection-error"')
    expect(html).toContain('sourceInfo.connectionErrorTitle GitHub')
    expect(html).toContain('sourceInfo.technicalDetails')
    // The raw text sits in the disclosure, trimmed as upstream trims it.
    expect(html).toContain('>HTTP 502 from https://mcp.example.com/…</pre>')
  })

  it('control — `untested` stays grey and shows no alert', () => {
    // UB12.87: this switched-off source's pip reads the display status, `disabled` (the grey ring that
    // says "Disabled"), where it used to read rule 4's `untested`; either way it is grey, not `failed`.
    const html = renderSource({ state: 'disabled', credentialState: 'not-required', lastTestStatus: 'untested' })
    expect(html).toContain('data-source-status="disabled"')
    expect(html).not.toContain('data-source-status="failed"')
    expect(html).not.toContain('data-testid="connection-error"')
    expect(html).not.toContain('sourceInfo.connectionErrorTitle')
    // A blank stored reason is no reason: still no alert.
    expect(renderSource({ lastTestStatus: 'failed', connectionError: '   ' })).not.toContain('data-testid="connection-error"')
  })
})

/**
 * UB14.59 — the hero anatomy of v0.15.1's detail pages on our template: the name in the hero ONLY,
 * the header's "⋯" from `headerActions` (or nothing), the state pill on the meta line, the page's
 * buttons as the hero's own `actions`. The pill is driven exactly as `SourceInfoPage` drives it,
 * through the pip's own verdict as the surfaces print it (`capabilitySummaryDisplayStatus`, UB12.75)
 * and `connectionStatePill`.
 */
describe('CapabilityDetailTemplate — UB14.59 the hero anatomy', () => {
  const NAME = 'Zephyr Source Name'
  const renderHero = (
    overrides: Partial<SafeCapabilitySummary>,
    extra: Partial<React.ComponentProps<typeof CapabilityDetailTemplate>> = {},
  ): string => {
    const summary = summaryOf('source', { sourceType: 'mcp', ...overrides })
    const pill = connectionStatePill(capabilitySummaryDisplayStatus(summary), (key) => testI18n.t(key))
    return render(
      <CapabilityDetailTemplate
        summary={summary}
        displayName={NAME}
        avatar={<span />}
        statePill={pill}
        content={{ status: 'empty' }}
        {...extra}
      />,
    )
  }
  /** The hero row: from its wrapper to the first section card under it. */
  const heroOf = (html: string): string => {
    const start = html.indexOf('mt-2 flex items-center gap-3.5')
    expect(start).toBeGreaterThan(-1)
    return html.slice(start, html.indexOf('<section', start))
  }

  it('a failed verdict renders the `bad` state pill in the hero and the error banner', () => {
    const html = renderHero({
      state: 'disabled',
      credentialState: 'ready',
      lastTestStatus: 'failed',
      connectionError: 'HTTP 502 from https://mcp.example.com/…',
    })
    const hero = heroOf(html)
    expect(hero).toContain('bg-destructive-tint text-destructive')
    expect(hero).toContain('sourcesList.statusDisconnected')
    expect(html).toContain('data-testid="connection-error"')
  })

  it('control — a connected one renders the `ok` pill and no banner', () => {
    const html = renderHero({ state: 'active', credentialState: 'ready' })
    const hero = heroOf(html)
    expect(hero).toContain('bg-success-tint text-success')
    expect(hero).toContain('sourcesList.statusConnected')
    expect(hero).not.toContain('bg-destructive-tint')
    expect(html).not.toContain('data-testid="connection-error"')
  })

  it('maps every pip verdict to its v0.15.1 tone and label', () => {
    const t = (key: string) => key
    expect(connectionStatePill('connected', t)).toEqual({ tone: 'ok', label: 'sourcesList.statusConnected' })
    expect(connectionStatePill('needs_auth', t)).toEqual({ tone: 'warn', label: 'sourcesList.statusAuthRequired' })
    expect(connectionStatePill('untested', t)).toEqual({ tone: 'off', label: 'sourcesList.statusNotTested' })
    expect(connectionStatePill('local_disabled', t)).toEqual({ tone: 'off', label: 'sourcesList.statusDisabled' })
    expect(connectionStatePill('failed', t)).toEqual({ tone: 'bad', label: 'sourcesList.statusDisconnected' })
    expect(connectionStatePill('disabled', t)).toEqual({ tone: 'off', label: 'sourcesList.statusDisabled' })
  })

  it('UB12.75 POSITIVE — a source the user switched off reads Disabled on the off pill, not Not Tested', () => {
    const summary = summaryOf('source', { sourceType: 'mcp', state: 'disabled', credentialState: 'not-required' })
    // The pip's verdict is unchanged (rule 4's bucket); only the printed word is refined.
    expect(capabilitySummaryConnectionStatus(summary)).toBe('untested')
    expect(capabilitySummaryDisplayStatus(summary)).toBe('disabled')
    const hero = heroOf(renderHero({ state: 'disabled', credentialState: 'not-required' }))
    expect(hero).toContain('bg-fill-hover text-secondary')
    expect(hero).toContain('sourcesList.statusDisabled')
    expect(hero).not.toContain('sourcesList.statusNotTested')
  })

  it('UB12.75 control — a never-tested source that is not switched off keeps Not Tested; a failed disabled one stays bad', () => {
    for (const state of ['review-required', 'shadowed', 'unsupported-runtime'] as const) {
      const hero = heroOf(renderHero({ state, credentialState: 'not-required' }))
      expect(hero, state).toContain('sourcesList.statusNotTested')
      expect(hero, state).not.toContain('sourcesList.statusDisabled')
    }
    expect(capabilitySummaryDisplayStatus({ state: 'disabled', credentialState: 'ready', lastTestStatus: 'failed' })).toBe('failed')
    expect(capabilitySummaryDisplayStatus({ state: 'disabled', credentialState: 'missing' })).toBe('needs_auth')
    expect(capabilitySummaryDisplayStatus({ state: 'disabled', credentialState: 'not-required', mcpTransport: 'stdio' }, false))
      .toBe('local_disabled')
  })

  it('renders `actions` inside the hero row, after the name', () => {
    const html = renderHero({ state: 'active', credentialState: 'ready' }, {
      actions: <button type="button" data-testid="hero-action-probe">Act</button>,
    })
    const hero = heroOf(html)
    expect(hero).toContain('data-testid="hero-action-probe"')
    expect(hero.indexOf(NAME)).toBeLessThan(hero.indexOf('hero-action-probe'))
  })

  it('no header title: the name is rendered exactly once, in the hero h2', () => {
    const html = renderHero({ state: 'active', credentialState: 'ready' })
    expect(html.split(NAME).length - 1).toBe(1)
    expect(heroOf(html)).toContain(`<h2 class="text-title text-foreground [overflow-wrap:anywhere]">${NAME}</h2>`)
  })

  it('a page with `headerActions` renders its named "⋯" menu in the header, above the hero', () => {
    const html = renderHero({ state: 'active', credentialState: 'ready' }, {
      headerActions: (
        <Info_HeaderMenu label="More source actions">
          <span>item</span>
        </Info_HeaderMenu>
      ),
    })
    const trigger = html.indexOf('aria-label="More source actions"')
    expect(trigger).toBeGreaterThan(-1)
    expect(html).toContain('aria-haspopup="menu"')
    expect(trigger).toBeLessThan(html.indexOf('mt-2 flex items-center gap-3.5'))
  })

  it('control — a page with no actions renders no menu trigger at all', () => {
    const html = renderHero({ state: 'active', credentialState: 'ready' })
    expect(html).not.toContain('aria-haspopup="menu"')
    expect(html).not.toContain('aria-label="common.more"')
  })

  it('the origin badge sits on the meta line, after the pill and before the tagline', () => {
    const html = renderHero({ state: 'active', credentialState: 'ready', presentation: { format: 'claude', acquisition: 'repository' } })
    const hero = heroOf(html)
    const pill = hero.indexOf('sourcesList.statusConnected')
    const origin = hero.indexOf('plugins.origin.acquisition.repository')
    const tagline = hero.indexOf('source tagline')
    expect(pill).toBeGreaterThan(-1)
    expect(origin).toBeGreaterThan(pill)
    expect(tagline).toBeGreaterThan(origin)
  })
})

describe('CapabilityContentPanel — state switching', () => {
  const states: Array<[CapabilityContentPanelStatus, string]> = [
    ['loading', 'data-testid="content-loading"'],
    ['error', 'data-testid="content-error"'],
    ['empty', 'data-testid="content-empty"'],
    ['loaded', 'data-testid="content-loaded"'],
  ]

  for (const [status, marker] of states) {
    it(`renders the ${status} state marker`, () => {
      const html = render(
        <CapabilityContentPanel status={status} markdown="Loaded body" errorMessage="boom" />,
      )
      expect(html).toContain(marker)
    })
  }

  it('error state shows a retry affordance only when onRetry is provided', () => {
    const withRetry = render(<CapabilityContentPanel status="error" onRetry={() => {}} />)
    const withoutRetry = render(<CapabilityContentPanel status="error" />)
    expect(withRetry).toContain('capabilityDetail.retry')
    expect(withoutRetry).not.toContain('capabilityDetail.retry')
  })

  it('loaded state renders file-ref chips with a relative-path tooltip', () => {
    const html = render(
      <CapabilityContentPanel
        status="loaded"
        markdown="body"
        fileRefs={[{ id: 'a', label: 'Program.cs', relativePath: 'src/Api/Program.cs' }]}
      />,
    )
    expect(html).toContain('data-testid="content-file-ref"')
    expect(html).toContain('Program.cs')
    expect(html).toContain('title="src/Api/Program.cs"')
  })
})

describe('ContentFileRefChips — callback firing', () => {
  it('invokes onOpenFileRef with the clicked ref', () => {
    const refs: CapabilityContentFileRef[] = [
      { id: 'a', label: 'Program.cs', relativePath: 'src/Api/Program.cs' },
      { id: 'b', label: 'Tests.cs', relativePath: 'tests/Tests.cs' },
    ]
    const clicked: string[] = []
    // Hook-free component: invoke directly to inspect the element tree.
    const tree = ContentFileRefChips({ fileRefs: refs, onOpenFileRef: (r) => clicked.push(r.id) })
    const buttons = React.Children.toArray(tree.props.children) as React.ReactElement[]
    expect(buttons).toHaveLength(2)
    // Fire the second chip's onClick.
    ;(buttons[1].props as { onClick: () => void }).onClick()
    expect(clicked).toEqual(['b'])
  })
})

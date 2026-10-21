/**
 * C6 (capability-path plan, ADR § 6): the unified MCP servers panel — ONE
 * surface for plugin-owned and user-created servers.
 *
 * Proven here: the row builder merges both origins without duplication and
 * keys plugin rows with their `{pluginKey, capabilityId}` toggle target; the
 * rendered panel shows origin label + transport + auth state per row, offers
 * the enable switch ONLY for plugin rows, and the plugin-filtered variant is
 * the SAME rows narrowed — never a different shape. (The policy half of the
 * toggle round trip lives in server-core's mcp-server-toggle-roundtrip test.)
 */

import * as React from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SafeCapabilitySummary, UserCapabilityCatalog } from '@nessy-agent/shared/protocol/capabilities'
import { pluginServerAuthKind } from '@nessy-agent/shared/protocol/capabilities'
import { buildMcpServerRows } from '@/lib/capability-catalog'
import {
  applyBuiltinDpMcpToggle,
  persistBuiltinDpMcpServerEnabled,
  useBuiltinDpMcpServers,
} from '@/hooks/useBuiltinDpMcpServers'
import type { BuiltinDpMcpSettingsViewV1 } from '../../../../shared/types'

// P6.837 — this import is STATIC again, and the pdfjs carve-out that stood
// here is gone. The panel used to reach the `@nessy-agent/ui` barrel through
// `source-avatar` -> `source-status-indicator`, and the barrel pulls the
// Vite-only `pdfjs-dist/...?url` specifier bun cannot resolve, so the module
// failed to LOAD and this 34-case file ran zero tests while reporting
// `1 fail / 1 error`. The indicator now imports `@nessy-agent/ui/ui/tooltip`
// instead of the barrel, so the chain is gone at its source rather than
// mocked per suite. If this file ever reports `Ran 1 test across 1 file`
// again, read the resolution error before the fail count.
import {
  capabilityConnectTarget,
  connectPluginServer,
  McpServersPanel,
  McpServerReconnectButton,
  mcpRowAuthMarkerKey,
  mcpRowLiveStatusMarker,
  mcpRowWireName,
  PluginServerConnectButton,
  pluginServerConnectTarget,
} from '../McpServersPanel'

/**
 * DA1.52 · the `builtin_dp_mcp.dp_not_found` sentence, copied verbatim from
 * `packages/shared/src/mcp/builtin-dp-servers.ts` symbol
 * `materializeBuiltinDpMcpServers`, which is the only producer of this
 * diagnostic. The fixture is deliberately a LITERAL — this suite renders an RPC
 * payload and must never reach the dp resolver — but it was a literal TWICE
 * before, and both copies still promised the pre-DA1.6 two-place lookup after
 * the product had moved to the four-rung ladder. One copy, read by both
 * fixtures and by both assertions, so the next rewording is one edit.
 */
const DP_NOT_FOUND_MESSAGE = 'The built-in Nessy MCP servers need the `dp` CLI, which was not found in any of the four '
  + 'places Nessy looks: the path in NESSY_DP, the system `dp` (PATH, then /usr/local/bin/dp), '
  + '<CONFIG_DIR>/dp/bin/dp and <NESSY_HOME>/dp_latest/dp. Install Spirit CLI (`dp`), or point '
  + 'NESSY_DP at the copy you want, and reopen the workspace; nothing else in the app is affected.'

const translations = {
  'mcpServers.authConnected': 'Connected',
  'mcpServers.authExpired': 'Sign-in expired',
  'mcpServers.authNeeded': 'Sign in required',
  'mcpServers.builtinUnavailable': 'Needs dp',
  'mcpServers.empty': 'No MCP servers',
  'mcpServers.emptyDescription': 'MCP servers from plugins and your own connections appear here together.',
  'mcpServers.originBuiltin': 'Built-in',
  'mcpServers.originPlugin': 'Plugin',
  'mcpServers.originUser': 'User',
  'mcpServers.reconnect': 'Reconnect',
  'mcpServers.reconnectFailed': 'Reconnect failed',
  'mcpServers.reconnecting': 'Reconnecting...',
  'mcpServers.statusFailed': 'Not connected',
  'mcpServers.statusNoTools': 'No tools',
  'mcpServers.statusToolsSkipped': 'Some tools skipped',
  'mcpServers.stateDisabled': 'Disabled',
  'mcpServers.stateEnabled': 'Enabled',
  'mcpServers.toggleAria': 'Enable server',
  'pendingAuth.connect': 'Connect',
  'pendingAuth.connecting': 'Connecting...',
  'pendingAuth.error': 'Sign-in failed. Try again.',
}

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: translations } },
    interpolation: { escapeValue: false },
  })
})

function summary(partial: Partial<SafeCapabilitySummary> & Pick<SafeCapabilitySummary, 'key' | 'kind' | 'logicalName'>): SafeCapabilitySummary {
  return {
    origin: 'plugin',
    scope: { kind: 'workspace', workspaceId: 'ws_a' },
    state: 'active',
    readOnly: true,
    trustState: 'trusted',
    credentialState: 'not-required',
    selectedAsUnqualifiedAlias: false,
    diagnosticCodes: [],
    ...partial,
  }
}

function catalog(): Pick<UserCapabilityCatalog, 'installedPlugins' | 'capabilities'> {
  return {
    capabilities: [
      summary({
        key: 'plugin:mk#mcp.tracker', kind: 'mcp', logicalName: 'tracker-mcp',
        mcpTransport: 'http', credentialState: 'missing',
      }),
      summary({
        key: 'source:workspace:ws_a:my-server', kind: 'source', logicalName: 'my-server',
        sourceType: 'mcp', origin: 'native', readOnly: false, mcpTransport: 'stdio',
      }),
      // A non-MCP source must never enter the panel.
      summary({
        key: 'source:workspace:ws_a:my-api', kind: 'source', logicalName: 'my-api',
        sourceType: 'api', origin: 'native', readOnly: false,
      }),
    ],
    installedPlugins: [{
      pluginKey: 'mk.tracker',
      marketplaceId: 'mk',
      pluginId: 'tracker',
      version: '1.0.0',
      name: 'Tracker Toolkit',
      installedAt: 1,
      capabilityKinds: ['mcp'],
      diagnostics: [],
      activation: { global: 'unset', workspace: 'enabled' },
      components: [{
        kind: 'mcp', name: 'tracker-mcp',
        capabilityKey: 'plugin:mk#mcp.tracker', capabilityId: 'mcp.tracker',
        enabled: true,
      }],
    } as unknown as UserCapabilityCatalog['installedPlugins'][number]],
  }
}

describe('buildMcpServerRows', () => {
  it('merges plugin and user servers without duplication and keys the toggle target', () => {
    const rows = buildMcpServerRows(catalog())
    expect(rows.map(row => row.name)).toEqual(['my-server', 'tracker-mcp'])

    const pluginRow = rows.find(row => row.name === 'tracker-mcp')!
    expect(pluginRow).toMatchObject({
      originKind: 'plugin',
      pluginName: 'Tracker Toolkit',
      pluginKey: 'mk.tracker',
      capabilityId: 'mcp.tracker',
      transport: 'http',
      enabled: true,
      credentialState: 'missing',
    })

    const userRow = rows.find(row => row.name === 'my-server')!
    expect(userRow).toMatchObject({ originKind: 'user', transport: 'stdio', enabled: true })
    expect(userRow.capabilityId).toBeUndefined()
  })

  it('a disabled plugin component reports enabled: false (the toggle target state)', () => {
    const data = catalog()
    ;(data.installedPlugins![0]!.components![0] as { enabled?: boolean }).enabled = false
    const rows = buildMcpServerRows(data)
    expect(rows.find(row => row.name === 'tracker-mcp')?.enabled).toBe(false)
  })
})

describe('McpServersPanel rendering', () => {
  const render = (props: Partial<React.ComponentProps<typeof McpServersPanel>> = {}) =>
    renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <McpServersPanel catalog={catalog()} onToggleServer={() => {}} {...props} />
      </I18nextProvider>,
    )

  it('one panel, both origins, with the toggle ONLY on plugin rows', () => {
    // Origin / transport / auth-state BADGES were removed 2026-08-01: the MCP
    // row carries the aggregate Sources row's content (the category, since
    // UB12.74 as the title meta), and those three now belong to the detail
    // page. What this arm still owns is which ROWS appear and which carry a
    // control.
    const html = render()
    expect(html).toContain('tracker-mcp')
    expect(html).toContain('my-server')
    expect(html).not.toContain('my-api')
    expect(html).toContain('mcp-server-toggle-tracker-mcp')
    expect(html).not.toContain('mcp-server-toggle-my-server')
  })

  it('shows the category as the title meta (UB12.74, the ONE card\'s slots) and no origin or transport badge', () => {
    const html = render()
    expect(html.match(/data-testid="source-card-meta-mcp"/g)?.length).toBe(2)
    expect(html).not.toContain('source-category-badge-')
    expect(html).not.toContain('Tracker Toolkit')
    expect(html).not.toContain('>User<')
    expect(html).not.toContain('>HTTP<')
    expect(html).not.toContain('>stdio<')
  })

  it('the plugin detail view is the SAME rows filtered by pluginKey', () => {
    const html = render({ pluginKey: 'mk.tracker' })
    expect(html).toContain('tracker-mcp')
    expect(html).not.toContain('my-server')
    expect(html).toContain('mcp-server-toggle-tracker-mcp')
  })

  it('renders the empty screen when no MCP servers exist anywhere', () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <McpServersPanel catalog={{ capabilities: [], installedPlugins: [] }} />
      </I18nextProvider>,
    )
    expect(html).toContain('No MCP servers')
  })

  it('UB14.40 — each row draws EntityRow\'s mail-style hairline under ITSELF, and no separator element between rows', () => {
    const html = render()
    const rows = html.match(/data-testid="mcp-server-row-[^"]+"/g) ?? []
    expect(rows.length).toBe(2)
    // Positive: every row carries its own `after:` hairline (EntityRow's, UB13.13) and pads the gutter.
    expect(html.match(/after:bg-separator/g)?.length).toBe(rows.length)
    expect(html.match(/entity-row-btn flex w-full items-start py-\[9px\] px-gutter/g)?.length).toBe(rows.length)
    // Negative: the v0.14 Separator (Radix, `data-slot="separator"`) the second row used to draw above itself is gone,
    // and so is its indented wrapper.
    expect(html).not.toContain('data-slot="separator"')
    expect(html).not.toContain('class="pl-10 pr-4"')
  })
})

/**
 * B2, as REVISED by the owner 2026-08-01: the row STATES, the detail page ACTS.
 *
 * B2 originally put a Connect button in the list row, because the row said
 * "Sign in required" and offered nothing. The owner's correction is that the
 * button belongs on the detail page of the server that actually needs
 * authorising, not on the list item — so the row is back to stating the
 * problem (in `trailing`, bottom-right beside the badge) and the ACTION is
 * reached by clicking through. What did NOT change is the RULE about who can
 * be signed in this way, so every discrimination arm below survives verbatim;
 * only the surface that renders the button moved.
 *
 * The discrimination is the whole point: only an `oauth` server can be signed
 * in by `performOAuth`. `bearer`/`environment` are configured on the plugin
 * page, so a Connect button for them would swap a dead end for a failing
 * button — on the row, and equally on the detail page.
 *
 * `figma`'s component name is deliberately a DISPLAY name that differs from
 * its server name: the credential slot and `authRequirements[].serverNames`
 * are both keyed by the manifest `mcp.serverName`, which reaches the renderer
 * as the capability's `logicalName`, never as the row label.
 */
describe('McpServersPanel plugin sign-in (B2, revised 2026-08-01)', () => {
  const priorWindow = (globalThis as unknown as { window?: unknown }).window
  afterEach(() => {
    ;(globalThis as unknown as { window?: unknown }).window = priorWindow
  })

  function authCatalog(): Pick<UserCapabilityCatalog, 'installedPlugins' | 'capabilities'> {
    const server = (key: string, logicalName: string, credentialState: SafeCapabilitySummary['credentialState']) =>
      summary({ key, kind: 'mcp', logicalName, mcpTransport: 'http', credentialState })
    return {
      capabilities: [
        server('plugin:fg#mcp.figma', 'figma', 'missing'),
        server('plugin:fg#mcp.billing', 'billing', 'missing'),
        server('plugin:fg#mcp.envsrv', 'envsrv', 'missing'),
        server('plugin:fg#mcp.done', 'done-oauth', 'ready'),
        summary({
          key: 'source:workspace:ws_a:my-server', kind: 'source', logicalName: 'my-server',
          sourceType: 'mcp', origin: 'native', readOnly: false, mcpTransport: 'stdio',
          credentialState: 'missing',
        }),
      ],
      installedPlugins: [{
        pluginKey: 'fg.figma',
        name: 'Figma',
        version: '1.0.0',
        installedAt: 1,
        capabilityKinds: ['mcp'],
        activation: { global: 'unset', workspace: 'enabled' },
        authRequirements: [
          { kind: 'oauth', connectorIds: ['mcp.figma', 'mcp.done'], serverNames: ['done-oauth', 'figma'], timing: 'ON_FIRST_USE' },
          { kind: 'bearer', connectorIds: ['mcp.billing'], serverNames: ['billing'], timing: 'ON_FIRST_USE' },
          { kind: 'environment', capabilityIds: ['mcp.envsrv'], serverNames: ['envsrv'], requiredNames: ['API_KEY'] },
        ],
        components: [
          // Display name ≠ server name: the join must not use the row label.
          { kind: 'mcp', name: 'Figma-Design', capabilityKey: 'plugin:fg#mcp.figma', capabilityId: 'mcp.figma', enabled: true },
          { kind: 'mcp', name: 'billing', capabilityKey: 'plugin:fg#mcp.billing', capabilityId: 'mcp.billing', enabled: true },
          { kind: 'mcp', name: 'envsrv', capabilityKey: 'plugin:fg#mcp.envsrv', capabilityId: 'mcp.envsrv', enabled: true },
          { kind: 'mcp', name: 'done-oauth', capabilityKey: 'plugin:fg#mcp.done', capabilityId: 'mcp.done', enabled: true },
        ],
      } as unknown as UserCapabilityCatalog['installedPlugins'][number]],
    }
  }

  const renderAuth = (props: Partial<React.ComponentProps<typeof McpServersPanel>> = {}) =>
    renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <McpServersPanel catalog={authCatalog()} onToggleServer={() => {}} {...props} />
      </I18nextProvider>,
    )

  it('the list STATES the outstanding sign-in and carries NO Connect on any row', () => {
    const html = renderAuth()
    // The statement, on every row whose credential is outstanding — including
    // the bearer/environment ones, which the button could never have helped.
    expect(html).toContain('mcp-server-auth-Figma-Design')
    expect(html).toContain('mcp-server-auth-billing')
    expect(html).toContain('mcp-server-auth-envsrv')
    expect(html).toContain('mcp-server-auth-my-server')
    expect(html).toContain('Sign in required')
    // …and on no row whose credential is fine. Positive control for that
    // absence is the four ids above, rendered from the same markup.
    expect(html).not.toContain('mcp-server-auth-done-oauth')
    // The ACTION is gone from the list entirely — including from the row the
    // old B2 put it on, which is the whole of the owner's correction.
    expect(html).not.toContain('mcp-server-connect-')
    expect(html).not.toContain('>Connect<')
  })

  it('a healthy list says nothing at all — the marker is not "always on"', () => {
    // Positive control for the arm above: the SAME panel over a catalog whose
    // credentials are all fine emits no marker anywhere.
    const healthy = authCatalog()
    for (const capability of healthy.capabilities!) capability.credentialState = 'ready'
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <McpServersPanel catalog={healthy} onToggleServer={() => {}} />
      </I18nextProvider>,
    )
    expect(html).not.toContain('mcp-server-auth-')
    expect(html).not.toContain('Sign in required')
    // …and `not-required` (every built-in) is equally silent, not "Connected".
    for (const capability of healthy.capabilities!) capability.credentialState = 'not-required'
    const notRequired = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <McpServersPanel catalog={healthy} onToggleServer={() => {}} />
      </I18nextProvider>,
    )
    expect(notRequired).not.toContain('mcp-server-auth-')
    expect(notRequired).not.toContain('Connected')
  })

  it('an expired token says so in its own words, not the missing-credential ones', () => {
    const expired = authCatalog()
    expired.capabilities!.find(capability => capability.logicalName === 'figma')!.credentialState = 'expired'
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <McpServersPanel catalog={expired} onToggleServer={() => {}} />
      </I18nextProvider>,
    )
    expect(html).toContain('Sign-in expired')
    // The decision itself, without a renderer, in both directions.
    expect(mcpRowAuthMarkerKey({ credentialState: 'expired' })).toBe('mcpServers.authExpired')
    expect(mcpRowAuthMarkerKey({ credentialState: 'missing' })).toBe('mcpServers.authNeeded')
    expect(mcpRowAuthMarkerKey({ credentialState: 'ready' })).toBeNull()
    expect(mcpRowAuthMarkerKey({ credentialState: 'not-required' })).toBeNull()
  })

  it("the plugin's own page is the SAME rows filtered — the same statement, still no button", () => {
    const html = renderAuth({ pluginKey: 'fg.figma' })
    expect(html).not.toContain('my-server')
    expect(html).toContain('mcp-server-auth-Figma-Design')
    expect(html).not.toContain('mcp-server-connect-')
  })

  /**
   * The detail page's half of the move. It holds a capability KEY and no row,
   * so it re-enters the same join — and must land on exactly the target the
   * row used to compute, refusing exactly the rows the row refused.
   */
  it('the detail page resolves the same target by capability key, and refuses the same rows', () => {
    const catalogValue = authCatalog()
    expect(capabilityConnectTarget('plugin:fg#mcp.figma', catalogValue)).toEqual({
      workspaceId: 'ws_a',
      sourceSlug: 'figma',
      pluginServer: { pluginKey: 'fg.figma', serverName: 'figma' },
    })
    // bearer, environment, already-signed-in, and a user server with no plugin
    // credential slot — the same four the list refuses.
    for (const key of [
      'plugin:fg#mcp.billing',
      'plugin:fg#mcp.envsrv',
      'plugin:fg#mcp.done',
      'source:workspace:ws_a:my-server',
    ]) {
      expect(capabilityConnectTarget(key, catalogValue)).toBeNull()
    }
    // A key no row carries resolves to nothing rather than throwing.
    expect(capabilityConnectTarget('plugin:fg#mcp.nope', catalogValue)).toBeNull()
    expect(capabilityConnectTarget('plugin:fg#mcp.figma', null)).toBeNull()
  })

  it('the target is the manifest server name and the row scope, not the display label', () => {
    const catalogValue = authCatalog()
    const rows = buildMcpServerRows(catalogValue)
    const figmaRow = rows.find(row => row.name === 'Figma-Design')!
    expect(pluginServerConnectTarget(figmaRow, catalogValue)).toEqual({
      workspaceId: 'ws_a',
      sourceSlug: 'figma',
      pluginServer: { pluginKey: 'fg.figma', serverName: 'figma' },
    })
    // Boundary: the same shape refuses every non-oauth row.
    for (const name of ['billing', 'envsrv', 'done-oauth', 'my-server']) {
      expect(pluginServerConnectTarget(rows.find(row => row.name === name)!, catalogValue)).toBeNull()
    }
  })

  it('the auth-kind join answers per server, and answers nothing for an unknown one', () => {
    const requirements = authCatalog().installedPlugins![0]!.authRequirements!
    expect(pluginServerAuthKind(requirements, 'figma')).toBe('oauth')
    expect(pluginServerAuthKind(requirements, 'billing')).toBe('bearer')
    expect(pluginServerAuthKind(requirements, 'envsrv')).toBe('environment')
    // Positive control for the absence: the same call over the same array
    // does answer for the three names above.
    expect(pluginServerAuthKind(requirements, 'not-declared')).toBeUndefined()
    expect(pluginServerAuthKind(undefined, 'figma')).toBeUndefined()
  })

  it('Connect runs the same performOAuth call the session notice makes', async () => {
    const calls: unknown[] = []
    ;(globalThis as unknown as { window?: unknown }).window = {
      electronAPI: {
        performOAuth(args: unknown) {
          calls.push(args)
          return Promise.resolve({ success: true })
        },
      },
    }
    const target = pluginServerConnectTarget(
      buildMcpServerRows(authCatalog()).find(row => row.name === 'Figma-Design')!,
      authCatalog(),
    )!
    await expect(connectPluginServer(target)).resolves.toBe(true)
    expect(calls).toEqual([{
      workspaceId: 'ws_a',
      sourceSlug: 'figma',
      pluginServer: { pluginKey: 'fg.figma', serverName: 'figma' },
    }])
  })

  /**
   * The wiring arm. Everything above proves the control is RENDERED and that
   * the action WORKS; neither can see an `onClick` that was never attached —
   * a button that renders and does nothing is the exact failure this row was
   * filed against. `renderToStaticMarkup` drops handlers and the repo ships no
   * DOM, so the component is called under a minimal hook dispatcher (the seam
   * `PendingAuthNotice.test.tsx` established for B1) and its button's real
   * `onClick` is fired.
   */
  it('pressing the rendered Connect button is what calls performOAuth', async () => {
    const calls: unknown[] = []
    ;(globalThis as unknown as { window?: unknown }).window = {
      electronAPI: {
        performOAuth(args: unknown) {
          calls.push(args)
          return Promise.resolve({ success: true })
        },
      },
    }
    const target = pluginServerConnectTarget(
      buildMcpServerRows(authCatalog()).find(row => row.name === 'Figma-Design')!,
      authCatalog(),
    )!
    const mounted = mountComponent(PluginServerConnectButton, {
      target,
      testId: 'mcp-server-connect-Figma-Design',
    })
    const button = findByTestId(mounted.output(), 'mcp-server-connect-Figma-Design')
    expect(button).not.toBeNull()
    expect(calls).toHaveLength(0)

    ;(button!.props as { onClick: () => void }).onClick()
    await mounted.flush()

    expect(calls).toEqual([{
      workspaceId: 'ws_a',
      sourceSlug: 'figma',
      pluginServer: { pluginKey: 'fg.figma', serverName: 'figma' },
    }])
    mounted.unmount()
  })

  it('a refused sign-in is reported, not swallowed as success', async () => {
    ;(globalThis as unknown as { window?: unknown }).window = {
      electronAPI: {
        performOAuth: () => Promise.resolve({ success: false, error: 'cancelled' }),
      },
    }
    const target: Parameters<typeof connectPluginServer>[0] = {
      workspaceId: 'ws_a', sourceSlug: 'figma', pluginServer: { pluginKey: 'fg.figma', serverName: 'figma' },
    }
    await expect(connectPluginServer(target)).resolves.toBe(false)
  })
})

/**
 * A7 as ROWS of this list (owner decision 2026-08-01).
 *
 * The built-in dp set used to be a card BELOW this panel — a second surface
 * inside an element that already means "list". It is now ordinary rows: same
 * shape, same alphabetical order, the existing `originKind: 'builtin'` badge
 * the row model always had and nobody ever supplied.
 *
 * The load-bearing arm is the WRITE one. A built-in has no capability policy
 * record, so routing its switch through the plugin `set-capability-enabled`
 * mutation would write the wrong thing and silently do nothing; the two paths
 * are asserted separately, in both directions.
 *
 * Nothing here touches `dp`: the payload is a literal, exactly as it arrives
 * over RPC from the process that did the filesystem lookup.
 */
describe('built-in dp servers as rows of the same list (A7)', () => {
  const priorWindow = (globalThis as unknown as { window?: unknown }).window
  afterEach(() => {
    ;(globalThis as unknown as { window?: unknown }).window = priorWindow
  })

  const BUILTIN_SERVERS: BuiltinDpMcpSettingsViewV1['servers'] = [
    { name: 'dpJira', subcommand: 'jira', description: 'Tool for working with Jira issues', defaultEnabled: false, enabled: true },
    { name: 'dpSage', subcommand: 'sage', description: 'Tool for working with logs and metrics', defaultEnabled: false, enabled: false },
  ]
  const BUILTIN: BuiltinDpMcpSettingsViewV1 = { available: true, diagnostics: [], servers: BUILTIN_SERVERS }
  const DP_MISSING: BuiltinDpMcpSettingsViewV1 = {
    available: false,
    diagnostics: [{
      code: 'builtin_dp_mcp.dp_not_found',
      message: DP_NOT_FOUND_MESSAGE,
    }],
    servers: BUILTIN_SERVERS,
  }

  const renderBuiltin = (props: Partial<React.ComponentProps<typeof McpServersPanel>> = {}) =>
    renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <McpServersPanel
          catalog={catalog()}
          builtinDp={BUILTIN}
          onToggleServer={() => {}}
          onToggleBuiltinDp={() => {}}
          {...props}
        />
      </I18nextProvider>,
    )

  it('merges into ONE alphabetically ordered list — no group, no card, no second surface', () => {
    const rows = buildMcpServerRows(catalog(), BUILTIN)
    // The exact order the ordinary sort produces, asserted rather than
    // described: built-ins are interleaved with the servers that exist, which
    // is what "an ordinary element" means here.
    expect(rows.map(row => row.name)).toEqual(['dpJira', 'dpSage', 'my-server', 'tracker-mcp'])
    expect(rows.find(row => row.name === 'dpJira')).toMatchObject({
      originKind: 'builtin',
      builtinDpName: 'dpJira',
      transport: 'stdio',
      enabled: true,
    })
    // A built-in carries no capability record — that is the whole reason its
    // write path differs from a plugin row's.
    expect(rows.find(row => row.name === 'dpJira')?.capabilityId).toBeUndefined()
    expect(rows.find(row => row.name === 'dpSage')?.enabled).toBe(false)
  })

  it('drops a built-in whose wire name a configured server already took', () => {
    const taken = catalog()
    taken.capabilities![1]!.logicalName = 'dpJira'
    const rows = buildMcpServerRows(taken, BUILTIN)
    expect(rows.filter(row => row.name === 'dpJira')).toHaveLength(1)
    // …and the surviving row is the CONFIGURED one, because that is the one
    // the runtime fold starts (`mergeBuiltinDpMcpServers` yields to it).
    expect(rows.find(row => row.name === 'dpJira')?.originKind).toBe('user')
    // Positive control on the same call: the non-colliding built-in survives.
    expect(rows.find(row => row.name === 'dpSage')?.originKind).toBe('builtin')
  })

  it('renders a built-in row with its own switch and no origin badge', () => {
    const html = renderBuiltin()
    expect(html).toContain('dpJira')
    // The `Built-in` origin badge went to the detail page (badge parity,
    // 2026-08-01); the SWITCH is the control, and controls were never in scope.
    expect(html).not.toContain('>Built-in<')
    expect(html).toContain('mcp-server-toggle-dpJira')
    // The switch reflects the effective state, not a hard-coded one.
    expect(html.match(/aria-checked="true"/g) ?? []).toHaveLength(2) // dpJira + tracker-mcp
    expect(html.match(/aria-checked="false"/g) ?? []).toHaveLength(1) // dpSage
  })

  it("never shows a built-in on a plugin's own page (it belongs to no plugin)", () => {
    const html = renderBuiltin({ pluginKey: 'mk.tracker' })
    expect(html).toContain('tracker-mcp')
    expect(html).not.toContain('dpJira')
  })

  it('keeps the switch live when dp is missing, and carries the reason to the detail page', () => {
    // A7 said a row that will start nothing has to SAY so, and it did — via a
    // `Needs dp` badge whose tooltip carried the backend's sentence. Badge
    // parity (2026-08-01) removed that badge from the ROW, but the reason is
    // not lost: `buildMcpServerRows` still carries `unavailableReason`, and
    // `CapabilityDetailTemplate` already renders it on the detail page the row
    // opens. This arm pins the DATA so the surface cannot be silently orphaned.
    const html = renderBuiltin({ builtinDp: DP_MISSING })
    expect(html).not.toContain('Needs dp')
    expect(html).toContain('mcp-server-toggle-dpJira')

    const rows = buildMcpServerRows(catalog(), DP_MISSING)
    const jira = rows.find(row => row.name === 'dpJira')
    expect(jira?.unavailableReason).toContain(DP_NOT_FOUND_MESSAGE)
    // Positive control on the same call: with dp present there is no reason to
    // carry, so this is not simply "the field is always set".
    const healthy = buildMcpServerRows(catalog(), BUILTIN)
    expect(healthy.find(row => row.name === 'dpJira')?.unavailableReason).toBeUndefined()
  })

  it('a built-in switch routes to the built-in write, and NEVER to the plugin mutation', () => {
    const builtinCalls: Array<[string, boolean]> = []
    const pluginCalls: unknown[] = []
    const mounted = mountComponent(McpServersPanel, {
      catalog: catalog(),
      builtinDp: BUILTIN,
      onToggleServer: (row: unknown, next: boolean) => { pluginCalls.push([row, next]) },
      onToggleBuiltinDp: (name: string, next: boolean) => { builtinCalls.push([name, next]) },
    } as React.ComponentProps<typeof McpServersPanel>)

    const rows = renderedRows(mounted.output())
    const builtinSwitch = findByTestId(rows, 'mcp-server-toggle-dpSage')
    expect(builtinSwitch).not.toBeNull()
    ;(builtinSwitch!.props as { onCheckedChange: (next: boolean) => void }).onCheckedChange(true)
    expect(builtinCalls).toEqual([['dpSage', true]])
    expect(pluginCalls).toEqual([])

    // The other direction, on the same mount: a plugin row still flips its
    // capability policy record and never touches the built-in preference.
    const pluginSwitch = findByTestId(rows, 'mcp-server-toggle-tracker-mcp')
    ;(pluginSwitch!.props as { onCheckedChange: (next: boolean) => void }).onCheckedChange(false)
    expect(pluginCalls).toEqual([[{ pluginKey: 'mk.tracker', capabilityId: 'mcp.tracker' }, false]])
    expect(builtinCalls).toEqual([['dpSage', true]])
    mounted.unmount()
  })

  it('the toggle a row hands back PERSISTS through setBuiltinDpMcpServerEnabled', async () => {
    const writes: Array<[string, boolean]> = []
    ;(globalThis as unknown as { window?: unknown }).window = {
      electronAPI: {
        getBuiltinDpMcpServers: () => Promise.resolve(BUILTIN),
        setBuiltinDpMcpServerEnabled: (name: string, enabled: boolean) => {
          writes.push([name, enabled])
          return Promise.resolve()
        },
      },
    }
    let state: ReturnType<typeof useBuiltinDpMcpServers> | null = null
    const Probe = () => {
      state = useBuiltinDpMcpServers()
      return null
    }
    const mounted = mountComponent(Probe, {})
    await mounted.flush()
    // The set arrived over RPC — nothing here resolved or ran `dp`.
    expect(state!.view?.servers.map(server => server.name)).toEqual(['dpJira', 'dpSage'])

    state!.toggle('dpSage', true)
    await mounted.flush()
    expect(writes).toEqual([['dpSage', true]])
    // …and the row shows the new state immediately rather than after a re-read.
    expect(state!.view?.servers.find(server => server.name === 'dpSage')?.enabled).toBe(true)
    mounted.unmount()
  })

  it('a refused write is re-read, not left as an optimistic lie', async () => {
    ;(globalThis as unknown as { window?: unknown }).window = {
      electronAPI: {
        setBuiltinDpMcpServerEnabled: () => Promise.reject(new Error('Unknown built-in dp MCP server: nope')),
      },
    }
    await expect(persistBuiltinDpMcpServerEnabled('nope', true)).resolves.toBe(false)
    // Positive control for that false: the same call succeeds when the write does.
    ;(globalThis as unknown as { window?: unknown }).window = {
      electronAPI: { setBuiltinDpMcpServerEnabled: () => Promise.resolve() },
    }
    await expect(persistBuiltinDpMcpServerEnabled('dpJira', true)).resolves.toBe(true)
  })

  it('the optimistic update touches one server and nothing else', () => {
    const next = applyBuiltinDpMcpToggle(BUILTIN, 'dpSage', true)
    expect(next!.servers).toEqual([
      { ...BUILTIN_SERVERS[0]! },
      { ...BUILTIN_SERVERS[1]!, enabled: true },
    ])
    expect(applyBuiltinDpMcpToggle(null, 'dpSage', true)).toBeNull()
  })
})

/**
 * A7 option A: a built-in is an ordinary CAPABILITY too (owner decision
 * 2026-08-01 — "we need common behaviour for everything, the only difference is
 * that they are built in").
 *
 * The set now arrives twice — from the capability catalog
 * (`storage-runtime.ts`'s `builtinDpMcpCapabilityRecords`) and from the
 * `getBuiltinDpMcpServers` RPC — and `buildMcpServerRows` is the join. Each half
 * owns something the other cannot supply, and every arm here is about one of
 * them being dropped:
 *
 * - the catalog half owns `capabilityKey`, so the row OPENS a detail page;
 * - the RPC half owns the live switch state (nothing publishes a
 *   capability-changed event for the preference write) and the dp-availability
 *   sentence (the projection deliberately does no filesystem lookup);
 * - `builtinDpName` must survive the join on BOTH halves, because it is the
 *   whole route of the switch: without it the toggle silently degrades to text,
 *   which reads as a styling detail and means "this server can no longer be
 *   turned on".
 */
describe('a built-in projected through the capability catalog (A7 option A)', () => {
  const BUILTIN_SERVERS: BuiltinDpMcpSettingsViewV1['servers'] = [
    { name: 'dpJira', subcommand: 'jira', description: 'Tool for working with Jira issues', defaultEnabled: false, enabled: true },
    { name: 'dpSage', subcommand: 'sage', description: 'Tool for working with logs and metrics', defaultEnabled: false, enabled: false },
  ]
  const VIEW: BuiltinDpMcpSettingsViewV1 = { available: true, diagnostics: [], servers: BUILTIN_SERVERS }
  const DP_MISSING: BuiltinDpMcpSettingsViewV1 = {
    available: false,
    diagnostics: [{
      code: 'builtin_dp_mcp.dp_not_found',
      message: DP_NOT_FOUND_MESSAGE,
    }],
    servers: BUILTIN_SERVERS,
  }

  /** Exactly what the projection puts in the catalog, minus the server-only half. */
  const projected = (name: string, description: string): SafeCapabilitySummary => summary({
    key: `builtin:mcp:${name}`,
    kind: 'mcp',
    logicalName: name,
    description,
    origin: 'builtin',
    scope: { kind: 'builtin' },
    mcpTransport: 'stdio',
    // The resolver's verdict for a server the user left off.
    state: 'disabled',
    unavailableReason: 'source-disabled',
    readOnly: true,
    trustState: 'not-required',
    credentialState: 'not-required',
  })

  const withBuiltins = (): Pick<UserCapabilityCatalog, 'installedPlugins' | 'capabilities'> => {
    const base = catalog()
    base.capabilities = [
      ...base.capabilities!,
      projected('dpJira', 'Tool for working with Jira issues'),
      projected('dpSage', 'Tool for working with logs and metrics'),
    ]
    return base
  }

  it('joins the two halves into ONE row — never two, and never a lost switch', () => {
    const rows = buildMcpServerRows(withBuiltins(), VIEW)
    expect(rows.map(row => row.name)).toEqual(['dpJira', 'dpSage', 'my-server', 'tracker-mcp'])
    expect(rows.find(row => row.name === 'dpJira')).toMatchObject({
      originKind: 'builtin',
      // The catalog half: what makes the row clickable.
      capabilityKey: 'builtin:mcp:dpJira',
      transport: 'stdio',
      description: 'Tool for working with Jira issues',
      // The RPC half: the switch's live state and its write target.
      builtinDpName: 'dpJira',
      enabled: true,
    })
    // The RPC half wins on `enabled` for a reason: the catalog says `disabled`
    // here, and it is the half that goes stale after a toggle.
    expect(rows.find(row => row.name === 'dpSage')?.enabled).toBe(false)
    // A built-in still has no capability POLICY record — the write path is
    // unchanged, and this is what keeps the panel from finding one.
    expect(rows.find(row => row.name === 'dpJira')?.capabilityId).toBeUndefined()
  })

  it('keeps the switch alive with only the catalog half (no RPC read yet)', () => {
    const rows = buildMcpServerRows(withBuiltins(), null)
    expect(rows.find(row => row.name === 'dpJira')).toMatchObject({
      originKind: 'builtin',
      builtinDpName: 'dpJira',
      capabilityKey: 'builtin:mcp:dpJira',
      enabled: false,
    })
  })

  it('still lets a CONFIGURED server of the same name win', () => {
    const taken = withBuiltins()
    // A user's own server called `dpJira`: the runtime fold yields to it, so the
    // list must show one row, and it must be the configured one.
    taken.capabilities![1]!.logicalName = 'dpJira'
    const rows = buildMcpServerRows(taken, VIEW)
    const jira = rows.filter(row => row.name === 'dpJira')
    // The built-in projection and the RPC copy both stand down behind the
    // catalog's own configured entry… but the projection is itself a catalog
    // entry, so both survive as distinct KEYS while sharing a name.
    expect(jira.some(row => row.originKind === 'user')).toBe(true)
    // Positive control: the non-colliding built-in is untouched.
    expect(rows.find(row => row.name === 'dpSage')?.originKind).toBe('builtin')
  })

  it('does not attribute "needs dp" to a server the user simply left off', () => {
    // Post badge-parity this is a ROW-DATA assertion: the badge no longer
    // renders in either case, so asserting on markup could not tell the two
    // apart. `unavailableReason` is the field the detail page reads, and it
    // must stay empty for a server that is merely switched off.
    const off = buildMcpServerRows(withBuiltins(), VIEW)
    expect(off.find(row => row.name === 'dpSage')?.unavailableReason).toBeUndefined()
    // Positive control on the same shape: dp really being absent DOES set it,
    // so the assertion above is not just "the field is never set".
    const missing = buildMcpServerRows(withBuiltins(), DP_MISSING)
    expect(missing.find(row => row.name === 'dpSage')?.unavailableReason).toContain(DP_NOT_FOUND_MESSAGE)
  })

  it('opens the detail page from the row, and still routes the switch to the preference', () => {
    const opened: string[] = []
    const builtinCalls: Array<[string, boolean]> = []
    const pluginCalls: unknown[] = []
    const mounted = mountComponent(McpServersPanel, {
      catalog: withBuiltins(),
      builtinDp: VIEW,
      onOpenServer: (capabilityKey: string) => { opened.push(capabilityKey) },
      onToggleServer: (row: unknown, next: boolean) => { pluginCalls.push([row, next]) },
      onToggleBuiltinDp: (name: string, next: boolean) => { builtinCalls.push([name, next]) },
    } as unknown as React.ComponentProps<typeof McpServersPanel>)

    const rows = renderedRows(mounted.output())
    // NAVIGATION — the half the row never had before this change. A built-in
    // row now carries an `onClick`, and it carries the capability key.
    const onClick = rowClick(rows, 'dpJira')
    expect(onClick).not.toBeNull()
    onClick!()
    expect(opened).toEqual(['builtin:mcp:dpJira'])

    // …and the WRITE is still the preference, not the plugin mutation.
    const toggle = findByTestId(rows, 'mcp-server-toggle-dpJira')
    expect(toggle).not.toBeNull()
    ;(toggle!.props as { onCheckedChange: (next: boolean) => void }).onCheckedChange(false)
    expect(builtinCalls).toEqual([['dpJira', false]])
    expect(pluginCalls).toEqual([])

    // Positive control on the same mount: a plugin row is unchanged — it opens
    // its own detail page and flips its capability policy record.
    const pluginToggle = findByTestId(rows, 'mcp-server-toggle-tracker-mcp')
    ;(pluginToggle!.props as { onCheckedChange: (next: boolean) => void }).onCheckedChange(false)
    expect(pluginCalls).toEqual([[{ pluginKey: 'mk.tracker', capabilityId: 'mcp.tracker' }, false]])
    expect(builtinCalls).toEqual([['dpJira', false]])
    mounted.unmount()
  })
})

/**
 * One row's `onClick`, or null when the row is inert.
 *
 * Matched on `McpEntityRow`'s own `dataTestId` PROP rather than on a rendered
 * `data-testid` attribute: `renderedRows` returns unrendered elements, so the
 * row is still `<McpEntityRow …>` and its props are the only thing there is to
 * read. `findByTestId` finds the controls INSIDE the row (they are plain
 * elements), which is why both helpers exist.
 */
function rowClick(rows: React.ReactNode[], name: string): (() => void) | null {
  const row = rows.find(node => (
    React.isValidElement(node)
    && (node.props as { dataTestId?: string }).dataTestId === `mcp-server-row-${name}`
  ))
  if (!row || !React.isValidElement(row)) throw new Error(`no row rendered for ${name}`)
  return (row.props as { onClick?: () => void }).onClick ?? null
}

// ---------------------------------------------------------------------------
// A minimal function-component harness (the seam `PendingAuthNotice.test.tsx`
// introduced for B1, narrowed to the hooks this button and `useTranslation`
// use). The repo ships no DOM and no `renderHook`, and `renderToStaticMarkup`
// discards event handlers — so without this there is no way to assert that the
// Connect button is WIRED rather than merely drawn.
// ---------------------------------------------------------------------------

type HookSlot = { value?: unknown; deps?: unknown[]; cleanup?: (() => void) | void }

const reactDispatcherRef = (
  React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } }
  }
).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher

function mountComponent<P>(Component: (props: P) => React.ReactNode, props: P) {
  const slots: HookSlot[] = []
  const pendingEffects: Array<{ slot: HookSlot; create: () => (() => void) | void }> = []
  let cursor = 0
  let output: React.ReactNode = null
  let renderQueued = false
  let unmounted = false

  const takeSlot = (): HookSlot => {
    const slot = slots[cursor] ?? (slots[cursor] = {})
    cursor += 1
    return slot
  }
  const depsChanged = (slot: HookSlot, deps: unknown[] | undefined): boolean =>
    !slot.deps || !deps || deps.length !== slot.deps.length
      || deps.some((dep, index) => !Object.is(dep, slot.deps?.[index]))

  const dispatcher = {
    useState(initial: unknown) {
      const slot = takeSlot()
      if (!('value' in slot)) {
        slot.value = typeof initial === 'function' ? (initial as () => unknown)() : initial
      }
      const setState = (next: unknown) => {
        const previous = slot.value
        const value = typeof next === 'function' ? (next as (prev: unknown) => unknown)(previous) : next
        if (Object.is(value, previous)) return
        slot.value = value
        if (!unmounted) renderQueued = true
      }
      return [slot.value, setState]
    },
    useEffect(create: () => (() => void) | void, deps?: unknown[]) {
      const slot = takeSlot()
      if (!depsChanged(slot, deps)) return
      slot.deps = deps ? [...deps] : undefined
      pendingEffects.push({ slot, create })
    },
    useLayoutEffect(create: () => (() => void) | void, deps?: unknown[]) {
      dispatcher.useEffect(create, deps)
    },
    useMemo(factory: () => unknown, deps?: unknown[]) {
      const slot = takeSlot()
      if (depsChanged(slot, deps)) {
        slot.deps = deps ? [...deps] : undefined
        slot.value = factory()
      }
      return slot.value
    },
    useCallback(fn: unknown, deps?: unknown[]) {
      return dispatcher.useMemo(() => fn, deps)
    },
    useRef(initial: unknown) {
      const slot = takeSlot()
      if (!('value' in slot)) slot.value = { current: initial }
      return slot.value
    },
    // `useTranslation` reads the i18n context and subscribes to the instance.
    // No provider is mounted here, so the context is empty and react-i18next
    // falls back to the instance `initReactI18next` registered globally.
    useContext(context: { _currentValue?: unknown }) {
      return context?._currentValue
    },
    useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown) {
      return getSnapshot()
    },
    useDebugValue() {},
  }

  const renderPass = () => {
    const previous = reactDispatcherRef.current
    reactDispatcherRef.current = dispatcher
    cursor = 0
    try {
      output = Component(props)
    } finally {
      reactDispatcherRef.current = previous
    }
    while (pendingEffects.length > 0) {
      const effect = pendingEffects.shift()
      if (!effect) break
      if (typeof effect.slot.cleanup === 'function') effect.slot.cleanup()
      effect.slot.cleanup = effect.create()
    }
  }

  const renderLoop = () => {
    for (let pass = 0; pass < 25; pass += 1) {
      renderQueued = false
      renderPass()
      if (!renderQueued) return
    }
    throw new Error('mountComponent: render loop did not settle')
  }

  renderLoop()

  return {
    output: () => output,
    flush: async (): Promise<void> => {
      for (let tick = 0; tick < 8; tick += 1) {
        await new Promise<void>(resolve => { setTimeout(resolve, 0) })
        if (renderQueued && !unmounted) renderLoop()
      }
    },
    unmount: () => {
      unmounted = true
      for (const slot of slots) {
        if (typeof slot.cleanup === 'function') slot.cleanup()
        slot.cleanup = undefined
      }
    },
  }
}

/**
 * Depth-first search of an unrendered element tree for one `data-testid`.
 *
 * Walks EVERY element-valued prop, not just `children`: this panel's row hands
 * its controls to slot props (`overlay`, `badges`, `icon`), so a `children`-only
 * walk finds nothing — which is how it looks when the switch is missing.
 */
function findByTestId(node: React.ReactNode, testId: string): React.ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByTestId(child, testId)
      if (hit) return hit
    }
    return null
  }
  if (!React.isValidElement(node)) return null
  const props = node.props as Record<string, unknown>
  if (props['data-testid'] === testId) return node
  for (const value of Object.values(props)) {
    const hit = findByTestId(value as React.ReactNode, testId)
    if (hit) return hit
  }
  return null
}

/**
 * The rows the panel hands to `EntityList`. `EntityList` receives them as
 * `items` + `renderItem` rather than as children, so a mounted panel's output
 * has to be asked for them the same way the list would.
 */
function renderedRows(output: React.ReactNode): React.ReactNode[] {
  const list = output as React.ReactElement<{
    items: unknown[]
    renderItem: (item: unknown, index: number, isFirst: boolean) => React.ReactNode
  }>
  return list.props.items.map((item, index) => list.props.renderItem(item, index, index === 0))
}

/**
 * P6.711 — the row's Reconnect control.
 *
 * Two things this block is for, and neither is "the button renders".
 *
 * The ADDRESS: the pool is keyed by the WIRE name, and this panel's rows carry
 * a DISPLAY name that a manifest may override. A control that sent the label
 * would restart nothing and the pool would answer `unknown-server`, which reads
 * exactly like a server that is simply not in this session — a wrong answer
 * that looks right.
 *
 * The VERDICT: `reconnectSessionMcpServer` resolves with one of four named
 * refusals rather than rejecting, so a failure must be SHOWN, not swallowed as
 * success. Live pool state (P6.750's serverStatuses) gates nothing here: since
 * F1.1260 the control is offered on every ENABLED row and on none without one.
 */
describe('McpServersPanel reconnect (P6.711)', () => {
  const wireCatalog = (): Pick<UserCapabilityCatalog, 'installedPlugins' | 'capabilities'> => ({
    capabilities: [
      summary({ key: 'plugin:fg#mcp.figma', kind: 'mcp', logicalName: 'figma', mcpTransport: 'http' }),
    ],
    installedPlugins: [{
      pluginKey: 'fg.figma',
      name: 'Figma',
      version: '1.0.0',
      installedAt: 1,
      capabilityKinds: ['mcp'],
      activation: { global: 'unset', workspace: 'enabled' },
      components: [
        // Display name ≠ wire name, deliberately: the address must be `figma`.
        { kind: 'mcp', name: 'Figma-Design', capabilityKey: 'plugin:fg#mcp.figma', capabilityId: 'mcp.figma', enabled: true },
      ],
    } as unknown as UserCapabilityCatalog['installedPlugins'][number]],
  })

  it('addresses the pool by wire name, never by the row label', () => {
    const row = buildMcpServerRows(wireCatalog()).find(entry => entry.name === 'Figma-Design')!
    expect(row.name).toBe('Figma-Design')
    expect(mcpRowWireName(row, wireCatalog())).toBe('figma')
    // A built-in that arrived only through the RPC half has no capability
    // summary to read, and its own wire name is the address.
    expect(mcpRowWireName(
      { id: 'builtin-dp:dpJira', name: 'dpJira', originKind: 'builtin', builtinDpName: 'dpJira', enabled: true },
      wireCatalog(),
    )).toBe('dpJira')
  })

  it('offers the control on enabled rows when a session can act, and none at all without one', () => {
    const withSession = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <McpServersPanel catalog={catalog()} onReconnectServer={() => Promise.resolve({ ok: true })} />
      </I18nextProvider>,
    )
    // Both rows — a plugin server and a user one, both enabled — and no LIVE state gates it.
    expect(withSession).toContain('mcp-server-reconnect-tracker-mcp')
    expect(withSession).toContain('mcp-server-reconnect-my-server')

    const withoutSession = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <McpServersPanel catalog={catalog()} />
      </I18nextProvider>,
    )
    expect(withoutSession).not.toContain('mcp-server-reconnect-')
  })

  // F1.1260 (origin: the final sitting SIT2-a, TRIAGE D-13) — a switched-off server is not in any pool, so its
  // Reconnect could only answer `unknown-server` (the sitting saw it on switched-off built-in dp rows, where it may start a dp sign-in). The control is
  // offered on enabled rows only; live pool state still gates nothing (P6.750).
  it('F1.1260: a switched-off row has no Reconnect, and an enabled row beside it keeps it', () => {
    const value = catalog()
    ;(value.installedPlugins[0]!.components![0] as { enabled: boolean }).enabled = false
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <McpServersPanel catalog={value} onReconnectServer={() => Promise.resolve({ ok: true })} />
      </I18nextProvider>,
    )
    const has = (needle: string) => ({ needle, present: html.includes(needle) })
    expect(has('mcp-server-row-tracker-mcp')).toEqual({ needle: 'mcp-server-row-tracker-mcp', present: true }) // the row stays
    expect(has('mcp-server-reconnect-tracker-mcp')).toEqual({ needle: 'mcp-server-reconnect-tracker-mcp', present: false })
    expect(has('mcp-server-reconnect-my-server')).toEqual({ needle: 'mcp-server-reconnect-my-server', present: true })
  })

  it('pressing Reconnect calls the verb with the wire name, and a success says nothing', async () => {
    const calls: string[] = []
    const mounted = mountComponent(McpServerReconnectButton, {
      wireName: 'figma',
      onReconnect: (wireName: string) => {
        calls.push(wireName)
        return Promise.resolve({ ok: true } as const)
      },
      testId: 'mcp-server-reconnect-Figma-Design',
    })
    const button = findByTestId(mounted.output(), 'mcp-server-reconnect-Figma-Design')
    expect(button).not.toBeNull()
    expect(calls).toHaveLength(0)

    ;(button!.props as { onClick: () => void }).onClick()
    await mounted.flush()

    expect(calls).toEqual(['figma'])
    expect(findByTestId(mounted.output(), 'mcp-server-reconnect-Figma-Design-failed')).toBeNull()
    mounted.unmount()
  })

  it('a named refusal is reported, and the verdict itself survives into the title', async () => {
    const mounted = mountComponent(McpServerReconnectButton, {
      wireName: 'figma',
      onReconnect: () => Promise.resolve({ ok: false, reason: 'failed', detail: 'spawn ENOENT' } as const),
      testId: 'mcp-server-reconnect-Figma-Design',
    })
    ;(findByTestId(mounted.output(), 'mcp-server-reconnect-Figma-Design')!
      .props as { onClick: () => void }).onClick()
    await mounted.flush()

    const failure = findByTestId(mounted.output(), 'mcp-server-reconnect-Figma-Design-failed')
    expect(failure).not.toBeNull()
    // The one translated line the user reads...
    expect((failure!.props as { children: unknown }).children).toBe('Reconnect failed')
    // ...and the verdict the four refusals differ by, kept rather than collapsed.
    expect((failure!.props as { title: string }).title).toBe('failed: spawn ENOENT')
    mounted.unmount()
  })
})

/**
 * P6.750 — the live-state marker.
 *
 * The row is built from stored CONFIG, so before this the three broken states
 * were indistinguishable from a healthy server. These cases pin which three are
 * named, that a healthy one stays silent, and — the half a render test cannot
 * see — that "nobody counted" never renders as a state.
 */
describe('McpServersPanel live MCP status (P6.750)', () => {
  it('names the three broken states and stays silent on the rest', () => {
    const line = (over: Record<string, unknown>) =>
      [{ name: 'figma', state: 'connected', toolCount: 3, ...over }] as any

    expect(mcpRowLiveStatusMarker('figma', line({ state: 'failed', toolCount: null, detail: 'spawn ENOENT' })))
      .toEqual({ key: 'mcpServers.statusFailed', tone: 'warning', detail: 'spawn ENOENT' })
    // The credential vocabulary, not a second spelling of "sign in".
    expect(mcpRowLiveStatusMarker('figma', line({ state: 'needs-auth', toolCount: null })))
      .toEqual({ key: 'mcpServers.authNeeded', tone: 'auth' })
    expect(mcpRowLiveStatusMarker('figma', line({ toolCount: 0 })))
      .toEqual({ key: 'mcpServers.statusNoTools', tone: 'warning' })

    // Healthy, still coming up, and a server this session does not hold.
    expect(mcpRowLiveStatusMarker('figma', line({}))).toBeNull()
    expect(mcpRowLiveStatusMarker('figma', line({ state: 'pending', toolCount: null }))).toBeNull()
    expect(mcpRowLiveStatusMarker('other', line({ state: 'failed', toolCount: null }))).toBeNull()
  })

  it('reads a missing inventory as "nobody counted", never as a state', () => {
    // `null` from the host means no runtime yet and no pool; `[]` means asked
    // and there are none. Neither may put a marker on a row, and a `toolCount`
    // of `null` on a disconnected server must not read as zero tools.
    expect(mcpRowLiveStatusMarker('figma', null)).toBeNull()
    expect(mcpRowLiveStatusMarker('figma', undefined)).toBeNull()
    expect(mcpRowLiveStatusMarker('figma', [])).toBeNull()
    expect(mcpRowLiveStatusMarker(
      'figma',
      [{ name: 'figma', state: 'pending', toolCount: null }] as any,
    )).toBeNull()
  })

  it('renders the marker on the failing row only, addressed by WIRE name', () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <McpServersPanel
          catalog={catalog()}
          serverStatuses={[
            { name: 'tracker-mcp', state: 'failed', toolCount: null, detail: 'spawn ENOENT' },
            { name: 'my-server', state: 'connected', toolCount: 4 },
          ] as any}
        />
      </I18nextProvider>,
    )
    expect(html).toContain('mcp-server-status-tracker-mcp')
    expect(html).toContain('Not connected')
    // The pool's own reason, reachable without opening the detail page.
    expect(html).toContain('spawn ENOENT')
    // The healthy row says nothing at all.
    expect(html).not.toContain('mcp-server-status-my-server')
  })

  /**
   * F1.655 — a CONNECTED server that skipped tools (F1.643/F1.644) carries the
   * pool's "N tools skipped: …" as `detail`, and the row used to say nothing.
   */
  it('names a connected server that skipped tools, and keeps a clean connected line silent', () => {
    const skipped = '1 tool skipped: "broken" (anyOf value must be ["array"])'
    const line = (over: Record<string, unknown>) =>
      [{ name: 'figma', state: 'connected', toolCount: 3, ...over }] as any

    expect(mcpRowLiveStatusMarker('figma', line({ detail: skipped })))
      .toEqual({ key: 'mcpServers.statusToolsSkipped', tone: 'warning', detail: skipped })
    // Every tool skipped: the stronger finding wins, and it now says why.
    expect(mcpRowLiveStatusMarker('figma', line({ toolCount: 0, detail: skipped })))
      .toEqual({ key: 'mcpServers.statusNoTools', tone: 'warning', detail: skipped })
    // CONTROL: a clean connected line, an empty detail, and a detail on a state
    // that is not connected or failed all stay silent.
    expect(mcpRowLiveStatusMarker('figma', line({}))).toBeNull()
    expect(mcpRowLiveStatusMarker('figma', line({ detail: '' }))).toBeNull()
    expect(mcpRowLiveStatusMarker('figma', line({ state: 'pending', toolCount: null, detail: skipped }))).toBeNull()

    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <McpServersPanel
          catalog={catalog()}
          serverStatuses={[
            { name: 'tracker-mcp', state: 'connected', toolCount: 2, detail: skipped },
            { name: 'my-server', state: 'connected', toolCount: 4 },
          ] as any}
        />
      </I18nextProvider>,
    )
    expect(html).toContain('mcp-server-status-tracker-mcp')
    expect(html).toContain('Some tools skipped')
    // Which tool and why, reachable without opening the detail page.
    expect(html).toContain('anyOf value must be')
    expect(html).not.toContain('mcp-server-status-my-server')
  })

  it('renders exactly as before when the panel is given no inventory', () => {
    const before = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <McpServersPanel catalog={catalog()} />
      </I18nextProvider>,
    )
    const withNull = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <McpServersPanel catalog={catalog()} serverStatuses={null} />
      </I18nextProvider>,
    )
    expect(withNull).toBe(before)
    expect(before).not.toContain('mcp-server-status-')
  })
})

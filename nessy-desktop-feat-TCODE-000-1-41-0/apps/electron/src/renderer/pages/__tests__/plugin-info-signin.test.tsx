/**
 * B2 (plugins-and-marketplace plan) — the plugin's OWN page can sign you in.
 *
 * `PluginInfoPage`'s authentication section used to render the auth kind and
 * the server name as static text, so the page a user opens after installing
 * Figma named the problem and offered nothing. This drives the REAL page
 * component and asserts the rendered Connect control, on the oauth server and
 * on no other.
 *
 * What is stubbed and why: the page's chrome (the detail template shell, the
 * actions menu, the enablement mutations, the configuration RPC) is replaced so
 * a static render can run at all — none of it is the behaviour under test. The
 * authentication section, the MCP panel it hosts and the connect-target join
 * are the real modules.
 */

import * as React from 'react'
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import type { UserCapabilityCatalog } from '@nessy-agent/shared/protocol/capabilities'

// NEVER mock `@/components/info` — `mock.module` is process-global in bun, and
// a PARTIAL stub of a barrel makes every export it omits `undefined` in every
// other file for the rest of the run. This one used to return
// `<div>{kindSections}</div>`, which is exactly the `"<div></div>"` that
// `capability-info-pages.test.tsx` rendered instead of the detail template:
// 5 red tests in a file whose own code was correct, and only in full-suite runs.
// The real template renders the same kind sections, so the assertions below
// hold against it without any stub at all.
//
// The barrel does reach react-pdf, which needs these two module stubs and the
// DOMMatrix shim under bun. Those are safe to leak — they REPLACE modules no
// test asserts on, rather than hiding exports other tests need.
// Declared here rather than relied on from whichever file happened to run
// first: this file used to pass in a full run only because another test's
// leaked ThemeContext mock reached it, and failed on its own.
mock.module('@/context/ThemeContext', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: () => {} }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}))
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}
// `PluginRowMenu` is a whole-module replacement, not a partial stub of a
// barrel, so leaking it costs nothing: no other test asserts on it.
mock.module('@/components/app-shell/PluginRowMenu', () => ({ PluginRowMenu: () => null }))
mock.module('@/hooks/usePluginEnablement', () => ({
  usePluginEnablement: () => ({
    pendingCapabilityId: undefined,
    hasProjectContext: false,
    configurationPrompt: null,
    setEnabled: () => Promise.resolve(),
    setCapabilityEnabled: () => Promise.resolve(),
    uninstall: () => Promise.resolve(true),
  }),
}))

let PluginInfoPage: typeof import('../PluginInfoPage')['default']
let AppShellProvider: typeof import('@/context/AppShellContext')['AppShellProvider']

const translations = {
  'mcpServers.authNeeded': 'Sign in required',
  'mcpServers.pluginSectionTitle': 'MCP servers',
  'mcpServers.pluginSectionDescription': 'Servers this plugin contributes.',
  'pendingAuth.connect': 'Connect',
  'pendingAuth.connecting': 'Connecting...',
  'pendingAuth.error': 'Sign-in failed. Try again.',
  'pluginDetail.authenticationTitle': 'Authentication',
  'pluginDetail.authentication.bearer': 'API token',
  'pluginDetail.authentication.oauth': 'OAuth',
}

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: translations } },
    interpolation: { escapeValue: false },
  })
  PluginInfoPage = (await import('../PluginInfoPage')).default
  AppShellProvider = (await import('@/context/AppShellContext')).AppShellProvider
  // P6.859 — the hook had NO third argument, so it ran on bun's 5 000 ms
  // default while paying exactly the import its directory-sibling
  // `plugin-info-diagnostics.test.tsx` has profiled at **54 591 ms** for
  // `import('../PluginInfoPage')` alone (W7-ag, 2026-09-07, in the known-failing
  // register). Eleven times the default: the budget was below the floor, and
  // the default is not a decision anyone took.
  //
  // Measured here 2026-09-08 at HEAD `cf1613619`, and this file is the CHEAP end
  // of the family when its graph is warm — `3 pass / 0 fail` in 1.500 s, 1.373 s
  // and 1.352 s at load 13.3, with the zero-case control at **547 ms, 0 cases
  // executed**, every reading above 100 % cpu (1.30 s user + 0.82 s sys against
  // 1.40 s wall). A warm reading is the page cache and not the file, which is
  // why the sibling's cold 54.6 s import is the floor this is sized against and
  // these numbers are not.
}, MODULE_GRAPH_HOOK_BUDGET_MS)

function catalog(): UserCapabilityCatalog {
  const server = (key: string, logicalName: string, credentialState: 'missing' | 'ready') => ({
    key, kind: 'mcp' as const, logicalName, mcpTransport: 'http' as const,
    origin: 'plugin' as const, scope: { kind: 'workspace' as const, workspaceId: 'ws_a' },
    state: 'active' as const, readOnly: true, trustState: 'trusted' as const,
    credentialState, selectedAsUnqualifiedAlias: false, diagnosticCodes: [],
  })
  return {
    capabilities: [
      server('plugin:fg#mcp.figma', 'figma', 'missing'),
      server('plugin:fg#mcp.billing', 'billing', 'missing'),
    ],
    installedPlugins: [{
      pluginKey: 'fg.figma',
      name: 'Figma',
      version: '1.0.0',
      installedAt: 1,
      capabilityKinds: ['mcp'],
      activation: { global: 'unset', workspace: 'enabled', effective: 'active' },
      authRequirements: [
        { kind: 'oauth', connectorIds: ['mcp.figma'], serverNames: ['figma'], timing: 'ON_FIRST_USE' },
        { kind: 'bearer', connectorIds: ['mcp.billing'], serverNames: ['billing'], timing: 'ON_FIRST_USE' },
      ],
      components: [
        { kind: 'mcp', name: 'figma', capabilityKey: 'plugin:fg#mcp.figma', capabilityId: 'mcp.figma', enabled: true },
        { kind: 'mcp', name: 'billing', capabilityKey: 'plugin:fg#mcp.billing', capabilityId: 'mcp.billing', enabled: true },
      ],
    }],
  } as unknown as UserCapabilityCatalog
}

function render(catalogValue: UserCapabilityCatalog | undefined): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <AppShellProvider
        value={{ capabilityCatalog: catalogValue, refreshPluginState: () => Promise.resolve() } as never}
      >
        <PluginInfoPage pluginKey="fg.figma" workspaceId="ws_a" />
      </AppShellProvider>
    </I18nextProvider>,
  )
}

describe('PluginInfoPage sign-in (B2)', () => {
  /**
   * Owner decision 2026-08-01: ONE Connect per server, on the server's row.
   * The page used to render a second one in the authentication section, ten
   * lines above the row that already had it. The section keeps its text — it
   * says WHICH KIND of credential each server needs, which no row expresses —
   * and loses the button.
   */
  it('the authentication section states the kind and the servers, and offers no sign-in of its own', () => {
    const html = render(catalog())
    // The section still names both requirements…
    expect(html).toContain('Authentication')
    expect(html).toContain('OAuth')
    expect(html).toContain('API token')
    expect(html).toContain('plugin-auth-server-figma')
    expect(html).toContain('plugin-auth-server-billing')
    // …and neither of them carries a control any more.
    expect(html).not.toContain('plugin-auth-connect-figma')
    expect(html).not.toContain('plugin-auth-connect-billing')
  })

  /**
   * REVISED by the owner 2026-08-01, and this arm is where the revision lands.
   *
   * It used to read "the ONE sign-in on this page is the server row" — the row
   * carried the Connect button. The owner's correction is that a list item
   * STATES and a detail page ACTS, so this page (whose MCP section is
   * `McpServersPanel` filtered by `pluginKey`) now carries no sign-in control
   * at all: the row says "Sign in required" and the button lives one click
   * deeper, on the server's own detail page, beside `Status: missing-credential`
   * where the user was already looking for it.
   */
  it('the plugin page STATES the outstanding sign-in and carries no Connect anywhere', () => {
    const html = render(catalog())
    expect(html).toContain('MCP servers')
    // The statement, on the row, in the section this page hosts.
    expect(html).toContain('mcp-server-auth-figma')
    expect(html).toContain('Sign in required')
    // Not one Connect on the whole page — neither the auth section's (removed
    // 2026-08-01) nor the row's (moved to the server's detail page).
    expect(html).not.toContain('mcp-server-connect-')
    expect(html).not.toContain('plugin-auth-connect-')
    expect(html.match(/Connect/g) ?? []).toHaveLength(0)
  })

  it('boundary: a signed-in oauth server says nothing, while the unsigned one still does', () => {
    const data = catalog()
    ;(data.capabilities[0] as { credentialState: string }).credentialState = 'ready'
    const html = render(data)
    // The section still names the server — only its outstanding-sign-in
    // statement goes away.
    expect(html).toContain('plugin-auth-server-figma')
    expect(html).not.toContain('mcp-server-auth-figma')
    expect(html).not.toContain('plugin-auth-connect-figma')
    // Positive control on the same render: `billing` is still `missing`, so
    // "no marker" above is a decision about credential state and not simply
    // "this page never renders one".
    expect(html).toContain('mcp-server-auth-billing')
  })
})

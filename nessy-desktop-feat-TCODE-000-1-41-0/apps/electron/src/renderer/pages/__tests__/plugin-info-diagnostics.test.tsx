/**
 * sev-3 (1.25.0 signed-build audit) — a refused plugin MCP server says so on the
 * plugin's OWN page.
 *
 * Measured defect: installing `chrome-devtools-mcp` (inline `mcpServers`) or
 * `playwright` (bare-map `.mcp.json`) reports "Plugin installed", the Claude
 * format adapter refuses the server by policy
 * (`format-adapters/claude.ts` — `plugin.format.claude_mcp_command_unavailable`,
 * `npx`/`bunx` with no bundle-local materialized dependency), and the plugin's
 * detail page then rendered "State Active · Diagnostics — No issues detected".
 * The refusal reached only the transient marketplace-card affordance.
 *
 * The refusal's ONLY path-free survivor across the safe boundary is the
 * persisted compatibility report (`SafeInstalledPluginSummary.compatibility`:
 * `state` + `deferred[{externalKind, reasonCode}]`) — `plugin.format.*`
 * diagnostics never enter the resolver snapshot (verified with `rg -a` over
 * `packages/shared/src/capabilities/` and `packages/server-core/src`), so this
 * is the truthful record the page must read.
 *
 * Stubbing follows `plugin-info-signin.test.tsx`: never `mock.module` the
 * `@/components/info` barrel (process-global partial stub), only whole modules
 * no assertion here depends on.
 */

import * as React from 'react'
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UserCapabilityCatalog } from '@nessy-agent/shared/protocol/capabilities'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

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

// Real English copy for the two reused strings, so the assertions prove the
// rendered SENTENCE and not just that some key was passed through.
const translations = {
  'capabilityDetail.diagnostics': 'Diagnostics',
  'capabilityDetail.noDiagnostics': 'No issues detected',
  'capabilityDetail.metadata': 'Metadata',
  'pluginDetail.activation.active': 'Active',
  'pluginDetail.componentsEmpty': 'This plugin ships no components.',
  'pluginDetail.metaState': 'State',
  'pluginDetail.metaStateNoComponents': '{{state}} — no usable components (see Diagnostics)',
  'pluginDetail.metaVersion': 'Version',
  'plugins.compatDeferredEntry': '{{kind}}: {{reason}}',
}

let testI18n: I18nInstance

// P6.652 · THE HOOK'S COST IS ONE IMPORT, AND IT IS 11x BUN'S DEFAULT.
//
// This file presented as `0 pass / 1 fail`, `(unnamed)`, "a beforeEach/afterEach
// hook timed out" — bun's message names the wrong hook family; it is the
// `beforeAll` below. W8-a's control with the file at HEAD verbatim failed
// identically (92.8 s vs 34.6 s at load 12.7), so it is not any lane's edit.
//
// Profiled 2026-09-07 by timestamping each step of the hook (instrumented copy,
// sha256-verified back to baseline afterwards), load 9.64:
//
//   i18next init ..............      2 ms
//   import('../PluginInfoPage') 54 591 ms   <- the whole of it
//   import AppShellContext .....      0 ms   (already in the graph by then)
//   hook total ................. 54 593 ms
//
// So this is the module-graph family in
// `docs/superpowers/specs/2026-07-29-known-failing-tests.md`: one import of the
// renderer page graph against a 5 000 ms default. bun's budget is a TIMER, so
// the reported elapsed overshoots wildly — the failing run above reported
// 62 885 ms against a 5 s budget — and whether a run goes red is decided by
// where the transpile lets the loop breathe.
//
// THE RED IS INTERMITTENT, and one green run of the pre-budget file does not
// refute it. Those bytes (saved, overwritten, then byte-restored and sha256-
// verified back to baseline) passed 6 / 0 TWICE on the same day two independent
// observations of the identical bytes were `0 pass / 1 fail` — at load 10.25 and
// again, deliberately, at load 7.85. So a lane that runs this file once, sees
// green and deletes the budget has measured the lottery, not the file.
//
// Readings, 2026-09-07, `uptime` beside each, all 6 pass / 0 fail across 1 file:
//
//   with the budget ......  354.41 s at load 7.59   <- SLOWEST, at the LOWEST load
//   with the budget ......  334.37 s at load 10.67  (2.00 s user, 1.27 s sys, 0 % cpu)
//   with the budget ......  280.80 s at load 12.10
//   with the budget ......  127.25 s at load 14.97  <- FASTEST, at the HIGHEST load
//   pre-budget bytes .....  248.05 s at load 7.85
//   pre-budget bytes .....   91.10 s at load 10.25
//   control, `-t` matching NOTHING, 0 cases run:  53.87 s at load 10.57
//   with the budget, WARM ..  2.19 s at load 10.36  <- run straight after a
//                             `bun run typecheck:electron`, and the ONLY reading
//                             here that burned real cpu: 90 %, against under 2 %
//                             for every cold one
//
// STARVATION IS REFUTED, not merely unproven. The slowest run came at the lowest
// load and the fastest at the highest — a 2.8x spread running BACKWARDS against
// load — and every run burned under 1 % cpu, so the sibling lanes are not taking
// cores away from it. AGENTS' two-causes rule ("passes alone at low load ->
// starvation") would mislabel this file: it passes alone at low load AND is
// slowest there. The cause is bun's budget being a TIMER on the event loop, which
// a blocking transpile does not advance: 54 s of wall clock can cost 0 ms of
// budget until a yield lands past the 5 s mark, and then it fires. Whether it
// fires is where the yields land, not how busy the box is.
//
// AND THE COST IS I/O, NOT TRANSPILE CPU — which is what the warm reading above
// settles. 2.19 s against 354.41 s is a 162x spread on byte-identical work, and
// the fast run is the one pegging a core while every slow run idles below 2 %.
// The `typecheck:electron` immediately before it had walked these same sources
// into the page cache. So a lane "reproducing" one of these numbers by running it
// twice has measured the cache, and any gate that reads a source tree first will
// see a different file entirely.
//
// The control is the instrument P6.653 established, and here it SPLITS the cost
// in two: 53.87 s is this file's OWN top-level graph (react, react-dom/server,
// i18next), paid before any hook timer exists and so budgetable by nothing at
// all; the remainder is the hook's dynamic import of the page graph. The hook
// therefore accounted for most of a 334 s run — 5x the 54.6 s profiled above,
// on byte-identical work.
//
// The budget is sized against the LARGEST observed run total (354.41 s). The row
// was born from 92.8 s and 91.99 s readings — a 3.9x spread on byte-identical
// work, and exactly why a number measured once is not a floor. It is never sized
// against the 54.6 s hook and never against a warm reading: this family has
// measured 23x and 258x spreads on
// byte-identical work, and a knob set near the resting state manufactures its own
// failures. 600 000 ms is the value its `monitor-command-gate.test.ts` sibling
// carries for the same shape; it still caps a genuine hang. Per-file on purpose —
// raising bun's global default would hide the whole class. The six case BODIES
// are left on bun's default deliberately: all six passed inside every run above,
// so the seconds are the graph and not the cases. P6.638 is the row that folds
// the family's per-file constants into one shared module.
// P6.638 — the budget is the SHARED one now; the reasoning above is this
// file's own measurement and stays. The constant's docblock carries the
// sizing rule and the zero-case-control recipe for whoever sizes the next
// one, so a seventh suite does not rediscover them a seventh time.

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: translations } },
    interpolation: { escapeValue: false },
  })
  PluginInfoPage = (await import('../PluginInfoPage')).default
  AppShellProvider = (await import('@/context/AppShellContext')).AppShellProvider
}, MODULE_GRAPH_HOOK_BUDGET_MS)

const REFUSED_MCP = {
  externalKind: 'mcp',
  reasonCode: 'plugin.deferred.claude_mcp_command_unavailable',
}

/**
 * `chrome-devtools-mcp` as measured: six skills imported, the inline
 * `mcpServers.chrome-devtools` entry refused, `state: 'partial'`.
 */
function partialCatalog(): UserCapabilityCatalog {
  return {
    capabilities: [],
    installedPlugins: [{
      pluginKey: 'cd.chrome-devtools-mcp',
      name: 'chrome-devtools-mcp',
      version: '1.4.0',
      installedAt: 1,
      capabilityKinds: ['skill'],
      activation: { global: 'unset', workspace: 'enabled', effective: 'active' },
      compatibility: { state: 'partial', deferred: [REFUSED_MCP] },
      components: [
        { kind: 'skill', name: 'a11y-debugging', capabilityKey: 'plugin:cd#skill.a11y', enabled: true },
      ],
    }],
  } as unknown as UserCapabilityCatalog
}

/** `playwright` as measured: the bare-map `.mcp.json` server was its ONLY
 * declared component, so the bundle imported nothing at all. */
function zeroCapabilityCatalog(): UserCapabilityCatalog {
  return {
    capabilities: [],
    installedPlugins: [{
      pluginKey: 'pw.playwright',
      name: 'playwright',
      version: '0.0.0',
      installedAt: 1,
      capabilityKinds: [],
      activation: { global: 'unset', workspace: 'enabled', effective: 'active' },
      compatibility: { state: 'partial', deferred: [REFUSED_MCP] },
    }],
  } as unknown as UserCapabilityCatalog
}

/** Positive control: a plugin that imported cleanly (context7-shaped). */
function cleanCatalog(): UserCapabilityCatalog {
  return {
    capabilities: [],
    installedPlugins: [{
      pluginKey: 'c7.context7',
      name: 'context7',
      version: '1.0.0',
      installedAt: 1,
      capabilityKinds: ['mcp'],
      activation: { global: 'unset', workspace: 'enabled', effective: 'active' },
      compatibility: { state: 'supported', deferred: [] },
      components: [
        { kind: 'skill', name: 'query-docs', capabilityKey: 'plugin:c7#skill.query', enabled: true },
      ],
    }],
  } as unknown as UserCapabilityCatalog
}

function render(catalogValue: UserCapabilityCatalog, pluginKey: string): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <AppShellProvider
        value={{ capabilityCatalog: catalogValue, refreshPluginState: () => Promise.resolve() } as never}
      >
        <PluginInfoPage pluginKey={pluginKey} workspaceId="ws_a" />
      </AppShellProvider>
    </I18nextProvider>,
  )
}

describe('PluginInfoPage diagnostics (sev-3)', () => {
  it('states the refused MCP server in the Diagnostics block instead of "No issues detected"', () => {
    const html = render(partialCatalog(), 'cd.chrome-devtools-mcp')
    expect(html).toContain('Diagnostics')
    expect(html).toContain('mcp: plugin.deferred.claude_mcp_command_unavailable')
    expect(html).not.toContain('No issues detected')
    expect(html).not.toContain('diagnostics-empty')
  })

  it('a plugin that imported ZERO capabilities does not present as a plain Active', () => {
    const html = render(zeroCapabilityCatalog(), 'pw.playwright')
    expect(html).toContain('This plugin ships no components.')
    expect(html).toContain('Active — no usable components (see Diagnostics)')
    expect(html).toContain('mcp: plugin.deferred.claude_mcp_command_unavailable')
    expect(html).not.toContain('No issues detected')
  })

  /**
   * The absence control. Without it "the page says nothing when clean" and "the
   * page never says anything" are indistinguishable, and the first assertion
   * above would pass against a page that unconditionally prints the line.
   */
  it('a cleanly-imported plugin keeps the empty placeholder and the plain state', () => {
    const html = render(cleanCatalog(), 'c7.context7')
    expect(html).toContain('No issues detected')
    expect(html).toContain('diagnostics-empty')
    expect(html).not.toContain('no usable components')
    expect(html).not.toContain('plugin.deferred.')
  })

  /**
   * Q10-4 — `playwright` declares no `version`, and the page printed `0.0.0`.
   *
   * Claude's `plugin.json` makes `version` optional, so a real marketplace
   * bundle simply has none; our schema requires one, so the Claude adapter fills
   * `UNDECLARED_PLUGIN_VERSION` to keep the plugin installable. That placeholder
   * is an internal necessity, not a fact about the plugin, and printing it tells
   * the user the author shipped a version they did not.
   *
   * The honest display is to OMIT the row, which is what this surface already
   * does everywhere else for metadata it does not have: `buildMetadata` pushes
   * the Capabilities row only when there are capability kinds, the Claude adapter
   * omits `description`/`publisher`/`homepageUrl` rather than inventing them, and
   * the marketplace detail panel on `PluginsPage` guards its own version row with
   * `if (detailItem.version)`. No new idiom and no new string.
   */
  it('a plugin whose manifest declares no version omits the row instead of printing 0.0.0', () => {
    const html = render(zeroCapabilityCatalog(), 'pw.playwright')
    expect(html).not.toContain('0.0.0')
    expect(html).not.toContain('Version')
    // The page is still the page: everything else about it renders.
    expect(html).toContain('State')
  })

  /** The absence control: a declared version is still shown, verbatim. */
  it('a plugin that declares a version still shows it', () => {
    const html = render(cleanCatalog(), 'c7.context7')
    expect(html).toContain('Version')
    expect(html).toContain('1.0.0')
  })

  /** A blocked report is an error, not a warning — the tone class proves the
   * severity actually reaches the list item. */
  it('a blocked compatibility report renders at error severity', () => {
    const catalog = zeroCapabilityCatalog()
    ;(catalog.installedPlugins[0] as { compatibility: { state: string } }).compatibility.state = 'blocked'
    const html = render(catalog, 'pw.playwright')
    expect(html).toContain('text-destructive')
    expect(html).toContain('mcp: plugin.deferred.claude_mcp_command_unavailable')
  })
})

/**
 * T9 — a gateway connection reconnects from its own row menu.
 *
 * The defect this closes: managed gateway cards are `api_key_with_endpoint` with
 * `canEditLlmConnection === false`, so they matched NEITHER arm of the row
 * menu's auth ternary (`oauth` → Re-authenticate, otherwise → Edit) and their
 * menu offered Rename / Set as default / Validate / Mid-stream / Delete and
 * nothing else. A card reading «Not authenticated» had no way back except the
 * credential-health banner's redirect into the API-setup form, where the user
 * re-created the connection by hand.
 *
 * `bun test` has no DOM in this repo (no happy-dom/jsdom/testing-library), so the
 * RULE is tested as a pure function — the `computeGatewayBannerView` pattern the
 * sibling banner already uses — and the WIRING is pinned by source match, the
 * instrument `submit-control.test.ts` and `composer-permission-modes.test.ts`
 * use for the same reason.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it, mock } from 'bun:test'
// Direct module, not the `@/components/apisetup` barrel: the barrel reaches
// `ApiKeyInput` and the UI chain below, while this module's only import is a
// type. Same literal either way.
import { NESSY_GATEWAY_BASE_URL } from '@/components/apisetup/nessy-gateway'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

// `AiSettingsPage` imports the `@nessy-agent/ui` BARREL, which reaches the
// markdown/PDF viewer chain and ends at `pdfjs-dist/build/pdf.worker.min.mjs?url`
// — a `?url` import bun's test runner cannot load, and the throw kills the module
// graph for the whole process (see the note at the top of
// `components/ui/styled-dropdown.tsx`). These two stubs are the repo's
// established fix, verbatim from `plugin-info-diagnostics.test.tsx` and three
// playground registry suites. They replace a THIRD-PARTY module in full, not one
// of ours in part, so the `mock.module` amputation trap in AGENTS.md does not
// apply: nothing here asserts on pdfjs, and no other suite reads it either.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

// react-pdf (via the same `@nessy-agent/ui` overlay) bundles its OWN nested copy
// of pdfjs at `react-pdf/node_modules/pdfjs-dist`, which the stub above does not
// resolve to, and that copy touches `DOMMatrix` at module scope. Shim verbatim
// from `playground/__tests__/capability-detail-registry.test.ts`.
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

// Loaded AFTER the stubs. A static `import` is hoisted above them and reinstates
// the very failure they exist to prevent — the pattern `plugin-info-*.test.tsx`
// uses for the same reason.
let computeGatewayReconnectItem: typeof import('../AiSettingsPage').computeGatewayReconnectItem

beforeAll(async () => {
  computeGatewayReconnectItem = (await import('../AiSettingsPage')).computeGatewayReconnectItem
}, MODULE_GRAPH_HOOK_BUDGET_MS)

/** A managed gateway card, as the one-click Pi/Codex/Claude setup creates it. */
const gatewayCard = (providerType: string) => ({
  providerType,
  authType: 'api_key_with_endpoint',
  baseUrl: NESSY_GATEWAY_BASE_URL,
})

describe('computeGatewayReconnectItem — who gets the item', () => {
  it('offers Reconnect on every gateway-backed managed card', () => {
    for (const providerType of ['pi_compat', 'codex-runtime', 'claude-runtime']) {
      expect({ providerType, item: computeGatewayReconnectItem(gatewayCard(providerType), null) }).toEqual({
        providerType,
        item: { labelKey: 'settings.ai.reconnect', busy: false },
      })
    }
  })

  it('normalizes the trailing slash, exactly as the backend rule does', () => {
    expect(
      computeGatewayReconnectItem({ authType: 'api_key_with_endpoint', baseUrl: `${NESSY_GATEWAY_BASE_URL}/` }, null),
    ).toEqual({ labelKey: 'settings.ai.reconnect', busy: false })
  })

  it('does NOT offer it to a BYO api-key connection', () => {
    // A BYO endpoint on a runtime provider type. `byo-runtime.ts` refuses the
    // gateway URL itself at validation (`endpointIsGateway`), so the URL rule
    // alone separates managed from BYO.
    for (const connection of [
      { providerType: 'claude-runtime', authType: 'api_key_with_endpoint', baseUrl: 'https://byo.example.test/v1' },
      { providerType: 'pi_compat', authType: 'api_key_with_endpoint', baseUrl: 'http://localhost:11434/v1' },
      // A plain Anthropic API-key connection carries no baseUrl at all.
      { providerType: 'anthropic', authType: 'api_key' },
      // Same host, different path — the whole-URL match must reject it, or the
      // item would appear on a connection the dp credential never serves.
      {
        providerType: 'pi_compat',
        authType: 'api_key_with_endpoint',
        baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/other/v1',
      },
    ]) {
      expect({ baseUrl: connection.baseUrl, item: computeGatewayReconnectItem(connection, null) })
        .toEqual({ baseUrl: connection.baseUrl, item: null })
    }
  })

  it('never replaces the oauth row\'s own Re-authenticate item', () => {
    // Gateway cards are never `oauth`, so this cannot fire in the product — it is
    // pinned so the property belongs to this function and not to the JSX ternary.
    // A Claude Pro/Max subscription card, which carries the item today.
    const subscription = { providerType: 'anthropic', authType: 'oauth' }
    expect(computeGatewayReconnectItem(subscription, null)).toBeNull()
    // Contrived — oauth ON the gateway URL — so the exclusion is asserted
    // independently of the fact that no such connection is creatable.
    const oauthOnGatewayUrl = { providerType: 'pi_compat', authType: 'oauth', baseUrl: NESSY_GATEWAY_BASE_URL }
    expect(computeGatewayReconnectItem(oauthOnGatewayUrl, null)).toBeNull()
  })
})

describe('computeGatewayReconnectItem — the flow\'s phases reach the item', () => {
  it('disables the item and names the phase while the flow runs', () => {
    const card = gatewayCard('pi_compat')
    expect(computeGatewayReconnectItem(card, 'checking'))
      .toEqual({ labelKey: 'onboarding.gatewayConnect.connecting', busy: true })
    expect(computeGatewayReconnectItem(card, 'exchanging'))
      .toEqual({ labelKey: 'onboarding.gatewayConnect.connecting', busy: true })
    expect(computeGatewayReconnectItem(card, 'waiting-browser'))
      .toEqual({ labelKey: 'onboarding.gatewayConnect.waitingBrowser', busy: true })
  })

  it('returns to a clickable Reconnect on every terminal or idle phase', () => {
    const card = gatewayCard('claude-runtime')
    for (const phase of ['idle', 'done', 'error', 'login-required'] as const) {
      expect({ phase, item: computeGatewayReconnectItem(card, phase) })
        .toEqual({ phase, item: { labelKey: 'settings.ai.reconnect', busy: false } })
    }
  })

  it('leaves every other row alone while one row reconnects (null phase)', () => {
    expect(computeGatewayReconnectItem(gatewayCard('codex-runtime'), null))
      .toEqual({ labelKey: 'settings.ai.reconnect', busy: false })
  })
})

describe('every label the item can carry exists in both locales', () => {
  it('has the new key and reuses the banner\'s in-progress keys', () => {
    const keys = [
      'settings.ai.reconnect',
      'onboarding.gatewayConnect.connecting',
      'onboarding.gatewayConnect.waitingBrowser',
    ]
    for (const key of keys) {
      expect({ key, en: typeof (en as Record<string, unknown>)[key] }).toEqual({ key, en: 'string' })
      expect({ key, ru: typeof (ru as Record<string, unknown>)[key] }).toEqual({ key, ru: 'string' })
    }
  })
})

describe('AiSettingsPage wires the item through this function', () => {
  const source = readFileSync(fileURLToPath(new URL('../AiSettingsPage.tsx', import.meta.url)), 'utf8')
  // `expect(source).toContain(needle)` prints the whole 1 500-line page on
  // failure. Report the needle instead.
  const present = (needle: string) => ({ needle, inSource: source.includes(needle) })
  const found = (needle: string) => ({ needle, inSource: true })
  const absent = (needle: string) => ({ needle, inSource: false })

  it('renders the menu item only when the function returns one, and disables it when busy', () => {
    for (const needle of [
      'const reconnectItem = computeGatewayReconnectItem(connection, reconnectPhase)',
      '{reconnectItem && (',
      'onClick={() => runAfterMenuClose(onReconnect)}',
      'disabled={reconnectItem.busy}',
      '<span>{t(reconnectItem.labelKey)}</span>',
    ]) {
      expect(present(needle)).toEqual(found(needle))
    }
  })

  it('runs the one-click ensure path, NOT the API-setup redirect', () => {
    for (const needle of [
      // The click reaches the page handler with this row's slug.
      'onReconnect={() => { void handleReconnectGateway(conn.slug) }}',
      // …which runs the same flow the chat banner runs.
      'const result = await ensureGatewayAuth()',
      // F1.361 — …and a failure is TOLD, not swallowed: the row's spinner used
      // to stop with nothing said.
      'if (!result?.ok) { toastGatewayReconnectFailure(result, t); return }',
      // …and a success refreshes the list so «Not authenticated» clears in place.
      'await refreshLlmConnections?.()',
    ]) {
      expect(present(needle)).toEqual(found(needle))
    }
    // The whole point of the task: no re-creation. `openApiSetup` must not appear
    // anywhere inside the reconnect handler.
    const start = source.indexOf('const handleReconnectGateway =')
    const end = source.indexOf('// Handler for re-authenticate button in credential health banner')
    expect({ found: start > -1 && end > start }).toEqual({ found: true })
    const handler = source.slice(start, end)
    expect({ needle: 'openApiSetup', inSource: handler.includes('openApiSetup') })
      .toEqual(absent('openApiSetup'))
    // F1.361 — the silent early return is gone from the handler.
    expect({ needle: 'if (!result?.ok) return\n', inSource: handler.includes('if (!result?.ok) return\n') })
      .toEqual(absent('if (!result?.ok) return\n'))
  })

  it('owns ONE auth hook for the page and names the row that started the run', () => {
    // A hook per ConnectionRow would light every gateway row up at once: the hook
    // subscribes to the global `nessy:gatewayAuthStatus` stream, so each instance
    // sees every status event — including the chat banner's own flow.
    expect(source.split('useNessyGatewayAuth()').length - 1).toBe(1)
    // …and it is the PAGE's, not the row's. The count alone would still pass if
    // the single hook had simply been moved down into `ConnectionRow`, which is
    // the regression that matters.
    // UB15.11 — the needle is the declaration's PREFIX: D1.254 gave the page its route props, so the old
    // `AiSettingsPage()` spelling found nothing, `indexOf` answered -1 and this comparison could not fail.
    const pageAt = source.indexOf('export default function AiSettingsPage(')
    expect({ pageFound: pageAt > -1 }).toEqual({ pageFound: true })
    expect({
      hookIsBelowThePageComponent: source.indexOf('useNessyGatewayAuth()') > pageAt,
    }).toEqual({ hookIsBelowThePageComponent: true })
    expect({
      rowTakesThePhaseAsAProp: source.includes('reconnectPhase: GatewayAuthPhase | null'),
    }).toEqual({ rowTakesThePhaseAsAProp: true })
    for (const needle of [
      'const [reconnectingSlug, setReconnectingSlug] = useState<string | null>(null)',
      'reconnectPhase={reconnectingSlug === conn.slug ? gatewayAuthPhase : null}',
      'setReconnectingSlug(slug)',
      'setReconnectingSlug(null)',
    ]) {
      expect(present(needle)).toEqual(found(needle))
    }
  })

  it('routes the credential-health banner down the same path for a gateway connection', () => {
    for (const needle of [
      'if (defaultConn && computeGatewayReconnectItem(defaultConn, null)) {',
      'void handleReconnectGateway(defaultConn.slug)',
    ]) {
      expect(present(needle)).toEqual(found(needle))
    }
    // …and the form redirect survives for connections that genuinely need it.
    expect(present('openApiSetup(defaultConn.slug)')).toEqual(found('openApiSetup(defaultConn.slug)'))
  })

  it('leaves the oauth Re-authenticate branch token-identical', () => {
    // UB15.11 — compared with whitespace collapsed: the needle used to be indentation-exact, so a restyle that
    // re-nested the menu would redden it with the branch unchanged. Every TOKEN of the branch is still pinned.
    const squash = (text: string) => text.replace(/\s+/g, ' ')
    const flat = squash(source)
    const branch = squash([
      "{connection.authType === 'oauth' ? (",
      '<StyledDropdownMenuItem onClick={() => runAfterMenuClose(onReauthenticate)}>',
      '<RefreshCcw className="h-3.5 w-3.5" />',
      '<span>{t("settings.ai.reAuthenticate")}</span>',
      '</StyledDropdownMenuItem>',
      ') : !canEditLlmConnection(connection) ? (',
    ].join('\n'))
    expect({ oauthBranchUnchanged: flat.includes(branch) }).toEqual({ oauthBranchUnchanged: true })
    // The new item is a SIBLING of that ternary, not a third arm of it.
    expect(flat.indexOf('{reconnectItem && (')).toBeGreaterThan(flat.indexOf(branch))
    // CONTROL on the same instrument: a branch whose oauth arm opens the edit form instead is not found.
    const swapped = branch.replace('runAfterMenuClose(onReauthenticate)', 'runAfterMenuClose(onEdit)')
    expect({ swappedFound: flat.includes(swapped) }).toEqual({ swappedFound: false })
  })
})

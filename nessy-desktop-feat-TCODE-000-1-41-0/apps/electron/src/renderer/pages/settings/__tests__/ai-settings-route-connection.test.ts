/**
 * D1.254 — the page's half: a route that names a connection re-authenticates it
 * once, and then the page drops the segment.
 *
 * The DECISION is a function (`ai-settings-route-connection.ts`) and is driven
 * here for real; the WIRING — that the effect calls it, dispatches the page's
 * own two handlers and clears the route — is pinned by source, the instrument
 * its siblings in this directory use for the same reason: importing
 * `AiSettingsPage` drags in the `@nessy-agent/ui` barrel and its pdfjs `?url`
 * chain, which `bun test` cannot resolve.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { resolveRouteConnectionAction } from '../ai-settings-route-connection'

const GATEWAY_CONNECTION = {
  slug: 'nessy-gateway',
  baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
}
const KEY_CONNECTION = { slug: 'my-openai', baseUrl: 'https://api.openai.com/v1' }
const OAUTH_ON_GATEWAY = { ...GATEWAY_CONNECTION, slug: 'oauth-row', authType: 'oauth' }
const CONNECTIONS = [GATEWAY_CONNECTION, KEY_CONNECTION, OAUTH_ON_GATEWAY]

describe('resolveRouteConnectionAction', () => {
  it('sends a gateway-backed connection down the one-click path and everything else to the setup', () => {
    expect(resolveRouteConnectionAction('nessy-gateway', null, CONNECTIONS)).toEqual({
      kind: 'gateway',
      connection: GATEWAY_CONNECTION,
    })
    expect(resolveRouteConnectionAction('my-openai', null, CONNECTIONS)).toEqual({
      kind: 'setup',
      connection: KEY_CONNECTION,
    })
    // An OAuth row keeps its own path even on the gateway URL — the second term
    // of `computeGatewayReconnectItem`, in its order.
    expect(resolveRouteConnectionAction('oauth-row', null, CONNECTIONS)).toEqual({
      kind: 'setup',
      connection: OAUTH_ON_GATEWAY,
    })
  })

  it('acts ONCE per naming, and forgets when the segment goes away', () => {
    // The whole reason the page drops the segment: without the `forget` arm the
    // same connection could never be named twice, and without the `idle` arm the
    // overlay would reopen on every unrelated re-render.
    expect(resolveRouteConnectionAction('my-openai', 'my-openai', CONNECTIONS)).toEqual({ kind: 'idle' })
    expect(resolveRouteConnectionAction(undefined, 'my-openai', CONNECTIONS)).toEqual({ kind: 'forget' })
    expect(resolveRouteConnectionAction('my-openai', null, CONNECTIONS).kind).toBe('setup')
  })

  it('does nothing for a slug the list does not carry — including before it loads', () => {
    expect(resolveRouteConnectionAction('my-openai', null, [])).toEqual({ kind: 'idle' })
    expect(resolveRouteConnectionAction('deleted-one', null, CONNECTIONS)).toEqual({ kind: 'idle' })
  })
})

const page = readFileSync(fileURLToPath(new URL('../AiSettingsPage.tsx', import.meta.url)), 'utf8')

describe('the page consumes the route segment, and then drops it', () => {
  it('takes the slug as a prop rather than reading the global navigation state', () => {
    // A panel may render `navStateOverride`, so a page reading
    // `useNavigationState()` would open the connection some OTHER panel names.
    expect(page).toContain('export default function AiSettingsPage({ connectionSlug }: SettingsRouteProps)')
    expect(page).not.toContain('useNavigationState')
    // UB15.10 — the route type is `SettingsRouteProps`: the page also renders the layout `SettingsPage`, whose own
    // props type is `SettingsPageProps`, so the old name would shadow one or the other in this file.
    expect(page).toContain("import type { SettingsRouteProps } from './settings-pages'")
    expect(page).not.toContain('SettingsPageProps')

    const panel = readFileSync(
      fileURLToPath(new URL('../../../components/app-shell/MainContentPanel.tsx', import.meta.url)),
      'utf8',
    )
    expect(panel).toContain('<SettingsPageComponent connectionSlug={navState.connectionSlug} />')
  })

  it('dispatches the page\'s own handlers and then clears the route', () => {
    const at = page.indexOf('resolveRouteConnectionAction(')
    expect(at).toBeGreaterThan(-1)
    const effect = page.slice(at, page.indexOf('}, [connectionSlug', at))
    expect(effect).toContain('handleReconnectGateway(action.connection.slug)')
    expect(effect).toContain('handleReauthenticateConnection(action.connection)')
    // Without this line the second press of the same button is a navigation to
    // the route the panel is already on, and nothing happens.
    expect(effect).toContain("navigate(routes.view.settings('ai'))")
  })
})

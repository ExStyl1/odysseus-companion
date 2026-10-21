/**
 * D1.254 — a settings route can name a connection.
 *
 * The row's premise, verified at HEAD before this landed: `routes.view.settings`
 * took a subpage and nothing else, and the API-setup overlay is local state
 * inside `AiSettingsPage` — so no surface outside that page could open ONE
 * connection's setup, which is what D1.194's expired-credential card and the
 * page's own `handleReauthenticateConnection` both want.
 *
 * The segment has to survive the ROUND TRIP to be worth anything: `navigate()`
 * parses the route to a `NavigationState`, resolves auto-selection, and then
 * REBUILDS the string it stores in the panel. A parser that read the slug and a
 * builder that dropped it would look right in isolation and lose it in the app,
 * so every case below goes both ways.
 */

import { describe, expect, it } from 'bun:test'
import {
  buildCompoundRoute,
  buildRouteFromNavigationState,
  parseCompoundRoute,
  parseRouteToNavigationState,
} from '../route-parser'
import { routes } from '../routes'

describe('route-parser: a settings route that names a connection', () => {
  it('builds, parses and rebuilds the same string', () => {
    const route = routes.view.settings('ai', 'nessy-gateway')
    expect(route).toBe('settings/ai/connection/nessy-gateway')

    const parsed = parseCompoundRoute(route)
    expect(parsed).toEqual({
      navigator: 'settings',
      details: { type: 'ai', id: 'ai' },
      connectionSlug: 'nessy-gateway',
    })
    expect(buildCompoundRoute(parsed!)).toBe(route)

    const state = parseRouteToNavigationState(route)
    expect(state).toEqual({ navigator: 'settings', subpage: 'ai', connectionSlug: 'nessy-gateway' })
    expect(buildRouteFromNavigationState(state!)).toBe(route)
  })

  it('carries a slug that needs escaping through both directions', () => {
    // A slug is opaque. `label` and the plugin key are encoded for the same
    // reason, and a slash inside one would otherwise read as another segment.
    const route = routes.view.settings('ai', 'my/own key')
    expect(route).toBe('settings/ai/connection/my%2Fown%20key')
    expect(parseCompoundRoute(route)?.connectionSlug).toBe('my/own key')
    expect(parseRouteToNavigationState(route)).toEqual({
      navigator: 'settings',
      subpage: 'ai',
      connectionSlug: 'my/own key',
    })
  })

  it('is absent from the route and from the state when no connection is named', () => {
    // The boundary the cases above are only meaningful against: the plain route
    // must be byte-identical to what it was before this segment existed, and the
    // state must not grow an `undefined` field that a caller could read as one.
    expect(routes.view.settings('ai')).toBe('settings/ai')
    expect(routes.view.settings()).toBe('settings')
    expect(parseCompoundRoute('settings/ai')).toEqual({
      navigator: 'settings',
      details: { type: 'ai', id: 'ai' },
    })
    expect(parseRouteToNavigationState('settings/ai')).toEqual({ navigator: 'settings', subpage: 'ai' })
  })

  it('REFUSES a trailing shape it does not understand instead of truncating it', () => {
    // A parser that ignored the tail would answer `settings/ai` for every one of
    // these, and a link that silently means something else is worse than a link
    // that does not work.
    expect(parseCompoundRoute('settings/ai/connection')).toBeNull()
    expect(parseCompoundRoute('settings/ai/connection/a/b')).toBeNull()
    expect(parseCompoundRoute('settings/ai/whatever/a')).toBeNull()
    expect(parseCompoundRoute('settings/not-a-subpage/connection/a')).toBeNull()
  })

  it('does not throw on a malformed escape — the segment survives verbatim', () => {
    // `decodeURIComponent('%')` throws, and a throw inside the parser would take
    // the whole route down rather than one segment.
    expect(parseCompoundRoute('settings/ai/connection/%')?.connectionSlug).toBe('%')
  })
})

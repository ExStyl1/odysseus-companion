/**
 * U4 — sources/plugins subsection routes.
 *
 * The Plugins subsection is a sources-navigator sub-route (like the api/mcp/
 * local type filters). Proves both the list route (`sources/plugins`) and the
 * plugin-detail route (`sources/plugins/plugin/<key>`) round-trip cleanly
 * through the compound parser, the navigation-state helpers, and the
 * `routes.view.sourcesPlugins` builder — including pluginKey URL-encoding.
 */

import { describe, expect, it } from 'bun:test'
import {
  buildCompoundRoute,
  buildRouteFromNavigationState,
  parseCompoundRoute,
  parseRoute,
  parseRouteToNavigationState,
} from '../route-parser'
import { getNavigationStateKey, parseNavigationStateKey } from '../types'
import { routes } from '../routes'

describe('route-parser: sources/plugins subsection', () => {
  it('parses the list route as a sources navigator + plugins filter', () => {
    expect(parseCompoundRoute('sources/plugins')).toEqual({
      navigator: 'sources',
      sourceFilter: { kind: 'plugins' },
      details: null,
    })
    expect(parseRouteToNavigationState('sources/plugins')).toEqual({
      navigator: 'sources',
      filter: { kind: 'plugins' },
      details: null,
    })
  })

  it('parses the plugin-detail route (decoding the pluginKey)', () => {
    const key = 'm/p@1.0.0'
    const route = routes.view.sourcesPlugins(key)
    expect(route).toBe(`sources/plugins/plugin/${encodeURIComponent(key)}`)
    expect(parseCompoundRoute(route)).toEqual({
      navigator: 'sources',
      sourceFilter: { kind: 'plugins' },
      details: { type: 'plugin', id: key },
    })
    expect(parseRouteToNavigationState(route)).toEqual({
      navigator: 'sources',
      filter: { kind: 'plugins' },
      details: { type: 'plugin', pluginKey: key },
    })
    expect(parseRoute(route)).toEqual({ type: 'view', name: 'plugin-info', id: key, params: {} })
  })

  it('round-trips list + detail through the compound builder', () => {
    const list = parseCompoundRoute('sources/plugins')!
    expect(buildCompoundRoute(list)).toBe('sources/plugins')

    const detail = parseCompoundRoute(routes.view.sourcesPlugins('pk-1'))!
    expect(buildCompoundRoute(detail)).toBe('sources/plugins/plugin/pk-1')
  })

  it('round-trips through buildRouteFromNavigationState', () => {
    expect(buildRouteFromNavigationState({
      navigator: 'sources', filter: { kind: 'plugins' }, details: null,
    })).toBe('sources/plugins')
    expect(buildRouteFromNavigationState({
      navigator: 'sources', filter: { kind: 'plugins' }, details: { type: 'plugin', pluginKey: 'pk-1' },
    })).toBe('sources/plugins/plugin/pk-1')
  })

  it('round-trips through the navigation-state key helpers', () => {
    expect(getNavigationStateKey({ navigator: 'sources', filter: { kind: 'plugins' }, details: null }))
      .toBe('sources/plugins')
    expect(parseNavigationStateKey('sources/plugins')).toEqual({
      navigator: 'sources', filter: { kind: 'plugins' }, details: null,
    })
    expect(getNavigationStateKey({
      navigator: 'sources', filter: { kind: 'plugins' }, details: { type: 'plugin', pluginKey: 'pk-1' },
    })).toBe('sources/plugins/plugin/pk-1')
    expect(parseNavigationStateKey('sources/plugins/plugin/pk-1')).toEqual({
      navigator: 'sources', filter: { kind: 'plugins' }, details: { type: 'plugin', pluginKey: 'pk-1' },
    })
  })

  it('the existing type-filter routes still parse (no regression)', () => {
    expect(parseCompoundRoute('sources/mcp')).toEqual({
      navigator: 'sources', sourceFilter: { kind: 'type', sourceType: 'mcp' }, details: null,
    })
    expect(routes.view.sourcesPlugins()).toBe('sources/plugins')
  })
})

import { describe, expect, it } from 'bun:test'
import {
  buildCompoundRoute,
  buildRouteFromNavigationState,
  parseCompoundRoute,
  parseRoute,
  parseRouteToNavigationState,
} from '../route-parser'
import { routes } from '../routes'

describe('route-parser: plugins route', () => {
  it('parses plugins as standalone plugins navigator', () => {
    const parsed = parseCompoundRoute('plugins')

    expect(parsed).toEqual({
      navigator: 'plugins',
      details: null,
    })
  })

  it('roundtrips plugins route through compound and navigation-state helpers', () => {
    const parsed = parseCompoundRoute('plugins')

    expect(parsed).not.toBeNull()
    expect(buildCompoundRoute(parsed!)).toBe('plugins')
    expect(parseRoute('plugins')).toEqual({ type: 'view', name: 'plugins', params: {} })
    expect(parseRouteToNavigationState('plugins')).toEqual({ navigator: 'plugins' })
    expect(buildRouteFromNavigationState({ navigator: 'plugins' })).toBe('plugins')
    expect(routes.view.plugins()).toBe('plugins')
  })

  it('rejects nested plugins routes', () => {
    expect(parseCompoundRoute('plugins/anything')).toBeNull()
  })
})

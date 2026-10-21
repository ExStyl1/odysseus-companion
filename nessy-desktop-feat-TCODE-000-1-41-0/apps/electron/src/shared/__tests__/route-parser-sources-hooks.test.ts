import { describe, expect, it } from 'bun:test'
import {
  buildCompoundRoute,
  buildRouteFromNavigationState,
  parseCompoundRoute,
  parseRouteToNavigationState,
} from '../route-parser'
import { getNavigationStateKey, parseNavigationStateKey } from '../types'
import { routes } from '../routes'

const hooksState = {
  navigator: 'sources' as const,
  filter: { kind: 'hooks' as const },
  details: { type: 'hooks' as const },
}

describe('route-parser: sources/hooks subsection', () => {
  it('parses the project-hooks route', () => {
    expect(routes.view.sourcesHooks()).toBe('sources/hooks')
    expect(parseCompoundRoute('sources/hooks')).toEqual({
      navigator: 'sources',
      sourceFilter: { kind: 'hooks' },
      details: { type: 'hooks', id: 'hooks' },
    })
    expect(parseRouteToNavigationState('sources/hooks')).toEqual(hooksState)
  })

  it('round-trips through compound, navigation, and state-key builders', () => {
    expect(buildCompoundRoute(parseCompoundRoute('sources/hooks')!)).toBe('sources/hooks')
    expect(buildRouteFromNavigationState(hooksState)).toBe('sources/hooks')
    expect(getNavigationStateKey(hooksState)).toBe('sources/hooks')
    expect(parseNavigationStateKey('sources/hooks')).toEqual(hooksState)
  })
})

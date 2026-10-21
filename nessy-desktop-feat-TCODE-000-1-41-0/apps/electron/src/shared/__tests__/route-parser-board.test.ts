/**
 * UA2.2 — the Kanban board route (v0.13.4): `board` is a standalone sessions-navigator route in
 * `viewMode: 'board'` over all sessions. It round-trips through every route helper, and a
 * trailing segment is refused (upstream parsed `board/extra` as the board; a route the parser
 * silently truncates is a link that looks like it worked).
 */
import { describe, expect, it } from 'bun:test'
import {
  buildCompoundRoute,
  buildRouteFromNavigationState,
  isCompoundRoute,
  parseCompoundRoute,
  parseRoute,
  parseRouteToNavigationState,
} from '../route-parser'
import { routes } from '../routes'
import type { NavigationState } from '../types'

const BOARD_STATE: NavigationState = {
  navigator: 'sessions',
  filter: { kind: 'allSessions' },
  viewMode: 'board',
  details: null,
}

describe('UA2.2 — route-parser: board route', () => {
  it('POSITIVE — `board` round-trips through the compound, view-route and navigation-state helpers', () => {
    expect(routes.view.board()).toBe('board')
    expect(isCompoundRoute('board')).toBe(true)
    const parsed = parseCompoundRoute('board')
    expect(parsed).toEqual({ navigator: 'sessions', sessionFilter: { kind: 'allSessions' }, viewMode: 'board', details: null })
    expect(buildCompoundRoute(parsed!)).toBe('board')
    expect(parseRouteToNavigationState('board')).toEqual(BOARD_STATE)
    expect(buildRouteFromNavigationState(BOARD_STATE)).toBe('board')
    // The view-route form keeps the board's own name, and that name parses back to the board
    // (the path a navigation queued before the app is ready takes).
    expect(parseRoute('board')).toEqual({ type: 'view', name: 'board', params: {} })
    expect(parseRouteToNavigationState(parseRoute('board')!.name)).toEqual(BOARD_STATE)
  })

  it('NEGATIVE — `board/extra` (and any longer tail) is rejected', () => {
    expect(parseCompoundRoute('board/extra')).toBeNull()
    expect(parseCompoundRoute('board/session/abc')).toBeNull()
    expect(parseRouteToNavigationState('board/extra')).toBeNull()
  })

  it('BOUNDARY — the list keeps its exact shape: no viewMode key, and the list state builds its own route', () => {
    const list = parseRouteToNavigationState('allSessions')
    expect(list).toEqual({ navigator: 'sessions', filter: { kind: 'allSessions' }, details: null })
    expect(list && 'viewMode' in list).toBe(false)
    expect(buildRouteFromNavigationState({ navigator: 'sessions', filter: { kind: 'allSessions' }, details: null })).toBe('allSessions')
    expect(buildRouteFromNavigationState({ ...BOARD_STATE, viewMode: 'list' })).toBe('allSessions')
    expect(buildRouteFromNavigationState({ navigator: 'sessions', filter: { kind: 'flagged' }, details: { type: 'session', sessionId: 's1' } }))
      .toBe('flagged/session/s1')
  })
})

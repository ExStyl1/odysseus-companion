/**
 * UA5.8 — the Projects navigator's routes (ported from craft-agents-oss v0.13.4 `route-parser.ts`, `routes.ts`,
 * `types.ts` and `atoms/panel-stack.ts`, Apache-2.0), shaped as UA7.3's `route-parser-pages.test.ts`.
 *
 * POSITIVE: `projects` and `projects/project/{slug}` round-trip route ⇄ NavigationState ⇄ panel key, and the
 * new-session action carries the `project` param (`?project=`) to NavigationContext.
 * NEGATIVE: a query tail never leaks into a parsed segment — not into a session id the panel stack extracts,
 * not into a label id, not into a project slug; a projects route with a tail after the slug is refused, as
 * UA7.3's pages route is.
 */

import { describe, test, expect } from 'bun:test'
import {
  isCompoundRoute,
  parseCompoundRoute,
  buildCompoundRoute,
  parseRoute,
  parseRouteToNavigationState,
  buildRouteFromNavigationState,
} from '../route-parser'
import {
  getNavigationStateKey,
  parseNavigationStateKey,
  isProjectsNavigation,
  type NavigationState,
} from '../types'
import { routes } from '../routes'
import { parseSessionIdFromRoute } from '../../renderer/atoms/panel-stack'
import { isDetailNavState } from '../../renderer/lib/nav-helpers'

describe('UA5.8 — projects routes round-trip', () => {
  test('POSITIVE: the route builders emit the projects prefix', () => {
    expect(routes.view.projects()).toBe('projects')
    expect(routes.view.projects('acme')).toBe('projects/project/acme')
  })

  test('POSITIVE: projects is a compound route prefix', () => {
    expect(isCompoundRoute('projects')).toBe(true)
    expect(isCompoundRoute('projects/project/acme')).toBe(true)
  })

  test('POSITIVE: the bare route is the list with nothing selected; the detail route names the slug', () => {
    expect(parseCompoundRoute('projects')).toEqual({ navigator: 'projects', details: null })
    const list = parseRouteToNavigationState('projects')
    expect(list).toEqual({ navigator: 'projects', details: null })
    expect(list && isProjectsNavigation(list)).toBe(true)
    expect(parseCompoundRoute('projects/project/acme')).toEqual({
      navigator: 'projects',
      details: { type: 'project', id: 'acme' },
    })
    expect(parseRouteToNavigationState('projects/project/acme')).toEqual({
      navigator: 'projects',
      details: { type: 'project', projectSlug: 'acme' },
    })
  })

  test('POSITIVE: route ⇄ navigation state ⇄ panel key', () => {
    for (const route of ['projects', 'projects/project/acme'] as const) {
      const state = parseRouteToNavigationState(route)
      expect(state).not.toBeNull()
      expect(buildRouteFromNavigationState(state!)).toBe(route)
    }
    expect(buildCompoundRoute({ navigator: 'projects', details: null })).toBe('projects')
    expect(buildCompoundRoute({ navigator: 'projects', details: { type: 'project', id: 'x' } })).toBe('projects/project/x')
    const list: NavigationState = { navigator: 'projects', details: null }
    const detail: NavigationState = { navigator: 'projects', details: { type: 'project', projectSlug: 'acme' } }
    expect(getNavigationStateKey(list)).toBe('projects')
    expect(getNavigationStateKey(detail)).toBe('projects/project/acme')
    expect(parseNavigationStateKey('projects')).toEqual(list)
    expect(parseNavigationStateKey('projects/project/acme')).toEqual(detail)
  })

  test('POSITIVE: compact mode shows the content only once a project is open', () => {
    expect(isDetailNavState({ navigator: 'projects', details: null })).toBe(false)
    expect(isDetailNavState({ navigator: 'projects', details: { type: 'project', projectSlug: 'acme' } })).toBe(true)
  })

  test('POSITIVE: the new-session action carries the project id (`?project=`)', () => {
    const route = routes.action.newSession({ project: 'proj_0123abcd' })
    expect(route).toBe('action/new-session?project=proj_0123abcd')
    const parsed = parseRoute(route)
    expect(parsed?.type).toBe('action')
    expect(parsed?.name).toBe('new-session')
    expect(parsed?.params.project).toBe('proj_0123abcd')
  })
})

describe('UA5.8 — a query tail does not leak into a parsed segment', () => {
  test('NEGATIVE: the panel stack never reads `?x=y` as part of the focused session id', () => {
    expect(parseSessionIdFromRoute('allSessions/session/abc123?focus=1' as never)).toBe('abc123')
    expect(parseSessionIdFromRoute('allSessions/session/abc123' as never)).toBe('abc123')
  })

  test('NEGATIVE: a compound route with a query tail parses as its path alone', () => {
    expect(isCompoundRoute('allSessions?x=y')).toBe(true)
    expect(parseCompoundRoute('label/bug?x=y')).toEqual(parseCompoundRoute('label/bug'))
    expect(parseCompoundRoute('projects/project/acme?tab=assets')).toEqual({
      navigator: 'projects',
      details: { type: 'project', id: 'acme' },
    })
  })

  test('NEGATIVE: a projects route with a tail after the slug, or a non-`project` detail, is refused', () => {
    expect(parseCompoundRoute('projects/project/acme/extra')).toBeNull()
    expect(parseRouteToNavigationState('projects/project/acme/extra')).toBeNull()
    expect(parseCompoundRoute('projects/project')).toBeNull()
    expect(parseCompoundRoute('projects/session/acme')).toBeNull()
  })

  test('BOUNDARY: the pages, plugins and board routes keep their own navigators', () => {
    expect(parseRouteToNavigationState('pages')).toEqual({ navigator: 'pages', details: null })
    expect(parseRouteToNavigationState('plugins')).toEqual({ navigator: 'plugins' })
    expect(parseCompoundRoute('board')?.navigator).toBe('sessions')
  })
})

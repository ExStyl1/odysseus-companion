/* Copied from v0.13.4:apps/electron/src/shared/__tests__/route-parser-label-filter.test.ts (craft-agents-oss, Apache-2.0)
   by UA5.10, 2026-10-02, verbatim (upstream lands it with the board's task-scoped navigation). It pins the label
   routes (`label/<id>`, `label/<id>/session/<id>`) round-tripping, and that a query tail never leaks into a parsed
   label or session id. */
import { describe, it, expect } from 'bun:test'
import {
  parseCompoundRoute,
  buildCompoundRoute,
  parseRouteToNavigationState,
  buildRouteFromNavigationState,
} from '../route-parser'
import { routes } from '../routes'
import { isSessionsNavigation } from '../types'

describe('route-parser: label filter routes', () => {
  it('parses a plain label route', () => {
    const result = parseCompoundRoute('label/task')
    expect(result).not.toBeNull()
    expect(result!.sessionFilter).toEqual({ kind: 'label', labelId: 'task' })
    expect(result!.details).toBeNull()
  })

  it('round-trips a label route with session details', () => {
    const route = routes.view.label('task', 'abc123')
    expect(route).toBe('label/task/session/abc123')
    const state = parseRouteToNavigationState(route)
    if (!state || !isSessionsNavigation(state)) throw new Error('expected sessions navigation state')
    expect(state.filter).toEqual({ kind: 'label', labelId: 'task' })
    expect(state.details).toEqual({ type: 'session', sessionId: 'abc123' })
    expect(buildRouteFromNavigationState(state)).toBe('label/task/session/abc123')
  })

  it('builds label routes without details', () => {
    expect(
      buildCompoundRoute({
        navigator: 'sessions',
        sessionFilter: { kind: 'label', labelId: 'task' },
        details: null,
      })
    ).toBe('label/task')
  })

  it('a stray query tail never leaks into the parsed labelId (slash-segment invariant)', () => {
    const result = parseCompoundRoute('label/task?stray=x')
    expect(result).not.toBeNull()
    expect(result!.sessionFilter).toEqual({ kind: 'label', labelId: 'task' })
  })

  it('session ids extracted from label routes stay clean even with a query tail', () => {
    // Mirrors parseSessionIdFromRoute's segment logic (panel-stack.ts).
    const segments = 'label/task/session/abc123?stray=x'.split('?')[0].split('/')
    expect(segments[segments.indexOf('session') + 1]).toBe('abc123')
  })
})

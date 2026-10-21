/**
 * UA12.79 — a navigation queued before the app is ready lands where it aimed.
 *
 * A cold-start deep link to a detail view (`pages/page/x`,
 * `automations/automation/a`) used to be dropped by the pending-navigation
 * flush: it re-serialized the PARSED route as `${name}/${id}` — and
 * `pages/page/x` parses to `{ name: 'page-info', id: 'x' }`, whose rebuild
 * `page-info/x` is no compound prefix and parses to null. The ready path never
 * had the bug: it parses the ORIGINAL route string.
 *
 * Two halves, because either alone passes on the bug: the parser-level facts
 * (the control and boundary routes and their states, measured on the shipped
 * parser) and the context's composition read from source (the context cannot
 * be mounted here without the whole app shell — the D1.282 / reconcile-suite
 * reading).
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseRoute, parseRouteToNavigationState } from '../../../shared/route-parser'

const CONTEXT_SOURCE = readFileSync(join(import.meta.dir, '..', 'NavigationContext.tsx'), 'utf-8')

describe('UA12.79 — the pending-navigation flush keeps the original route', () => {
  it('no lossy name/id rebuild in the flush', () => {
    // RED at HEAD: `const routeStr = `${pending.name}${pending.id ? `/${pending.id}` : ''}``
    expect(CONTEXT_SOURCE).not.toContain('const routeStr = `${pending.name}')
  })

  it('the flush parses the route the caller stored', () => {
    expect(CONTEXT_SOURCE).toMatch(/pendingNavigationRef\.current = \{ parsed, options, route \}/)
    expect(CONTEXT_SOURCE).toMatch(/const \{ parsed: pending, options, route \} = pendingNavigationRef\.current/)
    expect(CONTEXT_SOURCE).toMatch(/const navState = parseRouteToNavigationState\(route\)/)
  })

  it('the ref carries the original route from the queue site', () => {
    // Specific to the ref's own type — a bare `route: Route` also matches the
    // navigate callback's parameter and could not fail on the defect.
    expect(CONTEXT_SOURCE).toMatch(/parsed: ParsedRoute; options\?: NavigateOptions; route: Route \}/)
  })
})

describe('the control routes reach their detail states — given the original string', () => {
  it('pages/page/x reaches the page detail', () => {
    expect(parseRoute('pages/page/x')).toMatchObject({ type: 'view', name: 'page-info', id: 'x' })
    expect(parseRouteToNavigationState('pages/page/x')).toEqual({
      navigator: 'pages',
      details: { type: 'page', pageSlug: 'x' },
    })
  })

  it('automations/automation/a reaches the automation detail', () => {
    expect(parseRoute('automations/automation/a')).toMatchObject({
      type: 'view', name: 'automation-info', id: 'a',
    })
    expect(parseRouteToNavigationState('automations/automation/a')).toEqual({
      navigator: 'automations',
      details: { type: 'automation', automationId: 'a' },
    })
  })

  it('the name/id rebuild is what dropped them — the parser answers null for both', () => {
    // The parser fact the old flush tripped on, pinned so a future rebuild
    // cannot sneak back: neither rebuilt string is a compound prefix.
    expect(parseRouteToNavigationState('page-info/x')).toBeNull()
    expect(parseRouteToNavigationState('automation-info/a')).toBeNull()
  })

  it('boundary: bare navigators keep their navigator-only states', () => {
    expect(parseRouteToNavigationState('pages')).toEqual({ navigator: 'pages', details: null })
    expect(parseRouteToNavigationState('automations')).toEqual({ navigator: 'automations', details: null })
  })
})

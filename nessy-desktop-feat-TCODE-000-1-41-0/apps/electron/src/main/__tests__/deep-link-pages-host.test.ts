/**
 * UA12.146 — the `pages` deep-link host: both documented forms parse, the tail
 * after the slug is refused like the routes refuse it.
 *
 * SIT-C (2026-10-04) measured `nessy://pages` and `nessy://pages/page/<slug>`
 * doing NOTHING on the packaged build: parseDeepLink's host list had no pages
 * entry, although `routes.view.pages` and the renderer parser accept both forms
 * and the docs-site deeplinks page documents them.
 *
 * The refusal arms mirror `route-parser.ts`'s own pages grammar (a tail after
 * the slug is REFUSED, not truncated), so a link the renderer would silently
 * drop never parses as a target at all. The CONTROL arms pin that every
 * pre-existing host's parse is byte-identical after the `compoundViewRoute`
 * extraction — that extraction touched the shared path of all of them.
 */
import { describe, expect, it } from 'bun:test'
import { parseDeepLink } from '../deep-link'

describe('parseDeepLink: pages host (UA12.146)', () => {
  it('POSITIVE: nessy://pages opens the pages grid', () => {
    expect(parseDeepLink('nessy://pages')).toEqual({
      workspaceId: undefined,
      view: 'pages',
      windowMode: undefined,
      rightSidebar: undefined,
    })
  })

  it('POSITIVE: nessy://pages/page/<slug> opens the page view', () => {
    expect(parseDeepLink('nessy://pages/page/my-page')).toEqual({
      workspaceId: undefined,
      view: 'pages/page/my-page',
      windowMode: undefined,
      rightSidebar: undefined,
    })
  })

  it('keeps the query params the host handlers already carry', () => {
    expect(parseDeepLink('nessy://pages/page/my-page?window=focused&sidebar=history')).toEqual({
      workspaceId: undefined,
      view: 'pages/page/my-page',
      windowMode: 'focused',
      rightSidebar: 'history',
    })
  })

  it('NEGATIVE: a tail after the slug is refused, not truncated (like the routes)', () => {
    // route-parser.ts refuses `pages/page/x/extra`; the deep link must not
    // hand the renderer a route it will silently drop.
    expect(parseDeepLink('nessy://pages/page/my-page/extra')).toBeNull()
  })

  it('NEGATIVE: any other pages shape is refused', () => {
    expect(parseDeepLink('nessy://pages/junk')).toBeNull()
    expect(parseDeepLink('nessy://pages/page')).toBeNull()
    expect(parseDeepLink('nessy://pages/page/')).toBeNull()
  })

  it('the workspace-scoped form accepts the same two shapes and refuses the same tails', () => {
    expect(parseDeepLink('nessy://workspace/ws-1/pages')).toEqual({
      workspaceId: 'ws-1',
      view: 'pages',
      windowMode: undefined,
      rightSidebar: undefined,
    })
    expect(parseDeepLink('nessy://workspace/ws-1/pages/page/my-page')).toEqual({
      workspaceId: 'ws-1',
      view: 'pages/page/my-page',
      windowMode: undefined,
      rightSidebar: undefined,
    })
    expect(parseDeepLink('nessy://workspace/ws-1/pages/page/my-page/extra')).toBeNull()
    expect(parseDeepLink('nessy://workspace/ws-1/pages/junk')).toBeNull()
  })
})

describe('parseDeepLink: CONTROL — every other host parses exactly as before', () => {
  it('the pre-existing compound hosts keep the join-everything grammar', () => {
    expect(parseDeepLink('nessy://allSessions')?.view).toBe('allSessions')
    expect(parseDeepLink('nessy://allSessions/session/abc')?.view).toBe('allSessions/session/abc')
    expect(parseDeepLink('nessy://sources/source/github')?.view).toBe('sources/source/github')
    expect(parseDeepLink('nessy://settings/shortcuts')?.view).toBe('settings/shortcuts')
    expect(parseDeepLink('nessy://skills/skill/my-skill')?.view).toBe('skills/skill/my-skill')
    // A host that is NOT pages may still carry a tail — unchanged behaviour.
    expect(parseDeepLink('nessy://allSessions/session/abc/extra')?.view).toBe('allSessions/session/abc/extra')
  })

  it('the workspace compound routes keep their reconstruction', () => {
    expect(parseDeepLink('nessy://workspace/ws-1/allSessions')).toEqual({
      workspaceId: 'ws-1',
      view: 'allSessions',
      windowMode: undefined,
      rightSidebar: undefined,
    })
    expect(parseDeepLink('nessy://workspace/ws-1/allSessions/session/abc')?.view).toBe('allSessions/session/abc')
    expect(parseDeepLink('nessy://workspace/ws-1/settings/shortcuts')?.view).toBe('settings/shortcuts')
  })

  it('the action and auth-callback shapes are untouched', () => {
    expect(parseDeepLink('nessy://action/new-session')?.action).toBe('new-session')
    expect(parseDeepLink('nessy://auth-callback?code=x')).toBeNull()
    expect(parseDeepLink('nessy://unknown-host/x')).toBeNull()
  })
})

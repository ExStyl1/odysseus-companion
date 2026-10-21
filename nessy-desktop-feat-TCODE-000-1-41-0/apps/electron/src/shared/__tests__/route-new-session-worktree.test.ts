import { describe, expect, it } from 'bun:test'
import { routes } from '../routes'
import { resolveDeepLinkAction } from '../../renderer/contexts/deep-link-policy'

/**
 * P6.133 — the New-Chat route can now ask for an isolated worktree, and only an
 * IN-APP navigation may.
 *
 * The host port has existed since P6.20 and is provider-free — Pi, claude and
 * codex get it identically, because it is the host mechanism rather than any
 * runtime's own flag — but nothing user-reachable ever passed the field. The
 * missing piece was an entry point, so what is worth pinning is the entry
 * point's two properties: the parameter reaches the route at all, and the trust
 * gate that stops an untrusted page causing it is real.
 *
 * The gate matters because creating a worktree is not a view change: it runs
 * git and takes a host lease. `NavigationContext` honours the parameter under
 * `link.trusted &&`, and `resolveDeepLinkAction` is the function that decides
 * that word — so the second block asserts on the decider rather than restating
 * the conjunct.
 */
describe('routes.action.newSession — the worktree parameter', () => {
  it('carries `worktree=true` when asked, and is absent when not', () => {
    expect(routes.action.newSession({ worktree: true })).toContain('worktree=true')
    // BOUNDARY: the query string must not grow a `worktree=false` — the handler
    // matches the string `'true'`, and an explicit false is simply the default.
    expect(routes.action.newSession({ worktree: false })).not.toContain('worktree')
    expect(routes.action.newSession()).toBe('action/new-session')
    expect(routes.action.newSession({})).toBe('action/new-session')
  })

  it('composes with the parameters that were already there', () => {
    const route = routes.action.newSession({ name: 'Isolated', worktree: true })
    expect(route).toContain('name=Isolated')
    expect(route).toContain('worktree=true')
  })
})

describe('P6.133 — the trust gate the worktree parameter rides', () => {
  it('an in-app new-session route is trusted, an external one is not', () => {
    // POSITIVE: in-app navigation carries no origin and resolves internal.
    expect(resolveDeepLinkAction('new-session', { worktree: 'true' }, 'internal').trusted).toBe(true)
    // NEGATIVE: the deep-link listener marks a route external, and the handler's
    // `link.trusted &&` conjunct is what drops the field there. Without this,
    // `nessy://action/new-session?worktree=true` from any page would run git.
    expect(resolveDeepLinkAction('new-session', { worktree: 'true' }, 'external').trusted).toBe(false)
  })
})

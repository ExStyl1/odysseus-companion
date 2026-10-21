import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isWorkspaceSwitchPending, normalizePanelRouteForReconcile, resolveInitialPanelRoute } from '../navigation-reconcile'
import type { NavigationState } from '../../../shared/types'

describe('normalizePanelRouteForReconcile', () => {
  it('auto-selects session details for filter-only session routes', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        return {
          ...state,
          details: { type: 'session', sessionId: 's1' },
        }
      }
      return state
    }

    const normalized = normalizePanelRouteForReconcile('allSessions', resolver)
    expect(normalized).toBe('allSessions/session/s1')
  })

  it('keeps explicit session details unchanged', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        return {
          ...state,
          details: { type: 'session', sessionId: 's1' },
        }
      }
      return state
    }

    const normalized = normalizePanelRouteForReconcile('allSessions/session/s2', resolver)
    expect(normalized).toBe('allSessions/session/s2')
  })

  it('normalizes each session panel route independently', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        const sessionId = state.filter.kind === 'flagged' ? 'flagged-1' : 'all-1'
        return {
          ...state,
          details: { type: 'session', sessionId },
        }
      }
      return state
    }

    const routes = ['allSessions', 'flagged'] as const
    const normalized = routes.map((route) => normalizePanelRouteForReconcile(route, resolver))

    expect(normalized).toEqual(['allSessions/session/all-1', 'flagged/session/flagged-1'])
  })

  it('keeps route unchanged when resolver leaves state without details', () => {
    const resolver = (state: NavigationState): NavigationState => state

    const normalized = normalizePanelRouteForReconcile('allSessions', resolver)
    expect(normalized).toBe('allSessions')
  })

  it('keeps non-session routes unchanged with session-only resolver', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        return {
          ...state,
          details: { type: 'session', sessionId: 's1' },
        }
      }
      return state
    }

    expect(normalizePanelRouteForReconcile('settings', resolver)).toBe('settings')
    expect(normalizePanelRouteForReconcile('sources', resolver)).toBe('sources')
    expect(normalizePanelRouteForReconcile('plugins', resolver)).toBe('plugins')
  })

  it('UA12.161 CONTRACT CHANGE — the resolver\u2019s rewrite of an explicit detail wins: a rewritten detail is the dead-signal', () => {
    // The old contract kept the URL verbatim no matter what the resolver did with a detail
    // route — that is exactly what preserved a deleted session. Under the shared UA12.155
    // recognition, "resolver rewrote the details" IS how a dead target is signalled, so a
    // rewrite resolves to the live route. A resolver that rewrote a LIVE detail would be a
    // resolver bug: NavigationContext's resolveAutoSelection returns live details unchanged.
    // The `sources` arm pins the HELPER only — production's resolver validates sessions alone,
    // so a source/skill detail is never rewritten there and survives verbatim (UA12.179).
    const resolver = (state: NavigationState): NavigationState => {
      if ('details' in state) {
        if (state.navigator === 'sessions') {
          return { ...state, details: { type: 'session', sessionId: 'rewritten' } }
        }
        if (state.navigator === 'sources') {
          return { ...state, details: { type: 'source', sourceSlug: 'rewritten' } }
        }
      }
      return state
    }

    expect(normalizePanelRouteForReconcile('allSessions/session/s2', resolver)).toBe('allSessions/session/rewritten')
    expect(normalizePanelRouteForReconcile('sources/source/github', resolver)).toBe('sources/source/rewritten')
  })

  it('live explicit detail routes stay distinct across multiple panels — distinctness is the live-target shape now', () => {
    // The old test proved distinctness by a resolver that rewrote every detail (and a verbatim
    // branch that ignored it). Distinctness now comes from the production resolver shape: live
    // details come back UNCHANGED, so each panel keeps its own session verbatim.
    const liveResolver = (state: NavigationState): NavigationState => state

    const routes = ['allSessions/session/left', 'allSessions/session/right'] as const
    const normalized = routes.map((route) => normalizePanelRouteForReconcile(route, liveResolver))

    expect(normalized).toEqual(['allSessions/session/left', 'allSessions/session/right'])
  })
})

/**
 * UA12.161 — a `?panels=` entry no longer preserves a deleted session verbatim.
 *
 * Control (the row's): boot with `panels=allSessions/session/<gone>:0.5,allSessions:0.5` —
 * the dead panel must resolve to a LIVE route. The mechanism is UA12.155's, shared: the
 * `?panels=` branch (`reconcileFromUrlParams`) feeds `normalizePanelRouteForReconcile` the SAME
 * `resolveAutoSelection` that the `?route=` branch feeds `resolveInitialPanelRoute`, and a detail
 * route survives verbatim only while the resolver returns its details UNCHANGED (the same
 * reference — NavigationContext's live-target shape, NavigationContext.tsx:744-751); a dead
 * target (details dropped, or replaced by the auto-selected fallback) resolves to the resolver's
 * live route instead of booting a panel into session-not-found.
 *
 * These arms were written FIRST and fail at HEAD, where the verbatim branch is unconditional.
 */
describe('UA12.161 — a dead ?panels= session entry resolves to a live route', () => {
  /** The deleted-session shape: the dead detail is dropped and the auto-selected fallback fills in. */
  const deadResolver = (state: NavigationState): NavigationState => {
    if (state.navigator === 'sessions' && state.details?.type === 'session' && state.details.sessionId.startsWith('gone')) {
      return { ...state, details: { type: 'session', sessionId: 'live-1' } }
    }
    return state
  }
  /** The deleted-session shape with nothing to fall back to: the detail is dropped, the view stays. */
  const deadNoFallbackResolver = (state: NavigationState): NavigationState =>
    (state.navigator === 'sessions' && state.details) ? { ...state, details: null } : state

  it('CONTROL — a dead session panel resolves to the auto-selected live session', () => {
    expect(normalizePanelRouteForReconcile('allSessions/session/gone', deadResolver)).toBe('allSessions/session/live-1')
  })

  it('BOUNDARY — a dead target with no fallback resolves to the plain view route (never session-not-found)', () => {
    expect(normalizePanelRouteForReconcile('allSessions/session/gone', deadNoFallbackResolver)).toBe('allSessions')
  })

  it('MULTI-PANEL — two dead panels each resolve to the live fallback (the stale multi-panel URL the row names)', () => {
    const routes = ['allSessions/session/gone', 'allSessions/session/gone-2'] as const
    const normalized = routes.map((route) => normalizePanelRouteForReconcile(route, deadResolver))
    expect(normalized).toEqual(['allSessions/session/live-1', 'allSessions/session/live-1'])
  })

  it('NavigationContext feeds the panels branch the same dead-aware resolver (the wiring)', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    const ctx = read('../NavigationContext.tsx')
    const branch = ctx.slice(ctx.indexOf('if (panelsParam) {'), ctx.indexOf('} else if (initialRoute) {'))
    expect(branch).toContain('normalizePanelRouteForReconcile(rawRoute, (state) => resolveAutoSelectionRef.current(state))')
  })
})

/**
 * UA12.155 — the route a persisted `?route=` restores its single panel to on boot. SIT-D F5:
 * `nessy-workspace-url` held `route=allSessions/session/<deleted-id>`; boot reconciled that stale
 * route verbatim, the renderer logged `session-not-found`, and the dead route + stale composer
 * wedged navigation until the key was cleared. A detail route now survives only while its target
 * is live — recognised by the resolver returning the state UNCHANGED (same details reference),
 * which NavigationContext's resolveAutoSelection does exactly for a session the workspace still
 * carries — and a dead target takes the resolver's live fallback instead.
 */
describe('UA12.155 — resolveInitialPanelRoute falls back to a live route when the persisted target is gone', () => {
  /** The live-session shape of NavigationContext's resolveAutoSelection: a carried session comes back unchanged. */
  const liveResolver = (state: NavigationState): NavigationState => state
  /** The deleted-session shape: the dead detail is dropped and the auto-selected fallback fills in. */
  const deadResolver = (state: NavigationState): NavigationState => {
    if (state.navigator === 'sessions' && state.details?.type === 'session' && state.details.sessionId === 'gone') {
      return { ...state, details: { type: 'session', sessionId: 'live-1' } }
    }
    return state
  }
  /** The deleted-session shape with nothing to fall back to: the detail is dropped, the view stays. */
  const deadNoFallbackResolver = (state: NavigationState): NavigationState =>
    (state.navigator === 'sessions' && state.details) ? { ...state, details: null } : state

  it('DEFECT (SIT-D F5) — a session detail the resolver rewrites (deleted session) resolves to the live fallback route', () => {
    expect(resolveInitialPanelRoute('allSessions/session/gone', deadResolver)).toBe('allSessions/session/live-1')
  })

  it('BOUNDARY — a dead target with no fallback session resolves to the plain view route (never session-not-found)', () => {
    expect(resolveInitialPanelRoute('allSessions/session/gone', deadNoFallbackResolver)).toBe('allSessions')
  })

  it('POSITIVE — a live session detail keeps the persisted URL verbatim (the resolver returns it unchanged)', () => {
    expect(resolveInitialPanelRoute('allSessions/session/live-1', liveResolver)).toBe('allSessions/session/live-1')
    expect(resolveInitialPanelRoute('allSessions/session/live-1', deadResolver)).toBe('allSessions/session/live-1')
  })

  it('CONTROL — a filter-only route still auto-selects through the resolver, exactly as the old branch did', () => {
    expect(resolveInitialPanelRoute('allSessions', liveResolver)).toBe('allSessions')
  })

  it('NEGATIVE — an unparseable route returns null: the caller keeps entries empty, as before', () => {
    expect(resolveInitialPanelRoute('', liveResolver)).toBeNull()
  })

  it('NavigationContext routes the boot single-panel branch through it (the wiring, not just the helper)', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    const ctx = read('../NavigationContext.tsx')
    const branch = ctx.slice(ctx.indexOf('} else if (initialRoute) {'), ctx.indexOf('if (entries.length > 0)'))
    expect(branch).toContain('resolveInitialPanelRoute(initialRoute')
  })
})

/**
 * UA12.179 — an in-window workspace switch must not reconcile `?panels=` against an EMPTY meta map.
 * App's handleSelectWorkspace empties sessionMetaMapAtom on a switch; while `sessionsLoaded` stayed
 * true, NavigationContext's switch effect reconciled the saved URL in the same commit, every LIVE
 * session panel resolved as dead (no meta yet) and collapsed to the plain view, and that collapse was
 * saved over the workspace's layout (2026-10-08 verification, UA12.161 finding). "Dead" must mean
 * dead, not "not loaded yet": the switch clears `sessionsLoaded` in the same synchronous block, so the
 * effect's isSessionsReady gate holds the reconcile until the new workspace's sessions have arrived.
 * The CONTROL that a truly deleted session still collapses is the UA12.161 describe above (the
 * resolver with a loaded map). React state cannot be rendered here (no DOM library), so the two arms
 * below pin the wiring on the source.
 */
describe('UA12.179 — the in-window workspace switch waits for the new workspace’s sessions', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

  it('DEFECT — handleSelectWorkspace clears sessionsLoaded in the same synchronous block that empties the meta map', () => {
    const app = read('../../App.tsx')
    const start = app.indexOf('const handleSelectWorkspace = useCallback(')
    expect(start).toBeGreaterThan(-1)
    const body = app.slice(start, app.indexOf('}, [windowWorkspaceId, setSession, store])', start))
    const afterAwait = body.slice(body.indexOf('await window.electronAPI.switchWorkspace(workspaceId)'))
    // One await only (the main-process switch); everything after it runs in one synchronous block.
    expect(afterAwait.indexOf('await ', 1)).toBe(-1)
    expect(afterAwait).toContain('setWindowWorkspaceId(workspaceId)')
    expect(afterAwait).toContain('setSessionsLoaded(false)')
    expect(afterAwait).toContain('store.set(sessionMetaMapAtom, new Map())')
  })

  it('BOUNDARY — the switch effect gates on isSessionsReady BEFORE it consumes the switch (previousWorkspaceIdRef)', () => {
    const ctx = read('../NavigationContext.tsx')
    const start = ctx.indexOf('const previousWorkspaceIdRef = useRef<string | null>(null)')
    expect(start).toBeGreaterThan(-1)
    const effect = ctx.slice(start, ctx.indexOf('}, [workspaceId, store, updateCanGoBackForward, getSemanticHistoryKey, isSessionsReady])', start))
    const gate = effect.indexOf('if (!workspaceId || !isSessionsReady) return')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(effect.indexOf('previousWorkspaceIdRef.current = workspaceId'))
    expect(effect).toContain('reconcileFromUrlParamsRef.current(new URLSearchParams(url.search))')
  })
})

/**
 * UA12.179 follow-up — the load window the switch now waits through must not let a WRITER persist
 * the old workspace's panels under the new workspace's key (2026-10-08 verifier + skeptic). From
 * the commit that changes `workspaceId` until the switch effect consumes it (after the new
 * workspace's sessions load) the OLD panel stack is still mounted: initializeSessions fills the
 * meta map BEFORE the permission-mode IPCs and `setSessionsLoaded(true)`, so the AUTO-SELECT ON
 * SESSION LOAD effect saw the new metas against the old focused list and navigated it, and the
 * panelStack subscription's syncUrl saved that single panel as the new workspace's URL — which the
 * switch effect then restored instead of its saved `?panels=` layout. A focus change, resize or
 * sidebar toggle in the window did the same through syncUrl.
 */
describe('UA12.179 follow-up — nothing writes the new workspace’s URL before its switch is consumed', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  const ctx = read('../NavigationContext.tsx')

  it('isWorkspaceSwitchPending — pending from the id change until the switch effect consumes it', () => {
    expect(isWorkspaceSwitchPending('ws-old', 'ws-new')).toBe(true)
  })

  it('BOUNDARY — not pending once consumed, before the first mount is consumed, or with no workspace', () => {
    expect(isWorkspaceSwitchPending('ws-new', 'ws-new')).toBe(false)
    expect(isWorkspaceSwitchPending(null, 'ws-new')).toBe(false)
    expect(isWorkspaceSwitchPending('ws-old', null)).toBe(false)
  })

  it('DEFECT — syncUrl returns while a switch is pending, before it builds or persists any URL', () => {
    const start = ctx.indexOf('const syncUrl = useCallback(')
    expect(start).toBeGreaterThan(-1)
    const body = ctx.slice(start, ctx.indexOf('}, [store, workspaceId, updateCanGoBackForward])', start))
    const gate = body.indexOf('isWorkspaceSwitchPending(previousWorkspaceIdRef.current, workspaceId)) return')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(body.indexOf('history.pushState'))
    expect(gate).toBeLessThan(body.indexOf('storage.set(storage.KEYS.workspaceUrl'))
  })

  it('DEFECT — AUTO-SELECT ON SESSION LOAD waits for the sessions and the consumed switch, and acts only on the store’s current focused route', () => {
    const start = ctx.indexOf('// AUTO-SELECT ON SESSION LOAD')
    expect(start).toBeGreaterThan(-1)
    const effect = ctx.slice(start, ctx.indexOf('// CONTEXT VALUE', start))
    const act = effect.indexOf('navigateToSession(resolved.details.sessionId)')
    expect(act).toBeGreaterThan(-1)
    const gate = effect.indexOf('if (!isSessionsReady || isWorkspaceSwitchPending(previousWorkspaceIdRef.current, workspaceId)) return')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(act)
    const fresh = effect.indexOf('if (store.get(focusedPanelRouteAtom) !== focusedRoute) return')
    expect(fresh).toBeGreaterThan(-1)
    expect(fresh).toBeLessThan(act)
    // The flag is a dependency, so the effect re-runs (fresh) once the sessions are in.
    expect(effect).toMatch(/\[\s*isReady,\s*isSessionsReady,\s*workspaceId,\s*focusedRoute,/)
  })
})

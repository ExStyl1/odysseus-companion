import { buildRouteFromNavigationState, parseRouteToNavigationState } from '../../shared/route-parser'
import type { ViewRoute } from '../../shared/routes'
import type { NavigationState } from '../../shared/types'

export type AutoSelectionResolver = (state: NavigationState) => NavigationState

/**
 * UA12.161 — the one recognition both URL surfaces share: a detail route survives verbatim
 * only while its target is still live, which the resolver signals by returning the state with
 * the SAME details reference. NavigationContext's `resolveAutoSelection` does exactly that for
 * a SESSION the workspace still carries (returns it unchanged) and drops or replaces the details
 * of a deleted one (its session-validation branch, then the last/first fallback) — so a dead
 * session resolves to the resolver's live fallback instead of a panel that boots into
 * session-not-found. SESSIONS ONLY: the resolver validates no source or skill detail, so a dead
 * source/skill detail comes back as the same reference and survives verbatim (UA12.179).
 * "Dead" also needs a LOADED meta map — against an empty one every session reads as dead, so the
 * callers reconcile only once sessions are ready (App's workspace switch clears that flag,
 * UA12.179).
 */
function resolvesToSameDetails(navState: NavigationState, resolved: NavigationState): boolean {
  return 'details' in navState && 'details' in resolved && navState.details != null && resolved.details === navState.details
}

/**
 * Normalize a panel route during URL reconciliation (a `?panels=` entry).
 *
 * Ensures filter-only routes (e.g. `allSessions`) can be upgraded to
 * canonical detail routes (e.g. `allSessions/session/{id}`) via the same
 * auto-selection policy used by normal navigation.
 *
 * UA12.161 — CONTRACT CHANGE: an explicit detail route no longer survives verbatim
 * unconditionally (the old "preserve exactly as encoded in URL" branch). It survives only while
 * its session target is live, recognised by `resolvesToSameDetails` (a source/skill detail is
 * never validated, so it still survives verbatim); a deleted session resolves to a
 * LIVE route — the auto-selected fallback, else the plain view — the same verdict
 * `resolveInitialPanelRoute` has issued for `?route=` since UA12.155, through the same resolver
 * the `?panels=` branch already passed. A stale multi-panel URL can therefore no longer boot a
 * dead panel. Pinned live by the resolver: two live panels stay distinct verbatim (each detail
 * comes back unchanged); two dead ones converge on the fallback.
 */
export function normalizePanelRouteForReconcile(
  route: ViewRoute,
  resolveAutoSelection: AutoSelectionResolver,
): ViewRoute {
  const navState = parseRouteToNavigationState(route)
  if (!navState) return route

  const resolved = resolveAutoSelection(navState)
  if (resolvesToSameDetails(navState, resolved)) {
    return route
  }
  return buildRouteFromNavigationState(resolved) as ViewRoute
}

/**
 * UA12.155 — the route a persisted `?route=` restores its single panel to (the boot restore and
 * the workspace-switch restore of `nessy-workspace-url`). A detail route survives verbatim only
 * while its target is still live: that is recognised by the resolver returning the state with the
 * SAME details reference, which NavigationContext's resolveAutoSelection does exactly for a
 * session the workspace still carries (it returns a live-session state unchanged, and drops or
 * replaces the details of a deleted one). A deleted session therefore resolves to a LIVE route —
 * the auto-selected fallback, else the plain view — instead of booting into session-not-found
 * with a dead route and a stale composer (SIT-D F5: `route=allSessions/session/<deleted-id>`
 * wedged RS-114's arm A until the key was cleared). Filter-only routes auto-select exactly as
 * the inline branch did; an unparseable route returns null and the caller keeps entries empty.
 */
export function resolveInitialPanelRoute(
  initialRoute: string,
  resolveAutoSelection: AutoSelectionResolver,
): ViewRoute | null {
  const navState = parseRouteToNavigationState(initialRoute)
  if (!navState) return null

  const resolved = resolveAutoSelection(navState)
  if (resolvesToSameDetails(navState, resolved)) {
    return initialRoute as ViewRoute
  }
  return buildRouteFromNavigationState(resolved) as ViewRoute
}

/**
 * UA12.179 follow-up — an in-window workspace switch is PENDING from the commit that changes
 * `workspaceId` until NavigationContext's switch effect consumes it (`previousWorkspaceIdRef`),
 * which since UA12.179 waits for the new workspace's sessions. In that window the OLD workspace's
 * panel stack is still mounted, so a writer that runs then (syncUrl's per-workspace URL, the
 * AUTO-SELECT ON SESSION LOAD effect) would persist the old panels — or an auto-selected session
 * on the old focused list — under the NEW workspace's key, and the switch effect would restore
 * that instead of the workspace's saved `?panels=` layout. Not pending before the first mount is
 * consumed (`consumedWorkspaceId` null — boot is gated by initial restoration instead) or with no
 * workspace.
 */
export function isWorkspaceSwitchPending(
  consumedWorkspaceId: string | null,
  workspaceId: string | null | undefined,
): boolean {
  return consumedWorkspaceId !== null && workspaceId != null && consumedWorkspaceId !== workspaceId
}

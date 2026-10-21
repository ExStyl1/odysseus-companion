/**
 * Deep Link Handler
 *
 * Parses nessy:// URLs and routes to appropriate actions.
 *
 * URL Formats (workspace is optional - uses active window if omitted):
 *
 * Compound format (hierarchical navigation):
 *   nessy://allSessions[/session/{sessionId}]            - Session list (all sessions)
 *   nessy://flagged[/session/{sessionId}]             - Session list (flagged filter)
 *   nessy://state/{stateId}[/session/{sessionId}]     - Session list (state filter)
 *   nessy://sources[/source/{sourceSlug}]          - Sources list
 *   nessy://settings[/{subpage}]                   - Settings (general, shortcuts, preferences)
 *
 * Action format:
 *   nessy://action/{actionName}[/{id}][?params]
 *   nessy://workspace/{workspaceId}/action/{actionName}[?params]
 *
 * Actions (the authoritative list is the switch in NavigationContext's
 * handleActionNavigation — this handler only routes the name, it does not
 * validate it):
 *   new-session               - Create new chat, optional ?input=text&name=name&send=true
 *                               send=true is honoured only for an 'internal'
 *                               origin; an external link always prefills
 *   rename-session/{id}       - Rename session
 *   delete-session/{id}       - Delete session
 *   flag-session/{id}         - Flag session
 *   unflag-session/{id}       - Unflag session
 *   oauth/{sourceSlug}        - Start the source sign-in flow
 *   delete-source/{slug}      - Delete source
 *   set-mode/{id}?mode=       - Set the session's permission mode
 *   copy?text=                - Copy text to the clipboard
 *   install-plugin/{plugin}   - Open the plugin install dialog with the plugin
 *     ?marketplace={name}       (and the marketplace, when named) PRE-FILLED.
 *                               Also accepts the vendor's documented
 *                               `plugin-name@marketplace-name` spelling in the
 *                               id. INSTALLS NOTHING: the install runs when the
 *                               user presses the button, from any origin. The
 *                               marketplace name is resolved against the
 *                               marketplaces this machine has already
 *                               registered — a link can neither add one nor
 *                               reach one that is not there (P6.512, owner
 *                               decision Q-den 43, option 2).
 *                               STATED DIVERGENCE: codex answers
 *                               `codex://plugins/install/<id>?marketplace=<m>`
 *                               with a one-click install. Ours is two clicks,
 *                               deliberately — the last step is a person.
 *
 * Examples:
 *   nessy://allSessions                               (all sessions view)
 *   nessy://allSessions/session/abc123                (specific session)
 *   nessy://settings/shortcuts                     (shortcuts page)
 *   nessy://sources/source/github                  (github source info)
 *   nessy://action/new-session                     (uses active window)
 *   nessy://workspace/ws123/allSessions/session/abc123   (targets specific workspace)
 *
 * TRUST: every entry point must label the URL with a `DeepLinkOrigin`. Only a
 * dispatch that Nessy itself produced is 'internal'; anything the OS, a web
 * page or model output handed us is 'external' and the renderer keeps it inert.
 */

import type { BrowserWindow } from 'electron'
import { mainLog } from './logger'
import type { WindowManager } from './window-manager'
import { RPC_CHANNELS } from '../shared/types'
import type { EventSink } from '@nessy-agent/server-core/transport'

/**
 * Trust label for a deep link, decided by the entry point that received it.
 *
 * 'external' - OS `open-url`, a page in the in-app browser pane, a markdown
 *              link in model output: anything Nessy did not itself produce.
 * 'internal' - a dispatch Nessy built from its own UI state.
 */
export type DeepLinkOrigin = 'external' | 'internal'

export interface DeepLinkTarget {
  /** Workspace ID - undefined means use active window */
  workspaceId?: string
  /** Compound route format (e.g., 'allSessions/session/abc123', 'settings/shortcuts') */
  view?: string
  /** Action route (e.g., 'new-session', 'delete-session') */
  action?: string
  actionParams?: Record<string, string>
  /** Window mode - if set, opens in a new window instead of navigating in existing */
  windowMode?: 'focused' | 'full'
  /** Right sidebar param (e.g., 'files/path/to/file', 'history') */
  rightSidebar?: string
}

export interface DeepLinkResult {
  success: boolean
  error?: string
  windowId?: number
}

/**
 * Navigation payload sent to renderer via IPC
 */
export interface DeepLinkNavigation {
  /** Compound route format (e.g., 'allSessions/session/abc123', 'settings/shortcuts') */
  view?: string
  /** Action route (e.g., 'new-session', 'delete-session') */
  action?: string
  actionParams?: Record<string, string>
  /** Trust label of the URL this navigation came from. See DeepLinkOrigin. */
  origin?: DeepLinkOrigin
}

/**
 * Parse window mode from URL search params
 */
function parseWindowMode(parsed: URL): 'focused' | 'full' | undefined {
  const windowParam = parsed.searchParams.get('window')
  if (windowParam === 'focused' || windowParam === 'full') {
    return windowParam
  }
  return undefined
}

/**
 * Parse right sidebar param from URL search params
 */
function parseRightSidebar(parsed: URL): string | undefined {
  return parsed.searchParams.get('sidebar') || undefined
}

/**
 * Parse a deep link URL into structured target
 */
export function parseDeepLink(url: string): DeepLinkTarget | null {
  try {
    const parsed = new URL(url)

    if (parsed.protocol !== 'nessy:') {
      return null
    }

    // For custom protocols, the hostname contains the first path segment
    // e.g., nessy://workspace/ws123 → hostname='workspace', pathname='/ws123'
    // e.g., nessy://allSessions/chat/abc → hostname='allSessions', pathname='/chat/abc'
    const host = parsed.hostname
    const pathParts = parsed.pathname.split('/').filter(Boolean)
    const windowMode = parseWindowMode(parsed)
    const rightSidebar = parseRightSidebar(parsed)

    // nessy://auth-callback?... (OAuth callbacks - return null to let existing handler process)
    if (host === 'auth-callback') {
      return null
    }

    // Compound route prefixes
    const COMPOUND_ROUTE_PREFIXES = [
      'allSessions', 'flagged', 'state', 'sources', 'settings', 'skills', 'pages'
    ]

    // nessy://allSessions/..., nessy://settings/..., etc. (compound routes)
    if (COMPOUND_ROUTE_PREFIXES.includes(host)) {
      // Reconstruct the full compound route; pages refuses tails (UA12.146)
      const viewRoute = compoundViewRoute(host, pathParts)
      return viewRoute === null ? null : {
        workspaceId: undefined,
        view: viewRoute,
        windowMode,
        rightSidebar,
      }
    }

    // nessy://workspace/{workspaceId}/... (with workspace targeting)
    if (host === 'workspace') {
      const workspaceId = pathParts[0]
      if (!workspaceId) return null

      const result: DeepLinkTarget = { workspaceId, windowMode, rightSidebar }

      // Check what type of route follows the workspace ID
      const routeType = pathParts[1]

      // Parse compound routes: /workspace/{id}/{compoundRoute}
      // e.g., /workspace/ws123/allSessions/session/abc123
      if (routeType && COMPOUND_ROUTE_PREFIXES.includes(routeType)) {
        const viewRoute = compoundViewRoute(routeType, pathParts.slice(2))
        if (viewRoute === null) return null
        return { ...result, view: viewRoute }
      }

      // Parse /action/{actionName}/...
      if (routeType === 'action') {
        result.action = pathParts[2]
        result.actionParams = {}
        // Handle path-based ID (e.g., /action/delete-session/{sessionId})
        if (pathParts[3]) {
          result.actionParams.id = pathParts[3]
        }
        parsed.searchParams.forEach((value, key) => {
          // Skip the window and sidebar params - they're handled separately
          if (key !== 'window' && key !== 'sidebar') {
            result.actionParams![key] = value
          }
        })
        return result
      }

      return result
    }

    // nessy://action/... (no workspace - uses active window)
    if (host === 'action') {
      const result: DeepLinkTarget = {
        workspaceId: undefined,
        action: pathParts[0],
        actionParams: {},
        windowMode,
        rightSidebar,
      }

      if (pathParts[1]) {
        result.actionParams!.id = pathParts[1]
      }

      parsed.searchParams.forEach((value, key) => {
        // Skip the window and sidebar params - they're handled separately
        if (key !== 'window' && key !== 'sidebar') {
          result.actionParams![key] = value
        }
      })

      return result
    }

    return null
  } catch (error) {
    mainLog.error('[DeepLink] Failed to parse URL:', url, error)
    return null
  }
}

/**
 * Wait for window's renderer to signal ready
 */
function waitForWindowReady(window: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    if (window.webContents.isLoading()) {
      window.webContents.once('did-finish-load', () => {
        // TIMING NOTE: This 100ms delay allows React to mount and register
        // IPC listeners before we send the deep link. `did-finish-load` fires
        // when the HTML is loaded, but React's useEffect hooks haven't run yet.
        // A proper handshake (renderer signals "ready") would be cleaner but
        // adds complexity for minimal gain - this delay is sufficient for all
        // practical cases and only affects reload scenarios.
        setTimeout(resolve, 100)
      })
    } else {
      resolve()
    }
  })
}

/**
 * Build a deep link URL without the window query parameter
 */
function buildDeepLinkWithoutWindowParam(url: string): string {
  const parsed = new URL(url)
  parsed.searchParams.delete('window')
  return parsed.toString()
}

/**
 * Handle a deep link by navigating to the target
 */
export async function handleDeepLink(
  url: string,
  windowManager: WindowManager,
  /**
   * Required on purpose: a new entry point that forgets to label its URL is a
   * typecheck error, not a silent grant of internal trust.
   */
  origin: DeepLinkOrigin,
  sink?: EventSink,
  resolveClientId?: (webContentsId: number) => string | undefined,
  preferredClientId?: string,
): Promise<DeepLinkResult> {
  const target = parseDeepLink(url)

  if (!target) {
    // Return success for null targets (like auth-callback) - they're handled elsewhere
    if (url.includes('auth-callback')) {
      return { success: true }
    }
    return { success: false, error: 'Invalid deep link URL' }
  }

  mainLog.info('[DeepLink] Handling:', target, 'origin:', origin)

  // If windowMode is set, create a new window instead of navigating in existing
  if (target.windowMode) {
    mainLog.info('[DeepLink] windowMode detected:', target.windowMode)
    // Get workspaceId from target or from current window
    let wsId = target.workspaceId
    if (!wsId) {
      const focusedWindow = windowManager.getFocusedWindow()
      mainLog.info('[DeepLink] focusedWindow:', focusedWindow?.id)
      if (focusedWindow) {
        wsId = windowManager.getWorkspaceForWindow(focusedWindow.webContents.id) ?? undefined
        mainLog.info('[DeepLink] wsId from focused window:', wsId)
      }
      if (!wsId) {
        const allWindows = windowManager.getAllWindows()
        mainLog.info('[DeepLink] allWindows count:', allWindows.length)
        if (allWindows.length > 0) {
          wsId = allWindows[0].workspaceId
          mainLog.info('[DeepLink] wsId from first window:', wsId)
        }
      }
    }

    if (!wsId) {
      mainLog.error('[DeepLink] No workspace available for new window')
      return { success: false, error: 'No workspace available for new window' }
    }

    // Build URL without window param for navigation inside the new window
    const navUrl = buildDeepLinkWithoutWindowParam(url)
    mainLog.info('[DeepLink] Creating new window with navUrl:', navUrl)

    const window = windowManager.createWindow({
      workspaceId: wsId,
      focused: target.windowMode === 'focused',
      initialDeepLink: navUrl,
      // Passing through window creation must not launder the origin: an
      // external link carrying window=focused|full stays external.
      initialDeepLinkOrigin: origin,
    })
    mainLog.info('[DeepLink] Window created:', window.webContents.id)

    return { success: true, windowId: window.webContents.id }
  }

  // 1. Get target window (existing behavior for non-window-mode links)
  let window: BrowserWindow | null = null

  if (target.workspaceId) {
    // Workspace specified - focus or create window for that workspace
    window = windowManager.focusOrCreateWindow(target.workspaceId)
  } else {
    // No workspace - use focused window or last active
    window = windowManager.getFocusedWindow() ?? windowManager.getLastActiveWindow()

    if (!window) {
      // No windows at all - can't navigate without a workspace
      return { success: false, error: 'No active window to navigate' }
    }

    // Focus the window
    if (window.isMinimized()) {
      window.restore()
    }
    window.focus()
  }

  // 2. Wait for window to be ready (renderer loaded)
  await waitForWindowReady(window)

  // 3. Send navigation command to renderer
  if (target.view || target.action) {
    const navigation: DeepLinkNavigation = {
      view: target.view,
      action: target.action,
      actionParams: target.actionParams,
      origin,
    }
    const wsId = target.workspaceId ?? windowManager.getWorkspaceForWindow(window.webContents.id)
    const resolvedClientId = resolveClientId?.(window.webContents.id)

    // Prefer the resolved target window client. Only use preferredClientId as
    // fallback when no resolver was provided (legacy call sites).
    const clientId = resolvedClientId ?? (!resolveClientId ? preferredClientId : undefined)

    if (sink && clientId) {
      sink(RPC_CHANNELS.deeplink.NAVIGATE, { to: 'client', clientId }, navigation)
    } else if (sink && wsId) {
      sink(RPC_CHANNELS.deeplink.NAVIGATE, { to: 'workspace', workspaceId: wsId }, navigation)
    }
  }

  return { success: true, windowId: window.isDestroyed() ? -1 : window.webContents.id }
}

/**
 * UA12.146 — build the compound view route for a host, refusing what the
 * pages routes refuse.
 *
 * The `pages` host is the one host whose grammar is EXACT rather than
 * join-everything: `nessy://pages` (the library grid) and
 * `nessy://pages/page/{slug}` (one page) are the only two forms the renderer's
 * route parser accepts (`routes.view.pages`, route-parser.ts REFUSES a tail
 * after the slug instead of truncating it — "a route the parser silently
 * truncates is a link that looks like it worked"), and they are the two forms
 * the docs-site deeplinks page documents. This function refuses everything
 * else at the parse layer for the same reason, so the tail never travels as a
 * link the renderer will silently drop.
 *
 * Every other host keeps the previous behaviour verbatim (host + all path
 * segments, or the bare host).
 */
function compoundViewRoute(host: string, pathParts: string[]): string | null {
  if (host === 'pages') {
    if (pathParts.length === 0) return 'pages'
    if (pathParts.length === 2 && pathParts[0] === 'page' && pathParts[1]) {
      return `pages/page/${pathParts[1]}`
    }
    return null
  }
  return pathParts.length > 0 ? `${host}/${pathParts.join('/')}` : host
}

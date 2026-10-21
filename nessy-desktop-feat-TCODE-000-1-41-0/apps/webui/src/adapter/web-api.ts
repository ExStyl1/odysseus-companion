/**
 * Web API adapter — browser-compatible ElectronAPI implementation.
 *
 * Reuses the same WsRpcClient + buildClientApi() + CHANNEL_MAP from the Electron app.
 * Overrides LOCAL_ONLY methods (window management, native dialogs, etc.) with web equivalents.
 *
 * Auth: the browser's session cookie (set by /api/auth) is automatically sent
 * on the WebSocket upgrade request — no bearer token needed.
 */

import i18n from 'i18next'
import { toast } from 'sonner'
import { openExternalUrl } from '@nessy-agent/ui'
import { OAUTH_FAILURE_CODES } from '@nessy-agent/shared/protocol'
import { CLIENT_CONFIRM_DIALOG, type ConfirmDialogSpec } from '@nessy-agent/server-core/transport'
import { browserConfirmDialogResponse } from './confirm-dialog'
import { WsRpcClient } from '../../../electron/src/transport/client'
import { buildClientApi } from '../../../electron/src/transport/build-api'
import { CHANNEL_MAP } from '../../../electron/src/transport/channel-map'
import { wrapElectronApi } from '../../../electron/src/renderer/lib/rpc-error-rehydration'
import type { ElectronAPI, TransportConnectionState } from '../../../electron/src/shared/types'

// ---------------------------------------------------------------------------
// Web file picker (replaces native Electron dialog)
// ---------------------------------------------------------------------------

function webFilePicker(): Promise<string[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = () => {
      const files = input.files
      if (!files || files.length === 0) {
        resolve([])
        return
      }
      // Return file names — actual file reading is handled elsewhere
      resolve(Array.from(files).map(f => f.name))
    }
    // If user cancels the dialog
    input.oncancel = () => resolve([])
    input.click()
  })
}

// ---------------------------------------------------------------------------
// System theme detection
// ---------------------------------------------------------------------------

const darkMediaQuery = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null

function getSystemTheme(): boolean {
  return darkMediaQuery?.matches ?? false
}

// ---------------------------------------------------------------------------
// Create web API
// ---------------------------------------------------------------------------

export interface WebApiOptions {
  /** WebSocket server URL (ws:// or wss://) */
  serverUrl: string
  /** Workspace ID to connect as. */
  workspaceId?: string
}

export function createWebApi(options: WebApiOptions): {
  api: ElectronAPI
  client: WsRpcClient
} {
  const { serverUrl, workspaceId } = options

  const client = new WsRpcClient(serverUrl, {
    workspaceId,
    autoReconnect: true,
    mode: 'remote',
    // UA12.49 — the one client capability this surface answers: the server's
    // composed confirm dialogs (delete-confirmation with the task folder, and
    // its revoke-share failure notice) invoke CLIENT_CONFIRM_DIALOG on this
    // client; invokeClient refuses an unadvertised capability.
    clientCapabilities: [CLIENT_CONFIRM_DIALOG],
    // No token — auth is via session cookie sent on WebSocket upgrade
  })
  client.handleCapability(CLIENT_CONFIRM_DIALOG, (spec: ConfirmDialogSpec) => browserConfirmDialogResponse(spec))

  // Build the API proxy from the same channel map the Electron app uses…
  const rawApi = buildClientApi(
    client,
    CHANNEL_MAP,
    (ch) => client.isChannelAvailable(ch),
  )
  // …and then undo its envelope, exactly as the Electron renderer entry does.
  //
  // D1.282 — `buildClientApi` wraps every invoke in `asEnvelopeOnReject`, so a
  // FAILED call RESOLVES with `{ __nessyRpcError__: true, message }` instead of
  // rejecting. That is a contextBridge workaround (`rpc-error.ts` carries the
  // measurement: a rejected promise's Error loses `code`, `name` and its stack
  // crossing the bridge), and the other half of it lives in the renderer entry
  // — `lib/install-rpc-api.ts` publishes `window.electronAPI` as
  // `wrapElectronApi(raw)`. This adapter builds the same API and installed only
  // the first half, so every `try`/`catch` in the 271 awaited
  // `window.electronAPI.*` reads the renderer shares with this surface would
  // have taken a failure as a successful, envelope-shaped answer here: no
  // `catch` fires, no test fails, and a fail-soft reader renders an empty list
  // for an error.
  //
  // There is no contextBridge in a browser, so nothing forces the envelope on
  // this side — but the wrapper is what makes the two surfaces behave the same,
  // and `wrapElectronApi` walks `CHANNEL_MAP` rather than the object, which is
  // what reaches the 39 namespaced methods a walker would silently miss.
  const baseApi = wrapElectronApi(rawApi as unknown as Record<string, unknown>)

  // Override LOCAL_ONLY methods with web-compatible implementations
  const webOverrides: Partial<ElectronAPI> = {
    // Shell operations — use browser APIs
    openUrl: (url: string) => {
      const result = openExternalUrl(url)
      if (!result.opened) {
        if (result.reason === 'dangerous') {
          toast.error(`Blocked unsafe URL (${result.detail})`)
        } else if (result.reason === 'internal-deeplink') {
          console.warn('[openUrl] nessy:// deep links require the desktop app')
        } else {
          console.warn('[openUrl] Malformed URL:', url)
        }
      }
      return Promise.resolve()
    },
    openFile: () => Promise.resolve(), // no-op in browser
    showInFolder: () => Promise.resolve(), // no-op in browser

    // File dialogs
    openFileDialog: webFilePicker,
    openFolderDialog: () => Promise.resolve(null), // not possible in browser

    // System info
    getVersions: () => ({ node: 'n/a', chrome: navigator.userAgent, electron: 'web' }),
    getRuntimeEnvironment: () => 'web',
    getSystemWarnings: () => Promise.resolve({ vcredistMissing: false }),
    getWindowVibrancy: () => null, // browsers paint an opaque canvas
    isDebugMode: () => Promise.resolve(import.meta.env.DEV),

    // Theme
    getSystemTheme: () => Promise.resolve(getSystemTheme()),
    onSystemThemeChange: (cb: (isDark: boolean) => void) => {
      if (!darkMediaQuery) return () => {}
      const handler = (e: MediaQueryListEvent) => cb(e.matches)
      darkMediaQuery.addEventListener('change', handler)
      return () => darkMediaQuery.removeEventListener('change', handler)
    },

    // Window management — no-ops or browser equivalents
    setTrafficLightsVisible: () => Promise.resolve(),
    closeWindow: () => Promise.resolve(),
    confirmCloseWindow: () => Promise.resolve(),
    cancelCloseWindow: () => Promise.resolve(),
    onCloseRequested: () => () => {},
    getWindowFocusState: () => Promise.resolve(document.hasFocus()),
    onWindowFocusChange: (cb: (focused: boolean) => void) => {
      const onFocus = () => cb(true)
      const onBlur = () => cb(false)
      window.addEventListener('focus', onFocus)
      window.addEventListener('blur', onBlur)
      return () => {
        window.removeEventListener('focus', onFocus)
        window.removeEventListener('blur', onBlur)
      }
    },

    // Workspace operations — web UI works with a single connection
    getWindowWorkspace: () => Promise.resolve(workspaceId ?? null),
    getWindowMode: () => Promise.resolve('main'),
    // switchWorkspace must call the server so it registers the client's
    // workspaceId — otherwise push events (session updates) won't arrive.
    switchWorkspace: async (wsId: string) => {
      await client.invoke('window:switchWorkspace', wsId)
    },
    openWorkspace: async () => {},
    openSessionInNewWindow: async (_wsId: string, sessionId: string) => {
      // Open in new tab
      window.open(`${window.location.origin}/?session=${sessionId}`, '_blank')
    },

    // Auto-update — not applicable to web (but expose server version for About page)
    checkForUpdates: () => Promise.resolve({ available: false, currentVersion: client.getServerVersion() ?? '' } as any),
    getUpdateInfo: () => Promise.resolve({ available: false, currentVersion: client.getServerVersion() ?? '' } as any),
    installUpdate: () => Promise.resolve(),
    dismissUpdate: () => Promise.resolve(),
    getDismissedUpdateVersion: () => Promise.resolve(null),
    onUpdateAvailable: () => () => {},
    onUpdateDownloadProgress: () => () => {},
    // Release notes — serve from server via RPC (same content as Electron)
    getReleaseNotes: () => client.invoke('releaseNotes:get') as Promise<string>,
    getLatestReleaseVersion: () => client.invoke('releaseNotes:getLatestVersion') as Promise<string | undefined>,

    // Menu events — register as keyboard shortcuts
    onMenuNewChat: () => () => {},
    onMenuOpenSettings: () => () => {},
    onMenuKeyboardShortcuts: () => () => {},
    onMenuToggleFocusMode: () => () => {},
    onMenuToggleSidebar: () => () => {},
    onDeepLinkNavigate: () => () => {},

    // Menu actions — no-ops (web has no native menu)
    menuQuit: () => Promise.resolve(),
    menuNewWindow: () => { window.open(window.location.href, '_blank'); return Promise.resolve() },
    menuMinimize: () => Promise.resolve(),
    menuMaximize: () => Promise.resolve(),
    menuZoomIn: () => Promise.resolve(),
    menuZoomOut: () => Promise.resolve(),
    menuZoomReset: () => Promise.resolve(),
    menuToggleDevTools: () => Promise.resolve(),
    menuUndo: () => { document.execCommand('undo'); return Promise.resolve() },
    menuRedo: () => { document.execCommand('redo'); return Promise.resolve() },
    menuCut: () => { document.execCommand('cut'); return Promise.resolve() },
    menuCopy: () => { document.execCommand('copy'); return Promise.resolve() },
    menuPaste: () => { document.execCommand('paste'); return Promise.resolve() },
    menuSelectAll: () => { document.execCommand('selectAll'); return Promise.resolve() },

    // Badge — use document title
    refreshBadge: () => Promise.resolve(),
    setDockIconWithBadge: () => Promise.resolve(),
    onBadgeDraw: () => () => {},
    onBadgeDrawWindows: () => () => {},

    // Notifications — Web Notifications API
    showNotification: async (title: string, body: string) => {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body })
      }
    },
    onNotificationNavigate: () => () => {},

    // Git bash (Windows-only) — not applicable
    checkGitBash: () => Promise.resolve({ available: true } as any),
    browseForGitBash: () => Promise.resolve(null),
    setGitBashPath: () => Promise.resolve({ success: true }),

    // P6.722 — `openSkillInEditor` / `openSkillInFinder` were REMOVED, not
    // renamed: `git grep -an openSkillIn -- apps packages` finds them nowhere
    // else in the tree, so these two stubs overrode nothing and only made this
    // literal fail `Partial<ElectronAPI>`'s excess-property check. Opening a
    // skill on the host is still not possible from a browser; there is simply
    // no longer a member to say so through.

    // Confirmation dialogs — use browser confirm()
    showLogoutConfirmation: () => Promise.resolve(window.confirm(i18n.t('dialog.logoutConfirmation'))),
    // UA12.49 — `showDeleteSessionConfirmation` has NO local override: the
    // CHANNEL_MAP member bound below passes (name, sessionId) to the server
    // handler, which composes the dialog (task folder the delete removes,
    // shared-link line) and asks THIS client to confirm it — the same flow the
    // Electron renderer runs. The removed local stub took `(name)` only, so a
    // webui confirm could never name the task folder; the browser answer to
    // the server's request is `browserConfirmDialogResponse` (confirm-dialog.ts).

    // Power settings — not applicable
    getKeepAwakeWhileRunning: () => Promise.resolve(false),
    setKeepAwakeWhileRunning: () => Promise.resolve(),

    // Transport state
    getTransportConnectionState: () => Promise.resolve(client.getConnectionState() as TransportConnectionState),
    onTransportConnectionStateChanged: (cb: (state: TransportConnectionState) => void) => {
      return client.onConnectionStateChanged(cb as any)
    },
    reconnectTransport: () => { client.reconnectNow(); return Promise.resolve() },
    isChannelAvailable: (ch: string) => client.isChannelAvailable(ch),

    // Relaunch — reload page
    relaunchApp: () => { window.location.reload(); return Promise.resolve() },
    // P6.501 — the shape is `WorkspaceDeleteResult` now; the web UI still
    // supports no removal, so it reports a purge that did not happen.
    removeWorkspace: () => Promise.resolve({ deleted: false, cleanupFailures: [] }),
    // P6.722 — `invokeOnServer` is gone from `ElectronAPI` DELIBERATELY: it is
    // one of the eight names `components/workspace/__tests__/creation-contract.test.tsx`
    // forbids the renderer to carry ("generic server tunnel"). A stub that
    // rejects it here re-declared the member the contract removed. The row said
    // two red members; there were THREE, because TypeScript's excess-property
    // check reports one per literal and this one only appeared once the first
    // was gone.
  }

  // OAuth overrides — web-compatible browser opening.
  // The Electron preload uses shell.openExternal() which isn't available in browsers.
  const oauthOverrides: Partial<ElectronAPI> = {
    performOAuth: async (args: {
      sourceSlug: string
      sessionId?: string
      authRequestId?: string
    }) => {
      void args
      // P6.722 — a CODE, not a sentence. `performOAuth`'s result carries
      // `error?: OAuthFailureCode | 'cancelled' | 'cancel-failed' |
      // 'settlement-failed'` and no message field at all, so the prose that
      // used to sit here did not reach a user under any renderer — it only
      // failed the typecheck. `start-failed` is the honest member of that
      // union: in a browser the flow cannot be started, which is exactly what
      // the code means. Both consumers (`connectPluginServer`,
      // `PendingAuthNotice`) read `success` and nothing else.
      return {
        success: false,
        error: OAUTH_FAILURE_CODES.START_FAILED,
      }
    },

    // Claude OAuth — server returns authUrl, we open it in a new tab.
    // Same iOS-safe pre-open pattern as `performOAuth` above.
    startClaudeOAuth: async () => {
      const popup = window.open('about:blank', '_blank')
      try {
        const result = await client.invoke('onboarding:startClaudeOAuth')
        if (result.success && result.authUrl) {
          if (popup && !popup.closed) {
            popup.location.href = result.authUrl
          } else {
            window.location.href = result.authUrl
          }
        } else if (popup && !popup.closed) {
          // No auth URL — close the placeholder we opened on the click.
          popup.close()
        }
        return result
      } catch (err) {
        if (popup && !popup.closed) popup.close()
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Claude OAuth failed',
        }
      }
    },

    // ChatGPT OAuth — requires localhost callback server, not possible in browser
    startChatGptOAuth: async () => {
      return {
        success: false,
        error: i18n.t('errors.chatGptOAuthNotAvailable'),
      }
    },
  }

  const api = { ...baseApi, ...webOverrides, ...oauthOverrides } as ElectronAPI

  return { api, client }
}

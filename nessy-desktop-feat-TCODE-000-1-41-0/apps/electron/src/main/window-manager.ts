import { BrowserWindow, shell, nativeTheme, Menu, app, dialog } from 'electron'
import { windowLog } from './logger'
import { join, resolve } from 'path'
import { existsSync } from 'fs'
import { release } from 'os'
import { fileURLToPath } from 'url'
import { getZoomFactor } from '@nessy-agent/shared/config'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'
import { classifyExternalUrl, formatBlockedUrlError } from '@nessy-agent/shared/utils/url-safety'
import { RPC_CHANNELS, type WindowCloseRequestSource } from '../shared/types'
import type { DeepLinkOrigin } from './deep-link'
import { rebuildDevRestoreUrl, type SavedWindow } from './window-state'
import { createBootDiagnosticWriter, formatRendererGoneLogLine } from './boot-fatal'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import {
  WINDOWS_BACKGROUND_MATERIAL_MIN_BUILD,
  windowsBackgroundMaterialForBuild,
  windowsBuildNumber,
  windowVibrancyArguments,
  windowVibrancyFor,
} from './window-material'

/**
 * D1.142 — the always-on sink, built once.
 *
 * `CONFIG_DIR` is frozen at import by `config/paths.ts`, so binding the writer
 * here answers the same directory `index.ts`'s own boot diagnostic writes to,
 * and a per-window writer would only re-do the join.
 */
const rendererDiagnostic = createBootDiagnosticWriter(CONFIG_DIR)

// Vite dev server URL for hot reload
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

/**
 * Mica behind the window on Windows 11 22H2+, else none (UB14.47, v0.15.0). Electron ignores
 * `backgroundMaterial` on older builds (Windows 10, Windows 11 21H2) but still makes the web
 * contents transparent, so asking for it there would leave the translucent canvas over nothing.
 * The gate itself is `windowsBackgroundMaterialForBuild` in `./window-material`.
 */
function getWindowsBackgroundMaterial(): 'mica' | undefined {
  if (process.platform !== 'win32') return undefined

  // os.release() returns "10.0.xxxxx" where xxxxx is the build number
  const buildNumber = windowsBuildNumber(release())
  const material = windowsBackgroundMaterialForBuild(buildNumber)

  if (material) {
    windowLog.info('Windows build ' + buildNumber + ': using Mica')
    return material
  }

  windowLog.info('Windows build ' + buildNumber + ': no background material (needs ' + WINDOWS_BACKGROUND_MATERIAL_MIN_BUILD + '+)')
  return undefined
}


interface ManagedWindow {
  window: BrowserWindow
  workspaceId: string
}

export interface CreateWindowOptions {
  /** The workspace to open (empty string for onboarding) */
  workspaceId: string
  /** Whether to open in focused mode (smaller window, no sidebars) */
  focused?: boolean
  /** Deep link URL to navigate to after window loads (without ?window= param) */
  initialDeepLink?: string
  /**
   * Trust label of `initialDeepLink`. Omitted is read as 'external' — window
   * creation must not launder an untrusted link into an internal dispatch.
   */
  initialDeepLinkOrigin?: DeepLinkOrigin
  /** Full URL to restore from saved state (preserves route/query params) */
  restoreUrl?: string
}

export class WindowManager {
  private windows: Map<number, ManagedWindow> = new Map()  // webContents.id → ManagedWindow
  private focusedModeWindows: Set<number> = new Set()  // webContents.id of windows in focused mode
  private pendingCloseTimeouts: Map<number, NodeJS.Timeout> = new Map()  // Fallback timeouts for window close
  private eventSink: ((channel: string, target: import('@nessy-agent/shared/protocol').PushTarget, ...args: any[]) => void) | null = null
  private workspaceService: WorkspaceService | null = null

  setWorkspaceService(workspaceService: WorkspaceService): void {
    this.workspaceService = workspaceService
    this.refreshWindowTitles()
  }
  private clientResolver: ((wcId: number) => string | undefined) | null = null
  private keyboardCloseIntents: Set<number> = new Set()  // webContents.id flagged by Cmd/Ctrl+W before close
  private keyboardCloseIntentTimeouts: Map<number, NodeJS.Timeout> = new Map()  // Auto-clear stale keyboard-close intents
  private isAppQuitting = false  // Skip layered close interception during app quit

  /**
   * Set the event sink and client resolver for pushing events via the RPC server
   * instead of webContents.send. Called after server creation.
   */
  setRpcEventSink(
    sink: (channel: string, target: import('@nessy-agent/shared/protocol').PushTarget, ...args: any[]) => void,
    resolver: (wcId: number) => string | undefined
  ): void {
    this.eventSink = sink
    this.clientResolver = resolver
  }

  /** Return current RPC event sink, if transport has been initialized. */
  getRpcEventSink(): ((channel: string, target: import('@nessy-agent/shared/protocol').PushTarget, ...args: any[]) => void) | null {
    return this.eventSink
  }

  /** Resolve a window's current clientId from transport handshake state. */
  getClientIdForWindow(webContentsId: number): string | undefined {
    return this.clientResolver?.(webContentsId)
  }

  /** Push an event to a specific window via the RPC event sink. Falls back to webContents.send. */
  private pushToWindow(window: BrowserWindow, channel: string, ...args: any[]): void {
    if (this.eventSink && this.clientResolver) {
      const clientId = this.clientResolver(window.webContents.id)
      if (clientId) {
        this.eventSink(channel, { to: 'client', clientId }, ...args)
        return
      }
    }
    // Fallback: direct webContents.send (used before WS handshake completes)
    if (!window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.mainFrame) {
      window.webContents.send(channel, ...args)
    }
  }

  /**
   * Is this URL the app shell itself — the ONE page a renderer window may
   * navigate to?
   *
   * ## What the second disjunct used to admit (P6.667)
   *
   * It ended `filePath === join(rendererRoot, 'index.html') ||
   * filePath.startsWith(rendererRoot + sep)`, and the second half admitted every
   * file under `dist/renderer/`. One of them is `playground.html`, the design
   * surface — and it SHIPS: driven through `app-builder-lib`'s own
   * `FileMatcher.createFilter()` against the real `electron-builder.yml` `files`
   * arrays (W8-x, 2026-09-07), `dist/renderer/playground.html` and its bundle
   * are copied, with `asar: false`, so they are plain files inside
   * `Nessy Desktop.app/Contents/Resources/app/`. Five negative controls were
   * skipped in the same run, two of them under the same `dist/**` subtree, so
   * the matcher was reading the real rules rather than defaulting to true.
   *
   * Latent, not live: no route in the packaged app produces such a navigation
   * today. Markdown anchors `preventDefault()` and `defaultUrlTransform` strips
   * `file:`; `setWindowOpenHandler` denies everything and hands the URL to
   * `classifyExternalUrl`, which classifies `file:` as dangerous; the prod
   * `restoreUrl` branch deliberately never replays a saved `file://` URL. But
   * "nothing reaches it" is a property of four other components, and this is the
   * one place that can say no by itself.
   *
   * ## Native mechanism (owner rule 2026-08-28)
   *
   * Electron's own `will-navigate` and `setWindowOpenHandler`, both already
   * wired here. So this is option (1): narrow the guard the platform gives us,
   * add no layer beside it.
   *
   * ## Why `index.html` and nothing else is the correct floor
   *
   * It is the only page this class ever loads: all four `loadFile` calls below
   * name `renderer/index.html`. The two other pages the main process loads —
   * `browser-toolbar.html` and `browser-empty-state.html` — belong to
   * `browser-pane-manager.ts`'s `WebContentsView`s, are loaded by the main
   * process directly, and are never a navigation TARGET from a renderer window.
   * `fileURLToPath` drops the query and the fragment, so the `?workspaceId=…`
   * every real load carries still compares equal.
   *
   * ## Residue, stated rather than implied
   *
   * The DEV arm above is unchanged and still admits any path on the Vite origin,
   * so `http://localhost:5173/playground.html` still loads in a dev window —
   * which is how the page has actually been reached. That half is closed from
   * the other end by P6.668: the playground refuses to mount when a bridge it
   * did not install is present. Narrowing the dev arm here instead would break
   * the dev server's own navigations for no gain in a shipped build.
   */
  private isRendererAppUrl(url: string): boolean {
    if (VITE_DEV_SERVER_URL) {
      try {
        const parsed = new URL(url)
        const devServer = new URL(VITE_DEV_SERVER_URL)
        if (parsed.origin === devServer.origin) return true
      } catch {
        // Fall through to file:// handling below.
      }
    }

    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'file:') return false

      const filePath = resolve(fileURLToPath(parsed))
      const rendererRoot = resolve(join(__dirname, 'renderer'))
      return filePath === join(rendererRoot, 'index.html')
    } catch {
      return false
    }
  }

  private openExternalFromRenderer(url: string, context: string, sourceWindow?: BrowserWindow): void {
    const classification = classifyExternalUrl(url)

    if (classification.kind === 'dangerous') {
      windowLog.warn(`[url-safety] Blocked ${context}: ${formatBlockedUrlError(classification)} url=${url}`)
      return
    }

    if (classification.kind === 'internal-deeplink') {
      if (!sourceWindow) {
        windowLog.warn(`[url-safety] Blocked ${context}: internal deep link has no target window url=${url}`)
        return
      }

      void import('./deep-link').then(async ({ handleDeepLink }) => {
        const result = await handleDeepLink(
          url,
          this,
          // The URL came from renderer content (window-open / will-navigate),
          // which can be model output or a page we do not control.
          'external',
          this.eventSink ?? undefined,
          this.clientResolver ?? undefined,
          this.clientResolver?.(sourceWindow.webContents.id),
        )
        if (!result.success) {
          windowLog.warn(`[url-safety] Blocked ${context}: unsupported internal deep link url=${url} error=${result.error ?? 'unknown'}`)
        }
      }).catch((error) => {
        windowLog.warn(`[url-safety] Failed to route internal deep link from ${context}: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }

    void shell.openExternal(url).catch((error) => {
      windowLog.warn(`[url-safety] Failed to open external URL from ${context}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * Apply the window-title policy across all managed windows:
   *   1 window  → app name ("Nessy Desktop") on the lone window
   *   ≥2 windows → workspace name on each window, app-name fallback when the
   *                workspace can't be resolved (e.g. onboarding window).
   *
   * Called after createWindow() registers a new window and after the closed
   * handler removes one, so titles always reflect the current window count.
   * Renderer-driven page-title-updated events are suppressed in createWindow
   * so these setTitle() calls aren't clobbered by the static <title> tag.
   */
  private refreshWindowTitles(): void {
    const defaultTitle = app.getName()
    const showWorkspaceName = this.windows.size > 1
    for (const { window, workspaceId } of this.windows.values()) {
      if (window.isDestroyed()) continue
      let title = defaultTitle
      if (showWorkspaceName && workspaceId) {
        try {
          const workspace = this.workspaceService?.resolve(workspaceId)
          if (workspace?.config.name) title = workspace.config.name
        } catch (err) {
          windowLog.warn('refreshWindowTitles: workspace lookup failed', { workspaceId, err })
        }
      }
      window.setTitle(title)
    }
  }

  /**
   * Create a new window for a workspace
   * @param options - Window creation options
   */
  createWindow(options: CreateWindowOptions): BrowserWindow {
    const { workspaceId, focused = false, initialDeepLink, initialDeepLinkOrigin, restoreUrl } = options

    // Load platform-specific app icon
    // In packaged app, resources are at dist/resources/ (same level as __dirname)
    // In dev, resources are at ../resources/ (sibling of dist/)
    const getIconPath = () => {
      const iconName = process.platform === 'darwin' ? 'icon.icns'
        : process.platform === 'win32' ? 'icon.ico'
        : 'icon.png'
      return [
        join(__dirname, 'resources', iconName),
        join(__dirname, '../resources', iconName),
      ].find(p => existsSync(p)) ?? join(__dirname, '../resources', iconName)
    }

    const iconPath = getIconPath()
    const iconExists = existsSync(iconPath)

    if (!iconExists) {
      windowLog.warn('App icon not found at:', iconPath)
    }

    // Use smaller window size for focused mode (single session view)
    const windowWidth = focused ? 900 : 1400
    const windowHeight = focused ? 700 : 900

    // Platform-specific window options
    const isMac = process.platform === 'darwin'
    const isWindows = process.platform === 'win32'
    const windowsBackgroundMaterial = getWindowsBackgroundMaterial()
    const windowVibrancy = windowVibrancyFor(process.platform, windowsBackgroundMaterial)

    const window = new BrowserWindow({
      width: windowWidth,
      height: windowHeight,
      minWidth: 800,
      minHeight: 600,
      show: false, // Don't show until ready-to-show event (faster perceived startup)
      title: '',
      icon: iconExists ? iconPath : undefined,
      // macOS-specific: hidden title bar with inset traffic lights
      ...(isMac && {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 18, y: 16 },
        vibrancy: 'under-window',
        visualEffectState: 'active',
      }),
      // Windows: native frame, Mica on Windows 11 22H2+
      ...(isWindows && {
        frame: true, // Keep native frame for better UX
        autoHideMenuBar: true, // Menu is null on Windows, this is just for safety
        // Note: Don't use transparent:true with backgroundMaterial - it hides the window frame
        ...(windowsBackgroundMaterial && {
          backgroundMaterial: windowsBackgroundMaterial,
        }),
      }),
      // Linux: use native frame
      ...(!isMac && !isWindows && {
        frame: true,
        autoHideMenuBar: true,
      }),
      webPreferences: {
        preload: join(__dirname, 'bootstrap-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: false, // Browser integration uses WebContentsView, not <webview>
        // Tell the renderer which native material sits behind the window (ThemeContext data-vibrancy)
        additionalArguments: windowVibrancyArguments(windowVibrancy),
      }
    })

    // Show window when first paint is ready (faster perceived startup)
    window.once('ready-to-show', () => {
      window.show()
    })

    // Open external links in default browser, but never hand known-dangerous
    // schemes directly to shell.openExternal. Markdown normal-clicks go through
    // OPEN_URL; middle-clicks/window.open/top-navigation land here.
    window.webContents.setWindowOpenHandler((details) => {
      this.openExternalFromRenderer(details.url, 'window-open', window)
      return { action: 'deny' }
    })

    // Handle external navigation attempts from renderer WebContents
    window.webContents.on('will-navigate', (event, url) => {
      // Allow only the actual app shell (file:// in prod, Vite dev server in dev).
      // Any other navigation is treated as an external URL and goes through the
      // same URL-safety classifier used by OPEN_URL.
      if (this.isRendererAppUrl(url)) return

      event.preventDefault()
      this.openExternalFromRenderer(url, 'will-navigate', window)
    })
    installSubframeNavigationGuard(window.webContents, this.createDeniedFrameNavigationRoute(window))
    // Enable right-click context menu in development
    if (!app.isPackaged) {
      window.webContents.on('context-menu', (_event, params) => {
        Menu.buildFromTemplate([
          { label: 'Inspect Element', click: () => window.webContents.inspectElement(params.x, params.y) },
          { type: 'separator' },
          { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
          { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
          { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
        ]).popup()
      })
    }

    // The renderer's index.html ships with `<title>Nessy Desktop</title>`, so
    // without this Electron auto-syncs every window's title back to that on
    // load — clobbering the workspace-name policy applied below. Suppress the
    // default sync so setTitle() calls from refreshWindowTitles() stick.
    window.on('page-title-updated', (event) => {
      event.preventDefault()
    })

    // Store the window mapping BEFORE loadURL — bootstrap preload uses
    // __get-workspace-id (via sendSync) which reads this map during eval.
    const webContentsId = window.webContents.id
    this.windows.set(webContentsId, { window, workspaceId })

    // Apply window-title policy now that the map size reflects this window —
    // covers both the new window and any existing windows that should switch
    // from app name → workspace name as the count crosses 1 → 2.
    this.refreshWindowTitles()

    // Track focused mode state for persistence
    if (focused) {
      this.focusedModeWindows.add(webContentsId)
    }

    // Load the renderer - use restoreUrl if provided, otherwise build from options
    if (restoreUrl) {
      // Restore from saved URL - need to adapt for dev vs prod
      if (VITE_DEV_SERVER_URL) {
        // In dev mode, keep only the QUERY from the saved URL — mirroring the
        // prod branch below, which extracts query params and nothing else. The
        // saved pathname may belong to another life of this profile: after a
        // packaged run it is `/…/Resources/app/…/index.html`, Vite happily
        // answers 200 for it with a page that has no window.electronAPI, and
        // `did-fail-load` never fires. Replaying it here is what the contract
        // on `SavedWindow.url` (window-state.ts) always said we do not do.
        const rebuilt = rebuildDevRestoreUrl(restoreUrl, VITE_DEV_SERVER_URL)
        if (rebuilt) {
          window.loadURL(rebuilt)
        } else {
          // Fallback if URL parsing fails
          windowLog.warn('Failed to parse restoreUrl, using default:', restoreUrl)
          const params = new URLSearchParams({ workspaceId, ...(focused && { focused: 'true' }) }).toString()
          window.loadURL(`${VITE_DEV_SERVER_URL}?${params}`)
        }
      } else {
        // In prod, always extract query params and load from current __dirname.
        // Never load file:// URLs directly — the path may be stale (e.g. Linux AppImage
        // mounts to a different /tmp dir on each launch). See #13.
        try {
          const savedUrl = new URL(restoreUrl)
          const query: Record<string, string> = {}
          savedUrl.searchParams.forEach((value, key) => { query[key] = value })
          window.loadFile(join(__dirname, 'renderer/index.html'), { query })
        } catch {
          window.loadFile(join(__dirname, 'renderer/index.html'), { query: { workspaceId } })
        }
      }
    } else {
      // Build URL from options
      const query: Record<string, string> = { workspaceId }
      if (focused) {
        query.focused = 'true' // Open in focused mode (no sidebars)
      }

      if (VITE_DEV_SERVER_URL) {
        const params = new URLSearchParams(query).toString()
        window.loadURL(`${VITE_DEV_SERVER_URL}?${params}`)
      } else {
        window.loadFile(join(__dirname, 'renderer/index.html'), { query })
      }
    }

    // Fallback: if the renderer fails to load (e.g. stale path, disk error),
    // recover gracefully by loading the default state instead of showing a white screen. See #13.
    // In dev mode, retry the Vite dev server (it may not be ready yet) instead of falling back
    // to file:// which doesn't exist during development.
    // UA12.144: recovery is for MAIN-frame failures only. A subframe failure
    // (a CSP-blocked form POST / self-navigation inside a page iframe) must
    // leave the window alone — both arms below navigate the whole renderer.
    let failLoadRetries = 0
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      windowLog.warn('Failed to load renderer:', errorCode, errorDescription, isMainFrame ? '(main frame)' : '(subframe, contained)')
      const decision = decideLoadFailureRecovery({
        isMainFrame,
        devServerUrl: VITE_DEV_SERVER_URL,
        retriesSoFar: failLoadRetries,
      })
      if (decision.action === 'leave-alone') {
        windowLog.info('[UA12.144] Subframe load failure contained; renderer window left alone')
        return
      }
      if (decision.action === 'retry-dev-server') {
        failLoadRetries++
        windowLog.info(`Retrying Vite dev server (attempt ${failLoadRetries}/${LOAD_FAILURE_DEV_SERVER_RETRIES})...`)
        setTimeout(() => {
          const params = new URLSearchParams({ workspaceId }).toString()
          window.loadURL(`${VITE_DEV_SERVER_URL}?${params}`)
        }, 1000)
      } else {
        window.loadFile(join(__dirname, 'renderer/index.html'), { query: { workspaceId } })
      }
    })

    // D1.142 — a renderer that DIES reaches a log on a packaged build.
    //
    // `did-fail-load` above covers a renderer that could not load; this covers
    // the one that loaded and then went away, which until now left no trace
    // anywhere a user could read: `windowLog` is electron-log, whose transports
    // are disabled in packaged builds, so the whole evidence was a white window.
    // The sink is the same always-on `boot.log` writer the boot-fatal path uses,
    // for that exact reason, and the line carries `scope: "renderer"` so it is
    // not collected by a reader grepping this file for a failed launch.
    //
    // Chromium's own recovery is untouched: nothing here reloads, closes or
    // exits. A crashed renderer is reported and the window behaves exactly as it
    // did before.
    window.webContents.on('render-process-gone', (_event, details) => {
      windowLog.error('Renderer process gone:', details.reason, details.exitCode)
      rendererDiagnostic(formatRendererGoneLogLine({
        reason: details.reason,
        exitCode: details.exitCode,
        configDir: CONFIG_DIR,
      }))
    })

    // Re-apply the persisted global zoom factor on every load. Chromium tracks
    // zoom per-URL and resets it on reload/navigation, which drops the user's
    // chosen zoom on Cmd+Tab and restart (#780). did-finish-load fires on the
    // initial load and on every subsequent reload/recovery, keeping one global
    // zoom value applied across all windows.
    window.webContents.on('did-finish-load', () => {
      const zoom = getZoomFactor()
      if (zoom !== 1.0) window.webContents.setZoomFactor(zoom)
    })

    // If an initial deep link was provided, navigate to it after the window is ready
    if (initialDeepLink) {
      window.once('ready-to-show', () => {
        // Import parseDeepLink dynamically to avoid circular dependency
        import('./deep-link').then(({ parseDeepLink }) => {
          const target = parseDeepLink(initialDeepLink)
          if (target && (target.view || target.action)) {
            // Wait a bit for React to mount and register IPC listeners
            setTimeout(() => {
              this.pushToWindow(window, RPC_CHANNELS.deeplink.NAVIGATE, {
                view: target.view,
                action: target.action,
                actionParams: target.actionParams,
                // Fail safe: an unlabelled initial link is treated as external.
                origin: initialDeepLinkOrigin ?? 'external',
              })
            }, 100)
          }
        })
      })
    }

    // Listen for system theme changes and notify this window's renderer
    const themeHandler = () => {
      this.pushToWindow(window, RPC_CHANNELS.theme.SYSTEM_CHANGED, nativeTheme.shouldUseDarkColors)
    }
    nativeTheme.on('updated', themeHandler)

    // Handle focus/blur to broadcast window focus state
    window.on('focus', () => {
      this.pushToWindow(window, RPC_CHANNELS.window.FOCUS_STATE, true)
    })
    window.on('blur', () => {
      this.pushToWindow(window, RPC_CHANNELS.window.FOCUS_STATE, false)
    })

    // Detect Cmd/Ctrl+W before close events so renderer can distinguish close source.
    // Intent is short-lived to avoid stale classification.
    window.webContents.on('before-input-event', (_event, input) => {
      if (!input || input.type !== 'keyDown') return
      const key = input.key?.toLowerCase?.()
      if (key !== 'w') return

      const isCloseShortcut = process.platform === 'darwin'
        ? !!input.meta
        : !!input.control

      if (!isCloseShortcut) return

      const wcId = window.webContents.id
      this.keyboardCloseIntents.add(wcId)
      const existingTimeout = this.keyboardCloseIntentTimeouts.get(wcId)
      if (existingTimeout) clearTimeout(existingTimeout)

      this.keyboardCloseIntentTimeouts.set(wcId, setTimeout(() => {
        this.keyboardCloseIntentTimeouts.delete(wcId)
        this.keyboardCloseIntents.delete(wcId)
      }, 500))
    })

    // Handle window close request (traffic-light button, menu close, Cmd/Ctrl+W)
    // and send source metadata so renderer can decide layered dismiss vs direct close.
    window.on('close', (event) => {
      // During app quit, bypass layered close behavior and allow native close flow.
      // This preserves expected Cmd+Q semantics (quit app instead of closing overlays/panels first).
      if (this.isAppQuitting) {
        return
      }

      // Check if renderer is ready (mainFrame exists) - if not, allow close directly
      if (!window.webContents.isDestroyed() && window.webContents.mainFrame) {
        event.preventDefault()
        const wcId = window.webContents.id
        let source: WindowCloseRequestSource = 'window-button'
        if (this.keyboardCloseIntents.has(wcId)) {
          source = 'keyboard-shortcut'
          this.keyboardCloseIntents.delete(wcId)
          const keyboardIntentTimeout = this.keyboardCloseIntentTimeouts.get(wcId)
          if (keyboardIntentTimeout) {
            clearTimeout(keyboardIntentTimeout)
            this.keyboardCloseIntentTimeouts.delete(wcId)
          }
        }

        // Send close request to renderer - it will either close a modal/panel or confirm close.
        this.pushToWindow(window, RPC_CHANNELS.window.CLOSE_REQUESTED, { source })

        // Fallback timeout: if IPC fails (e.g., on Hyprland/Wayland), force close after 3s.
        // Reset timeout on each attempt so active users closing modals aren't interrupted.
        const existingTimeout = this.pendingCloseTimeouts.get(wcId)
        if (existingTimeout) clearTimeout(existingTimeout)

        this.pendingCloseTimeouts.set(wcId, setTimeout(() => {
          this.pendingCloseTimeouts.delete(wcId)
          if (!window.isDestroyed()) window.destroy()
        }, 3000))
      }
      // If renderer not ready, allow default close behavior
    })

    // Handle window closed - clean up theme listener and internal state
    window.on('closed', () => {
      // Clean up any pending close timeout to prevent memory leaks
      const timeout = this.pendingCloseTimeouts.get(webContentsId)
      if (timeout) {
        clearTimeout(timeout)
        this.pendingCloseTimeouts.delete(webContentsId)
      }

      // Clean up short-lived keyboard-close intent tracking.
      const keyboardIntentTimeout = this.keyboardCloseIntentTimeouts.get(webContentsId)
      if (keyboardIntentTimeout) {
        clearTimeout(keyboardIntentTimeout)
        this.keyboardCloseIntentTimeouts.delete(webContentsId)
      }
      this.keyboardCloseIntents.delete(webContentsId)

      nativeTheme.removeListener('updated', themeHandler)
      this.windows.delete(webContentsId)
      this.focusedModeWindows.delete(webContentsId)
      // Re-apply window-title policy — surviving windows revert from workspace
      // name back to app name when the count drops from 2 → 1.
      this.refreshWindowTitles()
      windowLog.info(`Window closed for workspace ${workspaceId}`)
    })

    windowLog.info(`Created window for workspace ${workspaceId} (focused: ${focused})`)
    return window
  }

  /**
   * Get window by webContents.id (used by IPC handlers instead of BrowserWindow.fromId)
   */
  getWindowByWebContentsId(wcId: number): BrowserWindow | null {
    const managed = this.windows.get(wcId)
    return managed?.window ?? null
  }

  /**
   * Get window by workspace ID (returns first match - for backwards compatibility)
   */
  getWindowByWorkspace(workspaceId: string): BrowserWindow | null {
    for (const managed of this.windows.values()) {
      if (managed.workspaceId === workspaceId && !managed.window.isDestroyed()) {
        return managed.window
      }
    }
    return null
  }

  /**
   * Get ALL windows for a workspace (main window + tab content windows)
   * Used for broadcasting events to all windows showing the same workspace
   */
  getAllWindowsForWorkspace(workspaceId: string): BrowserWindow[] {
    const windows: BrowserWindow[] = []
    for (const managed of this.windows.values()) {
      if (managed.workspaceId === workspaceId && !managed.window.isDestroyed()) {
        windows.push(managed.window)
      }
    }
    // Debug: log registered workspaces when lookup fails
    if (windows.length === 0 && this.windows.size > 0) {
      const registered = Array.from(this.windows.values()).map(m => m.workspaceId)
      windowLog.warn(`No windows for workspace '${workspaceId}', have: [${registered.join(', ')}]`)
    }
    return windows
  }

  /**
   * Get workspace ID for a window (by webContents.id)
   */
  getWorkspaceForWindow(webContentsId: number): string | null {
    const managed = this.windows.get(webContentsId)
    return managed?.workspaceId ?? null
  }

  /**
   * Mark whether the app is in quit flow.
   * When true, window close events bypass layered close interception.
   */
  setAppQuitting(isQuitting: boolean): void {
    this.isAppQuitting = isQuitting
  }

  /**
   * Close window by webContents.id (triggers close event which may be intercepted)
   */
  closeWindow(webContentsId: number): void {
    const managed = this.windows.get(webContentsId)
    if (managed && !managed.window.isDestroyed()) {
      managed.window.close()
    }
  }

  /**
   * Force close window by webContents.id (bypasses close event interception).
   * Used when renderer confirms the close action (no modals to close).
   */
  forceCloseWindow(webContentsId: number): void {
    // Clear any pending close timeout since renderer confirmed
    const timeout = this.pendingCloseTimeouts.get(webContentsId)
    if (timeout) {
      clearTimeout(timeout)
      this.pendingCloseTimeouts.delete(webContentsId)
    }

    const managed = this.windows.get(webContentsId)
    if (managed && !managed.window.isDestroyed()) {
      // Remove close listener temporarily to avoid infinite loop,
      // then destroy the window directly
      managed.window.destroy()
    }
  }

  /**
   * Cancel a pending close request (renderer handled it by closing a modal/panel).
   * Clears the fallback timeout so the window stays open.
   */
  cancelPendingClose(webContentsId: number): void {
    const timeout = this.pendingCloseTimeouts.get(webContentsId)
    if (timeout) {
      clearTimeout(timeout)
      this.pendingCloseTimeouts.delete(webContentsId)
    }
  }

  /**
   * Close window for a specific workspace
   */
  closeWindowForWorkspace(workspaceId: string): void {
    const window = this.getWindowByWorkspace(workspaceId)
    if (window && !window.isDestroyed()) {
      window.close()
    }
  }

  /**
   * Update the workspace ID for an existing window (for in-window switching)
   * @param webContentsId - The webContents.id of the window
   * @param workspaceId - The new workspace ID
   * @returns true if window was found and updated, false otherwise
   */
  updateWindowWorkspace(webContentsId: number, workspaceId: string): boolean {
    const managed = this.windows.get(webContentsId)
    if (managed) {
      const oldWorkspaceId = managed.workspaceId
      managed.workspaceId = workspaceId
      // Re-apply window-title policy so in-window workspace switches update
      // the titlebar immediately (relevant when ≥2 windows are open).
      this.refreshWindowTitles()
      windowLog.info(`Updated window ${webContentsId} from workspace ${oldWorkspaceId} to ${workspaceId}`)
      return true
    }
    // Window not found - log for debugging
    windowLog.warn(`Cannot update workspace for unknown window ${webContentsId}, registered: [${Array.from(this.windows.keys()).join(', ')}]`)
    return false
  }

  /**
   * Register an existing window with a workspace ID
   * Used for re-registration when window mapping is lost (e.g., after refresh)
   * @param window - The BrowserWindow to register
   * @param workspaceId - The workspace ID to associate with
   */
  registerWindow(window: BrowserWindow, workspaceId: string): void {
    const webContentsId = window.webContents.id
    this.windows.set(webContentsId, { window, workspaceId })
    // Re-apply window-title policy after re-registration (e.g. post-refresh).
    this.refreshWindowTitles()
    windowLog.info(`Registered window ${webContentsId} for workspace ${workspaceId}`)
  }

  /**
   * Get all managed windows
   */
  getAllWindows(): ManagedWindow[] {
    return Array.from(this.windows.values()).filter(m => !m.window.isDestroyed())
  }

  /**
   * Focus existing window for workspace or create new one
   */
  focusOrCreateWindow(workspaceId: string): BrowserWindow {
    const existing = this.getWindowByWorkspace(workspaceId)
    if (existing) {
      if (existing.isMinimized()) {
        existing.restore()
      }
      existing.focus()
      return existing
    }
    return this.createWindow({ workspaceId })
  }

  /**
   * Get window states for persistence (includes bounds and focused mode)
   * Used by window-state.ts to save/restore windows
   */
  getWindowStates(): SavedWindow[] {
    return this.getAllWindows().map(managed => {
      const webContentsId = managed.window.webContents.id
      const isFocused = this.focusedModeWindows.has(webContentsId)
      const url = managed.window.webContents.getURL()
      return {
        type: 'main' as const,
        workspaceId: managed.workspaceId,
        bounds: managed.window.getBounds(),
        ...(isFocused && { focused: true }),
        ...(url && { url }),
      }
    })
  }

  /**
   * Check if any windows are open
   */
  hasWindows(): boolean {
    return this.getAllWindows().length > 0
  }

  /**
   * Get the currently focused window
   */
  getFocusedWindow(): BrowserWindow | null {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && !focused.isDestroyed()) {
      return focused
    }
    return null
  }

  /**
   * Get the last active window (most recently used)
   * Falls back to any available window if none focused
   */
  getLastActiveWindow(): BrowserWindow | null {
    // First try focused window
    const focused = this.getFocusedWindow()
    if (focused) {
      return focused
    }

    // Fall back to any available window
    const allWindows = this.getAllWindows()
    if (allWindows.length > 0) {
      return allWindows[0].window
    }

    return null
  }

  /**
   * Show or hide macOS traffic light buttons (close/minimize/maximize).
   * Used to hide them when fullscreen overlays are open to prevent accidental clicks.
   * No-op on non-macOS platforms.
   */
  setTrafficLightsVisible(webContentsId: number, visible: boolean): void {
    if (process.platform !== 'darwin') return

    const managed = this.windows.get(webContentsId)
    if (managed && !managed.window.isDestroyed()) {
      managed.window.setWindowButtonVisibility(visible)
      // Re-apply custom traffic light position after showing buttons
      // setWindowButtonVisibility can reset position to default, so we need
      // to restore the custom position using the modern setWindowButtonPosition API
      if (visible) {
        managed.window.setWindowButtonPosition({ x: 18, y: 19 })
      }
    }
  }

  /**
   * UA12.31 + UA12.170 — where this window's UA7.2 denials go. An http(s)
   * link-out (a preview's `<a target="_self">`, or anything a frame's own script
   * did — its name proves nothing) opens only after the user confirms the FULL
   * URL in a native dialog, and then through the same classified route a
   * top-frame link takes; a Page frame's self-navigation and every non-http(s)
   * scheme stay cancelled, logged by origin alone
   * ({@link createDeniedFrameNavigationRouter}).
   */
  private createDeniedFrameNavigationRoute(window: BrowserWindow): (denied: DeniedFrameNavigation) => void {
    return createDeniedFrameNavigationRouter({
      confirm: async (url) => {
        if (window.isDestroyed()) return false
        const { response } = await dialog.showMessageBox(window, frameLinkOutConfirmOptions(url, i18n.t.bind(i18n)))
        return response === FRAME_LINK_OUT_OPEN_BUTTON
      },
      open: (url) => this.openExternalFromRenderer(url, 'will-frame-navigate', window),
      log: (line) => windowLog.warn(line),
    })
  }
}

// UA7.2 — appended below the highest line the docs cite (399), so no anchor moves; import declarations are hoisted.
import {
  createDeniedFrameNavigationRouter,
  FRAME_LINK_OUT_OPEN_BUTTON,
  frameLinkOutConfirmOptions,
  installSubframeNavigationGuard,
  type DeniedFrameNavigation,
} from './frame-navigation-guard'
// UA12.170 — the link-out confirmation reuses UA7.3's strings; appended for the same reason.
import { i18n } from '@nessy-agent/shared/i18n'
// UA12.144 — same appended-import pattern, same reason.
import { decideLoadFailureRecovery, LOAD_FAILURE_DEV_SERVER_RETRIES } from './load-failure-recovery'

/**
 * Page thumbnail capture (Electron main).
 *
 * Renders a page in an offscreen, opaque-sandboxed window exactly like
 * PageFrame (see page-thumbnail-host.ts), captures a poster with
 * `webContents.capturePage`, and writes pages/{slug}/thumbnail.jpg + stamps
 * `PageConfig.thumbnail` via `recordPageThumbnail`. Captures run one-at-a-time
 * through a queue that coalesces duplicate slugs; every failure is swallowed
 * (the page just stays posterless and the grid falls back to the placeholder).
 *
 * This is the only capture surface in the stack — it exists in Electron main
 * only. Headless/WebUI hosts never construct it; SessionManager's
 * `enqueuePageThumbnail` becomes a no-op there and tiles fall back.
 *
 * UA7.4 — copied from craft-agents-oss `v0.13.4:apps/electron/src/main/page-thumbnailer.ts` (Apache-2.0),
 * rebranded (`@craft-agent` → `@nessy-agent`) and hardened (spec
 * `docs/superpowers/specs/2026-09-23-upstream-0-13-4-board-planning-pages-design.md` §14 "Thumbnailer", threat S4).
 * Upstream's window had no partition, no window-open handler and no navigation handler; ours:
 * - runs in the in-memory partition {@link PAGE_THUMBNAIL_PARTITION}, whose request filter cancels everything
 *   except `data:`, `blob:` and `about:` and whose permission handlers refuse every request and check;
 * - denies `window.open` (`setWindowOpenHandler`), every `will-navigate`, and every `will-frame-navigate` that
 *   is not the frame's own inline document;
 * - keeps upstream's capture timeout (15 s); on timeout the `finally` destroys the window.
 * Measured on Electron 39.8.10 (probes `work/ua-ak/probe-nav*.cjs`, 2026-10-02): a sandboxed page's
 * `location` assignment and meta refresh are refused three times over — by the host CSP's `frame-src 'none'`
 * (ERR_BLOCKED_BY_CSP), by this window's `will-frame-navigate` handler when that CSP is absent, and by the
 * partition (ERR_BLOCKED_BY_CLIENT) when the handler is absent too; `window.open` from the frame returns null
 * and no window is created.
 * - NESSY: Electron's `BrowserWindow` and `session.fromPartition` are injected ({@link ThumbnailElectron}; the main
 *   process passes the real ones), so the hardening is driven by tests without a mocked `electron` module.
 * - NESSY: the timeout timer is cleared when the capture wins the race (upstream left it pending).
 * - NESSY (UA12.80): each capture window is registered in `app-windows.ts` for its lifetime, so the main-process
 *   consumers that mean "the app's windows" (`appWindows`) never see it.
 * - NESSY (UA12.193): when the LAST app window closes on a host that quits then (Windows, Linux), the in-flight
 *   capture window is destroyed at once and the queue dropped ({@link abortCaptureWhenLastAppWindowCloses}):
 *   Electron's `window-all-closed` counts the capture window, so the quit used to wait for its timeout.
 */

import type { BrowserWindow, BrowserWindowConstructorOptions, Session, WebContents } from 'electron'
import { renameSync, writeFileSync } from 'node:fs'
import {
  computePageContentDigest,
  getPageThumbnailPath,
  loadPageConfig,
  loadPageContent,
  readPageDataSnapshot,
  recordPageThumbnail,
} from '@nessy-agent/shared/pages'
import {
  THUMB_JPEG_QUALITY,
  THUMB_LOGICAL_HEIGHT,
  THUMB_LOGICAL_WIDTH,
  THUMB_OUTPUT_HEIGHT,
  THUMB_OUTPUT_WIDTH,
  buildThumbnailHostHtml,
  isDeniedThumbnailNavigation,
  isThumbnailRequestAllowed,
} from './page-thumbnail-host'
// The partition NAME is the registry's (session-partitions.ts, the one place it is written
// down); the capture-window constants are the host's.
import { PAGE_THUMBNAIL_PARTITION } from './session-partitions'
import { appWindows, isThumbnailCaptureWindow, registerThumbnailCaptureWindow } from './app-windows'

export interface ThumbnailRequest {
  workspaceId: string
  workspaceRootPath: string
  slug: string
}

/** UA7.4 — the two Electron entry points the thumbnailer needs; the main process passes the real ones. */
export interface ThumbnailElectron {
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow
  fromPartition(partition: string): Session
}

export interface PageThumbnailerOptions {
  /** UA7.4 — `new BrowserWindow(...)` and `session.fromPartition(...)`. */
  electron: ThumbnailElectron
  /** Called after a poster is written + page.json stamped, so the host can broadcast pages:changed. */
  onCaptured?: (req: ThumbnailRequest) => void
  log?: (message: string) => void
  /** Test seam; production keeps upstream's values. */
  timings?: Partial<{ settleMs: number; retryDelayMs: number; captureTimeoutMs: number }>
}

/** How long to let the iframe load + paint + apply its snapshot before capturing. */
const RENDER_SETTLE_MS = 550
/** Capture retries when the first frame comes back empty (hidden-window paint race). */
const CAPTURE_RETRIES = 3
const CAPTURE_RETRY_DELAY_MS = 250
/** Hard ceiling on one capture so a hung page can't wedge the queue. */
const CAPTURE_TIMEOUT_MS = 15_000

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** UA7.4 — the capture window's session: no network, no disk, no permissions (see the module header). */
function hardenThumbnailSession(ses: Session): void {
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isThumbnailRequestAllowed(details.url) })
  })
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
}

/** UA7.4 — the capture window opens nothing and navigates nowhere (see the module header). */
function hardenThumbnailWindow(webContents: WebContents): void {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  webContents.on('will-frame-navigate', (details) => {
    if (isDeniedThumbnailNavigation(details)) details.preventDefault()
  })
}

export class PageThumbnailer {
  private readonly queue: ThumbnailRequest[] = []
  private readonly pending = new Set<string>()
  private running = false
  private sessionHardened = false
  /** UA12.193 — the capture in progress: its window and the rejection that ends it early ({@link abortAll}). */
  private inFlight: { win: BrowserWindow; abort: (error: Error) => void } | undefined
  private readonly settleMs: number
  private readonly retryDelayMs: number
  private readonly captureTimeoutMs: number

  constructor(private readonly options: PageThumbnailerOptions) {
    this.settleMs = options.timings?.settleMs ?? RENDER_SETTLE_MS
    this.retryDelayMs = options.timings?.retryDelayMs ?? CAPTURE_RETRY_DELAY_MS
    this.captureTimeoutMs = options.timings?.captureTimeoutMs ?? CAPTURE_TIMEOUT_MS
  }

  private key(req: ThumbnailRequest): string {
    return `${req.workspaceRootPath}::${req.slug}`
  }

  /** Queue a (re)capture. Coalesces duplicate slugs; the run reads latest from disk. */
  enqueue(req: ThumbnailRequest): void {
    const key = this.key(req)
    if (this.pending.has(key)) return
    this.pending.add(key)
    this.queue.push(req)
    void this.drain()
  }

  /** NESSY: true while a capture runs or waits (lets a caller or a test wait for the queue to drain). */
  isBusy(): boolean {
    return this.running || this.queue.length > 0
  }

  /**
   * UA12.193 — drop every queued capture and end the one in progress NOW: its window is destroyed synchronously
   * (so Electron, which counts it, can emit `window-all-closed`) and the capture fails with `reason`, leaving the
   * page posterless exactly as a timeout does. A later {@link enqueue} works as before.
   */
  abortAll(reason: string): void {
    this.queue.length = 0
    this.pending.clear()
    const current = this.inFlight
    if (!current) return
    if (!current.win.isDestroyed()) current.win.destroy()
    current.abort(new Error(`capture aborted: ${reason}`))
  }

  /** UA12.193 — true for the window of the capture in progress. */
  isInFlightCaptureWindow(id: number): boolean {
    return this.inFlight?.win.id === id
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0) {
        const req = this.queue.shift()!
        this.pending.delete(this.key(req))
        try {
          await this.capture(req)
        } catch (error) {
          this.options.log?.(
            `[page-thumbnailer] capture failed for ${req.slug}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    } finally {
      this.running = false
    }
  }

  private async capture(req: ThumbnailRequest): Promise<void> {
    const { workspaceRootPath, slug } = req
    const config = loadPageConfig(workspaceRootPath, slug)
    if (!config) return // page deleted between enqueue and run

    const content = loadPageContent(workspaceRootPath, slug)
    if (content === null || content.trim() === '') return // nothing to render

    const digest = config.contentDigest ?? computePageContentDigest(content)
    // Already have a fresh poster (e.g. duplicate enqueue) — skip the work.
    if (config.thumbnail?.digest === digest) return

    const snapshot = readPageDataSnapshot(workspaceRootPath, slug)
    const html = buildThumbnailHostHtml({ content, slug, kind: config.kind, snapshot })

    if (!this.sessionHardened) {
      hardenThumbnailSession(this.options.electron.fromPartition(PAGE_THUMBNAIL_PARTITION))
      this.sessionHardened = true
    }

    const win = this.options.electron.createWindow({
      show: false,
      width: THUMB_LOGICAL_WIDTH,
      height: THUMB_LOGICAL_HEIGHT,
      useContentSize: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // UA7.4 — the in-memory, network-cancelling session (no preload is ever set).
        partition: PAGE_THUMBNAIL_PARTITION,
        // Keep the render deterministic regardless of the user's display.
        zoomFactor: 1,
      },
    })
    const releaseCaptureWindow = registerThumbnailCaptureWindow(win) // UA12.80
    let abort: (error: Error) => void = () => {}
    const aborted = new Promise<never>((_, reject) => { abort = reject }) // UA12.193
    this.inFlight = { win, abort }

    try {
      hardenThumbnailWindow(win.webContents)
      const buffer = await this.withTimeout(Promise.race([this.renderAndCapture(win, html), aborted]), this.captureTimeoutMs)
      if (!buffer) {
        this.options.log?.(`[page-thumbnailer] empty capture for ${slug}; leaving posterless`)
        return
      }

      const target = getPageThumbnailPath(workspaceRootPath, slug)
      const tmp = `${target}.tmp`
      writeFileSync(tmp, buffer)
      renameSync(tmp, target)

      // Re-check the page still exists (could be deleted mid-capture) before stamping.
      if (!loadPageConfig(workspaceRootPath, slug)) return
      recordPageThumbnail(workspaceRootPath, slug, {
        digest,
        capturedAt: Date.now(),
        width: THUMB_OUTPUT_WIDTH,
        height: THUMB_OUTPUT_HEIGHT,
      })
      this.options.onCaptured?.(req)
      this.options.log?.(`[page-thumbnailer] captured poster for ${slug}`)
    } finally {
      if (this.inFlight?.win === win) this.inFlight = undefined
      if (!win.isDestroyed()) win.destroy()
      releaseCaptureWindow()
    }
  }

  private async renderAndCapture(win: BrowserWindow, html: string): Promise<Buffer | null> {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    // did-finish-load (awaited above) only covers the host doc; give the
    // sandboxed iframe + its scripts + the snapshot render time to settle.
    await delay(this.settleMs)

    for (let attempt = 0; attempt < CAPTURE_RETRIES; attempt++) {
      if (win.isDestroyed()) return null
      const image = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      if (!image.isEmpty()) {
        const resized = image.resize({
          width: THUMB_OUTPUT_WIDTH,
          height: THUMB_OUTPUT_HEIGHT,
          quality: 'best',
        })
        const jpeg = resized.toJPEG(THUMB_JPEG_QUALITY)
        if (jpeg && jpeg.length > 0) return jpeg
      }
      await delay(this.retryDelayMs)
    }
    return null
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    // Keep the losing branch handled: on timeout the caller's finally destroys
    // the window while renderAndCapture's loadURL is still pending, and that
    // later rejection (ERR_ABORTED) would surface as an unhandled rejection.
    promise.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`capture timed out after ${ms}ms`)), ms)
      }),
    ]).finally(() => clearTimeout(timer))
  }
}

/** UA12.193 — the window lifecycle {@link abortCaptureWhenLastAppWindowCloses} reads; `index.ts` passes Electron's. */
export interface AppWindowLifecycle<W extends { id: number; isDestroyed(): boolean; once(event: 'closed', listener: () => void): unknown }> {
  /** `app.on('browser-window-created', …)`: every window created from now on, capture windows included. */
  onWindowCreated(listener: (win: W) => void): void
  /** The windows that exist now: `appWindows(BrowserWindow.getAllWindows())` (filtered again here either way). */
  allWindows(): readonly W[]
}

/**
 * UA12.193 — abort the in-flight capture ({@link PageThumbnailer.abortAll}) when the LAST app window closes on a
 * host that quits then (`quitsOnLastWindow`: `index.ts`'s `window-all-closed` handler quits off macOS and not
 * headless). Electron's `window-all-closed` counts every `BrowserWindow`, the hidden capture window included
 * (UA12.80's residue), so on a hung page the quit waited for the 15 s capture timeout; destroying the capture
 * window lets Electron emit it at once. Closing one of several app windows aborts nothing, and neither does a
 * capture window's own close. Every window that exists now and every later one is watched; `appWindows` decides
 * which are app windows, so the rule is the one UA12.80's consumers use.
 */
export function abortCaptureWhenLastAppWindowCloses<W extends { id: number; isDestroyed(): boolean; once(event: 'closed', listener: () => void): unknown }>(
  thumbnailer: PageThumbnailer,
  lifecycle: AppWindowLifecycle<W>,
  quitsOnLastWindow: boolean,
): void {
  if (!quitsOnLastWindow) return
  const watch = (win: W): void => {
    const id = win.id
    win.once('closed', () => {
      if (isThumbnailCaptureWindow({ id }) || thumbnailer.isInFlightCaptureWindow(id)) return
      const remaining = appWindows(lifecycle.allWindows()).filter(other => other.id !== id && !other.isDestroyed())
      if (remaining.length === 0) thumbnailer.abortAll('the last app window closed')
    })
  }
  for (const win of lifecycle.allWindows()) watch(win)
  lifecycle.onWindowCreated(watch)
}

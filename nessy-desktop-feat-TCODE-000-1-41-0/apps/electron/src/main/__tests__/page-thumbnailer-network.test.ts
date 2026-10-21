/**
 * UA7.4 — the thumbnail capture window is closed to the network, to new windows and to navigation, and a hung
 * capture is destroyed at the timeout (spec `docs/superpowers/specs/2026-09-23-upstream-0-13-4-board-planning-pages-design.md`
 * §14 "Thumbnailer", threat S4). Driven through {@link PageThumbnailer} over a real page on disk, with the Electron
 * window and session injected as recording fakes (the same injection the main process fills with `BrowserWindow`
 * and `session.fromPartition`), so what the window was asked to do is read back, never assumed.
 *
 * Positive: `data:` (and `blob:`, `about:`) requests pass the partition; a capture writes thumbnail.jpg and
 * stamps page.json with the content digest, then calls onCaptured.
 * Negative: `https:` and loopback requests are cancelled; permission requests are refused; the window has no
 * preload, is sandboxed and context-isolated in the in-memory partition, and its srcdoc frame is never
 * `allow-same-origin`; `window.open` from the page is denied (no window is created); a meta-refresh or `location`
 * assignment (a subframe navigation) and any main-frame navigation are prevented; a page whose render never
 * settles (an infinite loop) is destroyed at the capture timeout, leaves no window and no poster, and the queue
 * moves on.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron'
import { createPage, getPageThumbnailPath, loadPageConfig } from '@nessy-agent/shared/pages'
import { PAGE_THUMBNAIL_PARTITION } from '../page-thumbnail-host'
import { PageThumbnailer, type ThumbnailElectron } from '../page-thumbnailer'

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

function workspaceWithPage(tag: string, content = '<!doctype html><h1>Poster</h1><script>document.title = "x"</script>') {
  const root = mkdtempSync(join(tmpdir(), `ua7-4-thumb-${tag}-`))
  roots.push(root)
  const workspaceRootPath = join(root, 'ws')
  mkdirSync(workspaceRootPath, { recursive: true })
  const page = createPage(workspaceRootPath, { name: `Page ${tag}`, kind: 'interactive', content })
  return { workspaceRootPath, slug: page.slug, workspaceId: `ws-${tag}` }
}

type Listener = (event: { url: string; isMainFrame?: boolean; preventDefault(): void }) => void

/** A recording stand-in for one BrowserWindow. `hang` keeps loadURL pending forever (a render that never settles). */
function fakeWindow(options: BrowserWindowConstructorOptions, hang: boolean) {
  const listeners = new Map<string, Listener[]>()
  let openHandler: ((details: { url: string }) => { action: string }) | undefined
  let destroyed = false
  const loaded: string[] = []
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  const image = { isEmpty: () => false, resize: () => image, toJPEG: () => jpeg }
  const win = {
    options,
    loaded,
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true },
    loadURL: (url: string) => {
      loaded.push(url)
      return hang ? new Promise<void>(() => {}) : Promise.resolve()
    },
    webContents: {
      setWindowOpenHandler: (handler: (details: { url: string }) => { action: string }) => { openHandler = handler },
      on: (event: string, listener: Listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
        return win.webContents
      },
      capturePage: async () => image,
    },
    /** What the window did with a page-initiated navigation: true when it was prevented. */
    navigate(event: string, url: string, isMainFrame: boolean): boolean {
      let prevented = false
      for (const listener of listeners.get(event) ?? []) listener({ url, isMainFrame, preventDefault: () => { prevented = true } })
      return prevented
    },
    open(url: string) { return openHandler?.({ url }) },
    hasListener: (event: string) => (listeners.get(event)?.length ?? 0) > 0,
  }
  return win
}

function rig(opts: { hang?: boolean } = {}) {
  const windows: Array<ReturnType<typeof fakeWindow>> = []
  const requestListeners: Array<(details: { url: string }, callback: (response: { cancel: boolean }) => void) => void> = []
  let permissionRequest: ((wc: unknown, permission: string, callback: (granted: boolean) => void) => void) | undefined
  let permissionCheck: (() => boolean) | undefined
  const partitions: string[] = []
  const session = {
    webRequest: { onBeforeRequest: (listener: (typeof requestListeners)[number]) => { requestListeners.push(listener) } },
    setPermissionRequestHandler: (handler: typeof permissionRequest) => { permissionRequest = handler },
    setPermissionCheckHandler: (handler: typeof permissionCheck) => { permissionCheck = handler },
  }
  const electron: ThumbnailElectron = {
    createWindow: (options) => {
      const win = fakeWindow(options, opts.hang === true)
      windows.push(win)
      return win as unknown as BrowserWindow
    },
    fromPartition: (partition) => {
      partitions.push(partition)
      return session as unknown as Session
    },
  }
  const captured: string[] = []
  const logs: string[] = []
  const thumbnailer = new PageThumbnailer({
    electron,
    onCaptured: req => { captured.push(req.slug) },
    log: message => { logs.push(message) },
    timings: { settleMs: 0, retryDelayMs: 0, captureTimeoutMs: 60 },
  })
  /** The partition's verdict on a request: true when it is cancelled. */
  const cancelled = (url: string): boolean => {
    let verdict: boolean | undefined
    for (const listener of requestListeners) listener({ url }, response => { verdict = response.cancel })
    if (verdict === undefined) throw new Error('no request listener answered')
    return verdict
  }
  const permission = (name: string): boolean => {
    let granted: boolean | undefined
    permissionRequest?.(null, name, g => { granted = g })
    return granted === true
  }
  return { thumbnailer, windows, partitions, cancelled, permission, permissionCheck: () => permissionCheck?.() ?? true, captured, logs }
}

/** Wait until the queue has drained (the capture is fire-and-forget). */
async function drained(thumbnailer: PageThumbnailer, deadlineMs = 2000): Promise<void> {
  const start = Date.now()
  while (thumbnailer.isBusy()) {
    if (Date.now() - start > deadlineMs) throw new Error('thumbnailer did not drain')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('UA7.4 page thumbnailer — network, windows, navigation, timeout', () => {
  it('positive: a capture writes the poster and stamps page.json in the in-memory partition; data: passes it', async () => {
    const r = rig()
    const page = workspaceWithPage('ok')
    r.thumbnailer.enqueue(page)
    await drained(r.thumbnailer)

    expect(r.windows).toHaveLength(1)
    const config = loadPageConfig(page.workspaceRootPath, page.slug)!
    expect(existsSync(getPageThumbnailPath(page.workspaceRootPath, page.slug))).toBe(true)
    expect(config.thumbnail?.digest).toBe(config.contentDigest)
    expect(r.captured).toEqual([page.slug])
    expect(r.windows[0]!.isDestroyed()).toBe(true)

    expect(r.partitions).toEqual([PAGE_THUMBNAIL_PARTITION])
    expect(PAGE_THUMBNAIL_PARTITION.startsWith('persist:')).toBe(false)
    expect(r.cancelled('data:text/html;charset=utf-8,%3Cp%3Ex%3C%2Fp%3E')).toBe(false)
    expect(r.cancelled('blob:null/0a1b')).toBe(false)
    expect(r.cancelled('about:srcdoc')).toBe(false)
  })

  it('negative: https:, loopback and file: requests are cancelled; permissions are refused', async () => {
    const r = rig()
    r.thumbnailer.enqueue(workspaceWithPage('net'))
    await drained(r.thumbnailer)
    expect(r.cancelled('https://example.invalid/beacon?d=1')).toBe(true)
    expect(r.cancelled('http://127.0.0.1:43123/v1/responses')).toBe(true)
    expect(r.cancelled('ws://localhost:9229/')).toBe(true)
    expect(r.cancelled('file:///etc/hosts')).toBe(true)
    expect(r.permission('media')).toBe(false)
    expect(r.permission('geolocation')).toBe(false)
    expect(r.permissionCheck()).toBe(false)
  })

  it('negative: the window is sandboxed, isolated, preload-free and partitioned; its frame is never allow-same-origin', async () => {
    const r = rig()
    r.thumbnailer.enqueue(workspaceWithPage('prefs'))
    await drained(r.thumbnailer)
    const { options, loaded } = r.windows[0]!
    expect(options.show).toBe(false)
    expect(options.webPreferences?.sandbox).toBe(true)
    expect(options.webPreferences?.contextIsolation).toBe(true)
    expect(options.webPreferences?.nodeIntegration).toBe(false)
    expect(options.webPreferences?.preload).toBeUndefined()
    expect(options.webPreferences?.partition).toBe(PAGE_THUMBNAIL_PARTITION)
    expect(loaded).toHaveLength(1)
    const host = decodeURIComponent(loaded[0]!.replace(/^data:text\/html;charset=utf-8,/, ''))
    expect(host).toContain('sandbox="allow-scripts allow-forms"')
    expect(host).not.toContain('allow-same-origin')
  })

  it('negative: window.open from the page is denied and creates no window', async () => {
    const r = rig()
    r.thumbnailer.enqueue(workspaceWithPage('open'))
    await drained(r.thumbnailer)
    expect(r.windows).toHaveLength(1)
    expect(r.windows[0]!.open('https://example.invalid/popup')).toEqual({ action: 'deny' })
    expect(r.windows).toHaveLength(1)
  })

  it('negative: a meta-refresh or location assignment (a subframe navigation) and any main-frame navigation are prevented', async () => {
    const r = rig()
    r.thumbnailer.enqueue(workspaceWithPage('nav'))
    await drained(r.thumbnailer)
    const win = r.windows[0]!
    expect(win.hasListener('will-navigate')).toBe(true)
    expect(win.hasListener('will-frame-navigate')).toBe(true)
    expect(win.navigate('will-frame-navigate', 'https://example.invalid/leak?d=1', false)).toBe(true)
    expect(win.navigate('will-frame-navigate', 'data:text/html,<p>swapped</p>', false)).toBe(true)
    expect(win.navigate('will-frame-navigate', 'https://example.invalid/top', true)).toBe(true)
    expect(win.navigate('will-navigate', 'https://example.invalid/top', true)).toBe(true)
    // Control: the frame's own inline document still loads.
    expect(win.navigate('will-frame-navigate', 'about:srcdoc', false)).toBe(false)
  })

  it('negative: a render that never settles is destroyed at the timeout, leaves no window and no poster, and the queue moves on', async () => {
    const r = rig({ hang: true })
    const hung = workspaceWithPage('hang', '<!doctype html><script>for(;;){}</script>')
    const next = workspaceWithPage('after')
    r.thumbnailer.enqueue(hung)
    r.thumbnailer.enqueue(next)
    await drained(r.thumbnailer)

    expect(r.windows).toHaveLength(2)
    expect(r.windows.every(win => win.isDestroyed())).toBe(true)
    expect(existsSync(getPageThumbnailPath(hung.workspaceRootPath, hung.slug))).toBe(false)
    expect(loadPageConfig(hung.workspaceRootPath, hung.slug)?.thumbnail).toBeUndefined()
    expect(r.captured).toEqual([])
    expect(r.logs.some(line => line.includes('capture timed out after 60ms'))).toBe(true)
  })
})

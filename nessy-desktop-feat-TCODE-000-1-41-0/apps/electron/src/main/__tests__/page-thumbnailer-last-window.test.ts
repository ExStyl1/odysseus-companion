/**
 * UA12.193 — closing the last app window during a thumbnail capture quits at once on Windows and Linux.
 *
 * Electron's `window-all-closed` counts every `BrowserWindow`, the hidden capture window of `page-thumbnailer.ts`
 * included (UA12.80's stated residue), so the main process's quit (`index.ts`: `app.quit()` off macOS) waited for
 * that window to go — up to the 15 s capture timeout on a hung page. The thumbnailer now destroys its in-flight
 * capture window and drops its queue when the LAST app window closes (`abortCaptureWhenLastAppWindowCloses`), which
 * is what lets Electron emit `window-all-closed` at once; the capture ends as a failure (posterless, as a timeout
 * leaves it).
 *
 * Driven through {@link PageThumbnailer} over a real page on disk with the Electron window injected as a recording
 * fake (the same injection `page-thumbnailer-network.test.ts` uses) and a fake window lifecycle in place of
 * `app.on('browser-window-created')` / `BrowserWindow.getAllWindows()`.
 *
 * Positive: the last app window closing during a hung capture destroys the capture window synchronously, the queue
 * drains far inside the capture timeout, the next queued page is not captured, and no poster is written.
 * Negative (controls): closing one of two app windows does not abort; on a host that does not quit on its last
 * window (macOS, the headless server) nothing aborts; the capture window's own close aborts nothing.
 * Failing arm, taken over `a3323779a`'s thumbnailer with a no-op stand-in for the then-absent wiring: the positive
 * arm failed (the capture window outlived the last app window); the three controls passed.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron'
import { createPage, getPageThumbnailPath } from '@nessy-agent/shared/pages'
import * as thumbnailerModule from '../page-thumbnailer'
import { PageThumbnailer, type ThumbnailElectron } from '../page-thumbnailer'

type Wire = typeof thumbnailerModule.abortCaptureWhenLastAppWindowCloses
const abortCaptureWhenLastAppWindowCloses: Wire = thumbnailerModule.abortCaptureWhenLastAppWindowCloses

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

function workspaceWithPage(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `ua12-193-${tag}-`))
  roots.push(root)
  const workspaceRootPath = join(root, 'ws')
  mkdirSync(workspaceRootPath, { recursive: true })
  const page = createPage(workspaceRootPath, { name: `Page ${tag}`, kind: 'interactive', content: '<h1>x</h1>' })
  return { workspaceRootPath, slug: page.slug, workspaceId: `ws-${tag}` }
}

/** A window with an id, a `closed` event and a destroyed flag — an app window or a capture window. */
type FakeWindow = {
  id: number
  isDestroyed(): boolean
  destroy(): void
  once(event: 'closed', listener: () => void): FakeWindow
  close(): void
}

/**
 * The window lifecycle the wiring reads: `getAllWindows()` and `browser-window-created`. A capture window the
 * thumbnailer creates is announced like any other, as Electron announces it.
 */
function lifecycle() {
  let nextId = 1
  const all: FakeWindow[] = []
  const createdListeners: Array<(win: FakeWindow) => void> = []
  function create(extra: Record<string, unknown> = {}): FakeWindow {
    const closedListeners: Array<() => void> = []
    let destroyed = false
    const win: FakeWindow = {
      ...extra,
      id: nextId++,
      isDestroyed: () => destroyed,
      destroy: () => { if (!destroyed) win.close() },
      once: (_event, listener) => { closedListeners.push(listener); return win },
      close: () => {
        destroyed = true
        all.splice(all.indexOf(win), 1)
        for (const listener of closedListeners.splice(0)) listener()
      },
    }
    all.push(win)
    for (const listener of createdListeners) listener(win)
    return win
  }
  return {
    create,
    all,
    windowLifecycle: {
      onWindowCreated: (listener: (win: FakeWindow) => void) => { createdListeners.push(listener) },
      allWindows: () => [...all],
    },
  }
}

/** A thumbnailer whose capture windows come from `lc` and whose renders never settle (a hung page). */
function rig(lc: ReturnType<typeof lifecycle>, captureTimeoutMs: number) {
  const captureWindows: FakeWindow[] = []
  const session = {
    webRequest: { onBeforeRequest: () => {} },
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
  }
  const electron: ThumbnailElectron = {
    createWindow: (_options: BrowserWindowConstructorOptions) => {
      const win = lc.create({
        loadURL: () => new Promise<void>(() => {}),
        webContents: { setWindowOpenHandler: () => {}, on: () => {}, capturePage: async () => ({ isEmpty: () => true }) },
      })
      captureWindows.push(win)
      return win as unknown as BrowserWindow
    },
    fromPartition: () => session as unknown as Session,
  }
  const logs: string[] = []
  const thumbnailer = new PageThumbnailer({
    electron,
    log: message => { logs.push(message) },
    timings: { settleMs: 0, retryDelayMs: 0, captureTimeoutMs },
  })
  return { thumbnailer, captureWindows, logs }
}

async function until(condition: () => boolean, deadlineMs: number, what: string): Promise<number> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > deadlineMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  return Date.now() - start
}

describe('UA12.193 · the last app window closing aborts an in-flight thumbnail capture', () => {
  it('positive: the capture window is destroyed at once, the queue drains inside the timeout, no poster is written', async () => {
    const lc = lifecycle()
    const appWindow = lc.create()
    const r = rig(lc, 10_000)
    abortCaptureWhenLastAppWindowCloses(r.thumbnailer, lc.windowLifecycle, true)
    const hung = workspaceWithPage('hung')
    const next = workspaceWithPage('next')
    r.thumbnailer.enqueue(hung)
    r.thumbnailer.enqueue(next)
    await until(() => r.captureWindows.length === 1, 2000, 'the capture window')

    appWindow.close()
    // Synchronously: Electron emits `window-all-closed` as soon as the capture window is gone.
    expect(r.captureWindows[0]!.isDestroyed()).toBe(true)
    expect(lc.all).toEqual([])

    const drainMs = await until(() => !r.thumbnailer.isBusy(), 2000, 'the queue to drain')
    expect(drainMs).toBeLessThan(2000)
    expect(r.captureWindows).toHaveLength(1) // the queued page was dropped, not captured
    expect(existsSync(getPageThumbnailPath(hung.workspaceRootPath, hung.slug))).toBe(false)
    expect(r.logs.some(line => line.includes('the last app window closed'))).toBe(true)
  })

  it('CONTROL: closing one of two app windows does not abort the capture', async () => {
    const lc = lifecycle()
    const first = lc.create()
    lc.create()
    const r = rig(lc, 300)
    abortCaptureWhenLastAppWindowCloses(r.thumbnailer, lc.windowLifecycle, true)
    r.thumbnailer.enqueue(workspaceWithPage('two'))
    await until(() => r.captureWindows.length === 1, 2000, 'the capture window')

    first.close()
    expect(r.captureWindows[0]!.isDestroyed()).toBe(false)
    // It ends on its own timeout, as before.
    await until(() => !r.thumbnailer.isBusy(), 3000, 'the timeout')
    expect(r.logs.some(line => line.includes('capture timed out after 300ms'))).toBe(true)
  })

  it('CONTROL: a host that does not quit on its last window (macOS, headless) aborts nothing', async () => {
    const lc = lifecycle()
    const only = lc.create()
    const r = rig(lc, 300)
    abortCaptureWhenLastAppWindowCloses(r.thumbnailer, lc.windowLifecycle, false)
    r.thumbnailer.enqueue(workspaceWithPage('mac'))
    await until(() => r.captureWindows.length === 1, 2000, 'the capture window')

    only.close()
    expect(r.captureWindows[0]!.isDestroyed()).toBe(false)
    await until(() => !r.thumbnailer.isBusy(), 3000, 'the timeout')
  })

  it('CONTROL: the capture window\'s own close (its timeout) aborts nothing that follows', async () => {
    const lc = lifecycle() // no app window: only the capture windows come and go
    const r = rig(lc, 100)
    abortCaptureWhenLastAppWindowCloses(r.thumbnailer, lc.windowLifecycle, true)
    r.thumbnailer.enqueue(workspaceWithPage('first'))
    r.thumbnailer.enqueue(workspaceWithPage('second'))
    // Both captures run to their own timeout: the first capture window closing did not drop the second page.
    await until(() => !r.thumbnailer.isBusy(), 3000, 'both timeouts')
    expect(r.captureWindows).toHaveLength(2)
    expect(r.logs.filter(line => line.includes('capture timed out after 100ms'))).toHaveLength(2)
  })
})

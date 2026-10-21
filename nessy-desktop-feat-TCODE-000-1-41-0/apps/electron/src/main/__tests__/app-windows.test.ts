/**
 * UA12.80 — the hidden thumbnail capture window (UA7.4, `page-thumbnailer.ts`, in the in-memory partition
 * `PAGE_THUMBNAIL_PARTITION`) lives up to its 15 s capture timeout, and `BrowserWindow.getAllWindows()` lists it.
 * The main-process consumers that mean "the app's windows" — the dock `activate` re-creation after the last window
 * closed, the `__dialog:*` parent fallbacks, the boot-fatal "no window yet" check, the gateway-auth status
 * broadcasts and the Windows taskbar overlay — read {@link appWindows} instead, which leaves the capture window out.
 *
 * Positive: a main window is still found beside a registered capture window; a capture registers its window for
 * exactly its lifetime (released after the window is destroyed, also on the timeout path).
 * Negative: the capture window alone counts as no windows; every named consumer's source reads `appWindows(…)`, and
 * the only bare `BrowserWindow.getAllWindows()` left in those files are the two diagnostic counts (named below).
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, Session } from 'electron'
import { createPage } from '@nessy-agent/shared/pages'

const MAIN_DIR = join(import.meta.dir, '..')
const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

describe('UA12.80 · app windows leave the thumbnail capture window out', () => {
  it('positive: a main window is still found beside a capture window; negative: the capture window alone is no window', async () => {
    const { appWindows, registerThumbnailCaptureWindow } = await import('../app-windows')
    const main = { id: 9001 }
    const capture = { id: 9002 }
    const release = registerThumbnailCaptureWindow(capture)
    try {
      expect(appWindows([main, capture])).toEqual([main])
      expect(appWindows([capture])).toEqual([])
      expect(appWindows([capture])[0]).toBeUndefined() // the dialog fallback's `[0]` finds no parent
    } finally {
      release()
    }
    // Released: the same window is an app window again (the registry holds nothing past the capture).
    expect(appWindows([capture])).toEqual([capture])
  })

  it('a capture registers its window for exactly its lifetime, the timeout path included', async () => {
    const { appWindows } = await import('../app-windows')
    const { PageThumbnailer } = await import('../page-thumbnailer')
    const root = mkdtempSync(join(tmpdir(), 'ua12-80-'))
    roots.push(root)
    const workspaceRootPath = join(root, 'ws')
    mkdirSync(workspaceRootPath, { recursive: true })
    const page = createPage(workspaceRootPath, { name: 'Poster', kind: 'interactive', content: '<h1>x</h1>' })

    let destroyed = false
    let seenWhileOpen: unknown[] | undefined
    const win = {
      id: 9100,
      isDestroyed: () => destroyed,
      destroy: () => { destroyed = true },
      // A render that never settles: the capture ends on its timeout.
      loadURL: () => {
        seenWhileOpen = appWindows([win])
        return new Promise<void>(() => {})
      },
      webContents: { setWindowOpenHandler: () => {}, on: () => win.webContents, capturePage: async () => null },
    }
    const session = {
      webRequest: { onBeforeRequest: () => {} },
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
    }
    const thumbnailer = new PageThumbnailer({
      electron: { createWindow: () => win as unknown as BrowserWindow, fromPartition: () => session as unknown as Session },
      timings: { settleMs: 0, retryDelayMs: 0, captureTimeoutMs: 40 },
    })
    thumbnailer.enqueue({ workspaceId: 'ws', workspaceRootPath, slug: page.slug })
    const start = Date.now()
    while (thumbnailer.isBusy() && Date.now() - start < 2000) await new Promise(resolve => setTimeout(resolve, 5))
    expect(thumbnailer.isBusy()).toBe(false)
    expect(seenWhileOpen).toEqual([]) // while it rendered, it was not an app window
    expect(destroyed).toBe(true)
    expect(appWindows([win])).toEqual([win]) // released after the destroy
  })

  /**
   * The consumers are inline closures of the Electron main process (no seam to drive them without Electron), so
   * their sources are pinned: each named consumer reads `appWindows(BrowserWindow.getAllWindows())`. The two
   * diagnostic counts (`electronWindowCount` in `index.ts` before-quit and in `auto-update.ts`) keep the raw count
   * on purpose — they record what Electron holds, the capture window included.
   */
  it('negative: every named consumer reads appWindows(…); only the diagnostic counts stay raw', () => {
    const bare = (rel: string): string[] =>
      readFileSync(join(MAIN_DIR, rel), 'utf-8').split('\n')
        .filter(line => line.includes('BrowserWindow.getAllWindows()') && !line.includes('appWindows(BrowserWindow.getAllWindows())'))
        .map(line => line.trim())
    expect(bare('index.ts')).toEqual(['electronWindowCount: BrowserWindow.getAllWindows().length,'])
    expect(bare('handlers/nessy-auth.ts')).toEqual([])
    expect(bare('notifications.ts')).toEqual([])
    const index = readFileSync(join(MAIN_DIR, 'index.ts'), 'utf-8')
    // Control: the consumers are still there, now reading the filtered list.
    expect(index).toContain('if (appWindows(BrowserWindow.getAllWindows()).length === 0 && windowManager && storageRuntime) {')
    expect(index.split('|| appWindows(BrowserWindow.getAllWindows())[0]').length - 1).toBe(3)
    expect(index).toContain("import { appWindows } from './app-windows'")
  })
})

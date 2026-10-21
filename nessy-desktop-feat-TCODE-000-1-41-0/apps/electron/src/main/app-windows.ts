/**
 * UA12.80 — "the app's windows", as the main process means it: `BrowserWindow.getAllWindows()` minus the hidden
 * thumbnail capture window.
 *
 * The page thumbnailer (UA7.4, `page-thumbnailer.ts`) renders each poster in its own hidden `BrowserWindow` in the
 * in-memory partition `PAGE_THUMBNAIL_PARTITION`, for up to its 15 s capture timeout. Electron lists that window in
 * `getAllWindows()`, so a consumer that asks "is there a window?" or "which window?" saw it: the dock `activate`
 * after the last window closed did not re-create a window, a `__dialog:*` request with no sender window and no
 * focused one parented its dialog to the hidden window, and the gateway-auth status broadcasts reached its `data:`
 * page. Those consumers read {@link appWindows} instead.
 *
 * The thumbnailer registers each capture window here for exactly its lifetime (released after `destroy()`), keyed
 * by `BrowserWindow.id` — a number Electron assigns once per window — so the filter does not depend on wrapper
 * identity or on reading a window's partition back. Electron-free on purpose: the thumbnailer's tests inject fakes.
 *
 * Kept raw on purpose: the diagnostic counts (`electronWindowCount` in `index.ts`'s before-quit record and in
 * `auto-update.ts`) record what Electron holds, the capture window included.
 * Electron's own `window-all-closed` counts the capture window too; UA12.193 closes that: the last app window closing
 * on Windows/Linux destroys the in-flight capture window at once (`abortCaptureWhenLastAppWindowCloses`).
 */

const captureWindowIds = new Set<number>()

/** Register a thumbnail capture window; the returned function releases it (call it after `destroy()`). */
export function registerThumbnailCaptureWindow(win: { id: number }): () => void {
  const id = win.id
  if (typeof id !== 'number') return () => {}
  captureWindowIds.add(id)
  return () => { captureWindowIds.delete(id) }
}

/** True for a window the thumbnailer registered and has not released. */
export function isThumbnailCaptureWindow(win: { id: number }): boolean {
  return captureWindowIds.has(win.id)
}

/** `windows` without the thumbnail capture window(s); pass `BrowserWindow.getAllWindows()`. */
export function appWindows<T extends { id: number }>(windows: readonly T[]): T[] {
  return windows.filter(win => !isThumbnailCaptureWindow(win))
}

/**
 * UA7.2 — the `will-frame-navigate` guard: a subframe of a renderer window may
 * not navigate anywhere except to its own inline document.
 *
 * ## Why
 *
 * A Page renders in a sandboxed `srcdoc` iframe (`sandbox="allow-scripts
 * allow-forms"`, never `allow-same-origin`, never `allow-top-navigation`). Its
 * CSP (`shared/page-frame-csp.ts`, UA7.1) closes `fetch`, WebSocket, images and
 * forms — but CSP has no directive a browser enforces for a frame navigating
 * ITSELF (`location = 'https://host/?data=…'`), which is an exfiltration path
 * and a way to swap the page for remote content. Spec
 * `docs/superpowers/specs/2026-09-23-upstream-0-13-4-board-planning-pages-design.md`
 * §14 "Navigation" and threat S2: before this row only `will-navigate` (main
 * frame) was guarded. Upstream v0.13.4 has no such guard.
 *
 * ## Native mechanism (owner rule 2026-08-28)
 *
 * Electron's own `will-frame-navigate` event, which fires for the main frame
 * AND every subframe; `preventDefault()` cancels the navigation. Option (1):
 * one handler on the platform's event, no layer beside it.
 *
 * ## What it admits
 *
 * - Every MAIN-frame navigation: those stay `will-navigate`'s business
 *   (`WindowManager.isRendererAppUrl`), unchanged by this row.
 * - Subframe navigations to `about:srcdoc` and `about:blank` — the inline
 *   documents the renderer's own iframes are made of (Pages, and the existing
 *   `MarkdownHtmlBlock` / `HTMLPreviewOverlay` previews, which route their link
 *   clicks to the TOP frame with `<base target="_top">`, i.e. through
 *   `will-navigate`, and so lose nothing here).
 *
 * Everything else in a subframe — `http(s):`, `file:`, `data:`, `blob:`,
 * `javascript:`, a custom scheme — is denied. A Page that wants a link opened
 * asks through the bridge's `open-url` (`shared/page-bridge.ts`), which the host
 * confirms (UA7.3).
 *
 * ## UA12.31 — a denial is no longer uniformly silent
 *
 * The renderer's OTHER srcdoc frames (the HTML previews, the artifact preview,
 * the playground oauth frame) run no scripts, so a navigation out of one is a
 * link click; an `<a target="_self">` overrides the `<base target="_top">` those
 * previews inject, and before UA7.2 it opened the browser. A Page frame (the one
 * carrying `PAGE_IFRAME_NAME`, `shared/page-frame-csp.ts`) and every non-http(s)
 * denial stay cancelled with the origin-only log line: a Page's link-outs belong
 * to the bridge's confirmed `open-url`.
 *
 * ## UA12.170 — never SILENTLY: an http(s) link-out waits for the user
 *
 * UA12.31 opened a non-Page frame's http(s) denial with no dialog. But a frame's
 * name is written by the frame's own script: the 2026-10-08 audit probe
 * (Electron 39.8.10) measured that a sandboxed srcdoc frame which sets
 * `window.name` reports the NEW name to the main process — so a Page could
 * rename itself, set `location.href = 'https://host/?d=<data>'`, and the host
 * opened it. The name therefore only ever buys SILENCE (the safe direction);
 * {@link classifyDeniedFrameNavigation} sends every other http(s) denial to
 * `confirm-external`, and {@link createDeniedFrameNavigationRouter} opens the
 * full URL only after the user confirms it in a native dialog
 * ({@link frameLinkOutConfirmOptions}: UA7.3's strings, the full URL, Cancel the
 * default). A native box rather than UA7.3's renderer dialog: the denial is
 * observed in the main process, and a renderer round trip would need a new push
 * channel for the same question (TRANSPARENT and SIMPLE). One confirmation is
 * open per window at a time, and a frame whose link-out the user CANCELLED is
 * not asked again (keyed by its embed root — the child of the main frame — so
 * a Page cannot mint fresh keys with nested iframes); without both, a script
 * looping on `location` would hold the window under a modal forever.
 */

import type { Event, WebContentsWillFrameNavigateEventParams } from 'electron'
import { PAGE_IFRAME_NAME } from '../shared/page-frame-csp'

const INLINE_DOCUMENTS = new Set(['about:srcdoc', 'about:blank'])

/** The schemes a denied link-out may be opened at in the system browser (UA12.31). */
const BROWSER_SCHEMES = new Set(['http:', 'https:'])

/** True when a `will-frame-navigate` must be cancelled. */
export function isDeniedFrameNavigation(details: { isMainFrame: boolean; url: string }): boolean {
  if (details.isMainFrame) return false
  let parsed: URL
  try {
    parsed = new URL(details.url)
  } catch {
    return true
  }
  return !INLINE_DOCUMENTS.has(`${parsed.protocol}${parsed.pathname}`)
}

/** The slice of `WebFrameMain` the router reads (`name`, `frameTreeNodeId`, `parent`). */
export interface FrameLike {
  name?: string
  frameTreeNodeId?: number
  parent?: FrameLike | null
}

/** What the host does with one denied subframe navigation (UA12.31, UA12.170). */
export type DeniedFrameNavigation =
  | { action: 'confirm-external'; url: string; origin: string; frameKey: number | null }
  | { action: 'deny'; origin: string }

/**
 * Route one denied subframe navigation. `confirm-external` with the full URL
 * when it is http(s) out of any frame not named `PAGE_IFRAME_NAME` (UA12.170:
 * the user confirms before anything opens); `deny` with the origin alone
 * otherwise — a Page frame's self-navigation and every non-http(s) scheme. The
 * frame may be unreadable (`null` per the event typings): it is confirmed, never
 * trusted. `frameKey` is the embed root's `frameTreeNodeId`, or `null`.
 */
export function classifyDeniedFrameNavigation(details: {
  isMainFrame: boolean
  url: string
  frame?: FrameLike | null
}): DeniedFrameNavigation {
  if (readFrameName(details.frame) !== PAGE_IFRAME_NAME) {
    try {
      const parsed = new URL(details.url)
      if (BROWSER_SCHEMES.has(parsed.protocol)) {
        return { action: 'confirm-external', url: details.url, origin: parsed.origin, frameKey: embedRootKey(details.frame) }
      }
    } catch {
      // unparseable — falls through to the origin-only denial
    }
  }
  return { action: 'deny', origin: describeOrigin(details.url) }
}

/** The answer index of "Open link" in {@link frameLinkOutConfirmOptions}'s buttons. */
export const FRAME_LINK_OUT_OPEN_BUTTON = 1

/**
 * UA12.170 — the native confirmation of one link-out: UA7.3's title and button
 * strings (no new keys), the FULL URL as the detail, Cancel first, the default
 * and the escape answer.
 */
export function frameLinkOutConfirmOptions(url: string, t: (key: string) => string): {
  type: 'question'
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  noLink: true
} {
  return {
    type: 'question',
    message: t('pages.openUrlConfirmTitle'),
    detail: url,
    buttons: [t('common.cancel'), t('common.openLink')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
}

/** What one window's router needs from the host (lets the test drive it without Electron). */
export interface DeniedFrameNavigationRouterDeps {
  /** Ask the user about the full URL; resolves true only on "Open link". */
  confirm(url: string): Promise<boolean>
  /** Hand a confirmed URL to the host's classified external-open route. */
  open(url: string): void
  /** One log line; never carries more than the origin. */
  log(line: string): void
}

/**
 * UA12.170 — one window's handler for {@link installSubframeNavigationGuard}'s
 * denials. `deny` logs the origin; `confirm-external` asks the user and opens
 * the full URL only on a confirm. While one confirmation is open, further
 * link-outs are dropped; a frame (embed root) whose link-out was cancelled is
 * not asked again. Every dropped link-out is logged by origin alone.
 */
export function createDeniedFrameNavigationRouter(
  deps: DeniedFrameNavigationRouterDeps,
): (denied: DeniedFrameNavigation) => void {
  let pending = false
  const declined = new Set<number>()
  return denied => {
    if (denied.action === 'deny') {
      deps.log(`[navigation] subframe navigation denied (UA7.2): ${denied.origin}`)
      return
    }
    if (pending || (denied.frameKey !== null && declined.has(denied.frameKey))) {
      const why = pending ? 'a confirmation is already open' : 'the user declined this frame'
      deps.log(`[navigation] subframe link-out dropped (UA12.170, ${why}): ${denied.origin}`)
      return
    }
    pending = true
    deps.log(`[navigation] subframe link-out awaits the user's confirmation (UA12.170): ${denied.origin}`)
    void deps.confirm(denied.url)
      .catch(() => false)
      .then(confirmed => {
        pending = false
        if (confirmed) deps.open(denied.url)
        else if (denied.frameKey !== null) declined.add(denied.frameKey)
      })
  }
}

/** The slice of `WebContents` the guard needs (lets the test drive it without Electron). */
export interface FrameNavigationSource {
  on(
    event: 'will-frame-navigate',
    listener: (details: Event<WebContentsWillFrameNavigateEventParams>) => void,
  ): unknown
}

/**
 * Install the guard on a renderer window's `webContents`. The navigation is
 * cancelled here in every denied case; `onDenied` receives the classified
 * {@link DeniedFrameNavigation} — `confirm-external` with the full URL (an
 * http(s) link-out the user must confirm, UA12.31/UA12.170) or `deny` with the
 * refused URL's origin only (never its path or query, which is where a page
 * would put the data it tried to carry out).
 */
export function installSubframeNavigationGuard(
  webContents: FrameNavigationSource,
  onDenied: (denied: DeniedFrameNavigation) => void,
): void {
  webContents.on('will-frame-navigate', details => {
    if (!isDeniedFrameNavigation(details)) return
    details.preventDefault()
    onDenied(classifyDeniedFrameNavigation(details))
  })
}

function describeOrigin(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.origin === 'null' ? `${parsed.protocol}…` : parsed.origin
  } catch {
    return '(unparseable URL)'
  }
}

/** The frame's name, or undefined when the frame is gone (a disposed `WebFrameMain` may throw on access). */
function readFrameName(frame: FrameLike | null | undefined): string | undefined {
  try {
    return frame?.name
  } catch {
    return undefined
  }
}

/**
 * The `frameTreeNodeId` of the frame's embed root — the ancestor whose parent is
 * the main frame — so every frame nested inside one Page shares one key. `null`
 * when the frame (or its chain) cannot be read.
 */
function embedRootKey(frame: FrameLike | null | undefined): number | null {
  try {
    let root = frame
    while (root?.parent?.parent) root = root.parent
    return typeof root?.frameTreeNodeId === 'number' ? root.frameTreeNodeId : null
  } catch {
    return null
  }
}

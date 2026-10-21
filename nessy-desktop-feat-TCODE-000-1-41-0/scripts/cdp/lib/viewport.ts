/**
 * Mouse input with a viewport guard.
 *
 * A previous run computed a palette row at y=1006 inside a 900px-tall window and
 * clicked it anyway. CDP dispatched the event happily, the click landed nowhere,
 * and the "click outside" handler closed the palette — so the run measured a
 * palette that had silently shut. Any click through this module is checked
 * against the live viewport first and REFUSED with the numbers, rather than
 * dispatched into the void.
 *
 * Note also that `Page.captureScreenshot` is 2x device pixels on this machine
 * while every coordinate here is CSS pixels. Never read coordinates off a
 * screenshot; read them off `getBoundingClientRect()`.
 */

import type { CdpSession } from './connect.ts'

export interface Viewport {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/**
 * Pure guard. Returns an explanatory message when the point is unclickable, or
 * `null` when it is fine. Unit tested.
 */
export function viewportRejection(viewport: Viewport, point: Point, label = 'point'): string | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return `click refused: ${label} has non-finite coordinates (${point.x}, ${point.y})`
  }
  const outsideX = point.x < 0 || point.x > viewport.width
  const outsideY = point.y < 0 || point.y > viewport.height
  if (!outsideX && !outsideY) return null
  const which = [outsideX ? `x=${point.x} outside 0..${viewport.width}` : '', outsideY ? `y=${point.y} outside 0..${viewport.height}` : '']
    .filter(Boolean)
    .join(', ')
  return (
    `click refused: ${label} at (${point.x}, ${point.y}) is outside the ${viewport.width}x${viewport.height} viewport — ${which}. ` +
    'Clicking anyway dismisses popovers instead of hitting the row. Scroll the element into view, resize the window, ' +
    'or drive the surface with arrow keys + Enter.'
  )
}

export function assertInViewport(viewport: Viewport, point: Point, label = 'point'): void {
  const rejection = viewportRejection(viewport, point, label)
  if (rejection) throw new Error(rejection)
}

export async function getViewport(session: CdpSession): Promise<Viewport> {
  return session.evaluate<Viewport>('({ width: window.innerWidth, height: window.innerHeight })')
}

export async function resizeWindow(session: CdpSession, width: number, height: number): Promise<void> {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 0, mobile: false,
  })
}

/** Native mouse click at CSS coordinates. Radix popovers ignore synthetic `.click()`. */
export async function clickAt(session: CdpSession, point: Point, label = 'point'): Promise<void> {
  assertInViewport(await getViewport(session), point, label)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
    await session.send('Input.dispatchMouseEvent', {
      type, x: point.x, y: point.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: type === 'mouseMoved' ? 0 : 1,
    })
  }
}

export interface RectResult {
  found: boolean
  rect?: { x: number; y: number; width: number; height: number }
}

/**
 * Rect of the first VISIBLE element matching `selector`.
 *
 * "First match" alone produced a false FAIL on AGT-3: `InputContainer` renders
 * an invisible measuring copy of the permission card BEFORE the visible one, so
 * `querySelector` returned a `visibility: hidden` Allow button at a different y
 * and the click missed. `visibility: hidden` keeps its box, so the zero-size
 * guard in `clickSelector` never fired. Proven with a positive control: an
 * ordinary non-fork bash prompt missed identically (2026-07-31, L5 executor).
 */
export async function elementRect(session: CdpSession, selector: string): Promise<RectResult> {
  return session.call<RectResult>(`
    const all = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
    const el = all.find(candidate => {
      const style = window.getComputedStyle(candidate)
      return style.visibility !== 'hidden' && style.display !== 'none' && candidate.getClientRects().length > 0
    }) ?? all[0]
    if (!el) return { found: false }
    const r = el.getBoundingClientRect()
    return { found: true, rect: { x: r.x, y: r.y, width: r.width, height: r.height } }
  `)
}

/**
 * Click the centre of the first element matching `selector`.
 *
 * Refuses rather than clicks when the element is off-viewport or zero-sized.
 * Prefer keyboard selection where the surface supports it; a click is a last
 * resort because it is the input that can miss.
 */
export async function clickSelector(session: CdpSession, selector: string): Promise<Point> {
  const found = await elementRect(session, selector)
  if (!found.found || !found.rect) throw new Error(`click refused: no element matches ${selector}`)
  const { x, y, width, height } = found.rect
  if (width <= 0 || height <= 0) throw new Error(`click refused: ${selector} has zero size (${width}x${height}) — it is hidden, not clickable`)
  const point = { x: Math.round(x + width / 2), y: Math.round(y + height / 2) }
  // A coordinate click dies SILENTLY under an overlay while key events keep
  // working — the HMR splash (`z-splash`) covers the app whenever anything in
  // the renderer's Vite graph changes, and packages/shared is in that graph,
  // so a concurrent server-side executor can splash a run mid-case (trap 0,
  // measured twice on 2026-07-31). Wait for the target to actually be the
  // element under the cursor; refuse LOUDLY if something else stays on top.
  const covered = await waitForHitTarget(session, selector, point, 20_000)
  if (covered) throw new Error(`click refused: ${selector} at (${point.x},${point.y}) is covered by ${covered} — an overlay would eat this click silently`)
  await clickAt(session, point, selector)
  return point
}

/** Poll until elementFromPoint resolves inside the target; return the covering description if it never does. */
async function waitForHitTarget(session: CdpSession, selector: string, point: Point, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  let last: string | null = null
  for (;;) {
    last = await session.call<string | null>(`
      const target = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
        .find(el => { const s = window.getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && el.getClientRects().length > 0 })
      if (!target) return 'target-vanished'
      const hit = document.elementFromPoint(${point.x}, ${point.y})
      if (!hit) return 'nothing-at-point'
      if (target.contains(hit) || hit.contains(target)) return null
      return hit.tagName + '.' + String(hit.className).slice(0, 80)
    `)
    if (last === null) return null
    if (Date.now() >= deadline) return last
    await new Promise(resolve => { setTimeout(resolve, 500) })
  }
}

/**
 * UB4.23 (B3-25; upstream v0.15.1 `hooks/useContainerWidth.ts`) — a narrow
 * window never paints the wide layout first.
 *
 * At HEAD the hook measured in `useEffect` and had no first read, so its first
 * render returned the default 0 and the shell painted the WIDE layout before
 * the ResizeObserver's first callback reflowed it into compact — the cold-load
 * layout shift upstream fixed by measuring in a layout effect, before paint.
 *
 * Instrument: the repo has no DOM library, so the established pattern applies
 * (`useBackgroundTasks.test.ts`): the pure half (`contentWidth`) is driven on
 * element stubs, and the load-bearing wiring — measure-in-layout-effect before
 * observe, resize still updates — is pinned against the hook's own source with
 * comments stripped (so the new docblock cannot defeat its own guard).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { contentWidth } from '../useContainerWidth.ts'

const hookSource = readFileSync(new URL('../useContainerWidth.ts', import.meta.url), 'utf8')
const hookCode = hookSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

function stubElement(clientWidth: number, paddingLeft = 0, paddingRight = 0): HTMLElement {
  const el = {
    clientWidth,
    getAttribute: () => null,
  } as unknown as HTMLElement
  ;(globalThis as { getComputedStyle?: unknown }).getComputedStyle = () =>
    ({ paddingLeft: `${paddingLeft}px`, paddingRight: `${paddingRight}px` }) as unknown as CSSStyleDeclaration
  return el
}

describe('contentWidth (the pure half)', () => {
  it('reads the content-box width of a 600 px container, horizontal padding excluded', () => {
    expect(contentWidth(stubElement(600))).toBe(600)
    expect(contentWidth(stubElement(616, 8, 8))).toBe(600)
    expect(contentWidth(stubElement(600, 12))).toBe(588)
  })

  it('treats absent padding styles as zero (parse failure falls back to 0)', () => {
    ;(globalThis as { getComputedStyle?: unknown }).getComputedStyle = () =>
      ({} as unknown as CSSStyleDeclaration)
    expect(contentWidth(stubElement(600))).toBe(600)
  })
})

describe('useContainerWidth wiring (source pins)', () => {
  it('THE ROW: the first measurement is a layout-effect read before the observer attaches', () => {
    // Fails on HEAD's logic: useEffect + observe-only (no first read).
    expect(hookCode).toContain('useLayoutEffect')
    expect(hookCode).not.toContain('useEffect(')
    const effectBody = hookCode.slice(hookCode.indexOf('useLayoutEffect'))
    const firstRead = effectBody.indexOf('setWidth(contentWidth(el))')
    const observe = effectBody.indexOf('ro.observe(el)')
    expect(firstRead).toBeGreaterThan(-1)
    expect(observe).toBeGreaterThan(firstRead)
  })

  it('CONTROL: a later resize still updates through the ResizeObserver callback', () => {
    expect(hookCode).toContain('new ResizeObserver')
    expect(hookCode).toContain('setWidth(entry.contentBoxSize[0].inlineSize)')
    expect(hookCode).toContain('ro.disconnect()')
  })
})

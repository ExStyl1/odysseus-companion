import { describe, expect, it } from 'bun:test'

import { assertInViewport, viewportRejection } from './viewport.ts'
import { paletteKeySequence } from './composer.ts'

const VIEWPORT = { width: 1440, height: 900 }

describe('viewportRejection', () => {
  it('accepts a point inside the viewport', () => {
    expect(viewportRejection(VIEWPORT, { x: 700, y: 450 })).toBeNull()
    expect(viewportRejection(VIEWPORT, { x: 0, y: 0 })).toBeNull()
    expect(viewportRejection(VIEWPORT, { x: 1440, y: 900 })).toBeNull()
  })

  it('refuses the exact click that closed the palette: y=1006 in a 900px window', () => {
    const rejection = viewportRejection(VIEWPORT, { x: 400, y: 1006 }, 'palette row')
    expect(rejection).toContain('palette row')
    expect(rejection).toContain('y=1006 outside 0..900')
  })

  it('refuses a point off the left or right edge', () => {
    expect(viewportRejection(VIEWPORT, { x: -1, y: 10 })).toContain('x=-1 outside 0..1440')
    expect(viewportRejection(VIEWPORT, { x: 1441, y: 10 })).toContain('x=1441 outside 0..1440')
  })

  it('refuses non-finite coordinates instead of dispatching NaN', () => {
    expect(viewportRejection(VIEWPORT, { x: Number.NaN, y: 10 })).toContain('non-finite')
  })

  it('assertInViewport throws for a refused point and stays quiet otherwise', () => {
    expect(() => assertInViewport(VIEWPORT, { x: 400, y: 1006 })).toThrow(/click refused/)
    expect(() => assertInViewport(VIEWPORT, { x: 400, y: 106 })).not.toThrow()
  })
})

describe('paletteKeySequence', () => {
  it('commits the already-highlighted row with a bare Enter', () => {
    expect(paletteKeySequence(0, 0, 5)).toEqual(['Enter'])
  })

  it('walks down to a later row', () => {
    expect(paletteKeySequence(0, 3, 10)).toEqual(['ArrowDown', 'ArrowDown', 'ArrowDown', 'Enter'])
  })

  it('walks up when up is shorter, since the palette wraps both ways', () => {
    expect(paletteKeySequence(0, 8, 10)).toEqual(['ArrowUp', 'ArrowUp', 'Enter'])
    expect(paletteKeySequence(2, 9, 10)).toEqual(['ArrowUp', 'ArrowUp', 'ArrowUp', 'Enter'])
  })

  it('breaks a tie downwards rather than wandering', () => {
    expect(paletteKeySequence(7, 2, 10)).toEqual(Array(5).fill('ArrowDown').concat('Enter'))
  })

  it('rejects an index the palette does not have', () => {
    expect(() => paletteKeySequence(0, 5, 5)).toThrow(/outside 0\.\.4/)
    expect(() => paletteKeySequence(-1, 0, 5)).toThrow(/outside 0\.\.4/)
    expect(() => paletteKeySequence(0, 0, 0)).toThrow(/no items/)
  })
})

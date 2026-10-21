/**
 * UB14.46 — useListReorderFlip (v0.15.1; taken 1:1 by UB14.3 with its consumer, SessionList).
 * Only a PURE reorder animates: rows that move within or between groups glide, while a render that
 * adds or removes a row changes the list instantly (`enabled` is false for that render only).
 *
 * The hook runs unmodified on the real reconciler (`fixtures/render-hook.ts`): `enabled` compares
 * this render's row set with the one its effect stored after the previous render.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { useListReorderFlip } from '../useListReorderFlip'
import { renderHook, type RenderedHook } from './fixtures/render-hook'

type Groups = ReadonlyArray<{ key: string; ids: readonly string[] }>
type Flip = ReturnType<typeof useListReorderFlip>

const container = { current: null }
const viewport = { current: null }

let mounted: RenderedHook<Groups, Flip> | null = null

function mount(groups: Groups): RenderedHook<Groups, Flip> {
  mounted = renderHook(
    (g: Groups) => useListReorderFlip({ groups: g, container, viewport, rowKeyAttribute: 'data-session-id' }),
    groups,
  )
  return mounted
}

afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('useListReorderFlip — only a pure reorder animates', () => {
  it('positive: a reorder within a group and a move into another group are enabled', () => {
    const hook = mount([{ key: 'today', ids: ['a', 'b', 'c'] }])
    const before = hook.current.value

    hook.rerender([{ key: 'today', ids: ['c', 'a', 'b'] }])
    expect(hook.current.enabled).toBe(true)
    expect(hook.current.value).not.toBe(before)

    hook.rerender([
      { key: 'today', ids: ['c'] },
      { key: 'yesterday', ids: ['a', 'b'] },
    ])
    expect(hook.current.enabled).toBe(true)
    expect(hook.current.value).toBe('today:c|yesterday:a,b')
  })

  it('negative: an added row disables that render, and a removed row too', () => {
    const hook = mount([{ key: 'today', ids: ['a', 'b'] }])

    hook.rerender([{ key: 'today', ids: ['b', 'a', 'd'] }])
    expect(hook.current.enabled).toBe(false)

    // Boundary: the next render compares against the new set, so a reorder animates again.
    hook.rerender([{ key: 'today', ids: ['d', 'b', 'a'] }])
    expect(hook.current.enabled).toBe(true)

    hook.rerender([{ key: 'today', ids: ['d', 'a'] }])
    expect(hook.current.enabled).toBe(false)
  })

  it('boundary: with no mounted list there is nothing to measure', () => {
    const hook = mount([{ key: 'today', ids: ['a'] }])
    expect(hook.current.getTargets()).toEqual([])
  })
})

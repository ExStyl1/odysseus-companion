/**
 * UB4.22 (B3-22; upstream v0.15.0/v0.15.1 `kanban/__tests__/board-collision.test.ts`,
 * copied+adapted, Apache-2.0) — in the compact stacked board a drag targets the
 * column under the pointer.
 *
 * At HEAD the board's `DndContext` passed `closestCorners` unconditionally, so
 * when the compact shell stacked the columns vertically each drop target was
 * only as tall as its cards and corner distance picked a short neighbouring
 * column over the one under the finger. `boardCollisionDetection` keeps
 * `closestCorners` for side-by-side layouts and uses `pointerWithin` only when
 * every column shares one left edge.
 */
import { describe, expect, it } from 'bun:test'
import type { ClientRect, DroppableContainer, UniqueIdentifier } from '@dnd-kit/core'
import { areColumnsStacked, boardCollisionDetection } from '../board-collision'

const rect = (left: number, top: number, width: number, height: number): ClientRect => ({
  left, top, width, height, right: left + width, bottom: top + height,
})

function detect(columns: Record<string, ClientRect>, dragged: ClientRect, pointer: { x: number; y: number }) {
  const droppableRects = new Map<UniqueIdentifier, ClientRect>(Object.entries(columns))
  const droppableContainers = Object.keys(columns).map(id => ({ id, disabled: false, data: { current: undefined } }) as unknown as DroppableContainer)
  const collisions = boardCollisionDetection({
    active: { id: 'card', data: { current: undefined }, rect: { current: { initial: dragged, translated: dragged } } },
    collisionRect: dragged,
    droppableRects,
    droppableContainers,
    pointerCoordinates: pointer,
  } as Parameters<typeof boardCollisionDetection>[0])
  return collisions[0]?.id
}

describe('areColumnsStacked', () => {
  it('is false for side-by-side columns and a single column (control)', () => {
    expect(areColumnsStacked([rect(16, 0, 260, 600), rect(288, 0, 260, 600)])).toBe(false)
    expect(areColumnsStacked([rect(16, 0, 260, 600)])).toBe(false)
  })
  it('is true when every column shares a left edge (rounded, so a sub-pixel drift still stacks)', () => {
    expect(areColumnsStacked([rect(12, 0, 396, 420), rect(12, 432, 396, 60), rect(12.3, 504, 396, 60)])).toBe(true)
  })
})

describe('boardCollisionDetection', () => {
  // Compact stack: a tall To Do (5 cards) above two short, empty columns.
  const stacked = {
    todo: rect(12, 0, 396, 420),
    progress: rect(12, 432, 396, 60),
    done: rect(12, 504, 396, 60),
  }

  it('THE ROW: a card held over a short stacked column drops into the column under the pointer', () => {
    const dragged = rect(20, 420, 380, 72)
    expect(detect(stacked, dragged, { x: 200, y: 460 })).toBe('progress')
  })

  it('keeps a card held inside a tall stacked column in that column', () => {
    const dragged = rect(20, 340, 380, 72)
    expect(detect(stacked, dragged, { x: 200, y: 380 })).toBe('todo')
  })

  it('falls back to the closest column in the gap between stacked columns', () => {
    const dragged = rect(20, 400, 380, 72)
    expect(detect(stacked, dragged, { x: 200, y: 426 })).toBeDefined()
  })

  it('CONTROL: side-by-side targeting stays with closestCorners', () => {
    const wide = { todo: rect(16, 0, 260, 600), progress: rect(288, 0, 260, 600) }
    const dragged = rect(300, 100, 240, 72)
    expect(detect(wide, dragged, { x: 420, y: 130 })).toBe('progress')
  })
})

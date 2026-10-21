/**
 * UA12.21 (OQ-14) — keyboard drag on the board.
 *
 * This renderer's `bun test` has no DOM, so the move is driven through the pieces dnd-kit calls, in the order it
 * calls them, and the wiring is pinned by source where only a source read can see it:
 *
 *  - the ACTIVATOR: Space on the tile card starts a drag; Enter, a tile control (`data-no-dnd`) or anything outside a
 *    tile does not;
 *  - the MOVE: Left/Right put the dragged tile onto the neighbouring column's rect; Up/Down and the board's edges do
 *    nothing;
 *  - the DROP: the column under the tile becomes the move (`boardDropTarget`), and the board container folds the
 *    status to that column's drop status (`resolveDropStatus`, the pointer's own path); Escape is a cancel, which
 *    never reaches the drop;
 *  - the ANNOUNCEMENTS: localized, naming the task and the column (en and ru both read from the real locale files);
 *  - UB14.52: the same move on the compact STACKED board, where the collision is pointer-first and a keyboard drag has
 *    no pointer.
 */
import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KeyboardCode, KeyboardSensor, type SensorContext } from '@dnd-kit/core'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolveDropStatus } from '@/atoms/kanban'
import type { SessionStatus } from '@/config/session-status-config'
import * as boardDrag from '../board-keyboard-drag'
import { areColumnsStacked, boardCollisionDetection } from '../board-collision'
import { deriveBoardTasks } from '../board-derive'
import { TaskTile } from '../TaskTile'
import {
  BOARD_DND_ID,
  BOARD_KEYBOARD_CODES,
  BoardKeyboardSensor,
  boardColumnCoordinates,
  boardDragAccessibility,
  boardDropTarget,
  isTileKeyboardDragTarget,
} from '../board-keyboard-drag'

const KANBAN_DIR = join(import.meta.dir, '..')
const LOCALES_DIR = join(KANBAN_DIR, '..', '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
const source = (file: string) => readFileSync(join(KANBAN_DIR, file), 'utf8')

/** A fake DOM: a tile wrapper holding its card and one `data-no-dnd` control. */
function fakeTile() {
  const wrapper: any = { attrs: { 'data-kanban-task': 's1' } }
  const card: any = { attrs: { role: 'button' }, parent: wrapper }
  const control: any = { attrs: { 'data-no-dnd': 'true' }, parent: card }
  const outside: any = { attrs: {}, parent: null }
  const matches = (el: any, selector: string) =>
    selector === '[data-no-dnd="true"]' ? el.attrs['data-no-dnd'] === 'true'
      : selector === '[data-kanban-task]' ? 'data-kanban-task' in el.attrs
        : selector === '[role="button"]' ? el.attrs.role === 'button' : false
  for (const el of [wrapper, card, control, outside]) {
    el.closest = (selector: string) => {
      for (let node = el; node; node = node.parent) if (matches(node, selector)) return node
      return null
    }
  }
  wrapper.querySelector = (selector: string) => (matches(card, selector) ? card : null)
  return { wrapper, card, control, outside }
}

function keyEvent(code: string, target: unknown) {
  let prevented = false
  return {
    nativeEvent: { code },
    target,
    preventDefault: () => { prevented = true },
    get prevented() { return prevented },
  }
}

const startHandler = BoardKeyboardSensor.activators[0]!.handler

describe('UA12.21 — what starts a keyboard drag', () => {
  it('is dnd-kit\'s own KeyboardSensor, started on a keydown', () => {
    expect(Object.getPrototypeOf(BoardKeyboardSensor)).toBe(KeyboardSensor)
    expect(BoardKeyboardSensor.activators.map(a => a.eventName)).toEqual(['onKeyDown'])
  })

  it('Space on the tile card starts it', () => {
    const { card } = fakeTile()
    let activated = 0
    const event = keyEvent(KeyboardCode.Space, card)
    const started = startHandler(event as any, { keyboardCodes: BOARD_KEYBOARD_CODES, onActivation: () => { activated += 1 } }, { active: { activatorNode: { current: null } } } as any)
    expect(started).toBe(true)
    expect(activated).toBe(1)
  })

  it('Enter on the card does not (Enter opens the task), nor Space on a tile control or outside any tile', () => {
    const { card, control, outside } = fakeTile()
    const ctx = { active: { activatorNode: { current: null } } } as any
    expect(startHandler(keyEvent(KeyboardCode.Enter, card) as any, { keyboardCodes: BOARD_KEYBOARD_CODES }, ctx)).toBe(false)
    expect(startHandler(keyEvent(KeyboardCode.Space, control) as any, { keyboardCodes: BOARD_KEYBOARD_CODES }, ctx)).toBe(false)
    expect(startHandler(keyEvent(KeyboardCode.Space, outside) as any, { keyboardCodes: BOARD_KEYBOARD_CODES }, ctx)).toBe(false)
    expect(isTileKeyboardDragTarget(null)).toBe(false)
  })

  it('the codes: Space picks up; Space, Enter and Tab drop (dnd-kit\'s own end set); Escape cancels; Enter never starts', () => {
    expect(BOARD_KEYBOARD_CODES).toEqual({ start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter', 'Tab'] })
  })

  it('the tile opens on Enter only, so Space can never both open a task and pick it up', () => {
    const tile = source('TaskTile.tsx')
    expect(tile).not.toContain("e.key === 'Enter' || e.key === ' '")
  })
})

/** The sensor context a coordinate getter reads, for a three-column board 300 px wide each. */
function boardContext(overId: string | null): SensorContext {
  const rect = (left: number) => ({ left, top: 100, width: 280, height: 600, right: left + 280, bottom: 700 })
  return {
    over: overId ? { id: overId } : null,
    collisionRect: { left: 10, top: 120, width: 260, height: 90, right: 270, bottom: 210 },
    droppableRects: new Map([['todo', rect(0)], ['in-progress', rect(300)], ['done', rect(600)]]),
  } as unknown as SensorContext
}

const coordinates = boardColumnCoordinates(() => ['todo', 'in-progress', 'done'])
const press = (code: string, overId: string | null) =>
  coordinates({ code } as KeyboardEvent, { active: 's1', currentCoordinates: { x: 10, y: 120 }, context: boardContext(overId) })

describe('UA12.21 — Left/Right jump a whole column', () => {
  it('Right from ToDo lands inside In Progress\'s rect; Left from Done inside In Progress\'s', () => {
    expect(press(KeyboardCode.Right, 'todo')).toEqual({ x: 310, y: 108 })
    expect(press(KeyboardCode.Left, 'done')).toEqual({ x: 310, y: 108 })
  })

  it('nothing at the board\'s edges, for Up/Down, or before the tile is over any column', () => {
    expect(press(KeyboardCode.Left, 'todo')).toBeUndefined()
    expect(press(KeyboardCode.Right, 'done')).toBeUndefined()
    expect(press(KeyboardCode.Up, 'in-progress')).toBeUndefined()
    expect(press(KeyboardCode.Down, 'in-progress')).toBeUndefined()
    expect(press(KeyboardCode.Right, null)).toBeUndefined()
  })
})

describe('UA12.21 — the drop, and the drop status it applies', () => {
  const tasks = [{ id: 's1', column: 'todo' }]
  const columnStatus = { todo: 'todo', 'in-progress': 'in-progress', done: 'done' } as Record<string, string>
  const isKnownStatus = (id: string) => ['todo', 'in-progress', 'done'].includes(id)

  it('a keyboard-only move: Space, Right, Right, Space moves the tile to Done and applies Done\'s drop status', () => {
    // dnd-kit's order: the activator, then the getter per arrow (the board's collision then reports the column the
    // tile is over), then the drop on Space with that column as `over`.
    expect(startHandler(keyEvent(KeyboardCode.Space, fakeTile().card) as any, { keyboardCodes: BOARD_KEYBOARD_CODES }, { active: { activatorNode: { current: null } } } as any)).toBe(true)
    expect(press(KeyboardCode.Right, 'todo')).toBeDefined()
    expect(press(KeyboardCode.Right, 'in-progress')).toBeDefined()
    expect(BOARD_KEYBOARD_CODES.end).toContain(KeyboardCode.Space)
    const toColumn = boardDropTarget(tasks, 's1', 'done')
    expect(toColumn).toBe('done')
    expect(resolveDropStatus({ toColumn: toColumn!, columnStatus, isKnownStatus })).toBe('done')
  })

  it('no move: dropped on its own column, outside every column, or for an unknown tile', () => {
    expect(boardDropTarget(tasks, 's1', 'todo')).toBeNull()
    expect(boardDropTarget(tasks, 's1', null)).toBeNull()
    expect(boardDropTarget(tasks, 'ghost', 'done')).toBeNull()
  })

  it('Escape cancels with no change: the cancel code, and the board\'s cancel handler never moves anything', () => {
    expect(BOARD_KEYBOARD_CODES.cancel).toEqual([KeyboardCode.Esc])
    const board = source('KanbanBoard.tsx')
    // UB14.52 (v0.15.1): the cancel handler also captures the settle FLIP, and still only clears the drag.
    expect(board).toContain('onDragCancel={handleDragCancel}')
    const cancel = board.slice(board.indexOf('const handleDragCancel'), board.indexOf('}, [activeId, captureSettle])'))
    expect(cancel).toContain('setActiveId(null)')
    expect(cancel).not.toContain('onMoveTask')
    expect(cancel).not.toContain('boardDropTarget')
    // The ONLY move is the drag END's, through the shared drop rule.
    expect(board.match(/onMoveTask\?\.\(/g)).toHaveLength(1)
    expect(board).toContain('const toColumn = boardDropTarget(tasks, active.id, over?.id)')
  })

  it('the board registers the keyboard sensor beside the pointer one, with the codes, the getter and the a11y', () => {
    const board = source('KanbanBoard.tsx')
    expect(board).toContain('useSensor(BoardKeyboardSensor, { keyboardCodes: BOARD_KEYBOARD_CODES, coordinateGetter: keyboardCoordinates })')
    expect(board).toContain('id={BOARD_DND_ID}')
    expect(board).toContain('accessibility={accessibility}')
    expect(source('KanbanColumn.tsx')).toContain('describedBy={BOARD_DND_ID}')
    expect(source('TaskTile.tsx')).toContain('aria-describedby={describedBy}')
    expect(BOARD_DND_ID).toBe('kanban-board-dnd')
  })
})

/**
 * UB14.52 (R2-15) — the compact shell stacks the columns (every column on one left edge) and the board's collision
 * becomes `boardCollisionDetection` (UB4.22): `pointerWithin` first, `closestCorners` as the fallback. A keyboard drag
 * has no pointer: dnd-kit's `pointerWithin` returns `[]` without `pointerCoordinates` (core.esm.js, the
 * `if (!pointerCoordinates) return []` guard), so each Left/Right lands per `closestCorners` on the rect the column
 * getter moved the tile onto, and the drop goes through `boardDropTarget` as on a side-by-side board.
 */
describe('UB14.52 — keyboard drag on the stacked (compact) board', () => {
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height })
  // The compact stack the collision suite uses: a tall To Do above two short columns.
  const STACKED = { todo: rect(12, 0, 396, 420), 'in-progress': rect(12, 432, 396, 60), done: rect(12, 504, 396, 60) }
  const TILE = { width: 380, height: 72 }
  const order = ['todo', 'in-progress', 'done']
  const stackedGetter = boardColumnCoordinates(() => order)

  /** One keyboard step: the getter's new point, then the board's collision on the moved tile with no pointer. */
  function step(code: string, overId: string, pointer: { x: number; y: number } | null = null) {
    const droppableRects = new Map(Object.entries(STACKED))
    const context = { over: { id: overId }, collisionRect: rect(20, 0, TILE.width, TILE.height), droppableRects } as unknown as SensorContext
    const point = stackedGetter({ code } as KeyboardEvent, { active: 's1', currentCoordinates: { x: 20, y: 0 }, context })
    if (!point) return { point, over: undefined }
    const moved = rect(point.x, point.y, TILE.width, TILE.height)
    const droppableContainers = order.map(id => ({ id, disabled: false, data: { current: undefined } }))
    const collisions = boardCollisionDetection({
      active: { id: 's1', data: { current: undefined }, rect: { current: { initial: moved, translated: moved } } },
      collisionRect: moved,
      droppableRects,
      droppableContainers,
      pointerCoordinates: pointer,
    } as unknown as Parameters<typeof boardCollisionDetection>[0])
    return { point, over: collisions[0]?.id as string | undefined }
  }

  it('the instrument: the stub layout IS stacked, so the pointer-first branch is the one taken', () => {
    expect(areColumnsStacked(Object.values(STACKED))).toBe(true)
  })

  it('POSITIVE — with no pointer coordinates, Right then Right lands on In Progress then Done, and the drop moves the tile there', () => {
    const first = step(KeyboardCode.Right, 'todo')
    expect(first.over).toBe('in-progress')
    const second = step(KeyboardCode.Right, 'in-progress')
    expect(second.over).toBe('done')
    expect(boardDropTarget([{ id: 's1', column: 'todo' }], 's1', second.over)).toBe('done')
    // Left from Done comes back to In Progress, the same way.
    expect(step(KeyboardCode.Left, 'done').over).toBe('in-progress')
  })

  it('CONTROL — the same moved tile WITH a pointer inside Done is targeted by the pointer, so the null-pointer arm above is what made the keyboard land by corners', () => {
    expect(step(KeyboardCode.Right, 'todo', { x: 200, y: 530 }).over).toBe('done')
    expect(step(KeyboardCode.Right, 'todo').over).toBe('in-progress')
  })
})

describe('UA12.21 — the announcements are localized', () => {
  const locale = (lang: 'en' | 'ru') => JSON.parse(readFileSync(join(LOCALES_DIR, `${lang}.json`), 'utf8')) as Record<string, string>
  const tFrom = (messages: Record<string, string>) => (key: string, options: Record<string, string>) => {
    const template = messages[key]
    if (template === undefined) throw new Error(`missing key ${key}`)
    return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => options[name] ?? `{{${name}}}`)
  }
  const build = (lang: 'en' | 'ru') => boardDragAccessibility(
    tFrom(locale(lang)),
    () => 'Fix login',
    () => lang === 'en' ? 'ToDo' : 'К выполнению',
    id => (id === 'done' ? (lang === 'en' ? 'Done' : 'Готово') : String(id)),
  )

  for (const lang of ['en', 'ru'] as const) {
    it(`${lang}: every announcement names the task, and the column where there is one; the instructions exist`, () => {
      const { announcements, screenReaderInstructions } = build(lang)
      const active = { id: 's1' } as any
      const over = { id: 'done' } as any
      const said = [
        announcements.onDragStart({ active }),
        announcements.onDragOver({ active, over } as any),
        announcements.onDragOver({ active, over: null } as any),
        announcements.onDragEnd({ active, over } as any),
        announcements.onDragEnd({ active, over: null } as any),
        announcements.onDragCancel({ active, over: null } as any),
      ]
      for (const line of said) {
        expect(line).toContain('Fix login')
        expect(line).not.toContain('{{')
      }
      expect(said[1]).toContain(lang === 'en' ? 'Done' : 'Готово')
      expect(said[3]).toContain(lang === 'en' ? 'Done' : 'Готово')
      expect(screenReaderInstructions.draggable.length).toBeGreaterThan(20)
    })
  }

  it('ru is not the English text', () => {
    expect(build('ru').screenReaderInstructions.draggable).not.toBe(build('en').screenReaderInstructions.draggable)
  })
})

/**
 * UA12.21 follow-up (LF-6-fix, 2026-10-09) — Enter in the middle of a keyboard move.
 *
 * Focus stays on the picked-up card while only the overlay clone moves, so the card's own Enter handler sees every
 * key of the move. Before this fix it opened the task (the app left the board) while dnd-kit, which had no use for
 * Enter, kept the drag running with its document listener attached and the board gone: the next Space or Tab typed
 * anywhere was swallowed and ended that hidden drag through the unmounted board's `handleDragEnd`, writing the
 * column and its drop status off screen. Three arms, each red against 6dd92fb5a for that reason:
 *
 *  - the card does not open on Enter while it is being dragged (it still does at rest);
 *  - Enter ends a keyboard move, dnd-kit's own default (the REAL sensor, driven on a fake window);
 *  - `cancelBoardDrag` — the board's unmount cleanup — cancels a live sensor through dnd-kit's own resize cancel, so
 *    a later key is neither swallowed nor a drop.
 */
let probeI18n: I18nInstance
beforeAll(async () => {
  probeI18n = createInstance()
  await probeI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8')) } },
    interpolation: { escapeValue: false },
  })
})

const TODO_STATUS: SessionStatus = { id: 'todo', label: 'TODO', resolvedColor: '#888888', icon: null, iconColorable: true, category: 'open' }

/** The tile card (`role="button"` with the key handler) inside the element tree TaskTile returns. */
function findCard(node: unknown): { props: { onKeyDown: (e: unknown) => void } } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findCard(child)
      if (hit) return hit
    }
    return null
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return null
  const props = (node as { props: Record<string, unknown> }).props
  if (props.role === 'button' && typeof props.onKeyDown === 'function') return node as never
  return findCard(props.children)
}

/** Press a key on a rendered tile's card; returns how many times the tile asked to open. */
function pressOnTile(key: string, dragging: boolean): number {
  const [task] = deriveBoardTasks(
    new Map([['s1', { id: 's1', workspaceId: 'ws', name: 'Fix login', sessionStatus: 'todo' } as never]]),
    new Map([[TODO_STATUS.id, TODO_STATUS]]),
  )
  let opened = 0
  let card: ReturnType<typeof findCard> = null
  const props = { task: task!, status: TODO_STATUS, treatment: 'stripe', expanded: false, onClick: () => { opened += 1 }, dragging }
  // TaskTile is called inside a component so its hooks run in a render; the returned tree carries the card's handler.
  function Probe() {
    const tree = (TaskTile as (p: unknown) => React.ReactElement)(props)
    card = findCard(tree)
    return tree
  }
  renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: probeI18n }, React.createElement(Probe)))
  if (!card) throw new Error('tile card not found')
  ;(card as NonNullable<ReturnType<typeof findCard>>).props.onKeyDown({ key, preventDefault: () => {} })
  return opened
}

/** A window/document pair dnd-kit's DOM helpers accept, with a KeyboardEvent class (bun has none). */
function fakeWindow() {
  class FakeKeyboardEvent extends Event {
    code: string
    key: string
    constructor(type: string, init: { code: string; key: string }) {
      super(type, { cancelable: true })
      this.code = init.code
      this.key = init.key
    }
  }
  const win = new EventTarget() as EventTarget & Record<string, unknown>
  Object.defineProperty(win, Symbol.toStringTag, { value: 'Window' })
  const doc = new EventTarget() as EventTarget & Record<string, unknown>
  doc.nodeType = 9
  doc.ownerDocument = { defaultView: win }
  win.document = doc
  win.KeyboardEvent = FakeKeyboardEvent
  const key = (code: string, key = code) => {
    const event = new FakeKeyboardEvent('keydown', { code, key })
    doc.dispatchEvent(event)
    return event
  }
  return { win, key }
}

/** The real board sensor, started on the fake window; resolves once its keydown listener is attached. */
async function liveSensor(win: EventTarget) {
  const calls = { end: 0, cancel: 0 }
  const props = {
    active: 's1',
    activeNode: { node: { current: null } },
    event: { target: win },
    context: { current: { over: { id: 'in-progress' }, collisionRect: null, droppableRects: new Map(), scrollableAncestors: [] } },
    options: { keyboardCodes: BOARD_KEYBOARD_CODES, coordinateGetter: coordinates },
    onStart: () => {},
    onMove: () => {},
    onEnd: () => { calls.end += 1 },
    onCancel: () => { calls.cancel += 1 },
  }
  new (BoardKeyboardSensor as unknown as new (p: unknown) => object)(props)
  await new Promise(resolve => setTimeout(resolve, 0)) // dnd-kit attaches the keydown listener on the next tick
  return calls
}

describe('UA12.21 follow-up — Enter in the middle of a keyboard move', () => {
  it('the card does not open on Enter while it is being dragged; at rest it does, and Space never opens it', () => {
    expect(pressOnTile('Enter', true)).toBe(0)
    expect(pressOnTile('Enter', false)).toBe(1)
    expect(pressOnTile(' ', false)).toBe(0)
  })

  it('Enter ends a keyboard move (the real sensor): the drop, not a no-op that leaves the drag running', async () => {
    const { win, key } = fakeWindow()
    const calls = await liveSensor(win)
    const enter = key(KeyboardCode.Enter, 'Enter')
    expect(calls).toEqual({ end: 1, cancel: 0 })
    expect(enter.defaultPrevented).toBe(true)
    // Detached after the drop: a later Space is the page's again.
    expect(key(KeyboardCode.Space, ' ').defaultPrevented).toBe(false)
    expect(calls.end).toBe(1)
  })

  it('cancelBoardDrag (the board\'s unmount cleanup) cancels a live move: no drop, and the next Space is not swallowed', async () => {
    const { win, key } = fakeWindow()
    const calls = await liveSensor(win)
    expect(typeof boardDrag.cancelBoardDrag).toBe('function')
    boardDrag.cancelBoardDrag(win)
    expect(calls).toEqual({ end: 0, cancel: 1 })
    expect(key(KeyboardCode.Space, ' ').defaultPrevented).toBe(false)
    expect(key(KeyboardCode.Tab, 'Tab').defaultPrevented).toBe(false)
    expect(calls).toEqual({ end: 0, cancel: 1 })
  })

  it('control: with no cleanup, a live move swallows the next Space and drops (the defect\'s own path)', async () => {
    const { win, key } = fakeWindow()
    const calls = await liveSensor(win)
    expect(key(KeyboardCode.Space, ' ').defaultPrevented).toBe(true)
    expect(calls).toEqual({ end: 1, cancel: 0 })
  })

  it('the wiring: the column hands the drag state to the card, and the board cancels a live drag when it unmounts', () => {
    expect(source('KanbanColumn.tsx')).toContain('dragging={dragging}')
    expect(source('TaskTile.tsx')).toContain("if (e.key === 'Enter' && !dragging) {")
    const board = source('KanbanBoard.tsx')
    expect(board).toMatch(/return \(\) => \{\s*if \(activeIdRef\.current !== null\) cancelBoardDrag\(window\)\s*\}/)
  })
})

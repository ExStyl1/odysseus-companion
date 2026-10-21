/**
 * UB14.52 (R2-15, R4-03; upstream v0.15.0/v0.15.1 `kanban/KanbanBoard.tsx`, `KanbanColumn.tsx`, `NewTaskComposer.tsx`,
 * `BoardListToggle.tsx`) — the board and its columns on the redesign.
 *
 * - The column header's "+" opens the inline New Task composer (`open`/`onOpenChange`, R4-03); the dashed
 *   "+ New Task" button of v0.13.4 is gone, so a closed composer renders nothing.
 * - Enter in the open composer creates the tile and keeps the field open for the next one.
 * - While a card is dragged, every column it does not sit in gets its RECENCY slot as `dropIndicatorIndex` (cards sort
 *   newest-first, so the drop bar shows where the card will really go); the column it sits in gets none.
 * - Each column's `homeStatusId` is its drop status, else a built-in column's own id (the tile reads it in UB14.60).
 * - The List ⇄ Board switch is v0.15.1's segmented control: `role="group"`, icon segments named by `aria-label`.
 *
 * No DOM in this repo's `bun test`: interactions run the REAL handlers through React's own state machinery — the
 * component is called inside a probe component (its hooks run in the probe's render, as `board-keyboard-drag.test.ts`
 * does for the tile card), the handler is invoked DURING that render, and React re-renders the probe with the updated
 * state (a render-phase update, which the server renderer supports). Nothing is stubbed.
 */
import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DndContext } from '@dnd-kit/core'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@nessy-agent/ui/ui/tooltip'
import type { SessionStatus } from '@/config/session-status-config'
import { BoardListToggle } from '../BoardListToggle'
import { KanbanBoard } from '../KanbanBoard'
import { KanbanColumn } from '../KanbanColumn'
import { NewTaskComposer } from '../NewTaskComposer'
import { KANBAN_COLUMNS } from '../status-column'
import type { KanbanColumnMeta, KanbanTask } from '../types'

const KANBAN_DIR = join(import.meta.dir, '..')
const LOCALES_DIR = join(KANBAN_DIR, '..', '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8')) as Record<string, string>

let testI18n: I18nInstance
beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
})

const TODO: SessionStatus = { id: 'todo', label: 'TODO', resolvedColor: '#888888', icon: null, iconColorable: true, category: 'open' }
const STATUSES_BY_ID = new Map([[TODO.id, TODO]])

type AnyElement = React.ReactElement<Record<string, unknown>>

/** Every element in a returned tree (depth-first through `props.children`), function-component elements unexpanded. */
function elements(node: unknown, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out)
    return out
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return out
  out.push(node as AnyElement)
  elements((node as AnyElement).props.children, out)
  return out
}

/**
 * Render `component(props)` inside a probe; `act(tree, pass)` runs during each render pass on the tree the component
 * returned (pass 0, 1, …), so a handler it calls updates state and React renders the probe again.
 */
function probe<P>(component: (props: P) => React.ReactNode, props: P, act: (tree: AnyElement[], pass: number) => void): { html: string; passes: AnyElement[][] } {
  const passes: AnyElement[][] = []
  function Probe() {
    const tree = component(props)
    const flat = elements(tree)
    passes.push(flat)
    act(flat, passes.length - 1)
    return tree as React.ReactElement
  }
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <TooltipProvider>
        <DndContext>
          <Probe />
        </DndContext>
      </TooltipProvider>
    </I18nextProvider>
  )
  return { html, passes }
}

const NEW_TASK = en['kanban.newTask']!
const NEW_TASK_TITLE = en['kanban.newTaskTitle']!

function columnProps(onCreateTask?: (title: string) => void): React.ComponentProps<typeof KanbanColumn> {
  return {
    column: KANBAN_COLUMNS[0]!,
    tasks: [],
    projectsById: new Map(),
    statusesById: STATUSES_BY_ID,
    treatment: 'stripe',
    expandedTaskIds: new Set(),
    onCreateTask,
  }
}

describe('UB14.52 — the column header "+" opens the New Task composer (R4-03)', () => {
  it('NEGATIVE (control) — closed, the column draws its header "+" and no field, and no dashed "+ New Task" button anywhere', () => {
    const { html } = probe(KanbanColumn, columnProps(() => {}), () => {})
    expect(html).toContain(`aria-label="${NEW_TASK}"`)
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('border-dashed')
    // The neutral well replaced the coloured tint: no inline background on the column body, the well's own fill.
    expect(html).toContain('rounded-lg bg-fill-hover p-2')
    expect(html).not.toContain('background-color')
  })

  it('POSITIVE — pressing the header "+" opens the sunken composer field at the top of the column', () => {
    let pressed = 0
    const { html } = probe(KanbanColumn, columnProps(() => {}), (tree, pass) => {
      if (pass !== 0) return
      const plus = tree.find(el => el.props['aria-label'] === NEW_TASK && typeof el.props.onClick === 'function')
      if (!plus) throw new Error('no header "+" in the column')
      ;(plus.props.onClick as () => void)()
      pressed += 1
    })
    expect(pressed).toBe(1)
    expect(html).toContain('<textarea')
    expect(html).toContain(`placeholder="${NEW_TASK_TITLE}"`)
    expect(html).toContain('field-surface')
  })

  it('BOUNDARY — a column the board gives no `onCreateTask` (every column but the first) has no "+" and no field', () => {
    const { html } = probe(KanbanColumn, columnProps(undefined), () => {})
    expect(html).not.toContain(`aria-label="${NEW_TASK}"`)
    expect(html).not.toContain('<textarea')
  })
})

describe('UB14.52 — NewTaskComposer (v0.15.1, open/onOpenChange)', () => {
  const textarea = (tree: AnyElement[]) => {
    const el = tree.find(node => node.type === 'textarea')
    if (!el) throw new Error('no textarea')
    return el.props as { onChange: (e: unknown) => void; onKeyDown: (e: unknown) => void; onBlur: () => void }
  }
  const key = (k: string, shiftKey = false) => ({ key: k, shiftKey, preventDefault: () => {} })

  /** Type `title` on pass 0, then run `then` on pass 1; returns what the composer reported. */
  function drive(title: string, then: (field: ReturnType<typeof textarea>) => void) {
    const created: string[] = []
    const openChanges: boolean[] = []
    const { html } = probe(NewTaskComposer, { open: true, onOpenChange: open => openChanges.push(open), onCreate: t => created.push(t) }, (tree, pass) => {
      if (pass === 0) textarea(tree).onChange({ target: { value: title } })
      else if (pass === 1) then(textarea(tree))
    })
    return { created, openChanges, html }
  }

  it('POSITIVE — Enter creates the tile from the typed title and keeps the field open (cleared) for the next one', () => {
    const { created, openChanges, html } = drive('  Ship the board  ', field => field.onKeyDown(key('Enter')))
    expect(created).toEqual(['Ship the board'])
    expect(openChanges).toEqual([])
    expect(html).toContain('<textarea')
    expect(html).not.toContain('Ship the board')
  })

  it('BOUNDARY — Shift+Enter is a newline, not a create; Escape discards and closes; an empty Enter closes', () => {
    expect(drive('Draft', field => field.onKeyDown(key('Enter', true))).created).toEqual([])
    const escaped = drive('Draft', field => field.onKeyDown(key('Escape')))
    expect(escaped.created).toEqual([])
    expect(escaped.openChanges).toEqual([false])
    const empty = drive('   ', field => field.onKeyDown(key('Enter')))
    expect(empty.created).toEqual([])
    expect(empty.openChanges).toEqual([false])
  })

  it('POSITIVE — blurring with a title commits it and closes', () => {
    const blurred = drive('Typed then left', field => field.onBlur())
    expect(blurred.created).toEqual(['Typed then left'])
    expect(blurred.openChanges).toEqual([false])
  })

  it('NEGATIVE — closed, it renders nothing at all: no field and no stray dashed button', () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <NewTaskComposer open={false} onOpenChange={() => {}} onCreate={() => {}} />
      </I18nextProvider>
    )
    expect(html).toBe('')
    // Control: the same element open draws the field, so the empty reading is the state, not a broken render.
    const open = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <NewTaskComposer open onOpenChange={() => {}} onCreate={() => {}} />
      </I18nextProvider>
    )
    expect(open).toContain('<textarea')
  })
})

describe('UB14.52 — the drop bar marks the dragged card\'s recency slot', () => {
  const tile = (id: string, column: string, createdAt: number): KanbanTask =>
    ({ id, title: `Tile ${id}`, column, statusId: 'todo', createdAt, subtasks: [] }) as KanbanTask
  // To Do sorts newest-first: a(30) · b(20) · c(10). Done holds d(25). In Progress is empty.
  const TASKS = [tile('a', 'todo', 30), tile('b', 'todo', 20), tile('c', 'todo', 10), tile('d', 'done', 25)]

  /** The board's columns as it hands them out, after `onDragStart` for `dragId` (or no drag). */
  function columnsDuring(dragId: string | null, extra: Partial<React.ComponentProps<typeof KanbanBoard>> = {}) {
    const props: React.ComponentProps<typeof KanbanBoard> = {
      columns: KANBAN_COLUMNS,
      tasks: TASKS,
      projectsById: new Map(),
      statusesById: STATUSES_BY_ID,
      expandedTaskIds: new Set(),
      ...extra,
    }
    const { passes } = probe(KanbanBoard, props, (tree, pass) => {
      if (pass !== 0 || dragId === null) return
      const context = tree.find(el => el.type === DndContext)
      if (!context) throw new Error('no DndContext in the board')
      ;(context.props.onDragStart as (e: unknown) => void)({ active: { id: dragId } })
    })
    const last = passes[passes.length - 1]!
    return new Map(
      last.filter(el => el.type === KanbanColumn).map(el => {
        const p = el.props as { column: KanbanColumnMeta; dropIndicatorIndex?: number; homeStatusId?: string }
        return [p.column.id, p] as const
      })
    )
  }

  it('POSITIVE — dragging Done\'s d (25) over To Do lands between a (30) and b (20): slot 1; the empty In Progress offers slot 0', () => {
    const columns = columnsDuring('d')
    expect(columns.get('todo')?.dropIndicatorIndex).toBe(1)
    expect(columns.get('in-progress')?.dropIndicatorIndex).toBe(0)
  })

  it('NEGATIVE — no bar in the column the card already sits in, and none anywhere before a drag starts', () => {
    expect(columnsDuring('d').get('done')?.dropIndicatorIndex).toBeUndefined()
    const idle = columnsDuring(null)
    expect([...idle.values()].map(c => c.dropIndicatorIndex)).toEqual([undefined, undefined, undefined])
  })

  it('BOUNDARY — the newest card goes on top of another column (slot 0); the oldest card goes after its last tile (slot = count)', () => {
    expect(columnsDuring('a').get('done')?.dropIndicatorIndex).toBe(0)
    const oldest = columnsDuring('c')
    expect(oldest.get('done')?.dropIndicatorIndex).toBe(1)
    expect(oldest.get('todo')?.dropIndicatorIndex).toBeUndefined()
  })

  it('homeStatusId — the drop status when set, else a built-in column\'s own id; a custom column without one has none', () => {
    const builtIn = columnsDuring(null, { columnDropStatus: { done: 'cancelled' } })
    expect(builtIn.get('todo')?.homeStatusId).toBe('todo')
    expect(builtIn.get('in-progress')?.homeStatusId).toBe('in-progress')
    expect(builtIn.get('done')?.homeStatusId).toBe('cancelled')
    const custom = columnsDuring(null, {
      columns: [{ id: 'col-review', name: 'Review' }, { id: 'col-ship', name: 'Ship', dropStatusId: 'done' }],
    })
    expect(custom.get('col-review')?.homeStatusId).toBeUndefined()
    expect(custom.get('col-ship')?.homeStatusId).toBe('done')
  })
})

describe('UB14.52 — the List ⇄ Board switch is v0.15.1\'s segmented control', () => {
  const render = (value: 'list' | 'board') =>
    renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <TooltipProvider>
          <BoardListToggle value={value} onChange={() => {}} />
        </TooltipProvider>
      </I18nextProvider>
    )

  it('POSITIVE — a role="group" well with two icon segments named by aria-label; the selected one is pressed and raised', () => {
    const html = render('board')
    expect(html).toContain('role="group"')
    expect(html).toContain('bg-fill-hover')
    expect(html).toMatch(new RegExp(`aria-pressed="false" aria-label="${en['kanban.list']}"`))
    expect(html).toMatch(new RegExp(`aria-pressed="true" aria-label="${en['kanban.board']}"[^>]*bg-floating`))
  })

  it('NEGATIVE — the segments carry no visible text label any more (icons only), and flipping the value flips the press', () => {
    const html = render('list')
    expect(html).not.toContain(`>${en['kanban.board']}<`)
    expect(html).not.toContain(`>${en['kanban.list']}<`)
    expect(html).toMatch(new RegExp(`aria-pressed="true" aria-label="${en['kanban.list']}"`))
  })
})

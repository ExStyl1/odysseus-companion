/**
 * UA2.7 — the board's DOM hooks the RS-110 sitting case reads (`scripts/cdp/cases/rs-110.ts`).
 *
 * The packaged sitting drags a tile into the Done column and then reads WHICH column the tile is
 * rendered in, by session id and column id. Upstream's markup carries neither (a column is a styled
 * `div`, a tile wrapper is the dnd-kit draggable `div`), so a case could only find them by class
 * names or by localised copy. Two attributes, added line for line in `KanbanColumn.tsx`:
 *
 * - `data-kanban-column="<column id>"` on each column's root;
 * - `data-kanban-task="<session id>"` on each tile's draggable wrapper.
 *
 * Rendered with `renderToStaticMarkup` through the real `KanbanBoard` (no DOM in this repo's
 * `bun test`), as `board-derive.test.tsx` does. The negative arm is the board's own fallback: a tile
 * whose stored column no longer exists is rendered under the FIRST column's hook, so the case's
 * "rendered in Done" reading cannot be satisfied by a tile the board put elsewhere.
 *
 * UA12.151 — the subtask list's expand toggle carries `data-kanban-subtasks-toggle`. SIT-D's live
 * re-probes (work/sitting5/SIT-D, F1) found the toggle with `button[aria-expanded]` and clicked the
 * FIRST such button in the tile — the status picker's Radix `PopoverTrigger` (Radix arms every
 * popover trigger with `aria-expanded`), which sits earlier in the markup. The click opened the
 * status menu, ITS `aria-expanded` flipped to "true", and the subtask list never expanded — so every
 * row read came back empty while the tile's progress ("0/2" → "2/2") showed the rows were derived
 * all along. The hook gives drivers the unambiguous target the `data-kanban-*` family exists for
 * (UA2.7), and the trap arm pins WHY `button[aria-expanded]` can never be that target.
 * UB14.60 (v0.15.1's card): the status picker moved into the meta row, AFTER the toggle, and a card in its own
 * column's status draws no picker at all — so which button `button[aria-expanded]` hits first now depends on the
 * card's status and the anatomy. The trap arm is re-pinned to that: two matches whenever the picker shows, one when
 * it does not, in an order the hook does not depend on.
 */
import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionMeta } from '@/atoms/sessions'
import type { SessionStatus } from '@/config/session-status-config'
import { deriveBoardTasks } from '../board-derive'
import { KanbanBoard } from '../KanbanBoard'
import { KANBAN_COLUMNS } from '../status-column'

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

function render(metas: SessionMeta[]): string {
  const tasks = deriveBoardTasks(new Map(metas.map(m => [m.id, m])), STATUSES_BY_ID)
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <KanbanBoard
        columns={KANBAN_COLUMNS}
        tasks={tasks}
        projectsById={new Map()}
        statusesById={STATUSES_BY_ID}
        expandedTaskIds={new Set()}
      />
    </I18nextProvider>
  )
}

/** The markup of one column, from its hook to the next column's hook (or the end). */
function columnSlice(html: string, columnId: string): string {
  const start = html.indexOf(`data-kanban-column="${columnId}"`)
  if (start < 0) return ''
  const next = html.indexOf('data-kanban-column="', start + 1)
  return html.slice(start, next < 0 ? undefined : next)
}

describe('UA2.7 — the board DOM hooks the RS-110 case reads', () => {
  it('POSITIVE — every built-in column carries its id, in board order', () => {
    const html = render([])
    const ids = [...html.matchAll(/data-kanban-column="([^"]+)"/g)].map(match => match[1])
    expect(ids).toEqual(KANBAN_COLUMNS.map(column => column.id))
  })

  it('POSITIVE — a tile placed in Done is rendered inside the Done column, under its session id', () => {
    const html = render([{ id: 'sess-done', workspaceId: 'ws', name: 'Placed', sessionStatus: 'todo', kanbanColumn: 'done' }])
    expect(columnSlice(html, 'done')).toContain('data-kanban-task="sess-done"')
    expect(columnSlice(html, 'todo')).not.toContain('data-kanban-task="sess-done"')
  })

  it('NEGATIVE — a tile whose stored column no longer exists is under the FIRST column, not where it was stored', () => {
    const html = render([{ id: 'sess-gone', workspaceId: 'ws', name: 'Stale', sessionStatus: 'todo', kanbanColumn: 'retired-column' }])
    expect(columnSlice(html, 'todo')).toContain('data-kanban-task="sess-gone"')
    expect(columnSlice(html, 'done')).not.toContain('data-kanban-task="sess-gone"')
    expect(html).not.toContain('data-kanban-column="retired-column"')
  })
})

describe('UA12.151 — the subtask list expands through an unambiguous toggle hook', () => {
  const STATUSES = [TODO]
  /** The tile's markup, from its wrapper hook to the end (the last tile in the only board). */
  // UB14.60: by default the orchestrator sits in In Progress with status Todo, so its card shows the status picker
  // (a status other than the column's); `ownColumn` parks it in Todo, where the picker is skipped.
  const renderTile = (expanded: boolean, ownColumn = false): string => {
    const orch: SessionMeta = {
      id: 'orch', workspaceId: 'ws', name: 'Orchestrator', sessionStatus: 'todo', taskSlug: 'ship',
      ...(ownColumn ? {} : { kanbanColumn: 'in-progress' }),
    }
    const child: SessionMeta = { id: 'c1', workspaceId: 'ws', name: 'Ran child', parentSessionId: 'orch', taskNodeId: 'b', taskSlug: 'ship', messageCount: 1 }
    const tasks = deriveBoardTasks(
      new Map([[orch.id, orch], [child.id, child]]),
      STATUSES_BY_ID,
      { specNodesBySlug: new Map([['ship', [{ id: 'a', title: 'Authored node' }, { id: 'b', title: 'Ran node' }]]]) }
    )
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <KanbanBoard
          columns={KANBAN_COLUMNS}
          tasks={tasks}
          projectsById={new Map()}
          statusesById={STATUSES_BY_ID}
          statuses={STATUSES}
          onChangeStatus={() => {}}
          onToggleSubtasks={() => {}}
          onSubtaskClick={() => {}}
          expandedTaskIds={new Set(expanded ? ['orch'] : [])}
        />
      </I18nextProvider>
    )
    const start = html.indexOf('data-kanban-task="orch"')
    expect(start).toBeGreaterThan(-1)
    return html.slice(start)
  }

  it('THE TRAP (re-pinned by UB14.60) — `button[aria-expanded]` matches the status picker AND the toggle whenever the picker shows; their order is the anatomy\'s', () => {
    const tile = renderTile(false)
    // Every button tag carrying aria-expanded, in markup order.
    const expandedButtons = tile.match(/<button[^>]*aria-expanded[^>]*>/g) ?? []
    expect(expandedButtons.length).toBeGreaterThanOrEqual(2)
    // v0.15.1's meta row puts the status picker's Radix trigger AFTER the toggle (v0.13.4 put it before — what SIT-D's
    // `button[aria-expanded]` click hit); either way the selector is ambiguous, so drivers keep the hook.
    const pickerIndex = expandedButtons.findIndex(tag => tag.includes(`aria-label="${en['kanban.changeStatus']}"`))
    const toggleIndex = expandedButtons.findIndex(tag => tag.includes(`aria-label="${en['kanban.subtasks']}"`))
    expect(toggleIndex).toBe(0)
    expect(pickerIndex).toBeGreaterThan(toggleIndex)
    // In its own column's status the card skips the picker: the selector then matches the toggle alone.
    const own = renderTile(false, true).match(/<button[^>]*aria-expanded[^>]*>/g) ?? []
    expect(own).toHaveLength(1)
    expect(own[0]).toContain('data-kanban-subtasks-toggle')
  })

  it('POSITIVE — the subtasks toggle carries data-kanban-subtasks-toggle (the unambiguous target)', () => {
    const collapsed = renderTile(false)
    const collapsedToggle = collapsed.match(/<button[^>]*data-kanban-subtasks-toggle[^>]*>/)?.[0]
    expect(collapsedToggle).toBeDefined()
    expect(collapsedToggle).toContain(`aria-label="${en['kanban.subtasks']}"`)
    expect(collapsedToggle).toContain('aria-expanded="false"')
    const expandedToggle = renderTile(true).match(/<button[^>]*data-kanban-subtasks-toggle[^>]*>/)?.[0]
    expect(expandedToggle).toContain('aria-expanded="true"')
  })

  it('POSITIVE — expanded, the tile renders the synthetic spec row and the session-backed row under it', () => {
    const tile = renderTile(true)
    expect(tile).toContain('Authored node') // synthetic `node:a` row (never run)
    expect(tile).toContain('Ran child') // session-backed row (the child session's title)
    // Only the session-backed row is a button (SubtaskRow renders role="button" when it opens a session).
    expect(tile).toMatch(new RegExp(`<div role="button"[\\s\\S]{0,900}?Ran child`))
    expect(tile).not.toMatch(new RegExp(`<div role="button"[\\s\\S]{0,900}?Authored node`))
  })

  it('CONTROL — collapsed, neither row renders (the arms above can fail)', () => {
    const tile = renderTile(false)
    expect(tile).not.toContain('Authored node')
    expect(tile).not.toContain('Ran child')
  })
})

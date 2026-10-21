/**
 * UA5.10 — per-project columns, the board's project filter ("No project"), the scoped jump, the task's project.
 *
 * The container's rules are `project-columns.ts`'s pure functions (lifted from v0.13.4 `KanbanBoardContainer.tsx`),
 * pinned here directly; the column editor and the "add column" control are rendered through the real
 * `KanbanBoard` with `renderToStaticMarkup`, as `board-dom-hooks.test.tsx` does (no DOM in this repo's `bun test`).
 *
 * - POSITIVE: the first edit seeds the built-in columns (built-in ids, labels in the current language) and the
 *   seeded set passes the project store's own schema; removing a column reassigns its cards to the first
 *   remaining column; a focused project's columns replace the built-ins; the editor and "add column" render only
 *   when the container passes their callbacks.
 * - NEGATIVE: the last column cannot be removed (no plan, and the board offers no remove); a project filter hides
 *   unbound tiles unless "No project" is selected; "No project" never binds a new task nor focuses a project.
 * - The scoped jump (`withTaskScopeFilters`): replaces the All Sessions label and project filters, keeps its
 *   statuses and grouping, leaves other views alone.
 */
import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@nessy-agent/ui/ui/tooltip'
import { KanbanColumnsSchema } from '@nessy-agent/shared/projects'
import type { SessionStatus } from '@/config/session-status-config'
import { KanbanBoard } from '../KanbanBoard'
import { KANBAN_COLUMNS } from '../status-column'
import {
  KANBAN_UNASSIGNED_PROJECT,
  editableColumns,
  filterTasksByProject,
  firstFilteredProjectId,
  focusedProjectOf,
  planColumnRemoval,
  pruneProjectFilter,
  resolveActiveColumns,
  withAddedColumn,
  withUpdatedColumn,
  type BoardProject,
} from '../project-columns'
import { expandLabelFilterIds, hasLiveLabelFilter, isDeletedLabelView, withTaskScopeFilters } from '../../task-scope-filters'
import * as labelsHook from '@/hooks/useLabels'
import type { KanbanColumnMeta, KanbanTask } from '../types'

const KANBAN_DIR = join(import.meta.dir, '..')
const LOCALES_DIR = join(KANBAN_DIR, '..', '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8')) as Record<string, string>
const tEn = (key: string) => en[key] ?? key

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

const project = (id: string, kanbanColumns?: BoardProject['config']['kanbanColumns']): BoardProject => ({
  config: { id, slug: id, name: `Project ${id}`, ...(kanbanColumns ? { kanbanColumns } : {}) },
})

const tile = (id: string, column: string, projectId?: string) => ({ id, column, ...(projectId ? { projectId } : {}) })

describe('UA5.10 — per-project columns', () => {
  it('POSITIVE: the first edit seeds the built-in columns (built-in ids, translated names), valid for the project store', () => {
    const seeded = editableColumns(project('p1'), resolveActiveColumns(project('p1')), tEn)
    expect(seeded.map(c => c.id)).toEqual(['todo', 'in-progress', 'done'])
    expect(seeded.map(c => c.name)).toEqual(['ToDo', 'In Progress', 'Done'])
    const added = withAddedColumn(seeded, 'col-1a2b3c4d', tEn('kanban.column.newColumnName'))
    expect(added.map(c => c.id)).toEqual(['todo', 'in-progress', 'done', 'col-1a2b3c4d'])
    expect(added[3]!.name).toBe('New column')
    // The set the container persists is one the host accepts (projects/storage.ts, `project-columns-invalid` otherwise).
    expect(KanbanColumnsSchema.safeParse(added).success).toBe(true)
  })

  it('POSITIVE: a project with custom columns edits ITS set (a copy), and they replace the built-ins on the board', () => {
    const custom = [{ id: 'backlog', name: 'Backlog' }, { id: 'ship', name: 'Ship', color: '#6366f1', dropStatusId: 'done' }]
    const p = project('p1', custom)
    const editable = editableColumns(p, resolveActiveColumns(p), tEn)
    expect(editable).toEqual(custom)
    expect(editable[0]).not.toBe(custom[0])
    expect(resolveActiveColumns(p)).toEqual([
      { id: 'backlog', name: 'Backlog', color: undefined, dropStatusId: undefined },
      { id: 'ship', name: 'Ship', color: '#6366f1', dropStatusId: 'done' },
    ])
    expect(withUpdatedColumn(editable, 'ship', { name: 'Shipped' }).map(c => c.name)).toEqual(['Backlog', 'Shipped'])
    // Boundary: no focused project, or one with an empty set, is the built-in board.
    expect(resolveActiveColumns(undefined)).toBe(KANBAN_COLUMNS)
    expect(resolveActiveColumns(project('p2', []))).toBe(KANBAN_COLUMNS)
  })

  it('POSITIVE: removing a column reassigns its cards to the first remaining column', () => {
    const base = editableColumns(project('p1'), KANBAN_COLUMNS, tEn)
    const plan = planColumnRemoval(base, 'todo', [tile('a', 'todo'), tile('b', 'done'), tile('c', 'todo')])
    expect(plan?.remaining.map(c => c.id)).toEqual(['in-progress', 'done'])
    expect(plan?.reassign).toEqual([{ taskId: 'a', toColumn: 'in-progress' }, { taskId: 'c', toColumn: 'in-progress' }])
  })

  it('NEGATIVE: the last column cannot be removed; an unknown column id plans nothing', () => {
    expect(planColumnRemoval([{ id: 'only', name: 'Only' }], 'only', [tile('a', 'only')])).toBeNull()
    expect(planColumnRemoval([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 'gone', [])).toBeNull()
    // Control: two columns, one removable — the same call plans.
    expect(planColumnRemoval([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 'a', [])).not.toBeNull()
  })
})

describe('UA5.10 — the column editor on the board', () => {
  const TODO: SessionStatus = { id: 'todo', label: 'TODO', resolvedColor: '#888888', icon: null, iconColorable: true, category: 'open' }

  function render(columns: readonly KanbanColumnMeta[], editor: boolean): string {
    const noop = () => {}
    // UB14.52: the add-column control is v0.15.1's IconButton with a tooltip, which needs the app root's provider.
    return renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <TooltipProvider>
          <KanbanBoard
            columns={columns}
            tasks={[] as KanbanTask[]}
            projectsById={new Map()}
            statusesById={new Map([[TODO.id, TODO]])}
            statuses={[TODO]}
            expandedTaskIds={new Set()}
            onSelectDropStatus={noop}
            {...(editor ? { onUpdateColumn: noop, onRemoveColumn: noop, onAddColumn: noop } : {})}
          />
        </TooltipProvider>
      </I18nextProvider>
    )
  }

  it('POSITIVE: with the editor callbacks, each column opens "Edit column" and the board offers "Add column"', () => {
    const html = render(resolveActiveColumns(project('p1', [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }])), true)
    expect(html.match(/title="Edit column"/g)?.length).toBe(2)
    // UB14.52: the add control is named by its aria-label (v0.15.1's IconButton), no longer a title.
    expect(html).toContain('aria-label="Add column"')
    expect(html).toContain('Alpha')
  })

  it('NEGATIVE: without them (the all-projects view) the header only sets the drop status and nothing adds a column', () => {
    const html = render(KANBAN_COLUMNS, false)
    expect(html).not.toContain('title="Edit column"')
    expect(html).not.toContain('aria-label="Add column"')
    // Control: the same render shows the drop-status picker the detector would otherwise miss.
    expect(html.match(/title="Set status when moved here"/g)?.length).toBe(3)
  })
})

describe('UA5.10 — the board project filter and "No project"', () => {
  const live = new Set(['p1', 'p2'])
  const tasks = [tile('in-p1', 'todo', 'p1'), tile('in-p2', 'todo', 'p2'), tile('unbound', 'todo'), tile('gone', 'todo', 'deleted')]

  it('POSITIVE: an empty filter shows every tile; a project shows its own; "No project" shows unbound and gone-project tiles', () => {
    expect(filterTasksByProject(tasks, [], live)).toBe(tasks)
    expect(filterTasksByProject(tasks, ['p1'], live).map(t => t.id)).toEqual(['in-p1'])
    expect(filterTasksByProject(tasks, [KANBAN_UNASSIGNED_PROJECT], live).map(t => t.id)).toEqual(['unbound', 'gone'])
    expect(filterTasksByProject(tasks, ['p2', KANBAN_UNASSIGNED_PROJECT], live).map(t => t.id)).toEqual(['in-p2', 'unbound', 'gone'])
  })

  it('NEGATIVE: under a project filter an unbound tile is hidden; "No project" never binds a task nor focuses a project', () => {
    expect(filterTasksByProject(tasks, ['p1'], live).some(t => t.projectId === undefined)).toBe(false)
    expect(firstFilteredProjectId([KANBAN_UNASSIGNED_PROJECT])).toBeUndefined()
    expect(firstFilteredProjectId([KANBAN_UNASSIGNED_PROJECT, 'p2', 'p1'])).toBe('p2')
    const projects = [project('p1'), project('p2')]
    expect(focusedProjectOf([KANBAN_UNASSIGNED_PROJECT], projects)).toBeUndefined()
    expect(focusedProjectOf(['p1', 'p2'], projects)).toBeUndefined()
    // Control: exactly one live project is in focus.
    expect(focusedProjectOf(['p2'], projects)?.config.id).toBe('p2')
  })

  it('BOUNDARY: pruning drops a deleted project, keeps "No project", and returns the same array when nothing changes', () => {
    const kept = ['p1', KANBAN_UNASSIGNED_PROJECT]
    expect(pruneProjectFilter(kept, live)).toBe(kept)
    expect(pruneProjectFilter(['p1', 'deleted', KANBAN_UNASSIGNED_PROJECT], live)).toEqual(['p1', KANBAN_UNASSIGNED_PROJECT])
    const empty: string[] = []
    expect(pruneProjectFilter(empty, live)).toBe(empty)
  })
})

describe('UA5.10 — the scoped jump (withTaskScopeFilters)', () => {
  it('POSITIVE: All Sessions gets the task label and project as include filters; statuses and grouping stay', () => {
    const prev = {
      allSessions: { statuses: { todo: 'include' as const }, labels: { bug: 'exclude' as const }, projects: { old: 'include' as const }, groupingMode: 'project' },
      flagged: { statuses: {}, labels: { x: 'include' as const } },
    }
    const next = withTaskScopeFilters(prev, { labelId: 'task-fix-login-1', projectId: 'p1' })
    expect(next.allSessions).toEqual({ statuses: { todo: 'include' }, labels: { 'task-fix-login-1': 'include' }, projects: { p1: 'include' }, groupingMode: 'project' })
    expect(next.flagged).toBe(prev.flagged)
  })

  it('NEGATIVE: an unbound task clears the project filter rather than keeping a stale one', () => {
    const next = withTaskScopeFilters({ allSessions: { statuses: {}, labels: {}, projects: { old: 'include' } } }, { labelId: 'task' })
    expect(next.allSessions!.projects).toEqual({})
    expect(next.allSessions!.labels).toEqual({ task: 'include' })
  })
})

/**
 * UA12.154 — AppShell's pre-filter expands one label-filter entry through this pure helper, which
 * drops an id no label config carries (a persisted filter naming a deleted label — SIT-D F4 —
 * must not blank All Sessions). The list's own second pass drops the same ids
 * (useSessionSearch, pinned by label-filter-tree.test.ts).
 */
describe('UA12.154 — expandLabelFilterIds drops ids the label config no longer carries', () => {
  const TREE = [
    { id: 'parent', name: 'Parent', children: [{ id: 'child', name: 'Child' }] },
    { id: 'solo', name: 'Solo' },
  ]

  it('POSITIVE — a live parent id expands to itself and its descendants', () => {
    expect(expandLabelFilterIds(TREE, 'parent')).toEqual(['parent', 'child'])
  })

  it('BOUNDARY — a live childless id expands to just itself', () => {
    expect(expandLabelFilterIds(TREE, 'solo')).toEqual(['solo'])
    expect(expandLabelFilterIds(TREE, 'child')).toEqual(['child'])
  })

  it('DEFECT (the SIT-D F4 shape) — an id no config carries matches nothing, so it cannot blank the list', () => {
    expect(expandLabelFilterIds(TREE, 'task-confirm-me-014241-7')).toEqual([])
    expect(expandLabelFilterIds([], 'parent')).toEqual([])
  })
})

/**
 * UA12.162 — the active-filters tint (and the clear affordances) key on LIVE label ids, not the
 * raw persisted map's size. UA12.154 made a dead id filter like no filter, but the filter-menu
 * button's tint still read `labelFilter.size > 0`, so a dead-only persisted filter (the F4
 * state) kept the accent tint and the clear-all affordance until any filter edit rewrote the
 * map. `hasLiveLabelFilter` is the same prune as the pre-filter memo, as a predicate: the UI
 * shows "filters active" exactly when a filter still narrows the list.
 *
 * These arms were written FIRST and fail at HEAD (no predicate; the JSX still keys on the raw
 * size). No DOM in this repo's `bun test`, so the wiring half is the two-headed source scan
 * (the tint expression must be gone from AppShell and the compact filter; the predicate's use
 * must be present), the same shape as UA12.145's page-toast pin.
 */
describe('UA12.162 — the filter tint keys on live label ids, not the raw persisted size', () => {
  const TREE = [
    { id: 'parent', name: 'Parent', children: [{ id: 'child', name: 'Child' }] },
    { id: 'solo', name: 'Solo' },
  ]
  const filters = (entries: [string, 'include' | 'exclude'][]) => new Map(entries)

  it('POSITIVE — a map with one live id has an active label filter', () => {
    expect(hasLiveLabelFilter(TREE, filters([['parent', 'include']]))).toBe(true)
    expect(hasLiveLabelFilter(TREE, filters([['child', 'exclude']]))).toBe(true)
  })

  it('CONTROL (the F4 state) — a dead-only map has none: no tint, no clear affordance', () => {
    expect(hasLiveLabelFilter(TREE, filters([['task-confirm-me-014241-7', 'include']]))).toBe(false)
    expect(hasLiveLabelFilter(TREE, filters([['gone-1', 'include'], ['gone-2', 'exclude']]))).toBe(false)
  })

  it('BOUNDARY — mixed live+dead is active; an empty map is not; modes do not matter', () => {
    expect(hasLiveLabelFilter(TREE, filters([['gone', 'include'], ['solo', 'exclude']]))).toBe(true)
    expect(hasLiveLabelFilter(TREE, filters([]))).toBe(false)
    expect(hasLiveLabelFilter([], filters([['parent', 'include']]))).toBe(false)
  })

  it('WIRING — the filter menu\u2019s tint expression keys on the live predicate, and the raw size survives only in AppShell\u2019s pre-filter memo', () => {
    // UB14.5 moved the dropdown (its tint, Clear and chips section) out of AppShell into SessionFilterMenu, v0.15.1's
    // file, whose own expression is the raw `labelFilter.size > 0` — UA12.162 is re-applied there.
    const menu = readFileSync(join(KANBAN_DIR, '..', 'SessionFilterMenu.tsx'), 'utf8')
    const appShell = readFileSync(join(KANBAN_DIR, '..', 'AppShell.tsx'), 'utf8')
    // The exact raw-size tint expression the row names is gone from every UI site:
    for (const source of [menu, appShell]) expect(source).not.toContain('listFilter.size > 0 || labelFilter.size > 0')
    // The live predicate is wired (the memo) and read by the tint, the Clear affordance and the chips section:
    expect(menu).toContain('hasLiveLabelFilter(labelConfigs, labelFilter)')
    expect((menu.match(/hasActiveLabelFilter/g) ?? []).length).toBeGreaterThanOrEqual(4)
    expect((menu.match(/labelFilter\.size > 0/g) ?? []).length).toBe(0)
    // The pre-filter memo legitimately keeps the raw iteration (it prunes inside):
    expect((appShell.match(/labelFilter\.size > 0/g) ?? []).length).toBe(1)
  })

  it('WIRING — the compact filter\u2019s hasUserFilter keys on the same live predicate', () => {
    const compact = readFileSync(join(KANBAN_DIR, '..', 'CompactSessionListFilter.tsx'), 'utf8')
    expect(compact).toContain('hasLiveLabelFilter(labelConfigs, labelFilter)')
  })

  it('LINES — the doc-cited CompactSessionListFilter.tsx:321-322 still name the unread row\u2019s radio and tap (imports go at the file end)', () => {
    // The file's own end-of-file note promises its imports land at the END so the lines above keep the
    // numbers the docs cite (capability-ledger, denominator-gaps: "chooser at CompactSessionListFilter.tsx:321-322").
    // d37ce72b6 added an import and a comment above them (+3); the 2026-10-08 verification follow-up restores them.
    const lines = readFileSync(join(KANBAN_DIR, '..', 'CompactSessionListFilter.tsx'), 'utf8').split('\n')
    expect(lines[320]?.trim()).toBe("radioSelected={chatGroupingMode === 'unread'}")
    expect(lines[321]?.trim()).toBe("onTap={() => setChatGroupingMode('unread')}")
  })
})

/**
 * UA12.164 — the pinned sidebar route `label:<deleted-id>` must not blank the label's view
 * silently. At HEAD the route's filter matches nothing, the list renders the generic "No sessions
 * yet" screen, and the panel title falls back to `getLabelDisplayName`'s titlecased raw id —
 * an empty-but-live-looking view for a label that no longer exists (the same dead-id shape the
 * row family has been closing since UA12.154). `isDeletedLabelView` is the render predicate: the
 * navigator shows an explicit deleted-label empty-state instead of the session list, and the
 * title falls back to the generic section name exactly like the dead view branch does.
 *
 * These arms were written FIRST and fail at HEAD (no predicate; the wiring absent).
 */
describe('UA12.164 — a deleted label\u2019s route renders an explicit empty-state, not a silent blank', () => {
  const TREE = [
    { id: 'parent', name: 'Parent', children: [{ id: 'child', name: 'Child' }] },
    { id: 'solo', name: 'Solo' },
  ]

  /** Labels loaded without error, search off — the only state in which "no config carries it" means DELETED. */
  const READY = { labelsReady: true, searchActive: false } as const

  it('CONTROL — a label filter naming a dead id is a deleted-label view', () => {
    expect(isDeletedLabelView({ kind: 'label', labelId: 'task-confirm-me-014241-7' }, TREE, READY)).toBe(true)
  })

  it('BOUNDARY — live ids, __all__, other kinds and no filter are not', () => {
    expect(isDeletedLabelView({ kind: 'label', labelId: 'parent' }, TREE, READY)).toBe(false)
    expect(isDeletedLabelView({ kind: 'label', labelId: 'child' }, TREE, READY)).toBe(false)
    expect(isDeletedLabelView({ kind: 'label', labelId: '__all__' }, TREE, READY)).toBe(false)
    expect(isDeletedLabelView({ kind: 'allSessions' }, TREE, READY)).toBe(false)
    expect(isDeletedLabelView({ kind: 'view', viewId: 'gone' }, TREE, READY)).toBe(false)
    expect(isDeletedLabelView(null, TREE, READY)).toBe(false)
  })

  // 2026-10-08 verification (findings/UA12.164.md, both lenses): useLabels starts at [] with
  // isLoading=true and keeps [] when listLabels fails, so a LIVE label's route read as deleted
  // ("Label deleted") for the load's round trip, and for good on a load error; and the empty-state
  // replaced SessionList (which owns the search header) even with search active, so Cmd+F did nothing.
  it('NEGATIVE (follow-up) — not while labels load or failed to load: an empty config is "not loaded yet", not "deleted"', () => {
    const notReady = { labelsReady: false, searchActive: false } as const
    expect(isDeletedLabelView({ kind: 'label', labelId: 'parent' }, [], notReady)).toBe(false)
    expect(isDeletedLabelView({ kind: 'label', labelId: 'task-confirm-me-014241-7' }, TREE, notReady)).toBe(false)
  })

  it('NEGATIVE (follow-up) — not while search is active: the session list (and its search header) stays', () => {
    expect(isDeletedLabelView({ kind: 'label', labelId: 'task-confirm-me-014241-7' }, TREE, { labelsReady: true, searchActive: true })).toBe(false)
  })

  it('WIRING — AppShell renders the deleted-label empty-state and the title falls back like the dead view branch', () => {
    const appShell = readFileSync(join(KANBAN_DIR, '..', 'AppShell.tsx'), 'utf8')
    expect(appShell).toContain('isDeletedLabelView(sessionFilter, labelConfigs, { labelsReady, searchActive })')
    // The readiness comes from the hook's own state, and the title keeps the id's name until labels are ready:
    expect(appShell).toContain('const { labels: labelConfigs, isLoaded: labelsLoaded, error: labelsError } = useLabels(')
    expect(appShell).toContain('const labelsReady = labelsLoaded && !labelsError')
    expect(appShell).toContain('findLabelById(labelConfigs, sessionFilter.labelId) || !labelsReady')
    expect(appShell).toContain('t("sidebar.deletedLabelTitle")')
    expect(appShell).toContain('t("sidebar.deletedLabelDesc")')
    // The dead-id title fallback mirrors the dead view branch (`?.name || t("sidebar.views")`):
    expect(appShell).toContain('findLabelById(labelConfigs, sessionFilter.labelId)')
  })

  // 2026-10-08 re-verification of 6da39447a: useLabels.refresh() sets isLoading=true on EVERY
  // refresh (each LABELS_CHANGED), not only the first load, while `labels` still holds the last
  // good list. Gating readiness on isLoading made a real deleted-label view drop back to the
  // generic SessionList blank (title titlecased from the dead id) for every label-config change's
  // round trip. Readiness is "this workspace's labels LOADED once", which a refresh does not undo
  // and a workspace switch does (the previous workspace's list is not this workspace's).
  it('POSITIVE (follow-up 2) — a refresh over this workspace\u2019s loaded list keeps the labels ready', () => {
    expect(labelsHook.isLabelsLoadedFor('ws-a', 'ws-a')).toBe(true)
  })

  it('NEGATIVE (follow-up 2) — not before the first load, not on the previous workspace\u2019s list, not without a workspace', () => {
    expect(labelsHook.isLabelsLoadedFor(null, 'ws-a')).toBe(false)
    expect(labelsHook.isLabelsLoadedFor('ws-a', 'ws-b')).toBe(false)
    expect(labelsHook.isLabelsLoadedFor(null, null)).toBe(false)
  })

  it('WIRING (follow-up 2) — useLabels marks a workspace loaded only on a successful list, and AppShell no longer gates on isLoading', () => {
    const hook = readFileSync(join(KANBAN_DIR, '..', '..', '..', 'hooks', 'useLabels.ts'), 'utf8')
    expect(hook).toContain('setLabels(configs)\n      setLoadedWorkspaceId(workspaceId)')
    expect(hook).toContain('isLoaded: isLabelsLoadedFor(loadedWorkspaceId, workspaceId),')
    const appShell = readFileSync(join(KANBAN_DIR, '..', 'AppShell.tsx'), 'utf8')
    expect(appShell).not.toContain('labelsLoading')
  })

  it('WIRING — the empty-state keys exist in BOTH locales, written as characters', () => {
    const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8')) as Record<string, string>
    const ru = JSON.parse(readFileSync(join(LOCALES_DIR, 'ru.json'), 'utf8')) as Record<string, string>
    expect(en['sidebar.deletedLabelTitle']).toBeTruthy()
    expect(en['sidebar.deletedLabelDesc']).toBeTruthy()
    expect(ru['sidebar.deletedLabelTitle']).toBeTruthy()
    expect(ru['sidebar.deletedLabelDesc']).toBeTruthy()
    // Written as characters, never \uXXXX escapes:
    expect(ru['sidebar.deletedLabelTitle']).toMatch(/[А-Яа-яЁё]/)
  })
})

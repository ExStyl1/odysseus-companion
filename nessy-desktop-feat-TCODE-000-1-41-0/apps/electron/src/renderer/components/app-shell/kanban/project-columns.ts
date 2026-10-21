/**
 * UA5.10 — the board's project rules as pure functions, so `bun test` pins them without mounting the
 * container (whose graph reaches `@nessy-agent/ui`; see `__tests__/task-editor.test.tsx` on that cost).
 *
 * Each function is a block of v0.13.4 `apps/electron/src/renderer/components/app-shell/kanban/KanbanBoardContainer.tsx`
 * (craft-agents-oss, Apache-2.0) lifted out unchanged in what it reads and decides, as UA2.4 lifted the `tasks` memo
 * into `board-derive.ts`; the container calls them where upstream wrote them inline:
 * - {@link pruneProjectFilter} — L110–L126, the filter kept to live projects;
 * - {@link focusedProjectOf} — L165–L172, `editingProject`;
 * - {@link resolveActiveColumns} — L174–L183, the active column set;
 * - {@link filterTasksByProject} — L291–L297, the filter over tiles;
 * - {@link firstFilteredProjectId} — L371 and L576, the project a new task binds to;
 * - {@link editableColumns}, {@link withAddedColumn}, {@link withUpdatedColumn}, {@link planColumnRemoval} — L422–L467,
 *   the column editor's set arithmetic (the container persists the result through `projects:update`).
 *
 * NESSY adaptations, each named:
 * 1. "No project" (spec §9): the filter may carry {@link KANBAN_UNASSIGNED_PROJECT}. It selects tiles with no project
 *    and tiles whose project no longer exists (the session list's rule, `session-list-project-groups.ts`), survives
 *    pruning, never binds a new task and never focuses a project. Upstream's board has no such option.
 * 2. {@link planColumnRemoval} refuses to remove the last column (returns `null`). Upstream guards it in the board
 *    (`KanbanBoard` passes `onRemove` only while more than one column remains) and its handler would persist `[]` —
 *    which our project store reads as "the default columns" (`projects/storage.ts`), so removing a project's only
 *    column would bring the three built-ins back instead. The board guard stays; this is the second line.
 */
import { KANBAN_UNASSIGNED_PROJECT } from '@/atoms/kanban'
import type { KanbanColumnDef } from '@nessy-agent/shared/projects/types'
import { KANBAN_COLUMNS } from './status-column'
import type { KanbanColumnMeta } from './types'

export { KANBAN_UNASSIGNED_PROJECT }

/** The slice of a loaded project the board reads. */
export interface BoardProject {
  config: { id: string; slug: string; name: string; kanbanColumns?: KanbanColumnDef[] }
}

/**
 * v0.13.4 L121–L125: drop ids whose project no longer exists, so the board cannot stay filtered to nothing.
 * Identity-preserving (the same array back when nothing changed). NESSY: the "No project" id always survives.
 */
export function pruneProjectFilter(prev: string[], liveProjectIds: ReadonlySet<string>): string[] {
  if (prev.length === 0) return prev
  const live = prev.filter(id => id === KANBAN_UNASSIGNED_PROJECT || liveProjectIds.has(id))
  return live.length === prev.length ? prev : live
}

/** v0.13.4 L169–L172: the single project in focus — exactly one selected, and it is a live project. */
export function focusedProjectOf<P extends BoardProject>(filter: readonly string[], projects: readonly P[]): P | undefined {
  return filter.length === 1 ? projects.find(p => p.config.id === filter[0]) : undefined
}

/**
 * v0.13.4 L177–L183: the focused project's custom columns when it defines any, otherwise the default built-ins.
 * Custom defs map straight onto the presentational meta (verbatim `name`, no i18n key).
 */
export function resolveActiveColumns(focused: BoardProject | undefined): readonly KanbanColumnMeta[] {
  const custom = focused?.config.kanbanColumns
  if (custom?.length) {
    return custom.map(c => ({ id: c.id, name: c.name, color: c.color, dropStatusId: c.dropStatusId }))
  }
  return KANBAN_COLUMNS
}

/**
 * v0.13.4 L293–L297: empty selection = show all. With a selection, a tile shows when its project is selected;
 * NESSY adaptation 1: a tile with no project, or a project not in `liveProjectIds`, shows when "No project" is.
 */
export function filterTasksByProject<T extends { projectId?: string }>(
  tasks: T[],
  filter: readonly string[],
  liveProjectIds: ReadonlySet<string>,
): T[] {
  if (filter.length === 0) return tasks
  const allow = new Set(filter)
  return tasks.filter(task => {
    const projectId = task.projectId !== undefined && liveProjectIds.has(task.projectId) ? task.projectId : undefined
    return projectId === undefined ? allow.has(KANBAN_UNASSIGNED_PROJECT) : allow.has(projectId)
  })
}

/** v0.13.4 L371 / L576: the project a task created under the filter binds to — the first selected REAL project. */
export function firstFilteredProjectId(filter: readonly string[]): string | undefined {
  return filter.find(id => id !== KANBAN_UNASSIGNED_PROJECT)
}

/**
 * v0.13.4 L426–L435: the project's current custom set, or — on first customization — a seed materialized from the
 * active (default) columns. The seed reuses the built-in ids so existing card placement survives, and freezes the
 * default labels in the user's current language (thereafter user-authored, like the project name).
 */
export function editableColumns(
  focused: BoardProject | undefined,
  activeColumns: readonly KanbanColumnMeta[],
  translate: (key: string) => string,
): KanbanColumnDef[] {
  const custom = focused?.config.kanbanColumns
  if (custom?.length) return custom.map(c => ({ ...c }))
  return activeColumns.map(c => ({
    id: c.id,
    name: c.name ?? (c.labelKey ? translate(c.labelKey) : c.id),
    color: c.color,
    dropStatusId: c.dropStatusId,
  }))
}

/** v0.13.4 L437–L441: a new column at the end; the id is `col-<8 hex>` (callers pass it). */
export function withAddedColumn(base: KanbanColumnDef[], id: string, name: string): KanbanColumnDef[] {
  return [...base, { id, name }]
}

/** v0.13.4 L443–L449: one column patched in place. */
export function withUpdatedColumn(base: KanbanColumnDef[], columnId: string, patch: Partial<KanbanColumnDef>): KanbanColumnDef[] {
  return base.map(c => (c.id === columnId ? { ...c, ...patch } : c))
}

/**
 * v0.13.4 L451–L467: the remaining set and the cards to move — each tile in the removed column goes to the first
 * remaining column, so none disappears. NESSY adaptation 2: `null` (nothing to do) for the last column or an id
 * not in the set.
 */
export function planColumnRemoval<T extends { id: string; column: string }>(
  base: KanbanColumnDef[],
  columnId: string,
  tasks: readonly T[],
): { remaining: KanbanColumnDef[]; reassign: Array<{ taskId: string; toColumn: string }> } | null {
  if (base.length <= 1 || !base.some(c => c.id === columnId)) return null
  const remaining = base.filter(c => c.id !== columnId)
  const fallbackId = remaining[0]!.id
  const reassign = tasks.filter(task => task.column === columnId).map(task => ({ taskId: task.id, toColumn: fallbackId }))
  return { remaining, reassign }
}

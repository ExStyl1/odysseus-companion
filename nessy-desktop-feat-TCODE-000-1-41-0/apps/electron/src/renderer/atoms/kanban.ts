/* Copied from v0.13.4:apps/electron/src/renderer/atoms/kanban.ts
   (craft-agents-oss, Apache-2.0); manifest row UA2.4, landed with UA2.3 because
   UA2.3's hook and the Appearance page read these atoms (upstream's ordering,
   same lane), 2026-10-02. UA5.10 restored L18–L19 (`kanbanProjectFilterAtom`, the project filter).
   Adaptations: the "No project" bucket (spec §9) is the `KANBAN_UNASSIGNED_PROJECT` sentinel in the
   filter, as upstream's own Pages filter carries `PAGES_UNASSIGNED_PROJECT` (`atoms/pages.ts`); the
   localStorage keys are rebranded `craft-*` → `nessy-*`; the three pure helpers at the end (`readColumnMap`, `withColumnDropStatus`,
   `resolveDropStatus`) carry the rules upstream writes inline in the Appearance
   page and the board container, so a corrupt stored map reads as empty and
   `bun test` pins the drop-status rule without a DOM. */
/**
 * Jotai atoms for the live Kanban board's view state.
 *
 * The project filter persists across board⇄list remounts within a session (the
 * board unmounts when the user flips to the list view), so a filter the user set
 * stays applied when they return.
 *
 * Column colors and the live-pulse toggle are appearance *preferences*, so they
 * persist to localStorage via `atomWithStorage` (same pattern as
 * `workspaceAvatarColorsAtom`) — reactive, multi-window, no RPC/disk-config. They
 * are per-machine, not workspace-synced.
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { KanbanColumnId, TaskEditorTarget } from '@/components/app-shell/kanban/types'

/** Selected project ids to filter the board by. Empty array = all projects. */
export const kanbanProjectFilterAtom = atom<string[]>([])

/**
 * NESSY (spec §9, "the project filter gets a 'No project' bucket"): the sentinel id the board filter
 * carries for "No project" — tiles with no project, or one that no longer exists. Upstream's board
 * hides every unbound tile while a filter is active ("an explicit 'No project' option is a later add");
 * its Pages filter already has this option, under the same shape (`PAGES_UNASSIGNED_PROJECT`).
 */
export const KANBAN_UNASSIGNED_PROJECT = '__unassigned__'

/**
 * The board pane's Task-editor overlay target (null = closed). An atom rather than
 * board-local state so surfaces outside the board — e.g. the chat header's
 * "Edit task" button — can point the editor at a session and then navigate to the
 * board route, where the overlay opens prefilled.
 */
export const kanbanEditorTargetAtom = atom<TaskEditorTarget | null>(null)

/**
 * Per-column color overrides (hex). A column absent from the map falls back to
 * `DEFAULT_KANBAN_COLUMN_COLORS` (see `kanban/kanban-colors.ts`). Resetting a
 * column in Settings deletes its key here.
 */
export const kanbanColumnColorsAtom = atomWithStorage<Partial<Record<KanbanColumnId, string>>>(
  'nessy-kanban-column-colors',
  {}
)

/** Whether active (in-progress) tiles get the live-pulse treatment. Default on. */
export const kanbanLivePulseAtom = atomWithStorage<boolean>('nessy-kanban-live-pulse', true)

/**
 * Per-column status auto-applied when a task is dropped into that column. A
 * column absent from the map (or mapped to a status that no longer exists)
 * leaves the task's status untouched on move.
 */
export const kanbanColumnStatusAtom = atomWithStorage<Partial<Record<KanbanColumnId, string>>>(
  'nessy-kanban-column-status',
  {}
)

/**
 * A stored per-column map read defensively. `atomWithStorage` already falls back
 * to `{}` on unparseable JSON; this covers the JSON that parses to the wrong
 * shape (`null`, an array, a number) and drops every non-string or empty entry.
 */
export function readColumnMap(value: unknown): Partial<Record<KanbanColumnId, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Partial<Record<KanbanColumnId, string>> = {}
  for (const [column, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry) out[column] = entry
  }
  return out
}

/**
 * The Appearance page's "status on move" setter (upstream inline): a status id
 * maps the column, the empty selection ('') removes the mapping.
 */
export function withColumnDropStatus(
  prev: unknown,
  column: KanbanColumnId,
  statusId: string
): Partial<Record<KanbanColumnId, string>> {
  const next = { ...readColumnMap(prev) }
  if (statusId) next[column] = statusId
  else delete next[column]
  return next
}

/**
 * The status a move into `toColumn` applies (upstream's board-container guard):
 * a project column's own `dropStatusId` first, else the global per-column map —
 * and only when that status still exists, so an absent or stale mapping leaves
 * the task's status untouched.
 */
export function resolveDropStatus(args: {
  toColumn: KanbanColumnId
  columnDropStatusId?: string
  columnStatus: unknown
  isKnownStatus: (statusId: string) => boolean
}): string | undefined {
  const autoStatus = args.columnDropStatusId ?? readColumnMap(args.columnStatus)[args.toColumn]
  return autoStatus && args.isKnownStatus(autoStatus) ? autoStatus : undefined
}

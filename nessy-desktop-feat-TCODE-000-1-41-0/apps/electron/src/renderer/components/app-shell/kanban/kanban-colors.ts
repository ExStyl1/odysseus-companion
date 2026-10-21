/* Copied verbatim from v0.13.4:apps/electron/src/renderer/components/app-shell/kanban/kanban-colors.ts
   (craft-agents-oss, Apache-2.0) by UA2.3, 2026-10-02.
   Manifest row UA2.4; landed with UA2.3 because UA2.3's hook and the Appearance
   page import it (upstream's ordering, same lane). */
import type { BuiltInKanbanColumnId } from './types'

/**
 * Default accent color for each board column (hex). Single source of truth for
 * the column identity; user overrides live in `kanbanColumnColorsAtom` and are
 * merged over these by `useKanbanColumnColors`.
 *
 * Picked from `PROJECT_COLOR_PALETTE` so the board reads as one family: indigo
 * (planning) → amber (active) → emerald (done).
 */
export const DEFAULT_KANBAN_COLUMN_COLORS: Record<BuiltInKanbanColumnId, string> = {
  todo: '#6366f1', // indigo
  'in-progress': '#f59e0b', // amber
  done: '#10b981', // emerald
}

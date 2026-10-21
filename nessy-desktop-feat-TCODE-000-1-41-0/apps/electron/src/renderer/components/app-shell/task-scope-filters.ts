/**
 * UA5.10 — the All Sessions filters a board click applies, lifted from v0.13.4
 * `apps/electron/src/renderer/components/app-shell/AppShell.tsx` L795–L817 `handleJumpToTaskSessions`
 * (craft-agents-oss, Apache-2.0) as a pure function: AppShell's callback is this plus the navigation, written on
 * one line there so the lines the docs cite keep their numbers.
 *
 * Replace the allSessions view's label filter (and project filter, when the task is bound to one) with the task's
 * scope. These are the SAME user-clearable filters the list-header chips edit — clearing them afterwards works
 * exactly like any hand-set filter. The view's status filter and grouping are kept; other views are untouched.
 *
 * UA12.154 — `expandLabelFilterIds` is the label-filter half of AppShell's pre-filter memo, lifted
 * pure for the same reason: a persisted view filter can name a label the config has since deleted
 * (SIT-D F4 — the label's task was deleted), and an include that expands to the dead id alone
 * blanks All Sessions ("No sessions yet" beside live unread counts, surviving reload and restart).
 * An id no config carries matches NOTHING; the filter chip already renders nothing for it, so the
 * filter is effectively gone instead of eating the list. The list's own second pass
 * (useSessionSearch `passesLabelFilter`) drops the same ids.
 */
import { findLabelById, getDescendantIds, type LabelConfig } from '@nessy-agent/shared/labels'

export type TaskScopeFilterMode = 'include' | 'exclude'

/** The scope of one task: its per-task label (`TASK-<slug>-<N>`, or the Task root) and its project, if bound. */
export interface TaskSessionsScope {
  labelId: string
  projectId?: string
}

type FilterEntry = Record<string, TaskScopeFilterMode>
type ViewFilters<G> = { statuses: FilterEntry; labels: FilterEntry; projects?: FilterEntry; groupingMode?: G }

export function withTaskScopeFilters<G>(
  prev: Record<string, ViewFilters<G>>,
  scope: TaskSessionsScope,
): Record<string, ViewFilters<G>> {
  const existing = prev['allSessions']
  return {
    ...prev,
    allSessions: {
      statuses: existing?.statuses ?? {},
      labels: { [scope.labelId]: 'include' },
      projects: scope.projectId ? { [scope.projectId]: 'include' } : {},
      groupingMode: existing?.groupingMode,
    },
  }
}

/**
 * UA12.154 — the ids one label-filter entry matches: the id and its descendants while a live label
 * config carries it, NOTHING once none does (the label was deleted). An exclude of a dead id is
 * inert either way (it matches nothing), so callers need not distinguish modes.
 */
export function expandLabelFilterIds(labelConfigs: readonly LabelConfig[], id: string): string[] {
  return findLabelById(labelConfigs as LabelConfig[], id) ? [id, ...getDescendantIds(labelConfigs as LabelConfig[], id)] : []
}

/**
 * UA12.162 — whether the label filter still narrows anything: at least one entry expands to a
 * live id. The active-filters tint and the clear affordances used to key on the raw persisted
 * map's `size > 0`, so a dead-only persisted filter (the SIT-D F4 state — every id a deleted
 * label) kept the accent tint and its clear affordance until any filter edit rewrote the map,
 * while `expandLabelFilterIds` (UA12.154) had long made the filter itself inert. The modes are
 * irrelevant here exactly as they are in `expandLabelFilterIds`: an include and an exclude of a
 * dead id are both inert.
 */
export function hasLiveLabelFilter(
  labelConfigs: readonly LabelConfig[],
  labelFilter: ReadonlyMap<string, unknown>,
): boolean {
  for (const id of labelFilter.keys()) {
    if (expandLabelFilterIds(labelConfigs, id).length > 0) return true
  }
  return false
}

/**
 * UA12.164 — whether the navigator is showing a LABEL VIEW whose label no longer exists: the
 * pinned sidebar route `label:<deleted-id>` (boot restore, stale deeplink) parses to a label
 * filter that matches nothing, so at HEAD the view rendered the generic "No sessions yet" screen
 * under a title titlecased from the dead id — a silent blank indistinguishable from an empty
 * live label. The renderer shows an explicit deleted-label empty-state instead. `__all__` (the
 * Labels header) is never a deleted view; other filter kinds are not label views at all.
 *
 * `state` is REQUIRED (2026-10-08 verification follow-up): "no config carries the id" means
 * DELETED only once the labels have LOADED without error — useLabels starts at `[]` while
 * loading and keeps `[]` when the load fails, and the pre-UA12.164 list still showed the
 * sessions tagged with the id meanwhile — and never while search is active, since the
 * empty-state replaces SessionList, which owns the search header (Cmd+F would do nothing).
 */
export function isDeletedLabelView(
  filter: { kind: string; labelId?: string; viewId?: string } | null | undefined,
  labelConfigs: readonly LabelConfig[],
  state: { labelsReady: boolean; searchActive: boolean },
): boolean {
  return state.labelsReady
    && !state.searchActive
    && filter?.kind === 'label'
    && filter.labelId !== undefined
    && filter.labelId !== '__all__'
    && expandLabelFilterIds(labelConfigs, filter.labelId).length === 0
}

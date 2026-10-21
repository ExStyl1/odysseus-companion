/* Copied from v0.13.4:apps/electron/src/renderer/components/app-shell/inherited-filter-params.ts (craft-agents-oss, Apache-2.0) by
   UA5.9, 2026-10-02. Adapted (UA12.163, 2026-10-04): resolveInheritedFilterParams takes a REQUIRED fourth
   parameter `isLiveLabel` and prunes the label includes through it before counting (see its docblock) —
   not upstream: v0.13.4 through v0.14.0 take three arguments. Nothing else differs. */
/** Filter mode for tri-state filtering: include shows only matching, exclude hides matching. */
export type FilterMode = 'include' | 'exclude'

export interface InheritedNewSessionParams {
  status?: string
  label?: string
  project?: string
}

const includeKeys = <K extends string>(m: Map<K, FilterMode>): K[] =>
  [...m.entries()].filter(([, mode]) => mode === 'include').map(([id]) => id)

/**
 * Resolve the "inherit sole active filter" rule for new sessions.
 *
 * Only include-mode filters are inheritance candidates — an excluded
 * status/label/project must NEVER be inherited (#970: a lone `Done → exclude`
 * filter used to create new sessions as `Done`). Inherit only when exactly one
 * include filter is active across statuses + labels + projects; otherwise return
 * null and let the caller fall back to the workspace default status.
 *
 * UA12.163 — a label include is only ACTIVE while a live label config carries it: a dead id
 * filters like no filter since UA12.154 (both list consumers prune through
 * `expandLabelFilterIds`), but this rule still counted it, so the SIT-D F4 state (a sole include
 * of a label since deleted) stamped new chats with a label that does not exist. `isLiveLabel` is
 * REQUIRED — AppShell threads the same prune the lists use — so a caller cannot silently
 * re-create the defect by forgetting it; a dead include also cannot create a false ambiguity
 * beside a live one.
 */
export function resolveInheritedFilterParams<S extends string, L extends string, P extends string>(
  statusFilter: Map<S, FilterMode>,
  labelFilter: Map<L, FilterMode>,
  projectFilter: Map<P, FilterMode>,
  isLiveLabel: (id: L) => boolean
): InheritedNewSessionParams | null {
  const statusIncludes = includeKeys(statusFilter)
  const labelIncludes = includeKeys(labelFilter).filter(isLiveLabel)
  const projectIncludes = includeKeys(projectFilter)
  const total = statusIncludes.length + labelIncludes.length + projectIncludes.length
  if (total !== 1) return null
  if (statusIncludes.length === 1) return { status: statusIncludes[0] }
  if (labelIncludes.length === 1) return { label: labelIncludes[0] }
  if (projectIncludes.length === 1) return { project: projectIncludes[0] }
  return null
}

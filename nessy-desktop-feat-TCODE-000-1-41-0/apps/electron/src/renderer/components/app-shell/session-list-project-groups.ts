/**
 * UA5.9 — the session list's `'project'` grouping (ported from craft-agents-oss v0.13.4
 * `apps/electron/src/renderer/components/app-shell/SessionList.tsx` L391–L450 and L514–L520, Apache-2.0).
 *
 * Moved out of `SessionList.tsx` into this module, unchanged in behaviour: `SessionList.tsx` is cited by line in the
 * docs (highest cited line 723 on 2026-10-02), so its upstream block is called from one rewritten line instead of
 * being inserted above that line. The labels are passed in (`noProjectLabel`, `unknownProjectLabel`) so this module
 * needs no i18n instance and is testable alone.
 */
import type { EntityListGroup } from '../ui/entity-list'

/** The project fields the session list reads (AppShell's `projectMenuOptions`). */
export interface SessionListProjectOption {
  id: string
  slug: string
  name: string
  color?: string
}

/** The "no project" bucket's key: sessions with no projectId, or one no workspace project has. */
export const NO_PROJECT_GROUP_KEY = 'project-__none__'

interface Row {
  item: { projectId?: string; lastMessageAt?: number }
}

/** The group key of one session: its project's, or {@link NO_PROJECT_GROUP_KEY} when the project is unknown. */
export function projectGroupKeyOf(item: { projectId?: string }, knownProjectIds: Set<string>): string {
  const pid = item.projectId
  return pid && knownProjectIds.has(pid) ? `project-${pid}` : NO_PROJECT_GROUP_KEY
}

/** Every group key of `items` — what "collapse all" collapses in project mode. */
export function projectGroupKeys(items: Array<{ projectId?: string }>, projects: SessionListProjectOption[] | undefined): Set<string> {
  const known = new Set((projects ?? []).map(p => p.id))
  return new Set(items.map(item => projectGroupKeyOf(item, known)))
}

/**
 * Bucket the visible rows by project. Sessions without a projectId (or with an unknown one) go to the "no project"
 * bucket so they're never silently dropped from the list; it sinks to the bottom, the configured projects keep
 * registration order. Collapsed groups come back as header-only placeholders (`items: []`, `collapsedCount`).
 */
export function groupSessionRowsByProject<R extends Row>(
  rows: R[],
  projects: SessionListProjectOption[] | undefined,
  collapsedGroupsMeta: Array<{ key: string; count: number }>,
  labels: { noProject: string; unknownProject: string },
): { rows: R[]; groups: EntityListGroup<R>[] } {
  const projectOrder = new Map<string, number>()
  ;(projects ?? []).forEach((p, index) => projectOrder.set(p.id, index))
  const projectNameById = new Map<string, string>()
  ;(projects ?? []).forEach(p => projectNameById.set(p.id, p.name))

  const groupsByKey = new Map<string, { rows: R[], projectId: string | null }>()
  for (const row of rows) {
    const rawProjectId = row.item.projectId
    const resolvedProjectId = rawProjectId && projectNameById.has(rawProjectId) ? rawProjectId : null
    const key = resolvedProjectId ? `project-${resolvedProjectId}` : NO_PROJECT_GROUP_KEY
    if (!groupsByKey.has(key)) groupsByKey.set(key, { rows: [], projectId: resolvedProjectId })
    groupsByKey.get(key)!.rows.push(row)
  }

  // Insert collapsed placeholder groups (header-only, items: [])
  for (const meta of collapsedGroupsMeta) {
    if (!groupsByKey.has(meta.key)) {
      const idPart = meta.key.replace('project-', '')
      const projectId = idPart === '__none__' ? null : idPart
      groupsByKey.set(meta.key, { rows: [], projectId })
    }
  }

  const orderedGroups: EntityListGroup<R>[] = []
  for (const [key, { rows: groupRows, projectId }] of groupsByKey) {
    groupRows.sort((a, b) => (b.item.lastMessageAt || 0) - (a.item.lastMessageAt || 0))
    const collapsedMeta = collapsedGroupsMeta.find(m => m.key === key)
    const label = projectId
      ? (projectNameById.get(projectId) ?? labels.unknownProject)
      : labels.noProject
    orderedGroups.push({
      key,
      label,
      items: groupRows,
      collapsible: true,
      ...(collapsedMeta ? { collapsedCount: collapsedMeta.count } : {}),
    })
  }
  orderedGroups.sort((a, b) => {
    // No-project bucket sinks to the bottom, configured projects in registration order
    if (a.key === NO_PROJECT_GROUP_KEY) return 1
    if (b.key === NO_PROJECT_GROUP_KEY) return -1
    const aOrder = projectOrder.get(a.key.replace('project-', '')) ?? 999
    const bOrder = projectOrder.get(b.key.replace('project-', '')) ?? 999
    return aOrder - bOrder
  })

  if (orderedGroups.length === 1) {
    orderedGroups[0]!.collapsible = false
  }

  return {
    rows: orderedGroups.flatMap(g => g.items),
    groups: orderedGroups,
  }
}

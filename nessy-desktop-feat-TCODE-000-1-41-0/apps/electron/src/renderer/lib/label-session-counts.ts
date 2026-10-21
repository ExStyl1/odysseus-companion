import { flattenLabels, matchesLabelFilter, type LabelConfig, type LabelFilterableSession } from '@nessy-agent/shared/labels'

/**
 * F1.357 — the sidebar's per-label session count, cumulative (a parent counts
 * every chat under any of its descendants) and counted ONCE per chat.
 *
 * AppShell's `labelCounts` used to add a direct pass and a separate descendant
 * pass over OVERLAPPING sets (inherited verbatim from craft-agents-oss v0.13.4),
 * so a chat tagged both `parent` and `parent/child` scored 2 on the parent while
 * the `label` filter listed it once. This counts every chat against the same
 * predicate the list filters by — `matchesLabelFilter`: the label plus its
 * descendants, valued entries such as `priority::3` by base id — so the badge
 * and the list it labels share one rule. Archived-ness is the caller's policy:
 * AppShell passes its active (non-archived) sessions.
 */
export function countSessionsPerLabel(
  sessions: readonly LabelFilterableSession[],
  labelConfigs: LabelConfig[],
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const label of flattenLabels(labelConfigs)) {
    counts[label.id] = sessions.filter(session => matchesLabelFilter(session, { labelId: label.id }, labelConfigs)).length
  }
  return counts
}

import type { RecentProjectSummary } from '@nessy-agent/shared/protocol'

export type RecentProjectScenario = 'none' | 'few' | 'many'

const paths = [
  '/Users/demo/projects/nessy-general-agent',
  '/Users/demo/projects/nessy-general-agent/apps/electron',
  '/Users/demo/projects/nessy-general-agent/apps/viewer',
  '/Users/demo/projects/nessy-general-agent/apps/cli',
  '/Users/demo/projects/nessy-general-agent/packages/shared',
  '/Users/demo/projects/nessy-general-agent/packages/server-core',
  '/Users/demo/projects/nessy-general-agent/packages/pi-agent-server',
  '/Users/demo/projects/nessy-general-agent/packages/ui',
  '/Users/demo/projects/nessy-general-agent/scripts',
]

const summaries = paths.map((displayPath, index): RecentProjectSummary => ({
  id: `recent-project-${index + 1}`,
  displayPath,
  lastUsedAt: 1_800_000_000_000 - index,
}))

const RECENT_PROJECT_SCENARIOS: Record<RecentProjectScenario, RecentProjectSummary[]> = {
  none: [],
  few: summaries.slice(0, 3),
  many: summaries,
}

/** Return path-visible summaries with opaque backend-owned IDs. */
export function getRecentProjectsForScenario(
  scenario: RecentProjectScenario,
): RecentProjectSummary[] {
  return RECENT_PROJECT_SCENARIOS[scenario].map(project => ({ ...project }))
}

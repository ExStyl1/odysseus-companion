/**
 * The ONE card shape every Sources subsection renders (owner decisions
 * 2026-08-01, both from driving the running app).
 *
 * Four things and nothing else: the status-bearing icon, the name, ONE
 * category, and the description. What the rows used to add — a second "Plugin"
 * badge beside the type badge, and the acquisition badge ("External
 * marketplace") — stays GONE. A list of 48 mixed rows had five different badge
 * combinations, and provenance on the row is what made two rows of the same
 * kind look like two kinds.
 *
 * The description came BACK on 2026-08-01 (second report). Dropping it went too
 * far: the MCP subsection had always rendered it, so the same server read
 * differently one click apart.
 *
 * Since v0.15.1's row anatomy (UB14.57 for the aggregate list, UB12.74 for the
 * MCPs, Plugins and Hooks subsections) the category is the title line's
 * tertiary META and the description is line 2 (`sourceCardSlots`,
 * `components/app-shell/SourceCardBadges.tsx`). The coloured badge is retired
 * with its per-category palette: no surface draws a category in colour any
 * more, so the table below holds the LABEL alone. (Its name is historical.)
 *
 * The category IS the meta: one row belongs to exactly one category, so it can
 * never be plural and a row can never be without one. That totality is the
 * point — `sourceCategoryFor` is total over the row types the seven Sources
 * subsections render (Sources, APIs, MCPs, Local Folders, Plugins, Hooks,
 * Skills), so there is no "unknown" label to design.
 */

import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'

/** Every category a row of the Sources subsections can belong to. */
export type SourceCategory = 'mcp' | 'api' | 'local' | 'skill' | 'plugin' | 'hook'

/** The label key for one category — the meta's only configuration. */
export const SOURCE_CATEGORY_BADGE: Record<SourceCategory, { labelKey: string }> = {
  mcp: { labelKey: 'sourcesList.typeMcp' },
  api: { labelKey: 'sourcesList.typeApi' },
  local: { labelKey: 'sourcesList.typeLocal' },
  skill: { labelKey: 'sourcesList.typeSkill' },
  plugin: { labelKey: 'sourcesList.pluginBadge' },
  hook: { labelKey: 'sourcesList.typeHook' },
}

/**
 * Everything the card reads from a row — and nothing else.
 *
 * Structural on purpose: a Sources/Skills row is a whole `SafeCapabilitySummary`,
 * a Plugins row is the synthesized one from `plugin-management-rows.ts`, and an
 * MCP row (`McpServerRow`) is neither. All three can name their category and
 * their description, which is the entire input the card needs.
 */
export interface SourceCardRow {
  kind: SafeCapabilitySummary['kind']
  sourceType?: SafeCapabilitySummary['sourceType']
  description?: string
}

/**
 * The category of one row. Total over the row types the subsections render, so
 * the meta is never absent and never doubled.
 *
 * A plugin-provided MCP server is `mcp`, not `plugin`: the category names WHAT
 * the row is, and its provenance is on the detail page. That is the whole
 * reason the second "Plugin" badge could be dropped. `plugin` is reserved for the row
 * that IS a plugin package (`kind: 'app'`, the Plugins subsection).
 */
export function sourceCategoryFor(item: SourceCardRow): SourceCategory {
  switch (item.kind) {
    case 'skill': return 'skill'
    case 'hook': return 'hook'
    case 'app': return 'plugin'
    case 'mcp': return 'mcp'
    // `kind: 'source'` — the type is the row's own `sourceType`, defaulting to
    // `api` the way `sourceTypeFor` has always defaulted it.
    default: return item.sourceType ?? 'api'
  }
}

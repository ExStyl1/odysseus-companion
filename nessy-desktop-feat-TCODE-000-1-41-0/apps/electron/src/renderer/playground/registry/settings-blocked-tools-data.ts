/**
 * Sample data for the unenforceable-`blockedTools` draft (P3.351 / P4.10).
 *
 * ## Why this is a separate file from the entry that renders it
 *
 * Measured 2026-09-04, not assumed: importing
 * `registry/settings-blocked-tools.tsx` under bun fails with
 * `Missing 'default' export in module 'pdfjs-dist/build/pdf.worker.min.mjs?url'`
 * after 73.3 s — the entry mounts the real `PermissionsDataTable`, whose graph
 * reaches `pdfjs-dist`. P3.316's ruling stands: the fix is CONTAINMENT, not a
 * sixth bare `mock.module` site with no spread and no restore. So the values a
 * test has to read as VALUES live here, in a module with no runtime imports at
 * all, and the entry's wiring is asserted against source text — the same
 * division of labour `runtime-switch-costs-registry.test.ts` records.
 *
 * The classification below is stated as data and RE-DERIVED in
 * `__tests__/settings-blocked-tools-registry.test.ts` through
 * `classifyBlockedToolDeclaration` over the real `ALWAYS_ALLOWED_TOOLS`, which
 * lives in `mode-manager.ts` and drags 193 node-builtin import edges over 274
 * files — free in a bun test, not free in a renderer bundle. That test is the
 * pin: this file cannot drift away from the gate without going red.
 *
 * The shipped page does NOT read this file. It classifies live, through the
 * same predicate over `agent/always-allowed-tools.ts` — the leaf holding the
 * one copy of the names, which `mode-manager.ts` builds its Set from. This
 * sample exists so a draft can show branches a given machine's config happens
 * not to declare.
 */

import type { BlockedToolPreemption } from '@nessy-agent/shared/agent/blocked-tools-enforcement'

/** One entry as a user wrote it, with the branch that actually decides it. */
export interface SampleDeclaration {
  tool: string
  /** `null` = the runtime really does block it. */
  preemption: BlockedToolPreemption | null
}

/**
 * A workspace `permissions.json` carrying `blockedTools`, chosen to cover every
 * branch — including `anything__Read`, which shows the suffix rule is ANY
 * `__<name>` and not only the `mcp__…__` spelling the documentation describes,
 * and two entries the runtime really does block so the draft is not a screen on
 * which everything is a lie.
 */
export const SAMPLE_BLOCKED_TOOLS: SampleDeclaration[] = [
  { tool: 'WebFetch', preemption: { kind: 'always-allowed', matched: 'WebFetch' } },
  { tool: 'WebSearch', preemption: { kind: 'always-allowed', matched: 'WebSearch' } },
  { tool: 'TodoWrite', preemption: { kind: 'always-allowed', matched: 'TodoWrite' } },
  { tool: 'mcp__session__read_mcp_resource', preemption: { kind: 'always-allowed-suffix', matched: 'read_mcp_resource' } },
  { tool: 'anything__Read', preemption: { kind: 'always-allowed-suffix', matched: 'Read' } },
  { tool: 'browser_tool', preemption: { kind: 'browser-tool' } },
  { tool: 'mcp__session__browser_tool', preemption: { kind: 'browser-tool' } },
  { tool: 'browser_snapshot', preemption: { kind: 'browser-tool' } },
  { tool: 'Bash', preemption: { kind: 'bash-classifier' } },
  { tool: 'Write', preemption: null },
  { tool: 'mcp__acme__deploy', preemption: null },
]

/**
 * Every treatment the owner is being shown, `none` FIRST as the control.
 *
 * `none` is what ships today — every declared name wearing the destructive
 * BLOCKED badge — and a draft showing only the candidates would hide the defect
 * it exists to settle.
 */
export const BLOCKED_TOOL_TREATMENTS = ['none', 'warn', 'grey', 'annotate', 'filter'] as const
export type BlockedToolTreatment = (typeof BLOCKED_TOOL_TREATMENTS)[number]

/** i18n key per branch — one sentence each; `tool` and `matched` interpolate. */
export const PREEMPTION_KEYS: Record<BlockedToolPreemption['kind'], string> = {
  'always-allowed': 'settings.permissions.blockedToolsUnenforcedAlwaysAllowed',
  'always-allowed-suffix': 'settings.permissions.blockedToolsUnenforcedSuffix',
  'browser-tool': 'settings.permissions.blockedToolsUnenforcedBrowser',
  'bash-classifier': 'settings.permissions.blockedToolsUnenforcedBash',
}

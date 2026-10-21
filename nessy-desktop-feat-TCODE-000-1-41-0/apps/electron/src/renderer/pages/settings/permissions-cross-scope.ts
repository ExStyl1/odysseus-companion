/**
 * Cross-scope precedence for the permissions page — P6.209.
 *
 * A LEAF module, and that is the whole reason this is not a function inside
 * `PermissionsSettingsPage.tsx`. Measured 2026-09-07: a test importing the page
 * to reach this function pulls in the `@nessy-agent/ui` barrel and its pdfjs
 * `?url` chain, and `bun test` dies with
 * `SyntaxError: Missing 'default' export in module '.../pdf.worker.min.mjs?url'`
 * after 186 s — the exact cost `advisor-settings-surface.test.ts`'s header
 * predicted and avoided by matching source text instead. The same lift
 * `ALWAYS_ALLOWED_TOOL_NAMES` took for the same reason: put the derivation where
 * it can be imported, and the page, the playground draft and the test all read
 * one definition.
 *
 * The only import here is a TYPE, which is erased, so this module adds no
 * runtime edge at all.
 */

import type { PermissionRow } from '@/components/info/PermissionsDataTable'

/**
 * The two scopes' precedence, made visible — P6.209 (cross-scope half).
 *
 * ## What the resolver actually does, read rather than assumed
 *
 * `PermissionsConfigCache.buildMergedConfig` applies the app-level `global`
 * layer FIRST (`permissions-config.ts`, `applyDefaultConfig` at the
 * *"Load and apply app-level default permissions"* call) and the `workspace`
 * layer SECOND (`applyCustomConfig`, at *"Add workspace-level customizations"*).
 * Both appliers only ever PUSH onto the same arrays — `readOnlyBashPatterns`,
 * `readOnlyMcpPatterns`, `allowedApiEndpoints`, `allowedWritePaths` — and
 * `blockedTools` is a Set seeded from `SAFE_MODE_CONFIG` that only grows.
 *
 * So the precedence is **additive, not last-wins**: the workspace scope extends
 * the defaults and can never remove one of them. The page had never said this,
 * and a two-table layout invites the opposite reading — that the lower table
 * overrides the upper one.
 *
 * ## Which makes a repeated pattern INERT, not a winner
 *
 * A workspace row whose pattern is already granted above contributes nothing to
 * any verdict: membership is tested against the whole array, so the grant is
 * already in effect when the workspace layer is read. (`getMergedConfig`'s own
 * docblock says the position of a duplicate is ATTRIBUTION-only — it picks which
 * pattern name lands in a reason string — and is not a verdict flip.) The row is
 * therefore marked inert rather than left looking identical to a live one, which
 * is what the row's `done_means` asks for.
 *
 * Deliberately NOT done here: the source-level (`plugin`) scope and the managed
 * layer. Neither reaches this page — the page reads two files — and inventing
 * either would be the fictional resolver P6.168 already refused to build.
 *
 * Exported so the derivation is testable directly rather than by source match.
 */
export function annotateRowsAlreadyGrantedByDefaults(
  customRows: readonly PermissionRow[],
  defaultRows: readonly PermissionRow[],
  sentence: string,
): PermissionRow[] {
  // NUL-joined so a pattern containing the separator cannot forge a key for a
  // different type. Only `allowed` rows participate: the default table renders
  // nothing else, and a `blocked` row is a different claim entirely.
  const key = (row: PermissionRow) => `${row.access}\u0000${row.type}\u0000${row.pattern}`
  const granted = new Set(defaultRows.filter(row => row.access === 'allowed').map(key))
  return customRows.map(row => {
    // An existing sentence wins: a blocked row already carries P3.351's
    // pre-emption reason, which is about what the runtime does rather than about
    // which scope granted it, and overwriting it would trade a stronger finding
    // for a weaker one.
    if (row.unenforceable) return row
    if (row.access !== 'allowed' || !granted.has(key(row))) return row
    return { ...row, unenforceable: sentence }
  })
}

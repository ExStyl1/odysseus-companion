/**
 * Plugin-detail diagnostics projection (sev-3, 1.25.0 signed-build audit).
 *
 * A format adapter that REFUSES a declared component by policy — the measured
 * case is a Claude plugin's `npx`/`bunx` MCP server with no bundle-local
 * materialized dependency (`format-adapters/claude.ts`,
 * `plugin.format.claude_mcp_command_unavailable`) — writes two records: a
 * `PluginDiagnostic` on the stored manifest and an entry on the persisted
 * `PluginCompatibilityReport`. Only the SECOND crosses the safe boundary:
 * `plugin.format.*` diagnostics never enter the resolver snapshot, so
 * `UserCapabilityCatalog.diagnostics` never carries them, while
 * `SafeInstalledPluginSummary.compatibility` is projected verbatim by
 * `toSafeInstalledPlugin` (`capabilities/views.ts`) — `deferred` and `blocked`
 * merged, each stripped to `externalKind` + `reasonCode`.
 *
 * That report is therefore the truthful, already-path-free record of what the
 * runtime refused, and this module turns it into the diagnostics the plugin's
 * own detail page shows. Nothing is added to the payload: the two fields the
 * marketplace card already renders are the two fields rendered here, through
 * the same `plugins.compatDeferredEntry` copy.
 *
 * Pure (no React / IPC), so the projection is testable without mounting.
 *
 * ## What this is NOT, and where the missing half lives — P6.411
 *
 * Everything above is INSTALL-TIME and PER-PLUGIN: a `PluginCompatibilityReport`
 * is written when a format adapter refuses a declared component, and this page
 * is the one plugin the user opened. It answers "what did this bundle fail to
 * contribute", and it cannot answer P6.411's question — *which plugins loaded in
 * THIS session and which silently did not* — because a capability can install
 * cleanly and still be withheld at run time, by being disabled, by an unmet
 * trust decision, or by the runtime not supporting its kind.
 *
 * The record for that question already EXISTS and has no surface.
 * `AgentRuntimeView.withheld` (`capabilities/views.ts`, landed by P6.411's
 * mechanism half, `9ad1c13d9`) carries, per withheld capability, its key, kind,
 * logical name, the plugin it came from when it has one, and a `reason` that is
 * a VALUE — `disabled` / `review-required` / `blocked` / `unsupported-runtime` —
 * precisely so the surface owns the wording. It is produced at `toAgentRuntime`,
 * the single point all three runtimes converge on, so a surface built on it is
 * identical on Pi, claude and codex by construction rather than by agreement.
 *
 * It does not reach here because it does not reach the renderer at all:
 * `AgentRuntimeView` occurs only inside `SessionManager` outside the shared
 * package. Closing P6.411 is therefore a channel plus a session-scoped view, and
 * both sit outside this module — recorded here rather than in a lane report so
 * the next reader of this file finds the seam instead of re-deriving it.
 */

import type {
  SafeCapabilityDiagnostic,
  SafeInstalledPluginSummary,
} from '@nessy-agent/shared/protocol/capabilities'

/** Reused verbatim from the marketplace card's deferred-capability line. */
const DEFERRED_ENTRY_MESSAGE_KEY = 'plugins.compatDeferredEntry'

/**
 * Every capability this runtime refused, as detail-page diagnostics.
 *
 * `state` drives severity because it is the adapter's own verdict: `blocked`
 * means the bundle cannot run, `partial` means it runs with less than it
 * declared. `supported` reports nothing — an empty result keeps the section's
 * placeholder, which is the honest answer for a plugin that imported cleanly.
 */
export function pluginDetailDiagnostics(
  plugin: SafeInstalledPluginSummary,
): SafeCapabilityDiagnostic[] {
  const compatibility = plugin.compatibility
  if (!compatibility) return []
  const severity: SafeCapabilityDiagnostic['severity'] =
    compatibility.state === 'blocked' ? 'error' : 'warning'
  return compatibility.deferred.map(entry => ({
    severity,
    code: entry.reasonCode,
    messageKey: DEFERRED_ENTRY_MESSAGE_KEY,
    // Names and statuses only — an external kind and a reason code, the same
    // two the browse card shows. No path, command, URL or secret ref exists on
    // this shape to leak.
    safeArgs: { kind: entry.externalKind, reason: entry.reasonCode },
  }))
}

/**
 * Whether the plugin installed and then contributed nothing usable.
 *
 * The measured `playwright` case: its bare-map `.mcp.json` server was the whole
 * bundle, the adapter refused it, and the page still read "State: Active". An
 * empty inventory ALONE is not dishonest (a bundle may legitimately ship
 * nothing this runtime projects), so this requires a refusal to point at —
 * which is also what makes the "see Diagnostics" reference true.
 */
export function pluginShippedNoUsableComponents(
  plugin: SafeInstalledPluginSummary,
  diagnostics: readonly SafeCapabilityDiagnostic[],
): boolean {
  return (plugin.components?.length ?? 0) === 0 && diagnostics.length > 0
}

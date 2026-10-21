import type {
  SafeCapabilityContextRef,
  SafeCapabilitySummary,
  UserCapabilityCatalog,
} from '@nessy-agent/shared/protocol/capabilities'
import type { BuiltinDpMcpSettingsViewV1 } from '../../shared/types'

export type SafeSourceRow = SafeCapabilitySummary & { kind: 'source' | 'mcp'; sourceType?: 'api' | 'mcp' | 'local' }
export type SafeSkillRow = SafeCapabilitySummary & { kind: 'skill' }

export function capabilityDisplayName(item: SafeCapabilitySummary): string {
  return item.mention?.label ?? item.displayName ?? item.logicalName
}

export function capabilityContext(workspaceId: string, sessionId?: string | null): SafeCapabilityContextRef {
  return sessionId ? { workspaceId, sessionId } : { workspaceId }
}

export function isSafeSourceRow(item: SafeCapabilitySummary): item is SafeSourceRow {
  return item.kind === 'source' || item.kind === 'mcp'
}

/**
 * Composer selection contract (R3, part C): the composer source picker and its
 * `@mention` autocomplete are restricted to folder + API sources only. MCP
 * (native `.mcp.json`/`mcp.json` servers with `kind: 'mcp'`, and any MCP-
 * transport source config carrying `sourceType: 'mcp'`) is governed by
 * plugin/config activation alone — analogous to Codex/Claude — so it is never a
 * per-session composer toggle. Excluding MCP here removes the former dead
 * toggle (an MCP row the picker showed but the resolver never session-gated;
 * see `resolver.ts` / `storage-runtime.ts`, where the session-selection gate is
 * `kind === 'source'` only and MCP stays exempt/activation-governed).
 *
 * This is an EXPLICIT allow-list of composer-selectable transports, kept easy
 * to extend for future kinds. It intentionally does NOT touch `isSafeSourceRow`
 * (the Sources management panel keeps MCP — R2).
 */
const COMPOSER_SELECTABLE_SOURCE_TYPES: ReadonlyArray<'api' | 'local'> = ['api', 'local']

export function isComposerSelectableSourceRow(item: SafeCapabilitySummary): item is SafeSourceRow {
  if (item.kind !== 'source') return false
  const sourceType = item.sourceType ?? 'api'
  return COMPOSER_SELECTABLE_SOURCE_TYPES.includes(sourceType as 'api' | 'local')
}

/**
 * UB14.31 — the ONE identity a composer source is picked by: the id its `@mention` carries, else its
 * logical name. The toolbar's sources chip (desktop AND compact) and both source selectors key on it,
 * so a slug the picker stored is a slug the chip counts. (The compact chip used to count by
 * `logicalName` alone while everything else keyed on the mention id; harmless only because
 * `capabilities/views.ts` stamps a source's `mention.id` with its logical name.)
 */
export function sourceSelectionId(item: SafeCapabilitySummary): string {
  return item.mention?.id ?? item.logicalName
}

export function isSafeSkillRow(item: SafeCapabilitySummary): item is SafeSkillRow {
  return item.kind === 'skill'
}

/** Only runnable skills belong in the composer picker and @mention results. */
export function isComposerSelectableSkillRow(item: SafeCapabilitySummary): item is SafeSkillRow {
  return isSafeSkillRow(item) && item.state === 'active'
}

/**
 * P6.311 — the identity the composer emits for one subagent.
 *
 * `logicalName` today, and that is a MEASURED limit rather than a choice.
 *
 * A PLUGIN subagent's identity is its scoped name — `sub-agents.md`, verbatim:
 * "Subagents provided by an enabled plugin appear in the typeahead under their
 * scoped name, such as `my-plugin:code-reviewer` or `my-plugin:review:security`
 * when the plugin organizes agents into subfolders". The catalog carries a
 * `mention` record that is exactly that scoped, collision-free identity — but
 * `SafeCapabilitySummary['mention'].type` is declared `'source' | 'skill'`
 * (`protocol/capabilities.ts`), so no agent row can carry one and the branch
 * below is unreachable at HEAD.
 *
 * It is kept rather than removed, and this paragraph is why: widening that
 * union is a protocol change with a producer on the other side of it, which is
 * a different lane's file. When it lands, the scoped id starts winning here
 * with no edit. Until then two plugins shipping an agent of the same name are
 * indistinguishable in the typeahead — reported, not papered over.
 *
 * Deliberately NOT `skillMentionInvocationId`'s short-alias logic either: a
 * skill may be selected under a short alias when unambiguous, and an agent name
 * is what the host has to resolve to exactly one definition.
 */
export function agentMentionInvocationId(item: SafeCapabilitySummary): string {
  return item.mention?.id ?? item.logicalName
}

/** Exact invocation identity emitted by the composer for one runnable skill. */
export function skillMentionInvocationId(item: SafeCapabilitySummary): string {
  const mention = item.mention
  if (!mention) return item.logicalName
  return mention.selectedAsShortAlias === false && mention.qualifiedId
    ? mention.qualifiedId
    : mention.id
}

export function sourceTypeFor(item: SafeSourceRow): 'api' | 'mcp' | 'local' {
  if (item.kind === 'mcp') return 'mcp'
  return item.sourceType ?? 'api'
}

export function capabilityRouteId(key: string): string {
  return encodeURIComponent(key)
}

export function capabilityKeyFromRoute(id: string): string {
  try {
    return decodeURIComponent(id)
  } catch {
    return id
  }
}

// ---------------------------------------------------------------------------
// Unified MCP servers panel rows (C6, capability-path plan / ADR § 6)
// ---------------------------------------------------------------------------

/** One row of the unified MCP servers panel. Path-/secret-free by construction. */
export interface McpServerRow {
  /** Stable row id (capability key, or pluginKey#capabilityId fallback). */
  id: string
  name: string
  description?: string
  /** Who owns the server. */
  originKind: 'plugin' | 'user' | 'builtin' | 'managed'
  /** Owning plugin's display name (plugin rows only). */
  pluginName?: string
  pluginKey?: string
  /** `set-capability-enabled` target (plugin rows only). */
  capabilityId?: string
  /**
   * `setBuiltinDpMcpServerEnabled` target — the built-in dp set's wire name
   * (A7 rows only). Present ONLY on rows whose switch must go through the
   * built-in dp preference, never through the plugin capability mutation, so
   * the two write paths cannot be confused at the call site.
   *
   * Derived on BOTH halves of a built-in row — the capability projection and the
   * RPC view — because either half can be the one that survives: with no catalog
   * yet the RPC row stands alone, and with no RPC read yet the catalog row does.
   * A half that forgets it renders a switch-shaped nothing.
   */
  builtinDpName?: string
  /** Detail-page navigation target when one exists. */
  capabilityKey?: string
  transport?: 'stdio' | 'http' | 'sse' | 'ws'
  /** Row avatar, when the capability carries one (same field the Sources list reads). */
  iconUrl?: string
  enabled: boolean
  credentialState?: SafeCapabilitySummary['credentialState']
  state?: SafeCapabilitySummary['state']
  unavailableReason?: string
}

/**
 * The built-in dp set (A7) as ordinary rows of the SAME list.
 *
 * Owner decision 2026-08-01: a built-in must look like every other MCP entry —
 * same row shape, same list, same ordering — not a card of its own under the
 * list.
 *
 * The set now arrives TWICE, deliberately, and this module is the join:
 *
 * - The capability catalog carries it (`storage-runtime.ts`'s
 *   `builtinDpMcpCapabilityRecords`), which is what gives a built-in row its
 *   `capabilityKey` — and therefore its detail page, its tools section and its
 *   metadata table, with no second screen.
 * - The `getBuiltinDpMcpServers` RPC carries it too, and it stays the SWITCH's
 *   state: the toggle writes the preference and updates this view optimistically,
 *   while nothing publishes a capability-changed event for that write
 *   (`handlers/rpc/settings.ts`'s `builtinDpMcp:setEnabled`). Taking `enabled`
 *   from the catalog alone would leave the switch visibly stuck until a restart.
 *   It is also the only half that knows whether `dp` is installed — the
 *   capability projection deliberately does no filesystem lookup.
 *
 * `transport` is `stdio` by construction, not by report: every definition
 * materializes to `dp ai mcp <subcommand>` as a child process
 * (`mcp/builtin-dp-servers.ts`). `unavailableReason` carries the backend's own
 * sentence when `dp` is missing — the switches stay live (a preference is a
 * preference) but the row has to say why nothing will start.
 */
function buildBuiltinDpMcpRows(view: BuiltinDpMcpSettingsViewV1 | null | undefined): McpServerRow[] {
  if (!view) return []
  const unavailableReason = view.available
    ? undefined
    : view.diagnostics.map(diagnostic => diagnostic.message).join(' ')
  return view.servers.map(server => ({
    id: `builtin-dp:${server.name}`,
    name: server.name,
    ...(server.description ? { description: server.description } : {}),
    originKind: 'builtin' as const,
    builtinDpName: server.name,
    transport: 'stdio' as const,
    enabled: server.enabled,
    ...(unavailableReason ? { unavailableReason } : {}),
  }))
}

/**
 * Build the unified MCP server rows — plugin-owned, user-created and built-in
 * together (ADR § 6: ONE surface, mirroring Claude's `/mcp`). The plugin detail
 * page consumes the SAME rows filtered by `pluginKey` — a view, not a second
 * surface.
 *
 * A built-in whose wire name is already taken by a CONFIGURED server is
 * DROPPED, because that is what the runtime does: `mergeBuiltinDpMcpServers`
 * yields to the configured entry, so a second row would advertise a server that
 * can never start. A built-in whose name matches the catalog's own projection of
 * the same built-in is not a collision — it is the join, and the two halves are
 * merged into one row (see `buildBuiltinDpMcpRows`).
 */
export function buildMcpServerRows(catalog: {
  installedPlugins?: UserCapabilityCatalog['installedPlugins']
  capabilities?: SafeCapabilitySummary[]
}, builtinDp?: BuiltinDpMcpSettingsViewV1 | null): McpServerRow[] {
  const rows: McpServerRow[] = []
  const capabilities = catalog.capabilities ?? []
  const byKey = new Map(capabilities.map(capability => [capability.key, capability]))
  // F1.635 — the wire names the organisation's policy actually OWNS: an active
  // org row is the server the fold delivers under that name
  // (`foldManagedOrgMcpServers` — the org entry wins it), so a built-in under
  // the same name advertises a server that can never start and must yield, on
  // the catalog half exactly as the RPC half below. ACTIVE only: a
  // policy-DENIED org row displaces nothing in the fold (the entry is refused
  // before the merge), so the built-in it would have displaced keeps its row.
  const managedWireNames = new Set(
    capabilities
      .filter(capability => capability.origin === 'managed' && capability.state === 'active')
      .map(capability => capability.logicalName),
  )
  const claimedKeys = new Set<string>()
  for (const plugin of catalog.installedPlugins ?? []) {
    for (const component of plugin.components ?? []) {
      if (component.kind !== 'mcp') continue
      const summary = component.capabilityKey ? byKey.get(component.capabilityKey) : undefined
      if (component.capabilityKey) claimedKeys.add(component.capabilityKey)
      rows.push({
        id: component.capabilityKey ?? `${plugin.pluginKey}#${component.capabilityId ?? component.name}`,
        name: component.name,
        ...(component.description ? { description: component.description } : {}),
        originKind: 'plugin',
        pluginName: plugin.name,
        pluginKey: plugin.pluginKey,
        ...(component.capabilityId ? { capabilityId: component.capabilityId } : {}),
        ...(component.capabilityKey ? { capabilityKey: component.capabilityKey } : {}),
        ...(summary?.mcpTransport ? { transport: summary.mcpTransport } : {}),
        ...(summary?.iconUrl ? { iconUrl: summary.iconUrl } : {}),
        enabled: component.enabled ?? true,
        ...(summary ? { credentialState: summary.credentialState, state: summary.state } : {}),
        ...(component.unavailableReason ? { unavailableReason: component.unavailableReason } : {}),
      })
    }
  }
  for (const capability of capabilities) {
    if (claimedKeys.has(capability.key)) continue
    const isMcp = capability.kind === 'mcp'
      || (capability.kind === 'source' && capability.sourceType === 'mcp')
    if (!isMcp || capability.origin === 'plugin') continue
    const isManaged = capability.origin === 'managed'
    const isBuiltin = capability.origin === 'builtin'
    // F1.635 — a built-in the org policy displaced never starts; the active
    // managed row under that wire name is the honest one to show.
    if (isBuiltin && managedWireNames.has(capability.logicalName)) continue
    rows.push({
      id: capability.key,
      name: capabilityDisplayName(capability),
      ...(capability.description ? { description: capability.description } : {}),
      originKind: isManaged ? 'managed' : isBuiltin ? 'builtin' : 'user',
      capabilityKey: capability.key,
      // THE TOGGLE'S ROUTE. A built-in projected through the catalog must still
      // write the built-in preference, never `set-capability-enabled` — and the
      // panel decides that per row, from this field alone. Without it the switch
      // silently degrades to plain text (`McpServersPanel`'s `onToggle` falls
      // through to `null`), which looks like a rendering nicety and is actually
      // "this server can no longer be turned on".
      //
      // `logicalName` and not `name`: `name` is the DISPLAY name, and the
      // preference key is the wire name.
      ...(isBuiltin ? { builtinDpName: capability.logicalName } : {}),
      ...(capability.mcpTransport ? { transport: capability.mcpTransport } : {}),
      ...(capability.iconUrl ? { iconUrl: capability.iconUrl } : {}),
      enabled: capability.state === 'active',
      credentialState: capability.credentialState,
      state: capability.state,
      // On a built-in row `unavailableReason` means ONE thing to the panel —
      // "dp is not installed, so nothing here can start" — and it renders a
      // warning badge for it. The resolver's reason for a switched-off built-in
      // is `source-disabled`, which is not that: copying it through would put a
      // warning badge on every server the user simply left off, beside the
      // "disabled" badge that already says so. The dp-availability sentence
      // comes from the RPC half below, which is the only half that looked.
      ...(capability.unavailableReason && !isBuiltin
        ? { unavailableReason: capability.unavailableReason }
        : {}),
    })
  }
  // WIRE names, not display names. `mergeBuiltinDpMcpServers` keys its
  // stand-down on the wire name, and a user may give their own server any
  // display name they like — so keying this drop on `row.name` (which is
  // `displayName ?? logicalName`) let a renamed `dpJira` show the built-in
  // `dpJira` as a second row while the runtime still started exactly one.
  const configuredWireNames = new Set<string>()
  for (const capability of capabilities) {
    if (capability.origin === 'builtin') continue
    configuredWireNames.add(capability.logicalName)
  }
  for (const plugin of catalog.installedPlugins ?? []) {
    for (const component of plugin.components ?? []) {
      if (component.kind === 'mcp') configuredWireNames.add(component.name)
    }
  }
  const byName = new Map(rows.map(row => [row.name, row]))
  for (const builtinRow of buildBuiltinDpMcpRows(builtinDp)) {
    // A CONFIGURED server owns the wire name: the runtime's own merge yields to
    // it, so the built-in must not appear at all.
    if (configuredWireNames.has(builtinRow.builtinDpName ?? builtinRow.name)) continue
    const existing = byName.get(builtinRow.name)
    if (!existing) {
      rows.push(builtinRow)
      byName.set(builtinRow.name, builtinRow)
      continue
    }
    if (existing.originKind !== 'builtin') continue
    // The two halves of the same built-in. The catalog half owns identity and
    // navigation; the RPC half owns the live switch state and the dp-availability
    // sentence, for the reasons in `buildBuiltinDpMcpRows`.
    existing.enabled = builtinRow.enabled
    existing.builtinDpName = builtinRow.builtinDpName ?? existing.builtinDpName
    if (builtinRow.unavailableReason) existing.unavailableReason = builtinRow.unavailableReason
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name))
}

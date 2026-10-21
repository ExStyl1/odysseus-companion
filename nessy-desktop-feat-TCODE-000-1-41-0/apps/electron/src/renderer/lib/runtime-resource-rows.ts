import type { SafeCapabilitySummary, UserCapabilityCatalog } from '@nessy-agent/shared/protocol/capabilities'
import type { BuiltinDpMcpSettingsViewV1, SourceFilter } from '../../shared/types'
import {
  buildMcpServerRows,
  capabilityRouteId,
  isSafeSkillRow,
  isSafeSourceRow,
  sourceTypeFor,
  type SafeSkillRow,
  type SafeSourceRow,
} from './capability-catalog'
import { sourceListSkillId } from './source-list-ids'

export type RuntimeResourceRow =
  | { kind: 'source'; id: string; item: SafeSourceRow }
  | { kind: 'skill'; id: string; item: SafeSkillRow }

export type RuntimeResourceFilter = SourceFilter | { kind: 'type'; sourceType: 'skills' }

export function buildRuntimeResourceRows(input: {
  capabilities: SafeCapabilitySummary[]
  filter?: RuntimeResourceFilter | null
}): RuntimeResourceRow[] {
  const sourceType = input.filter?.kind === 'type' ? input.filter.sourceType : null
  const sources = input.capabilities.filter(isSafeSourceRow)
  const skills = input.capabilities.filter(isSafeSkillRow)

  if (sourceType === 'skills') {
    return skills.map(item => ({ kind: 'skill', id: sourceListSkillId(item.key), item }))
  }

  const sourceRows = sources
    .filter(item => !sourceType || sourceTypeFor(item) === sourceType)
    .map(item => ({ kind: 'source' as const, id: capabilityRouteId(item.key), item }))

  if (sourceType) return sourceRows

  return [
    ...sourceRows,
    ...skills.map(item => ({ kind: 'skill' as const, id: sourceListSkillId(item.key), item })),
  ]
}

export function firstSelectableRowId(rows: RuntimeResourceRow[]): string | null {
  return rows[0]?.id ?? null
}

/** The four figures the Sources section of the left nav shows. */
export interface SourceNavigationCounts {
  api: number
  mcp: number
  local: number
  /** The `Sources` aggregate — its children plus skills, by construction. */
  total: number
}

/**
 * Every Sources count, derived ONCE.
 *
 * The MCP figure counts the rows `McpServersPanel` actually renders — the same
 * `buildMcpServerRows` call, built-ins included — rather than the MCP
 * capabilities in the catalog. The two used to be different derivations of the
 * "same" number, and the day built-ins became rows the nav said `MCPs 1` over a
 * list of 29. A counter that labels a list has to count that list.
 *
 * That is a renderer-side join, and it is the honest reading of a real split:
 * the rows come from the capability catalog AND from the built-in dp RPC, while
 * the count came from the catalog alone. The fix for the split is upstream —
 * projecting the built-in set into the catalog, so both come from one place;
 * until then this keeps the label and the list from disagreeing.
 *
 * `total` is the SUM of its children plus skills rather than a fourth
 * independent count, because `sourceTypeFor` puts every source row in exactly
 * one of api/mcp/local — so a sum cannot drift from the rows the way an
 * independent scan could.
 */
export function sourceNavigationCounts(input: {
  sources: SafeCapabilitySummary[]
  skills: SafeCapabilitySummary[]
  installedPlugins?: UserCapabilityCatalog['installedPlugins']
  builtinDp?: BuiltinDpMcpSettingsViewV1 | null
}): SourceNavigationCounts {
  const api = buildRuntimeResourceRows({ capabilities: input.sources, filter: { kind: 'type', sourceType: 'api' } }).length
  const local = buildRuntimeResourceRows({ capabilities: input.sources, filter: { kind: 'type', sourceType: 'local' } }).length
  const mcp = buildMcpServerRows(
    {
      capabilities: input.sources,
      ...(input.installedPlugins ? { installedPlugins: input.installedPlugins } : {}),
    },
    input.builtinDp,
  ).length
  return { api, mcp, local, total: api + mcp + local + input.skills.length }
}

/**
 * Best-effort guess at whether Show-in-Finder (`capabilities.REVEAL`) can
 * succeed for this capability (A9), from safe fields only. A capability the runtime
 * declared unsupported (`state: 'unsupported-runtime'`) is definitely
 * catalog-only — the server's `resolveCapabilityRevealPath`
 * (rpc/capabilities.ts) has no resource to point Finder at for that state and
 * always throws `capability-not-revealable`, so excluding it here is exact.
 *
 * This is NOT a complete predictor, though: a plugin-owned MCP capability can
 * be `state: 'active'` yet still have no revealable resource (its resolver
 * binding never sets `server.resource`, and `server.pluginRuntime` is only
 * present when the plugin instance's runtime context happens to be attached
 * at resolve time — see `capabilities/resolver.ts`'s `pluginRuntimeBinding`
 * mcp case). The safe DTO carries no field that distinguishes that case from
 * a normal active MCP, so this heuristic can occasionally leave Show-in-Finder
 * enabled for a row the RPC will reject. The one reveal every row menu calls
 * (`hooks/useCapabilityReveal.ts`, UB12.113) already catches that failure and
 * toasts an error, so the residual gap is a wrong tooltip/disabled-state, never
 * a crash or a silently swallowed error.
 */
export function canRevealCapability(capability: Pick<SafeCapabilitySummary, 'state'>): boolean {
  return capability.state !== 'unsupported-runtime'
}

/** {@link canRevealCapability} for a Sources-list row (a source or a skill). */
export function canRevealResourceRow(row: RuntimeResourceRow): boolean {
  return canRevealCapability(row.item)
}

import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { pushTyped } from '../../transport/push'
import {
  emitCapabilityCatalogInvalidation,
  emitPluginRuntimeInvalidation,
  type CapabilityInvalidationEffect,
  type NativeSourceInvalidationScope,
} from '@nessy-agent/shared/capabilities/invalidation'
import { assertStorageId } from '@nessy-agent/shared/workspaces'
import type { RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { ProjectKey } from '@nessy-agent/shared/projects/project-identity'
import type { PluginRuntimeRefreshRpcVerdict } from '@nessy-agent/shared/protocol'
import { pluginRuntimeRefreshFailure, type PluginRuntimeRefreshSummary } from '../../sessions/plugin-runtime-refresh-outcome'

export interface PluginMutationRefreshContext {
  workspaceId?: string
  projectKey?: ProjectKey
  /** Concrete renderer destinations for a global invalidation. */
  workspaceIds?: readonly string[]
}

function validWorkspaceId(workspaceId?: string): string | undefined {
  if (!workspaceId) return undefined
  try {
    return assertStorageId('workspace', workspaceId)
  } catch {
    return undefined
  }
}

/**
 * Immediate revoke/refresh notification for the plugin-mutation contract: emit the typed capability
 * invalidations (native-source bus + resolver-facing catalog bus) and push
 * `capabilities.CHANGED` to the renderer. Deliberately takes ONLY
 * (rpcServer, ctx, reason, effect) — no `HandlerDeps` — so callers that cannot
 * reach a `HandlerDeps` (e.g. `SessionManager`, which `HandlerDeps` wraps and
 * would otherwise create a circular dependency) can still produce the same
 * emit+push semantics as the RPC path. This runs before live-runtime teardown:
 * a slow process/MCP drain must never delay security revocation or renderer state.
 */
export function emitPluginMutationInvalidation(
  server: RpcServer,
  ctx: PluginMutationRefreshContext,
  reason: string,
  effect: CapabilityInvalidationEffect,
  /**
   * Renderer-facing tag on the pushed `capabilities.CHANGED`. Defaults to the
   * value every interactive mutation has always carried; the scheduled
   * marketplace auto-update passes its own so the renderer can tell a background
   * refresh apart from something the user just clicked, and notify accordingly
   * (`plugins/loading.md#when-auto-update-runs`). The field is a free-form string on the wire, so
   * this widens no union.
   */
  reasonCode: string = 'plugin-runtime-changed',
): void {
  const workspaceId = validWorkspaceId(ctx.workspaceId)
  const scope: NativeSourceInvalidationScope = workspaceId && ctx.projectKey
    ? { kind: 'project', workspaceId, projectKey: ctx.projectKey }
    : workspaceId
    ? { kind: 'workspace', workspaceId }
    : { kind: 'global' }
  emitPluginRuntimeInvalidation({ scope, effect })
  emitCapabilityCatalogInvalidation({
    scope: workspaceId && ctx.projectKey
      ? { kind: 'project', workspaceId, projectKey: ctx.projectKey }
      : workspaceId
        ? { kind: 'workspace', workspaceId }
        : { kind: 'global' },
    reason: ctx.pluginKey ? `${reason} (${ctx.pluginKey})` : reason, // F1.493 (1) — a revoked turn can name the plugin
    effect: effect === 'remove' ? 'revoke-active-snapshot' : 'refresh-before-next-turn', ...(ctx.pluginKey ? { pluginKey: ctx.pluginKey } : {}), // F1.766 — the revoke stops only turns holding it
  })

  const rendererWorkspaceIds = workspaceId
    ? [workspaceId]
    : [...new Set((ctx.workspaceIds ?? []).map(validWorkspaceId).filter((id): id is string => !!id))]
  for (const rendererWorkspaceId of rendererWorkspaceIds) {
    pushTyped(
      server,
      RPC_CHANNELS.capabilities.CHANGED,
      { to: 'workspace', workspaceId: rendererWorkspaceId },
      {
        workspaceId: rendererWorkspaceId,
        generation: '',
        reasonCode,
        effect: effect === 'remove' ? 'revoke-active-snapshot' : 'refresh-before-next-turn',
      },
    )
  }
}

/**
 * P2.107 — how the live runtimes ended up, or `undefined` when the refresh
 * could not be completed.
 *
 * `undefined` is the honest third answer and callers must treat it as "cannot
 * say", never as "applied": the refresh is wrapped in a fail-soft catch (a slow
 * or failing drain must not fail an already-committed mutation), and a caller
 * that reported "Plugin is now active" off a swallowed failure would be
 * asserting exactly what did not happen.
 */
export type PluginMutationRefreshVerdict = 'applied' | 'deferred' | 'reloaded' | 'failed' | undefined // F1.396 — see afterPluginMutation

/**
 * Which verdict a summary means for the USER: the plugin is live unless some
 * live session still holds the previous paths.
 *
 * `untouched` sessions count as applied — there is no stale runtime to refresh,
 * and the next turn builds from the mutated state.
 */
function describeRefreshSummary(summary: PluginRuntimeRefreshSummary): PluginMutationRefreshVerdict {
  if (summary.deferred > 0) return 'deferred'
  // P6.412 — a NATIVE reload outranks a teardown in what it tells the user (the
  // plugin is live in the session they are looking at) and it is the only
  // outcome that costs them tokens on the next request, so it may not be folded
  // into `applied`. Ordered after `deferred` deliberately: if any session still
  // holds the old paths, that is the fact the summary must carry.
  if ((summary.reloaded ?? 0) > 0) return 'reloaded'
  return 'applied'
}

/**
 * P6.563 — the same summary read for a USER-INITIATED refresh, where the third
 * outcome matters and `describeRefreshSummary` above deliberately hides it.
 *
 * After a MUTATION, `untouched` means "no stale runtime, the next turn builds
 * from the mutated state" — indistinguishable from applied for the user, which
 * is why the mutation reader folds it in. After a user clicks Refresh, folding
 * it in would answer a question the server never asked: nothing was refreshed
 * because there was nothing to refresh, and saying "the plugin runtime was
 * refreshed" there is the exact false report P6.563 exists to remove.
 */
export function describeRuntimeRefreshVerdict(
  summary: PluginRuntimeRefreshSummary,
): PluginRuntimeRefreshRpcVerdict {
  if (summary.failed) throw pluginRuntimeRefreshFailure(summary) // F1.265 — a session that failed is an error, never "refreshed"
  return summary.deferred > 0 ? 'deferred' : summary.applied > 0 ? 'applied' : 'untouched'
}

/**
 * After a plugin mutation: emit a typed invalidation, then refresh affected live runtimes.
 * capability invalidation carrying whether the change ADDS/refreshes availability
 * (W8 queues it) or REMOVES security/availability (W8 revokes the active
 * snapshot). The emission reuses the shared invalidation bus (W7 Step 10).
 *
 * P2.107 — and it REPORTS what the refresh did, so a caller that has to tell the
 * user whether their plugin is live reads the server's own verdict instead of
 * re-deriving one from session state.
 */
export async function afterPluginMutation(
  server: RpcServer,
  deps: HandlerDeps,
  ctx: PluginMutationRefreshContext,
  reason: string,
  effect: CapabilityInvalidationEffect = 'add-or-refresh',
): Promise<PluginMutationRefreshVerdict> {
  // Mutation state is already committed. Publish revocation/refresh before any
  // potentially slow agent/process/MCP drain so stale authority is withdrawn
  // immediately even when teardown later fails soft.
  const invalidationContext = ctx.workspaceId
    ? ctx
    : {
        ...ctx,
        workspaceIds: deps.workspaceService?.listResolved().map(workspace => workspace.id) ?? [],
      }
  emitPluginMutationInvalidation(server, invalidationContext, reason, effect)

  try {
    // F1.484 — a GLOBAL mutation (no `workspaceId`) still refreshes every live session, and its VERDICT answers for
    // the caller's workspace, as the agent channel's has since F1.407; a scoped one is already that workspace alone.
    const answerFor = ctx.workspaceId ? undefined : ctx.answerForWorkspaceId
    const summary = answerFor
      ? await deps.sessionManager.refreshPluginRuntime(ctx.workspaceId, ctx.projectKey, reason, answerFor)
      : await deps.sessionManager.refreshPluginRuntime(ctx.workspaceId, ctx.projectKey, reason)
    // F1.265 — the log says what EVERY session did, which the rejected `Promise.all` used to throw away.
    // F1.396 (origin WJ-ff P-WJ-ff-2) — and the answer is `'failed'`, no longer `undefined`: "cannot say" sent the
    // renderer to its own derivation, which reads only the ACTIVE session's `isProcessing` and so could announce
    // "Plugin is now active" while another live session still held the previous plugins. `'failed'` is the value the
    // agent tool channel already answers for the same fact (`runtimeRefresh: 'failed'`, F1.211), so the two channels
    // say one thing. A refresh that threw outright (the catch below) still answers `undefined`.
    if (summary.failed) {
      deps.platform.logger?.warn(
        `PLUGIN_RUNTIME_REFRESH: ${summary.failed} session(s) failed after ${reason} (applied ${summary.applied}, `
          + `reloaded ${summary.reloaded ?? 0}, deferred ${summary.deferred}, untouched ${summary.untouched}): `
          + (summary.failures ?? []).map(failure => `${failure.sessionId}: ${failure.error}`).join('; '),
      )
      return 'failed'
    }
    return describeRefreshSummary(summary)
  } catch (error) {
    deps.platform.logger?.warn(
      `PLUGIN_RUNTIME_REFRESH: Failed after ${reason}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
}

// F1.484 (origin WJ-ss-b P-WJ-ss-b-3) — declared by interface merging so no cited line above moves.
export interface PluginMutationRefreshContext {
  /**
   * The workspace whose user reads the verdict. A GLOBAL mutation (install, update, repair, uninstall) still
   * refreshes every live session on the machine; this only scopes what the VERDICT counts, exactly as the agent
   * channel has since F1.407 — sessions elsewhere become `otherWorkspaces` (a bare count) and never turn this
   * workspace's notice into "failed". Absent keeps the machine-wide answer.
   */
  answerForWorkspaceId?: string
  /**
   * F1.493 (1) — the plugin the mutation was about, when the caller knows it. It rides on the capability catalog
   * invalidation's REASON (so a turn whose snapshot that invalidation revokes can say which plugin was removed) and,
   * since F1.766, as its `pluginKey`, so a revoke stops only the turns whose snapshot held this plugin.
   */
  pluginKey?: string
}

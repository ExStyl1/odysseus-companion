import {
  RPC_CHANNELS,
  isSafePluginManagementActionRequest,
  type SafePluginActivationTarget,
  type SafePluginManagementActionRequest,
  type SafePluginManagementActionResult,
} from '@nessy-agent/shared/protocol'
import {
  isPluginMutationCommittedError,
  type PluginActivationTarget,
  type PluginCompatibilityReport,
  type PluginKey,
  type PluginManagementRepairOptions,
} from '@nessy-agent/shared/plugins'
import { resolveInstalledUpdateOptions } from '@nessy-agent/shared/marketplace'
import type { ProjectKey } from '@nessy-agent/shared/projects/project-identity'
import type { RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { resolveCapabilityContext } from '../../domain/capabilities/context'
import { afterPluginMutation } from './plugin-runtime-refresh'

export const HANDLED_CHANNELS = [RPC_CHANNELS.plugins.MANAGE] as const

export function registerPluginsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const service = deps.pluginManagement

  const resolveSafeActivationTarget = async (
    ctx: RequestContext,
    target: SafePluginActivationTarget,
  ): Promise<{ workspaceId?: string; projectKey?: ProjectKey; target: PluginActivationTarget }> => {
    if (target.kind === 'global') return { target: { kind: 'global' } }

    const workspaceId = target.kind === 'workspace' ? target.workspaceId : target.context.workspaceId
    if (!ctx.workspaceId || ctx.workspaceId !== workspaceId) {
      throw new Error('plugin.manage.workspace-mismatch')
    }
    if (target.kind === 'workspace') {
      return { workspaceId, target: { kind: 'workspace', workspaceId } }
    }

    const handleService = deps.sessionManager.getProjectHandleService?.()
    if (!handleService) throw new Error('plugin.manage.project-context-unavailable')
    const resolved = await resolveCapabilityContext(target.context, {
      handleService,
      resolveSessionWorkingDirectory: (candidateWorkspaceId, sessionId) => (
        deps.sessionManager.getWorkingDirectory(sessionId, candidateWorkspaceId) ?? undefined
      ),
    })
    if (!resolved.projectKey) throw new Error('plugin.manage.project-context-required')
    return {
      workspaceId: resolved.workspaceId,
      projectKey: resolved.projectKey,
      target: { kind: 'project', workspaceId: resolved.workspaceId, projectKey: resolved.projectKey },
    }
  }

  /**
   * R88 — what the user-clicked Update actually fetches.
   *
   * `PluginManagementApi.update` is `repair` plus a caller-supplied source, and
   * the service refuses to grow a catalog of its own ("this service holds no
   * catalog and must not grow one, because the catalog's allowlist gates live on
   * the registry controller"). This handler is that caller. It used to pass
   * nothing, so Update re-fetched the version already installed and returned ok
   * — a no-op that toasted success, on exactly the marketplaces
   * `plugins/loading.md#which-marketplaces-and-plugins-auto-update` leaves auto-update OFF for.
   *
   * The decision and its wording moved to `resolveInstalledUpdateOptions` when
   * R88b found the agent's `plugin_manage` tool was the same no-op: two callers,
   * one switch, so the honest refusals cannot drift. It still PEEKS the catalog
   * (`peekCachedItems()`, the cached-only read R81 established — no clone on the
   * request path, no retry-budget spend, no `marketplaces.json` write) and still
   * decides through `planInstalledUpdate`, so read and write stay the same rows
   * in the same order as the badge the user clicked.
   */
  const resolveUpdateOptions = (
    management: NonNullable<HandlerDeps['pluginManagement']>,
    pluginKey: PluginKey,
  ): Promise<PluginManagementRepairOptions> =>
    resolveInstalledUpdateOptions(deps.marketplaceRegistrySource, management, pluginKey)

  server.handle(
    RPC_CHANNELS.plugins.MANAGE,
    async (ctx, unsafeRequest: unknown): Promise<SafePluginManagementActionResult> => {
      if (!isSafePluginManagementActionRequest(unsafeRequest)) {
        throw new Error('plugin.manage.invalid-request')
      }
      if (!service) throw new Error('plugin.manage.runtime-unavailable')

      const request: SafePluginManagementActionRequest = unsafeRequest
      // Lifecycle operations (repair/update/uninstall) mutate the one global
      // installed bundle. They must never inherit the caller window's
      // workspace, otherwise other live workspaces retain stale runtimes after
      // the global mutation. Scoped activation actions set this explicitly
      // from their validated target below.
      let workspaceId: string | undefined
      let projectKey: ProjectKey | undefined
      let ok = true
      let pendingAuth: SafePluginManagementActionResult['pendingAuth']
      let authRequirements: SafePluginManagementActionResult['authRequirements']
      let compatibility: PluginCompatibilityReport | undefined
      let requiresConfirmation: boolean | undefined
      let configuration: SafePluginManagementActionResult['configuration']
      let mutated = true

      try {
        if (request.action === 'enable' || request.action === 'disable') {
          const activation = await resolveSafeActivationTarget(ctx, request.target)
          workspaceId = activation.workspaceId
          projectKey = activation.projectKey
          const result = await service[request.action](request.pluginKey, activation.target)
          pendingAuth = result.authRequests
          authRequirements = result.authRequirements
          // `plugins/components.md#when-the-configuration-dialog-appears` — the enable-time prompt. Value-free; the
          // same shape `configuration-status` returns, so the renderer raises
          // one dialog from one type.
          configuration = result.configuration
        } else if (request.action === 'set-capability-enabled') {
          const activation = await resolveSafeActivationTarget(ctx, request.target)
          workspaceId = activation.workspaceId
          projectKey = activation.projectKey
          await service.setCapabilityEnabled(
            request.pluginKey, activation.target, request.capabilityId, request.enabled,
          )
        } else if (request.action === 'repair' || request.action === 'update') {
          // Repair re-materializes the PINNED origin (no source); update resolves
          // the catalog source first, or refuses (R88).
          const options = request.action === 'update'
            ? await resolveUpdateOptions(service, request.pluginKey)
            : {}
          const result = await service[request.action](request.pluginKey, options)
          ok = result.ok
          pendingAuth = result.authRequests
          authRequirements = result.installed?.authRequirements
          compatibility = result.compatibility
          requiresConfirmation = result.requiresConfirmation
        } else if (request.action === 'configuration-status'
          || request.action === 'configure'
          || request.action === 'clear-configuration') {
          if (!ctx.workspaceId || ctx.workspaceId !== request.workspaceId) {
            throw new Error('plugin.manage.workspace-mismatch')
          }
          workspaceId = request.workspaceId
          if (request.action === 'configuration-status') {
            mutated = false
            configuration = await service.configurationStatus(request.pluginKey, request.workspaceId)
          } else if (request.action === 'configure') {
            configuration = await service.configure(request.pluginKey, request.workspaceId, request.values)
          } else {
            configuration = await service.clearConfiguration(request.pluginKey, request.workspaceId)
          }
        } else {
          await service.uninstall(request.pluginKey)
        }
      } catch (error) {
        if (isPluginMutationCommittedError(error)) {
          await afterPluginMutation(server, deps, { ...(ctx.workspaceId ? { answerForWorkspaceId: ctx.workspaceId } : {}), pluginKey: request.pluginKey, // F1.484 + F1.493 (1)
            ...(workspaceId ? { workspaceId } : {}),
            ...(projectKey ? { projectKey } : {}),
          }, `plugin ${error.action}`, error.effect)
        }
        throw error
      }

      // A rejected repair/update did not mutate the installed registry or
      // activation policy. Do not invalidate and globally drain every live
      // runtime for a no-op failure (and never let that unrelated drain hold
      // the error response open).
      if (ok && mutated) {
        const effect = request.action === 'disable' || request.action === 'uninstall'
            || request.action === 'clear-configuration'
            || (request.action === 'set-capability-enabled' && !request.enabled)
            || ((request.action === 'repair' || request.action === 'update')
              && compatibility?.state === 'partial')
          ? 'remove'
          : 'add-or-refresh'
        await afterPluginMutation(server, deps, { ...(ctx.workspaceId ? { answerForWorkspaceId: ctx.workspaceId } : {}), pluginKey: request.pluginKey, // F1.484 + F1.493 (1)
          ...(workspaceId ? { workspaceId } : {}),
          ...(projectKey ? { projectKey } : {}),
        }, `plugin ${request.action}`, effect)
      }
      return {
        ok,
        pluginKey: request.pluginKey,
        action: request.action,
        ...(compatibility ? {
          state: compatibility.state,
          deferred: [...compatibility.deferred, ...compatibility.blocked].map(entry => ({
            externalKind: entry.externalKind,
            reasonCode: entry.reasonCode,
          })),
        } : {}),
        ...(requiresConfirmation ? { requiresConfirmation: true } : {}),
        // T2 split (plugin-install plan § 0b-2): `authRequests` keeps its
        // renderer contract — a one-shot `performOAuth` chain — so only the
        // ON_INSTALL subset rides it; the full awaiting-auth list crosses as
        // the informational `pendingAuth`.
        ...(pendingAuth?.some(request => request.timing !== 'ON_FIRST_USE') ? {
          authRequests: pendingAuth
            .filter(request => request.timing !== 'ON_FIRST_USE')
            .map(request => ({ workspaceId: request.workspaceId, sourceSlug: request.sourceSlug })),
        } : {}),
        ...(pendingAuth?.length ? { pendingAuth } : {}),
        ...(authRequirements?.length ? { authRequirements } : {}),
        ...(configuration ? { configuration } : {}),
      }
    },
  )
}

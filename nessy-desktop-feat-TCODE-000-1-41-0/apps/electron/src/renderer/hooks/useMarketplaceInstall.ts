import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { PluginScope } from '@nessy-agent/shared/plugins/types'
import type {
  SafeCapabilityContextRef,
  SafeConnectorAuthRequest,
  SafeMarketplaceAddRegistryRequest,
  SafeMarketplaceEnableOfferRequest,
  SafeMarketplacePluginInstallRequest,
  SafeMarketplacePluginInstallResult,
  SafeMarketplaceRegistryRef,
  SafeMarketplaceSetRegistryAutoUpdateRequest,
  SafePluginManagementActionRequest,
  SafePluginActivationTarget,
} from '@nessy-agent/shared/protocol/capabilities'
import type { PluginRuntimeRefreshRpcVerdict } from '@nessy-agent/shared/protocol'
import { marketplaceQueryKeys } from './useMarketplaceItems'
import type { ElectronAPI } from '../../shared/types'

type ToggleRequest = Extract<SafePluginManagementActionRequest, { action: 'enable' | 'disable' }>
type CapabilityToggleRequest = Extract<SafePluginManagementActionRequest, { action: 'set-capability-enabled' }>
type LifecycleRequest = Extract<SafePluginManagementActionRequest, { action: 'update' | 'repair' | 'uninstall' }>

export async function consumeConnectorAuthRequests(
  requests: readonly SafeConnectorAuthRequest[] | undefined,
  _workspaceId: string | null,
  performOAuth: ElectronAPI['performOAuth'] = window.electronAPI.performOAuth,
): Promise<void> {
  if (!requests?.length) return
  for (const request of requests) {
    const result = await performOAuth({
      workspaceId: request.workspaceId,
      sourceSlug: request.sourceSlug,
    })
    if (!result.success) throw new Error(result.error || 'plugin.connector-auth-required')
  }
}

async function completePluginMutation<T extends { authRequests?: SafeConnectorAuthRequest[] }>(
  result: T,
  workspaceId: string | null,
): Promise<T> {
  await consumeConnectorAuthRequests(result.authRequests, workspaceId)
  return result
}

export function invalidateMarketplaceQueries(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.all })
}

/**
 * Classify an install result's A7-carry fields (`state`/`requiresConfirmation`
 * /`deferred`) into the UI affordance PluginsPage needs to drive: a
 * `blocked` install shows why and never offers enable; a `partial` install
 * that `requiresConfirmation` shows an explicit confirm-enable action instead
 * of auto-enabling. `supported` (or an install result with no compatibility
 * report at all, e.g. a hard failure before staging) needs neither
 * affordance. Pure/UI-agnostic so it is testable without rendering.
 */
export function describeInstallOutcome(
  result: SafeMarketplacePluginInstallResult,
  confirmationTarget?: SafePluginActivationTarget,
): {
  blocked: boolean
  needsConfirmEnable: boolean
  confirmationTarget?: SafePluginActivationTarget
} {
  const needsConfirmEnable = result.ok
    && result.state === 'partial'
    && result.requiresConfirmation === true
  return {
    // `ok:false` is always a rejected install, even when the adapter's
    // compatibility report is `partial` (for example app-only connector
    // metadata is unavailable). It must never reach an "installed" toast.
    blocked: !result.ok || result.state === 'blocked',
    needsConfirmEnable,
    ...(needsConfirmEnable && confirmationTarget ? { confirmationTarget } : {}),
  }
}

/**
 * P6.414 — one offered install scope, resolved to the activation target the
 * install request carries.
 *
 * `SafeMarketplacePluginInstallRequest.activateIn` has carried this all along
 * (`rpc/marketplace.ts` passes it straight to `service.install`), so decision A
 * — "offer the choice at install time" — needed no wire change: what was
 * missing is that the renderer computed a scope FOR the user from the listing's
 * kind and never asked. `PLUGIN_INSTALL_SCOPE_OFFERS` is the list to render;
 * this is the mapping behind it.
 *
 * `null` is "this scope cannot be targeted from here" — no workspace is open,
 * or no project context — and is deliberately distinct from a scope that can:
 * a caller must disable that choice rather than silently install somewhere
 * else, which is the behaviour the offer exists to replace.
 */
export function installScopeTarget(
  scope: PluginScope,
  workspaceId: string | null,
  context: SafeCapabilityContextRef | undefined,
): SafePluginActivationTarget | null {
  if (scope === 'user/global') return { kind: 'global' }
  if (scope === 'workspace') return workspaceId ? { kind: 'workspace', workspaceId } : null
  if (context && ('sessionId' in context || 'projectHandleId' in context)) return { kind: 'project', context }
  return null
}

export function useMarketplaceInstall(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (request: SafeMarketplacePluginInstallRequest) => completePluginMutation(
      await window.electronAPI.marketplace.install(request), workspaceId,
    ),
    onSettled: () => invalidateMarketplaceQueries(queryClient),
  })
}

export function useMarketplaceDisable(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (request: ToggleRequest & { action: 'disable' }) => completePluginMutation(
      await window.electronAPI.plugin.manage(request), workspaceId,
    ),
    onSettled: () => invalidateMarketplaceQueries(queryClient),
  })
}

export function useMarketplaceEnable(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (request: ToggleRequest & { action: 'enable' }) => completePluginMutation(
      await window.electronAPI.plugin.manage(request), workspaceId,
    ),
    onSettled: () => invalidateMarketplaceQueries(queryClient),
  })
}

export function useMarketplaceSetCapabilityEnabled(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (request: CapabilityToggleRequest) => completePluginMutation(
      await window.electronAPI.plugin.manage(request), workspaceId,
    ),
    // The capability write is complete before this callback. External
    // marketplace refresh must not keep that component's switch pending.
    onSettled: () => { void invalidateMarketplaceQueries(queryClient) },
  })
}

export function useMarketplaceUninstall(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (request: LifecycleRequest & { action: 'uninstall' }) => completePluginMutation(
      await window.electronAPI.plugin.manage(request), workspaceId,
    ),
    onSettled: () => invalidateMarketplaceQueries(queryClient),
  })
}

export function useMarketplaceRepair(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (request: LifecycleRequest & { action: 'repair' }) => completePluginMutation(
      await window.electronAPI.plugin.manage(request), workspaceId,
    ),
    onSettled: () => invalidateMarketplaceQueries(queryClient),
  })
}

/**
 * R82 — the per-plugin update action (`plugins-reference.md` § *plugin update*).
 * Same shape as repair: the server's `update` branch returns the same
 * ok/state/requiresConfirmation result, so the renderer treats it identically.
 */
export function useMarketplaceUpdate(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (request: LifecycleRequest & { action: 'update' }) => completePluginMutation(
      await window.electronAPI.plugin.manage(request), workspaceId,
    ),
    onSettled: () => invalidateMarketplaceQueries(queryClient),
  })
}

/**
 * P6.563 — the Plugins page's Refresh-runtime action.
 *
 * Until now this was `mutationFn: async () => undefined` plus a react-query
 * invalidation: it refreshed the CATALOG QUERIES in the renderer and nothing on
 * the server, while the button's toast said the plugin runtime had been
 * refreshed. `SessionManager.refreshPluginRuntime` — the method that actually
 * tears a live session's runtime down and rebuilds its capability snapshot —
 * had exactly one caller, inside the install/manage RPCs, reachable from no
 * renderer route.
 *
 * The mutation now returns the SERVER's verdict, so the caller reports what
 * happened rather than asserting it. `workspaceId` scopes the refresh to the
 * live sessions of one workspace; `null` (no workspace selected) refreshes
 * every live session, which is the only thing a workspace-less window can mean.
 */
export function useMarketplaceRefresh(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<PluginRuntimeRefreshRpcVerdict> => {
      const result = await window.electronAPI.marketplace.refreshRuntime(
        workspaceId ? { workspaceId } : {},
      )
      return result.verdict
    },
    onSuccess: () => invalidateMarketplaceQueries(queryClient),
  })
}

// ── R3: bring-your-own registry mutations. Each calls the RPC (the server does
// the clone — NO renderer-side fetch) and invalidates the marketplace queries so
// the grouped browse list + registry rows refresh.

/**
 * Map the add-marketplace dialog's `{source, gitRef, sparsePaths}` to the
 * ADD_REGISTRY RPC payload: `gitRef` → `refName`, `sparsePaths` passed through
 * (omit-when-empty). Pure so the mapping is unit-testable without rendering.
 */
export function addRegistryPayload(submit: {
  source: string
  gitRef: string
  sparsePaths: string[]
}): SafeMarketplaceAddRegistryRequest {
  return {
    source: submit.source,
    ...(submit.gitRef ? { refName: submit.gitRef } : {}),
    ...(submit.sparsePaths.length ? { sparsePaths: submit.sparsePaths } : {}),
  }
}

export function useMarketplaceAddRegistry() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: SafeMarketplaceAddRegistryRequest) => window.electronAPI.marketplace.addRegistry(request),
    onSuccess: () => invalidateMarketplaceQueries(queryClient),
  })
}

export function useMarketplaceUpgradeRegistry() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: SafeMarketplaceRegistryRef) => window.electronAPI.marketplace.upgradeRegistry(request),
    onSuccess: () => invalidateMarketplaceQueries(queryClient),
  })
}

export function useMarketplaceRemoveRegistry() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: SafeMarketplaceRegistryRef) => window.electronAPI.marketplace.removeRegistry(request),
    onSuccess: () => invalidateMarketplaceQueries(queryClient),
  })
}

/**
 * P6.517 / P6.518 — turn on a built-in catalog that ships present but off.
 *
 * The request carries the offer's NAME only; the source is pinned server-side.
 * Rides `marketplaceQueryKeys.all` like every other registry mutation, so the
 * chip strip and the browse list both refetch and the offer disappears from
 * `available` the moment it is registered.
 */
export function useMarketplaceEnableOffer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: SafeMarketplaceEnableOfferRequest) =>
      window.electronAPI.marketplace.enableOffer(request),
    onSuccess: () => invalidateMarketplaceQueries(queryClient),
  })
}

/**
 * `plugins/install.md#turn-auto-update-on-or-off-for-a-marketplace` — the per-marketplace Enable/Disable auto-update
 * control. The server owns the precedence (a managed value refuses the write),
 * so the renderer only reports what came back.
 */
export function useMarketplaceSetRegistryAutoUpdate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: SafeMarketplaceSetRegistryAutoUpdateRequest) =>
      window.electronAPI.marketplace.setRegistryAutoUpdate(request),
    onSuccess: () => invalidateMarketplaceQueries(queryClient),
  })
}

import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { getWorkspaceOrThrow } from '../utils'
import { safeJsonParse } from '@nessy-agent/shared/utils/files'
import { emitCapabilityCatalogInvalidation } from '@nessy-agent/shared/capabilities/invalidation'
import type { RpcServer } from '@nessy-agent/server-core/transport'
import { pushTyped } from '../../transport/push'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.sources.CREATE,
  RPC_CHANNELS.sources.DELETE,
  RPC_CHANNELS.sources.PENDING_AUTH,
  RPC_CHANNELS.workspace.GET_PERMISSIONS,
  RPC_CHANNELS.workspace.IMPORT_CLAUDE_PREVIEW,
  RPC_CHANNELS.workspace.IMPORT_CLAUDE_APPLY,
  RPC_CHANNELS.permissions.GET_DEFAULTS,
] as const

export function registerSourcesHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  // Create a new source
  server.handle(RPC_CHANNELS.sources.CREATE, async (_ctx, workspaceId: string, config: Partial<import('@nessy-agent/shared/sources').CreateSourceInput>) => {
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)
    const { createSource } = await import('@nessy-agent/shared/sources')
    const created = await createSource(workspace.workspaceRootPath, {
      name: config.name || 'New Source',
      provider: config.provider || 'custom',
      type: config.type || 'mcp',
      enabled: config.enabled ?? true,
      mcp: config.mcp,
      api: config.api,
      local: config.local,
    })
    notifyCapabilityChange(server, workspaceId, 'native-source-created', 'refresh-before-next-turn')
    return { ok: true, capabilityKey: `source:workspace:${workspaceId}:${created.slug}` }
  })

  // Delete a source
  server.handle(RPC_CHANNELS.sources.DELETE, async (_ctx, workspaceId: string, sourceSlug: string) => {
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)
    const { removeSourceEverywhere } = await import('@nessy-agent/shared/sources')
    // The same three ops the agent's `source_manage: remove` runs — one
    // implementation, two notify seams.
    await removeSourceEverywhere(sourceSlug, {
      workspaceRootPath: workspace.workspaceRootPath,
      ...(workspace.config.defaults?.enabledSourceSlugs
        ? { enabledSourceSlugs: workspace.config.defaults.enabledSourceSlugs }
        : {}),
      updateEnabledSourceSlugs: async next => {
        await deps.workspaceService!.updateSettings(workspaceId, {
          defaults: { enabledSourceSlugs: next },
        })
      },
      notifyRevoked: () => notifyCapabilityChange(server, workspaceId, 'native-source-deleted', 'revoke-active-snapshot'),
    })
  })

  // T4 (plugin-install plan § 5): the session-start notice's data. Value-free
  // and read-only — fetching it never connects a server and never starts auth.
  server.handle(RPC_CHANNELS.sources.PENDING_AUTH, async (_ctx, workspaceId: string) => {
    getWorkspaceOrThrow(deps.workspaceService, workspaceId)
    return deps.sessionManager.getWorkspacePendingAuth(workspaceId)
  })

  // Get permissions config for a workspace (raw format for UI display)
  server.handle(RPC_CHANNELS.workspace.GET_PERMISSIONS, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)

    const { existsSync, readFileSync } = await import('fs')
    const { getWorkspacePermissionsPath } = await import('@nessy-agent/shared/agent')
    const path = getWorkspacePermissionsPath(workspace.workspaceRootPath)

    if (!existsSync(path)) return null

    try {
      const content = readFileSync(path, 'utf-8')
      return safeJsonParse(content)
    } catch (error) {
      log.error('Error reading workspace permissions config:', error)
      return null
    }
  })

  // P2.9 — dry-run preview of importing a Claude Code setup (`~/.claude`) into
  // this workspace. Read-only: computes the change set and writes nothing.
  server.handle(RPC_CHANNELS.workspace.IMPORT_CLAUDE_PREVIEW, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)
    const { computeClaudeSetupImportPlan } = await import('@nessy-agent/shared/capabilities/claude-setup-import')
    return computeClaudeSetupImportPlan({ workspaceRootPath: workspace.workspaceRootPath })
  })

  // P2.9 — the confirmed write. Applies the same conversion the preview showed,
  // then invalidates the workspace capability catalog so imported skills / MCP
  // sources / hooks / permissions take effect.
  server.handle(RPC_CHANNELS.workspace.IMPORT_CLAUDE_APPLY, async (
    _ctx,
    workspaceId: string,
    // The plan the user confirmed in the preview. Pinning the write to it is
    // what stops a `~/.claude` edit between preview and confirm from importing
    // a set the user never saw.
    confirmedPlan?: import('@nessy-agent/shared/capabilities/claude-setup-import').ClaudeSetupImportPlan,
  ) => {
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)
    const { applyClaudeSetupImportPlan } = await import('@nessy-agent/shared/capabilities/claude-setup-import')
    const result = await applyClaudeSetupImportPlan(
      { workspaceRootPath: workspace.workspaceRootPath },
      confirmedPlan,
    )
    if (result.applied.length > 0) {
      notifyCapabilityChange(server, workspaceId, 'claude-setup-imported', 'refresh-before-next-turn')
    }
    return result
  })

  // Get default permissions from managed storage without exposing its path.
  server.handle(RPC_CHANNELS.permissions.GET_DEFAULTS, async () => {
    const { existsSync, readFileSync } = await import('fs')
    const { getAppPermissionsDir } = await import('@nessy-agent/shared/agent')
    const { join } = await import('path')

    const defaultPath = join(getAppPermissionsDir(), 'default.json')
    if (!existsSync(defaultPath)) return { config: null }

    try {
      const content = readFileSync(defaultPath, 'utf-8')
      return { config: safeJsonParse(content) }
    } catch (error) {
      log.error('Error reading default permissions config:', error)
      return { config: null }
    }
  })

}

function notifyCapabilityChange(
  server: RpcServer,
  workspaceId: string,
  reasonCode: string,
  effect: 'refresh-before-next-turn' | 'revoke-active-snapshot',
): void {
  emitCapabilityCatalogInvalidation({
    scope: { kind: 'workspace', workspaceId },
    reason: reasonCode,
    effect,
  })
  pushTyped(
    server,
    RPC_CHANNELS.capabilities.CHANGED,
    { to: 'workspace', workspaceId },
    { workspaceId, generation: '', reasonCode, effect },
  )
}

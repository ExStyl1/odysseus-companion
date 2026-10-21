import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { getWorkspaceOrThrow } from '../utils'
import type { RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.statuses.LIST,
  RPC_CHANNELS.statuses.REORDER,
] as const

export function registerStatusesHandlers(server: RpcServer, deps: HandlerDeps): void {
  // List all statuses for a workspace
  server.handle(RPC_CHANNELS.statuses.LIST, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)

    const { listStatuses } = await import('@nessy-agent/shared/statuses')
    return listStatuses(workspace.workspaceRootPath)
  })

  // Reorder statuses (drag-and-drop). Receives new ordered array of status IDs.
  // Config watcher will detect the file change and broadcast STATUSES_CHANGED.
  server.handle(RPC_CHANNELS.statuses.REORDER, async (_ctx, workspaceId: string, orderedIds: string[]) => {
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)

    const { reorderStatuses } = await import('@nessy-agent/shared/statuses')
    reorderStatuses(workspace.workspaceRootPath, orderedIds)
  })
}

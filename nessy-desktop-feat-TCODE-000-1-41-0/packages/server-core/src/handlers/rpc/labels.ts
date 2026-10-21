/**
 * Labels RPC handlers (list, create, delete).
 *
 * - Every handler runs `assertCallerWorkspace` (UA1.9) first, refusing
 *   `labels-workspace-mismatch` (upstream: no counterpart; UA12.43 — a window
 *   bound to one workspace could change another workspace's labels by id).
 * - UA12.42 — labels:list runs the load-time label-id repair before reading.
 */
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { getWorkspaceOrThrow } from '../utils'
import { pushTyped, type RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { assertCallerWorkspace } from './caller-workspace'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.labels.LIST,
  RPC_CHANNELS.labels.CREATE,
  RPC_CHANNELS.labels.DELETE,
] as const

export function registerLabelsHandlers(server: RpcServer, deps: HandlerDeps): void {
  // List all labels for a workspace.
  // UA12.42 — the load-time repair runs before the read: label ids minted before
  // UA12.40 ("", "-2", …) fail isValidLabelIdFormat and the config schema, so
  // config_validate reports them and the PreToolUse config guard refuses every
  // agent Write/Edit of labels/config.json until they are fixed. The pass is a
  // no-op for a healthy config; when it renames, the sessions on disk are
  // relabeled inside the repair, and the sessions this host holds in memory here
  // (else their next persist writes the old id back — the UA12.41 lesson).
  server.handle(RPC_CHANNELS.labels.LIST, async (ctx, workspaceId: string) => {
    assertCallerWorkspace(ctx, deps, workspaceId, 'labels-workspace-mismatch')
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)

    const { listLabels, repairLegacyLabelIds } = await import('@nessy-agent/shared/labels/storage')
    const repair = await repairLegacyLabelIds(workspace.workspaceRootPath, workspaceId)
    if (repair.renamed.size > 0) {
      try {
        const { mapLabelEntryId } = await import('@nessy-agent/shared/labels')
        for (const session of deps.sessionManager.getSessions(workspace.id)) {
          const labels = session.labels ?? []
          const mapped = labels.map(entry => mapLabelEntryId(entry, repair.renamed))
          if (mapped.some((entry, i) => entry !== labels[i])) {
            await deps.sessionManager.setSessionLabels(session.id, mapped, workspace.id)
          }
        }
      } finally {
        pushTyped(server, RPC_CHANNELS.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
      }
    }
    return listLabels(workspace.workspaceRootPath)
  })

  // Create a new label in a workspace
  server.handle(RPC_CHANNELS.labels.CREATE, async (ctx, workspaceId: string, input: import('@nessy-agent/shared/labels').CreateLabelInput) => {
    assertCallerWorkspace(ctx, deps, workspaceId, 'labels-workspace-mismatch')
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)

    const { createLabel } = await import('@nessy-agent/shared/labels/crud')
    const label = createLabel(workspace.workspaceRootPath, input)
    pushTyped(server, RPC_CHANNELS.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
    return label
  })

  // Delete a label (and descendants) from a workspace.
  // UA12.41 — deleteLabel strips the sessions on disk by the workspace ID (storage v2). Every session
  // SessionManager holds in memory is then stripped through its own labels setter (labels_changed event,
  // persist, flush): the disk write alone is skipped by the fs.watch reconcile as this process's own write,
  // so the next persist of that session would write the deleted id back. An unknown id throws before
  // anything is written; once the config is saved, labels:changed is pushed even if a later step fails
  // (the config watcher's onLabelConfigChange pushes the same channel as a backstop).
  server.handle(RPC_CHANNELS.labels.DELETE, async (ctx, workspaceId: string, labelId: string) => {
    assertCallerWorkspace(ctx, deps, workspaceId, 'labels-workspace-mismatch')
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)

    const { deleteLabel } = await import('@nessy-agent/shared/labels/crud')
    const { extractLabelId } = await import('@nessy-agent/shared/labels')
    const { stripped, removedIds } = await deleteLabel(workspace.workspaceRootPath, labelId, workspace.id)
    try {
      const removed = new Set(removedIds)
      for (const session of deps.sessionManager.getSessions(workspace.id)) {
        const labels = session.labels ?? []
        const kept = labels.filter(entry => !removed.has(extractLabelId(entry)))
        if (kept.length !== labels.length) await deps.sessionManager.setSessionLabels(session.id, kept, workspace.id)
      }
      return { stripped }
    } finally {
      pushTyped(server, RPC_CHANNELS.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
    }
  })
}

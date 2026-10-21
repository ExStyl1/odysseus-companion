import { unlink } from 'fs/promises'
import { join } from 'path'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { getCredentialManager } from '@nessy-agent/shared/credentials'
import { i18n } from '@nessy-agent/shared/i18n'
import type { RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { requestClientConfirmDialog } from '@nessy-agent/server-core/transport'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.auth.LOGOUT,
  RPC_CHANNELS.auth.SHOW_LOGOUT_CONFIRMATION,
  RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION,
  RPC_CHANNELS.credentials.HEALTH_CHECK,
] as const

export function registerAuthHandlers(server: RpcServer, deps: HandlerDeps): void {
  // Show logout confirmation dialog (routed to client)
  server.handle(RPC_CHANNELS.auth.SHOW_LOGOUT_CONFIRMATION, async (ctx) => {
    const result = await requestClientConfirmDialog(server, ctx.clientId, {
      type: 'warning',
      buttons: [i18n.t('common.cancel'), i18n.t('dialog.logOut')],
      defaultId: 0,
      cancelId: 0,
      title: i18n.t('dialog.logOut'),
      message: i18n.t('dialog.logoutConfirmation'),
      detail: i18n.t('dialog.logoutDetail'),
    })
    // result.response is the index of the clicked button
    // 0 = Cancel, 1 = Log Out
    return result.response === 1
  })

  // Show delete session confirmation dialog (routed to client)
  // UA3.8 — `sessionId` (optional: older callers send the name only) lets the dialog name the task folder the delete
  // removes with an orchestrator, read from the SAME predicate the cascade uses (`taskFolderDeletedWith`).
  server.handle(RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION, async (ctx, name: string, sessionId?: string) => {
    const taskFolder = typeof sessionId === 'string' && ctx.workspaceId
      ? taskFolderDeletedWith(deps.sessionManager?.getSessions(ctx.workspaceId) ?? [], sessionId)
      : null
    const cannotUndo = i18n.t('dialog.reset.cannotUndo')
    // UA1.26 (O18, OQ-22 (g)) — deleting a SHARED chat asks about its link here: the session delete no longer revokes
    // on its own (UA1.25), so "Delete and stop sharing" sends the one DELETE (`revokeShare`: a retryable failure is
    // kept as a pending deletion) before the renderer deletes the session; "Delete, keep the link" leaves it open.
    const shared = typeof sessionId === 'string' && ctx.workspaceId
      ? (deps.sessionManager?.getSessions(ctx.workspaceId) ?? []).some(session => session.id === sessionId && !!session.sharedUrl)
      : false
    const detail = [
      ...(taskFolder ? [i18n.t('dialog.deleteTaskFolderDetail', { folder: `tasks/${taskFolder}/` })] : []),
      ...(shared ? [i18n.t('dialog.deleteSharedDetail')] : []),
      cannotUndo,
    ].join('\n\n')
    const result = await requestClientConfirmDialog(server, ctx.clientId, {
      type: 'warning',
      buttons: shared
        ? [i18n.t('common.cancel'), i18n.t('dialog.deleteKeepLink'), i18n.t('dialog.deleteAndStopSharing')]
        : [i18n.t('common.cancel'), i18n.t('common.delete')],
      defaultId: 0,
      cancelId: 0,
      title: i18n.t('dialog.deleteConversationTitle'),
      message: i18n.t('dialog.deleteConfirmMessage', { name }),
      detail,
    })
    // result.response is the index of the clicked button
    // 0 = Cancel, 1 = Delete (shared: keep the link), 2 = Delete and stop sharing (shared only)
    if (shared && result.response === 2 && typeof sessionId === 'string' && deps.sessionManager) {
      const revoked = await deps.sessionManager.revokeShare(sessionId, ctx.workspaceId ?? undefined)
      if (!revoked.success) {
        // Said, not swallowed: the chat is still deleted (that was the choice), and the link stays in Published
        // pages for a later delete.
        await requestClientConfirmDialog(server, ctx.clientId, {
          type: 'warning',
          buttons: [i18n.t('common.ok')],
          defaultId: 0,
          cancelId: 0,
          title: i18n.t('dialog.stopSharingFailed'),
          message: i18n.t('dialog.stopSharingFailed'),
          detail: i18n.t('dialog.stopSharingFailedDetail', { message: revoked.error ?? '' }),
        })
      }
      return true
    }
    return result.response === 1
  })

  // Logout - clear all credentials and config
  server.handle(RPC_CHANNELS.auth.LOGOUT, async () => {
    try {
      const manager = getCredentialManager()

      // List and delete all stored credentials
      const allCredentials = await manager.list()
      for (const credId of allCredentials) {
        await manager.delete(credId)
      }

      // Delete the config file
      const configPath = join(CONFIG_DIR, 'config.json')
      await unlink(configPath).catch(() => {
        // Ignore if file doesn't exist
      })

      deps.platform.logger.info('Logout complete - cleared all credentials and config')
    } catch (error) {
      deps.platform.logger.error('Logout error:', error)
      throw error
    }
  })

  // Credential health check - validates credential store is readable and usable
  // Called on app startup to detect corruption, machine migration, or missing credentials
  server.handle(RPC_CHANNELS.credentials.HEALTH_CHECK, async () => {
    const manager = getCredentialManager()
    return manager.checkHealth()
  })
}

// UA3.8 — appended so the docs' cited lines of this file keep their numbers; imports are hoisted.
import { taskFolderDeletedWith } from '../../tasks/orchestrator-folder'

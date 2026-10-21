/**
 * UA1.26 (O18, OQ-22 (g)) — deleting a SHARED chat asks about its link in the delete confirmation itself: the
 * session delete no longer revokes on its own (UA1.25), so "Delete and stop sharing" sends the one DELETE
 * (`revokeShare`) before the renderer deletes, and "Delete, keep the link" leaves the link open. An unshared chat keeps
 * the two-button dialog and never revokes.
 */
import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { ShareResult } from '@nessy-agent/shared/protocol'
import { i18n, setupI18n } from '@nessy-agent/shared/i18n'
import { CLIENT_CONFIRM_DIALOG } from '@nessy-agent/server-core/transport'
import type { HandlerFn, RequestContext, RpcServer } from '../../../transport/types'
import type { HandlerDeps } from '../../handler-deps'
import { registerAuthHandlers } from '../auth'

setupI18n()

function harness(answers: number[], revokeResult: ShareResult = { success: true }) {
  const handlers = new Map<string, HandlerFn>()
  const dialogs: Array<{ buttons: string[]; detail: string; title: string }> = []
  const revoked: Array<{ sessionId: string; workspaceId?: string }> = []
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient(_clientId, channel, ...args) {
      if (channel === CLIENT_CONFIRM_DIALOG) dialogs.push(args[0] as { buttons: string[]; detail: string; title: string })
      return { response: answers.shift() ?? 0 }
    },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const deps = {
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    sessionManager: {
      getSessions: (workspaceId: string) => workspaceId === 'ws-1'
        ? [{ id: 'shared', sharedUrl: 'https://t-artifacts.t-tech.team/a/abcdefghijklmnopqrstuv' }, { id: 'plain' }]
        : [],
      revokeShare: async (sessionId: string, workspaceId?: string) => {
        revoked.push({ sessionId, workspaceId })
        return revokeResult
      },
    },
  } as unknown as HandlerDeps
  registerAuthHandlers(server, deps)
  const ctx: RequestContext = { clientId: 'c1', workspaceId: 'ws-1', webContentsId: 1 }
  const confirm = (sessionId: string) => handlers.get(RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION)!(ctx, 'Chat', sessionId)
  return { confirm, dialogs, revoked }
}

describe('UA1.26 — the delete confirmation asks about a shared chat\'s link', () => {
  it('shared: three answers; "Delete and stop sharing" revokes once, then the delete goes ahead', async () => {
    const { confirm, dialogs, revoked } = harness([2])
    expect(await confirm('shared')).toBe(true)
    expect(dialogs[0]!.buttons).toEqual([i18n.t('common.cancel'), i18n.t('dialog.deleteKeepLink'), i18n.t('dialog.deleteAndStopSharing')])
    expect(dialogs[0]!.detail).toBe(`${i18n.t('dialog.deleteSharedDetail')}\n\n${i18n.t('dialog.reset.cannotUndo')}`)
    expect(revoked).toEqual([{ sessionId: 'shared', workspaceId: 'ws-1' }])
    expect(dialogs).toHaveLength(1)
  })

  it('shared: "Delete, keep the link" deletes without a DELETE; Cancel deletes nothing', async () => {
    const keep = harness([1])
    expect(await keep.confirm('shared')).toBe(true)
    expect(keep.revoked).toHaveLength(0)
    const cancel = harness([0])
    expect(await cancel.confirm('shared')).toBe(false)
    expect(cancel.revoked).toHaveLength(0)
  })

  it('a stop-sharing failure is said in a second dialog and the delete still goes ahead', async () => {
    const { confirm, dialogs, revoked } = harness([2, 0], { success: false, error: 'The service refused.' })
    expect(await confirm('shared')).toBe(true)
    expect(revoked).toHaveLength(1)
    expect(dialogs).toHaveLength(2)
    expect(dialogs[1]!.title).toBe(i18n.t('dialog.stopSharingFailed'))
    expect(dialogs[1]!.detail).toContain('The service refused.')
  })

  it('negative: an unshared chat keeps the two-button dialog and never revokes', async () => {
    const { confirm, dialogs, revoked } = harness([1])
    expect(await confirm('plain')).toBe(true)
    expect(dialogs[0]!.buttons).toEqual([i18n.t('common.cancel'), i18n.t('common.delete')])
    expect(dialogs[0]!.detail).toBe(i18n.t('dialog.reset.cannotUndo'))
    expect(revoked).toHaveLength(0)
  })
})

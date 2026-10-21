import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { i18n, setupI18n } from '@nessy-agent/shared/i18n'
import { CLIENT_CONFIRM_DIALOG } from '@nessy-agent/server-core/transport'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import type { HandlerDeps } from '../handler-deps'
import { registerAuthHandlers } from './auth'

function createHarness() {
  const handlers = new Map<string, HandlerFn>()
  const dialogSpecs: any[] = []

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient(_clientId, channel, ...args) {
      if (channel === CLIENT_CONFIRM_DIALOG) dialogSpecs.push(args[0])
      // Return { response: 0 } (Cancel) so the handlers short-circuit and never
      // touch credentials/config.
      return { response: 0 }
    },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }

  const deps = {
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    // UA3.8 — the sessions the delete dialog reads to name a task folder.
    sessionManager: {
      getSessions: (workspaceId: string) => workspaceId === 'ws-1'
        ? [{ id: 'orch', taskSlug: 'fix-login' }, { id: 'plain' }, { id: 'node', taskSlug: 'other-task', taskNodeId: 'main' }]
        : [],
    },
  } as unknown as HandlerDeps

  registerAuthHandlers(server, deps)

  const ctx: RequestContext = { clientId: 'c1', workspaceId: 'ws-1', webContentsId: 1 }
  return { handlers, dialogSpecs, ctx }
}

describe('registerAuthHandlers native dialogs are localized', () => {
  setupI18n()
  // AWAITED, in hooks: the previous shape set 'ru' in the describe body and
  // restored 'en' in an un-awaited afterAll — that floating promise could
  // resolve after the NEXT file's English-expecting tests started, which is
  // exactly what CI measured (run-summary received Russian, 8 reds; green
  // locally three times). 2026-08-21, pipeline 122476869.
  beforeAll(async () => { await i18n.changeLanguage('ru') })
  afterAll(async () => { await i18n.changeLanguage('en') })

  it('logout dialog sources title/message/detail/buttons from i18n', async () => {
    const { handlers, dialogSpecs, ctx } = createHarness()
    await handlers.get(RPC_CHANNELS.auth.SHOW_LOGOUT_CONFIRMATION)!(ctx)

    expect(dialogSpecs).toHaveLength(1)
    const spec = dialogSpecs[0]
    expect(spec.title).toBe(i18n.t('dialog.logOut'))
    expect(spec.message).toBe(i18n.t('dialog.logoutConfirmation'))
    expect(spec.detail).toBe(i18n.t('dialog.logoutDetail'))
    expect(spec.buttons).toEqual([i18n.t('common.cancel'), i18n.t('dialog.logOut')])
    // Guard against a lingering English literal.
    expect(spec.title).not.toBe('Log Out')
  })

  it('delete dialog interpolates the session name via i18n', async () => {
    const { handlers, dialogSpecs, ctx } = createHarness()
    await handlers.get(RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION)!(ctx, 'My Chat')

    expect(dialogSpecs).toHaveLength(1)
    const spec = dialogSpecs[0]
    expect(spec.title).toBe(i18n.t('dialog.deleteConversationTitle'))
    expect(spec.message).toBe(i18n.t('dialog.deleteConfirmMessage', { name: 'My Chat' }))
    expect(spec.message).toContain('My Chat')
    expect(spec.detail).toBe(i18n.t('dialog.reset.cannotUndo'))
    expect(spec.buttons).toEqual([i18n.t('common.cancel'), i18n.t('common.delete')])
    expect(spec.title).not.toBe('Delete Conversation')
  })

  it('UA3.8 — deleting an orchestrator names its task folder; a plain session or a child node does not', async () => {
    const { handlers, dialogSpecs, ctx } = createHarness()
    const handler = handlers.get(RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION)!
    await handler(ctx, 'Fix login', 'orch')
    await handler(ctx, 'Plain', 'plain')
    await handler(ctx, 'Node', 'node')

    const folderLine = i18n.t('dialog.deleteTaskFolderDetail', { folder: 'tasks/fix-login/' })
    expect(folderLine).toContain('tasks/fix-login/')
    expect(dialogSpecs[0].detail).toBe(`${folderLine}\n\n${i18n.t('dialog.reset.cannotUndo')}`)
    expect(dialogSpecs[1].detail).toBe(i18n.t('dialog.reset.cannotUndo'))
    expect(dialogSpecs[2].detail).toBe(i18n.t('dialog.reset.cannotUndo'))
  })
})

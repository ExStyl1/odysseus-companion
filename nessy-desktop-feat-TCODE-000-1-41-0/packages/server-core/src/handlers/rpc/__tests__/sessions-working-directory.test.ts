import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { HandlerDeps } from '../../handler-deps'
import type { HandlerFn, RequestContext, RpcServer } from '../../../transport/types'
import { registerSessionsHandlers } from '../sessions'

function createHarness(updateWorkingDirectory: HandlerDeps['sessionManager']['updateWorkingDirectory']) {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const deps = {
    sessionManager: {
      waitForInit: async () => {},
      getSessions: () => [],
      updateWorkingDirectory,
    },
    platform: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerSessionsHandlers(server, deps)
  const context: RequestContext = {
    clientId: 'client-cwd',
    workspaceId: 'workspace-cwd',
    webContentsId: null,
  }
  return { handler: handlers.get(RPC_CHANNELS.sessions.COMMAND)!, context }
}

describe('sessions working-directory RPC', () => {
  it('keeps the RPC pending until the shared async SessionManager owner resolves', async () => {
    const calls: Array<{ sessionId: string; path: string; workspaceId?: string }> = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const { handler, context } = createHarness(async (sessionId, path, workspaceId) => {
      calls.push({ sessionId, path, workspaceId })
      await gate
    })

    const result = handler(context, 'session-cwd', {
      type: 'updateWorkingDirectory',
      dir: '/tmp/next-cwd',
    }) as Promise<void>
    let settled = false
    void result.then(() => { settled = true })
    await Promise.resolve()

    expect(calls).toEqual([{
      sessionId: 'session-cwd',
      path: '/tmp/next-cwd',
      workspaceId: 'workspace-cwd',
    }])
    expect(settled).toBe(false)
    release()
    await expect(result).resolves.toBeUndefined()
  })

  it('propagates rejection from the shared SessionManager owner', async () => {
    const { handler, context } = createHarness(async () => {
      throw new Error('cwd-transaction-rejected')
    })

    await expect(handler(context, 'session-cwd', {
      type: 'updateWorkingDirectory',
      dir: '/tmp/rejected-cwd',
    })).rejects.toThrow('cwd-transaction-rejected')
  })
})

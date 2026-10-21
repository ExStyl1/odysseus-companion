import { describe, expect, mock, test } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { registerSessionsHandlers } from './sessions'

describe('Pi runtime session RPC contract', () => {
  test('captures the client barrier before projection and binds controls once', async () => {
    const handlers = new Map<string, Function>()
    const order: string[] = []
    const control = mock(async (request: unknown) => ({ schemaVersion: 1, ok: true, request }))
    const agentViewControl = mock(async (request: unknown) => ({ schemaVersion: 1, ok: true, request }))
    const server = {
      handle(channel: string, handler: Function) { handlers.set(channel, handler) },
      getClientLastSentSeq(clientId: string) { order.push(`barrier:${clientId}`); return 8 },
    }
    const sessionManager = {
      async getPiHarnessRuntimeSnapshot(session: unknown) {
        order.push('snapshot')
        return { schemaVersion: 1, session, provider: 'pi', available: false, generatedAt: 1, processes: [] }
      },
      controlPiHarnessRuntime: control,
      waitForInit: async () => {},
      listPiAgentView: mock(async () => ({ schemaVersion: 1, items: [] })),
      controlPiAgentView: agentViewControl,
    }
    registerSessionsHandlers(server as any, {
      sessionManager,
      platform: { logger: { info() {}, error() {} } },
      oauthFlowStore: {},
    } as any)
    const ctx = { clientId: 'client', workspaceId: 'w', webContentsId: null }
    const snapshot = await handlers.get(RPC_CHANNELS.sessions.GET_PI_HARNESS_RUNTIME)!(ctx, { workspaceId: 'w', sessionId: 's' })
    expect(order).toEqual(['barrier:client', 'snapshot'])
    expect(snapshot.barrierSeq).toBe(8)

    await handlers.get(RPC_CHANNELS.sessions.CONTROL_PI_HARNESS_RUNTIME)!(ctx, { schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'refresh' })
    expect(control).toHaveBeenCalledTimes(1)
    await handlers.get(RPC_CHANNELS.sessions.LIST_PI_AGENT_VIEW)!(ctx, { schemaVersion: 1, limit: 25 })
    await handlers.get(RPC_CHANNELS.sessions.CONTROL_PI_AGENT_VIEW)!(ctx, { schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'open' })
    expect(agentViewControl).toHaveBeenCalledTimes(1)
    await expect(handlers.get(RPC_CHANNELS.sessions.GET_PI_HARNESS_RUNTIME)!(ctx, { workspaceId: 'other', sessionId: 's' })).rejects.toThrow('session-scope-mismatch')
    await expect(handlers.get(RPC_CHANNELS.sessions.CONTROL_PI_AGENT_VIEW)!(ctx, { schemaVersion: 1, session: { workspaceId: 'other', sessionId: 's' }, action: 'open' })).rejects.toThrow('session-scope-mismatch')
  })
})

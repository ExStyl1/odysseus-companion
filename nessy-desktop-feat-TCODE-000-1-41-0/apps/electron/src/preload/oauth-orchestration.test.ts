import { describe, expect, mock, test } from 'bun:test'
import { OAUTH_FAILURE_CODES, RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import {
  createOAuthOperation,
  OAuthOperationRegistry,
  OAUTH_CLIENT_CODES,
  type OAuthOperationResult,
  type OAuthOrchestrationDeps,
} from './oauth-orchestration'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function args() {
  return {
    sourceSlug: 'mail',
    sessionId: 'session-1',
    authRequestId: 'request-1',
  }
}

describe('OAuth preload orchestration', () => {
  test('preserves the bounded provider failure code and atomically fails the published flow', async () => {
    const close = mock(() => {})
    const invocations: Array<{ channel: string; args: Record<string, unknown> }> = []
    const deps: OAuthOrchestrationDeps = {
      createCallbackServer: async () => ({
        url: 'http://localhost:6477',
        close,
        promise: Promise.resolve({
          query: {
            error: 'raw-provider-error',
            error_description: 'raw-provider-body',
          },
        }),
      }),
      openExternal: async () => {},
      invoke: async (channel, request) => {
        invocations.push({ channel, args: request })
        if (channel === RPC_CHANNELS.oauth.START) {
          return {
            authUrl: 'https://auth.example.test',
            flowId: 'flow-1',
            state: 'state-1',
          }
        }
        if (channel === RPC_CHANNELS.oauth.FAIL) {
          return { success: false, code: OAUTH_FAILURE_CODES.PROVIDER_CALLBACK_FAILED }
        }
        throw new Error(`unexpected channel ${channel}`)
      },
    }

    const result = await createOAuthOperation(deps, args()).result

    expect(result).toEqual({
      success: false,
      error: OAUTH_FAILURE_CODES.PROVIDER_CALLBACK_FAILED,
    })
    expect(close).toHaveBeenCalled()
    expect(invocations.at(-1)).toEqual({
      channel: RPC_CHANNELS.oauth.FAIL,
      args: {
        flowId: 'flow-1',
        state: 'state-1',
        sessionId: 'session-1',
        authRequestId: 'request-1',
        sourceSlug: 'mail',
        code: OAUTH_FAILURE_CODES.PROVIDER_CALLBACK_FAILED,
      },
    })
    expect(JSON.stringify(invocations)).not.toContain('raw-provider')
  })

  test('does not report the original failure code when server settlement fails', async () => {
    const deps: OAuthOrchestrationDeps = {
      createCallbackServer: async () => ({
        url: 'http://localhost:6477',
        close: () => {},
        promise: Promise.resolve({ query: { error: 'provider-secret' } }),
      }),
      openExternal: async () => {},
      invoke: async (channel) => {
        if (channel === RPC_CHANNELS.oauth.START) {
          return {
            authUrl: 'https://auth.example.test',
            flowId: 'flow-1',
            state: 'state-1',
          }
        }
        throw new Error('transport-provider-body')
      },
    }

    expect(await createOAuthOperation(deps, args()).result).toEqual({
      success: false,
      error: OAUTH_CLIENT_CODES.SETTLEMENT_FAILED,
    })
  })

  test('in-flight cancel closes the callback wait and invokes bound server cancel', async () => {
    const callback = deferred<{ query: Record<string, string> }>()
    const opened = deferred<void>()
    const close = mock(() => {})
    const invocations: Array<{ channel: string; args: Record<string, unknown> }> = []
    const deps: OAuthOrchestrationDeps = {
      createCallbackServer: async () => ({
        url: 'http://localhost:6477',
        close,
        promise: callback.promise,
      }),
      openExternal: async () => {
        opened.resolve()
      },
      invoke: async (channel, request) => {
        invocations.push({ channel, args: request })
        if (channel === RPC_CHANNELS.oauth.START) {
          return {
            authUrl: 'https://auth.example.test',
            flowId: 'flow-1',
            state: 'state-1',
          }
        }
        if (channel === RPC_CHANNELS.oauth.CANCEL) return { success: true }
        throw new Error(`unexpected channel ${channel}`)
      },
    }
    const operation = createOAuthOperation(deps, args())
    await opened.promise

    expect(await operation.cancel()).toEqual({ ok: true })
    expect(await operation.result).toEqual({
      success: false,
      error: OAUTH_CLIENT_CODES.CANCELLED,
    })
    expect(close).toHaveBeenCalled()
    expect(invocations.at(-1)).toEqual({
      channel: RPC_CHANNELS.oauth.CANCEL,
      args: {
        flowId: 'flow-1',
        state: 'state-1',
        sessionId: 'session-1',
        authRequestId: 'request-1',
        sourceSlug: 'mail',
      },
    })

    callback.reject(new Error('late callback failure'))
    await Promise.resolve()
  })

  test('cancel failure is stable and still shuts down the callback server', async () => {
    const callback = deferred<{ query: Record<string, string> }>()
    const opened = deferred<void>()
    const close = mock(() => {})
    const deps: OAuthOrchestrationDeps = {
      createCallbackServer: async () => ({
        url: 'http://localhost:6477',
        close,
        promise: callback.promise,
      }),
      openExternal: async () => {
        opened.resolve()
      },
      invoke: async (channel) => {
        if (channel === RPC_CHANNELS.oauth.START) {
          return {
            authUrl: 'https://auth.example.test',
            flowId: 'flow-1',
            state: 'state-1',
          }
        }
        throw new Error('raw-cancel-transport-error')
      },
    }
    const operation = createOAuthOperation(deps, args())
    await opened.promise

    expect(await operation.cancel()).toEqual({
      ok: false,
      code: OAUTH_CLIENT_CODES.CANCEL_FAILED,
    })
    expect(await operation.result).toEqual({
      success: false,
      error: OAUTH_CLIENT_CODES.CANCEL_FAILED,
    })
    expect(close).toHaveBeenCalled()
  })

  test('cancel during START settles the request binding and ignores the late flow', async () => {
    const callback = deferred<{ query: Record<string, string> }>()
    const start = deferred<{ authUrl: string; flowId: string; state: string }>()
    const startCalled = deferred<void>()
    const cancelRequest = deferred<Record<string, unknown>>()
    const cancelRequests: Record<string, unknown>[] = []
    const close = mock(() => {})
    const openExternal = mock(async () => {})
    const deps: OAuthOrchestrationDeps = {
      createCallbackServer: async () => ({
        url: 'http://localhost:6477',
        close,
        promise: callback.promise,
      }),
      openExternal,
      invoke: async (channel, request) => {
        if (channel === RPC_CHANNELS.oauth.START) {
          startCalled.resolve()
          return await start.promise
        }
        if (channel === RPC_CHANNELS.oauth.CANCEL) {
          cancelRequests.push(request)
          cancelRequest.resolve(request)
          return { success: true }
        }
        throw new Error(`unexpected channel ${channel}`)
      },
    }
    const operation = createOAuthOperation(deps, args())
    await startCalled.promise

    const cancel = operation.cancel()
    expect(await cancelRequest.promise).toEqual({
      sessionId: 'session-1',
      authRequestId: 'request-1',
      sourceSlug: 'mail',
    })
    start.resolve({
      authUrl: 'https://auth.example.test',
      flowId: 'late-flow',
      state: 'late-state',
    })

    expect(await cancel).toEqual({ ok: true })
    expect(await operation.result).toEqual({
      success: false,
      error: OAUTH_CLIENT_CODES.CANCELLED,
    })
    expect(openExternal).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
    expect(cancelRequests).toEqual([
      {
        sessionId: 'session-1',
        authRequestId: 'request-1',
        sourceSlug: 'mail',
      },
      {
        flowId: 'late-flow',
        state: 'late-state',
        sessionId: 'session-1',
        authRequestId: 'request-1',
        sourceSlug: 'mail',
      },
    ])
  })

  test('registry reuses the active operation for one composite auth request', async () => {
    const registry = new OAuthOperationRegistry()
    const result = deferred<OAuthOperationResult>()
    let created = 0
    const factory = () => {
      created += 1
      return {
        result: result.promise,
        cancel: async () => ({ ok: true as const }),
      }
    }
    const operationArgs = {
      workspaceId: 'workspace-1',
      ...args(),
    }

    const first = registry.run(operationArgs, factory)
    const second = registry.run(operationArgs, factory)

    expect(created).toBe(1)
    expect(registry.get(operationArgs)).toBeDefined()
    result.resolve({ success: true })
    expect(await Promise.all([first, second])).toEqual([
      { success: true },
      { success: true },
    ])
    expect(registry.get(operationArgs)).toBeUndefined()
  })

  test('sends the plugin-server target and never a bare sourceSlug to oauth:start', async () => {
    const starts: Record<string, unknown>[] = []
    const deps: OAuthOrchestrationDeps = {
      createCallbackServer: async () => ({
        url: 'http://localhost:6477',
        close: () => {},
        promise: Promise.resolve({ query: { code: 'authorization-code' } }),
      }),
      openExternal: async () => {},
      invoke: async (channel, request) => {
        if (channel === RPC_CHANNELS.oauth.START) {
          starts.push(request)
          return { authUrl: 'https://auth.example.test', flowId: 'flow-1', state: 'state-1' }
        }
        if (channel === RPC_CHANNELS.oauth.COMPLETE) return { success: true }
        throw new Error(`unexpected channel ${channel}`)
      },
    }

    // The in-chat card's shape for a plugin-owned MCP server: `sourceSlug` is
    // the serverName as binding identity, and the RPC target is `pluginServer`.
    const result = await createOAuthOperation(deps, {
      ...args(),
      sourceSlug: 'figma',
      pluginServer: { pluginKey: 'registry-6135.figma', serverName: 'figma' },
    }).result

    expect(result).toEqual({ success: true })
    expect(starts).toEqual([{
      pluginServer: { pluginKey: 'registry-6135.figma', serverName: 'figma' },
      callbackUrl: 'http://localhost:6477/callback',
      sessionId: 'session-1',
      authRequestId: 'request-1',
    }])
    expect(starts[0]).not.toHaveProperty('sourceSlug')
  })

  test('a plain source still targets oauth:start by sourceSlug', async () => {
    const starts: Record<string, unknown>[] = []
    const deps: OAuthOrchestrationDeps = {
      createCallbackServer: async () => ({
        url: 'http://localhost:6477',
        close: () => {},
        promise: Promise.resolve({ query: { code: 'authorization-code' } }),
      }),
      openExternal: async () => {},
      invoke: async (channel, request) => {
        if (channel === RPC_CHANNELS.oauth.START) {
          starts.push(request)
          return { authUrl: 'https://auth.example.test', flowId: 'flow-1', state: 'state-1' }
        }
        if (channel === RPC_CHANNELS.oauth.COMPLETE) return { success: true }
        throw new Error(`unexpected channel ${channel}`)
      },
    }

    expect(await createOAuthOperation(deps, args()).result).toEqual({ success: true })
    expect(starts).toEqual([{
      sourceSlug: 'mail',
      callbackUrl: 'http://localhost:6477/callback',
      sessionId: 'session-1',
      authRequestId: 'request-1',
    }])
    expect(starts[0]).not.toHaveProperty('pluginServer')
  })

  test('a rejected start reports the original reason beside the typed code', async () => {
    const failures: Record<string, unknown>[] = []
    const deps: OAuthOrchestrationDeps = {
      createCallbackServer: async () => ({
        url: 'http://localhost:6477',
        close: () => {},
        promise: new Promise(() => {}),
      }),
      openExternal: async () => {},
      invoke: async (channel, request) => {
        if (channel === RPC_CHANNELS.oauth.START) {
          // The live 2026-08-01 rejection, verbatim.
          throw new Error('Source not found: figma')
        }
        if (channel === RPC_CHANNELS.oauth.FAIL) {
          failures.push(request)
          return { success: false, code: OAUTH_FAILURE_CODES.START_FAILED }
        }
        throw new Error(`unexpected channel ${channel}`)
      },
    }

    expect(await createOAuthOperation(deps, args()).result).toEqual({
      success: false,
      error: OAUTH_FAILURE_CODES.START_FAILED,
      diagnostic: 'Source not found: figma',
    })
    // The typed code the UI switches on is unchanged by carrying the reason.
    expect(failures.at(-1)?.code).toBe(OAUTH_FAILURE_CODES.START_FAILED)
  })

  test('a diagnostic keeps a URL origin and path but never its query', async () => {
    const deps: OAuthOrchestrationDeps = {
      createCallbackServer: async () => ({
        url: 'http://localhost:6477',
        close: () => {},
        promise: new Promise(() => {}),
      }),
      openExternal: async () => {},
      invoke: async (channel) => {
        if (channel === RPC_CHANNELS.oauth.START) {
          throw new Error(
            'metadata fetch failed for https://mcp.figma.test/mcp?code=AUTHCODE&state=STATEVALUE#tok',
          )
        }
        if (channel === RPC_CHANNELS.oauth.FAIL) {
          return { success: false, code: OAUTH_FAILURE_CODES.START_FAILED }
        }
        throw new Error(`unexpected channel ${channel}`)
      },
    }

    const result = await createOAuthOperation(deps, args()).result

    expect(result.error).toBe(OAUTH_FAILURE_CODES.START_FAILED)
    expect(result.diagnostic).toBe('metadata fetch failed for https://mcp.figma.test/mcp')
    for (const secret of ['AUTHCODE', 'STATEVALUE', 'code=', 'state=', '#tok']) {
      expect(result.diagnostic).not.toContain(secret)
    }
  })

  test('uses the server COMPLETE code without a second FAIL settlement', async () => {
    const channels: string[] = []
    const deps: OAuthOrchestrationDeps = {
      createCallbackServer: async () => ({
        url: 'http://localhost:6477',
        close: () => {},
        promise: Promise.resolve({ query: { code: 'authorization-code' } }),
      }),
      openExternal: async () => {},
      invoke: async (channel) => {
        channels.push(channel)
        if (channel === RPC_CHANNELS.oauth.START) {
          return {
            authUrl: 'https://auth.example.test',
            flowId: 'flow-1',
            state: 'state-1',
          }
        }
        if (channel === RPC_CHANNELS.oauth.COMPLETE) {
          return { success: false, error: OAUTH_FAILURE_CODES.COMPLETE_FAILED }
        }
        throw new Error(`unexpected channel ${channel}`)
      },
    }

    expect(await createOAuthOperation(deps, args()).result).toEqual({
      success: false,
      error: OAUTH_FAILURE_CODES.COMPLETE_FAILED,
    })
    expect(channels).toEqual([
      RPC_CHANNELS.oauth.START,
      RPC_CHANNELS.oauth.COMPLETE,
    ])
  })
})

import { describe, expect, mock, test } from 'bun:test'
import { DpAuthError } from '@nessy-agent/shared/auth/dp'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerDpAuthHandlers } from '../dp-auth'

function harness(options: { pending?: boolean; local?: boolean } = {}) {
  const handlers = new Map<string, HandlerFn>()
  const pushes: unknown[][] = []
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push(...args) { pushes.push(args) },
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const ensureDpAuth = mock(async (
    _sessionId: string,
    _requestId: string,
    _workspaceId: string,
    onStatus?: (status: string) => void,
  ) => {
    onStatus?.('checking')
    onStatus?.('waiting-browser')
    return { ok: true as const }
  })
  const cancelDpAuth = mock(async () => ({
    ok: false as const,
    code: DpAuthError.Cancelled,
  }))
  const probeDpSessionState = mock(async () => 'ready' as const)
  const deps = {
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    sessionManager: {
      hasPendingDpAuthRequest: () => options.pending ?? true,
      ensureDpAuth,
      cancelDpAuth,
      probeDpSessionState,
    },
    oauthFlowStore: {},
    ...(options.local === false ? {} : {
      windowManager: {
        getWorkspaceForWindow: (id: number) => id === 42 ? 'workspace-dp' : null,
        getWindowByWebContentsId: (id: number) => id === 42 ? {} : null,
      },
    }),
  } as unknown as HandlerDeps
  registerDpAuthHandlers(server, deps)
  return { handlers, pushes, ensureDpAuth, cancelDpAuth, probeDpSessionState }
}

const localContext: RequestContext = {
  clientId: 'client-dp',
  workspaceId: 'workspace-dp',
  webContentsId: 42,
}

describe('DP auth RPC', () => {
  test('binds ensure to the authenticated workspace/session and a registered Electron window', async () => {
    const { handlers, pushes, ensureDpAuth } = harness()

    const result = await handlers.get(RPC_CHANNELS.dpAuth.ENSURE)!(localContext, {
      sessionId: 'session-dp',
      requestId: 'request-dp',
    })

    expect(result).toEqual({ ok: true })
    expect(Object.keys(result)).toEqual(['ok'])
    expect(ensureDpAuth).toHaveBeenCalledTimes(1)
    expect(ensureDpAuth.mock.calls[0]?.slice(0, 3)).toEqual([
      'session-dp',
      'request-dp',
      'workspace-dp',
    ])
    expect(pushes).toEqual([
      [
        RPC_CHANNELS.dpAuth.STATUS,
        { to: 'client', clientId: 'client-dp' },
        { requestId: 'request-dp', status: 'checking' },
      ],
      [
        RPC_CHANNELS.dpAuth.STATUS,
        { to: 'client', clientId: 'client-dp' },
        { requestId: 'request-dp', status: 'waiting-browser' },
      ],
    ])
  })

  test.each([
    {
      name: 'headless owner',
      context: localContext,
      options: { local: false },
    },
    {
      name: 'remote client without Electron identity',
      context: { ...localContext, webContentsId: null },
      options: {},
    },
    {
      name: 'unregistered Electron identity',
      context: { ...localContext, webContentsId: 99 },
      options: {},
    },
  ])('returns only InteractiveLoginUnavailable for $name', async ({ context, options }) => {
    const { handlers, ensureDpAuth } = harness(options)

    const result = await handlers.get(RPC_CHANNELS.dpAuth.ENSURE)!(context, {
      sessionId: 'session-dp',
      requestId: 'request-dp',
    })

    expect(result).toEqual({
      ok: false,
      code: DpAuthError.InteractiveLoginUnavailable,
    })
    expect(Object.keys(result).sort()).toEqual(['code', 'ok'])
    expect(ensureDpAuth).not.toHaveBeenCalled()
  })

  test('rejects a stale or mismatched pending request with a stable code', async () => {
    const { handlers, ensureDpAuth } = harness({ pending: false })

    const result = await handlers.get(RPC_CHANNELS.dpAuth.ENSURE)!(localContext, {
      sessionId: 'session-dp',
      requestId: 'stale-request',
    })

    expect(result).toEqual({ ok: false, code: DpAuthError.Cancelled })
    expect(ensureDpAuth).not.toHaveBeenCalled()
  })

  test('cancels only the validated request owner', async () => {
    const { handlers, cancelDpAuth } = harness()

    const result = await handlers.get(RPC_CHANNELS.dpAuth.CANCEL)!(localContext, {
      sessionId: 'session-dp',
      requestId: 'request-dp',
    })

    expect(result).toEqual({ ok: false, code: DpAuthError.Cancelled })
    expect(cancelDpAuth).toHaveBeenCalledWith(
      'session-dp',
      'request-dp',
      'workspace-dp',
    )
  })

  // T3 (plugin-install plan): the probe is value-only and needs NO pending
  // request — it exists so a completed system sign-in takes effect without a
  // chat message, and it must never start a login of its own.
  test('probe answers value-only with no pending request required', async () => {
    const { handlers, ensureDpAuth, probeDpSessionState } = harness({ pending: false })

    const result = await handlers.get(RPC_CHANNELS.dpAuth.PROBE)!(localContext, undefined)

    expect(result).toEqual({ state: 'ready' })
    expect(Object.keys(result)).toEqual(['state'])
    expect(probeDpSessionState).toHaveBeenCalledTimes(1)
    expect(ensureDpAuth).not.toHaveBeenCalled()
  })

  test('allows a remote or headless caller to cancel its validated request', async () => {
    const { handlers, cancelDpAuth } = harness({ local: false })

    const result = await handlers.get(RPC_CHANNELS.dpAuth.CANCEL)!({
      ...localContext,
      webContentsId: null,
    }, {
      sessionId: 'session-dp',
      requestId: 'request-dp',
    })

    expect(result).toEqual({ ok: false, code: DpAuthError.Cancelled })
    expect(cancelDpAuth).toHaveBeenCalledWith(
      'session-dp',
      'request-dp',
      'workspace-dp',
    )
  })
})

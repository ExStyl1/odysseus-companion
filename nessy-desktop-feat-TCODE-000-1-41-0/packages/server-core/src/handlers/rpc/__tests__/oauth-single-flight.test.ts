/**
 * UB3.10 — one sign-in serves every session waiting on a source.
 *
 * The single flight lives in `createOAuthFlowStarter` (join / restart / the
 * preparing map) and in `completeOAuthFlow` (the outcome joiners poll, the
 * fan-out resume). The thin `oauth:status` and `oauth:cancel {error}` handlers
 * are driven through `registerOAuthHandlers` with the same fake-RpcServer
 * harness `oauth-plugin-server.test.ts` uses.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { OAuthFlowStore, createPendingFlow, type OAuthFlowWaiter, type PendingOAuthFlow } from '@nessy-agent/shared/auth'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { completeOAuthFlow, createOAuthFlowStarter, registerOAuthHandlers, type SourceFlowStartRequest } from '../oauth'

const logger = { info: () => {} }
const stores: OAuthFlowStore[] = []

afterEach(() => {
  while (stores.length > 0) stores.pop()!.dispose()
})

/** A starter whose provider preparation resolves when the test lets it. */
function harness(opts: { manualPrepare?: boolean } = {}) {
  const flowStore = new OAuthFlowStore()
  stores.push(flowStore)
  let prepareCount = 0
  const releases: Array<() => void> = []
  const start = createOAuthFlowStarter({
    flowStore,
    logger,
    run: async (req: SourceFlowStartRequest, carriedWaiters: OAuthFlowWaiter[]) => {
      const materialize = (n: number) => {
        const flow: PendingOAuthFlow = createPendingFlow({
          flowId: `flow-state-${n}`,
          state: `state-${n}`,
          codeVerifier: 'verifier',
          redirectUri: 'http://localhost:6477/callback',
          source: {} as never,
          clientId: 'oauth-client',
          tokenEndpoint: 'https://oauth2.example.com/token',
          provider: 'google',
          ownerClientId: req.clientId,
          workspaceId: req.workspaceId,
          sourceSlug: req.sourceSlug,
          sessionId: req.sessionId,
          authRequestId: req.authRequestId,
          waiters: carriedWaiters,
        })
        flowStore.store(flow)
        return {
          authUrl: `https://accounts.example.com/auth?n=${n}`,
          state: flow.state,
          flowId: flow.flowId,
          expiresInMs: flow.expiresAt - Date.now(),
        }
      }
      const n = ++prepareCount
      if (!opts.manualPrepare) return materialize(n)
      return new Promise(resolve => releases.push(() => resolve(materialize(n))))
    },
  })
  return { flowStore, start, prepareCount: () => prepareCount, releaseNext: () => releases.shift()!() }
}

function request(overrides: Partial<SourceFlowStartRequest> = {}): SourceFlowStartRequest {
  return {
    workspaceId: 'ws-1',
    clientId: 'client-a',
    sourceSlug: 'gmail',
    callbackUrl: 'http://localhost:6477/callback',
    joinLive: true,
    ...overrides,
  }
}

describe('oauth:start single flight (createOAuthFlowStarter)', () => {
  it('a second start for the same source joins the live flow instead of opening another sign-in', async () => {
    const { flowStore, start, prepareCount } = harness()

    const owner = await start(request({ sessionId: 'session-1', authRequestId: 'auth-1' }))
    const joiner = await start(request({ clientId: 'client-b', sessionId: 'session-2', authRequestId: 'auth-2' }))

    expect('authUrl' in owner && owner.authUrl).toBe('https://accounts.example.com/auth?n=1')
    expect(joiner).toMatchObject({ joined: true, flowId: owner.flowId })
    expect(prepareCount()).toBe(1)
    expect(flowStore.getLiveForSource('ws-1', 'gmail')!.waiters).toEqual([
      { clientId: 'client-b', sessionId: 'session-2', authRequestId: 'auth-2' },
    ])
  })

  it('a start that arrives while the first is still preparing waits and joins it', async () => {
    const { start, prepareCount, releaseNext } = harness({ manualPrepare: true })

    const ownerPromise = start(request())
    const joinerPromise = start(request({ clientId: 'client-b' }))
    await Promise.resolve()
    releaseNext()

    const owner = await ownerPromise
    const joiner = await joinerPromise
    expect(joiner).toMatchObject({ joined: true, flowId: owner.flowId })
    expect(prepareCount()).toBe(1)
  })

  it('other sources and other workspaces get their own flow', async () => {
    const { start, prepareCount } = harness()

    const gmail = await start(request())
    const calendar = await start(request({ sourceSlug: 'calendar' }))
    const otherWorkspace = await start(request({ workspaceId: 'ws-2' }))

    expect('joined' in calendar).toBe(false)
    expect('joined' in otherWorkspace).toBe(false)
    expect(new Set([gmail.flowId, calendar.flowId, otherWorkspace.flowId]).size).toBe(3)
    expect(prepareCount()).toBe(3)
  })

  it('older clients that cannot join still get their own flow', async () => {
    const { start } = harness()

    const first = await start(request())
    const legacy = await start(request({ clientId: 'old-client', joinLive: undefined }))

    expect('authUrl' in legacy).toBe(true)
    expect(legacy.flowId).not.toBe(first.flowId)
  })

  it('once the flow ends, the next start owns a new one', async () => {
    const { flowStore, start } = harness()

    const first = await start(request())
    flowStore.remove('authUrl' in first ? first.state : '', { success: false, error: 'denied' })
    const next = await start(request({ clientId: 'client-b' }))

    expect('authUrl' in next).toBe(true)
    expect(next.flowId).not.toBe(first.flowId)
  })

  it('a restart replaces the live flow, releases its waiters and keeps their cards bound', async () => {
    const { flowStore, start } = harness()

    const first = await start(request({ sessionId: 'session-1', authRequestId: 'auth-1' }))
    await start(request({ clientId: 'client-b', sessionId: 'session-2', authRequestId: 'auth-2' }))
    const restarted = await start(request({ clientId: 'client-b', sessionId: 'session-2', authRequestId: 'auth-2', restart: true }))

    expect('authUrl' in restarted).toBe(true)
    expect(restarted.flowId).not.toBe(first.flowId)
    const replaced = flowStore.getStatus(first.flowId, 'ws-1')
    expect(replaced.live).toBe(false)
    expect(replaced.live === false && replaced.outcome?.error).toBe('The sign-in was restarted.')

    const live = flowStore.getLiveForSource('ws-1', 'gmail')!
    expect(live.flowId).toBe(restarted.flowId)
    expect(live.waiters).toEqual([{ clientId: 'client-a', sessionId: 'session-1', authRequestId: 'auth-1' }])
  })
})

/** `completeOAuthFlow` over the same starter, with a recording session manager. */
function completionHarness(exchange: () => Promise<{ success: boolean; error?: string; email?: string }>) {
  const { flowStore, start } = harness()
  const calls: { fanOut: unknown[][]; settled: unknown[]; pushed: string[] } = { fanOut: [], settled: [], pushed: [] }
  const sessionManager = {
    claimAuthRequest(sessionId: string, requestId: string, sourceSlug: string) {
      if (!sessionId || !requestId) throw new Error('auth-request-stale')
      return { claimId: `claim-${requestId}`, sessionId, workspaceId: 'ws-1', requestId, sourceSlug }
    },
    async completeClaimedAuthRequest(claim: { requestId: string }, result: { requestId: string }) {
      calls.settled.push([claim.requestId, result])
    },
    completeAuthRequestsForSource: (...args: unknown[]) => {
      calls.fanOut.push(args)
      return ['session-1', 'session-2']
    },
  }
  const complete = (state: string, flowId: string) => completeOAuthFlow({
    code: 'auth-code',
    state,
    flowId,
    flowStore,
    credManager: { exchangeAndStore: exchange },
    sessionManager,
    pushSourcesChanged: (workspaceId) => calls.pushed.push(workspaceId),
    logger,
    owner: { clientId: 'client-a', workspaceId: 'ws-1' },
  })
  return { flowStore, start, calls, complete }
}

describe('completeOAuthFlow (UB3.10 outcome + fan-out)', () => {
  it('a successful sign-in answers every session waiting on the source and tells joiners', async () => {
    const { flowStore, start, calls, complete } = completionHarness(async () => ({ success: true, email: 'me@example.com' }))
    const owner = await start(request({ sessionId: 'session-1', authRequestId: 'auth-1' }))
    await start(request({ clientId: 'client-b', sessionId: 'session-2', authRequestId: 'auth-2' }))
    await start(request({ clientId: 'client-c' })) // page banner: no card

    const result = await complete('authUrl' in owner ? owner.state : '', owner.flowId)

    expect(result).toEqual({ success: true, email: 'me@example.com' })
    expect(calls.fanOut).toEqual([[
      'ws-1',
      'gmail',
      { email: 'me@example.com' },
      [
        { sessionId: 'session-1', authRequestId: 'auth-1' },
        { sessionId: 'session-2', authRequestId: 'auth-2' },
      ],
    ]])
    expect(calls.pushed).toEqual(['ws-1'])
    expect(flowStore.getStatus(owner.flowId, 'ws-1')).toEqual({
      live: false,
      outcome: { success: true, error: undefined, email: 'me@example.com' },
    })
  })

  it('a failed exchange fails only the card that started the flow; joined cards stay pending', async () => {
    const { flowStore, start, calls, complete } = completionHarness(async () => ({ success: false, error: 'invalid_grant' }))
    const owner = await start(request({ sessionId: 'session-1', authRequestId: 'auth-1' }))
    await start(request({ clientId: 'client-b', sessionId: 'session-2', authRequestId: 'auth-2' }))

    await complete('authUrl' in owner ? owner.state : '', owner.flowId)

    // No fan-out on failure; only the starting card was settled.
    expect(calls.fanOut).toEqual([])
    expect(calls.settled.length).toBe(1)
    const status = flowStore.getStatus(owner.flowId, 'ws-1')
    expect(status.live === false && status.outcome?.error).toBe('invalid_grant')
  })

  it('an exchange that throws still ends the flow so joiners stop waiting', async () => {
    const { flowStore, start, calls, complete } = completionHarness(async () => { throw new Error('network down') })
    const owner = await start(request({ sessionId: 'session-1', authRequestId: 'auth-1' }))

    // Our exchange keeps the D5 find (the throw never escapes the completion),
    // so the RPC resolves `complete-failed` — but the joined clients still read
    // the REAL reason from the outcome.
    const result = await complete('authUrl' in owner ? owner.state : '', owner.flowId)

    expect(result).toEqual({ success: false, error: 'complete-failed' })
    expect(calls.fanOut).toEqual([])
    expect(flowStore.getLiveForSource('ws-1', 'gmail')).toBeNull()
    const status = flowStore.getStatus(owner.flowId, 'ws-1')
    expect(status.live === false && status.outcome?.error).toBe('network down')
  })

  it('only the owning client can complete over RPC', async () => {
    const { start, complete } = completionHarness(async () => ({ success: true }))
    const owner = await start(request({ clientId: 'someone-else' }))

    await expect(complete('authUrl' in owner ? owner.state : '', owner.flowId)).rejects.toThrow()
  })
})

describe('oauth:status and oauth:cancel {error} handlers', () => {
  function handlerHarness() {
    const handlers = new Map<string, HandlerFn>()
    const server: RpcServer = {
      handle(channel, handler) { handlers.set(channel, handler) },
      push() {},
      async invokeClient() { return undefined },
      hasClientCapability() { return false },
      findClientsWithCapability() { return [] },
    }
    const flowStore = new OAuthFlowStore()
    stores.push(flowStore)
    const deps = {
      platform: { logger: { info() {}, warn() {}, error() {} } },
      oauthFlowStore: flowStore,
      sessionManager: {
        async getSession() { return null },
        claimAuthRequest() { throw new Error('unused') },
        async completeClaimedAuthRequest() {},
        completeAuthRequestsForSource: () => [],
      },
    } as unknown as HandlerDeps
    registerOAuthHandlers(server, deps)
    const ctx = { clientId: 'client-1', workspaceId: 'ws-1', webContentsId: 1 }
    return { handlers, ctx, flowStore }
  }

  it('oauth:status answers live, then the recorded outcome, workspace-scoped', async () => {
    const { handlers, ctx, flowStore } = handlerHarness()
    const status = handlers.get(RPC_CHANNELS.oauth.STATUS)!
    flowStore.store({
      flowId: 'flow-s1',
      state: 's1',
      codeVerifier: 'v',
      redirectUri: 'http://localhost/callback',
      source: {} as never,
      clientId: 'c',
      tokenEndpoint: 'https://example.test/token',
      provider: 'google',
      ownerClientId: 'client-1',
      workspaceId: 'ws-1',
      sourceSlug: 'gmail',
      waiters: [],
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })

    expect(await status(ctx, { flowId: 'flow-s1' })).toMatchObject({ live: true })
    expect(await status({ ...ctx, workspaceId: 'ws-2' }, { flowId: 'flow-s1' })).toEqual({ live: false })

    flowStore.remove('s1', { success: false, error: 'access_denied' })
    expect(await status(ctx, { flowId: 'flow-s1' })).toEqual({
      live: false,
      outcome: { success: false, error: 'access_denied' },
    })
  })

  it('oauth:cancel records the owner-provided error for the clients that joined', async () => {
    const { handlers, ctx, flowStore } = handlerHarness()
    const cancel = handlers.get(RPC_CHANNELS.oauth.CANCEL)!
    flowStore.store({
      flowId: 'flow-s1',
      state: 's1',
      codeVerifier: 'v',
      redirectUri: 'http://localhost/callback',
      source: {} as never,
      clientId: 'c',
      tokenEndpoint: 'https://example.test/token',
      provider: 'google',
      ownerClientId: 'client-1',
      workspaceId: 'ws-1',
      sourceSlug: 'gmail',
      waiters: [{ clientId: 'client-2', sessionId: 'session-2', authRequestId: 'auth-2' }],
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })

    expect(await cancel(ctx, { flowId: 'flow-s1', state: 's1', error: 'User denied' })).toEqual({ success: true })
    expect(flowStore.getStatus('flow-s1', 'ws-1')).toEqual({
      live: false,
      outcome: { success: false, error: 'User denied' },
    })
  })

  it('oauth:cancel without an error reports the cancellation sentence', async () => {
    const { handlers, ctx, flowStore } = handlerHarness()
    const cancel = handlers.get(RPC_CHANNELS.oauth.CANCEL)!
    flowStore.store({
      flowId: 'flow-s2',
      state: 's2',
      codeVerifier: 'v',
      redirectUri: 'http://localhost/callback',
      source: {} as never,
      clientId: 'c',
      tokenEndpoint: 'https://example.test/token',
      provider: 'google',
      ownerClientId: 'client-1',
      workspaceId: 'ws-1',
      sourceSlug: 'gmail',
      waiters: [],
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })

    await cancel(ctx, { flowId: 'flow-s2', state: 's2' })
    const status = flowStore.getStatus('flow-s2', 'ws-1')
    expect(status.live === false && status.outcome?.error).toContain('cancelled')
  })

  it('oauth:status refuses a client with no workspace', async () => {
    const { handlers } = handlerHarness()
    const status = handlers.get(RPC_CHANNELS.oauth.STATUS)!
    await expect(status({ clientId: 'client-1', workspaceId: undefined } as never, { flowId: 'flow-x' }))
      .rejects.toThrow('No workspace bound to this client')
  })
})

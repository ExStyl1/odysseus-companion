/**
 * UB3.10 — the WebUI `/api/oauth/callback` route completes the flow for every
 * session waiting on the source (the fan-out) and ends a provider-error flow
 * with the provider's own reason, so the clients that joined it read why.
 * Upstream: `webui/__tests__/oauth-callback.test.ts`, driven here through our
 * `startWebuiHttpServer` harness.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPendingFlow, OAuthFlowStore, type PendingOAuthFlow } from '@nessy-agent/shared/auth'
import { startWebuiHttpServer, type OAuthCallbackDeps } from '../http-server'

const SECRET = 'test-server-secret'
const PASSWORD = 'test-password'
const TEMP_DIRS: string[] = []
const SERVERS: Array<{ stop: () => void }> = []

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any

function createTestWebuiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nessy-webui-oauth-callback-'))
  TEMP_DIRS.push(dir)
  writeFileSync(join(dir, 'login.html'), '<!doctype html><html><body>login</body></html>')
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>app</body></html>')
  return dir
}

function createFlow(state: string): PendingOAuthFlow {
  return createPendingFlow({
    flowId: `flow-${state}`,
    state,
    codeVerifier: 'verifier',
    redirectUri: 'http://localhost:6477/callback',
    source: {} as never,
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    tokenEndpoint: 'https://oauth2.example.com/token',
    provider: 'google',
    ownerClientId: 'client-1',
    workspaceId: 'workspace-1',
    sourceSlug: 'gmail',
    sessionId: 'session-1',
    authRequestId: 'auth-1',
  })
}

function depsHarness(flowStore: OAuthFlowStore, exchange: () => Promise<{ success: boolean; error?: string; email?: string }>) {
  const fanOuts: unknown[][] = []
  const settled: Array<{ requestId: string; sourceSlug?: string; success: boolean; email?: string; error?: string }> = []
  let authStatus: 'pending' | 'completed' | 'cancelled' | 'failed' = 'pending'
  let claimed = false
  // The HTTP callback is state-bearer, but the flow's OWN card binding still
  // claims + settles through the claim model (our Keep) beside the fan-out.
  const sessionManager = {
    claimAuthRequest(sessionId: string, requestId: string, sourceSlug: string, workspaceId?: string) {
      if (claimed
        || sessionId !== 'session-1'
        || workspaceId !== 'workspace-1'
        || requestId !== 'auth-1'
        || sourceSlug !== 'gmail'
        || authStatus !== 'pending') {
        throw new Error('auth-request-stale')
      }
      claimed = true
      return { claimId: 'claim-1', sessionId, requestId, sourceSlug, workspaceId: 'workspace-1' }
    },
    async completeClaimedAuthRequest(_claim: unknown, result: { requestId: string; success: boolean }) {
      if (!claimed || authStatus !== 'pending') throw new Error('auth-request-stale')
      authStatus = result.success ? 'completed' : 'failed'
      settled.push(result)
    },
    completeAuthRequestsForSource: (...args: unknown[]) => {
      fanOuts.push(args)
      return ['session-1']
    },
  }
  const deps: OAuthCallbackDeps = {
    flowStore,
    credManager: { exchangeAndStore: exchange },
    sessionManager,
    pushSourcesChanged: () => {},
  }
  return { deps, fanOuts, settled }
}

afterEach(() => {
  while (SERVERS.length > 0) SERVERS.pop()!.stop()
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('WebUI /api/oauth/callback (UB3.10)', () => {
  it('completes the flow and answers every session waiting on the source', async () => {
    const flowStore = new OAuthFlowStore()
    const flow = createFlow('inner-state-123')
    flowStore.store(flow)
    const { deps, fanOuts, settled } = depsHarness(flowStore, async () => ({ success: true, email: 'me@example.com' }))

    const server = await startWebuiHttpServer({
      port: 0,
      webuiDir: createTestWebuiDir(),
      secret: SECRET,
      password: PASSWORD,
      wsProtocol: 'wss',
      wsPort: 9100,
      getHealthCheck: () => ({ status: 'ok' }),
      logger,
      oauthCallbackDeps: deps,
    })
    SERVERS.push(server)

    const response = await fetch(`http://127.0.0.1:${server.port}/api/oauth/callback?code=auth-code-123&state=inner-state-123`)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Authorization Successful')
    expect(flowStore.getByState('inner-state-123')).toBeNull()
    // Every session waiting on the source in the workspace is answered, with the cards that
    // started or joined the flow bound even if their session forgot the request.
    expect(fanOuts).toEqual([[
      'workspace-1',
      'gmail',
      { email: 'me@example.com' },
      [{ sessionId: 'session-1', authRequestId: 'auth-1' }],
    ]])
    // The card that started the flow settled through the claim model, exactly once.
    expect(settled).toEqual([{ requestId: 'auth-1', sourceSlug: 'gmail', success: true, email: 'me@example.com', error: undefined }])
    expect(flowStore.getStatus(flow.flowId, 'workspace-1')).toEqual({
      live: false,
      outcome: { success: true, error: undefined, email: 'me@example.com' },
    })
  })

  it('ends a provider-error flow with the provider\'s own reason', async () => {
    const flowStore = new OAuthFlowStore()
    const flow = createFlow('inner-state-456')
    flowStore.store(flow)
    const { deps } = depsHarness(flowStore, async () => ({ success: true }))

    const server = await startWebuiHttpServer({
      port: 0,
      webuiDir: createTestWebuiDir(),
      secret: SECRET,
      password: PASSWORD,
      wsProtocol: 'wss',
      wsPort: 9100,
      getHealthCheck: () => ({ status: 'ok' }),
      logger,
      oauthCallbackDeps: deps,
    })
    SERVERS.push(server)

    const response = await fetch(`http://127.0.0.1:${server.port}/api/oauth/callback?error=access_denied&error_description=User%20denied&state=inner-state-456`)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Authorization Failed')
    expect(flowStore.getByState('inner-state-456')).toBeNull()
    // Clients that joined the flow learn why it ended — the provider's reason, not a generic code.
    expect(flowStore.getStatus(flow.flowId, 'workspace-1')).toEqual({
      live: false,
      outcome: { success: false, error: 'User denied', email: undefined },
    })
  })
})

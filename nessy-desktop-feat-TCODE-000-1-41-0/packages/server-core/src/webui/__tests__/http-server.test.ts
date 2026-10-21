import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPendingFlow, OAuthFlowStore } from '@nessy-agent/shared/auth'
import {
  startWebuiHttpServer,
  type OAuthCallbackDeps,
} from '../http-server'

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
  const dir = mkdtempSync(join(tmpdir(), 'nessy-webui-test-'))
  TEMP_DIRS.push(dir)
  writeFileSync(join(dir, 'login.html'), '<!doctype html><html><body>login</body></html>')
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>app</body></html>')
  return dir
}

async function createServer(overrides?: {
  secureCookies?: boolean
  publicWsUrl?: string
  wsProtocol?: 'ws' | 'wss'
  wsPort?: number
  logger?: typeof logger
  oauthCallbackDeps?: OAuthCallbackDeps
}) {
  const server = await startWebuiHttpServer({
    port: 0,
    webuiDir: createTestWebuiDir(),
    secret: SECRET,
    password: PASSWORD,
    secureCookies: overrides?.secureCookies,
    publicWsUrl: overrides?.publicWsUrl,
    wsProtocol: overrides?.wsProtocol ?? 'wss',
    wsPort: overrides?.wsPort ?? 9100,
    getHealthCheck: () => ({ status: 'ok' }),
    logger: overrides?.logger ?? logger,
    oauthCallbackDeps: overrides?.oauthCallbackDeps,
  })

  SERVERS.push(server)

  return {
    server,
    baseUrl: `http://127.0.0.1:${server.port}`,
  }
}

function oauthCallbackHarness(requestId: string, state: string) {
  const flowStore = new OAuthFlowStore()
  const settlements: Array<{
    requestId: string
    sourceSlug: string
    success: boolean
    cancelled?: boolean
    error?: string
  }> = []
  let authStatus: 'pending' | 'completed' | 'cancelled' | 'failed' = 'pending'
  let claimed = false
  const sessionManager = {
    async getSession() {
      return {
        messages: [{
          role: 'auth-request',
          authRequestId: requestId,
          authRequestType: 'oauth',
          authSourceSlug: 'mail',
          authStatus,
        }],
      }
    },
    claimAuthRequest(
      sessionId: string,
      claimedRequestId: string,
      sourceSlug: string,
      workspaceId?: string,
    ) {
      if (claimed
        || sessionId !== 'session-1'
        || workspaceId !== 'workspace-1'
        || claimedRequestId !== requestId
        || sourceSlug !== 'mail'
        || authStatus !== 'pending') {
        throw new Error('auth-request-stale')
      }
      claimed = true
      return { sessionId, requestId, sourceSlug, workspaceId: 'workspace-1' }
    },
    async completeClaimedAuthRequest(_claim: unknown, result: typeof settlements[number]) {
      if (!claimed || authStatus !== 'pending') throw new Error('auth-request-stale')
      authStatus = result.success ? 'completed' : result.cancelled ? 'cancelled' : 'failed'
      settlements.push(result)
    },
    async completeAuthRequest(
      sessionId: string,
      result: typeof settlements[number],
      workspaceId?: string,
    ) {
      const claim = this.claimAuthRequest(
        sessionId,
        result.requestId,
        result.sourceSlug,
        workspaceId,
      )
      await this.completeClaimedAuthRequest(claim, result)
    },
  }
  flowStore.store(createPendingFlow({
    flowId: `flow-${requestId}`,
    state,
    codeVerifier: 'verifier',
    redirectUri: 'http://localhost/callback',
    source: {} as never,
    clientId: 'client',
    tokenEndpoint: 'https://example.test/token',
    provider: 'mcp',
    ownerClientId: 'webui',
    workspaceId: 'workspace-1',
    sourceSlug: 'mail',
    sessionId: 'session-1',
    authRequestId: requestId,
  }))
  const exchangeAndStore = mock(async () => ({ success: true }))
  return {
    flowStore,
    settlements,
    exchangeAndStore,
    deps: {
      flowStore,
      credManager: { exchangeAndStore },
      sessionManager,
      pushSourcesChanged: () => {},
    } as unknown as OAuthCallbackDeps,
  }
}

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie')
  expect(setCookie).toBeTruthy()
  return setCookie!.split(';')[0]!
}

afterEach(() => {
  while (SERVERS.length > 0) {
    SERVERS.pop()?.stop()
  }

  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('startWebuiHttpServer', () => {
  it('allows plain-http login even when the RPC transport is wss', async () => {
    const { baseUrl } = await createServer({ wsProtocol: 'wss', wsPort: 9100 })

    const authRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })

    expect(authRes.status).toBe(200)
    const setCookie = authRes.headers.get('set-cookie')
    expect(setCookie).toContain('nessy_session=')
    expect(setCookie).not.toContain('Secure')

    const configRes = await fetch(`${baseUrl}/api/config`, {
      headers: {
        cookie: extractSessionCookie(authRes),
      },
    })

    expect(configRes.status).toBe(200)
    expect(await configRes.json()).toEqual({
      wsUrl: 'wss://127.0.0.1:9100',
    })
  })

  it('rejects invalid credentials', async () => {
    const { baseUrl } = await createServer()

    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid credentials' })
  })

  it('honors an explicit secure-cookie override', async () => {
    const { baseUrl } = await createServer({ secureCookies: true, wsProtocol: 'ws', wsPort: 9100 })

    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('infers secure cookies from proxy https headers when no override is set', async () => {
    const { baseUrl } = await createServer({ wsProtocol: 'wss', wsPort: 9100 })

    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ password: PASSWORD }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('derives a browser-facing websocket URL from forwarded public host headers', async () => {
    const { baseUrl } = await createServer({ wsProtocol: 'wss', wsPort: 9100 })

    const authRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'nessy.example.com:3100',
      },
      body: JSON.stringify({ password: PASSWORD }),
    })

    const configRes = await fetch(`${baseUrl}/api/config`, {
      headers: {
        cookie: extractSessionCookie(authRes),
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'nessy.example.com:3100',
      },
    })

    expect(configRes.status).toBe(200)
    expect(await configRes.json()).toEqual({
      wsUrl: 'wss://nessy.example.com:9100',
    })
  })

  it('returns an explicit public websocket URL override from /api/config', async () => {
    const { baseUrl } = await createServer({
      publicWsUrl: 'wss://nessy.example.com/ws',
      wsProtocol: 'wss',
      wsPort: 9100,
    })

    const authRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })

    const configRes = await fetch(`${baseUrl}/api/config`, {
      headers: {
        cookie: extractSessionCookie(authRes),
      },
    })

    expect(configRes.status).toBe(200)
    expect(await configRes.json()).toEqual({
      wsUrl: 'wss://nessy.example.com/ws',
    })
  })

  it('terminally settles a provider callback error once without exposing provider text', async () => {
    const harness = oauthCallbackHarness('request-provider-error', 'state-provider-error')
    const logs: string[] = []
    const recordingLogger = {
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
      error: (message: string) => logs.push(message),
      debug: (message: string) => logs.push(message),
    } as typeof logger
    try {
      const { baseUrl } = await createServer({
        oauthCallbackDeps: harness.deps,
        logger: recordingLogger,
      })
      const callbackUrl = `${baseUrl}/api/oauth/callback?state=state-provider-error`
        + '&error=access_denied&error_description=raw-provider-secret'

      const responses = await Promise.all([
        fetch(callbackUrl),
        fetch(callbackUrl),
      ])
      const bodies = await Promise.all(responses.map(response => response.text()))

      expect(harness.settlements).toEqual([{
        requestId: 'request-provider-error',
        sourceSlug: 'mail',
        success: false,
        error: 'The OAuth provider did not complete authentication.',
      }])
      expect(harness.exchangeAndStore).not.toHaveBeenCalled()
      expect(harness.flowStore.size).toBe(0)
      expect(bodies.join('\n')).toContain('The OAuth provider did not complete authentication.')
      expect(bodies.join('\n')).not.toContain('raw-provider-secret')
      expect(logs.join('\n')).not.toContain('raw-provider-secret')
      expect(logs.join('\n')).not.toContain('access_denied')
    } finally {
      harness.flowStore.dispose()
    }
  })

  it('terminally settles a missing authorization code with the bounded code message', async () => {
    const harness = oauthCallbackHarness('request-missing-code', 'state-missing-code')
    try {
      const { baseUrl } = await createServer({ oauthCallbackDeps: harness.deps })

      const response = await fetch(
        `${baseUrl}/api/oauth/callback?state=state-missing-code`,
      )
      const body = await response.text()

      expect(response.status).toBe(200)
      expect(harness.settlements).toEqual([{
        requestId: 'request-missing-code',
        sourceSlug: 'mail',
        success: false,
        error: 'The OAuth provider did not return an authorization code.',
      }])
      expect(harness.exchangeAndStore).not.toHaveBeenCalled()
      expect(harness.flowStore.size).toBe(0)
      expect(body).toContain('The OAuth provider did not return an authorization code.')
    } finally {
      harness.flowStore.dispose()
    }
  })
})

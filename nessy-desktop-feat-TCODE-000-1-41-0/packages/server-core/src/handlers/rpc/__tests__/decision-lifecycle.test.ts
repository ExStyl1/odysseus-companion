/**
 * UB6.3 — the decision RPC lifecycle.
 *
 * Positive: a LOCAL client (the request carries a live Electron window) sets the
 * Laya provider and the canned connection test reaches the wire. Negative
 * (controls): a NON-LOCAL client (no webContentsId — a proxied remote client, or
 * the headless server's own client) is refused any provider, base URL, connection
 * or key change (`decision-provider-change-local-only`, the SEC-8 posture) while
 * its reads and non-endpoint settings changes pass; a foreground decision past its
 * 3 s cap resolves null and the caller proceeds.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { RpcServer, RequestContext } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerDecisionsHandlers } from '../decisions'
import { initializeCredentialManagerV2 } from '@nessy-agent/shared/credentials'
import { getDecisionLayerSettings, loadStoredConfig, saveConfig } from '@nessy-agent/shared/config/storage'
import { STORAGE_LAYOUT_VERSION } from '@nessy-agent/shared/config/paths'
import { FOREGROUND_MAX_DEADLINE_MS, openDecisionPoint } from '../../../decisions/decision-point'
import { DecisionError, type DecisionRequest, type DecisionResult } from '@nessy-agent/shared/decisions'
import { normalizeDecisionLayerSettings, resolveDecisionEndpoint } from '@nessy-agent/shared/decisions'
import type { DecisionClientResolution } from '@nessy-agent/shared/decisions'

function stubServer(): { server: RpcServer; handlers: Map<string, (...args: unknown[]) => unknown> } {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const server = {
    handle(channel: string, handler: never) {
      handlers.set(channel, handler as (...args: unknown[]) => unknown)
    },
    push() {},
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as RpcServer
  return { server, handlers }
}

function depsWithWindow(known: boolean): HandlerDeps {
  return {
    windowManager: {
      getWindowByWebContentsId: () => (known ? { id: 1 } : null),
      getWorkspaceForWindow: () => 'ws-1',
    },
  } as unknown as HandlerDeps
}

const LOCAL_CTX: RequestContext = { clientId: 'local', workspaceId: null, webContentsId: 7 }
const REMOTE_CTX: RequestContext = { clientId: 'remote', workspaceId: null, webContentsId: null }

const LAYA_OK = {
  model: 'auto',
  answers: { succeeded: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 2 },
}

describe('decisions RPC lifecycle (UB6.3)', () => {
  let fetchCalls: Array<{ url: string; init: RequestInit }>
  let realFetch: typeof globalThis.fetch

  beforeEach(() => {
    // The handlers resolve the process credential singleton; startup is what
    // initializes it from verified v2 storage. Bind it the sibling bootstrap tests'
    // way (same verificationId, so a shared process returns the bound manager).
    initializeCredentialManagerV2({ storageLayoutVersion: 2, verificationId: 'verified' })
    // The isolate preload points NESSY_CONFIG_DIR at an EMPTY temp dir: config.json
    // does not exist until startup seeds it. The SET_SETTINGS arm needs a real file.
    if (!loadStoredConfig()) {
      saveConfig({
        storageLayoutVersion: STORAGE_LAYOUT_VERSION,
        workspaceRefs: [],
        activeWorkspaceId: null,
        activeSessionId: null,
      })
    }
    fetchCalls = []
    realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init })
      return new Response(JSON.stringify(LAYA_OK), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('positive: a local client sets Laya and the connection test reaches the wire', async () => {
    const { server, handlers } = stubServer()
    registerDecisionsHandlers(server, depsWithWindow(true))

    await handlers.get(RPC_CHANNELS.decisions.SET_SETTINGS)!(LOCAL_CTX, { provider: 'laya', enabled: true })
    expect(getDecisionLayerSettings().provider).toBe('laya')
    expect(getDecisionLayerSettings().enabled).toBe(true)

    const result = await handlers.get(RPC_CHANNELS.decisions.TEST)!(LOCAL_CTX, {}) as { ok: boolean; provider?: string }
    expect(result.ok).toBe(true)
    expect(result.provider).toBe('laya')
    expect(fetchCalls.some(c => c.url === 'http://127.0.0.1:8000/v1/systemone')).toBe(true)
  })

  it('negative (control): a remote client\u2019s provider, URL, connection and key changes are refused; its reads pass', async () => {
    const { server, handlers } = stubServer()
    registerDecisionsHandlers(server, depsWithWindow(false))

    for (const patch of [{ provider: 'laya' }, { baseUrl: 'http://127.0.0.1:9000' }, { connectionSlug: 'openrouter-main' }]) {
      await expect(handlers.get(RPC_CHANNELS.decisions.SET_SETTINGS)!(REMOTE_CTX, patch)).rejects.toThrow('decision-provider-change-local-only')
    }
    await expect(handlers.get(RPC_CHANNELS.decisions.SET_API_KEY)!(REMOTE_CTX, 'laya', 'sk-x')).rejects.toThrow('decision-provider-change-local-only')
    await expect(handlers.get(RPC_CHANNELS.decisions.DELETE_API_KEY)!(REMOTE_CTX, 'laya')).rejects.toThrow('decision-provider-change-local-only')
    await expect(handlers.get(RPC_CHANNELS.decisions.PROBE_SERVER)!(REMOTE_CTX, { baseUrl: 'http://127.0.0.1:9000' })).rejects.toThrow('decision-provider-change-local-only')
    // TEST with an endpoint patch or an unsaved key is the same refusal.
    await expect(handlers.get(RPC_CHANNELS.decisions.TEST)!(REMOTE_CTX, { settings: { provider: 'laya' } })).rejects.toThrow('decision-provider-change-local-only')
    await expect(handlers.get(RPC_CHANNELS.decisions.TEST)!(REMOTE_CTX, { apiKey: 'sk-fixture' })).rejects.toThrow('decision-provider-change-local-only')

    // Reads stay REMOTE_ELIGIBLE, and a patch that touches no endpoint field passes.
    await expect(handlers.get(RPC_CHANNELS.decisions.GET_SETTINGS)!(REMOTE_CTX)).resolves.toBeDefined()
    await expect(handlers.get(RPC_CHANNELS.decisions.GET_STATUS)!(REMOTE_CTX)).resolves.toBeDefined()
    await expect(handlers.get(RPC_CHANNELS.decisions.GET_USAGE)!(REMOTE_CTX)).resolves.toBeDefined()
    await expect(handlers.get(RPC_CHANNELS.decisions.SET_SETTINGS)!(REMOTE_CTX, { enabled: true, deadlineMs: 2000, features: { decideTool: false } })).resolves.toBeDefined()
  })

  it('boundary: the headless shape (no window manager at all) is non-local too', async () => {
    const { server, handlers } = stubServer()
    registerDecisionsHandlers(server, {} as HandlerDeps)
    await expect(handlers.get(RPC_CHANNELS.decisions.SET_SETTINGS)!(REMOTE_CTX, { provider: 'typesafe' })).rejects.toThrow('decision-provider-change-local-only')
  })

  it('negative (control): a foreground decision past the 3 s cap resolves null and the caller proceeds', async () => {
    const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'custom', baseUrl: 'http://127.0.0.1:9' })
    const resolveClient = async (): Promise<DecisionClientResolution> => ({
      ok: true,
      value: {
        client: {
          // Stands in for the real client's deadline behaviour: past the deadline the
          // real SystemOneClient throws TimeoutError, which the point maps to null.
          decide: async (): Promise<DecisionResult> => {
            await new Promise(resolve => setTimeout(resolve, 30))
            throw new DecisionError('timeout', 'slow')
          },
        } as never,
        settings,
        provider: 'custom',
        endpoint: resolveDecisionEndpoint(settings),
        keySource: 'none',
      },
    })
    // A request deadline the client ignores is still cut off by the client's own
    // clamp; the point passes its cap down, and the caller sees null either way.
    const decide = (await openDecisionPoint({ feature: 'turnOutcome', record: 'turn_outcome', resolveClient, maxDeadlineMs: FOREGROUND_MAX_DEADLINE_MS }))!
    const result = await decide({ state: 's', questions: { q: { type: 'noul', instructions: 'ok?' } }, deadlineMs: 5 })
    expect(result).toBeNull()
  })
})

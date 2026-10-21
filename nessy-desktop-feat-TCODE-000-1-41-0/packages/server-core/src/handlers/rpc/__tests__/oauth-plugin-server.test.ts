/**
 * C3 (capability-path plan): the OAuth RPC boundary accepts a PLUGIN-SERVER
 * target — `{pluginKey, serverName}` — resolved against the ACTIVE installed
 * manifest's auth-carrying `kind:'mcp'` capability under plugin/capability
 * policy. Completion stores into the server's GLOBAL plugin credential slot
 * (`plugin_mcp_oauth::{pluginKey}::{serverName}`); no Source exists at any
 * point. Revoke clears both slots.
 */

import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import * as sharedAuth from '@nessy-agent/shared/auth'
import * as credentialsManagerModule from '@nessy-agent/shared/credentials/manager'
import {
  credentialIdToAccount,
  type CredentialId,
  type StoredCredential,
} from '@nessy-agent/shared/credentials/types'
import type { PluginInstalledEntryV2 } from '@nessy-agent/shared/plugins'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerOAuthHandlers } from '../oauth'

let root: string
let rows: Map<string, StoredCredential>
const spies: Array<{ mockRestore: () => void }> = []

function fakeCredentialManager() {
  const account = (id: CredentialId) => credentialIdToAccount(id)
  return {
    get: async (id: CredentialId) => structuredClone(rows.get(account(id)) ?? null),
    set: async (id: CredentialId, credential: StoredCredential) => {
      rows.set(account(id), structuredClone(credential))
    },
    delete: async (id: CredentialId) => rows.delete(account(id)),
    deleteSync: (id: CredentialId) => rows.delete(account(id)),
    getRuntimeCredentialStatus: (id: CredentialId) => ({
      state: rows.has(account(id)) ? 'ready' : 'missing',
      revision: 0,
    }),
  }
}

const BUNDLE_HASH = 'a'.repeat(64)
const PLUGIN_INSTANCE_ID = `plugin://mk/tracker@1.0.0#${BUNDLE_HASH}`

function installedEntry(serverUrl = 'https://tracker.example.test/mcp'): PluginInstalledEntryV2 {
  return {
    pluginInstanceId: PLUGIN_INSTANCE_ID,
    pluginKey: 'mk.tracker',
    marketplaceId: 'mk',
    pluginId: 'tracker',
    version: '1.0.0',
    bundleHash: BUNDLE_HASH,
    cacheRef: { marketplaceId: 'mk', pluginId: 'tracker', version: '1.0.0', bundleHash: BUNDLE_HASH },
    manifest: {
      schemaVersion: 1,
      kind: 'plugin',
      id: 'tracker',
      name: 'Tracker',
      version: '1.0.0',
      capabilities: [{
        kind: 'mcp',
        id: 'mcp.tracker.tracker-mcp',
        mcp: {
          serverName: 'tracker-mcp',
          transport: 'http',
          url: serverUrl,
          authType: 'oauth',
          oauthResource: 'https://tracker.example.test/',
        },
      }],
    },
    origin: { source: 'marketplace', resolvedAt: 0 },
    installedAt: 1,
    diagnostics: [],
  }
}

function createHarness(options: { enabled?: boolean; serverUrl?: string } = {}) {
  const handlers = new Map<string, HandlerFn>()
  const errorLog: unknown[][] = []
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const policyStore = new CapabilityPolicyStore({
    globalPath: join(root, 'capabilities.json'),
    workspacePolicyPath: workspaceId => join(root, `${workspaceId}-capabilities.json`),
  })
  if (options.enabled !== false) {
    policyStore.recordWorkspace('ws-1', { pluginKey: 'mk.tracker', enabled: true })
  }
  const flowStore = new sharedAuth.OAuthFlowStore()
  const deps = {
    platform: {
      logger: {
        info() {},
        warn() {},
        error(...args: unknown[]) { errorLog.push(args) },
      },
    },
    oauthFlowStore: flowStore,
    sessionManager: {
      async getSession() { return null },
      claimAuthRequest() { throw new Error('unused') },
      async completeClaimedAuthRequest() {},
    },
    pluginStore: {
      async readInstalledRegistry() {
        return {
          plugins: [installedEntry(options.serverUrl)],
          active: { 'mk.tracker': PLUGIN_INSTANCE_ID },
        }
      },
    },
    capabilityPolicyStore: policyStore,
  } as unknown as HandlerDeps
  registerOAuthHandlers(server, deps)
  const ctx = { clientId: 'client-1', workspaceId: 'ws-1', webContentsId: 1 }
  return { handlers, ctx, flowStore, errorLog }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oauth-plugin-server-rpc-'))
  rows = new Map()
  spies.push(spyOn(credentialsManagerModule, 'getCredentialManager')
    .mockReturnValue(fakeCredentialManager() as never))
})

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore()
  rmSync(root, { recursive: true, force: true })
})

describe('plugin-server OAuth flow (C3)', () => {
  it('START prepares from the manifest endpoint, COMPLETE stores into the plugin slot, REVOKE clears it', async () => {
    const prepareSpy = spyOn(sharedAuth, 'prepareEndpointOAuth').mockResolvedValue({
      authUrl: 'https://auth.example.test/authorize',
      state: 'state-1',
      codeVerifier: 'verifier-1',
      tokenEndpoint: 'https://auth.example.test/token',
      clientId: 'dcr-client-1',
      redirectUri: 'http://localhost:8914/oauth/callback',
      oauthResource: 'https://tracker.example.test/',
      provider: 'mcp',
    })
    spies.push(prepareSpy)
    const exchangeSpy = spyOn(sharedAuth, 'exchangeEndpointOAuth').mockResolvedValue({
      success: true,
      accessToken: 'slot-access-token',
      refreshToken: 'slot-refresh-token',
      expiresAt: 4102444800000,
      oauthClientId: 'dcr-client-1',
    })
    spies.push(exchangeSpy)

    const { handlers, ctx, flowStore } = createHarness()
    try {
      const started = await handlers.get(RPC_CHANNELS.oauth.START)!(ctx, {
        pluginServer: { pluginKey: 'mk.tracker', serverName: 'tracker-mcp' },
        callbackPort: 8914,
      }) as { authUrl: string; state: string; flowId: string }

      expect(started.authUrl).toBe('https://auth.example.test/authorize')
      expect(prepareSpy).toHaveBeenCalledTimes(1)
      expect(prepareSpy.mock.calls[0]![0]).toEqual({
        url: 'https://tracker.example.test/mcp',
        authType: 'oauth',
        oauthResource: 'https://tracker.example.test/',
      })

      const completed = await handlers.get(RPC_CHANNELS.oauth.COMPLETE)!(ctx, {
        flowId: started.flowId,
        code: 'authorization-code',
        state: started.state,
      }) as { success: boolean }

      expect(completed.success).toBe(true)
      expect(rows.get('plugin_mcp_oauth::mk.tracker::tracker-mcp')).toEqual({
        value: 'slot-access-token',
        refreshToken: 'slot-refresh-token',
        expiresAt: 4102444800000,
        clientId: 'dcr-client-1',
        clientSecret: undefined,
      })
      // No source row of any shape was written.
      expect([...rows.keys()].every(key => key.startsWith('plugin_mcp_'))).toBe(true)

      const revoked = await handlers.get(RPC_CHANNELS.oauth.REVOKE)!(ctx, {
        pluginServer: { pluginKey: 'mk.tracker', serverName: 'tracker-mcp' },
      }) as { success: boolean }
      expect(revoked.success).toBe(true)
      expect(rows.size).toBe(0)
    } finally {
      flowStore.dispose()
    }
  })

  it('refuses a disabled plugin and an unknown server without preparing anything', async () => {
    const prepareSpy = spyOn(sharedAuth, 'prepareEndpointOAuth').mockResolvedValue({} as never)
    spies.push(prepareSpy)

    const disabled = createHarness({ enabled: false })
    try {
      await expect(disabled.handlers.get(RPC_CHANNELS.oauth.START)!(disabled.ctx, {
        pluginServer: { pluginKey: 'mk.tracker', serverName: 'tracker-mcp' },
      })).rejects.toThrow('plugin-oauth-flow-invalidated')
    } finally {
      disabled.flowStore.dispose()
    }

    const enabled = createHarness()
    try {
      await expect(enabled.handlers.get(RPC_CHANNELS.oauth.START)!(enabled.ctx, {
        pluginServer: { pluginKey: 'mk.tracker', serverName: 'ghost-mcp' },
      })).rejects.toThrow('plugin-mcp-server-unavailable')
    } finally {
      enabled.flowStore.dispose()
    }
    expect(prepareSpy).not.toHaveBeenCalled()
  })
})

/**
 * A guard that replaces a specific error with a generic string is why a live
 * Figma OAuth failure was unreadable from the product: the card said "Unable to
 * start OAuth authentication" and the log said nothing at all. START must keep
 * BOTH halves — the typed code the UI switches on, and the original error.
 */
describe('plugin-server OAuth START preserves the failing error', () => {
  it('surfaces the original error in cause, diagnostic and log while still throwing START_FAILED', async () => {
    const original = new TypeError('fetch failed: unable to verify the first certificate')
    const prepareSpy = spyOn(sharedAuth, 'prepareEndpointOAuth').mockRejectedValue(original)
    spies.push(prepareSpy)

    const { handlers, ctx, flowStore, errorLog } = createHarness()
    try {
      const thrown = await handlers.get(RPC_CHANNELS.oauth.START)!(ctx, {
        pluginServer: { pluginKey: 'mk.tracker', serverName: 'tracker-mcp' },
      }).then(() => null, (error: unknown) => error) as Error & {
        diagnostic?: Record<string, unknown>
      }

      // Half 1 — the typed code the UI keys off is unchanged.
      expect(thrown).toBeInstanceOf(Error)
      expect(thrown.message).toBe('start-failed')

      // Half 2 — the original error is still reachable.
      expect(thrown.cause).toBe(original)
      expect(thrown.diagnostic).toMatchObject({
        code: 'start-failed',
        target: 'tracker-mcp',
        errorName: 'TypeError',
        errorMessage: 'fetch failed: unable to verify the first certificate',
      })

      const logged = errorLog.find(args => args[0] === '[OAuth] Start failed')
      expect(logged).toBeDefined()
      expect(logged![1]).toMatchObject({
        code: 'start-failed',
        errorName: 'TypeError',
        errorMessage: 'fetch failed: unable to verify the first certificate',
      })
    } finally {
      flowStore.dispose()
    }
  })

  it('keeps METADATA_UNAVAILABLE typed, and logs the endpoint without its query', async () => {
    const original = new Error('No OAuth metadata found for https://tracker.example.test/mcp')
    const prepareSpy = spyOn(sharedAuth, 'prepareEndpointOAuth').mockRejectedValue(original)
    spies.push(prepareSpy)

    const { handlers, ctx, flowStore, errorLog } = createHarness({
      serverUrl: 'https://tracker.example.test/mcp?state=SECRET&code=SECRET',
    })
    try {
      const thrown = await handlers.get(RPC_CHANNELS.oauth.START)!(ctx, {
        pluginServer: { pluginKey: 'mk.tracker', serverName: 'tracker-mcp' },
      }).then(() => null, (error: unknown) => error) as Error & {
        diagnostic?: Record<string, unknown>
      }

      expect(thrown.message).toBe('metadata-unavailable')
      expect(thrown.cause).toBe(original)

      const logged = errorLog.find(args => args[0] === '[OAuth] Start failed')!
      const diagnostic = logged[1] as Record<string, unknown>
      expect(diagnostic.endpoint).toBe('https://tracker.example.test/mcp')
      expect(JSON.stringify(diagnostic)).not.toContain('SECRET')
    } finally {
      flowStore.dispose()
    }
  })
})

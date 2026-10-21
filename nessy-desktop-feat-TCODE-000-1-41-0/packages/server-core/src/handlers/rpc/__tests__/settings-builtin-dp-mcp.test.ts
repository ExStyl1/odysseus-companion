/**
 * A7 — the RPC surface that lets a user change the built-in dp MCP set.
 *
 * The storage key, its parser, the read and both runtime folds already existed
 * and were wired. What did not exist was any way for a user to WRITE the
 * preference: no channel, no handler, no renderer, so `config.json` had to be
 * hand-edited. These arms assert the write reaches disk through the config
 * storage path, that the read half's forward-compatibility rules survive it,
 * and that a machine without `dp` gets an explanation rather than a dead switch.
 *
 * Host-independence is a rule here, not a convenience:
 *
 * - **Nothing executes `dp`, and no arm needs it installed.** The two
 *   availability arms inject `resolveDpPath` (the seam
 *   `materializeBuiltinDpMcpServers` exists to have); the handler-driven arms
 *   never assert `available`, because the handler uses the real filesystem
 *   lookup and that answer legitimately differs between a corp laptop and CI.
 * - **Nothing touches the developer's real config.** The root `bunfig.toml`
 *   `[test].preload` points `NESSY_CONFIG_DIR` at a private temp directory.
 * - **Nothing reads `~/.nessy/dp_auth_creds.json`.** The set carries no token,
 *   header or env: each dp subprocess authenticates itself.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import {
  CONFIG_DIR,
  getBuiltinDpMcpServerPreferences,
  loadStoredConfig,
  readBuiltinDpMcpSettingsView,
  saveConfig,
} from '@nessy-agent/shared/config'
import { BUILTIN_DP_MCP_SERVERS, type McpClientPool } from '@nessy-agent/shared/mcp'
import type {
  CapabilityContext,
  CapabilityResolver,
  EffectiveCapabilitySnapshot,
  ResolvedCapabilityEntry,
} from '@nessy-agent/shared/capabilities/resolver'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerCapabilitiesHandlers } from '../capabilities'
import { registerSettingsHandlers } from '../settings'
import { createTestSessionManager } from '../../../sessions/__tests__/test-session-manager'

const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
let seeded = false

beforeAll(() => {
  if (existsSync(CONFIG_FILE)) return
  saveConfig({ workspaceRefs: [], activeWorkspaceId: null, activeSessionId: null })
  seeded = true
})

/** Every arm starts from "the user has expressed no preference". */
beforeEach(() => {
  const config = loadStoredConfig()
  if (!config) return
  delete config.builtinDpMcpServers
  saveConfig(config)
})

afterAll(() => {
  if (seeded) {
    rmSync(CONFIG_FILE, { force: true })
    return
  }
  const config = loadStoredConfig()
  if (!config) return
  delete config.builtinDpMcpServers
  saveConfig(config)
})

function handlers(overrides: {
  invalidateWorkspaceMcpPools?: () => void
  push?: (channel: string, target: unknown, ...args: unknown[]) => void
  workspaces?: Array<{ id: string }>
} = {}): Map<string, HandlerFn> {
  const registered = new Map<string, HandlerFn>()
  const server = {
    handle(channel: string, handler: HandlerFn) { registered.set(channel, handler) },
    push: overrides.push ?? (() => {}),
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as RpcServer
  const deps = {
    // A successful SET_ENABLED calls `invalidateWorkspaceMcpPools()` — every
    // arm that reaches that point needs a real function here, not `{}`; tests
    // that care about the call inject their own spy.
    sessionManager: {
      invalidateWorkspaceMcpPools: overrides.invalidateWorkspaceMcpPools ?? (() => {}),
      getWorkspaces: () => overrides.workspaces ?? [],
    },
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerSettingsHandlers(server, deps)
  return registered
}

const ctx = { clientId: 'client-a', workspaceId: 'ws-a', webContentsId: null }

interface ServerRow {
  name: string
  subcommand: string
  description: string
  defaultEnabled: boolean
  enabled: boolean
}
interface SettingsView {
  available: boolean
  diagnostics: { code: string; message: string }[]
  servers: ServerRow[]
}

function storedMap(): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as {
    builtinDpMcpServers?: { enabled?: Record<string, unknown> }
  }
  return raw.builtinDpMcpServers?.enabled ?? {}
}

describe('built-in dp MCP RPC surface', () => {
  it('registers the read and the write', () => {
    const registered = handlers()
    expect(registered.has(RPC_CHANNELS.builtinDpMcp.LIST)).toBe(true)
    expect(registered.has(RPC_CHANNELS.builtinDpMcp.SET_ENABLED)).toBe(true)
  })

  it('serves every built-in with its name, description and effective switch', async () => {
    const view = await handlers().get(RPC_CHANNELS.builtinDpMcp.LIST)!(ctx) as SettingsView
    expect(view.servers).toHaveLength(BUILTIN_DP_MCP_SERVERS.length)
    expect(view.servers.map(row => row.name)).toEqual(BUILTIN_DP_MCP_SERVERS.map(d => d.name))
    // A settings row needs the two things a user reads before flipping it.
    for (const row of view.servers) {
      expect(row.description.length).toBeGreaterThan(0)
      expect(row.subcommand.length).toBeGreaterThan(0)
    }
    // Owner decision 2026-08-01: the whole set ships OFF.
    expect(view.servers.every(row => row.defaultEnabled === false)).toBe(true)
    expect(view.servers.every(row => row.enabled === false)).toBe(true)
  })

  /**
   * THE GATE. This is the arm the mutation kills: drop the write path so the
   * toggle is cosmetic and only this and its neighbour below go red.
   */
  it('persists a toggle, and the read reads back exactly what was written', async () => {
    const registered = handlers()
    await registered.get(RPC_CHANNELS.builtinDpMcp.SET_ENABLED)!(ctx, 'dpJira', true)

    expect(getBuiltinDpMcpServerPreferences()).toEqual({ dpJira: true })

    const view = await registered.get(RPC_CHANNELS.builtinDpMcp.LIST)!(ctx) as SettingsView
    expect(view.servers.find(row => row.name === 'dpJira')!.enabled).toBe(true)

    // And switching it back off is a stored `false`, not a deletion.
    await registered.get(RPC_CHANNELS.builtinDpMcp.SET_ENABLED)!(ctx, 'dpJira', false)
    expect(getBuiltinDpMcpServerPreferences()).toEqual({ dpJira: false })
  })

  /**
   * The Settings toggle used to write config and never invalidate a warm
   * pool, so a session already holding a browse/session pool never learned a
   * built-in it enabled had joined the desired set. SET_ENABLED must tell
   * every workspace's pool to re-materialize.
   */
  it('invalidates every warm workspace MCP pool after a successful toggle', async () => {
    let invalidateCalls = 0
    const registered = handlers({ invalidateWorkspaceMcpPools: () => { invalidateCalls += 1 } })
    await registered.get(RPC_CHANNELS.builtinDpMcp.SET_ENABLED)!(ctx, 'dpJira', true)
    expect(invalidateCalls).toBe(1)
  })

  /**
   * F1.1251 (origin: the final sitting SIT2-a, TRIAGE D-1, an F1.851 residue) — an OPEN dpGitlab page kept its 11
   * tools after the switch went off: the page's tools hook peeks once, and nothing told it the source changed.
   * Measured by reading the code at HEAD (the row asked to confirm it first): the built-in switch wrote config.json
   * and invalidated the pools, and no `capabilities.CHANGED` followed on that path (the emitters are the source,
   * OAuth, plugin and skill paths and the pool's verdict change). The switch is app-wide, so the change is told to
   * every workspace, AFTER the write and the pool invalidation, so a re-read sees the new state.
   */
  it('F1.1251: a toggle tells every workspace its capabilities changed, after the write and the invalidation', async () => {
    const order: string[] = []
    const pushed: Array<{ channel: string; target: unknown; event: unknown }> = []
    const registered = handlers({
      invalidateWorkspaceMcpPools: () => { order.push('invalidate') },
      push: (channel, target, ...args) => { order.push('push'); pushed.push({ channel, target, event: args[0] }) },
      workspaces: [{ id: 'ws-a' }, { id: 'ws-b' }],
    })
    await registered.get(RPC_CHANNELS.builtinDpMcp.SET_ENABLED)!(ctx, 'dpJira', true)
    expect(pushed.map(entry => [entry.channel, entry.target])).toEqual([
      [RPC_CHANNELS.capabilities.CHANGED, { to: 'workspace', workspaceId: 'ws-a' }],
      [RPC_CHANNELS.capabilities.CHANGED, { to: 'workspace', workspaceId: 'ws-b' }],
    ])
    expect(pushed[0]!.event).toMatchObject({ workspaceId: 'ws-a', reasonCode: 'builtin-dp-mcp-changed' })
    expect(order).toEqual(['invalidate', 'push', 'push'])
  })

  it('F1.1251 CONTROL: a refused toggle tells nobody', async () => {
    const pushed: string[] = []
    const registered = handlers({ push: channel => { pushed.push(channel) }, workspaces: [{ id: 'ws-a' }] })
    await expect(registered.get(RPC_CHANNELS.builtinDpMcp.SET_ENABLED)!(ctx, 'notABuiltin', true)).rejects.toThrow()
    expect(pushed).toEqual([])
  })

  /**
   * The forward-compatibility rule, from the WRITE side. A server the user
   * never touched must stay ABSENT from the stored map — writing the whole set
   * on every toggle would freeze today's defaults into every user's config and
   * hide every built-in a later release adds.
   */
  it('writes only the named server, leaving untouched ones on their own default', async () => {
    const registered = handlers()
    await registered.get(RPC_CHANNELS.builtinDpMcp.SET_ENABLED)!(ctx, 'dpMail', true)

    expect(Object.keys(storedMap())).toEqual(['dpMail'])

    const view = await registered.get(RPC_CHANNELS.builtinDpMcp.LIST)!(ctx) as SettingsView
    const untouched = view.servers.find(row => row.name === 'dpSage')!
    expect(untouched.enabled).toBe(false)
    expect(untouched.defaultEnabled).toBe(false)
  })

  /**
   * The same rule from the READ side, and the reason the write refuses a name
   * the read accepts: a map written by a NEWER release must survive a
   * downgrade intact and must not conjure a row or a subprocess.
   */
  it('ignores a stored name no definition claims, and does not drop it on the next write', async () => {
    const config = loadStoredConfig()!
    config.builtinDpMcpServers = { enabled: { dpFromTheFuture: true, dpJira: true } }
    saveConfig(config)

    const registered = handlers()
    const view = await registered.get(RPC_CHANNELS.builtinDpMcp.LIST)!(ctx) as SettingsView
    expect(view.servers).toHaveLength(BUILTIN_DP_MCP_SERVERS.length)
    expect(view.servers.some(row => row.name === 'dpFromTheFuture')).toBe(false)
    expect(view.servers.find(row => row.name === 'dpJira')!.enabled).toBe(true)

    await registered.get(RPC_CHANNELS.builtinDpMcp.SET_ENABLED)!(ctx, 'dpSage', true)
    expect(storedMap()).toEqual({ dpFromTheFuture: true, dpJira: true, dpSage: true })
  })

  it('refuses a wire name no definition claims, and writes nothing', async () => {
    const setEnabled = handlers().get(RPC_CHANNELS.builtinDpMcp.SET_ENABLED)!
    await expect(setEnabled(ctx, 'dpNotAThing', true)).rejects.toThrow('Unknown built-in dp MCP server')
    await expect(setEnabled(ctx, '', true)).rejects.toThrow('non-empty string')
    expect(getBuiltinDpMcpServerPreferences()).toEqual({})
  })

  it('refuses a non-boolean switch', async () => {
    const setEnabled = handlers().get(RPC_CHANNELS.builtinDpMcp.SET_ENABLED)!
    await expect(setEnabled(ctx, 'dpJira', 'yes')).rejects.toThrow('must be a boolean')
    expect(getBuiltinDpMcpServerPreferences()).toEqual({})
  })
})

describe('the surface explains itself when dp is missing', () => {
  /**
   * The absence arm. `resolveDpPath` is injected, so this runs identically on a
   * machine that has dp and on one that does not.
   */
  it('reports unavailable with a diagnostic naming dp, and still lists every server', () => {
    const view = readBuiltinDpMcpSettingsView({ resolveDpPath: () => null })
    expect(view.available).toBe(false)
    expect(view.diagnostics).toHaveLength(1)
    expect(view.diagnostics[0]!.code).toBe('builtin_dp_mcp.dp_not_found')
    expect(view.diagnostics[0]!.message).toContain('dp')
    // The rows survive: a user must still be able to choose what will run once
    // dp is installed, and must see what the list even is.
    expect(view.servers).toHaveLength(BUILTIN_DP_MCP_SERVERS.length)
    // No credential, token or header ever reaches this payload.
    expect(JSON.stringify(view)).not.toContain('dp_auth_creds')
  })

  /**
   * POSITIVE CONTROL for the arm above: on the same rig, with dp "installed",
   * the surface reports available and says nothing. Without this, "unavailable"
   * could be the only answer the builder can produce.
   */
  it('reports available with no diagnostics when dp resolves', () => {
    const view = readBuiltinDpMcpSettingsView({ resolveDpPath: () => '/usr/local/bin/dp' })
    expect(view.available).toBe(true)
    expect(view.diagnostics).toEqual([])
    expect(view.servers).toHaveLength(BUILTIN_DP_MCP_SERVERS.length)
  })
})

/**
 * F1.851 — measured on RC `69a6d33da` (SIT-w): switch `dpGitlab` on, list its
 * tools (`ok`), switch it off, list again — still `ok` with the tools, while a
 * never-enabled `dpJira` answered `refused / disabled` the same minute.
 *
 * The session manager was never asked the second time: `capabilities.ts`'s
 * `createMcpToolsLister` serves an `ok` from its 5-minute cache, and nothing
 * the switch did reached that cache. These arms drive the REAL chain — the
 * SET_ENABLED handler, the real `SessionManager.listMcpToolsForCapability` and
 * its browse-pool registry, the real LIST_MCP_TOOLS handler and its cache —
 * with only the resolver and the pool faked. The resolver reads the row's
 * enabled state from the stored switch, which is what
 * `builtinDpMcpCapabilityRecords` does; the wire name is a fixture name so the
 * real built-in fold (which needs a `dp` on PATH) plays no part on any host.
 */
describe('F1.851 — a built-in switched OFF is not answered from the tools-list cache', () => {
  const KEY = 'builtin:mcp:dpGitlab'
  const wsCtx = { clientId: 'client-a', workspaceId: 'ws-a', webContentsId: null }

  function rig(options: { enabled?: () => boolean } = {}) {
    let resolves = 0
    let busListener: ((event: unknown) => void) | undefined
    const isEnabled = options.enabled ?? (() => getBuiltinDpMcpServerPreferences().dpGitlab === true)
    const entry = (enabled: boolean): ResolvedCapabilityEntry => ({
      summary: { key: KEY, logicalName: 'dpGitlab', kind: 'mcp', enabled, trustState: 'trusted' },
      runtimeBinding: {
        kind: 'mcp',
        server: { key: KEY, wireName: 'gitlab-fixture', definition: { type: 'http', url: 'https://example.test/gitlab' } },
      },
    }) as unknown as ResolvedCapabilityEntry
    const resolver: CapabilityResolver = {
      resolve: async (context: CapabilityContext): Promise<EffectiveCapabilitySnapshot> => {
        resolves += 1
        return {
          context,
          generation: `g-${resolves}`,
          leaseId: `lease-${resolves}`,
          entries: [entry(isEnabled())],
          installedPlugins: [],
          diagnostics: [],
        }
      },
      releaseSnapshot: () => {},
      invalidate: () => {},
      isLeaseActive: () => true,
      referencedInstances: () => new Set(),
      leaseCount: () => 0,
    }
    const connected = new Map<string, Array<{ name: string }>>()
    const pool = {
      async sync(mcpServers: Record<string, unknown>) {
        for (const slug of Object.keys(mcpServers)) {
          if (!connected.has(slug)) connected.set(slug, [{ name: 'gitlab_whoami' }])
        }
        return []
      },
      isConnected: (slug: string) => connected.has(slug),
      health: () => ({ status: 'ready', connected: [...connected.keys()], failed: [] }),
      getTools: (slug: string) => connected.get(slug) ?? [],
      async disconnectAll() { connected.clear() },
      subscribeConnectionVerdictChanged: () => () => {},
      hasLeaser: (leaserId: string) => leaserId.length > 0,
      async dropLeaser() {},
      async notifyRootsChanged() {},
    }
    const sm = createTestSessionManager({
      resolver,
      createWorkspaceMcpPool: () => pool as unknown as McpClientPool,
      subscribeInvalidation: (listener) => {
        busListener = listener as (event: unknown) => void
        return () => {}
      },
    })
    const registered = new Map<string, HandlerFn>()
    const server = {
      handle(channel: string, handler: HandlerFn) { registered.set(channel, handler) },
      push() {},
      async invokeClient() { return undefined },
      hasClientCapability() { return false },
      findClientsWithCapability() { return [] },
    } as RpcServer
    const deps = {
      sessionManager: sm,
      platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      oauthFlowStore: {},
    } as unknown as HandlerDeps
    registerSettingsHandlers(server, deps)
    registerCapabilitiesHandlers(server, deps)
    return {
      sm,
      resolves: () => resolves,
      bus: (event: unknown) => busListener!(event),
      setEnabled: (enabled: boolean) => registered.get(RPC_CHANNELS.builtinDpMcp.SET_ENABLED)!(wsCtx, 'dpGitlab', enabled),
      listTools: () => registered.get(RPC_CHANNELS.capabilities.LIST_MCP_TOOLS)!(wsCtx, { workspaceId: 'ws-a' }, KEY),
    }
  }

  const OK = { status: 'ok', tools: [{ name: 'gitlab_whoami' }] }
  const DISABLED = { status: 'refused', reason: 'disabled' }

  it('switching the built-in off answers refused / disabled on the very next list', async () => {
    const r = rig()
    await r.setEnabled(true)
    expect(await r.listTools()).toEqual(OK)
    await r.setEnabled(false)
    expect(await r.listTools()).toEqual(DISABLED)
    await r.sm.cleanup()
  })

  it('with no inventory change between two lists, the second is still served from the cache', async () => {
    const r = rig()
    await r.setEnabled(true)
    expect(await r.listTools()).toEqual(OK)
    const resolvesAfterFirst = r.resolves()
    expect(await r.listTools()).toEqual(OK)
    // The cache hit never reached the session manager, so nothing resolved.
    expect(r.resolves()).toBe(resolvesAfterFirst)
    await r.sm.cleanup()
  })

  it('a capability-bus invalidation (any other MCP source switched off) expires the cached list too', async () => {
    let enabled = true
    const r = rig({ enabled: () => enabled })
    expect(await r.listTools()).toEqual(OK)
    enabled = false
    r.bus({ scope: { kind: 'workspace', workspaceId: 'ws-a' }, effect: 'refresh-before-next-turn', revokedLeaseIds: [], reason: 'test' })
    expect(await r.listTools()).toEqual(DISABLED)
    await r.sm.cleanup()
  })

  it('a source file change on disk expires the cached list too', async () => {
    let enabled = true
    const r = rig({ enabled: () => enabled })
    expect(await r.listTools()).toEqual(OK)
    enabled = false
    // The ConfigWatcher's `onSourcesListChange` / `onSourceChange` both land here.
    await (r.sm as unknown as { reloadSourcesForWorkspace(root: string): Promise<void> })
      .reloadSourcesForWorkspace('/no/such/workspace-root')
    expect(await r.listTools()).toEqual(DISABLED)
    await r.sm.cleanup()
  })
})

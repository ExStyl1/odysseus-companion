/**
 * SessionManager.listMcpToolsForCapability — U3b browse (no-session) path.
 *
 * Proves the workspace-level browse pool serves an MCP source's tools WITHOUT a
 * live session (invariant c), a DISABLED source refuses BEFORE any pool connect
 * (invariant d), a project-scoped MCP absent from the workspace-scope snapshot
 * is honestly `not-mcp` (invariant g), and the fail-soft refusals never throw.
 * The pool is a fake injected via `createWorkspaceMcpPool` so no real MCP
 * subprocess/connection is started; the resolver is a fake returning file-free
 * HTTP MCP entries so materialization does no disk I/O.
 */

import { describe, it, expect } from 'bun:test'
import type {
  CapabilityContext,
  CapabilityResolver,
  EffectiveCapabilitySnapshot,
  ResolvedCapabilityEntry,
} from '@nessy-agent/shared/capabilities/resolver'
import type { McpClientPool } from '@nessy-agent/shared/mcp'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

function httpMcpEntry(key: string, wireName: string, enabled: boolean): ResolvedCapabilityEntry {
  return {
    summary: { key, logicalName: wireName, kind: 'mcp', enabled, trustState: 'trusted' },
    runtimeBinding: {
      kind: 'mcp',
      server: { key, wireName, definition: { type: 'http', url: `https://example.test/${wireName}` } },
    },
  } as unknown as ResolvedCapabilityEntry
}

function fakeResolver(entriesByWorkspace: (ctx: CapabilityContext) => ResolvedCapabilityEntry[]): CapabilityResolver {
  const active = new Set<string>()
  let seq = 0
  return {
    resolve: async (context: CapabilityContext): Promise<EffectiveCapabilitySnapshot> => {
      seq += 1
      const leaseId = `lease-${seq}`
      active.add(leaseId)
      return {
        context,
        generation: `g-${seq}`,
        leaseId,
        entries: entriesByWorkspace(context),
        installedPlugins: [],
        diagnostics: [],
      }
    },
    releaseSnapshot: (leaseId: string) => { active.delete(leaseId) },
    invalidate: () => {},
    isLeaseActive: (leaseId: string) => active.has(leaseId),
    referencedInstances: () => new Set(),
    leaseCount: () => active.size,
  }
}

function fakePoolFactory() {
  const syncCalls: Array<Record<string, unknown>> = []
  const connected = new Map<string, Array<{ name: string; description?: string }>>()
  const pool = {
    async sync(mcpServers: Record<string, unknown>) {
      syncCalls.push(mcpServers)
      for (const slug of Object.keys(mcpServers)) {
        if (!connected.has(slug)) connected.set(slug, [{ name: `${slug}-search`, description: 'Search' }])
      }
      return []
    },
    isConnected: (slug: string) => connected.has(slug),
    health: () => ({
      status: connected.size === 0 ? 'unavailable' : 'ready',
      connected: [...connected.keys()],
      failed: [],
    }),
    getTools: (slug: string) => connected.get(slug) ?? [],
    async disconnectAll() { connected.clear() },
    // Not decoration: `WorkspaceMcpPoolRegistry` subscribes AT POOL CREATION
    // (`627c7af05`, P3.246 — a verdict can move on a path that never
    // reconciles), so a duck without this throws before `sync` is ever reached
    // and all four cases below read `{ status: 'refused', reason: 'error' }`
    // from the registry's fail-soft catch. Same shape as the
    // `claude-live-settings.test.ts` entry in the known-failing register: the
    // `as unknown as McpClientPool` cast is what let the real interface grow
    // two methods past this stub without a compile error.
    subscribeConnectionVerdictChanged: () => () => {},
    hasLeaser: (leaserId: string) => leaserId.length > 0,
    async dropLeaser() {},
    async notifyRootsChanged() {},
  }
  return { create: () => pool as unknown as McpClientPool, syncCalls }
}

describe('listMcpToolsForCapability — U3b browse pool', () => {
  it('(c) serves tools for an enabled workspace-scope MCP WITHOUT a session', async () => {
    const factory = fakePoolFactory()
    const sm = createTestSessionManager({
      resolver: fakeResolver(() => [httpMcpEntry('src:ws-1:gh', 'gh', true)]),
      createWorkspaceMcpPool: factory.create,
    })
    const result = await sm.listMcpToolsForCapability({ workspaceId: 'ws-1' }, 'src:ws-1:gh')
    expect(result).toEqual({ status: 'ok', tools: [{ name: 'gh-search', description: 'Search' }] })
    expect(factory.syncCalls.length).toBe(1) // lazily connected exactly once
    sm.cleanup()
  })

  it('(d) a DISABLED source refuses without any pool connect', async () => {
    const factory = fakePoolFactory()
    const sm = createTestSessionManager({
      resolver: fakeResolver(() => [httpMcpEntry('src:ws-1:gh', 'gh', false)]),
      createWorkspaceMcpPool: factory.create,
    })
    const result = await sm.listMcpToolsForCapability({ workspaceId: 'ws-1' }, 'src:ws-1:gh')
    expect(result).toEqual({ status: 'refused', reason: 'disabled' })
    expect(factory.syncCalls.length).toBe(0) // NEVER warmed the pool for a disabled source
    sm.cleanup()
  })

  it('(g) a capability absent from the workspace-scope snapshot is honestly not-mcp', async () => {
    const factory = fakePoolFactory()
    const sm = createTestSessionManager({
      // Workspace-scope resolve has no project-scoped entries.
      resolver: fakeResolver(() => []),
      createWorkspaceMcpPool: factory.create,
    })
    const result = await sm.listMcpToolsForCapability({ workspaceId: 'ws-1' }, 'src:project:only')
    expect(result).toEqual({ status: 'refused', reason: 'not-mcp' })
    expect(factory.syncCalls.length).toBe(0)
    sm.cleanup()
  })

  it('reuses the SAME warm pool across repeat browse reads (keep-alive)', async () => {
    const factory = fakePoolFactory()
    const sm = createTestSessionManager({
      resolver: fakeResolver(() => [httpMcpEntry('src:ws-1:gh', 'gh', true)]),
      createWorkspaceMcpPool: factory.create,
    })
    await sm.listMcpToolsForCapability({ workspaceId: 'ws-1' }, 'src:ws-1:gh')
    const second = await sm.listMcpToolsForCapability({ workspaceId: 'ws-1' }, 'src:ws-1:gh')
    expect(second).toEqual({ status: 'ok', tools: [{ name: 'gh-search', description: 'Search' }] })
    expect(factory.syncCalls.length).toBe(1) // warm: not re-synced on the second read
    sm.cleanup()
  })

  it('(peek) a cold-pool peek reads WITHOUT connecting → disconnected, never syncs', async () => {
    const factory = fakePoolFactory()
    const sm = createTestSessionManager({
      resolver: fakeResolver(() => [httpMcpEntry('src:ws-1:gh', 'gh', true)]),
      createWorkspaceMcpPool: factory.create,
    })
    // Opening a detail page is not connect-intent: the peek must NOT warm a cold
    // pool. An enabled-but-disconnected source is honestly 'disconnected'.
    const result = await sm.listMcpToolsForCapability({ workspaceId: 'ws-1' }, 'src:ws-1:gh', true)
    expect(result).toEqual({ status: 'refused', reason: 'disconnected' })
    expect(factory.syncCalls.length).toBe(0) // peek NEVER connects a cold pool
    sm.cleanup()
  })

  it('(peek) a warm-pool peek returns the tools WITHOUT an extra connect', async () => {
    const factory = fakePoolFactory()
    const sm = createTestSessionManager({
      resolver: fakeResolver(() => [httpMcpEntry('src:ws-1:gh', 'gh', true)]),
      createWorkspaceMcpPool: factory.create,
    })
    // Warm the pool via the full (connecting) read the "Load tools" click makes.
    await sm.listMcpToolsForCapability({ workspaceId: 'ws-1' }, 'src:ws-1:gh')
    expect(factory.syncCalls.length).toBe(1)
    // A later detail open peeks the now-warm cache and shows tools with no click
    // and no second connect.
    const peeked = await sm.listMcpToolsForCapability({ workspaceId: 'ws-1' }, 'src:ws-1:gh', true)
    expect(peeked).toEqual({ status: 'ok', tools: [{ name: 'gh-search', description: 'Search' }] })
    expect(factory.syncCalls.length).toBe(1) // peek did NOT re-sync/connect
    sm.cleanup()
  })

  it('(peek) a DISABLED source still refuses BEFORE any pool touch', async () => {
    const factory = fakePoolFactory()
    const sm = createTestSessionManager({
      resolver: fakeResolver(() => [httpMcpEntry('src:ws-1:gh', 'gh', false)]),
      createWorkspaceMcpPool: factory.create,
    })
    const result = await sm.listMcpToolsForCapability({ workspaceId: 'ws-1' }, 'src:ws-1:gh', true)
    expect(result).toEqual({ status: 'refused', reason: 'disabled' })
    expect(factory.syncCalls.length).toBe(0)
    sm.cleanup()
  })

  it('(b) OAuth completion (refresh-before-next-turn) resyncs the warm workspace pool', async () => {
    const factory = fakePoolFactory()
    let listener: ((e: {
      scope: { kind: string; workspaceId?: string }
      effect: 'refresh-before-next-turn' | 'revoke-active-snapshot'
      revokedLeaseIds: string[]
    }) => void) | undefined
    const sm = createTestSessionManager({
      resolver: fakeResolver(() => [httpMcpEntry('src:ws-1:gh', 'gh', true)]),
      createWorkspaceMcpPool: factory.create,
      subscribeInvalidation: (l) => { listener = l as typeof listener; return () => {} },
    })
    // Warm the browse pool.
    await sm.listMcpToolsForCapability({ workspaceId: 'ws-1' }, 'src:ws-1:gh')
    expect(factory.syncCalls.length).toBe(1)
    // OAuth completion emits a workspace-scope refresh — credentials are written
    // server-only (never via a watched source file), so this bus is the ONLY
    // signal that reaches the browse pool. It MUST resync the warm pool.
    expect(listener).toBeDefined()
    listener!({ scope: { kind: 'workspace', workspaceId: 'ws-1' }, effect: 'refresh-before-next-turn', revokedLeaseIds: [] })
    await new Promise(resolve => setTimeout(resolve, 300)) // past the 250ms debounce
    expect(factory.syncCalls.length).toBe(2)
    sm.cleanup()
  })
})

// F1.1252 (origin: the final sitting SIT2-a, TRIAGE D-2, an F1.851 residue) — a chat with no MCP pool (a
// restricted-project chat) answered 'no-session' before asking whether the source is active, so a switched-off
// source's page showed the "open a trusted project" copy instead of saying it is switched off.
describe('listMcpToolsForCapability — a chat with no MCP pool', () => {
  function chatWithoutPool(enabled: boolean) {
    const factory = fakePoolFactory()
    const sm = createTestSessionManager({
      resolver: fakeResolver(() => [httpMcpEntry('src:ws-1:codeSearch', 'codeSearch', enabled)]),
      createWorkspaceMcpPool: factory.create,
    })
    const workspace = { id: 'ws-1', name: 'WS', slug: 'ws', rootPath: '/tmp/ws-1', createdAt: Date.now() }
    const managed = createManagedSession({ id: 'chat-restricted' }, workspace, { messagesLoaded: true })
    expect(managed.mcpPool).toBeFalsy() // the premise: this chat has no pool
    ;(sm as any).sessions.set(encodeSessionKey({ workspaceId: 'ws-1', sessionId: managed.id }), managed)
    ;(sm as any).buildSlashCommandCapabilityContext = async () => ({ workspaceId: 'ws-1', projectTrustState: 'untrusted', projectTrustRevision: '' })
    return { sm, factory }
  }

  it('F1.1252: a switched-off source says disabled, not no-session, and touches no pool', async () => {
    const { sm, factory } = chatWithoutPool(false)
    const result = await sm.listMcpToolsForCapability({ workspaceId: 'ws-1', sessionId: 'chat-restricted' }, 'src:ws-1:codeSearch', true)
    expect(result).toEqual({ status: 'refused', reason: 'disabled' })
    expect(factory.syncCalls.length).toBe(0)
    ;(sm as any).sessions.clear()
    sm.cleanup()
  })

  it('F1.1252 CONTROL: an active source in the same chat still answers no-session', async () => {
    const { sm, factory } = chatWithoutPool(true)
    const result = await sm.listMcpToolsForCapability({ workspaceId: 'ws-1', sessionId: 'chat-restricted' }, 'src:ws-1:codeSearch', true)
    expect(result).toEqual({ status: 'refused', reason: 'no-session' })
    expect(factory.syncCalls.length).toBe(0)
    ;(sm as any).sessions.clear()
    sm.cleanup()
  })
})

/**
 * WorkspaceMcpPoolRegistry (U3b) — lifecycle + gating unit tests.
 *
 * Drives the registry with a FAKE McpClientPool (records sync/disconnect) and a
 * controllable fake CapabilityResolver whose snapshots carry file-free HTTP MCP
 * entries, so `materializeRuntimePoolServers` produces a desired set with NO
 * disk I/O. Proves: lazy connect exactly once (e), keep-alive skips the second
 * need (e), a warm pool resyncs on invalidate (f) while a cold pool stays cold,
 * plugin-uninstall shrinks the synced set so the diff disconnects (a),
 * project-scope resolves only with a trusted project handle (g), and dispose
 * tears everything down.
 */

import { describe, it, expect } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type {
  CapabilityContext,
  CapabilityResolver,
  EffectiveCapabilitySnapshot,
  ResolvedCapabilityEntry,
} from '@nessy-agent/shared/capabilities/resolver'
import { computeNormalizedBundleHash } from '@nessy-agent/shared/plugins'
import type { McpClientPool } from '@nessy-agent/shared/mcp'
import type { CapabilityTurnRuntime } from '@nessy-agent/shared/agent/backend'
import type { ProcessSupervisorPort } from '@nessy-agent/shared/agent/pi-harness/process-supervisor-port'
import { DpAuthError, type DpSessionBroker, type DpSessionState } from '@nessy-agent/shared/auth/dp'
import { CapabilityMaterializationError } from '@nessy-agent/shared/capabilities/materializer'
import { loadStoredConfig, saveConfig, setBuiltinDpMcpServerEnabled } from '@nessy-agent/shared/config'
import { WorkspaceMcpPoolRegistry } from '../workspace-mcp-pool-registry'

// --- Fakes -----------------------------------------------------------------

interface SyncCall {
  mcpServers: Record<string, unknown>
  apiServers: Record<string, unknown>
  leaserId?: string
}

function makeFakePool() {
  const syncCalls: SyncCall[] = []
  const droppedLeasers: string[] = []
  const syncedLeasers = new Set<string>()
  let disconnectedAll = 0
  const connected = new Map<string, Array<{ name: string; description?: string }>>()
  const failed = new Set<string>()
  const pool = {
    async sync(
      mcpServers: Record<string, unknown>,
      apiServers: Record<string, unknown> = {},
      options: { leaserId?: string } = {},
    ) {
      syncCalls.push({ mcpServers, apiServers, ...(options.leaserId ? { leaserId: options.leaserId } : {}) })
      if (options.leaserId) syncedLeasers.add(options.leaserId)
      // Mimic the real diff: connect the desired set, drop the rest.
      const desired = new Set(Object.keys(mcpServers))
      for (const slug of [...connected.keys()]) {
        if (!desired.has(slug)) connected.delete(slug)
      }
      for (const slug of desired) {
        if (!connected.has(slug)) connected.set(slug, [{ name: `${slug}-tool` }])
        failed.delete(slug)
      }
      return []
    },
    // P2b release primitive: records the dropped leaser. The pool is NOT
    // disconnected — a dropped leaser only reconciles the union.
    async dropLeaser(leaserId: string) {
      droppedLeasers.push(leaserId)
      syncedLeasers.delete(leaserId)
      return []
    },
    hasLeaser: (leaserId: string) => syncedLeasers.has(leaserId),
    isConnected: (slug: string) => connected.has(slug),
    health: () => ({
      status: connected.size === 0 ? 'unavailable' : failed.size === 0 ? 'ready' : 'degraded',
      connected: [...connected.keys()],
      failed: [...failed],
    }),
    getTools: (slug: string) => connected.get(slug) ?? [],
    async disconnectAll() { disconnectedAll++; connected.clear(); syncedLeasers.clear() },
  }
  return {
    pool: pool as unknown as McpClientPool,
    syncCalls,
    droppedLeasers,
    get disconnectedAll() { return disconnectedAll },
    connected,
    markFailed(slug: string) { connected.delete(slug); failed.add(slug) },
  }
}

/** File-free HTTP MCP entry: materializes to `{wireName:{type:'http',url}}`. */
function httpMcpEntry(key: string, wireName: string, enabled = true): ResolvedCapabilityEntry {
  return {
    summary: {
      key,
      logicalName: wireName,
      kind: 'mcp',
      enabled,
      trustState: 'trusted',
    },
    runtimeBinding: {
      kind: 'mcp',
      server: {
        key,
        wireName,
        definition: { type: 'http', url: `https://example.test/${wireName}` },
      },
    },
  } as unknown as ResolvedCapabilityEntry
}

/**
 * Fake resolver whose current entry set is swappable between resolves (to model
 * a config change). Records every context it was asked to resolve.
 */
function makeFakeResolver(
  initial: ResolvedCapabilityEntry[] = [],
  installedPlugins: EffectiveCapabilitySnapshot['installedPlugins'] = [],
) {
  let entries = initial
  const contexts: CapabilityContext[] = []
  const active = new Set<string>()
  let seq = 0
  /** Every lease, including ones resolved later, reads as revoked. */
  let allRevoked = false
  const resolver = {
    resolve: async (context: CapabilityContext): Promise<EffectiveCapabilitySnapshot> => {
      contexts.push(context)
      seq += 1
      const leaseId = `lease-${seq}`
      active.add(leaseId)
      return {
        context,
        generation: `g-${seq}`,
        leaseId,
        entries,
        installedPlugins,
        diagnostics: [],
      }
    },
    releaseSnapshot: (leaseId: string) => { active.delete(leaseId) },
    invalidate: () => {},
    isLeaseActive: (leaseId: string) => !allRevoked && active.has(leaseId),
    referencedInstances: () => new Set(),
    leaseCount: () => active.size,
  }
  return {
    resolver: resolver as unknown as CapabilityResolver,
    contexts,
    setEntries: (next: ResolvedCapabilityEntry[]) => { entries = next },
    revokeEveryLease: () => { allRevoked = true },
    leaseCount: () => active.size,
  }
}

function makeRegistry(
  fakeResolver: ReturnType<typeof makeFakeResolver>,
  fakePool: ReturnType<typeof makeFakePool>,
  opts: {
    resyncDebounceMs?: number
    dpSessionBroker?: Pick<DpSessionBroker, 'probe' | 'subscribe'>
    pluginNodeRuntime?: ConstructorParameters<typeof WorkspaceMcpPoolRegistry>[0]['pluginNodeRuntime']
  } = {},
) {
  const dpSessionBroker = opts.dpSessionBroker ?? makeFakeDpBroker({
    state: 'needs-login',
    version: '13.0.0',
    outdated: false,
  }).broker
  return new WorkspaceMcpPoolRegistry({
    resolver: fakeResolver.resolver,
    resolveCredential: () => ({ ready: false, revision: 0 }),
    resolveWorkspaceRootPath: () => undefined,
    createPool: () => fakePool.pool,
    resyncDebounceMs: opts.resyncDebounceMs ?? 0,
    dpSessionBroker,
    ...(opts.pluginNodeRuntime ? { pluginNodeRuntime: opts.pluginNodeRuntime } : {}),
  })
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

/**
 * Wait for an async effect to land instead of assuming a wall-clock budget for
 * it. A fixed sleep here was green alone and red inside a full `bun test` run,
 * where a loaded machine has not finished the resync 30 ms later — the
 * assertion was about WHAT syncs, never about how fast, so the wait polls and
 * the assertion stays exactly as strict.
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function makeFakeDpBroker(initial: DpSessionState) {
  let state = initial
  const listeners = new Set<(next: DpSessionState) => void>()
  return {
    broker: {
      probe: async () => state,
      subscribe(listener: (next: DpSessionState) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    setState(next: DpSessionState) {
      state = next
      for (const listener of listeners) listener(next)
    },
    get listenerCount() { return listeners.size },
  }
}

function makeDeferredDpBroker(initial: DpSessionState) {
  let state = initial
  let firstProbe = true
  let resolveFirstProbe!: (next: DpSessionState) => void
  let markProbeStarted!: () => void
  const firstProbeResult = new Promise<DpSessionState>(resolve => { resolveFirstProbe = resolve })
  const probeStarted = new Promise<void>(resolve => { markProbeStarted = resolve })
  const listeners = new Set<(next: DpSessionState) => void>()
  return {
    broker: {
      probe: async () => {
        if (!firstProbe) return state
        firstProbe = false
        markProbeStarted()
        return firstProbeResult
      },
      subscribe(listener: (next: DpSessionState) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    probeStarted,
    resolveFirstProbe,
    setState(next: DpSessionState) {
      state = next
      for (const listener of listeners) listener(next)
    },
    get listenerCount() { return listeners.size },
  }
}

function runtimeWithDp(): CapabilityTurnRuntime {
  return {
    view: {
      generation: 'g',
      sources: [],
      skills: [],
      mcpServers: [{
        key: 'plugin#dpGitlab',
        wireName: 'dpGitlab',
        definition: { type: 'stdio', command: 'dp', args: ['ai', 'mcp', 'gitlab'] },
        pluginRuntime: {
          rootPath: '/cache/plugin',
          dataPath: '/data/plugin',
          bundleHash: 'a'.repeat(64),
          profile: 'generic-plugin-env-v1',
        },
        pluginInstanceId: 'plugin://default',
      }],
      hooks: [],
      automations: [],
      agents: [],
      promptLayers: [],
      memory: [],
      permissionLayers: [],
      commands: [],
      promptCommands: [],
      apps: [],
      lspServers: [],
    },
    materializer: {
      assertActive: () => {},
      verifyPlugin: async () => {},
      resolvePath: async () => '/abs/path',
      readText: async () => '{}',
      resolveCredential: () => { throw new CapabilityMaterializationError('credential-not-ready') },
    },
  } as unknown as CapabilityTurnRuntime
}

/** No plugin-bound mcp servers — used to isolate the BUILT-IN dp fold, which
 * the registry injects itself and which requires no pinned document/resource. */
function runtimeWithoutMcp(): CapabilityTurnRuntime {
  const dpRuntime = runtimeWithDp()
  return { ...dpRuntime, view: { ...dpRuntime.view, mcpServers: [] } } as unknown as CapabilityTurnRuntime
}

async function makeDpCapabilityFixture() {
  const bundleRoot = mkdtempSync(join(tmpdir(), 'workspace-mcp-dp-'))
  const executable = join(bundleRoot, 'server.js')
  writeFileSync(executable, 'process.exit(0)')
  if (process.platform !== 'win32') chmodSync(executable, 0o755)
  const bundleHash = await computeNormalizedBundleHash(bundleRoot)
  const pluginInstanceId = `plugin://local/default@1.0.0#${bundleHash}`
  const dpEntry = {
    summary: {
      key: 'plugin#dpGitlab',
      logicalName: 'dpGitlab',
      kind: 'mcp',
      enabled: true,
      trustState: 'trusted',
    },
    runtimeBinding: {
      kind: 'mcp',
      server: {
        key: 'plugin#dpGitlab',
        wireName: 'dpGitlab',
        definition: { type: 'stdio', command: 'dp', args: ['ai', 'mcp', 'gitlab'] },
        pluginRuntime: {
          rootPath: bundleRoot,
          dataPath: join(bundleRoot, 'data'),
          bundleHash,
          profile: 'generic-plugin-env-v1',
        },
        pluginInstanceId,
      },
    },
  } as unknown as ResolvedCapabilityEntry
  const installedPlugin = {
    pluginKey: 'local/default',
    activeInstanceId: pluginInstanceId,
    origin: { marketplaceId: 'local', pluginId: 'default' },
    name: 'Default',
    version: '1.0.0',
    installedAt: 1,
    lifecycleState: 'ready',
    capabilityKinds: ['mcp'],
    bundleHash,
    bundleRootPath: bundleRoot,
  } as EffectiveCapabilitySnapshot['installedPlugins'][number]
  return {
    bundleRoot,
    dpEntry,
    installedPlugin,
    pluginNodeRuntime: {
      command: process.execPath,
      executables: {
        dp: {
          command: process.execPath,
          environment: { DP_AI_MCP_SKIP_LOGIN: 'true' },
          externalAuthProvider: 'dp' as const,
        },
      },
    },
  }
}

// --- Tests -----------------------------------------------------------------

describe('WorkspaceMcpPoolRegistry', () => {
  it('is cold at construction — no resolve, no pool, no connect (start policy)', () => {
    const r = makeFakeResolver([httpMcpEntry('k', 'srv')])
    const p = makeFakePool()
    makeRegistry(r, p)
    expect(r.contexts.length).toBe(0)
    expect(p.syncCalls.length).toBe(0)
  })

  it('threads the process supervisor into the default pool for plugin stdio MCPs', () => {
    const r = makeFakeResolver([])
    const processSupervisor = {} as ProcessSupervisorPort
    const reg = new WorkspaceMcpPoolRegistry({
      resolver: r.resolver,
      resolveCredential: () => ({ ready: false, revision: 0 }),
      resolveWorkspaceRootPath: () => '/workspace',
      dpSessionBroker: makeFakeDpBroker({
        state: 'needs-login',
        version: '13.0.0',
        outdated: false,
      }).broker,
      processSupervisor,
    })

    const lease = reg.lease({ workspaceId: 'ws-1' })
    const authority = (lease.pool as unknown as {
      pluginProcessAuthority?: { processSupervisor: ProcessSupervisorPort; sessionKey: { workspaceId: string; sessionId: string } }
    }).pluginProcessAuthority

    expect(authority?.processSupervisor).toBe(processSupervisor)
    expect(authority?.sessionKey.workspaceId).toBe('ws-1')
    expect(authority?.sessionKey.sessionId).toMatch(/^mcp-pool:/)
  })

  it('(e) lazy connects exactly once on first need; keep-alive skips the second', async () => {
    const r = makeFakeResolver([httpMcpEntry('k', 'srv')])
    const p = makeFakePool()
    const reg = makeRegistry(r, p)
    const lease = reg.lease({ workspaceId: 'ws-1' })
    await lease.ensureSynced({ workspaceId: 'ws-1' })
    await lease.ensureSynced({ workspaceId: 'ws-1' })
    expect(p.syncCalls.length).toBe(1)
    expect(r.contexts.length).toBe(1)
    expect(p.connected.has('srv')).toBe(true)
    // Every resolve lease was released (no leak).
    expect(r.leaseCount()).toBe(0)
  })

  it('keeps provider-neutral browse resolution unfiltered', async () => {
    const r = makeFakeResolver(['allowed', 'denied']
      .map(serverName => httpMcpEntry(`native:${serverName}`, serverName)))
    const p = makeFakePool()
    const reg = makeRegistry(r, p)

    await reg.lease({ workspaceId: 'ws-1' }).ensureSynced({ workspaceId: 'ws-1' })

    expect(Object.keys(p.syncCalls[0]!.mcpServers)).toEqual(['allowed', 'denied'])
    expect(r.contexts[0]).not.toHaveProperty('provider')
  })

  it('(f) invalidateWorkspace resyncs a WARM pool (debounced)', async () => {
    const r = makeFakeResolver([httpMcpEntry('k', 'srv')])
    const p = makeFakePool()
    const reg = makeRegistry(r, p)
    const lease = reg.lease({ workspaceId: 'ws-1' })
    await lease.ensureSynced({ workspaceId: 'ws-1' })
    expect(p.syncCalls.length).toBe(1)
    reg.invalidateWorkspace('ws-1')
    await tick()
    expect(p.syncCalls.length).toBe(2)
  })

  it('retries a warm browse identity after its transport exits unexpectedly', async () => {
    const r = makeFakeResolver([httpMcpEntry('k', 'srv')])
    const p = makeFakePool()
    const reg = makeRegistry(r, p)
    const lease = reg.lease({ workspaceId: 'ws-1' })
    await lease.ensureSynced({ workspaceId: 'ws-1' })
    p.markFailed('srv')

    await lease.ensureSynced({ workspaceId: 'ws-1' })

    expect(p.syncCalls.length).toBe(2)
    expect(p.connected.has('srv')).toBe(true)
  })

  it('reruns a warm-pool sync when invalidated while its resolver is blocked', async () => {
    const r = makeFakeResolver([httpMcpEntry('k', 'srv')])
    const p = makeFakePool()
    let blockNextResolve = false
    let unblockResolve!: () => void
    let blockedResolveStarted!: () => void
    const resolveGate = new Promise<void>(resolve => { unblockResolve = resolve })
    const blocked = new Promise<void>(resolve => { blockedResolveStarted = resolve })
    let resolveCalls = 0
    const resolver = {
      ...r.resolver,
      resolve: async (context: CapabilityContext) => {
        resolveCalls += 1
        if (blockNextResolve) {
          blockNextResolve = false
          blockedResolveStarted()
          await resolveGate
        }
        return r.resolver.resolve(context)
      },
    } as unknown as CapabilityResolver
    const reg = new WorkspaceMcpPoolRegistry({
      resolver,
      resolveCredential: () => ({ ready: false, revision: 0 }),
      resolveWorkspaceRootPath: () => undefined,
      dpSessionBroker: makeFakeDpBroker({
        state: 'needs-login',
        version: '13.0.0',
        outdated: false,
      }).broker,
      createPool: () => p.pool,
      resyncDebounceMs: 0,
    })
    const lease = reg.lease({ workspaceId: 'ws-1' })
    await lease.ensureSynced({ workspaceId: 'ws-1' })
    blockNextResolve = true

    reg.invalidateWorkspace('ws-1')
    await blocked
    reg.invalidateWorkspace('ws-1')
    await tick()
    unblockResolve()
    await tick()

    expect(resolveCalls).toBe(3)
    expect(p.syncCalls.length).toBe(3)
  })

  it('leaves a COLD pool cold on invalidate (no eager warm-at-change)', async () => {
    const r = makeFakeResolver([httpMcpEntry('k', 'srv')])
    const p = makeFakePool()
    const reg = makeRegistry(r, p)
    reg.lease({ workspaceId: 'ws-1' }) // created but never synced → cold
    reg.invalidateWorkspace('ws-1')
    await tick()
    expect(p.syncCalls.length).toBe(0)
  })

  it('(a) plugin uninstall while warm → next sync omits the removed server (diff disconnects)', async () => {
    const r = makeFakeResolver([httpMcpEntry('k1', 'plugin-srv'), httpMcpEntry('k2', 'native-srv')])
    const p = makeFakePool()
    const reg = makeRegistry(r, p)
    const lease = reg.lease({ workspaceId: 'ws-1' })
    await lease.ensureSynced({ workspaceId: 'ws-1' })
    expect(Object.keys(p.syncCalls[0]!.mcpServers).sort()).toEqual(['native-srv', 'plugin-srv'])
    expect(p.connected.has('plugin-srv')).toBe(true)
    // Uninstall removes the plugin connector's server from the resolve.
    r.setEntries([httpMcpEntry('k2', 'native-srv')])
    reg.invalidateWorkspace('ws-1')
    await tick()
    expect(Object.keys(p.syncCalls[1]!.mcpServers)).toEqual(['native-srv'])
    expect(p.connected.has('plugin-srv')).toBe(false)
  })

  it('(g) resolves workspace-scope (no project) unless a TRUSTED project handle is threaded', async () => {
    const r = makeFakeResolver([])
    const p = makeFakePool()
    const reg = makeRegistry(r, p)
    const lease = reg.lease({ workspaceId: 'ws-1' })
    // Untrusted / no project → pure workspace-scope context.
    await lease.ensureSynced({ workspaceId: 'ws-1', projectRoot: '/p', projectKey: 'pk', projectTrustState: 'none' })
    expect(r.contexts[0]).toMatchObject({ workspaceId: 'ws-1', projectTrustState: 'none' })
    expect(r.contexts[0]!.projectRoot).toBeUndefined()
    // Trusted project handle → project-scope context.
    reg.invalidateWorkspace('ws-1')
    await tick()
  })

  it('threads a trusted project handle into the resolve context', async () => {
    const r = makeFakeResolver([])
    const p = makeFakePool()
    const reg = makeRegistry(r, p)
    const lease = reg.lease({ workspaceId: 'ws-1', projectKey: 'pk' })
    await lease.ensureSynced({
      workspaceId: 'ws-1',
      projectRoot: '/trusted/proj',
      projectKey: 'pk',
      projectTrustState: 'trusted',
      projectTrustRevision: 'rev-1',
    })
    expect(r.contexts[0]).toMatchObject({
      workspaceId: 'ws-1',
      projectRoot: '/trusted/proj',
      projectKey: 'pk',
      projectTrustState: 'trusted',
    })
    reg.invalidateWorkspace('ws-1')
    await tick()
    expect(r.contexts[1]).toMatchObject({
      workspaceId: 'ws-1',
      projectRoot: '/trusted/proj',
      projectKey: 'pk',
      projectTrustState: 'trusted',
      projectTrustRevision: 'rev-1',
    })
  })

  it('global invalidation resyncs every warm workspace and trusted-project pool', async () => {
    const r = makeFakeResolver([httpMcpEntry('k', 'srv')])
    const p = makeFakePool()
    const reg = makeRegistry(r, p)
    await reg.lease({ workspaceId: 'ws-1' }).ensureSynced({ workspaceId: 'ws-1' })
    await reg.lease({ workspaceId: 'ws-2', projectKey: 'pk' }).ensureSynced({
      workspaceId: 'ws-2',
      projectRoot: '/trusted/proj',
      projectKey: 'pk',
      projectTrustState: 'trusted',
      projectTrustRevision: 'rev-1',
    })

    reg.invalidateAll()
    await tick()

    expect(r.contexts.length).toBe(4)
    expect(r.contexts[2]).toMatchObject({ workspaceId: 'ws-1', projectTrustState: 'none' })
    expect(r.contexts[3]).toMatchObject({
      workspaceId: 'ws-2', projectKey: 'pk', projectRoot: '/trusted/proj', projectTrustState: 'trusted',
    })
  })

  it('dispose disconnects every pool and releases resolver leases', async () => {
    const r = makeFakeResolver([httpMcpEntry('k', 'srv')])
    const p = makeFakePool()
    const reg = makeRegistry(r, p)
    const lease = reg.lease({ workspaceId: 'ws-1' })
    await lease.ensureSynced({ workspaceId: 'ws-1' })
    await reg.dispose()
    expect(p.disconnectedAll).toBe(1)
    expect(r.leaseCount()).toBe(0)
    // After dispose, ensureSynced is a no-op (registry is torn down).
    await lease.ensureSynced({ workspaceId: 'ws-1' })
    expect(p.syncCalls.length).toBe(1)
  })

  it('waits for an in-flight resolve before disconnecting and never syncs after dispose', async () => {
    const r = makeFakeResolver([httpMcpEntry('k', 'srv')])
    const p = makeFakePool()
    let resolveStarted!: () => void
    let unblockResolve!: () => void
    const started = new Promise<void>(resolve => { resolveStarted = resolve })
    const gate = new Promise<void>(resolve => { unblockResolve = resolve })
    const resolver = {
      ...r.resolver,
      resolve: async (context: CapabilityContext) => {
        resolveStarted()
        await gate
        return r.resolver.resolve(context)
      },
    } as unknown as CapabilityResolver
    const dp = makeFakeDpBroker({ state: 'needs-login', version: '13.0.0', outdated: false })
    const reg = new WorkspaceMcpPoolRegistry({
      resolver,
      resolveCredential: () => ({ ready: false, revision: 0 }),
      resolveWorkspaceRootPath: () => undefined,
      createPool: () => p.pool,
      dpSessionBroker: dp.broker,
    })
    const syncing = reg.lease({ workspaceId: 'ws-1' }).ensureSynced({ workspaceId: 'ws-1' })
    await started

    let disposeReturned = false
    const disposing = reg.dispose().then(() => { disposeReturned = true })
    await tick()
    const returnedBeforeResolveSettled = disposeReturned
    unblockResolve()
    await Promise.all([syncing, disposing])

    expect(returnedBeforeResolveSettled).toBe(false)
    expect(p.syncCalls).toEqual([])
    expect(p.disconnectedAll).toBe(1)
    expect(dp.listenerCount).toBe(0)
  })

  // --- P2b: session leases (leaserId-bearing) --------------------------------

  it('(P2b) a session lease release is idempotent and never disconnects the pool', async () => {
    const r = makeFakeResolver([httpMcpEntry('k', 'srv')])
    const p = makeFakePool()
    const reg = makeRegistry(r, p)
    const key = { workspaceId: 'ws-1' }
    const lease = reg.lease(key, { leaserId: 'session:A' })
    expect(reg.leaseCountFor(key)).toBe(1)
    await Promise.all([lease.release(), lease.release()])
    await lease.release()
    // dropLeaser('session:A') fired once; the pool was NEVER disconnectAll'ed
    // (browse keep-alive) and the leaseCount is back to zero.
    expect(p.droppedLeasers).toEqual(['session:A'])
    expect(p.disconnectedAll).toBe(0)
    expect(reg.leaseCountFor(key)).toBe(0)
  })

  it('(P2b) a browse lease (no leaserId) release resolves and drops nothing', async () => {
    const r = makeFakeResolver([httpMcpEntry('k', 'srv')])
    const p = makeFakePool()
    const reg = makeRegistry(r, p)
    const lease = reg.lease({ workspaceId: 'ws-1' })
    await lease.release()
    expect(p.droppedLeasers).toEqual([])
    expect(p.disconnectedAll).toBe(0)
    expect(reg.leaseCountFor({ workspaceId: 'ws-1' })).toBe(0)
  })

  it('(P2b) two session leases on ONE key share the same pool instance (union), and release drops only that leaser', async () => {
    const r = makeFakeResolver([httpMcpEntry('k', 'srv')])
    const p = makeFakePool()
    const reg = makeRegistry(r, p)
    const key = { workspaceId: 'ws-1' }
    const leaseA = reg.lease(key, { leaserId: 'session:A' })
    const leaseB = reg.lease(key, { leaserId: 'session:B' })
    // Both sessions borrow the SAME shared pool object.
    expect(leaseA.pool).toBe(leaseB.pool)
    expect(leaseA.pool).toBe(p.pool)
    expect(reg.leaseCountFor(key)).toBe(2)
    // A leaves → only A's leaser is dropped; the shared pool stays (B still holds it).
    await leaseA.release()
    expect(p.droppedLeasers).toEqual(['session:A'])
    expect(p.disconnectedAll).toBe(0)
    expect(reg.leaseCountFor(key)).toBe(1)
    await leaseB.release()
    expect(p.droppedLeasers).toEqual(['session:A', 'session:B'])
    expect(p.disconnectedAll).toBe(0)
  })

  it('a failed resolve leaves the pool dirty so the next need retries (fail-soft)', async () => {
    const r = makeFakeResolver([httpMcpEntry('k', 'srv')])
    const p = makeFakePool()
    // First resolve throws, second succeeds.
    let calls = 0
    const throwingResolver = {
      ...r.resolver,
      resolve: async (context: CapabilityContext) => {
        calls++
        if (calls === 1) throw new Error('resolve failed')
        return r.resolver.resolve(context)
      },
    } as unknown as CapabilityResolver
    const reg = new WorkspaceMcpPoolRegistry({
      resolver: throwingResolver,
      resolveCredential: () => ({ ready: false, revision: 0 }),
      resolveWorkspaceRootPath: () => undefined,
      dpSessionBroker: makeFakeDpBroker({
        state: 'needs-login',
        version: '13.0.0',
        outdated: false,
      }).broker,
      createPool: () => p.pool,
      resyncDebounceMs: 0,
    })
    const lease = reg.lease({ workspaceId: 'ws-1' })
    await lease.ensureSynced({ workspaceId: 'ws-1' }) // throws internally → dirty, no sync
    expect(p.syncCalls.length).toBe(0)
    await lease.ensureSynced({ workspaceId: 'ws-1' }) // retries because still dirty
    expect(p.syncCalls.length).toBe(1)
  })

  it('re-materializes the same entry when DP crosses ready during its first deferred probe', async () => {
    const fixture = await makeDpCapabilityFixture()
    try {
      const r = makeFakeResolver([fixture.dpEntry], [fixture.installedPlugin])
      const p = makeFakePool()
      const dp = makeDeferredDpBroker({
        state: 'needs-login',
        version: '13.0.0',
        outdated: false,
      })
      const reg = makeRegistry(r, p, {
        dpSessionBroker: dp.broker,
        pluginNodeRuntime: fixture.pluginNodeRuntime,
      })
      const syncing = reg.lease({ workspaceId: 'ws-1' }).ensureSynced({ workspaceId: 'ws-1' })
      await dp.probeStarted

      dp.setState({ state: 'ready', version: '13.0.0', outdated: false })
      dp.resolveFirstProbe({ state: 'needs-login', version: '13.0.0', outdated: false })
      await syncing

      expect(r.contexts).toHaveLength(1)
      expect(p.syncCalls).toHaveLength(1)
      expect(Object.keys(p.syncCalls.at(-1)!.mcpServers)).toEqual(['dpGitlab'])
      await reg.dispose()
    } finally {
      rmSync(fixture.bundleRoot, { recursive: true, force: true })
    }
  })

  it('returns current DP state when it changes during a direct lease final rematerialization', async () => {
    const r = makeFakeResolver()
    const p = makeFakePool()
    const dp = makeFakeDpBroker({ state: 'ready', version: '13.0.0', outdated: false })
    const reg = makeRegistry(r, p, {
      dpSessionBroker: dp.broker,
      pluginNodeRuntime: {
        command: process.execPath,
        executables: {
          dp: {
            command: process.execPath,
            externalAuthProvider: 'dp',
          },
        },
      },
    })
    const runtime = runtimeWithDp()
    let verifyCalls = 0
    let finalMaterializationStarted!: () => void
    let releaseFinalMaterialization!: () => void
    const finalStarted = new Promise<void>(resolve => { finalMaterializationStarted = resolve })
    const finalGate = new Promise<void>(resolve => { releaseFinalMaterialization = resolve })
    runtime.materializer.verifyPlugin = async () => {
      verifyCalls += 1
      if (verifyCalls !== 2) return
      finalMaterializationStarted()
      await finalGate
    }

    const materializing = reg.lease({ workspaceId: 'ws-1' }).materializeRuntime(runtime)
    await finalStarted
    dp.setState({ state: 'needs-login', version: '13.0.0', outdated: false })
    releaseFinalMaterialization()
    const result = await materializing

    expect(verifyCalls).toBeGreaterThanOrEqual(3)
    expect(result.mergedMcpServers).toEqual({})
    expect(result.externalAuthRequirements).toEqual([{
      provider: 'dp',
      wireNames: ['dpGitlab'],
      pluginInstanceIds: ['plugin://default'],
      state: 'needs-login',
    }])
    await reg.dispose()
  })

  it('skips a browse pool sync when DP changes after stable materialization', async () => {
    const fixture = await makeDpCapabilityFixture()
    try {
      const r = makeFakeResolver([fixture.dpEntry], [fixture.installedPlugin])
      const p = makeFakePool()
      const dp = makeFakeDpBroker({ state: 'ready', version: '13.0.0', outdated: false })
      const releaseSnapshot = r.resolver.releaseSnapshot.bind(r.resolver)
      let releaseCalls = 0
      const resolver = {
        ...r.resolver,
        releaseSnapshot(leaseId: string) {
          releaseSnapshot(leaseId)
          if (releaseCalls++ === 0) {
            dp.setState({ state: 'needs-login', version: '13.0.0', outdated: false })
          }
        },
      } as unknown as CapabilityResolver
      const reg = new WorkspaceMcpPoolRegistry({
        resolver,
        resolveCredential: () => ({ ready: false, revision: 0 }),
        resolveWorkspaceRootPath: () => undefined,
        createPool: () => p.pool,
        resyncDebounceMs: 0,
        dpSessionBroker: dp.broker,
        pluginNodeRuntime: fixture.pluginNodeRuntime,
      })

      await reg.lease({ workspaceId: 'ws-1' }).ensureSynced({ workspaceId: 'ws-1' })

      expect(r.contexts).toHaveLength(2)
      expect(p.syncCalls).toHaveLength(1)
      expect(p.syncCalls[0]!.mcpServers).toEqual({})
      await reg.dispose()
    } finally {
      rmSync(fixture.bundleRoot, { recursive: true, force: true })
    }
  })

  it('isolates DP state and subscriptions across registries with different host brokers', async () => {
    const fixture = await makeDpCapabilityFixture()
    try {
      const brokerA = makeFakeDpBroker({ state: 'needs-login', version: '13.0.0', outdated: false })
      const brokerB = makeFakeDpBroker({ state: 'needs-login', version: '13.0.0', outdated: false })
      const resolverA = makeFakeResolver([fixture.dpEntry], [fixture.installedPlugin])
      const resolverB = makeFakeResolver([fixture.dpEntry], [fixture.installedPlugin])
      const poolA = makeFakePool()
      const poolB = makeFakePool()
      const registryA = makeRegistry(resolverA, poolA, {
        dpSessionBroker: brokerA.broker,
        pluginNodeRuntime: fixture.pluginNodeRuntime,
      })
      const registryB = makeRegistry(resolverB, poolB, {
        dpSessionBroker: brokerB.broker,
        pluginNodeRuntime: fixture.pluginNodeRuntime,
      })
      await Promise.all([
        registryA.lease({ workspaceId: 'ws-a' }).ensureSynced({ workspaceId: 'ws-a' }),
        registryB.lease({ workspaceId: 'ws-b' }).ensureSynced({ workspaceId: 'ws-b' }),
      ])

      brokerA.setState({ state: 'ready', version: '13.0.0', outdated: false })
      await waitUntil(() => Object.keys(poolA.syncCalls.at(-1)!.mcpServers).length > 0)
      expect(Object.keys(poolA.syncCalls.at(-1)!.mcpServers)).toEqual(['dpGitlab'])
      expect(poolB.syncCalls).toHaveLength(1)

      await registryA.dispose()
      expect(brokerA.listenerCount).toBe(0)
      expect(brokerB.listenerCount).toBe(1)
      brokerB.setState({ state: 'ready', version: '13.0.0', outdated: false })
      await waitUntil(() => Object.keys(poolB.syncCalls.at(-1)!.mcpServers).length > 0)
      expect(Object.keys(poolB.syncCalls.at(-1)!.mcpServers)).toEqual(['dpGitlab'])
      await registryB.dispose()
      expect(brokerB.listenerCount).toBe(0)
    } finally {
      rmSync(fixture.bundleRoot, { recursive: true, force: true })
    }
  })

  it('gates DP for browse and session leases, then resyncs only the affected warm pool', async () => {
    const bundleRoot = mkdtempSync(join(tmpdir(), 'workspace-mcp-dp-'))
    try {
      const executable = join(bundleRoot, 'server.js')
      writeFileSync(executable, 'process.exit(0)')
      if (process.platform !== 'win32') chmodSync(executable, 0o755)
      const bundleHash = await computeNormalizedBundleHash(bundleRoot)
      const pluginInstanceId = `plugin://local/default@1.0.0#${bundleHash}`
      const dpEntry = {
        summary: {
          key: 'plugin#dpGitlab',
          logicalName: 'dpGitlab',
          kind: 'mcp',
          enabled: true,
          trustState: 'trusted',
        },
        runtimeBinding: {
          kind: 'mcp',
          server: {
            key: 'plugin#dpGitlab',
            wireName: 'dpGitlab',
            definition: { type: 'stdio', command: 'dp', args: ['ai', 'mcp', 'gitlab'] },
            pluginRuntime: {
              rootPath: bundleRoot,
              dataPath: join(bundleRoot, 'data'),
              bundleHash,
              profile: 'generic-plugin-env-v1',
            },
            pluginInstanceId,
          },
        },
      } as unknown as ResolvedCapabilityEntry
      const installedPlugin = {
        pluginKey: 'local/default',
        activeInstanceId: pluginInstanceId,
        origin: { marketplaceId: 'local', pluginId: 'default' },
        name: 'Default',
        version: '1.0.0',
        installedAt: 1,
        lifecycleState: 'ready',
        capabilityKinds: ['mcp'],
        bundleHash,
        bundleRootPath: bundleRoot,
      } as EffectiveCapabilitySnapshot['installedPlugins'][number]
      const r = makeFakeResolver([dpEntry, httpMcpEntry('native', 'native')], [installedPlugin])
      const p = makeFakePool()
      const dp = makeFakeDpBroker({
        state: 'needs-login',
        version: '13.0.0',
        outdated: false,
      })
      const reg = makeRegistry(r, p, {
        dpSessionBroker: dp.broker,
        pluginNodeRuntime: {
          command: process.execPath,
          executables: {
            dp: {
              command: process.execPath,
              environment: { DP_AI_MCP_SKIP_LOGIN: 'true' },
              externalAuthProvider: 'dp',
            },
          },
        },
      })
      const browse = reg.lease({ workspaceId: 'ws-1' })
      const session = reg.lease({ workspaceId: 'ws-1' }, { leaserId: 'session:A' })
      const plain = reg.lease({ workspaceId: 'ws-plain' })
      const cold = reg.lease({ workspaceId: 'ws-cold' })

      const [browseMaterialized, sessionMaterialized] = await Promise.all([
        browse.materializeRuntime(runtimeWithDp()),
        session.materializeRuntime(runtimeWithDp()),
      ])
      expect(browseMaterialized.externalAuthRequirements).toEqual(sessionMaterialized.externalAuthRequirements)
      expect(browseMaterialized.mergedMcpServers).toEqual(sessionMaterialized.mergedMcpServers)

      r.setEntries([httpMcpEntry('native', 'native')])
      await plain.ensureSynced({ workspaceId: 'ws-plain' })
      r.setEntries([dpEntry, httpMcpEntry('native', 'native')])
      await browse.ensureSynced({ workspaceId: 'ws-1' })
      expect(Object.keys(p.syncCalls[1]!.mcpServers)).toEqual(['native'])
      dp.setState({ state: 'ready', version: '13.0.0', outdated: false })
      dp.setState({ state: 'needs-login', version: '13.0.0', outdated: false })
      dp.setState({ state: 'ready', version: '13.0.0', outdated: false })
      await waitUntil(() => p.syncCalls.length > 2)

      expect(Object.keys(p.syncCalls[2]!.mcpServers).sort()).toEqual(['dpGitlab', 'native'])
      expect(p.syncCalls).toHaveLength(3)
      expect(r.contexts.filter(context => context.workspaceId === 'ws-plain')).toHaveLength(1)
      expect(r.contexts.filter(context => context.workspaceId === 'ws-cold')).toEqual([])
      await cold.release()
      await plain.release()
      await session.release()
      await reg.dispose()
      expect(dp.listenerCount).toBe(0)
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true })
    }
  })

  it('resyncs only a synced session DP leaser across the ready boundary', async () => {
    const r = makeFakeResolver()
    const p = makeFakePool()
    const dp = makeFakeDpBroker({ state: 'ready', version: '13.0.0', outdated: false })
    const reg = makeRegistry(r, p, {
      dpSessionBroker: dp.broker,
      pluginNodeRuntime: {
        command: process.execPath,
        executables: {
          dp: {
            command: process.execPath,
            environment: { DP_AI_MCP_SKIP_LOGIN: 'true' },
            externalAuthProvider: 'dp',
          },
        },
      },
    })
    const dpRuntime = runtimeWithDp()
    dpRuntime.view.mcpServers.push({
      key: 'healthy',
      wireName: 'healthy',
      logicalName: 'healthy',
      definition: { type: 'http', url: 'https://mcp.test/healthy' },
    })
    const plainRuntime = {
      ...runtimeWithDp(),
      view: {
        ...runtimeWithDp().view,
        mcpServers: [{
          key: 'plain',
          wireName: 'plain',
          definition: { type: 'http', url: 'https://mcp.test/plain' },
        }],
      },
    } as unknown as CapabilityTurnRuntime
    const session = reg.lease({ workspaceId: 'ws-1' }, { leaserId: 'session:dp' })
    const plainSession = reg.lease({ workspaceId: 'ws-1' }, { leaserId: 'session:plain' })
    const [desired, plainDesired] = await Promise.all([
      session.materializeRuntime(dpRuntime),
      plainSession.materializeRuntime(plainRuntime),
    ])
    await Promise.all([
      session.pool.sync(
        desired.mergedMcpServers,
        desired.apiServers as Parameters<McpClientPool['sync']>[1],
        { leaserId: session.leaserId },
      ),
      plainSession.pool.sync(
        plainDesired.mergedMcpServers,
        plainDesired.apiServers as Parameters<McpClientPool['sync']>[1],
        {
          leaserId: plainSession.leaserId,
        },
      ),
    ])

    dp.setState({ state: 'needs-login', version: '13.0.0', outdated: false })
    await tick()
    expect(p.syncCalls).toHaveLength(3)
    expect(p.syncCalls.at(-1)).toMatchObject({
      leaserId: 'session:dp',
      mcpServers: { healthy: { type: 'http', url: 'https://mcp.test/healthy' } },
    })

    dp.setState({ state: 'ready', version: '13.0.0', outdated: false })
    await tick()
    expect(p.syncCalls).toHaveLength(4)
    expect(p.syncCalls.at(-1)).toMatchObject({
      leaserId: 'session:dp',
      mcpServers: {
        dpGitlab: expect.any(Object),
        healthy: { type: 'http', url: 'https://mcp.test/healthy' },
      },
    })

    await plainSession.release()
    await session.release()
    await reg.dispose()
  })

  it('restores a gated session without replacing unrelated API instances', async () => {
    const r = makeFakeResolver()
    const p = makeFakePool()
    const dp = makeFakeDpBroker({ state: 'needs-login', version: '13.0.0', outdated: false })
    const reg = makeRegistry(r, p, {
      dpSessionBroker: dp.broker,
      pluginNodeRuntime: {
        command: process.execPath,
        executables: {
          dp: {
            command: process.execPath,
            environment: { DP_AI_MCP_SKIP_LOGIN: 'true' },
            externalAuthProvider: 'dp',
          },
        },
      },
    })
    const session = reg.lease({ workspaceId: 'ws-1' }, { leaserId: 'session:dp-only' })
    const runtime = runtimeWithDp()
    runtime.view.sources.push({
      key: 'source:healthy-api',
      logicalName: 'healthy-api',
      resource: { absolutePath: '/ws/sources/healthy-api/config.json' },
    } as CapabilityTurnRuntime['view']['sources'][number])
    runtime.materializer.readText = async () => JSON.stringify({
      id: 'healthy-api',
      name: 'Healthy API',
      slug: 'healthy-api',
      enabled: true,
      provider: 'custom',
      type: 'api',
      api: { baseUrl: 'https://api.test/', authType: 'none' },
    })
    const desired = await session.materializeRuntime(runtime)
    expect(desired.mergedMcpServers).toEqual({})
    const apiInstance = (desired.apiServers['healthy-api'] as { instance?: unknown }).instance
    expect(apiInstance).toBeDefined()
    await session.pool.sync(
      desired.mergedMcpServers,
      desired.apiServers as Parameters<McpClientPool['sync']>[1],
      { leaserId: session.leaserId },
    )

    dp.setState({ state: 'ready', version: '13.0.0', outdated: false })
    await tick()
    expect(p.syncCalls).toHaveLength(2)
    expect(p.syncCalls.at(-1)).toMatchObject({
      leaserId: 'session:dp-only',
      mcpServers: { dpGitlab: expect.any(Object) },
    })
    expect((p.syncCalls.at(-1)!.apiServers['healthy-api'] as { instance?: unknown }).instance).toBe(apiInstance)

    await session.release()
    await reg.dispose()
  })

  /**
   * A7 × the dp session gate: the registry's own materialize call
   * (`workspace-mcp-pool-registry.ts:510`) folds the BUILT-IN dp set through
   * `builtinDpMcpServers: { enabled: getBuiltinDpMcpServerPreferences() }`
   * — a REAL config read, with no `resolveDpPath` seam threaded through (the
   * brief for this task keeps `workspace-mcp-pool-registry.ts` untouched), so
   * this arm drives the real preference-write path instead of an injected one.
   *
   * Host-independence for `dp` itself comes from a real, harmless executable
   * placed on PATH — `materializeBuiltinDpMcpServers` only ever `accessSync`s
   * it (never executes it), exactly like `resolveDpBinary` in production.
   *
   * Host-independence for CONFIG_DIR comes from `bunfig.toml`'s `[test].preload`
   * (`isolate-shared-config-dir.ts`), which points `NESSY_CONFIG_DIR` at a
   * private per-run temp directory before ANY test file's imports can freeze
   * `CONFIG_DIR` at the real machine's `~/.nessy-agent` — verified empirically:
   * a later per-file `process.env.NESSY_CONFIG_DIR` reassignment has NO effect
   * on the already-frozen constant `config/storage.ts` reads from, so this
   * suite deliberately does NOT attempt one (unlike some session suites that
   * assign the env var before a DYNAMIC import of their own subject — that
   * pattern only works when nothing earlier in the same `bun test` process has
   * already imported `config/storage.ts`, which the global preload guarantees
   * is never true here). Instead this shares the one isolated `config.json`
   * every in-process suite in the run already reads through, and snapshots +
   * restores the exact `builtinDpMcpServers` key it touches so nothing leaks
   * into a sibling suite sharing that same directory.
   */
  it('gates an enabled BUILT-IN on needs-login and restores it across the ready boundary (A7 × dp gate)', async () => {
    const dpDir = mkdtempSync(join(tmpdir(), 'workspace-mcp-builtin-dp-path-'))
    const fakeDp = join(dpDir, 'dp')
    writeFileSync(fakeDp, '#!/bin/sh\nexit 0\n')
    if (process.platform !== 'win32') chmodSync(fakeDp, 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = `${dpDir}${delimiter}${previousPath ?? ''}`

    if (!loadStoredConfig()) {
      saveConfig({ workspaceRefs: [], activeWorkspaceId: null, activeSessionId: null } as Parameters<typeof saveConfig>[0])
    }
    const previousBuiltinDpMcpServers = loadStoredConfig()?.builtinDpMcpServers
    setBuiltinDpMcpServerEnabled('dpGitlab', true)

    try {
      const r = makeFakeResolver([])
      const p = makeFakePool()
      const dp = makeFakeDpBroker({ state: 'needs-login', version: '13.0.0', outdated: false })
      const reg = makeRegistry(r, p, { dpSessionBroker: dp.broker })
      const browse = reg.lease({ workspaceId: 'ws-1' })

      // The pool's ACTUAL desired set withholds the builtin while dp reports
      // needs-login — no plugin dp-bound server is involved anywhere here.
      await browse.ensureSynced({ workspaceId: 'ws-1' })
      expect(Object.keys(p.syncCalls.at(-1)!.mcpServers)).toEqual([])

      // The tracked requirement (the value `getWorkspacePendingAuth` and the
      // session-start notice read) names the builtin and the current state.
      const pending = await browse.materializeRuntime(runtimeWithoutMcp())
      expect(pending.mergedMcpServers.dpGitlab).toBeUndefined()
      expect(pending.externalAuthRequirements).toEqual([{
        provider: 'dp',
        wireNames: ['dpGitlab'],
        pluginInstanceIds: [],
        state: 'needs-login',
        builtinWireNames: ['dpGitlab'],
      }])

      // Flip ready and publish through the broker's OWN subscribe channel (not
      // a direct materialize call): the ready-boundary invalidation this
      // proves is `observeDpSessionState` reading the PoolEntry's tracked
      // `externalAuthRequirements` from the `ensureSynced` call above — if
      // that field had not been populated for a builtin, this resync would
      // never fire and `dpGitlab` would never come back.
      dp.setState({ state: 'ready', version: '13.0.0', outdated: false })
      await waitUntil(() => p.syncCalls.length >= 2)

      expect(p.syncCalls).toHaveLength(2)
      expect(Object.keys(p.syncCalls.at(-1)!.mcpServers)).toEqual(['dpGitlab'])

      await reg.dispose()
    } finally {
      process.env.PATH = previousPath
      const restored = loadStoredConfig()
      if (restored) {
        restored.builtinDpMcpServers = previousBuiltinDpMcpServers
        saveConfig(restored)
      }
      rmSync(dpDir, { recursive: true, force: true })
    }
  })

  /**
   * The review's "Important" finding, fixed: `scheduleSessionAuthResync` used
   * to block EVERY `requirement.wireNames` entry whenever
   * `dpSessionState !== 'ready'`, so a `ready -> unavailable` crossing (a
   * transient probe hiccup, or the non-Pi session preflight's hardcoded
   * value) evicted a connected BUILTIN from a live SESSION pool — the owner
   * decision this plan itself relies on ("withheld only on a positive
   * needs-login verdict") violated one layer above the materialization the
   * A7 arms already cover. This drives the two-tier `blocked` set added to
   * that function directly, via the broker's own subscribe channel — the
   * ONLY path that calls it.
   *
   * Same real-config + stub-dp-on-PATH fixture as the sibling A7 arm above
   * (the registry never accepts an injected `resolveDpPath`), but as a
   * SESSION lease: `scheduleSessionAuthResync` only ever runs for session
   * leasers, never for browse (a browse pool re-invalidates and re-resolves
   * wholesale instead).
   */
  it('a ready -> unavailable crossing keeps a connected builtin in a live session pool; needs-login still withholds it', async () => {
    const dpDir = mkdtempSync(join(tmpdir(), 'workspace-mcp-builtin-dp-resync-'))
    const fakeDp = join(dpDir, 'dp')
    writeFileSync(fakeDp, '#!/bin/sh\nexit 0\n')
    if (process.platform !== 'win32') chmodSync(fakeDp, 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = `${dpDir}${delimiter}${previousPath ?? ''}`

    if (!loadStoredConfig()) {
      saveConfig({ workspaceRefs: [], activeWorkspaceId: null, activeSessionId: null } as Parameters<typeof saveConfig>[0])
    }
    const previousBuiltinDpMcpServers = loadStoredConfig()?.builtinDpMcpServers
    setBuiltinDpMcpServerEnabled('dpGitlab', true)

    try {
      const r = makeFakeResolver([])
      const p = makeFakePool()
      const dp = makeFakeDpBroker({ state: 'ready', version: '13.0.0', outdated: false })
      const reg = makeRegistry(r, p, { dpSessionBroker: dp.broker })
      const session = reg.lease({ workspaceId: 'ws-1' }, { leaserId: 'session:builtin-only' })

      const desired = await session.materializeRuntime(runtimeWithoutMcp())
      expect(desired.mergedMcpServers.dpGitlab).toBeDefined()
      await session.pool.sync(
        desired.mergedMcpServers,
        desired.apiServers as Parameters<McpClientPool['sync']>[1],
        { leaserId: session.leaserId },
      )
      expect(p.syncCalls).toHaveLength(1)

      // Ready -> unavailable: exactly the crossing the review named — a
      // transient probe failure or the hardcoded non-Pi preflight value must
      // not evict an already-connected builtin.
      dp.setState({ state: 'unavailable', code: DpAuthError.Timeout })
      await tick()
      expect(p.syncCalls).toHaveLength(2)
      expect(Object.keys(p.syncCalls.at(-1)!.mcpServers)).toEqual(['dpGitlab'])

      // Bounce through ready: unavailable -> needs-login alone does not cross
      // the ready boundary (neither side equals 'ready'), so it would not
      // schedule a resync on its own — only a crossing does. Going back
      // through ready first (a legitimate real transition: dp recovers, then
      // the session expires) keeps the next step an observable crossing too.
      dp.setState({ state: 'ready', version: '13.0.0', outdated: false })
      await tick()
      expect(p.syncCalls).toHaveLength(3)
      expect(Object.keys(p.syncCalls.at(-1)!.mcpServers)).toEqual(['dpGitlab'])

      // Ready -> needs-login: the ONE state that means "the user must sign
      // in" — the builtin is correctly withheld here, and only here.
      dp.setState({ state: 'needs-login', version: '13.0.0', outdated: false })
      await tick()
      expect(p.syncCalls).toHaveLength(4)
      expect(Object.keys(p.syncCalls.at(-1)!.mcpServers)).toEqual([])

      await session.release()
      await reg.dispose()
    } finally {
      process.env.PATH = previousPath
      const restored = loadStoredConfig()
      if (restored) {
        restored.builtinDpMcpServers = previousBuiltinDpMcpServers
        saveConfig(restored)
      }
      rmSync(dpDir, { recursive: true, force: true })
    }
  })
})

/**
 * F1: a materialization that cannot answer must not take a send down with it.
 *
 * `preflightDpAuth` reaches this seam on every Pi send, so a snapshot revoked by
 * a concurrent plugin install used to surface as a raw
 * `CapabilityMaterializationError` in place of the model's answer — repeatedly,
 * for as long as the condition held.
 */
describe('a revoked snapshot re-resolves once, then degrades', () => {
  /** A pinned runtime whose snapshot lease is already dead. */
  function runtimeWithRevokedSnapshot(): CapabilityTurnRuntime {
    return {
      view: {
        generation: 'g-dead',
        sources: [],
        skills: [],
        mcpServers: [],
        hooks: [],
        automations: [],
        agents: [],
        promptLayers: [],
        memory: [],
        permissionLayers: [],
        commands: [],
        promptCommands: [],
        apps: [],
        lspServers: [],
      },
      materializer: {
        assertActive: () => { throw new CapabilityMaterializationError('revoked') },
        verifyPlugin: async () => { throw new CapabilityMaterializationError('revoked') },
        resolvePath: async () => { throw new CapabilityMaterializationError('revoked') },
        readText: async () => { throw new CapabilityMaterializationError('revoked') },
        resolveCredential: () => { throw new CapabilityMaterializationError('revoked') },
      },
    } as unknown as CapabilityTurnRuntime
  }

  it('re-resolves a FRESH snapshot and returns its servers', async () => {
    const r = makeFakeResolver([httpMcpEntry('mcp#alpha', 'alpha')])
    const p = makeFakePool()
    const reg = makeRegistry(r, p)

    const session = reg.lease({ workspaceId: 'ws-1' }, { leaserId: 'session:s1' })
    const desired = await session.materializeRuntime(runtimeWithRevokedSnapshot())

    // The dead lease produced nothing; the re-resolve did.
    expect(Object.keys(desired.mergedMcpServers)).toEqual(['alpha'])
    // Exactly one extra resolve, and its snapshot was released again.
    expect(r.contexts).toHaveLength(1)
    expect(r.leaseCount()).toBe(0)

    await session.release()
    await reg.dispose()
  })

  it('fails soft with an empty requirement list when the re-resolve is revoked too', async () => {
    const r = makeFakeResolver([httpMcpEntry('mcp#alpha', 'alpha')])
    const p = makeFakePool()
    const reg = makeRegistry(r, p)
    r.revokeEveryLease()

    const session = reg.lease({ workspaceId: 'ws-1' }, { leaserId: 'session:s1' })
    const desired = await session.materializeRuntime(runtimeWithRevokedSnapshot())

    expect(desired.mergedMcpServers).toEqual({})
    expect(desired.externalAuthRequirements).toEqual([])
    expect(desired.sources).toEqual([])
    // Degraded, not leaked: the retry's snapshot is released either way.
    expect(r.leaseCount()).toBe(0)

    await session.release()
    await reg.dispose()
  })

  it('never syncs the degraded empty set into a warm browse pool', async () => {
    const r = makeFakeResolver([httpMcpEntry('mcp#alpha', 'alpha')])
    const p = makeFakePool()
    const reg = makeRegistry(r, p)

    const browse = reg.lease({ workspaceId: 'ws-1' })
    await browse.ensureSynced({ workspaceId: 'ws-1' })
    expect(p.syncCalls).toHaveLength(1)
    expect(p.pool.isConnected('alpha')).toBe(true)

    // Now every lease is dead: the next browse resync must leave the connected
    // pool alone rather than syncing `{}` and disconnecting it.
    r.revokeEveryLease()
    reg.invalidateWorkspace('ws-1', { workspaceId: 'ws-1' })
    await tick()
    await browse.ensureSynced({ workspaceId: 'ws-1' })

    expect(p.syncCalls).toHaveLength(1)
    expect(p.pool.isConnected('alpha')).toBe(true)

    await reg.dispose()
  })
})

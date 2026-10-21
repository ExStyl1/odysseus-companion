/**
 * E5a — a browse reload keeps the live connections of unchanged servers.
 *
 * > When you reload, Claude Code keeps the live connections of plugin servers
 * > whose configuration is unchanged.
 *
 * Drives the REAL `WorkspaceMcpPoolRegistry` over the REAL `McpClientPool` (a
 * subclass that only RECORDS `connectInProcess`/`sync` and delegates), a REAL
 * `CapabilitySnapshotMaterializer` and REAL api sources on disk, so the thing
 * under assertion is the pool's own client identity rather than a count of
 * rows in a desired set. API sources are in-process (`InMemoryTransport`): no
 * subprocess, no network, no credential file.
 *
 * The MCP half needs no coverage here — `mcpConnectionKey` is a sha256 over the
 * server config, so an unchanged MCP server already keeps its client. The api
 * half is the one that churned: `apiConnectionKey` keys on the INSTANCE, and
 * every resync used to mint a fresh instance for every api source.
 */

import { describe, it, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpClientPool } from '@nessy-agent/shared/mcp'
import type {
  CapabilityContext,
  CapabilityResolver,
  EffectiveCapabilitySnapshot,
  NativeResourceRef,
  ResolvedCapabilityEntry,
} from '@nessy-agent/shared/capabilities/resolver'
import type { DpSessionBroker } from '@nessy-agent/shared/auth/dp'
import type { RuntimeCredentialBinding, StoredCredential } from '@nessy-agent/shared/credentials'
import { WorkspaceMcpPoolRegistry } from '../workspace-mcp-pool-registry'

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

/**
 * The real pool, instrumented. Overrides record and delegate — no reconcile,
 * diff or identity rule is reproduced here, so a regression in the production
 * rule still reaches these assertions.
 */
class RecordingPool extends McpClientPool {
  readonly apiConnects: { slug: string; instance: object }[] = []
  readonly syncedApiMaps: Record<string, { instance: McpServer }>[] = []

  override async connectInProcess(slug: string, mcpServer: McpServer): Promise<void> {
    this.apiConnects.push({ slug, instance: mcpServer })
    return super.connectInProcess(slug, mcpServer)
  }

  override async sync(
    mcpServers: Parameters<McpClientPool['sync']>[0],
    apiServers: Parameters<McpClientPool['sync']>[1] = {},
    options: Parameters<McpClientPool['sync']>[2] = {},
  ): Promise<string[]> {
    this.syncedApiMaps.push(apiServers as Record<string, { instance: McpServer }>)
    return super.sync(mcpServers, apiServers, options)
  }

  /** Instance the pool was last handed for a slug, by sync ordinal. */
  instanceAt(syncIndex: number, slug: string): object | undefined {
    return this.syncedApiMaps[syncIndex]?.[slug]?.instance
  }

  connectCountFor(slug: string): number {
    return this.apiConnects.filter(connect => connect.slug === slug).length
  }
}

/** Write an api source folder and return the resource ref pinning its bytes. */
function writeApiSource(
  root: string,
  slug: string,
  overrides: Record<string, unknown> = {},
): NativeResourceRef {
  const folder = join(root, slug)
  mkdirSync(folder, { recursive: true })
  const configPath = join(folder, 'config.json')
  const config = {
    id: slug,
    name: slug,
    slug,
    enabled: true,
    provider: slug,
    type: 'api',
    api: { baseUrl: `https://example.test/${slug}`, authType: 'none' },
    ...overrides,
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  const bytes = Buffer.from(JSON.stringify(config, null, 2))
  return {
    source: 'workspace',
    scope: { kind: 'workspace', workspaceId: 'ws-1' },
    resourceId: `source:${slug}`,
    absolutePath: folder,
    revision: String(statSync(configPath).mtimeMs),
    contentHash: createHash('sha256').update(bytes).digest('hex'),
  } as unknown as NativeResourceRef
}

function sourceEntry(
  slug: string,
  resource: NativeResourceRef,
  credential?: RuntimeCredentialBinding,
): ResolvedCapabilityEntry {
  return {
    summary: { key: `source#${slug}`, logicalName: slug, kind: 'source', enabled: true, trustState: 'trusted' },
    runtimeBinding: { kind: 'source', resource, ...(credential ? { credential } : {}) },
  } as unknown as ResolvedCapabilityEntry
}

function makeResolver(initial: ResolvedCapabilityEntry[]) {
  let entries = initial
  const active = new Set<string>()
  let seq = 0
  const resolver = {
    resolve: async (context: CapabilityContext): Promise<EffectiveCapabilitySnapshot> => {
      seq += 1
      const leaseId = `lease-${seq}`
      active.add(leaseId)
      return {
        context,
        generation: `g-${seq}`,
        leaseId,
        entries,
        installedPlugins: [],
        diagnostics: [],
      } as unknown as EffectiveCapabilitySnapshot
    },
    releaseSnapshot: (leaseId: string) => { active.delete(leaseId) },
    invalidate: () => {},
    isLeaseActive: (leaseId: string) => active.has(leaseId),
    referencedInstances: () => new Set(),
    leaseCount: () => active.size,
  }
  return {
    resolver: resolver as unknown as CapabilityResolver,
    setEntries: (next: ResolvedCapabilityEntry[]) => { entries = next },
  }
}

const dpBroker: Pick<DpSessionBroker, 'probe' | 'subscribe'> = {
  probe: async () => ({ state: 'needs-login', version: '13.0.0', outdated: false }) as never,
  subscribe: () => () => {},
}

function makeRegistry(
  resolver: CapabilityResolver,
  pool: RecordingPool,
  resolveCredential: (binding: RuntimeCredentialBinding) => {
    ready: boolean
    revision: number
    value?: string
    credential?: StoredCredential
  } = () => ({ ready: false, revision: 0 }),
) {
  return new WorkspaceMcpPoolRegistry({
    resolver,
    resolveCredential,
    resolveWorkspaceRootPath: () => undefined,
    createPool: () => pool,
    resyncDebounceMs: 0,
    dpSessionBroker: dpBroker,
  })
}

describe('E5a — browse reload keeps unchanged api connections', () => {
  it('a reload with no change reconnects nothing, and a changed source reconnects only itself', async () => {
    const root = mkdtempSync(join(tmpdir(), 'e5a-browse-'))
    const alpha = writeApiSource(root, 'alpha')
    const beta = writeApiSource(root, 'beta')
    const fake = makeResolver([sourceEntry('alpha', alpha), sourceEntry('beta', beta)])
    const pool = new RecordingPool({})
    const registry = makeRegistry(fake.resolver, pool)
    const key = { workspaceId: 'ws-1' }
    const context = { workspaceId: 'ws-1' }

    // 1. Warm the pool.
    await registry.lease(key).ensureSynced(context)
    expect(pool.connectCountFor('alpha')).toBe(1)
    expect(pool.connectCountFor('beta')).toBe(1)

    // 2. Reload with NOTHING changed: no reconnect, and the pool is handed the
    //    same instances it is already holding.
    registry.invalidateWorkspace('ws-1')
    await tick()
    await registry.lease(key).ensureSynced(context)
    expect(pool.syncedApiMaps.length).toBeGreaterThan(1)
    expect(pool.connectCountFor('alpha')).toBe(1)
    expect(pool.connectCountFor('beta')).toBe(1)
    expect(pool.instanceAt(1, 'alpha')).toBe(pool.instanceAt(0, 'alpha')!)
    expect(pool.instanceAt(1, 'beta')).toBe(pool.instanceAt(0, 'beta')!)

    // 3. alpha's configuration moves. Only alpha reconnects; beta keeps the
    //    exact client identity it has been holding since the first sync.
    const movedAlpha = writeApiSource(root, 'alpha', { tagline: 'moved' })
    fake.setEntries([sourceEntry('alpha', movedAlpha), sourceEntry('beta', beta)])
    registry.invalidateWorkspace('ws-1')
    await tick()
    await registry.lease(key).ensureSynced(context)
    const changedSync = pool.syncedApiMaps.length - 1
    expect(pool.connectCountFor('alpha')).toBe(2)
    expect(pool.connectCountFor('beta')).toBe(1)
    expect(pool.instanceAt(changedSync, 'alpha')).not.toBe(pool.instanceAt(0, 'alpha')!)
    expect(pool.instanceAt(changedSync, 'beta')).toBe(pool.instanceAt(0, 'beta')!)

    await registry.dispose()
  })

  it('a credential revision change reconnects, even though the config file is untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'e5a-cred-'))
    const gamma = writeApiSource(root, 'gamma', {
      api: { baseUrl: 'https://example.test/gamma', authType: 'bearer' },
      isAuthenticated: true,
    })
    const stable = writeApiSource(root, 'stable')
    let revision = 1
    const fake = makeResolver([
      sourceEntry('gamma', gamma, { id: 'cred-gamma', expectedRevision: revision } as unknown as RuntimeCredentialBinding),
      sourceEntry('stable', stable),
    ])
    const pool = new RecordingPool({})
    const registry = makeRegistry(fake.resolver, pool, binding => ({
      ready: true,
      revision: binding.expectedRevision,
      value: 'not-a-real-token',
      credential: { value: 'not-a-real-token' } as StoredCredential,
    }))
    const key = { workspaceId: 'ws-1' }
    const context = { workspaceId: 'ws-1' }

    await registry.lease(key).ensureSynced(context)
    expect(pool.connectCountFor('gamma')).toBe(1)
    expect(pool.connectCountFor('stable')).toBe(1)

    // The credential rotated: same config bytes, new binding revision.
    revision = 2
    fake.setEntries([
      sourceEntry('gamma', gamma, { id: 'cred-gamma', expectedRevision: revision } as unknown as RuntimeCredentialBinding),
      sourceEntry('stable', stable),
    ])
    registry.invalidateWorkspace('ws-1')
    await tick()
    await registry.lease(key).ensureSynced(context)
    const last = pool.syncedApiMaps.length - 1
    expect(pool.connectCountFor('gamma')).toBe(2)
    expect(pool.connectCountFor('stable')).toBe(1)
    expect(pool.instanceAt(last, 'gamma')).not.toBe(pool.instanceAt(0, 'gamma')!)
    expect(pool.instanceAt(last, 'stable')).toBe(pool.instanceAt(0, 'stable')!)

    await registry.dispose()
  })
})

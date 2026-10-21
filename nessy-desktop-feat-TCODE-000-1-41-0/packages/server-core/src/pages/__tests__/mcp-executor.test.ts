/**
 * UA9.2 — the Pages MCP executor runs a granted call through the EXISTING workspace pool, leased as
 * `page:<slug>`, never a page-only pool.
 *
 * Adapted from craft-agents-oss `v0.13.4:packages/server-core/src/pages/__tests__/mcp-executor.test.ts`
 * (Apache-2.0): upstream's arms (unknown source, an API source named in an mcp grant, the stable
 * `source-auth-required` error, a tool error thrown, a long result truncated, the abort signal forwarded) are kept;
 * the pool is a REAL `McpClientPool` whose transport is faked at `openConnection` (the planted-collaborator rule:
 * the production `sync` → reconcile → connect path runs), and the registry is a stand-in with the real lease shape
 * (`release` drops the leaser).
 * - positive: a granted MCP call goes through our lease (`page:dash`), and the leaser is dropped after;
 * - negative: under `shared` a server the browse leaser already holds is joined, not reconnected; under
 *   `per-leaser` the page gets its own isolated transport and no second unisolated one; a source the capability
 *   view does not carry (disabled / managed-denied) is refused with no connect.
 */
import { describe, expect, it } from 'bun:test'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { McpClientPool, type McpOpenConnectionRequest, type PoolClient } from '@nessy-agent/shared/mcp'
import type { SdkMcpServerConfig } from '@nessy-agent/shared/agent/backend'
import type { LoadedSource } from '@nessy-agent/shared/sources'
import { createPagesMcpExecutor, MCP_ACTION_BODY_MAX_CHARS, pageMcpLeaserId } from '../mcp-executor'
import { PAGE_SOURCE_AUTH_REQUIRED_PREFIX } from '../source-gate'

const HTTP: SdkMcpServerConfig = { type: 'http', url: 'https://mcp.example.test/mcp' }
const TOOLS: Tool[] = [
  { name: 'create_issue', description: 'Create', inputSchema: { type: 'object', properties: {} } } as Tool,
  { name: 'big', description: 'Big', inputSchema: { type: 'object', properties: {} } } as Tool,
  { name: 'fails', description: 'Fails', inputSchema: { type: 'object', properties: {} } } as Tool,
]
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never

class FakeTransportPool extends McpClientPool {
  readonly connects: string[] = []
  readonly connectionKeys: string[] = []
  readonly calls: Array<{ tool: string; args: unknown; connectionKey: string }> = []

  protected override async openConnection({ slug, connectionKey }: McpOpenConnectionRequest): Promise<PoolClient> {
    this.connects.push(slug)
    this.connectionKeys.push(connectionKey)
    return {
      listTools: async () => TOOLS,
      callTool: async (name: string, args: Record<string, unknown>) => {
        this.calls.push({ tool: name, args, connectionKey })
        if (name === 'fails') return { content: [{ type: 'text', text: 'upstream said no' }], isError: true }
        if (name === 'big') return { content: [{ type: 'text', text: 'x'.repeat(MCP_ACTION_BODY_MAX_CHARS + 10) }] }
        return { content: [{ type: 'text', text: `created:${JSON.stringify(args)}` }] }
      },
      close: async () => {},
    } as unknown as PoolClient
  }
}

function source(slug: string, overrides: Record<string, unknown> = {}): LoadedSource {
  return {
    config: { slug, name: slug, type: 'mcp', enabled: true, mcp: { authType: 'none' }, ...overrides },
    guide: null,
    folderPath: `/ws/sources/${slug}`,
    workspaceRootPath: '/ws',
    workspaceId: 'ws',
  } as unknown as LoadedSource
}

interface Rig {
  pool: FakeTransportPool
  leases: string[]
  releases: string[]
  run: ReturnType<typeof createPagesMcpExecutor>
}

function rig(options: {
  isolation?: 'shared' | 'per-leaser'
  sources?: Record<string, LoadedSource>
  /** logicalName → wire name carried by the capability view; absent = not in the view */
  view?: Record<string, string | null>
  mcpServers?: Record<string, SdkMcpServerConfig>
  apiServers?: Record<string, unknown>
} = {}): Rig {
  const pool = new FakeTransportPool({ connectionNonBlocking: false, connectionIsolation: options.isolation ?? 'shared' })
  const leases: string[] = []
  const releases: string[] = []
  const view = options.view ?? { linear: 'linear' }
  const run = createPagesMcpExecutor({
    workspaceId: 'ws',
    workspaceRootPath: '/ws',
    log,
    loadSource: (_root, slug) => (options.sources ?? { linear: source('linear') })[slug] ?? null,
    refreshManager: { ensureFreshToken: async () => ({ success: true }) as never },
    resolveRuntime: async () => ({
      runtime: {
        view: { sources: Object.entries(view).map(([logicalName, wire]) => ({ logicalName, ...(wire ? { mcpWireName: wire } : {}) })) },
        materializer: {},
      } as never,
      release: () => {},
    }),
    registry: {
      lease: (_key, leaseOptions) => {
        const leaserId = leaseOptions?.leaserId ?? 'browse'
        leases.push(leaserId)
        return {
          key: { workspaceId: 'ws' },
          pool,
          leaserId,
          ensureSynced: async () => {},
          materializeRuntime: async () => ({
            sources: [],
            mcpServers: options.mcpServers ?? { linear: HTTP },
            apiServers: options.apiServers ?? {},
            mergedMcpServers: options.mcpServers ?? { linear: HTTP },
            externalAuthRequirements: [],
          }),
          release: async () => {
            releases.push(leaserId)
            await pool.dropLeaser(leaserId)
          },
        }
      },
    },
  })
  return { pool, leases, releases, run }
}

const signal = () => new AbortController().signal

describe('createPagesMcpExecutor (UA9.2)', () => {
  it('positive: a granted call goes through the workspace pool leased as page:<slug>, and the leaser is dropped after', async () => {
    const r = rig()
    const body = await r.run({ pageSlug: 'dash', sourceSlug: 'linear', toolName: 'create_issue', args: { title: 'x' } }, { signal: signal() })
    expect(body).toBe('created:{"title":"x"}')
    expect(r.leases).toEqual([pageMcpLeaserId('dash')])
    expect(r.leases[0]).toBe('page:dash')
    expect(r.pool.calls.map(({ tool, args }) => ({ tool, args }))).toEqual([{ tool: 'create_issue', args: { title: 'x' } }])
    expect(r.releases).toEqual(['page:dash'])
    expect(r.pool.hasLeaser('page:dash')).toBe(false)
  })

  it('negative (shared): a server the browse leaser already holds is joined — no second connection', async () => {
    const r = rig({ isolation: 'shared' })
    await r.pool.sync({ linear: HTTP }, {}, { leaserId: 'browse' })
    expect(r.pool.connects).toEqual(['linear'])
    await r.run({ pageSlug: 'dash', sourceSlug: 'linear', toolName: 'create_issue', args: {} }, { signal: signal() })
    expect(r.pool.connects).toEqual(['linear'])
    // The browse leaser keeps its server after the page lets go.
    expect(r.pool.isConnected('linear', 'browse')).toBe(true)
  })

  it('negative (per-leaser): the page gets its own isolated transport and opens no second unisolated one', async () => {
    const r = rig({ isolation: 'per-leaser' })
    await r.pool.sync({ linear: HTTP }, {}, { leaserId: 'browse' })
    const browseKey = r.pool.connectionKeyForDesired('linear', 'browse')!
    await r.run({ pageSlug: 'dash', sourceSlug: 'linear', toolName: 'create_issue', args: {} }, { signal: signal() })
    // Exactly two transports — the browse leaser's and the page's own — and the call rode the page's.
    expect(r.pool.connects).toEqual(['linear', 'linear'])
    expect(r.pool.connectionKeys[0]).toBe(browseKey)
    expect(r.pool.connectionKeys[1]).not.toBe(browseKey)
    expect(r.pool.calls.map(call => call.connectionKey)).toEqual([r.pool.connectionKeys[1]!])
    // Released with the page: the isolated connection goes, the browse one stays.
    expect(r.pool.isConnected('linear', 'browse')).toBe(true)
    expect(r.pool.hasLeaser('page:dash')).toBe(false)
  })

  it('negative: a source the capability view does not carry (disabled, managed-denied) is refused before any connect', async () => {
    const r = rig({ view: {} })
    await expect(r.run({ pageSlug: 'dash', sourceSlug: 'linear', toolName: 'create_issue', args: {} }, { signal: signal() }))
      .rejects.toThrow('not available to this workspace')
    expect(r.pool.connects).toEqual([])
    expect(r.releases).toEqual(['page:dash'])
  })

  it('refuses an unknown source, an API source named in an mcp grant, and a source that lost its sign-in', async () => {
    await expect(rig({ sources: {} }).run({ pageSlug: 'dash', sourceSlug: 'linear', toolName: 'create_issue', args: {} }, { signal: signal() }))
      .rejects.toThrow('not found in this workspace')

    const api = rig({ sources: { stripe: source('stripe', { type: 'api', mcp: undefined, api: { authType: 'none' } }) }, view: { stripe: null }, apiServers: { stripe: {} } })
    await expect(api.run({ pageSlug: 'dash', sourceSlug: 'stripe', toolName: 'charges', args: {} }, { signal: signal() }))
      .rejects.toThrow('is an API source')

    const signedOut = rig({ sources: { linear: source('linear', { mcp: { authType: 'oauth' }, isAuthenticated: false }) } })
    await expect(signedOut.run({ pageSlug: 'dash', sourceSlug: 'linear', toolName: 'create_issue', args: {} }, { signal: signal() }))
      .rejects.toThrow(`${PAGE_SOURCE_AUTH_REQUIRED_PREFIX}:`)
    expect(signedOut.pool.connects).toEqual([])
  })

  it('throws a tool error and truncates an oversized result (upstream arms)', async () => {
    const r = rig()
    await expect(r.run({ pageSlug: 'dash', sourceSlug: 'linear', toolName: 'fails', args: {} }, { signal: signal() }))
      .rejects.toThrow('upstream said no')
    const big = await r.run({ pageSlug: 'dash', sourceSlug: 'linear', toolName: 'big', args: {} }, { signal: signal() }) as string
    expect(big.length).toBe(MCP_ACTION_BODY_MAX_CHARS)
    expect(big).toContain('[truncated — full result was')
  })

  it('two concurrent calls of one page share one lease; it is released when the last settles', async () => {
    const r = rig()
    const [a, b] = await Promise.all([
      r.run({ pageSlug: 'dash', sourceSlug: 'linear', toolName: 'create_issue', args: { n: 1 } }, { signal: signal() }),
      r.run({ pageSlug: 'dash', sourceSlug: 'linear', toolName: 'create_issue', args: { n: 2 } }, { signal: signal() }),
    ])
    expect([a, b]).toEqual(['created:{"n":1}', 'created:{"n":2}'])
    expect(r.leases).toEqual(['page:dash'])
    expect(r.releases).toEqual(['page:dash'])
  })
})

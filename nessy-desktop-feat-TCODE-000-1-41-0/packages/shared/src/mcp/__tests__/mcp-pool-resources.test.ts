/**
 * UB7.10 — the pool's agent-facing resource listing and read.
 *
 * `listResources(slug)` follows `nextCursor` (10 pages at most, a repeated
 * cursor stops) and degrades a source that refuses its TEMPLATES (the
 * `-32601` servers without any usually answer) to no templates; a source
 * without the resources capability, an API source and a source that is not
 * connected are refused with the sentences the agent can act on.
 * `readResourceText(slug, uri)` renders agent-ready text — text contents
 * joined, a binary blob described (to downloads/ when the session has a
 * folder) — where the wire-facing `readResource` keeps the raw contents.
 *
 * Upstream's own suite (`mcp-pool-resources.test.ts` over the
 * `mcp-server-resources.mjs` stdio fixture) drives a REAL server end to end;
 * ours drives the same arms through the scripted-client rig
 * `pool-server-resources.test.ts` uses, because the pool's connect here is
 * replaced wholesale rather than spawned.
 */

import { describe, expect, it } from 'bun:test'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { McpClientPool, type McpOpenConnectionRequest } from '../mcp-pool.ts'
import type { McpResourceReadResult, PoolClient } from '../client.ts'
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts'

const httpAt = (host: string): SdkMcpServerConfig => ({ type: 'http', url: `https://${host}.example.test/mcp` })
const tool = (name: string): Tool =>
  ({ name, description: `desc ${name}`, inputSchema: { type: 'object', properties: {} } } as Tool)

interface FakeServer {
  capabilities?: Record<string, unknown>
  /** One array per page; the cursor is the next page's index. */
  resources?: Array<Array<{ uri: string; name?: string }>>
  templates?: Array<Array<{ uriTemplate: string; name?: string }>> | 'fail'
  /** Overrides the index cursor (e.g. a server that keeps returning the same one). */
  nextCursor?: (page: number) => string | undefined
  read?: (uri: string) => McpResourceReadResult
}

/** Tools-only: the API-source shape (no resources or prompts members). */
function toolsOnlyClient(): PoolClient {
  return {
    listTools: async () => [tool('api')],
    callTool: async () => ({ content: [] }),
    close: async () => {},
  } as PoolClient
}

class ResourcesPool extends McpClientPool {
  readonly servers = new Map<string, FakeServer>()
  readonly calls: Array<{ slug: string; method: string; cursor?: string }> = []

  protected override async openConnection({ slug }: McpOpenConnectionRequest): Promise<PoolClient> {
    const server = this.servers.get(slug)
    if (!server) return toolsOnlyClient()
    const page = <T>(pages: Array<T[]> | undefined, cursor?: string): { items: T[]; nextCursor?: string } => {
      const index = cursor ? Number(cursor) || 0 : 0
      const nextCursor = server.nextCursor
        ? server.nextCursor(index)
        : pages && index + 1 < pages.length ? String(index + 1) : undefined
      return { items: pages?.[index] ?? [], ...(nextCursor ? { nextCursor } : {}) }
    }
    const record = (method: string, cursor?: string) => this.calls.push({ slug, method, cursor })
    return {
      listTools: async () => [tool(slug)],
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      close: async () => {},
      getServerCapabilities: () => server.capabilities as never,
      listResources: async (cursor?: string) => {
        record('listResources', cursor)
        const { items, nextCursor } = page(server.resources, cursor)
        return { resources: items, ...(nextCursor ? { nextCursor } : {}) }
      },
      listResourceTemplates: async (cursor?: string) => {
        record('listResourceTemplates', cursor)
        if (server.templates === 'fail') throw new Error('MCP error -32601: Method not found')
        const { items, nextCursor } = page(server.templates, cursor)
        return { resourceTemplates: items, ...(nextCursor ? { nextCursor } : {}) }
      },
      readResource: async (uri: string) => {
        record('readResource')
        return server.read?.(uri) ?? { contents: [] }
      },
    } as unknown as PoolClient
  }
}

const BOTH: Record<string, unknown> = { tools: {}, resources: {}, prompts: {} }

describe('McpClientPool.listResources (UB7.10 pagination)', () => {
  it('a 3-page server lists all items and flags the truncation cap', async () => {
    const pool = new ResourcesPool({ connectionNonBlocking: false });
    // 12 resources over 3 pages: all 12 are listed (under the 10-page cap).
    (pool as unknown as { servers: Map<string, FakeServer> }).servers.set('liza', {
      capabilities: BOTH,
      resources: [
        [{ uri: 'liza://r/1' }, { uri: 'liza://r/2' }, { uri: 'liza://r/3' }, { uri: 'liza://r/4' }],
        [{ uri: 'liza://r/5' }, { uri: 'liza://r/6' }, { uri: 'liza://r/7' }, { uri: 'liza://r/8' }],
        [{ uri: 'liza://r/9' }, { uri: 'liza://r/10' }, { uri: 'liza://r/11' }, { uri: 'liza://r/12' }],
      ],
      templates: [[{ uriTemplate: 'liza://r/{id}', name: 'r' }]],
    })
    await pool.sync({ liza: httpAt('liza') }, {}, { leaserId: 'L' })

    const listing = await pool.listResources('liza', 'L')

    expect(listing.resources.map(r => (r as { uri: string }).uri)).toEqual([
      'liza://r/1', 'liza://r/2', 'liza://r/3', 'liza://r/4',
      'liza://r/5', 'liza://r/6', 'liza://r/7', 'liza://r/8',
      'liza://r/9', 'liza://r/10', 'liza://r/11', 'liza://r/12',
    ])
    expect(listing.resourceTemplates).toEqual([{ uriTemplate: 'liza://r/{id}', name: 'r' }])
    expect(listing.truncated).toBe(false)
    // The cursor walk happened pool-side: three pages, the walker passed 1 then 2.
    expect(pool.calls.filter(c => c.method === 'listResources').map(c => c.cursor)).toEqual([undefined, '1', '2'])
  })

  it('a repeated cursor stops the walk instead of looping to the page cap', async () => {
    const pool = new ResourcesPool({ connectionNonBlocking: false });
    (pool as unknown as { servers: Map<string, FakeServer> }).servers.set('stuck', {
      capabilities: BOTH,
      resources: [[{ uri: 'stuck://r/1' }]],
      // A broken server that always claims there is a next page, same cursor.
      nextCursor: () => '1',
    })
    await pool.sync({ stuck: httpAt('stuck') }, {}, { leaserId: 'L' })

    const listing = await pool.listResources('stuck', 'L')

    expect(listing.resources).toEqual([{ uri: 'stuck://r/1' }])
    expect(listing.truncated).toBe(true)
    const walks = pool.calls.filter(c => c.method === 'listResources')
    expect(walks.length).toBe(2)
    expect(walks.map(c => c.cursor)).toEqual([undefined, '1'])
  })

  it('a server that refuses its templates (-32601) still lists its resources', async () => {
    const pool = new ResourcesPool({ connectionNonBlocking: false });
    (pool as unknown as { servers: Map<string, FakeServer> }).servers.set('plain', {
      capabilities: { tools: {}, resources: {} },
      resources: [[{ uri: 'plain://r/1' }]],
      templates: 'fail',
    })
    await pool.sync({ plain: httpAt('plain') }, {}, { leaserId: 'L' })

    const listing = await pool.listResources('plain', 'L')

    expect(listing.resources).toEqual([{ uri: 'plain://r/1' }])
    expect(listing.resourceTemplates).toEqual([])
  })

  it('refuses the agent-readable way: not connected, API source, missing capability', async () => {
    const pool = new ResourcesPool({ connectionNonBlocking: false });
    (pool as unknown as { servers: Map<string, FakeServer> }).servers.set('nores', {
      capabilities: { tools: {}, prompts: {} },
      resources: [[{ uri: 'nores://r/1' }]],
    })
    await pool.sync({ nores: httpAt('nores'), api: httpAt('api') }, {}, { leaserId: 'L' })

    await expect(pool.listResources('missing', 'L')).rejects.toThrow(/is not connected/)
    // 'api' has no scripted server, so its client carries tools only — the API-source shape.
    await expect(pool.listResources('api', 'L')).rejects.toThrow(/is an API source/)
    await expect(pool.listResources('nores', 'L')).rejects.toThrow(/did not declare the resources capability/)
  })
})

describe('McpClientPool.readResourceText (UB7.10 read guard)', () => {
  it('renders text contents as agent-ready text', async () => {
    const pool = new ResourcesPool({ connectionNonBlocking: false });
    (pool as unknown as { servers: Map<string, FakeServer> }).servers.set('docs', {
      capabilities: BOTH,
      read: (uri: string) => ({
        contents: [{ uri, mimeType: 'text/markdown', text: `# served ${uri}` }],
      }),
    })
    await pool.sync({ docs: httpAt('docs') }, {}, { leaserId: 'L' })

    expect(await pool.readResourceText('docs', 'docs://guides/start', 'L')).toBe('# served docs://guides/start')
  })

  it('describes a binary blob it cannot save (no session folder), instead of raw base64', async () => {
    const pool = new ResourcesPool({ connectionNonBlocking: false });
    (pool as unknown as { servers: Map<string, FakeServer> }).servers.set('bin', {
      capabilities: BOTH,
      read: (uri: string) => ({
        contents: [{ uri, mimeType: 'image/png', blob: 'aWNvbg==' }],
      }),
    })
    await pool.sync({ bin: httpAt('bin') }, {}, { leaserId: 'L' })

    const text = await pool.readResourceText('bin', 'bin://icon', 'L')
    expect(text).toContain('could not be saved')
    expect(text).not.toContain('aWNvbg==')
  })
})

/**
 * P3.344 — MCP resources on the pool surface, which is the CODEX arm.
 *
 * ## The measurement this closes
 *
 * Codex registers three model-facing resource tools — `list_mcp_resources`,
 * `list_mcp_resource_templates`, `read_mcp_resource` — whenever ANY MCP server
 * is configured: `openai/codex@rust-v0.148.0`,
 * `core/src/tools/spec_plan.rs::add_mcp_resource_tools`, whose whole gate is
 * `if context.mcp.has_servers()`. We always configure exactly one, this server,
 * as `[mcp_servers.sources]`. Before this file's subject existed, the pool
 * server declared `capabilities: { tools: … }` and registered ListTools and
 * CallTool only — so codex's `list_all_resources`
 * (`codex-mcp/src/connection_manager/resources.rs`) took the `-32601` back,
 * logged `warn!("Failed to list resources for MCP server …")` and dropped it,
 * and the model was handed an EMPTY resource list for every source the user had
 * connected. Not an absence it could see: a false negative it could not.
 *
 * That is why P4.6's rejection ("both other runtimes read MCP resources
 * natively") was true about the TOOL and false about the SUBJECT.
 *
 * Evidence tier for the codex claims here: STRONG — read from
 * `github.com/openai/codex` at the tag we ship, not from a page (AGENTS.md,
 * "the two runtimes need different evidence").
 *
 * ## What is pinned, and why each case is not vacuous
 *
 * (a) the list is served, slug-qualified, with the source's own uri;
 * (b) a read routes to the source that advertised the uri — with a second
 *     source connected, so a single-source rig cannot pass it by accident;
 * (c) a uri no leased source advertises is REFUSED, not guessed;
 * (d) the `resources` capability is declared even when nothing advertises one —
 *     the empty answer must be TRUE-empty, and a capability computed at the
 *     handshake could never grow (MCP revises capabilities with no
 *     notification, exactly as it does not revise `instructions`);
 * (e) `listChanged` is NOT claimed, because we emit no
 *     `notifications/resources/list_changed`;
 * (f) `resources/templates/list` stays METHOD-NOT-FOUND — the pool has no
 *     template channel, and an always-`[]` handler would manufacture the very
 *     false empty this row exists to remove;
 * (g) the leaser scopes the answer: a session sees its own leased sources'
 *     resources and not another session's.
 */
import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool, type McpOpenConnectionRequest } from '../mcp-pool.ts';
import { McpPoolServer } from '../pool-server.ts';
import type { McpResourceReadResult, PoolClient } from '../client.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';

const httpAt = (host: string): SdkMcpServerConfig => ({ type: 'http', url: `https://${host}.example.test/mcp` });
const tool = (name: string): Tool =>
  ({ name, description: `desc ${name}`, inputSchema: { type: 'object', properties: {} } } as Tool);

interface ScriptedResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * A pool whose connect is replaced wholesale so each slug's advertised
 * resources — and whether it advertises the capability at all — are under the
 * test's control. Same shape as `pool-server-instructions-refresh.test.ts`'s
 * `ScriptedPool`; no MCP server process is spawned by this suite.
 */
class ScriptedPool extends McpClientPool {
  readonly resources = new Map<string, ScriptedResource[]>();
  /** UB7.10 — per-slug advertised templates; absent = the source refuses (the -32601 shape). */
  readonly templates = new Map<string, Array<{ uriTemplate: string; name?: string }>>();

  protected override async openConnection({ slug }: McpOpenConnectionRequest): Promise<PoolClient> {
    const advertised = this.resources.get(slug);
    const templates = this.templates.get(slug);
    return {
      listTools: async () => [tool(slug)],
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      close: async () => {},
      // A source with no advertised resources gets NEITHER method, which is the
      // real shape: `PoolClient` declares both optional and the pool reads `[]`
      // for a client that has no `listResources`.
      ...(advertised === undefined ? {} : {
        // UB7.10 — the PoolClient member returns ONE PAGE now; this rig lists
        // one page and no cursor, which is the same shape a small real server
        // produces. The capability is declared (the resources methods exist on
        // this client only when the source advertises, matching a real server
        // that declares `resources` and publishes some).
        getServerCapabilities: () => ({ tools: {}, resources: {} }),
        listResources: async (): Promise<{ resources: ScriptedResource[] }> => ({ resources: advertised }),
        listResourceTemplates: templates === undefined
          ? async (): Promise<never> => { throw new Error('MCP error -32601: Method not found'); }
          : async (): Promise<{ resourceTemplates: Array<{ uriTemplate: string; name?: string }> }> => ({ resourceTemplates: templates }),
        readResource: async (uri: string): Promise<McpResourceReadResult> => ({
          contents: [{ uri, mimeType: 'text/plain', text: `${slug} served ${uri}` }],
        }),
      }),
    } as unknown as PoolClient;
  }
}

/** `contents[n].text` off the SDK's text|blob union, without widening the read. */
function textOf(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const text = (entry as Record<string, unknown>).text;
  return typeof text === 'string' ? text : undefined;
}

async function handshake(poolServer: McpPoolServer): Promise<Client> {
  const client = new Client({ name: 'pool-server-resources-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(poolServer.url), {
    requestInit: { headers: { authorization: `Bearer ${poolServer.bearerToken}` } },
  }));
  return client;
}

describe('the pool server answers codex\'s native resource tools (P3.344)', () => {
  it('(a,b,c) lists every leased source\'s resources and routes a read back to its own source', async () => {
    const pool = new ScriptedPool({ connectionNonBlocking: false });
    pool.resources.set('linear', [
      { uri: 'linear://issues/open', name: 'Open issues', description: 'Current sprint', mimeType: 'application/json' },
    ]);
    pool.resources.set('notion', [{ uri: 'notion://db/roadmap', name: 'Roadmap' }]);
    const poolServer = new McpPoolServer(pool, { leaserId: 'L' });
    await poolServer.start();
    await pool.sync({ linear: httpAt('linear'), notion: httpAt('notion') }, {}, { leaserId: 'L' });

    const client = await handshake(poolServer);
    try {
      const listed = await client.listResources();
      // The uri is the SOURCE's own — unrewritten, because a uri is the
      // resource's identity. The NAME carries the slug, the same flattening the
      // tool list does, because N sources are one server here.
      expect(listed.resources.map(resource => [resource.name, resource.uri])).toEqual([
        ['linear__Open issues', 'linear://issues/open'],
        ['notion__Roadmap', 'notion://db/roadmap'],
      ]);
      expect(listed.resources[0]?.description).toBe('Current sprint');
      expect(listed.resources[0]?.mimeType).toBe('application/json');

      // (b) Two sources are connected, so a handler that ignored the routing and
      // read from "the" client would have a 50% chance of being caught; the
      // assertion names WHICH source served it, so it is caught every time.
      const read = await client.readResource({ uri: 'notion://db/roadmap' });
      expect(textOf(read.contents[0])).toBe('notion served notion://db/roadmap');

      // (c) Not guessed at, and not answered empty either.
      await expect(client.readResource({ uri: 'linear://issues/closed' })).rejects.toThrow(
        /mcp-resource-not-listed/,
      );
    } finally {
      await client.close().catch(() => {});
      await poolServer.stop().catch(() => {});
    }
  });

  it('(d,e) declares the resources capability with no source advertising one, and never claims listChanged', async () => {
    const pool = new ScriptedPool({ connectionNonBlocking: false });
    // A connected source with NO resources: the difference between "nothing to
    // list" and "cannot list" is the whole point of the row.
    const poolServer = new McpPoolServer(pool, { leaserId: 'L' });
    await poolServer.start();
    await pool.sync({ quiet: httpAt('quiet') }, {}, { leaserId: 'L' });

    const client = await handshake(poolServer);
    try {
      const capabilities = client.getServerCapabilities();
      expect(capabilities?.resources).toEqual({});
      // Declaring `listChanged` would promise a notification we never send.
      expect((capabilities?.resources as { listChanged?: boolean } | undefined)?.listChanged).toBeUndefined();
      // Positive control that the rig is live rather than silently empty.
      expect(capabilities?.tools).toEqual({ listChanged: true });
      expect((await client.listResources()).resources).toEqual([]);
      expect(pool.getConnectedSlugs('L')).toEqual(['quiet']);
    } finally {
      await client.close().catch(() => {});
      await poolServer.stop().catch(() => {});
    }
  });

  it('(f, UB7.10) serves resources/templates/list from the source that advertises one, and answers TRUE-empty when none does', async () => {
    // UB7.10 closed P3.344's stated residue: the pool grew the template channel
    // (`PoolClient.listResourceTemplates`, the paginated
    // `McpClientPool.listResources`), so the handler is registered and a source
    // that REFUSES its templates (the `-32601` servers without any answer) is
    // degraded to none by the collection — an empty answer is TRUE-empty, not
    // the manufactured kind the old note warned about. The -32601-honest arm
    // lives at the POOL level now (mcp-pool-resources.test.ts: the refusal is
    // per source, agent-readable).
    const pool = new ScriptedPool({ connectionNonBlocking: false });
    pool.resources.set('linear', [{ uri: 'linear://issues/open', name: 'Open issues' }]);
    const poolServer = new McpPoolServer(pool, { leaserId: 'L' });
    await poolServer.start();
    await pool.sync({ linear: httpAt('linear') }, {}, { leaserId: 'L' });

    const client = await handshake(poolServer);
    try {
      // No scripted template member on the source: the collection degrades the
      // refusal to none, and the answer is an honest empty.
      expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);
      // Control on the same handshake: the sibling method IS still served.
      expect((await client.listResources()).resources).toHaveLength(1);
    } finally {
      await client.close().catch(() => {});
      await poolServer.stop().catch(() => {});
    }
  });

  it('(f2, UB7.10) flattens a template-advertising source under its slug', async () => {
    const pool = new ScriptedPool({ connectionNonBlocking: false });
    pool.resources.set('liza', [{ uri: 'liza://guides/start', name: 'start' }]);
    pool.templates.set('liza', [{ uriTemplate: 'liza://guides/{name}', name: 'guide' }]);
    const poolServer = new McpPoolServer(pool, { leaserId: 'L' });
    await poolServer.start();
    await pool.sync({ liza: httpAt('liza') }, {}, { leaserId: 'L' });

    const client = await handshake(poolServer);
    try {
      // The SAME flattening the resources list uses: N sources are one server,
      // so the name carries the slug. The uriTemplate stays the source's own.
      expect((await client.listResourceTemplates()).resourceTemplates).toEqual([
        { uriTemplate: 'liza://guides/{name}', name: 'liza__guide' },
      ]);
    } finally {
      await client.close().catch(() => {});
      await poolServer.stop().catch(() => {});
    }
  });

  it('(g) serves only the leaser\'s own sources when the server is session-scoped', async () => {
    const pool = new ScriptedPool({ connectionNonBlocking: false });
    pool.resources.set('linear', [{ uri: 'linear://issues/open', name: 'Open issues' }]);
    pool.resources.set('notion', [{ uri: 'notion://db/roadmap', name: 'Roadmap' }]);
    const poolServer = new McpPoolServer(pool, { leaserId: 'session-a' });
    await poolServer.start();
    await pool.sync({ linear: httpAt('linear') }, {}, { leaserId: 'session-a' });
    await pool.sync({ notion: httpAt('notion') }, {}, { leaserId: 'session-b' });

    const client = await handshake(poolServer);
    try {
      const listed = await client.listResources();
      expect(listed.resources.map(resource => resource.name)).toEqual(['linear__Open issues']);
      // The other session's source really is connected in the shared pool, so
      // the absence above is scoping and not a pool that never connected it.
      expect(pool.getConnectedSlugs('session-b')).toEqual(['notion']);
      // ...and its resource is not reachable by uri through this server either.
      await expect(client.readResource({ uri: 'notion://db/roadmap' })).rejects.toThrow(
        /mcp-resource-not-listed/,
      );
    } finally {
      await client.close().catch(() => {});
      await poolServer.stop().catch(() => {});
    }
  });

  it('names a uri two leased sources both advertise, and routes it deterministically', async () => {
    const lines: string[] = [];
    const pool = new ScriptedPool({ connectionNonBlocking: false });
    // The residue {@link McpPoolServer.publishedResources} records: codex hands
    // a read only (server, uri), so a collision cannot be addressed — only named.
    pool.resources.set('notion', [{ uri: 'file:///shared/notes.md', name: 'Notes' }]);
    pool.resources.set('drive', [{ uri: 'file:///shared/notes.md', name: 'Notes' }]);
    const poolServer = new McpPoolServer(pool, { leaserId: 'L', debug: msg => lines.push(msg) });
    await poolServer.start();
    await pool.sync({ notion: httpAt('notion'), drive: httpAt('drive') }, {}, { leaserId: 'L' });

    const client = await handshake(poolServer);
    try {
      const read = await client.readResource({ uri: 'file:///shared/notes.md' });
      // Alphabetically first, stated in the docblock and pinned here so the
      // choice cannot drift into "whichever connected first".
      expect(textOf(read.contents[0])).toBe('drive served file:///shared/notes.md');
      const collision = lines.filter(line => line.includes('is advertised by'));
      expect(collision).toHaveLength(1);
      expect(collision[0]).toContain('drive, notion');
      expect(collision[0]).toContain('not reachable');
    } finally {
      await client.close().catch(() => {});
      await poolServer.stop().catch(() => {});
    }
  });
});

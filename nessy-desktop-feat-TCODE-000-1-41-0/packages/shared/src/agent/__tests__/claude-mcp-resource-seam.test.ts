/**
 * P6.139 — MCP resources reach a claude-runtime model, through the one SDK seam
 * that can carry them.
 *
 * Claude's own `ListMcpResources` / `ReadMcpResource` are in the `claude_code`
 * preset and were always callable; they answered EMPTY because no server we
 * registered declared any resources. Every source proxy is built by
 * `createSdkMcpServer({ … tools })`, whose option type is tools-only — and
 * P6.25 read that as `cannot-at-this-seam`. That verdict was derived from the
 * FACTORY and is refuted by the SDK's own config union:
 * `McpSdkServerConfigWithInstance = McpSdkServerConfig & { instance: McpServer }`
 * (`sdk.d.ts:1063`), reachable through `McpServerConfig` (`:1070`). The factory
 * cannot express resources; the OPTION can, because it takes a whole server.
 * `mcp-context-runtime-reach.test.ts` (c) already pinned both halves of that
 * correction and stays green — it measures the SDK's types, not our code.
 *
 * Native-first: (1) the runtime already has the mechanism, two preset tools,
 * already on — the SERVER half was missing; (2) the host cannot supply it
 * uniformly, because Pi reaches resources through its own session tools and
 * codex through the HTTP pool surface, two different seams. So step 1 for the
 * third runtime, and deliberately over the SAME collection and routing the
 * HTTP surface uses, extracted rather than re-derived.
 *
 * What this suite cannot settle, recorded as a null rather than guessed:
 * whether the CLOSED `claude` binary actually issues `resources/list` to an
 * `sdk`-type server once its instance declares the capability. That is CDP case
 * MCP-R1 arm 1 on a packaged build, with the codex arm (4/4 PASS) as the
 * control. Until then the claude arm is a hypothesis about the binary — but a
 * hypothesis whose SERVER half is now measured to answer correctly.
 */
import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool, type McpOpenConnectionRequest } from '../../mcp/mcp-pool.ts';
import {
  collectPooledResources,
  createPooledResourceSdkServer,
  POOLED_RESOURCE_SERVER_NAME,
  routePooledResourceUri,
} from '../../mcp/pool-server.ts';
import { createSourceProxyServers } from '../claude-agent.ts';
import type { McpResourceReadResult, PoolClient } from '../../mcp/client.ts';
import type { SdkMcpServerConfig } from '../backend/types.ts';

const httpAt = (host: string): SdkMcpServerConfig => ({ type: 'http', url: `https://${host}.example.test/mcp` });
const stubTool = (name: string): Tool =>
  ({ name, description: `desc ${name}`, inputSchema: { type: 'object', properties: {} } } as Tool);

interface ScriptedResource { uri: string; name: string; description?: string; mimeType?: string }

/**
 * Same `ScriptedPool` shape as `mcp/__tests__/pool-server-resources.test.ts`,
 * so the claude arm and the codex arm are driven by one stub rather than two
 * that could disagree about what a source advertises. No MCP process is spawned.
 */
class ScriptedPool extends McpClientPool {
  readonly resources = new Map<string, ScriptedResource[]>();

  protected override async openConnection({ slug }: McpOpenConnectionRequest): Promise<PoolClient> {
    const advertised = this.resources.get(slug);
    return {
      listTools: async () => [stubTool(slug)],
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      close: async () => {},
      // A source with no advertised resources gets NEITHER method, which is the
      // real shape: `PoolClient` declares both optional.
      ...(advertised === undefined ? {} : {
        listResources: async () => advertised,
        readResource: async (uri: string): Promise<McpResourceReadResult> => ({
          contents: [{ uri, mimeType: 'text/plain', text: `${slug} served ${uri}` }],
        }),
      }),
    } as unknown as PoolClient;
  }
}

/** Drive the instance the way the CLI does — over a transport, not by calling handlers. */
async function connectTo(instance: Parameters<typeof handshake>[0]): Promise<Client> {
  return await handshake(instance);
}

async function handshake(instance: { connect: (t: InMemoryTransport) => Promise<void> }): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await instance.connect(serverSide);
  const client = new Client({ name: 'claude-resource-seam-test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

function textOf(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const text = (entry as Record<string, unknown>).text;
  return typeof text === 'string' ? text : undefined;
}

describe('the in-process resource server a claude-runtime session is given', () => {
  it('lists every leased source\'s resources and routes a read back to its own source', async () => {
    const pool = new ScriptedPool({ connectionNonBlocking: false });
    pool.resources.set('linear', [
      { uri: 'linear://issues/open', name: 'Open issues', description: 'Current sprint', mimeType: 'application/json' },
    ]);
    pool.resources.set('notion', [{ uri: 'notion://db/roadmap', name: 'Roadmap' }]);
    await pool.sync({ linear: httpAt('linear'), notion: httpAt('notion') }, {}, { leaserId: 'L' });

    const client = await connectTo(createPooledResourceSdkServer(pool, { leaserId: 'L' }).instance);
    const listed = await client.listResources();
    // The SAME `<slug>__<name>` flattening the HTTP surface uses: N sources
    // become ONE server, so without the slug the model cannot tell two
    // sources' resources apart.
    expect(listed.resources.map(r => r.name).sort()).toEqual(['linear__Open issues', 'notion__Roadmap']);
    expect(listed.resources.map(r => r.uri).sort()).toEqual(['linear://issues/open', 'notion://db/roadmap']);

    const read = await client.readResource({ uri: 'notion://db/roadmap' });
    expect(textOf(read.contents[0])).toBe('notion served notion://db/roadmap');
    await client.close();
  });

  it('declares the resources capability even when no source has one, so a later source is reachable', async () => {
    // The load-bearing half. Capabilities travel in the `initialize` result and
    // MCP has no notification that revises them, so a capability computed from
    // "does a leased source advertise resources RIGHT NOW" would be pinned at
    // the handshake and a source connecting afterwards could never be listed.
    // An empty list is TRUE-empty; a withheld capability is a resource that
    // exists and cannot be read.
    const pool = new ScriptedPool({ connectionNonBlocking: false });
    await pool.sync({ linear: httpAt('linear') }, {}, { leaserId: 'L' });

    const client = await connectTo(createPooledResourceSdkServer(pool, { leaserId: 'L' }).instance);
    expect(client.getServerCapabilities()?.resources).toBeDefined();
    // …and `listChanged` is NOT claimed, because we emit no such notification.
    expect(client.getServerCapabilities()?.resources?.listChanged).toBeUndefined();
    expect((await client.listResources()).resources).toEqual([]);
    await client.close();
  });

  it('refuses a read of a uri no leased source advertises', async () => {
    const pool = new ScriptedPool({ connectionNonBlocking: false });
    pool.resources.set('linear', [{ uri: 'linear://issues/open', name: 'Open issues' }]);
    await pool.sync({ linear: httpAt('linear') }, {}, { leaserId: 'L' });

    const client = await connectTo(createPooledResourceSdkServer(pool, { leaserId: 'L' }).instance);
    await expect(client.readResource({ uri: 'linear://issues/closed' })).rejects.toThrow(
      /mcp-resource-not-listed/,
    );
    await client.close();
  });

  it('scopes the answer to the session\'s own lease', async () => {
    const pool = new ScriptedPool({ connectionNonBlocking: false });
    pool.resources.set('linear', [{ uri: 'linear://issues/open', name: 'Open issues' }]);
    pool.resources.set('notion', [{ uri: 'notion://db/roadmap', name: 'Roadmap' }]);
    await pool.sync({ linear: httpAt('linear') }, {}, { leaserId: 'A' });
    await pool.sync({ notion: httpAt('notion') }, {}, { leaserId: 'B' });

    const a = await connectTo(createPooledResourceSdkServer(pool, { leaserId: 'A' }).instance);
    expect((await a.listResources()).resources.map(r => r.uri)).toEqual(['linear://issues/open']);
    await a.close();
  });
});

describe('the shared collection and routing, used by BOTH resource surfaces', () => {
  it('routes a colliding uri to the alphabetically-first slug and says so', async () => {
    // Extracted rather than copied: two derivations of "which resource belongs
    // to which source" is exactly how the HTTP surface and this one would come
    // to disagree, and the disagreement would only show as a read landing on
    // the wrong source.
    const heard: string[] = [];
    const slug = routePooledResourceUri(
      [
        { sourceSlug: 'notion', uri: 'file:///shared/notes.md', name: 'Notes' },
        { sourceSlug: 'linear', uri: 'file:///shared/notes.md', name: 'Notes' },
      ],
      'file:///shared/notes.md',
      message => heard.push(message),
    );
    expect(slug).toBe('linear');
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain('file:///shared/notes.md');
    // A uri advertised once says nothing — the negative that keeps the line
    // from being noise on every read.
    const quiet: string[] = [];
    expect(routePooledResourceUri(
      [{ sourceSlug: 'linear', uri: 'linear://x', name: 'X' }],
      'linear://x',
      message => quiet.push(message),
    )).toBe('linear');
    expect(quiet).toEqual([]);
  });

  it('falls back to the uri when a source advertises a resource with no name', async () => {
    const pool = new ScriptedPool({ connectionNonBlocking: false });
    pool.resources.set('linear', [{ uri: 'linear://issues/open' } as ScriptedResource]);
    await pool.sync({ linear: httpAt('linear') }, {}, { leaserId: 'L' });
    const collected = await collectPooledResources(pool, 'L');
    expect(collected).toEqual([
      { sourceSlug: 'linear', uri: 'linear://issues/open', name: 'linear://issues/open' },
    ]);
  });
});

describe('the wiring — a claude turn is actually given the server', () => {
  it('registers the resource server beside the per-source tool proxies', async () => {
    const pool = new ScriptedPool({ connectionNonBlocking: false });
    pool.resources.set('linear', [{ uri: 'linear://issues/open', name: 'Open issues' }]);
    await pool.sync({ linear: httpAt('linear') }, {}, { leaserId: 'L' });

    const servers = createSourceProxyServers(pool, { leaserId: 'L' });
    // The per-source tool proxy is still there — this row must not have moved it.
    expect(servers['linear']).toBeDefined();
    // …and the resource server is beside it, under the one shared constant.
    const resourceServer = servers[POOLED_RESOURCE_SERVER_NAME];
    expect(resourceServer).toBeDefined();
    expect(resourceServer?.type).toBe('sdk');
    expect(resourceServer?.instance).toBeDefined();
  });

  it('registers it even for a lease whose sources advertise nothing', async () => {
    // Unconditional registration, for the capability reason above: a session
    // that starts with no resource-bearing source must still be able to read
    // one that connects mid-session.
    const pool = new ScriptedPool({ connectionNonBlocking: false });
    await pool.sync({ linear: httpAt('linear') }, {}, { leaserId: 'L' });
    expect(createSourceProxyServers(pool, { leaserId: 'L' })[POOLED_RESOURCE_SERVER_NAME]).toBeDefined();
  });
});

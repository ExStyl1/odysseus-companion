/**
 * P3.248 — a server's instructions are pinned at the subprocess handshake and
 * there is no protocol refresh, so what the model is told about a server can be
 * older than the server. The asymmetry is the row's point, not the window.
 *
 * NATIVE-FIRST WAS ASKED, AND THE ANSWER IS NO ON BOTH HALVES — measured, not
 * assumed, and the denominator rule applies: the vendored SDK's own type module
 * is what "the complete set of notifications" means, and a test below reads it
 * rather than trusting this sentence. `instructions` travel in the `initialize`
 * result; nothing revises them. Nor can the server force a re-handshake: the
 * SDK's `StreamableHTTPClientTransport` does not re-initialize on a 404, so
 * terminating the protocol session would break the subprocess rather than
 * refresh it.
 *
 * So the host does the two things it can, which is the native-first rule's
 * second half — make the residue smaller, and make what remains HONEST:
 *
 * 1. The handshake is a point of need, so it settles the pool first (shared
 *    with P3.247). Every source that was ASKED for by then contributes its
 *    prose, instead of whichever ones happened to have finished connecting.
 * 2. A composition that changes after a subprocess has handshaken says so, by
 *    slug, so an operator can see that the model's description is stale.
 *
 * The residue that remains, stated: a source added, dropped or rewritten after
 * the handshake is not re-announced. On codex that interval ends at one of its
 * own re-handshake triggers (`Op::RefreshMcpServers`, an auth change, a
 * settings change — `openai/codex@rust-v0.148.0`, `McpRuntime::replace`,
 * which reuses a connection only when its `McpServerConnectionIdentity`
 * matches).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool, type McpOpenConnectionRequest } from '../mcp-pool.ts';
import { McpPoolServer } from '../pool-server.ts';
import type { PoolClient } from '../client.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';

const HTTP: SdkMcpServerConfig = { type: 'http', url: 'https://mcp.example.test/mcp' };
const tool = (name: string): Tool =>
  ({ name, description: `desc ${name}`, inputSchema: { type: 'object', properties: {} } } as Tool);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** How long the fake server takes to hand back a connection. */
const CONNECT_WORK_MS = 300;

/**
 * A pool whose connect is replaced wholesale, with per-slug delay and per-slug
 * instructions, so the prose a source contributes and the moment it becomes
 * available are both under the test's control.
 */
class ScriptedPool extends McpClientPool {
  readonly instructions = new Map<string, string>();
  readonly delays = new Map<string, number>();

  protected override async openConnection({ slug }: McpOpenConnectionRequest): Promise<PoolClient> {
    const delay = this.delays.get(slug) ?? 0;
    if (delay > 0) await sleep(delay);
    const prose = this.instructions.get(slug);
    return {
      listTools: async () => [tool(slug)],
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      close: async () => {},
      ...(prose === undefined ? {} : { getInstructions: () => prose }),
    } as unknown as PoolClient;
  }
}

async function handshake(poolServer: McpPoolServer): Promise<Client> {
  const client = new Client({ name: 'instructions-refresh-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(poolServer.url), {
    requestInit: { headers: { authorization: `Bearer ${poolServer.bearerToken}` } },
  }));
  return client;
}

describe('the handshake composes instructions from a SETTLED pool (P3.248 + P3.247)', () => {
  it('a source still connecting when setup returned still introduces itself', async () => {
    const pool = new ScriptedPool({ connectionNonBlocking: false });
    pool.instructions.set('linear', 'Search before creating.');
    pool.delays.set('linear', CONNECT_WORK_MS);
    const poolServer = new McpPoolServer(pool, { leaserId: 'L' });
    await poolServer.start();
    // The session-setup shape after P3.247: the reconcile is queued and not
    // awaited. Instructions ride the `initialize` result and nothing revises
    // them, so a handshake that raced this connect would have pinned "no
    // instructions" for the subprocess's whole life.
    void pool.sync({ linear: HTTP }, {}, { leaserId: 'L' }).catch(() => {});

    const client = await handshake(poolServer);
    try {
      expect(client.getInstructions()).toBe('## linear\n\nSearch before creating.');
    } finally {
      await client.close().catch(() => {});
      await poolServer.stop().catch(() => {});
    }
  });
});

describe('a composition that changes after the handshake is NAMED, because it cannot be sent', () => {
  it('reports the slug that became available, and says why the model will not see it', async () => {
    const lines: string[] = [];
    const pool = new ScriptedPool({ connectionNonBlocking: false });
    pool.instructions.set('linear', 'Search before creating.');
    pool.instructions.set('notion', 'Prefer database queries.');
    const poolServer = new McpPoolServer(pool, { leaserId: 'L', debug: msg => lines.push(msg) });
    await poolServer.start();
    await pool.sync({ linear: HTTP }, {}, { leaserId: 'L' });

    const client = await handshake(poolServer);
    try {
      expect(client.getInstructions()).toBe('## linear\n\nSearch before creating.');

      // A second source joins the leased set mid-session — the ordinary case,
      // and the one MCP has no way to announce.
      await pool.sync({ linear: HTTP, notion: { ...HTTP, url: 'https://notion.example.test/mcp' } }, {}, { leaserId: 'L' });

      const drift = lines.filter(line => line.includes('Source instructions changed'));
      expect(drift).toHaveLength(1);
      expect(drift[0]).toContain('now available: notion');
      // The sentence has to carry the CONSEQUENCE, not just the event — an
      // operator reading this needs to know the model is working from the older
      // description until the runtime re-handshakes.
      expect(drift[0]).toContain('initialize result');
      // And the client really is still holding the old one: this is a report,
      // not a repair.
      expect(client.getInstructions()).toBe('## linear\n\nSearch before creating.');
    } finally {
      await client.close().catch(() => {});
      await poolServer.stop().catch(() => {});
    }
  });

  it('says nothing when a verdict moves without changing the composition', async () => {
    const lines: string[] = [];
    const pool = new ScriptedPool({ connectionNonBlocking: false });
    pool.instructions.set('linear', 'Search before creating.');
    const poolServer = new McpPoolServer(pool, { leaserId: 'L', debug: msg => lines.push(msg) });
    await poolServer.start();
    await pool.sync({ linear: HTTP }, {}, { leaserId: 'L' });
    const client = await handshake(poolServer);
    try {
      // A source with no instructions of its own joins. The verdict changes —
      // a new connection is in the signature — and the composition does not.
      await pool.sync({ linear: HTTP, quiet: { ...HTTP, url: 'https://quiet.example.test/mcp' } }, {}, { leaserId: 'L' });

      expect(lines.filter(line => line.includes('Source instructions changed'))).toEqual([]);
      // Positive control on the same rig: the second source really did connect,
      // so the silence is a comparison finding nothing and not a listener that
      // never ran.
      expect(pool.getConnectedSlugs('L').sort()).toEqual(['linear', 'quiet']);
    } finally {
      await client.close().catch(() => {});
      await poolServer.stop().catch(() => {});
    }
  });

  it('says nothing before any subprocess has handshaken', async () => {
    const lines: string[] = [];
    const pool = new ScriptedPool({ connectionNonBlocking: false });
    pool.instructions.set('linear', 'Search before creating.');
    const poolServer = new McpPoolServer(pool, { leaserId: 'L', debug: msg => lines.push(msg) });
    await poolServer.start();
    try {
      // Nothing has been told anything yet, so nothing can be stale. Warning
      // here would train an operator to ignore the line that matters.
      await pool.sync({ linear: HTTP }, {}, { leaserId: 'L' });
      expect(lines.filter(line => line.includes('Source instructions changed'))).toEqual([]);
      expect(pool.getInstructions('linear', 'L')).toBe('Search before creating.');
    } finally {
      await poolServer.stop().catch(() => {});
    }
  });
});

describe('why this is a report and not a refresh — the denominator, read rather than claimed', () => {
  it('the vendored MCP SDK declares no notification that revises instructions', async () => {
    // AGENTS.md's membership rule: for "what is the complete set of X?", the
    // vendored bundle is the denominator. So this reads the SDK's own type
    // module instead of trusting a sentence in a docblock.
    const types = readFileSync(
      new URL('../../../../../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js', import.meta.url),
      'utf8',
    );
    const methods = [...new Set(
      [...types.matchAll(/['"](notifications\/[a-z/_]+)['"]/g)].map(match => match[1] as string),
    )];

    // Positive control: the probe reads the file and finds the notification we
    // DO use, so an empty instructions result below is an absence and not a
    // regex that matches nothing.
    expect(methods).toContain('notifications/tools/list_changed');
    expect(methods.filter(method => method.includes('instruction'))).toEqual([]);
  });

  it('and `instructions` really is an initialize-result field, so there is nowhere else to put it', async () => {
    const pool = new ScriptedPool({ connectionNonBlocking: false });
    pool.instructions.set('linear', 'Search before creating.');
    const poolServer = new McpPoolServer(pool, { leaserId: 'L' });
    await poolServer.start();
    await pool.sync({ linear: HTTP }, {}, { leaserId: 'L' });
    const client = await handshake(poolServer);
    try {
      // The SDK client exposes it only as the handshake result it cached, which
      // is the whole shape of the row: one delivery, at one moment.
      expect(client.getInstructions()).toBe('## linear\n\nSearch before creating.');
      expect(client.getServerVersion()?.name).toBe('nessy-pool-proxy');
    } finally {
      await client.close().catch(() => {});
      await poolServer.stop().catch(() => {});
    }
  });
});

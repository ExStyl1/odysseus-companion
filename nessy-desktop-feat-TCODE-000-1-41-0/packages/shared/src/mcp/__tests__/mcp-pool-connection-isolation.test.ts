/**
 * P3.371 — how many sessions share ONE MCP transport, and the two things that
 * decision breaks if it is taken naively.
 *
 * ## The measurement
 *
 * `mcpConnectionKey` is `sha256(stableJson(config))` with no leaser term, and it
 * is what the three reuse sites compare, so two sessions in one workspace whose
 * materialized config is byte-identical share ONE transport, ONE `initialize`,
 * ONE `Mcp-Session-Id`, and every tool call from both rides it. Neither
 * `mcp.md` nor codex's pages state a sharing radius, so this is a
 * transparent-and-simple decision: the shared default is kept (it is what
 * shipped, and the alternative costs one connection per session per server —
 * case (a) measures exactly that), the alternative is an operator lever
 * (`NESSY_MCP_CONNECTION_ISOLATION=per-leaser`), and the case the digest cannot
 * see is NAMED.
 *
 * ## The auth half, which is the part a config digest is blind to
 *
 * Static `headers` are IN the config, so two sessions with different static
 * credentials already split the key — case (c) is that control, and without it
 * "the digest cannot see credentials" would be too strong. A `headersHelper` is
 * a COMMAND: the digest covers `{command, cwd?, pluginRoot?}` and never what it
 * returns, deliberately, so reconnects keep their identity. Two sessions
 * declaring the same helper therefore share one connection carrying whichever
 * token resolved first. Case (d) pins the diagnostic that says so, including
 * that it names the lever — a diagnostic an operator cannot act on is a
 * different kind of silence.
 *
 * ## The trap
 *
 * The durable tool-descriptor store is keyed by the SAME connection key, while a
 * session's leaser id is fresh per setup. Appending the leaser term naively
 * gives every isolated session a permanent descriptor-cache MISS and one record
 * per session per server. Case (b) pins the split: config hash for the STORE,
 * leaser term only for the CONNECTION. The store is separately CAPPED since
 * `DA3.9` (`TOOL_DESCRIPTOR_STORE_MAX_RECORDS`), so the failure mode of getting
 * this wrong is a permanent cache miss rather than a directory that grows
 * forever — the miss is still the whole point of the case.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool, toolDescriptorStoreKey, type McpOpenConnectionRequest } from '../mcp-pool.ts';
import type { ToolDescriptorStore } from '../tool-descriptor-store.ts';
import type { PoolClient } from '../client.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';

const HTTP: SdkMcpServerConfig = { type: 'http', url: 'https://mcp.example.test/mcp' };
const SSE: SdkMcpServerConfig = { type: 'sse', url: 'https://mcp.example.test/sse' };
const WS: SdkMcpServerConfig = { type: 'ws', url: 'wss://mcp.example.test/ws' };
const STDIO: SdkMcpServerConfig = { type: 'stdio', command: '/usr/bin/true' };
const TOOL: Tool = { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } } as Tool;

function memoryStore(seed: Record<string, Tool[]> = {}): ToolDescriptorStore & { written: Record<string, Tool[]> } {
  const written: Record<string, Tool[]> = {};
  return {
    written,
    read: key => seed[key] ?? written[key],
    write: (key, tools) => { written[key] = [...tools]; },
  };
}

/**
 * A REAL MCP server over a REAL Streamable HTTP transport, whose only tool
 * answers WHICH TRANSPORT the call arrived on.
 *
 * DA3.8 — this fixture exists because every other pool in this file replaces the
 * pool's connect path with a fake one, and that replacement is what made the
 * suite structurally unable to see the defect it was written beside (the
 * AGENTS.md planted-collaborator class: a rig that supplies a collaborator the
 * production path does not have). The production connect path computed the
 * isolated key and then handed `registerClient` only `(slug, client, config)`,
 * so the client, the tool cache, the proxy routes and the slug map were filed
 * under the SHARED identity while the reconcile, `clients.has`,
 * `dispatchElicitation` and `activeConfigs` all used the isolated one. A fixture
 * that replaces that path cannot reach the offending line at all. These two
 * cases drive the real one, over a real transport, with a real `callTool`.
 *
 * The tool returns a per-CONNECTION token, so "did session-b reach its own
 * transport" is answered by the server rather than by a key comparison: a key
 * comparison is exactly what passed while the posture was broken.
 */
function startTransportNamingServer(): { http: HttpServer; port: number } {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  let connections = 0;

  const buildServer = (): Server => {
    const token = `connection-${++connections}`;
    const server = new Server(
      { name: 'transport-naming-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{
        name: 'whoami',
        description: 'Names the transport this call arrived on.',
        inputSchema: { type: 'object' as const, properties: {} },
      }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: 'text' as const, text: token }],
    }));
    return server;
  };

  const http = createServer(async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const existing = transports.get(sessionId);
      if (!existing) {
        res.writeHead(404).end();
        return;
      }
      await existing.handleRequest(req, res);
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: id => { transports.set(id, transport); },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) transports.delete(id);
    };
    await buildServer().connect(transport);
    await transport.handleRequest(req, res);
  });
  http.listen(0, '127.0.0.1');
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { http, port };
}

const liveServer = startTransportNamingServer();
afterAll(() => { liveServer.http.close(); });

const LIVE = (): SdkMcpServerConfig => ({
  type: 'http',
  url: `http://127.0.0.1:${liveServer.port}/mcp`,
});
const WHOAMI = 'mcp__box__whoami';

/**
 * Counts transports.
 *
 * `DA3.6`: the override is {@link McpClientPool.openConnection}, which RETURNS a
 * client and never files it, so there is no connection key for a fixture to
 * forward or to drop. It used to override `connect(slug, config, key?)` and
 * forward the key by hand — a contract prose asked for and 28 of 31 override
 * sites did not keep.
 */
class CountingPool extends McpClientPool {
  readonly connects: string[] = [];

  protected override async openConnection({ slug }: McpOpenConnectionRequest): Promise<PoolClient> {
    this.connects.push(slug);
    return {
      listTools: async () => [TOOL],
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      close: async () => {},
    } as unknown as PoolClient;
  }
}

describe('MCP connection sharing radius (P3.371)', () => {
  it('(a) shares one transport across sessions under the shared posture, and costs one per session under the lever', async () => {
    // `shared` is NAMED rather than left implicit, for the same reason as cases
    // (b), (c) and (d): this arm IS the shared posture, and a case that inherits
    // the pool default measures whatever the default happens to be on the day
    // rather than the thing it was written to price. What the default is at any
    // given moment is case (f)'s subject, not this one's.
    const shared = new CountingPool({ connectionNonBlocking: false, connectionIsolation: 'shared' });
    await shared.sync({ gh: HTTP }, {}, { leaserId: 'session-a' });
    await shared.sync({ gh: HTTP }, {}, { leaserId: 'session-b' });
    await shared.sync({ gh: HTTP }, {}, { leaserId: 'session-c' });
    // The measurement the decision rests on: three sessions, ONE connection.
    expect(shared.connects).toEqual(['gh']);
    expect(shared.connectionKeyForDesired('gh', 'session-a'))
      .toBe(shared.connectionKeyForDesired('gh', 'session-b')!);

    const isolated = new CountingPool({ connectionNonBlocking: false, connectionIsolation: 'per-leaser' });
    await isolated.sync({ gh: HTTP }, {}, { leaserId: 'session-a' });
    await isolated.sync({ gh: HTTP }, {}, { leaserId: 'session-b' });
    await isolated.sync({ gh: HTTP }, {}, { leaserId: 'session-c' });
    // ...and the price of the alternative, stated as a number rather than as a
    // worry: one connection per session per server.
    expect(isolated.connects).toEqual(['gh', 'gh', 'gh']);
    expect(isolated.connectionKeyForDesired('gh', 'session-a'))
      .not.toBe(isolated.connectionKeyForDesired('gh', 'session-b')!);
    // Each session's own connection really is usable — the assertion that a
    // dropped key would fail, where a key comparison alone would not.
    expect(isolated.isConnected('gh', 'session-b')).toBe(true);
    expect(isolated.getTools('gh', 'session-c')).toEqual([TOOL]);
  });

  it('(b) THE TRAP: the durable descriptor store stays keyed by the config, not by the session', async () => {
    const isolatedA = new CountingPool({ connectionNonBlocking: false, connectionIsolation: 'per-leaser' });
    await isolatedA.sync({ gh: HTTP }, {}, { leaserId: 'session-a' });
    const isolatedKeyA = isolatedA.connectionKeyForDesired('gh', 'session-a')!;

    // `shared` is named rather than left implicit, for the same reason as cases
    // (a), (c) and (d): this half of the comparison IS the shared posture, and a
    // case that inherits the pool default measures whatever the default happens
    // to be on the day rather than the thing it was written to price.
    const sharedPool = new CountingPool({ connectionNonBlocking: false, connectionIsolation: 'shared' });
    await sharedPool.sync({ gh: HTTP }, {}, { leaserId: 'session-a' });
    const sharedKey = sharedPool.connectionKeyForDesired('gh', 'session-a')!;

    // The identities differ — that is the point of the lever...
    expect(isolatedKeyA).not.toBe(sharedKey);
    // ...and they collapse to ONE durable key, which is the point of the split.
    expect(toolDescriptorStoreKey(isolatedKeyA)).toBe(sharedKey);
    expect(toolDescriptorStoreKey(sharedKey)).toBe(sharedKey);

    // End to end: a record written under the shared posture is HYDRATED by an
    // isolated session with a brand-new leaser id. Naive appending would have
    // made this a permanent miss, and every isolated session would spend a
    // record of the store's DA3.9 cap on a key nothing will ever read again.
    const store = memoryStore({ [sharedKey]: [TOOL] });
    const cold = new McpClientPool({ toolDescriptorStore: store, connectionIsolation: 'per-leaser' });
    await cold.sync({ gh: HTTP }, {}, { leaserId: 'session-freshly-minted' });
    expect(cold.isConnected('gh', 'session-freshly-minted')).toBe(false);
    expect(cold.getTools('gh', 'session-freshly-minted')).toEqual([TOOL]);

    // ...and the WRITE lands on the durable key too, so an isolated run does not
    // grow a second record beside the one it just read.
    const writer = new CountingPool({ toolDescriptorStore: store, connectionIsolation: 'per-leaser', connectionNonBlocking: false });
    await writer.sync({ gh: HTTP }, {}, { leaserId: 'another-fresh-session' });
    expect(Object.keys(store.written)).toEqual([sharedKey]);
  });

  it('(c) CONTROL: a static credential DOES split the key, so the blind spot is the helper and not headers as such', async () => {
    // Forced shared, so the ONLY thing that can split these two keys is the
    // credential — and named rather than inherited for case (b)'s reason: under
    // any posture that isolates HTTP per leaser these two keys split anyway and
    // this case would pass while measuring nothing.
    const pool = new CountingPool({ connectionNonBlocking: false, connectionIsolation: 'shared' });
    await pool.sync({ gh: { ...HTTP, headers: { authorization: 'Bearer alpha' } } }, {}, { leaserId: 'session-a' });
    await pool.sync({ gh: { ...HTTP, headers: { authorization: 'Bearer beta' } } }, {}, { leaserId: 'session-b' });
    expect(pool.connects).toEqual(['gh', 'gh']);
    expect(pool.connectionKeyForDesired('gh', 'session-a'))
      .not.toBe(pool.connectionKeyForDesired('gh', 'session-b')!);
  });

  it('(d) NAMES a helper-headed connection two sessions share, once, and names the lever', async () => {
    const lines: string[] = [];
    const helper: SdkMcpServerConfig = { ...HTTP, headersHelper: { command: 'print-token' } };
    // Forced shared, and named rather than inherited for case (b)'s reason: the
    // whole case is about two sessions SHARING one helper-headed connection,
    // which no posture that isolates HTTP per leaser would do. Case (g) is the
    // same report on a transport `by-transport` still shares.
    const pool = new CountingPool({
      connectionNonBlocking: false,
      connectionIsolation: 'shared',
      debug: message => lines.push(message),
    });

    await pool.sync({ gh: helper }, {}, { leaserId: 'session-a' });
    // One session sharing nothing says nothing: a line here would train an
    // operator to ignore the line that matters.
    expect(lines.filter(line => line.includes('sessions share ONE connection'))).toEqual([]);

    await pool.sync({ gh: helper }, {}, { leaserId: 'session-b' });
    const named = lines.filter(line => line.includes('sessions share ONE connection'));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain('"gh"');
    expect(named[0]).toContain('headersHelper');
    expect(named[0]).toContain('NESSY_MCP_CONNECTION_ISOLATION=per-leaser');
    // The digest really did NOT split — the line reports a fact, not a worry.
    expect(pool.connects).toEqual(['gh']);

    // Once per connection, not once per sync.
    await pool.sync({ gh: helper }, {}, { leaserId: 'session-c' });
    expect(lines.filter(line => line.includes('sessions share ONE connection'))).toHaveLength(1);
  });

  it('(e) says nothing under the lever, because there is nothing shared to report', async () => {
    const lines: string[] = [];
    const helper: SdkMcpServerConfig = { ...HTTP, headersHelper: { command: 'print-token' } };
    const pool = new CountingPool({
      connectionNonBlocking: false,
      connectionIsolation: 'per-leaser',
      debug: message => lines.push(message),
    });
    await pool.sync({ gh: helper }, {}, { leaserId: 'session-a' });
    await pool.sync({ gh: helper }, {}, { leaserId: 'session-b' });
    expect(lines.filter(line => line.includes('sessions share ONE connection'))).toEqual([]);
    // Positive control on the same rig: both sessions really are here, each on
    // its own transport, so the silence is the report finding nothing to say.
    expect(pool.connects).toEqual(['gh', 'gh']);
  });

  it('(f) DA3.2: `by-transport` decides per transport — http/sse isolate, stdio/ws share', async () => {
    // Both arms on ONE pool, so the table is measured against itself rather than
    // against two differently-configured pools.
    //
    // `by-transport` is NAMED and is not the pool default: the default is still
    // `shared`. DA3.2 kept it there because making this the default was what
    // first exercised an isolated posture end to end and found it broken beyond
    // key computation; DA3.8 repaired that (cases (i)/(j) below), so the default
    // now stays for the ordinary reason on `SHARED_TRANSPORTS_DEFAULT` — the
    // cost of the alternative — rather than for a blocking one. What this case
    // pins is the granularity the lever gained.
    const pool = new CountingPool({ connectionNonBlocking: false, connectionIsolation: 'by-transport' });
    await pool.sync({ gh: HTTP, sse: SSE, local: STDIO, socket: WS }, {}, { leaserId: 'session-a' });
    await pool.sync({ gh: HTTP, sse: SSE, local: STDIO, socket: WS }, {}, { leaserId: 'session-b' });

    // The expensive half stays shared — one PROCESS, one socket, two sessions.
    expect(pool.connectionKeyForDesired('local', 'session-a'))
      .toBe(pool.connectionKeyForDesired('local', 'session-b')!);
    expect(pool.connectionKeyForDesired('socket', 'session-a'))
      .toBe(pool.connectionKeyForDesired('socket', 'session-b')!);
    // ...and the stream-stateful half does not.
    expect(pool.connectionKeyForDesired('gh', 'session-a'))
      .not.toBe(pool.connectionKeyForDesired('gh', 'session-b')!);
    expect(pool.connectionKeyForDesired('sse', 'session-a'))
      .not.toBe(pool.connectionKeyForDesired('sse', 'session-b')!);
    // Counted rather than inferred: 4 connects for session-a, then only the two
    // isolating transports connect again for session-b.
    expect(pool.connects).toEqual(['gh', 'sse', 'local', 'socket', 'gh', 'sse']);
    // Both isolated sessions really are usable — a dropped key is invisible to
    // a key comparison alone.
    expect(pool.isConnected('gh', 'session-b')).toBe(true);
    expect(pool.getTools('sse', 'session-b')).toEqual([TOOL]);

    // BOUNDARY, and the reason the two older spellings still exist: `shared`
    // (the pool default) takes the isolating half back, `per-leaser` takes the
    // shared half away.
    const forcedShared = new CountingPool({ connectionNonBlocking: false, connectionIsolation: 'shared' });
    await forcedShared.sync({ gh: HTTP }, {}, { leaserId: 'session-a' });
    await forcedShared.sync({ gh: HTTP }, {}, { leaserId: 'session-b' });
    expect(forcedShared.connects).toEqual(['gh']);

    const forcedIsolated = new CountingPool({ connectionNonBlocking: false, connectionIsolation: 'per-leaser' });
    await forcedIsolated.sync({ local: STDIO }, {}, { leaserId: 'session-a' });
    await forcedIsolated.sync({ local: STDIO }, {}, { leaserId: 'session-b' });
    expect(forcedIsolated.connects).toEqual(['local', 'local']);

    // The durable descriptor store is unmoved by any of it — the trap case (b)
    // pins, re-asserted on a transport `by-transport` isolates.
    expect(toolDescriptorStoreKey(pool.connectionKeyForDesired('gh', 'session-a')!))
      .toBe(forcedShared.connectionKeyForDesired('gh', 'session-a')!);
  });

  it('(g) DA3.2: the shared-helper diagnostic follows the transport, not the pool posture', async () => {
    // The report used to open with `connectionIsolation !== 'shared' -> return`,
    // a POOL-WIDE question about a fact that is per connection: under
    // `by-transport` it silences the report everywhere — including for `ws`,
    // which declares `headersHelper` in the config union and which
    // `by-transport` still shares. Measured on ONE `by-transport` pool: silent
    // for the isolating transport, spoken for the shared one.
    const lines: string[] = [];
    const pool = new CountingPool({
      connectionNonBlocking: false,
      connectionIsolation: 'by-transport',
      debug: message => lines.push(message),
    });
    const httpHelper: SdkMcpServerConfig = { ...HTTP, headersHelper: { command: 'print-token' } };
    const wsHelper: SdkMcpServerConfig = { ...WS, headersHelper: { command: 'print-token' } };

    await pool.sync({ gh: httpHelper, socket: wsHelper }, {}, { leaserId: 'session-a' });
    await pool.sync({ gh: httpHelper, socket: wsHelper }, {}, { leaserId: 'session-b' });

    const named = lines.filter(line => line.includes('sessions share ONE connection'));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain('"socket"');
    expect(named[0]).not.toContain('"gh"');
  });

  it.each([
    ['per-leaser'],
    ['by-transport'],
  ] as const)('(i) DA3.8: under `%s` each session CALLS ITS OWN transport, on the real connect path', async posture => {
    const pool = new McpClientPool({ connectionNonBlocking: false, connectionIsolation: posture });
    await pool.sync({ box: LIVE() }, {}, { leaserId: 'session-a' });
    await pool.sync({ box: LIVE() }, {}, { leaserId: 'session-b' });

    // The keys split — which is all the rest of this file could ever check.
    expect(pool.connectionKeyForDesired('box', 'session-a'))
      .not.toBe(pool.connectionKeyForDesired('box', 'session-b')!);

    // ...and the connections are REACHABLE, which is the half that was broken:
    // a real tool call, answered by the server, on each session's own transport.
    const a = await pool.callTool(WHOAMI, {}, undefined, { leaserId: 'session-a' });
    const b = await pool.callTool(WHOAMI, {}, undefined, { leaserId: 'session-b' });

    // Before the repair BOTH of these were `{ isError: true, content: 'Tool not
    // available in this session' }`: the client was filed under the shared key
    // and `resolveProxyRoute` looked it up under the isolated one.
    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    expect(a.content).not.toBe(b.content);
    expect(String(a.content)).toMatch(/^connection-\d+$/);
    // Stable, not merely different: a second call from the same session rides
    // the same transport rather than opening a third one.
    expect((await pool.callTool(WHOAMI, {}, undefined, { leaserId: 'session-a' })).content)
      .toBe(a.content);

    await pool.disconnectAll();
  });

  it('(j) CONTROL for (i): under `shared` the same two sessions answer from ONE transport', async () => {
    // Without this arm, case (i) would pass on a fixture that simply minted a
    // fresh token per CALL — the difference between the two answers would prove
    // nothing about transports. Same fixture, same calls, one connection.
    const pool = new McpClientPool({ connectionNonBlocking: false, connectionIsolation: 'shared' });
    await pool.sync({ box: LIVE() }, {}, { leaserId: 'session-a' });
    await pool.sync({ box: LIVE() }, {}, { leaserId: 'session-b' });

    expect(pool.connectionKeyForDesired('box', 'session-a'))
      .toBe(pool.connectionKeyForDesired('box', 'session-b')!);

    const a = await pool.callTool(WHOAMI, {}, undefined, { leaserId: 'session-a' });
    const b = await pool.callTool(WHOAMI, {}, undefined, { leaserId: 'session-b' });
    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    expect(a.content).toBe(b.content);

    await pool.disconnectAll();
  });

  describe('(h) DA3.3: a credential-only config change MUST split the pool key', () => {
    // The invariant holds BY CONSTRUCTION — the key is a sha256 over the WHOLE
    // config through a stable-JSON normaliser — so this table is a guard against
    // a future refactor to a hand-written projection of "the fields that
    // matter", which is exactly how the reference acquired the bug its own
    // canonicaliser records by name.
    //
    // Every row is built through ONE isolation posture (`shared`), because the
    // key gained an optional fourth element: comparing a three-element key with
    // a four-element one passes for the wrong reason.
    //
    // The fields are the ones that EXIST in `SdkMcpServerConfig`. The four OAuth
    // names the row was written from are the reference's: `McpOAuthConfig`
    // (`packages/shared/src/agent/backend/types.ts`) carries an auth-server
    // metadata URL and scopes, and its own docblock says neither is ever a
    // secret — so `oauth` is a NON-secret control below, not a credential row.
    const key = async (config: SdkMcpServerConfig): Promise<string> => {
      const pool = new CountingPool({ connectionNonBlocking: false, connectionIsolation: 'shared' });
      await pool.sync({ srv: config }, {}, { leaserId: 'session-a' });
      return pool.connectionKeyForDesired('srv', 'session-a')!;
    };

    const rows: Array<[string, SdkMcpServerConfig, SdkMcpServerConfig]> = [
      ['http/sse headers', { ...HTTP, headers: { authorization: 'Bearer alpha' } }, { ...HTTP, headers: { authorization: 'Bearer beta' } }],
      ['http/sse bearerTokenEnvVar', { ...HTTP, bearerTokenEnvVar: 'ALPHA_TOKEN' }, { ...HTTP, bearerTokenEnvVar: 'BETA_TOKEN' }],
      ['stdio env', { ...STDIO, env: { TOKEN: 'alpha' } }, { ...STDIO, env: { TOKEN: 'beta' } }],
      ['stdio envVars', { ...STDIO, envVars: ['ALPHA_TOKEN'] }, { ...STDIO, envVars: ['BETA_TOKEN'] }],
    ];

    for (const [field, left, right] of rows) {
      it(`splits on ${field}`, async () => {
        expect(await key(left)).not.toBe(await key(right));
      });
    }

    it('is a real table: the SAME config on both sides is the same key', async () => {
      // The control that makes every row above falsifiable — without it a key
      // function that returned a fresh value every call would pass all four.
      expect(await key({ ...HTTP, headers: { authorization: 'Bearer alpha' } }))
        .toBe(await key({ ...HTTP, headers: { authorization: 'Bearer alpha' } }));
    });

    it('CONTROL: oauth is not a credential field, and a different one still splits', async () => {
      // `McpOAuthConfig`'s two fields are non-secret by its own docblock, so
      // this row records that the digest covers them WITHOUT claiming they are
      // credentials — the distinction the row's premise error turned on.
      expect(await key({ ...HTTP, oauth: { scopes: 'read' } }))
        .not.toBe(await key({ ...HTTP, oauth: { scopes: 'write' } }));
    });

    it('THE DOCUMENTED EXCEPTION: two configs differing only in what a helper RESOLVES to are one key', async () => {
      // Deliberate, and the one place the invariant above does not hold: the
      // digest covers the helper SPEC and never its output, so reconnects keep
      // their connection identity. Two sessions declaring the same helper share
      // one transport carrying whichever token resolved first — which is why
      // `reportSharedDynamicHeaderConnections` exists and why cases (d) and (g)
      // pin the diagnostic rather than the key.
      const helper: SdkMcpServerConfig = { ...HTTP, headersHelper: { command: 'print-token' } };
      expect(await key(helper)).toBe(await key({ ...helper, headersHelper: { command: 'print-token' } }));
      // ...and the SPEC itself is in the digest, so a different helper really
      // does split. Without this the case above could pass on a key function
      // that ignored `headersHelper` entirely.
      expect(await key(helper)).not.toBe(await key({ ...HTTP, headersHelper: { command: 'print-other-token' } }));
    });
  });
});

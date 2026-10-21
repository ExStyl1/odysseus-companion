import { afterAll, describe, expect, it } from 'bun:test';
import type { Server as BunServer, ServerWebSocket } from 'bun';
import { McpClientPool, checkMcpWsTarget } from '../mcp-pool.ts';
import { parseMcpServersDocument } from '../project-config.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';

/**
 * `mcp.md:147`: "The `type: \"ws\"` entry accepts the same `url`, `headers`,
 * `headersHelper`, `timeout`, and `alwaysLoad` fields as `http`."
 */
describe('.mcp.json ws servers', () => {
  const parse = (server: unknown) => {
    const warnings: string[] = [];
    const servers = parseMcpServersDocument({ mcpServers: { events: server } }, message => warnings.push(message));
    return { config: servers.events, warnings };
  };

  it('parses a ws entry with the fields http accepts', () => {
    const { config, warnings } = parse({
      type: 'ws',
      url: 'wss://mcp.example.test/socket',
      headers: { Authorization: 'Bearer static-token' },
      timeout: 5000,
      alwaysLoad: true,
    });

    expect(config).toEqual({
      type: 'ws',
      url: 'wss://mcp.example.test/socket',
      headers: { Authorization: 'Bearer static-token' },
      toolTimeoutMs: 5000,
      alwaysLoad: true,
    });
    expect(warnings).toEqual([]);
  });

  it('refuses a ws entry with no url, as it does for http', () => {
    const { config, warnings } = parse({ type: 'ws' });

    expect(config).toBeUndefined();
    expect(warnings[0]).toContain('unsupported MCP server config');
  });

  // `mcp.md:768`: `headersHelper` is implemented — the parsed config carries
  // the command (as the resolved-spec shape the pool executes) and nothing
  // warns. The http and sse cases are the two the doc's own examples use, and
  // their absence here is how the silent http/sse drop survived before.
  it.each(['ws', 'http', 'sse'] as const)('emits headersHelper on a %s entry without warning', transport => {
    const { config, warnings } = parse({
      type: transport,
      url: transport === 'ws' ? 'wss://mcp.example.test/socket' : 'https://mcp.example.test/mcp',
      headersHelper: './scripts/token.sh',
    });

    expect(config).toMatchObject({
      type: transport,
      headersHelper: { command: './scripts/token.sh' },
    });
    expect(warnings).toEqual([]);
  });

  // `mcp.md:459-460`: the expansion locations are command/args/env/url/headers —
  // headersHelper is NOT one, so its `${VAR}` text survives verbatim for the
  // shell it runs in, and no missing-variable warning fires for it.
  it('never expands ${VAR} references inside headersHelper', () => {
    const { config, warnings } = parse({
      type: 'http',
      url: 'https://mcp.example.test/mcp',
      headersHelper: 'echo "{\\"Authorization\\": \\"Bearer ${NESSY_TEST_UNSET_TOKEN}\\"}"',
    });

    expect(config).toMatchObject({
      headersHelper: { command: 'echo "{\\"Authorization\\": \\"Bearer ${NESSY_TEST_UNSET_TOKEN}\\"}"' },
    });
    expect(warnings).toEqual([]);
  });

  it('names a non-string headersHelper instead of dropping it in silence', () => {
    const { config, warnings } = parse({
      type: 'http',
      url: 'https://mcp.example.test/mcp',
      headersHelper: ['./scripts/token.sh'],
    });

    expect(config).toMatchObject({ type: 'http' });
    expect(config).not.toHaveProperty('headersHelper');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('headersHelper');
  });

  // `mcp.md:138`: WebSocket "supports neither" OAuth nor `--transport`.
  it('says an oauth object has no effect on a ws server', () => {
    const { config, warnings } = parse({
      type: 'ws',
      url: 'wss://mcp.example.test/socket',
      oauth: { scopes: 'a b' },
    });

    expect(config).toMatchObject({ type: 'ws' });
    expect(config).not.toHaveProperty('oauth');
    expect(warnings[0]).toContain('has no effect on a ws server');
  });
});

/**
 * The address guard — the SAME two checks a Monitor `ws` watch passes
 * (`config/network-address-guard.ts`), reached from the MCP connect path.
 */
describe('the ws address guard', () => {
  const publicResolve = async () => ['203.0.113.10'];

  it('admits an ordinary remote host', async () => {
    expect(await checkMcpWsTarget('wss://events.example.test/socket', { resolve: publicResolve }))
      .toEqual({ denied: false });
  });

  it('refuses a literal private address', async () => {
    const verdict = await checkMcpWsTarget('ws://10.0.0.5:9000/socket', { resolve: publicResolve });

    expect(verdict.denied).toBe(true);
    expect(verdict.reason).toContain('private address');
  });

  it('refuses a URL with embedded credentials without quoting it', async () => {
    const verdict = await checkMcpWsTarget('wss://user:s3cret@events.example.test/socket', {
      resolve: publicResolve,
    });

    expect(verdict.denied).toBe(true);
    expect(verdict.reason).toBe('the ws url must not embed credentials');
    expect(verdict.reason).not.toContain('s3cret');
  });

  it('refuses a host on the managed deny list', async () => {
    const verdict = await checkMcpWsTarget('wss://events.example.test/socket', {
      resolve: publicResolve,
      deniedDomains: ['*.example.test'],
    });

    expect(verdict.denied).toBe(true);
    expect(verdict.reason).toContain('deniedDomains');
  });

  it('refuses a host outside the managed allowlist', async () => {
    const verdict = await checkMcpWsTarget('wss://events.example.test/socket', {
      resolve: publicResolve,
      managedAllowlist: ['corp.example.com'],
    });

    expect(verdict.denied).toBe(true);
    expect(verdict.reason).toContain('outside the managed domain allowlist');
  });

  it('refuses a name that resolves to a blocked address', async () => {
    const verdict = await checkMcpWsTarget('wss://events.example.test/socket', {
      resolve: async () => ['203.0.113.10', '169.254.169.254'],
    });

    expect(verdict.denied).toBe(true);
    expect(verdict.reason).toContain('cloud-metadata address');
  });

  it('refuses a non-ws scheme', async () => {
    const verdict = await checkMcpWsTarget('https://events.example.test/socket', { resolve: publicResolve });

    expect(verdict.denied).toBe(true);
    expect(verdict.reason).toContain('must use ws: or wss:');
  });
});

// ---------------------------------------------------------------------------
// A real loopback MCP server, spoken over a real WebSocket.
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Minimal MCP server over Bun's WebSocket, answering the three methods a pool
 * connect performs: `initialize`, the `notifications/initialized` that follows,
 * and `tools/list`, plus `tools/call` so the tool is provably usable.
 *
 * Hand-written on the SERVER side only. The client is the vendored SDK's
 * `WebSocketClientTransport` — writing that half by hand would be a second
 * untested implementation of the framing the SDK already owns.
 */
function startWsMcpServer(): BunServer<unknown> {
  const send = (ws: ServerWebSocket<unknown>, id: number | string, result: unknown) => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  return Bun.serve({
    port: 0,
    fetch(request, server) {
      // Echo the `mcp` subprotocol the SDK transport negotiates.
      const requested = request.headers.get('sec-websocket-protocol');
      const upgraded = server.upgrade(request, {
        data: undefined,
        ...(requested ? { headers: { 'Sec-WebSocket-Protocol': 'mcp' } } : {}),
      });
      return upgraded ? undefined : new Response('expected a websocket upgrade', { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw)) as JsonRpcRequest;
        if (message.id === undefined) return; // notifications/initialized
        if (message.method === 'initialize') {
          send(ws, message.id, {
            protocolVersion: (message.params?.protocolVersion as string) ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'ws-fixture', version: '1.0.0' },
          });
          return;
        }
        if (message.method === 'tools/list') {
          send(ws, message.id, {
            tools: [{
              name: 'ping',
              description: 'Answers with pong.',
              inputSchema: { type: 'object', properties: {} },
            }],
          });
          return;
        }
        if (message.method === 'tools/call') {
          send(ws, message.id, { content: [{ type: 'text', text: 'pong' }] });
          return;
        }
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'method not found' },
        }));
      },
    },
  });
}

const wsServer = startWsMcpServer();
afterAll(() => { wsServer.stop(true); });

describe('a ws MCP server connects and contributes tools', () => {
  const config = (): Extract<SdkMcpServerConfig, { type: 'ws' }> => ({
    type: 'ws',
    // `localhost`, not `127.0.0.1`: the address guard denies a literal loopback
    // address outright (clause 1), which is correct for a transport `mcp.md:136`
    // introduces as "Add a REMOTE WebSocket server". A hostname reaches clause 4
    // instead, where the guard's own documented `resolve` seam decides — so the
    // fixture supplies a public answer and the guard is exercised, not skipped.
    url: `ws://localhost:${wsServer.port}/socket`,
  });

  it('lists its tools through the pool and calls one', async () => {
    const pool = new McpClientPool({
      wsNetworkPolicy: { resolve: async () => ['203.0.113.10'] },
    });

    await pool.connect('events', config());

    expect(pool.getProxyToolDefs().map(tool => tool.name)).toEqual(['mcp__events__ping']);
    const result = await pool.callTool('mcp__events__ping', {});
    expect(result).toMatchObject({ content: 'pong', isError: false });

    await pool.disconnectAll();
  });

  it('never opens a socket to a target the guard refuses', async () => {
    const messages: string[] = [];
    const pool = new McpClientPool({
      debug: message => messages.push(message),
      // No resolve override: `localhost` resolves to loopback and is refused.
      wsNetworkPolicy: {},
    });

    await pool.connect('events', config());

    expect(pool.getProxyToolDefs()).toEqual([]);
    expect(messages.join('\n')).toContain('was refused');
    expect(messages.join('\n')).toContain('loopback address');

    await pool.disconnectAll();
  });

  it('says out loud that ws headers are not transmitted', async () => {
    const messages: string[] = [];
    const pool = new McpClientPool({
      debug: message => messages.push(message),
      wsNetworkPolicy: { resolve: async () => ['203.0.113.10'] },
    });

    await pool.connect('events', { ...config(), headers: { Authorization: 'Bearer static' } });

    expect(messages.join('\n')).toContain('cannot send');
    expect(messages.join('\n')).not.toContain('Bearer static');

    await pool.disconnectAll();
  });
});

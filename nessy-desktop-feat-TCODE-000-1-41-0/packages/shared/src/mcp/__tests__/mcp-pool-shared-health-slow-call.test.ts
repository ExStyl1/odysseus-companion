/**
 * F1.801 (origin: release sitting SIT-r, packaged `5896a66d2`, 2026-09-25,
 * `work/sitting/SIT-r/verdicts.md` observation 2) — a busy-but-responsive
 * server must not be reported unhealthy.
 *
 * What SIT-r measured, on a stdio fixture whose `slow_lookup` answers after
 * 150 s and whose `tools/list` answers at once (`work/sitting/SIT-r/mcp-calls.jsonl`
 * is the ground truth): while the 150 s call was in flight, the codex session
 * (04:28:36) and the Pi session (04:30:05) both opened turns telling the model
 * the source was "failing / not responding" (`<source_issue status="failed">`
 * in `agent/core/source-manager.ts`, fed by `pool.health()`), the Pi model then
 * debugged the server and its turn never completed. The fixture log shows NO
 * `tools/list` in the window and no transport close — the server answered
 * everything it was asked.
 *
 * The mechanism, measured here against the real pool: the connection is SHARED
 * (the default posture — one transport for every session in the workspace,
 * `mcpConnectionKey`'s documented radius), and the one failure writer a
 * healthy-but-busy connection can still reach is the CONTEXT-capability
 * refresh (`resources`/`prompts`). A tools-only server — the SIT-r fixture
 * declared exactly `capabilities: { tools: {} }` — answers `resources/list`
 * with JSON-RPC `-32601 method not found`, and `refreshContextCapability`
 * marks the WHOLE connection capability-failed: every leaser's `health()`
 * then reports the slug as `failed`, and the model is told a server that is
 * answering calls is not responding.
 *
 * ## The threshold, measured
 *
 * Two boundaries decide whether a busy-but-responsive server can be marked at
 * all, and both are pinned here:
 *
 * 1. **The declaration boundary.** A capability the server never declared at
 *    the MCP handshake must not be probed at all — the pool already tracks the
 *    declared `resources` capability (`resourceCapableConnections`, read by
 *    `hasResourceCapability`), but the refresh path never asked it. This is the
 *    SIT-r case: the request is sent, refused, and the refusal is recorded as
 *    the server being down.
 * 2. **The refusal boundary.** JSON-RPC `-32601 method not found` is the
 *    server DECLARING the capability absent — the documented answer of a
 *    tools-only server — and must read as "empty", never as a failure.
 *
 * The TIME threshold is the SDK's own request ceiling: the pool's context
 * refreshes pass no `timeout`, so `@modelcontextprotocol/sdk` 1.29.0's
 * `DEFAULT_REQUEST_TIMEOUT_MSEC` (60 000 ms, `shared/protocol.js:8`, applied at
 * `:712` as `options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC`) bounds every
 * refresh — the measured ceiling a refresh queued behind a long call on a
 * server that serializes requests can hit. Pinned so the number in this
 * comment cannot rot.
 *
 * The CONTROL arm proves the slow call itself is innocent: nothing in the
 * tool-call path writes the failure sets (the callTool catch marks only auth
 * and helper-reconnect failures), so a call in flight moves no verdict.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool } from '../mcp-pool.ts';
import { NessyMcpClient, type PoolClient } from '../client.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';
import { registerFixtureClient } from './pool-fixture.ts';

const CONFIG: SdkMcpServerConfig = { type: 'http', url: 'https://busy.example.test/mcp' };
const TOOL: Tool = { name: 'slow_lookup', description: 'Slow', inputSchema: { type: 'object', properties: {} } } as Tool;

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

class TestPool extends McpClientPool {
  register(slug: string, client: PoolClient, config: SdkMcpServerConfig) {
    return registerFixtureClient(this, slug, client, config);
  }
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
});

/**
 * A live TOOLS-ONLY MCP server over an in-memory transport — the SIT-r
 * fixture's shape (`capabilities: { tools: {} }`): one slow tool and one quick
 * one, and NO resources or prompts capability declared, so a `resources/list`
 * is refused with `-32601`.
 */
async function toolsOnlySource(options: { workMs: number }): Promise<NessyMcpClient> {
  const server = new McpServer({ name: 'busy-test', version: '1.0.0' });
  server.registerTool(TOOL.name, { description: TOOL.description ?? '', inputSchema: {} }, async () => {
    await sleep(options.workMs);
    return { content: [{ type: 'text' as const, text: 'archived value' }] };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new NessyMcpClient(CONFIG.type === 'http' ? { transport: 'http', url: CONFIG.url } : CONFIG as never, {
    transport: clientTransport,
  } as never);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

/** Two leasers in one workspace, sharing the one connection (the default posture). */
async function sharedPool(): Promise<TestPool> {
  const pool = new TestPool();
  await pool.register('sitr-slow', await toolsOnlySource({ workMs: 400 }), CONFIG);
  await pool.sync({ 'sitr-slow': CONFIG }, {}, { leaserId: 'leaser-claude' });
  await pool.sync({ 'sitr-slow': CONFIG }, {}, { leaserId: 'leaser-codex' });
  return pool;
}

describe('F1.801 — a busy-but-responsive server is not reported unhealthy', () => {
  it('precondition: the rig mirrors the SIT-r fixture — resources never declared, tools served', async () => {
    const pool = await sharedPool();
    const connectionKey = [...(pool as unknown as { clients: Map<string, unknown> }).clients.keys()][0]!;
    const client = (pool as unknown as { clients: Map<string, PoolClient> }).clients.get(connectionKey)!;
    const declared = client.getServerCapabilities?.();
    expect(declared?.tools).toBeDefined();
    // The SIT-r fixture's `capabilities: { tools: {} }`: no resources row at all.
    expect(declared?.resources).toBeUndefined();
  });

  it('CONTROL — a slow tool call in flight marks nothing, for either leaser', async () => {
    const pool = await sharedPool();
    const call = pool.callTool('mcp__sitr-slow__slow_lookup', {}, undefined, { leaserId: 'leaser-claude' });
    // Mid-flight: the other session opens its turn and reads health.
    await sleep(120);
    expect(pool.health('leaser-codex').failed).toEqual([]);
    expect(pool.health('leaser-codex').status).toBe('ready');
    const result = await call;
    expect(result.isError).toBe(false);
    // And after: still nothing.
    expect(pool.health('leaser-codex').failed).toEqual([]);
    expect(pool.health('leaser-claude').failed).toEqual([]);
  });

  it('a context-capability probe of a tools-only server does not mark the SHARED connection failed', async () => {
    // The SIT-r shape: one session's surface asks the source for its resources
    // (`mcpResourcesPort.list` / the pool server's resources bridge), the
    // tools-only server refuses with -32601, and at HEAD the WHOLE connection —
    // both leasers — reads failed, "not responding", while it answers calls.
    const pool = await sharedPool();
    await pool.listContextResources(new Set(['sitr-slow']), 'leaser-claude');
    expect(pool.health('leaser-claude').failed).toEqual([]);
    expect(pool.health('leaser-codex').failed).toEqual([]);
    expect(pool.health('leaser-codex').status).toBe('ready');
  });

  it('measures the SDK request ceiling a refresh can hit behind a busy declared server', () => {
    // `shared/protocol.js:8` in @modelcontextprotocol/sdk 1.29.0; `:712` applies
    // it as `options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC`, and the pool's
    // context refreshes pass no `timeout`. This is the TIME threshold the row
    // asks to be measured: 60 000 ms of queueing behind a long call on a
    // server that serializes requests is where a declared-capability refresh
    // throws client-side. Pinned so the number above cannot rot silently.
    expect(DEFAULT_REQUEST_TIMEOUT_MSEC).toBe(60_000);
  });
});

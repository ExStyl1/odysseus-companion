/**
 * P6.26 — the GLOBAL wall clock on a running MCP tool call.
 *
 * Two halves were already here and are not retested: the per-server
 * `SdkMcpServerConfig.toolTimeoutMs` (pinned by "applies the per-call tool
 * timeout to a server it just connected" in `mcp-pool-connect-on-demand.test.ts`)
 * and the idle window (`mcp-pool-call-idle-timeout.test.ts`). What was missing is
 * the operator's ceiling for every OTHER connection — the servers that declare no
 * `timeout` of their own, which is most of them — plus the fact that an abort
 * has to say WHY.
 *
 * Every assertion here names the number and the knob. A timeout test that only
 * asserts "it stopped" passes just as happily when the call never started.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool } from '../mcp-pool.ts';
import { NessyMcpClient, type PoolClient } from '../client.ts';
import {
  MCP_DEFAULT_TOOL_TIMEOUT_MS,
  MCP_MIN_TOOL_TIMEOUT_MS,
  mcpDefaultToolTimeoutMsFromEnv,
} from '../server-config-values.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';
import { registerFixtureClient } from './pool-fixture.ts';

const CONFIG: SdkMcpServerConfig = { type: 'http', url: 'https://wallclock.example.test/mcp' };
const TOOL: Tool = { name: 'slow', description: 'Slow', inputSchema: { type: 'object', properties: {} } } as Tool;

class TestPool extends McpClientPool {
  register(slug: string, client: PoolClient, config: SdkMcpServerConfig) {
    return registerFixtureClient(this, slug, client, config);
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

const closers: Array<() => Promise<void>> = [];
const previousToolTimeout = process.env.NESSY_MCP_TOOL_TIMEOUT;

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
  if (previousToolTimeout === undefined) delete process.env.NESSY_MCP_TOOL_TIMEOUT;
  else process.env.NESSY_MCP_TOOL_TIMEOUT = previousToolTimeout;
});

/** A live MCP server whose `slow` tool takes `workMs` and reports no progress. */
async function liveSource(workMs: number): Promise<NessyMcpClient> {
  // P6.553 — the SDK's high-level `McpServer`, not the `@deprecated` `Server`.
  // This fake needs nothing low-level: one static tool, no notification of its
  // own, no client-capability read. `registerTool` owns `tools/list` and
  // `tools/call`, and it publishes the identical name, description and empty
  // object schema this test's `TOOL` declared by hand.
  const server = new McpServer({ name: 'wall-clock-test', version: '1.0.0' });
  server.registerTool(TOOL.name, { description: TOOL.description ?? '', inputSchema: {} }, async () => {
    await sleep(workMs);
    return { content: [{ type: 'text' as const, text: 'done' }] };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new NessyMcpClient(
    { transport: 'http', url: 'https://wallclock.example.test/mcp' } as never,
    { transport: clientTransport } as never,
  );
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe('mcpDefaultToolTimeoutMsFromEnv', () => {
  it('is the documented 28-hour default when the lever is unset', () => {
    expect(mcpDefaultToolTimeoutMsFromEnv({})).toBe(MCP_DEFAULT_TOOL_TIMEOUT_MS);
    expect(MCP_DEFAULT_TOOL_TIMEOUT_MS).toBe(100_000_000);
  });

  it('reads NESSY_MCP_TOOL_TIMEOUT', () => {
    expect(mcpDefaultToolTimeoutMsFromEnv({ NESSY_MCP_TOOL_TIMEOUT: ' 45000 ' })).toBe(45_000);
  });

  it('floors a sub-second value at one second rather than ignoring it', () => {
    // env-vars.md#variables: "For the env variable, values below 1000 are
    // floored to one second; for the per-server field, values below 1000 are
    // ignored." The two rules differ, and this is the env half.
    expect(mcpDefaultToolTimeoutMsFromEnv({ NESSY_MCP_TOOL_TIMEOUT: '5' })).toBe(MCP_MIN_TOOL_TIMEOUT_MS);
  });

  it('falls back to the default — never to "no ceiling" — on junk', () => {
    for (const raw of ['', '   ', 'soon', '0', '-1', 'NaN']) {
      expect(mcpDefaultToolTimeoutMsFromEnv({ NESSY_MCP_TOOL_TIMEOUT: raw })).toBe(MCP_DEFAULT_TOOL_TIMEOUT_MS);
    }
  });
});

describe('McpClientPool global tool wall clock', () => {
  it('bounds a server that declares no timeout of its own, and says so', async () => {
    // The row's whole point: before this, a connection with no per-server
    // `timeout` had NO wall clock at all.
    const pool = new TestPool({ defaultToolTimeoutMs: 120 });
    await pool.register('srv', await liveSource(3_000), CONFIG);

    const started = Date.now();
    const result = await pool.callTool('mcp__srv__slow', {});
    const elapsed = Date.now() - started;

    expect(result.isError).toBe(true);
    // N, and the knob that produced N — not a bare "the operation timed out".
    expect(result.content).toContain('120ms wall clock');
    expect(result.content).toContain('NESSY_MCP_TOOL_TIMEOUT');
    expect(result.content).toContain('MCP tool "slow" (source: srv) failed');
    // Observed N: stopped at the ceiling, not after the server's own 3s.
    expect(elapsed).toBeLessThan(1_500);
  });

  it('lets the per-server timeout override the global default, and attributes it', async () => {
    // mcp.md, the `.mcp.json` `timeout` bullet: "This overrides the
    // `MCP_TOOL_TIMEOUT` environment variable for that server only."
    const pool = new TestPool({ defaultToolTimeoutMs: 5_000 });
    await pool.register('srv', await liveSource(3_000), { ...CONFIG, toolTimeoutMs: 150 });

    const started = Date.now();
    const result = await pool.callTool('mcp__srv__slow', {});
    const elapsed = Date.now() - started;

    expect(result.isError).toBe(true);
    expect(result.content).toContain('150ms wall clock');
    expect(result.content).toContain('the "timeout" field configured for this server');
    expect(result.content).not.toContain('NESSY_MCP_TOOL_TIMEOUT');
    expect(elapsed).toBeLessThan(1_500);
  });

  it('a per-server timeout longer than the global default still wins', async () => {
    // The override is not a MINIMUM: a server allowed more time than the global
    // ceiling gets it, which is the only reading under which "for that server
    // only" means anything.
    const pool = new TestPool({ defaultToolTimeoutMs: 60 });
    await pool.register('srv', await liveSource(120), { ...CONFIG, toolTimeoutMs: 4_000 });

    const result = await pool.callTool('mcp__srv__slow', {});

    expect(result.isError).toBe(false);
    expect(result.content).toBe('done');
  });

  it('does not bite at rest: the unset default lets an ordinary call finish', async () => {
    // The number was chosen from the system's resting behaviour, not from zero.
    // A default that killed healthy calls would be a narrowing knob set below
    // the floor it is meant to sit above.
    delete process.env.NESSY_MCP_TOOL_TIMEOUT;
    const pool = new TestPool();
    await pool.register('srv', await liveSource(120), CONFIG);

    const result = await pool.callTool('mcp__srv__slow', {});

    expect(result.isError).toBe(false);
    expect(result.content).toBe('done');
  });

  it('reads the env lever at construction, floor included', async () => {
    // The wiring, end to end: an operator sets the documented name and a real
    // ceiling appears — which is the "silence" the row is about.
    process.env.NESSY_MCP_TOOL_TIMEOUT = '4';
    const pool = new TestPool();
    await pool.register('srv', await liveSource(4_000), CONFIG);

    const started = Date.now();
    const result = await pool.callTool('mcp__srv__slow', {});
    const elapsed = Date.now() - started;

    expect(result.isError).toBe(true);
    // Floored to one second, not obeyed at 4ms and not ignored.
    expect(result.content).toContain('1000ms wall clock');
    expect(result.content).toContain('NESSY_MCP_TOOL_TIMEOUT');
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(3_000);
  });
});

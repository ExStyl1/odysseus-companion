/**
 * F1.984 — a tool-call timeout longer than a timer can hold.
 *
 * `setTimeout` keeps its delay in a 32-bit signed integer. Measured on Bun
 * 1.3.14 (2026-09-26): a delay of 2 147 483 647 ms is kept, while 2 147 483 648
 * or 3 000 000 000 prints a `TimeoutOverflowWarning` ("Timeout duration was set
 * to 1") and the timer fires after about 1 ms. Nothing upstream bounds the
 * value from above: a `.mcp.json` `timeout` only has to be at least 1000
 * (`mcpToolTimeoutMs`), the `MCP_TOOL_TIMEOUT` lever only has to be positive,
 * and a codex `tool_timeout_sec` is converted by `codexToolTimeoutMs`. So a long
 * ceiling that meant "practically never" made every call fail at once.
 *
 * The pool is the one place all of them meet, so the pool holds the two timers
 * it derives from that ceiling — the wall clock and the idle window — at the
 * maximum. These tests go through the real call path with a live server, plus
 * the idle arithmetic through the method the call path reads.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpClientPool, type McpOpenConnectionRequest } from '../mcp-pool.ts';
import { NessyMcpClient, type PoolClient } from '../client.ts';
import type { ToolDescriptorStore } from '../tool-descriptor-store.ts';
import {
  MCP_CONNECT_BATCH_TIMEOUT_COMPAT_ENV,
  MCP_CONNECT_BATCH_TIMEOUT_ENV,
  MCP_STARTUP_TIMEOUT_COMPAT_ENV,
  MCP_STARTUP_TIMEOUT_ENV,
  MCP_TOOL_IDLE_TIMEOUT_COMPAT_ENV,
  MCP_TOOL_IDLE_TIMEOUT_ENV,
  MCP_TOOL_TIMEOUT_COMPAT_ENV,
  MCP_TOOL_TIMEOUT_ENV,
} from '../server-config-values.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';
import { registerFixtureClient } from './pool-fixture.ts';

/** The largest delay `setTimeout` keeps (2^31 - 1 ms, about 24.8 days). */
const TIMER_MAX_MS = 2_147_483_647;
/** About 34.7 days: past the maximum, and a value a real config could hold. */
const OVERFLOWING_MS = 3_000_000_000;

const CONFIG: SdkMcpServerConfig = { type: 'http', url: 'https://overflow.example.test/mcp' };

class TestPool extends McpClientPool {
  register(slug: string, client: PoolClient, config: SdkMcpServerConfig) {
    return registerFixtureClient(this, slug, client, config);
  }

  seed(key: string, config: SdkMcpServerConfig): void {
    (this as unknown as { activeConfigs: Map<string, SdkMcpServerConfig> }).activeConfigs.set(key, config);
  }

  idle(key: string): number | undefined {
    return (this as unknown as { toolIdleTimeoutMs(k: string): number | undefined }).toolIdleTimeoutMs(key);
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

const ENV_NAMES = [
  MCP_TOOL_TIMEOUT_ENV,
  MCP_TOOL_TIMEOUT_COMPAT_ENV,
  MCP_TOOL_IDLE_TIMEOUT_ENV,
  MCP_TOOL_IDLE_TIMEOUT_COMPAT_ENV,
] as const;
const previousEnv = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));

function clearTimeoutEnv(): void {
  for (const name of ENV_NAMES) delete process.env[name];
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
  // `delete` before assign on every restore, never a bare assign.
  clearTimeoutEnv();
  for (const name of ENV_NAMES) {
    const value = previousEnv[name];
    if (value !== undefined) process.env[name] = value;
  }
});

/** A live MCP server whose `slow` tool takes `workMs` and reports no progress. */
async function liveSource(workMs: number): Promise<NessyMcpClient> {
  const server = new McpServer({ name: 'timer-overflow-test', version: '1.0.0' });
  server.registerTool('slow', { description: 'Slow', inputSchema: {} }, async () => {
    await sleep(workMs);
    return { content: [{ type: 'text' as const, text: 'done' }] };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new NessyMcpClient(
    { transport: 'http', url: 'https://overflow.example.test/mcp' } as never,
    { transport: clientTransport } as never,
  );
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe('McpClientPool timers past the setTimeout maximum', () => {
  it('a per-server timeout past the maximum lets an ordinary call finish', async () => {
    // Both timers are derived from this value: the wall clock directly and the
    // idle window through its floor. Either one overflowing fails the call.
    clearTimeoutEnv();
    const pool = new TestPool();
    await pool.register('srv', await liveSource(80), { ...CONFIG, toolTimeoutMs: OVERFLOWING_MS });

    const result = await pool.callTool('mcp__srv__slow', {});

    expect(result.content).toBe('done');
    expect(result.isError).toBe(false);
  });

  it('the MCP_TOOL_TIMEOUT lever past the maximum lets an ordinary call finish', async () => {
    // No per-server timeout, so the idle window stays at its 5-minute default:
    // this arm isolates the wall clock the env lever feeds.
    clearTimeoutEnv();
    process.env[MCP_TOOL_TIMEOUT_COMPAT_ENV] = String(OVERFLOWING_MS);
    const pool = new TestPool();
    await pool.register('srv', await liveSource(80), CONFIG);

    const result = await pool.callTool('mcp__srv__slow', {});

    expect(result.content).toBe('done');
    expect(result.isError).toBe(false);
  });

  it('holds the idle window at the maximum, and leaves a value below it alone', () => {
    clearTimeoutEnv();
    const pool = new TestPool({ defaultToolTimeoutMs: OVERFLOWING_MS });
    pool.seed('over', { ...CONFIG, toolTimeoutMs: OVERFLOWING_MS });
    pool.seed('exact', { ...CONFIG, toolTimeoutMs: TIMER_MAX_MS });
    pool.seed('below', { ...CONFIG, toolTimeoutMs: 2_000_000 });
    pool.seed('default', CONFIG);

    expect(pool.idle('over')).toBe(TIMER_MAX_MS);
    expect(pool.idle('exact')).toBe(TIMER_MAX_MS);
    // The clamp only lowers what a timer cannot hold: the per-server floor
    // still raises the 5-minute default to 2 000 000 ms, and the default idle
    // window under an overflowing global ceiling is still 5 minutes.
    expect(pool.idle('below')).toBe(2_000_000);
    expect(pool.idle('default')).toBe(5 * 60_000);
  });

  it('an overflowing idle override is held at the maximum too', () => {
    clearTimeoutEnv();
    process.env[MCP_TOOL_IDLE_TIMEOUT_ENV] = String(OVERFLOWING_MS);
    const pool = new TestPool({ defaultToolTimeoutMs: OVERFLOWING_MS });
    pool.seed('srv', CONFIG);

    expect(pool.idle('srv')).toBe(TIMER_MAX_MS);
  });
});

/**
 * F1.1102 — the two CONNECT timers have the same overflow: the per-server
 * connect deadline (`NESSY_MCP_TIMEOUT` / `MCP_TIMEOUT`, or the option) and the
 * reconcile's batch cap (`NESSY_MCP_CONNECT_TIMEOUT_MS`, or the option). Past
 * the maximum, the deadline rejected every connect after about 1 ms and the cap
 * ended every batch wait after about 1 ms.
 */
class ConnectPool extends McpClientPool {
  readonly finished: string[] = [];
  connectDelayMs = 60;

  protected override async openConnection({ slug }: McpOpenConnectionRequest): Promise<PoolClient> {
    await sleep(this.connectDelayMs);
    this.finished.push(slug);
    return {
      listTools: async () => [],
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      close: async () => {},
    } as unknown as PoolClient;
  }
}

const COLD_STORE: ToolDescriptorStore = { read: () => [], write: () => {} };
const CONNECT_ENV_NAMES = [
  MCP_STARTUP_TIMEOUT_ENV,
  MCP_STARTUP_TIMEOUT_COMPAT_ENV,
  MCP_CONNECT_BATCH_TIMEOUT_ENV,
  MCP_CONNECT_BATCH_TIMEOUT_COMPAT_ENV,
] as const;
const previousConnectEnv = Object.fromEntries(CONNECT_ENV_NAMES.map(name => [name, process.env[name]]));
const clearConnectEnv = (): void => { for (const name of CONNECT_ENV_NAMES) delete process.env[name]; };
const connectTimers = (pool: McpClientPool) =>
  pool as unknown as { connectTimeoutMs: number; connectBatchTimeoutMs: number | undefined };

describe('McpClientPool connect timers past the setTimeout maximum (F1.1102)', () => {
  afterEach(() => {
    // `delete` before assign on every restore, never a bare assign.
    clearConnectEnv();
    for (const name of CONNECT_ENV_NAMES) {
      const value = previousConnectEnv[name];
      if (value !== undefined) process.env[name] = value;
    }
  });

  it('a connect deadline past the maximum lets a 60 ms connect land', async () => {
    clearConnectEnv();
    const pool = new ConnectPool({ toolDescriptorStore: COLD_STORE, connectTimeoutMs: OVERFLOWING_MS });

    await pool.sync({ srv: CONFIG }, {}, { leaserId: 'L' });

    expect(pool.finished).toEqual(['srv']);
    expect(pool.isConnected('srv', 'L')).toBe(true);
  });

  it('a batch cap past the maximum waits for a 60 ms connect instead of returning at once', async () => {
    clearConnectEnv();
    const pool = new ConnectPool({ toolDescriptorStore: COLD_STORE, connectBatchTimeoutMs: OVERFLOWING_MS });

    const startedAt = Date.now();
    await pool.sync({ srv: CONFIG }, {}, { leaserId: 'L' });

    // Measured against the connect's own 60 ms, not against zero.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
    expect(pool.finished).toEqual(['srv']);
  });

  it('holds both env levers at the maximum', () => {
    clearConnectEnv();
    process.env[MCP_STARTUP_TIMEOUT_COMPAT_ENV] = String(OVERFLOWING_MS);
    process.env[MCP_CONNECT_BATCH_TIMEOUT_ENV] = String(OVERFLOWING_MS);

    const timers = connectTimers(new ConnectPool());

    expect(timers.connectTimeoutMs).toBe(TIMER_MAX_MS);
    expect(timers.connectBatchTimeoutMs).toBe(TIMER_MAX_MS);
  });

  it('leaves a value at or below the maximum, and an unset cap, alone', () => {
    clearConnectEnv();
    process.env[MCP_STARTUP_TIMEOUT_ENV] = String(TIMER_MAX_MS);

    const fromEnv = connectTimers(new ConnectPool());
    expect(fromEnv.connectTimeoutMs).toBe(TIMER_MAX_MS);
    expect(fromEnv.connectBatchTimeoutMs).toBeUndefined();

    const fromOptions = connectTimers(new ConnectPool({ connectTimeoutMs: 45_000, connectBatchTimeoutMs: 5_000 }));
    expect(fromOptions.connectTimeoutMs).toBe(45_000);
    expect(fromOptions.connectBatchTimeoutMs).toBe(5_000);
  });
});

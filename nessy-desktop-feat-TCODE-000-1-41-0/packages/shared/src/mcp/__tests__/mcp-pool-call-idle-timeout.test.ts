/**
 * The per-call IDLE abort.
 *
 * The per-server wall clock already exists as `SdkMcpServerConfig.toolTimeoutMs`
 * and is pinned by "applies the per-call tool timeout to a server it just
 * connected" in `mcp-pool-connect-on-demand.test.ts` — these tests do not repeat
 * it. What was missing is the other half: a call that is demonstrably ALIVE must
 * not be killed, and a call that has gone silent must not wait for the wall clock.
 * MCP progress notifications are the liveness signal.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool } from '../mcp-pool.ts';
import {
  MCP_TOOL_IDLE_TIMEOUT_COMPAT_ENV,
  MCP_TOOL_IDLE_TIMEOUT_ENV,
} from '../server-config-values.ts';
import { NessyMcpClient, type PoolClient } from '../client.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';
import { registerFixtureClient } from './pool-fixture.ts';

const CONFIG: SdkMcpServerConfig = { type: 'http', url: 'https://idle.example.test/mcp' };
const TOOL: Tool = { name: 'slow', description: 'Slow', inputSchema: { type: 'object', properties: {} } } as Tool;

class TestPool extends McpClientPool {
  register(slug: string, client: PoolClient, config: SdkMcpServerConfig) {
    return registerFixtureClient(this, slug, client, config);
  }
}

/**
 * P6.701 — the arithmetic the live cases above cannot show cheaply.
 *
 * `toolIdleTimeoutMs` is where the page's four numeric clauses meet, and each of
 * them is a boundary: a live server can demonstrate ONE of them per run at the
 * cost of a real timer, while the whole rule fits in a table. So the behaviour
 * stays above and the arithmetic is pinned here, against the same method the
 * call path reads.
 */
class ArithmeticPool extends McpClientPool {
  seed(key: string, config: SdkMcpServerConfig): void {
    (this as unknown as { activeConfigs: Map<string, SdkMcpServerConfig> }).activeConfigs.set(key, config);
  }

  idle(key: string): number | undefined {
    return (this as unknown as { toolIdleTimeoutMs(k: string): number | undefined }).toolIdleTimeoutMs(key);
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

const closers: Array<() => Promise<void>> = [];
const previousIdle = process.env.NESSY_MCP_TOOL_IDLE_TIMEOUT;
const previousIdleCompat = process.env[MCP_TOOL_IDLE_TIMEOUT_COMPAT_ENV];

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
  // `delete` before assign on every restore, never a bare assign.
  delete process.env[MCP_TOOL_IDLE_TIMEOUT_ENV];
  delete process.env[MCP_TOOL_IDLE_TIMEOUT_COMPAT_ENV];
  if (previousIdle !== undefined) process.env[MCP_TOOL_IDLE_TIMEOUT_ENV] = previousIdle;
  if (previousIdleCompat !== undefined) process.env[MCP_TOOL_IDLE_TIMEOUT_COMPAT_ENV] = previousIdleCompat;
});

/**
 * A live MCP server over an in-memory transport whose `slow` tool takes
 * `workMs`, optionally emitting a progress notification every `progressEveryMs`.
 */
async function liveSource(options: { workMs: number; progressEveryMs?: number }): Promise<NessyMcpClient> {
  // P6.553 — the SDK's high-level `McpServer`, not the `@deprecated` `Server`.
  // The progress notification this fake exists to emit does NOT need the
  // low-level class: `registerTool`'s `extra` carries both halves this handler
  // reads — the caller's `_meta.progressToken` and a `sendNotification` bound to
  // the request being handled — so the wire is the same one the pool's idle
  // timer keys on.
  const server = new McpServer({ name: 'idle-test', version: '1.0.0' });
  server.registerTool(TOOL.name, { description: TOOL.description ?? '', inputSchema: {} }, async (_args, extra) => {
    const progressToken = extra._meta?.progressToken;
    const deadline = Date.now() + options.workMs;
    while (Date.now() < deadline) {
      await sleep(Math.min(options.progressEveryMs ?? options.workMs, Math.max(1, deadline - Date.now())));
      if (progressToken !== undefined && options.progressEveryMs !== undefined && Date.now() < deadline) {
        await extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken, progress: Date.now() },
        });
      }
    }
    return { content: [{ type: 'text' as const, text: 'done' }] };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new NessyMcpClient(CONFIG.type === 'http' ? { transport: 'http', url: CONFIG.url } : CONFIG as never, {
    transport: clientTransport,
  } as never);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe('McpClientPool per-call idle timeout', () => {
  it('resets the idle timer while the server reports progress', async () => {
    // The load-bearing case: a plain deadline would kill this healthy long call.
    process.env.NESSY_MCP_TOOL_IDLE_TIMEOUT = '120';
    const pool = new TestPool();
    await pool.register('srv', await liveSource({ workMs: 500, progressEveryMs: 40 }), CONFIG);

    const result = await pool.callTool('mcp__srv__slow', {});

    expect(result.isError).toBe(false);
    expect(result.content).toBe('done');
  });

  it('aborts a call that goes silent for longer than the idle window', async () => {
    // P6.701 — `80` is RAISED to one second here (*"Values below 1000 are raised
    // to one second"*), so this case now also demonstrates that clause: the
    // abort lands at the floor rather than at the number the operator wrote, and
    // still far short of the server's own 3s of work.
    process.env[MCP_TOOL_IDLE_TIMEOUT_ENV] = '80';
    const pool = new TestPool();
    await pool.register('srv', await liveSource({ workMs: 3_000 }), CONFIG);

    const started = Date.now();
    const result = await pool.callTool('mcp__srv__slow', {});
    const elapsed = Date.now() - started;

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain('timed out');
    // Not at 80ms — the floor raised it — and not at the wall clock either.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2_500);
  });

  it('never aborts for idleness sooner than the per-server wall clock', async () => {
    // A per-server `toolTimeoutMs` is a FLOOR on the idle window: an operator who
    // configured a long ceiling must not have their calls killed earlier by the
    // idle check. Idle 50ms + floor 3000ms means this 150ms call survives.
    process.env.NESSY_MCP_TOOL_IDLE_TIMEOUT = '50';
    const pool = new TestPool();
    await pool.register(
      'srv',
      await liveSource({ workMs: 150 }),
      { ...CONFIG, toolTimeoutMs: 3_000 } as SdkMcpServerConfig,
    );

    const result = await pool.callTool('mcp__srv__slow', {});

    expect(result.isError).toBe(false);
    expect(result.content).toBe('done');
  });

  it('honours 0 as "no idle check"', async () => {
    process.env.NESSY_MCP_TOOL_IDLE_TIMEOUT = '0';
    const pool = new TestPool();
    await pool.register('srv', await liveSource({ workMs: 150 }), CONFIG);

    const result = await pool.callTool('mcp__srv__slow', {});

    expect(result.isError).toBe(false);
    expect(result.content).toBe('done');
  });
});

describe('P6.701 — the idle window the page specifies', () => {
  const KEY = 'srv-arith';
  const stdio = { type: 'stdio', command: 'x' } as unknown as SdkMcpServerConfig;
  const http = { type: 'http', url: 'https://idle.example.test/mcp' } as unknown as SdkMcpServerConfig;

  function pool(defaultToolTimeoutMs = 100_000_000): ArithmeticPool {
    return new ArithmeticPool({ defaultToolTimeoutMs });
  }

  /** *"Overrides the per-transport defaults of 300000 … and 1800000 … for stdio"*. */
  it('defaults to five minutes on a network server and thirty on stdio', () => {
    const p = pool();
    p.seed(KEY, http);
    expect(p.idle(KEY)).toBe(300_000);
    p.seed(KEY, stdio);
    expect(p.idle(KEY)).toBe(1_800_000);
  });

  /**
   * The row's own name, read by NOTHING before this row — the whole reason the
   * lever was inert for anyone following the page.
   */
  it('reads the documented CLAUDE_CODE spelling', () => {
    process.env[MCP_TOOL_IDLE_TIMEOUT_COMPAT_ENV] = '5000';
    const p = pool();
    p.seed(KEY, http);
    expect(p.idle(KEY)).toBe(5_000);
  });

  it('lets the Nessy spelling win when both are set', () => {
    process.env[MCP_TOOL_IDLE_TIMEOUT_ENV] = '5000';
    process.env[MCP_TOOL_IDLE_TIMEOUT_COMPAT_ENV] = '9000';
    const p = pool();
    p.seed(KEY, http);
    expect(p.idle(KEY)).toBe(5_000);
  });

  /** *"Values below 1000 are raised to one second"*, on both spellings. */
  it.each([MCP_TOOL_IDLE_TIMEOUT_ENV, MCP_TOOL_IDLE_TIMEOUT_COMPAT_ENV])('raises a sub-second %s to 1000', name => {
    process.env[name] = '1';
    const p = pool();
    p.seed(KEY, http);
    expect(p.idle(KEY)).toBe(1_000);
  });

  /** *"Set to `0` to disable the idle check"* — and the raise must not undo it. */
  it('treats 0 as off rather than raising it to one second', () => {
    process.env[MCP_TOOL_IDLE_TIMEOUT_ENV] = '0';
    const p = pool();
    p.seed(KEY, http);
    expect(p.idle(KEY)).toBeUndefined();
  });

  /** *"the value is capped at the effective `MCP_TOOL_TIMEOUT`"* — the global one… */
  it('caps the value at the global wall clock', () => {
    process.env[MCP_TOOL_IDLE_TIMEOUT_ENV] = '90000';
    const p = pool(30_000);
    p.seed(KEY, http);
    expect(p.idle(KEY)).toBe(30_000);
  });

  /** …and EFFECTIVE means the per-server field where one is set. */
  it('caps the value at a per-server timeout instead, when there is one', () => {
    process.env[MCP_TOOL_IDLE_TIMEOUT_ENV] = '90000';
    const p = pool(100_000_000);
    p.seed(KEY, { ...http, toolTimeoutMs: 20_000 } as SdkMcpServerConfig);
    expect(p.idle(KEY)).toBe(20_000);
  });

  /** The default is capped too, or a stdio server with a short ceiling never idles out. */
  it('caps the per-transport default at the wall clock as well', () => {
    const p = pool(100_000_000);
    p.seed(KEY, { ...stdio, toolTimeoutMs: 60_000 } as SdkMcpServerConfig);
    expect(p.idle(KEY)).toBe(60_000);
  });

  /**
   * *"A per-server `timeout` in `.mcp.json` of at least 1000 raises that
   * server's idle window to at least the `timeout` value"* — and the
   * `MCP_TOOL_TIMEOUT` row's other half, *"for the per-server field, values
   * below 1000 are ignored"*.
   */
  it('raises the window to a per-server timeout of at least 1000, and ignores one below it', () => {
    process.env[MCP_TOOL_IDLE_TIMEOUT_ENV] = '2000';
    const raised = pool();
    raised.seed(KEY, { ...http, toolTimeoutMs: 9_000 } as SdkMcpServerConfig);
    expect(raised.idle(KEY)).toBe(9_000);

    const ignored = pool();
    ignored.seed(KEY, { ...http, toolTimeoutMs: 999 } as SdkMcpServerConfig);
    // 999 is not a floor; it IS still the effective wall clock, and the cap
    // applies — which is the page's own composition, not an exception to it.
    expect(ignored.idle(KEY)).toBe(999);
  });

  /** An unreadable value leaves the lever unset — it must never widen or disable. */
  it('ignores a value that is not a number', () => {
    process.env[MCP_TOOL_IDLE_TIMEOUT_ENV] = 'soon';
    const p = pool();
    p.seed(KEY, http);
    expect(p.idle(KEY)).toBe(300_000);
  });

  /**
   * *"Doesn't apply to … SDK in-process servers"* — they hold no `activeConfigs`
   * entry, so the check is structurally absent rather than switched off.
   */
  it('does not apply to a connection with no config entry', () => {
    process.env[MCP_TOOL_IDLE_TIMEOUT_ENV] = '5000';
    expect(pool().idle('in-process')).toBeUndefined();
  });
});

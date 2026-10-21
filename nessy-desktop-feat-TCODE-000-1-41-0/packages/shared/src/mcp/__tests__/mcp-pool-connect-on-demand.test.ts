import { describe, expect, it } from 'bun:test';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool, type McpOpenConnectionRequest } from '../mcp-pool.ts';
import type { PoolClient } from '../client.ts';
import type { ToolDescriptorStore } from '../tool-descriptor-store.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';

const CONFIG = { type: 'stdio', command: '/bin/true', args: [] } as SdkMcpServerConfig;
const TOOL: Tool = { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } } as Tool;
const DEADLINE_MS = 200;

/** Every identity has a cached descriptor, so routes exist before any connect. */
const CACHED: ToolDescriptorStore = {
  read: () => [TOOL],
  write: () => {},
};

const never = (): Promise<never> => new Promise<never>(() => {});

function latch(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

/**
 * Let every pending caller reach its next await. A macrotask boundary drains the
 * whole microtask queue, so callers parked on `connect` have provably arrived.
 */
const settlePendingCallers = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 5); });

/**
 * Pool with a faked transport, dispatched on slug:
 * - `parked`: connects, but its `close()` never settles — used to park the
 *   reconcile's unbounded sequential disconnect pass.
 * - `gated`: blocks inside connect until the test releases it, so a caller can
 *   arrive while the reconcile's own connect is in flight.
 * - `stuck`: never completes its handshake.
 * - `broken`: refuses the connection.
 * - anything else: registers an in-memory client immediately.
 */
class LazyPool extends McpClientPool {
  readonly connectAttempts: string[] = [];
  readonly gateEntered = latch();
  readonly gateRelease = latch();

  protected override async openConnection({ slug }: McpOpenConnectionRequest): Promise<PoolClient> {
    this.connectAttempts.push(slug);
    if (slug === 'gated') {
      this.gateEntered.release();
      await this.gateRelease.wait;
    }
    if (slug === 'stuck') await never();
    if (slug === 'broken') throw new Error('transport refused');
    return {
      listTools: async () => [TOOL],
      callTool: async () => {
        if (slug === 'slow-tool') await never();
        return { content: [{ type: 'text', text: `ok:${slug}` }] };
      },
      close: async () => { if (slug === 'parked' || slug === 'draining') await never(); },
    } as unknown as PoolClient;
  }

  attemptsFor(slug: string): number {
    return this.connectAttempts.filter(attempt => attempt === slug).length;
  }
}

/**
 * The state Task 5 makes normal: `servers` are desired by leaser `L` and
 * advertised from the descriptor cache, but the reconcile has not connected
 * them. The sync chain is parked on a disconnect whose `close()` never settles,
 * and the disconnect pass runs before the connect pass — so no connect for
 * these servers is ever attempted by the reconcile.
 */
async function coldPool(servers: Record<string, SdkMcpServerConfig>): Promise<LazyPool> {
  const pool = new LazyPool({ connectTimeoutMs: DEADLINE_MS, toolDescriptorStore: CACHED });
  await pool.sync({ parked: CONFIG }, {}, { leaserId: 'PARK' });
  void pool.dropLeaser('PARK');
  void pool.sync(servers, {}, { leaserId: 'L' });
  return pool;
}

describe('McpClientPool connect on demand', () => {
  it('connects a desired-but-cold server on the first call and reuses it after', async () => {
    const pool = await coldPool({ alpha: CONFIG });
    expect(pool.isConnected('alpha', 'L')).toBe(false);
    expect(pool.attemptsFor('alpha')).toBe(0);

    const result = await pool.callTool('mcp__alpha__echo', {}, undefined, { leaserId: 'L' });

    expect(result).toMatchObject({ content: 'ok:alpha', isError: false });
    expect(pool.attemptsFor('alpha')).toBe(1);
    expect(pool.isConnected('alpha', 'L')).toBe(true);

    // A warm connection is not reconnected per call.
    const second = await pool.callTool('mcp__alpha__echo', {}, undefined, { leaserId: 'L' });

    expect(second).toMatchObject({ content: 'ok:alpha', isError: false });
    expect(pool.attemptsFor('alpha')).toBe(1);
  });

  it('opens ONE transport for a cold server however many callers want it at once', async () => {
    // The reconcile is mid-connect and three tool calls arrive before it
    // finishes. Each caller opening its own transport would leave
    // registerClient keeping only the last client, orphaning the rest.
    const pool = new LazyPool({ connectTimeoutMs: 1_000, toolDescriptorStore: CACHED });
    const reconcile = pool.sync({ gated: CONFIG }, {}, { leaserId: 'L' });
    await pool.gateEntered.wait;

    const calls = [0, 1, 2].map(() => pool.callTool('mcp__gated__echo', {}, undefined, { leaserId: 'L' }));
    await settlePendingCallers();
    pool.gateRelease.release();
    const results = await Promise.all(calls);

    expect(await reconcile).toEqual([]);
    expect(results.map(result => result.isError)).toEqual([false, false, false]);
    expect(results.map(result => result.content)).toEqual(['ok:gated', 'ok:gated', 'ok:gated']);
    expect(pool.attemptsFor('gated')).toBe(1);
  });

  it('keeps the soft error for a server whose connect already failed', async () => {
    const pool = new LazyPool({ connectTimeoutMs: DEADLINE_MS, toolDescriptorStore: CACHED });
    expect(await pool.sync({ broken: CONFIG }, {}, { leaserId: 'L' })).toEqual(['broken']);
    const attempts = pool.attemptsFor('broken');

    const started = Date.now();
    const result = await pool.callTool('mcp__broken__echo', {}, undefined, { leaserId: 'L' });

    expect(result).toEqual({
      content: 'MCP client for source "broken" is not connected.',
      isError: true,
      sourceSlug: 'broken',
    });
    // A known-broken server pays no deadline and is not retried per call.
    expect(pool.attemptsFor('broken')).toBe(attempts);
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS);
  });

  it('bounds an on-demand connect by the connect deadline and does not retry it per call', async () => {
    const pool = await coldPool({ stuck: CONFIG });

    const firstStarted = Date.now();
    const first = await pool.callTool('mcp__stuck__echo', {}, undefined, { leaserId: 'L' });
    const firstElapsed = Date.now() - firstStarted;

    expect(first).toEqual({
      content: 'MCP client for source "stuck" is not connected.',
      isError: true,
      sourceSlug: 'stuck',
    });
    // Waited for the connect deadline — and no longer than it.
    expect(firstElapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 25);
    expect(firstElapsed).toBeLessThan(DEADLINE_MS * 3);
    expect(pool.health('L').failed).toEqual(['stuck']);

    const attempts = pool.attemptsFor('stuck');
    const secondStarted = Date.now();
    const second = await pool.callTool('mcp__stuck__echo', {}, undefined, { leaserId: 'L' });

    expect(second.isError).toBe(true);
    expect(pool.attemptsFor('stuck')).toBe(attempts);
    expect(Date.now() - secondStarted).toBeLessThan(DEADLINE_MS / 2);
  });

  it.each([
    ['a foreign leaser', 'mcp__alpha__echo', 'M', 'Tool not available in this session'],
    ['an unknown tool', 'mcp__alpha__nope', 'L', 'Unknown MCP proxy tool: mcp__alpha__nope'],
  ])('refuses %s without connecting anything', async (_label, proxyName, leaserId, message) => {
    const pool = await coldPool({ alpha: CONFIG });

    const result = await pool.callTool(proxyName, {}, undefined, { leaserId });

    expect(result).toEqual({ content: message, isError: true });
    expect(pool.attemptsFor('alpha')).toBe(0);
  });

  it('keeps the disconnecting error while a connection drains', async () => {
    const pool = new LazyPool({ connectTimeoutMs: DEADLINE_MS, toolDescriptorStore: CACHED });
    await pool.sync({ draining: CONFIG }, {}, { leaserId: 'L' });
    const attempts = pool.attemptsFor('draining');
    // `close()` never settles, so the connection stays in the draining set.
    void pool.disconnect('draining');

    const result = await pool.callTool('mcp__draining__echo', {}, undefined, { leaserId: 'L' });

    expect(result).toEqual({
      content: 'MCP client for source "draining" is disconnecting.',
      isError: true,
      sourceSlug: 'draining',
    });
    expect(pool.attemptsFor('draining')).toBe(attempts);
  });

  it('applies the per-call tool timeout to a server it just connected', async () => {
    const pool = await coldPool({ 'slow-tool': { ...CONFIG, toolTimeoutMs: 30 } as SdkMcpServerConfig });

    const started = Date.now();
    const result = await pool.callTool('mcp__slow-tool__echo', {}, undefined, { leaserId: 'L' });

    // The on-demand connect must record the config it connected with, or the
    // first call to a cold server would silently lose its tool timeout.
    expect(pool.attemptsFor('slow-tool')).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('MCP tool "echo" (source: slow-tool) failed');
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS);
  });
});

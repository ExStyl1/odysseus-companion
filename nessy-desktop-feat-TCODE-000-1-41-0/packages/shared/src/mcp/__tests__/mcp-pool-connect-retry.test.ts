import { describe, expect, it } from 'bun:test';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool, type McpOpenConnectionRequest } from '../mcp-pool.ts';
import type { PoolClient } from '../client.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';

const CONFIG = { type: 'stdio', command: '/bin/true', args: [] } as SdkMcpServerConfig;
const TOOL: Tool = { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } } as Tool;
const RETRY = { attempts: 3, baseDelayMs: 1 } as const;

const healthyClient = (slug: string): PoolClient => ({
  listTools: async () => [TOOL],
  callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  // `parked` never finishes closing, which parks the reconcile's disconnect pass
  // and therefore the whole sync chain — the same seam the connect-on-demand
  // suite uses to reach a desired-but-cold server.
  close: async () => { if (slug === 'parked') await new Promise<never>(() => {}); },
});

/** Every identity has a cached descriptor, so routes exist before any connect. */
const CACHED = { read: () => [TOOL], write: () => {} };

/**
 * A pool whose transport refuses the first `failuresBeforeSuccess` attempts and
 * records every attempt, so a test can count transports opened per server.
 */
class FlakyPool extends McpClientPool {
  readonly attempts: string[] = [];

  constructor(
    private readonly failuresBeforeSuccess: number,
    options?: NonNullable<ConstructorParameters<typeof McpClientPool>[0]>,
  ) {
    super(options);
  }

  protected override async openConnection({ slug }: McpOpenConnectionRequest): Promise<PoolClient> {
    this.attempts.push(slug);
    if (slug !== 'parked' && this.attemptsFor(slug) <= this.failuresBeforeSuccess) throw new Error('502');
    return healthyClient(slug);
  }

  attemptsFor(slug: string): number {
    return this.attempts.filter(attempt => attempt === slug).length;
  }
}

describe('McpClientPool bounded connect retry', () => {
  it('retries a failing initial connect a bounded number of times', async () => {
    const pool = new FlakyPool(Number.POSITIVE_INFINITY, { connectTimeoutMs: 5_000, retry: RETRY });

    const failed = await pool.sync({ srv: CONFIG }, {}, { leaserId: 'L' });

    expect(failed).toEqual(['srv']);
    expect(pool.attemptsFor('srv')).toBe(3);
    expect(pool.health('L').failed).toContain('srv');
  });

  it('serves the server once a later attempt succeeds', async () => {
    const pool = new FlakyPool(1, { connectTimeoutMs: 5_000, retry: RETRY });

    const failed = await pool.sync({ srv: CONFIG }, {}, { leaserId: 'L' });

    expect(failed).toEqual([]);
    expect(pool.attemptsFor('srv')).toBe(2);
    expect(pool.isConnected('srv', 'L')).toBe(true);
  });

  /**
   * DA3.15 — "exactly one transport per server" IS the shared posture, said in
   * the language of retries: two leasers asking for the same server concurrently
   * fold into one connect and therefore one retry ladder.
   *
   * Under `NESSY_MCP_CONNECTION_ISOLATION=per-leaser` each leaser runs its own
   * ladder and the count is a multiple of it (measured 2026-09-17: 12 against
   * the shared posture's 3). Left unpinned on purpose — a case that would fail
   * if `DA3.2`'s default moved is the instrument for that move, and pinning it
   * to `shared` is the class of pin AGENTS.md's "a DEFAULT FLIP has no
   * instrument" bullet is about.
   */
  it('still opens exactly one transport per server across retries', async () => {
    // P1 added connectOnce because a probe showed four transports for one
    // server. A retry loop that sits OUTSIDE the dedupe reintroduces that leak:
    // two leasers would each run their own three-attempt chain.
    const pool = new FlakyPool(Number.POSITIVE_INFINITY, { connectTimeoutMs: 5_000, retry: RETRY });

    await Promise.all([
      pool.sync({ srv: CONFIG }, {}, { leaserId: 'a' }),
      pool.sync({ srv: CONFIG }, {}, { leaserId: 'b' }),
    ]);

    expect(pool.attemptsFor('srv')).toBe(3);
  });

  it('shares one retry chain across concurrent on-demand callers', async () => {
    // The reconcile pass is serialized, so it cannot by itself prove the dedupe
    // still owns the chain. `callTool`'s on-demand connect is where several
    // callers genuinely race ONE cold identity — the exact case connectOnce was
    // added for. Three callers must still cost three attempts, not nine.
    const pool = new FlakyPool(Number.POSITIVE_INFINITY, {
      connectTimeoutMs: 5_000,
      retry: RETRY,
      toolDescriptorStore: CACHED,
    });
    // Park the sync chain on a `close()` that never settles, so the reconcile
    // never reaches its connect pass and the on-demand path owns every attempt.
    await pool.sync({ parked: CONFIG }, {}, { leaserId: 'PARK' });
    void pool.dropLeaser('PARK');
    void pool.sync({ cold: CONFIG }, {}, { leaserId: 'L' });
    expect(pool.attemptsFor('cold')).toBe(0);

    const results = await Promise.all([0, 1, 2].map(() => (
      pool.callTool('mcp__cold__echo', {}, undefined, { leaserId: 'L' })
    )));

    expect(results.map(result => result.isError)).toEqual([true, true, true]);
    expect(pool.attemptsFor('cold')).toBe(3);
  });

  it('does not retry a connection that has left the desired union', async () => {
    // P1's Task 3 invariant. The DP gate withholds a server by leaving it OUT
    // of the desired set `materializeRuntimePoolServers` hands to `sync` (see
    // runtime-pool-servers.test.ts, "withholds DP-backed servers"), so the
    // retry must never re-attempt a key that is no longer desired.
    const pool = new FlakyPool(Number.POSITIVE_INFINITY, { connectTimeoutMs: 5_000, retry: RETRY });
    await pool.sync({ srv: CONFIG }, {}, { leaserId: 'L' });
    const attemptsWhileDesired = pool.attemptsFor('srv');

    await pool.dropLeaser('L');
    await pool.sync({ other: CONFIG }, {}, { leaserId: 'M' });

    expect(attemptsWhileDesired).toBe(3);
    expect(pool.attemptsFor('srv')).toBe(attemptsWhileDesired);
    expect(pool.isConnected('srv', 'L')).toBe(false);
  });

  it('keeps the whole retry chain inside one connect deadline', async () => {
    // The deadline must wrap the chain, not each attempt: a hanging transport
    // costs ONE deadline however many attempts are configured, so retries never
    // add serial latency past what P1 already allowed.
    const pool = new (class extends McpClientPool {
      entered = 0;
      protected override async openConnection(): Promise<PoolClient> {
        this.entered += 1;
        return new Promise<never>(() => {});
      }
    })({ connectTimeoutMs: 80, retry: { attempts: 3, baseDelayMs: 10 } });

    const started = Date.now();
    expect(await pool.sync({ srv: CONFIG }, {}, { leaserId: 'L' })).toEqual(['srv']);

    expect(Date.now() - started).toBeLessThan(80 * 2);
    expect(pool.entered).toBe(1);
  });
});

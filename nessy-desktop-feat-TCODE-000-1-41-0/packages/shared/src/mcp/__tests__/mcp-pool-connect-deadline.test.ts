import { afterEach, describe, expect, it } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpClientPool, type McpOpenConnectionRequest } from '../mcp-pool.ts';
import type { PoolClient } from '../client.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';

// Save/restore the deadline env override the way the idle-timeout suite does
// for NESSY_MCP_TOOL_IDLE_TIMEOUT: leaking it would perturb the other pool
// suites, which construct pools without an explicit connectTimeoutMs.
const previousTimeout = process.env.NESSY_MCP_TIMEOUT;

afterEach(() => {
  if (previousTimeout === undefined) delete process.env.NESSY_MCP_TIMEOUT;
  else process.env.NESSY_MCP_TIMEOUT = previousTimeout;
});

const resolvedDeadlineMs = (pool: McpClientPool): number =>
  (pool as unknown as { connectTimeoutMs: number }).connectTimeoutMs;

const CONFIG = { type: 'stdio', command: '/bin/true', args: [] } as SdkMcpServerConfig;
const HANGING_SLUGS = ['slow-a', 'slow-b', 'slow-c'];
const DEADLINE_MS = 200;

const healthyClient = (): PoolClient => ({
  listTools: async () => [],
  callTool: async () => ({ content: [] }),
  close: async () => {},
});

/** A pool whose transport connect never settles, except for the `fast` slug. */
class HangingPool extends McpClientPool {
  readonly connectStartedAt: number[] = [];

  protected override async openConnection({ slug }: McpOpenConnectionRequest): Promise<PoolClient> {
    this.connectStartedAt.push(Date.now());
    if (slug === 'fast') return healthyClient();
    return new Promise<never>(() => {});
  }
}

/** A pool whose in-process API connect never settles. */
class HangingApiPool extends McpClientPool {
  override async connectInProcess(_slug: string, _server: McpServer): Promise<void> {
    await new Promise<never>(() => {});
  }
}

describe('McpClientPool connect deadline', () => {
  it('marks a server that never completes its handshake as failed at the deadline', async () => {
    const pool = new HangingPool({ connectTimeoutMs: 40 });

    const failed = await pool.sync({ slow: CONFIG }, {}, { leaserId: 'L' });

    expect(failed).toEqual(['slow']);
    expect(pool.health('L')).toMatchObject({ status: 'unavailable', failed: ['slow'] });
  });

  /**
   * DA3.15 — the LAST assertion of this case prices the SHARED posture, and the
   * rest of it does not. Everything above the second `sync` is about
   * concurrency and holds under any posture; the closing line — a sync by a
   * different leaser is not blocked by the hanging servers — is true here
   * because under `shared` leaser `M` gets `fast` from the transport `L`
   * already opened, so the call costs nothing.
   *
   * Under `NESSY_MCP_CONNECTION_ISOLATION=per-leaser` it is not: `M` opens its
   * OWN transport for `fast` and the elapsed crosses the bound (measured
   * 2026-09-17: 203 ms against `< 200`). That is the posture behaving exactly as
   * documented, not a defect — and the case is deliberately NOT pinned to
   * `shared`, because these cases are today the only thing that would fire if
   * the `DA3.2` default ever moved.
   */
  it('bounds the whole reconcile by ONE deadline however many servers hang', async () => {
    const pool = new HangingPool({ connectTimeoutMs: DEADLINE_MS });
    const servers = Object.fromEntries([...HANGING_SLUGS, 'fast'].map(slug => [slug, CONFIG]));

    const started = Date.now();
    const failed = await pool.sync(servers, {}, { leaserId: 'L' });
    const elapsed = Date.now() - started;

    // Concurrent connects cost about one deadline; sequential ones would cost
    // one deadline PER hanging server, i.e. 3x this bound.
    expect(elapsed).toBeLessThan(DEADLINE_MS * 2);
    // Every connect was entered before any of them settled.
    expect(pool.connectStartedAt).toHaveLength(HANGING_SLUGS.length + 1);
    expect(Math.max(...pool.connectStartedAt) - Math.min(...pool.connectStartedAt)).toBeLessThan(50);
    // A healthy server still connects while its peers are stuck.
    expect([...failed].sort()).toEqual([...HANGING_SLUGS]);
    expect(pool.health('L')).toEqual({
      status: 'degraded',
      connected: ['fast'],
      failed: [...HANGING_SLUGS],
      // P6.715 — every hanging server names the deadline that cut it off.
      failureReasons: Object.fromEntries(
        HANGING_SLUGS.map(slug => [slug, `Timeout: "${slug}" did not connect within ${DEADLINE_MS}ms`]),
      ),
    });

    // A sync queued behind the hanging servers is not blocked by them.
    const secondStarted = Date.now();
    await pool.sync({ fast: CONFIG }, {}, { leaserId: 'M' });
    expect(Date.now() - secondStarted).toBeLessThan(DEADLINE_MS);
  });

  it('bounds an in-process API connect with the same deadline', async () => {
    const pool = new HangingApiPool({ connectTimeoutMs: 40 });

    const failed = await pool.sync({}, { api: { type: 'sdk', instance: {} as McpServer } }, { leaserId: 'L' });

    expect(failed).toEqual(['api']);
    expect(pool.health('L')).toMatchObject({ status: 'unavailable', failed: ['api'] });
  });

  // The `NESSY_MCP_TIMEOUT` lever (`mcp-quickstart.md:333` names the remedy;
  // `env-vars.md:412` gives the 30 s default). Env applies only when no
  // programmatic option is passed, so the ~13 suites that pass
  // `connectTimeoutMs` explicitly stay env-insensitive.
  it('honours NESSY_MCP_TIMEOUT when no connectTimeoutMs option is passed', async () => {
    process.env.NESSY_MCP_TIMEOUT = '40';
    const messages: string[] = [];
    const pool = new HangingPool({ debug: message => messages.push(message) });

    const failed = await pool.sync({ slow: CONFIG }, {}, { leaserId: 'L' });

    // Behavioral proof, not just the resolved field: with the 30 s default in
    // force this sync would outlive the test timeout.
    expect(failed).toEqual(['slow']);
    expect(messages.some(message => message.includes('did not connect within 40ms'))).toBe(true);
  });

  it('falls back to the 30s default on a malformed NESSY_MCP_TIMEOUT', () => {
    for (const raw of ['soon', '-5', '0']) {
      process.env.NESSY_MCP_TIMEOUT = raw;
      expect(resolvedDeadlineMs(new HangingPool())).toBe(30_000);
    }
  });

  it('lets an explicit connectTimeoutMs option beat the env variable', async () => {
    process.env.NESSY_MCP_TIMEOUT = '60000';
    const messages: string[] = [];
    const pool = new HangingPool({ connectTimeoutMs: 40, debug: message => messages.push(message) });

    const failed = await pool.sync({ slow: CONFIG }, {}, { leaserId: 'L' });

    expect(failed).toEqual(['slow']);
    expect(messages.some(message => message.includes('did not connect within 40ms'))).toBe(true);
    expect(resolvedDeadlineMs(pool)).toBe(40);
  });
});

/**
 * P3.237 — which connects a reconcile WAITS for, and whether an operator can
 * change that.
 *
 * `McpClientPool.sync` awaited EVERY connect, and there was no lever of any
 * kind: `MCP_CONNECTION_NONBLOCKING` and `MCP_CONNECT_TIMEOUT_MS` were both
 * absent. `agent-sdk/mcp.md#connection-timing` states the rule as a
 * per-server-type table — a "Remote server with a cached tool list, saved by
 * Claude Code from a previous connection" does NOT delay the first turn, since
 * "the cached tools are available from the first turn" — and our durable
 * descriptor store is exactly that cached list.
 *
 * The default here deviates from Claude's, deliberately, and the reason is
 * pinned below rather than asserted in prose: the connect result is read
 * synchronously by `authNeededSlugs`, which has no change notification.
 *
 * Every timing assertion measures against the fake server's OWN work time, so
 * none can pass on a connect that never started.
 */
import { describe, expect, it } from 'bun:test';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool, type McpOpenConnectionRequest } from '../mcp-pool.ts';
import {
  MCP_DOCUMENTED_CONNECT_BATCH_TIMEOUT_MS,
  mcpConnectBatchTimeoutMsFromEnv,
  mcpConnectionNonBlockingFromEnv,
} from '../server-config-values.ts';
import type { PoolClient } from '../client.ts';
import type { ToolDescriptorStore } from '../tool-descriptor-store.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';

const TOOL: Tool = { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } } as Tool;
const HTTP: SdkMcpServerConfig = { type: 'http', url: 'https://mcp.example.test/mcp' };

/** A store that reports a previously-saved tool list for every connection. */
const CACHED: ToolDescriptorStore = { read: () => [TOOL], write: () => {} };
/** A store that has never seen these connections — the uncached row. */
const COLD: ToolDescriptorStore = { read: () => [], write: () => {} };

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * A pool whose transport is replaced wholesale: `connect` takes exactly the time
 * the test asks for, then registers a fake client. Nothing here reaches a
 * socket, so an elapsed time IS the delay under test.
 */
class TimedPool extends McpClientPool {
  readonly started: string[] = [];
  readonly finished: string[] = [];
  /** Per-slug connect duration, ms. */
  readonly delays = new Map<string, number>();
  /** Per-slug connect rejection. */
  readonly failures = new Map<string, unknown>();

  protected override async openConnection({ slug }: McpOpenConnectionRequest): Promise<PoolClient> {
    this.started.push(slug);
    const delay = this.delays.get(slug) ?? 0;
    if (delay > 0) await sleep(delay);
    const failure = this.failures.get(slug);
    if (failure) throw failure;
    this.finished.push(slug);
    return {
      listTools: async () => [TOOL],
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      close: async () => {},
    } as unknown as PoolClient;
  }
}

/** The shape the MCP SDK's HTTP transports throw: status on `code`. */
const httpError = (status: number) => Object.assign(new Error(`http ${status}`), { code: status });

describe('the documented first-turn table decides which connects are awaited', () => {
  it('holds the reconcile open for a server whose tool list is NOT already known', async () => {
    // The table's first row: "stdio server, or HTTP/SSE server without a cached
    // tool list — Yes, until it connects". True with the exemption switched ON,
    // so the exemption cannot be read as "never wait for anything".
    const pool = new TimedPool({ toolDescriptorStore: COLD, connectionNonBlocking: true });
    pool.delays.set('jira', 150);

    const startedAt = Date.now();
    await pool.sync({ jira: HTTP }, {}, { leaserId: 'L' });
    const elapsed = Date.now() - startedAt;

    expect(pool.finished).toEqual(['jira']);
    // Measured against the server's own 150ms, not against zero.
    expect(elapsed).toBeGreaterThanOrEqual(140);
  });

  it('returns without waiting for a server whose tool list IS already known', async () => {
    const pool = new TimedPool({ toolDescriptorStore: CACHED, connectionNonBlocking: true });
    pool.delays.set('jira', 150);

    const startedAt = Date.now();
    await pool.sync({ jira: HTTP }, {}, { leaserId: 'L' });
    const elapsed = Date.now() - startedAt;

    // The connect STARTED — this is a deferral, not a skip.
    expect(pool.started).toEqual(['jira']);
    expect(pool.finished).toEqual([]);
    expect(elapsed).toBeLessThan(140);
    // And the cached tools are what makes that safe: they are advertised now.
    expect(pool.getTools('jira', 'L').map(entry => entry.name)).toEqual(['echo']);

    // It still lands, and the pool is connected afterwards.
    await sleep(250);
    expect(pool.finished).toEqual(['jira']);
  });
});

describe('the default posture is the blocking one, and the reason is a verdict nobody re-reads', () => {
  it('waits for a cached-tool-list connect by default, so a 401 is visible the instant sync returns', async () => {
    // Claude's own default is the non-blocking one. Ours is not, and this is
    // why: `authNeededSlugs` is read synchronously right after the sync (the
    // session-start pending-auth notice) and has no change notification, so
    // deferring this connect would drop the sign-in prompt silently.
    const pool = new TimedPool({ toolDescriptorStore: CACHED });
    pool.delays.set('jira', 60);
    pool.failures.set('jira', httpError(401));

    await pool.sync({ jira: HTTP }, {}, { leaserId: 'L' });

    expect(pool.authNeededSlugs('L')).toEqual(['jira']);
  });

  it('loses that verdict at sync time once an operator opts into the exemption', async () => {
    // The cost of the lever, pinned rather than left for someone to discover.
    const pool = new TimedPool({ toolDescriptorStore: CACHED, connectionNonBlocking: true });
    pool.delays.set('jira', 60);
    pool.failures.set('jira', httpError(401));

    await pool.sync({ jira: HTTP }, {}, { leaserId: 'L' });
    expect(pool.authNeededSlugs('L')).toEqual([]);

    await sleep(160);
    expect(pool.authNeededSlugs('L')).toEqual(['jira']);
  });
});

describe('the batch cap stops waiting without aborting', () => {
  it('returns at the cap and lets the pending connect finish in the background', async () => {
    // The cap sits between the resting state (a connect that answers promptly)
    // and the slow server under test — never at zero.
    const pool = new TimedPool({ toolDescriptorStore: COLD, connectBatchTimeoutMs: 120 });
    pool.delays.set('fast', 10);
    pool.delays.set('slow', 400);

    const startedAt = Date.now();
    await pool.sync({ fast: HTTP, slow: { type: 'http', url: 'https://slow.example.test/mcp' } }, {}, { leaserId: 'L' });
    const elapsed = Date.now() - startedAt;

    expect(pool.finished).toEqual(['fast']);
    expect(elapsed).toBeGreaterThanOrEqual(110);
    // The whole point: it did NOT pay the slow server's 400ms.
    expect(elapsed).toBeLessThan(380);

    // "Servers still pending at the deadline keep connecting in the background."
    await sleep(400);
    expect(pool.finished.sort()).toEqual(['fast', 'slow']);
    expect(pool.isConnected('slow', 'L')).toBe(true);
  });

  it('waits for the whole batch when no cap is set, which is the resting state', async () => {
    const pool = new TimedPool({ toolDescriptorStore: COLD });
    pool.delays.set('slow', 200);

    const startedAt = Date.now();
    await pool.sync({ slow: HTTP }, {}, { leaserId: 'L' });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(190);
    expect(pool.finished).toEqual(['slow']);
  });

  it('names the count, the slugs and the knob when it cuts a wait short', async () => {
    // y1's rule: a ceiling that fires and cannot say why is a control that has
    // silently stopped controlling.
    const lines: string[] = [];
    const pool = new TimedPool({
      toolDescriptorStore: COLD,
      connectBatchTimeoutMs: 80,
      debug: message => { lines.push(message); },
    });
    pool.delays.set('slow', 300);

    await pool.sync({ slow: HTTP }, {}, { leaserId: 'L' });

    const notice = lines.find(line => line.includes('NESSY_MCP_CONNECT_TIMEOUT_MS'));
    expect(notice, `no cap attribution in: ${lines.join(' | ')}`).toBeDefined();
    expect(notice).toContain('80ms');
    expect(notice).toContain('slow');
    await sleep(320);
  });

  it('names the deferred connects and the knob that would wait for them', async () => {
    const lines: string[] = [];
    const pool = new TimedPool({
      toolDescriptorStore: CACHED,
      connectionNonBlocking: true,
      debug: message => { lines.push(message); },
    });
    pool.delays.set('jira', 40);

    await pool.sync({ jira: HTTP }, {}, { leaserId: 'L' });

    const notice = lines.find(line => line.includes('NESSY_MCP_CONNECTION_NONBLOCKING'));
    expect(notice, `no deferral attribution in: ${lines.join(' | ')}`).toBeDefined();
    expect(notice).toContain('jira');
    await sleep(80);
  });
});

describe('the two env readers', () => {
  it('keeps the blocking posture unless an operator writes 1 or true', () => {
    expect(mcpConnectionNonBlockingFromEnv({})).toBe(false);
    expect(mcpConnectionNonBlockingFromEnv({ NESSY_MCP_CONNECTION_NONBLOCKING: '' })).toBe(false);
    expect(mcpConnectionNonBlockingFromEnv({ NESSY_MCP_CONNECTION_NONBLOCKING: '0' })).toBe(false);
    // A typo must not silently take the exemption.
    expect(mcpConnectionNonBlockingFromEnv({ NESSY_MCP_CONNECTION_NONBLOCKING: 'yes' })).toBe(false);
    expect(mcpConnectionNonBlockingFromEnv({ NESSY_MCP_CONNECTION_NONBLOCKING: '1' })).toBe(true);
    expect(mcpConnectionNonBlockingFromEnv({ NESSY_MCP_CONNECTION_NONBLOCKING: 'TRUE' })).toBe(true);
  });

  it('reports no batch cap unless one is set to a usable positive value', () => {
    expect(mcpConnectBatchTimeoutMsFromEnv({})).toBeUndefined();
    expect(mcpConnectBatchTimeoutMsFromEnv({ NESSY_MCP_CONNECT_TIMEOUT_MS: '  ' })).toBeUndefined();
    expect(mcpConnectBatchTimeoutMsFromEnv({ NESSY_MCP_CONNECT_TIMEOUT_MS: 'soon' })).toBeUndefined();
    expect(mcpConnectBatchTimeoutMsFromEnv({ NESSY_MCP_CONNECT_TIMEOUT_MS: '0' })).toBeUndefined();
    expect(mcpConnectBatchTimeoutMsFromEnv({ NESSY_MCP_CONNECT_TIMEOUT_MS: '-5' })).toBeUndefined();
    expect(mcpConnectBatchTimeoutMsFromEnv({ NESSY_MCP_CONNECT_TIMEOUT_MS: '2500.7' })).toBe(2500);
    // Claude's own number, recorded so an operator can write it without guessing.
    expect(MCP_DOCUMENTED_CONNECT_BATCH_TIMEOUT_MS).toBe(5000);
  });
});

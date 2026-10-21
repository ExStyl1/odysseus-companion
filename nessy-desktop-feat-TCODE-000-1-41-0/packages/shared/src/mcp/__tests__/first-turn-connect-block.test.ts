/**
 * P3.247 — the two sites where a runtime still paid a whole MCP connect batch
 * before its first turn, and the mechanism that makes not paying it safe.
 *
 * The row's premises were BOTH corrected before this file existed, and the
 * corrections are why the change is small: `needsHttpPoolServer` is true for
 * `codex-runtime` ALONE (`BACKEND_CAPABILITIES`), so the session-setup await
 * was codex-only rather than "Pi and Codex"; and `preflightDpAuth`'s first line
 * is `if (runtime.provider !== 'pi') return { ready: true }`, so the DP
 * preflight blocked Pi alone rather than every runtime. Two accidental
 * runtime-specific waits in front of one host policy that every other call site
 * already followed — `BaseAgent.setSourceServers`'s `awaitConnect: false`,
 * whose docblock carries the measurement ("33.7s with ten").
 *
 * The row also said the argument for the fix was plausible and UNVERIFIED, and
 * demanded it be driven on the surface codex actually speaks before being
 * trusted. That is what this file does: a REAL `McpPoolServer` over HTTP with a
 * REAL MCP SDK client standing in for the subprocess, against a server whose
 * connect takes a measured amount of time. Every timing assertion is made
 * against that server's own work time, never against zero, so none of them can
 * pass on a connect that never started.
 *
 * The claim under test, in one sentence: `sync` writes the desired set and
 * hydrates the durable descriptor cache in its SYNCHRONOUS PREFIX — it contains
 * no `await` of its own — so a caller that drops the promise still leaves the
 * pool's per-leaser view correct, and only the connect pass is still in flight.
 */
import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool, type McpOpenConnectionRequest } from '../mcp-pool.ts';
import { McpPoolServer } from '../pool-server.ts';
import type { PoolClient } from '../client.ts';
import type { ToolDescriptorStore } from '../tool-descriptor-store.ts';
import {
  MCP_DOCUMENTED_CONNECT_BATCH_TIMEOUT_MS,
  MCP_POOL_SERVER_STARTUP_WAIT_MS,
} from '../server-config-values.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';

/** What the server answers once it is finally up. */
const LIVE_TOOL: Tool = {
  name: 'search',
  description: 'Search issues',
  inputSchema: { type: 'object', properties: {} },
} as Tool;

/** What a PREVIOUS connection saved, i.e. the documented "cached tool list". */
const CACHED_TOOL: Tool = {
  name: 'search',
  description: 'Search issues (from the last connection)',
  inputSchema: { type: 'object', properties: {} },
} as Tool;

const HTTP: SdkMcpServerConfig = { type: 'http', url: 'https://mcp.example.test/mcp' };

const CACHED_STORE: ToolDescriptorStore = { read: () => [CACHED_TOOL], write: () => {} };
const COLD_STORE: ToolDescriptorStore = { read: () => [], write: () => {} };

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * How long the fake server takes to hand back a usable connection. Every
 * "did/did not wait" assertion below is stated against THIS number rather than
 * against a constant, so raising it can never make a passing test vacuous.
 */
const CONNECT_WORK_MS = 400;
/**
 * Slack under load. The box these run on has been measured at load average 14
 * with a 49x spread between load extremes, so a bound that reads "did not pay
 * the connect" is set well below the work time rather than near zero.
 */
const NOT_WAITED_MS = CONNECT_WORK_MS / 2;

/**
 * A pool whose transport is replaced wholesale: `connect` takes exactly the
 * time the test asks for and then registers a fake client. Nothing here reaches
 * a socket, so an elapsed time IS the delay under test. Same shape as
 * `mcp-pool-connect-batch-timing.test.ts`'s `TimedPool` (P3.237), deliberately,
 * so a reader comparing the caller-side deferral this file measures with the
 * pool-side one that file measures is comparing like with like.
 */
class TimedPool extends McpClientPool {
  readonly started: string[] = [];
  readonly finished: string[] = [];
  readonly delays = new Map<string, number>();
  /** Per-slug connect rejection, thrown after the delay has been paid. */
  readonly failures = new Map<string, unknown>();

  protected override async openConnection({ slug }: McpOpenConnectionRequest): Promise<PoolClient> {
    this.started.push(slug);
    const delay = this.delays.get(slug) ?? 0;
    if (delay > 0) await sleep(delay);
    const failure = this.failures.get(slug);
    if (failure) throw failure;
    this.finished.push(slug);
    return {
      listTools: async () => [LIVE_TOOL],
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      close: async () => {},
    } as unknown as PoolClient;
  }
}

interface Subprocess {
  client: Client;
  /** Tool names the subprocess sees right now, over the real HTTP surface. */
  listToolNames(): Promise<string[]>;
  /** Resolves when `notifications/tools/list_changed` arrives. */
  toolListChanged: Promise<void>;
  close(): Promise<void>;
}

/**
 * Stand in for the codex subprocess: a real MCP SDK client speaking Streamable
 * HTTP to a real `McpPoolServer`. Reading tool names through this rather than
 * through `pool.getTools` is the point — a value the pool holds but the wire
 * drops would pass the second and fail here.
 */
async function attachSubprocess(poolServer: McpPoolServer): Promise<Subprocess> {
  const client = new Client({ name: 'first-turn-test', version: '1.0.0' });
  let signalChanged: () => void = () => {};
  const toolListChanged = new Promise<void>(resolve => { signalChanged = resolve; });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { signalChanged(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(poolServer.url), {
    requestInit: { headers: { authorization: `Bearer ${poolServer.bearerToken}` } },
  }));
  return {
    client,
    listToolNames: async () => (await client.listTools()).tools.map(tool => tool.name).sort(),
    toolListChanged,
    close: () => client.close().catch(() => {}),
  };
}

describe('the session-setup reconcile no longer holds the first turn (P3.247)', () => {
  it('returns before the server connects, and the subprocess re-pays the wait at the point of need', async () => {
    // `connectionNonBlocking: false` deliberately: the pool's OWN documented
    // exemption (P3.237) stays off, so anything this test measures is the
    // caller-side deferral and nothing else.
    const pool = new TimedPool({ toolDescriptorStore: CACHED_STORE, connectionNonBlocking: false });
    pool.delays.set('jira', CONNECT_WORK_MS);
    const poolServer = new McpPoolServer(pool, { leaserId: 'L' });
    await poolServer.start();
    try {
      // The shape `SessionManager`'s `needsHttpPoolServer` branch now uses.
      const startedAt = Date.now();
      void pool.sync({ jira: HTTP }, {}, { leaserId: 'L' }).catch(() => {});
      const elapsed = Date.now() - startedAt;

      // The win, and it is a real one: everything session setup does after this
      // line — spawning the subprocess above all — now overlaps the connect.
      expect(elapsed).toBeLessThan(NOT_WAITED_MS);
      // MEASURED, and it sharpens the row's argument rather than confirming it:
      // the connect has not even STARTED at this instant. `sync`'s synchronous
      // prefix records the desired set and hydrates the descriptor cache, but
      // `queueReconcile` puts the reconcile on `syncChain.then(...)`, i.e. a
      // microtask. So "the pool's view is already correct" is true of the
      // DESIRED set and the tool cache and of nothing else.
      expect(pool.started).toEqual([]);

      // And here is where the wait is re-paid. The subprocess handshakes and
      // lists; both are points of need, and both settle the pool first.
      const subprocess = await attachSubprocess(poolServer);
      try {
        expect(await subprocess.listToolNames()).toEqual(['jira__search']);
        // Not the cached descriptor — the LIVE one. Before the point-of-need
        // wait this read returned the cache and the subprocess never learned
        // better, because the notification that would have told it is discarded
        // by the runtime this surface serves.
        const live = await subprocess.client.listTools();
        expect(live.tools[0]?.description).toBe('Search issues');
        expect(pool.finished).toEqual(['jira']);
      } finally {
        await subprocess.close();
      }
    } finally {
      await poolServer.stop().catch(() => {});
    }
  });

  it('the subprocess pays the connect it needs, measured against the server\'s own work time', async () => {
    // The other half of the trade, stated as a number: the wait did not vanish,
    // it MOVED — off session setup and onto the request that reads the answer.
    const pool = new TimedPool({ toolDescriptorStore: COLD_STORE, connectionNonBlocking: false });
    pool.delays.set('jira', CONNECT_WORK_MS);
    const poolServer = new McpPoolServer(pool, { leaserId: 'L' });
    await poolServer.start();
    try {
      const startedAt = Date.now();
      void pool.sync({ jira: HTTP }, {}, { leaserId: 'L' }).catch(() => {});
      const subprocess = await attachSubprocess(poolServer);
      try {
        // A server never connected before is the row `agent-sdk/mcp.md#connection-timing`
        // says DOES delay the first turn ("Yes, until it connects"). It does —
        // here, at the handshake, rather than during session setup.
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(CONNECT_WORK_MS - 40);
        expect(await subprocess.listToolNames()).toEqual(['jira__search']);
      } finally {
        await subprocess.close();
      }
    } finally {
      await poolServer.stop().catch(() => {});
    }
  });

  it('a MID-SESSION reconcile is waited for too, which is the case the handshake cannot cover', async () => {
    // The handshake wait settles the pool once. It does NOT cover the reconcile
    // that runs on EVERY later turn — `BaseAgent.setSourceServers` syncs the
    // same leaser with `awaitConnect: false` on each send — so a `tools/list`
    // arriving during one of those would read a half-reconciled pool. Kept as
    // its own case because removing the `tools/list` wait left the handshake
    // tests green: a mutant that survives is a claim nothing tests.
    const pool = new TimedPool({ toolDescriptorStore: COLD_STORE, connectionNonBlocking: false });
    const poolServer = new McpPoolServer(pool, { leaserId: 'L' });
    await poolServer.start();
    await pool.sync({ jira: HTTP }, {}, { leaserId: 'L' });
    const subprocess = await attachSubprocess(poolServer);
    try {
      expect(await subprocess.listToolNames()).toEqual(['jira__search']);

      // A second source joins mid-session and is slow. The session is already
      // handshaken, so nothing else will settle the pool for this read.
      pool.delays.set('notion', CONNECT_WORK_MS);
      const startedAt = Date.now();
      void pool.sync(
        { jira: HTTP, notion: { ...HTTP, url: 'https://notion.example.test/mcp' } },
        {},
        { leaserId: 'L' },
      ).catch(() => {});

      expect(await subprocess.listToolNames()).toEqual(['jira__search', 'notion__search']);
      // Measured against the new server's own work time, so this cannot pass on
      // a list that answered before the connect began.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(CONNECT_WORK_MS - 40);
    } finally {
      await subprocess.close();
      await poolServer.stop().catch(() => {});
    }
  });

  it('the point-of-need wait is CAPPED, because codex drops a server that misses its own 30s wall', async () => {
    // Read from `openai/codex@rust-v0.148.0`: `DEFAULT_STARTUP_TIMEOUT` is 30 s
    // and, on a streamable-HTTP transport, it is a deadline shared across retry
    // attempts covering the `initialize` round trip. Our per-server connect
    // deadline is also 30 s, so an unbounded wait here would land on that wall
    // and codex would drop the pool server outright — losing EVERY source
    // rather than the slow one.
    // The production cap is `MCP_POOL_SERVER_STARTUP_WAIT_MS`; this drives the
    // same code path on the constructor's test seam so the suite does not spend
    // five seconds per assertion. The constant's own value is pinned below.
    const CAP_MS = 200;
    const lines: string[] = [];
    const pool = new TimedPool({ toolDescriptorStore: CACHED_STORE, connectionNonBlocking: false });
    pool.delays.set('jira', CAP_MS * 6);
    const poolServer = new McpPoolServer(pool, { leaserId: 'L', startupWaitMs: CAP_MS, debug: msg => lines.push(msg) });
    await poolServer.start();
    try {
      const startedAt = Date.now();
      void pool.sync({ jira: HTTP }, {}, { leaserId: 'L' }).catch(() => {});
      const subprocess = await attachSubprocess(poolServer);
      try {
        const elapsed = Date.now() - startedAt;
        // Bounded well below the server's own work time — the whole point.
        expect(elapsed).toBeLessThan(CAP_MS * 5);
        // Degraded, not empty: the descriptor cache is still what it answers
        // with, which is why the cap is survivable at all.
        expect(await subprocess.listToolNames()).toEqual(['jira__search']);

        const capped = lines.filter(line => line.includes('Stopped waiting for the MCP reconcile'));
        expect(capped.length).toBeGreaterThan(0);
        expect(capped[0]).toContain('still connecting: jira');
        // The consequence, not just the event: on this surface's runtime there
        // is no re-list, so the operator has to be told what the model lost.
        expect(capped[0]).toContain('will not see them this session');
      } finally {
        await subprocess.close();
      }
    } finally {
      await poolServer.stop().catch(() => {});
      // Let the straggler land so it cannot settle into another test's timing.
      await sleep(CAP_MS * 6);
    }
  });

  it('and the production cap is Claude\'s documented startup number, not an invented one', () => {
    // `env-vars.md#variables`, the `MCP_CONNECT_TIMEOUT_MS` row: "How long
    // blocking MCP startup waits, in milliseconds, for the connection batch
    // before snapshotting the tool list (default: 5000)." The pool declines that
    // number for its reconcile because the page puts it on an earlier phase —
    // and the pool server IS that earlier phase, so here it is parity. Pinned so
    // a later edit cannot quietly substitute a number nobody derived.
    expect(MCP_POOL_SERVER_STARTUP_WAIT_MS).toBe(MCP_DOCUMENTED_CONNECT_BATCH_TIMEOUT_MS);
    // Two independent ceilings it must stay under: codex's own
    // `DEFAULT_STARTUP_TIMEOUT` (30 s, `openai/codex@rust-v0.148.0`) and this
    // pool's per-server connect deadline (30 s).
    expect(MCP_POOL_SERVER_STARTUP_WAIT_MS).toBeLessThan(30_000);
  });

  it('CONTROL — awaiting the same reconcile pays the whole connect, which is what the old site did', async () => {
    const pool = new TimedPool({ toolDescriptorStore: CACHED_STORE, connectionNonBlocking: false });
    pool.delays.set('jira', CONNECT_WORK_MS);

    const startedAt = Date.now();
    await pool.sync({ jira: HTTP }, {}, { leaserId: 'L' });
    const elapsed = Date.now() - startedAt;

    // Measured against the server's own work time. Without this control the
    // test above proves only that a promise can be dropped.
    expect(elapsed).toBeGreaterThanOrEqual(CONNECT_WORK_MS - 40);
    expect(pool.finished).toEqual(['jira']);
  });

  it('a connect that fails while nobody is awaiting still reaches the sign-in verdict (P3.246)', async () => {
    // The deferral is only safe because the verdict it outruns is no longer
    // pull-only. Without `subscribeConnectionVerdictChanged` this is exactly
    // z7's twelve-failure measurement: the 401 lands after every reader read.
    const pool = new TimedPool({ toolDescriptorStore: CACHED_STORE, connectionNonBlocking: false });
    pool.delays.set('jira', 120);
    pool.failures.set('jira', Object.assign(new Error('http 401'), { code: 401 }));
    const announced: string[][] = [];
    const unsubscribe = pool.subscribeConnectionVerdictChanged(() => {
      announced.push(pool.authNeededSlugs('L'));
    });
    try {
      const reconcile = pool.sync({ jira: HTTP }, {}, { leaserId: 'L' });
      // Read at the instant a non-awaiting caller resumes: nothing is known
      // yet, and before P3.246 that state was final for the whole session.
      expect(pool.authNeededSlugs('L')).toEqual([]);
      expect(announced).toEqual([]);

      await reconcile;

      expect(pool.authNeededSlugs('L')).toEqual(['jira']);
      // The verdict CHANGED and somebody was told — the whole point, and the
      // reason the two call sites above may stop waiting.
      expect(announced.at(-1)).toEqual(['jira']);
    } finally {
      unsubscribe();
    }
  });
});

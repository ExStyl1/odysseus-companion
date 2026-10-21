/**
 * P3.246 — the pool's two USER-FACING verdicts get a change notification.
 *
 * `authNeededSlugs()` and `health().failed` are pull-only, and both of their
 * consumers pull once: the session-start pending-auth notice reads the first
 * immediately after a `sync`, the browse registry reads the second to judge a
 * pool stale. Every verdict that moved AFTER that read was invisible — a
 * credential revoked between two turns produced a 401 the pool recorded and
 * nobody heard, so the Connect button (the only sign-in affordance we ship for
 * an MCP server) never appeared. P3.237 measured the same defect on a deferred
 * connect and could not take Claude's non-blocking default because of it.
 *
 * The defect is one of ORDER, so these assertions are about order: what the
 * verdict said at the instant the listener ran, and how many times a reconcile
 * that passes through torn intermediates is allowed to speak.
 */
import { describe, expect, it } from 'bun:test';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool, type McpOpenConnectionRequest } from '../mcp-pool.ts';
import type { PoolClient } from '../client.ts';
import type { ToolDescriptorStore } from '../tool-descriptor-store.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';

const TOOL: Tool = { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } } as Tool;
const HTTP: SdkMcpServerConfig = { type: 'http', url: 'https://mcp.example.test/mcp' };
const OTHER: SdkMcpServerConfig = { type: 'http', url: 'https://other.example.test/mcp' };

/** A store that reports a previously-saved tool list — the documented cached row. */
const CACHED: ToolDescriptorStore = { read: () => [TOOL], write: () => {} };
/** A store that has never seen these connections. */
const COLD: ToolDescriptorStore = { read: () => [], write: () => {} };

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The shape the MCP SDK's HTTP transports throw: status on `code`. */
const httpError = (status: number) => Object.assign(new Error(`http ${status}`), { code: status });

/**
 * A pool whose transport is replaced wholesale: `connect` takes exactly the
 * time the test asks for and then registers a fake client whose tool call can
 * be made to fail. Nothing reaches a socket, so an observed ordering IS the
 * ordering under test.
 */
class TimedPool extends McpClientPool {
  readonly delays = new Map<string, number>();
  readonly failures = new Map<string, unknown>();
  /** Thrown by the next tool call, then consumed. */
  callFailures: unknown[] = [];

  protected override async openConnection({ slug }: McpOpenConnectionRequest): Promise<PoolClient> {
    const delay = this.delays.get(slug) ?? 0;
    if (delay > 0) await sleep(delay);
    const failure = this.failures.get(slug);
    if (failure) throw failure;
    return {
      listTools: async () => [TOOL],
      callTool: async () => {
        const callFailure = this.callFailures.shift();
        if (callFailure) throw callFailure;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
      close: async () => {},
    } as unknown as PoolClient;
  }
}

/**
 * Records, for every notification, what the verdicts said AT THAT MOMENT.
 * A listener told about a change before the change is readable is no better
 * than no listener at all, so the readings are what the tests assert on.
 */
function record(pool: McpClientPool, leaserId: string) {
  const readings: Array<{ auth: string[]; failed: string[] }> = [];
  const release = pool.subscribeConnectionVerdictChanged(() => {
    readings.push({ auth: pool.authNeededSlugs(leaserId), failed: [...pool.health(leaserId).failed] });
  });
  return { readings, release };
}

describe('a verdict that moves after the reader has read is announced', () => {
  it('announces a deferred connect\'s 401, with the slug already readable when the listener runs', async () => {
    // The exact case P3.237 could not ship as the default: the connect is
    // exempted from the first-turn wait, so its rejection lands after the
    // pending-auth notice was computed.
    const pool = new TimedPool({ toolDescriptorStore: CACHED, connectionNonBlocking: true });
    pool.delays.set('jira', 60);
    pool.failures.set('jira', httpError(401));
    const { readings } = record(pool, 'L');

    await pool.sync({ jira: HTTP }, {}, { leaserId: 'L' });
    // The reader's snapshot, taken exactly where SessionManager takes it.
    expect(pool.authNeededSlugs('L')).toEqual([]);
    expect(readings).toEqual([]);

    await sleep(160);

    // Told once, and the verdict was already true when we were told.
    expect(readings).toEqual([{ auth: ['jira'], failed: ['jira'] }]);
  });

  it('announces a 401 on a TOOL CALL, which needs no deferral at all', async () => {
    // The positive control for the claim that this gap predates P3.237: no
    // lever is set here, the connect is fully awaited, and the verdict still
    // moves long after every reader has read.
    const pool = new TimedPool({ toolDescriptorStore: CACHED });
    await pool.sync({ jira: HTTP }, {}, { leaserId: 'L' });
    const { readings } = record(pool, 'L');
    pool.callFailures = [httpError(401)];

    await pool.callTool('mcp__jira__echo', {}, undefined, { leaserId: 'L' });

    expect(readings).toEqual([{ auth: ['jira'], failed: [] }]);
  });

  it('announces the recovery too, so a stale sign-in prompt cannot persist', async () => {
    const pool = new TimedPool({ toolDescriptorStore: CACHED });
    await pool.sync({ jira: HTTP }, {}, { leaserId: 'L' });
    pool.callFailures = [httpError(401)];
    await pool.callTool('mcp__jira__echo', {}, undefined, { leaserId: 'L' });
    const { readings } = record(pool, 'L');

    // The re-authenticated call goes through and clears the verdict.
    await pool.callTool('mcp__jira__echo', {}, undefined, { leaserId: 'L' });

    expect(readings).toEqual([{ auth: [], failed: [] }]);
  });

  it('announces a transport failure, which is `health().failed` and not a sign-in', async () => {
    const pool = new TimedPool({ toolDescriptorStore: CACHED, connectionNonBlocking: true });
    pool.delays.set('jira', 60);
    pool.failures.set('jira', Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }));
    const { readings } = record(pool, 'L');

    await pool.sync({ jira: HTTP }, {}, { leaserId: 'L' });
    expect(readings).toEqual([]);

    await sleep(160);

    expect(readings).toEqual([{ auth: [], failed: ['jira'] }]);
  });

  it('stops announcing once the subscriber releases', async () => {
    const pool = new TimedPool({ toolDescriptorStore: CACHED });
    await pool.sync({ jira: HTTP }, {}, { leaserId: 'L' });
    const { readings, release } = record(pool, 'L');
    release();
    pool.callFailures = [httpError(401)];

    await pool.callTool('mcp__jira__echo', {}, undefined, { leaserId: 'L' });

    expect(readings).toEqual([]);
    expect(pool.authNeededSlugs('L')).toEqual(['jira']);
  });
});

describe('a reconcile speaks once, and only about its settled state', () => {
  it('never publishes the empty verdict a reconcile passes through while sweeping the old set', async () => {
    // The deterministic tear, and the reason the reconcile is suspended rather
    // than left to the signature guard. A reconcile's cleanup pass CLEARS the
    // previous set's verdicts before the connect pass records the new ones, so
    // there is a real instant at which the pool believes nothing needs signing
    // in. Announced, that instant renders a notice saying everything is fine —
    // and then a second one contradicting it.
    const pool = new TimedPool({ toolDescriptorStore: COLD });
    pool.failures.set('old', httpError(401));
    pool.failures.set('new', httpError(401));
    await pool.sync({ old: HTTP }, {}, { leaserId: 'L' });
    expect(pool.authNeededSlugs('L')).toEqual(['old']);
    const { readings } = record(pool, 'L');

    // Same leaser, entirely different server: `old` is swept, `new` fails.
    await pool.sync({ new: OTHER }, {}, { leaserId: 'L' });

    expect(readings).toEqual([{ auth: ['new'], failed: ['new'] }]);
  });

  it('does not publish the torn intermediates a reconcile passes through', async () => {
    // A reconcile marks filtered connections failed, disconnects the undesired
    // and only then connects the rest. A listener that read `health()` between
    // those passes would act on a verdict the pool is about to contradict, so
    // the whole pass is one announcement.
    const pool = new TimedPool({ toolDescriptorStore: COLD });
    pool.failures.set('broken', httpError(401));
    const { readings } = record(pool, 'L');

    await pool.sync({ good: HTTP, broken: OTHER }, {}, { leaserId: 'L' });

    expect(readings).toEqual([{ auth: ['broken'], failed: ['broken'] }]);
  });

  /**
   * DA3.15 — "no verdict changed" depends on the two leasers sharing ONE
   * connection: the second sync finds the same failed connection the first one
   * already spoke about, so there is nothing new to say.
   *
   * Under `NESSY_MCP_CONNECTION_ISOLATION=per-leaser` the second leaser gets its
   * own connection, which fails afresh and is a genuinely new verdict, so the
   * reading is non-empty (measured 2026-09-17). Deliberately not pinned to
   * `shared`; see the note on the deadline case for why these five are left as
   * the default's instrument.
   */
  it('says nothing when a re-sync changes no verdict', async () => {
    const pool = new TimedPool({ toolDescriptorStore: COLD });
    pool.failures.set('broken', httpError(401));
    await pool.sync({ good: HTTP, broken: OTHER }, {}, { leaserId: 'L' });
    const { readings } = record(pool, 'L');

    // A second leaser wanting the identical set joins the union; the connection
    // identities and every verdict are unchanged.
    await pool.sync({ good: HTTP, broken: OTHER }, {}, { leaserId: 'M' });

    expect(readings).toEqual([]);
  });

  it('says nothing for a pool that comes up empty and stays empty', async () => {
    const pool = new TimedPool({ toolDescriptorStore: COLD });
    const { readings } = record(pool, 'L');

    await pool.sync({}, {}, { leaserId: 'L' });

    expect(readings).toEqual([]);
  });
});

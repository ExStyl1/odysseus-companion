/**
 * P2.280 — a codex session's host-callback bridge either came up or it did not,
 * and until this row NOTHING outside `CodexAgent` could tell which.
 *
 * `startCallbackBridge` fails non-fatally BY DESIGN — its own diagnostic reads
 * "scheduling tools stay unavailable this session" — and that diagnostic went to
 * `debug()`, which routes through electron-log with the main process's
 * transports disabled. So a session running with 18 tools and none of the cron
 * four was indistinguishable, from outside, from one running with 26. Every
 * remedy for "`/loop` is offered where its tools are absent" needs that fact to
 * exist first; these rows are the fact.
 *
 * Four propositions, each separable:
 *
 * 1. **A fresh agent is `not-started`, not `unavailable`.** This is the one that
 *    stops the fix becoming the mirror of the bug: the runtime is built inside
 *    the chat generator's `ensureRuntime()`, so EVERY codex session is in this
 *    state when its first capability view is frozen. A version that reported
 *    `unavailable` here would withhold `/loop` from every codex session on turn
 *    one, including the overwhelming majority whose bridge is about to be fine.
 * 2. **A real listen flips it to `active`.** No double: the bridge really binds
 *    127.0.0.1:0 and is really closed afterwards. Without this arm, arm 3 passes
 *    on an implementation that reports `unavailable` unconditionally.
 * 3. **Both failure shapes report `unavailable`** — a throwing listen, and a
 *    config with no session identity to bind to. The second is not a lesser
 *    case: it omits the very same `--host-callback-port` argument, so the
 *    subprocess's surface is stripped identically, and it reaches the state
 *    with no mock in play at all.
 * 4. **Teardown returns to `not-started`, not to a latch.** `createRuntime`
 *    re-attempts the listen, so a torn-down session must not keep reporting a
 *    failure it has not had yet.
 *
 * The bridge module is mocked with a SPREAD, delegating to the real function
 * unless a test asks for a rejection, and restored from a reference captured
 * BEFORE the mock is installed — a bare `mock.module` amputates the module for
 * every later test file in the process, and restoring by re-spreading the
 * already-mutated namespace re-installs the mock permanently.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

import * as realBridge from '../backend/codex/session-callback-bridge.ts';

const originals = { startCodexSessionCallbackBridge: realBridge.startCodexSessionCallbackBridge };

/** When set, the next `startCallbackBridge` sees a listen that throws. */
let listenFailure: Error | null = null;

mock.module('../backend/codex/session-callback-bridge.ts', () => ({
  ...realBridge,
  startCodexSessionCallbackBridge: (options: Parameters<typeof originals.startCodexSessionCallbackBridge>[0]) => (
    listenFailure
      ? Promise.reject(listenFailure)
      : originals.startCodexSessionCallbackBridge(options)
  ),
}));

afterAll(() => {
  mock.module('../backend/codex/session-callback-bridge.ts', () => ({
    ...realBridge,
    startCodexSessionCallbackBridge: originals.startCodexSessionCallbackBridge,
  }));
});

const { CodexAgent } = await import('../codex-agent.ts');
import type { BackendConfig } from '../backend/types.ts';

const WORKSPACE_ID = 'ws-bridge-state';
const SESSION_ID = 'session-bridge-state';

function createAgent(options: { withoutSessionIdentity?: boolean } = {}): any {
  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Bridge State Workspace',
      rootPath: '/tmp/ws-bridge-state-root',
      workspaceRootPath: '/tmp/ws-bridge-state-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-bridge-state',
    } as any,
    ...(options.withoutSessionIdentity
      ? {}
      : {
        session: {
          id: SESSION_ID,
          workspaceRootPath: '/tmp/ws-bridge-state-root',
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          workingDirectory: '/tmp/project-root',
        } as any,
      }),
    model: 'codex/test-model',
    isHeadless: true,
    runtime: { paths: { sessionServer: '/tmp/session-mcp-server.js', node: '/tmp/node' } },
  } as any;
  return new CodexAgent(config);
}

describe('P2.280 · the codex scheduling bridge reports its own outcome', () => {
  beforeEach(() => { listenFailure = null; });

  it('a fresh agent is not-started — the state every session is in on turn one', () => {
    expect(createAgent().getSchedulingBridgeState()).toBe('not-started');
  });

  it('a real listen reports active, and the port reaches the session MCP argv', async () => {
    const agent = createAgent();
    const handle = await agent.startCallbackBridge();
    try {
      expect(agent.getSchedulingBridgeState()).toBe('active');
      expect(typeof handle?.port).toBe('number');
      // The state and the spawn argument must agree: `active` is worthless if
      // the subprocess is still spawned without `--host-callback-port`.
      expect(agent.buildSessionMcpSpec(handle!.port)?.args)
        .toContain('--host-callback-port');
    } finally {
      await handle?.close();
    }
  });

  it('a listen that throws reports unavailable, and the argv loses the flag', async () => {
    listenFailure = new Error('listen EMFILE 127.0.0.1');
    const agent = createAgent();

    expect(await agent.startCallbackBridge()).toBeUndefined();
    expect(agent.getSchedulingBridgeState()).toBe('unavailable');
    expect(agent.buildSessionMcpSpec(undefined)?.args)
      .not.toContain('--host-callback-port');
  });

  // No mock in play on this arm: the early return is reached by CONFIG, so it
  // proves the state without any double at all.
  it('a config with no session identity reports unavailable too', async () => {
    const agent = createAgent({ withoutSessionIdentity: true });

    expect(await agent.startCallbackBridge()).toBeUndefined();
    expect(agent.getSchedulingBridgeState()).toBe('unavailable');
  });

  it('teardown returns to not-started so the next runtime may retry', async () => {
    listenFailure = new Error('listen EADDRNOTAVAIL 127.0.0.1');
    const agent = createAgent();
    await agent.startCallbackBridge();
    expect(agent.getSchedulingBridgeState()).toBe('unavailable');

    await agent.teardownRuntime();

    expect(agent.getSchedulingBridgeState()).toBe('not-started');
  });
});

/**
 * P6.183 — the bind itself, one layer below the state above.
 *
 * `listenOnLoopbackWithRetry` is the whole failure surface the row named: the
 * old code was one `server.listen` whose rejection cost the session the eleven
 * bridge-only tools with no retry and no record of WHY. Three arms:
 *
 * 1. **A first failure is survived on a REAL socket.** The double fails only
 *    the first `listen` call and delegates the rest to a genuine
 *    `http.Server`, so attempt 2 binds a real loopback port — the "comes up
 *    bridged anyway" half of `done_means`, measured rather than mocked.
 * 2. **Every attempt failing still fails**, with the error CODE and the attempt
 *    count in the message; that string is what `startCallbackBridge` puts on
 *    the durable operator notice, so the honest arm is not regressed.
 * 3. **The code is recorded per attempt** on the diagnostic channel. Measured
 *    2026-09-06: bun reports a privileged-port refusal as `EADDRINUSE` where
 *    node reports `EACCES`, which is why the retry is bounded-and-blind rather
 *    than keyed on a code that means different things in the two runtimes this
 *    module runs in.
 */
describe('P6.183 · the bridge bind is retried, and its failure carries a code', () => {
  const bindError = (code: string) => Object.assign(new Error(`listen ${code} 127.0.0.1`), { code });

  it('survives a first failure and still binds a real loopback port', async () => {
    const { createServer } = await import('node:http');
    const { listenOnLoopbackWithRetry } = await import('../backend/codex/session-callback-bridge.ts');
    const real = createServer(() => {});
    let attempts = 0;
    const listener: any = {
      listen: (...args: unknown[]) => {
        attempts += 1;
        if (attempts === 1) {
          queueMicrotask(() => real.emit('error', bindError('EMFILE')));
          return real;
        }
        return (real.listen as any)(...args);
      },
      once: (event: string, fn: any) => real.once(event as any, fn),
      on: (event: string, fn: any) => real.on(event as any, fn),
      removeListener: (event: string, fn: any) => real.removeListener(event as any, fn),
      address: () => real.address(),
    };
    const seen: string[] = [];

    const port = await listenOnLoopbackWithRetry(listener, message => seen.push(message), 0);
    try {
      expect(attempts).toBe(2);
      expect(port).toBeGreaterThan(0);
      expect(seen.some(line => line.includes('EMFILE') && line.includes('attempt 1 of 3'))).toBe(true);
      expect(seen.some(line => line.includes('bound on attempt 2 of 3'))).toBe(true);
    } finally {
      await new Promise<void>(resolve => real.close(() => resolve()));
    }
  });

  it('gives up after the bound and names the code and the attempt count', async () => {
    const { EventEmitter } = await import('node:events');
    const { listenOnLoopbackWithRetry } = await import('../backend/codex/session-callback-bridge.ts');
    const emitter = new EventEmitter();
    let attempts = 0;
    const listener: any = {
      listen: () => { attempts += 1; queueMicrotask(() => emitter.emit('error', bindError('EADDRINUSE'))); },
      once: (event: string, fn: any) => emitter.once(event, fn),
      on: (event: string, fn: any) => emitter.on(event, fn),
      removeListener: (event: string, fn: any) => emitter.removeListener(event, fn),
      address: () => null,
    };

    await expect(listenOnLoopbackWithRetry(listener, () => {}, 0)).rejects.toThrow(
      /could not bind 127\.0\.0\.1 after 3 attempts \(EADDRINUSE\)/,
    );
    expect(attempts).toBe(3);
  });
});

import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import type { AgentEvent } from '@nessy-agent/core/types';

/**
 * P6.271 half (a) — a worker shutting down is announced on claude and, until
 * this row, on neither of the other two.
 *
 * The signal is HOST-originated on Pi (`this.send({ type: 'shutdown' })`), so
 * nothing had to be learned — only said. The reference is the SDK message
 * claude already renders, `SDKWorkerShuttingDownMessage`, whose own docblock in
 * the vendored `sdk.d.ts` reads: *"Emitted by the bridge on opt-in graceful
 * worker teardown (only when the teardown caller supplied a reason) … Absence
 * is NOT a dead-host signal: handoffs (/update, /teleport, respawn),
 * auto-disable, mode transitions, and internal fatal-error paths emit nothing
 * by design."*
 *
 * Hence the two cases below are a PAIR, and the negative is the one that
 * carries the contract: the graceful path speaks, the abrupt path — abort,
 * reconnect, error recovery, final destroy — stays silent exactly as claude
 * does. A test that only asserted the notice exists would pass equally well
 * over an implementation that shouted on every teardown.
 */

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-shutdown-notice',
      name: 'Shutdown Notice Workspace',
      rootPath: '/tmp/nessy-general-agent-shutdown-notice',
      workspaceRootPath: '/tmp/nessy-general-agent-shutdown-notice',
      sessionRootPath: '/tmp/nessy-general-agent-shutdown-notice-sessions/ws-shutdown-notice',
    } as any,
    session: {
      id: 'session-shutdown-notice',
      workspaceRootPath: '/tmp/nessy-general-agent-shutdown-notice',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    skipConfigWatcher: true,
  } as BackendConfig;
}

interface Rig {
  agent: PiAgent;
  /** Everything the agent put on the turn's own event queue, in order. */
  queued: AgentEvent[];
  /** True once `complete()` has been signalled, recorded per enqueue. */
  completedBeforeEnqueue: boolean[];
}

function setupRig(): Rig {
  const agent = new PiAgent(createConfig());
  const queued: AgentEvent[] = [];
  const completedBeforeEnqueue: boolean[] = [];
  (agent as any).send = () => {};
  (agent as any).debug = () => {};
  const eventQueue = (agent as any).eventQueue;
  const enqueue = eventQueue.enqueue.bind(eventQueue);
  eventQueue.enqueue = (event: AgentEvent) => {
    queued.push(event);
    completedBeforeEnqueue.push(eventQueue.isComplete === true);
    enqueue(event);
  };
  return { agent, queued, completedBeforeEnqueue };
}

describe('P6.271 — the Pi worker-shutdown notice', () => {
  it('the graceful restart teardown prints claude\'s own sentence, at warning level, before the queue closes', async () => {
    const rig = setupRig();

    await rig.agent.disposeForRestart();

    const notices = rig.queued.filter(
      (event): event is Extract<AgentEvent, { type: 'info' }> => event.type === 'info',
    );
    expect(notices).toHaveLength(1);
    // Parallel to `backend/claude/event-adapter.ts`'s
    // `Claude worker is shutting down (<reason>).` — one sentence for a user who
    // switches runtimes, and a snake_case reason as the SDK's own field is
    // documented to carry ("Short snake_case reason set by the host CLI").
    expect(notices[0]!.message).toBe('Pi worker is shutting down (runtime_restart).');
    expect(notices[0]!.level).toBe('warning');

    // The ordering half. `EventQueue.drain()` breaks out of its loop once
    // `complete()` has been signalled and the queue is drained, so a notice
    // enqueued after that line can vanish without a trace. Asserting the
    // message alone would not see the difference.
    expect(rig.completedBeforeEnqueue).toEqual([false]);
  });

  it('an abrupt teardown stays silent, as claude does on its internal paths', async () => {
    const rig = setupRig();

    // `reconnect()` is the plainest caller of `killSubprocess()` — the path
    // abort, error recovery and final destroy also take. No child is attached,
    // which is itself the common case for those paths.
    await rig.agent.reconnect();

    expect(rig.queued.filter(event => event.type === 'info')).toEqual([]);
  });
});

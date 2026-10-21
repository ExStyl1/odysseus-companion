/**
 * L9 — THE HOST'S ROUTE TO THE PI SUBPROCESS'S `BackgroundTaskRegistry`.
 *
 * Before this there was none. Every member of the subprocess's `InboundMessage`
 * union was checked and none reached the registry, so `SessionManager.stopAgentTask`
 * could only call the host-side `ChildSessionService` — which cannot stop a
 * `kind: 'mcp'` task at all (no child record exists for one) and stops only the
 * CURRENT NODE of a background workflow while the DAG script keeps scheduling. The
 * model's own `stopTask` tool has always tried the registry first; this is the same
 * order, reached from the host.
 *
 * What is pinned here is the correlation, the settlement and — most of all — that
 * every non-answer resolves rather than rejects: the caller is a button press whose
 * next move is to try the durable child service, so an exception nobody catches
 * would turn "not mine" into a failed RPC.
 */
import { describe, expect, it, jest } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-l9',
      name: 'L9 Workspace',
      rootPath: '/tmp/nessy-l9-stop-background-task',
      workspaceRootPath: '/tmp/nessy-l9-stop-background-task',
      sessionRootPath: '/tmp/nessy-l9-stop-background-task-sessions/ws-l9',
    } as never,
    session: {
      id: 'session-l9',
      workspaceRootPath: '/tmp/nessy-l9-stop-background-task',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as never,
    isHeadless: true,
  } as BackendConfig;
}

/** A PiAgent whose `send` is captured and which believes it has a live subprocess. */
function liveAgent(): { agent: PiAgent; sent: Array<Record<string, unknown>> } {
  const agent = new PiAgent(createConfig());
  const sent: Array<Record<string, unknown>> = [];
  (agent as unknown as { subprocess: unknown }).subprocess = { pid: 1234 };
  (agent as unknown as { send: (cmd: Record<string, unknown>) => void }).send = cmd => { sent.push(cmd); };
  return { agent, sent };
}

describe('PiAgent.stopBackgroundTask', () => {
  it('sends one correlated stop_background_task and resolves stopped on the registry answer', async () => {
    const { agent, sent } = liveAgent();
    try {
      const promise = agent.stopBackgroundTask('task-mcp-1');
      await Promise.resolve();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: 'stop_background_task', taskId: 'task-mcp-1' });
      expect(typeof sent[0]!.id).toBe('string');

      ;(agent as unknown as { handleStopBackgroundTaskResult: (msg: Record<string, unknown>) => void })
        .handleStopBackgroundTaskResult({ id: sent[0]!.id, stopped: true });

      expect(await promise).toEqual({ stopped: true });
    } finally {
      agent.destroy();
    }
  });

  it('resolves "not mine" — stopped:false with NO error — so the caller falls through', async () => {
    // The registry returns false for an id it does not hold. That is the whole
    // reason the host asks it FIRST and the durable child service second, so it
    // must not be dressed up as a failure.
    const { agent, sent } = liveAgent();
    try {
      const promise = agent.stopBackgroundTask('bg-1');
      await Promise.resolve();
      ;(agent as unknown as { handleStopBackgroundTaskResult: (msg: Record<string, unknown>) => void })
        .handleStopBackgroundTaskResult({ id: sent[0]!.id, stopped: false });

      const outcome = await promise;
      expect(outcome.stopped).toBe(false);
      expect(outcome.error).toBeUndefined();
    } finally {
      agent.destroy();
    }
  });

  it('carries the registry\'s own failure so a half-stopped tree is never called a stop', async () => {
    const { agent, sent } = liveAgent();
    try {
      const promise = agent.stopBackgroundTask('wf-1');
      await Promise.resolve();
      ;(agent as unknown as { handleStopBackgroundTaskResult: (msg: Record<string, unknown>) => void })
        .handleStopBackgroundTaskResult({
          id: sent[0]!.id,
          stopped: false,
          errorMessage: 'background-task-stop-failed:wf-1',
        });

      expect(await promise).toEqual({ stopped: false, error: 'background-task-stop-failed:wf-1' });
    } finally {
      agent.destroy();
    }
  });

  it('ignores a result for an id it is not waiting on', async () => {
    const { agent, sent } = liveAgent();
    try {
      const promise = agent.stopBackgroundTask('bg-1');
      await Promise.resolve();
      const handler = (agent as unknown as { handleStopBackgroundTaskResult: (msg: Record<string, unknown>) => void })
        .handleStopBackgroundTaskResult.bind(agent);
      handler({ id: 'stop-background-task-999', stopped: true });
      handler({ id: sent[0]!.id, stopped: false });
      expect((await promise).stopped).toBe(false);
    } finally {
      agent.destroy();
    }
  });

  it('answers without sending anything when there is no subprocess', async () => {
    // Deliberately NOT `ensureSubprocess()`: a subprocess that does not exist is
    // holding no background task, and starting one to discover that would be
    // absurd. The answer is "not mine", which sends the caller to the next arm.
    const agent = new PiAgent(createConfig());
    const sent: Array<Record<string, unknown>> = [];
    (agent as unknown as { send: (cmd: Record<string, unknown>) => void }).send = cmd => { sent.push(cmd); };
    try {
      expect(await agent.stopBackgroundTask('bg-1')).toEqual({ stopped: false });
      expect(sent).toEqual([]);
    } finally {
      agent.destroy();
    }
  });

  it('settles every waiting stop when the subprocess dies, as "not mine" rather than as a failure', async () => {
    // THIS ASSERTION IS THE CORRECTED ONE. It used to require `outcome.error` to
    // contain "exited unexpectedly", and an `error` is the single shape
    // `SessionManager.stopAgentTask` refuses to fall through on — it means "this
    // mechanism owned the id and the stop went wrong". So a stop in flight when the
    // subprocess died was reported to the user as a FAILURE and the durable
    // child-session port was never tried, which is exactly what
    // `pendingStopBackgroundTasks`' own comment says must happen. The registry died
    // with the subprocess, so there is no half-stopped tree to protect here, and the
    // reason is logged instead of smuggled through the contract's error slot.
    const { agent, sent } = liveAgent();
    try {
      const promise = agent.stopBackgroundTask('bg-1');
      await Promise.resolve();
      expect(sent).toHaveLength(1);
      ;(agent as unknown as { rejectPendingSubprocessRequests: (error: Error) => void })
        .rejectPendingSubprocessRequests(new Error('Pi subprocess exited unexpectedly (code 1)'));

      const outcome = await promise;
      expect(outcome.stopped).toBe(false);
      expect(outcome.error).toBeUndefined();
    } finally {
      agent.destroy();
    }
  });

  it('answers "not mine" when nothing answers inside the deadline, so an old bundle reaches the fallback', async () => {
    // The method's doc comment has always promised this: "an old bundle that does
    // not know the message degrades to 'not mine' after the deadline instead of
    // hanging the button". It did not — the deadline resolved with an `error`, so
    // the host stopped there and a subprocess bundle predating
    // `stop_background_task` could never use the child-session route at all.
    jest.useFakeTimers();
    const { agent, sent } = liveAgent();
    try {
      const promise = agent.stopBackgroundTask('bg-1');
      await Promise.resolve();
      expect(sent).toHaveLength(1);
      // Nothing ever calls handleStopBackgroundTaskResult: an old bundle has no
      // handler for the message and answers nothing at all.
      jest.advanceTimersByTime(15_000);

      const outcome = await promise;
      expect(outcome.stopped).toBe(false);
      expect(outcome.error).toBeUndefined();
    } finally {
      jest.useRealTimers();
      agent.destroy();
    }
  });
});

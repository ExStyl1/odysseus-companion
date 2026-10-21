import { describe, expect, it } from 'bun:test';
import { NESTOR_CANCEL_TIMEOUT_MS, NestorCloudTurn } from '../turn.ts';

interface CancelRecord {
  taskId: string;
  signal?: AbortSignal;
}

function createTurn(options: {
  cancels: CancelRecord[];
  updates?: unknown[];
  signal?: AbortSignal;
  createCancelSignal?: () => AbortSignal | undefined;
}): NestorCloudTurn {
  return new NestorCloudTurn({
    taskId: 'task-1',
    client: {
      loadAgentCard: async () => ({}),
      sendMessageStream: async function* () {},
      sendToolResultsStream: async function* () {},
      cancelTask: async (taskId: string, signal?: AbortSignal) => {
        options.cancels.push({ taskId, ...(signal ? { signal } : {}) });
      },
    } as never,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.createCancelSignal ? { createCancelSignal: options.createCancelSignal } : {}),
    onContextUpdate: (update) => {
      options.updates?.push(update);
    },
  });
}

describe('Nestor cloud cancel behavior', () => {
  it('aborts local stream by canceling active remote task and clearing backend task state', async () => {
    const updates: unknown[] = [];
    const cancels: CancelRecord[] = [];
    const turn = createTurn({ cancels, updates });

    const events = [];
    for await (const event of turn.cancelWithEvents()) {
      events.push(event);
    }

    expect(cancels.map(record => record.taskId)).toEqual(['task-1']);
    expect(updates).toContainEqual({ clearTask: true, taskStatus: 'canceled' });
    expect(events).toEqual([
      { type: 'status', message: 'Stopping Nestor task...' },
      { type: 'complete' },
    ]);
  });

  it('never sends the cancel on the turn signal that was just aborted (F20)', async () => {
    const cancels: CancelRecord[] = [];
    const controller = new AbortController();
    const turn = createTurn({ cancels, signal: controller.signal });

    // Every production cancel path aborts the turn first; passing that signal
    // into the cancel fetch kills the request before it leaves the process.
    controller.abort();
    await turn.cancel();

    expect(cancels).toHaveLength(1);
    const sent = cancels[0]?.signal;
    expect(sent).toBeDefined();
    expect(sent).not.toBe(controller.signal);
    expect(sent?.aborted).toBe(false);
  });

  it('bounds the cancel with its own 5s timeout signal', async () => {
    const cancels: CancelRecord[] = [];
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const requested: number[] = [];
    AbortSignal.timeout = ((ms: number) => {
      requested.push(ms);
      return originalTimeout(ms);
    }) as typeof AbortSignal.timeout;
    try {
      const turn = createTurn({ cancels });
      await turn.cancel();
    } finally {
      AbortSignal.timeout = originalTimeout as typeof AbortSignal.timeout;
    }

    expect(NESTOR_CANCEL_TIMEOUT_MS).toBe(5000);
    expect(requested).toEqual([NESTOR_CANCEL_TIMEOUT_MS]);
    expect(cancels[0]?.signal).toBeDefined();
  });

  it('uses an injected cancel-signal factory when one is supplied', async () => {
    const cancels: CancelRecord[] = [];
    const injected = new AbortController().signal;
    let calls = 0;
    const turn = createTurn({
      cancels,
      createCancelSignal: () => {
        calls++;
        return injected;
      },
    });

    await turn.cancel();

    expect(calls).toBe(1);
    expect(cancels[0]?.signal).toBe(injected);
  });

  it('sends the RPC but touches no sidecar when the cancel is a teardown cancel', async () => {
    // A teardown cancel outlives its agent: the awaited RPC can settle seconds
    // after `destroy()`, and the context store it would notify rebuilds the
    // whole sidecar from a CACHED snapshot — resurrecting a file the teardown
    // (or a newer session) already superseded.
    const updates: unknown[] = [];
    const cancels: CancelRecord[] = [];
    const turn = createTurn({ cancels, updates });

    await turn.cancel({ updateSidecar: false });

    expect(cancels.map(record => record.taskId)).toEqual(['task-1']);
    expect(updates).toEqual([]);

    // The in-memory task id is still cleared, so a second cancel is a no-op.
    await turn.cancel({ updateSidecar: false });
    expect(cancels).toHaveLength(1);
  });

  it('does not call the backend when the turn holds no task', async () => {
    const cancels: CancelRecord[] = [];
    const turn = new NestorCloudTurn({
      client: {
        loadAgentCard: async () => ({}),
        sendMessageStream: async function* () {},
        sendToolResultsStream: async function* () {},
        cancelTask: async (taskId: string) => {
          cancels.push({ taskId });
        },
      } as never,
    });

    await turn.cancel();

    expect(cancels).toHaveLength(0);
  });
});

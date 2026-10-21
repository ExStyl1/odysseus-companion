import { describe, expect, it } from 'bun:test';
import { toNestorStreamError } from '../client.ts';
import { NestorCloudRetryableTransportError, RATE_LIMIT_MAX_RETRIES } from '../retry.ts';
import { NestorCloudTurn } from '../turn.ts';
import type { A2AStreamEvent } from '../types.ts';

/**
 * The rate-limit survival contract (F9/F18/F27), end to end through the turn.
 *
 * Two paths, deliberately different: a transport 429 throws BEFORE any frame, so
 * the ORIGINAL args are re-sent verbatim; an in-band `-32029` retryable-error
 * data part ends the stream INPUT_REQUIRED, so the retry is a NEW send carrying
 * the retry marker part on `contextId` alone.
 */
class FakeClient {
  cancelCalls: string[] = [];
  messageCalls: Array<Record<string, unknown>> = [];
  toolResultCalls: Array<Record<string, unknown>> = [];
  retryMarkerCalls: Array<Record<string, unknown>> = [];
  messageStreams: Array<AsyncIterable<A2AStreamEvent>> = [];
  toolStreams: Array<AsyncIterable<A2AStreamEvent>> = [];
  retryMarkerStreams: Array<AsyncIterable<A2AStreamEvent>> = [];

  async loadAgentCard() {
    return {};
  }

  sendMessageStream(args: Record<string, unknown>) {
    this.messageCalls.push(args);
    return this.messageStreams.shift() ?? stream(completed());
  }

  sendToolResultsStream(args: Record<string, unknown>) {
    this.toolResultCalls.push(args);
    return this.toolStreams.shift() ?? stream(completed());
  }

  sendRetryMarkerStream(args: Record<string, unknown>) {
    this.retryMarkerCalls.push(args);
    return this.retryMarkerStreams.shift() ?? stream(completed());
  }

  async cancelTask(taskId: string) {
    this.cancelCalls.push(taskId);
  }
}

function stream(...events: A2AStreamEvent[]): AsyncIterable<A2AStreamEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function throwingStream(err: Error): AsyncIterable<A2AStreamEvent> {
  return (async function* () {
    throw err;
  })();
}

/** Frames the attempt DID deliver, then the rejection that ended it mid-stream. */
function streamThenThrow(events: A2AStreamEvent[], err: Error): AsyncIterable<A2AStreamEvent> {
  return (async function* () {
    for (const event of events) yield event;
    throw err;
  })();
}

function terminalTaskRejection(): Error {
  return toNestorStreamError({
    code: -32004,
    message: 'invalid params',
    data: { error: 'task is already in terminal state' },
  });
}

function task(): A2AStreamEvent {
  return { task: { id: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_SUBMITTED' } } };
}

function completed(text = 'done'): A2AStreamEvent {
  return {
    statusUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      status: {
        state: 'TASK_STATE_COMPLETED',
        message: { messageId: 'msg-done', role: 'ROLE_AGENT', parts: text ? [{ text }] : [] },
      },
    },
  };
}

/**
 * The backend's retryable-error shape: the error parts ride a WORKING update and
 * are followed by INPUT_REQUIRED (`a2a_environment.go:157-165`) — the task stays
 * addressable and the stream simply ends.
 */
function retryableErrorFrames(
  code = -32029,
  message = 'Inference rate limit error occurred, please try again later',
  text = 'half an answ',
): A2AStreamEvent[] {
  return [
    {
      statusUpdate: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        status: {
          state: 'TASK_STATE_WORKING',
          message: {
            messageId: 'msg-err',
            role: 'ROLE_AGENT',
            parts: [
              ...(text ? [{ text }] : []),
              { data: { data_type: 'retryable_error', data_version: 1, id: 'req-1', error: { code, message } } },
            ],
          },
        },
      },
    },
    {
      statusUpdate: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { messageId: 'msg-err-2', role: 'ROLE_AGENT', parts: [] } },
      },
    },
  ];
}

function inputRequiredWithTool(): A2AStreamEvent {
  return {
    statusUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      status: {
        state: 'TASK_STATE_INPUT_REQUIRED',
        message: {
          messageId: 'msg-tool',
          role: 'ROLE_AGENT',
          parts: [{
            data: {
              data_type: 'tool_call',
              data_version: 1,
              id: 'call-1',
              index: 0,
              function: { name: 'list_files', arguments: '{"path":"/workspace"}' },
            },
          }],
        },
      },
    },
  };
}

function rateLimited(message = 'суточный лимит токенов исчерпан, лимит обновится в 00:00'): Error {
  return new NestorCloudRetryableTransportError(429, message, true);
}

interface Harness {
  client: FakeClient;
  turn: NestorCloudTurn;
  sleeps: number[];
}

function harness(options: {
  contextId?: string;
  taskId?: string;
  answerToolCall?: { toolCallId: string; name: string };
  signal?: AbortSignal;
  sleepReturns?: boolean[];
  metadata?: Record<string, unknown>;
  executeTool?: NonNullable<ConstructorParameters<typeof NestorCloudTurn>[0]['executeTool']>;
} = {}): Harness {
  const client = new FakeClient();
  const sleeps: number[] = [];
  const sleepReturns = options.sleepReturns ? [...options.sleepReturns] : [];
  const turn = new NestorCloudTurn({
    client: client as never,
    ...(options.contextId ? { contextId: options.contextId } : {}),
    ...(options.taskId ? { taskId: options.taskId } : {}),
    ...(options.answerToolCall ? { answerToolCall: options.answerToolCall } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
    ...(options.executeTool ? { executeTool: options.executeTool } : {}),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      return sleepReturns.length > 0 ? sleepReturns.shift()! : true;
    },
  });
  return { client, turn, sleeps };
}

async function collect(turn: NestorCloudTurn, message = 'hello') {
  const events = [];
  for await (const event of turn.run(message)) events.push(event);
  return events;
}

describe('NestorCloudTurn transport 429', () => {
  it('backs off and re-sends the ORIGINAL message args unchanged', async () => {
    const { client, turn, sleeps } = harness({ contextId: 'ctx-1', metadata: { mode: 'act' } });
    client.messageStreams.push(throwingStream(rateLimited()));
    client.messageStreams.push(stream(task(), completed('PONG')));

    const events = await collect(turn, 'ping');

    expect(sleeps).toEqual([5_000]);
    expect(client.messageCalls).toHaveLength(2);
    // Verbatim: same text, same contextId, same metadata — a rebuilt send would
    // be a different request on a wire where metadata carries the tool set.
    const { signal: _first, ...firstSend } = client.messageCalls[0]!;
    const { signal: _second, ...secondSend } = client.messageCalls[1]!;
    expect(secondSend).toEqual(firstSend);
    expect(firstSend).toMatchObject({ text: 'ping', contextId: 'ctx-1', metadata: { mode: 'act' } });
    expect(events.some(event =>
      event.type === 'status' && String(event.message).includes('rate limit'))).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'complete' });
  });

  it('re-sends a parked answer as the tool result it was, not as a bare message', async () => {
    const { client, turn, sleeps } = harness({
      contextId: 'ctx-1',
      taskId: 'task-1',
      answerToolCall: { toolCallId: 'call-terminal', name: 'ask_followup_question' },
    });
    client.toolStreams.push(throwingStream(rateLimited()));
    client.toolStreams.push(stream(completed('ok')));

    await collect(turn, 'my answer');

    expect(sleeps).toEqual([5_000]);
    expect(client.messageCalls).toHaveLength(0);
    expect(client.toolResultCalls).toHaveLength(2);
    expect(client.toolResultCalls[1]).toMatchObject({
      taskId: 'task-1',
      results: [{ toolCallId: 'call-terminal', content: 'my answer' }],
    });
  });

  it('re-sends a continuation with its tool results intact', async () => {
    const { client, turn, sleeps } = harness({
      contextId: 'ctx-1',
      executeTool: async () => ({ content: 'file-a\nfile-b' }),
    });
    client.messageStreams.push(stream(task(), inputRequiredWithTool()));
    client.toolStreams.push(throwingStream(rateLimited()));
    client.toolStreams.push(stream(completed('done')));

    await collect(turn, 'list please');

    expect(sleeps).toEqual([5_000]);
    expect(client.toolResultCalls).toHaveLength(2);
    expect(client.toolResultCalls[1]).toMatchObject({
      taskId: 'task-1',
      results: [{ toolCallId: 'call-1', content: 'file-a\nfile-b' }],
    });
  });

  it('gives the backend\'s quota message back to the user when the budget runs out', async () => {
    const { client, turn, sleeps } = harness({ contextId: 'ctx-1' });
    for (let i = 0; i < RATE_LIMIT_MAX_RETRIES + 1; i++) {
      client.messageStreams.push(throwingStream(rateLimited()));
    }

    const events = await collect(turn, 'ping');

    expect(sleeps).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000]);
    expect(client.messageCalls).toHaveLength(RATE_LIMIT_MAX_RETRIES + 1);
    expect(events).toContainEqual({
      type: 'error',
      message: 'суточный лимит токенов исчерпан, лимит обновится в 00:00',
    });
    expect(events.at(-1)).toEqual({ type: 'complete' });
  });

  it('retries a 5xx once on its own budget, without a delay', async () => {
    const { client, turn, sleeps } = harness({ contextId: 'ctx-1' });
    client.messageStreams.push(throwingStream(new NestorCloudRetryableTransportError(503, 'Nestor stream failed: 503', false)));
    client.messageStreams.push(throwingStream(new NestorCloudRetryableTransportError(503, 'Nestor stream failed: 503', false)));

    const events = await collect(turn, 'ping');

    expect(sleeps).toEqual([]);
    expect(client.messageCalls).toHaveLength(2);
    expect(events).toContainEqual({ type: 'error', message: 'Nestor stream failed: 503' });
    expect(events.at(-1)).toEqual({ type: 'complete' });
  });

  it('stops the backoff the moment the turn is aborted', async () => {
    const controller = new AbortController();
    const { client, turn, sleeps } = harness({ contextId: 'ctx-1', signal: controller.signal, sleepReturns: [false] });
    client.messageStreams.push(throwingStream(rateLimited()));

    const events = await collect(turn, 'ping');

    expect(sleeps).toEqual([5_000]);
    expect(client.messageCalls).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'complete' });
    expect(events.some(event => event.type === 'error')).toBe(false);
  });
});

describe('NestorCloudTurn in-band retryable error', () => {
  it('backs off and retries with the marker part on contextId alone — no taskId', async () => {
    const { client, turn, sleeps } = harness({ contextId: 'ctx-1', metadata: { mode: 'act' } });
    client.messageStreams.push(stream(task(), ...retryableErrorFrames()));
    client.retryMarkerStreams.push(stream(completed('PONG')));

    const events = await collect(turn, 'ping');

    expect(sleeps).toEqual([5_000]);
    expect(client.retryMarkerCalls).toHaveLength(1);
    const retrySend = client.retryMarkerCalls[0]!;
    expect(retrySend).toMatchObject({ contextId: 'ctx-1', metadata: { mode: 'act' } });
    // The task the error froze is NOT addressed — the retry opens a fresh one in
    // the same context (`nessy-acp-agent/src/commands/regenerate-agent-turn.command.ts:65-78`).
    expect('taskId' in retrySend).toBe(false);
    expect(client.messageCalls).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'complete' });
  });

  it('keeps the text the failed attempt already streamed', async () => {
    const { client, turn } = harness({ contextId: 'ctx-1' });
    client.messageStreams.push(stream(task(), ...retryableErrorFrames()));
    client.retryMarkerStreams.push(stream(completed('PONG')));

    const events = await collect(turn, 'ping');

    const completes = events.filter(event => event.type === 'text_complete');
    expect(completes.map(event => (event as { text: string }).text)).toEqual(['half an answ', 'PONG']);
  });

  it('surfaces the backend message and stops when the budget runs out', async () => {
    const { client, turn, sleeps } = harness({ contextId: 'ctx-1' });
    client.messageStreams.push(stream(task(), ...retryableErrorFrames()));
    for (let i = 0; i < RATE_LIMIT_MAX_RETRIES; i++) {
      client.retryMarkerStreams.push(stream(...retryableErrorFrames(-32029, 'Inference rate limit error occurred, please try again later', '')));
    }

    const events = await collect(turn, 'ping');

    expect(sleeps).toHaveLength(RATE_LIMIT_MAX_RETRIES);
    expect(client.retryMarkerCalls).toHaveLength(RATE_LIMIT_MAX_RETRIES);
    expect(events).toContainEqual({
      type: 'error',
      message: 'Inference rate limit error occurred, please try again later (-32029)',
    });
    expect(events.at(-1)).toEqual({ type: 'complete' });
  });

  it('does not carry a rejected attempt\'s retryable error into the next pass', async () => {
    // The `-32029` part arrives on a stream that then THROWS a terminal-task
    // rejection, so `consumeStream` never reaches the post-stream read that
    // clears the held error. The recovery `continue` therefore inherited it and
    // the CLEAN attempt that followed was treated as rate-limited: a bogus
    // backoff plus a retry marker on a turn that had already answered.
    const { client, turn, sleeps } = harness({ contextId: 'ctx-1', taskId: 'stale-task' });
    client.messageStreams.push(streamThenThrow(
      [task(), ...retryableErrorFrames()],
      terminalTaskRejection(),
    ));
    client.messageStreams.push(stream(task(), completed('PONG')));

    const events = await collect(turn, 'ping');

    expect(client.retryMarkerCalls).toEqual([]);
    expect(sleeps).toEqual([]);
    expect(client.messageCalls).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'complete' });
  });

  it('surfaces a persistent in-band error and never retries it', async () => {
    const { client, turn, sleeps } = harness({ contextId: 'ctx-1' });
    client.messageStreams.push(stream(task(), ...retryableErrorFrames(-32603, 'Internal agent error', '')));

    const events = await collect(turn, 'ping');

    expect(sleeps).toEqual([]);
    expect(client.retryMarkerCalls).toHaveLength(0);
    expect(events).toContainEqual({ type: 'error', message: 'Internal agent error (-32603)' });
    expect(events.at(-1)).toEqual({ type: 'complete' });
  });
});

describe('NestorCloudTurn task-not-found recovery', () => {
  it('resends without the stale taskId, exactly once, for a -32001 frame', async () => {
    // ORCHESTRATOR DECISION: -32001 is NOT on the backoff set (the connector
    // retries it, `a2a-errors.ts:86-87`) — a task the backend lost will not
    // reappear by retrying the same taskId, so it takes the terminal-task
    // recovery: resend without the taskId.
    const notFound = toNestorStreamError({
      code: -32001,
      message: 'task not found',
      data: { error: 'task loading failed: task not found' },
    });
    const { client, turn, sleeps } = harness({ contextId: 'ctx-1', taskId: 'stale-task' });
    client.messageStreams.push(throwingStream(notFound));
    client.messageStreams.push(throwingStream(notFound));

    const { events, error } = await collectUntilError(turn, 'ping');

    expect(sleeps).toEqual([]);
    expect(client.messageCalls).toHaveLength(2);
    expect(client.messageCalls[0]).toMatchObject({ taskId: 'stale-task' });
    expect('taskId' in client.messageCalls[1]!).toBe(false);
    expect(events.some(event =>
      event.type === 'status' && String(event.message).includes('Reconnecting'))).toBe(true);
    // The second failure is not recovered from again — one retry, then it surfaces.
    expect(error).toBeDefined();
    // And what surfaces is the BACKEND's sentence. The generic "already
    // terminal" text is wrong for a task the backend never found, and it is the
    // only thing the user would otherwise see.
    expect((error as Error).message).toContain('task not found');
  });
});

async function collectUntilError(turn: NestorCloudTurn, message = 'hello') {
  const events = [];
  let error: unknown;
  try {
    for await (const event of turn.run(message)) events.push(event);
  } catch (err) {
    error = err;
  }
  return { events, error };
}

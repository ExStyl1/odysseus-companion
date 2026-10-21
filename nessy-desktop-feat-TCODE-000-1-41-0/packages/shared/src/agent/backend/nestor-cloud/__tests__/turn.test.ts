import { describe, expect, it } from 'bun:test';
import type { A2AStreamEvent } from '../types.ts';
import { NestorCloudTerminalTaskError, NestorCloudTurn } from '../turn.ts';

type MessageArgs = Parameters<NestorCloudTurn['run']>[0];

class FakeClient {
  loadCount = 0;
  cancelCalls: string[] = [];
  messageCalls: Array<Record<string, unknown>> = [];
  toolResultCalls: Array<Record<string, unknown>> = [];
  messageStreams: Array<AsyncIterable<A2AStreamEvent>> = [];
  toolStreams: Array<AsyncIterable<A2AStreamEvent>> = [];

  async loadAgentCard() {
    this.loadCount++;
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

  async cancelTask(taskId: string) {
    this.cancelCalls.push(taskId);
  }
}

async function collect(turn: NestorCloudTurn, message: MessageArgs = 'hello') {
  const events = [];
  for await (const event of turn.run(message)) {
    events.push(event);
  }
  return events;
}

/**
 * Like {@link collect}, but keeps the events the turn managed to yield BEFORE it
 * rejected. The flush-on-error contract is a statement about exactly those.
 */
async function collectUntilError(turn: NestorCloudTurn, message: MessageArgs = 'hello') {
  const events = [];
  let error: unknown;
  try {
    for await (const event of turn.run(message)) {
      events.push(event);
    }
  } catch (err) {
    error = err;
  }
  return { events, error };
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

/** Yields `events`, then tears the stream — the torn-socket / aborted shape. */
function streamThenThrow(err: Error, ...events: A2AStreamEvent[]): AsyncIterable<A2AStreamEvent> {
  return (async function* () {
    for (const event of events) yield event;
    throw err;
  })();
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
        message: { messageId: 'msg-1', role: 'ROLE_AGENT', parts: text ? [{ text }] : [] },
      },
    },
  };
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

function inputRequiredWithTerminalTool(
  name = 'plan_mode_respond',
  args = '{"response":"plan"}',
  id = 'call-terminal',
): A2AStreamEvent {
  return {
    statusUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      status: {
        state: 'TASK_STATE_INPUT_REQUIRED',
        message: {
          messageId: 'msg-terminal-tool',
          role: 'ROLE_AGENT',
          parts: [{
            data: {
              data_type: 'tool_call',
              data_version: 1,
              id,
              index: 0,
              function: { name, arguments: args },
            },
          }],
        },
      },
    },
  };
}

/** A non-final frame carrying text — the shape a dropped stream ends on. */
function workingText(text: string): A2AStreamEvent {
  return {
    statusUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      status: {
        state: 'TASK_STATE_WORKING',
        message: { messageId: 'msg-1', role: 'ROLE_AGENT', parts: [{ text }] },
      },
    },
  };
}

function inputRequiredNoTool(): A2AStreamEvent {
  return {
    statusUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      status: {
        state: 'TASK_STATE_INPUT_REQUIRED',
        message: { messageId: 'msg-1', role: 'ROLE_AGENT', parts: [] },
      },
    },
  };
}

describe('NestorCloudTurn', () => {
  it('runs an initial prompt and emits transient loading status before completion', async () => {
    const client = new FakeClient();
    client.messageStreams.push(stream(task(), completed('PONG')));
    const updates: unknown[] = [];
    const turn = new NestorCloudTurn({
      client: client as never,
      onContextUpdate: (update) => {
        updates.push(update);
      },
    });

    const events = await collect(turn, 'ping');

    expect(client.loadCount).toBe(1);
    expect(client.messageCalls[0]).toMatchObject({ text: 'ping' });
    expect(events.map((event) => event.type)).toEqual([
      'status',
      'status',
      'status',
      'status',
      'text_delta',
      'text_complete',
      'complete',
    ]);
    expect(events.filter((event) => event.type === 'status').map((event) => event.message)).toEqual([
      'Checking Nestor credentials...',
      'Connecting to Nestor cloud agent...',
      'Starting remote agent task...',
      'Waiting for Nestor agent...',
    ]);
    expect(updates).toContainEqual({ contextId: 'ctx-1' });
  });

  it('executes tool calls and sends tool-result continuation on input-required', async () => {
    const client = new FakeClient();
    client.messageStreams.push(stream(task(), inputRequiredWithTool()));
    client.toolStreams.push(stream(completed('after tool')));
    const turn = new NestorCloudTurn({
      client: client as never,
      executeTool: async () => ({ content: 'file list' }),
    });

    const events = await collect(turn);

    expect(events.map((event) => event.type)).toContain('tool_start');
    expect(events).toContainEqual({
      type: 'tool_result',
      toolUseId: 'call-1',
      toolName: 'list_files',
      result: 'file list',
      isError: false,
    });
    expect(events.filter((event) => event.type === 'status').map((event) => event.message))
      .toContain('Sending tool result to Nestor...');
    expect(client.toolResultCalls[0]).toMatchObject({
      contextId: 'ctx-1',
      taskId: 'task-1',
      results: [{ toolCallId: 'call-1', content: 'file list' }],
    });
  });

  it('suspends on a terminal tool instead of executing it or answering it itself', async () => {
    const client = new FakeClient();
    client.messageStreams.push(stream(task(), inputRequiredWithTerminalTool()));
    const executed: string[] = [];
    const updates: Array<Record<string, unknown>> = [];
    const turn = new NestorCloudTurn({
      client: client as never,
      executeTool: async (call) => {
        executed.push(call.name);
        return { content: 'plan' };
      },
      onContextUpdate: (update) => {
        updates.push(update as Record<string, unknown>);
      },
    });

    const events = await collect(turn);

    expect(executed).toEqual([]);
    expect(client.toolResultCalls).toHaveLength(0);
    expect(events.map((event) => event.type)).not.toContain('tool_start');
    expect(events.map((event) => event.type)).not.toContain('tool_result');
    expect(events.filter((event) => event.type === 'text_complete'))
      .toEqual([{ type: 'text_complete', text: 'plan' }]);
    expect(events.at(-1)).toEqual({
      type: 'complete',
      terminalReason: 'tool_deferred',
      deferredToolUse: { id: 'call-terminal', name: 'plan_mode_respond', input: { response: 'plan' } },
    });
    expect(updates).toContainEqual({
      pendingTerminalTool: { toolCallId: 'call-terminal', name: 'plan_mode_respond' },
    });
    // The parked call is addressed by taskId on the next turn, so the task must
    // survive the suspension: input-required is not a terminal state.
    expect(updates.some((update) => update.clearTask === true)).toBe(false);
  });

  it('renders followup choices as the connector does: question, one newline, numbered options', async () => {
    const client = new FakeClient();
    client.messageStreams.push(stream(task(), inputRequiredWithTerminalTool(
      'ask_followup_question',
      '{"question":"Which database?","followup":["postgres","sqlite"]}',
      'call-ask',
    )));
    const turn = new NestorCloudTurn({ client: client as never });

    const events = await collect(turn);

    expect(events.filter((event) => event.type === 'text_complete')).toEqual([
      { type: 'text_complete', text: 'Which database?\n1. postgres\n2. sqlite' },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'complete',
      terminalReason: 'tool_deferred',
      deferredToolUse: { id: 'call-ask', name: 'ask_followup_question' },
    });
  });

  it('answers a parked terminal tool with the next user prompt, carrying the turn metadata', async () => {
    const client = new FakeClient();
    client.toolStreams.push(stream(completed('thanks')));
    const updates: Array<Record<string, unknown>> = [];
    const turn = new NestorCloudTurn({
      client: client as never,
      contextId: 'ctx-1',
      taskId: 'task-1',
      metadata: { source: 'fixture' },
      answerToolCall: { toolCallId: 'call-terminal', name: 'plan_mode_respond' },
      onContextUpdate: (update) => {
        updates.push(update as Record<string, unknown>);
      },
    });

    const events = await collect(turn, 'looks good, proceed');

    expect(client.messageCalls).toHaveLength(0);
    expect(client.toolResultCalls[0]).toMatchObject({
      contextId: 'ctx-1',
      taskId: 'task-1',
      results: [{ toolCallId: 'call-terminal', content: 'looks good, proceed' }],
      metadata: { source: 'fixture' },
    });
    expect(updates).toContainEqual({ clearPendingTerminalTool: true });
    expect(events.at(-1)).toEqual({ type: 'complete' });
  });

  it('sends an empty answer as an empty string rather than omitting content', async () => {
    const client = new FakeClient();
    client.toolStreams.push(stream(completed('ok')));
    const turn = new NestorCloudTurn({
      client: client as never,
      contextId: 'ctx-1',
      taskId: 'task-1',
      answerToolCall: { toolCallId: 'call-terminal', name: 'ask_followup_question' },
    });

    await collect(turn, '');

    const results = (client.toolResultCalls[0] as { results: Array<Record<string, unknown>> }).results;
    expect(results[0]).toEqual({ toolCallId: 'call-terminal', content: '' });
  });

  it('drops a parked answer whose task is gone and sends the prompt as a fresh message', async () => {
    const client = new FakeClient();
    client.messageStreams.push(stream(task(), completed('fresh')));
    const updates: Array<Record<string, unknown>> = [];
    const turn = new NestorCloudTurn({
      client: client as never,
      contextId: 'ctx-1',
      answerToolCall: { toolCallId: 'call-terminal', name: 'ask_followup_question' },
      onContextUpdate: (update) => {
        updates.push(update as Record<string, unknown>);
      },
    });

    await collect(turn, 'answer without a task');

    expect(client.toolResultCalls).toHaveLength(0);
    expect(client.messageCalls[0]).toMatchObject({ text: 'answer without a task' });
    expect(updates).toContainEqual({ clearPendingTerminalTool: true });
  });

  it('completes locally on input-required when there are no pending tool results', async () => {
    const client = new FakeClient();
    client.messageStreams.push(stream(task(), inputRequiredNoTool()));
    const turn = new NestorCloudTurn({ client: client as never });

    const events = await collect(turn);

    expect(client.toolResultCalls).toHaveLength(0);
    expect(events.at(-1)).toEqual({ type: 'complete' });
  });

  it('ends cleanly when aborted before opening the stream', async () => {
    const client = new FakeClient();
    const controller = new AbortController();
    controller.abort();
    const turn = new NestorCloudTurn({ client: client as never, signal: controller.signal });

    const events = await collect(turn);

    expect(events.at(-1)).toEqual({ type: 'complete' });
    expect(client.messageCalls).toHaveLength(0);
  });

  it('retries a stale terminal task once without taskId for non-tool prompts', async () => {
    const client = new FakeClient();
    client.messageStreams.push(
      throwingStream(new NestorCloudTerminalTaskError('completed')),
      stream(task(), completed('reconnected')),
    );
    const updates: unknown[] = [];
    const turn = new NestorCloudTurn({
      client: client as never,
      contextId: 'ctx-1',
      taskId: 'old-task',
      onContextUpdate: (update) => {
        updates.push(update);
      },
    });

    const events = await collect(turn);

    expect(client.messageCalls).toHaveLength(2);
    expect(client.messageCalls[0]).toMatchObject({ taskId: 'old-task' });
    expect(client.messageCalls[1]).not.toHaveProperty('taskId');
    expect(events).toContainEqual({ type: 'status', message: 'Reconnecting Nestor task...' });
    expect(updates).toContainEqual({ clearTask: true, taskStatus: 'completed' });
  });

  it('does not retry when the rejected send carried tool results', async () => {
    // The guard the connector mirrors (`CONNECTOR/src/core/turn.ts:95-131`):
    // a continuation's parts are tool results addressed to THAT task, and a
    // fresh task has no call to answer — replaying them as a prompt would send
    // the model its own tool output as a user message.
    const client = new FakeClient();
    client.messageStreams.push(stream(task(), inputRequiredWithTool()));
    client.toolStreams.push(throwingStream(new NestorCloudTerminalTaskError('completed')));
    const turn = new NestorCloudTurn({
      client: client as never,
      executeTool: async () => ({ content: 'file list' }),
    });

    await expect(collect(turn)).rejects.toBeInstanceOf(NestorCloudTerminalTaskError);
    expect(client.messageCalls).toHaveLength(1);
    expect(client.toolResultCalls).toHaveLength(1);
  });

  it('flushes buffered text when the stream ends without any final-state event', async () => {
    // The backend's retryable path and a dropped socket both end the stream on
    // a non-final state (`a2a_environment.go:157-165` emits WORKING then closes
    // on the error branch). Without a flush the assistant text never becomes a
    // `text_complete`, and `text_delta` alone is renderer-only — the message is
    // never committed (`SessionManager.ts` inserts on `text_complete` only).
    const client = new FakeClient();
    client.messageStreams.push(stream(task(), workingText('half a thought')));
    const turn = new NestorCloudTurn({ client: client as never });

    const events = await collect(turn, 'ping');

    expect(events.map((event) => event.type)).toEqual([
      'status',
      'status',
      'status',
      'status',
      'text_delta',
      'text_complete',
      'complete',
    ]);
    expect(events).toContainEqual({
      type: 'text_complete',
      text: 'half a thought',
      turnId: undefined,
      sdkMessageId: 'msg-1',
    });
  });

  it('flushes buffered text before rethrowing a torn stream', async () => {
    // The motivating cases for the flush THROW out of the `for await` rather
    // than ending it: `client.ts` re-wraps a torn socket as
    // `NestorCloudClientError('stream-failed')`. A flush that only runs on the
    // clean end still loses the buffered text on exactly the paths F7 named.
    const client = new FakeClient();
    const torn = new Error('Nestor stream failed: socket hang up');
    client.messageStreams.push(streamThenThrow(torn, task(), workingText('half a thought')));
    const turn = new NestorCloudTurn({ client: client as never });

    const { events, error } = await collectUntilError(turn, 'ping');

    expect(error).toBe(torn);
    expect(events).toContainEqual({
      type: 'text_complete',
      text: 'half a thought',
      turnId: undefined,
      sdkMessageId: 'msg-1',
    });
    // The flush must precede the rejection, not merely happen: an event yielded
    // after the throw is an event the consumer never sees.
    expect(events.map((event) => event.type).at(-1)).toBe('text_complete');
  });

  it('flushes buffered text when the turn signal aborts mid-stream', async () => {
    const client = new FakeClient();
    const controller = new AbortController();
    const aborted = new DOMException('The operation was aborted.', 'AbortError');
    client.messageStreams.push((async function* () {
      yield task();
      yield workingText('interrupted mid-sentence');
      controller.abort();
      throw aborted;
    })());
    const turn = new NestorCloudTurn({ client: client as never, signal: controller.signal });

    const { events, error } = await collectUntilError(turn, 'ping');

    expect(error).toBe(aborted);
    expect(events).toContainEqual({
      type: 'text_complete',
      text: 'interrupted mid-sentence',
      turnId: undefined,
      sdkMessageId: 'msg-1',
    });
  });

  it('discards the rejected attempt text so it cannot leak into the retry', async () => {
    // `-32004` is reachable AFTER text streamed (the task store's own Update
    // guard, `a2a_repo_task_store.go:106-107`), so the recovery inherits a
    // non-empty buffer. The retry regenerates its own answer; the rejected
    // attempt's half-sentence must not be prepended to it.
    const client = new FakeClient();
    client.messageStreams.push(
      streamThenThrow(new NestorCloudTerminalTaskError('completed'), task(), workingText('rejected half')),
      stream(task(), completed('the retry answer')),
    );
    const turn = new NestorCloudTurn({ client: client as never, contextId: 'ctx-1', taskId: 'old-task' });

    const events = await collect(turn, 'ping');

    expect(client.messageCalls).toHaveLength(2);
    expect(events.filter((event) => event.type === 'text_complete'))
      .toEqual([{ type: 'text_complete', text: 'the retry answer', turnId: undefined, sdkMessageId: 'msg-1' }]);
  });

  it('retries an answering send whose task went terminal, as an ordinary message', async () => {
    // Divergence from the connector (`core/turn.ts:113-120`), recorded in the
    // T12 tracker row: it refuses the retry when `initialParts` carry a
    // `tool_result`. Here the tool result's content IS the user's own prompt,
    // not tool output, so replaying it as a message sends the model what the
    // user typed — the connector's failure mode does not apply.
    const client = new FakeClient();
    client.toolStreams.push(throwingStream(new NestorCloudTerminalTaskError('completed')));
    client.messageStreams.push(stream(task(), completed('picked up again')));
    const updates: Array<Record<string, unknown>> = [];
    const turn = new NestorCloudTurn({
      client: client as never,
      contextId: 'ctx-1',
      taskId: 'task-1',
      answerToolCall: { toolCallId: 'call-terminal', name: 'ask_followup_question' },
      onContextUpdate: (update) => {
        updates.push(update as Record<string, unknown>);
      },
    });

    const events = await collect(turn, 'yes, go ahead');

    expect(client.toolResultCalls).toHaveLength(1);
    expect(updates).toContainEqual({ clearPendingTerminalTool: true });
    expect(client.messageCalls).toHaveLength(1);
    expect(client.messageCalls[0]).toMatchObject({ text: 'yes, go ahead' });
    expect(client.messageCalls[0]).not.toHaveProperty('taskId');
    expect(events).toContainEqual({ type: 'status', message: 'Reconnecting Nestor task...' });
    expect(events.at(-1)).toEqual({ type: 'complete' });
  });

  it('does not double-flush text a final status already completed', async () => {
    const client = new FakeClient();
    client.messageStreams.push(stream(task(), completed('PONG')));
    const turn = new NestorCloudTurn({ client: client as never });

    const events = await collect(turn, 'ping');

    expect(events.filter((event) => event.type === 'text_complete')).toHaveLength(1);
  });

  it('emits cancel status and calls remote cancel', async () => {
    const client = new FakeClient();
    const turn = new NestorCloudTurn({ client: client as never, taskId: 'task-1' });

    const events = [];
    for await (const event of turn.cancelWithEvents()) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'status', message: 'Stopping Nestor task...' },
      { type: 'complete' },
    ]);
    expect(client.cancelCalls).toEqual(['task-1']);
  });
});

import { describe, expect, it } from 'bun:test';
import { NestorCloudEventAdapter } from '../event-adapter.ts';
import type { A2AStreamEvent } from '../types.ts';

/**
 * A2A 1.0 (`/api/v2/code-agent/a2a`) frames.
 *
 * Envelope is a oneof keyed by `task` / `message` / `statusUpdate` /
 * `artifactUpdate` (a2a-go v2 `a2a/core.go:93-109`), task states are
 * `TASK_STATE_*` (`a2a/core.go:272-292`), parts are flattened and discriminated
 * by key presence with no `kind` (`a2a/core.go:672-716`), and there is NO
 * `final` field — the client computes it (`a2acompat/a2av0/conversions.go:485`).
 */
function statusUpdate(
  parts: Array<Record<string, unknown>>,
  state = 'TASK_STATE_WORKING',
): A2AStreamEvent {
  return {
    statusUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      status: {
        state,
        message: {
          messageId: 'msg-1',
          role: 'ROLE_AGENT',
          parts,
        },
      },
    },
  };
}

describe('NestorCloudEventAdapter (A2A 1.0 envelope)', () => {
  it('maps a task envelope, text deltas, and a completed status update', () => {
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    const first = adapter.adapt({
      task: {
        id: 't1',
        contextId: 'c1',
        status: { state: 'TASK_STATE_SUBMITTED' },
      },
    });
    expect(first).toContainEqual({ kind: 'context', contextId: 'c1' });
    expect(first).toContainEqual({
      kind: 'task_status',
      taskId: 't1',
      status: 'submitted',
      final: false,
      hasVisibleMessage: false,
    });

    const working = adapter.adapt(statusUpdate([{ text: 'PONG' }]));
    expect(working).toContainEqual({ kind: 'context', contextId: 'ctx-1' });
    expect(working).toContainEqual({
      kind: 'agent_event',
      event: { type: 'text_delta', text: 'PONG', turnId: 'turn-1' },
    });
    expect(working).toContainEqual({
      kind: 'task_status',
      taskId: 'task-1',
      status: 'working',
      final: false,
      hasVisibleMessage: true,
    });

    const done = adapter.adapt(statusUpdate([], 'TASK_STATE_COMPLETED'));
    expect(done).toContainEqual({
      kind: 'task_status',
      taskId: 'task-1',
      status: 'completed',
      final: true,
      hasVisibleMessage: false,
    });
    expect(done).toContainEqual({
      kind: 'agent_event',
      event: {
        type: 'text_complete',
        text: 'PONG',
        turnId: 'turn-1',
        sdkMessageId: 'msg-1',
      },
    });
    expect(done).toContainEqual({ kind: 'done', status: 'completed' });
  });

  it('computes final from the state because v2 carries no final flag', () => {
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    const inputRequired = adapter.adapt(statusUpdate([], 'TASK_STATE_INPUT_REQUIRED'));
    expect(inputRequired).toContainEqual({
      kind: 'task_status',
      taskId: 'task-1',
      status: 'input-required',
      final: true,
      hasVisibleMessage: false,
    });
    expect(inputRequired).toContainEqual({ kind: 'done', status: 'input-required' });

    const canceled = adapter.adapt(statusUpdate([], 'TASK_STATE_CANCELED'));
    expect(canceled).toContainEqual({ kind: 'done', status: 'canceled' });

    const working = adapter.adapt(statusUpdate([], 'TASK_STATE_WORKING'));
    expect(working).toContainEqual({
      kind: 'task_status',
      taskId: 'task-1',
      status: 'working',
      final: false,
      hasVisibleMessage: false,
    });
    expect(working.some(output => output.kind === 'done')).toBe(false);
  });

  it('never accepts the 0.3 lowercase task-state vocabulary', () => {
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    expect(adapter.adapt(statusUpdate([], 'working'))).toContainEqual({
      kind: 'task_status',
      taskId: 'task-1',
      status: 'unknown',
      final: false,
      hasVisibleMessage: false,
    });

    const legacyCompleted = adapter.adapt(statusUpdate([], 'completed'));
    expect(legacyCompleted).toContainEqual({
      kind: 'task_status',
      taskId: 'task-1',
      status: 'unknown',
      final: false,
      hasVisibleMessage: false,
    });
    expect(legacyCompleted.some(output => output.kind === 'done')).toBe(false);

    expect(adapter.adapt({
      task: { id: 't1', contextId: 'c1', status: { state: 'submitted' } },
    })).toContainEqual({
      kind: 'task_status',
      taskId: 't1',
      status: 'unknown',
      final: false,
      hasVisibleMessage: false,
    });
  });

  it('maps a message envelope parts like any other parts carrier', () => {
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    const outputs = adapter.adapt({
      message: {
        messageId: 'msg-123',
        role: 'ROLE_AGENT',
        contextId: 'ctx-1',
        parts: [{ text: 'hello' }],
      },
    });

    expect(outputs).toContainEqual({ kind: 'context', contextId: 'ctx-1' });
    expect(outputs).toContainEqual({
      kind: 'agent_event',
      event: { type: 'text_delta', text: 'hello', turnId: 'turn-1' },
    });
  });

  it('maps an artifactUpdate envelope parts like a status-update message', () => {
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    const outputs = adapter.adapt({
      artifactUpdate: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        artifact: {
          artifactId: 'a1',
          parts: [{ text: 'artifact summary' }],
        },
      },
    });

    expect(outputs).toContainEqual({ kind: 'context', contextId: 'ctx-1' });
    expect(outputs).toContainEqual({
      kind: 'agent_event',
      event: { type: 'text_delta', text: 'artifact summary', turnId: 'turn-1' },
    });
  });

  it('discriminates parts by key presence, ignoring a stray kind field', () => {
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    const outputs = adapter.adapt(statusUpdate([
      { kind: 'text', text: 'stray kind survives' },
      {
        kind: 'data',
        data: {
          data_type: 'tool_call',
          data_version: 1,
          id: 'call-1',
          index: 0,
          function: { name: 'read_file', arguments: '{"path":"/workspace/a"}' },
        },
      },
    ]));

    expect(outputs).toContainEqual({
      kind: 'agent_event',
      event: { type: 'text_delta', text: 'stray kind survives', turnId: 'turn-1' },
    });
    expect(outputs).toContainEqual({
      kind: 'tool_call',
      toolCall: {
        id: 'call-1',
        index: 0,
        name: 'read_file',
        arguments: '{"path":"/workspace/a"}',
      },
      startEvent: {
        type: 'tool_start',
        toolName: 'read_file',
        toolUseId: 'call-1',
        input: { path: '/workspace/a' },
        turnId: 'turn-1',
        parentToolUseId: undefined,
        intent: undefined,
        displayName: undefined,
      },
    });
  });

  it('skips raw, url, file, and primitive-data parts without throwing', () => {
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    const outputs = adapter.adapt(statusUpdate([
      { filename: 'foo', mediaType: 'image/png', raw: '//4=' },
      { filename: 'foo', url: 'https://cats.com/1.png' },
      { kind: 'file', file: { bytes: '//4=', mimeType: 'image/png' } },
      { data: 'a primitive data value' },
      {},
    ]));

    expect(outputs).toEqual([
      { kind: 'context', contextId: 'ctx-1' },
      {
        kind: 'task_status',
        taskId: 'task-1',
        status: 'working',
        final: false,
        hasVisibleMessage: false,
      },
    ]);
  });

  it('logs and skips an unknown envelope key instead of throwing', () => {
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    expect(adapter.adapt({ statusUpdateV2: { taskId: 'task-1', status: { state: 'TASK_STATE_WORKING' } } }))
      .toEqual([]);
    expect(adapter.adapt({})).toEqual([]);
  });

  it('maps terminal tool calls without creating a local tool_start event', () => {
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    const outputs = adapter.adapt(statusUpdate([{
      data: {
        data_type: 'tool_call',
        data_version: 1,
        id: 'call-1',
        index: 0,
        function: { name: 'plan_mode_respond', arguments: '{"response":"plan"}' },
      },
    }], 'TASK_STATE_INPUT_REQUIRED'));

    expect(outputs).toContainEqual({
      kind: 'tool_call',
      toolCall: {
        id: 'call-1',
        index: 0,
        name: 'plan_mode_respond',
        arguments: '{"response":"plan"}',
      },
      terminal: true,
    });
  });

  it('maps the reasoning data-part envelope to intermediate text', () => {
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    const outputs = adapter.adapt(statusUpdate([{
      data: { data_type: 'reasoning', data_version: 1, reasoning: 'thinking' },
    }]));

    expect(outputs).toContainEqual({
      kind: 'agent_event',
      // P4.4 · `isThinking` is asserted here rather than matched loosely: this
      // arm IS a reasoning producer, and the whole point of the field is that
      // this backend's reasoning stops being indistinguishable from commentary.
      event: { type: 'text_complete', text: 'thinking', isIntermediate: true, isThinking: true, turnId: 'turn-1' },
    });
  });

  it('surfaces failed status and retryable-error data parts', () => {
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    const failed = adapter.adapt(statusUpdate([], 'TASK_STATE_FAILED'));
    expect(failed).toContainEqual({
      kind: 'agent_event',
      event: { type: 'error', message: 'Nestor task failed' },
    });
    expect(failed).toContainEqual({ kind: 'done', status: 'failed' });

    // The retryable-error part is CLASSIFIED, not rendered: `turn.ts` decides
    // between a backoff retry and surfacing it, and only it knows whether tool
    // results or a parked question are in flight.
    const retryable = adapter.adapt(statusUpdate([{
      data: {
        data_type: 'retryable_error',
        data_version: 1,
        id: 'err-1',
        error: { code: -32029, message: 'Inference rate limit error occurred, please try again later' },
      },
    }]));
    expect(retryable).toContainEqual({
      kind: 'stream_error',
      code: -32029,
      retryable: true,
      message: 'Inference rate limit error occurred, please try again later (-32029)',
    });
    expect(retryable.some(output => output.kind === 'agent_event')).toBe(false);
  });

  it('marks the persistent halves of the retryable-error extension as non-retryable', () => {
    // `retryable_error_extension.go:55-72` — only -32029 is the rate limit;
    // -32000 (inference error / aborted) and -32603 (internal) are persistent.
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    for (const [code, message] of [[-32000, 'Inference error occurred'], [-32603, 'Internal agent error']] as const) {
      const outputs = adapter.adapt(statusUpdate([{
        data: { data_type: 'retryable_error', data_version: 1, id: 'err-1', error: { code, message } },
      }]));
      expect(outputs).toContainEqual({
        kind: 'stream_error',
        code,
        retryable: false,
        message: `${message} (${code})`,
      });
    }
  });

  it('no longer parses the context_usage/compaction data parts the backend never sends', () => {
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    const usage = adapter.adapt(statusUpdate([{
      data: { type: 'context_usage', inputTokens: 78000, contextWindow: 200000 },
    }]));
    expect(usage.some(output => output.kind === 'agent_event')).toBe(false);

    const compaction = adapter.adapt(statusUpdate([{ data: { type: 'compaction_start' } }]));
    expect(compaction.some(output => output.kind === 'agent_event')).toBe(false);
  });

  it('flushes buffered text on demand when the stream ended without a final state', () => {
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    const working = adapter.adapt(statusUpdate([{ text: 'half a ' }]));
    expect(working.some(output => output.kind === 'agent_event'
      && output.event.type === 'text_complete')).toBe(false);
    adapter.adapt(statusUpdate([{ text: 'thought' }]));

    expect(adapter.flushPending()).toEqual([{
      kind: 'agent_event',
      event: {
        type: 'text_complete',
        text: 'half a thought',
        turnId: 'turn-1',
        sdkMessageId: 'msg-1',
      },
    }]);
  });

  it('surfaces server_tool_status as a status event, discriminating on data_type not envelope kind', () => {
    // `mapping/status.go:25-49` wraps the part in `a2a.NewArtifactEvent`, so it
    // arrives on the artifactUpdate envelope — but the adapter must decide from
    // `data.data_type` alone (`server_tool_status.go:20`).
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    const outputs = adapter.adapt({
      artifactUpdate: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        artifact: {
          artifactId: 'a1',
          parts: [{
            data: {
              data_type: 'server_tool_status',
              data_version: 1,
              tool_call_id: 'server-call-1',
              name: 'doc_search_v2',
              state: 'started',
              description: 'Searching the docs',
            },
          }],
        },
      },
    });

    expect(outputs).toContainEqual({
      kind: 'agent_event',
      event: { type: 'status', message: 'Searching the docs' },
    });
    // Never executed locally — the backend already ran it.
    expect(outputs.some(output => output.kind === 'tool_call')).toBe(false);
  });

  it('surfaces server_tool_status off a statusUpdate envelope too — the carrier is not the discriminator', () => {
    // The companion above proves the artifactUpdate carrier; this one proves the
    // OTHER carrier for the same part, so the pairing the backend happens to use
    // today cannot quietly become the rule the adapter depends on.
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    const outputs = adapter.adapt(statusUpdate([{
      data: {
        data_type: 'server_tool_status',
        data_version: 1,
        tool_call_id: 'server-call-1',
        name: 'doc_search_v2',
        state: 'started',
        description: 'Searching the docs',
      },
    }]));

    expect(outputs).toContainEqual({
      kind: 'agent_event',
      event: { type: 'status', message: 'Searching the docs' },
    });
    expect(outputs.some(output => output.kind === 'tool_call')).toBe(false);
  });

  it('renders server_tool_status from the description only — an invisible display stays invisible', () => {
    // `yieldToolCallStatus` writes `description` ONLY when `Display.Visible`
    // (`mapping/status.go:33-36`); an empty one is the backend saying "no label".
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    const hidden = adapter.adapt(statusUpdate([{
      data: {
        data_type: 'server_tool_status',
        data_version: 1,
        tool_call_id: 'server-call-1',
        name: 'doc_search_v2',
        state: 'started',
        description: '',
      },
    }]));
    expect(hidden.some(output => output.kind === 'agent_event')).toBe(false);

    // `started` is the only state the extension defines
    // (`server_tool_status.go:10`); anything else is skipped, not rendered.
    const unknownState = adapter.adapt(statusUpdate([{
      data: {
        data_type: 'server_tool_status',
        data_version: 1,
        tool_call_id: 'server-call-1',
        name: 'doc_search_v2',
        state: 'finished',
        description: 'Searched the docs',
      },
    }]));
    expect(unknownState.some(output => output.kind === 'agent_event')).toBe(false);
  });

  it('renders server_tool_invocation as a read-only tool card, never as an executable call', () => {
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    const outputs = adapter.adapt(statusUpdate([{
      data: {
        data_type: 'server_tool_invocation',
        data_version: 1,
        call: {
          index: 0,
          id: 'server-call-1',
          function: { name: 'doc_search_v2', arguments: '{"query":"a2a"}' },
        },
        result: { tool_call_id: 'server-call-1', content: 'three documents' },
      },
    }]));

    expect(outputs).toContainEqual({
      kind: 'agent_event',
      event: {
        type: 'tool_start',
        toolName: 'doc_search_v2',
        toolUseId: 'server-call-1',
        input: { query: 'a2a' },
        turnId: 'turn-1',
        parentToolUseId: undefined,
        intent: undefined,
        displayName: undefined,
      },
    });
    expect(outputs).toContainEqual({
      kind: 'agent_event',
      event: {
        type: 'tool_result',
        toolUseId: 'server-call-1',
        toolName: 'doc_search_v2',
        result: 'three documents',
        isError: false,
        turnId: 'turn-1',
        parentToolUseId: undefined,
      },
    });
    // The backend already ran it: a `tool_call` output would make `turn.ts`
    // execute it again and send a result the backend never asked for.
    expect(outputs.some(output => output.kind === 'tool_call')).toBe(false);
  });

  it('renders server_tool_invocation off an artifactUpdate envelope too', () => {
    // Same independence, the other way round: the invocation part is read from
    // `data.data_type` wherever it rides, so a backend that moves it onto the
    // artifact carrier does not silently stop producing the tool card.
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    const outputs = adapter.adapt({
      artifactUpdate: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        artifact: {
          artifactId: 'a1',
          parts: [{
            data: {
              data_type: 'server_tool_invocation',
              data_version: 1,
              call: {
                index: 0,
                id: 'server-call-3',
                function: { name: 'doc_search_v2', arguments: '{"query":"a2a"}' },
              },
              result: { tool_call_id: 'server-call-3', content: 'three documents' },
            },
          }],
        },
      },
    });

    expect(outputs).toContainEqual({
      kind: 'agent_event',
      event: {
        type: 'tool_start',
        toolName: 'doc_search_v2',
        toolUseId: 'server-call-3',
        input: { query: 'a2a' },
        turnId: 'turn-1',
        parentToolUseId: undefined,
        intent: undefined,
        displayName: undefined,
      },
    });
    expect(outputs).toContainEqual({
      kind: 'agent_event',
      event: {
        type: 'tool_result',
        toolUseId: 'server-call-3',
        toolName: 'doc_search_v2',
        result: 'three documents',
        isError: false,
        turnId: 'turn-1',
        parentToolUseId: undefined,
      },
    });
    expect(outputs.some(output => output.kind === 'tool_call')).toBe(false);
  });

  it('marks a failed server_tool_invocation result as an error card', () => {
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    const outputs = adapter.adapt(statusUpdate([{
      data: {
        data_type: 'server_tool_invocation',
        data_version: 1,
        call: { index: 0, id: 'server-call-2', function: { name: 'doc_search_v2', arguments: '{}' } },
        result: { tool_call_id: 'server-call-2', content: '', error: 'index unavailable' },
      },
    }]));

    expect(outputs).toContainEqual({
      kind: 'agent_event',
      event: {
        type: 'tool_result',
        toolUseId: 'server-call-2',
        toolName: 'doc_search_v2',
        result: 'index unavailable',
        isError: true,
        turnId: 'turn-1',
        parentToolUseId: undefined,
      },
    });
  });

  it('appends the request_id to error events, reading message metadata first', () => {
    // `request_details_extension.go:55-70` writes it onto the MESSAGE metadata of
    // every outgoing message; the connector reads event metadata first and the
    // status message's metadata as the fallback (`a2a/utils.ts:67-80`).
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    adapter.adapt({
      message: {
        messageId: 'msg-9',
        role: 'ROLE_AGENT',
        contextId: 'ctx-1',
        parts: [{ text: 'hi' }],
        metadata: {
          request_details: { data_type: 'request_details', data_version: 1, request_id: 'req-abc' },
        },
      },
    });

    const failed = adapter.adapt(statusUpdate([], 'TASK_STATE_FAILED'));
    expect(failed).toContainEqual({
      kind: 'agent_event',
      event: { type: 'error', message: 'Nestor task failed [request_id: req-abc]' },
    });
  });

  it('falls back to the status message metadata and appends the id to stream errors', () => {
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    const outputs = adapter.adapt({
      statusUpdate: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        status: {
          state: 'TASK_STATE_WORKING',
          message: {
            messageId: 'msg-1',
            role: 'ROLE_AGENT',
            metadata: {
              request_details: { data_type: 'request_details', data_version: 1, request_id: 'req-xyz' },
            },
            parts: [{
              data: {
                data_type: 'retryable_error',
                data_version: 1,
                id: 'err-1',
                error: { code: -32603, message: 'Internal agent error' },
              },
            }],
          },
        },
      },
    });

    expect(outputs).toContainEqual({
      kind: 'stream_error',
      code: -32603,
      retryable: false,
      message: 'Internal agent error (-32603) [request_id: req-xyz]',
    });
  });

  it('treats the literal N/A as absent and forgets the id on the next turn', () => {
    // `GetRequestID` returns the literal "N/A" when the domain context is gone
    // (`request_details_extension.go:72-80`) — that is not a support handle.
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    adapter.adapt({
      message: {
        messageId: 'msg-1',
        role: 'ROLE_AGENT',
        parts: [],
        metadata: { request_details: { request_id: 'N/A' } },
      },
    });
    expect(adapter.adapt(statusUpdate([], 'TASK_STATE_FAILED'))).toContainEqual({
      kind: 'agent_event',
      event: { type: 'error', message: 'Nestor task failed' },
    });

    adapter.startTurn('turn-2');
    adapter.adapt({
      message: {
        messageId: 'msg-2',
        role: 'ROLE_AGENT',
        parts: [],
        metadata: { request_details: { request_id: 'req-1' } },
      },
    });
    expect(adapter.adapt(statusUpdate([], 'TASK_STATE_FAILED'))).toContainEqual({
      kind: 'agent_event',
      event: { type: 'error', message: 'Nestor task failed [request_id: req-1]' },
    });

    adapter.startTurn('turn-3');
    expect(adapter.adapt(statusUpdate([], 'TASK_STATE_FAILED'))).toContainEqual({
      kind: 'agent_event',
      event: { type: 'error', message: 'Nestor task failed' },
    });
  });

  it('makes a second flush a no-op, whether the first came from a final status or the caller', () => {
    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn('turn-1');

    adapter.adapt(statusUpdate([{ text: 'PONG' }]));
    const done = adapter.adapt(statusUpdate([], 'TASK_STATE_COMPLETED'));
    expect(done.filter(output => output.kind === 'agent_event'
      && output.event.type === 'text_complete')).toHaveLength(1);
    expect(adapter.flushPending()).toEqual([]);

    adapter.adapt(statusUpdate([{ text: 'again' }]));
    expect(adapter.flushPending()).toHaveLength(1);
    expect(adapter.flushPending()).toEqual([]);
  });
});

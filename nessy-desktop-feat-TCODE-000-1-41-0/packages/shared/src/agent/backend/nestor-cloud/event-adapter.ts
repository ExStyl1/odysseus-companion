import type { AgentEvent } from '@nessy-agent/core/types';
import { BaseEventAdapter } from '../base-event-adapter.ts';
import type {
  A2AArtifact,
  A2APart,
  A2AStreamEvent,
  A2ATask,
  A2ATaskArtifactUpdate,
  A2ATaskState,
  A2ATaskStatusUpdate,
  A2AMessage,
} from './types.ts';
import { isNestorTerminalTool, parseRemoteToolCall } from './tool-schema.ts';
import { isRetryableStreamErrorCode } from './retry.ts';
import { isTerminalNestorTaskState, normalizeNestorWireTaskState as normalizeTaskState } from './types.ts';

export interface NestorToolCall {
  id: string;
  index: number;
  name: string;
  arguments: string;
}

export type NestorAdapterOutput =
  | { kind: 'agent_event'; event: AgentEvent }
  | { kind: 'context'; contextId: string }
  | { kind: 'task_status'; taskId: string; status: A2ATaskState; final: boolean; hasVisibleMessage: boolean }
  | { kind: 'tool_call'; toolCall: NestorToolCall; startEvent?: AgentEvent; terminal?: boolean }
  /**
   * A `retryable_error` data part, CLASSIFIED rather than rendered: only
   * `turn.ts` knows whether tool results or a parked question are in flight, so
   * only it can decide between a backoff retry and surfacing the message.
   */
  | { kind: 'stream_error'; code?: number; message: string; retryable: boolean }
  | { kind: 'done'; status: A2ATaskState };

/**
 * Decodes the A2A 1.0 stream envelope served at `/api/v2/code-agent/a2a`.
 *
 * Three things differ from the 0.3-compat wire and all three are load-bearing:
 * the envelope is a oneof keyed by `task`/`message`/`statusUpdate`/`artifactUpdate`
 * instead of a `kind` string, task states are `TASK_STATE_*`, and there is no
 * `final` flag — the client computes it. Everything downstream of `adapt()`
 * keeps the internal lowercase state vocabulary.
 */
export class NestorCloudEventAdapter extends BaseEventAdapter {
  private readonly textBuffers = new Map<string, string>();
  /**
   * The backend's support handle for this turn (F22). It is stamped on the
   * metadata of every outgoing message (`request_details_extension.go:82-98`),
   * so it arrives long before the error it explains — it is remembered and
   * appended to whatever the user is eventually shown, and RESET per turn so a
   * later turn never quotes a stale incident id.
   */
  private requestId?: string;

  constructor() {
    super('nestor-cloud');
  }

  protected onTurnStart(): void {
    this.textBuffers.clear();
    this.requestId = undefined;
  }

  adapt(event: A2AStreamEvent): NestorAdapterOutput[] {
    const envelope = asRecord(event);
    if (!envelope) return [];

    const task = asRecord(envelope.task) as A2ATask | null;
    if (task) {
      this.captureRequestId(task);
      return this.adaptTask(task);
    }

    const statusUpdate = asRecord(envelope.statusUpdate) as A2ATaskStatusUpdate | null;
    if (statusUpdate) {
      this.captureRequestId(statusUpdate);
      return this.adaptStatusUpdate(statusUpdate);
    }

    const artifactUpdate = asRecord(envelope.artifactUpdate) as A2ATaskArtifactUpdate | null;
    if (artifactUpdate) {
      this.captureRequestId(artifactUpdate);
      return this.adaptArtifactUpdate(artifactUpdate);
    }

    const message = asRecord(envelope.message) as A2AMessage | null;
    if (message) {
      this.captureRequestId(message);
      return this.adaptMessage(message);
    }

    this.log.warn('Unknown A2A stream envelope key', { keys: Object.keys(envelope) });
    return [];
  }

  /**
   * Reads the request id off the envelope's own metadata, falling back to the
   * status message's — the two locations the connector reads
   * (`adapter/a2a/utils.ts:67-80`), because `MakeResponseMessage` writes it onto
   * the MESSAGE and a status-update carries that message one level down.
   * Logged once per distinct value so a support ticket has something to quote
   * even when the turn ends without an error.
   */
  private captureRequestId(carrier: object): void {
    const requestId = readRequestId(carrier);
    if (!requestId || requestId === this.requestId) return;
    this.requestId = requestId;
    this.log.info('Nestor request id', { requestId });
  }

  /**
   * The support handle appended to anything the user is shown as a failure. No
   * id (or the backend's `"N/A"` placeholder) means no suffix — a message that
   * ends in `[request_id: N/A]` reads like a handle and is not one.
   */
  private withRequestId(message: string): string {
    return this.requestId ? `${message} [request_id: ${this.requestId}]` : message;
  }

  private adaptTask(task: A2ATask): NestorAdapterOutput[] {
    const outputs = contextOutputs(task.contextId);
    if (typeof task.id === 'string' && task.id) {
      const status = normalizeTaskState(task.status?.state);
      outputs.push({
        kind: 'task_status',
        taskId: task.id,
        status,
        final: isFinalState(status),
        hasVisibleMessage: false,
      });
      outputs.push(...this.turnEndOutputs(status));
    }
    return outputs;
  }

  private adaptMessage(message: A2AMessage): NestorAdapterOutput[] {
    const outputs = contextOutputs(message.contextId);
    outputs.push(...this.partsToOutputs(message.parts ?? [], message.messageId));
    return outputs;
  }

  private adaptArtifactUpdate(update: A2ATaskArtifactUpdate): NestorAdapterOutput[] {
    const outputs = contextOutputs(update.contextId);
    const artifact = asRecord(update.artifact) as A2AArtifact | null;
    outputs.push(...this.partsToOutputs(artifact?.parts ?? [], artifact?.artifactId));
    return outputs;
  }

  private adaptStatusUpdate(update: A2ATaskStatusUpdate): NestorAdapterOutput[] {
    const outputs = contextOutputs(update.contextId);
    const parts = update.status?.message?.parts ?? [];
    outputs.push(...this.partsToOutputs(parts, update.status?.message?.messageId));

    const status = normalizeTaskState(update.status?.state);
    // v2 carries no `final` field; the client computes the 0.3 predicate itself
    // (`a2acompat/a2av0/conversions.go:485` — Terminal() || INPUT_REQUIRED).
    const final = isFinalState(status);

    if (update.taskId) {
      outputs.push({
        kind: 'task_status',
        taskId: update.taskId,
        status,
        final,
        hasVisibleMessage: hasVisibleParts(parts),
      });
    }

    outputs.push(...this.turnEndOutputs(status));
    return outputs;
  }

  /**
   * The stream-ending tail for a carried task state, shared by the `task` and
   * `statusUpdate` envelopes so the computed `final` predicate lives in one
   * place. `auth-required` is in neither Terminal() nor INPUT_REQUIRED, so it
   * stays OUT of `isFinalState` — but it still ends the conversation from the
   * user's side, so it takes the same tail with an explicit error. The backend
   * never emits it today (SUBMITTED/WORKING/INPUT_REQUIRED/COMPLETED/CANCELED
   * only); this is the defensive path.
   */
  private turnEndOutputs(status: A2ATaskState): NestorAdapterOutput[] {
    if (!isFinalState(status) && status !== 'auth-required') return [];
    const outputs: NestorAdapterOutput[] = [...this.flushTextComplete()];
    if (status === 'failed' || status === 'rejected' || status === 'auth-required') {
      outputs.push({
        kind: 'agent_event',
        event: { type: 'error', message: this.withRequestId(`Nestor task ${status}`) },
      });
    }
    outputs.push({ kind: 'done', status });
    return outputs;
  }

  private partsToOutputs(parts: A2APart[], messageId?: string): NestorAdapterOutput[] {
    const outputs: NestorAdapterOutput[] = [];
    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      if (!part) continue;

      // Flattened oneof: discriminate by key presence, never by `kind`.
      if (typeof part.text === 'string') {
        const text = part.text;
        if (!text) continue;
        const id = messageId ?? 'default';
        this.textBuffers.set(id, (this.textBuffers.get(id) ?? '') + text);
        outputs.push({
          kind: 'agent_event',
          event: { type: 'text_delta', text, turnId: this.currentTurnId ?? undefined },
        });
        continue;
      }

      // `raw` / `url` / unrecognised parts carry nothing this backend produces.
      // Logged, not silent: the wire facts are a2a-go v2.1.0-verified while the
      // backend pins v2.3.1, so a part shape that shifts must be diagnosable.
      const data = asRecord(part.data);
      if (!data) {
        this.log.warn('Skipped A2A part with no recognised content key', { keys: Object.keys(part) });
        continue;
      }

      if (data.data_type === 'reasoning' && typeof data.reasoning === 'string') {
        outputs.push({
          kind: 'agent_event',
          event: {
            type: 'text_complete',
            text: data.reasoning,
            isIntermediate: true,
            // P4.4 · beyond the row's letter (which names Pi and claude) and
            // deliberately: this arm is a reasoning producer too, and labelling
            // Pi's while leaving this one indistinguishable from commentary is
            // exactly the silent per-backend divergence the host is supposed to
            // remove. One field, same meaning, same renderer row.
            isThinking: true,
            turnId: this.currentTurnId ?? undefined,
          },
        });
        continue;
      }

      // Server-side tool activity (F13). Both arms discriminate on
      // `data.data_type` and NOT on the envelope that carried them: the backend
      // sends `server_tool_status` as an artifact event
      // (`mapping/status.go:47-48`) and `server_tool_invocation` as a
      // status-update message part (`a2a_environment.go:111-123`), and nothing
      // downstream should depend on that pairing holding.
      if (data.data_type === 'server_tool_status') {
        outputs.push(...this.serverToolStatusOutputs(data));
        continue;
      }

      if (data.data_type === 'server_tool_invocation') {
        outputs.push(...this.serverToolInvocationOutputs(data));
        continue;
      }

      if (isRetryableErrorData(data)) {
        const code = readRetryableErrorCode(data);
        outputs.push({
          kind: 'stream_error',
          ...(code !== undefined ? { code } : {}),
          message: this.withRequestId(readRetryableErrorMessage(data)),
          retryable: isRetryableStreamErrorCode(code),
        });
        continue;
      }

      const toolCall = parseRemoteToolCall(data);
      if (toolCall) {
        const input = parseToolArguments(toolCall.arguments);
        const terminal = isNestorTerminalTool(toolCall.name);
        outputs.push({
          kind: 'tool_call',
          toolCall,
          ...(terminal ? { terminal } : { startEvent: this.createToolStart(toolCall.id, toolCall.name, input) }),
        });
      }
    }
    return outputs;
  }

  /**
   * `server_tool_status` — a ONE-SHOT progress ping for a tool the backend runs
   * itself (`server_tool_status.go:10-24`): `started` is the only state the
   * extension defines, so there is no completion half to pair it with and it
   * renders as a plain status line rather than a tool card.
   *
   * The line is the `description` and nothing else. `yieldToolCallStatus` fills
   * that field ONLY when the tool's display is marked visible
   * (`mapping/status.go:33-36`), so an empty one is the backend declining to
   * label this run — substituting a name-based line of our own would override a
   * visibility decision that is the backend's to make. Nothing is lost by
   * honoring it: the same call surfaces as a `server_tool_invocation` card when
   * its result arrives.
   */
  private serverToolStatusOutputs(data: Record<string, unknown>): NestorAdapterOutput[] {
    if (data.state !== 'started') {
      this.log.warn('Skipped server_tool_status with an unknown state', { state: data.state });
      return [];
    }
    const description = typeof data.description === 'string' ? data.description.trim() : '';
    if (!description) return [];
    return [{ kind: 'agent_event', event: { type: 'status', message: description } }];
  }

  /**
   * `server_tool_invocation` — the call AND its result, both already executed on
   * the backend (`server_tool_invocation.go:7-10`). It is rendered as a
   * read-only tool card: a `tool_call` output would send it through `turn.ts`'s
   * executor, which would run a tool the backend has already run and then post
   * a `tool_result` nobody asked for.
   */
  private serverToolInvocationOutputs(data: Record<string, unknown>): NestorAdapterOutput[] {
    const call = asRecord(data.call);
    const result = asRecord(data.result);
    const fn = asRecord(call?.function);
    const name = typeof fn?.name === 'string' ? fn.name : undefined;
    const id = typeof call?.id === 'string' && call.id
      ? call.id
      : (typeof result?.tool_call_id === 'string' ? result.tool_call_id : undefined);
    if (!name || !id) {
      this.log.warn('Skipped malformed server_tool_invocation part', { keys: Object.keys(data) });
      return [];
    }

    const input = typeof fn?.arguments === 'string' ? parseToolArguments(fn.arguments) : {};
    const error = typeof result?.error === 'string' && result.error ? result.error : undefined;
    const content = typeof result?.content === 'string' ? result.content : '';
    return [
      { kind: 'agent_event', event: this.createToolStart(id, name, input) },
      { kind: 'agent_event', event: this.createToolResult(id, name, error ?? content, error !== undefined) },
    ];
  }

  /**
   * Flush whatever text the turn has buffered so far — for a stream that ENDED
   * without ever carrying a final state (F7).
   *
   * The computed `final` predicate covers every state the backend closes on
   * TODAY, but not the two ways a stream can simply stop: a dropped socket, and
   * the retryable-error path, which emits WORKING with the error parts and
   * closes (`a2a_environment.go:157-165` — contrast :174-178, where the
   * client-tool and completed paths carry a terminal state). Text that only ever
   * reached `text_delta` is renderer-only; the assistant message is built solely
   * from `text_complete`, so an unflushed buffer is a message the session never
   * commits.
   *
   * Idempotent by construction: {@link flushTextComplete} empties the buffers,
   * so a flush after a final status — or a second call — returns nothing.
   */
  flushPending(): NestorAdapterOutput[] {
    return this.flushTextComplete();
  }

  private flushTextComplete(): NestorAdapterOutput[] {
    const outputs: NestorAdapterOutput[] = [];
    for (const [messageId, text] of this.textBuffers) {
      if (!text) continue;
      outputs.push({
        kind: 'agent_event',
        event: {
          type: 'text_complete',
          text,
          turnId: this.currentTurnId ?? undefined,
          sdkMessageId: messageId === 'default' ? undefined : messageId,
        },
      });
    }
    this.textBuffers.clear();
    return outputs;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * `metadata.request_details.request_id`, then the status message's copy of the
 * same — the two places the connector looks (`adapter/a2a/utils.ts:67-80`).
 * The literal `"N/A"` is the backend's placeholder for "no domain context"
 * (`request_details_extension.go:72-80`), i.e. an absent id, not one to quote.
 */
function readRequestId(carrier: object): string | undefined {
  const record = carrier as Record<string, unknown>;
  const direct = readRequestIdFromMetadata(record.metadata);
  if (direct) return direct;
  const status = asRecord(record.status);
  return readRequestIdFromMetadata(asRecord(status?.message)?.metadata);
}

function readRequestIdFromMetadata(metadata: unknown): string | undefined {
  const details = asRecord(asRecord(metadata)?.request_details);
  const requestId = details?.request_id;
  if (typeof requestId !== 'string' || !requestId || requestId === 'N/A') return undefined;
  return requestId;
}

function contextOutputs(contextId: unknown): NestorAdapterOutput[] {
  return typeof contextId === 'string' && contextId
    ? [{ kind: 'context', contextId }]
    : [];
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

/**
 * `Terminal()` (`a2a/core.go:327-332`) plus INPUT_REQUIRED, per the compat
 * predicate — this is the 0.3 `final` FLAG semantics, not "the task is over".
 * `turn.ts` clears tasks through its own narrower `isTerminal()`; `final` must
 * never drive `clearTask`, or a parked terminal-tool answer loses the `taskId`
 * it is addressed by.
 */
function isFinalState(status: A2ATaskState): boolean {
  return isTerminalNestorTaskState(status) || status === 'input-required';
}

function hasVisibleParts(parts: A2APart[]): boolean {
  return parts.some((rawPart) => {
    const part = asRecord(rawPart);
    if (!part) return false;
    if (typeof part.text === 'string') return !!part.text.trim();
    return asRecord(part.data) !== null;
  });
}

function isRetryableErrorData(data: Record<string, unknown>): boolean {
  return asRecord(data.error) !== null;
}

function readRetryableErrorMessage(data: Record<string, unknown>): string {
  const error = data.error as { message?: unknown; code?: unknown };
  const message = typeof error.message === 'string' ? error.message : 'A2A stream error';
  const code = typeof error.code === 'number' ? ` (${error.code})` : '';
  return `${message}${code}`;
}

function readRetryableErrorCode(data: Record<string, unknown>): number | undefined {
  const error = data.error as { code?: unknown };
  return typeof error.code === 'number' ? error.code : undefined;
}

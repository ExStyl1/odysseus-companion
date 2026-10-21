import type { AgentEvent } from '@nessy-agent/core/types';
import type { NestorCloudClient } from './client.ts';
import { NestorCloudEventAdapter, type NestorAdapterOutput, type NestorToolCall } from './event-adapter.ts';
import {
  NestorCloudRetryableTransportError,
  NestorCloudRetryPolicy,
  RATE_LIMIT_MAX_RETRIES,
  sleepUnlessAborted,
} from './retry.ts';
import { readNestorTerminalToolPrompt } from './tool-schema.ts';
import type { A2AStreamEvent, A2ATaskState, NestorPendingTerminalTool } from './types.ts';
import { isTerminalNestorTaskState, NestorCloudTerminalTaskError } from './types.ts';

/**
 * Declared in `types.ts` (the client throws it, the turn catches it) and
 * re-exported here because this is where every existing importer reads it from.
 */
export { NestorCloudTerminalTaskError };

/**
 * How long a cancel is allowed to take. The cancel is fired on a teardown path
 * — nobody is waiting for it — so it needs a bound of its own, but it must NOT
 * be the turn's signal: every production caller aborts that signal one line
 * before calling `cancel()` (F20).
 */
export const NESTOR_CANCEL_TIMEOUT_MS = 5000;

export interface NestorToolExecutionResult {
  content?: string;
  error?: string;
  events?: AgentEvent[];
}

export interface NestorCloudTurnOptions {
  client: Pick<
    NestorCloudClient,
    'loadAgentCard' | 'sendMessageStream' | 'sendToolResultsStream' | 'sendRetryMarkerStream' | 'cancelTask'
  >;
  adapter?: NestorCloudEventAdapter;
  executeTool?: (toolCall: NestorToolCall) => Promise<NestorToolExecutionResult>;
  metadata?: Record<string, unknown>;
  contextId?: string;
  taskId?: string;
  /**
   * A terminal tool call this session parked on a previous turn (F5). When it is
   * present AND {@link taskId} still names the task that asked, this turn's
   * message is sent as that call's `tool_result` instead of as a new prompt.
   */
  answerToolCall?: NestorPendingTerminalTool;
  signal?: AbortSignal;
  /**
   * The signal a cancel RPC rides. Injectable for test determinism only —
   * production leaves it unset and gets a fresh
   * `AbortSignal.timeout(NESTOR_CANCEL_TIMEOUT_MS)` per call.
   */
  createCancelSignal?: () => AbortSignal | undefined;
  /**
   * The retry backoff's sleep. Injectable for test determinism only — production
   * leaves it unset and gets {@link sleepUnlessAborted}, which the turn's signal
   * cuts short. Resolves `false` when the turn was aborted mid-wait.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  onContextUpdate?: (update: NestorCloudTurnContextUpdate) => void | Promise<void>;
}

/**
 * One outgoing send, built ONCE and re-openable.
 *
 * A retryable transport failure (429/5xx) is decided before any frame is read,
 * so the correct retry is the identical request — and rebuilding it from the
 * turn's state would not produce one: a parked answer is consumed on the way in
 * and the pending tool results are drained into the first attempt.
 */
type NestorSendSpec =
  | { kind: 'message'; text: string }
  | { kind: 'answer'; toolCallId: string; content: string }
  | { kind: 'tool_results'; results: Array<{ toolCallId: string; content?: string; error?: string }> }
  | { kind: 'retry_marker' };

/** Structurally the context store's `NestorCloudContextUpdate`, without the import. */
export interface NestorCloudTurnContextUpdate {
  contextId?: string;
  taskId?: string;
  taskStatus?: A2ATaskState;
  clearTask?: boolean;
  pendingTerminalTool?: NestorPendingTerminalTool;
  clearPendingTerminalTool?: boolean;
}

/** A `retryable_error` data part, held until the stream that carried it ends. */
interface NestorRetryableStreamError {
  code?: number;
  message: string;
}

/** A terminal tool call seen on the stream, with the text it hands to the user. */
interface NestorTerminalToolCall extends NestorPendingTerminalTool {
  input: Record<string, unknown>;
  text: string;
}

export class NestorCloudTurn {
  private readonly adapter: NestorCloudEventAdapter;
  private readonly executeTool: (toolCall: NestorToolCall) => Promise<NestorToolExecutionResult>;
  private contextId?: string;
  private taskId?: string;
  private taskStatus: A2ATaskState = 'unknown';
  private answerToolCall?: NestorPendingTerminalTool;
  private readonly pendingToolResults: Array<{ toolCallId: string; content?: string; error?: string }> = [];
  private terminalToolCalls: NestorTerminalToolCall[] = [];
  /** One budget per turn, shared by the transport and in-band rate-limit paths. */
  private readonly retryPolicy = new NestorCloudRetryPolicy();
  /** The last `retryable_error` part this attempt carried, decided after the stream ends. */
  private retryableStreamError?: NestorRetryableStreamError;

  constructor(private readonly options: NestorCloudTurnOptions) {
    this.adapter = options.adapter ?? new NestorCloudEventAdapter();
    this.executeTool = options.executeTool ?? (async (toolCall) => ({
      error: `Tool execution is not wired yet: ${toolCall.name}`,
    }));
    this.contextId = options.contextId;
    this.taskId = options.taskId;
    this.answerToolCall = options.answerToolCall;
  }

  async *run(message: string): AsyncGenerator<AgentEvent> {
    this.adapter.startTurn();
    yield { type: 'status', message: 'Checking Nestor credentials...' };
    yield { type: 'status', message: 'Connecting to Nestor cloud agent...' };
    await this.options.client.loadAgentCard(this.options.signal);

    let isContinuation = false;
    let retriedTerminalTask = false;
    // The sidecar park survives until the answering send is ACCEPTED (the
    // stream consumed without throwing): clearing before the send would lose
    // the user's answer on a failed POST — the next prompt would go out as an
    // ordinary message onto a task still waiting for its tool result.
    let clearParkAfterAccept = false;
    // A send the next pass must use INSTEAD of building one: either the previous
    // attempt's own args held for a verbatim retry after a transport 429/5xx, or
    // the retry marker that answers an in-band `-32029`. Its presence also means
    // "do not consume the parked answer again" — it was consumed on the attempt
    // this send belongs to.
    let queuedSend: NestorSendSpec | undefined;

    for (;;) {
      if (this.options.signal?.aborted) {
        yield { type: 'complete' };
        return;
      }

      // Consumed on the FIRST send only. A parked call whose task is gone
      // cannot be addressed at all (the continuation must name a taskId), so
      // the prompt goes out as an ordinary message and the park drops NOW;
      // an addressable park is cleared only after the answer is accepted.
      let answer: NestorPendingTerminalTool | undefined;
      if (!queuedSend && !isContinuation && this.answerToolCall) {
        const parked = this.answerToolCall;
        this.answerToolCall = undefined;
        if (this.taskId) {
          answer = parked;
          clearParkAfterAccept = true;
        } else {
          await this.notifyContext({ clearPendingTerminalTool: true });
        }
      }

      this.terminalToolCalls = [];
      // Per-PASS state, cleared here rather than only after the stream: the
      // post-stream read below is skipped whenever `consumeStream` throws, so a
      // `-32029` seen on an attempt the terminal-task recovery then rejected
      // would be inherited by the next attempt — a backoff and a retry marker
      // charged to a stream that never carried the error. (The later clear stays;
      // it is a no-op once this line has run.)
      this.retryableStreamError = undefined;
      const send = queuedSend ?? this.buildSend(message, isContinuation, answer);
      queuedSend = undefined;
      try {
        yield* this.consumeStream(this.openStream(send));
      } catch (err) {
        if (err instanceof NestorCloudTerminalTaskError && this.taskId && !isContinuation && !retriedTerminalTask) {
          retriedTerminalTask = true;
          this.taskId = undefined;
          await this.notifyContext({ clearTask: true, taskStatus: err.taskState });
          if (clearParkAfterAccept) {
            // The task the answer addressed is terminal — the answer is
            // undeliverable as a tool result; the retry sends it as a message.
            clearParkAfterAccept = false;
            await this.notifyContext({ clearPendingTerminalTool: true });
          }
          yield { type: 'status', message: 'Reconnecting Nestor task...' };
          continue;
        }
        if (err instanceof NestorCloudRetryableTransportError) {
          const wait = err.rateLimited
            ? this.retryPolicy.nextRateLimitDelayMs()
            : (this.retryPolicy.allowServerErrorRetry() ? 0 : undefined);
          if (wait === undefined) {
            // Budget spent. The backend's own text is the only thing that says
            // WHICH limit was hit, so it is what the user gets.
            yield { type: 'error', message: err.message };
            yield { type: 'complete' };
            return;
          }
          yield {
            type: 'status',
            message: err.rateLimited
              ? `Nestor rate limit — retrying in ${Math.round(wait / 1000)}s `
                + `(attempt ${this.retryPolicy.rateLimitAttempt}/${RATE_LIMIT_MAX_RETRIES})...`
              : `Nestor request failed (${err.status}) — retrying...`,
          };
          if (wait > 0 && !(await this.sleep(wait))) {
            yield { type: 'complete' };
            return;
          }
          // Verbatim: the failure happened before any frame, so these args are
          // still the right ones and the park (if any) stays consumed for them.
          queuedSend = send;
          continue;
        }
        // Not recovered from — so this is the text the user reads. The generic
        // "already terminal" sentence covers only one of the conditions routed
        // onto that class: a `-32001` task was NOT FOUND, and saying it is frozen
        // both misdescribes it and throws away the backend's own words.
        if (err instanceof NestorCloudTerminalTaskError) throw err.asSurfaced();
        throw err;
      }
      if (clearParkAfterAccept) {
        clearParkAfterAccept = false;
        await this.notifyContext({ clearPendingTerminalTool: true });
      }

      const parked = this.terminalToolCalls.at(-1);

      // Read through a method, not off the field: the per-pass reset above
      // narrows the field to `undefined` for the flow analysis (which cannot see
      // the writer inside `handleAdapterOutput`, and whose narrowing survives the
      // `yield*`), so a direct read would type as `never` here.
      const streamError = this.takeRetryableStreamError();
      if (streamError) {
        // The backend flattened a rate limit into a data part and ended the
        // stream INPUT_REQUIRED (`a2a_environment.go:157-165`): the task is
        // frozen mid-turn, so the retry cannot address it — it carries the
        // extension's retry marker on the contextId alone.
        //
        // Not when tool results or a parked question are in flight: the marker
        // send abandons both, and the backend's loop is one-tool-per-message, so
        // that combination is defensive rather than real. Surface it instead.
        if (this.pendingToolResults.length > 0 || parked) {
          yield { type: 'error', message: streamError.message };
        } else {
          const wait = this.retryPolicy.nextRateLimitDelayMs();
          if (wait === undefined) {
            yield { type: 'error', message: streamError.message };
            yield { type: 'complete' };
            return;
          }
          yield {
            type: 'status',
            message: `Nestor rate limit — retrying in ${Math.round(wait / 1000)}s `
              + `(attempt ${this.retryPolicy.rateLimitAttempt}/${RATE_LIMIT_MAX_RETRIES})...`,
          };
          if (!(await this.sleep(wait))) {
            yield { type: 'complete' };
            return;
          }
          queuedSend = { kind: 'retry_marker' };
          isContinuation = false;
          continue;
        }
      }
      const suspending = this.taskStatus === 'input-required'
        && this.pendingToolResults.length === 0
        && parked !== undefined;

      if (suspending && parked) {
        // Surfaced after the stream so the model's own narration (flushed by the
        // final status) reads before the question it ends on — and ONLY on the
        // branch that actually parks: showing a question this turn will not
        // honor would leave the user answering into a continuation.
        for (const terminal of this.terminalToolCalls) {
          if (terminal.text) yield { type: 'text_complete', text: terminal.text };
        }
        await this.notifyContext({
          pendingTerminalTool: { toolCallId: parked.toolCallId, name: parked.name },
        });
        // `tool_deferred` — the documented terminal reason for a run that ends
        // SUCCESS with a pending tool call preserved. It is also what keeps
        // `BaseAgent.chat` from re-entering the backend: a `complete` carrying a
        // reason is not held back, so no model-skill continuation is built from
        // the question text (`base-agent.ts:3868-3879`). The user answers it.
        yield {
          type: 'complete',
          terminalReason: 'tool_deferred',
          deferredToolUse: { id: parked.toolCallId, name: parked.name, input: parked.input },
        };
        return;
      }

      if (parked) {
        // Mixed stream: a terminal call arrived alongside executable tools, so
        // the continuation wins and the question cannot be honored this pass.
        // The backend's loop is one-tool-per-message, so this is a defensive
        // path — but it must not drop the call silently.
        yield {
          type: 'info',
          message: `Nestor asked ${parked.name} alongside other tools; sending their results first.`,
        };
      }

      if (this.taskStatus === 'input-required' && this.pendingToolResults.length > 0) {
        isContinuation = true;
        yield { type: 'status', message: 'Sending tool result to Nestor...' };
        continue;
      }

      yield { type: 'complete' };
      return;
    }
  }

  /**
   * Cancel the remote task. The RPC deliberately does NOT ride
   * `options.signal`: `abort()`, `forceAbort()`, `destroy()` and
   * `disposeForRestart()` all abort that signal before they get here, and an
   * already-aborted signal makes the fetch reject before the request leaves the
   * process — the backend never hears about it and keeps burning quota (F20).
   * Its own timeout is the bound instead.
   *
   * `updateSidecar: false` is the TEARDOWN form, used by `destroy()` and
   * `disposeForRestart()`. Their cancel is fire-and-forget and awaits a network
   * round trip, so its `clearTask` notification can land up to
   * {@link NESTOR_CANCEL_TIMEOUT_MS} AFTER the agent is gone — and the context
   * store it notifies rebuilds the whole sidecar from its own CACHED snapshot
   * and rewrites the file. On a teardown that is a write against a store nobody
   * owns any more: it resurrects a sidecar `/clear` deleted, or clobbers one a
   * newer session already wrote. The RPC still goes out and the in-memory task
   * id is still cleared; only the persisted side is skipped.
   */
  async cancel(options?: { updateSidecar?: boolean }): Promise<void> {
    if (!this.taskId) return;
    const signal = this.options.createCancelSignal?.() ?? AbortSignal.timeout(NESTOR_CANCEL_TIMEOUT_MS);
    await this.options.client.cancelTask(this.taskId, signal);
    this.taskId = undefined;
    if (options?.updateSidecar === false) return;
    await this.notifyContext({ clearTask: true, taskStatus: 'canceled' });
  }

  async *cancelWithEvents(): AsyncGenerator<AgentEvent> {
    if (!this.taskId) {
      yield { type: 'complete' };
      return;
    }
    yield { type: 'status', message: 'Stopping Nestor task...' };
    await this.cancel();
    yield { type: 'complete' };
  }

  /**
   * Decides WHAT this pass sends, and drains the state that goes with it — the
   * pending tool results, and the parked answer the caller already consumed.
   * Called once per attempt; a retry re-uses the spec instead of calling it
   * again, which is the whole reason the two halves are separate.
   */
  private buildSend(
    message: string,
    isContinuation: boolean,
    answer?: NestorPendingTerminalTool,
  ): NestorSendSpec {
    if (isContinuation) {
      return { kind: 'tool_results', results: this.pendingToolResults.splice(0) };
    }
    if (answer && this.taskId) {
      // The user's prompt IS the parked call's result. `content` is
      // `validate:"required"` on the backend's tool-result item, so it is always
      // emitted — an empty answer is an empty string, never an absent field.
      return { kind: 'answer', toolCallId: answer.toolCallId, content: message };
    }
    return { kind: 'message', text: message };
  }

  private openStream(send: NestorSendSpec): AsyncIterable<A2AStreamEvent> {
    switch (send.kind) {
      case 'tool_results':
        return this.options.client.sendToolResultsStream({
          ...(this.contextId ? { contextId: this.contextId } : {}),
          taskId: this.taskId ?? '',
          results: send.results,
          signal: this.options.signal,
        });
      case 'answer':
        return this.options.client.sendToolResultsStream({
          ...(this.contextId ? { contextId: this.contextId } : {}),
          taskId: this.taskId ?? '',
          results: [{ toolCallId: send.toolCallId, content: send.content }],
          ...(this.options.metadata ? { metadata: this.options.metadata } : {}),
          signal: this.options.signal,
        });
      case 'retry_marker':
        // No `taskId` by construction — see `sendRetryMarkerStream`.
        return this.options.client.sendRetryMarkerStream({
          ...(this.contextId ? { contextId: this.contextId } : {}),
          ...(this.options.metadata ? { metadata: this.options.metadata } : {}),
          signal: this.options.signal,
        });
      case 'message':
        return this.options.client.sendMessageStream({
          text: send.text,
          ...(this.contextId ? { contextId: this.contextId } : {}),
          ...(this.taskId ? { taskId: this.taskId } : {}),
          ...(this.options.metadata ? { metadata: this.options.metadata } : {}),
          signal: this.options.signal,
        });
    }
  }

  /**
   * The held `retryable_error`, cleared as it is read. Kept even though every
   * pass now starts by clearing the field: this is the read that PAIRS with the
   * decision below, and leaving the value set after it would be a second way for
   * one attempt's error to reach another.
   */
  private takeRetryableStreamError(): NestorRetryableStreamError | undefined {
    const held = this.retryableStreamError;
    this.retryableStreamError = undefined;
    return held;
  }

  private async sleep(ms: number): Promise<boolean> {
    const sleep = this.options.sleep ?? sleepUnlessAborted;
    return sleep(ms, this.options.signal);
  }

  private async *consumeStream(stream: AsyncIterable<A2AStreamEvent>): AsyncGenerator<AgentEvent> {
    yield { type: 'status', message: this.taskId ? 'Resuming remote agent task...' : 'Starting remote agent task...' };
    yield { type: 'status', message: 'Waiting for Nestor agent...' };

    try {
      for await (const wireEvent of stream) {
        for (const output of this.adapter.adapt(wireEvent)) {
          yield* this.handleAdapterOutput(output);
        }
      }
    } catch (err) {
      // The motivating F7 cases do not END the stream, they THROW out of it: a
      // torn socket and an abort mid-WORKING both surface here (`client.ts`
      // re-wraps them as `NestorCloudClientError('stream-failed')`). A flush
      // placed only after the loop would therefore miss exactly the paths it
      // exists for — so it runs on the error path too, BEFORE the rethrow,
      // because an event yielded after a throw is an event nobody receives.
      //
      // A terminal-task rejection is the one exception: `run()` recovers from it
      // by resending, and the retry regenerates the answer from scratch. Keeping
      // the rejected attempt's half-sentence would prepend it to the retry's
      // `text_complete` (the buffers are per-turn, not per-attempt), so the
      // buffer is emptied and DROPPED. `-32004` is reachable after text has
      // streamed (`a2a_repo_task_store.go:106-107`), so this is not theoretical.
      const outputs = this.adapter.flushPending();
      if (!(err instanceof NestorCloudTerminalTaskError)) {
        for (const output of outputs) {
          yield* this.handleAdapterOutput(output);
        }
      }
      throw err;
    }

    // The stream is exhausted. A final status is the OPTIMISATION, not the only
    // trigger: a dropped socket and the backend's retryable-error path both end
    // a stream on a non-final state, and text left in the adapter's buffer would
    // never become the `text_complete` the session commits a message from (F7).
    // A double flush is a no-op, so the ordinary completed stream is unchanged.
    for (const output of this.adapter.flushPending()) {
      yield* this.handleAdapterOutput(output);
    }
  }

  private async *handleAdapterOutput(output: NestorAdapterOutput): AsyncGenerator<AgentEvent> {
    switch (output.kind) {
      case 'agent_event':
        yield output.event;
        break;
      case 'context':
        this.contextId = output.contextId;
        await this.notifyContext({ contextId: output.contextId });
        break;
      case 'task_status':
        this.taskId = output.taskId;
        this.taskStatus = output.status;
        await this.notifyContext({ taskId: output.taskId, taskStatus: output.status });
        if (isTerminal(output.status)) {
          this.taskId = undefined;
          await this.notifyContext({ clearTask: true, taskStatus: output.status });
        }
        break;
      case 'tool_call': {
        // A terminal tool is NOT executed. Nothing local can answer
        // "should I continue?" — the user can, so the call is parked and the
        // turn suspends after the stream (F5).
        if (output.terminal === true) {
          const prompt = readNestorTerminalToolPrompt(output.toolCall);
          this.terminalToolCalls.push({
            toolCallId: output.toolCall.id,
            name: output.toolCall.name,
            input: prompt.input,
            text: prompt.text,
          });
          break;
        }
        if (output.startEvent) {
          yield output.startEvent;
        }
        const result = await this.executeTool(output.toolCall);
        for (const event of result.events ?? []) {
          yield event;
        }
        if (!result.events?.some((event) => event.type === 'tool_result' && event.toolUseId === output.toolCall.id)) {
          yield {
            type: 'tool_result',
            toolUseId: output.toolCall.id,
            toolName: output.toolCall.name,
            result: result.error ?? result.content ?? '',
            isError: !!result.error,
          };
        }
        this.pendingToolResults.push({
          toolCallId: output.toolCall.id,
          content: result.content ?? '',
          ...(result.error ? { error: result.error } : {}),
        });
        break;
      }
      case 'stream_error':
        // Held, not yielded: the decision needs the END of the stream (whether
        // tool results or a parked question came with it). A persistent code is
        // surfaced immediately — nothing later can change what to do with it.
        if (output.retryable) {
          this.retryableStreamError = { ...(output.code !== undefined ? { code: output.code } : {}), message: output.message };
        } else {
          yield { type: 'error', message: output.message };
        }
        break;
      case 'done':
        this.taskStatus = output.status;
        break;
    }
  }

  private async notifyContext(update: NestorCloudTurnContextUpdate): Promise<void> {
    await this.options.onContextUpdate?.(update);
  }
}

/**
 * The task-clearing predicate — DELIBERATELY narrower than the adapter's
 * `isFinalState`, which includes `input-required` because that is the 0.3
 * `final` flag's meaning (Terminal() || INPUT_REQUIRED). `input-required` must
 * NEVER clear the task: the suspension path parks a terminal tool call that is
 * addressable only by this `taskId`. Wiring `output.final` into `clearTask`
 * would silently degrade every parked answer into an ordinary message.
 */
function isTerminal(status: A2ATaskState): boolean {
  return isTerminalNestorTaskState(status);
}

/**
 * Streaming Nestor chat SSE → Responses SSE events.
 *
 * Mirrors the index-keyed tool-call accumulation from
 * `unified-network-interceptor.ts:createOpenAiSseStrippingStream` (the FIRST
 * chunk for an index carries id+name; continuation chunks carry only argument
 * fragments and may have null/missing id/name/type — never a hard error) but
 * emits **Responses** events, whose exact `type` strings were validated end-to-
 * end against the real codex app-server in Phase 1.
 *
 * Emission order: `response.created` → [reasoning item events] → [message item
 * events] → [function_call item events per tool index] → a terminal frame →
 * `data: [DONE]`. Reasoning is surfaced as a `reasoning` item, never in
 * `output_text`; tool calls come ONLY from `content`, never from reasoning.
 *
 * The terminal frame is one of:
 *  - `response.completed` — a graceful close (`[DONE]`, a `finish_reason`, or a
 *    trailing usage chunk);
 *  - `response.failed` — an upstream failure, with a `last_error` classified into
 *    the taxonomy codex-rs understands (see `errors.ts:classifyError`);
 *  - `response.incomplete` — a truncated turn: `max_output_tokens` (opt-in per
 *    route, see `TruncationFrame`), `upstream_stall_timeout`, or `adapter_eof`.
 *
 * ---------------------------------------------------------------------------
 * T3b — the stream-integrity behaviour below is VENDORED from opencodex
 * (github.com/lidge-jun/opencodex) @ 16bef04, MIT.
 * Copyright (c) 2026 opencodex contributors. MIT — see
 * https://github.com/lidge-jun/opencodex/blob/main/LICENSE
 * Blocks, with their source sites (adapted to this file's
 * `parseChatSse` / `streamResponsesFromChat` names; the `<think>` splitter and
 * the retry rungs are untouched):
 *  - fail-closed truncation, inline `chunk.error` envelope, residual-frame flush:
 *    `src/adapters/openai-chat.ts:340-461`;
 *  - `response.failed` with a classified `last_error`: `src/bridge.ts:628-664`;
 *  - `response.incomplete` on generator EOF: `src/bridge.ts:669-686`;
 *  - trailing `data: [DONE]`: `src/bridge.ts:163,688`;
 *  - heartbeat / stall watchdog: `src/bridge.ts:182-211`;
 *  - atomic tool-call flush with synthesized `call_N` ids and the `""`→`"{}"`
 *    argument guard: `src/adapters/openai-chat.ts:317-334`, `src/bridge.ts:341-344`.
 * Local divergence: the stall path emits the trailing `data: [DONE]` too. opencodex's
 * watchdog returns before its `emitDone()` (`bridge.ts:204-210` vs `:688`), so a
 * stalled turn there ends without the sentinel. Ours emits it after EVERY terminal
 * frame, so a client that waits for the sentinel is not left hanging by the one case
 * that already means "the upstream went quiet"; pinned by the stall tests.
 * See docs/superpowers/plans/2026-08-04-claude-sdk-runtime-on-nessy-integrations.md (T3b).
 * ---------------------------------------------------------------------------
 */
import { StreamingThinkSplitter } from '../../shared/src/llm/think-splitter.ts';
import { mapUsage, type ChatUsage } from './from-chat.ts';
import { adapterFailureFromMessage } from './errors.ts';

interface ChatDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string | null;
    type?: string | null;
    function?: { name?: string | null; arguments?: string | null };
  }>;
}
export interface ChatChunk {
  choices?: Array<{ delta?: ChatDelta; finish_reason?: string | null }>;
  usage?: ChatUsage;
  /**
   * A 200/OK chat-completions stream may carry an inline provider error envelope
   * instead of a clean `[DONE]`. `parseChatSse` also SYNTHESIZES one of these when
   * the socket ends with no terminal signal at all, so the single downstream
   * `chunk.error` branch covers both (opencodex `openai-chat.ts:366-371,456-459`).
   */
  error?: { message?: string | null; type?: string | null; code?: string | null } | null;
  /**
   * Parser-synthesized graceful-close marker for `data: [DONE]`. Not a wire field —
   * it is how the parser tells the emitter "this close was clean", the role
   * opencodex's `{ type: "done" }` adapter event plays (`openai-chat.ts:349-353`).
   */
  done?: true;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Message the fail-closed EOF path reports. Neutral wording: shared by both routes. */
const EOF_WITHOUT_TERMINAL =
  'upstream stream ended without a terminal signal ([DONE] or finish_reason) — possible truncation';

/**
 * Parse a Nestor chat SSE body into chat chunks.
 *
 * Terminal signals are tracked so a socket EOF with none of them can FAIL CLOSED
 * rather than read as a clean completion (silent truncation). A graceful close is
 * an explicit `[DONE]`, a chunk carrying a non-null `finish_reason`, or a trailing
 * usage chunk — some OpenAI-compatible gateways send only one of the three.
 */
export async function* parseChatSse(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawFinish = false;
  let sawUsage = false;

  // One per-line handler shared by the streaming loop and the EOF residual flush, so a
  // final frame is parsed identically wherever it lands (no duplicated, drift-prone
  // parsing). Returns 'terminate' for a frame that must end the stream.
  function* handleDataLine(rawLine: string): Generator<ChatChunk, 'continue' | 'terminate'> {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return 'continue';
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      yield { done: true };
      return 'terminate';
    }
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(payload) as ChatChunk;
    } catch {
      // Local deviation from opencodex (which terminates with an error here): this
      // adapter has always tolerated a malformed frame rather than crashing the
      // stream, and a corrupt stream still fails closed at the EOF check below.
      return 'continue';
    }
    // An inline error envelope is terminal: surface it so the emitter reports a
    // classified `response.failed`, never a truncated completion.
    if (chunk.error) {
      yield chunk;
      return 'terminate';
    }
    if (chunk.usage) sawUsage = true;
    const finish = chunk.choices?.[0]?.finish_reason;
    if (typeof finish === 'string' && finish) sawFinish = true;
    yield chunk;
    return 'continue';
  }

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if ((yield* handleDataLine(line)) === 'terminate') return;
      }
    }
    // Some gateways send the terminal `data:` frame (final delta, finish_reason and/or
    // usage) WITHOUT a trailing newline before closing the socket, so it never crosses
    // the split boundary and stays in `buffer`. Run it through the SAME handler, or a
    // genuinely complete stream loses its last frame and is falsely failed below.
    if (buffer.length > 0 && (yield* handleDataLine(buffer)) === 'terminate') return;
    if (!sawFinish && !sawUsage) {
      yield { error: { message: EOF_WITHOUT_TERMINAL } };
    }
  } finally {
    reader.releaseLock();
  }
}

interface ToolAcc {
  index: number;
  id: string;
  name: string;
  args: string;
}

/**
 * Which terminal frame a truncated turn (`finish_reason: "length"`) ends with.
 *
 * `'completed'` is the default and is what the codex `/v1/responses` route uses:
 * codex's consumer treats a stream that never reaches `response.completed` as a
 * stream error, which is a worse outcome than reporting a truncated turn as a
 * finished one. `'incomplete'` is opted into by the Anthropic `/v1/messages`
 * route, whose translator maps `response.incomplete` +
 * `incomplete_details.reason: "max_output_tokens"` to `stop_reason: "max_tokens"`.
 *
 * The trigger is not rare — `to-chat.ts` sends the caller's `max_tokens` only when
 * the request carries one, so the gateway's own output ceiling still produces
 * `"length"` on long turns.
 */
export type TruncationFrame = 'completed' | 'incomplete';

/**
 * How long upstream silence may last before a parser-ignored keepalive is written
 * to re-arm the client's idle timer (opencodex `bridge.ts:73`).
 */
export const DEFAULT_HEARTBEAT_MS = 2_000;

/** Silence after which the turn is abandoned as stalled (opencodex `bridge.ts:184`). */
export const DEFAULT_STALL_TIMEOUT_SEC = 90;

export interface StreamResponsesOptions {
  model: string;
  responseId: string;
  toolNamespaces?: Record<string, string>;
  truncationFrame?: TruncationFrame;
  /** Keepalive cadence during upstream silence. Default `DEFAULT_HEARTBEAT_MS`. */
  heartbeatMs?: number;
  /** Silence budget before `response.incomplete`. Default `DEFAULT_STALL_TIMEOUT_SEC`. */
  stallTimeoutSec?: number;
  /**
   * Called once when the stall watchdog fires, AFTER the terminal frame is written.
   * The routes wire this to their per-request `AbortController.abort()` so a stalled
   * turn does not leak the upstream stream or keep draining tokens.
   */
  onStall?: () => void;
}

/**
 * Drive Responses SSE onto `write` from an async iterable of chat chunks.
 * `write` receives complete SSE frames.
 */
export async function streamResponsesFromChat(
  chunks: AsyncIterable<ChatChunk>,
  write: (frame: string) => void,
  opts: StreamResponsesOptions,
): Promise<void> {
  const { model, responseId, toolNamespaces, truncationFrame = 'completed', onStall } = opts;
  const nsFor = (name: string): { namespace?: string } => {
    const ns = toolNamespaces?.[name];
    return ns ? { namespace: ns } : {};
  };
  const reasoningId = `reasoning_${responseId}`;
  const msgId = `msg_${responseId}`;
  const splitter = new StreamingThinkSplitter();

  let nextOutputIndex = 0;
  let reasoningOpened = false;
  let reasoningIndex = -1;
  let messageOpened = false;
  let messageIndex = -1;
  let messageClosed = false;
  /**
   * Tool calls are BUFFERED until the stream ends, then flushed as atomic
   * added → delta → done sequences (opencodex `openai-chat.ts:317-334`). Emitting
   * them live cannot represent parallel calls without OVERLAPPING sequences, and the
   * Anthropic consumer (`anthropic/outbound.ts`) routes `input_json_delta` to THE
   * open tool block rather than by `item_id` — so an upstream that interleaves
   * fragments from two calls would misroute every fragment after the second opens.
   * Buffering is what keeps each call's run contiguous, and therefore that routing safe.
   */
  const pendingToolCalls: ToolAcc[] = [];
  let toolCallSeq = 0;
  let lastToolIndex = -1;
  let usage: ChatUsage | undefined;
  let finishReason: string | undefined;
  /** `parseChatSse` saw an explicit `data: [DONE]` — the cleanest close there is. */
  let sawGracefulClose = false;
  /** Set once a terminal frame has been written; suppresses every later write. */
  let terminated = false;
  /** Cleared by the heartbeat tick whenever a real frame went out since the last tick. */
  let activity = false;

  const emit = (frame: string): void => {
    if (terminated) return;
    activity = true;
    write(frame);
  };
  /** The trailing sentinel Responses clients read as end-of-stream (`bridge.ts:163`). */
  const emitDone = (): void => {
    write('data: [DONE]\n\n');
  };

  emit(sse('response.created', {
    type: 'response.created',
    response: { id: responseId, object: 'response', status: 'in_progress', model, output: [] },
  }));

  const openReasoning = () => {
    if (reasoningOpened) return;
    reasoningOpened = true;
    reasoningIndex = nextOutputIndex++;
    emit(sse('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: reasoningIndex,
      item: { type: 'reasoning', id: reasoningId, summary: [], content: [] },
    }));
  };
  const closeReasoning = (text: string) => {
    if (!reasoningOpened) return;
    emit(sse('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: reasoningIndex,
      item: { type: 'reasoning', id: reasoningId, summary: [], content: [{ type: 'reasoning_text', text }] },
    }));
  };
  const openMessage = () => {
    if (messageOpened) return;
    messageOpened = true;
    messageIndex = nextOutputIndex++;
    emit(sse('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: messageIndex,
      item: { type: 'message', id: msgId, status: 'in_progress', role: 'assistant', content: [] },
    }));
    emit(sse('response.content_part.added', {
      type: 'response.content_part.added',
      item_id: msgId,
      output_index: messageIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    }));
  };

  let reasoningText = '';
  let answerText = '';

  const routeReasoning = (frag: string) => {
    if (!frag) return;
    openReasoning();
    reasoningText += frag;
    emit(sse('response.reasoning_text.delta', {
      type: 'response.reasoning_text.delta',
      item_id: reasoningId,
      output_index: reasoningIndex,
      delta: frag,
    }));
  };
  const routeAnswer = (frag: string) => {
    if (!frag) return;
    // First answer text closes reasoning (think precedes answer).
    if (reasoningOpened) {
      closeReasoning(reasoningText);
      reasoningOpened = false; // mark done so we don't re-close
    }
    openMessage();
    answerText += frag;
    emit(sse('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: msgId,
      output_index: messageIndex,
      content_index: 0,
      delta: frag,
    }));
  };

  const closeMessage = () => {
    if (!messageOpened || messageClosed) return;
    messageClosed = true;
    emit(sse('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: msgId,
      output_index: messageIndex,
      content_index: 0,
      text: answerText,
    }));
    emit(sse('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: msgId,
      output_index: messageIndex,
      content_index: 0,
      part: { type: 'output_text', text: answerText, annotations: [] },
    }));
    emit(sse('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: messageIndex,
      item: { type: 'message', id: msgId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: answerText, annotations: [] }] },
    }));
  };

  /**
   * Flush every buffered tool call as an atomic added → delta → done sequence
   * (opencodex `openai-chat.ts:326-334` + `bridge.ts:341-344`). Two guards live here:
   *  - a call the provider never gave an id gets a synthesized `call_N`. When codex
   *    replays the call next turn, `sanitize.ts` drops any `tool_calls` entry whose
   *    id is `''` AND the orphan `role:"tool"` result that referenced it — so the
   *    model silently loses the call and its output for the rest of the session;
   *  - empty arguments serialize as `"{}"`, never `""`. `to-chat.ts:131` replays the
   *    string verbatim, and a no-arg tool echoed back as `arguments: ""` is what
   *    opencodex saw 400 a whole turn on `JSON.parse("")`.
  *
   * P6.159 — **live tool-input streaming is NOT DELIVERED on codex, and this
   * buffer is the nearer of the two reasons.** The far one is structural: the
   * app-server protocol (`codex-protocol/generated/ServerNotification.ts`)
   * declares ten delta families and none of them is a tool-call-argument delta,
   * so the binary cannot forward one however it arrives. This one is ours —
   * every argument fragment the upstream sends is accumulated into `acc.args`
   * and emitted as ONE delta at flush.
   *
   * Not delivered, not impossible. The unbuilt alternative, recorded so the next
   * reader of this function meets the decision rather than the silence: an
   * `onToolArgsDelta` sink beside the host-supplied sinks in `server.ts`
   * (`onUpstreamAuth`, `onFieldNegotiation`, `onRetryRung`), plus emitting a
   * delta per fragment here instead of one at flush. Its OPEN RISK is why it
   * stops at this comment: nothing at HEAD proves `acc.id` / `fc_<call_id>`
   * correlates with the tool id the app-server later reports in `item/started`,
   * so a sink wired on that assumption can draw a card that nothing closes. Pi
   * and claude deliver the same capability since P6.158.
   */
  const flushToolCalls = () => {
    for (const acc of pendingToolCalls) {
      if (!acc.id) acc.id = `call_${++toolCallSeq}`;
      const argsStr = acc.args || '{}';
      const itemId = `fc_${acc.id}`;
      const outputIndex = nextOutputIndex++;
      const item = (args: string, status: string) => ({
        type: 'function_call', id: itemId, call_id: acc.id, name: acc.name, ...nsFor(acc.name), arguments: args, status,
      });
      emit(sse('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: item('', 'in_progress'),
      }));
      if (acc.args.length > 0) {
        emit(sse('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: itemId,
          output_index: outputIndex,
          delta: acc.args,
        }));
      }
      emit(sse('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: itemId,
        output_index: outputIndex,
        arguments: argsStr,
      }));
      emit(sse('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: item(argsStr, 'completed'),
      }));
    }
    pendingToolCalls.length = 0;
  };

  let splitterFlushed = false;
  /**
   * Flush the `<think>` splitter's tail, then close every open item, in the order the
   * Responses wire expects. EVERY terminal path goes through here — completed, failed,
   * incomplete and the stall watchdog alike.
   *
   * The splitter withholds text it cannot yet prove is not the start of a `<think>`
   * opener (`push('start')` returns nothing; `flush()` returns `'start'`), so a path
   * that closed the items without flushing would drop the turn's text outright. The
   * stall path did exactly that until the test asserting "the partial text still
   * reached the client" caught it.
   */
  const closeOpenItems = () => {
    if (!splitterFlushed) {
      splitterFlushed = true;
      const tail = splitter.flush();
      routeReasoning(tail.reasoning);
      routeAnswer(tail.answer);
    }
    if (reasoningOpened) {
      closeReasoning(reasoningText);
      reasoningOpened = false;
    }
    closeMessage();
    flushToolCalls();
  };

  const responseBase = (status: string) => ({ id: responseId, object: 'response', status, model });

  // Re-arm the client's idle timer during upstream silence with a parser-ignored
  // heartbeat, and abandon the turn once the silence exceeds the stall budget
  // (opencodex `bridge.ts:182-211`). The tick is skipped whenever a real frame went
  // out since the last one, so it only fires on a genuine stall.
  const heartbeatMs = Math.max(1, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  // Local change: opencodex clamps the stall budget to >= 1 s; the floor is an epsilon
  // here so a test can drive the watchdog without a multi-second wait.
  const stallSec = Math.max(0.01, opts.stallTimeoutSec ?? DEFAULT_STALL_TIMEOUT_SEC);
  const maxStallTicks = Math.ceil((stallSec * 1000) / heartbeatMs);
  let stallTicks = 0;
  let stalled = false;
  const beat: ReturnType<typeof setInterval> = setInterval(() => {
    if (terminated) return;
    if (activity) { activity = false; stallTicks = 0; return; }
    if (++stallTicks < maxStallTicks) {
      // Deliberately NOT through `emit`: a keepalive must not count as activity.
      write(sse('response.heartbeat', { type: 'response.heartbeat' }));
      return;
    }
    stalled = true;
    closeOpenItems();
    emit(sse('response.incomplete', {
      type: 'response.incomplete',
      response: {
        ...responseBase('incomplete'),
        incomplete_details: { reason: 'upstream_stall_timeout' },
        usage: mapUsage(usage),
      },
    }));
    terminated = true;
    emitDone();
    // Stop ticking the moment the turn is over (opencodex `bridge.ts:204-205`). The
    // `finally` below is the catch-all; this keeps a slow-to-unwind source from
    // getting further no-op ticks in the meantime.
    clearInterval(beat);
    onStall?.();
  }, heartbeatMs);

  /** The upstream error envelope that ended the turn, if any. */
  let failure: { message?: string | null } | undefined;

  try {
    for await (const chunk of chunks) {
      if (stalled) break; // the watchdog already terminated the turn
      // A terminal error envelope — inline from a 200 stream, or synthesized by
      // `parseChatSse` at an EOF with no terminal signal.
      if (chunk.error) { failure = chunk.error; break; }
      if (chunk.done) { sawGracefulClose = true; continue; }
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      // Read the finish reason BEFORE the delta guard: the terminating chunk
      // usually carries `finish_reason` with an empty or absent delta.
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      if (!delta) continue;

      // Split-field reasoning (if the gateway uses it).
      const splitReasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof splitReasoning === 'string') routeReasoning(splitReasoning);

      // Content: run through the <think> splitter → reasoning + answer.
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        const { reasoning, answer } = splitter.push(delta.content);
        routeReasoning(reasoning);
        routeAnswer(answer);
      }

      // Tool calls: accumulate by index (never by id), emitted only at the flush.
      for (const tc of delta.tool_calls ?? []) {
        const idx = typeof tc.index === 'number' ? tc.index : lastToolIndex >= 0 ? lastToolIndex : 0;
        let acc = pendingToolCalls.find((c) => c.index === idx);
        if (!acc) {
          acc = { index: idx, id: '', name: '', args: '' };
          pendingToolCalls.push(acc);
          lastToolIndex = idx;
        }
        if (typeof tc.id === 'string' && tc.id) acc.id = tc.id;
        if (typeof tc.function?.name === 'string' && tc.function.name) acc.name = tc.function.name;
        const argFrag = tc.function?.arguments;
        if (typeof argFrag === 'string' && argFrag.length > 0) acc.args += argFrag;
      }
    }
  } finally {
    // Every exit path — return, break, throw — clears the timer. A leaked interval
    // keeps the process (and the test runner) alive.
    clearInterval(beat);
  }

  if (stalled) return;

  closeOpenItems();

  // An upstream failure terminates with `response.failed` carrying a `last_error`
  // classified into the taxonomy codex-rs acts on (`server_is_overloaded` gets
  // retry-after backoff; `context_length_exceeded` gets a compaction path). Reported
  // as `response.completed`, a cut stream is indistinguishable from a finished turn.
  if (failure) {
    const classified = adapterFailureFromMessage(
      typeof failure.message === 'string' && failure.message ? failure.message : 'upstream error',
    );
    // `status` is a local addition to the vendored payload: the Anthropic consumer
    // (`anthropic/outbound.ts` case "response.failed") reads `response.error.status`
    // to shape the client-visible error, and defaults to 500 without it.
    const error = { ...classified.error, status: classified.httpStatus };
    emit(sse('response.failed', {
      type: 'response.failed',
      response: {
        ...responseBase('failed'),
        ...(usage ? { usage: mapUsage(usage) } : {}),
        error,
        last_error: error,
      },
    }));
    terminated = true;
    emitDone();
    return;
  }

  // A truncated turn MAY terminate with `response.incomplete` instead of
  // `response.completed` — that is what the real Responses API emits when the
  // output token budget runs out, and it is the ONLY frame the Anthropic
  // outbound translation maps to `stop_reason: "max_tokens"` (it keys off
  // `response.incomplete_details.reason === "max_output_tokens"`; see
  // `anthropic/outbound.ts`). Reported without it, a cut-off answer looks to
  // the client like a completed one.
  //
  // Opt-in per route (see `TruncationFrame`): the codex path keeps
  // `response.completed`, because for its consumer a stream that never reaches
  // that frame reads as a stream error. This gate governs `finish_reason: "length"`
  // ONLY — the failed/stalled/EOF frames above and below are ungated, because they
  // are what codex-rs itself expects for those conditions.
  if (finishReason === 'length' && truncationFrame === 'incomplete') {
    emit(sse('response.incomplete', {
      type: 'response.incomplete',
      response: {
        ...responseBase('incomplete'),
        incomplete_details: { reason: 'max_output_tokens' },
        usage: mapUsage(usage),
      },
    }));
    terminated = true;
    emitDone();
    return;
  }

  // The chunk source ended with no terminal signal of any kind. Through
  // `parseChatSse` this is unreachable (it synthesizes the error envelope handled
  // above); it is the belt-and-braces for a direct-iterable caller, and it marks the
  // turn incomplete rather than completed so a truncation is never reported as clean.
  if (!sawGracefulClose && finishReason === undefined && usage === undefined) {
    emit(sse('response.incomplete', {
      type: 'response.incomplete',
      response: {
        ...responseBase('incomplete'),
        incomplete_details: { reason: 'adapter_eof' },
        usage: mapUsage(usage),
      },
    }));
    terminated = true;
    emitDone();
    return;
  }

  emit(sse('response.completed', {
    type: 'response.completed',
    response: { ...responseBase('completed'), usage: mapUsage(usage) },
  }));
  terminated = true;
  emitDone();
}

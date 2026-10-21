/**
 * Non-streaming Nestor chat JSON → a Responses response object with `output[]`.
 *
 * Reasoning is SURFACED as a `reasoning` output item (from `reasoning_content`/
 * `reasoning` if present, else the inline `<think>` span), never placed in
 * `output_text`, never dropped. Tool calls come only from the answer/content.
 * Malformed tool `arguments` are passed through raw (codex surfaces the parse
 * error; the adapter does not guess). `matched_stop` is ignored.
 */
import { extractReasoning } from '../../shared/src/llm/think-splitter.ts';

interface ChatToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface ChatMessageOut {
  content?: unknown;
  reasoning_content?: unknown;
  reasoning?: unknown;
  tool_calls?: ChatToolCall[];
}
export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  /**
   * OpenAI's nested cache detail. `cached_tokens` is the READ count; its
   * creation counterpart is spelled `cache_write_tokens` here, not
   * `cache_creation_tokens` — see `CACHED-TOKEN CONTRACT` on `mapUsage`.
   */
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  /** DeepSeek's flat spelling of the same read count. */
  prompt_cache_hit_tokens?: number;
  /** A third flat spelling, the bare name at the top level. */
  cached_tokens?: number;
}
export interface ChatJson {
  choices?: Array<{ message?: ChatMessageOut; finish_reason?: string }>;
  usage?: ChatUsage;
}

/** The Responses-shaped usage object every frame of this adapter carries. */
export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /**
   * Present only when the upstream published at least one cache figure. Its
   * absence means "the upstream said nothing", which is not the same claim as
   * a zero — although `anthropicUsage` collapses both to `0` downstream.
   */
  input_tokens_details?: { cached_tokens: number; cache_write_tokens: number };
}

/**
 * A count the wire may spell as anything. `undefined` for anything that is not a
 * finite count, so a junk field falls through to the next spelling instead of
 * poisoning the arithmetic — `anthropicUsage` subtracts these, and a `NaN` there
 * would reach the renderer as a `NaN` token figure.
 */
function finiteCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Nestor usage → Responses usage. `reasoning_tokens` is telemetry-only (not surfaced).
 *
 * CACHED-TOKEN CONTRACT (D1.330). This function is the ONLY chokepoint between the
 * gateway's chat-completions usage and every frame this adapter emits, on BOTH front
 * doors — so until now it was also the only reason the claude card reported no cache
 * accounting at all. Downstream, `anthropicUsage` (`./anthropic/outbound.ts`) reads
 * `input_tokens_details.cached_tokens` / `.cache_write_tokens` and turns them into the
 * Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens` the Claude Agent
 * SDK carries in `message_delta.usage`, which the host's claude event adapter already
 * reads into `tokenUsage.cacheReadTokens` and `cache.warmth`. This function published
 * neither field, so that whole chain answered `0 / 0 / unknown` — measured on the
 * packaged 1.40.0 by CDP case `RS-72`, where a Pi session on the SAME gateway model in
 * the SAME profile read `8192` cached tokens and `warm`.
 *
 * WHICH FIELDS, and WHY these three. The gateway is not documented at this level, and
 * `RS-72` captured only the app's derived figures, not the upstream usage object — so
 * the contract is taken from the READER that demonstrably answered non-zero against
 * this very gateway: Pi's own `parseChunkUsage`, in the vendored
 * `@earendil-works/pi-coding-agent` 0.84.4 (`dist/bundle/chunks/openai-completions-*.js`).
 * It reads the cache-READ count as `prompt_tokens_details.cached_tokens`, falling back
 * to `prompt_cache_hit_tokens` and then to a bare top-level `cached_tokens`, and the
 * cache-WRITE count as `prompt_tokens_details.cache_write_tokens` only. The precedence
 * is mirrored exactly, including that an explicit `0` in an earlier spelling wins over
 * a later one. DeepSeek's `prompt_cache_miss_tokens` is deliberately NOT read: Pi does
 * not read it either (0 occurrences in the same chunk, against 1 for the hit counter),
 * and it is a miss count, not a creation count — forwarding it as
 * `cache_creation_input_tokens` would invent a write the upstream never claimed.
 *
 * WHICH DIRECTION for `input_tokens`. Unchanged, and deliberately: chat-completions
 * `prompt_tokens` is the WHOLE input INCLUDING the cached share, and Responses
 * `input_tokens` is inclusive too, so the two line up as they already did. The
 * subtraction to the Anthropic convention (where `input_tokens` EXCLUDES both cache
 * figures) happens once, in `anthropicUsage`, which is also where Pi does it
 * (`input = max(0, prompt_tokens - cacheRead - cacheWrite)`). Doing it here as well
 * would subtract twice.
 *
 * The codex `/v1/responses` front door reads the same object, so a gateway that
 * publishes cache figures now surfaces them on the codex card too — codex's own
 * `cached_input_tokens` breakdown is fed from this field, and the host already
 * subtracts it from the whole input (`backend/codex/event-adapter.ts`).
 */
export function mapUsage(usage: ChatUsage | undefined): ResponsesUsage {
  const details = usage?.prompt_tokens_details;
  const cachedRead = finiteCount(details?.cached_tokens)
    ?? finiteCount(usage?.prompt_cache_hit_tokens)
    ?? finiteCount(usage?.cached_tokens);
  const cacheWrite = finiteCount(details?.cache_write_tokens);
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? 0,
    ...(cachedRead !== undefined || cacheWrite !== undefined
      ? { input_tokens_details: { cached_tokens: cachedRead ?? 0, cache_write_tokens: cacheWrite ?? 0 } }
      : {}),
  };
}

/** Separate reasoning from the answer for a full (non-stream) message. */
export function splitReasoning(message: ChatMessageOut): { reasoning: string; answer: string } {
  const content = typeof message.content === 'string' ? message.content : '';
  if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
    return { reasoning: message.reasoning_content, answer: content };
  }
  if (typeof message.reasoning === 'string' && message.reasoning) {
    return { reasoning: message.reasoning, answer: content };
  }
  return extractReasoning(content);
}

export interface ResponsesResponseObject {
  id: string;
  object: 'response';
  status: 'completed';
  model: string;
  output: unknown[];
  usage: ResponsesUsage;
}

export function toResponsesResponse(chat: ChatJson, opts: { model: string; responseId: string; toolNamespaces?: Record<string, string> }): ResponsesResponseObject {
  const { model, responseId, toolNamespaces } = opts;
  const message = chat.choices?.[0]?.message ?? {};
  const { reasoning, answer } = splitReasoning(message);

  const output: unknown[] = [];

  if (reasoning) {
    output.push({
      type: 'reasoning',
      id: `reasoning_${responseId}`,
      summary: [],
      content: [{ type: 'reasoning_text', text: reasoning }],
    });
  }

  if (answer.trim().length > 0) {
    output.push({
      type: 'message',
      id: `msg_${responseId}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: answer, annotations: [] }],
    });
  }

  for (const tc of message.tool_calls ?? []) {
    const callId = typeof tc.id === 'string' ? tc.id : '';
    const name = tc.function?.name ?? '';
    const ns = toolNamespaces?.[name];
    output.push({
      type: 'function_call',
      id: `fc_${callId || responseId}`,
      call_id: callId,
      name,
      ...(ns ? { namespace: ns } : {}),
      // Pass arguments through raw (may be malformed JSON — codex decides).
      arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : '',
      status: 'completed',
    });
  }

  return {
    id: responseId,
    object: 'response',
    status: 'completed',
    model,
    output,
    usage: mapUsage(chat.usage),
  };
}

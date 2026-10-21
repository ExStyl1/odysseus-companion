/**
 * Maps the Responses request body Codex sends → an OpenAI Chat Completions body
 * for the Nestor gateway.
 *
 * Item shapes are the ones observed from the real app-server (Phase 1 capture)
 * and the generated Responses types: `input[]` carries `message`,
 * `function_call`, and `function_call_output` items; `tools[]` is the Responses
 * function-tool shape (name/description/parameters at the top level), which Chat
 * nests under `function`.
 *
 * Hard rules (00-context): NEVER emit `tool_choice`; never send
 * `chat_template_kwargs`/`enable_thinking` (we consume the API, we don't mutate
 * server behavior); never send `temperature: 0` (Qwen greedy-decode
 * degradation).
 */
import { sanitizeOpenAiHistoryInPlace, type ChatMessage } from './sanitize.ts';

interface ResponsesContentPart {
  type?: string;
  /** `input_text` / `output_text`. */
  text?: string;
  /**
   * `input_image`. Codex serializes `ContentItem::InputImage { image_url, detail }`
   * with `#[serde(tag = "type", rename_all = "snake_case")]`
   * (openai/codex @ `rust-v0.150.1`, `codex-rs/protocol/src/models.rs`, the
   * `ContentItem::InputImage` variant), so a
   * local attachment arrives as a data URL here, framed by two `input_text` parts
   * (`local_image_content_items`, same file :1646). Until P3.114 this type had no
   * image member and the flattener kept only string `text` — the picture was
   * dropped between codex's frame tags and nothing was said anywhere.
   */
  image_url?: string;
  /** Codex `ImageDetail`: auto | low | high | original (models.rs:785). */
  detail?: string;
  /** `input_audio` — `ContentItem::InputAudio { audio_url }`. No chat equivalent. */
  audio_url?: string;
}
interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: string | ResponsesContentPart[];
  // function_call
  name?: string;
  arguments?: string;
  call_id?: string;
  // function_call_output
  output?: unknown;
}
interface ResponsesTool {
  type?: string;
  name?: string;
  description?: string;
  parameters?: unknown;
  function?: { name?: string; description?: string; parameters?: unknown };
  /** Namespace tools (e.g. codex `multi_agent_v1`) bundle sub-tools here. */
  tools?: ResponsesTool[];
}
export interface ResponsesRequest {
  model?: string;
  instructions?: string;
  input?: ResponsesInputItem[];
  tools?: ResponsesTool[];
  temperature?: number;
  top_p?: number;
  /** Responses' output cap. Sent by Codex, and by the Anthropic inbound translation (from `max_tokens`). */
  max_output_tokens?: number;
  /**
   * Responses' reasoning controls. **Present on every request from both inbound
   * paths**, measured rather than assumed:
   *
   *  - **Codex** — `codex-rs/core/src/client.rs::build_responses_request` sets
   *    `reasoning: Some(reasoning)` unconditionally (openai/codex @
   *    `rust-v0.148.0`), and `build_reasoning` fills `effort` from the config's
   *    `model_reasoning_effort` (or the model's `default_reasoning_level`),
   *    rewriting only `Ultra -> Max`. DRIVEN on the shipped
   *    `darwin-arm64/codex-app-server` against a capture stub, 2026-09-03:
   *    `model_reasoning_effort = "xhigh"` -> `{"effort":"xhigh","summary":"auto"}`,
   *    `"none"` -> `{"effort":"none","summary":"auto"}`, and the CONTROL with the
   *    key absent -> `{"summary":"auto"}` with no `effort` member at all. That
   *    control is why the forward below is conditional on presence.
   *  - **Anthropic inbound** — `anthropic/inbound.ts` sets it from
   *    `output_config.effort` (Claude Code's `/effort`) or from
   *    `thinking.budget_tokens`, and omits it for `thinking:{type:"disabled"}`.
   *
   * `summary` and `context` have no Chat Completions equivalent and are not
   * carried; the chat wire returns its reasoning as `reasoning_content`
   * regardless (see `from-chat.ts`).
   */
  reasoning?: { effort?: unknown; summary?: unknown; context?: unknown };
  stream?: boolean;
  [k: string]: unknown;
}

/**
 * OpenAI Chat Completions multimodal content parts. A message's `content` is a
 * plain string whenever it is text-only (every pre-P3.114 request keeps its exact
 * shape) and this array only when it actually carries a non-text part.
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: unknown } }>;
  temperature: number;
  top_p: number;
  /** Chat Completions' output cap. Omitted entirely when the caller set none. */
  max_tokens?: number;
  /**
   * Chat Completions' reasoning control, carried VERBATIM from the Responses
   * body's `reasoning.effort`. Omitted entirely when the caller set none.
   *
   * Typed as `string`, not as a closed union, on purpose: the accepted set is a
   * PER-BACK-END contract (P3.88) and no single enum is right for every
   * upstream this adapter serves. {@link toChatRequest} records the one set
   * measured so far — the Nessy Gateway's, which the endpoint states itself in
   * its own 400.
   */
  reasoning_effort?: string;
  stream: boolean;
}

/**
 * `detail` values the Chat Completions image part defines. Codex's `ImageDetail`
 * adds `original`, which is not one of them, so it is dropped and the server's
 * own default decides — forwarding an unknown enum value is how a shape-fragile
 * gateway 400s on a field it would otherwise have ignored.
 */
const CHAT_IMAGE_DETAILS = new Set(['auto', 'low', 'high']);

/** Marker for a part we recognize and cannot carry — never a silent drop. */
const UNSUPPORTED_AUDIO = '[audio attachment omitted: the chat-completions API has no audio content part]';

function toImagePart(part: ResponsesContentPart): ChatContentPart | null {
  if (typeof part.image_url !== 'string' || part.image_url.length === 0) return null;
  const image_url: { url: string; detail?: string } = { url: part.image_url };
  if (typeof part.detail === 'string' && CHAT_IMAGE_DETAILS.has(part.detail)) {
    image_url.detail = part.detail;
  }
  return { type: 'image_url', image_url };
}

/**
 * Responses message content (string, or an array of content parts) → chat content.
 *
 * Text-only input returns the joined string, byte-identical to the pre-P3.114
 * flattener, so no existing request changes shape. An `input_image` part is
 * translated to the standard chat `image_url` part and the message becomes an
 * array — MEASURED against the Nessy gateway 2026-08-28: it parses that part
 * (its 400 names it, "Invalid Chat Message Part: Model Does Not Support Image
 * Inputs") while a text-part array returns 200, so the shape is right and only
 * the served model's capability is the blocker. Forwarding it is therefore a
 * VISIBLE endpoint refusal on the gateway and a working image on a BYO
 * `openai-compatible` upstream whose model has vision — both better than the
 * silent drop this replaces.
 */
function toChatContent(content: string | ResponsesContentPart[] | undefined): string | ChatContentPart[] {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: ChatContentPart[] = [];
  let hasNonText = false;
  for (const part of content) {
    const image = toImagePart(part);
    if (image) {
      parts.push(image);
      hasNonText = true;
      continue;
    }
    if (typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
      continue;
    }
    if (typeof part.audio_url === 'string') {
      parts.push({ type: 'text', text: UNSUPPORTED_AUDIO });
      continue;
    }
    // `encrypted_content` (a FunctionCallOutputContentItem member) is opaque
    // provider-internal state for the Responses API, not user content: it cannot
    // be replayed to a chat endpoint and its absence is not a loss. Anything else
    // unrecognized is skipped the way it always was.
  }
  if (!hasNonText) {
    return parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  }
  // Empty text parts are dropped only on the multimodal branch: some endpoints
  // reject a zero-length text part, and the joined string above never had them.
  return parts.filter((p) => p.type !== 'text' || p.text.length > 0);
}

/** Content-item types a `function_call_output` array may carry (models.rs:1913). */
const OUTPUT_CONTENT_ITEM_TYPES = new Set(['input_text', 'output_text', 'input_image', 'input_audio', 'encrypted_content']);

function isOutputContentItem(value: unknown): value is ResponsesContentPart {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && OUTPUT_CONTENT_ITEM_TYPES.has(type);
}

/**
 * `function_call_output.output` is EITHER a bare string OR an array of
 * `FunctionCallOutputContentItem` — codex's hand-written
 * `impl Serialize for FunctionCallOutputPayload` (models.rs:2065) emits one or
 * the other, and the array is how `view_image` hands back a picture. Before
 * P3.114 that array was `JSON.stringify`d whole into the tool message, so a
 * screenshot reached the model as several hundred kilobytes of base64 QUOTED AS
 * PROSE: not a drop, a corruption, and the mechanism P3.116 depends on. Any
 * other non-string output keeps the historical JSON encoding.
 */
function toToolContent(output: unknown): string | ChatContentPart[] {
  if (typeof output === 'string') return output;
  if (Array.isArray(output) && output.length > 0 && output.every(isOutputContentItem)) {
    return toChatContent(output);
  }
  return JSON.stringify(output ?? '');
}

/** Codex uses a `developer` role; fold it into `system` for the chat API. */
function mapRole(role: string | undefined): string {
  if (role === 'developer') return 'system';
  return role ?? 'user';
}

/**
 * DA1.22 - what the MODEL'S OWN CATALOGUE recommends for this model.
 *
 * Declared here rather than imported because this package is the dependency
 * ROOT of the pair: `@nessy-agent/shared` depends on it and never the reverse
 * (`home-latch.ts`), so the host resolves the values and hands them down, the
 * same doctrine {@link ResponsesRequest}'s siblings already follow. The shared
 * side's `resolveModelGenerationDefaults` (`config/llm-connections.ts`) is the
 * only producer today; it reads what `model-fetchers/nestor.ts` wrote off the
 * gateway's `/cli/models` rows.
 */
export interface ModelGenerationDefaults {
  /** The catalogue's recommended reasoning effort. A DEFAULT, never an override. */
  reasoningEffort?: string;
  /** The catalogue's published sampling parameters, verbatim. */
  samplingParams?: Record<string, unknown>;
}

/**
 * DA1.22 - keys a published `sampling_params` object may NOT set on the wire.
 *
 * Two groups, and neither is an allowlist of what the gateway is allowed to
 * recommend - it is the list of slots this translator already owns:
 *
 *  - every named {@link ChatRequest} field. `temperature` and `top_p` have their
 *    own precedence below (caller, then catalogue, then this file's fallback);
 *    `reasoning_effort` has its own, and letting a sampling key set it would
 *    route round the default-only rule that keeps a user's chosen effort - and a
 *    user's chosen OFF - intact.
 *  - the two names the module header forbids outright (`chat_template_kwargs`,
 *    `enable_thinking`): we consume this API, we do not mutate server behaviour.
 *
 * Everything else rides verbatim, which is the point: `top_k` is published on the
 * `fast` row and reaches the gateway by NO other route (`anthropic/inbound.ts`
 * accepts and drops it for want of a Responses equivalent), and an allowlist here
 * would silently drop the next key the catalogue grows.
 */
const SAMPLING_KEYS_THIS_TRANSLATOR_OWNS: ReadonlySet<string> = new Set([
  'model', 'messages', 'stream', 'tools', 'temperature', 'top_p', 'max_tokens',
  'reasoning_effort', 'chat_template_kwargs', 'enable_thinking',
]);

export function toChatRequest(
  body: ResponsesRequest,
  /**
   * DA1.22 - resolved per REQUEST, by the model id actually being sent, because
   * one connection can hold many models and each publishes its own row.
   * Omitting it is what every pre-DA1.22 caller and every test gets: the
   * invented `0.7`/`0.8` fallback and no effort default at all.
   */
  generationDefaultsForModel?: (model: string) => ModelGenerationDefaults | undefined,
): ChatRequest {
  const messages: ChatMessage[] = [];

  // Nestor/Qwen requires a SINGLE system message at the beginning. Codex sends
  // `instructions` (system) plus leading `developer`-role input items (also
  // system-like), which would produce multiple system messages → gateway 400
  // "System message must be at the beginning". Collapse the leading system/
  // developer run into one system message; map any later developer → user.
  const systemParts: string[] = [];
  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    systemParts.push(body.instructions);
  }
  let leadingSystem = true;

  const flushSystem = () => {
    if (systemParts.length > 0) {
      messages.push({ role: 'system', content: systemParts.join('\n\n') });
      systemParts.length = 0;
    }
  };

  for (const item of body.input ?? []) {
    switch (item.type) {
      case 'message': {
        const role = mapRole(item.role);
        const content = toChatContent(item.content);
        // The system block is one joined STRING, so a system/developer item that
        // carries an image cannot merge into it. Rather than drop the image to
        // keep the merge, fall through: the item leaves the leading block and is
        // demoted to `user` below, image intact.
        if (leadingSystem && role === 'system' && typeof content === 'string') {
          // still in the leading system block — merge in
          systemParts.push(content);
          break;
        }
        flushSystem();
        leadingSystem = false;
        // A `developer`/system message after content started is not allowed
        // mid-stream — demote it to `user`.
        messages.push({ role: role === 'system' ? 'user' : role, content });
        break;
      }
      case 'function_call':
        flushSystem();
        leadingSystem = false;
        // arguments stays a JSON string (OpenAI shape); one assistant message
        // per call preserves the input ordering (call, then its output).
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: item.call_id ?? '',
              type: 'function',
              function: { name: item.name ?? '', arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) },
            },
          ],
        });
        break;
      case 'function_call_output':
        flushSystem();
        leadingSystem = false;
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id ?? '',
          content: toToolContent(item.output),
        });
        break;
      default:
        // reasoning items and other input types are not replayed to the chat API.
        //
        // P6.481 — THE DROP IS THIS LEG'S, not codex's, and the difference
        // decides where a fix belongs. Measured at HEAD against the pinned
        // schema: `thread/inject_items` accepts a reasoning item with nothing to
        // enable — `ReasoningResponseItem` is `"required": ["summary","type"]`
        // with `"encrypted_content": {"type": ["string","null"]}` and a nullable
        // `content` of `ReasoningItemContent` (`schema/ClientRequest.json`,
        // `generated/ReasoningItemContent.ts`), so the ATTESTATION is optional
        // and the reasoning TEXT is plain. A codex thread on a NATIVE Responses
        // upstream therefore carries reasoning across a switch; a thread on the
        // gateway leg loses it HERE, because chat-completions has no slot to
        // translate it into and inventing one would be a request class the
        // gateway never agreed to. So the switch line for reasoning is
        // per-MODEL, not per-runtime — the shape P3.280 already had to adopt for
        // images — and this branch is the reason the gateway half of that line
        // says "dropped".
        break;
    }
  }

  // All input was leading system/developer (or empty) — flush the system block.
  flushSystem();

  const tools = (body.tools ?? [])
    .flatMap((t) => {
      // Namespace tools (codex multi_agent_v1) bundle sub-tools: flatten them so
      // a chat-completions model can call each one; from-chat re-attaches the
      // `namespace` field on the resulting function_call (see extractToolNamespaces).
      if (t.type === 'namespace' && Array.isArray(t.tools)) return t.tools;
      return [t];
    })
    .map((t) => {
      // Responses puts name/desc/params at top level; a few clients nest under `function`.
      // Hosted server-side tools (type "web_search" etc.) carry no name and are
      // dropped — they execute on OpenAI's backend, not on our gateway.
      const name = t.name ?? t.function?.name;
      if (!name) return null;
      return {
        type: 'function' as const,
        function: {
          name,
          description: t.description ?? t.function?.description,
          parameters: t.parameters ?? t.function?.parameters,
        },
      };
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

  // DA1.22 - the model's own published generation config, if the host supplied a
  // resolver and this model's catalogue row carried one.
  const generationDefaults = generationDefaultsForModel?.(body.model ?? '');
  const published = generationDefaults?.samplingParams ?? {};
  const publishedPositiveNumber = (key: string): number | undefined => {
    const value = published[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };

  // Sampling, THREE tiers since DA1.22: the caller's own value, then the value
  // this model's catalogue row publishes, then the invented fallback that used to
  // be the only tier. The fallback is `fast`'s published pair by coincidence of
  // history - it was hand-typed as "Qwen coding defaults" and happened to match
  // one row - which is exactly why the catalogue tier is worth having: the
  // default `coder` row publishes `temperature: 1, top_p: 0.95` and got 0.7/0.8.
  //
  // `> 0` on both caller and catalogue temperature: the module header's hard rule
  // is that a `temperature: 0` NEVER goes on this wire (Qwen greedy-decode
  // degradation), and a catalogue is no more allowed to set it than a caller is.
  const publishedTemperature = publishedPositiveNumber('temperature');
  const temperature = typeof body.temperature === 'number' && body.temperature > 0
    ? body.temperature
    : (publishedTemperature !== undefined && publishedTemperature > 0 ? publishedTemperature : 0.7);
  const top_p = typeof body.top_p === 'number' ? body.top_p : (publishedPositiveNumber('top_p') ?? 0.8);

  const chat: ChatRequest = {
    model: body.model ?? '',
    messages,
    temperature,
    top_p,
    stream: body.stream === true,
    // NOTE: tool_choice is intentionally NEVER set (gateway 400s on its presence).
  };
  // DA1.22 - every OTHER key the catalogue published, verbatim. Written through
  // an index cast rather than a spread in the literal above because `ChatRequest`
  // is a closed interface and must stay one: these keys are the gateway's own
  // recommendation for its own model, not a shape this adapter models. Assigned
  // AFTER the named fields and BEFORE `tools`/`max_tokens`/`reasoning_effort`, so
  // no published key can reach a slot this translator owns - see
  // {@link SAMPLING_KEYS_THIS_TRANSLATOR_OWNS}, which is belt to that braces.
  for (const [key, value] of Object.entries(published)) {
    if (SAMPLING_KEYS_THIS_TRANSLATOR_OWNS.has(key) || value === undefined) continue;
    (chat as unknown as Record<string, unknown>)[key] = value;
  }
  if (tools.length > 0) chat.tools = tools;
  // Output cap: Responses `max_output_tokens` → Chat Completions `max_tokens`.
  // Both Codex and the Anthropic inbound translation send it, and it was being
  // dropped on the floor — a client's explicit cap was silently ignored and the
  // gateway's own ceiling decided every turn's length instead. `max_tokens` is a
  // standard Chat Completions field; the gateway's known shape-fragility is
  // confined to `tool_choice` and tool-schema field combos, and it ignores
  // fields it does not recognize. Only forwarded when positive, so a caller that
  // sets none still gets the server default.
  if (typeof body.max_output_tokens === 'number' && body.max_output_tokens > 0) {
    chat.max_tokens = body.max_output_tokens;
  }
  // P3.265 · Reasoning effort: Responses `reasoning.effort` -> Chat Completions
  // `reasoning_effort`. Until this line the user's chosen thinking level reached
  // the codex config, the codex runtime and this adapter, and NEVER the model —
  // a control that was present, configured, and did nothing on every codex turn.
  //
  // MEASURED against the Nessy gateway 2026-09-03, four arms on
  // `tgpt/qwen35-397b-a17b-fp8`, `max_tokens: 300`:
  //
  //   no field           200, `<think>` present, 300 completion tokens
  //   "none"             200, NO `<think>`, 2 completion tokens, and the message
  //                      gains a `reasoning_content` key — it is HONOURED, not
  //                      merely tolerated
  //   "minimal"/"high"   200, `<think>` present
  //   "zzz-not-a-level"  400 `literal_error` naming the field and the set
  //                      `literal['none','minimal','low','medium','high','xhigh','max']`
  //
  // The last arm is what makes the first three meaningful: a control arm with an
  // invented key (`nessy_bogus_field_xyz`) returned 200, so this endpoint ignores
  // fields it does not know and a 200 alone would have proved nothing.
  //
  // CARRIED VERBATIM, and the value is deliberately not validated here. The
  // accepted set is per-back-end: the gateway's seven above; OpenAI's own chat
  // API publishes a narrower one; a BYO `openai-compatible` upstream may publish
  // another. Narrowing to any of them would be authoring a policy this adapter
  // cannot know — so an unaccepted value earns the endpoint's own named refusal,
  // which P3.127's pins already carry back verbatim as a 400 rather than a
  // generic 502. The one value known to land there today is `ultra`, which
  // `anthropic/inbound.ts` accepts from Claude Code's `/effort` and the gateway's
  // literal set omits; codex itself cannot send it (its
  // `reasoning_effort_for_request` rewrites `Ultra -> Max` before the request).
  if (typeof body.reasoning?.effort === 'string' && body.reasoning.effort.length > 0) {
    chat.reasoning_effort = body.reasoning.effort;
  } else if (
    typeof body.reasoning === 'object' && body.reasoning !== null
    && typeof generationDefaults?.reasoningEffort === 'string'
  ) {
    // DA1.22 - the catalogue's recommended effort, and the condition is the whole
    // safety argument. It applies ONLY where the caller sent a `reasoning` object
    // and named no level inside it - i.e. asked for reasoning and expressed no
    // preference. An ABSENT `reasoning` is left absent, because on the Anthropic
    // route absence is how `thinking: {type:"disabled"}` arrives
    // (`anthropic/inbound.ts` omits the whole block for it), and filling a
    // default in there would turn thinking ON for a user who turned it off.
    //
    // What that means per runtime, measured rather than assumed:
    //  - codex sends `reasoning` on EVERY request, and the shipped binary sends
    //    `{"summary":"auto"}` with no `effort` member when `model_reasoning_effort`
    //    is unset (driven against `darwin-arm64/codex-app-server`, 2026-09-03, the
    //    control arm recorded on `ResponsesRequest.reasoning`). So this is the
    //    ordinary case there, and it is the silent divergence DA1.16 went looking
    //    for: a gateway model whose row recommends an effort, on a runtime that
    //    named none.
    //  - the claude runtime derives an effort from the SDK's own thinking setting
    //    whenever thinking is on, so the first branch takes it; with thinking off
    //    there is no `reasoning` object and neither branch fires. Inert by
    //    construction there, and that is the honest outcome rather than a gap.
    chat.reasoning_effort = generationDefaults.reasoningEffort;
  }

  sanitizeOpenAiHistoryInPlace(chat);
  return chat;
}

/**
 * Sub-tool name → namespace name for every namespace-type tool in the request.
 * from-chat / from-chat-stream use it to stamp `namespace` back onto
 * function_call items so codex routes the call into the namespace toolset
 * (protocol: ResponseItem function_call has optional `namespace`).
 */
export function extractToolNamespaces(body: ResponsesRequest): Record<string, string> {
  const map: Record<string, string> = {};
  for (const t of body.tools ?? []) {
    if (t.type !== 'namespace' || typeof t.name !== 'string' || !Array.isArray(t.tools)) continue;
    for (const sub of t.tools) {
      const name = sub.name ?? sub.function?.name;
      if (name) map[name] = t.name;
    }
  }
  return map;
}

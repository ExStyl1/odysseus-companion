/**
 * DA1.22 — the catalogue's own generation config, applied as DEFAULTS.
 *
 * The owner's decision (2026-09-17) is to honour what the gateway publishes per
 * `/cli/models` row instead of the values this translator invented beside them.
 * The whole safety argument of that decision lives in the PRECEDENCE, so every
 * case below is a precedence case: the caller wins, then the catalogue, then the
 * pre-DA1.22 fallback — and an absent `reasoning` object stays absent, because
 * on the Anthropic route that is how a user's "thinking off" arrives.
 *
 * The fixture values are the ones WA-e measured live on 2026-09-13: the default
 * `coder` row publishes `{temperature: 1, top_p: 0.95}` and `reasoning:
 * {"effort":"low"}`, the `fast` row publishes `{temperature: 0.7, top_k: 20,
 * top_p: 0.8}` and no reasoning block.
 */
import { describe, expect, it } from 'bun:test';
import { toChatRequest, type ModelGenerationDefaults } from '../to-chat.ts';

const CODER = 'tgpt/deepseek-v4-flash-0731';
const FAST = 'tgpt/qwen36-35b-a3b-fp8';

const CATALOGUE: Record<string, ModelGenerationDefaults> = {
  [CODER]: { reasoningEffort: 'low', samplingParams: { temperature: 1, top_p: 0.95 } },
  [FAST]: { samplingParams: { temperature: 0.7, top_k: 20, top_p: 0.8 } },
};

const resolver = (model: string): ModelGenerationDefaults | undefined => CATALOGUE[model];

describe('toChatRequest — published sampling params (DA1.22)', () => {
  it('uses the row\'s own temperature and top_p instead of the invented pair', () => {
    const chat = toChatRequest({ model: CODER, input: [] }, resolver);
    expect(chat.temperature).toBe(1);
    expect(chat.top_p).toBe(0.95);
  });

  it('the caller\'s own values still win', () => {
    const chat = toChatRequest({ model: CODER, input: [], temperature: 0.2, top_p: 0.5 }, resolver);
    expect(chat.temperature).toBe(0.2);
    expect(chat.top_p).toBe(0.5);
  });

  /**
   * `top_k` is the load-bearing key: the gateway publishes it on the `fast` row
   * and it reaches the gateway by NO other route — `anthropic/inbound.ts`
   * accepts and drops it for want of a Responses equivalent, and `ChatRequest`
   * has no member for it. A reader that allowlisted temperature/top_p would pass
   * every other case in this file and still drop it.
   */
  it('carries every OTHER published key verbatim, top_k included', () => {
    const chat = toChatRequest({ model: FAST, input: [] }, resolver) as unknown as Record<string, unknown>;
    expect(chat.top_k).toBe(20);
    expect(chat.temperature).toBe(0.7);
    expect(chat.top_p).toBe(0.8);
  });

  /**
   * The negative half of that verbatim carry: a published key may not reach a
   * slot this translator owns. `model` and `messages` would corrupt the request;
   * `reasoning_effort` would route round the default-only rule below; the two
   * `chat_template_*`/`enable_thinking` names are forbidden by the module header
   * whoever asks for them.
   */
  it('refuses published keys that name a slot this translator owns', () => {
    const hostile = (): ModelGenerationDefaults | undefined => ({
      samplingParams: {
        model: 'someone-elses-model',
        messages: [],
        stream: true,
        tools: [],
        max_tokens: 1,
        reasoning_effort: 'max',
        enable_thinking: true,
        chat_template_kwargs: { enable_thinking: true },
        // …and one innocent key on the same object, as the positive control that
        // the carry itself still happened.
        min_p: 0.05,
      },
    });
    const chat = toChatRequest(
      { model: CODER, input: [{ type: 'message', role: 'user', content: 'hi' }], stream: false },
      hostile,
    ) as unknown as Record<string, unknown>;
    expect(chat.model).toBe(CODER);
    expect(chat.messages).toHaveLength(1);
    expect(chat.stream).toBe(false);
    expect(chat).not.toHaveProperty('tools');
    expect(chat).not.toHaveProperty('max_tokens');
    expect(chat).not.toHaveProperty('reasoning_effort');
    expect(chat).not.toHaveProperty('enable_thinking');
    expect(chat).not.toHaveProperty('chat_template_kwargs');
    expect(chat.min_p).toBe(0.05);
  });

  /**
   * The module header's hard rule — `temperature: 0` never goes on this wire
   * (Qwen greedy-decode degradation) — binds the catalogue exactly as it binds a
   * caller. A row publishing 0 falls through to the fallback rather than through
   * the gate.
   */
  it('a published temperature of 0 falls through to the fallback', () => {
    const zero = (): ModelGenerationDefaults => ({ samplingParams: { temperature: 0, top_p: 0.5 } });
    const chat = toChatRequest({ model: CODER, input: [] }, zero);
    expect(chat.temperature).toBe(0.7);
    // The positive control beside it: the same object's `top_p` DID land, so the
    // 0.7 above is the temperature rule and not the resolver being ignored.
    expect(chat.top_p).toBe(0.5);
  });
});

describe('toChatRequest — published reasoning effort (DA1.22)', () => {
  /**
   * The case the row was born for. The shipped `codex-app-server` sends
   * `{"summary":"auto"}` with no `effort` member when `model_reasoning_effort` is
   * unset (driven against the binary, 2026-09-03) — asked for reasoning, named no
   * level — and until this row the catalogue's recommendation was dropped there.
   */
  it('fills in the recommendation when the caller asked for reasoning and named no level', () => {
    const chat = toChatRequest({ model: CODER, input: [], reasoning: { summary: 'auto' } }, resolver);
    expect(chat.reasoning_effort).toBe('low');
  });

  it('never overrides a level the caller named', () => {
    const chat = toChatRequest({ model: CODER, input: [], reasoning: { effort: 'high', summary: 'auto' } }, resolver);
    expect(chat.reasoning_effort).toBe('high');
  });

  /**
   * THE ONE THAT MATTERS MOST. On the Anthropic route `anthropic/inbound.ts`
   * omits the whole `reasoning` block for `thinking: {type:"disabled"}`, so an
   * absent object is how a user's explicit OFF arrives here. Filling a default in
   * would turn thinking on for someone who turned it off — and the cost is
   * measured: 0.9 s to 12 s on the same prompt.
   */
  it('leaves an ABSENT reasoning object absent — thinking off stays off', () => {
    const chat = toChatRequest({ model: CODER, input: [] }, resolver);
    expect(chat).not.toHaveProperty('reasoning_effort');
  });

  it('a row that publishes no reasoning block recommends nothing', () => {
    const chat = toChatRequest({ model: FAST, input: [], reasoning: { summary: 'auto' } }, resolver);
    expect(chat).not.toHaveProperty('reasoning_effort');
  });
});

/**
 * THE CONTROL, and it is the reason every pre-DA1.22 caller can stay unchanged:
 * with no resolver the translator must produce byte-identical output to the
 * version before this row — the hand-typed 0.7/0.8 and no effort default.
 */
describe('toChatRequest — no resolver (DA1.22 control)', () => {
  it('is the pre-row behaviour exactly', () => {
    const chat = toChatRequest({ model: CODER, input: [], reasoning: { summary: 'auto' } });
    expect(chat.temperature).toBe(0.7);
    expect(chat.top_p).toBe(0.8);
    expect(chat).not.toHaveProperty('reasoning_effort');
    expect(chat).not.toHaveProperty('top_k');
  });

  it('and so is a resolver that answers undefined for this model', () => {
    const chat = toChatRequest({ model: 'some/byo-model', input: [], reasoning: { summary: 'auto' } }, resolver);
    expect(chat.temperature).toBe(0.7);
    expect(chat.top_p).toBe(0.8);
    expect(chat).not.toHaveProperty('reasoning_effort');
  });
});

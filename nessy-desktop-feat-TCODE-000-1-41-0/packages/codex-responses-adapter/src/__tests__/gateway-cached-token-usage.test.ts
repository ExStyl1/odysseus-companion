/**
 * D1.330 — the gateway's cached-token accounting, from the chat wire to
 * `message_delta.usage`.
 *
 * The defect this pins: `mapUsage` (`../from-chat.ts`) is the ONE chokepoint
 * between the gateway's chat-completions usage and every frame this adapter
 * emits, and it carried only `prompt_tokens`/`completion_tokens`/`total_tokens`.
 * `anthropicUsage` (`../anthropic/outbound.ts`) reads `input_tokens_details`,
 * so with that field never published the claude card read `0` cached tokens and
 * `warmth: unknown` — measured on the packaged 1.40.0 by CDP case `RS-72`,
 * against a Pi session on the SAME gateway model in the SAME profile reading
 * `8192` and `warm`.
 *
 * The contract the translator now implements is Pi's own `parseChunkUsage`
 * (vendored `@earendil-works/pi-coding-agent` 0.84.4), which is the reader that
 * demonstrably answered non-zero against this gateway — see the
 * `CACHED-TOKEN CONTRACT` block on `mapUsage` for which fields and which
 * direction, and why the miss counter is deliberately not read.
 *
 * `8192` below is `RS-72`'s own figure, so a reader can line the arms up against
 * the narrative in `docs/testing/cdp-runs/2026-09-18-measure-sitting-5c.md`.
 */
import { describe, expect, test } from 'bun:test';
import { mapUsage, toResponsesResponse, type ChatUsage } from '../from-chat.ts';
import { streamResponsesFromChat, type ChatChunk } from '../from-chat-stream.ts';
import { anthropicUsage, responsesSseToAnthropicSse } from '../anthropic/outbound.ts';

/** The gateway's usage object as OpenAI spells it: the cache detail is nested. */
const NESTED: ChatUsage = {
  prompt_tokens: 21_439,
  completion_tokens: 12,
  total_tokens: 21_451,
  prompt_tokens_details: { cached_tokens: 8192 },
};

/** The same turn with NO cache field of any spelling — the negative arm. */
const BARE: ChatUsage = { prompt_tokens: 21_439, completion_tokens: 12, total_tokens: 21_451 };

/** The four counts `anthropicUsage` always publishes, named so arithmetic typechecks. */
interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

// ============================================================
// (a) the translator: which fields, and what absence means
// ============================================================

describe('mapUsage: the chat wire cache detail reaches the Responses usage', () => {
  test('the nested OpenAI spelling is carried, and the counts are left inclusive', () => {
    expect(mapUsage(NESTED)).toEqual({
      input_tokens: 21_439,
      output_tokens: 12,
      total_tokens: 21_451,
      input_tokens_details: { cached_tokens: 8192, cache_write_tokens: 0 },
    });
  });

  test('a creation count travels beside the read count', () => {
    expect(mapUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 25 } }).input_tokens_details)
      .toEqual({ cached_tokens: 60, cache_write_tokens: 25 });
  });

  test.each([
    ['DeepSeek flat', { prompt_tokens: 100, prompt_cache_hit_tokens: 64 } as ChatUsage],
    ['bare top-level', { prompt_tokens: 100, cached_tokens: 64 } as ChatUsage],
  ])('the %s spelling is read too — the gateway is undocumented at this level', (_label, usage) => {
    expect(mapUsage(usage).input_tokens_details).toEqual({ cached_tokens: 64, cache_write_tokens: 0 });
  });

  test('an explicit nested zero WINS over a later spelling, exactly as Pi chains them', () => {
    // Pi's `parseChunkUsage` uses `??`, so a published `0` is an answer and not a
    // gap. Mirrored rather than "improved": a divergence here would be invention.
    const usage: ChatUsage = { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 64 };
    expect(mapUsage(usage).input_tokens_details).toEqual({ cached_tokens: 0, cache_write_tokens: 0 });
  });

  test('NEGATIVE — no cache field at all publishes no detail, and the three counts are untouched', () => {
    const mapped = mapUsage(BARE);
    expect(mapped).toEqual({ input_tokens: 21_439, output_tokens: 12, total_tokens: 21_451 });
    expect('input_tokens_details' in mapped).toBe(false);
    // Absence is "the upstream said nothing", but the consumer must still read a
    // number: `anthropicUsage` collapses it to an honest zero, never `NaN`.
    const anthropic = anthropicUsage(mapped) as unknown as AnthropicUsage;
    expect(anthropic.cache_read_input_tokens).toBe(0);
    expect(anthropic.cache_creation_input_tokens).toBe(0);
    expect(anthropic.input_tokens).toBe(21_439);
  });

  test('NEGATIVE — an absent usage object is still three finite zeros', () => {
    expect(mapUsage(undefined)).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  });

  test.each([
    ['a string', '8192'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative count', -5],
  ])('BOUNDARY — %s in the nested field falls through instead of poisoning the arithmetic', (_label, junk) => {
    const usage = { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: junk }, prompt_cache_hit_tokens: 64 } as unknown as ChatUsage;
    // The junk is skipped and the next spelling answers — and nothing is `NaN`.
    expect(mapUsage(usage).input_tokens_details).toEqual({ cached_tokens: 64, cache_write_tokens: 0 });
    const onlyJunk = { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: junk } } as unknown as ChatUsage;
    expect(mapUsage(onlyJunk).input_tokens_details).toBeUndefined();
    expect(Number.isNaN((anthropicUsage(mapUsage(onlyJunk)) as unknown as AnthropicUsage).input_tokens)).toBe(false);
  });

  test('the non-stream JSON route carries the same detail', () => {
    const out = toResponsesResponse({ choices: [{ message: { content: 'hi' } }], usage: NESTED }, { model: 'm', responseId: 'r' });
    expect(out.usage.input_tokens_details).toEqual({ cached_tokens: 8192, cache_write_tokens: 0 });
  });
});

// ============================================================
// (b) end to end: gateway chunks -> Responses SSE -> message_delta.usage
// ============================================================

/** Drive the real emitter over a chunk list and read the frames back. */
async function responsesFrames(usage: ChatUsage | undefined): Promise<string> {
  const chunks: ChatChunk[] = [
    { choices: [{ delta: { content: 'ok' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ...(usage ? [{ usage } as ChatChunk] : []),
  ];
  const frames: string[] = [];
  async function* gen() { for (const c of chunks) yield c; }
  await streamResponsesFromChat(gen(), (f) => frames.push(f), { model: 'm', responseId: 'r' });
  return frames.join('');
}

/** The `message_delta` the Claude Agent SDK's own reader consumes. */
async function messageDeltaUsage(usage: ChatUsage | undefined): Promise<AnthropicUsage> {
  const body = await responsesFrames(usage);
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(body)); controller.close(); },
  });
  const text = await new Response(responsesSseToAnthropicSse(upstream, 'claude-sonnet-4-5-20250929', { pingIntervalMs: 0 })).text();
  for (const frame of text.split('\n\n')) {
    if (!frame.startsWith('event: message_delta')) continue;
    const line = frame.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(line!.slice(6)).usage as AnthropicUsage;
  }
  throw new Error('no message_delta frame in the translated stream');
}

describe('end to end: the gateway usage chunk reaches message_delta.usage', () => {
  test('POSITIVE — the cached share arrives as cache_read_input_tokens and leaves input_tokens exclusive', async () => {
    const usage = await messageDeltaUsage(NESTED);
    expect(usage.cache_read_input_tokens).toBe(8192);
    expect(usage.cache_creation_input_tokens).toBe(0);
    // Anthropic's `input_tokens` EXCLUDES both cache figures; the chat wire's
    // `prompt_tokens` includes them. The subtraction happens once, downstream.
    expect(usage.input_tokens).toBe(21_439 - 8192);
    expect(usage.input_tokens + usage.cache_read_input_tokens).toBe(21_439);
  });

  test('NEGATIVE — the SAME stream with no cache field reports zero, and that is the whole difference', async () => {
    const usage = await messageDeltaUsage(BARE);
    expect(usage.cache_read_input_tokens).toBe(0);
    expect(usage.cache_creation_input_tokens).toBe(0);
    // The control that makes the positive arm a discrimination rather than "the
    // pipeline emits some number": only the usage chunk differs between the arms.
    expect(usage.input_tokens).toBe(21_439);
    expect(usage.output_tokens).toBe(12);
  });

  test('BOUNDARY — a turn whose usage chunk never arrives still reports finite zeros', async () => {
    const usage = await messageDeltaUsage(undefined);
    expect(usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });
});

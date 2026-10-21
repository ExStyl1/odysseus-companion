/**
 * D1.330, the host half — the claude event adapter's `message_delta.usage`
 * reader, driven over the usage the loopback adapter really produces.
 *
 * The sibling suite
 * `packages/codex-responses-adapter/src/__tests__/gateway-cached-token-usage.test.ts`
 * pins the translation (gateway chat usage -> `input_tokens_details` ->
 * `message_delta.usage`). This one closes the chain on THIS side: the same two
 * functions are driven for real, and their output is fed to the real
 * `ClaudeEventAdapter`, so a future change to either end cannot leave the two
 * halves agreeing with each other and disagreeing with the product.
 *
 * Why that matters here: `RS-72` (packaged 1.40.0) read `0 / 0 / unknown` on the
 * claude card against `8192 / 0 / warm` for a Pi session on the SAME gateway
 * model in the SAME profile, and the natural reading — "the claude reader is
 * broken" — is WRONG. The reader below has always been correct; the translator
 * never gave it a number. Asserting the reader in isolation would have gone
 * green throughout the defect, which is why this file starts from a chat-wire
 * usage object and not from a hand-written Anthropic one.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentEvent } from '@nessy-agent/core/types';
import { describeCacheUsage } from '@nessy-agent/core/types';
import { ClaudeEventAdapter, type ClaudeAdapterCallbacks } from '../event-adapter.ts';
// A deep relative import because the adapter's exports map publishes neither
// `from-chat` nor `anthropic/outbound`; taking the real functions is the whole
// point of the file, and a copied literal would be the drift it exists to stop.
import { mapUsage, type ChatUsage } from '../../../../../../codex-responses-adapter/src/from-chat.ts';
import { anthropicUsage } from '../../../../../../codex-responses-adapter/src/anthropic/outbound.ts';

/** `RS-72`'s own figures: a warm turn on the gateway's `coder` alias. */
const WARM_TURN: ChatUsage = {
  prompt_tokens: 21_439,
  completion_tokens: 12,
  total_tokens: 21_451,
  prompt_tokens_details: { cached_tokens: 8192 },
};

/** The same turn from a gateway that publishes no cache figure at all. */
const SILENT_TURN: ChatUsage = { prompt_tokens: 21_439, completion_tokens: 12, total_tokens: 21_451 };

function callbacks(): ClaudeAdapterCallbacks {
  return {
    onDebug: undefined,
    mapSDKError: async () => ({
      type: 'typed_error' as const,
      error: { code: 'unknown_error', title: 't', message: 'm', details: [], actions: [], canRetry: false },
    }),
  };
}

interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/**
 * One gateway turn, end to end: chat usage -> `mapUsage` -> `anthropicUsage` ->
 * `message_delta` -> the real adapter -> the `complete` event's usage.
 */
async function turnUsage(chatUsage: ChatUsage): Promise<TurnUsage | undefined> {
  const translated = anthropicUsage(mapUsage(chatUsage));
  const adapter = new ClaudeEventAdapter(callbacks());
  adapter.startTurn();
  // The gateway reports usage only in its trailing chunk, so the opening
  // snapshot is a zero — exactly the shape F6 records for this wire.
  await adapter.adapt({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 0, output_tokens: 0 } },
    parent_tool_use_id: null,
    session_id: 'sess-1',
  } as never);
  await adapter.adapt({
    type: 'stream_event',
    event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: translated },
    parent_tool_use_id: null,
    session_id: 'sess-1',
  } as never);
  const events: AgentEvent[] = await adapter.adapt({
    type: 'result',
    subtype: 'success',
    usage: translated,
    total_cost_usd: 0,
    parent_tool_use_id: null,
    session_id: 'sess-1',
  } as never);
  return (events.find(e => e.type === 'complete') as { usage?: TurnUsage } | undefined)?.usage;
}

describe('the claude reader fills the cache figures once the translator publishes them', () => {
  it('POSITIVE — a warm gateway turn reports RS-72’s 8192 and resolves to "warm"', async () => {
    const usage = await turnUsage(WARM_TURN);
    expect(usage?.cacheReadTokens).toBe(8192);
    expect(usage?.cacheCreationTokens).toBe(0);
    // The reader re-assembles the WHOLE input from the three Anthropic fields,
    // so the figure the renderer shows is still the gateway's `prompt_tokens`.
    expect(usage?.inputTokens).toBe(21_439);
    expect(describeCacheUsage({
      totalInputTokens: usage!.inputTokens!,
      cacheReadTokens: usage?.cacheReadTokens,
      cacheCreationTokens: usage?.cacheCreationTokens,
    }).warmth).toBe('warm');
  });

  it('NEGATIVE — a gateway that publishes no cache figure still reports zeros and "unknown"', async () => {
    const usage = await turnUsage(SILENT_TURN);
    expect(usage?.cacheReadTokens).toBe(0);
    expect(usage?.cacheCreationTokens).toBe(0);
    expect(usage?.inputTokens).toBe(21_439);
    // This is the reading `RS-72` took on the claude card, and it is the honest
    // one for a silent upstream — the defect was that it was ALSO the reading
    // for a warm one.
    expect(describeCacheUsage({
      totalInputTokens: usage!.inputTokens!,
      cacheReadTokens: usage?.cacheReadTokens,
      cacheCreationTokens: usage?.cacheCreationTokens,
    }).warmth).toBe('unknown');
  });

  it('BOUNDARY — a creation-only turn is "cold", and no figure is ever NaN', async () => {
    const usage = await turnUsage({ prompt_tokens: 500, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 120 } });
    expect(usage?.cacheReadTokens).toBe(0);
    expect(usage?.cacheCreationTokens).toBe(120);
    expect(usage?.inputTokens).toBe(500);
    expect(Number.isNaN(usage?.inputTokens)).toBe(false);
    expect(describeCacheUsage({
      totalInputTokens: usage!.inputTokens!,
      cacheReadTokens: usage?.cacheReadTokens,
      cacheCreationTokens: usage?.cacheCreationTokens,
    }).warmth).toBe('cold');
  });

  it('the hit rate the breakdown renders is the cached share of the whole input', async () => {
    const usage = await turnUsage(WARM_TURN);
    const snapshot = describeCacheUsage({
      totalInputTokens: usage!.inputTokens!,
      cacheReadTokens: usage?.cacheReadTokens,
      cacheCreationTokens: usage?.cacheCreationTokens,
    });
    expect(snapshot.hitRate).toBeCloseTo(8192 / 21_439, 6);
  });
});

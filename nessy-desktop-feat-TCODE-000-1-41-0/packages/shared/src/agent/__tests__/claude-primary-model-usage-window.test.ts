/**
 * F1.1283 (origin: the 1.41.0 re-check sitting SIT3, lane SIT3-a) — a fresh 1M claude session stored a 200 000 context
 * window after turn 1, until a context refresh or /compact. The adapter took the window from the FIRST `modelUsage`
 * entry of the result, and a turn's `modelUsage` carries every model the child called that turn — a background call on
 * another model (the sitting read it as the CLI's own `claude-sonnet-4-6` request) can come first. The window is now
 * the MAIN model's entry: the one the SDK's own `getContextUsage` reported on, else the model of the turn's main-line
 * assistant message, else the first entry as before.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentEvent } from '@nessy-agent/core/types';
import { ClaudeEventAdapter, type ClaudeAdapterCallbacks } from '../backend/claude/event-adapter.ts';

const MAIN = 'claude-opus-4-8';
const BACKGROUND = 'claude-sonnet-4-6';

function callbacks(): ClaudeAdapterCallbacks {
  return {
    mapSDKError: async () => ({
      type: 'typed_error' as const,
      error: { code: 'unknown_error', title: 'x', message: 'x', details: [], actions: [], canRetry: false },
    }),
  };
}

function assistant(model: string): Record<string, unknown> {
  return {
    type: 'assistant', session_id: 's', parent_tool_use_id: null,
    message: {
      id: 'msg-1', role: 'assistant', model, content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn',
      usage: { input_tokens: 40_000, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
}

function result(modelUsage: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'result', subtype: 'success', result: 'hi', is_error: false, num_turns: 1, total_cost_usd: 0,
    session_id: 's', stop_reason: null, modelUsage,
    usage: { input_tokens: 40_000, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

/** The background call's entry FIRST, as the sitting's turn 1 had it. */
const TURN_ONE_USAGE = {
  [BACKGROUND]: { inputTokens: 300, outputTokens: 20, contextWindow: 200_000 },
  [MAIN]: { inputTokens: 40_000, outputTokens: 2, contextWindow: 1_000_000 },
};

async function windowAfter(messages: Array<Record<string, unknown>>, prime?: (adapter: ClaudeEventAdapter) => void): Promise<{ complete?: number; stored?: number }> {
  const adapter = new ClaudeEventAdapter(callbacks());
  prime?.(adapter);
  adapter.startTurn();
  const events: AgentEvent[] = [];
  for (const message of messages) events.push(...await adapter.adapt(message as never));
  const complete = events.find(event => event.type === 'complete') as { usage?: { contextWindow?: number } } | undefined;
  return { complete: complete?.usage?.contextWindow, stored: adapter.getReportedContextWindow() };
}

describe('F1.1283 — the stored context window is the main model\'s, not the first modelUsage entry\'s', () => {
  it('THE CLAIM: a background call\'s entry listed first does not set a 1M session\'s window to 200 000', async () => {
    expect(await windowAfter([assistant(MAIN), result(TURN_ONE_USAGE)])).toEqual({ complete: 1_000_000, stored: 1_000_000 });
  });

  it('the SDK\'s own report names the main model when no assistant message did (a `[1m]` spelling included)', async () => {
    const after = await windowAfter([result(TURN_ONE_USAGE)], adapter => {
      adapter.applySdkContextUsage({ model: `${MAIN}[1m]`, rawMaxTokens: 1_000_000 });
    });
    expect(after).toEqual({ complete: 1_000_000, stored: 1_000_000 });
  });

  it('CONTROL — with nothing naming the main model the first entry is read, as before; one entry is unchanged', async () => {
    expect(await windowAfter([result(TURN_ONE_USAGE)])).toEqual({ complete: 200_000, stored: 200_000 });
    expect(await windowAfter([assistant(BACKGROUND), result({ [BACKGROUND]: TURN_ONE_USAGE[BACKGROUND] })]))
      .toEqual({ complete: 200_000, stored: 200_000 });
  });
});

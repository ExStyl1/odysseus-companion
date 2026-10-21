/**
 * Tests for ClaudeEventAdapter
 *
 * Tests the SDK message → AgentEvent conversion extracted from ClaudeAgent.
 * Each test provides mock SDKMessage objects and verifies the AgentEvents produced.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ClaudeEventAdapter, buildWindowsSkillsDirError, type ClaudeAdapterCallbacks } from '../backend/claude/event-adapter.ts';
import type { AgentEvent, PersistedModelUsage } from '@nessy-agent/core/types';
// P2.42 reads the per-model map through the reader that inflated it: the
// session's own accumulator, whose every field is `before + turn`.
import { mergeModelUsage } from '../../telemetry/cost-reporting.ts';
// P2.35 composes the adapter's own output with the shared ceiling in
// `BaseAgent.chat` — `TestAgent` is that path (claude leaves
// `enforcesMaxBudgetUsdInChatImpl` false, so it is the loop claude runs).
import {
  TestAgent,
  collectEvents,
  createMockBackendConfig,
  createMockCapabilityTurnRuntime,
} from './test-utils.ts';

// Helper: create default callbacks
function createCallbacks(overrides?: Partial<ClaudeAdapterCallbacks>): ClaudeAdapterCallbacks {
  return {
    onDebug: undefined,
    mapSDKError: async (errorCode) => ({
      type: 'typed_error' as const,
      error: {
        code: 'unknown_error',
        title: 'Test Error',
        message: `Mock error for ${errorCode}`,
        details: [],
        actions: [],
        canRetry: false,
      },
    }),
    ...overrides,
  };
}

describe('ClaudeEventAdapter', () => {
  let adapter: ClaudeEventAdapter;

  beforeEach(() => {
    adapter = new ClaudeEventAdapter(createCallbacks());
    adapter.startTurn();
  });

  describe('stream_event: message_start', () => {
    it('should capture turn ID from message_start', async () => {
      const events = await adapter.adapt({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'msg-123' },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      } as any);

      // No events emitted for message_start itself
      expect(events).toHaveLength(0);

      // Subsequent events should include the turn ID
      const textEvents = await adapter.adapt({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'hello' },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      } as any);

      expect(textEvents).toHaveLength(1);
      expect(textEvents[0]).toMatchObject({
        type: 'text_delta',
        text: 'hello',
        turnId: 'msg-123',
      });
    });
  });

  describe('stream_event: text_delta', () => {
    it('should emit text_delta for content_block_delta', async () => {
      const events = await adapter.adapt({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello world' },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      } as any);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_delta',
        text: 'Hello world',
      });
    });

    it('should include parentToolUseId from SDK message', async () => {
      const events = await adapter.adapt({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'nested' },
        },
        parent_tool_use_id: 'task-001',
        session_id: 'sess-1',
      } as any);

      expect(events[0]).toMatchObject({
        type: 'text_delta',
        parentToolUseId: 'task-001',
      });
    });
  });

  describe('stream_event: message_delta (text_complete)', () => {
    it('should emit text_complete when message_delta arrives with pending text', async () => {
      // First: assistant message sets pending text
      await adapter.adapt({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Final answer' }],
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      } as any);

      // Then: message_delta triggers text_complete
      const events = await adapter.adapt({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      } as any);

      const textComplete = events.find(e => e.type === 'text_complete');
      expect(textComplete).toBeDefined();
      expect(textComplete).toMatchObject({
        type: 'text_complete',
        text: 'Final answer',
        isIntermediate: false,
      });
    });

    it('should set isIntermediate=true when stop_reason is tool_use', async () => {
      await adapter.adapt({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Let me check...' }],
          usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      } as any);

      const events = await adapter.adapt({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      } as any);

      const textComplete = events.find(e => e.type === 'text_complete');
      expect(textComplete).toMatchObject({
        isIntermediate: true,
      });
    });
  });

  describe('assistant message', () => {
    it('should skip replayed messages', async () => {
      const events = await adapter.adapt({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'replayed' }],
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: true,
      } as any);

      expect(events).toHaveLength(0);
    });

    it('should emit usage_update for non-sidechain messages', async () => {
      const events = await adapter.adapt({
        type: 'assistant',
        message: {
          content: [],
          usage: {
            input_tokens: 1000,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 200,
          },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      } as any);

      const usageEvent = events.find(e => e.type === 'usage_update');
      expect(usageEvent).toBeDefined();
      expect(usageEvent).toMatchObject({
        type: 'usage_update',
        usage: {
          inputTokens: 1700, // 1000 + 500 + 200
        },
      });
    });

    it('should not emit usage_update for sidechain messages', async () => {
      const events = await adapter.adapt({
        type: 'assistant',
        message: {
          content: [],
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: 'task-001', // sidechain
        session_id: 'sess-1',
        isReplay: false,
      } as any);

      const usageEvent = events.find(e => e.type === 'usage_update');
      expect(usageEvent).toBeUndefined();
    });

    it('should handle SDK errors via callback', async () => {
      const events = await adapter.adapt({
        type: 'assistant',
        error: 'rate_limit',
        message: { content: [], usage: {} },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      } as any);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'typed_error',
        error: {
          message: 'Mock error for rate_limit',
        },
      });
    });
  });

  /**
   * F6 — context occupancy on the `claude-runtime` (gateway) wire.
   *
   * The numbers below are one real turn, captured by driving the shipped SDK
   * binary through the real `codex-responses-adapter` against a stub gateway:
   * the assistant message carries the `message_start` snapshot `{input_tokens:
   * 0, output_tokens: 0}` (the gateway reports usage only in its trailing
   * chunk), and the settled `{input_tokens: 58392, output_tokens: 38}` arrives
   * in `message_delta`. The same 58 392 / 38 / $0.29291 triple is what the
   * owner's own claude-gateway sessions persisted — against `inputTokens: 0`.
   */
  describe('gateway-wire occupancy (F6)', () => {
    const emptySnapshot = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 0, output_tokens: 0 } },
      parent_tool_use_id: null,
      session_id: 'sess-1',
    } as any;

    const settledDelta = (overrides: Record<string, unknown> = {}) => ({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          input_tokens: 58_392,
          output_tokens: 38,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      session_id: 'sess-1',
      ...overrides,
    }) as any;

    const gatewayResult = {
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 58_392,
        output_tokens: 38,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      total_cost_usd: 0.29291,
      modelUsage: {
        'tgpt/qwen35-397b-a17b-fp8': {
          inputTokens: 58_392,
          outputTokens: 38,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 240_000,
        },
      },
      session_id: 'sess-1',
    } as any;

    const completeUsage = (events: AgentEvent[]) =>
      (events.find(event => event.type === 'complete') as
        { usage?: { inputTokens?: number; cacheReadTokens?: number } } | undefined)?.usage;

    it('reports the turn occupancy the SDK reports, not the zero opening snapshot', async () => {
      await adapter.adapt(emptySnapshot);
      const deltaEvents = await adapter.adapt(settledDelta());
      expect(deltaEvents.find(event => event.type === 'usage_update')).toMatchObject({
        usage: { inputTokens: 58_392 },
      });

      const usage = completeUsage(await adapter.adapt(gatewayResult));
      expect(usage?.inputTokens).toBe(58_392);
      // The observable F5 named: consistent with the SDK's own per-model figure
      // for this turn.
      expect(usage?.inputTokens).toBe(
        gatewayResult.modelUsage['tgpt/qwen35-397b-a17b-fp8'].inputTokens,
      );
    });

    it('lets no empty snapshot announce a drop or overwrite a real reading', async () => {
      const openingEvents = await adapter.adapt(emptySnapshot);
      expect(openingEvents.find(event => event.type === 'usage_update')).toBeUndefined();

      await adapter.adapt(settledDelta());
      // A second request in the same turn opens with zeros again.
      const secondOpening = await adapter.adapt(emptySnapshot);
      expect(secondOpening.find(event => event.type === 'usage_update')).toBeUndefined();
      expect(completeUsage(await adapter.adapt(gatewayResult))?.inputTokens).toBe(58_392);
    });

    it('ignores a subagent message_delta', async () => {
      await adapter.adapt(settledDelta());
      const sidechain = await adapter.adapt(settledDelta({ parent_tool_use_id: 'task-001' }));
      expect(sidechain.find(event => event.type === 'usage_update')).toBeUndefined();
      expect(completeUsage(await adapter.adapt(gatewayResult))?.inputTokens).toBe(58_392);
    });

    it('keeps the first-party per-message reading instead of the cumulative result total', async () => {
      // The first-party wire fills `message_start`, so the per-request snapshot
      // is already right. `result.usage` sums the turn's requests — using it
      // would inflate a multi-step turn, which is why this pins the smaller
      // number.
      await adapter.adapt({
        type: 'assistant',
        message: {
          content: [],
          usage: { input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 200 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      } as any);

      const usage = completeUsage(await adapter.adapt({
        ...gatewayResult,
        usage: { input_tokens: 9999, output_tokens: 42, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }));
      expect(usage?.inputTokens).toBe(1700);
      expect(usage?.cacheReadTokens).toBe(500);
    });
  });

  describe('user message (tool results)', () => {
    it('should skip replayed user messages', async () => {
      const events = await adapter.adapt({
        type: 'user',
        tool_use_result: 'result data',
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: true,
      } as any);

      expect(events).toHaveLength(0);
    });
  });

  describe('tool_progress', () => {
    it('should emit task_progress with elapsed time', async () => {
      const events = await adapter.adapt({
        type: 'tool_progress',
        tool_use_id: 'tool-1',
        tool_name: 'Task',
        parent_tool_use_id: 'parent-1',
        elapsed_time_seconds: 5.2,
        session_id: 'sess-1',
      } as any);

      const progressEvent = events.find(e => e.type === 'task_progress');
      expect(progressEvent).toBeDefined();
      expect(progressEvent).toMatchObject({
        type: 'task_progress',
        toolUseId: 'parent-1', // Uses parent_tool_use_id
        elapsedSeconds: 5.2,
      });
    });

    it('should use tool_use_id when no parent', async () => {
      const events = await adapter.adapt({
        type: 'tool_progress',
        tool_use_id: 'tool-1',
        tool_name: 'Bash',
        parent_tool_use_id: null,
        elapsed_time_seconds: 1.0,
        session_id: 'sess-1',
      } as any);

      const progressEvent = events.find(e => e.type === 'task_progress');
      expect(progressEvent).toMatchObject({
        toolUseId: 'tool-1',
      });
    });
  });

  describe('result', () => {
    // Shared shape for the terminal-reason cases below; the older tests inline
    // their own usage blocks and stay untouched.
    const resultUsage = {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const resultMessage = (overrides: Record<string, unknown>) => ({
      type: 'result',
      usage: resultUsage,
      total_cost_usd: 0,
      modelUsage: {},
      session_id: 'sess-1',
      ...overrides,
    }) as any;

    it('maps each documented result subtype to a distinct terminal reason', async () => {
      const cases: Array<[string, string]> = [
        ['error_max_turns', 'max_agent_turns'],
        ['error_max_budget_usd', 'max_budget_usd'],
        // The DOCUMENTED terminal_reason value (typescript.md), not our old
        // invented 'max_structured_output_retries' (doc-verification § R18).
        ['error_max_structured_output_retries', 'structured_output_retry_exhausted'],
      ];
      for (const [subtype, reason] of cases) {
        adapter = new ClaudeEventAdapter(createCallbacks());
        adapter.startTurn();
        const events = await adapter.adapt(resultMessage({ subtype, errors: [] }));
        const complete = events.find(event => event.type === 'complete');
        expect(complete, subtype).toBeDefined();
        expect((complete as { terminalReason?: string }).terminalReason, subtype).toBe(reason);
      }
    });

    it('leaves a successful result exactly as it was', async () => {
      const events = await adapter.adapt(resultMessage({ subtype: 'success', total_cost_usd: 0.5 }));
      const complete = events.find(event => event.type === 'complete') as
        { type: 'complete'; usage?: { costUsd?: number }; terminalReason?: string };
      expect(complete.terminalReason).toBeUndefined();
      expect('terminalReason' in complete).toBe(false);
      expect(complete.usage?.costUsd).toBe(0.5);
      // A schema-less turn carries no structured-output fields at all.
      expect('structuredOutput' in complete).toBe(false);
      expect('structuredOutputSubtype' in complete).toBe(false);
      expect('structuredOutputErrors' in complete).toBe(false);
    });

    it('forwards structured_output and the error subtype onto complete (R18)', async () => {
      // Success arm: SDK structured_output rides the complete event.
      const okEvents = await adapter.adapt(resultMessage({
        subtype: 'success',
        structured_output: { ok: true },
      }));
      const okComplete = okEvents.find(event => event.type === 'complete') as Record<string, unknown>;
      expect(okComplete.structuredOutput).toEqual({ ok: true });
      expect(okComplete.structuredOutputSubtype).toBe('success');

      // Error arm: the subtype + errors list ride complete, with the
      // documented terminal reason already mapped above.
      adapter = new ClaudeEventAdapter(createCallbacks());
      adapter.startTurn();
      const errEvents = await adapter.adapt(resultMessage({
        subtype: 'error_max_structured_output_retries',
        errors: ['validation failed after retries'],
      }));
      const errComplete = errEvents.find(event => event.type === 'complete') as Record<string, unknown>;
      expect(errComplete.structuredOutputSubtype).toBe('error_max_structured_output_retries');
      expect(errComplete.structuredOutputErrors).toEqual(['validation failed after retries']);
      expect(errComplete.terminalReason).toBe('structured_output_retry_exhausted');
      expect('structuredOutput' in errComplete).toBe(false);
    });

    it('reports a cap as a stop, not as an error event', async () => {
      // A cap must not surface as a crash: the user sees "stopped because of the
      // budget", and any assistant text already produced this turn is kept.
      const events = await adapter.adapt(resultMessage({ subtype: 'error_max_turns', errors: [] }));
      expect(events.some(event => event.type === 'error')).toBe(false);
      expect(events.some(event => event.type === 'typed_error')).toBe(false);
    });

    it('still emits an error event for an unrecognized failure subtype', async () => {
      const events = await adapter.adapt(
        resultMessage({ subtype: 'error_during_execution', errors: ['boom'] }),
      );
      expect(events.some(event => event.type === 'error')).toBe(true);
      const complete = events.find(event => event.type === 'complete');
      expect((complete as { terminalReason?: string }).terminalReason).toBe('provider_error');
    });

    it('reports a refusal carried on a successful subtype', async () => {
      // stop_reason is a sibling of subtype, not a subtype of its own: a success
      // result can still be a refusal, and reading only subtype would report it
      // as a clean completion.
      const events = await adapter.adapt(
        resultMessage({ subtype: 'success', stop_reason: 'refusal' }),
      );
      const complete = events.find(event => event.type === 'complete');
      expect((complete as { terminalReason?: string }).terminalReason).toBe('provider_refusal');
      expect(events.some(event => event.type === 'error')).toBe(false);
    });

    it('should emit complete with usage on success', async () => {
      const events = await adapter.adapt({
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 100,
        },
        total_cost_usd: 0.05,
        modelUsage: {
          'claude-opus': { contextWindow: 200000 },
        },
        session_id: 'sess-1',
      } as any);

      const completeEvent = events.find(e => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent).toMatchObject({
        type: 'complete',
        usage: {
          outputTokens: 500,
          costUsd: 0.05,
          contextWindow: 200000,
        },
      });
    });

    it('should emit error then complete on failure', async () => {
      const events = await adapter.adapt({
        type: 'result',
        subtype: 'error',
        errors: ['Something went wrong', 'Another error'],
        usage: {
          input_tokens: 100,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.01,
        modelUsage: {},
        session_id: 'sess-1',
      } as any);

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: 'error',
        message: 'Something went wrong, Another error',
      });
      expect(events[1]).toMatchObject({
        type: 'complete',
      });
    });

    it('should use lastAssistantUsage for accurate context display', async () => {
      // Send an assistant message first to capture per-message usage
      await adapter.adapt({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'test' }],
          usage: {
            input_tokens: 800,
            cache_read_input_tokens: 400,
            cache_creation_input_tokens: 100,
          },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      } as any);

      // Now send result — should use the per-message usage, not cumulative
      const events = await adapter.adapt({
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 5000, // cumulative (should be ignored)
          output_tokens: 1000,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 500,
        },
        total_cost_usd: 0.10,
        modelUsage: {},
        session_id: 'sess-1',
      } as any);

      const completeEvent = events.find(e => e.type === 'complete') as any;
      // Should use lastAssistantUsage (800+400+100=1300), not cumulative (5000+2000+500=7500)
      expect(completeEvent.usage.inputTokens).toBe(1300);
      expect(completeEvent.usage.cacheReadTokens).toBe(400);
      expect(completeEvent.usage.cacheCreationTokens).toBe(100);
    });
  });

  /**
   * A crash/startup-error result — INCLUDING the zeroed `usage` its name claims.
   *
   * P2.230. Every case below titled *"a zeroed crash…"* used to override only
   * the subtype and the error flags, so it kept its factory's
   * `input_tokens: 10, output_tokens: 2` and **never once drove a zeroed
   * `usage`** — the one thing the name promised was the one thing it did not
   * exercise. Nothing broke, because the verdicts these cases pin read
   * `total_cost_usd` and `modelUsage`, never this block; that is precisely why
   * a false landmark survived in the file every future cost row reads.
   *
   * `sdk.d.ts:4359` and `:4367` describe the shape as "crash/startup-error
   * results may carry zeroed values" / "zeroed usage", so the zero belongs to
   * the whole result, not to the cost field alone.
   */
  const CRASHED_RESULT = {
    subtype: 'error_during_execution',
    is_error: true,
    errors: [],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };

  // -------------------------------------------------------------------------
  // P2.35 — `total_cost_usd` IS A RUNNING TOTAL, AND `usage.costUsd` IS NOT
  // -------------------------------------------------------------------------

  describe("the SDK's running cost total becomes this turn's own cost", () => {
    /** One SDK result carrying `total` as the child's running total so far. */
    const costResult = (total: number, overrides: Record<string, unknown> = {}) => ({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      is_error: false,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: total,
      modelUsage: {},
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      session_id: 'sess-1',
      ...overrides,
    }) as any;

    /** The `costUsd` each of these results puts on its `complete`, in order. */
    async function costsFor(
      results: Array<Record<string, unknown>>,
      betweenTurns?: (turnIndex: number) => void,
    ): Promise<Array<number | undefined>> {
      const costs: Array<number | undefined> = [];
      for (const [index, message] of results.entries()) {
        betweenTurns?.(index);
        adapter.startTurn();
        const events = await adapter.adapt(message as any);
        const complete = events.find(event => event.type === 'complete') as
          { usage?: { costUsd?: number } } | undefined;
        costs.push(complete?.usage?.costUsd);
      }
      return costs;
    }

    it('THE CLAIM: three cumulative totals are three turn costs, not three totals', async () => {
      // `sdk.d.ts:4359` — "cumulative across turns in streaming-input sessions —
      // each result carries the running total so far, so read the latest result
      // rather than summing across results". Every consumer of `usage.costUsd`
      // in this repo ADDS it (`BaseAgent.exceedsMaxBudgetUsd`'s
      // `sessionCostUsd += costUsd`, `SessionManager`'s `tokenUsage.costUsd +=
      // event.usage.costUsd ?? 0`, `recordUsageMetrics`, the goal service), so
      // the field's contract is a per-turn increment and the running total has
      // to be differenced here.
      expect(await costsFor([costResult(1), costResult(2), costResult(3)])).toEqual([1, 1, 1]);
    });

    it('THE CONTROL: a total that does not move reports no spend at all', async () => {
      // Without this, "the deltas are 1, 1, 1" is also what forwarding the raw
      // number would produce for totals 1, 1, 1 — the control that separates
      // "differenced" from "happened to look right".
      expect(await costsFor([costResult(2), costResult(2), costResult(5)])).toEqual([2, 0, 3]);
    });

    it('a zeroed crash result reports nothing and does NOT lower the running baseline', async () => {
      // Same doc line: "Crash/startup-error results may carry zeroed values."
      // Reading that 0 as the new baseline would make the NEXT result's
      // difference re-count every dollar already counted — the original defect,
      // reintroduced by the guard that was supposed to fix it.
      expect(await costsFor([
        costResult(4),
        costResult(0, CRASHED_RESULT),
        costResult(6),
      ])).toEqual([4, 0, 2]);
    });

    it('a NEW CHILD starts its own total over, and the reset is what says so', async () => {
      // `total_cost_usd` is scoped to one `query()` call, so every respawn
      // `ensureLiveSession` performs restarts it at zero while the session's
      // real spend continues. `resetReportedCostTotal` is called from that
      // spawn line; without it the second child's smaller totals would
      // difference to nothing until they passed the dead child's peak.
      //
      // P2.46 REBUILT THIS CONTROL, and the rebuild is the point rather than a
      // fixture tidy-up. The series used to be `[3, 1, 2]` expecting `[3, 1, 1]`.
      // Once the backwards branch is split, the restart branch INFERS what the
      // reset used to say, so that same series produces `[3, 1, 1]` with AND
      // without the reset — the control stops discriminating while still passing,
      // which is the worst state a control can be in.
      //
      // MONOTONE-CROSSING instead: child two's first total (5) EXCEEDS the dead
      // child's peak (3), which no restart heuristic can infer, because nothing
      // about 5 says "started over". Only the explicit reset makes turn two 5
      // rather than 2.
      const costs = await costsFor(
        [costResult(3), costResult(5)],
        turn => { if (turn === 1) adapter.resetReportedCostTotal(); },
      );
      expect(costs).toEqual([3, 5]);
      // Session total = 8: child one's 3 plus child two's own 5.
      expect(costs.reduce((sum: number, cost) => sum + (cost ?? 0), 0)).toBe(8);

      // THE OTHER HALF, on a FRESH adapter. `costsFor` closes over the outer
      // `adapter`, which `beforeEach` builds once per test and not once per
      // call — so a second series would otherwise start from the first one's
      // baseline and this arm would agree by accident rather than by measurement.
      adapter = new ClaudeEventAdapter(createCallbacks());
      expect(await costsFor([costResult(3), costResult(5)])).toEqual([3, 2]);
    });

    it('P2.46: a zeroed crash keeps the baseline, a SMALLER NON-ZERO total is a restart', async () => {
      // One documented sentence, two conditions needing OPPOSITE handling:
      // "crash/startup-error results may carry zeroed usage, resumed sessions
      // start fresh, and a mid-session /clear resets the running total"
      // (`sdk.d.ts`, re-read verbatim at 0.3.233).
      //
      // The crash arm is the existing behaviour, asserted again here beside its
      // twin so the pair cannot be split by a later edit that reads only one.
      expect(await costsFor([costResult(4), costResult(0, CRASHED_RESULT), costResult(6)])).toEqual([4, 0, 2]);

      // The restart arm is the new one. Folded into the crash case, 1 would
      // report 0 and keep the baseline at 4, so the 3 would report 0 too and
      // BOTH dollars would vanish: `[4, 0, 0]` against a true `[4, 1, 2]`.
      adapter = new ClaudeEventAdapter(createCallbacks());
      expect(await costsFor([costResult(4), costResult(1), costResult(3)])).toEqual([4, 1, 2]);
    });

    it('THE POINT: the host counter lands on the true spend, and a cap above it does not trip', async () => {
      // The whole chain on real code: SDK numbers → the adapter → the shared
      // ceiling in `BaseAgent.chat`. Three turns of $1 against a $4 ceiling.
      // Before this row the host counted 1+2+3 = 6 and stopped the session at
      // roughly half its real spend.
      const costs = await costsFor([costResult(1), costResult(2), costResult(3)]);

      const agent = new TestAgent(createMockBackendConfig());
      agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime());
      (agent as unknown as { getMaxBudgetUsd(): number }).getMaxBudgetUsd = () => 4;
      const terminalReasons: Array<string | undefined> = [];
      for (const costUsd of costs) {
        // P2.36 — `costReporting: 'reported'` is what the adapter stamps beside a
        // priced figure, and what the shared classifier requires before it counts
        // anything. Replayed here because these turns stand in for a PRICED
        // session; the unpriced twin lives in `base-agent.test.ts`.
        agent.scriptedEvents = [{ type: 'complete', usage: { inputTokens: 1, outputTokens: 1, costUsd, costReporting: 'reported' } as never }];
        const events = await collectEvents(agent.chat('hi'));
        terminalReasons.push((events.at(-1) as { terminalReason?: string }).terminalReason);
      }

      expect((agent as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(3);
      expect(terminalReasons).toEqual([undefined, undefined, undefined]);
      expect(agent.forceAbortCalls).toEqual([]);
      agent.destroy();
    });

    it('and the ceiling still fires once the TRUE spend passes it', async () => {
      // The negative of the row is "the cap stops firing", so the positive has
      // to be pinned on the same rig: differencing must not disarm the ceiling.
      const costs = await costsFor([costResult(3), costResult(6)]);
      expect(costs).toEqual([3, 3]);

      const agent = new TestAgent(createMockBackendConfig());
      agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime());
      (agent as unknown as { getMaxBudgetUsd(): number }).getMaxBudgetUsd = () => 4;
      const terminalReasons: Array<string | undefined> = [];
      for (const costUsd of costs) {
        // P2.36 — `costReporting: 'reported'` is what the adapter stamps beside a
        // priced figure, and what the shared classifier requires before it counts
        // anything. Replayed here because these turns stand in for a PRICED
        // session; the unpriced twin lives in `base-agent.test.ts`.
        agent.scriptedEvents = [{ type: 'complete', usage: { inputTokens: 1, outputTokens: 1, costUsd, costReporting: 'reported' } as never }];
        const events = await collectEvents(agent.chat('hi'));
        terminalReasons.push((events.at(-1) as { terminalReason?: string }).terminalReason);
      }

      expect(terminalReasons).toEqual([undefined, 'max_budget_usd']);
      agent.destroy();
    });

    // -----------------------------------------------------------------------
    // P2.36 — A PRESENT `total_cost_usd` IS NOT A PRICED ONE.
    //
    // `costReporting` was an unconditional `'reported'` here, justified by the
    // field being on every result subtype. It is; its VALUE is 0 on every result
    // from an upstream the CLI cannot price (the Nessy Gateway card, a
    // subscription, a BYO `claude-runtime` endpoint), so the adapter asserted a
    // working meter over a session that had none — and the shared classifier,
    // whose whole job is to tell "0 because free" from "0 because unpriced",
    // was handed the wrong answer to work from.
    // -----------------------------------------------------------------------
    async function reportingFor(results: Array<Record<string, unknown>>): Promise<Array<string | undefined>> {
      const verdicts: Array<string | undefined> = [];
      for (const message of results) {
        adapter.startTurn();
        const events = await adapter.adapt(message as any);
        const complete = events.find(event => event.type === 'complete') as
          { usage?: { costReporting?: string } } | undefined;
        verdicts.push(complete?.usage?.costReporting);
      }
      return verdicts;
    }

    it('an unpriced upstream reports `unsupported`, not a working meter', async () => {
      // The gateway shape: a result on every turn, `total_cost_usd` 0 on all of
      // them. Pi's adapter already says `unsupported` for exactly this, in the
      // same words; this makes the claude backend agree.
      expect(await reportingFor([costResult(0), costResult(0)])).toEqual(['unsupported', 'unsupported']);
    });

    it('CONTROL: a priced upstream still reports `reported`', async () => {
      // The negative of the row is "the claude backend stops declaring the cost
      // it really does have", so the positive is pinned on the same rig.
      expect(await reportingFor([costResult(1), costResult(2)])).toEqual(['reported', 'reported']);
    });

    it('reads the CUMULATIVE total, so a free turn under a working meter stays priced', async () => {
      // The delta of the second result is 0 (the total did not move), but the
      // meter demonstrably works — it priced turn one. A verdict off the delta
      // would call that a broken meter and fire P2.36's warning at a session
      // that is perfectly well capped.
      expect(await reportingFor([costResult(2), costResult(2)])).toEqual(['reported', 'reported']);
    });

    it('a zeroed crash result reports `unsupported` for that turn', async () => {
      // `sdk.d.ts:4359`: "Crash/startup-error results may carry zeroed values."
      // That turn's cost is genuinely unknown, and `mergeCostReporting` folds it
      // to `partial` — "a total that was ever incomplete stays incomplete",
      // which is exactly what such a session's total is.
      expect(await reportingFor([
        costResult(4),
        costResult(0, CRASHED_RESULT),
      ])).toEqual(['reported', 'unsupported']);
    });

    it('THE FIXTURE ITSELF: the crash result those cases drive really is zeroed', async () => {
      // P2.230 — the name was the only thing claiming a zeroed `usage`, and it
      // was false. This is the assertion that makes the zero load-bearing, so
      // restoring the factory's `input_tokens: 10, output_tokens: 2` (or
      // dropping the override) fails HERE rather than quietly re-planting the
      // landmark. With no assistant message this turn, the adapter reads the
      // result's own `usage` — `event-adapter.ts`'s `else` arm — which is
      // exactly the block that was never zero.
      adapter.startTurn();
      const events = await adapter.adapt(costResult(0, CRASHED_RESULT) as any);
      const complete = events.find(event => event.type === 'complete') as
        { usage?: { inputTokens?: number; outputTokens?: number } } | undefined;
      expect({
        inputTokens: complete?.usage?.inputTokens,
        outputTokens: complete?.usage?.outputTokens,
      }).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it('the per-model breakdown agrees with the top line, per model', async () => {
      // A breakdown asserting "priced" under a total saying "unsupported" is the
      // disagreement P2.42 already paid for once, in the other direction.
      adapter.startTurn();
      const events = await adapter.adapt(costResult(0, {
        modelUsage: {
          unpriced: { inputTokens: 10, outputTokens: 2, costUSD: 0 },
        },
      }) as any);
      const complete = events.find(event => event.type === 'complete') as
        { usage?: { costReporting?: string; modelUsage?: Record<string, { costReporting?: string }> } } | undefined;
      expect(complete?.usage?.costReporting).toBe('unsupported');
      expect(complete?.usage?.modelUsage?.unpriced?.costReporting).toBe('unsupported');

      adapter.startTurn();
      const priced = await adapter.adapt(costResult(3, {
        modelUsage: {
          opus: { inputTokens: 10, outputTokens: 2, costUSD: 3 },
        },
      }) as any);
      const pricedComplete = priced.find(event => event.type === 'complete') as
        { usage?: { costReporting?: string; modelUsage?: Record<string, { costReporting?: string }> } } | undefined;
      expect(pricedComplete?.usage?.costReporting).toBe('reported');
      expect(pricedComplete?.usage?.modelUsage?.opus?.costReporting).toBe('reported');
    });

    // -----------------------------------------------------------------------
    // P2.44 — A RESPAWN RESETS THE ADAPTER'S BASELINE AND MUST NOT RE-SEED THE
    // HOST'S SESSION TOTAL. THESE ARE TWO BASELINES AT TWO SCOPES.
    //
    // The trap: `total_cost_usd` is cumulative per `query()` call, so
    // `resetReportedCostTotal()` clears the ADAPTER's view of it at every spawn.
    // The host's ceiling now resumes from the SESSION's recorded spend. Conflate
    // the two and a respawn re-counts the session's whole spend — the exact
    // shape of the N(N+1)/2 inflation P2.35 removed, one scope up.
    // -----------------------------------------------------------------------
    it('a respawn mid-session re-counts nothing: the two baselines are separate', async () => {
      // Child one runs a $3 turn; the child is replaced (the reset); child two
      // runs its own $2 turn, whose running total starts again from zero. The
      // host resumes at the $4 this session had already recorded before this
      // instance existed, so the truth is 4 + 3 + 2 = 9.
      const costs = await costsFor(
        [costResult(3), costResult(2)],
        turn => { if (turn === 1) adapter.resetReportedCostTotal(); },
      );
      expect(costs).toEqual([3, 2]);

      const agent = new TestAgent(createMockBackendConfig({ getSessionSpendUsd: () => 4 }));
      agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime());
      (agent as unknown as { getMaxBudgetUsd(): number }).getMaxBudgetUsd = () => 100;
      for (const costUsd of costs) {
        agent.scriptedEvents = [{ type: 'complete', usage: { inputTokens: 1, outputTokens: 1, costUsd, costReporting: 'reported' } as never }];
        await collectEvents(agent.chat('hi'));
      }

      expect((agent as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(9);
      agent.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // P2.42 — `modelUsage` IS A RUNNING TOTAL TOO, ACROSS ALL SIX OF ITS FIELDS
  // -------------------------------------------------------------------------

  describe("the SDK's running per-model totals become this turn's own per-model usage", () => {
    /** One model's cumulative counters, in the SDK's own field names. */
    const modelTotals = (costUSD: number) => ({
      inputTokens: costUSD * 100,
      outputTokens: costUSD * 10,
      cacheReadInputTokens: costUSD * 4,
      cacheCreationInputTokens: costUSD * 2,
      webSearchRequests: costUSD,
      costUSD,
      contextWindow: 200_000,
    });

    /** One SDK result carrying every model's running totals so far. */
    const usageResult = (
      modelUsage: Record<string, Record<string, number>>,
      overrides: Record<string, unknown> = {},
    ) => ({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      is_error: false,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0,
      modelUsage,
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      session_id: 'sess-1',
      ...overrides,
    }) as any;

    type TurnMap = Record<string, PersistedModelUsage> | undefined;

    /**
     * Each result's own per-model map and top-line cost, plus the SESSION map
     * `SessionManager` folds them into — `mergeModelUsage`, the real reader,
     * whose every field is `before + turn`.
     */
    async function runResults(
      results: Array<Record<string, unknown>>,
      betweenTurns?: (turnIndex: number) => void,
    ): Promise<{ perTurn: TurnMap[]; costs: Array<number | undefined>; merged: TurnMap }> {
      const perTurn: TurnMap[] = [];
      const costs: Array<number | undefined> = [];
      let merged: TurnMap;
      for (const [index, message] of results.entries()) {
        betweenTurns?.(index);
        adapter.startTurn();
        const events = await adapter.adapt(message as any);
        const usage = (events.find(event => event.type === 'complete') as
          { usage?: { costUsd?: number; modelUsage?: Record<string, PersistedModelUsage> } } | undefined)?.usage;
        perTurn.push(usage?.modelUsage);
        costs.push(usage?.costUsd);
        merged = mergeModelUsage(merged, usage?.modelUsage);
      }
      return { perTurn, costs, merged };
    }

    it('THE CLAIM: three cumulative per-model totals merge to the latest total, not their sum', async () => {
      // `sdk.d.ts:4367` gives `modelUsage` the same wording `total_cost_usd`
      // carries at `:4359` — "Cumulative across turns in streaming-input
      // sessions: each result carries the running total so far, so read the
      // latest result rather than summing across results". `AgentEventUsage`
      // already documents its own `modelUsage` as *"This turn's per-model
      // breakdown"*, and both readers ADD (`mergeModelUsage` per field,
      // `recordUsageMetrics`' OTLP counters), so forwarding the running total
      // gave the breakdown the same N(N+1)/2 inflation P2.35 took off the top
      // line: 1 + 2 + 3 = 6 against a true 3.
      const { merged, costs } = await runResults([
        usageResult({ opus: modelTotals(1) }, { total_cost_usd: 1 }),
        usageResult({ opus: modelTotals(2) }, { total_cost_usd: 2 }),
        usageResult({ opus: modelTotals(3) }, { total_cost_usd: 3 }),
      ]);

      // All six consumption fields, not just cost — they share one sentence in
      // the SDK's docs and one `+` in every reader.
      expect(merged).toEqual({
        opus: {
          inputTokens: 300,
          outputTokens: 30,
          cacheReadTokens: 12,
          cacheCreationTokens: 6,
          webSearchRequests: 3,
          costUsd: 3,
          costReporting: 'reported',
        },
      });
      // THE POINT OF THE ROW: the top line and the breakdown are the same money.
      expect(costs.reduce((sum: number, cost) => sum + (cost ?? 0), 0)).toBe(3);
    });

    it('THE CONTROL: totals that do not move report no new consumption at all', async () => {
      // Without this, "the deltas are right" is also what forwarding the raw
      // numbers would produce for a series that happened to be flat.
      const { perTurn, merged } = await runResults([
        usageResult({ opus: modelTotals(2) }),
        usageResult({ opus: modelTotals(2) }),
        usageResult({ opus: modelTotals(5) }),
      ]);

      expect(perTurn.map(turn => turn?.opus?.costUsd)).toEqual([2, 0, 3]);
      expect(perTurn.map(turn => turn?.opus?.inputTokens)).toEqual([200, 0, 300]);
      expect(merged?.opus?.costUsd).toBe(5);
    });

    it('F1.1279: the per-model usage it emits is keyed by the bare id, never the [1m] selector', async () => {
      // The owner's F1.1241 constraint: `[1m]` lives only in the id handed to the
      // SDK. The SDK keys `modelUsage` by that wire id, so the adapter is where
      // the recorded breakdown (the session map and the OTLP counters) gets its
      // key. The running total is still differenced per WIRE key.
      const { perTurn, merged } = await runResults([
        usageResult({ 'claude-opus-4-8[1m]': modelTotals(1), 'claude-sonnet-4-6': modelTotals(0.5) }),
        usageResult({ 'claude-opus-4-8[1m]': modelTotals(3), 'claude-sonnet-4-6': modelTotals(0.5) }),
      ]);

      expect(perTurn.map(turn => Object.keys(turn ?? {}).sort())).toEqual([
        ['claude-opus-4-8', 'claude-sonnet-4-6'],
        ['claude-opus-4-8', 'claude-sonnet-4-6'],
      ]);
      expect(perTurn.map(turn => turn?.['claude-opus-4-8']?.costUsd)).toEqual([1, 2]);
      expect(merged?.['claude-opus-4-8']?.costUsd).toBe(3);
    });

    it('two models arriving on different turns each keep their OWN running total', async () => {
      const { merged } = await runResults([
        usageResult({ opus: modelTotals(1) }),
        usageResult({ opus: modelTotals(3), haiku: modelTotals(0.5) }),
        usageResult({ opus: modelTotals(3), haiku: modelTotals(2) }),
      ]);

      expect(merged?.opus?.costUsd).toBe(3);
      expect(merged?.haiku?.costUsd).toBe(2);
      expect(merged?.opus?.outputTokens).toBe(30);
      expect(merged?.haiku?.outputTokens).toBe(20);
    });

    it('THE MAP BOUNDARY: a model absent from a result reported no NEW consumption, not a reset', async () => {
      // The decided semantics, pinned. A key present, then absent, then present
      // again keeps its baseline across the gap: reading absence as "back to
      // zero" would make the reappearance re-count everything already counted,
      // and reading it as "the model is finished" would lose the gap's own
      // spend if the SDK ever elides an idle model. Nothing is claimed for a
      // model the result did not mention — the emitted map's keys are exactly
      // the result's keys.
      const { perTurn, merged } = await runResults([
        usageResult({ opus: modelTotals(5) }),
        usageResult({ haiku: modelTotals(1) }),
        usageResult({ opus: modelTotals(8), haiku: modelTotals(1) }),
      ]);

      expect(perTurn[1]?.opus).toBeUndefined();
      expect(perTurn[2]?.opus?.costUsd).toBe(3);
      expect(perTurn[2]?.haiku?.costUsd).toBe(0);
      expect(merged?.opus?.costUsd).toBe(8);
      expect(merged?.haiku?.costUsd).toBe(1);
    });

    it('a zeroed crash entry reports nothing and does NOT lower the baseline', async () => {
      // `sdk.d.ts:4367` — "crash/startup-error results may carry zeroed usage".
      // Taking that zero as the new baseline would make the next result
      // re-count every token already counted: the defect, restored by its guard.
      const { perTurn, merged } = await runResults([
        usageResult({ opus: modelTotals(4) }),
        usageResult({ opus: modelTotals(0) }, CRASHED_RESULT),
        usageResult({ opus: modelTotals(6) }),
      ]);

      expect(perTurn.map(turn => turn?.opus?.costUsd)).toEqual([4, 0, 2]);
      expect(merged?.opus?.costUsd).toBe(6);
      expect(merged?.opus?.inputTokens).toBe(600);
    });

    it('a SMALLER NON-ZERO per-model total is a restart — the same rule the top line follows', async () => {
      // The two counters disagreeing is the state this row exists to end, so the
      // backwards case is pinned on ONE rig with both numbers read off the same
      // events — and P2.46 changed what that rule IS, in both guards at once.
      //
      // This assertion used to read `[5, 0, 1]`: a backwards total was absorbed
      // as a crash, on the reasoning that the restart signal is explicit and
      // inference would double-count a revised estimate. The documented sentence
      // does not support folding them — a crash carries ZEROED usage, a restart
      // carries a smaller NON-ZERO one — and the fold's failure direction is a
      // silent, permanent UNDERCOUNT: under the old rule the 2 vanished entirely
      // and the 6 reported only 1, so 5 of the 6 dollars the child actually
      // spent were never reported to any consumer.
      const { perTurn, costs } = await runResults([
        usageResult({ opus: modelTotals(5) }, { total_cost_usd: 5 }),
        usageResult({ opus: modelTotals(2) }, { total_cost_usd: 2 }),
        usageResult({ opus: modelTotals(6) }, { total_cost_usd: 6 }),
      ]);

      expect(perTurn.map(turn => turn?.opus?.costUsd)).toEqual([5, 2, 4]);
      expect(costs).toEqual([5, 2, 4]);
    });

    it('P2.42 residual: a key EVICTED and then restarted outside a respawn now sums to its real spend', async () => {
      // P2.42 recorded this exact series as a hypothetical it could not close:
      // "a key evicted AND restarted outside a respawn (opus 5 -> absent -> 2 ->
      // 4) merges 5 against a hypothetical 9". The split closes it, and the
      // arithmetic is the reason the twin had to move with the top line: 5
      // (baseline 5), absent (baseline KEPT — the map boundary above), 2 is
      // 0 < 2 < 5 so a restart (delta 2, baseline 2), then 4 (delta 2). 5+2+2=9.
      const { perTurn, merged } = await runResults([
        usageResult({ opus: modelTotals(5) }),
        usageResult({ haiku: modelTotals(1) }),
        usageResult({ opus: modelTotals(2) }),
        usageResult({ opus: modelTotals(4) }),
      ]);

      expect(perTurn.map(turn => turn?.opus?.costUsd)).toEqual([5, undefined, 2, 2]);
      expect(merged?.opus?.costUsd).toBe(9);
    });

    it('a NEW CHILD starts its per-model totals over, and the reset is what says so', async () => {
      // `modelUsage` is scoped to one `query()` call exactly as the total is, and
      // the adapter outlives every respawn `ensureLiveSession` performs. Without
      // the reset on that spawn line the second child's smaller totals would
      // difference to nothing until they passed the dead child's peak.
      //
      // P2.46 REBUILT THIS CONTROL for the same reason as its top-line twin: on
      // the old `[3, 1, 2]` series the restart branch infers what the reset used
      // to say, so it produced `[3, 1, 1]` with AND without the reset and proved
      // nothing while still passing. MONOTONE-CROSSING instead — child two's
      // first total (5) exceeds the dead child's peak (3), which no heuristic
      // can infer.
      const { perTurn, merged } = await runResults(
        [
          usageResult({ opus: modelTotals(3) }),
          usageResult({ opus: modelTotals(5) }),
        ],
        turn => { if (turn === 1) adapter.resetReportedModelUsageTotals(); },
      );

      expect(perTurn.map(turn => turn?.opus?.costUsd)).toEqual([3, 5]);
      // Nothing lost and nothing doubled: child one's final 3 plus child two's
      // own 5, in every field.
      expect(merged?.opus?.costUsd).toBe(8);
      expect(merged?.opus?.inputTokens).toBe(800);
      expect(merged?.opus?.webSearchRequests).toBe(8);

      // THE OTHER HALF, on a fresh adapter: the identical series with no reset
      // must differ, or the reset is not what produced the reading above.
      adapter = new ClaudeEventAdapter(createCallbacks());
      const withoutReset = await runResults([
        usageResult({ opus: modelTotals(3) }),
        usageResult({ opus: modelTotals(5) }),
      ]);
      expect(withoutReset.perTurn.map(turn => turn?.opus?.costUsd)).toEqual([3, 2]);
    });
  });

  describe('system', () => {
    it('should capture sdkTools from init message', async () => {
      await adapter.adapt({
        type: 'system',
        subtype: 'init',
        tools: ['Read', 'Write', 'Bash'],
        session_id: 'sess-1',
      } as any);

      expect(adapter.sdkTools).toEqual(['Read', 'Write', 'Bash']);
    });

    it('should emit info for compact_boundary', async () => {
      const events = await adapter.adapt({
        type: 'system',
        subtype: 'compact_boundary',
        session_id: 'sess-1',
      } as any);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'info',
        message: 'Compacted Conversation',
      });
    });

    it('should emit status for compacting', async () => {
      const events = await adapter.adapt({
        type: 'system',
        subtype: 'status',
        status: 'compacting',
        session_id: 'sess-1',
      } as any);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'status',
        message: 'Compacting conversation...',
      });
    });

    it('should emit task_completed for task_notification', async () => {
      adapter.startTurn();
      const events = await adapter.adapt({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-abc123',
        status: 'completed',
        output_file: '/tmp/task-output.txt',
        summary: 'Found 3 matching files',
        session_id: 'sess-1',
      } as any);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'task_completed',
        taskId: 'agent-abc123',
        status: 'completed',
        outputFile: '/tmp/task-output.txt',
        summary: 'Found 3 matching files',
      });
    });

    it('should handle task_notification with failed status', async () => {
      adapter.startTurn();
      const events = await adapter.adapt({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-xyz',
        status: 'failed',
        output_file: '/tmp/task-error.txt',
        summary: 'Task failed with error',
        session_id: 'sess-1',
      } as any);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'task_completed',
        taskId: 'agent-xyz',
        status: 'failed',
      });
    });

    it('should handle task_notification with stopped status', async () => {
      adapter.startTurn();
      const events = await adapter.adapt({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-stopped',
        status: 'stopped',
        summary: 'User stopped the task',
        session_id: 'sess-1',
      } as any);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'task_completed',
        taskId: 'agent-stopped',
        status: 'stopped',
      });
    });

    it('should skip task_notification with missing task_id', async () => {
      adapter.startTurn();
      const events = await adapter.adapt({
        type: 'system',
        subtype: 'task_notification',
        // task_id intentionally missing
        status: 'completed',
        session_id: 'sess-1',
      } as any);

      expect(events).toHaveLength(0);
    });

    it('should default to completed for unknown task_notification status', async () => {
      adapter.startTurn();
      const events = await adapter.adapt({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-unknown',
        status: 'some_future_status',
        session_id: 'sess-1',
      } as any);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'task_completed',
        taskId: 'agent-unknown',
        status: 'completed', // defaults to completed for unknown statuses
      });
    });

    // f081 — SDKInformationalMessage: "Render `content` as plaintext at the
    // given `level`." A warning-level banner is how a UserPromptSubmit hook's
    // block reason reaches the host, so it must surface, not vanish.
    it('should emit exactly an info event with level warning for a warning informational', async () => {
      const events = await adapter.adapt({
        type: 'system',
        subtype: 'informational',
        content: 'UserPromptSubmit hook blocked the prompt: contains a secret',
        level: 'warning',
        uuid: 'uuid-1',
        session_id: 'sess-1',
      } as any);

      expect(events).toEqual([{
        type: 'info',
        message: 'UserPromptSubmit hook blocked the prompt: contains a secret',
        level: 'warning',
      }]);
    });

    it('should collapse notice, suggestion, and info levels to info', async () => {
      for (const level of ['notice', 'suggestion', 'info'] as const) {
        const events = await adapter.adapt({
          type: 'system',
          subtype: 'informational',
          content: `banner at ${level}`,
          level,
          uuid: `uuid-${level}`,
          session_id: 'sess-1',
        } as any);

        expect(events, level).toEqual([{
          type: 'info',
          message: `banner at ${level}`,
          level: 'info',
        }]);
      }
    });

    it('should emit no event for an informational with empty content', async () => {
      const events = await adapter.adapt({
        type: 'system',
        subtype: 'informational',
        content: '',
        level: 'warning',
        uuid: 'uuid-empty',
        session_id: 'sess-1',
      } as any);

      expect(events).toHaveLength(0);
    });

    // F1.1247 (final sitting SIT2-b, 2.1.274) — the SDK's prompt-block banner is
    // `<Event> operation blocked by hook:\n<reason>\n\nOriginal prompt: <prompt>`,
    // and the prompt it quotes is the HOST-DECORATED one (date preamble,
    // session_state, skills catalogue): the chat row keeps the reason only.
    it('should cut a prompt-block banner at its Original prompt section (UserPromptSubmit and UserPromptExpansion)', async () => {
      const decorated = 'USER\'S DATE AND TIME: 2026-10-01\n<session_state>sessionId: s1</session_state>\n<skills>catalogue</skills>\n\nhello';
      for (const [header, original] of [
        ['UserPromptSubmit operation blocked by hook:', decorated],
        ['UserPromptExpansion operation blocked by hook:', '/deploy prod'],
      ] as const) {
        const events = await adapter.adapt({
          type: 'system',
          subtype: 'informational',
          content: `${header}\nSIT2B-BLOCK-MARK\n\nOriginal prompt: ${original}`,
          level: 'warning',
          uuid: 'uuid-block',
          session_id: 'sess-1',
        } as any);

        expect(events, header).toEqual([{ type: 'info', message: `${header}\nSIT2B-BLOCK-MARK`, level: 'warning' }]);
      }
    });

    it('should keep an Original prompt section in an informational that is not a prompt-block banner', async () => {
      const content = 'Stop hook feedback:\nkeep going\n\nOriginal prompt: not a block banner';
      const events = await adapter.adapt({
        type: 'system',
        subtype: 'informational',
        content,
        level: 'warning',
        uuid: 'uuid-other',
        session_id: 'sess-1',
      } as any);

      expect(events).toEqual([{ type: 'info', message: content, level: 'warning' }]);
    });

    it('should emit no events for an unrecognized system subtype, leaving a debug trace', async () => {
      const debugLines: string[] = [];
      const tracingAdapter = new ClaudeEventAdapter(createCallbacks({ onDebug: msg => debugLines.push(msg) }));
      tracingAdapter.startTurn();

      // The example used to be `worker_shutting_down`, which R8 now handles —
      // every one of the SDK's declared system subtypes has an explicit branch,
      // so the fall-through can only be reached by a subtype the SDK adds later.
      // This stands in for that future subtype; the contract (emit nothing,
      // leave a trace) is unchanged.
      const events = await tracingAdapter.adapt({
        type: 'system',
        subtype: 'subtype_the_sdk_has_not_invented_yet',
        uuid: 'uuid-unknown',
        session_id: 'sess-1',
      } as any);

      expect(events).toHaveLength(0);
      expect(debugLines).toContain('Unhandled system subtype: subtype_the_sdk_has_not_invented_yet');
    });

    it('should surface a worker shutdown as a warning instead of dropping it (R8)', async () => {
      const events = await adapter.adapt({
        type: 'system',
        subtype: 'worker_shutting_down',
        reason: 'host_exit',
        uuid: 'uuid-shutdown',
        session_id: 'sess-1',
      } as any);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'info', level: 'warning' });
      expect((events[0] as any).message).toContain('host_exit');
    });
  });

  describe('auth_status', () => {
    it('should emit error for auth errors', async () => {
      const events = await adapter.adapt({
        type: 'auth_status',
        error: 'token expired',
        session_id: 'sess-1',
      } as any);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'error',
        message: 'Auth error: token expired. Try running /auth to re-authenticate.',
      });
    });

    it('should not emit events when no auth error', async () => {
      const events = await adapter.adapt({
        type: 'auth_status',
        error: null,
        session_id: 'sess-1',
      } as any);

      expect(events).toHaveLength(0);
    });
  });

  describe('flushPending', () => {
    it('should flush pending text', async () => {
      // Set pending text via assistant message
      await adapter.adapt({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'unflushed text' }],
          usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      } as any);

      const flushed = adapter.flushPending();
      expect(flushed).toMatchObject({
        type: 'text_complete',
        text: 'unflushed text',
        isIntermediate: false,
      });

      // Second flush should return null
      expect(adapter.flushPending()).toBeNull();
    });

    it('should return null when nothing pending', () => {
      expect(adapter.flushPending()).toBeNull();
    });
  });

  describe('unknown message types', () => {
    it('should log and return empty for unknown types', async () => {
      const debugMessages: string[] = [];
      const adapter = new ClaudeEventAdapter(createCallbacks({
        onDebug: (msg) => debugMessages.push(msg),
      }));
      adapter.startTurn();

      const events = await adapter.adapt({
        type: 'unknown_type',
        session_id: 'sess-1',
      } as any);

      expect(events).toHaveLength(0);
      expect(debugMessages.some(m => m.includes('Unhandled SDK message type'))).toBe(true);
    });
  });

  describe('tool start dedup across stream + assistant messages', () => {
    it('should re-emit tool_start with complete input when assistant follows stream', async () => {
      // Stream event arrives first with content_block_start (empty input)
      const streamEvents = await adapter.adapt({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool-dup-1', name: 'Read', input: {} },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      } as any);

      const streamToolStarts = streamEvents.filter(e => e.type === 'tool_start');
      expect(streamToolStarts).toHaveLength(1);
      expect(streamToolStarts[0]).toMatchObject({ toolUseId: 'tool-dup-1', toolName: 'Read', input: {} });

      // Full assistant message arrives with same tool + complete input
      const assistantEvents = await adapter.adapt({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-dup-1', name: 'Read', input: { file_path: '/test' } }],
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      } as any);

      // Should re-emit with complete input (update mechanism for UI)
      const assistantToolStarts = assistantEvents.filter(e => e.type === 'tool_start');
      expect(assistantToolStarts).toHaveLength(1);
      expect(assistantToolStarts[0]).toMatchObject({
        toolUseId: 'tool-dup-1',
        toolName: 'Read',
        input: { file_path: '/test' },
      });
    });

    it('should not re-emit when assistant has no new input', async () => {
      // Stream with empty input
      await adapter.adapt({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool-noinput-1', name: 'Read', input: {} },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      } as any);

      // Assistant also has empty input (same as stream)
      const events = await adapter.adapt({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-noinput-1', name: 'Read', input: {} }],
          usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      } as any);

      // No re-emit because input is still empty
      const toolStarts = events.filter(e => e.type === 'tool_start');
      expect(toolStarts).toHaveLength(0);
    });

    it('should handle multiple tools: re-emit known + emit new', async () => {
      // Stream for tool-a (empty input)
      await adapter.adapt({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool-a', name: 'Read', input: {} },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      } as any);

      // Assistant with tool-a (complete input) + tool-b (new)
      const events = await adapter.adapt({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-a', name: 'Read', input: { file_path: '/a' } },
            { type: 'tool_use', id: 'tool-b', name: 'Grep', input: { pattern: 'x' } },
          ],
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      } as any);

      // tool-a re-emitted with complete input + tool-b is new
      const toolStarts = events.filter(e => e.type === 'tool_start');
      expect(toolStarts).toHaveLength(2);
      expect(toolStarts[0]).toMatchObject({ toolUseId: 'tool-a', input: { file_path: '/a' } });
      expect(toolStarts[1]).toMatchObject({ toolUseId: 'tool-b', input: { pattern: 'x' } });
    });
  });

  describe('activeParentTools lifecycle', () => {
    it('should track Task tools and remove them on result', async () => {
      // Task tool start via assistant message
      await adapter.adapt({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'task-parent-1', name: 'Task', input: { prompt: 'research' } }],
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      } as any);

      expect(adapter.getActiveParentTools().has('task-parent-1')).toBe(true);

      // Task tool result via user message
      await adapter.adapt({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'task-parent-1',
            content: 'Done',
          }],
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      } as any);

      expect(adapter.getActiveParentTools().has('task-parent-1')).toBe(false);
    });

    it('should reset activeParentTools on new turn', async () => {
      await adapter.adapt({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'task-reset-1', name: 'Task', input: {} }],
          usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      } as any);

      expect(adapter.getActiveParentTools().size).toBe(1);

      adapter.startTurn();
      expect(adapter.getActiveParentTools().size).toBe(0);
    });
  });

  describe('toolIndex: tool_start → tool_result matching', () => {
    it('should match tool_result to previously started tool via toolIndex', async () => {
      // Step 1: tool_start via stream event
      await adapter.adapt({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'bash-1', name: 'Bash', input: {} },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      } as any);

      // Step 2: assistant message confirms tool (deduped)
      await adapter.adapt({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'ls' } }],
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      } as any);

      // Step 3: user message with tool result
      const resultEvents = await adapter.adapt({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'bash-1',
            content: 'file1.txt\nfile2.txt',
          }],
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      } as any);

      const toolResult = resultEvents.find(e => e.type === 'tool_result');
      expect(toolResult).toBeDefined();
      expect(toolResult).toMatchObject({
        type: 'tool_result',
        toolUseId: 'bash-1',
        toolName: 'Bash',
      });
    });

    it('should handle full multi-tool sequence: start → result → start → result', async () => {
      // Tool 1 start
      await adapter.adapt({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Let me read the file.' },
            { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/test.ts' } },
          ],
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      } as any);

      // Tool 1 result
      const result1Events = await adapter.adapt({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'read-1',
            content: 'file contents here',
          }],
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      } as any);

      expect(result1Events.find(e => e.type === 'tool_result')).toMatchObject({
        toolUseId: 'read-1',
        toolName: 'Read',
      });

      // Tool 2 start
      await adapter.adapt({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Now let me search.' },
            { type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'TODO' } },
          ],
          usage: { input_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      } as any);

      // Tool 2 result
      const result2Events = await adapter.adapt({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'grep-1',
            content: 'found 3 matches',
          }],
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      } as any);

      expect(result2Events.find(e => e.type === 'tool_result')).toMatchObject({
        toolUseId: 'grep-1',
        toolName: 'Grep',
      });
    });
  });
});

describe('buildWindowsSkillsDirError', () => {
  it('should detect Windows ENOENT skills directory error', () => {
    const result = buildWindowsSkillsDirError(
      "ENOENT: no such file or directory, scandir 'C:\\ProgramData\\ClaudeCode\\.claude\\skills'"
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe('typed_error');
    expect(result!.error.title).toBe('Windows Setup Required');
    expect(result!.error.message).toContain('C:\\ProgramData\\ClaudeCode\\.claude\\skills');
  });

  it('should return null for non-matching errors', () => {
    expect(buildWindowsSkillsDirError('Connection refused')).toBeNull();
    expect(buildWindowsSkillsDirError('ENOENT: no such file, /tmp/other')).toBeNull();
  });
});

// ============================================================================
// R8 — SDK message coverage
//
// The adapter used to reach a handler for 12 of the 39 members of `SDKMessage`
// and drop the other 27 on the floor. These tests hold that closed in two ways:
// a drift guard that re-parses the SDK's own union from `sdk.d.ts`, and
// behaviour tests for the mappings whose exact shape something downstream reads.
// ============================================================================

/**
 * One representative message per `SDKMessage` union member, keyed by the SDK's
 * own type name. The drift guard below asserts this map covers the union
 * exactly — so when the SDK adds a message type, the failure names it.
 */
const SDK_MESSAGE_FIXTURES: Record<string, Record<string, unknown>> = {
  SDKAssistantMessage: {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5 } },
    parent_tool_use_id: null,
  },
  SDKUserMessage: {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
    parent_tool_use_id: null,
  },
  SDKUserMessageReplay: {
    type: 'user',
    message: { content: [] },
    parent_tool_use_id: null,
    isReplay: true,
  },
  SDKResultMessage: {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    total_cost_usd: 0,
  },
  SDKSystemMessage: { type: 'system', subtype: 'init', tools: ['Read'], slash_commands: ['help'] },
  SDKPartialAssistantMessage: {
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'msg-1' } },
    parent_tool_use_id: null,
  },
  SDKCompactBoundaryMessage: { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 1 } },
  SDKStatusMessage: { type: 'system', subtype: 'status', status: 'compacting' },
  SDKAPIRetryMessage: {
    type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5,
    retry_delay_ms: 30_000, error_status: 429, error: 'rate_limit',
  },
  SDKControlRequestProgressMessage: {
    type: 'system', subtype: 'control_request_progress', request_id: 'r1',
    status: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: 15_000, error_status: 500,
  },
  SDKModelRefusalFallbackMessage: {
    type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'retry',
    original_model: 'model-a', fallback_model: 'model-b', request_id: null, content: 'Refused.',
  },
  SDKModelRefusalNoFallbackMessage: {
    type: 'system', subtype: 'model_refusal_no_fallback',
    original_model: 'model-a', request_id: null, content: 'Refused, nothing to fall back to.',
  },
  SDKLocalCommandOutputMessage: { type: 'system', subtype: 'local_command_output', content: 'Total cost: $1.23' },
  SDKHookStartedMessage: { type: 'system', subtype: 'hook_started', hook_id: 'h1', hook_name: 'guard', hook_event: 'PreToolUse' },
  SDKHookProgressMessage: {
    type: 'system', subtype: 'hook_progress', hook_id: 'h1', hook_name: 'guard',
    hook_event: 'PreToolUse', stdout: 'partial', stderr: '', output: '',
  },
  SDKHookResponseMessage: {
    type: 'system', subtype: 'hook_response', hook_id: 'h1', hook_name: 'guard', hook_event: 'PreToolUse',
    output: '', stdout: '', stderr: 'boom', exit_code: 2, outcome: 'error',
  },
  SDKPluginInstallMessage: { type: 'system', subtype: 'plugin_install', status: 'failed', name: 'acme', error: 'bad manifest' },
  SDKToolProgressMessage: {
    type: 'tool_progress', tool_use_id: 'tu-1', tool_name: 'Bash',
    parent_tool_use_id: null, elapsed_time_seconds: 3,
  },
  SDKAuthStatusMessage: { type: 'auth_status', isAuthenticating: false, output: [] },
  SDKTaskNotificationMessage: {
    type: 'system', subtype: 'task_notification', task_id: 't-1',
    status: 'completed', output_file: '/out', summary: 'done',
  },
  SDKTaskStartedMessage: { type: 'system', subtype: 'task_started', task_id: 't-1', description: 'Build the thing' },
  SDKTaskUpdatedMessage: { type: 'system', subtype: 'task_updated', task_id: 't-1', patch: { status: 'failed', error: 'bad' } },
  SDKTaskProgressMessage: {
    type: 'system', subtype: 'task_progress', task_id: 't-1', tool_use_id: 'tu-1',
    description: 'working', usage: { total_tokens: 10, tool_uses: 1, duration_ms: 42_000 },
  },
  SDKBackgroundTasksChangedMessage: {
    type: 'system', subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'b-1', task_type: 'shell', description: 'npm run build' }],
  },
  SDKThinkingTokensMessage: { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 100, estimated_tokens_delta: 10 },
  SDKSessionStateChangedMessage: { type: 'system', subtype: 'session_state_changed', state: 'requires_action' },
  SDKWorkerShuttingDownMessage: { type: 'system', subtype: 'worker_shutting_down', reason: 'host_exit' },
  SDKCommandsChangedMessage: {
    type: 'system', subtype: 'commands_changed',
    commands: [{ name: 'deploy', description: 'ship it', argumentHint: '' }],
  },
  SDKNotificationMessage: { type: 'system', subtype: 'notification', key: 'k', text: 'Heads up', priority: 'high' },
  SDKFilesPersistedEvent: {
    type: 'system', subtype: 'files_persisted', files: [],
    failed: [{ filename: 'a.png', error: 'too big' }], processed_at: 'now',
  },
  SDKToolUseSummaryMessage: { type: 'tool_use_summary', summary: 'read 3 files', preceding_tool_use_ids: ['a'] },
  SDKMemoryRecallMessage: {
    type: 'system', subtype: 'memory_recall', mode: 'select',
    memories: [{ path: '/m.md', scope: 'personal' }],
  },
  SDKRateLimitEvent: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } },
  SDKElicitationCompleteMessage: { type: 'system', subtype: 'elicitation_complete', mcp_server_name: 'srv', elicitation_id: 'e-1' },
  SDKPermissionDeniedMessage: {
    type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'tu-9',
    decision_reason_type: 'mode', decision_reason: 'blocked by permission mode', message: 'denied',
  },
  SDKPromptSuggestionMessage: { type: 'prompt_suggestion', suggestion: 'try running the tests' },
  SDKMirrorErrorMessage: { type: 'system', subtype: 'mirror_error', error: 'write failed', key: { projectKey: 'p', sessionId: 's' } },
  SDKInformationalMessage: { type: 'system', subtype: 'informational', content: 'note', level: 'info' },
  SDKConversationResetMessage: { type: 'conversation_reset', new_conversation_id: 'c-2' },
};

/** The `SDKMessage` union member names, read from the installed SDK typings. */
function readSdkMessageUnionMembers(): string[] {
  const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
  const typingsPath = `${sdkEntry.slice(0, sdkEntry.lastIndexOf('/'))}/sdk.d.ts`;
  const source = readFileSync(typingsPath, 'utf8');
  const match = source.match(/^export declare type SDKMessage = (.+?);$/m);
  if (!match) throw new Error(`Could not find the SDKMessage union in ${typingsPath}`);
  return match[1]!.split('|').map(name => name.trim());
}

describe('R8: SDK message coverage', () => {
  const unionMembers = readSdkMessageUnionMembers();

  it('has a fixture for every member of the SDK message union', () => {
    // The drift guard. `plugins-reference.md`-style renames and NEW message
    // types are this repo's documented recurring failure mode, and the previous
    // 27-of-39 gap accumulated exactly by nobody re-reading the union. A new
    // member fails HERE, by name, instead of silently arriving and being dropped.
    const missing = unionMembers.filter(name => !(name in SDK_MESSAGE_FIXTURES));
    const stale = Object.keys(SDK_MESSAGE_FIXTURES).filter(name => !unionMembers.includes(name));

    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
    // Guards against the regex silently matching a shorter union.
    expect(unionMembers.length).toBeGreaterThanOrEqual(39);
  });

  it('reaches an explicit branch for every union member — no message falls through', async () => {
    const unhandled: string[] = [];

    for (const [name, fixture] of Object.entries(SDK_MESSAGE_FIXTURES)) {
      const debugLines: string[] = [];
      const probe = new ClaudeEventAdapter(createCallbacks({ onDebug: line => debugLines.push(line) }));
      probe.startTurn();
      await probe.adapt({ uuid: 'u-1', session_id: 'sess-1', ...fixture } as any);

      if (debugLines.some(line =>
        line.startsWith('Unhandled SDK message type:') || line.startsWith('Unhandled system subtype:')
      )) {
        unhandled.push(name);
      }
    }

    expect(unhandled).toEqual([]);
  });

  it('surfaces an event or records a documented drop for every member', async () => {
    // The seven members with no honest destination in our AgentEvent model.
    // Each is a decision recorded in the adapter, not an oversight — changing
    // this list means changing a documented decision.
    const DELIBERATE_DROPS = new Set([
      'SDKHookProgressMessage',
      'SDKThinkingTokensMessage',
      'SDKSessionStateChangedMessage',
      'SDKElicitationCompleteMessage',
      'SDKMirrorErrorMessage',
      'SDKToolUseSummaryMessage',
      'SDKPromptSuggestionMessage',
    ]);

    const silent: string[] = [];
    for (const [name, fixture] of Object.entries(SDK_MESSAGE_FIXTURES)) {
      if (DELIBERATE_DROPS.has(name)) continue;
      // These four are lifecycle plumbing, not user-visible events: `init`
      // captures state, a replay is skipped by contract, message_start only pins
      // the turn id, and `auth_status` is silent unless it carries an `error`
      // (the fixture is the ordinary, non-error case).
      if (
        name === 'SDKSystemMessage' || name === 'SDKUserMessageReplay'
        || name === 'SDKPartialAssistantMessage' || name === 'SDKAuthStatusMessage'
      ) continue;

      const probe = new ClaudeEventAdapter(createCallbacks());
      probe.startTurn();
      const events = await probe.adapt({ uuid: 'u-1', session_id: 'sess-1', ...fixture } as any);
      if (events.length === 0) silent.push(name);
    }

    expect(silent).toEqual([]);
  });

  it('emits nothing at all for the deliberate drops', async () => {
    for (const name of [
      'SDKHookProgressMessage', 'SDKThinkingTokensMessage', 'SDKSessionStateChangedMessage',
      'SDKElicitationCompleteMessage', 'SDKMirrorErrorMessage', 'SDKToolUseSummaryMessage',
      'SDKPromptSuggestionMessage',
    ]) {
      const probe = new ClaudeEventAdapter(createCallbacks());
      probe.startTurn();
      const events = await probe.adapt({ uuid: 'u-1', session_id: 'sess-1', ...SDK_MESSAGE_FIXTURES[name]! } as any);
      expect({ name, events }).toEqual({ name, events: [] });
    }
  });
});

describe('R8: api_retry → the status vocabulary SessionManager sniffs', () => {
  let adapter: ClaudeEventAdapter;
  beforeEach(() => {
    adapter = new ClaudeEventAdapter(createCallbacks());
    adapter.startTurn();
  });

  /**
   * P6.917 — the chip's CLEAR, which this runtime did not have.
   *
   * MEASURED FIRST, because the bundle is the denominator: the vendored
   * `sdk.d.ts` publishes no retry-resolution event — `api_retry` is documented
   * as a START ("will be retried after a delay") and the only other retry
   * spelling in the file is a `TerminalReason` for structured output. So the
   * clear is INFERRED from the model speaking again, and it is asserted with a
   * control on both sides: it must not fire without a retry, and it must fire
   * exactly once.
   */
  const textDelta = (text: string) => ({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    parent_tool_use_id: null,
    session_id: 's',
  }) as any;
  const retry = () => ({
    type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3,
    retry_delay_ms: 15_000, error_status: 429, error: 'rate_limit',
    uuid: 'u', session_id: 's',
  }) as any;
  const thinkingDelta = (thinking: string) => ({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
    parent_tool_use_id: null,
    session_id: 's',
  }) as any;
  const toolInputDelta = (partial_json: string) => ({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json } },
    parent_tool_use_id: null,
    session_id: 's',
  }) as any;

  it('P6.917 — the first assistant delta after a retry clears the chip, in Pi’s own words', async () => {
    await adapter.adapt(retry());
    const events = await adapter.adapt(textDelta('Hello'));

    // BEFORE the delta, so the chip is gone by the time the first characters
    // land. Both halves come from the one builder Pi's `auto_retry_end` uses, so
    // a second spelling is not expressible (P6.916).
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: 'status',
      message: 'Retry succeeded — resuming...',
      retry: { kind: 'succeeded' },
    });
    expect(events[1]).toMatchObject({ type: 'text_delta', text: 'Hello' });
  });

  it('P6.917 — it fires ONCE, not on every delta of the same reply', async () => {
    // A second `Retry succeeded` would republish the line and re-anchor the
    // renderer's countdown, which is what the chip's arrival time drives.
    await adapter.adapt(retry());
    await adapter.adapt(textDelta('Hel'));
    const later = await adapter.adapt(textDelta('lo'));

    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ type: 'text_delta', text: 'lo' });
  });

  it('P6.917 — THE CONTROL: a delta with no retry behind it clears nothing', async () => {
    // Without this, "the chip clears" is equally satisfied by an adapter that
    // announces a retry success on every single turn.
    const events = await adapter.adapt(textDelta('Hello'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'text_delta', text: 'Hello' });
  });

  it('P6.917 — a new turn does not inherit the previous turn’s standing chip', async () => {
    // The state is per-turn, reset in `onTurnStart`. A chip surviving into the
    // next turn would announce a success for a retry that turn never had.
    await adapter.adapt(retry());
    adapter.startTurn();
    const events = await adapter.adapt(textDelta('Hello'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'text_delta', text: 'Hello' });
  });

  /**
   * D1.140 — the clear fires on ANY `content_block_delta`, not on `text_delta`
   * alone. Since C3.348 streamed reasoning, the first frames of an answer are
   * often `thinking_delta`, so the chip outlived the condition it reports.
   *
   * These two positives are deliberately taken on a turn with NO turn id, which
   * is the state `beforeEach` leaves: both the thinking branch and the tool-input
   * branch then DROP their frame, so the only event is the clear itself. That is
   * the assertion that separates "fires on the frame" from "fires on the emitted
   * row" — a clear gated on what we managed to emit would produce zero events here.
   */
  it('D1.140 — a thinking_delta after a retry clears the chip, even when the frame emits no row', async () => {
    await adapter.adapt(retry());
    const events = await adapter.adapt(thinkingDelta('Let me check'));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'status',
      message: 'Retry succeeded — resuming...',
      retry: { kind: 'succeeded' },
    });
  });

  it('D1.140 — an input_json_delta clears it too: a resumed turn can begin with a tool call', async () => {
    await adapter.adapt(retry());
    const events = await adapter.adapt(toolInputDelta('{"path":'));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'status', retry: { kind: 'succeeded' } });
  });

  it('D1.140 — THE CONTROL: it still fires ONCE across kinds — thinking then text re-emits nothing', async () => {
    // This is the case that fails on the naive fix of pasting the clear into
    // each branch: the chip is cleared by the reasoning frame, and the prose
    // that follows in the SAME reply must not republish the line.
    adapter.startTurn('t1');
    await adapter.adapt(retry());
    const first = await adapter.adapt(thinkingDelta('Let me check'));
    const later = await adapter.adapt(textDelta('Hello'));

    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({ type: 'status', retry: { kind: 'succeeded' } });
    expect(first[1]).toMatchObject({ type: 'text_delta', text: 'Let me check', turnId: 't1__thinking0' });
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ type: 'text_delta', text: 'Hello' });
  });

  it('D1.140 — THE CONTROL: a thinking_delta with no retry behind it clears nothing', async () => {
    adapter.startTurn('t1');
    const events = await adapter.adapt(thinkingDelta('Let me check'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'text_delta', turnId: 't1__thinking0' });
  });

  it('uses the "Rate limited" prefix for a rate-limit retry', async () => {
    const events = await adapter.adapt({
      type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5,
      retry_delay_ms: 30_000, error_status: 429, error: 'rate_limit',
      uuid: 'u', session_id: 's',
    } as any);

    expect(events).toHaveLength(1);
    const status = events[0] as Extract<AgentEvent, { type: 'status' }>;
    expect(status.type).toBe('status');
    // The sentence is still the wire contract with the renderer's fallback
    // parse; since P6.916 the chip itself is stamped off the FIELDS, which are
    // what the sentence is derived from.
    expect(status.message.startsWith('Rate limited')).toBe(true);
    expect(status.message).toContain('retry 2/5');
    expect(status.message).toContain('in 30s');
    expect(status.retry).toEqual({
      kind: 'rate_limit',
      attempt: 2,
      maxAttempts: 5,
      delaySeconds: 30,
    });
  });

  it('uses the "Provider error" prefix when the cause is not a rate limit', async () => {
    const events = await adapter.adapt({
      type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3,
      retry_delay_ms: 15_000, error_status: 500, error: 'server_error',
      uuid: 'u', session_id: 's',
    } as any);

    const status = events[0] as Extract<AgentEvent, { type: 'status' }>;
    expect(status.message.startsWith('Provider error')).toBe(true);
    expect(status.message).toContain('retry 1/3');
    // P6.274 (b) — the SDK's own word for the cause, adjacent to the prefix so
    // the renderer's parser reads it back. `Provider error` alone cannot tell
    // an overload from a 5xx from a dropped socket.
    expect(status.message).toContain('(server_error)');
  });

  /**
   * P6.274 (b), the negative arm: `unknown` is the SDK's own placeholder, so it
   * is not a cause to show. The HTTP status is the fallback, and a retry that
   * carries neither keeps the bare prefix rather than an empty parenthesis.
   */
  it('falls back to the HTTP status when the SDK names no cause', async () => {
    const events = await adapter.adapt({
      type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3,
      retry_delay_ms: 15_000, error_status: 503, error: 'unknown',
      uuid: 'u', session_id: 's',
    } as any);

    const status = events[0] as Extract<AgentEvent, { type: 'status' }>;
    expect(status.message.startsWith('Provider error (HTTP 503)')).toBe(true);

    const bare = await adapter.adapt({
      type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3,
      retry_delay_ms: 15_000, uuid: 'u', session_id: 's',
    } as any);
    const bareStatus = bare[0] as Extract<AgentEvent, { type: 'status' }>;
    expect(bareStatus.message).toBe('Provider error — retry 1/3 in 15s');
  });

  it('classifies off error_status when the error code is unknown', async () => {
    const events = await adapter.adapt({
      type: 'system', subtype: 'control_request_progress', request_id: 'r1',
      status: 'api_retry', attempt: 1, max_retries: 2, retry_delay_ms: 1_000,
      error_status: 429, uuid: 'u', session_id: 's',
    } as any);

    expect((events[0] as any).message.startsWith('Rate limited')).toBe(true);
  });

  it('says nothing for a control request that merely started', async () => {
    const events = await adapter.adapt({
      type: 'system', subtype: 'control_request_progress', request_id: 'r1',
      status: 'started', uuid: 'u', session_id: 's',
    } as any);

    expect(events).toEqual([]);
  });
});

describe('R8: permission, hook and refusal banners', () => {
  let adapter: ClaudeEventAdapter;
  beforeEach(() => {
    adapter = new ClaudeEventAdapter(createCallbacks());
    adapter.startTurn();
  });

  it('surfaces a denied tool as a persisted warning naming the tool and the reason', async () => {
    const events = await adapter.adapt({
      type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'tu-1',
      decision_reason_type: 'mode', decision_reason: 'blocked by permission mode',
      message: 'model-facing text', uuid: 'u', session_id: 's',
    } as any);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'info', level: 'warning' });
    expect((events[0] as any).message).toContain('Bash');
    expect((events[0] as any).message).toContain('blocked by permission mode');
  });

  /**
   * **P3.97.** The discriminator this line dropped. It is not cosmetic: the
   * binary's own reason formatter returns `undefined` for `rule`, `mode`,
   * `subcommandResults` and `permissionPromptTool`, so those denials always fall
   * back to `message` while a `classifier` denial always carries its own words —
   * which made the two shapes look alike in our record precisely when telling
   * them apart matters. The classifier is a second permission authority; a rule
   * is ours.
   */
  it('names the decision_reason_type so a classifier denial is distinguishable from a rule denial', async () => {
    const classifier = await adapter.adapt({
      type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'tu-2',
      decision_reason_type: 'classifier', decision_reason: 'Blocked by classifier',
      message: 'model-facing text', uuid: 'u', session_id: 's',
    } as any);
    expect((classifier[0] as any).message).toBe('Permission denied for Bash (classifier): Blocked by classifier');

    const rule = await adapter.adapt({
      type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'tu-3',
      decision_reason_type: 'rule', message: 'model-facing text', uuid: 'u', session_id: 's',
    } as any);
    expect((rule[0] as any).message).toBe('Permission denied for Bash (rule): model-facing text');

    // A message without the field renders exactly as it did before this row.
    const untyped = await adapter.adapt({
      type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'tu-4',
      message: 'model-facing text', uuid: 'u', session_id: 's',
    } as any);
    expect((untyped[0] as any).message).toBe('Permission denied for Bash: model-facing text');
  });

  it('surfaces a failing hook and stays quiet about a successful one', async () => {
    const failed = await adapter.adapt({
      type: 'system', subtype: 'hook_response', hook_id: 'h1', hook_name: 'guard',
      hook_event: 'PreToolUse', output: '', stdout: '', stderr: 'permission denied',
      exit_code: 2, outcome: 'error', uuid: 'u', session_id: 's',
    } as any);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ type: 'info', level: 'warning' });
    expect((failed[0] as any).message).toContain('guard');
    expect((failed[0] as any).message).toContain('permission denied');

    const ok = await adapter.adapt({
      type: 'system', subtype: 'hook_response', hook_id: 'h1', hook_name: 'guard',
      hook_event: 'PreToolUse', output: 'fine', stdout: '', stderr: '',
      exit_code: 0, outcome: 'success', uuid: 'u', session_id: 's',
    } as any);
    expect(ok).toEqual([]);
  });

  it('announces a refusal-triggered model swap with both model names', async () => {
    const events = await adapter.adapt({
      type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'retry',
      original_model: 'model-a', fallback_model: 'model-b', request_id: null,
      content: 'Switched models after a refusal.', uuid: 'u', session_id: 's',
    } as any);

    expect(events[0]).toMatchObject({ type: 'info', level: 'warning' });
    expect((events[0] as any).message).toContain('model-a');
    expect((events[0] as any).message).toContain('model-b');
  });
});

describe('R8: compaction failure and rate-limit quota', () => {
  let adapter: ClaudeEventAdapter;
  beforeEach(() => {
    adapter = new ClaudeEventAdapter(createCallbacks());
    adapter.startTurn();
  });

  it('surfaces a FAILED compaction, which previously vanished entirely', async () => {
    const events = await adapter.adapt({
      type: 'system', subtype: 'status', status: null,
      compact_result: 'failed', compact_error: 'not enough messages',
      uuid: 'u', session_id: 's',
    } as any);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'info', level: 'warning' });
    expect((events[0] as any).message).toContain('not enough messages');
  });

  it('does not double-announce a SUCCESSFUL compaction (compact_boundary owns that line)', async () => {
    const events = await adapter.adapt({
      type: 'system', subtype: 'status', status: null, compact_result: 'success',
      uuid: 'u', session_id: 's',
    } as any);
    expect(events).toEqual([]);
  });

  it('keeps the existing compacting status line byte-identical', async () => {
    const events = await adapter.adapt({
      type: 'system', subtype: 'status', status: 'compacting', uuid: 'u', session_id: 's',
    } as any);
    expect(events).toEqual([{ type: 'status', message: 'Compacting conversation...' }]);
  });

  it('stays silent on an allowed quota and warns on a rejected one', async () => {
    expect(await adapter.adapt({
      type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, uuid: 'u', session_id: 's',
    } as any)).toEqual([]);

    const rejected = await adapter.adapt({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' },
      uuid: 'u', session_id: 's',
    } as any);
    expect(rejected[0]).toMatchObject({ type: 'info', level: 'warning' });
    expect((rejected[0] as any).message).toContain('five hour');
  });

  it('renders resetsAt whether the SDK sends seconds or milliseconds', async () => {
    // `SDKRateLimitInfo.resetsAt` carries no documented unit. Both readings must
    // land in the same year rather than in 1970 or the year 56000.
    const seconds = 1_786_000_000;
    const fromSeconds = await adapter.adapt({
      type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: seconds },
      uuid: 'u', session_id: 's',
    } as any);
    const fromMillis = await adapter.adapt({
      type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: seconds * 1000 },
      uuid: 'u', session_id: 's',
    } as any);

    const year = String(new Date(seconds * 1000).getFullYear());
    expect((fromSeconds[0] as any).message).toContain(year);
    expect((fromMillis[0] as any).message).toContain(year);
  });
});

describe('R8: replace-semantics feeds are diffed, not replayed', () => {
  let adapter: ClaudeEventAdapter;
  beforeEach(() => {
    adapter = new ClaudeEventAdapter(createCallbacks());
    adapter.startTurn();
  });

  const backgroundTasks = (tasks: Array<{ task_id: string; description: string }>) => ({
    type: 'system', subtype: 'background_tasks_changed',
    tasks: tasks.map(task => ({ ...task, task_type: 'shell' })),
    uuid: 'u', session_id: 's',
  });

  /** The info lines only — the row feed is asserted on its own below. */
  const infoOf = (events: readonly unknown[]) =>
    events.filter(event => (event as { type: string }).type === 'info');
  /** The one row-feed event in an emission, or `undefined`. */
  const rowsOf = (events: readonly unknown[]) =>
    events.find(event => (event as { type: string }).type === 'background_tasks_replaced') as
      { type: string; tasks: Array<{ taskId: string; description?: string; taskType?: string }> } | undefined;

  it('announces each new background task once and ignores an identical repeat', async () => {
    const first = await adapter.adapt(backgroundTasks([{ task_id: 'b1', description: 'npm run build' }]) as any);
    expect(infoOf(first)).toHaveLength(1);
    expect((infoOf(first)[0] as any).message).toContain('npm run build');

    // REPLACE semantics: the same payload arrives again on the next change. No
    // new INFO line — that is the transition news. P6.109: the row feed still
    // re-states the set, which is idempotent and is what makes the payload's own
    // semantics expressible at all.
    const repeat = await adapter.adapt(backgroundTasks([{ task_id: 'b1', description: 'npm run build' }]) as any);
    expect(infoOf(repeat)).toEqual([]);
    expect(rowsOf(repeat)?.tasks.map(task => task.taskId)).toEqual(['b1']);

    const added = await adapter.adapt(backgroundTasks([
      { task_id: 'b1', description: 'npm run build' },
      { task_id: 'b2', description: 'npm test' },
    ]) as any);
    expect(infoOf(added)).toHaveLength(1);
    expect((infoOf(added)[0] as any).message).toContain('npm test');

    const drained = await adapter.adapt(backgroundTasks([]) as any);
    expect(infoOf(drained)).toHaveLength(1);
    expect((infoOf(drained)[0] as any).message).toContain('finished');
  });

  // ---------------------------------------------------------------------------
  // P6.109 — the ROW, and the names it needs
  // ---------------------------------------------------------------------------

  it('emits the whole set as a row feed, with each task\'s own id and description', async () => {
    // The gap: a backgrounded claude subagent became an info line and never a
    // task row, because the adapter kept the ids and DISCARDED each task's
    // `description` / `task_type`. Both halves are asserted — a feed of opaque
    // handles would satisfy an id-only check and give the user a bar of
    // nothing.
    const events = await adapter.adapt(backgroundTasks([
      { task_id: 'b1', description: 'Review the diff' },
      { task_id: 'b2', description: 'Run the suite' },
    ]) as any);

    expect(rowsOf(events)?.tasks).toEqual([
      { taskId: 'b1', description: 'Review the diff', taskType: 'shell' },
      { taskId: 'b2', description: 'Run the suite', taskType: 'shell' },
    ]);
  });

  it('retires the rows with an EMPTY set rather than by saying nothing', async () => {
    // The negative side, and the one that decides whether a stale row can offer
    // a Stop that could only be refused: an empty payload must DELIVER the empty
    // set, not omit the field.
    await adapter.adapt(backgroundTasks([{ task_id: 'b1', description: 'Review the diff' }]) as any);
    const drained = await adapter.adapt(backgroundTasks([]) as any);

    expect(rowsOf(drained)).toBeDefined();
    expect(rowsOf(drained)?.tasks).toEqual([]);
  });

  it('never mints task_backgrounded from this feed, on any of its transitions', async () => {
    // The refusal the whole design rests on: `task_backgrounded` is the Pi
    // registration seam and SessionManager reacts to it by retaining a child
    // authority, so the matching `task_completed` would deliver a monitor event
    // and start a turn. Checked across a start, a repeat and a drain rather
    // than once.
    for (const payload of [
      backgroundTasks([{ task_id: 'b1', description: 'Review the diff' }]),
      backgroundTasks([{ task_id: 'b1', description: 'Review the diff' }]),
      backgroundTasks([]),
    ]) {
      const events = await adapter.adapt(payload as any);
      expect(events.some(event => event.type === 'task_backgrounded')).toBe(false);
      expect(events.some(event => event.type === 'task_completed')).toBe(false);
    }
  });

  it('reports the level as a liveness count that falls back to zero', async () => {
    // L5 — `SessionManager`'s busy predicate reads this through
    // `ClaudeAgent.backgroundWorkCount()`, and it is the ONLY way a Claude
    // background task can reach it: every other background domain is fed by a
    // map written from `task_backgrounded`, which this adapter refuses to emit.
    //
    // The property that makes it safe to read as a level, unlike
    // `backgroundShellCommands`: it goes back DOWN. A latching count would keep
    // the session unreapable for the rest of its life.
    expect(adapter.backgroundTaskCount).toBe(0);

    await adapter.adapt(backgroundTasks([
      { task_id: 'b1', description: 'npm run build' },
      { task_id: 'b2', description: 'npm test' },
    ]) as any);
    expect(adapter.backgroundTaskCount).toBe(2);

    await adapter.adapt(backgroundTasks([{ task_id: 'b2', description: 'npm test' }]) as any);
    expect(adapter.backgroundTaskCount).toBe(1);

    await adapter.adapt(backgroundTasks([]) as any);
    expect(adapter.backgroundTaskCount).toBe(0);
  });

  it('stops reporting work the CLI child took with it when it died', async () => {
    // The one case a level cannot signal for itself: the child that owned the
    // tasks is gone, and the new one emits nothing at startup. Leaving the count
    // up here would pin the session unreapable forever on a dead holding.
    await adapter.adapt(backgroundTasks([{ task_id: 'b1', description: 'npm run build' }]) as any);
    expect(adapter.backgroundTaskCount).toBe(1);

    const notices = adapter.resetBackgroundTaskLevel();
    expect(infoOf(notices)).toHaveLength(1);
    expect(adapter.backgroundTaskCount).toBe(0);
    // P6.109 · the ROWS go with the announcement. The new child emits nothing at
    // startup, so without this the bar would keep offering a Stop for work that
    // died with the old process.
    expect(rowsOf(notices)?.tasks).toEqual([]);
  });

  it('never maps a task status patch onto task_completed', async () => {
    // `task_completed` is SessionManager's Pi background-task bookkeeping seam:
    // it writes backgroundTaskOutputs and can deliver a monitor event, which
    // STARTS A TURN. A status patch is not a settled result.
    const events = await adapter.adapt({
      type: 'system', subtype: 'task_updated', task_id: 't-1',
      patch: { status: 'failed', error: 'exited 1' }, uuid: 'u', session_id: 's',
    } as any);

    expect(events.some(event => event.type === 'task_completed')).toBe(false);
    expect(events[0]).toMatchObject({ type: 'info', level: 'warning' });
  });

  it('hides an ambient task the SDK marked skip_transcript', async () => {
    expect(await adapter.adapt({
      type: 'system', subtype: 'task_started', task_id: 't-9',
      description: 'housekeeping', skip_transcript: true, uuid: 'u', session_id: 's',
    } as any)).toEqual([]);

    const visible = await adapter.adapt({
      type: 'system', subtype: 'task_started', task_id: 't-1',
      description: 'Build the thing', uuid: 'u', session_id: 's',
    } as any);
    expect((visible[0] as any).message).toContain('Build the thing');
  });

  /**
   * I2.9 — the set `skip_transcript` alone could not see.
   *
   * At the vendored 0.3.251 `ambient` is a strict SUPERSET of `skip_transcript`,
   * not a rename: "True for housekeeping tasks the CLI does not surface as user
   * work (every skip_transcript task, plus auto-started live-update watchers)".
   * An auto-started watcher carries `ambient` WITHOUT `skip_transcript`, and it
   * used to announce itself in the transcript as ordinary user work.
   *
   * The third arm is the control and it is the load-bearing one: a task with
   * NEITHER field still reaches the transcript, so a green first arm means the
   * ambient gate fired rather than that the adapter stopped announcing tasks.
   */
  it('hides an ambient task that is NOT marked skip_transcript (I2.9)', async () => {
    expect(await adapter.adapt({
      type: 'system', subtype: 'task_started', task_id: 't-ambient',
      description: 'live-update watcher', ambient: true, uuid: 'u', session_id: 's',
    } as any)).toEqual([]);

    // Both fields together behave as before — the widening is a superset, not a swap.
    expect(await adapter.adapt({
      type: 'system', subtype: 'task_started', task_id: 't-both',
      description: 'housekeeping', ambient: true, skip_transcript: true,
      uuid: 'u', session_id: 's',
    } as any)).toEqual([]);

    // CONTROL — neither field, and the announcement still happens.
    const visible = await adapter.adapt({
      type: 'system', subtype: 'task_started', task_id: 't-user',
      description: 'Build the thing', uuid: 'u', session_id: 's',
    } as any);
    expect((visible[0] as any).message).toContain('Build the thing');
  });

  /**
   * I2.8 - `queued_turn_count` is a tripwire here rather than a feature.
   *
   * `turn-slot.ts` is "ONE `query()` per agent", one open slot, passes strictly
   * sequential - so this host never has a second send of its own in flight.
   * A non-zero count therefore cannot be ours: it means something else wrote
   * user-initiated sends to the child. The zero arm is the control, and it is
   * the load-bearing one, because a line on every result would be noise nobody
   * reads and the tripwire would be worth nothing.
   */
  it('names a non-zero queued_turn_count on a result, and stays quiet at zero (I2.8)', async () => {
    const lines: string[] = [];
    const rig = new ClaudeEventAdapter(createCallbacks({ onDebug: (line: string) => { lines.push(line) } }));
    rig.startTurn();

    await rig.adapt({
      type: 'result', subtype: 'success', is_error: false, queued_turn_count: 2,
      duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: 'ok', session_id: 's',
      total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], uuid: 'u',
    } as any);
    expect(lines.filter(line => line.includes('queued_turn_count=2'))).toHaveLength(1);

    // CONTROL - the ordinary result, which is every result this host produces.
    lines.length = 0;
    rig.startTurn();
    await rig.adapt({
      type: 'result', subtype: 'success', is_error: false, queued_turn_count: 0,
      duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: 'ok', session_id: 's',
      total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], uuid: 'u',
    } as any);
    expect(lines.filter(line => line.includes('queued_turn_count'))).toEqual([]);

    // And an absent field is not a zero-with-a-warning either.
    lines.length = 0;
    rig.startTurn();
    await rig.adapt({
      type: 'result', subtype: 'success', is_error: false,
      duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: 'ok', session_id: 's',
      total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], uuid: 'u',
    } as any);
    expect(lines.filter(line => line.includes('queued_turn_count'))).toEqual([]);
  });

  it('announces only the DELTA of commands_changed against the init baseline', async () => {
    await adapter.adapt({
      type: 'system', subtype: 'init', tools: ['Read'],
      slash_commands: ['help', 'cost'], uuid: 'u', session_id: 's',
    } as any);
    expect(adapter.sdkSlashCommands).toEqual(['help', 'cost']);

    const events = await adapter.adapt({
      type: 'system', subtype: 'commands_changed',
      commands: [
        { name: 'help', description: '', argumentHint: '' },
        { name: 'cost', description: '', argumentHint: '' },
        { name: 'deploy', description: '', argumentHint: '' },
      ],
      uuid: 'u', session_id: 's',
    } as any);

    expect(events).toHaveLength(1);
    expect((events[0] as any).message).toContain('/deploy');
    // The two commands that were already there are not re-announced.
    expect((events[0] as any).message).not.toContain('/help');
    expect(adapter.sdkSlashCommands).toEqual(['help', 'cost', 'deploy']);

    // No delta → no banner.
    expect(await adapter.adapt({
      type: 'system', subtype: 'commands_changed',
      commands: [
        { name: 'help', description: '', argumentHint: '' },
        { name: 'cost', description: '', argumentHint: '' },
        { name: 'deploy', description: '', argumentHint: '' },
      ],
      uuid: 'u', session_id: 's',
    } as any)).toEqual([]);
  });
});

/**
 * P6.1006 — `system/init` carries THREE rosters and the adapter used to keep one.
 *
 * The vendored `sdk.d.ts` declares `skills: string[]` and `agents?: string[]` in
 * the same `SDKSystemMessage` object as `slash_commands`; both were dropped, which
 * is why the RS-23 sitting case had to walk the SDK's own `.jsonl` transcript to
 * see whether a claude session had a skill at all. The typing is pinned beside the
 * behaviour so a field renamed upstream fails here rather than going quietly empty.
 */
describe('P6.1006 — init.skills and init.agents reach the roster', () => {
  let adapter: ClaudeEventAdapter;
  beforeEach(() => {
    adapter = new ClaudeEventAdapter(createCallbacks());
    adapter.startTurn();
  });

  it('the vendored SDK still declares both fields beside slash_commands', () => {
    const entry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
    const typings = readFileSync(`${entry.slice(0, entry.lastIndexOf('/'))}/sdk.d.ts`, 'utf8');
    expect(typings).toContain('skills: string[];');
    expect(typings).toContain('agents?: string[];');
    // Positive control on the same read: the roster we have always captured.
    expect(typings).toContain('slash_commands: string[];');
  });

  it('captures both rosters from the init snapshot', async () => {
    expect(await adapter.adapt({
      type: 'system', subtype: 'init', tools: ['Read'],
      slash_commands: ['help'], skills: ['pdf', 'xlsx'], agents: ['Explore', 'Plan'],
      uuid: 'u', session_id: 's',
    } as any)).toEqual([]);

    expect(adapter.sdkSkills).toEqual(['pdf', 'xlsx']);
    expect(adapter.sdkAgents).toEqual(['Explore', 'Plan']);
    // The roster that already worked is unchanged by the two new captures.
    expect(adapter.sdkSlashCommands).toEqual(['help']);
  });

  it('leaves a captured roster standing when a later init omits the field', async () => {
    await adapter.adapt({
      type: 'system', subtype: 'init', tools: [],
      slash_commands: ['help'], skills: ['pdf'], agents: ['Explore'],
      uuid: 'u', session_id: 's',
    } as any);

    // A CLI that predates `agents` (optional in the typing) sends neither, and a
    // per-turn `init` must not empty what the session was already told.
    await adapter.adapt({
      type: 'system', subtype: 'init', tools: [],
      slash_commands: ['help'], uuid: 'u', session_id: 's',
    } as any);

    expect(adapter.sdkSkills).toEqual(['pdf']);
    expect(adapter.sdkAgents).toEqual(['Explore']);
  });

  it('starts empty, so "no skills" and "not told yet" are the same silence', () => {
    expect(adapter.sdkSkills).toEqual([]);
    expect(adapter.sdkAgents).toEqual([]);
  });
});

/**
 * P3.336 — the hook stream this adapter's warning depends on.
 *
 * The `hook_response` handler above persists the only info level SessionManager
 * writes into a transcript, and it was wired to a stream nobody had turned on:
 * `git grep includeHookEvents` scored 0 across the repo (positive control on the
 * same command: `includePartialMessages`, 2), while the vendored SDK declares
 * the option and defaults it to false. SessionStart and Setup are emitted
 * regardless, so the handler was live for those two and dead for the whole
 * tool-call path — which is where a blocking hook actually costs the user a tool
 * call they cannot explain.
 *
 * Both halves are pinned: the SDK still declares the option, and our turn still
 * asks for it. Either one alone would go green while the pair was broken.
 */
describe('P3.336 — hook lifecycle events are requested, not just handled', () => {
  function sdkTypings(): string {
    const entry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
    return readFileSync(`${entry.slice(0, entry.lastIndexOf('/'))}/sdk.d.ts`, 'utf8');
  }

  it('the vendored SDK still declares the option', () => {
    const typings = sdkTypings();
    expect(typings).toContain('includeHookEvents?: boolean;');
    // Positive control on the same read: an option we have always set.
    expect(typings).toContain('includePartialMessages?: boolean;');
    // Zero control, so "the file contains words" is not what passed.
    expect(typings.includes('includeHookEventsNotARealOption')).toBe(false);
  });

  it('the turn asks for it', () => {
    const agent = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    expect(agent).toContain('includeHookEvents: true,');
    // Control: the neighbour that proves this read reached the options object.
    expect(agent).toContain('includePartialMessages: true,');
    // `claude-agent.ts` is the largest file in the package; explicit budget.
  }, 60_000);

  it('a settings-tier hook failure still reaches the transcript as a persisted warning', async () => {
    // The consequence, driven rather than asserted about the flag: with the
    // stream on, a PreToolUse failure is one `info`/`warning` event carrying the
    // hook name and its stderr. `warning` is the only level SessionManager
    // persists, so this is what survives a reload.
    const adapter = new ClaudeEventAdapter(createCallbacks());
    const events = await adapter.adapt({
      type: 'system', subtype: 'hook_response', hook_id: 'h9', hook_name: 'project-guard',
      hook_event: 'PreToolUse', output: '', stdout: '', stderr: 'blocked by policy',
      exit_code: 2, outcome: 'error', uuid: 'u', session_id: 's',
    } as any);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'info', level: 'warning' });
    expect((events[0] as any).message).toContain('project-guard');
    expect((events[0] as any).message).toContain('blocked by policy');
  });
});

describe('tool_progress heartbeats (UA12.39, upstream #1008)', () => {
  let adapter: ClaudeEventAdapter;

  beforeEach(() => {
    adapter = new ClaudeEventAdapter(createCallbacks());
    adapter.startTurn();
  });

  // Measured 2026-10-04 against the vendored CLI 2.1.274 (both self-reports):
  // a long-running tool gets a `progress` frame `toolUseID: `${id}-heartbeat-${n}``
  // (data type `tool_heartbeat`) every 30 s, and the SDK bridge yields it to the
  // adapter as a plain `tool_progress` whose tool_use_id is that heartbeat id and
  // whose parent_tool_use_id is the running tool. adaptToolProgress therefore saw
  // an UNSEEN id and opened a fresh "Running …" row per heartbeat — upstream
  // #1008: "Long-running tools no longer look like a loop". The row's live
  // control (a 90 s Bash on claude-gateway shows one tool row, not three) stays
  // with the controller's packaged sitting; these are the hermetic arms.
  const feedLongRunningBash = async () => {
    await adapter.adapt({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'sleep 90' } }],
        usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      session_id: 'sess-1',
      isReplay: false,
    } as any);
  };
  const heartbeat = (n: number, elapsed: number) => adapter.adapt({
    type: 'tool_progress',
    tool_use_id: `bash-1-heartbeat-${n}`,
    tool_name: 'Bash',
    parent_tool_use_id: 'bash-1',
    elapsed_time_seconds: elapsed,
    session_id: 'sess-1',
  } as any);

  it('a heartbeat progress updates the running row and never opens a second one', async () => {
    await feedLongRunningBash();
    const events = [
      ...await heartbeat(0, 30),
      ...await heartbeat(1, 60),
    ];
    // Two heartbeats in, nothing here may open a row: the Bash row already
    // exists. At HEAD this reads 2 — a "Running …" row per heartbeat.
    const starts = events.filter(e => e.type === 'tool_start');
    expect(starts).toHaveLength(0);
    // The heartbeats stay useful: elapsed time lands on the running row.
    expect(events.filter(e => e.type === 'task_progress').map(e => (e as any).toolUseId))
      .toEqual(['bash-1', 'bash-1']);
  });

  it('a real tool discovered through progress still opens its row', async () => {
    await feedLongRunningBash();
    const events = await adapter.adapt({
      type: 'tool_progress',
      tool_use_id: 'task-child-1',
      tool_name: 'Read',
      parent_tool_use_id: 'bash-1',
      session_id: 'sess-1',
    } as any);
    // The control on the same instrument: a NON-heartbeat unseen id is the
    // discovery path heartbeats must not be mistaken for.
    const starts = events.filter(e => e.type === 'tool_start');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ toolUseId: 'task-child-1' });
  });
});

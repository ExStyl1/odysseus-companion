/**
 * Task 7.6 — unified Pi/Codex runtime turn telemetry (open question 8).
 *
 * ONE record shape for every backend, derived from the provider-agnostic
 * `AgentEvent` stream — so Pi, Claude, and Codex turns are counted identically
 * with no per-backend special-casing. There is no analytics vendor in this repo;
 * the sink is the existing `perf` metric store.
 */
import type { AgentEvent } from '@nessy-agent/core/types';
import type { ModelProvider } from '../config/models.ts';
import perf from '../utils/perf.ts';

export interface RuntimeTurnTelemetry {
  provider: ModelProvider;
  model: string;
  turnId: string;
  toolCalls: number;
  toolCallFailures: number;
  invalidJsonCount: number;
  reasoningLeaked: boolean;
  durationMs: number;
  retryCount: number;
}

export interface RuntimeTurnTelemetryInput {
  provider: ModelProvider;
  model: string;
  turnId: string;
  events: AgentEvent[];
  durationMs?: number;
  /** Adapter retry rungs used this turn (Codex); 0 for backends without retry. */
  retryCount?: number;
}

/**
 * Reduce a turn's `AgentEvent` stream to the unified telemetry record. Purely a
 * function of the events + a little meta — identical logic for every provider.
 */
export function buildRuntimeTurnTelemetry(input: RuntimeTurnTelemetryInput): RuntimeTurnTelemetry {
  const { events } = input;
  const toolStarts = events.filter((e): e is Extract<AgentEvent, { type: 'tool_start' }> => e.type === 'tool_start');
  const toolResults = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
  const text = events
    .filter((e): e is Extract<AgentEvent, { type: 'text_delta' | 'text_complete' }> => e.type === 'text_delta' || e.type === 'text_complete')
    .map((e) => e.text ?? '')
    .join('');

  return {
    provider: input.provider,
    model: input.model,
    turnId: input.turnId,
    toolCalls: toolStarts.length,
    toolCallFailures: toolResults.filter((e) => e.isError).length,
    // From the mapped stream, a tool_start always carries a parsed object input;
    // a missing/non-object input signals an upstream JSON-parse failure.
    invalidJsonCount: toolStarts.filter((e) => !e.input || typeof e.input !== 'object').length,
    reasoningLeaked: /<think>|<\/think>|reasoning_content/.test(text),
    durationMs: input.durationMs ?? 0,
    retryCount: input.retryCount ?? 0,
  };
}

/**
 * Sink the record into the existing perf metric store (retrievable via
 * `perf.getRecentMetrics()`).
 * ponytail: local structured record reuses the perf sink; wire to a real
 * analytics vendor only if product asks.
 */
export function recordRuntimeTurnTelemetry(telemetry: RuntimeTurnTelemetry): void {
  perf.span('runtime.turn', { ...telemetry }).end();
}

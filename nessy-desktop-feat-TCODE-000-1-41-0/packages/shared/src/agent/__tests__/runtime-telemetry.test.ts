/**
 * Task 7.6 gate: a Codex event sequence and a Pi event sequence produce the
 * SAME-SHAPED RuntimeTurnTelemetry record with correct counts — proving the
 * telemetry is provider-agnostic (derived from the shared AgentEvent stream).
 */
import { test, expect, describe } from 'bun:test';
import type { AgentEvent } from '@nessy-agent/core/types';
import { buildRuntimeTurnTelemetry, recordRuntimeTurnTelemetry, type RuntimeTurnTelemetry } from '../runtime-telemetry.ts';
import perf from '../../utils/perf.ts';

// A text→command→complete turn, expressed in the shared AgentEvent vocabulary.
const codexEvents: AgentEvent[] = [
  { type: 'text_delta', text: 'working ' },
  { type: 'tool_start', toolName: 'Bash', toolUseId: 'c1', input: { command: 'ls' } },
  { type: 'tool_result', toolUseId: 'c1', toolName: 'Bash', result: 'files', isError: false },
  { type: 'text_complete', text: 'done' },
  { type: 'complete' },
];
const piEvents: AgentEvent[] = [
  { type: 'text_delta', text: 'ok ' },
  { type: 'tool_start', toolName: 'Bash', toolUseId: 'p1', input: { command: 'pwd' } },
  { type: 'tool_result', toolUseId: 'p1', toolName: 'Bash', result: 'boom', isError: true },
  { type: 'text_complete', text: 'finished' },
  { type: 'complete' },
];

describe('unified runtime turn telemetry', () => {
  test('Codex and Pi turns produce identically-shaped records', () => {
    const c = buildRuntimeTurnTelemetry({ provider: 'codex-runtime', model: 'tgpt/qwen35-397b-a17b-fp8', turnId: 't1', events: codexEvents, durationMs: 1200, retryCount: 1 });
    const p = buildRuntimeTurnTelemetry({ provider: 'pi', model: 'some-pi-model', turnId: 't2', events: piEvents, durationMs: 800 });
    expect(Object.keys(c).sort()).toEqual(Object.keys(p).sort());
    // both count one tool call
    expect(c.toolCalls).toBe(1);
    expect(p.toolCalls).toBe(1);
    // failures differ by outcome, not by provider handling
    expect(c.toolCallFailures).toBe(0);
    expect(p.toolCallFailures).toBe(1);
    expect(c.retryCount).toBe(1);
    expect(p.retryCount).toBe(0);
  });

  test('reasoning leakage is flagged when <think> appears in assistant text', () => {
    const leaky = buildRuntimeTurnTelemetry({ provider: 'codex-runtime', model: 'm', turnId: 't', events: [{ type: 'text_complete', text: '<think>secret</think>answer' }] });
    expect(leaky.reasoningLeaked).toBe(true);
    const clean = buildRuntimeTurnTelemetry({ provider: 'codex-runtime', model: 'm', turnId: 't', events: [{ type: 'text_complete', text: 'answer' }] });
    expect(clean.reasoningLeaked).toBe(false);
  });

  test('the 7.4 eval metrics are derivable from the record', () => {
    const t: RuntimeTurnTelemetry = buildRuntimeTurnTelemetry({ provider: 'codex-runtime', model: 'm', turnId: 't', events: codexEvents });
    // tool-call success = (toolCalls - failures) / toolCalls; valid-json = 1 - invalidJson/toolCalls
    expect((t.toolCalls - t.toolCallFailures) / t.toolCalls).toBe(1);
    expect(1 - t.invalidJsonCount / t.toolCalls).toBe(1);
  });

  test('recordRuntimeTurnTelemetry sinks into the perf metric store', () => {
    perf.setEnabled(true);
    perf.clearMetrics();
    const t = buildRuntimeTurnTelemetry({ provider: 'codex-runtime', model: 'm', turnId: 'sink-test', events: codexEvents });
    recordRuntimeTurnTelemetry(t);
    const rec = perf.getRecentMetrics().find((m) => m.name === 'runtime.turn' && m.metadata?.turnId === 'sink-test');
    expect(rec).toBeTruthy();
    expect(rec!.metadata!.provider).toBe('codex-runtime');
  });
});

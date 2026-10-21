/**
 * F1.1073 (origin DN-269, 2026-09-28) — a Pi turn's `complete` carries EVERY model call's tokens and cost.
 *
 * pi-ai puts a `Usage` on each `AssistantMessage`, one per response, so a turn that calls a tool makes two or more
 * model calls and reports two or more usages. The adapter kept only the latest (`lastUsage`, overwritten per
 * `message_end`) and `agent_end` reported it, so the session totals, the goal record and `maxBudgetUsd`'s accumulator
 * saw only the LAST call: two calls of 5 tokens / 0.50 USD and 7 tokens / 0.25 USD totalled 7 / 0.25. Pi's own
 * `AgentSession.getSessionStats` (`@earendil-works/pi-coding-agent` 0.85.1, `dist/core/usage-totals.js`
 * `addUsageToTotals`) adds `output` and `cost.total` of every assistant message — the sum below is that arithmetic,
 * over one turn. The context size stays the latest call's: the host reads `inputTokens` as the context the session
 * holds, and each call re-sends the whole conversation.
 */
import { describe, expect, it } from 'bun:test';
import { PiEventAdapter } from './event-adapter.ts';

function usage(input: number, output: number, cacheRead: number, cost: number) {
  return { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { total: cost } };
}

function assistantEnd(stopReason: 'toolUse' | 'stop', callUsage: ReturnType<typeof usage>, id: string) {
  return {
    type: 'message_end',
    message: { role: 'assistant', stopReason, content: [{ type: 'text', text: `call ${id}` }], id, usage: callUsage },
  };
}

function run(adapter: PiEventAdapter, events: Array<Record<string, unknown>>) {
  const out: any[] = [];
  for (const event of events) out.push(...adapter.adaptEvent(event as never));
  return out;
}

const completeOf = (events: any[]) => events.filter(event => event.type === 'complete');

describe('F1.1073 — a multi-call Pi turn reports the sum of its model calls', () => {
  it('THE DEFECT — two model calls (5 / 0.50 then 7 / 0.25) end in ONE complete carrying 12 / 0.75, context size from the latest call', () => {
    const adapter = new PiEventAdapter();
    adapter.setContextWindow(200_000);
    adapter.startTurn();
    const events = run(adapter, [
      { type: 'agent_start' },
      { type: 'turn_start' }, assistantEnd('toolUse', usage(100, 5, 0, 0.5), 'm1'), { type: 'turn_end' },
      { type: 'turn_start' }, assistantEnd('stop', usage(130, 7, 20, 0.25), 'm2'), { type: 'turn_end' },
      { type: 'agent_end', messages: [] },
    ]);

    const completes = completeOf(events);
    expect(completes).toHaveLength(1);
    expect(completes[0].usage).toMatchObject({
      inputTokens: 150, // the latest call's input + cache read: the context the session now holds
      outputTokens: 12,
      cacheReadTokens: 20,
      cacheCreationTokens: 0,
      costUsd: 0.75,
      contextWindow: 200_000,
      costReporting: 'reported',
    });
  });

  it('BOUNDARY — a turn whose only model call FAILED reports no usage, not the previous turn\'s (no charge carried across turns)', () => {
    const adapter = new PiEventAdapter();
    adapter.startTurn();
    const first = run(adapter, [
      { type: 'agent_start' },
      { type: 'turn_start' }, assistantEnd('stop', usage(100, 5, 0, 0.5), 'm1'), { type: 'turn_end' },
      { type: 'agent_end', messages: [] },
    ]);
    expect(completeOf(first)[0].usage).toMatchObject({ outputTokens: 5, costUsd: 0.5 });

    adapter.startTurn();
    const second = run(adapter, [
      { type: 'agent_start' },
      { type: 'turn_start' },
      // pi-ai stamps a usage on a failed response too; the adapter's error arm never counts it.
      { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '400 Bad Request: invalid tool schema', content: [], id: 'm2', usage: usage(0, 0, 0, 0) } },
      { type: 'turn_end' },
      { type: 'agent_end', messages: [] },
    ]);
    expect(second.some(event => event.type === 'typed_error' || event.type === 'error')).toBe(true);
    const completes = completeOf(second);
    expect(completes).toHaveLength(1);
    expect(completes[0].usage).toBeUndefined();
  });

  it('CONTROL — a single-call turn reports that call unchanged, and an unpriced call stays unsupported', () => {
    const adapter = new PiEventAdapter();
    adapter.startTurn();
    const events = run(adapter, [
      { type: 'agent_start' },
      { type: 'turn_start' }, assistantEnd('stop', usage(40, 3, 10, 0), 'm1'), { type: 'turn_end' },
      { type: 'agent_end', messages: [] },
    ]);
    expect(completeOf(events)[0].usage).toMatchObject({
      inputTokens: 50,
      outputTokens: 3,
      cacheReadTokens: 10,
      costUsd: 0,
      costReporting: 'unsupported',
    });
  });
});

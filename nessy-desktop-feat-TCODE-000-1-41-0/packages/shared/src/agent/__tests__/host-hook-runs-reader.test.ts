/**
 * P6.828 — the READER half. W9-ai landed the producer: `executeAgentEvent`'s
 * result now publishes `hookRuns`, one `HookRunObservation` per host hook that
 * actually RAN, successes included. Until this reader existed,
 * `BaseAgent.emitAutomationEvent` read only `hookErrors`, so a clean host hook
 * left no trace anywhere and `/hooks` showed a run history of failures alone.
 *
 * Two properties, and the second is the one that makes the change safe rather
 * than merely additive:
 *
 * 1. When `hookRuns` is present it is the source — successes are recorded.
 * 2. It is a FALLBACK relationship, never two sources. A failing run appears in
 *    BOTH arrays at the producer, so reading both would record it twice; a
 *    result from some other `AgentAutomationSystem` implementation that carries
 *    only `hookErrors` must still have its failures recorded.
 *
 * Driven through the real `emitAutomationEvent` with a stub automation system,
 * because the subject is the reader's PREFERENCE and a test that called
 * `recordHookRun` directly would pass with the reader deleted.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentAutomationSystem, AgentEventExecutionResult } from '../../automations/types.ts';
import type { HookRunObservation } from '../hook-run-report.ts';
import { TestAgent, createMockBackendConfig } from './test-utils.ts';

/** The store, read the way `/hooks` reads it. */
function storedRuns(agent: unknown): Array<{ label: string; outcomes: string[] }> {
  const groups = (agent as {
    hookRuns: { groups(): Array<{ label: string; runs: Array<{ outcome: string }> }> };
  }).hookRuns.groups();
  return groups
    .map(group => ({ label: group.label, outcomes: group.runs.map(run => run.outcome) }))
    // The store groups by hook and does not promise an order across hooks; the
    // subject here is WHICH runs were recorded and how many, never their order.
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** An agent whose automation system answers every event with `result`. */
async function emitWith(result: AgentEventExecutionResult): Promise<TestAgent> {
  const agent = new TestAgent(createMockBackendConfig());
  agent.setAutomationSystem({
    executeAgentEvent: async () => result,
  } as unknown as AgentAutomationSystem);
  await (agent as unknown as {
    emitAutomationEvent(event: string, input: unknown): Promise<unknown>;
  }).emitAutomationEvent('SessionStart', {});
  return agent;
}

const SUCCESS: HookRunObservation = {
  runtime: 'host',
  event: 'SessionStart',
  name: 'guard/no-secrets',
  outcome: 'success',
  exitCode: 0,
};

const FAILURE: HookRunObservation = {
  runtime: 'host',
  event: 'SessionStart',
  name: 'guard/lint',
  outcome: 'error',
  exitCode: 2,
};

describe('P6.828 · emitAutomationEvent prefers hookRuns', () => {
  it('records the successes hookErrors structurally cannot carry', async () => {
    // POSITIVE. Before the reader this array was ignored entirely and a clean
    // run produced no record at all, on every runtime.
    const agent = await emitWith({ matchedCount: 1, hookRuns: [SUCCESS] } as AgentEventExecutionResult);

    expect(storedRuns(agent)).toEqual([{ label: 'guard/no-secrets', outcomes: ['success'] }]);
  });

  it('does not ALSO read hookErrors — one failing run is recorded once', async () => {
    // NEGATIVE / boundary, and the reason `hookRuns` is a fallback rather than
    // an addition: the producer publishes a failure in both arrays, so a reader
    // that concatenated them would show every failure twice in `/hooks`.
    const agent = await emitWith({
      matchedCount: 2,
      hookRuns: [SUCCESS, FAILURE],
      hookErrors: [{ event: 'SessionStart', hookName: 'guard/lint', exitCode: 2, detail: 'boom' }],
    } as unknown as AgentEventExecutionResult);

    expect(storedRuns(agent)).toEqual([
      { label: 'guard/lint', outcomes: ['error'] },
      { label: 'guard/no-secrets', outcomes: ['success'] },
    ]);
  });

  it('falls back to hookErrors when the result carries no hookRuns', async () => {
    // The interface is public: another `AgentAutomationSystem` implementation
    // may publish only the notices, and dropping this branch would silently
    // lose every failure it reports.
    const agent = await emitWith({
      matchedCount: 1,
      hookErrors: [{ event: 'SessionStart', hookName: 'guard/lint', exitCode: 2, detail: 'boom' }],
    } as unknown as AgentEventExecutionResult);

    expect(storedRuns(agent)).toEqual([{ label: 'guard/lint', outcomes: ['error'] }]);
  });
});

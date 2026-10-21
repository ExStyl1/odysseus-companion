/**
 * P6.276 — the host arm of the session turn cap: the shared loop counts for a
 * backend that has no cap of its own.
 *
 * The other two arms are native and already landed, which is why this one is
 * opt-IN: Pi counts `turn_start` inside its own loop and force-aborts at N+1
 * (eight pinned cases), and claude projects the same setting onto the SDK's
 * `Options.maxTurns`. Counting those two here as well would be a regression
 * dressed as coverage. Codex is the arm that needs it — its `config-schema.json`
 * has zero `max_turn*` keys — and its one-line opt-in is a hand-off to that
 * file's holder.
 *
 * ## The measurement this row demanded FIRST, recorded here
 *
 * There is no `turn_start` in `AgentEvent` at all: Pi's is a Pi-SDK event
 * consumed inside `pi-agent.ts` before adaptation. The nearest per-adapter
 * boundaries are NOT equivalent either — claude sets `text_complete` +
 * `isIntermediate` exactly when `stop_reason === 'tool_use'` (a real
 * model-response boundary), while codex sets the same flag on REASONING
 * summaries and PLAN items, several of which can arrive inside ONE model
 * response. Counting `text_complete` would over-count codex badly.
 *
 * So the unit is the MODEL ROUND-TRIP: the first model call, plus one per group
 * of consecutive tool activity the model comes back from. Parallel tool calls in
 * one response are one group. It is not Pi's unit and does not claim to be.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentEvent } from '@nessy-agent/core/types';
import { TestAgent, createMockBackendConfig, collectEvents, createMockCapabilityTurnRuntime } from './test-utils.ts';

function agentWithTurnCap(cap: number, script: AgentEvent[], opts: { hostCounts: boolean }) {
  const agent = new TestAgent(createMockBackendConfig());
  // `BaseAgent.chat()` refuses to run without one — see the helper's own note.
  agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime());
  (agent as unknown as { countsAgentTurnsInSharedLoop: boolean }).countsAgentTurnsInSharedLoop = opts.hostCounts;
  (agent as unknown as { getMaxAgentTurnsCeiling(): number }).getMaxAgentTurnsCeiling = () => cap;
  (agent as unknown as { scriptedEvents: AgentEvent[] }).scriptedEvents = script;
  return agent;
}

const toolStart = (id: string): AgentEvent => ({
  type: 'tool_start', toolName: 'Bash', toolUseId: id, input: {},
});
const toolResult = (id: string): AgentEvent => ({
  type: 'tool_result', toolUseId: id, result: 'ok', isError: false,
});
const text = (value: string): AgentEvent => ({ type: 'text_complete', text: value });

const terminal = (events: AgentEvent[]) =>
  events.filter((event): event is AgentEvent & { type: 'complete' } => event.type === 'complete');

describe('P6.276 the host turn ceiling', () => {
  it('ends the turn with max_agent_turns when the round-trips exceed the cap', async () => {
    const agent = agentWithTurnCap(2, [
      text('thinking'),
      toolStart('a'), toolResult('a'),   // round-trip 2
      text('more'),
      toolStart('b'), toolResult('b'),   // round-trip 3 — over the cap of 2
      text('never reached'),
      { type: 'complete' },
    ], { hostCounts: true });

    const events = await collectEvents(agent.chat('go'));

    const completes = terminal(events);
    expect(completes).toHaveLength(1);
    expect(completes[0]!.terminalReason).toBe('max_agent_turns');
    // The breaching tool call never runs: the cap is checked BEFORE the event
    // is yielded, so the round-trip that breaches is the one that ends the turn.
    expect(events.some(event => event.type === 'tool_start' && event.toolUseId === 'b')).toBe(false);
    expect(events.some(event => event.type === 'text_complete' && event.text === 'never reached')).toBe(false);
  });

  it('counts PARALLEL tool calls in one response as ONE round-trip', async () => {
    const agent = agentWithTurnCap(2, [
      text('one response, three tools'),
      toolStart('a'), toolStart('b'), toolStart('c'),
      toolResult('a'), toolResult('b'), toolResult('c'),
      text('done'),
      { type: 'complete' },
    ], { hostCounts: true });

    const events = await collectEvents(agent.chat('go'));

    // Two round-trips: the first model call and the one it came back for. A
    // per-`tool_start` count would have ended this turn at the cap.
    expect(terminal(events)[0]!.terminalReason).toBeUndefined();
    expect(events.some(event => event.type === 'text_complete' && event.text === 'done')).toBe(true);
  });

  it('changes nothing for a backend that did not ask the host to count', async () => {
    const agent = agentWithTurnCap(1, [
      text('a'), toolStart('a'), toolResult('a'),
      text('b'), toolStart('b'), toolResult('b'),
      text('c'),
      { type: 'complete' },
    ], { hostCounts: false });

    const events = await collectEvents(agent.chat('go'));

    // Pi and claude are exactly here: their own arms enforce the same setting,
    // and a second count under one name would end their turns early.
    expect(terminal(events)[0]!.terminalReason).toBeUndefined();
    expect(events.some(event => event.type === 'text_complete' && event.text === 'c')).toBe(true);
  });

  it('a cap of 0 is off, even when the host is counting', async () => {
    const agent = agentWithTurnCap(0, [
      text('a'), toolStart('a'), toolResult('a'),
      text('b'), toolStart('b'), toolResult('b'),
      text('c'),
      { type: 'complete' },
    ], { hostCounts: true });

    const events = await collectEvents(agent.chat('go'));

    expect(terminal(events)[0]!.terminalReason).toBeUndefined();
    expect(events.some(event => event.type === 'text_complete' && event.text === 'c')).toBe(true);
  });
});

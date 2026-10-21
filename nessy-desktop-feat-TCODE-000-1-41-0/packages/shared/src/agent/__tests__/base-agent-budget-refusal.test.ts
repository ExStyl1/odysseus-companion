/**
 * P2.258 — A USD CEILING IS NOT SET ON A RUNTIME THAT REPORTS NO COST.
 *
 * Owner-delegated controller decision 2026-09-02 (§E2): **refuse to set a USD
 * ceiling on codex while codex reports no cost.** The 2026-09-01 pattern applied
 * to a cap — a control that cannot control is not offered.
 *
 * What was wrong before is subtle and is the reason this file exists. The cap
 * DID run for codex; it simply never fired, because `classifyEventCost` never
 * returned `priced` on a backend that stamps `costReporting: 'unsupported'`. So
 * the ceiling was inert by ACCIDENT, one per-turn verdict at a time, and from
 * the outside that is indistinguishable from a ceiling that has not been reached
 * yet. `BaseAgent.exceedsMaxBudgetUsd` now refuses on the RUNTIME's own
 * declaration ({@link BaseAgent.reportsCostUsd}), which is a stated posture
 * rather than an emergent one.
 *
 * The two properties that have to hold together, and each has a test below:
 *
 * 1. **The declaration outranks a stray per-turn `reported`.** This is the whole
 *    difference between the old behaviour and the new one — under the old code a
 *    non-pricing runtime that emitted one `reported` event WOULD have been
 *    capped. It is also what makes `CodexAgent.reportsCostUsd`'s override
 *    load-bearing, so that deleting it the day a cost source lands (its own
 *    docblock carries that instruction) is what re-arms the cap.
 * 2. **It is not a silencing.** `takeUnenforceableBudgetNotice` is handed the
 *    CONFIGURED ceiling by both call sites, not this verdict, so the user is
 *    still told once per session that the limit cannot be enforced here.
 *
 * Positive control on the same rig: a runtime that DOES report cost is still
 * capped, so a green run here cannot come from a cap that stopped working
 * everywhere.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentEvent } from '@nessy-agent/core/types';
import { TestAgent, createMockBackendConfig, collectEvents, createMockCapabilityTurnRuntime } from './test-utils.ts';

function agent(maxBudgetUsd: number, scripted: AgentEvent[], reportsCost: boolean): TestAgent {
  const built = new TestAgent(createMockBackendConfig());
  built.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime());
  built.scriptedEvents = scripted;
  ;(built as unknown as { getMaxBudgetUsd(): number }).getMaxBudgetUsd = () => maxBudgetUsd;
  ;(built as unknown as { reportsCostUsd(): boolean }).reportsCostUsd = () => reportsCost;
  return built;
}

/** A turn the backend priced above any sane ceiling. */
const pricedOverCeiling: AgentEvent = {
  type: 'complete',
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 99, costReporting: 'reported' } as never,
};

function terminalReasons(events: AgentEvent[]): Array<string | undefined> {
  return events
    .filter(event => event.type === 'complete')
    .map(event => (event as { terminalReason?: string }).terminalReason);
}

describe('P2.258 — the ceiling refuses to arm where cost is not reported', () => {
  it('POSITIVE CONTROL: a runtime that reports cost is still capped', async () => {
    // Without this the whole file is satisfiable by deleting the cap.
    const capped = agent(5, [pricedOverCeiling], true);
    expect(terminalReasons(await collectEvents(capped.chat('hi')))).toContain('max_budget_usd');
    capped.destroy();
  });

  it('a runtime declaring it reports no cost is NOT capped, even on an event that claims a price', async () => {
    // MUTATION KILLED: dropping the `reportsCostUsd()` guard from
    // `exceedsMaxBudgetUsd`. The old code capped here — the per-turn `reported`
    // verdict was the only input — so this is the assertion that pins the
    // declaration as the one that outranks it.
    const refused = agent(5, [pricedOverCeiling], false);
    const reasons = terminalReasons(await collectEvents(refused.chat('hi')));
    expect(reasons).not.toContain('max_budget_usd');
    refused.destroy();
  });

  it('the session spend counter does not advance on a runtime that cannot price', async () => {
    // The accumulator lives inside the same guard, so a half-fix that returned
    // early without moving the `+=` would leave a total nobody can spend.
    const refused = agent(5, [pricedOverCeiling], false);
    await collectEvents(refused.chat('hi'));
    expect((refused as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(0);
    refused.destroy();
  });

  it('NOT A SILENCING: the "your limit cannot be enforced" notice still fires', async () => {
    // MUTATION KILLED: keying `takeUnenforceableBudgetNotice` off the
    // enforcement verdict instead of the configured ceiling, which would make
    // the refusal invisible — a cap that quietly stops applying is the exact
    // fail-open-that-looks-fine shape P2.36 removed.
    const refused = agent(5, [{ type: 'complete' }], false);
    const events = await collectEvents(refused.chat('hi'));
    const notice = events.find(
      event => event.type === 'info' && (event as { level?: string }).level === 'warning',
    );
    expect(notice).toBeDefined();
    refused.destroy();
  });

  it('an unset ceiling stays unset on both kinds of runtime', async () => {
    // The `maxBudgetUsd <= 0` guard runs first; the new guard must not turn a
    // no-cap session into anything at all.
    for (const reportsCost of [true, false]) {
      const uncapped = agent(0, [pricedOverCeiling], reportsCost);
      const events = await collectEvents(uncapped.chat('hi'));
      expect(terminalReasons(events)).not.toContain('max_budget_usd');
      expect(events.some(
        event => event.type === 'info' && (event as { level?: string }).level === 'warning',
      )).toBe(false);
      uncapped.destroy();
    }
  });
});

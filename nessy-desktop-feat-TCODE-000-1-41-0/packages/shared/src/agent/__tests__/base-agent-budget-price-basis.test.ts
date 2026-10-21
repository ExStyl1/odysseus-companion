/**
 * P6.706 — the USD cap fires against the OPERATOR'S price table, not only the
 * runtime's own figure.
 *
 * P6.537 gave the host a managed `modelPricing` table and wired the readout to
 * it: `ChatDisplay.usage-format.ts`'s `resolveModelCost` prefers the operator's
 * rates over the runtime's list price. The cap did not move with it, so on a
 * priced organization the number a user read in `/usage` and the number that
 * stopped their turn came from two different places — the exact divergence class
 * this plan keeps removing, in the one surface where it costs money.
 *
 * Three arms, and the middle one is the row's control:
 *
 * 1. **A table entry for the session's model** — the cap trips at the TABLE's
 *    price, on a stub turn whose token counts are known and whose runtime figure
 *    is deliberately far under the ceiling.
 * 2. **No table** — it trips exactly as it did before, on the runtime's figure.
 * 3. **A table that does not name this model** — same as (2). A model the
 *    operator never priced is not free and is not guessed at; `managedRatesFor`
 *    implements no prefix or family match, on purpose.
 *
 * And the fourth property, which is the row's last clause: the trip says WHICH
 * basis it used.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { AgentEvent } from '@nessy-agent/core/types';
import {
  setManagedModelPricing,
  type ManagedModelPricing,
} from '../../config/managed-model-prices.ts';
import {
  TestAgent,
  createMockBackendConfig,
  collectEvents,
  createMockCapabilityTurnRuntime,
} from './test-utils.ts';

function agent(maxBudgetUsd: number, scripted: AgentEvent[], model: string): TestAgent {
  const built = new TestAgent(createMockBackendConfig());
  built.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime());
  built.scriptedEvents = scripted;
  ;(built as unknown as { getMaxBudgetUsd(): number }).getMaxBudgetUsd = () => maxBudgetUsd;
  ;(built as unknown as { _model: string })._model = model;
  return built;
}

/**
 * One turn, priced by the runtime at ten cents and carrying two million output
 * tokens. Under a $5 ceiling on the runtime's own figure; over it at the
 * operator's $4/M output rate ($8).
 */
const TURN: AgentEvent = {
  type: 'complete',
  usage: {
    inputTokens: 1_000_000,
    outputTokens: 2_000_000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.1,
    costReporting: 'reported',
  } as never,
};

const OPERATOR_TABLE: ManagedModelPricing = {
  overrides: { 'house-model': { input: 1, output: 4 } },
};

function terminalReasons(events: AgentEvent[]): Array<string | undefined> {
  return events
    .filter(event => event.type === 'complete')
    .map(event => (event as { terminalReason?: string }).terminalReason);
}

function infoMessages(events: AgentEvent[]): string[] {
  return events
    .filter(event => event.type === 'info')
    .map(event => (event as { message?: string }).message ?? '');
}

afterEach(() => {
  // The table is a PROCESS registry, so a test that left one armed would price
  // every suite that runs after it in the same process.
  setManagedModelPricing(undefined);
});

describe('P6.706 — the cap reads the operator table where a price exists', () => {
  it('trips at the TABLE\'s price on a turn the runtime priced far under the ceiling', async () => {
    setManagedModelPricing(OPERATOR_TABLE);
    const capped = agent(5, [TURN], 'house-model');
    expect(terminalReasons(await collectEvents(capped.chat('hi')))).toContain('max_budget_usd');
    capped.destroy();
  });

  it('CONTROL — with no table it trips as it did before, on the runtime\'s figure', async () => {
    // $0.10 against a $5 ceiling: the same turn, unpriced by any operator, does
    // NOT trip. Without this the first test is satisfiable by a cap that fires
    // on everything.
    const uncapped = agent(5, [TURN], 'house-model');
    expect(terminalReasons(await collectEvents(uncapped.chat('hi')))).not.toContain('max_budget_usd');
    uncapped.destroy();
  });

  it('CONTROL — a table that does not name this model changes nothing', async () => {
    // No prefix and no family match: `managedRatesFor` implements neither, so a
    // model the operator never priced keeps the runtime's basis rather than
    // borrowing a neighbour's rates.
    setManagedModelPricing(OPERATOR_TABLE);
    const other = agent(5, [TURN], 'some-other-model');
    expect(terminalReasons(await collectEvents(other.chat('hi')))).not.toContain('max_budget_usd');
    other.destroy();
  });

  it('a bare multiplier re-bases the runtime\'s own figure, per the page', async () => {
    // `settings-reference.md#modelpricing`'s second arm: a multiplier with no
    // override re-bases an established figure. 0.1 x 100 = $10 > $5.
    setManagedModelPricing({ multiplier: 100 });
    const scaled = agent(5, [TURN], 'house-model');
    expect(terminalReasons(await collectEvents(scaled.chat('hi')))).toContain('max_budget_usd');
    scaled.destroy();
  });
});

describe('P6.706 — the trip names its basis', () => {
  it('says the organization\'s table when that is what it counted with', async () => {
    setManagedModelPricing(OPERATOR_TABLE);
    const capped = agent(5, [TURN], 'house-model');
    const events = await collectEvents(capped.chat('hi'));
    const messages = infoMessages(events).join('\n');
    expect(messages).toContain('$5');
    expect(messages.toLowerCase()).toContain("organization");
    capped.destroy();
  });

  it('says the runtime when no table priced the session', async () => {
    // The same turn against a ceiling low enough that the runtime's own $0.10
    // trips it, so the two messages are compared on the same code path.
    const capped = agent(0.01, [TURN], 'house-model');
    const messages = infoMessages(await collectEvents(capped.chat('hi'))).join('\n');
    expect(messages).toContain('$0.01');
    expect(messages.toLowerCase()).toContain('runtime');
    expect(messages.toLowerCase()).not.toContain('organization');
    capped.destroy();
  });

  it('never renders a raw key or an empty sentence', async () => {
    // The measured failure `takeUnenforceableBudgetNotice` guards against: an
    // i18next singleton nobody initialized returns `undefined` from `t()`, and
    // the headless entry never calls `setupI18n()`.
    const capped = agent(0.01, [TURN], 'house-model');
    const messages = infoMessages(await collectEvents(capped.chat('hi')));
    const trip = messages.find(message => message.includes('$0.01'));
    expect(trip).toBeDefined();
    expect(trip).not.toContain('chat.budget.');
    expect(trip!.trim().length).toBeGreaterThan(20);
    capped.destroy();
  });
});

describe('P6.729 — an operator table arms the cap on a runtime that reports no cost', () => {
  /**
   * The codex shape, measured rather than imagined: `codex-agent.ts`'s
   * `withCodexUsage` stamps `inputTokens`/`outputTokens` on the turn's own
   * `complete` beside `costReporting: 'unsupported'`, because the app-server
   * payload carries token counts and no money field at all. So the table has a
   * real input and the runtime still produced no figure.
   */
  const CODEX_TURN: AgentEvent = {
    type: 'complete',
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 2_000_000,
      costReporting: 'unsupported',
    } as never,
  };

  function unmeteredAgent(maxBudgetUsd: number, model: string): TestAgent {
    const built = agent(maxBudgetUsd, [CODEX_TURN], model);
    ;(built as unknown as { reportsCostUsd(): boolean }).reportsCostUsd = () => false;
    return built;
  }

  it('trips at the table price on a turn the runtime priced not at all', async () => {
    setManagedModelPricing(OPERATOR_TABLE);
    const capped = unmeteredAgent(5, 'house-model');
    expect(terminalReasons(await collectEvents(capped.chat('hi')))).toContain('max_budget_usd');
    capped.destroy();
  });

  it('CONTROL — without a table entry the runtime stays uncapped, exactly as today', async () => {
    setManagedModelPricing(OPERATOR_TABLE);
    const other = unmeteredAgent(5, 'some-other-model');
    expect(terminalReasons(await collectEvents(other.chat('hi')))).not.toContain('max_budget_usd');
    other.destroy();
  });

  it('CONTROL — a bare multiplier does NOT arm it: there is no figure to re-base', async () => {
    setManagedModelPricing({ multiplier: 100 });
    const scaled = unmeteredAgent(5, 'house-model');
    expect(terminalReasons(await collectEvents(scaled.chat('hi')))).not.toContain('max_budget_usd');
    scaled.destroy();
  });

  it('the trip names the managed basis', async () => {
    setManagedModelPricing(OPERATOR_TABLE);
    const capped = unmeteredAgent(5, 'house-model');
    const messages = infoMessages(await collectEvents(capped.chat('hi'))).join('\n');
    expect(messages).toContain('$5');
    expect(messages.toLowerCase()).toContain('organization');
    capped.destroy();
  });

  it('and it no longer says the cap cannot be enforced on a turn the table priced', async () => {
    // The honesty half. `chat.budget.notMetered` is a true sentence about a
    // codex session with no table and a FALSE one the moment the operator
    // prices the model, because the cap above now stops the turn.
    setManagedModelPricing(OPERATOR_TABLE);
    const capped = unmeteredAgent(5, 'house-model');
    const messages = infoMessages(await collectEvents(capped.chat('hi'))).join('\n').toLowerCase();
    expect(messages).not.toContain('cannot be enforced');
    capped.destroy();
  });

  it('CONTROL — with no table it still says so, once', async () => {
    const unpriced = unmeteredAgent(5, 'house-model');
    const messages = infoMessages(await collectEvents(unpriced.chat('hi'))).join('\n').toLowerCase();
    expect(messages).toContain('cannot be enforced');
    unpriced.destroy();
  });
});

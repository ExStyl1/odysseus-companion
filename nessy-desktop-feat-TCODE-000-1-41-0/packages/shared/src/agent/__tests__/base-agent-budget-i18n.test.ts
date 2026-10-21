/**
 * P2.130 — the unenforceable-budget notice is LOCALIZED, not an English literal.
 *
 * Its own file, and the language is switched in AWAITED hooks, for the reason
 * `server-core/src/handlers/rpc/auth.i18n.test.ts` records: an un-awaited
 * `changeLanguage` restore can resolve after the NEXT file's English-expecting
 * tests have started, which CI measured as eight unrelated reds.
 *
 * The mutation each test kills is named on the test.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import type { AgentEvent } from '@nessy-agent/core/types';
import { i18n, setupI18n } from '../../i18n/index.ts';
import en from '../../i18n/locales/en.json';
import ru from '../../i18n/locales/ru.json';
import { TestAgent, createMockBackendConfig, collectEvents } from './test-utils.ts';
import { createMockCapabilityTurnRuntime } from './test-utils.ts';

const UNENFORCEABLE_KEY = 'chat.budget.unenforceable';
const NOT_METERED_KEY = 'chat.budget.notMetered';

function agentWithBudget(maxBudgetUsd: number, scripted: AgentEvent[], meters = true): TestAgent {
  const budgeted = new TestAgent(createMockBackendConfig());
  budgeted.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime());
  budgeted.scriptedEvents = scripted;
  ;(budgeted as unknown as { getMaxBudgetUsd(): number }).getMaxBudgetUsd = () => maxBudgetUsd;
  if (!meters) (budgeted as unknown as { reportsCostUsd(): boolean }).reportsCostUsd = () => false;
  return budgeted;
}

async function noticeMessage(agent: TestAgent): Promise<string | undefined> {
  const events = await collectEvents(agent.chat('hi'));
  const notice = events.find(event => event.type === 'info' && (event as { level?: string }).level === 'warning');
  return notice ? (notice as { message: string }).message : undefined;
}

const unpricedComplete: AgentEvent = {
  type: 'complete',
  usage: { inputTokens: 1, outputTokens: 10, costReporting: 'unsupported' } as never,
};

describe('the unenforceable-budget notice is keyed', () => {
  beforeAll(async () => {
    setupI18n();
    await i18n.changeLanguage('ru');
  });
  afterAll(async () => { await i18n.changeLanguage('en'); });

  it('renders the Russian string, so an English literal cannot survive', async () => {
    // MUTATION KILLED: replacing `i18n.t('chat.budget.unenforceable', …)` with
    // the English literal this row removed. Asserted on IDENTITY with the
    // locale entry rather than on a phrase — a `toContain('лимит')` would also
    // pass for a half-translated sentence.
    const agent = agentWithBudget(5, [unpricedComplete]);
    const message = await noticeMessage(agent);
    expect(message).toBe(i18n.t(UNENFORCEABLE_KEY, { limit: '$5' }));
    expect(message).toBe((ru as Record<string, string>)[UNENFORCEABLE_KEY]!.replace('{{limit}}', '$5'));
    expect(message).not.toBe((en as Record<string, string>)[UNENFORCEABLE_KEY]!.replace('{{limit}}', '$5'));
    agent.destroy();
  });

  it('renders the Russian string for the not-metered case too', async () => {
    // MUTATION KILLED: keying only one of the two branches — the P2.128 branch
    // is newer and is exactly the one a partial fix would leave hardcoded.
    const agent = agentWithBudget(5, [{ type: 'complete' }], false);
    const message = await noticeMessage(agent);
    expect(message).toBe(i18n.t(NOT_METERED_KEY, { limit: '$5' }));
    expect(message).not.toBe(i18n.t(UNENFORCEABLE_KEY, { limit: '$5' }));
    agent.destroy();
  });

  it('interpolates the configured ceiling into both locales', async () => {
    // MUTATION KILLED: dropping the `{{limit}}` interpolation argument, which
    // leaves a grammatical sentence that no longer names the user's own limit.
    const agent = agentWithBudget(12.5, [unpricedComplete]);
    const message = await noticeMessage(agent);
    expect(message).toContain('$12.5');
    agent.destroy();

    await i18n.changeLanguage('en');
    const english = agentWithBudget(12.5, [unpricedComplete]);
    const englishMessage = await noticeMessage(english);
    expect(englishMessage).toContain('$12.5');
    expect(englishMessage).toContain('cannot be enforced');
    english.destroy();
    await i18n.changeLanguage('ru');
  });

  it('P2.238 · an unmetered runtime gets the PERMANENT wording even after a priceless usage arrived', async () => {
    // MUTATION KILLED: restoring `cost.kind === 'absent' && !reportsCostUsd()`.
    // Before P2.238 the sentence a codex user read depended on whether a
    // `thread/tokenUsage/updated` had landed yet: with one, `usage` arrives
    // stamped `unsupported` and the notice said "reported no cost for the turn"
    // — a permanent property of the runtime described as a per-turn accident.
    const agent = agentWithBudget(5, [unpricedComplete], false);
    const message = await noticeMessage(agent);
    expect(message).toBe(i18n.t(NOT_METERED_KEY, { limit: '$5' }));
    expect(message).not.toBe(i18n.t(UNENFORCEABLE_KEY, { limit: '$5' }));
    agent.destroy();
  });

  it('CONTROL: a runtime that CAN price keeps the per-turn wording', async () => {
    // The other direction, and the reason the fix is keyed on the declaration
    // rather than on the shape of the accounting: for claude and Pi "no cost for
    // the turn" is the true claim, and widening the permanent wording to them
    // would latch a false one for the rest of the session.
    const agent = agentWithBudget(5, [unpricedComplete]);
    const message = await noticeMessage(agent);
    expect(message).toBe(i18n.t(UNENFORCEABLE_KEY, { limit: '$5' }));
    expect(message).not.toBe(i18n.t(NOT_METERED_KEY, { limit: '$5' }));
    agent.destroy();
  });

  it('P6.796 · both notices name the token limit as the other route, in both languages', () => {
    // MUTATION KILLED: reverting either sentence to the single-route wording it
    // shipped with. Both keys used to end with "switch to a connection that
    // reports cost" and nothing else, which was the whole truth until P6.645
    // landed `workspaceDefaults.maxBudgetTokens` (declaration `8f6979257`,
    // reader `409ca7a91`): a runtime that reports no cost still honours a TOKEN
    // ceiling, so the notice was sending the user to change connections for a
    // limit they could already have had.
    //
    // Asserted on the setting's own name rather than on a phrase, because the
    // phrase is what a translator legitimately rewrites and the identifier is
    // what makes the sentence actionable.
    for (const locale of [en, ru] as Array<Record<string, string>>) {
      for (const key of [UNENFORCEABLE_KEY, NOT_METERED_KEY]) {
        expect(locale[key], key).toContain('maxBudgetTokens');
      }
    }
    // CONTROL, and not decoration: the dollar route is the ONLY way to a limit
    // in dollars, and `base-agent.ts` quotes this clause verbatim as "the
    // instructive half". Adding the token route must not have replaced it.
    for (const key of [UNENFORCEABLE_KEY, NOT_METERED_KEY]) {
      expect((en as Record<string, string>)[key], key)
        .toContain('switch to a connection that reports cost');
    }
  });

  it('both keys exist in every locale, with the interpolation placeholder intact', () => {
    // MUTATION KILLED: adding the key to en.json only — parity/sorted would
    // catch a missing key, but not a translation that dropped `{{limit}}`.
    for (const locale of [en, ru] as Array<Record<string, string>>) {
      for (const key of [UNENFORCEABLE_KEY, NOT_METERED_KEY]) {
        expect(locale[key], key).toBeDefined();
        expect(locale[key], key).toContain('{{limit}}');
      }
    }
  });
});

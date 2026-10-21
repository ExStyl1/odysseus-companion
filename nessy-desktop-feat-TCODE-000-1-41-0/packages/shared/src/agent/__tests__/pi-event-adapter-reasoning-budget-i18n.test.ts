/**
 * UB12.24 — the Pi "reasoning ate the output budget" notice (UB2.5, R14-24) is
 * READ from `chat.reasoningAteBudget`, not an English literal.
 *
 * UB2.5 landed the key in en and ru and then emitted the en text as a literal,
 * so the key had no reader (`lint:i18n:reachable` red) and a Russian user read
 * English. These arms pin the reader.
 *
 * Its own file, with the language switched in AWAITED hooks, for the reason
 * `base-agent-budget-i18n.test.ts` and `server-core/src/handlers/rpc/auth.i18n.test.ts`
 * record: an un-awaited `changeLanguage` restore can land after the NEXT file's
 * English-expecting tests have started.
 *
 * The mutation each test kills is named on the test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PiEventAdapter } from '../backend/pi/event-adapter.ts';
import { i18n, setupI18n } from '../../i18n/index.ts';
import en from '../../i18n/locales/en.json';
import ru from '../../i18n/locales/ru.json';

const SENTENCE_KEY = 'chat.reasoningAteBudget';
const COUNT_KEY = 'chat.tokensUsed';

function expected(locale: Record<string, string>, outputTokens: number): string {
  return `${locale[SENTENCE_KEY]!} (${locale[COUNT_KEY]!.replace('{{displayCount}}', String(outputTokens))})`;
}

function infosFor(adapter: PiEventAdapter, stopReason: 'stop' | 'toolUse', output: number): Array<{ message: string; level?: string }> {
  [...adapter.adaptEvent({ type: 'turn_start' } as never)];
  const events = [...adapter.adaptEvent({
    type: 'message_end',
    message: { role: 'assistant', stopReason, content: '', usage: { input: 1000, output, cacheRead: 0 } },
  } as never)];
  return events.filter(event => event.type === 'info') as Array<{ message: string; level?: string }>;
}

describe('UB12.24 — the reasoning-ate-budget notice reads its key', () => {
  let adapter: PiEventAdapter;

  beforeAll(async () => {
    setupI18n();
    await i18n.changeLanguage('ru');
  });
  afterAll(async () => { await i18n.changeLanguage('en'); });
  beforeEach(() => {
    adapter = new PiEventAdapter();
    adapter.startTurn();
  });

  it('POSITIVE — a Russian host reads the ru key, sentence and count, and no English survives', () => {
    // MUTATION KILLED: restoring UB2.5's English literal (the sentence or the
    // "(output tokens: N)" tail). Asserted on IDENTITY with the locale entries,
    // not on a phrase — a toContain('бюджет') would pass a half-translated line.
    const infos = infosFor(adapter, 'stop', 4199);
    expect(infos).toHaveLength(1);
    expect(infos[0]!.level).toBe('warning');
    expect(infos[0]!.message).toBe(expected(ru as Record<string, string>, 4199));
    expect(infos[0]!.message).not.toContain((en as Record<string, string>)[SENTENCE_KEY]!);
    expect(infos[0]!.message).not.toContain('output tokens');
  });

  it('BOUNDARY — the language is read at EMIT time: switching to en mid-run gives the en entries', async () => {
    // MUTATION KILLED: resolving the sentence once (module level or at adapter
    // construction) instead of per notice — AGENTS.md i18n rule 1. The adapter
    // was built under ru in beforeEach; only an emit-time read gives en here.
    await i18n.changeLanguage('en');
    try {
      const infos = infosFor(adapter, 'stop', 512);
      expect(infos).toHaveLength(1);
      expect(infos[0]!.message).toBe(expected(en as Record<string, string>, 512));
    } finally {
      await i18n.changeLanguage('ru');
    }
  });

  it('NEGATIVE — an intermediate (toolUse) textless message still emits nothing under ru', () => {
    // MUTATION KILLED: moving the keyed emit outside UB2.5's final-message guard
    // while wiring the reader.
    expect(infosFor(adapter, 'toolUse', 4199)).toHaveLength(0);
  });
});

import { describe, expect, test } from 'bun:test';

import {
  createWebSearchBudget,
  DEFAULT_MAX_WEB_SEARCHES_PER_SESSION,
  MAX_WEB_SEARCHES_PER_SESSION_COMPAT_ENV,
  MAX_WEB_SEARCHES_PER_SESSION_ENV,
  resolveMaxWebSearchesPerSession,
} from '../web-search-budget.ts';
import { resetNumericSettingReports } from '../numeric-setting.ts';

describe('resolveMaxWebSearchesPerSession', () => {
  // env-vars.md, the `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` row — "Accepts a
  // positive whole number with no upper bound. Anything else is ignored and the
  // default applies, so the cap can be raised but not turned off."
  //
  // That row notes NO plain-digits restriction, so `env-vars.md#variables`
  // governs the spelling: "Numeric variables such as timeouts, token budgets,
  // and retry counts accept scientific notation and digit-separator spellings
  // in addition to plain digits, except where a variable's row notes it takes
  // plain digits only. For example, Claude Code reads `2e3` as 2000 and
  // `64_000` as 64000." The sibling subagent-depth knob IS such an exception,
  // which is why the two readers are no longer the same one.
  test.each([
    [undefined, DEFAULT_MAX_WEB_SEARCHES_PER_SESSION],
    ['50', 50],
    [' 50 ', 50],
    ['1', 1],
    ['999999', 999999],
    // No disable value: 0 and negatives fall back, never mean "unlimited".
    ['0', DEFAULT_MAX_WEB_SEARCHES_PER_SESSION],
    ['-1', DEFAULT_MAX_WEB_SEARCHES_PER_SESSION],
    // The page's own two examples, verbatim in value.
    ['2e3', 2000],
    ['64_000', 64_000],
    ['1e3', 1000],
    ['1_000', 1000],
    // Hex, signs, a non-integer float and a stray separator stay refused.
    ['0x20', DEFAULT_MAX_WEB_SEARCHES_PER_SESSION],
    ['2.5', DEFAULT_MAX_WEB_SEARCHES_PER_SESSION],
    ['+3', DEFAULT_MAX_WEB_SEARCHES_PER_SESSION],
    ['1__0', DEFAULT_MAX_WEB_SEARCHES_PER_SESSION],
    ['1e', DEFAULT_MAX_WEB_SEARCHES_PER_SESSION],
    // Pre-v2.1.211 is the bug this spelling rule exists to fix: `1e6` must be
    // 1000000, never 1.
    ['1e6', 1_000_000],
    ['abc', DEFAULT_MAX_WEB_SEARCHES_PER_SESSION],
    ['', DEFAULT_MAX_WEB_SEARCHES_PER_SESSION],
    ['  ', DEFAULT_MAX_WEB_SEARCHES_PER_SESSION],
  ])('NESSY_MAX_WEB_SEARCHES_PER_SESSION=%p -> %p', (value, expected) => {
    const env = value === undefined ? {} : { [MAX_WEB_SEARCHES_PER_SESSION_ENV]: value };
    // Silent sink: the table exercises the VALUES; the report has its own test.
    expect(resolveMaxWebSearchesPerSession(env, () => {})).toBe(expected);
  });

  test('accepts the documented Claude spelling as a compat alias', () => {
    expect(resolveMaxWebSearchesPerSession({
      [MAX_WEB_SEARCHES_PER_SESSION_COMPAT_ENV]: '77',
    })).toBe(77);
  });

  test('the Nessy spelling wins when both are set, even when it is invalid', () => {
    expect(resolveMaxWebSearchesPerSession({
      [MAX_WEB_SEARCHES_PER_SESSION_ENV]: '25',
      [MAX_WEB_SEARCHES_PER_SESSION_COMPAT_ENV]: '77',
    })).toBe(25);
    // Defined-but-malformed Nessy value shadows the alias and falls back to the
    // default — the subagent-spawn-depth aliased-pair discipline.
    expect(resolveMaxWebSearchesPerSession({
      [MAX_WEB_SEARCHES_PER_SESSION_ENV]: 'nope',
      [MAX_WEB_SEARCHES_PER_SESSION_COMPAT_ENV]: '77',
    }, () => {})).toBe(DEFAULT_MAX_WEB_SEARCHES_PER_SESSION);
  });

  test('a refused value is SAID, with the name that was actually read', () => {
    resetNumericSettingReports();
    const said: string[] = [];
    expect(resolveMaxWebSearchesPerSession(
      { [MAX_WEB_SEARCHES_PER_SESSION_COMPAT_ENV]: '0x20' },
      m => { said.push(m); },
    )).toBe(DEFAULT_MAX_WEB_SEARCHES_PER_SESSION);
    expect(said).toHaveLength(1);
    // The alias was the one read, so the alias is the one named — a report
    // naming the other spelling would send the user to the wrong line.
    expect(said[0]).toContain(MAX_WEB_SEARCHES_PER_SESSION_COMPAT_ENV);
    expect(said[0]).not.toContain(MAX_WEB_SEARCHES_PER_SESSION_ENV);
  });

  test('default limit is 200', () => {
    expect(DEFAULT_MAX_WEB_SEARCHES_PER_SESSION).toBe(200);
  });
});

describe('createWebSearchBudget', () => {
  test('consumes up to the limit, then refuses without charging', () => {
    const budget = createWebSearchBudget(2);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.used()).toBe(2);
    expect(budget.remaining()).toBe(0);
  });

  test('seed sets the absolute base and an over-limit seed caps immediately', () => {
    const budget = createWebSearchBudget(5);
    budget.seed(3);
    expect(budget.used()).toBe(3);
    expect(budget.remaining()).toBe(2);
    expect(budget.tryConsume()).toBe(true);
    budget.seed(9);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.remaining()).toBe(0);
  });

  test('seed sanitizes malformed values to zero and floors fractions', () => {
    const budget = createWebSearchBudget(5);
    budget.seed(Number.NaN);
    expect(budget.used()).toBe(0);
    budget.seed(-4);
    expect(budget.used()).toBe(0);
    budget.seed(2.9);
    expect(budget.used()).toBe(2);
  });

  test('reset returns the count to zero (tools-reference.md:451 — /clear)', () => {
    const budget = createWebSearchBudget(1);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    budget.reset();
    expect(budget.used()).toBe(0);
    expect(budget.tryConsume()).toBe(true);
  });
});

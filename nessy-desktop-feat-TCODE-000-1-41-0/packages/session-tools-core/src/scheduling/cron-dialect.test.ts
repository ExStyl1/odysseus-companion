import { describe, expect, it, test } from 'bun:test';
import {
  CronDialectError,
  cronIntervalMs,
  isRecurrenceRule,
  isValidCronExpression,
  matchesCronExpression,
  matchesDayFields,
  nextCronRun,
  parseCronExpression,
  recurrenceRuleToCron,
} from './cron-dialect.ts';

describe('the documented dialect (`scheduled-tasks.md:191`, `:202`)', () => {
  test.each([
    ['*/5 * * * *', 'every 5 minutes'],
    ['0 * * * *', 'every hour on the hour'],
    ['7 * * * *', 'every hour at 7 minutes past'],
    ['0 9 * * *', 'every day at 9am local'],
    ['0 9 * * 1-5', 'weekdays at 9am local'],
    ['30 14 15 3 *', 'March 15 at 2:30pm local'],
    ['1,15,30 * * * *', 'comma list'],
    ['0 9 * * 0', 'Sunday as 0'],
    ['0 9 * * 7', 'Sunday as 7'],
  ])('parses %s (%s)', expression => {
    expect(() => parseCronExpression(expression)).not.toThrow();
  });

  test('0 and 7 are the same Sunday (`:202`)', () => {
    expect([...parseCronExpression('0 9 * * 7').daysOfWeek]).toEqual([0]);
    expect([...parseCronExpression('0 9 * * 0,7').daysOfWeek]).toEqual([0]);
  });

  // `:202` — "Extended syntax like `L`, `W`, `?`, and name aliases such as
  // `MON` or `JAN` is not supported." An unsupported token is an ERROR naming
  // the token, not an expression that silently never matches.
  test.each([
    ['0 9 L * *', 'L'],
    ['0 9 1W * *', 'W'],
    ['0 9 ? * 1', '?'],
    ['0 9 * * MON', 'MON'],
    ['0 9 * JAN *', 'JAN'],
    ['0 9 * * 1#2', '#'],
  ])('refuses %s, naming %s', (expression, token) => {
    let thrown: unknown;
    try {
      parseCronExpression(expression);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CronDialectError);
    expect((thrown as Error).message).toContain(token);
  });

  test.each([
    ['0 9 * *', 'four fields'],
    ['0 9 * * * *', 'six fields'],
    ['', 'empty'],
    ['60 9 * * *', 'minute out of range'],
    ['0 24 * * *', 'hour out of range'],
    ['0 9 32 * *', 'day-of-month out of range'],
    ['0 9 * 13 *', 'month out of range'],
    ['0 9 * * 8', 'day-of-week out of range'],
    ['5-1 9 * * *', 'reversed range'],
    ['*/0 * * * *', 'zero step'],
  ])('refuses %s (%s)', expression => {
    expect(() => parseCronExpression(expression)).toThrow(CronDialectError);
  });
});

describe('DOM+DOW both constrained matches on EITHER field (`:204`)', () => {
  // March 2026: the 13th is a Friday, and Mondays fall on the 2nd, 9th, 16th,
  // 23rd and 30th. `0 9 13 3 1` constrains BOTH day fields, so the or-reading
  // matches six dates and the and-reading matches NONE — the two readings are
  // maximally far apart on this one fixture.
  const parsed = parseCronExpression('0 9 13 3 1');
  const at = (day: number) => new Date(2026, 2, day, 9, 0, 0, 0);

  test('both day fields are recognised as restricted', () => {
    expect(parsed.dayOfMonthRestricted).toBe(true);
    expect(parsed.dayOfWeekRestricted).toBe(true);
  });

  test('the OR reading: the 13th matches although it is a Friday', () => {
    expect(at(13).getDay()).toBe(5);
    expect(matchesDayFields(parsed, at(13))).toBe(true);
    expect(matchesCronExpression(parsed, at(13))).toBe(true);
  });

  test('the OR reading: Monday the 16th matches although it is not the 13th', () => {
    expect(at(16).getDay()).toBe(1);
    expect(matchesDayFields(parsed, at(16))).toBe(true);
  });

  test('the AND reading is asserted apart and is NOT what we implement', () => {
    const andReading = (date: Date) =>
      parsed.daysOfMonth.has(date.getDate()) && parsed.daysOfWeek.has(date.getDay());
    // Every date the AND reading would reject and the contract requires we accept.
    for (const day of [2, 9, 13, 16, 23, 30]) {
      expect(andReading(at(day)), `AND would reject March ${day}`).toBe(false);
      expect(matchesDayFields(parsed, at(day)), `OR must accept March ${day}`).toBe(true);
    }
    // And a date BOTH readings reject, so the or-rule is not simply "always true".
    expect(matchesDayFields(parsed, at(14))).toBe(false);
  });

  // The independent cross-check against croner, an existing vixie-cron
  // implementation, lives in `packages/shared/src/sessions/__tests__/
  // cron-dialect-oracle.test.ts` — croner is a dependency of `shared`, not of
  // this package.

  test('one restricted day field alone still decides on its own', () => {
    const weekdays = parseCronExpression('0 9 * * 1-5');
    expect(weekdays.dayOfMonthRestricted).toBe(false);
    expect(matchesDayFields(weekdays, new Date(2026, 2, 14))).toBe(false);
    expect(matchesDayFields(weekdays, new Date(2026, 2, 16))).toBe(true);

    const fifteenth = parseCronExpression('30 14 15 3 *');
    expect(fifteenth.dayOfWeekRestricted).toBe(false);
    expect(matchesDayFields(fifteenth, new Date(2026, 2, 15))).toBe(true);
    expect(matchesDayFields(fifteenth, new Date(2026, 2, 16))).toBe(false);
  });

  test('`0-6` on day-of-week is the whole week, so it is not a restriction', () => {
    expect(parseCronExpression('0 9 15 * 0-6').dayOfWeekRestricted).toBe(false);
    expect(matchesDayFields(parseCronExpression('0 9 15 * 0-6'), new Date(2026, 2, 16))).toBe(false);
  });
});

describe('nextCronRun and cronIntervalMs', () => {
  test('finds the next minute strictly after the cursor', () => {
    const parsed = parseCronExpression('*/5 * * * *');
    const next = nextCronRun(parsed, new Date(2026, 2, 15, 9, 2, 30));
    expect(next?.getHours()).toBe(9);
    expect(next?.getMinutes()).toBe(5);
    // A cursor sitting exactly on a fire moves to the following one.
    expect(nextCronRun(parsed, new Date(2026, 2, 15, 9, 5, 0))?.getMinutes()).toBe(10);
  });

  test('crosses a year for a once-a-year expression without walking every minute', () => {
    const parsed = parseCronExpression('30 14 15 3 *');
    const next = nextCronRun(parsed, new Date(2026, 5, 1, 0, 0, 0));
    expect(next?.getFullYear()).toBe(2027);
    expect(next?.getMonth()).toBe(2);
    expect(next?.getDate()).toBe(15);
    expect(next?.getHours()).toBe(14);
    expect(next?.getMinutes()).toBe(30);
  });

  test('an impossible date returns null rather than spinning', () => {
    expect(nextCronRun(parseCronExpression('0 0 30 2 *'), new Date(2026, 0, 1))).toBeNull();
  });

  test('the interval is measured, so two spellings of one cadence agree', () => {
    const from = new Date(2026, 2, 15, 9, 0, 0);
    expect(cronIntervalMs(parseCronExpression('*/5 * * * *'), from)).toBe(5 * 60_000);
    expect(cronIntervalMs(parseCronExpression('0,5,10,15,20,25,30,35,40,45,50,55 * * * *'), from)).toBe(5 * 60_000);
    expect(cronIntervalMs(parseCronExpression('0 * * * *'), from)).toBe(60 * 60_000);
  });
});

describe('P6.295 — the recurrence-rule front door', () => {
  it('translates the row’s own example, and keeps the rule as written', () => {
    expect(recurrenceRuleToCron('FREQ=MONTHLY;BYMONTHDAY=1')).toBe('0 0 1 * *');
    const parsed = parseCronExpression('FREQ=MONTHLY;BYMONTHDAY=1');
    // `CronList` round-trips this field, so it must be the user's text.
    expect(parsed.expression).toBe('FREQ=MONTHLY;BYMONTHDAY=1');
    expect(parsed.daysOfMonth).toEqual(new Set([1]));
    expect(parsed.dayOfMonthRestricted).toBe(true);
  });

  it('fires on the 1st and not on the 2nd', () => {
    const parsed = parseCronExpression('FREQ=MONTHLY;BYMONTHDAY=1');
    // Local time throughout, matching `:174`.
    const next = nextCronRun(parsed, new Date(2026, 8, 6, 12, 0, 0));
    expect(next?.getDate()).toBe(1);
    expect(next?.getMonth()).toBe(9);
    expect(next?.getHours()).toBe(0);
    expect(matchesCronExpression(parsed, new Date(2026, 9, 1, 0, 0))).toBe(true);
    expect(matchesCronExpression(parsed, new Date(2026, 9, 2, 0, 0))).toBe(false);
  });

  it('accepts the other three frequencies with their required parts', () => {
    expect(recurrenceRuleToCron('FREQ=DAILY;BYHOUR=9;BYMINUTE=30')).toBe('30 9 * * *');
    expect(recurrenceRuleToCron('RRULE:FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9')).toBe('0 9 * * 1,3');
    expect(recurrenceRuleToCron('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15;BYHOUR=14')).toBe('0 14 15 3 *');
  });

  it('is not mistaken for a cron expression, and vice versa', () => {
    expect(isRecurrenceRule('FREQ=MONTHLY;BYMONTHDAY=1')).toBe(true);
    expect(isRecurrenceRule('RRULE:FREQ=DAILY')).toBe(true);
    expect(isRecurrenceRule('0 9 * * 1-5')).toBe(false);
    // The 5-field dialect is untouched by any of this.
    expect(parseCronExpression('0 9 * * 1-5').expression).toBe('0 9 * * 1-5');
  });

  it('refuses every part it cannot express, BY NAME', () => {
    const cases: [string, string][] = [
      ['FREQ=DAILY;INTERVAL=2', 'INTERVAL'],
      ['FREQ=DAILY;COUNT=5', 'COUNT'],
      ['FREQ=DAILY;UNTIL=20261231T000000Z', 'UNTIL'],
      ['FREQ=MONTHLY;BYDAY=2MO', 'BYDAY'],
      ['FREQ=MONTHLY;BYMONTHDAY=-1', 'BYMONTHDAY'],
      ['FREQ=MONTHLY;BYMONTHDAY=1;BYDAY=MO', 'BYMONTHDAY'],
      ['FREQ=WEEKLY', 'BYDAY'],
      ['FREQ=MONTHLY', 'BYMONTHDAY'],
      ['FREQ=YEARLY;BYMONTHDAY=1', 'BYMONTH'],
      ['FREQ=HOURLY', 'FREQ'],
      ['FREQ=DAILY;BYHOUR=99', 'BYHOUR'],
    ];
    for (const [rule, mentions] of cases) {
      let thrown: unknown;
      try { parseCronExpression(rule); } catch (error) { thrown = error; }
      expect(thrown, rule).toBeInstanceOf(CronDialectError);
      expect((thrown as Error).message, rule).toContain(mentions);
    }
    // And the predicate agrees, so schema-level validation refuses them too.
    expect(isValidCronExpression('FREQ=DAILY;INTERVAL=2')).toBe(false);
    expect(isValidCronExpression('FREQ=MONTHLY;BYMONTHDAY=1')).toBe(true);
  });
});

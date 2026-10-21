/**
 * The documented cron dialect (R27b Task 1).
 *
 * Contract source, `scheduled-tasks.md` read raw:
 * - `:191` — "`CronCreate` accepts standard 5-field cron expressions:
 *   `minute hour day-of-month month day-of-week`. All fields support wildcards
 *   (`*`), single values (`5`), steps (`*\/15`), ranges (`1-5`), and
 *   comma-separated lists (`1,15,30`)."
 *   (The backslash above is only there so the quoted step does not close this
 *   comment; the dialect itself has no escape.)
 * - `:202` — "Day-of-week uses `0` or `7` for Sunday through `6` for Saturday.
 *   Extended syntax like `L`, `W`, `?`, and name aliases such as `MON` or `JAN`
 *   is not supported."
 * - `:204` — "When both day-of-month and day-of-week are constrained, a date
 *   matches if **either** field matches. This follows standard vixie-cron
 *   semantics."
 * - `:174` — "All times are interpreted in your local timezone."
 *
 * WHY A PARSER AND NOT `croner`, which this repo already depends on for
 * Automations. Measured, not assumed: croner ACCEPTS every token `:202` refuses.
 * `0 9 L * *`, `0 9 * * MON`, `0 9 * JAN *`, `0 9 ? * 1`, `0 9 1W * *` and
 * `0 9 * * 1#2` all construct successfully and return a `nextRun`. Delegating
 * the dialect to croner would therefore SILENTLY ACCEPT the extended syntax the
 * contract requires us to refuse, so a validating parser has to exist either
 * way. Once each field is parsed into a value set, matching is set membership
 * plus the `:204` or-rule — running croner behind that would mean two parsers
 * and two authorities for one expression.
 *
 * croner is still used, as an ORACLE:
 * `packages/shared/src/sessions/__tests__/cron-dialect-oracle.test.ts` (croner
 * is a dependency of `shared`, not of this package) cross-checks the DOM/DOW
 * or-semantics against it, because that is the reading most likely to be
 * implemented backwards and an independent implementation agreeing is worth
 * more than a hand-computed fixture.
 */

/** The five fields, in documented order. */
export type CronFieldName = 'minute' | 'hour' | 'day-of-month' | 'month' | 'day-of-week';

export const CRON_FIELD_NAMES: readonly CronFieldName[] = [
  'minute',
  'hour',
  'day-of-month',
  'month',
  'day-of-week',
];

interface CronFieldRange {
  min: number;
  max: number;
}

const FIELD_RANGES: Record<CronFieldName, CronFieldRange> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  'day-of-month': { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  // `:202` — "`0` or `7` for Sunday through `6` for Saturday", so 7 is accepted
  // on input and normalised to 0 in the value set.
  'day-of-week': { min: 0, max: 7 },
};

/**
 * A parse failure that names the offending token, because `:202` makes an
 * unsupported token an ERROR rather than an expression that quietly never
 * matches. A silent no-match would look identical to a task the user simply
 * never saw fire.
 */
export class CronDialectError extends Error {
  constructor(
    message: string,
    readonly field: CronFieldName | null,
    readonly token: string,
  ) {
    super(message);
    this.name = 'CronDialectError';
  }
}

export interface ParsedCronExpression {
  /** The expression exactly as written, for round-tripping into `CronList`. */
  readonly expression: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** Sunday is always 0 here; an input `7` is folded in during parsing. */
  readonly daysOfWeek: ReadonlySet<number>;
  /** `:204` — the or-rule applies only when BOTH day fields are restricted. */
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

/**
 * Every token `:202` names, plus the two other widespread vixie/Quartz
 * extensions (`#` nth-weekday and `LW`), so an expression copied from a Quartz
 * scheduler fails loudly instead of being reinterpreted. The check runs on the
 * raw token before numeric parsing so the error can quote what the user wrote.
 */
const EXTENDED_SYNTAX = /[LW?#]/i;
const NAME_ALIAS = /[A-Za-z]/;

function parseFieldTerm(field: CronFieldName, term: string, whole: string): number[] {
  const { min, max } = FIELD_RANGES[field];

  const [rangePart, stepPart, ...extra] = term.split('/');
  if (extra.length > 0) {
    throw new CronDialectError(
      `Invalid ${field} term "${term}" in "${whole}": a step may appear at most once.`,
      field,
      term,
    );
  }

  let step = 1;
  if (stepPart !== undefined) {
    if (!/^\d+$/.test(stepPart)) {
      throw new CronDialectError(
        `Invalid step "${stepPart}" in ${field} term "${term}": a step must be a positive integer.`,
        field,
        term,
      );
    }
    step = Number(stepPart);
    if (step === 0) {
      throw new CronDialectError(
        `Invalid step "0" in ${field} term "${term}": a step must be greater than zero.`,
        field,
        term,
      );
    }
  }

  const base = rangePart ?? '';
  let from: number;
  let to: number;
  if (base === '*') {
    from = min;
    to = max;
  } else if (base.includes('-')) {
    const [rawFrom, rawTo, ...rest] = base.split('-');
    if (rest.length > 0 || rawFrom === undefined || rawTo === undefined) {
      throw new CronDialectError(
        `Invalid range "${base}" in ${field} of "${whole}".`,
        field,
        base,
      );
    }
    from = parseNumber(field, rawFrom, whole);
    to = parseNumber(field, rawTo, whole);
    if (from > to) {
      throw new CronDialectError(
        `Invalid range "${base}" in ${field} of "${whole}": the start is after the end.`,
        field,
        base,
      );
    }
  } else {
    from = parseNumber(field, base, whole);
    // A bare value with a step means "from this value to the field maximum",
    // which is what vixie-cron does and what `*/15` is a special case of.
    to = stepPart === undefined ? from : max;
  }

  const values: number[] = [];
  for (let value = from; value <= to; value += step) values.push(value);
  return values;
}

function parseNumber(field: CronFieldName, raw: string, whole: string): number {
  if (raw.length === 0) {
    throw new CronDialectError(`Empty ${field} value in "${whole}".`, field, raw);
  }
  if (NAME_ALIAS.test(raw)) {
    throw new CronDialectError(
      `Unsupported token "${raw}" in ${field} of "${whole}": name aliases such as MON or JAN are not supported.`,
      field,
      raw,
    );
  }
  if (!/^\d+$/.test(raw)) {
    throw new CronDialectError(
      `Unsupported token "${raw}" in ${field} of "${whole}".`,
      field,
      raw,
    );
  }
  const value = Number(raw);
  const { min, max } = FIELD_RANGES[field];
  if (value < min || value > max) {
    throw new CronDialectError(
      `Value ${value} is out of range for ${field} (${min}-${max}) in "${whole}".`,
      field,
      raw,
    );
  }
  return value;
}

function parseField(field: CronFieldName, raw: string, whole: string): { values: Set<number>; restricted: boolean } {
  if (raw.length === 0) {
    throw new CronDialectError(`Empty ${field} field in "${whole}".`, field, raw);
  }
  if (EXTENDED_SYNTAX.test(raw)) {
    const token = raw.match(EXTENDED_SYNTAX)![0];
    throw new CronDialectError(
      `Unsupported token "${token}" in ${field} of "${whole}": extended syntax like L, W and ? is not supported.`,
      field,
      token,
    );
  }

  const values = new Set<number>();
  for (const term of raw.split(',')) {
    for (const value of parseFieldTerm(field, term, whole)) {
      // Sunday is spelled both 0 and 7; fold before storing so membership is a
      // single lookup and `0,7` is not two distinct days.
      values.add(field === 'day-of-week' && value === 7 ? 0 : value);
    }
  }
  // "Restricted" means the field names something narrower than every value it
  // can take — the precondition `:204` puts on the or-rule. `*` is unrestricted;
  // so is `0-6` on day-of-week, which enumerates the whole week.
  const { min, max } = FIELD_RANGES[field];
  const span = field === 'day-of-week' ? 7 : max - min + 1;
  return { values, restricted: raw !== '*' && values.size < span };
}

/**
 * P6.295 — the RECURRENCE-RULE front door.
 *
 * ## Why this exists, and why it is a translator rather than a scheduler
 *
 * The 5-field dialect cannot say "the first of every month" in a way a person
 * recognises, and it cannot say it at all beyond a day-of-month number. The row
 * asked for `FREQ=MONTHLY;BYMONTHDAY=1`. There is **no native mechanism in any
 * of the three runtimes** — the store, the tick and the tool surface are all
 * ours — so this is the host supplying one thing once for all three.
 *
 * Given that, the smallest honest shape is a TRANSLATION onto the machinery
 * that already exists: an accepted rule becomes a 5-field expression and every
 * downstream rule — jitter, the or-semantics, the lookahead, the interval — is
 * unchanged and untouched. A second fire-time engine beside this one would be
 * two authorities for one question, which is the mistake `cron-dialect.ts`'s own
 * header records about croner.
 *
 * ## The subset, stated — because what is REFUSED is the contract here
 *
 * RFC 5545 §3.3.10 is far larger than cron. Everything outside the mapping is
 * refused BY NAME rather than silently dropped, because a dropped `INTERVAL=2`
 * is a task that fires twice as often as the user asked and looks correct.
 *
 * Accepted: `FREQ` (`DAILY` `WEEKLY` `MONTHLY` `YEARLY`), `INTERVAL=1`,
 * `BYMINUTE`, `BYHOUR`, `BYMONTHDAY` (positive), `BYDAY` (bare two-letter
 * codes), `BYMONTH`. An optional `RRULE:` prefix is accepted and ignored.
 *
 * Refused, each with its reason in the message: any `INTERVAL` other than 1 (no
 * cron field counts periods); a negative or `L`-style `BYMONTHDAY` and an
 * ordinal `BYDAY` such as `2MO` (the dialect refuses `L` and `#` for the same
 * reason at `:202`); `COUNT`, `UNTIL`, `BYSETPOS`, `BYWEEKNO`, `BYYEARDAY`,
 * `BYSECOND`, `WKST`, `DTSTART` (no representation at all); and `BYMONTHDAY`
 * together with `BYDAY`, because RFC 5545 intersects those two and vixie cron
 * UNIONS them — the same rule would mean two different things, so it is the one
 * case where translating would be a lie rather than a limitation.
 *
 * `FREQ=WEEKLY` requires `BYDAY` and `FREQ=MONTHLY` requires one of the two day
 * parts, because RFC 5545 fills those in from `DTSTART` and a scheduled task
 * has none — inferring one from the creation instant would make the same rule
 * mean different things on different days.
 */
const RECURRENCE_RULE_DAYS: Readonly<Record<string, number>> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

/** Parts that have no cron representation at all. */
const RECURRENCE_RULE_UNSUPPORTED_PARTS = [
  'COUNT', 'UNTIL', 'BYSETPOS', 'BYWEEKNO', 'BYYEARDAY', 'BYSECOND', 'WKST', 'DTSTART',
];

/**
 * True when the caller wrote a recurrence rule rather than a cron expression.
 * `FREQ=` is the one part RFC 5545 makes mandatory, so its presence is the
 * discriminator and no 5-field expression can contain it (`=` is not a cron
 * token).
 */
export function isRecurrenceRule(expression: string): boolean {
  return /(^|[;:\s])FREQ=/i.test(expression.trim());
}

function recurrenceNumbers(
  raw: string, part: string, min: number, max: number, whole: string,
): number[] {
  return raw.split(',').map(entry => {
    const token = entry.trim();
    if (!/^\d+$/.test(token)) {
      throw new CronDialectError(
        `Invalid ${part} value "${token}" in "${whole}": this fork accepts plain whole numbers only`
        + (/^-/.test(token) ? ', and a negative day counted from the end of the month has no cron equivalent.' : '.'),
        null,
        token,
      );
    }
    const value = Number(token);
    if (value < min || value > max) {
      throw new CronDialectError(
        `${part} value "${token}" in "${whole}" is outside ${min}-${max}.`,
        null,
        token,
      );
    }
    return value;
  });
}

/**
 * Translate an accepted recurrence rule into the equivalent 5-field expression.
 * Throws {@link CronDialectError} — the same error class the dialect already
 * raises — for everything outside the subset above.
 */
export function recurrenceRuleToCron(rule: string): string {
  const whole = rule.trim();
  const body = whole.replace(/^RRULE:/i, '');
  const parts = new Map<string, string>();
  for (const chunk of body.split(';')) {
    const token = chunk.trim();
    if (token.length === 0) continue;
    const at = token.indexOf('=');
    if (at <= 0) {
      throw new CronDialectError(
        `Invalid recurrence part "${token}" in "${whole}": each part is NAME=VALUE separated by ";".`,
        null,
        token,
      );
    }
    parts.set(token.slice(0, at).trim().toUpperCase(), token.slice(at + 1).trim());
  }

  for (const name of RECURRENCE_RULE_UNSUPPORTED_PARTS) {
    if (parts.has(name)) {
      throw new CronDialectError(
        `${name} in "${whole}" has no equivalent in the 5-field schedule this scheduler runs on, so it is refused rather than ignored.`,
        null,
        name,
      );
    }
  }

  const freq = (parts.get('FREQ') ?? '').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) {
    throw new CronDialectError(
      `FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY in "${whole}"; got "${parts.get('FREQ') ?? ''}".`,
      null,
      freq,
    );
  }

  const interval = parts.get('INTERVAL');
  if (interval !== undefined && interval.trim() !== '1') {
    throw new CronDialectError(
      `INTERVAL=${interval} in "${whole}" cannot be expressed: no cron field counts periods, so "every ${interval} ${freq.toLowerCase()}" would silently become "every one".`,
      null,
      interval,
    );
  }

  const byDayRaw = parts.get('BYDAY');
  const byMonthDayRaw = parts.get('BYMONTHDAY');
  if (byDayRaw !== undefined && byMonthDayRaw !== undefined) {
    throw new CronDialectError(
      `BYDAY and BYMONTHDAY together in "${whole}" cannot be translated: RFC 5545 intersects them and cron unions them, so the same rule would mean two different things.`,
      null,
      `${byDayRaw};${byMonthDayRaw}`,
    );
  }

  const daysOfWeek = byDayRaw === undefined ? undefined : byDayRaw.split(',').map(entry => {
    const token = entry.trim().toUpperCase();
    const day = RECURRENCE_RULE_DAYS[token];
    if (day === undefined) {
      throw new CronDialectError(
        `Invalid BYDAY value "${entry.trim()}" in "${whole}": two-letter day codes only`
        + (/^[+-]?\d/.test(token) ? ', and an ordinal such as "2MO" has no cron equivalent.' : '.'),
        null,
        entry.trim(),
      );
    }
    return day;
  });

  const daysOfMonth = byMonthDayRaw === undefined
    ? undefined
    : recurrenceNumbers(byMonthDayRaw, 'BYMONTHDAY', 1, 31, whole);
  const months = parts.get('BYMONTH') === undefined
    ? undefined
    : recurrenceNumbers(parts.get('BYMONTH')!, 'BYMONTH', 1, 12, whole);
  const hours = parts.get('BYHOUR') === undefined
    ? undefined
    : recurrenceNumbers(parts.get('BYHOUR')!, 'BYHOUR', 0, 23, whole);
  const minutes = parts.get('BYMINUTE') === undefined
    ? undefined
    : recurrenceNumbers(parts.get('BYMINUTE')!, 'BYMINUTE', 0, 59, whole);

  if (freq === 'WEEKLY' && daysOfWeek === undefined) {
    throw new CronDialectError(
      `FREQ=WEEKLY in "${whole}" needs BYDAY: RFC 5545 takes the weekday from DTSTART and a scheduled task has none.`,
      null,
      'FREQ=WEEKLY',
    );
  }
  if ((freq === 'MONTHLY' || freq === 'YEARLY') && daysOfWeek === undefined && daysOfMonth === undefined) {
    throw new CronDialectError(
      `FREQ=${freq} in "${whole}" needs BYMONTHDAY or BYDAY: RFC 5545 takes the day from DTSTART and a scheduled task has none.`,
      null,
      `FREQ=${freq}`,
    );
  }
  if (freq === 'YEARLY' && months === undefined) {
    throw new CronDialectError(
      `FREQ=YEARLY in "${whole}" needs BYMONTH, or it would fire every month.`,
      null,
      'FREQ=YEARLY',
    );
  }

  // Unnamed time-of-day defaults to midnight, as RFC 5545 does when DTSTART
  // carries no time — but said here explicitly, because it is the one default
  // that changes WHEN a task fires rather than whether it parses.
  const field = (values: number[] | undefined, fallback: string): string =>
    values === undefined ? fallback : [...new Set(values)].sort((a, b) => a - b).join(',');
  return [
    field(minutes, '0'),
    field(hours, '0'),
    field(daysOfMonth, '*'),
    field(months, '*'),
    field(daysOfWeek, '*'),
  ].join(' ');
}

/**
 * Parse a 5-field expression. Throws {@link CronDialectError} naming the
 * offending token for anything outside the documented dialect.
 */
export function parseCronExpression(expression: string): ParsedCronExpression {
  // P6.295 — a recurrence rule is translated to the 5-field form and parsed by
  // exactly the code below; nothing downstream learns a second dialect. The
  // ORIGINAL text is kept as `expression`, so `CronList` shows the user the rule
  // they wrote rather than our translation of it.
  if (isRecurrenceRule(expression)) {
    const translated = parseCronExpression(recurrenceRuleToCron(expression));
    return { ...translated, expression: expression.trim() };
  }
  const fields = expression.trim().split(/\s+/);
  if (expression.trim().length === 0 || fields.length !== 5) {
    throw new CronDialectError(
      `A cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week); got ${expression.trim().length === 0 ? 0 : fields.length} in "${expression}".`,
      null,
      expression,
    );
  }

  const minute = parseField('minute', fields[0]!, expression);
  const hour = parseField('hour', fields[1]!, expression);
  const dayOfMonth = parseField('day-of-month', fields[2]!, expression);
  const month = parseField('month', fields[3]!, expression);
  const dayOfWeek = parseField('day-of-week', fields[4]!, expression);

  return {
    expression: expression.trim(),
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dayOfMonth.values,
    months: month.values,
    daysOfWeek: dayOfWeek.values,
    dayOfMonthRestricted: dayOfMonth.restricted,
    dayOfWeekRestricted: dayOfWeek.restricted,
  };
}

/** `parseCronExpression` as a predicate, for schema-level validation. */
export function isValidCronExpression(expression: string): boolean {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `:204` day rule, isolated so it can be asserted on its own.
 *
 * - Neither day field restricted → the day is irrelevant.
 * - Exactly one restricted → that one decides.
 * - BOTH restricted → the date matches if EITHER matches. This is the reading
 *   most often implemented as AND; `cron-dialect.test.ts` asserts the two apart
 *   on one fixture and cross-checks the or-reading against croner.
 */
export function matchesDayFields(parsed: ParsedCronExpression, date: Date): boolean {
  const domMatch = parsed.daysOfMonth.has(date.getDate());
  const dowMatch = parsed.daysOfWeek.has(date.getDay());
  if (parsed.dayOfMonthRestricted && parsed.dayOfWeekRestricted) return domMatch || dowMatch;
  if (parsed.dayOfMonthRestricted) return domMatch;
  if (parsed.dayOfWeekRestricted) return dowMatch;
  return true;
}

/**
 * Does this local-time minute match? Seconds and milliseconds are ignored —
 * cron has one-minute granularity (`:60`).
 */
export function matchesCronExpression(parsed: ParsedCronExpression, date: Date): boolean {
  return (
    parsed.minutes.has(date.getMinutes()) &&
    parsed.hours.has(date.getHours()) &&
    parsed.months.has(date.getMonth() + 1) &&
    matchesDayFields(parsed, date)
  );
}

/**
 * How far ahead `nextCronRun` will look before giving up. Four years covers
 * every expression this dialect can express except an impossible date such as
 * `0 0 30 2 *`, which returns `null` rather than spinning.
 */
const MAX_LOOKAHEAD_DAYS = 4 * 366;

/**
 * The first matching minute strictly AFTER `from`, in local time, or `null`
 * when the expression can never match.
 *
 * Searched day-then-hour-then-minute rather than minute-by-minute: a yearly
 * expression like `30 14 15 3 *` would otherwise walk half a million minutes,
 * and the scheduler calls this on every task on every tick.
 */
export function nextCronRun(parsed: ParsedCronExpression, from: Date): Date | null {
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let day = 0; day <= MAX_LOOKAHEAD_DAYS; day += 1) {
    const dayStart = new Date(cursor.getTime());
    if (day > 0) {
      dayStart.setDate(dayStart.getDate() + day);
      dayStart.setHours(0, 0, 0, 0);
    }
    if (!parsed.months.has(dayStart.getMonth() + 1) || !matchesDayFields(parsed, dayStart)) continue;

    for (let hour = dayStart.getHours(); hour <= 23; hour += 1) {
      if (!parsed.hours.has(hour)) continue;
      const firstMinute = hour === dayStart.getHours() ? dayStart.getMinutes() : 0;
      for (let minute = firstMinute; minute <= 59; minute += 1) {
        if (!parsed.minutes.has(minute)) continue;
        const candidate = new Date(dayStart.getTime());
        candidate.setHours(hour, minute, 0, 0);
        // A DST spring-forward can move a wall-clock time onto a different
        // hour; re-check rather than trusting the setter.
        if (matchesCronExpression(parsed, candidate) && candidate.getTime() > from.getTime()) return candidate;
      }
    }
  }
  return null;
}

/**
 * The typical gap between consecutive fires, in milliseconds, or `null` when
 * the expression fires at most once in the lookahead window.
 *
 * The jitter rule at `:180` is stated in terms of an interval ("up to half the
 * interval, for tasks that run more often than hourly"), so the scheduler needs
 * one. Measured from the next three fires rather than inferred from the
 * expression's shape, which keeps a five-minute step and the equivalent
 * `0,5,10,…` list — the same cadence written two ways — on the same bound.
 */
export function cronIntervalMs(parsed: ParsedCronExpression, from: Date): number | null {
  const first = nextCronRun(parsed, from);
  if (!first) return null;
  const second = nextCronRun(parsed, first);
  if (!second) return null;
  return second.getTime() - first.getTime();
}

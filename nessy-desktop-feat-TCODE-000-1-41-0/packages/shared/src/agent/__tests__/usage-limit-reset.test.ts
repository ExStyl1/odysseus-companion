/**
 * P6.503 — a reset timestamp exists on two of the three arms and neither drives
 * a wait, so an unattended session dies at a usage limit with the work lost.
 *
 * Q-den 20 = **A**: wait only where a reset timestamp is published, and say
 * plainly where it is not. Never invent a reset the server did not promise.
 *
 * This file covers the half that landed: the shared vocabulary, and the codex
 * arm's sentence. The WAIT sequences behind P6.373 (the one resume-vs-stop
 * setting) and P6.444 (the codex `account/rateLimits/updated` readback), which
 * P6.503's own note says not to duplicate.
 *
 * WHAT EACH TEST KILLS:
 *  - the unit arms die if anything in `readPublishedUsageLimitReset` starts
 *    manufacturing a timestamp — a default, a "now + an hour", a `0` treated as
 *    an instant. Option B is exactly that mistake, and it is refused by type:
 *    there is no third state between published and not.
 *  - the seconds/milliseconds arm dies if the unit sniff is dropped. The SDK's
 *    `resetsAt` declares no unit while Anthropic's own headers are Unix seconds,
 *    so a naive read prints 1970 or the year 56000 to the user.
 *  - the codex arms die if the sentence is attached to the wrong error, or if
 *    the absence goes back to being an empty string.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUTO_CONTINUE_AT_USAGE_LIMIT_DEFAULT,
  AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR,
  awaitUsageLimitReset,
  decideUsageLimitContinuation,
  describeUsageLimitContinuation,
  describeUsageLimitReset,
  readPublishedUsageLimitReset,
  resolveAutoContinueAtUsageLimit,
} from '../usage-limit-reset.ts';

const FIXED = 'AT-THE-INSTANT';
const format = () => FIXED;

describe('P6.503 · readPublishedUsageLimitReset never invents a reset', () => {
  it('reads a millisecond instant unchanged', () => {
    expect(readPublishedUsageLimitReset(1_800_000_000_000))
      .toEqual({ published: true, resetsAtMs: 1_800_000_000_000 });
  });

  it('promotes a SECONDS instant, because the SDK field declares no unit', () => {
    expect(readPublishedUsageLimitReset(1_800_000_000))
      .toEqual({ published: true, resetsAtMs: 1_800_000_000_000 });
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string the caller did not parse', '1800000000'],
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('answers "not published" for %s', (_label, value) => {
    expect(readPublishedUsageLimitReset(value)).toEqual({ published: false });
  });
});

describe('P6.503 · the absence gets a sentence instead of an empty string', () => {
  it('names the instant the server published', () => {
    expect(describeUsageLimitReset({ published: true, resetsAtMs: 1 }, format))
      .toBe(` Resets ${FIXED}.`);
  });

  it('says the turn stops and why, rather than nothing at all', () => {
    const clause = describeUsageLimitReset({ published: false }, format);
    expect(clause.trim().length).toBeGreaterThan(0);
    expect(clause).toContain('No reset time was published');
    expect(clause).toContain('stops here rather than waiting');
    // Option B, refused, would read as a promise: nothing here may suggest a
    // retry interval the server did not name.
    expect(clause).not.toMatch(/retry|minute|second|hour/i);
  });
});


/**
 * P6.373 · denominator K22 — the ONE setting that decides resume-vs-stop.
 *
 * Two arms per the row's done_means ("a test drives both values"), plus the
 * ordering arm that is the safety property: an unpublished reset stops the turn
 * whatever the setting says. A mutation that removes the gate — returning
 * `{ resume: true }` unconditionally, or reading the setting before the reset —
 * fails here rather than shipping a session that waits for an instant nobody
 * named.
 *
 * `env` is passed as a plain object rather than mutated on `process.env`: Bun
 * 1.3.14 leaves an assigned name invisible to `{...process.env}` for the names
 * it pre-creates a slot for, and a test that mutates the real environment in
 * this tree has cost a measurement before.
 */
const PUBLISHED = { published: true as const, resetsAtMs: 1_800_000_000_000 };
const NOW = 1_800_000_000_000 - 90_000;

describe('P6.373 · the setting is read, with the documented default', () => {
  it('defaults to the page value when nothing is set', () => {
    expect(resolveAutoContinueAtUsageLimit({})).toBe(AUTO_CONTINUE_AT_USAGE_LIMIT_DEFAULT);
    // `settings-reference.md#autocontinueatusagelimit` — "**Default**: `true`".
    expect(AUTO_CONTINUE_AT_USAGE_LIMIT_DEFAULT).toBe(true);
  });

  it.each([['0'], ['false'], ['no'], ['off']])('reads %s as off', value => {
    expect(resolveAutoContinueAtUsageLimit({ [AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR]: value })).toBe(false);
  });

  it('keeps the default for a value it cannot read, rather than guessing', () => {
    expect(resolveAutoContinueAtUsageLimit({ [AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR]: 'maybe' })).toBe(true);
  });
});

describe('P6.373 · the gate decides resume-vs-stop, and BOTH values are driven', () => {
  it('resumes at the instant the server named when the setting is on', () => {
    expect(decideUsageLimitContinuation(PUBLISHED, { env: {}, nowMs: NOW }))
      .toEqual({ resume: true, resumeAtMs: PUBLISHED.resetsAtMs, waitMs: 90_000 });
  });

  it('stops, and still names the instant, when the setting is off', () => {
    expect(decideUsageLimitContinuation(PUBLISHED, {
      env: { [AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR]: '0' },
      nowMs: NOW,
    })).toEqual({ resume: false, reason: 'setting-off', resumeAtMs: PUBLISHED.resetsAtMs });
  });

  it('stops when NO reset was published, EVEN WITH THE SETTING ON — the ordering is the safety property', () => {
    expect(decideUsageLimitContinuation({ published: false }, { env: {}, nowMs: NOW }))
      .toEqual({ resume: false, reason: 'no-reset-published' });
  });

  it('never returns a negative wait for an instant that has already passed', () => {
    const past = decideUsageLimitContinuation(PUBLISHED, { env: {}, nowMs: PUBLISHED.resetsAtMs + 60_000 });
    expect(past).toEqual({ resume: true, resumeAtMs: PUBLISHED.resetsAtMs, waitMs: 0 });
  });
});

describe('P6.373 · the sentence names the setting that decided it', () => {
  it('says it is waiting, and which switch turned that on', () => {
    const clause = describeUsageLimitContinuation(
      { resume: true, resumeAtMs: PUBLISHED.resetsAtMs, waitMs: 90_000 },
      format,
    );
    expect(clause).toContain(FIXED);
    expect(clause).toContain(AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR);
    expect(clause).toContain('continuing');
  });

  it('says it is stopping, names the instant it is declining, and names the switch', () => {
    const clause = describeUsageLimitContinuation(
      { resume: false, reason: 'setting-off', resumeAtMs: PUBLISHED.resetsAtMs },
      format,
    );
    expect(clause).toContain(FIXED);
    expect(clause).toContain(AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR);
    expect(clause).toContain('stops here rather than waiting');
  });

  it('re-uses P6.503\'s exact sentence when nothing was published, byte for byte', () => {
    // The two arms already print this string; a gate landing must not reword a
    // sentence two adapters and two suites already pin.
    expect(describeUsageLimitContinuation({ resume: false, reason: 'no-reset-published' }, format))
      .toBe(describeUsageLimitReset({ published: false }, format));
  });
});

describe('P6.373 · the wait is the decision, not a second one', () => {
  it('sleeps exactly the decided interval and hands the verdict back', async () => {
    const slept: number[] = [];
    const verdict = await awaitUsageLimitReset(PUBLISHED, {
      env: {},
      nowMs: NOW,
      sleep: async ms => { slept.push(ms); },
    });
    expect(slept).toEqual([90_000]);
    expect(verdict).toEqual({ resume: true, resumeAtMs: PUBLISHED.resetsAtMs, waitMs: 90_000 });
  });

  it('does not sleep at all when the gate said stop', async () => {
    const slept: number[] = [];
    const verdict = await awaitUsageLimitReset(PUBLISHED, {
      env: { [AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR]: 'off' },
      nowMs: NOW,
      sleep: async ms => { slept.push(ms); },
    });
    expect(slept).toEqual([]);
    expect(verdict.resume).toBe(false);
  });
});

/**
 * P6.373 — the sentence must not promise a continuation the caller does not
 * perform.
 *
 * The gate, the setting and the wait all exist; `awaitUsageLimitReset` has no
 * in-tree caller. On the one arm that can reach the `resume` verdict today
 * (claude, whose stop signal carries a reset) the promise would print while
 * nothing continues, so the caller declares whether the wait is wired.
 */
describe('P6.373 · a caller that does not wait says so instead of promising', () => {
  const RESUMING = { resume: true as const, resumeAtMs: PUBLISHED.resetsAtMs, waitMs: 90_000 };

  it('names the setting and the instant, and promises nothing', () => {
    const clause = describeUsageLimitContinuation(RESUMING, format, {
      waitIsWired: false,
      env: { [AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR]: '1' },
    });
    expect(clause).toContain(FIXED);
    expect(clause).toContain(`${AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR}=1`);
    expect(clause).toContain('the turn stops here');
    expect(clause).not.toContain('continuing automatically');
  });

  /**
   * F1.602 — the setting's DEFAULT is on, so an unconfigured install reaches the
   * resume verdict with the variable unset. The sentence used to print `…=1`
   * there too, which reads as if the operator had set it. It now says `=1` only
   * when the operator did, and names the default otherwise; the two arms read
   * differently only inside the parenthesis, which is the only place they differ.
   */
  it('F1.602 · unset: names the default rather than an `=1` nobody wrote, and differs from `=1` only there', () => {
    for (const waitIsWired of [false, true]) {
      const unset = describeUsageLimitContinuation(RESUMING, format, { waitIsWired, env: {} });
      const garbage = describeUsageLimitContinuation(RESUMING, format, {
        waitIsWired,
        env: { [AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR]: 'maybe' },
      });
      const set = describeUsageLimitContinuation(RESUMING, format, {
        waitIsWired,
        env: { [AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR]: 'true' },
      });
      expect(unset).not.toContain(`${AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR}=1`);
      expect(unset).toContain(`the default; ${AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR}=0 turns it off`);
      expect(garbage).toBe(unset);
      expect(set).toContain(`(${AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR}=1)`);
      expect(set.replace(`(${AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR}=1)`, '(X)'))
        .toBe(unset.replace(`(the default; ${AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR}=0 turns it off)`, '(X)'));
    }
  });

  /**
   * F1.600 (DECIDE, 2026-09-24) — the one caller that passes `waitIsWired:
   * false` is codex, and codex's own posture at a usage limit is to STOP: at
   * `rust-v0.156.1` the turn returns the `UsageLimitReached` error without a
   * retry, an active goal becomes `usage_limited` and resumes only on
   * `/goal resume`, and the TUI never waits for the reset. The host follows it
   * rather than building a wait beside it, so the sentence stops promising a
   * later ("yet") and says what the user does instead.
   */
  it('F1.600 · the unwired sentence states a decided stop and how to continue, not a pending build', () => {
    const clause = describeUsageLimitContinuation(RESUMING, format, { waitIsWired: false, env: {} });
    expect(clause).not.toContain('yet');
    expect(clause).toContain('does not perform it, so the turn stops here.');
    expect(clause).toContain(`Send a message after ${FIXED} to continue.`);
  });

  it('CONTROL: the default is unchanged, so the wired caller still reads as it did', () => {
    expect(describeUsageLimitContinuation(RESUMING, format))
      .toBe(describeUsageLimitContinuation(RESUMING, format, { waitIsWired: true }));
    expect(describeUsageLimitContinuation(RESUMING, format)).toContain('continuing');
    const env = { [AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR]: '1' };
    expect(describeUsageLimitContinuation(RESUMING, format, { env }))
      .toBe(` Waiting until ${FIXED}, when the limit resets, then continuing automatically`
        + ` (${AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR}=1).`);
  });

  it('the flag touches only the resume arm — the two stop arms are word for word the same', () => {
    for (const verdict of [
      { resume: false as const, reason: 'no-reset-published' as const },
      { resume: false as const, reason: 'setting-off' as const, resumeAtMs: PUBLISHED.resetsAtMs },
    ]) {
      expect(describeUsageLimitContinuation(verdict, format, { waitIsWired: false }))
        .toBe(describeUsageLimitContinuation(verdict, format));
    }
  });
});

/**
 * D1.59 — the two protocol readings the `awaitUsageLimitReset` docblock rests
 * on, so a correction does not quietly go stale the way the paragraph it
 * replaced did.
 *
 * The carried verdict said codex "never reaches resume" because `CodexErrorInfo`
 * carries no timestamp. Half of that is right and half is not, and the half that
 * is not is what makes codex's arm BLOCKED rather than impossible: the reset
 * instant exists, on a notification this host deliberately does not read. Both
 * halves are read off the generated protocol rather than asserted, because it is
 * regenerated from upstream by a script and nobody re-reads a comment when it is.
 */
describe('D1.59 · the codex reading behind the recorded verdict', () => {
  const protocolDir = join(import.meta.dir, '..', '..', '..', '..', 'codex-protocol', 'generated', 'v2');
  const generated = (name: string) => readFileSync(join(protocolDir, `${name}.ts`), 'utf-8');

  it('the ERROR really carries no instant — the half of the verdict that stands', () => {
    const errorInfo = generated('CodexErrorInfo');
    expect(errorInfo).toContain('"usageLimitExceeded"');
    // The only objects in that union carry a status code, never a time.
    expect(errorInfo).not.toContain('resetsAt');
    // CONTROL: the probe can see the union's object members at all.
    expect(errorInfo).toContain('httpStatusCode');
  });

  it('but the PROTOCOL does publish one, on a notification we do not read', () => {
    expect(generated('RateLimitWindow')).toContain('resetsAt');
  });
});

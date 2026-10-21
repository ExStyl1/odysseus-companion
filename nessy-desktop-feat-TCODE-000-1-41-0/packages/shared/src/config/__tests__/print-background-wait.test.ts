/**
 * The accepted spelling of `NESSY_PRINT_BG_WAIT_CEILING_MS` (P2.356).
 *
 * P6.565 REVERSED the rule this file used to pin, and the reversal is the point.
 *
 * `env-vars.md`'s row for `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` states the
 * default and the `0` case but never says how the number may be written. The
 * paragraph opening the Variables list then settles it, verbatim:
 *
 * > Numeric variables such as timeouts, token budgets, and retry counts accept
 * > scientific notation and digit-separator spellings in addition to plain
 * > digits, except where a variable's row notes it takes plain digits only. For
 * > example, Claude Code reads `2e3` as 2000 and `64_000` as 64000.
 *
 * A row that says nothing gets the GENERAL rule. The argument this file used to
 * make — reasoning from `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`'s row and from
 * `tools-reference.md#memory-limit-on-linux-and-wsl`'s `4e9` example — read two
 * of the five documented EXCEPTIONS as the house rule. Generalizing from an
 * exception is exactly what the "except where a variable's row notes it" clause
 * exists to stop, and it is why P6.565 forbids a mechanical sweep in either
 * direction: each key is routed by its own row.
 *
 * These tests are what stops the rule from being silently flipped back.
 */

import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_PRINT_BG_WAIT_CEILING_MS,
  PRINT_BG_WAIT_CEILING_COMPAT_ENV_VAR,
  PRINT_BG_WAIT_CEILING_ENV_VAR,
  PRINT_BG_WAIT_UNBOUNDED_MS,
  resolvePrintBackgroundWaitCeilingMs,
} from '../print-background-wait.ts';

describe('resolvePrintBackgroundWaitCeilingMs', () => {
  test('unset falls back to the documented 600000 default', () => {
    expect(resolvePrintBackgroundWaitCeilingMs({})).toBe(600_000);
    expect(DEFAULT_PRINT_BG_WAIT_CEILING_MS).toBe(600_000);
  });

  test.each([
    ['600000', 600_000],
    ['0', PRINT_BG_WAIT_UNBOUNDED_MS],
    ['1', 1],
    ['  90000  ', 90_000],
    ['000600000', 600_000],
  ])('plain digits %p are accepted -> %p', (raw, expected) => {
    expect(resolvePrintBackgroundWaitCeilingMs({ [PRINT_BG_WAIT_CEILING_ENV_VAR]: raw }))
      .toBe(expected);
  });

  // P6.565 · the spellings a person reaches for once the number gets long are
  // now ACCEPTED, because this key's row does not note plain digits only.
  test.each([
    ['2e3', 2_000],
    ['6e5', 600_000],
    ['600_000', 600_000],
    ['2.5e3', 2_500],
  ])('the general rule accepts %p -> %p', (raw, expected) => {
    expect(resolvePrintBackgroundWaitCeilingMs({ [PRINT_BG_WAIT_CEILING_ENV_VAR]: raw }))
      .toBe(expected);
  });

  // What the general rule still refuses. The page's example set is scientific
  // notation and separators; widening past it would be inventing, so a sign, a
  // hex literal, a bare float, a unit suffix and a stray separator all take the
  // 600000 default rather than the unbounded `0`.
  test.each([
    '+600000',
    '-600000',
    '600000.5',
    '0x1',
    '600000ms',
    '600__000',
    '_600000',
    '600_',
    '',
    'soon',
  ])('spelling %p the general rule refuses falls back to the default, never to 0', (raw) => {
    const resolved = resolvePrintBackgroundWaitCeilingMs({
      [PRINT_BG_WAIT_CEILING_ENV_VAR]: raw,
    });
    expect(resolved).toBe(DEFAULT_PRINT_BG_WAIT_CEILING_MS);
    expect(resolved).not.toBe(PRINT_BG_WAIT_UNBOUNDED_MS);
  });

  test('a value past the safe-integer range is malformed, not accepted', () => {
    expect(resolvePrintBackgroundWaitCeilingMs({
      [PRINT_BG_WAIT_CEILING_ENV_VAR]: '9'.repeat(25),
    })).toBe(DEFAULT_PRINT_BG_WAIT_CEILING_MS);
  });

  test('the Claude compat alias is read, and the Nessy name wins when both are set', () => {
    expect(resolvePrintBackgroundWaitCeilingMs({
      [PRINT_BG_WAIT_CEILING_COMPAT_ENV_VAR]: '5000',
    })).toBe(5_000);
    expect(resolvePrintBackgroundWaitCeilingMs({
      [PRINT_BG_WAIT_CEILING_ENV_VAR]: '5000',
      [PRINT_BG_WAIT_CEILING_COMPAT_ENV_VAR]: '9000',
    })).toBe(5_000);
  });

  test('a malformed Nessy name does not fall through to a valid compat alias', () => {
    // The Nessy name being PRESENT is what selects it, not its being valid —
    // otherwise a typo would silently pick up a stale Claude-spelled value.
    expect(resolvePrintBackgroundWaitCeilingMs({
      [PRINT_BG_WAIT_CEILING_ENV_VAR]: '0x1',
      [PRINT_BG_WAIT_CEILING_COMPAT_ENV_VAR]: '9000',
    })).toBe(DEFAULT_PRINT_BG_WAIT_CEILING_MS);
  });
});

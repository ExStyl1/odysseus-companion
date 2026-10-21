/**
 * `tools-reference.md#timeout-and-output-limits` / `#output-limits` (P2.355).
 *
 * These lock the two MODEL-FACING limits — the read-back window and the failure
 * excerpt — to the numbers the page publishes. The host-survival three (5 GB
 * kill, 64 MiB truncation, the session-directory output file) are deferred and
 * have no assertions here on purpose; see the module's closing block.
 *
 * WIRED as of P2.366/P2.367: `agent/local-tools/runtime.ts`'s `bash()` calls
 * {@link applyBashOutputLimits}. This file still proves only the NUMBERS; that a
 * real command is cut at them is proven in
 * `agent/local-tools/__tests__/bash-output-limits-wiring.test.ts`.
 */

import { describe, expect, test } from 'bun:test';

import {
  BASH_FAILURE_INLINE_CHARS,
  BASH_MAX_OUTPUT_LENGTH_COMPAT_ENV,
  BASH_MAX_OUTPUT_LENGTH_ENV,
  BASH_READ_BACK_CHARS_DEFAULT,
  BASH_READ_BACK_CHARS_MAX,
  BASH_VALID_INLINE_CHARS,
  applyBashOutputLimits,
  buildBashFailureExcerpt,
  classifyBashResult,
  isBenignExitOne,
  resolveBashReadBackChars,
} from '../bash-output-limits.ts';

describe('the published numbers', () => {
  test('match the page: 30,000 read-back, 150,000 ceiling, 10,000 failure excerpt', () => {
    expect(BASH_READ_BACK_CHARS_DEFAULT).toBe(30_000);
    expect(BASH_READ_BACK_CHARS_MAX).toBe(150_000);
    expect(BASH_FAILURE_INLINE_CHARS).toBe(10_000);
    expect(BASH_VALID_INLINE_CHARS).toBe(30_000);
  });
});

describe('resolveBashReadBackChars', () => {
  test('unset -> the documented 30000 default', () => {
    expect(resolveBashReadBackChars({})).toBe(BASH_READ_BACK_CHARS_DEFAULT);
  });

  test('a set value inside the range is honoured, via either spelling', () => {
    expect(resolveBashReadBackChars({ [BASH_MAX_OUTPUT_LENGTH_ENV]: '90000' })).toBe(90_000);
    expect(resolveBashReadBackChars({ [BASH_MAX_OUTPUT_LENGTH_COMPAT_ENV]: '90000' })).toBe(90_000);
  });

  test('the Nessy name wins when both are set', () => {
    expect(resolveBashReadBackChars({
      [BASH_MAX_OUTPUT_LENGTH_ENV]: '40000',
      [BASH_MAX_OUTPUT_LENGTH_COMPAT_ENV]: '90000',
    })).toBe(40_000);
  });

  test('150000 is a ceiling, not a suggestion - a larger request is clamped', () => {
    expect(resolveBashReadBackChars({ [BASH_MAX_OUTPUT_LENGTH_ENV]: '150000' })).toBe(150_000);
    expect(resolveBashReadBackChars({ [BASH_MAX_OUTPUT_LENGTH_ENV]: '150001' })).toBe(150_000);
    expect(resolveBashReadBackChars({ [BASH_MAX_OUTPUT_LENGTH_ENV]: '99999999' })).toBe(150_000);
  });

  // P6.565 · `BASH_MAX_OUTPUT_LENGTH`'s row in `env-vars.md` notes nothing about
  // plain digits, so the Variables paragraph's general clause reaches it: `2e4`
  // and `30_000` are legal spellings, not malformed ones. `2e4` used to take the
  // default here, which meant an operator who wrote it got 30 000 while the
  // vendored binary read 20 000 off the same variable.
  test.each([
    ['2e4', 20_000],
    ['30_000', 30_000],
    ['1.5e5', 150_000],
  ])('the general rule accepts %p -> %p', (raw, expected) => {
    expect(resolveBashReadBackChars({ [BASH_MAX_OUTPUT_LENGTH_ENV]: raw })).toBe(expected);
  });

  test.each(['0', '-1', '30000.5', '0x1', '30__000', 'lots', ''])(
    'a value %p the general rule refuses, or zero, takes the default rather than shrinking the window',
    (raw) => {
      expect(resolveBashReadBackChars({ [BASH_MAX_OUTPUT_LENGTH_ENV]: raw }))
        .toBe(BASH_READ_BACK_CHARS_DEFAULT);
    },
  );
});

describe('isBenignExitOne', () => {
  test.each([
    ['grep pattern file', true],
    ['rg -n pattern', true],
    ['egrep x f', true],
    ['fgrep x f', true],
    ['find . -name x', true],
    ['diff a b', true],
    ['test -f x', true],
    ['[ -f x ]', true],
    ['/usr/bin/grep x f', true],
    ['git diff --stat', true],
    ['git grep pattern', true],
    ['git -c core.pager=cat diff', true],
    // Recorded limitation, not an oversight: a global option with a SEPARATE
    // argument is not unpicked, so this classifies as a failure. Over-strict is
    // the safe side - the model gets the smaller excerpt, never a larger one.
    ['git -C /repo diff', false],
    // Named by the page as failures despite a benign exit 1 - do not "fix" in.
    ['pgrep node', false],
    ['jq -e .x f.json', false],
    ['cmp a b', false],
    // git, but not one of the two named subcommands.
    ['git status', false],
    ['git log', false],
    ['bun test', false],
    ['', false],
  ])('%p -> %p', (command, expected) => {
    expect(isBenignExitOne(command)).toBe(expected);
  });
});

describe('classifyBashResult', () => {
  test('exit 0 is always valid', () => {
    expect(classifyBashResult({ command: 'pgrep node', exitCode: 0 })).toBe('valid');
  });

  test('exit 1 is valid only for the recognized commands', () => {
    expect(classifyBashResult({ command: 'grep x f', exitCode: 1 })).toBe('valid');
    expect(classifyBashResult({ command: 'git diff --exit-code', exitCode: 1 })).toBe('valid');
    expect(classifyBashResult({ command: 'pgrep node', exitCode: 1 })).toBe('failure');
    expect(classifyBashResult({ command: 'jq -e .x f', exitCode: 1 })).toBe('failure');
  });

  test('any other non-zero exit is a failure even for a recognized command', () => {
    expect(classifyBashResult({ command: 'grep x f', exitCode: 2 })).toBe('failure');
    expect(classifyBashResult({ command: 'grep x f', exitCode: null })).toBe('failure');
  });
});

describe('buildBashFailureExcerpt', () => {
  test('output within the limit is returned untouched', () => {
    expect(buildBashFailureExcerpt('short', 100)).toBe('short');
    expect(buildBashFailureExcerpt('x'.repeat(100), 100)).toBe('x'.repeat(100));
  });

  test('a head-and-tail excerpt keeps exactly the promised number of characters', () => {
    const text = `${'H'.repeat(500)}${'M'.repeat(9_000)}${'T'.repeat(500)}`;
    const excerpt = buildBashFailureExcerpt(text, 100);
    const kept = excerpt.replace(/\n… \[.*?\] …\n/, '');
    expect(kept).toHaveLength(100);
    expect(kept.startsWith('H')).toBe(true);
    expect(kept.endsWith('T')).toBe(true);
  });

  test('the excerpt announces the omission, so truncation is not read as completion', () => {
    const excerpt = buildBashFailureExcerpt('y'.repeat(1_000), 100);
    expect(excerpt).toContain('900 of 1000 characters omitted');
  });

  test('the default limit is the documented ~10,000 characters', () => {
    const excerpt = buildBashFailureExcerpt('z'.repeat(50_000));
    const kept = excerpt.replace(/\n… \[.*?\] …\n/, '');
    expect(kept).toHaveLength(BASH_FAILURE_INLINE_CHARS);
  });

  test('a non-positive limit yields nothing rather than throwing', () => {
    expect(buildBashFailureExcerpt('abc', 0)).toBe('');
  });
});

describe('applyBashOutputLimits', () => {
  const failing = { command: 'make build', exitCode: 2 };

  test('leaves a valid result exactly as it is', () => {
    // The file-plus-preview tier owns oversized valid results, at a threshold
    // more generous than the page's. Cutting here would show the model less.
    const huge = 'v'.repeat(BASH_READ_BACK_CHARS_MAX * 2);
    expect(applyBashOutputLimits({ command: 'ls', exitCode: 0, text: huge })).toBe(huge);
  });

  test('leaves a benign exit 1 alone as well', () => {
    const huge = 'g'.repeat(BASH_FAILURE_INLINE_CHARS * 3);
    expect(applyBashOutputLimits({ command: 'git grep needle', exitCode: 1, text: huge })).toBe(huge);
  });

  test('excerpts a failure head-and-tail at the documented size', () => {
    const text = `START${'m'.repeat(BASH_FAILURE_INLINE_CHARS * 2)}END`;
    const out = applyBashOutputLimits({ ...failing, text });
    expect(out).toContain('START');
    expect(out).toContain('END');
    expect(out).toContain('characters omitted');
  });

  test('a signal-killed command with no exit code is a failure', () => {
    // `exitCode: null` is the shape a kill leaves behind; the failure side is
    // the one that shows the tail, which is where a kill's reason lands.
    const text = `START${'k'.repeat(BASH_FAILURE_INLINE_CHARS * 2)}END`;
    const out = applyBashOutputLimits({ command: 'sleep 100', exitCode: null, text });
    expect(out).toContain('END');
  });

  test('BASH_MAX_OUTPUT_LENGTH widens the window the excerpt is cut from', () => {
    // P2.367: the operator's variable did nothing at all on this runtime. Sizes
    // are measured against the SHIPPED 30 000 default, never a dialled-down knob.
    const text = `START${'w'.repeat(BASH_READ_BACK_CHARS_DEFAULT * 2)}END`;

    const defaulted = applyBashOutputLimits({ ...failing, text, env: {} });
    expect(defaulted).not.toContain('END');
    expect(defaulted).toContain(`read back ${BASH_READ_BACK_CHARS_DEFAULT} of ${text.length} characters`);

    const widened = applyBashOutputLimits({
      ...failing,
      text,
      env: { [BASH_MAX_OUTPUT_LENGTH_COMPAT_ENV]: String(BASH_READ_BACK_CHARS_MAX) },
    });
    expect(widened).toContain('END');
    // The window now covers the whole output, so there is nothing left to warn
    // about — only the excerpt's own omission marker remains.
    expect(widened).not.toContain('read back');

    // The Nessy spelling does the same job.
    const nessy = applyBashOutputLimits({
      ...failing,
      text,
      env: { [BASH_MAX_OUTPUT_LENGTH_ENV]: String(BASH_READ_BACK_CHARS_MAX) },
    });
    expect(nessy).toContain('END');
  });

  test('the widened-window notice names the variable an operator would set', () => {
    const text = 'n'.repeat(BASH_READ_BACK_CHARS_DEFAULT + 1);
    expect(applyBashOutputLimits({ ...failing, text, env: {} }))
      .toContain(BASH_MAX_OUTPUT_LENGTH_COMPAT_ENV);
  });
});

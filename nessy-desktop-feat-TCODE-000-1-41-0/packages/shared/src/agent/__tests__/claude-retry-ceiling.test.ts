/**
 * CLR-12 — the interactive retry ceiling on the Claude subprocess env.
 *
 * The live audit measured a hard-stalled upstream holding a session on
 * `Responding…` for 14 minutes (re-POSTs at +92 s, +268 s, +301 s) because
 * `env-vars.md` puts `CLAUDE_CODE_MAX_RETRIES` at a default of 10 — right for a
 * headless worker, wrong for a person watching a spinner.
 *
 * The two negative cases matter as much as the positive one: this must not
 * override an operator's explicit value, and it must stand down under
 * `CLAUDE_CODE_RETRY_WATCHDOG`, which the page names as the switch for
 * unattended sessions that need to wait out long outages.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { buildClaudeSubprocessEnv, INTERACTIVE_MAX_RETRIES } from '../options.ts';

const TOUCHED = ['CLAUDE_CODE_MAX_RETRIES', 'CLAUDE_CODE_RETRY_WATCHDOG'] as const;
const saved = new Map<string, string | undefined>();
for (const key of TOUCHED) saved.set(key, process.env[key]);

afterEach(() => {
  for (const key of TOUCHED) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('CLR-12 interactive retry ceiling', () => {
  it('caps retries so a stalled upstream surfaces an error instead of an open-ended wait', () => {
    delete process.env.CLAUDE_CODE_MAX_RETRIES;
    delete process.env.CLAUDE_CODE_RETRY_WATCHDOG;

    const env = buildClaudeSubprocessEnv();

    expect(env.CLAUDE_CODE_MAX_RETRIES).toBe(String(INTERACTIVE_MAX_RETRIES));
    // The point is that it is BELOW the SDK's documented default of 10 — a bare
    // "is defined" assertion would pass on a value that changes nothing.
    expect(Number(env.CLAUDE_CODE_MAX_RETRIES)).toBeLessThan(10);
  });

  it('never overrides an operator who set the value themselves', () => {
    delete process.env.CLAUDE_CODE_RETRY_WATCHDOG;
    process.env.CLAUDE_CODE_MAX_RETRIES = '9';

    expect(buildClaudeSubprocessEnv().CLAUDE_CODE_MAX_RETRIES).toBe('9');
  });

  it('respects a value supplied through envOverrides, not just an ambient one', () => {
    delete process.env.CLAUDE_CODE_MAX_RETRIES;
    delete process.env.CLAUDE_CODE_RETRY_WATCHDOG;

    const env = buildClaudeSubprocessEnv({ CLAUDE_CODE_MAX_RETRIES: '7' });

    expect(env.CLAUDE_CODE_MAX_RETRIES).toBe('7');
  });

  it('stands down under CLAUDE_CODE_RETRY_WATCHDOG, the documented unattended switch', () => {
    delete process.env.CLAUDE_CODE_MAX_RETRIES;

    for (const truthy of ['1', 'true', 'YES', ' on ']) {
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = truthy;
      expect(buildClaudeSubprocessEnv().CLAUDE_CODE_MAX_RETRIES).toBeUndefined();
    }
  });

  it('still caps when the watchdog is present but switched off', () => {
    delete process.env.CLAUDE_CODE_MAX_RETRIES;
    process.env.CLAUDE_CODE_RETRY_WATCHDOG = '0';

    expect(buildClaudeSubprocessEnv().CLAUDE_CODE_MAX_RETRIES).toBe(String(INTERACTIVE_MAX_RETRIES));
  });
});

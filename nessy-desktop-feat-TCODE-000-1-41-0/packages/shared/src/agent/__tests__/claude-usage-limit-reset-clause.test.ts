/**
 * P6.503 (Q-den 20 = A) — the claude arm's usage-limit message says which of the
 * two happened, instead of spelling the absence as an empty string.
 *
 * The adapter already printed a PUBLISHED reset as *" Resets <date>."*; when the
 * server named none it appended `''`, so "no reset was published" and "we chose
 * not to print one" looked identical to the reader. That is the half-true
 * disclosure this fork keeps finding, and the sentence now comes from
 * `agent/usage-limit-reset.ts` so the claude and codex arms cannot word it
 * differently.
 *
 * ## The one decision this suite exists to pin, and where it was read from
 *
 * The stop-sentence is gated on `status === 'rejected'`. `SDKRateLimitInfo` in
 * the vendored `sdk.d.ts` declares `resetsAt?: number` — OPTIONAL on all three
 * statuses, `allowed_warning` included — so the approaching warning really can
 * arrive with no reset. Nothing has stopped in that case, so printing *"the turn
 * stops here rather than waiting"* beside *"Approaching your usage limit"* would
 * state a false consequence: worse than the silence it replaced, not better.
 * Read from the SDK type rather than assumed, because the alternative is an
 * invented answer that looks obviously right.
 */
import { describe, expect, it } from 'bun:test';
import { ClaudeEventAdapter, type ClaudeAdapterCallbacks } from '../backend/claude/event-adapter.ts';
import type { AgentEvent } from '@nessy-agent/core/types';
import { buildClaudeFlagSettingsOptions } from '../claude-auto-mode-policy.ts';

const callbacks: ClaudeAdapterCallbacks = {
  onDebug: undefined,
  mapSDKError: async () => ({
    type: 'typed_error' as const,
    error: { code: 'unknown_error', title: 't', message: 'm', details: [], actions: [], canRetry: false },
  }),
};

async function rateLimitEvents(info: Record<string, unknown>): Promise<AgentEvent[]> {
  const adapter = new ClaudeEventAdapter(callbacks);
  adapter.startTurn();
  return adapter.adapt({ type: 'rate_limit_event', rate_limit_info: info } as never);
}

const messageOf = (events: AgentEvent[]): string =>
  (events[0] as { message?: string } | undefined)?.message ?? '';

describe('a rejected turn always says which of the two happened', () => {
  it('prints the instant the server named', async () => {
    // 2026-01-02T03:04:05Z in Unix SECONDS — the unit the typings do not state
    // and Anthropic\'s own rate-limit headers use.
    const events = await rateLimitEvents({ status: 'rejected', resetsAt: 1767322445 });
    expect(messageOf(events)).toContain('Usage limit reached.');
    expect(messageOf(events)).toContain('resets');
    expect(messageOf(events)).not.toContain('No reset time was published');
  });

  /**
   * P6.373 — the stopping arm runs through the resume-vs-stop gate, so the
   * message names the SETTING that decided it. `NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT`
   * defaults to `true` (the page's own default for the key it mirrors), so this
   * is what an unconfigured install prints.
   *
   * P7.13 INVERTED THE SECOND HALF, and the inversion is the assertion. This
   * test used to require that the arm did NOT say "then continuing", because
   * `awaitUsageLimitReset` had no in-tree caller and the adapter therefore
   * passed `waitIsWired: false`. The vendored `0.3.247` runtime performs the
   * wait itself and `buildClaudeFlagSettingsOptions` hands it the host's answer,
   * so the promise is now one the runtime keeps and the adapter drops the
   * argument. The negative half moves to the SETTING-OFF case below, which is
   * the arm that must still refuse to promise anything.
   */
  it('names the setting that decided it, and promises the continuation the runtime performs', async () => {
    // F1.602 · `=1` is printed only when the operator set it; unset (what an
    // unconfigured install has) names the default instead, and the two messages
    // differ only inside that parenthesis.
    const previous = process.env.NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT;
    try {
      delete process.env.NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT;
      process.env.NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT = '1';
      const set = messageOf(await rateLimitEvents({ status: 'rejected', resetsAt: 1767322445 }));
      delete process.env.NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT;
      const message = messageOf(await rateLimitEvents({ status: 'rejected', resetsAt: 1767322445 }));

      expect(set).toContain('(NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT=1)');
      expect(message).not.toContain('NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT=1');
      expect(message).toContain('(the default; NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT=0 turns it off)');
      expect(set.replace('(NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT=1)', '(X)'))
        .toBe(message.replace('(the default; NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT=0 turns it off)', '(X)'));
      expect(message).toContain('then continuing');
      expect(message).toMatch(/Waiting until/);
      // The sentence the unwired arm prints, unreachable on the claude resume verdict.
      expect(message).not.toContain('does not perform');
    } finally {
      delete process.env.NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT;
      if (previous !== undefined) process.env.NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT = previous;
    }
  });

  /**
   * P7.13 · the projection is what makes the sentence above true, so the two are
   * asserted together — a promise whose mechanism was never handed over is the
   * defect this pairing exists to prevent.
   */
  it('the host answer really is projected onto the runtime\'s own setting', () => {
    const previous = process.env.NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT;
    delete process.env.NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT;
    try {
      // Unset: the vendor's documented default, sent explicitly rather than
      // left to the child's `autoContinueKeyPresence` heuristic.
      expect(buildClaudeFlagSettingsOptions({}).settings)
        .toMatchObject({ autoContinueAtUsageLimit: true });
      process.env.NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT = '0';
      expect(buildClaudeFlagSettingsOptions({}).settings)
        .toMatchObject({ autoContinueAtUsageLimit: false });
    } finally {
      delete process.env.NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT;
      if (previous !== undefined) process.env.NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT = previous;
    }
  });

  it('says so plainly when the operator turned the setting off', async () => {
    const previous = process.env.NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT;
    delete process.env.NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT;
    process.env.NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT = '0';
    try {
      const message = messageOf(await rateLimitEvents({ status: 'rejected', resetsAt: 1767322445 }));
      expect(message).toContain('NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT=0');
      expect(message).toContain('stops here rather than waiting');
    } finally {
      delete process.env.NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT;
      if (previous !== undefined) process.env.NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT = previous;
    }
  });

  it('says the absence out loud when the server named none', async () => {
    const events = await rateLimitEvents({ status: 'rejected' });
    expect(messageOf(events)).toContain('Usage limit reached.');
    expect(messageOf(events)).toContain('No reset time was published with this limit');
  });
});

describe('the approaching warning never claims the turn stopped', () => {
  it('still prints a published reset', async () => {
    const events = await rateLimitEvents({ status: 'allowed_warning', resetsAt: 1767322445 });
    expect(messageOf(events)).toContain('Approaching your usage limit');
    expect(messageOf(events)).toContain('Resets');
  });

  it('stays silent about a reset it was not given — nothing has stopped', async () => {
    const events = await rateLimitEvents({ status: 'allowed_warning' });
    expect(messageOf(events)).toContain('Approaching your usage limit');
    expect(messageOf(events)).not.toContain('No reset time was published');
    expect(messageOf(events)).not.toContain('stops here');
  });
});

describe('the ordinary case is still silent', () => {
  it('emits nothing at all on `allowed`', async () => {
    expect(await rateLimitEvents({ status: 'allowed', resetsAt: 1767322445 })).toEqual([]);
  });
});

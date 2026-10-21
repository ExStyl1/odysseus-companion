/**
 * F1.569 (origin WJ-bf P-WJbf-4, 2026-09-24) — F1.204's reset-time half, closed
 * on the ChatGPT (Codex) card: a codex turn stopped by `usageLimitExceeded` on a
 * session that holds codex's own usage windows names the window's reset,
 * instead of saying no reset was published.
 *
 * ## Why the old sentence became false on this card
 *
 * The signal that stops the turn is still a BARE STRING (`CodexErrorInfo`
 * `"usageLimitExceeded"`, `codex-usage-limit-reset.test.ts` re-pins that), so
 * the error alone carries no instant. But since F1.202 the card signs codex in
 * to a ChatGPT account, so the session HOLDS `RateLimitWindow.resetsAt`: from a
 * `/quota` read (`account/rateLimits/read`) or from an `account/rateLimits/updated`
 * push (F1.7). And codex's OWN message on that backend already says "Try again
 * at …" when the 429 body carries `resets_at` (`UsageLimitReachedError`'s
 * `Display`, `protocol/src/error.rs` at `rust-v0.156.1`). "No reset time was
 * published" appended after that would contradict codex in the same line.
 *
 * ## The pairing (D1.189's), and what it deliberately does not do
 *
 * The instant is the latest FUTURE reset among the windows codex reports FULL
 * (`usedPercent >= 100`): usage returns only when every exhausted window has
 * reset. A window that is not full did not stop the turn, and a reset already in
 * the past is not a deadline, so neither is named. Nothing is estimated.
 *
 * Codex performs NO wait: the turn has ended when this error arrives, and no
 * code re-drives it. So the codex clause says the reset and that the turn stops
 * (`waitIsWired: false`), never "waiting until … then continuing". That was a
 * latent false promise on this arm: `codexUsageLimitResetClause` would have
 * printed the waiting sentence the day any instant reached it.
 *
 * WHAT EACH ARM KILLS: a pairing that names a window that is not full, a past
 * reset, or the earlier of two exhausted resets; a codex sentence that promises
 * a continuation nothing performs; a card whose `/quota` read or window push does
 * not reach the stop sentence; a gateway session whose sentence moves (CONTROL).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import {
  codexUsageLimitWindowReset,
  type CodexAccountWindows,
  type CodexRateLimitWindow,
} from '../backend/codex/rate-limit-windows.ts';
import { CodexAgent } from '../codex-agent.ts';
import { AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR, codexUsageLimitResetClause } from '../usage-limit-reset.ts';

const NOW_MS = Date.now();
/** Unix SECONDS, the unit codex publishes; both in the future. */
const FIVE_HOUR_RESET_S = Math.floor(NOW_MS / 1000) + 2 * 3600;
const WEEKLY_RESET_S = Math.floor(NOW_MS / 1000) + 3 * 86_400;
const PAST_RESET_S = Math.floor(NOW_MS / 1000) - 600;

const win = (usedPercent: number, windowDurationMins: number, resetsAt: number | null): CodexRateLimitWindow =>
  ({ usedPercent, windowDurationMins, resetsAt });
const windows = (primary: CodexRateLimitWindow | null, secondary: CodexRateLimitWindow | null): CodexAccountWindows => ({
  ordinaryUsageAllowed: false,
  snapshot: {
    limitId: 'codex', limitName: null, primary, secondary, credits: null,
    planType: 'plus', rateLimitReachedType: 'rate_limit_reached', spendControlReached: null,
  },
});
const rateLimits = (primary: CodexRateLimitWindow, secondary: CodexRateLimitWindow) => ({
  limitId: 'codex', limitName: null, normalModelSlug: null, primary, secondary, credits: null,
  individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: 'rate_limit_reached',
});

// The operator's resume-vs-stop setting is read from the process env; this
// file measures the DEFAULT (unset), so it is removed for the file and put back.
// `delete` first, then assign — the bun 1.3.14 spread trap AGENTS.md records.
const savedSetting = process.env[AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR];
beforeAll(() => { delete process.env[AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR]; });
afterAll(() => {
  delete process.env[AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR];
  if (savedSetting !== undefined) process.env[AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR] = savedSetting;
});

describe('F1.569 · which window\'s reset pairs with the usage-limit stop', () => {
  it('the full window\'s future reset, in epoch ms', () => {
    expect(codexUsageLimitWindowReset(windows(win(100, 300, FIVE_HOUR_RESET_S), win(40, 10_080, WEEKLY_RESET_S)), NOW_MS))
      .toBe(FIVE_HOUR_RESET_S * 1000);
  });

  it('two full windows: the LATER reset, because usage returns only when both have reset', () => {
    expect(codexUsageLimitWindowReset(windows(win(100, 300, FIVE_HOUR_RESET_S), win(100, 10_080, WEEKLY_RESET_S)), NOW_MS))
      .toBe(WEEKLY_RESET_S * 1000);
  });

  it('no full window, a past reset, a missing reset or no windows at all: nothing is named', () => {
    expect(codexUsageLimitWindowReset(windows(win(99.4, 300, FIVE_HOUR_RESET_S), win(40, 10_080, WEEKLY_RESET_S)), NOW_MS)).toBeNull();
    expect(codexUsageLimitWindowReset(windows(win(100, 300, PAST_RESET_S), null), NOW_MS)).toBeNull();
    expect(codexUsageLimitWindowReset(windows(win(100, 300, null), null), NOW_MS)).toBeNull();
    expect(codexUsageLimitWindowReset(windows(null, null), NOW_MS)).toBeNull();
    expect(codexUsageLimitWindowReset(null, NOW_MS)).toBeNull();
  });
});

describe('F1.569 · the codex clause names the reset and promises no continuation', () => {
  const iso = (ms: number) => new Date(ms).toISOString();

  it('a published instant: the reset, and the turn stops — codex performs no wait', () => {
    const clause = codexUsageLimitResetClause('usageLimitExceeded', FIVE_HOUR_RESET_S * 1000, iso);
    expect(clause).toContain(`The limit resets ${iso(FIVE_HOUR_RESET_S * 1000)}.`);
    expect(clause).toContain('the turn stops here');
    expect(clause).not.toContain('Waiting until');
    expect(clause).not.toContain('continuing automatically');
    // F1.600 · decided, not pending: codex's own posture is to stop, so the
    // clause says how to continue instead of promising a later build.
    expect(clause).not.toContain('yet');
    expect(clause).toContain(`Send a message after ${iso(FIVE_HOUR_RESET_S * 1000)} to continue.`);
  });

  it('CONTROL: no instant keeps the measured sentence, byte for byte', () => {
    expect(codexUsageLimitResetClause('usageLimitExceeded', undefined, iso))
      .toBe(' No reset time was published with this limit, so the turn stops here rather than waiting.');
  });
});

function createAgent(): CodexAgent {
  return new CodexAgent({
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-f1569', name: 'Reset Workspace', rootPath: '/tmp/nessy-f1569-ws',
      workspaceRootPath: '/tmp/nessy-f1569-ws', sessionRootPath: '/tmp/nessy-f1569-sessions/ws-f1569',
    } as never,
    session: {
      id: 'session-f1569', workspaceRootPath: '/tmp/nessy-f1569-ws', createdAt: Date.now(),
      lastUsedAt: Date.now(), workingDirectory: '/tmp/nessy-f1569-project',
    } as never,
    model: 'gpt-6-astra',
    isHeadless: true,
  } as BackendConfig);
}

type Internals = {
  client: unknown;
  turnSink: { push(event: AgentEvent): void } | null;
  handleNotification(method: string, params: unknown): void;
  describeQuota(): AsyncGenerator<AgentEvent>;
};

/** A fake app-server answering the two account reads the card's `/quota` makes. */
function fakeAppServer(limits: unknown): { request(method: string): Promise<unknown> } {
  const answers: Record<string, unknown> = {
    'account/read': { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true },
    'account/rateLimits/read': { ordinaryUsageAllowed: false, rateLimits: limits },
  };
  return {
    async request(method: string) {
      if (!(method in answers)) throw new Error(`fake app-server: unexpected ${method}`);
      return answers[method];
    },
  };
}

/**
 * The usage-limit error as codex sends it. The turn it names is not the agent's
 * active one, so the stop-hook arm stays out of this unit; the message push is
 * unconditional on a non-retrying error.
 */
function stopOnUsageLimit(agent: CodexAgent): string {
  const internals = agent as unknown as Internals;
  const pushed: AgentEvent[] = [];
  // Production has a sink at this moment: the error arrives inside a turn.
  internals.turnSink = { push: event => { pushed.push(event); } };
  internals.handleNotification('error', {
    error: { message: 'You’ve hit your usage limit.', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null },
    willRetry: false, threadId: 'thread-f1569', turnId: 'turn-elsewhere',
  });
  internals.turnSink = null;
  const errors = pushed.filter(event => event.type === 'error');
  expect(errors).toHaveLength(1);
  return errors[0]?.type === 'error' ? errors[0].message : '';
}

describe('F1.569 · CodexAgent pairs the stop with the windows it holds', () => {
  it('the card: a /quota read with reset times names each window\'s reset, and the stop names the full one\'s', async () => {
    const agent = createAgent();
    try {
      const internals = agent as unknown as Internals;
      internals.client = fakeAppServer(rateLimits(win(100, 300, FIVE_HOUR_RESET_S), win(61, 10_080, WEEKLY_RESET_S)));
      const quota: AgentEvent[] = [];
      for await (const event of internals.describeQuota()) quota.push(event);
      internals.client = null;
      const answer = quota[0]?.type === 'info' ? quota[0].message : '';
      // CONTROL (the row's): /quota names each window's reset time.
      expect(answer).toContain(`(resets ${new Date(FIVE_HOUR_RESET_S * 1000).toISOString()})`);
      expect(answer).toContain(`(resets ${new Date(WEEKLY_RESET_S * 1000).toISOString()})`);

      const message = stopOnUsageLimit(agent);
      expect(message).toContain(`The limit resets ${new Date(FIVE_HOUR_RESET_S * 1000).toLocaleString()}.`);
      expect(message).not.toContain('No reset time was published');
      expect(message).not.toContain('Waiting until');
    } finally {
      agent.destroy();
    }
  });

  it('the card, fed by the account/rateLimits/updated push alone', () => {
    const agent = createAgent();
    try {
      (agent as unknown as Internals).handleNotification('account/rateLimits/updated', {
        rateLimits: rateLimits(win(100, 300, FIVE_HOUR_RESET_S), win(100, 10_080, WEEKLY_RESET_S)),
      });
      expect(stopOnUsageLimit(agent)).toContain(`The limit resets ${new Date(WEEKLY_RESET_S * 1000).toLocaleString()}.`);
    } finally {
      agent.destroy();
    }
  });

  it('CONTROL: a session with no codex account (the gateway card) keeps the measured sentence', () => {
    const agent = createAgent();
    try {
      const message = stopOnUsageLimit(agent);
      expect(message).toContain('No reset time was published with this limit');
      expect(message).not.toContain('The limit resets');
    } finally {
      agent.destroy();
    }
  });

  it('the emit site reads the held windows, after anything the error itself stamps', () => {
    const source = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');
    expect(source).toContain('codexError?.resetsAt ?? codexUsageLimitWindowReset(this.codexAccountWindows)');
  });
});

/**
 * F1.7 (origin D1.77) — `/quota` on a codex session reads codex's OWN usage
 * windows when codex itself names a ChatGPT account on the session, and says
 * the measured null everywhere else. This file used to pin that null alone
 * (C4.28); what it pins moved with the row, and the reason is the row's.
 *
 * ## C4.28, the measurement this row stands on (kept, not deleted)
 *
 * codex publishes the usage window natively — `account/rateLimits/read` and the
 * `account/rateLimits/updated` notification carrying
 * `RateLimitWindow { usedPercent, windowDurationMins, resetsAt }`. Measured
 * 2026-09-11 on the shipped `codex-app-server 0.150.1` behind this fork's
 * loopback adapter, no credential: `account/rateLimits/read` →
 * `-32600 "codex account authentication required to read rate limits"`,
 * `account/read` → `{ account: null, requiresOpenaiAuth: false }`, no window
 * notification in the boot, zero proxy-sink attempts — local and structural.
 *
 * ## What changed (OWNER 2026-09-18 ~16:40, item 3, build (b))
 *
 * *"a personal subscription card uses the subscription's own windows through
 * `account/rateLimits/read` + `account/rateLimits/updated`"*. So the reader
 * exists now (`backend/codex/rate-limit-windows.ts`), and the C4.28 verdict —
 * "a call that cannot succeed must not render an error as a budget" — is kept
 * as a BEHAVIOUR rather than as the old source-text absence: `account/read`
 * is asked first (it answers without an account), and `account/rateLimits/read`
 * is sent ONLY when codex names a `chatgpt` account. The source-text absence
 * pin is REPLACED by the no-account arms below, which would fail on a reader
 * that called the window read unconditionally; kept as text it would have
 * passed vacuously, because the call now lives in the reader module.
 *
 * ## The residue, and what F1.202 changed about it
 *
 * Since F1.202 (2026-09-24) ONE card signs codex in to a ChatGPT account: the
 * ChatGPT (Codex) card, through `account/login/start` `chatgptAuthTokens`
 * (`codex-chatgpt-subscription-login.test.ts` drives it). Every other codex
 * card still authenticates against our loopback adapter with no `auth.json`,
 * so there the no-account branch runs. The windows branch is still exercised
 * here over a fake app-server answering both methods; the live reading on the
 * owner's subscription is F1.8's sitting.
 *
 * WHAT EACH TEST KILLS:
 *  - the reader arms die if the window read is sent without an account, if a
 *    failed read renders as a number, or if a sparse update clears a value it
 *    did not carry;
 *  - the CodexAgent arms drive the real `describeQuota` over a live client (a
 *    fake app-server planted where the runtime puts its client), and the
 *    UN-planted arm is the negative the AGENTS.md planted-collaborator trap asks
 *    for: with no runtime running, nothing is asked and nothing is spawned;
 *  - the notification arm dies if `account/rateLimits/updated` goes back to the
 *    unread list or stops reaching `/quota`.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import {
  CODEX_ACCOUNT_READ_TIMEOUT_MS,
  formatCodexAccountWindows,
  mergeCodexRateLimitUpdate,
  readCodexAccountWindows,
  type CodexAccountWindows,
} from '../backend/codex/rate-limit-windows.ts';
import { CodexAgent } from '../codex-agent.ts';
import {
  HANDLED_CODEX_NOTIFICATION_METHOD_SET,
  UNREAD_CODEX_NOTIFICATION_METHOD_SET,
} from '../codex-notification-families.ts';

/** 2026-09-23T14:00:00Z in Unix SECONDS — the unit codex publishes. */
const RESETS_AT_SECONDS = 1_790_172_000;
const RESETS_AT_ISO = new Date(RESETS_AT_SECONDS * 1000).toISOString();

const CHATGPT_ACCOUNT = { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true };
const NO_ACCOUNT = { account: null, requiresOpenaiAuth: false };
const RATE_LIMITS = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: RESETS_AT_SECONDS },
    secondary: { usedPercent: 7.4, windowDurationMins: 10_080, resetsAt: null },
    credits: { hasCredits: true, unlimited: false, balance: '12.50' },
    individualLimit: null,
    spendControlReached: null,
    planType: null,
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: null,
  accountId: null,
  rateLimitUpsell: null,
};

interface Recorded { method: string; params: unknown; options: unknown }

/** A fake app-server: answers by method, records every request, throws on the unknown. */
function fakeAppServer(answers: Record<string, unknown | (() => never)>): {
  request(method: string, params?: unknown, options?: unknown): Promise<unknown>;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  return {
    requests,
    async request(method: string, params?: unknown, options?: unknown) {
      requests.push({ method, params, options });
      if (!(method in answers)) throw new Error(`fake app-server: unexpected ${method}`);
      const answer = answers[method];
      if (typeof answer === 'function') (answer as () => never)();
      return answer;
    },
  };
}

const methods = (requests: Recorded[]): string[] => requests.map(entry => entry.method);

describe('F1.7 · the reader asks for the windows only when codex names a ChatGPT account', () => {
  it('a ChatGPT account: account/read, then account/rateLimits/read, and the windows', async () => {
    const server = fakeAppServer({ 'account/read': CHATGPT_ACCOUNT, 'account/rateLimits/read': RATE_LIMITS });
    const read = await readCodexAccountWindows(server);

    expect(methods(server.requests)).toEqual(['account/read', 'account/rateLimits/read']);
    // Both requests carry a ceiling: `AppServerClient.request` has none by default.
    for (const entry of server.requests) expect(entry.options).toEqual({ timeoutMs: CODEX_ACCOUNT_READ_TIMEOUT_MS });
    expect(read.kind).toBe('windows');
    const windows = read.kind === 'windows' ? read.windows : null;
    expect(windows?.ordinaryUsageAllowed).toBe(true);
    expect(windows?.snapshot.primary).toEqual({ usedPercent: 42, windowDurationMins: 300, resetsAt: RESETS_AT_SECONDS });
    // The snapshot named no plan, so the ACCOUNT's plan is the authority.
    expect(windows?.snapshot.planType).toBe('plus');
  });

  it('NO account (the measured C4.28 answer): ONE request, and never the window read', async () => {
    const server = fakeAppServer({ 'account/read': NO_ACCOUNT, 'account/rateLimits/read': RATE_LIMITS });
    const read = await readCodexAccountWindows(server);

    expect(read).toEqual({ kind: 'no-account' });
    // The C4.28 verdict as behaviour: the call that cannot succeed is not made.
    expect(methods(server.requests)).toEqual(['account/read']);
  });

  it('an API-key account is not a subscription: no window read either', async () => {
    const server = fakeAppServer({ 'account/read': { account: { type: 'apiKey' }, requiresOpenaiAuth: false } });

    expect(await readCodexAccountWindows(server)).toEqual({ kind: 'no-account' });
    expect(methods(server.requests)).toEqual(['account/read']);
  });

  it('a refused window read is UNREADABLE with its reason — never a number', async () => {
    const server = fakeAppServer({
      'account/read': CHATGPT_ACCOUNT,
      'account/rateLimits/read': () => { throw new Error('codex account authentication required to read rate limits'); },
    });
    const read = await readCodexAccountWindows(server);

    expect(read.kind).toBe('unreadable');
    expect(read.kind === 'unreadable' ? read.reason : '').toContain('authentication required');
  });

  it('an account read that fails is unreadable too, and nothing else is asked', async () => {
    const server = fakeAppServer({ 'account/read': () => { throw new Error('app-server request account/read timed out after 10000ms'); } });

    expect((await readCodexAccountWindows(server)).kind).toBe('unreadable');
    expect(methods(server.requests)).toEqual(['account/read']);
  });
});

describe('F1.7 · rendering and the sparse update', () => {
  const windows: CodexAccountWindows = {
    ordinaryUsageAllowed: null,
    snapshot: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: RESETS_AT_SECONDS },
      secondary: { usedPercent: 7.4, windowDurationMins: 10_080, resetsAt: null },
      credits: { hasCredits: true, unlimited: false, balance: '12.50' },
      planType: 'plus',
      rateLimitReachedType: null,
      spendControlReached: null,
    },
  };

  it('renders each window, its reset in seconds-normalised ISO, the plan and the credits', () => {
    const text = formatCodexAccountWindows(windows);

    expect(text).toContain('Codex usage windows (ChatGPT plan: plus):');
    expect(text).toContain(`- 5-hour window: 42% used (resets ${RESETS_AT_ISO})`);
    // No published reset → no reset clause, rather than a fabricated one.
    expect(text).toContain('- Weekly window: 7% used\n');
    expect(text).toContain('- Credits: 12.50');
    // A NULL verdict prints no verdict: the generated field forbids inferring
    // recovery from percentages.
    expect(text).not.toContain('allowed');
    expect(text).not.toContain('blocked');
  });

  it('prints codex\'s verdict only when codex states one', () => {
    expect(formatCodexAccountWindows({ ...windows, ordinaryUsageAllowed: false })).toContain('Codex reports ordinary usage is blocked.');
    expect(formatCodexAccountWindows({ ...windows, ordinaryUsageAllowed: true })).toContain('Codex reports ordinary usage is allowed.');
  });

  it('a sparse update replaces what it carries and keeps what it leaves null', () => {
    const merged = mergeCodexRateLimitUpdate(windows, {
      rateLimits: {
        limitId: null, limitName: null,
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: RESETS_AT_SECONDS },
        secondary: null, credits: null, planType: null,
        rateLimitReachedType: 'rate_limit_reached', spendControlReached: null,
      },
    });

    expect(merged?.snapshot.primary?.usedPercent).toBe(100);
    expect(merged?.snapshot.rateLimitReachedType).toBe('rate_limit_reached');
    // Left null by the update → the previously observed value survives.
    expect(merged?.snapshot.secondary).toEqual(windows.snapshot.secondary);
    expect(merged?.snapshot.credits).toEqual(windows.snapshot.credits);
    expect(merged?.snapshot.planType).toBe('plus');
    expect(merged?.snapshot.limitId).toBe('codex');
  });

  it('an update with no snapshot changes nothing; the first update seeds the windows', () => {
    expect(mergeCodexRateLimitUpdate(windows, { nothing: true })).toBe(windows);
    expect(mergeCodexRateLimitUpdate(null, { rateLimits: RATE_LIMITS.rateLimits })?.snapshot.primary?.usedPercent).toBe(42);
  });
});

function createAgent(): CodexAgent {
  return new CodexAgent({
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-f17',
      name: 'Quota Workspace',
      rootPath: '/tmp/nessy-f17-ws',
      workspaceRootPath: '/tmp/nessy-f17-ws',
      sessionRootPath: '/tmp/nessy-f17-sessions/ws-f17',
    } as never,
    session: {
      id: 'session-f17',
      workspaceRootPath: '/tmp/nessy-f17-ws',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/nessy-f17-project',
    } as never,
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig);
}

/** Plant the fake where the runtime keeps its live app-server client. */
function withLiveClient(agent: CodexAgent, server: ReturnType<typeof fakeAppServer>): CodexAgent {
  (agent as unknown as { client: unknown }).client = server;
  return agent;
}

async function quota(agent: CodexAgent): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  try {
    const generator = (agent as unknown as { describeQuota: () => AsyncGenerator<AgentEvent> }).describeQuota();
    for await (const event of generator) events.push(event);
  } finally {
    (agent as unknown as { client: unknown }).client = null;
    agent.destroy();
  }
  return events;
}

function onlyMessage(events: AgentEvent[]): string {
  expect(events.map(event => event.type)).toEqual(['info']);
  return events[0]?.type === 'info' ? events[0].message : '';
}

describe('F1.7 · CodexAgent.describeQuota over the live app-server', () => {
  it('a session codex signed in to ChatGPT: the subscription\'s own windows', async () => {
    const server = fakeAppServer({ 'account/read': CHATGPT_ACCOUNT, 'account/rateLimits/read': RATE_LIMITS });
    const message = onlyMessage(await quota(withLiveClient(createAgent(), server)));

    expect(methods(server.requests)).toEqual(['account/read', 'account/rateLimits/read']);
    expect(message).toContain('Codex usage windows (ChatGPT plan: plus):');
    expect(message).toContain('42% used');
    expect(message).toContain('Codex reports ordinary usage is allowed.');
    expect(message).not.toContain('Quota is not available');
  });

  it('CONTROL — no subscription on the session: the measured null, and no window read', async () => {
    const server = fakeAppServer({ 'account/read': NO_ACCOUNT, 'account/rateLimits/read': RATE_LIMITS });
    const events = await quota(withLiveClient(createAgent(), server));
    const message = onlyMessage(events);

    expect(methods(server.requests)).toEqual(['account/read']);
    expect(message).toContain('Quota is not available on this runtime.');
    expect(message).toContain('account/rateLimits/read');
    expect(message).toContain('ChatGPT');
    expect(message).toContain('codex account');
    // F1.6 — this sentence reaches only a NON-gateway session, so it names the
    // connection's own endpoint rather than the Nessy Gateway.
    expect(message).toContain('the endpoint its connection names');
    expect(message).not.toContain('Nessy Gateway');
    // Never a number: an unpopulated window must not read as "0 % used".
    expect(message).not.toContain('%');
    expect(events[0]?.type === 'info' ? events[0].level : 'unset').not.toBe('warning');
  });

  it('a refused read says so beside the null, still with no number', async () => {
    const server = fakeAppServer({
      'account/read': () => { throw new Error('app-server request account/read timed out after 10000ms'); },
    });
    const message = onlyMessage(await quota(withLiveClient(createAgent(), server)));

    expect(message).toContain('Quota is not available on this runtime.');
    expect(message).toContain('timed out');
    expect(message).not.toContain('% used');
  });

  it('UN-PLANTED — no runtime running: nothing is asked, nothing is spawned, the null stands', async () => {
    const agent = createAgent();
    // The runtime was never started, which is what a `/quota` typed first finds.
    expect((agent as unknown as { client: unknown }).client ?? null).toBeNull();
    const message = onlyMessage(await quota(agent));

    expect(message).toContain('Quota is not available on this runtime.');
    expect(message).not.toContain('%');
  });
});

describe('F1.7 · account/rateLimits/updated is READ now', () => {
  it('is classified handled, and no longer on the unread list', () => {
    expect(HANDLED_CODEX_NOTIFICATION_METHOD_SET.has('account/rateLimits/updated')).toBe(true);
    expect(UNREAD_CODEX_NOTIFICATION_METHOD_SET.has('account/rateLimits/updated')).toBe(false);
    // Positive control: its two account neighbours stay unread, so the sets
    // are the real ones and not empty.
    expect(UNREAD_CODEX_NOTIFICATION_METHOD_SET.has('account/updated')).toBe(true);
    expect(UNREAD_CODEX_NOTIFICATION_METHOD_SET.has('account/login/completed')).toBe(true);
  });

  it('a pushed update reaches /quota even after the runtime has stopped, marked as such', async () => {
    const agent = createAgent();
    (agent as unknown as { handleNotification(method: string, params: unknown): void })
      .handleNotification('account/rateLimits/updated', { rateLimits: RATE_LIMITS.rateLimits });
    const message = onlyMessage(await quota(agent));

    expect(message).toContain('42% used');
    expect(message).toContain('As last pushed by codex');
  });
});

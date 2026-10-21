/**
 * P6.274 (a) — a retrying codex turn shows the retry chip instead of being
 * mislabelled as a failure.
 *
 * The row's verdict on F24 was DEMOTED from `absent` to `partial` by its own
 * sweep, and the demotion is the subject: *"a retrying codex turn is not silent,
 * it is MISLABELLED as an error"*. `ErrorNotification` carries `willRetry`
 * (`packages/codex-protocol/generated/v2/ErrorNotification.ts`), this agent has
 * always read it for turn-id lifecycle, and the error still went onto the
 * transcript as `{type:'error'}` while the turn was still going.
 *
 * ## What the assertions are really pinning, and why they read as string tests
 *
 * Since P6.916 the `status` branch carries an optional `retry` field and
 * `SessionManager` stamps `statusType: 'retrying'` off THAT, not off a prefix.
 * The sentence is still asserted below, and it is still a wire contract with the
 * renderer — but it is now DERIVED from the facts by `retryStatusEvent`
 * (`core/types/message.ts`), which is why a wrong fact shows up here as a wrong
 * sentence. The two other producers (`PiEventAdapter`'s `auto_retry_start`,
 * claude's `buildRetryFacts`) go through the same builder.
 *
 * ## The control is the case that did NOT change
 *
 * A non-retrying error still renders as an error — the row's own stated control,
 * and the half a status-only change would have quietly broken. Without it, "the
 * retry shows a chip" is equally satisfied by an implementation that never
 * reports a failure at all.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentRetryFacts } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';

interface Event { type: string; message?: string; retry?: AgentRetryFacts }

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-p6274',
      name: 'Retry Status Workspace',
      rootPath: '/tmp/nessy-p6274-ws',
      workspaceRootPath: '/tmp/nessy-p6274-ws',
      sessionRootPath: '/tmp/nessy-p6274-sessions/ws-p6274',
    } as any,
    session: {
      id: 'session-p6274',
      workspaceRootPath: '/tmp/nessy-p6274-ws',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/nessy-p6274-project',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/** A session with a turn open, because the sink is where both channels land. */
function rig() {
  const agent = new CodexAgent(createConfig());
  const events: Event[] = [];
  const debug: string[] = [];
  agent.onDebug = (message) => { debug.push(message) };
  (agent as any).turnSink = { push: (event: Event) => { events.push(event) }, finish: () => {} };
  const notify = (params: Record<string, unknown>) =>
    (agent as any).handleNotification('error', params);
  return { agent, events, debug, notify };
}

/** `ErrorNotification` is `{ error, willRetry, threadId, turnId }`, all required. */
function notification(input: {
  willRetry: boolean;
  codexErrorInfo?: unknown;
  message?: string;
}): Record<string, unknown> {
  return {
    willRetry: input.willRetry,
    threadId: 'thread-p6274',
    turnId: 'turn-p6274',
    error: {
      message: input.message ?? 'upstream said no',
      ...(input.codexErrorInfo === undefined ? {} : { codexErrorInfo: input.codexErrorInfo }),
    },
  };
}

describe('P6.274 (a) — the codex retry chip', () => {
  it('names a usage limit as a rate limit, on the STATUS channel', () => {
    const { events, notify } = rig();

    notify(notification({ willRetry: true, codexErrorInfo: 'usageLimitExceeded' }));

    expect(events).toEqual([{
      type: 'status',
      message: 'Rate limited by the provider — retry 1',
      // P6.916 — and the facts beside it. No `maxAttempts` and no
      // `delaySeconds`: codex publishes neither, and inventing either would be a
      // number the user could check and find wrong.
      retry: { kind: 'rate_limit', attempt: 1 },
    }]);
  });

  it('does NOT call every retry a rate limit', () => {
    // `willRetry` is true for overload, 5xx and connection failures too, so the
    // cause is read off codex's own error code. Naming a throttle here would
    // state a false cause on most retries — the same reason Pi's adapter
    // classifies off the message rather than off the event.
    const { events, notify } = rig();

    notify(notification({ willRetry: true, codexErrorInfo: 'serverOverloaded' }));
    notify(notification({ willRetry: true, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } }));
    notify(notification({ willRetry: true }));

    // P6.274 (b) — the attempt climbs because these are three retries of ONE
    // turn: `turn/started` is what resets it, and this rig opens no new turn.
    expect(events.map(event => event.message)).toEqual([
      'Provider error — retry 1', 'Provider error — retry 2', 'Provider error — retry 3',
    ]);
    expect(events.every(event => event.type === 'status')).toBe(true);
  });

  it('keeps the error TEXT, on the debug channel rather than nowhere', () => {
    const { debug, notify } = rig();

    notify(notification({ willRetry: true, message: 'stream reset by peer' }));

    expect(debug.some(line => line.includes('stream reset by peer'))).toBe(true);
  });

  it('still renders a NON-retrying error as an error — THE CONTROL', () => {
    const { events, notify } = rig();

    notify(notification({ willRetry: false, codexErrorInfo: 'badRequest', message: 'bad request' }));

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('error');
    expect(events[0]!.message).toContain('codex: bad request');
  });

  it('produces exactly the prefixes SessionManager stamps `retrying` on', () => {
    // The contract, asserted as a contract: this is a keyword match across a
    // frozen event shape, so the value is not a spelling choice. The third
    // prefix (`Retry succeeded`) has no producer here on purpose — codex
    // publishes no retry-END signal, which the site's docblock records.
    const { events, notify } = rig();

    notify(notification({ willRetry: true, codexErrorInfo: 'usageLimitExceeded' }));
    notify(notification({ willRetry: true, codexErrorInfo: 'internalServerError' }));

    for (const event of events) {
      expect(
        event.message?.startsWith('Rate limited') || event.message?.startsWith('Provider error'),
        event.message,
      ).toBe(true);
    }
  });
});

/**
 * P6.274 (b) — the attempt number, which is OURS.
 *
 * `ErrorNotification` publishes no attempt and no budget, so the number is a
 * count of the retries this agent observed for the turn in flight. Two
 * properties make that honest rather than invented, and both are asserted: it
 * counts ONE turn (a new `turn/started` resets it), and it carries NO
 * denominator (`retry 2/5` would be a maximum nobody named).
 */
describe('P6.274 (b) — the attempt number on the codex retry chip', () => {
  const turnStarted = (turnId: string) => ({ threadId: 'thread-p6274', turnId });

  it('resets at the next turn, so it counts a turn and not a session', () => {
    const { agent, events, notify } = rig();

    notify(notification({ willRetry: true }));
    notify(notification({ willRetry: true }));
    ;(agent as any).handleNotification('turn/started', turnStarted('turn-second'));
    notify(notification({ willRetry: true }));

    expect(events.map(event => event.message)).toEqual([
      'Provider error — retry 1', 'Provider error — retry 2', 'Provider error — retry 1',
    ]);
  });

  it('states no denominator, because codex publishes no retry budget', () => {
    const { events, notify } = rig();

    notify(notification({ willRetry: true, codexErrorInfo: 'usageLimitExceeded' }));

    // NEGATIVE: a slash would be a maximum nobody named. The positive control
    // is the case above, which proves the suffix is produced at all.
    expect(events[0]!.message).not.toContain('/');
  });

  it('leaves the PREFIX first, so the retrying stamp still matches — THE CONTROL', () => {
    // The suffix must not move the prefix match `SessionManager` stamps
    // `statusType: 'retrying'` on. This is the assertion the whole change is
    // allowed to exist under.
    const { events, notify } = rig();

    notify(notification({ willRetry: true, codexErrorInfo: 'usageLimitExceeded' }));
    notify(notification({ willRetry: true, codexErrorInfo: 'internalServerError' }));

    expect(events.map(event => event.message?.startsWith('Rate limited'))).toEqual([true, false]);
    expect(events[1]!.message?.startsWith('Provider error')).toBe(true);
  });

  it('P6.917 — the first assistant delta after a retry clears the chip, in Pi’s own words', () => {
    // codex publishes NO retry-END signal — `ErrorNotification` is
    // `{ error, willRetry, threadId, turnId }` and there is nothing beside it —
    // so the clear is inferred from the model speaking again. Driven through the
    // real notification funnel rather than by calling the adapter, because the
    // ordering (status BEFORE the delta) is the point.
    const { agent, events, notify } = rig();
    ;(agent as any).threadId = 'thread-p6274';
    notify(notification({ willRetry: true }));
    ;(agent as any).handleNotification('item/agentMessage/delta', {
      threadId: 'thread-p6274', turnId: 'turn-p6274', itemId: 'item-1', delta: 'Hello',
    });

    const messages = events.map(event => `${event.type}:${event.message ?? ''}`);
    expect(messages[0]).toBe('status:Provider error — retry 1');
    // The clear rides the same prefix `SessionManager` sniffs and Pi produces,
    // and it arrives before the text it precedes.
    const clearAt = messages.indexOf('status:Retry succeeded — resuming...');
    expect(clearAt, `no clear in ${JSON.stringify(messages)}`).toBeGreaterThan(0);
    const textAt = messages.findIndex(message => message.startsWith('text_delta'));
    if (textAt >= 0) expect(clearAt).toBeLessThan(textAt);
  });

  it('P6.917 — THE CONTROL: a delta with no retry behind it clears nothing', () => {
    // Without this, "the chip clears" is equally satisfied by an agent that
    // announces a retry success on every reply.
    const { agent, events } = rig();
    ;(agent as any).threadId = 'thread-p6274';
    ;(agent as any).handleNotification('item/agentMessage/delta', {
      threadId: 'thread-p6274', turnId: 'turn-p6274', itemId: 'item-1', delta: 'Hello',
    });
    expect(events.some(event => event.message === 'Retry succeeded — resuming...')).toBe(false);
  });

  it('a NON-retrying error does not advance the count', () => {
    const { events, notify } = rig();

    notify(notification({ willRetry: false, message: 'bad request' }));
    notify(notification({ willRetry: true }));

    expect(events[0]!.type).toBe('error');
    expect(events[1]!.message).toBe('Provider error — retry 1');
  });
});

/** F1.1224 — codex's in-stream rate limit (`rateLimitExceeded`, retried by codex) is a rate limit on the chip too. */
describe('F1.1224 — the retry chip for rateLimitExceeded', () => {
  it('names a stream rate limit as a rate limit', () => {
    const { events, notify } = rig();
    notify(notification({ willRetry: true, codexErrorInfo: 'rateLimitExceeded' }));
    expect(events).toEqual([{ type: 'status', message: 'Rate limited by the provider — retry 1', retry: { kind: 'rate_limit', attempt: 1 } }]);
  });

  it('BOUNDARY — flexUnavailable and tooManyDenials stay provider errors on the chip', () => {
    const { events, notify } = rig();
    notify(notification({ willRetry: true, codexErrorInfo: 'flexUnavailable' }));
    notify(notification({ willRetry: true, codexErrorInfo: 'tooManyDenials' }));
    expect(events.map(event => event.message)).toEqual(['Provider error — retry 1', 'Provider error — retry 2']);
  });
});

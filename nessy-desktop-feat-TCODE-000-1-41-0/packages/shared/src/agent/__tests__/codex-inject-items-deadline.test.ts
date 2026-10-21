/**
 * P2.260 — the runtime handoff's `thread/inject_items` is BOUNDED, and the bound
 * exists to REACH a `catch` that was already correct.
 *
 * `deliverRuntimeHandoff` (`codex-agent.ts`) is `await`ed from `chatImpl` between
 * the re-fork P2.257 bounded and the `turn/start` that bound was protecting, and
 * it is deliberately the LAST RPC before the turn. It has always had a
 * `try/catch` that degrades to the text handoff — but `AppServerClient.request`
 * settles on a matching response or on `close()` and nothing else (its
 * `timeoutMs` is opt-in and this call did not opt in), so an app-server that
 * ACCEPTED the inject and never answered it left the promise pending forever.
 * The fallback was unreachable by the one failure it could not otherwise
 * survive.
 *
 * WHAT THIS FILE PINS, and why each is its own proposition:
 *
 * 1. **A silent inject settles.** The defect itself. Asserted against a
 *    WATCHDOG rather than by waiting, because the regression is a HANG: a test
 *    that merely awaits does not go red, it goes quiet, and bun's own per-test
 *    timeout did not end the equivalent run on the sibling row.
 * 2. **Expiry DEGRADES — it does not throw.** The opposite of P2.257 one line
 *    up, which throws because it cannot honestly continue. Here the armed
 *    payload crosses as the text block inside the same turn.
 * 3. **The SENTINEL wins the production race.** Both timers come off the same
 *    budget and `AppServerClient` arms its own first, so without
 *    `CODEX_DEADLINE_CHANNEL_MARGIN_MS` the channel's bare rejection wins. The
 *    doubles below HONOUR `timeoutMs` for exactly this reason — a double that
 *    drops the option is green with the behaviour and without it, which is how a
 *    dead sentinel shipped on this plan once already.
 * 4. **PRODUCTION takes the constant.** Every other test passes its own small
 *    budget, so this is the only place production's own number is on the wire; a
 *    default drifting to `undefined` restores the exact hang.
 * 5. **The race is not redundant with the channel's `timeoutMs`.** A channel
 *    that drops the option must still be bounded.
 * 6. **A slow-but-answering inject is NOT degraded.** The bound must not
 *    manufacture the very downgrade it exists to make survivable.
 * 7. **The success path leaves no pending timer** — with a positive control, so
 *    the absence claim is made by a detector proven able to see a leak.
 * 8. **A real rejection still degrades exactly as before.** The deadline reuses
 *    that path rather than adding a second one.
 */
import { describe, expect, it, afterEach } from 'bun:test';
import type { BackendConfig, RuntimeHandoffPayload } from '../backend/types.ts';
import type { SessionKey } from '../../sessions/session-key.ts';
import { cleanupModeState } from '../mode-manager.ts';
import { buildRuntimeHandoffContext } from '../base-agent.ts';
import { CodexAgent, CODEX_INJECT_ITEMS_TIMEOUT_MS, CODEX_THREAD_REFORK_TIMEOUT_MS } from '../codex-agent.ts';

const WORKSPACE_ID = 'ws-inject-deadline';
const SESSION_ID = 'session-inject-deadline';
const SESSION_KEY: SessionKey = { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };

/** The span a pi → codex switch hands over. */
const SPAN = [
  { type: 'user' as const, content: 'the fixture password is opal-lantern-77' },
  { type: 'assistant' as const, content: 'Noted — opal-lantern-77.' },
];

const PROMPT = 'what was the fixture password?';

/**
 * Short enough that a wedged call is provable well inside bun's own 5000 ms, and
 * large enough that the 50 ms channel tie-break margin is a rounding error
 * rather than a term the assertions have to model.
 */
const BUDGET_MS = 300;

interface Recorded { method: string; params: any; timeoutMs: number | undefined }

interface Harness {
  agent: CodexAgent;
  requests: Recorded[];
  debugLines: string[];
  /** Every `markRuntimeHandoffApplied` call, in order. */
  applied: Array<string | undefined>;
  deliver: (timeoutMs?: number) => Promise<string>;
}

function createHarness(options: {
  /** `thread/inject_items` is accepted and never answered — the defect's shape. */
  silent?: boolean;
  /** Delay before a successful answer. */
  injectDelayMs?: number;
  /** Reject the way an app-server without the method does. */
  rejectInject?: boolean;
  /** Drop the channel's own `timeoutMs`, the way a two-argument double does. */
  ignoreChannelTimeout?: boolean;
  /** Arm the handoff with a payload whose text projection is empty. */
  handoff?: RuntimeHandoffPayload | null;
} = {}): Harness {
  cleanupModeState(SESSION_KEY);
  const requests: Recorded[] = [];
  const debugLines: string[] = [];
  const applied: Array<string | undefined> = [];

  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Inject Deadline Workspace',
      rootPath: '/tmp/ws-inject-deadline-root',
      workspaceRootPath: '/tmp/ws-inject-deadline-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-inject-deadline',
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: '/tmp/ws-inject-deadline-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
    markRuntimeHandoffApplied: (delivery?: string) => { applied.push(delivery); },
  } as BackendConfig;

  const agent = new CodexAgent(config);
  agent.onDebug = (line: string) => debugLines.push(line);

  const client = {
    request(method: string, params: any, requestOptions?: { timeoutMs?: number }) {
      requests.push({ method, params, timeoutMs: requestOptions?.timeoutMs });
      if (method !== 'thread/inject_items') return Promise.resolve({});
      if (options.rejectInject) return Promise.reject(new Error('unknown method thread/inject_items'));
      if (options.silent) {
        // A double FAITHFUL to `AppServerClient.request`: it arms its own timer
        // only when the caller opted in, and rejects with that class's exact
        // wording. Using one is not optional here — the real client arms inside
        // `request`, BEFORE the race's timer exists, so on a real channel the
        // two timers are not symmetric and only a faithful double can show which
        // one wins.
        const channelTimeoutMs = requestOptions?.timeoutMs;
        if (channelTimeoutMs === undefined || channelTimeoutMs <= 0) return new Promise<never>(() => {});
        return new Promise((_resolve, reject) => setTimeout(
          () => reject(new Error(`app-server request ${method} timed out after ${channelTimeoutMs}ms`)),
          channelTimeoutMs,
        ));
      }
      if (options.injectDelayMs !== undefined) {
        return new Promise(resolve => setTimeout(() => resolve({}), options.injectDelayMs));
      }
      return Promise.resolve({});
    },
    notify() {},
    close() {},
  };
  const channel = options.ignoreChannelTimeout
    ? { request: (method: string, params: any) => client.request(method, params), notify() {}, close() {} }
    : client;

  (agent as any).client = channel;
  (agent as any).threadId = 'thread-original';
  (agent as any).pendingRuntimeHandoff = options.handoff === undefined
    ? { from: 'pi', messages: SPAN as never, plan: 'native' } satisfies RuntimeHandoffPayload
    : options.handoff;

  return {
    agent,
    requests,
    debugLines,
    applied,
    deliver: (timeoutMs?: number) => (timeoutMs === undefined
      ? (agent as any).deliverRuntimeHandoff(PROMPT)
      : (agent as any).deliverRuntimeHandoff(PROMPT, timeoutMs)),
  };
}

/**
 * The regression this row exists for is a HANG, and a hang is not a red test —
 * it is a run that prints nothing and never ends. So every assertion about a
 * wedged call goes through this: the watchdog turns "never settles" into a
 * value the test can fail on.
 */
async function settleWithin<T>(work: Promise<T>, ms: number): Promise<
  { settled: 'value'; value: T } | { settled: 'threw'; error: unknown } | { settled: 'PENDING' }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        value => ({ settled: 'value' as const, value }),
        error => ({ settled: 'threw' as const, error }),
      ),
      new Promise<{ settled: 'PENDING' }>((resolve) => {
        timer = setTimeout(() => resolve({ settled: 'PENDING' }), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** What the text tier composes — the exact string a degraded delivery must return. */
const EXPECTED_TEXT_FALLBACK = `${buildRuntimeHandoffContext('pi', SPAN)!}\n\n${PROMPT}`;

describe('P2.260 · the runtime handoff inject is bounded', () => {
  afterEach(() => cleanupModeState(SESSION_KEY));

  it('settles a silent inject instead of hanging the turn, even on a channel that drops timeoutMs', async () => {
    // The pairing P2.138 established and both siblings kept: the channel's own
    // `timeoutMs` is what reclaims its pending entry, and the RACE is what makes
    // the deadline a property of this caller rather than a favour from whatever
    // object sits on `this.client`. With the option dropped, the race is the only
    // thing between the user and a turn that never starts.
    const { agent, requests, deliver } = createHarness({ silent: true, ignoreChannelTimeout: true });

    const outcome = await settleWithin(deliver(BUDGET_MS), BUDGET_MS * 8);

    expect(outcome.settled).toBe('value');
    expect((outcome as { value: string }).value).toBe(EXPECTED_TEXT_FALLBACK);
    // The channel really did get nothing — so nothing but the race saved it.
    expect(requests.find(r => r.method === 'thread/inject_items')!.timeoutMs).toBeUndefined();

    agent.destroy();
  });

  it('DEGRADES on expiry rather than throwing, and settles the obligation in the same turn', async () => {
    const { agent, debugLines, applied, deliver } = createHarness({ silent: true });

    const started = performance.now();
    const outcome = await settleWithin(deliver(BUDGET_MS), BUDGET_MS * 8);
    const elapsed = performance.now() - started;

    // The whole difference from P2.257: this one must NOT reject. A throw here
    // would fail a turn the fallback can carry.
    expect(outcome.settled).toBe('value');
    expect((outcome as { value: string }).value).toBe(EXPECTED_TEXT_FALLBACK);
    expect(elapsed).toBeLessThan(BUDGET_MS * 4);

    // The armed payload is spent exactly once, as TEXT — not left owed, and not
    // recorded as the native delivery that did not happen.
    expect(applied).toEqual(['text']);
    expect((agent as any).pendingRuntimeHandoff).toBeNull();
    expect(debugLines.some(l => l.includes(`did not answer within ${BUDGET_MS}ms`))).toBe(true);
    expect(debugLines.some(l => l.includes('falling back to the text handoff'))).toBe(true);

    agent.destroy();
  });

  it('lets the SENTINEL win on a channel that honours timeoutMs — the production race', async () => {
    // Without `CODEX_DEADLINE_CHANNEL_MARGIN_MS` the channel's own rejection
    // arrives first on every real connection, and the operator reads
    // `app-server request thread/inject_items timed out after Nms` instead of a
    // line that says what did not cross. The outcome would still be a text
    // fallback — which is exactly why only the DEBUG LINE can tell the two
    // apart, and why this assertion is on the wording rather than the result.
    const { agent, debugLines, requests, deliver } = createHarness({ silent: true });

    await settleWithin(deliver(BUDGET_MS), BUDGET_MS * 8);

    const line = debugLines.find(l => l.includes('[runtime-handoff] thread/inject_items'));
    expect(line).toBeDefined();
    expect(line!).toContain(`did not answer within ${BUDGET_MS}ms`);
    expect(line!).not.toContain('app-server request');

    // And the channel was armed all the same, a margin LATER — it is the only
    // thing that can delete the pending entry from the real client's map.
    const wire = requests.find(r => r.method === 'thread/inject_items')!.timeoutMs!;
    expect(Number.isInteger(wire)).toBe(true);
    expect(wire).toBeGreaterThan(BUDGET_MS);

    agent.destroy();
  });

  it('hands the PRODUCTION budget to the channel when no bound is passed', async () => {
    const { agent, requests, deliver } = createHarness();

    await deliver();

    const inject = requests.find(r => r.method === 'thread/inject_items');
    expect(inject).toBeDefined();
    // Not "a number" — the constant, plus the tie-break margin. Every other test
    // here passes its own budget, so this is the only place the shipped number
    // reaches the wire, and a default that drifted to `undefined` restores the
    // exact hang this row closed.
    expect(inject!.timeoutMs).toBeGreaterThanOrEqual(CODEX_INJECT_ITEMS_TIMEOUT_MS);
    expect(inject!.timeoutMs).toBeLessThanOrEqual(CODEX_INJECT_ITEMS_TIMEOUT_MS + 1_000);
    // One judgement, one number: the inject and the re-fork are both
    // thread-boundary RPCs at the head of the same turn (see the constant).
    expect(CODEX_INJECT_ITEMS_TIMEOUT_MS).toBe(CODEX_THREAD_REFORK_TIMEOUT_MS);
    expect(CODEX_INJECT_ITEMS_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);

    agent.destroy();
  });

  it('does not degrade an inject that is merely slow', async () => {
    // The bound must not manufacture the downgrade it exists to make survivable.
    // Measured on the shipped binary the real work is ~0.2 s even at a ~10 MB
    // payload; this stands in for that at test scale.
    const { agent, applied, deliver } = createHarness({ injectDelayMs: Math.floor(BUDGET_MS * 0.6) });

    const result = await deliver(BUDGET_MS);

    expect(result).toBe(PROMPT);
    expect(result).not.toContain('<runtime_handoff_context>');
    expect(applied).toEqual(['native-inject']);

    agent.destroy();
  });

  it('leaves no pending timer on the success path — with a positive control', async () => {
    const { agent, deliver } = createHarness();

    const armed: unknown[] = [];
    const cleared: unknown[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let control: unknown;
    try {
      (globalThis as any).setTimeout = (...args: unknown[]) => {
        const handle = (realSetTimeout as any)(...args);
        armed.push(handle);
        return handle;
      };
      (globalThis as any).clearTimeout = (handle: unknown) => {
        cleared.push(handle);
        return (realClearTimeout as any)(handle);
      };
      await deliver(BUDGET_MS);
      // POSITIVE CONTROL, on the same rig and inside the same window: a timer
      // deliberately left armed. Without it "nothing leaked" is indistinguishable
      // from "the detector sees nothing at all".
      control = (globalThis as any).setTimeout(() => {}, 60_000);
    } finally {
      (globalThis as any).setTimeout = realSetTimeout;
      (globalThis as any).clearTimeout = realClearTimeout;
    }

    // The detector CAN see a leak…
    expect(armed).toContain(control);
    expect(cleared).not.toContain(control);
    // …and the deadline's own timer is not one: every timer the delivery armed
    // was cleared. A 30 s handle left behind on a fast success holds the event
    // loop open long after the turn is over.
    const leaked = armed.filter(handle => handle !== control && !cleared.includes(handle));
    expect(leaked).toEqual([]);
    expect(armed.length).toBeGreaterThan(1);

    realClearTimeout(control as any);
    agent.destroy();
  });

  it('still degrades a real rejection exactly as before — one fallback path, not two', async () => {
    const { agent, debugLines, applied, deliver } = createHarness({ rejectInject: true });

    const result = await deliver(BUDGET_MS);

    expect(result).toBe(EXPECTED_TEXT_FALLBACK);
    expect(applied).toEqual(['text']);
    expect(debugLines.some(l => l.includes('unknown method thread/inject_items'))).toBe(true);
    expect(debugLines.some(l => l.includes('falling back to the text handoff'))).toBe(true);

    agent.destroy();
  });
});

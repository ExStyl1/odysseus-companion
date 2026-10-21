/**
 * P2.257 — the re-fork at the head of a turn is BOUNDED.
 *
 * `applySelectedPluginSkillRuntimePolicy` is `await`ed one line above the poll
 * P2.245 bounded (`codex-agent.ts`, `chatImpl`), and it fires on any model or
 * plugin/sandbox policy change. `AppServerClient.request` settles on a matching
 * response or on `close()`, so an app-server that never answers `thread/fork`
 * left the user's turn pending forever — printing nothing, ending never.
 *
 * WHAT THIS FILE PINS, and why each one is a separate proposition:
 *
 * 1. **The bound exists and PRODUCTION takes it.** A test that only ever passed
 *    its own short budget would pass with the default deleted.
 * 2. **A wedged fork fails the turn instead of hanging it** — and leaves the
 *    recorded config signature ALONE, so the next turn re-forks rather than
 *    silently running under the stale model and stale sandbox policy forever.
 * 3. **A timed-out fork never takes the `thread/start` fallback.** That arm is
 *    lossless only for a thread PROVEN empty by a `no rollout found` refusal;
 *    a fork that merely did not answer proves nothing, and starting fresh would
 *    discard the whole conversation.
 * 4. **The budget is for the WALK.** Fork and its fallback are sequential, so
 *    two per-call ceilings of T would hold the turn's head for 2 x T.
 * 5. **A slow-but-answering server is NOT failed.** P2.232's objection — a bound
 *    on a mandatory call manufactures failures — is the real risk here, because
 *    unlike P2.245's optional poll this one cannot degrade.
 * 6. **The SENTINEL wins the production race.** Both timers come off the same
 *    budget and the channel arms its own first, so without a margin the
 *    channel's bare rejection wins and the branch that explains what could not
 *    be applied never runs. P2.245's review measured that on the sibling; the
 *    doubles below honour `timeoutMs` so it cannot happen unseen here.
 * 7. **The race is load-bearing, not redundant with the channel's own
 *    `timeoutMs`.** A channel that drops the option must still be bounded.
 */
import { describe, expect, it, afterEach } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import type { SessionKey } from '../../sessions/session-key.ts';
import { cleanupModeState } from '../mode-manager.ts';
import { CodexAgent, CODEX_THREAD_OPEN_SLOWEST_MEASURED_MS, CODEX_THREAD_REFORK_TIMEOUT_MS } from '../codex-agent.ts';
import type { AgentEvent } from '@nessy-agent/core/types';
import { i18n, setupI18n } from '../../i18n/index.ts';
import { createMockCapabilityTurnRuntime } from './test-utils.ts';

const WORKSPACE_ID = 'ws-refork';
const SESSION_ID = 'session-refork';
const SESSION_KEY: SessionKey = { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };

/**
 * Short enough that a wedged call is provable inside bun's own 5000 ms, and
 * large enough that the channel's 50 ms tie-break margin is a rounding error in
 * it rather than a term the assertions have to model.
 */
const BUDGET_MS = 300;

/**
 * F1.1149 — what the walk's legs BEFORE `thread/fork` (F1.845's trust lookup
 * and `skills/list`) took at a host load of ~10: 57-134 ms (DN-229, paired A/B
 * on HEAD), past the 50 ms channel margin three pins below silently assumed.
 * The harness can delay `skills/list` by this much, so each of those pins runs
 * once at rest and once with the legs as slow as measured.
 */
const PRE_FORK_LEGS_UNDER_LOAD_MS = 150;

interface Recorded { method: string; params: any; timeoutMs: number | undefined; at: number }

interface Harness {
  agent: CodexAgent;
  requests: Recorded[];
  /** Drive the private seam directly, the way P2.245's tests drive the poll. */
  refork: (timeoutMs?: number) => Promise<void>;
}

function createHarness(options: {
  /** Methods that accept the request and then never answer at all. */
  silent?: string[];
  /** Make `thread/fork` refuse the way a rollout-less thread does. */
  forkRefusesNoRollout?: boolean;
  /** How long that refusal takes to arrive — i.e. how much budget leg one spends. */
  forkRefusalDelayMs?: number;
  /** Delay before `thread/fork` answers. */
  forkDelayMs?: number;
  /** F1.1149: `thread/fork` answers after this share of the channel budget it was handed. */
  forkDelayShare?: number;
  /** F1.1149: delay before `skills/list` answers — the pre-fork leg host load slows. */
  skillsListDelayMs?: number;
  /** Drop the channel's own `timeoutMs`, the way a two-argument double does. */
  ignoreChannelTimeout?: boolean;
} = {}): Harness {
  cleanupModeState(SESSION_KEY);
  const requests: Recorded[] = [];
  const silent = new Set(options.silent ?? []);

  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Refork Workspace',
      rootPath: '/tmp/ws-refork-root',
      workspaceRootPath: '/tmp/ws-refork-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-refork',
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: '/tmp/ws-refork-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };

  const agent = new CodexAgent(config);
  const client = {
    request(method: string, params: any, requestOptions?: { timeoutMs?: number }) {
      requests.push({ method, params, timeoutMs: requestOptions?.timeoutMs, at: performance.now() });
      if (silent.has(method)) {
        // The failure this row exists for: the request is accepted and no
        // answer ever comes. Nothing rejects it — not even `close()`, which the
        // real client reserves for teardown.
        //
        // A double that HONOURS `timeoutMs` is the production channel, and using
        // one is not optional here: `AppServerClient` arms its own timer inside
        // `request`, BEFORE the race's timer exists, so on a real channel the
        // two are not symmetric. A double that drops the option (P2.245's five
        // tests, and `ignoreChannelTimeout` below) cannot see which timer wins,
        // and that blind spot is how a sentinel branch ships dead.
        const channelTimeoutMs = requestOptions?.timeoutMs;
        if (channelTimeoutMs === undefined) return new Promise<never>(() => {});
        return new Promise((_resolve, reject) => setTimeout(
          // The real client's own wording, verbatim (`app-server-client.ts`).
          () => reject(new Error(`app-server request ${method} timed out after ${channelTimeoutMs}ms`)),
          channelTimeoutMs,
        ));
      }
      if (method === 'thread/fork' && options.forkRefusesNoRollout) {
        const refusal = new Error(`no rollout found for thread id ${params.threadId}`);
        return options.forkRefusalDelayMs === undefined
          ? Promise.reject(refusal)
          : new Promise((_resolve, reject) => setTimeout(() => reject(refusal), options.forkRefusalDelayMs));
      }
      if (method === 'thread/fork' && options.forkDelayMs !== undefined) {
        return new Promise(resolve => setTimeout(() => resolve({ thread: { id: 'thread-forked' } }), options.forkDelayMs));
      }
      if (method === 'thread/fork' && options.forkDelayShare !== undefined) {
        const delayMs = Math.floor(options.forkDelayShare * (requestOptions?.timeoutMs ?? 0));
        return new Promise(resolve => setTimeout(() => resolve({ thread: { id: 'thread-forked' } }), delayMs));
      }
      if (method === 'skills/list' && options.skillsListDelayMs !== undefined) {
        return new Promise(resolve => setTimeout(() => resolve({ data: [] }), options.skillsListDelayMs));
      }
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread-fresh' } });
      return Promise.resolve({ thread: { id: 'thread-forked' } });
    },
    notify() {},
    close() {},
  };
  // A channel that drops the option is not hypothetical — every two-argument
  // test double in this tree is one, and so would be any future transport.
  const channel = options.ignoreChannelTimeout
    ? { request: (method: string, params: any) => client.request(method, params), notify() {}, close() {} }
    : client;

  (agent as any).client = channel;
  (agent as any).threadId = 'thread-original';
  // The drift that makes the re-fork fire at all: a model change or a plugin
  // runtime selection leaves the recorded signature stale.
  (agent as any).runtimeConfigSignature = 'stale-signature';

  return {
    agent,
    requests,
    refork: (timeoutMs?: number) => (timeoutMs === undefined
      ? (agent as any).applySelectedPluginSkillRuntimePolicy({ environment: {}, writablePaths: [] })
      : (agent as any).applySelectedPluginSkillRuntimePolicy({ environment: {}, writablePaths: [] }, timeoutMs)),
  };
}

describe('P2.257 · the turn-head re-fork is bounded', () => {
  afterEach(() => cleanupModeState(SESSION_KEY));

  for (const skillsListDelayMs of [0, PRE_FORK_LEGS_UNDER_LOAD_MS]) it(`hands the PRODUCTION budget to the channel when no bound is passed (pre-fork legs +${skillsListDelayMs} ms)`, async () => {
    const { agent, requests, refork } = createHarness({ skillsListDelayMs });

    const started = performance.now();
    await refork();

    const fork = requests.find(r => r.method === 'thread/fork');
    expect(fork).toBeDefined();
    expect(requests.map(r => r.method)).toContain('skills/list');
    // Not "a number" — the constant, plus the tie-break margin the channel is
    // deliberately given (see `CODEX_DEADLINE_CHANNEL_MARGIN_MS`). A default
    // that drifted to `undefined` restores the exact hang, and every other test
    // in this file passes its own budget, so this is the only place production's
    // own number is on the wire.
    // F1.1149: the walk's legs before the fork spend the ONE budget first (the
    // `+150 ms` arm is the load DN-229 measured), so what reaches the channel is
    // the constant less THIS run's own pre-fork time, read off the clock — never
    // a guess at it, and still a failure for a default that drifted or vanished.
    expect(fork!.timeoutMs).toBeGreaterThanOrEqual(CODEX_THREAD_REFORK_TIMEOUT_MS - (fork!.at - started));
    expect(fork!.timeoutMs).toBeLessThanOrEqual(CODEX_THREAD_REFORK_TIMEOUT_MS + 1_000);
    expect(CODEX_THREAD_REFORK_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);

    agent.destroy();
  });

  it('fails the turn instead of hanging it, and does NOT record the drift as applied', async () => {
    const { agent, refork } = createHarness({ silent: ['thread/fork'] });

    const started = performance.now();
    await expect(refork(BUDGET_MS)).rejects.toThrow(new RegExp(`did not answer within ${BUDGET_MS}ms`));
    expect(performance.now() - started).toBeLessThan(BUDGET_MS * 8);

    // The two pieces of state a half-applied re-fork would corrupt. The thread
    // must still be the one that holds the conversation, and the signature must
    // still read STALE — a signature updated here would make every later turn
    // skip the re-fork and run under the old model and old sandbox policy for
    // the rest of the session, with no further attempt and no further error.
    expect((agent as any).threadId).toBe('thread-original');
    expect((agent as any).runtimeConfigSignature).toBe('stale-signature');

    agent.destroy();
  });

  it('never falls back to thread/start on a deadline — only on a proven-empty thread', async () => {
    const { agent, requests, refork } = createHarness({ silent: ['thread/fork'] });

    await expect(refork(BUDGET_MS)).rejects.toThrow(/did not answer/);

    // `thread/start` discards history. It is lossless ONLY after the
    // `no rollout found` refusal proves the thread empty, and a fork that did
    // not answer proves nothing.
    expect(requests.map(r => r.method)).not.toContain('thread/start');

    agent.destroy();
  });

  it('spends ONE budget across the whole walk, not one per leg', async () => {
    // The only route to the second leg is a rollout-less refusal, and the
    // refusal must COST something or the two designs are indistinguishable:
    // with leg one refusing instantly, a fresh per-call budget and the
    // remainder of a shared one are the same number. (Measured on the real
    // binary that refusal is 0.53-1.13 ms — so this delay is the test's
    // instrument, not a claim about codex.) Leg one spends 60% of the budget
    // here, so a per-call ceiling would total 1.6 x BUDGET_MS.
    const { agent, requests, refork } = createHarness({
      forkRefusesNoRollout: true,
      forkRefusalDelayMs: Math.floor(BUDGET_MS * 0.6),
      silent: ['thread/start'],
    });

    await expect(refork(BUDGET_MS)).rejects.toThrow(/did not answer within/);

    const fork = requests.find(r => r.method === 'thread/fork');
    const start = requests.find(r => r.method === 'thread/start');
    expect(fork).toBeDefined();
    expect(start).toBeDefined();
    // The fallback inherits what the first leg LEFT — never a fresh budget. A
    // per-call ceiling would hand it BUDGET_MS (plus the margin) all over again.
    expect(start!.timeoutMs).toBeLessThan(BUDGET_MS);
    expect(start!.timeoutMs).toBeGreaterThan(0);
    // F1.462 (5), origin WJ-jj P-WJjj-6: the ONE budget read off the two legs'
    // own channel budgets, not off the wall clock. This case asserted
    // `elapsed < 1.3 x BUDGET_MS` and measured 1389.5 ms (4.6 x) inside the
    // 568-file agent chunk at load ~10 while 7/0 alone: a timer under load fires
    // LATE, so the wall clock cannot tell the two designs apart there. The gap
    // between the legs can — both carry the same channel margin, which cancels;
    // leg one spent at least its scripted refusal (0.6 x BUDGET_MS, a timer that
    // fires late, never early), so the gap is at least that and load only WIDENS
    // it; a per-call ceiling hands both legs one number, a gap of 0. Half the
    // budget leaves room for a timer rounding a millisecond early.
    expect(fork!.timeoutMs! - start!.timeoutMs!).toBeGreaterThan(BUDGET_MS * 0.5);

    agent.destroy();
  });

  for (const skillsListDelayMs of [0, PRE_FORK_LEGS_UNDER_LOAD_MS]) it(`does not manufacture a failure for a server that is merely slow (pre-fork legs +${skillsListDelayMs} ms)`, async () => {
    // P2.232's objection, made concrete: this call is NOT the sub-millisecond
    // query P2.245 bounded (measured 239-1509 ms warm on the shipped binary),
    // and it cannot degrade — so a bound that fires early costs the user a turn.
    // F1.1149: the server answers after 60% of what the walk has LEFT when it
    // asks, so the legs before the fork (slow under load) cannot spend the rest.
    const { agent, refork } = createHarness({ forkDelayShare: 0.6, skillsListDelayMs });

    await refork(BUDGET_MS);

    expect((agent as any).threadId).toBe('thread-forked');
    expect((agent as any).runtimeConfigSignature).not.toBe('stale-signature');

    agent.destroy();
  });

  it('lets the SENTINEL win on a channel that honours timeoutMs — the production race', async () => {
    // Both timers are armed from the same budget, and `AppServerClient` arms
    // its own first. Without a margin the channel's rejection wins every time
    // on a real connection, the branch below never runs, and the operator reads
    // `app-server request thread/fork timed out after Nms` instead of what
    // could not be applied. Measured in P2.245's review; this is the guard that
    // would have caught it there.
    const { agent, refork } = createHarness({ silent: ['thread/fork'] });

    const error = await refork(BUDGET_MS).then(() => null, (caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain(`did not answer within ${BUDGET_MS}ms`);
    expect(error!.message).not.toContain('app-server request');

    agent.destroy();
  });

  it('bounds even a channel that drops the timeoutMs option', async () => {
    // The pairing P2.138 established and P2.245 kept: the channel's own
    // `timeoutMs` is what reclaims its pending entry, and the race is what makes
    // the deadline a property of the CALLER rather than a favour from whatever
    // object sits on `this.client`.
    const { agent, requests, refork } = createHarness({
      silent: ['thread/fork'],
      ignoreChannelTimeout: true,
    });

    await expect(refork(BUDGET_MS)).rejects.toThrow(/did not answer within/);
    expect(requests.find(r => r.method === 'thread/fork')!.timeoutMs).toBeUndefined();

    agent.destroy();
  });
});

describe('F1.1018 · the re-fork bound clears a 0.156.1 thread open', () => {
  afterEach(() => cleanupModeState(SESSION_KEY));

  it('outlasts the slowest thread/fork measured on the shipped binary under the credential deny-read floor', () => {
    // DN-198 measured 13-49 s per `thread/fork` on 0.156.1 (codex re-runs its
    // AGENTS.md discovery through the sandboxed fs helper while a deny-read path
    // is configured), so the 30 s bound failed turns whose fork would have
    // answered. Headroom of at least 2x, the same "busy laptop is not a hung
    // app-server" margin the constant's own docblock asks for.
    expect(CODEX_THREAD_OPEN_SLOWEST_MEASURED_MS).toBeGreaterThan(30_000);
    expect(CODEX_THREAD_REFORK_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * CODEX_THREAD_OPEN_SLOWEST_MEASURED_MS);
  });

  for (const skillsListDelayMs of [0, PRE_FORK_LEGS_UNDER_LOAD_MS]) it(`stays a bound: production still hands a finite deadline to the channel, and a silent fork still fails the turn (pre-fork legs +${skillsListDelayMs} ms)`, async () => {
    // BOUNDARY: widening must not turn into "wait forever" (P2.257's hang). The
    // production default on the wire is the constant, and the constant stays
    // within a few minutes; a wedged fork under a short budget still throws.
    const { agent, requests, refork } = createHarness({ skillsListDelayMs });
    const started = performance.now();
    await refork();
    const fork = requests.find(r => r.method === 'thread/fork');
    expect(fork!.timeoutMs).toBeGreaterThanOrEqual(CODEX_THREAD_REFORK_TIMEOUT_MS - (fork!.at - started)); // F1.1149
    expect(CODEX_THREAD_REFORK_TIMEOUT_MS).toBeLessThanOrEqual(180_000);
    agent.destroy();

    const wedged = createHarness({ silent: ['thread/fork'] });
    await expect(wedged.refork(BUDGET_MS)).rejects.toThrow(/did not answer within/);
    wedged.agent.destroy();
  });
});

/**
 * F1.1028 (origin DN-198) — the re-fork takes 13-49 s on 0.156.1 (F1.1018 raised its bound to 120 s), and until
 * this row the turn head showed nothing while it ran, so a slow re-fork read as a hang. The walk now calls
 * `onReopen` once it has decided to re-open the thread, and `chatImpl` turns that into ONE `status` event — the
 * existing turn-status channel, no new wire type — yielded while the fork is still in flight. A turn with no drift
 * re-opens nothing and says nothing.
 */
describe('F1.1028 · the turn head says the Codex thread is being re-opened while the re-fork runs', () => {
  afterEach(() => cleanupModeState(SESSION_KEY));

  const REOPENING = (): string => {
    if (!i18n.isInitialized) setupI18n();
    return i18n.t('chat.codexStatus.reopeningThread', { seconds: Math.round(CODEX_THREAD_REFORK_TIMEOUT_MS / 1000) });
  };

  it('the walk calls onReopen once, before the fork answers, and not at all when nothing drifted', async () => {
    const { agent } = createHarness();
    const order: string[] = [];
    let answerFork!: () => void;
    (agent as any).client = {
      request(method: string) {
        order.push(`request ${method}`);
        if (method !== 'thread/fork') return Promise.resolve({});
        return new Promise(resolve => { answerFork = () => { order.push('fork answered'); resolve({ thread: { id: 'thread-forked' } }); }; });
      },
      notify() {},
      close() {},
    };
    const walk = (agent as any).applySelectedPluginSkillRuntimePolicy({ environment: {}, writablePaths: [] }, 2_000, () => order.push('reopen'));
    while (!answerFork) await new Promise(resolve => setTimeout(resolve, 1));
    // Told first — before any leg of the walk (F1.845's skills/list included) and before the fork answers.
    expect(order[0]).toBe('reopen');
    expect(order.filter(entry => entry === 'reopen')).toHaveLength(1);
    expect(order).toContain('request thread/fork');
    expect(order).not.toContain('fork answered');
    answerFork();
    await walk;
    expect((agent as any).threadId).toBe('thread-forked');

    // BOUNDARY: the drift is now recorded, so the next walk returns early — no fork, no callback.
    const second: string[] = [];
    await (agent as any).applySelectedPluginSkillRuntimePolicy({ environment: {}, writablePaths: [] }, 2_000, () => second.push('reopen'));
    expect(second).toEqual([]);
    expect(order.filter(entry => entry === 'request thread/fork')).toHaveLength(1);
    agent.destroy();
  });

  it('a turn whose head re-forks yields the status while thread/fork is in flight; the next turn yields none', async () => {
    const { agent } = createHarness();
    const requests: string[] = [];
    let answerFork: (() => void) | undefined;
    const client = {
      request(method: string) {
        requests.push(method);
        if (method === 'turn/start') queueMicrotask(() => (agent as any).handleNotification('turn/completed', {}));
        if (method === 'thread/fork') {
          return new Promise(resolve => { answerFork = () => resolve({ thread: { id: 'thread-forked' } }); });
        }
        return Promise.resolve({ thread: { id: 'thread-original' } });
      },
      notify() {},
      close() {},
    };
    (agent as any).ensureRuntime = async () => { (agent as any).client = client; };
    agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime({
      workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, provider: 'codex-runtime',
    }));

    const events: AgentEvent[] = [];
    const turn = agent.chat('first');
    for (;;) {
      const next = await turn.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.type === 'status' && next.value.message === REOPENING()) {
        // Seen BEFORE the fork answered: the point of the row.
        expect(requests).toContain('thread/fork');
        expect(answerFork).toBeDefined();
        expect(requests).not.toContain('turn/start');
        answerFork!();
      }
    }
    expect(events.filter(event => event.type === 'status' && event.message === REOPENING())).toHaveLength(1);
    expect(requests).toContain('turn/start');
    expect(REOPENING()).toStartWith('Re-opening the Codex thread');
    expect(REOPENING()).toContain('120 s');

    const quiet: AgentEvent[] = [];
    for await (const event of agent.chat('second')) quiet.push(event);
    expect(quiet.some(event => event.type === 'status' && event.message === REOPENING())).toBe(false);
    expect(requests.filter(method => method === 'thread/fork')).toHaveLength(1);
    agent.destroy();
  });
});

/**
 * F1.1150 (origin DN-229) — F1.1028's label is a PHASE: it rides `status` with `phase: true` (a label, no transcript
 * row) and the turn clears it with an empty phase status once the re-fork settles, before `turn/start`, instead of
 * keeping the label until the turn's next status.
 */
describe('F1.1150 · the re-opening label clears itself when the re-fork settles', () => {
  afterEach(() => cleanupModeState(SESSION_KEY));

  it('the label is a phase status, and an empty phase status follows the fork before turn/start', async () => {
    if (!i18n.isInitialized) setupI18n();
    const reopening = i18n.t('chat.codexStatus.reopeningThread', { seconds: Math.round(CODEX_THREAD_REFORK_TIMEOUT_MS / 1000) });
    const { agent } = createHarness();
    const requests: string[] = [];
    const client = {
      request(method: string) {
        requests.push(method);
        if (method === 'turn/start') queueMicrotask(() => (agent as any).handleNotification('turn/completed', {}));
        if (method === 'thread/fork') return new Promise(resolve => { setTimeout(() => resolve({ thread: { id: 'thread-forked' } }), 5); });
        return Promise.resolve({ thread: { id: 'thread-original' } });
      },
      notify() {},
      close() {},
    };
    (agent as any).ensureRuntime = async () => { (agent as any).client = client; };
    agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime({
      workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, provider: 'codex-runtime',
    }));

    const seen: Array<{ event: AgentEvent; requests: string[] }> = [];
    for await (const event of agent.chat('first')) seen.push({ event, requests: [...requests] });
    const statuses = seen.filter(entry => entry.event.type === 'status');
    const label = statuses.find(entry => (entry.event as { message: string }).message === reopening);
    expect(label?.event).toMatchObject({ type: 'status', phase: true });
    const cleared = statuses.find(entry => (entry.event as { message: string }).message === '');
    expect(cleared?.event).toEqual({ type: 'status', message: '', phase: true });
    expect(cleared!.requests).toContain('thread/fork');
    expect(cleared!.requests).not.toContain('turn/start');

    // NEGATIVE — a turn with no re-fork yields neither the label nor a clear.
    const quiet: AgentEvent[] = [];
    for await (const event of agent.chat('second')) quiet.push(event);
    expect(quiet.some(event => event.type === 'status' && (event.message === reopening || event.message === ''))).toBe(false);
    agent.destroy();
  });
});

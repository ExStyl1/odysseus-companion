/**
 * Mid-turn steering on the codex backend, over the app-server's OWN mechanism.
 *
 * The user sends a task, codex goes off working, a minute later they type
 * "stop, that's the other API". Before this, `defaultMidStreamBehavior` returned
 * `queue` for `codex-runtime`, so the correction waited for the wrong refactor
 * to finish. `turn/steer` is codex's own answer, and it is a PRECONDITIONED
 * request: `expectedTurnId` is "Required active turn id precondition. The
 * request fails when it does not match the currently active turn"
 * (`codex-protocol/generated/v2/TurnSteerParams.ts`).
 *
 * So the three things worth pinning are the id's VALUE on the wire, the id's
 * LIFECYCLE (a turn that ended must not leave one behind, or every later steer
 * is refused for a reason the user did not cause), and the REFUSAL path — which
 * must end up queued rather than dropped, because `redirect()` is synchronous
 * and its `true` is a claim about the precondition, not a receipt.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { BackendConfig } from '../backend/types.ts';
import { cleanupModeState } from '../mode-manager.ts';
import { CodexAgent, readCodexTurnId } from '../codex-agent.ts';

const WORKSPACE_ID = 'ws-codex-steer';
const SESSION_ID = 'session-codex-steer';
const THREAD = 'thread-steer';
const OTHER_THREAD = 'thread-someone-else';
const TURN = 'turn-01960000-7000-7000-8000-000000000001';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Codex Steer Workspace',
      rootPath: '/tmp/ws-codex-steer-root',
      workspaceRootPath: '/tmp/ws-codex-steer-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-steer',
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: '/tmp/ws-codex-steer-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

interface SentRequest {
  method: string;
  params: any;
  /** How it went on the wire. `turn/interrupt` is a REQUEST method, not a notification. */
  kind: 'request' | 'notify';
}

/** One turn's event stream, recorded. A turn boundary swaps the whole object. */
interface RecordingSink {
  events: Array<{ type: string; message?: string }>;
  finished: boolean;
  push: (e: unknown) => void;
  finish: () => void;
}

function recordingSink(): RecordingSink {
  const sink: RecordingSink = {
    events: [],
    finished: false,
    push: e => { sink.events.push(e as { type: string; message?: string }); },
    finish: () => { sink.finished = true; },
  };
  return sink;
}

interface Harness {
  agent: CodexAgent;
  notify: (method: string, params: unknown) => void;
  sent: SentRequest[];
  events: Array<{ type: string; message?: string }>;
  finished: () => boolean;
  /** Settle the OLDEST unanswered `turn/steer` request (resolve or reject). */
  answerSteer: (outcome: { ok: true; turnId?: string } | { ok: false; message: string }) => void;
  /** The turn's own sink, as `chatImpl` installs it. */
  sink: RecordingSink;
  /** A later turn takes over `this.turnSink`; returns the new sink. */
  openSink: () => RecordingSink;
  /** `chatImpl`'s `finally`: the turn's stream is gone. */
  closeSink: () => void;
  /** `finishTurnSinkAfterPendingSteers()` — what every end of a turn calls. */
  finishSinkAfterSteers: () => void;
}

function harness(): Harness {
  const agent = new CodexAgent(createConfig());
  const internals = agent as unknown as {
    threadId: string | null;
    client: unknown;
    turnSink: RecordingSink | null;
    handleNotification: (method: string, params: unknown) => void;
    finishTurnSinkAfterPendingSteers: () => void;
  };
  const sent: SentRequest[] = [];
  const settles: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  const firstSink = recordingSink();

  internals.threadId = THREAD;
  internals.turnSink = firstSink;
  internals.client = {
    request: (method: string, params: unknown) => {
      sent.push({ method, params, kind: 'request' });
      // Only `turn/steer` is held open — the whole point is that its answer
      // arrives after `redirect()` has already returned. Everything else
      // (`turn/interrupt` on the abort paths) settles at once, the way a local
      // app-server does.
      if (method !== 'turn/steer') return Promise.resolve({});
      return new Promise((resolve, reject) => { settles.push({ resolve, reject }); });
    },
    notify: (method: string, params: unknown) => { sent.push({ method, params, kind: 'notify' }); },
    close: () => undefined,
  };

  return {
    agent,
    notify: (method, params) => internals.handleNotification(method, params),
    sent,
    get events() { return firstSink.events; },
    finished: () => firstSink.finished,
    sink: firstSink,
    openSink: () => {
      const next = recordingSink();
      internals.turnSink = next;
      return next;
    },
    closeSink: () => { internals.turnSink = null; },
    finishSinkAfterSteers: () => { internals.finishTurnSinkAfterPendingSteers(); },
    answerSteer: outcome => {
      const settle = settles.shift();
      if (!settle) throw new Error('no pending request to answer');
      if (outcome.ok) settle.resolve({ turnId: outcome.turnId ?? TURN });
      else settle.reject(new Error(outcome.message));
    },
  };
}

/** Let the steer's reaction chain (`then` → `finally` → `allSettled`) run out. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

const turnStarted = (threadId: string, turnId: string) => ({
  threadId,
  turn: { id: turnId, items: [], itemsView: 'complete', status: 'inProgress', error: null },
});

afterEach(() => {
  cleanupModeState({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID });
});

describe('readCodexTurnId', () => {
  it('reads Turn.id off the notification, never a flat params.turnId', () => {
    // `TurnStartedNotification = { threadId, turn: Turn }` — the id is one level
    // DOWN. A flat read would silently produce null on every real payload.
    expect(readCodexTurnId(turnStarted(THREAD, TURN))).toBe(TURN);
    expect(readCodexTurnId({ threadId: THREAD, turnId: TURN })).toBeNull();
    expect(readCodexTurnId({ threadId: THREAD, turn: { id: '' } })).toBeNull();
    expect(readCodexTurnId({ threadId: THREAD, turn: { id: 7 } })).toBeNull();
    expect(readCodexTurnId(undefined)).toBeNull();
  });
});

describe('CodexAgent.redirect — the positive path', () => {
  it('sends turn/steer carrying the id the server announced, and reports the steer accepted', () => {
    const h = harness();
    try {
      h.notify('turn/started', turnStarted(THREAD, TURN));

      expect(h.agent.redirect('stop, that is the other API')).toBe(true);

      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]!.method).toBe('turn/steer');
      expect(h.sent[0]!.params).toEqual({
        threadId: THREAD,
        expectedTurnId: TURN,
        input: [{ type: 'text', text: 'stop, that is the other API', text_elements: [] }],
      });
      // A steer is not an interrupt: the turn keeps running and its sink stays open.
      expect(h.finished()).toBe(false);
      expect(h.events).toHaveLength(0);
    } finally {
      h.agent.destroy();
    }
  });

  it("ignores another thread's turn/started, so a subagent's turn is never steered", () => {
    const h = harness();
    try {
      h.notify('turn/started', turnStarted(OTHER_THREAD, 'turn-belonging-to-the-child'));

      expect(h.agent.redirect('correction')).toBe(false);
      expect(h.sent).toHaveLength(0);
    } finally {
      h.agent.destroy();
    }
  });
});

describe('CodexAgent.redirect — the negative paths', () => {
  it('returns false with no active turn, writing nothing to the wire and interrupting nothing', () => {
    const h = harness();
    try {
      // No `turn/started` has arrived. `false` tells SessionManager to queue and
      // re-send; unlike `BaseAgent.redirect`'s default there is deliberately NO
      // `forceAbort` here — there is no turn in flight to tear down, and doing so
      // would end a codex turn for a message that is simply going to be the next
      // one. `turn/interrupt` on the wire would be the visible symptom.
      expect(h.agent.redirect('correction')).toBe(false);
      expect(h.sent).toHaveLength(0);
      expect(h.finished()).toBe(false);
    } finally {
      h.agent.destroy();
    }
  });

  it('re-queues the message when the server refuses the steer, and holds the sink open to say so', async () => {
    const h = harness();
    try {
      h.notify('turn/started', turnStarted(THREAD, TURN));
      expect(h.agent.redirect('use the v2 endpoint')).toBe(true);

      // `turn/completed` arrives while the steer is still unanswered — the race
      // that would otherwise drop the refusal on the floor. The sink must NOT
      // close yet.
      h.notify('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'completed' } });
      expect(h.finished()).toBe(false);

      // The refusal codex documents: `NonSteerableTurnKind = "review" | "compact"`,
      // reaching us as a bare message because `AppServerClient` drops the
      // JSON-RPC error's `data`.
      h.answerSteer({ ok: false, message: 'cannot steer a compact turn' });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(h.events).toEqual([
        { type: 'complete' },
        { type: 'steer_undelivered', message: 'use the v2 endpoint' },
      ]);
      // …and only then does the turn's stream end.
      expect(h.finished()).toBe(true);
    } finally {
      h.agent.destroy();
    }
  });

  // An accepted steer is silent — the turn carries the correction itself. Both
  // response ids are exercised because `TurnSteerResponse = { turnId }` and the
  // bindings do not say whether it echoes the steered turn or names a new one:
  // a surprising id is LOGGED, never acted on, so neither answer may invent an
  // event or leave the stream open.
  for (const answer of [
    { name: 'echoing the steered turn id', turnId: TURN },
    { name: 'naming some other turn id', turnId: 'turn-something-else' },
  ]) {
    it(`says nothing extra when the steer is accepted, ${answer.name}`, async () => {
      const h = harness();
      try {
        h.notify('turn/started', turnStarted(THREAD, TURN));
        h.agent.redirect('use the v2 endpoint');
        h.notify('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'completed' } });

        h.answerSteer({ ok: true, turnId: answer.turnId });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(h.events.map(e => e.type)).toEqual(['complete']);
        expect(h.finished()).toBe(true);
      } finally {
        h.agent.destroy();
      }
    });
  }
});

describe('CodexAgent active-turn-id lifecycle', () => {
  // A turn that has ended must not leave an id behind: `turn/steer` would then
  // fail its `expectedTurnId` precondition and the user would be shown a
  // failure they did not cause, for a message that should have been queued.
  const enders: Array<{ name: string; end: (h: Harness) => void | Promise<void> }> = [
    {
      name: 'turn/completed',
      end: h => h.notify('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'completed' } }),
    },
    {
      name: 'a terminal error notification (willRetry false)',
      end: h => h.notify('error', {
        threadId: THREAD,
        turnId: TURN,
        willRetry: false,
        error: { message: 'stream disconnected', codexErrorInfo: 'internalServerError', additionalDetails: null },
      }),
    },
    {
      name: 'forceAbort (user Stop)',
      end: h => { h.agent.forceAbort('user_stop' as never); },
    },
    {
      name: 'abort (teardown)',
      end: async h => { await h.agent.abort('teardown'); },
    },
    {
      name: 'clearHistory (/clear)',
      end: async h => { await h.agent.clearHistory(); },
    },
  ];

  for (const ender of enders) {
    it(`clears the id on ${ender.name}, so the next redirect queues instead of steering a dead turn`, async () => {
      const h = harness();
      try {
        h.notify('turn/started', turnStarted(THREAD, TURN));
        expect(h.agent.redirect('first correction')).toBe(true);
        const sentBefore = h.sent.length;

        await ender.end(h);

        expect(h.agent.redirect('second correction')).toBe(false);
        expect(h.sent.filter(r => r.method === 'turn/steer')).toHaveLength(sentBefore);
      } finally {
        h.agent.destroy();
      }
    });
  }

  it('keeps the id through a RETRYING error, because that turn is still the active one', () => {
    const h = harness();
    try {
      h.notify('turn/started', turnStarted(THREAD, TURN));
      h.notify('error', {
        threadId: THREAD,
        turnId: TURN,
        willRetry: true,
        error: { message: 'server overloaded', codexErrorInfo: 'serverOverloaded', additionalDetails: null },
      });

      expect(h.agent.redirect('correction during a retry')).toBe(true);
      expect(h.sent.filter(r => r.method === 'turn/steer')).toHaveLength(1);
    } finally {
      h.agent.destroy();
    }
  });

  it('keeps the id when a TERMINAL error names a DIFFERENT turn on this thread', () => {
    // `ErrorNotification` carries a REQUIRED `turnId`. An error attributable to
    // another turn must not drop the live turn's steer precondition — that
    // silently downgrades the user's next mid-turn send to a queue, and the id
    // needed for the exact check is in the payload the handler already reads.
    const h = harness();
    try {
      h.notify('turn/started', turnStarted(THREAD, TURN));
      h.notify('error', {
        threadId: THREAD,
        turnId: 'turn-01960000-7000-7000-8000-00000000dead',
        willRetry: false,
        error: { message: 'a different turn died', codexErrorInfo: 'internalServerError', additionalDetails: null },
      });

      expect(h.agent.redirect('correction')).toBe(true);
      const steer = h.sent.find(r => r.method === 'turn/steer');
      expect(steer!.params.expectedTurnId).toBe(TURN);
    } finally {
      h.agent.destroy();
    }
  });

  it('adopts a SECOND turn on the same thread, rather than steering the first forever', () => {
    const h = harness();
    try {
      h.notify('turn/started', turnStarted(THREAD, TURN));
      h.notify('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'completed' } });
      const second = 'turn-01960000-7000-7000-8000-000000000002';
      h.notify('turn/started', turnStarted(THREAD, second));

      expect(h.agent.redirect('correction')).toBe(true);
      const steer = h.sent.find(r => r.method === 'turn/steer');
      expect(steer!.params.expectedTurnId).toBe(second);
    } finally {
      h.agent.destroy();
    }
  });
});

const SECOND_TURN = 'turn-01960000-7000-7000-8000-000000000002';

describe('CodexAgent pending-steer lifetime', () => {
  it('an UNSETTLED steer does not wedge the next turn after a user Stop', () => {
    // The defect this pins, measured: `inFlightSteers` was AGENT-scoped and was
    // emptied only by the steer promise's own `.finally`. Stop finishes turn 1's
    // sink directly and clears `activeTurnId`, but the request stays open — the
    // transport is untouched, `AppServerClient.close()` runs on teardown, not on
    // Stop — so the orphaned promise survived into turn 2, and
    // `finishTurnSinkAfterPendingSteers` gated turn 2's `turn/completed` on it.
    // Turn 2's sink never finished, and neither did any later turn's.
    const h = harness();
    try {
      h.notify('turn/started', turnStarted(THREAD, TURN));
      expect(h.agent.redirect('first correction')).toBe(true);

      h.agent.forceAbort('user_stop' as never);
      expect(h.finished()).toBe(true);

      // Turn 2: its own sink, its own turn, its own completion.
      const second = h.openSink();
      h.notify('turn/started', turnStarted(THREAD, SECOND_TURN));
      h.notify('turn/completed', { threadId: THREAD, turn: { id: SECOND_TURN, status: 'completed' } });

      expect(second.finished).toBe(true);
      // POSITIVE CONTROL: the wait itself still works — a steer pending on THIS
      // turn does hold THIS turn's sink open (the row below proves the whole
      // mechanism was not simply disabled).
      const third = h.openSink();
      h.notify('turn/started', turnStarted(THREAD, 'turn-01960000-7000-7000-8000-000000000003'));
      expect(h.agent.redirect('third-turn correction')).toBe(true);
      h.notify('turn/completed', { threadId: THREAD, turn: { id: 'turn-01960000-7000-7000-8000-000000000003', status: 'completed' } });
      expect(third.finished).toBe(false);
    } finally {
      h.agent.destroy();
    }
  });

  // The other paths that END A TURN BY FINISHING ITS SINK have to account for the
  // pending steer the same way, or the wedge comes back through that door.
  //
  // Deliberately NOT in this list: a terminal `error` notification. It clears the
  // steer PRECONDITION (`activeTurnId`) but does not finish the sink — codex may
  // still send `turn/completed` — so its steers must stay attached or the late
  // refusal would have nowhere to be reported. The turn-start detach in
  // `chatImpl` is what stops one surviving into the next turn on that path, and
  // no in-process harness can install a sink the way `chatImpl` does.
  const enders: Array<{ name: string; end: (h: Harness) => void | Promise<void> }> = [
    { name: 'abort (teardown)', end: async h => { await h.agent.abort('teardown'); } },
    { name: 'clearHistory (/clear)', end: async h => { await h.agent.clearHistory(); } },
  ];

  for (const ender of enders) {
    it(`releases the next turn after ${ender.name}`, async () => {
      const h = harness();
      try {
        h.notify('turn/started', turnStarted(THREAD, TURN));
        expect(h.agent.redirect('first correction')).toBe(true);

        await ender.end(h);

        const second = h.openSink();
        h.notify('turn/started', turnStarted(THREAD, SECOND_TURN));
        h.notify('turn/completed', { threadId: THREAD, turn: { id: SECOND_TURN, status: 'completed' } });
        expect(second.finished).toBe(true);
      } finally {
        h.agent.destroy();
      }
    });
  }

  it("reports a late refusal on the steer's OWN sink and finishes only that one", async () => {
    // Both halves of the capture. The rejection handler pushes on the sink
    // `redirect` captured, and the deferred `finish()` targets that same sink —
    // NOT `this.turnSink`, which a later turn may already own. Reading the live
    // field instead would re-queue a turn-1 correction into turn 2 and truncate
    // turn 2's stream while leaving turn 1's open forever.
    const h = harness();
    try {
      h.notify('turn/started', turnStarted(THREAD, TURN));
      expect(h.agent.redirect('use the v2 endpoint')).toBe(true);
      h.notify('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'completed' } });
      expect(h.finished()).toBe(false);

      const second = h.openSink();
      h.answerSteer({ ok: false, message: 'cannot steer a compact turn' });
      await settleMicrotasks();

      expect(h.sink.events.map(e => e.type)).toEqual(['complete', 'steer_undelivered']);
      expect(h.sink.finished).toBe(true);
      expect(second.events).toEqual([]);
      expect(second.finished).toBe(false);
    } finally {
      h.agent.destroy();
    }
  });

  it('declines a steer when the turn has no sink to report a refusal on', () => {
    // `redirect`'s `true` is a PROMISE to report a refusal, and the sink is the
    // only channel for it. `activeTurnId` alone does not imply a sink: it is
    // written from `turn/started`, which also fires for a turn this client is not
    // draining. Without the `!sink` half of the guard this returns `true`, the
    // rejection handler throws inside a floating promise, and the user's message
    // is lost while the composer says "accepted".
    const h = harness();
    try {
      h.notify('turn/started', turnStarted(THREAD, TURN));
      h.closeSink();

      expect(h.agent.redirect('correction')).toBe(false);
      expect(h.sent).toHaveLength(0);
    } finally {
      h.agent.destroy();
    }
  });
});

describe('CodexAgent — a turn closed on a RESPONSE still reports a late refusal', () => {
  it('holds the sink open through a pending steer when the /compact branch closes it', async () => {
    // The `/compact` branch closes the queue in a `finally` on the
    // `thread/compact/start` RESPONSE, before `drain()` has even started, and a
    // compact turn is EXACTLY the turn codex refuses to steer. With a bare
    // `queue.finish()` there, `drain()` returned first and the `steer_undelivered`
    // landed in a buffer nobody reads — `redirect()` had already returned `true`,
    // so the transcript showed the message as delivered and it was gone.
    const h = harness();
    try {
      h.notify('turn/started', turnStarted(THREAD, TURN));
      expect(h.agent.redirect('actually, keep the auth notes')).toBe(true);

      // What the compact branch's `finally` now calls.
      h.finishSinkAfterSteers();
      expect(h.finished()).toBe(false);

      h.answerSteer({ ok: false, message: 'cannot steer a compact turn' });
      await settleMicrotasks();

      expect(h.sink.events).toEqual([
        { type: 'steer_undelivered', message: 'actually, keep the auth notes' },
      ]);
      expect(h.finished()).toBe(true);
    } finally {
      h.agent.destroy();
    }
  });

  it('every close of a turn stream in chatImpl goes through the steer-aware path', () => {
    // The behavioural row above proves the helper. This proves the two closes
    // that used to bypass it — the `/compact` `finally` and the `turn/start`
    // rejection — now call it, which no in-process harness can reach without
    // standing up a whole runtime.
    const source = readFileSync(new URL('../codex-agent.ts', import.meta.url), 'utf8');
    const chatImpl = source.slice(
      source.indexOf('protected async *chatImpl('),
      source.indexOf('async fuzzyFileSearch('),
    );
    expect(chatImpl.length).toBeGreaterThan(1_000);
    expect(chatImpl).toContain("if (sessionCommand?.kind === 'compact')");
    // Statement lines only — the prose above the compact branch names the bare
    // call it replaced, and a comment is not a close.
    const bareFinishes = chatImpl.split('\n').filter(line => line.trim() === 'queue.finish()' || line.trim() === 'queue.finish();');
    expect(bareFinishes).toEqual([]);
    expect(chatImpl.match(/this\.finishTurnSinkAfterPendingSteers\(\)/g)).toHaveLength(2);
  });
});

describe('CodexAgent turn/interrupt — both ids, and as a request', () => {
  // Measured against the bundled app-server (rust-v0.147.0, sha256 b1a7e99d…):
  //   - `{threadId}` as a REQUEST → `Invalid request: missing field \`turnId\``
  //   - `{threadId}` as a NOTIFICATION → no response at all; `turn/interrupt` is a
  //     `ClientRequest` member and `ClientNotification` is `{"method":"initialized"}`
  //     and nothing else, so a user Stop was interrupting NOTHING.
  //   - both fields, as a request → reaches thread-id validation (positive control).
  for (const path of [
    { name: 'forceAbort (user Stop)', run: (h: Harness) => { h.agent.forceAbort('user_stop' as never); } },
    { name: 'abort (teardown)', run: async (h: Harness) => { await h.agent.abort('teardown'); } },
  ]) {
    it(`${path.name} sends turn/interrupt as a request carrying threadId AND turnId`, async () => {
      const h = harness();
      try {
        h.notify('turn/started', turnStarted(THREAD, TURN));
        await path.run(h);

        const interrupts = h.sent.filter(r => r.method === 'turn/interrupt');
        expect(interrupts).toHaveLength(1);
        expect(interrupts[0]!.kind).toBe('request');
        expect(interrupts[0]!.params).toEqual({ threadId: THREAD, turnId: TURN });
      } finally {
        h.agent.destroy();
      }
    });

    it(`${path.name} sends nothing when no turn is active`, async () => {
      // An interrupt with no `turnId` is refused by definition, so sending one
      // manufactures an error the user did not cause. There is also nothing to
      // interrupt: no `turn/started` has arrived.
      const h = harness();
      try {
        await path.run(h);
        expect(h.sent.filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
      } finally {
        h.agent.destroy();
      }
    });
  }
});

describe('F1.330 — a late refusal names the message it refused, as Claude\'s hand-back does', () => {
  // Before this row `redirect(message)` dropped the metadata the host passes and the
  // refusal carried the text alone, so the host resolved it by exact text, oldest first:
  // two steers with the SAME text ("yes"), the first delivered and the second refused,
  // flipped the FIRST back to queued (WJ-gg verifier, probe-host-doors case 3).
  it('two steers with IDENTICAL text, the first accepted and the second refused: the event names the second one\'s id', async () => {
    const h = harness();
    try {
      h.notify('turn/started', turnStarted(THREAD, TURN));
      const redirect = h.agent.redirect.bind(h.agent) as (message: string, metadata?: { messageId?: string }) => boolean;
      expect(redirect('yes', { messageId: 'msg-first' })).toBe(true);
      expect(redirect('yes', { messageId: 'msg-second' })).toBe(true);

      h.answerSteer({ ok: true });
      h.answerSteer({ ok: false, message: 'cannot steer a compact turn' });
      await settleMicrotasks();

      expect(h.events.filter(event => event.type === 'steer_undelivered') as unknown[]).toEqual([
        { type: 'steer_undelivered', message: 'yes', messageId: 'msg-second' },
      ]);
    } finally {
      h.agent.destroy();
    }
  });

  it('a plugin monitor\'s refused steer carries its origin (F1.343), so the host does not queue it as a user message', async () => {
    const h = harness();
    try {
      h.notify('turn/started', turnStarted(THREAD, TURN));
      const redirect = h.agent.redirect.bind(h.agent) as (message: string, metadata?: { origin?: 'monitor' }) => boolean;
      expect(redirect('<monitor> build failed', { origin: 'monitor' })).toBe(true);

      h.answerSteer({ ok: false, message: 'cannot steer a review turn' });
      await settleMicrotasks();

      expect(h.events.filter(event => event.type === 'steer_undelivered') as unknown[]).toEqual([
        { type: 'steer_undelivered', message: '<monitor> build failed', origin: 'monitor' },
      ]);
    } finally {
      h.agent.destroy();
    }
  });
});

/**
 * F1.896 (origin SIT-ab WJ-ac(2), FAIL 2 of 2) — a monitor tick whose
 * `turn/steer` codex ACCEPTED used to go silent forever when the person stopped
 * the turn: codex applies steered input at its next sampling boundary, the
 * abort lands first, and the host — having counted the tick delivered at
 * `redirect()`'s optimistic true — never re-queued it, while the transcript
 * kept the "delivered by the app" line. The rollback below is the refusal
 * door's twin: what the Stop really took is reported as `steer_undelivered` on
 * the sink BEFORE it is finished, so the host's monitor requeue (F1.343's
 * origin arm) hands the tick to the user's next send (F1.530's hold).
 *
 * Deliberately monitor-scoped: replaying a PERSON's correction on abort could
 * repeat an instruction the model already acted on — a posture this row does
 * not take (stated residue; the same loss for user steers is a proposed row).
 */
describe('F1.896 — a Stop reports the monitor steers its turn never sampled', () => {
  it('an ACCEPTED monitor steer is reported undelivered before the Stop finishes the sink', async () => {
    const h = harness();
    try {
      h.notify('turn/started', turnStarted(THREAD, TURN));
      const redirect = h.agent.redirect.bind(h.agent) as (message: string, metadata?: { origin?: 'monitor'; messageId?: string }) => boolean;
      expect(redirect('<task-notification>Plugin monitor sit-tick: BLUE-HERON-47 healthy</task-notification>', { origin: 'monitor', messageId: 'msg-tick' })).toBe(true);

      h.answerSteer({ ok: true });
      await settleMicrotasks();

      h.agent.forceAbort('user_stop' as never);

      expect(h.sink.events.filter(event => event.type === 'steer_undelivered') as unknown[]).toEqual([
        { type: 'steer_undelivered', message: '<task-notification>Plugin monitor sit-tick: BLUE-HERON-47 healthy</task-notification>', messageId: 'msg-tick', origin: 'monitor' },
      ]);
      expect(h.sink.finished).toBe(true);
    } finally {
      h.agent.destroy();
    }
  });

  it('a USER steer stays silent on Stop — replaying a person\'s correction is not this row', async () => {
    const h = harness();
    try {
      h.notify('turn/started', turnStarted(THREAD, TURN));
      expect(h.agent.redirect('use the v2 endpoint')).toBe(true);
      h.answerSteer({ ok: true });
      await settleMicrotasks();

      h.agent.forceAbort('user_stop' as never);

      expect(h.sink.events.filter(event => event.type === 'steer_undelivered')).toEqual([]);
      expect(h.sink.finished).toBe(true);
    } finally {
      h.agent.destroy();
    }
  });

  it('a completed turn reports nothing: a Stop after completion reaches no turn (the host never calls it)', async () => {
    const h = harness();
    try {
      h.notify('turn/started', turnStarted(THREAD, TURN));
      const redirect = h.agent.redirect.bind(h.agent) as (message: string, metadata?: { origin?: 'monitor'; messageId?: string }) => boolean;
      expect(redirect('<monitor> tick', { origin: 'monitor', messageId: 'msg-tick' })).toBe(true);
      h.answerSteer({ ok: true });
      await settleMicrotasks();
      h.notify('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'completed' } });

      h.agent.forceAbort('user_stop' as never);

      expect(h.sink.events.filter(event => event.type === 'steer_undelivered')).toEqual([]);
    } finally {
      h.agent.destroy();
    }
  });

  it('a new turn does not re-report the previous turn\'s ticks (the record resets at turn/started)', async () => {
    const h = harness();
    try {
      h.notify('turn/started', turnStarted(THREAD, TURN));
      const redirect = h.agent.redirect.bind(h.agent) as (message: string, metadata?: { origin?: 'monitor' }) => boolean;
      expect(redirect('<monitor> tick one', { origin: 'monitor' })).toBe(true);
      h.answerSteer({ ok: true });
      await settleMicrotasks();
      h.notify('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'completed' } });

      // Turn 2: the reset has run; a Stop with no steers of its own is silent.
      const second = h.openSink();
      h.notify('turn/started', turnStarted(THREAD, SECOND_TURN));
      h.agent.forceAbort('user_stop' as never);

      expect(second.events.filter(event => event.type === 'steer_undelivered')).toEqual([]);
      expect(second.finished).toBe(true);
    } finally {
      h.agent.destroy();
    }
  });
});

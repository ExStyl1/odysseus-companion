/**
 * F1.220 (origin WJ-v P-WJ-v-2) — a question dialog the shared ask-user bridge
 * WITHDRAWS is withdrawn from the host too, on claude and codex.
 *
 * ## What was wrong
 *
 * `ElicitationAskUserBridge` (`agent/elicitation-ask-user.ts`) carries three
 * dialogs onto the host's permission channel: an MCP server's elicitation
 * (`BaseAgent.elicitationAsk`, both runtimes) and the model's own clarifying
 * question (`modelQuestionAsk`, one per runtime). When one of them is settled
 * WITHOUT an answer — the MCP server withdraws its request, the user presses
 * Stop, the session goes away — `cancel` settled the promise and told the host
 * nothing. The host keeps its own record (`SessionManager`'s
 * `pendingPermissionRequests`) and the card on screen, and the event that clears
 * both is `permission_request_cancelled` (`SessionManager.processEvent` →
 * `removePendingPermissionRequest`), which Pi (`cancelPendingPermission`) and,
 * since F1.170, codex's own approval cards already emit. So on these two
 * runtimes a withdrawn question stayed on screen and its click answered nothing.
 * `SessionManager.cancelProcessing` does not sweep the records either: the only
 * `clearPendingPermissionRequestsForSession` callers are a Pi drain, a runtime
 * switch, a rewind and a delete.
 *
 * ## The rig
 *
 * The REAL agents, the real pool elicitation handler each registers (a fake
 * pool whose only job is to hand that handler back, the shape
 * `runtime-mcp-elicitation-wiring.test.ts` uses), codex's real
 * `handleServerRequest` for `item/tool/requestUserInput`, and each runtime's real
 * Stop (`forceAbort(UserStop)`). The one planted piece is the turn's event sink
 * — codex's `turnSink`, claude's `openSlot` — and production HAS one at this
 * moment: every one of these dialogs is raised inside a turn.
 */
import { describe, expect, it } from 'bun:test';
import type { ElicitRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpElicitationHandler } from '../../mcp/client.ts';
import type { McpClientPool } from '../../mcp/mcp-pool.ts';
import { AbortReason, type BackendConfig, type PermissionCallback } from '../backend/types.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import { CodexAgent } from '../codex-agent.ts';
import { ElicitationAskUserBridge } from '../elicitation-ask-user.ts';

type SinkEvent = { type: string; requestId?: string };

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function config(kind: 'codex' | 'claude', pool: McpClientPool): BackendConfig {
  return {
    provider: kind === 'codex' ? 'codex-runtime' : 'anthropic',
    model: kind === 'codex' ? 'codex/test-model' : 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    mcpPool: pool,
    mcpLeaserId: `session:f1220:${kind}`,
    workspace: {
      id: 'ws-f1220',
      name: 'F1.220 Workspace',
      rootPath: '/tmp/ws-f1220',
      workspaceRootPath: '/tmp/ws-f1220',
      sessionRootPath: '/tmp/ws-f1220/sessions',
    } as never,
    session: {
      id: `session-f1220-${kind}`,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-f1220',
    } as never,
  } as BackendConfig;
}

/** A form elicitation the batched question card can render: one two-way choice. */
function formRequest(): ElicitRequest {
  return {
    method: 'elicitation/create',
    params: {
      message: 'Which workspace should I connect?',
      requestedSchema: {
        type: 'object',
        properties: { workspace: { type: 'string', enum: ['personal', 'team'] } },
        required: ['workspace'],
      },
    },
  } as ElicitRequest;
}

/** One agent mid-turn, its pool handler, the cards it surfaced and the host events its turn carries. */
function session(kind: 'codex' | 'claude') {
  let handler: McpElicitationHandler | undefined;
  const pool = {
    registerElicitationHandler(_leaserId: string, fn: McpElicitationHandler) { handler = fn; return () => {}; },
    setElicitationHandler(fn: McpElicitationHandler) { handler = fn; },
  } as unknown as McpClientPool;
  const agent = kind === 'codex' ? new CodexAgent(config(kind, pool)) : new ClaudeAgent(config(kind, pool) as never);
  agent.onDebug = () => {};
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  agent.onPermissionRequest = request => { surfaced.push(request); };
  const events: SinkEvent[] = [];
  const sink = { push: (event: SinkEvent) => { events.push(event); } };
  if (kind === 'codex') {
    (agent as unknown as { turnSink: unknown }).turnSink = { ...sink, finish: () => {} };
  } else {
    (agent as unknown as { openSlot: unknown }).openSlot = { ...sink, settled: false, close: () => {}, fail: () => {} };
  }
  expect(handler).toBeDefined();
  return { agent, handler: handler!, surfaced, events };
}

const withdrawn = (events: SinkEvent[]) => events.filter(e => e.type === 'permission_request_cancelled');

describe.each(['codex', 'claude'] as const)('F1.220 — %s withdraws a question dialog it settles without an answer', kind => {
  it('the MCP server withdrawing its elicitation takes the card off the host', async () => {
    const { handler, surfaced, events } = session(kind);
    const controller = new AbortController();
    const result = handler(formRequest(), controller.signal, { server: 'acme' });
    await settle();
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.type).toBe('ask_user');

    controller.abort();

    expect((await result).action).toBe('cancel');
    expect(withdrawn(events)).toEqual([{ type: 'permission_request_cancelled', requestId: surfaced[0]!.requestId }]);
  });

  /**
   * CONTROL. An ANSWERED dialog is not withdrawn: the host removed its record
   * on the click, and a second event would withdraw nothing. Without this arm
   * "a cancel emits" is equally satisfied by an emitter that fires for every id
   * it ever saw.
   */
  it('an answered elicitation is NOT withdrawn by the abort that follows it', async () => {
    const { agent, handler, surfaced, events } = session(kind);
    const controller = new AbortController();
    const result = handler(formRequest(), controller.signal, { server: 'acme' });
    await settle();
    agent.respondToPermission(surfaced[0]!.requestId, true, false, {
      askUserAnswer: { type: 'option', optionIndex: 1, value: 'team' } as never,
    });
    expect(await result).toEqual({ action: 'accept', content: { workspace: 'team' } });

    controller.abort();
    agent.forceAbort(AbortReason.UserStop);

    expect(withdrawn(events)).toEqual([]);
  });
});

describe('F1.220 — the model\'s own question, withdrawn by a Stop', () => {
  it('codex: an `item/tool/requestUserInput` card is taken off the host by the Stop that settles it', async () => {
    const { agent, surfaced, events } = session('codex');
    const answer = (agent as any).handleServerRequest('item/tool/requestUserInput', {
      threadId: 'thread-f1220',
      turnId: 'turn-f1220',
      itemId: 'item-f1220',
      isBlocking: true,
      autoResolutionMs: null,
      questions: [{
        id: 'q1',
        header: 'Scope',
        question: 'Which scope should I use?',
        isOther: false,
        isSecret: false,
        options: [{ label: 'user', description: 'Only you' }, { label: 'project', description: 'This repo' }],
      }],
    }) as Promise<Record<string, unknown>>;
    await settle();
    expect(surfaced).toHaveLength(1);

    agent.forceAbort(AbortReason.UserStop);

    expect(await answer).toEqual({ answers: {} });
    expect(withdrawn(events)).toContainEqual({ type: 'permission_request_cancelled', requestId: surfaced[0]!.requestId });
  });

  it('claude: an AskUserQuestion card is taken off the host by the Stop that settles it', async () => {
    const { agent, surfaced, events } = session('claude');
    const bridge = (agent as unknown as {
      modelQuestionAsk: { ask: (askUser: unknown) => Promise<unknown> };
    }).modelQuestionAsk;
    const question = bridge.ask({
      question: 'Which scope should I use?',
      options: ['user', 'project'],
      allowFreeText: false,
    }).catch((error: unknown) => error);
    await settle();
    expect(surfaced).toHaveLength(1);

    agent.forceAbort(AbortReason.UserStop);

    expect(await question).toBeInstanceOf(Error);
    expect(withdrawn(events)).toEqual([{ type: 'permission_request_cancelled', requestId: surfaced[0]!.requestId }]);
  });
});

/**
 * F1.479 (1) (origin WJ-rr-b P-WJ-rr-b-2) — measured, and REFUTED: codex's
 * `disposeForRestart` shows no `modelQuestionAsk.cancelAll` of its own, but its
 * synchronous prologue runs `denyPendingApprovals`, which cancels every open
 * model question (P6.344). So a runtime restart settles an open
 * `item/tool/requestUserInput` with codex's own "nothing was answered", and
 * the card goes — on the turn sink mid-turn, and on the out-of-turn channel
 * (F1.369) between turns. Pinned so a prologue that stops reaching
 * `denyPendingApprovals` goes red here.
 *
 * F1.585 — one test per branch. The two used to share one body with an
 * `if (midTurn)` around their assertions, which is the shape
 * `scripts/check-conditional-expect.ts` refuses (a flipped condition deletes an
 * assertion instead of failing it); each branch now asserts its own channel
 * unconditionally, over the shared `restartWithOpenQuestion` below.
 */
describe('F1.479 (1) — codex\'s runtime restart settles the model\'s open question', () => {
  /** What an answer still pending one macrotask after the restart reads as, so the red is an assertion, not a timeout. */
  const STILL_OPEN = 'still open after disposeForRestart';

  /** One surfaced `item/tool/requestUserInput`, then `disposeForRestart` — mid-turn, or with no turn sink (between turns). */
  async function restartWithOpenQuestion(midTurn: boolean) {
    const { agent, surfaced, events } = session('codex');
    const withdrawnOutOfTurn: string[] = [];
    (agent as unknown as { onPermissionRequestWithdrawn: unknown }).onPermissionRequestWithdrawn =
      (id: string) => { withdrawnOutOfTurn.push(id); };
    if (!midTurn) (agent as unknown as { turnSink: unknown }).turnSink = null;
    const answer = (agent as any).handleServerRequest('item/tool/requestUserInput', {
      threadId: 'thread-f1479', turnId: 'turn-f1479', itemId: 'item-f1479', isBlocking: true, autoResolutionMs: null,
      questions: [{ id: 'q1', header: 'Scope', question: 'Which scope should I use?', isOther: false, isSecret: false,
        options: [{ label: 'user', description: 'Only you' }, { label: 'project', description: 'This repo' }] }],
    }) as Promise<Record<string, unknown>>;
    await settle();
    expect(surfaced).toHaveLength(1);
    const requestId = surfaced[0]!.requestId;

    await (agent as unknown as { disposeForRestart: () => Promise<void> }).disposeForRestart();

    const settled = await Promise.race([answer, settle().then(() => STILL_OPEN)]);
    return { settled, requestId, events, withdrawnOutOfTurn };
  }

  it('mid-turn: disposeForRestart answers { answers: {} } and withdraws the card on the turn sink', async () => {
    const { settled, requestId, events, withdrawnOutOfTurn } = await restartWithOpenQuestion(true);

    expect(settled).toEqual({ answers: {} });
    expect(withdrawn(events)).toContainEqual({ type: 'permission_request_cancelled', requestId });
    expect(withdrawnOutOfTurn).toEqual([]);
  });

  it('between turns: disposeForRestart answers { answers: {} } and withdraws the card on the out-of-turn channel', async () => {
    const { settled, requestId, withdrawnOutOfTurn } = await restartWithOpenQuestion(false);

    expect(settled).toEqual({ answers: {} });
    expect(withdrawnOutOfTurn).toEqual([requestId]);
  });
});

/**
 * The bridge's own contract, which both runtimes above rely on: `withdraw` is
 * called for a SURFACED dialog settled without an answer, and for nothing else.
 */
describe('F1.220 — ElicitationAskUserBridge calls withdraw exactly for the dialogs it settles unanswered', () => {
  function bridge(options: { surfaceThrows?: boolean } = {}) {
    const surfaced: string[] = [];
    const withdrawnIds: string[] = [];
    const instance = new ElicitationAskUserBridge({
      idPrefix: 'f1220',
      surface: request => {
        if (options.surfaceThrows) throw new Error('no screen');
        surfaced.push(request.requestId);
      },
      permissionMode: () => 'default',
      timeoutMs: () => undefined,
      withdraw: requestId => { withdrawnIds.push(requestId); },
    });
    const ask = (signal?: AbortSignal) => instance.ask(
      { question: 'Pick one', options: ['a', 'b'], allowFreeText: false },
      signal,
    ).catch((error: unknown) => error);
    return { instance, surfaced, withdrawnIds, ask };
  }

  it('an aborted dialog and every dialog of a cancelAll are withdrawn, by id', async () => {
    const { instance, surfaced, withdrawnIds, ask } = bridge();
    const controller = new AbortController();
    const first = ask(controller.signal);
    const second = ask();
    const third = ask();
    controller.abort();
    instance.cancelAll('teardown');
    await Promise.all([first, second, third]);
    expect(withdrawnIds).toEqual(surfaced);
    expect(withdrawnIds).toHaveLength(3);
  });

  it('an answered or refused dialog is not withdrawn, and neither is one that never reached a screen', async () => {
    const answered = bridge();
    const pending = answered.ask();
    answered.instance.respond(answered.surfaced[0]!, true, { type: 'option', optionIndex: 0, value: 'a' });
    expect(await pending).toEqual({ type: 'option', optionIndex: 0, value: 'a' });
    const refused = answered.ask();
    answered.instance.respond(answered.surfaced[1]!, false);
    expect(await refused).toBeInstanceOf(Error);
    answered.instance.cancelAll('after the fact');
    expect(answered.withdrawnIds).toEqual([]);

    const unseen = bridge({ surfaceThrows: true });
    expect(await unseen.ask()).toBeInstanceOf(Error);
    unseen.instance.cancelAll('teardown');
    expect(unseen.withdrawnIds).toEqual([]);
  });
});

/**
 * F1.818 (origin SIT-s F1.67 side-finding, 2026-09-25, packaged `5896a66d2`) —
 * the askUserQuestionTimeout clock belongs to the HOST, armed when the question
 * is ASKED, as Pi's ask-user-service arms it. Measured on claude: the clock was
 * the RENDERER's, armed when the card MOUNTS, so an unattended or backgrounded
 * session's question never expired — 12 min 23 s and 2 min 55 s of silence in
 * the sitting's two arms, expiring only ~60 s after somebody opened the session.
 *
 * The settlement is Pi's shape: the batched answer with `autoContinued` (never a
 * tool error) — `askUserQuestionAnswerEnvelope` already turns that into the
 * SDK's `afkTimeoutMs` and away note. The card leaves through the same withdraw
 * channel a cancel uses: the question is answered even though nobody answered
 * it, so the host record and the card must both go (the F1.220 rule above gains
 * exactly this one case).
 */
describe('F1.818 — the bridge arms the askUserQuestionTimeout clock host-side', () => {
  function timedBridge(timeoutMs: number | undefined) {
    const surfaced: string[] = [];
    const withdrawnIds: string[] = [];
    const instance = new ElicitationAskUserBridge({
      idPrefix: 'f1818',
      surface: request => { surfaced.push(request.requestId); },
      permissionMode: () => 'default',
      timeoutMs: () => timeoutMs,
      withdraw: requestId => { withdrawnIds.push(requestId); },
    });
    const ask = () => instance.ask(
      { question: 'Pick one', options: ['a', 'b'], allowFreeText: false },
    ).catch((error: unknown) => error);
    const orTimeout = async (pending: Promise<unknown>, ms: number) =>
      Promise.race([pending, new Promise<'race-lost'>(resolve => setTimeout(() => resolve('race-lost'), ms))]);
    return { instance, surfaced, withdrawnIds, ask, orTimeout };
  }

  it('PREMISE: a question with a timeout expires by itself — settled auto-continued and withdrawn — with no card ever mounted', async () => {
    const rig = timedBridge(30);
    const outcome = await rig.orTimeout(rig.ask(), 500);
    // At HEAD this reads 'race-lost': nothing armed the clock, the promise
    // waited forever exactly as SIT-s measured.
    expect(outcome).toEqual({ type: 'batched', answers: {}, autoContinued: true });
    expect(rig.withdrawnIds).toEqual(rig.surfaced);
  });

  it('an answer wins the race and the clock is gone with the question (no late withdrawal)', async () => {
    const rig = timedBridge(60_000);
    const pending = rig.ask();
    rig.instance.respond(rig.surfaced[0]!, true, { type: 'option', optionIndex: 0, value: 'a' });
    const outcome = await rig.orTimeout(pending, 500);
    expect(outcome).toEqual({ type: 'option', optionIndex: 0, value: 'a' });
    expect(rig.withdrawnIds).toEqual([]);
    // The timer must not hold the process (or fire into a settled id later):
    // give any wrongly-armed 60 s clock no chance to matter, then assert the
    // contract that would break if it fired — a withdrawal for an ANSWERED
    // dialog, which F1.220 forbids.
    rig.instance.cancelAll('teardown');
    expect(rig.withdrawnIds).toEqual([]);
  });

  it('without a configured timeout nothing is armed — the default never expires', async () => {
    const rig = timedBridge(undefined);
    const pending = rig.ask();
    const outcome = await rig.orTimeout(pending, 200);
    expect(outcome).toBe('race-lost');
    expect(rig.withdrawnIds).toEqual([]);
    rig.instance.cancelAll('teardown');
  });
});

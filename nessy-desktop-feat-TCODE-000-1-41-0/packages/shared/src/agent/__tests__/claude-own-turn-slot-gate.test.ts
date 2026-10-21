/**
 * F1.540 (origin WJ-ar P-WJ-ar-2) — a host turn must never open its slot while the claude child is running a turn it
 * opened ITSELF: `chatImpl` waits that turn out, so the host's message is written only once the child is idle.
 *
 * ## The window this closes
 *
 * F1.509 made `SessionManager.sendMessage` queue a send while `runtimeOwnTurnSettled()` is pending. It reads the
 * marker ONCE, at the top of the send, and the turn's whole preparation (`ensureLiveSession`'s control requests, the
 * prompt build) runs after that read. The child's own `init` can arrive anywhere in it, and the slot then opens and
 * writes mid-turn: F1.528's rig (`work/wjar/`) measured the CLI FOLDING that write into its own turn at the next tool
 * boundary, or, with none left, answering the own turn into the host's slot and the host's text in a turn no slot
 * watches — the pre-F1.509 slip.
 *
 * ## What this file pins
 *
 * (a) A host turn that reaches its slot while the own turn runs WAITS: nothing is written until the own turn's
 *     `result`; the own turn's reply goes through the between-turns door; the host slot gets the host's reply.
 * (b) A Stop during that wait ends the host turn WITHOUT writing it, promptly, and leaves the child's own turn alone.
 * (c) A steer during that wait is refused WITHOUT the abort fallback (which kills the child, own turn and all), and
 *     the backend says so on the contract (`redirectFallbackInterruptsTurn()` false), so the host queues it without
 *     stamping `wasInterrupted` on a turn nothing interrupted. CONTROL: a steer with no host turn at all still takes
 *     the abort fallback and answers `true`.
 * (d) The child dying under its own turn while a host turn waits: the host turn runs on a respawned child instead of
 *     writing into the dead input.
 * CONTROL: with no own turn pending the host turn writes at once.
 *
 * The rig is `claude-runtime-own-turn.test.ts`'s, with one change: the fake reads the input channel CONCURRENTLY and
 * stamps every write with the phase it arrived in, which is the only way to see WHEN a message was written.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import { AbortReason } from '../core/session-lifecycle.ts';

// Importing `claude-agent.ts` is this file's wall-clock cost; the cases are milliseconds (AGENTS.md: size the budget
// against the FILE, not the case).
setDefaultTimeout(120_000);

const realSdk = { ...sdkPackage };

const scripts: Array<() => AsyncGenerator<unknown>> = [];
/** Every message the agent wrote, with the fake query it reached and the phase the test had declared at that moment. */
const writes: Array<{ query: number; phase: string; text: string }> = [];
let queryCount = 0;
let phase = 'idle';

function resultMessage(text = 'ok'): unknown {
  return {
    type: 'result',
    subtype: 'success',
    result: text,
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

function assistantText(text: string, uuid: string): unknown {
  return {
    type: 'assistant', parent_tool_use_id: null, session_id: 'sdk-f1-540', uuid,
    message: { id: `msg_${uuid}`, role: 'assistant', content: [{ type: 'text', text }] },
  };
}

/**
 * The own turn's reply as the CLI streams it (`includePartialMessages`): the between-turns door hands a main-thread
 * reply over at its `message_delta` (`claude-between-turns-task-events.test.ts`'s `streamedReply`), so a bare
 * `assistant` message would reach no door in this fake at all.
 */
function streamedReply(id: string, text: string): unknown[] {
  const streamEvent = (event: unknown) => ({ type: 'stream_event', event, parent_tool_use_id: null, session_id: 'sdk-f1-540', uuid: `s-${id}-${Math.random()}` });
  return [
    streamEvent({ type: 'message_start', message: { id, role: 'assistant', content: [] } }),
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    { type: 'assistant', parent_tool_use_id: null, session_id: 'sdk-f1-540', uuid: `a-${id}`, message: { id, role: 'assistant', content: [{ type: 'text', text }] } },
    streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
  ];
}

async function* plainSuccess(): AsyncGenerator<unknown> {
  yield resultMessage();
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    queryCount += 1;
    const id = queryCount;
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    const inbox: unknown[] = [];
    let wake: (() => void) | null = null;
    let inputDone = false;
    const nudge = () => { const w = wake; wake = null; w?.(); };
    // Read the channel CONCURRENTLY, as the real SDK's `streamInput` does, so a write is stamped when it is made —
    // not when the script gets round to serving it.
    void (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        writes.push({ query: id, phase, text: JSON.stringify(next.value) });
        inbox.push(next.value);
        nudge();
      }
      inputDone = true;
      nudge();
    })();
    async function* serveTurns(): AsyncGenerator<unknown> {
      for (;;) {
        while (inbox.length === 0) {
          if (inputDone) return;
          await new Promise<void>(resolve => { wake = resolve; });
        }
        inbox.shift();
        const script = scripts.shift() ?? plainSuccess;
        yield* script();
      }
    }
    const stream = serveTurns() as AsyncGenerator<unknown> & { interrupt(): Promise<unknown> };
    stream.interrupt = async () => ({ still_queued: [] });
    return stream;
  },
}));

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
});

const { ClaudeAgent } = await import('../claude-agent.ts');

const WORKSPACE_ROOT = '/tmp/nessy-f1-540';
const HOST_MARK = 'F1540-HOST-MESSAGE';

const doorEvents: AgentEvent[] = [];

function agentConfig(sessionId: string): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f1-540',
      name: 'F1.540',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: { id: sessionId, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: WORKSPACE_ROOT } as never,
    onBetweenTurnsEvent: (event: AgentEvent) => { doorEvents.push(event); },
  } as BackendConfig;
}

type GateAgent = InstanceType<typeof ClaudeAgent> & {
  runtimeOwnTurnSettled?: () => Promise<void> | null;
  redirectFallbackInterruptsTurn?: () => boolean;
};

/**
 * Turn 1 ends; on `startOwn()` the child opens a turn of its own (init, status) and pauses; on `endOwn()` it answers
 * with its reply and its `result` — or, with `crash`, its stream fails there, as a child that dies mid-turn does.
 */
function turnThenOwnTurn(options: { crash?: boolean } = {}): {
  startOwn(): void; endOwn(): void; headRouted: Promise<void>;
} {
  let openStart!: () => void;
  let openEnd!: () => void;
  let headDone!: () => void;
  const start = new Promise<void>(resolve => { openStart = resolve; });
  const end = new Promise<void>(resolve => { openEnd = resolve; });
  const headRouted = new Promise<void>(resolve => { headDone = resolve; });
  scripts.push(async function* turnThenOwn() {
    yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-540', uuid: 'u-host-init' };
    yield resultMessage();
    await start;
    phase = 'own-running';
    yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-540', uuid: 'u-own-init' };
    yield { type: 'system', subtype: 'status', status: 'requesting', session_id: 'sdk-f1-540', uuid: 'u-own-status' };
    headDone();
    await end;
    if (options.crash) {
      phase = 'own-crashed';
      throw new Error('F1540 the child died mid-turn');
    }
    for (const message of streamedReply('msg_own', 'F1540-OWN-REPLY')) yield message;
    // Declared BEFORE the result is yielded: anything written after this point was written once the child had
    // finished its own turn (the reader routes the result only after this line has run).
    phase = 'own-done';
    yield resultMessage('F1540-OWN-REPLY');
  });
  return { startOwn: () => openStart(), endOwn: () => openEnd(), headRouted };
}

/** The host's message, answered as the host turn it is. */
async function* hostReply(): AsyncGenerator<unknown> {
  yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-540', uuid: 'u-host2-init' };
  yield assistantText('F1540-HOST-REPLY', 'a-host');
  yield resultMessage('F1540-HOST-REPLY');
}

function drive(agent: GateAgent, message: string): { events: AgentEvent[]; done: Promise<unknown> } {
  const chatImpl = (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<AgentEvent> }).chatImpl.bind(agent);
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const event of chatImpl(message)) events.push(event);
  })().then(() => 'ended', (error: unknown) => error);
  return { events, done };
}

const texts = (events: AgentEvent[]) =>
  events.filter(e => e.type === 'text_complete').map(e => (e as { text?: string }).text);
const hostWrites = () => writes.filter(w => w.text.includes(HOST_MARK));

/** The reader is detached; one macrotask after a release lets its last `routeLiveMessage` settle. */
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'still-pending'> {
  return Promise.race([promise, new Promise<'still-pending'>(resolve => setTimeout(() => resolve('still-pending'), ms))]);
}

let counter = 0;
let liveAgent: GateAgent | null = null;

beforeEach(() => {
  scripts.length = 0;
  writes.length = 0;
  doorEvents.length = 0;
  queryCount = 0;
  phase = 'idle';
});

afterEach(() => {
  liveAgent?.destroy();
  liveAgent = null;
});

function freshAgent(): GateAgent {
  counter += 1;
  liveAgent = new ClaudeAgent(agentConfig(`session-f1-540-${counter}`)) as GateAgent;
  // The fixture's runtime is asserted rather than assumed (AGENTS.md, the 2026-09-20 fixture trap).
  expect(liveAgent).toBeInstanceOf(ClaudeAgent);
  return liveAgent;
}

/** Turn 1, then the child's own turn running (its slot-less init routed), then a host turn entering `chatImpl`. */
async function hostTurnDuringOwnTurn(agent: GateAgent, own: ReturnType<typeof turnThenOwnTurn>) {
  const first = drive(agent, 'start a background subagent');
  expect(await first.done).toBe('ended');
  expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeNull();
  own.startOwn();
  await own.headRouted;
  await tick();
  // The precondition: the own turn IS pending when the host turn reaches its slot (the send read `null` earlier).
  const ownTurn = agent.runtimeOwnTurnSettled?.() ?? null;
  expect(ownTurn).toBeInstanceOf(Promise);
  const host = drive(agent, `${HOST_MARK} please say hi`);
  await tick(100);
  return { host, ownTurn: ownTurn! };
}

describe('F1.540 — a host turn waits out the child\'s own turn before opening its slot', () => {
  it('(a) nothing is written until the own turn\'s result; the own reply goes through the door, the host reply to the host slot', async () => {
    const agent = freshAgent();
    const own = turnThenOwnTurn();
    scripts.push(hostReply);

    const { host } = await hostTurnDuringOwnTurn(agent, own);
    // THE DEFECT: before this row the slot opened here and the message went into the child mid-turn.
    expect(hostWrites()).toEqual([]);
    expect(agent.isProcessing()).toBe(false);

    own.endOwn();
    expect(await within(host.done, 5_000)).toBe('ended');
    await tick();

    expect(hostWrites().map(w => w.phase)).toEqual(['own-done']);
    expect(texts(host.events)).toEqual(['F1540-HOST-REPLY']);
    expect(host.events.some(e => e.type === 'complete')).toBe(true);
    expect(texts(doorEvents)).toContain('F1540-OWN-REPLY');
    expect(texts(doorEvents)).not.toContain('F1540-HOST-REPLY');
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeNull();
    expect(queryCount).toBe(1);
  });

  it('(b) a Stop during the wait ends the host turn without writing it, and leaves the child\'s own turn running', async () => {
    const agent = freshAgent();
    const own = turnThenOwnTurn();

    const { host, ownTurn } = await hostTurnDuringOwnTurn(agent, own);
    agent.forceAbort(AbortReason.UserStop);
    // Promptly — not when the own turn happens to end.
    expect(await within(host.done, 1_000)).not.toBe('still-pending');
    expect(hostWrites()).toEqual([]);
    // The child's own turn was not the user's to stop here: it is still running, and it ends on its own result.
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBe(ownTurn);

    own.endOwn();
    expect(await within(ownTurn.then(() => 'settled'), 2_000)).toBe('settled');
    await tick();
    expect(texts(doorEvents)).toContain('F1540-OWN-REPLY');
    expect(hostWrites()).toEqual([]);
    expect(queryCount).toBe(1);
  });

  it('(c) a steer during the wait is refused without killing the session, and the contract says nothing was interrupted', async () => {
    const agent = freshAgent();
    const own = turnThenOwnTurn();
    scripts.push(hostReply);

    const { host, ownTurn } = await hostTurnDuringOwnTurn(agent, own);
    expect(agent.redirect('F1540-STEER during the wait')).toBe(false);
    // The abort fallback is `killLiveSession`: it would have settled the own turn by teardown and ended the child.
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBe(ownTurn);
    expect(typeof agent.redirectFallbackInterruptsTurn).toBe('function');
    expect(agent.redirectFallbackInterruptsTurn?.()).toBe(false);

    own.endOwn();
    expect(await within(host.done, 5_000)).toBe('ended');
    expect(texts(host.events)).toEqual(['F1540-HOST-REPLY']);
    // The refused steer is the HOST's to queue: nothing of it reached the child.
    expect(writes.some(w => w.text.includes('F1540-STEER'))).toBe(false);
    expect(queryCount).toBe(1);
  });

  it('CONTROL — a steer with no host turn at all still takes the abort fallback, and says so', async () => {
    const agent = freshAgent();
    const first = drive(agent, 'an ordinary turn');
    expect(await first.done).toBe('ended');
    expect(agent.redirect('F1540-STEER between turns')).toBe(false);
    expect(agent.redirectFallbackInterruptsTurn?.() ?? true).toBe(true);
  });

  it('(d) the child dying under its own turn while a host turn waits: the host turn runs on a respawned child', async () => {
    const agent = freshAgent();
    const own = turnThenOwnTurn({ crash: true });
    scripts.push(hostReply);

    const { host } = await hostTurnDuringOwnTurn(agent, own);
    own.endOwn();
    expect(await within(host.done, 5_000)).toBe('ended');

    // Never into the child that was dying, and exactly once.
    expect(hostWrites().map(w => w.query)).toEqual([2]);
    expect(texts(host.events)).toEqual(['F1540-HOST-REPLY']);
    expect(queryCount).toBe(2);
  });

  it('CONTROL — with no own turn pending, the host turn writes at once', async () => {
    const agent = freshAgent();
    const first = drive(agent, 'an ordinary turn');
    expect(await first.done).toBe('ended');
    scripts.push(hostReply);
    const host = drive(agent, `${HOST_MARK} straight away`);
    expect(await within(host.done, 5_000)).toBe('ended');
    expect(hostWrites().map(w => w.phase)).toEqual(['idle']);
    expect(texts(host.events)).toEqual(['F1540-HOST-REPLY']);
  });
});

/**
 * F1.524 (1) (origin WJ-am P-WJ-am-1) — the turn the claude child opens ITSELF to hand the model a
 * `<task-notification>` is known from the notification, not only from the turn's own `init`.
 *
 * ## The window, measured
 *
 * F1.509's marker is the child's slot-less `system/init`. The CLI sends it some tens of milliseconds AFTER the
 * between-turns `task_notification` that ended the task: 61 / 17 / 17 ms on the vendored 2.1.251 (WJ-am's rig), and
 * 54 / 21 / 80 / 53 / 97 ms on 2.1.267 (WJ-bb's rig, `work/wjbb/`, five arms: two `completed`, three `stopped` by
 * `Query.stopTask`). Every one of those eight notifications was followed by an own turn. F1.540's gate reads the marker
 * just before a host slot opens; a read inside that gap saw `null`, the slot opened, and the own turn's frames landed
 * in it — the pre-F1.509 slip. (`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`'s `running`, F1.539, arrives 2–7 ms before
 * the `init` and 19–91 ms after the notification: it does not close the gap either.)
 *
 * ## What this file pins
 *
 * (a) A slot-less terminal `task_notification` opens the marker at once, and a host turn reaching its slot before the
 *     child's `init` waits the own turn out: its message is written only after the own turn's `result`.
 * (b) The expectation is BOUNDED: a notification no own turn follows (none was ever measured, and the cost of being
 *     wrong must be small) releases the marker after a short start bound, and a waiting host turn then writes.
 * CONTROL: a `task_notification` routed INTO an open host slot (the task ended during a host turn) opens nothing.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';

// Importing `claude-agent.ts` is this file's wall-clock cost; the cases are milliseconds (AGENTS.md: size the budget
// against the FILE, not the case).
setDefaultTimeout(120_000);

const realSdk = { ...sdkPackage };

const scripts: Array<() => AsyncGenerator<unknown>> = [];
const writes: Array<{ phase: string; text: string }> = [];
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
    type: 'assistant', parent_tool_use_id: null, session_id: 'sdk-f1-524', uuid,
    message: { id: `msg_${uuid}`, role: 'assistant', content: [{ type: 'text', text }] },
  };
}

/** The terminal message of a background task that ended between turns (`sdk.d.ts`, `SDKTaskNotificationMessage`). */
function taskNotification(taskId: string): unknown {
  return {
    type: 'system', subtype: 'task_notification', task_id: taskId, status: 'completed',
    output_file: '/tmp/f1524/out.txt', summary: 'done', session_id: 'sdk-f1-524', uuid: `n-${taskId}`,
  };
}

async function* plainSuccess(): AsyncGenerator<unknown> {
  yield resultMessage();
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    const inbox: unknown[] = [];
    let wake: (() => void) | null = null;
    let inputDone = false;
    const nudge = () => { const w = wake; wake = null; w?.(); };
    // Read the channel CONCURRENTLY (as `claude-own-turn-slot-gate.test.ts` does), so a write is stamped when made.
    void (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        writes.push({ phase, text: JSON.stringify(next.value) });
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

const WORKSPACE_ROOT = '/tmp/nessy-f1-524-1';
const HOST_MARK = 'F1524-HOST-MESSAGE';

function agentConfig(sessionId: string): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f1-524-1',
      name: 'F1.524',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: { id: sessionId, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: WORKSPACE_ROOT } as never,
    onBetweenTurnsEvent: () => {},
  } as BackendConfig;
}

type MarkerAgent = InstanceType<typeof ClaudeAgent> & { runtimeOwnTurnSettled?: () => Promise<void> | null };

/**
 * Turn 1 ends; on `notify()` a background task's `task_notification` arrives with no slot open; on `openTurn()` the
 * child opens its own turn (init, reply, result) — or, with `noTurn`, never does.
 */
function notificationThenOwnTurn(options: { noTurn?: boolean } = {}): {
  notify(): void; openTurn(): void; notified: Promise<void>; ownDone: Promise<void>;
} {
  let openNotify!: () => void;
  let openOwn!: () => void;
  let markNotified!: () => void;
  let markDone!: () => void;
  const notifyGate = new Promise<void>(resolve => { openNotify = resolve; });
  const ownGate = new Promise<void>(resolve => { openOwn = resolve; });
  const notified = new Promise<void>(resolve => { markNotified = resolve; });
  const ownDone = new Promise<void>(resolve => { markDone = resolve; });
  scripts.push(async function* turnThenNotification() {
    yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-524', uuid: 'u-host-init' };
    yield resultMessage();
    await notifyGate;
    phase = 'notified';
    yield taskNotification('task-f1524');
    markNotified();
    if (options.noTurn) return;
    await ownGate;
    phase = 'own-running';
    yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-524', uuid: 'u-own-init' };
    yield assistantText('F1524-OWN-REPLY', 'a-own');
    phase = 'own-done';
    yield resultMessage('F1524-OWN-REPLY');
    markDone();
  });
  return { notify: () => openNotify(), openTurn: () => openOwn(), notified, ownDone };
}

async function* hostReply(): AsyncGenerator<unknown> {
  yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-524', uuid: 'u-host2-init' };
  yield assistantText('F1524-HOST-REPLY', 'a-host');
  yield resultMessage('F1524-HOST-REPLY');
}

function drive(agent: MarkerAgent, message: string): { events: AgentEvent[]; done: Promise<unknown> } {
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
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'still-pending'> {
  return Promise.race([promise, new Promise<'still-pending'>(resolve => setTimeout(() => resolve('still-pending'), ms))]);
}

let counter = 0;
let liveAgent: MarkerAgent | null = null;

beforeEach(() => {
  scripts.length = 0;
  writes.length = 0;
  phase = 'idle';
});

afterEach(() => {
  liveAgent?.destroy();
  liveAgent = null;
});

function freshAgent(): MarkerAgent {
  counter += 1;
  liveAgent = new ClaudeAgent(agentConfig(`session-f1-524-1-${counter}`)) as MarkerAgent;
  // The fixture's runtime is asserted rather than assumed (AGENTS.md, the 2026-09-20 fixture trap).
  expect(liveAgent).toBeInstanceOf(ClaudeAgent);
  return liveAgent;
}

describe('F1.524 (1) — the own turn is expected from its task_notification, not only from its init', () => {
  it('(a) the marker opens at the notification, and a host turn reaching its slot before the init waits the turn out', async () => {
    const agent = freshAgent();
    const own = notificationThenOwnTurn();
    scripts.push(hostReply);

    const first = drive(agent, 'start a background subagent');
    expect(await first.done).toBe('ended');
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeNull();

    own.notify();
    await own.notified;
    await tick();
    // THE GAP: before this row nothing marked the turn the child was about to open.
    const expected = agent.runtimeOwnTurnSettled?.() ?? null;
    expect(expected).toBeInstanceOf(Promise);

    const host = drive(agent, `${HOST_MARK} please say hi`);
    await tick(100);
    expect(hostWrites()).toEqual([]);

    own.openTurn();
    expect(await within(host.done, 5_000)).toBe('ended');
    expect(hostWrites().map(w => w.phase)).toEqual(['own-done']);
    expect(texts(host.events)).toEqual(['F1524-HOST-REPLY']);
    // The same promise carried the whole turn: the expectation, then the turn its init started.
    expect(await within(expected!.then(() => 'settled'), 1_000)).toBe('settled');
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeNull();
  });

  it('(b) a notification no turn follows releases the marker after the start bound, and a waiting host turn writes', async () => {
    const agent = freshAgent();
    (agent as unknown as { runtimeOwnTurnStartBoundMs: number }).runtimeOwnTurnStartBoundMs = 150;
    const own = notificationThenOwnTurn({ noTurn: true });
    scripts.push(hostReply);

    const first = drive(agent, 'start a background subagent');
    expect(await first.done).toBe('ended');
    own.notify();
    await own.notified;
    await tick();
    const expected = agent.runtimeOwnTurnSettled?.() ?? null;
    expect(expected).toBeInstanceOf(Promise);

    const host = drive(agent, `${HOST_MARK} after a notification with no turn`);
    expect(await within(host.done, 5_000)).toBe('ended');
    expect(hostWrites().map(w => w.phase)).toEqual(['notified']);
    expect(texts(host.events)).toEqual(['F1524-HOST-REPLY']);
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeNull();
  });

  it('CONTROL — a task_notification routed into an open host slot opens nothing', async () => {
    const agent = freshAgent();
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>(resolve => { releaseTurn = resolve; });
    let notifiedInTurn!: () => void;
    const inTurn = new Promise<void>(resolve => { notifiedInTurn = resolve; });
    scripts.push(async function* notificationInsideAHostTurn() {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-524', uuid: 'u-host-init' };
      yield taskNotification('task-in-turn');
      notifiedInTurn();
      await turnGate;
      yield resultMessage();
    });

    const turn = drive(agent, 'a turn during which a task ends');
    await inTurn;
    await tick();
    expect(agent.isProcessing()).toBe(true);
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeNull();
    releaseTurn();
    expect(await within(turn.done, 5_000)).toBe('ended');
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeNull();
  });
});

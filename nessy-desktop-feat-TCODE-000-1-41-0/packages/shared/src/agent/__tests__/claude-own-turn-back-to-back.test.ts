/**
 * F1.597 (origin WJ-bb P-WJbb-2) — two background tasks ending back to back: the claude child answers each in a turn of
 * its OWN, and the host must not write into the gap between those two turns.
 *
 * ## The window, measured (vendored 2.1.267 / SDK 0.3.267, WJ-bv's rig `work/wjbv/`, 2026-09-24)
 *
 * Two background subagents ending ~100 ms apart. Task A's `task_notification` opens F1.524 (1)'s expected turn, the
 * child's `init` starts it 5–71 ms later — and task B's `task_notification` arrives DURING that turn (26–89 ms after
 * its `init`, six arms). The CLI does not fold B into a turn that makes no further request: it answers B in a SECOND
 * turn of its own, whose slot-less `init` came 0–9 ms after the first turn's `result` (four arms with no send in the
 * gap: `two-bg-1`, `two-bg-2`, `two-bg-host-l20`, `two-bg-host-l50`). The
 * marker was `null` in between, so a host turn reaching F1.540's check there opened its slot and wrote: with the send
 * 2 ms after that `result` (arm `two-bg-host-l0`) the host slot received the child's second turn — B's reply — and closed
 * on ITS `result`, and the host's own message was answered in a turn no slot watched: the pre-F1.509 slip. The host's
 * synchronous turn preparation kept the reader from routing the second `init` for 2.36 s, so the gap is not 0–9 ms
 * wide on a busy host. At 20 and 50 ms the send found the second turn running and waited, as F1.540 intends.
 *
 * B's notification arriving BEFORE the first own turn's `init` changes nothing (arm `two-bg-gap10`: 6 ms after A's,
 * while the turn was only expected): the first turn still carried A alone, and B came in a second turn 4 ms after its
 * `result`. When the first own turn DOES make another request after B's notification (a tool call, arm `two-bg-tool`),
 * the CLI folds B into that request and no second turn follows.
 *
 * ## What this file pins
 *
 * (a) A task that ends while the child's own turn RUNS is owed a turn of its own: at that turn's `result` the SAME
 *     promise stays pending as an EXPECTED turn, so a host turn in the gap waits out the second turn too.
 * (b) The expectation is bounded exactly as F1.524 (1)'s is: when the CLI folded the task into the first turn and no
 *     second turn comes, it releases after the start bound and a waiting host turn writes.
 * CONTROL (c): with ONE task, nothing is owed — the marker is `null` at the own turn's `result`, as before this row.
 * (d) A task that ends while the first own turn is only EXPECTED is owed a turn of its own too.
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
    type: 'assistant', parent_tool_use_id: null, session_id: 'sdk-f1-597', uuid,
    message: { id: `msg_${uuid}`, role: 'assistant', content: [{ type: 'text', text }] },
  };
}

/** The terminal message of a background task (`sdk.d.ts`, `SDKTaskNotificationMessage`). */
function taskNotification(taskId: string): unknown {
  return {
    type: 'system', subtype: 'task_notification', task_id: taskId, status: 'completed',
    output_file: `/tmp/f1597/${taskId}.txt`, summary: 'done', session_id: 'sdk-f1-597', uuid: `n-${taskId}`,
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

const WORKSPACE_ROOT = '/tmp/nessy-f1-597';
const HOST_MARK = 'F1597-HOST-MESSAGE';

function agentConfig(sessionId: string): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f1-597',
      name: 'F1.597',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: { id: sessionId, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: WORKSPACE_ROOT } as never,
    onBetweenTurnsEvent: () => {},
  } as BackendConfig;
}

type MarkerAgent = InstanceType<typeof ClaudeAgent> & {
  runtimeOwnTurnSettled?: () => Promise<void> | null;
  onRuntimeOwnTurn?: (phase: 'running' | 'ended') => void;
};

/**
 * The host's turn 1 ends; on `notify()` task A's `task_notification` arrives with no slot open and the child opens its
 * own turn, during which task B's (or, with `oneTask`, no second) notification arrives; the turn ends on its `result`.
 * On `openSecond()` the child opens its SECOND own turn — unless `noSecondTurn` (the CLI folded B into the first).
 */
function backToBack(options: { oneTask?: boolean; noSecondTurn?: boolean; earlyB?: boolean } = {}): {
  notify(): void; openSecond(): void; firstDone: Promise<void>; secondDone: Promise<void>;
} {
  let openNotify!: () => void;
  let openTwo!: () => void;
  let markFirst!: () => void;
  let markSecond!: () => void;
  const notifyGate = new Promise<void>(resolve => { openNotify = resolve; });
  const secondGate = new Promise<void>(resolve => { openTwo = resolve; });
  const firstDone = new Promise<void>(resolve => { markFirst = resolve; });
  const secondDone = new Promise<void>(resolve => { markSecond = resolve; });
  scripts.push(async function* hostTurnThenTwoOwnTurns() {
    yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-597', uuid: 'u-host-init' };
    yield resultMessage();
    await notifyGate;
    phase = 'notified-a';
    yield taskNotification('task-a');
    if (options.earlyB) yield taskNotification('task-b');
    phase = 'own1-running';
    yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-597', uuid: 'u-own1-init' };
    if (!options.oneTask && !options.earlyB) yield taskNotification('task-b');
    yield assistantText('F1597-OWN-1-REPLY', 'a-own1');
    phase = 'own1-done';
    yield resultMessage('F1597-OWN-1-REPLY');
    markFirst();
    if (options.oneTask || options.noSecondTurn) return;
    await secondGate;
    phase = 'own2-running';
    yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-597', uuid: 'u-own2-init' };
    yield assistantText('F1597-OWN-2-REPLY', 'a-own2');
    phase = 'own2-done';
    yield resultMessage('F1597-OWN-2-REPLY');
    markSecond();
  });
  return { notify: () => openNotify(), openSecond: () => openTwo(), firstDone, secondDone };
}

async function* hostReply(): AsyncGenerator<unknown> {
  yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-597', uuid: 'u-host2-init' };
  yield assistantText('F1597-HOST-REPLY', 'a-host');
  yield resultMessage('F1597-HOST-REPLY');
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

function freshAgent(): { agent: MarkerAgent; phases: string[] } {
  counter += 1;
  liveAgent = new ClaudeAgent(agentConfig(`session-f1-597-${counter}`)) as MarkerAgent;
  // The fixture's runtime is asserted rather than assumed (AGENTS.md, the 2026-09-20 fixture trap).
  expect(liveAgent).toBeInstanceOf(ClaudeAgent);
  const phases: string[] = [];
  liveAgent.onRuntimeOwnTurn = p => { phases.push(p); };
  return { agent: liveAgent, phases };
}

describe('F1.597 — a task that ends during the child’s own turn is owed a turn of its own', () => {
  it('(a) the marker stays pending through the gap, and a host turn sent there waits out the second own turn', async () => {
    const { agent, phases } = freshAgent();
    const own = backToBack();
    scripts.push(hostReply);

    const first = drive(agent, 'start two background subagents');
    expect(await first.done).toBe('ended');

    own.notify();
    await own.firstDone;
    await tick();
    // THE GAP: the first own turn has ended, the second has not started.
    const owed = agent.runtimeOwnTurnSettled?.() ?? null;
    expect(owed).toBeInstanceOf(Promise);
    expect(phases).toEqual(['running', 'ended']);

    const host = drive(agent, `${HOST_MARK} please say hi`);
    await tick(100);
    expect(hostWrites()).toEqual([]);

    own.openSecond();
    expect(await within(host.done, 5_000)).toBe('ended');
    expect(hostWrites().map(w => w.phase)).toEqual(['own2-done']);
    expect(texts(host.events)).toEqual(['F1597-HOST-REPLY']);
    // One promise carried the first turn, the gap and the second turn — the host waited on it once.
    expect(await within(owed!.then(() => 'settled'), 1_000)).toBe('settled');
    expect(phases).toEqual(['running', 'ended', 'running', 'ended']);
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeNull();
  });

  it('(b) when the CLI folded the second task into the first turn, the expectation releases after the start bound', async () => {
    const { agent, phases } = freshAgent();
    (agent as unknown as { runtimeOwnTurnStartBoundMs: number }).runtimeOwnTurnStartBoundMs = 150;
    const own = backToBack({ noSecondTurn: true });
    scripts.push(hostReply);

    const first = drive(agent, 'start two background subagents');
    expect(await first.done).toBe('ended');
    own.notify();
    await own.firstDone;
    await tick();
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeInstanceOf(Promise);

    const host = drive(agent, `${HOST_MARK} after a folded second task`);
    await tick(50);
    expect(hostWrites()).toEqual([]);
    expect(await within(host.done, 5_000)).toBe('ended');
    expect(hostWrites().map(w => w.phase)).toEqual(['own1-done']);
    expect(texts(host.events)).toEqual(['F1597-HOST-REPLY']);
    // The expected second turn never started, so it reports nothing: the busy seam saw exactly one own turn.
    expect(phases).toEqual(['running', 'ended']);
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeNull();
  });

  it('CONTROL (c) — with one task nothing is owed: the marker is null at the own turn’s result, as before this row', async () => {
    const { agent, phases } = freshAgent();
    const own = backToBack({ oneTask: true });
    scripts.push(hostReply);

    const first = drive(agent, 'start one background subagent');
    expect(await first.done).toBe('ended');
    own.notify();
    await own.firstDone;
    await tick();
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeNull();
    expect(phases).toEqual(['running', 'ended']);

    const host = drive(agent, `${HOST_MARK} after one task`);
    expect(await within(host.done, 5_000)).toBe('ended');
    expect(hostWrites().map(w => w.phase)).toEqual(['own1-done']);
    expect(texts(host.events)).toEqual(['F1597-HOST-REPLY']);
  });

  it('(d) a task that ends before the first own turn’s init is owed a turn of its own as well', async () => {
    const { agent, phases } = freshAgent();
    const own = backToBack({ earlyB: true });
    scripts.push(hostReply);

    const first = drive(agent, 'start two background subagents');
    expect(await first.done).toBe('ended');
    own.notify();
    await own.firstDone;
    await tick();
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeInstanceOf(Promise);

    const host = drive(agent, `${HOST_MARK} after two early tasks`);
    await tick(100);
    expect(hostWrites()).toEqual([]);
    own.openSecond();
    expect(await within(host.done, 5_000)).toBe('ended');
    expect(hostWrites().map(w => w.phase)).toEqual(['own2-done']);
    expect(texts(host.events)).toEqual(['F1597-HOST-REPLY']);
    expect(phases).toEqual(['running', 'ended', 'running', 'ended']);
  });
});

/**
 * F1.492 — a claude BACKGROUND subagent that ends while NO turn is open.
 *
 * ## What was measured before this row (vendored `claude` 2.1.251, driven through `ClaudeAgent`)
 *
 * The rig kept under `work/wjaf/` wraps the SDK's real `query()` around the vendored binary and a stub Messages
 * upstream, and drives `ClaudeAgent.chatImpl` exactly as the host does: turn 1 starts a background `Agent`, ends,
 * and the subagent finishes about four seconds later with no turn open. Every message after turn 1's `result`
 * reached `routeLiveMessage` with no slot, and `noteBetweenTurnsMessage` dropped all of them:
 *
 * - `system/background_tasks_changed` with `tasks: []` — so the adapter's level kept the finished task, and
 *   `backgroundWorkCount()` answered **1** for the rest of the session (warm arm: still 1 after the NEXT user turn),
 *   which pins the session busy for the idle reaper and the ceiling eviction and keeps the renderer's row running;
 * - `system/task_notification` `completed` — so no `task_completed` ever reached the host, and the subagent's row
 *   never reached a terminal state (F1.475's `onSubagentEnded`, read above the guard, was the only reader);
 * - the CLI's OWN turn that delivers `<task-notification>` to the model (`init`, `assistant`, `result`) — the
 *   reply is in the model's context (the next request carried it) and in no transcript.
 *
 * ## What this file pins (`ClaudeAgent.noteBetweenTurnsMessage`)
 *
 * The level and the terminal state are PER-CHILD facts, not a turn's news, so they are adapted between turns and
 * their two events go to the host's detached-task door — the `processEvent` door T30 built for Pi's detached runs
 * (`BackendConfig.onBetweenTurnsEvent`), where the row's terminal state and `backgroundTaskOutputs` live. The
 * turn the CLI opens itself IS the notification's delivery (native), so its main-thread WORDS cross as
 * `text_complete` and nothing else of it does: never its `complete`, because a `complete` on that door parks
 * terminal state onto the host's next turn (`between-turns-sink-consumer.test.ts`, "WHITELIST REQUIRED"). The
 * host half — R86 not delivering the same end a second time — is `server-core`'s
 * `claude-between-turns-task-delivery.test.ts`.
 *
 * The rig is `claude-steer-fifo.test.ts`'s: the SDK's `query` is faked, everything under it is the real
 * `ClaudeAgent` reader, adapter and slot.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';

const realSdk = { ...sdkPackage };

const scripts: Array<() => AsyncGenerator<unknown>> = [];

function resultMessage(): unknown {
  return {
    type: 'result',
    subtype: 'success',
    result: 'ok',
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

async function* plainSuccess(): AsyncGenerator<unknown> {
  yield resultMessage();
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    async function* serveTurns(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
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

const WORKSPACE_ROOT = '/tmp/nessy-f1-492';
const TASK_ID = 'a76f36bb24e7d8df5';

function agentConfig(sessionId: string, sink?: (event: AgentEvent) => void): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f1-492',
      name: 'F1.492',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: sessionId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: WORKSPACE_ROOT,
    } as never,
    ...(sink ? { onBetweenTurnsEvent: sink } : {}),
  } as BackendConfig;
}

// The measured shapes (sdk.d.ts `SDKBackgroundTasksChangedMessage` / `SDKTaskNotificationMessage`), in the order
// the vendored CLI sent them.
const tasksRunning = {
  type: 'system', subtype: 'background_tasks_changed',
  tasks: [{ task_id: TASK_ID, task_type: 'local_agent', description: 'probe bg' }],
  uuid: 'u-1', session_id: 'sdk-f1-492',
};
const tasksNone = { type: 'system', subtype: 'background_tasks_changed', tasks: [], uuid: 'u-2', session_id: 'sdk-f1-492' };
const taskCompleted = {
  type: 'system', subtype: 'task_notification', task_id: TASK_ID, tool_use_id: 'toolu_f1492_agent',
  status: 'completed', output_file: '', summary: 'probe bg finished', uuid: 'u-3', session_id: 'sdk-f1-492',
};
function streamEvent(event: unknown, parent: string | null = null): unknown {
  return { type: 'stream_event', event, parent_tool_use_id: parent, session_id: 'sdk-f1-492', uuid: `s-${Math.random()}` };
}

/** One assistant message as the CLI streams it (`includePartialMessages`): start, delta, the message, stop reason. */
function streamedReply(id: string, text: string, parent: string | null = null): unknown[] {
  return [
    streamEvent({ type: 'message_start', message: { id, role: 'assistant', content: [] } }, parent),
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, parent),
    {
      type: 'assistant', parent_tool_use_id: parent, session_id: 'sdk-f1-492', uuid: `a-${id}`,
      message: { id, role: 'assistant', content: [{ type: 'text', text }] },
    },
    streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, parent),
  ];
}

/** The CLI's OWN turn that hands the notification to the model — measured right after `task_notification`. */
const cliOwnTurn: unknown[] = [
  { type: 'system', subtype: 'init', session_id: 'sdk-f1-492', uuid: 'u-4' },
  { type: 'system', subtype: 'status', status: 'requesting', session_id: 'sdk-f1-492', uuid: 'u-5' },
  ...streamedReply('msg_cli_own', 'F1492-BG-REPLY'),
  resultMessage(),
];

async function runTurn(agent: InstanceType<typeof ClaudeAgent>, message: string): Promise<AgentEvent[]> {
  const chatImpl = (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<AgentEvent> }).chatImpl.bind(agent);
  const events: AgentEvent[] = [];
  for await (const event of chatImpl(message)) events.push(event);
  return events;
}

/**
 * A turn that starts one background task and ends; `after` arrives only once the test calls `go()`, so it is
 * routed with the turn's slot already closed — the measured order, made deterministic.
 */
function backgroundTurnThen(after: unknown[]): { go(): void; drained: Promise<void> } {
  let release!: () => void;
  let open!: () => void;
  const drained = new Promise<void>(resolve => { release = resolve; });
  const gate = new Promise<void>(resolve => { open = resolve; });
  scripts.push(async function* turnThenBetween() {
    yield tasksRunning;
    yield resultMessage();
    await gate;
    for (const message of after) yield message;
    release();
  });
  return { go: () => open(), drained };
}

let counter = 0;
let liveAgent: InstanceType<typeof ClaudeAgent> | null = null;

beforeEach(() => {
  scripts.length = 0;
});

afterEach(() => {
  liveAgent?.destroy();
  liveAgent = null;
});

function freshAgent(sink?: (event: AgentEvent) => void): InstanceType<typeof ClaudeAgent> & { backgroundWorkCount(): number } {
  counter += 1;
  liveAgent = new ClaudeAgent(agentConfig(`session-f1-492-${counter}`, sink));
  return liveAgent as InstanceType<typeof ClaudeAgent> & { backgroundWorkCount(): number };
}

/** The reader is detached; one macrotask after the script released lets its last `routeLiveMessage` settle. */
async function settle(drained: Promise<void>): Promise<void> {
  await drained;
  await new Promise(resolve => setTimeout(resolve, 20));
}

describe('F1.492 — a background task that ends between turns', () => {
  it('its terminal state and the emptied level reach the host sink, and the level stops counting it', async () => {
    const sunk: AgentEvent[] = [];
    const agent = freshAgent(event => sunk.push(event));
    const between = backgroundTurnThen([tasksNone, taskCompleted]);

    await runTurn(agent, 'start a background subagent');
    expect(agent.backgroundWorkCount()).toBe(1);
    expect(agent.isProcessing()).toBe(false);
    between.go();
    await settle(between.drained);

    // THE DEFECT, arm 1: `backgroundWorkCount()` stayed 1 — the emptied level was dropped with the turn closed.
    expect(agent.backgroundWorkCount()).toBe(0);
    // THE DEFECT, arm 2: nothing reached the host, so the row never reached a terminal state.
    const completed = sunk.filter(event => event.type === 'task_completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ type: 'task_completed', taskId: TASK_ID, status: 'completed', summary: 'probe bg finished' });
    const rows = sunk.filter(event => event.type === 'background_tasks_replaced');
    expect(rows).toHaveLength(1);
    expect((rows[0] as Extract<AgentEvent, { type: 'background_tasks_replaced' }>).tasks).toEqual([]);
  });

  it('the CLI\'s OWN delivery turn after it crosses as its WORDS only — never its complete, status or usage', async () => {
    const sunk: AgentEvent[] = [];
    const agent = freshAgent(event => sunk.push(event));
    const between = backgroundTurnThen([tasksNone, taskCompleted, ...cliOwnTurn]);

    await runTurn(agent, 'start a background subagent');
    between.go();
    await settle(between.drained);

    // THE DEFECT, arm 3: the reply the model gave to `<task-notification>` reached no transcript.
    const words = sunk.filter(event => event.type === 'text_complete') as Array<Extract<AgentEvent, { type: 'text_complete' }>>;
    expect(words.map(event => ({ text: event.text, isIntermediate: event.isIntermediate, turnId: event.turnId }))).toEqual([
      { text: 'F1492-BG-REPLY', isIntermediate: false, turnId: 'msg_cli_own' },
    ]);
    // THE WHITELIST: a `complete` on the host's door parks terminal state onto its NEXT turn; status and usage
    // are a turn's chrome. Exactly the task events and the words cross.
    expect(sunk.map(event => event.type).sort()).toEqual(['background_tasks_replaced', 'task_completed', 'text_complete']);
    expect(agent.isProcessing()).toBe(false);
  });

  it('BOUNDARY — a background subagent\'s OWN words between turns do not cross (only the main thread\'s do)', async () => {
    const sunk: AgentEvent[] = [];
    const agent = freshAgent(event => sunk.push(event));
    const between = backgroundTurnThen([...streamedReply('msg_sub', 'F1492-SUB-DONE', 'toolu_f1492_agent'), tasksNone, taskCompleted]);

    await runTurn(agent, 'start a background subagent');
    between.go();
    await settle(between.drained);

    expect(sunk.some(event => event.type === 'text_complete')).toBe(false);
    expect(sunk.map(event => event.type).sort()).toEqual(['background_tasks_replaced', 'task_completed']);
  });

  it('with NO host sink the level still stops counting the finished task (the reaper reads it, not the host)', async () => {
    const agent = freshAgent();
    const between = backgroundTurnThen([tasksNone, taskCompleted]);

    await runTurn(agent, 'start a background subagent');
    expect(agent.backgroundWorkCount()).toBe(1);
    between.go();
    await settle(between.drained);

    expect(agent.backgroundWorkCount()).toBe(0);
  });

  it('CONTROL — the same two messages INSIDE a turn ride the turn, and the sink hears nothing (no double report)', async () => {
    const sunk: AgentEvent[] = [];
    const agent = freshAgent(event => sunk.push(event));
    scripts.push(async function* inTurn() {
      yield tasksRunning;
      yield tasksNone;
      yield taskCompleted;
      yield resultMessage();
    });

    const events = await runTurn(agent, 'start and finish a background subagent');

    expect(events.some(event => event.type === 'task_completed' && event.taskId === TASK_ID)).toBe(true);
    expect(sunk).toEqual([]);
    expect(agent.backgroundWorkCount()).toBe(0);
  });
});

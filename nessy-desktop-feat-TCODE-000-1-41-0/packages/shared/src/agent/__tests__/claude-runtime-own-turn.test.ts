/**
 * F1.509 (origin WJ-af P-WJ-af-1) — the claude child runs turns it opened ITSELF, and the host must be able to ask.
 *
 * ## What was measured before this row (vendored `claude` 2.1.251, driven through `ClaudeAgent`)
 *
 * When a background subagent ends between turns, the CLI opens a turn of its own (`system/init` … `assistant` …
 * `result`) to hand the model `<task-notification>` — F1.492's class 2. `isProcessing()` is slot-based, so it
 * answers `false` throughout that turn, and so does everything the host reads. WJ-af replayed a host message
 * written into the live input 50 ms into that turn: the boundaries slipped by one — the message's slot received
 * the CLI turn's reply and closed on ITS `result`, the message itself was answered in a turn no slot watched, and
 * the NEXT message was shown that answer while its own was dropped.
 *
 * ## What this file pins
 *
 * `ClaudeAgent.runtimeOwnTurnSettled()` answers `null` when the child is not running a turn it opened itself, and
 * otherwise a promise that settles when that turn's `result` arrives — or when the child dies under it, so a host
 * waiting on it can never wait forever. The host half (the real `sendMessage` queues on it and replays when it
 * settles) is `server-core`'s `runtime-own-turn-queue.test.ts`.
 *
 * The rig is `claude-between-turns-task-events.test.ts`'s: the SDK's `query` is faked, everything under it is the
 * real `ClaudeAgent` reader, adapter and slot.
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

const WORKSPACE_ROOT = '/tmp/nessy-f1-509';

function agentConfig(sessionId: string): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f1-509',
      name: 'F1.509',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: { id: sessionId, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: WORKSPACE_ROOT } as never,
    onBetweenTurnsEvent: () => {},
  } as BackendConfig;
}

type OwnTurnAgent = InstanceType<typeof ClaudeAgent> & { runtimeOwnTurnSettled?: () => Promise<void> | null };

/** The CLI's own turn as the vendored 2.1.251 sent it (the rig's `route` log): init, status, the reply, result. */
const ownTurnHead: unknown[] = [
  { type: 'system', subtype: 'init', session_id: 'sdk-f1-509', uuid: 'u-init' },
  { type: 'system', subtype: 'status', status: 'requesting', session_id: 'sdk-f1-509', uuid: 'u-status' },
  {
    type: 'assistant', parent_tool_use_id: null, session_id: 'sdk-f1-509', uuid: 'a-own',
    message: { id: 'msg_cli_own', role: 'assistant', content: [{ type: 'text', text: 'F1509-CLI-OWN-REPLY' }] },
  },
];

async function runTurn(agent: OwnTurnAgent, message: string): Promise<AgentEvent[]> {
  const chatImpl = (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<AgentEvent> }).chatImpl.bind(agent);
  const events: AgentEvent[] = [];
  for await (const event of chatImpl(message)) events.push(event);
  return events;
}

/**
 * Turn 1 ends; then, on `startOwn()`, the child opens a turn of its own and pauses before its `result`, which
 * arrives on `endOwn()`. `inTurn` records what the agent answered WHILE the host's own turn 1 was running.
 */
function turnThenOwnTurn(agent: () => OwnTurnAgent): {
  startOwn(): void; endOwn(): void; headRouted: Promise<void>; drained: Promise<void>; inTurn: Array<unknown>;
} {
  let openStart!: () => void;
  let openEnd!: () => void;
  let headDone!: () => void;
  let release!: () => void;
  const start = new Promise<void>(resolve => { openStart = resolve; });
  const end = new Promise<void>(resolve => { openEnd = resolve; });
  const headRouted = new Promise<void>(resolve => { headDone = resolve; });
  const drained = new Promise<void>(resolve => { release = resolve; });
  const inTurn: unknown[] = [];
  scripts.push(async function* turnThenOwn() {
    yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-509', uuid: 'u-host-init' };
    inTurn.push(agent().runtimeOwnTurnSettled?.() ?? null);
    yield resultMessage();
    await start;
    for (const message of ownTurnHead) yield message;
    headDone();
    await end;
    yield resultMessage();
    release();
  });
  return { startOwn: () => openStart(), endOwn: () => openEnd(), headRouted, drained, inTurn };
}

/** The reader is detached; one macrotask after a release lets its last `routeLiveMessage` settle. */
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

let counter = 0;
let liveAgent: OwnTurnAgent | null = null;

beforeEach(() => {
  scripts.length = 0;
});

afterEach(() => {
  liveAgent?.destroy();
  liveAgent = null;
});

function freshAgent(): OwnTurnAgent {
  counter += 1;
  liveAgent = new ClaudeAgent(agentConfig(`session-f1-509-${counter}`)) as OwnTurnAgent;
  return liveAgent;
}

describe('F1.509 — the host can ask whether the claude child is running a turn it opened itself', () => {
  it('answers a pending promise from the own turn\'s init, and settles it on the own turn\'s result', async () => {
    const agent = freshAgent();
    const own = turnThenOwnTurn(() => agent);

    await runTurn(agent, 'start a background subagent');
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeNull();

    own.startOwn();
    await own.headRouted;
    await tick();
    // THE DEFECT: nothing the host reads says a turn is running — isProcessing() is slot-based.
    expect(agent.isProcessing()).toBe(false);
    const running = agent.runtimeOwnTurnSettled?.() ?? null;
    expect(running).toBeInstanceOf(Promise);
    let settled = false;
    void running?.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);

    own.endOwn();
    await own.drained;
    await tick();
    expect(settled).toBe(true);
    expect(agent.runtimeOwnTurnSettled?.()).toBeNull();
  });

  it('the child dying under its own turn settles the promise too — a host waiting on it never waits forever', async () => {
    const agent = freshAgent();
    const own = turnThenOwnTurn(() => agent);

    await runTurn(agent, 'start a background subagent');
    own.startOwn();
    await own.headRouted;
    await tick();
    const running = agent.runtimeOwnTurnSettled?.() ?? null;
    expect(running).toBeInstanceOf(Promise);

    agent.destroy();
    liveAgent = null;
    const outcome = await Promise.race([running!.then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('pending'), 500))]);
    expect(outcome).toBe('settled');
    expect(agent.runtimeOwnTurnSettled?.()).toBeNull();
  });

  it('CONTROL — the init of a turn the HOST opened is not the child\'s own: null throughout the host\'s turn', async () => {
    const agent = freshAgent();
    const own = turnThenOwnTurn(() => agent);

    await runTurn(agent, 'an ordinary turn');

    // Recorded inside the script, right after the host turn's own init was routed into its open slot.
    expect(own.inTurn).toEqual([null]);
    expect(agent.runtimeOwnTurnSettled?.()).toBeNull();
    // And the method exists: a missing method would make every `null` above vacuous.
    expect(typeof agent.runtimeOwnTurnSettled).toBe('function');
  });
});

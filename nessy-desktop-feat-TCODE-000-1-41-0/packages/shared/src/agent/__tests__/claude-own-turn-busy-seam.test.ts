/**
 * F1.524 (2) (origin WJ-am P-WJ-am-2) — the claude agent's half of the host busy seam for a turn the child opened
 * ITSELF: the host is told when that turn runs and when it ends, and a Stop can reach it.
 *
 * ## Why
 *
 * While the CLI answers a background task's end on its own, nothing the host reads says a turn is running: the
 * session looked idle, and a send is queued behind a turn the user cannot see (F1.509). Worse since F1.511: that
 * turn's `tool_start` crosses the between-turns door, the renderer's D1.379 rule raises `isProcessing` on it, and
 * nothing ever lowers it — a spinner and a Stop that outlive the turn, where `SessionManager.cancelProcessing` returns
 * at once because the host holds no turn. The host half (the renderer told, and a Stop that interrupts this turn)
 * lives in server-core; this file pins what the agent owes it.
 *
 * ## What this file pins
 *
 * (a) `onRuntimeOwnTurn` hears `running` at the own turn's `init` and `ended` at its `result`, once each.
 * (b) An own turn that ends by the child's death is `ended` too; an EXPECTED turn that never started (F1.524 (1)'s
 *     start bound released it) reports nothing at all.
 * (c) `interruptRuntimeOwnTurn()` sends `Query.interrupt()` while the own turn runs, and refuses (sends nothing) with no
 *     own turn, and while a host slot is open — a Stop there belongs to the host turn's own path.
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
let interrupts = 0;

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
    stream.interrupt = async () => { interrupts += 1; return { still_queued: [] }; };
    return stream;
  },
}));

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
});

const { ClaudeAgent } = await import('../claude-agent.ts');

const WORKSPACE_ROOT = '/tmp/nessy-f1-524-2';

function agentConfig(sessionId: string): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f1-524-2',
      name: 'F1.524',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: { id: sessionId, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: WORKSPACE_ROOT } as never,
    onBetweenTurnsEvent: () => {},
  } as BackendConfig;
}

type SeamAgent = InstanceType<typeof ClaudeAgent> & {
  onRuntimeOwnTurn?: (phase: 'running' | 'ended') => void;
  interruptRuntimeOwnTurn?: () => boolean;
  runtimeOwnTurnSettled?: () => Promise<void> | null;
};

/**
 * Turn 1 ends; on `startOwn()` the child opens a turn of its own (init) and pauses; `endOwn()` yields its result —
 * or, with `crash`, fails the stream. With `expectOnly`, only a `task_notification` arrives and no turn follows.
 */
function turnThenOwnTurn(options: { crash?: boolean; expectOnly?: boolean } = {}): {
  startOwn(): void; endOwn(): void; headRouted: Promise<void>;
} {
  let openStart!: () => void;
  let openEnd!: () => void;
  let headDone!: () => void;
  const start = new Promise<void>(resolve => { openStart = resolve; });
  const end = new Promise<void>(resolve => { openEnd = resolve; });
  const headRouted = new Promise<void>(resolve => { headDone = resolve; });
  scripts.push(async function* turnThenOwn() {
    yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-524-2', uuid: 'u-host-init' };
    yield resultMessage();
    await start;
    if (options.expectOnly) {
      yield { type: 'system', subtype: 'task_notification', task_id: 't-f1524-2', status: 'completed', session_id: 'sdk-f1-524-2', uuid: 'n-1' };
      headDone();
      await end;
      return;
    }
    yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-524-2', uuid: 'u-own-init' };
    headDone();
    await end;
    if (options.crash) throw new Error('F1524-2 the child died under its own turn');
    yield resultMessage();
  });
  return { startOwn: () => openStart(), endOwn: () => openEnd(), headRouted };
}

async function runTurn(agent: SeamAgent, message: string): Promise<AgentEvent[]> {
  const chatImpl = (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<AgentEvent> }).chatImpl.bind(agent);
  const events: AgentEvent[] = [];
  for await (const event of chatImpl(message)) events.push(event);
  return events;
}

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

let counter = 0;
let liveAgent: SeamAgent | null = null;

beforeEach(() => {
  scripts.length = 0;
  interrupts = 0;
});

afterEach(() => {
  liveAgent?.destroy();
  liveAgent = null;
});

function freshAgent(): { agent: SeamAgent; phases: string[] } {
  counter += 1;
  liveAgent = new ClaudeAgent(agentConfig(`session-f1-524-2-${counter}`)) as SeamAgent;
  // The fixture's runtime is asserted rather than assumed (AGENTS.md, the 2026-09-20 fixture trap).
  expect(liveAgent).toBeInstanceOf(ClaudeAgent);
  const phases: string[] = [];
  liveAgent.onRuntimeOwnTurn = phase => { phases.push(phase); };
  return { agent: liveAgent, phases };
}

describe('F1.524 (2) — the agent tells its host when its own turn runs, and lets a Stop reach it', () => {
  it('(a) running at the own turn\'s init, ended at its result, once each', async () => {
    const { agent, phases } = freshAgent();
    const own = turnThenOwnTurn();
    await runTurn(agent, 'start a background subagent');
    // A host turn's own init and result are not the child's own: nothing is reported for them.
    expect(phases).toEqual([]);

    own.startOwn();
    await own.headRouted;
    await tick();
    expect(phases).toEqual(['running']);
    own.endOwn();
    await tick(100);
    expect(phases).toEqual(['running', 'ended']);
  });

  it('(b) the child dying under its own turn is an end too; an expected turn that never started reports nothing', async () => {
    const died = freshAgent();
    const own = turnThenOwnTurn({ crash: true });
    await runTurn(died.agent, 'start a background subagent');
    own.startOwn();
    await own.headRouted;
    await tick();
    own.endOwn();
    await tick(100);
    expect(died.phases).toEqual(['running', 'ended']);
    died.agent.destroy();
    liveAgent = null;

    const expected = freshAgent();
    (expected.agent as unknown as { runtimeOwnTurnStartBoundMs: number }).runtimeOwnTurnStartBoundMs = 80;
    const quiet = turnThenOwnTurn({ expectOnly: true });
    await runTurn(expected.agent, 'start a background subagent');
    quiet.startOwn();
    await quiet.headRouted;
    await tick(250);
    expect(expected.agent.runtimeOwnTurnSettled?.() ?? null).toBeNull();
    expect(expected.phases).toEqual([]);
    quiet.endOwn();
  });

  it('(c) interruptRuntimeOwnTurn sends Query.interrupt while the own turn runs, and nothing otherwise', async () => {
    const { agent } = freshAgent();
    const own = turnThenOwnTurn();
    await runTurn(agent, 'start a background subagent');
    // No own turn: nothing to interrupt.
    expect(agent.interruptRuntimeOwnTurn?.()).toBe(false);
    expect(interrupts).toBe(0);

    own.startOwn();
    await own.headRouted;
    await tick();
    expect(agent.interruptRuntimeOwnTurn?.()).toBe(true);
    await tick();
    expect(interrupts).toBe(1);
    own.endOwn();
    await tick(100);
    expect(agent.interruptRuntimeOwnTurn?.()).toBe(false);
    expect(interrupts).toBe(1);
  });

  it('CONTROL — with a host slot open the own-turn interrupt refuses: a Stop there is the host turn\'s', async () => {
    const { agent } = freshAgent();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let opened!: () => void;
    const inTurn = new Promise<void>(resolve => { opened = resolve; });
    scripts.push(async function* held() {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-524-2', uuid: 'u-held-init' };
      opened();
      await gate;
      yield resultMessage();
    });
    const turn = runTurn(agent, 'a host turn');
    await inTurn;
    await tick();
    expect(agent.isProcessing()).toBe(true);
    expect(agent.interruptRuntimeOwnTurn?.()).toBe(false);
    expect(interrupts).toBe(0);
    release();
    await turn;
  });
});

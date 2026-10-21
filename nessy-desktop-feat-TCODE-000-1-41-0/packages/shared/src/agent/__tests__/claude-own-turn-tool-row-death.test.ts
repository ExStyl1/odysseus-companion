/**
 * F1.524 (3) (origin WJ-am P-WJ-am-3) — a tool row the claude child opened in a turn of ITS OWN must end when the
 * child dies under it.
 *
 * ## The defect
 *
 * F1.511 hands the host the tool rows of the turn the CLI opens itself between host turns (`tool_start`, then the
 * guarded `tool_result`, through the between-turns door), and it ends a row whose result the guard cannot handle. A
 * child that dies BETWEEN the two — the stream fails, or the host tears the session down — sent the `tool_start` and
 * never the `tool_result`. In a host turn that row is swept by the turn's own end; between turns there is no turn end
 * to sweep it, so the host kept it `executing` for good.
 *
 * ## What this file pins
 *
 * (a) The child's stream failing mid-tool ends the row: the door hears an ERROR `tool_result` for that call's id.
 * (b) The host tearing the session down mid-tool (`forceAbort` with a killing reason) ends it the same way.
 * CONTROL: a row the child ended itself is ended ONCE — a later death sends nothing more for it.
 *
 * The rig is `claude-between-turns-tool-calls.test.ts`'s: the SDK's `query` is faked, everything under it is the
 * real `ClaudeAgent` reader, adapter and between-turns door.
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

const WORKSPACE_ROOT = '/tmp/nessy-f1-524';
const TOOL_ID = 'toolu_f1524_own_read';

const door: AgentEvent[] = [];

function agentConfig(sessionId: string): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f1-524',
      name: 'F1.524',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: { id: sessionId, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: WORKSPACE_ROOT } as never,
    onBetweenTurnsEvent: (event: AgentEvent) => { door.push(event); },
  } as BackendConfig;
}

const toolUse: unknown = {
  type: 'assistant', parent_tool_use_id: null, session_id: 'sdk-f1-524', uuid: 'a-own-tool',
  message: { id: 'msg_own_tool', role: 'assistant', content: [{ type: 'tool_use', id: TOOL_ID, name: 'Read', input: { file_path: '/tmp/f1524/note.txt' } }] },
};
const toolResult: unknown = {
  type: 'user', parent_tool_use_id: null, session_id: 'sdk-f1-524', uuid: 'u-own-tool-result',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: TOOL_ID, content: 'F1524 note line' }] },
};

/**
 * Turn 1 ends; on `startOwn()` the child opens its own turn and calls a tool (the door hears `tool_start`); then, on
 * `endOwn()`, the stream FAILS there (`crash`), or — with `finish` — the tool's result and the turn's `result` arrive
 * and the script waits on `crashLater()` before failing the stream anyway.
 */
function ownTurnWithTool(options: { finish?: boolean } = {}): {
  startOwn(): void; endOwn(): void; crashLater(): void; toolStarted: Promise<void>; finished: Promise<void>;
} {
  let openStart!: () => void;
  let openEnd!: () => void;
  let openCrash!: () => void;
  let started!: () => void;
  let done!: () => void;
  const start = new Promise<void>(resolve => { openStart = resolve; });
  const end = new Promise<void>(resolve => { openEnd = resolve; });
  const crash = new Promise<void>(resolve => { openCrash = resolve; });
  const toolStarted = new Promise<void>(resolve => { started = resolve; });
  const finished = new Promise<void>(resolve => { done = resolve; });
  scripts.push(async function* turnThenOwn() {
    yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-524', uuid: 'u-host-init' };
    yield resultMessage();
    await start;
    yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-524', uuid: 'u-own-init' };
    yield toolUse;
    started();
    await end;
    if (options.finish) {
      yield toolResult;
      yield resultMessage();
      done();
      await crash;
    }
    throw new Error('F1524 the child died mid-tool');
  });
  return { startOwn: () => openStart(), endOwn: () => openEnd(), crashLater: () => openCrash(), toolStarted, finished };
}

async function runTurn(agent: InstanceType<typeof ClaudeAgent>, message: string): Promise<AgentEvent[]> {
  const chatImpl = (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<AgentEvent> }).chatImpl.bind(agent);
  const events: AgentEvent[] = [];
  for await (const event of chatImpl(message)) events.push(event);
  return events;
}

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const resultsFor = (id: string) =>
  door.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.toolUseId === id);

let counter = 0;
let liveAgent: InstanceType<typeof ClaudeAgent> | null = null;

beforeEach(() => {
  scripts.length = 0;
  door.length = 0;
});

afterEach(() => {
  liveAgent?.destroy();
  liveAgent = null;
});

function freshAgent(): InstanceType<typeof ClaudeAgent> {
  counter += 1;
  liveAgent = new ClaudeAgent(agentConfig(`session-f1-524-${counter}`));
  // The fixture's runtime is asserted rather than assumed (AGENTS.md, the 2026-09-20 fixture trap).
  expect(liveAgent).toBeInstanceOf(ClaudeAgent);
  return liveAgent;
}

async function toolRowOpen(agent: InstanceType<typeof ClaudeAgent>, own: ReturnType<typeof ownTurnWithTool>): Promise<void> {
  await runTurn(agent, 'start a background subagent');
  own.startOwn();
  await own.toolStarted;
  await tick();
  // The precondition: the door carried the row's start, and nothing has ended it.
  expect(door.some(e => e.type === 'tool_start' && (e as { toolUseId?: string }).toolUseId === TOOL_ID)).toBe(true);
  expect(resultsFor(TOOL_ID)).toEqual([]);
}

describe('F1.524 (3) — a between-turns tool row ends when its child dies', () => {
  it('(a) the child\'s stream failing mid-tool ends the row with an error result', async () => {
    const agent = freshAgent();
    const own = ownTurnWithTool();
    await toolRowOpen(agent, own);

    own.endOwn();
    await tick(100);
    const ended = resultsFor(TOOL_ID);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.isError).toBe(true);
    expect(ended[0]!.toolName).toBe('Read');
    expect(ended[0]!.result).toContain('ended before this tool call finished');
  });

  it('(b) the host tearing the session down mid-tool ends the row the same way', async () => {
    const agent = freshAgent();
    const own = ownTurnWithTool();
    await toolRowOpen(agent, own);

    agent.forceAbort(AbortReason.InternalError);
    await tick(100);
    const ended = resultsFor(TOOL_ID);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.isError).toBe(true);
  });

  it('CONTROL — a row the child ended itself is ended once; a later death sends nothing more for it', async () => {
    const agent = freshAgent();
    const own = ownTurnWithTool({ finish: true });
    await toolRowOpen(agent, own);

    own.endOwn();
    await own.finished;
    await tick();
    expect(resultsFor(TOOL_ID).map(e => e.isError)).toEqual([false]);

    own.crashLater();
    await tick(100);
    expect(resultsFor(TOOL_ID).map(e => e.isError)).toEqual([false]);
  });
});

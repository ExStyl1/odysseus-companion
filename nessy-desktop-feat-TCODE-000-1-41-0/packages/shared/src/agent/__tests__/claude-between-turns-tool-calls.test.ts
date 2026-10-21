/**
 * F1.511 (origin WJ-af P-WJ-af-3) — the tool calls of a turn the claude CLI opens ITSELF reach the host, with the
 * large-result guard applied there too.
 *
 * ## Before this row
 *
 * F1.492 admitted the CLI's own between-turns turn (the one that hands the model `<task-notification>`) to the
 * host's door as its WORDS only (`ClaudeAgent.noteBetweenTurnsMessage`, class 2). Its tool rows were kept out for a
 * stated reason: the large-result guard (`guardLargeResult`) ran only on the slot's path, so a between-turns
 * `tool_result` would have reached the transcript unguarded — a binary or oversized payload written as text — and a
 * `tool_start` without its result would be a row that never ends. So a model that read or edited files while
 * answering a background notification did it where the user saw only its words.
 *
 * ## What this file pins
 *
 * The guard needs nothing that lives only on the slot: its session directory is the one the last turn used, and
 * the rest (the summarizer, the context window, the MCP allowance) are the agent's. So the main thread's tool pair
 * crosses between turns — `tool_start`, and a `tool_result` through the SAME guard call a host turn makes — and a
 * guard that throws there still ends the row, with the reason in place of the result, instead of taking down the
 * session's one reader.
 *
 * The rig is `claude-between-turns-task-events.test.ts`'s (the SDK's `query` faked, everything under it real), plus
 * a spread-and-restored stub of `utils/large-response.ts` that can be told to throw once.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import * as largeResponse from '../../utils/large-response.ts';

const realSdk = { ...sdkPackage };
const realLargeResponse = { ...largeResponse };

const scripts: Array<() => AsyncGenerator<unknown>> = [];
let guardThrowsNext = false;

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

mock.module('../../utils/large-response.ts', () => ({
  ...realLargeResponse,
  guardLargeResult: async (...args: Parameters<typeof largeResponse.guardLargeResult>) => {
    if (guardThrowsNext) {
      guardThrowsNext = false;
      throw new Error('F1511-GUARD-FAILED');
    }
    return realLargeResponse.guardLargeResult(...args);
  },
}));

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
  mock.module('../../utils/large-response.ts', () => realLargeResponse);
});

const { ClaudeAgent } = await import('../claude-agent.ts');

const WORKSPACE_ROOT = '/tmp/nessy-f1-511';
const TOOL_ID = 'toolu_f1511_read';
/** A result the guard must intercept: one NUL byte makes it binary (`looksLikeBinary`). Built at run time. */
const BINARY_RESULT = `PNG-ish header${String.fromCharCode(0)}rest of the bytes`;

function agentConfig(sessionId: string, sink?: (event: AgentEvent) => void): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f1-511',
      name: 'F1.511',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: { id: sessionId, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: WORKSPACE_ROOT } as never,
    ...(sink ? { onBetweenTurnsEvent: sink } : {}),
  } as BackendConfig;
}

/** One tool call as the CLI reports it: the assistant's `tool_use`, then the `user` message carrying its result. */
function toolPair(result: string, parent: string | null = null, id = TOOL_ID): unknown[] {
  return [
    {
      type: 'assistant', parent_tool_use_id: parent, session_id: 'sdk-f1-511', uuid: `a-${id}`,
      message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/tmp/f1511/image.png' } }] },
    },
    {
      type: 'user', parent_tool_use_id: parent, session_id: 'sdk-f1-511', uuid: `u-${id}`,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] },
    },
  ];
}

function streamEvent(event: unknown): unknown {
  return { type: 'stream_event', event, parent_tool_use_id: null, session_id: 'sdk-f1-511', uuid: `s-${Math.random()}` };
}

/** The CLI's own turn: init, one tool call, its words (streamed, as `includePartialMessages` sends them), result. */
function ownTurn(pair: unknown[]): unknown[] {
  return [
    { type: 'system', subtype: 'init', session_id: 'sdk-f1-511', uuid: 'u-init' },
    ...pair,
    streamEvent({ type: 'message_start', message: { id: 'msg_words', role: 'assistant', content: [] } }),
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'F1511-DONE' } }),
    {
      type: 'assistant', parent_tool_use_id: null, session_id: 'sdk-f1-511', uuid: 'a-words',
      message: { id: 'msg_words', role: 'assistant', content: [{ type: 'text', text: 'F1511-DONE' }] },
    },
    streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
    resultMessage(),
  ];
}

async function runTurn(agent: InstanceType<typeof ClaudeAgent>, message: string): Promise<AgentEvent[]> {
  const chatImpl = (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<AgentEvent> }).chatImpl.bind(agent);
  const events: AgentEvent[] = [];
  for await (const event of chatImpl(message)) events.push(event);
  return events;
}

/** Turn 1 ends; `after` is routed with no slot open once `go()` is called. */
function turnThen(after: unknown[]): { go(): void; drained: Promise<void> } {
  let release!: () => void;
  let open!: () => void;
  const drained = new Promise<void>(resolve => { release = resolve; });
  const gate = new Promise<void>(resolve => { open = resolve; });
  scripts.push(async function* turnThenBetween() {
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
  guardThrowsNext = false;
});

afterEach(() => {
  liveAgent?.destroy();
  liveAgent = null;
});

function freshAgent(sink?: (event: AgentEvent) => void): InstanceType<typeof ClaudeAgent> {
  counter += 1;
  liveAgent = new ClaudeAgent(agentConfig(`session-f1-511-${counter}`, sink));
  return liveAgent;
}

async function settle(drained: Promise<void>): Promise<void> {
  await drained;
  await new Promise(resolve => setTimeout(resolve, 20));
}

type ToolResult = Extract<AgentEvent, { type: 'tool_result' }>;

describe('F1.511 — a tool call in the CLI\'s own between-turns turn reaches the host', () => {
  it('its row starts and ends at the host door, and a binary result is GUARDED there as it is in a host turn', async () => {
    const sunk: AgentEvent[] = [];
    const agent = freshAgent(event => sunk.push(event));
    const between = turnThen(ownTurn(toolPair(BINARY_RESULT)));

    await runTurn(agent, 'start a background subagent');
    between.go();
    await settle(between.drained);

    const starts = sunk.filter(event => event.type === 'tool_start');
    expect(starts.map(event => (event as { toolUseId: string }).toolUseId)).toEqual([TOOL_ID]);
    const results = sunk.filter(event => event.type === 'tool_result') as ToolResult[];
    expect(results.map(event => event.toolUseId)).toEqual([TOOL_ID]);
    // The guard ran: the NUL-bearing payload became the saved-file notice, not transcript text.
    expect(String(results[0]!.result)).toStartWith('[Binary content detected');
    expect(String(results[0]!.result)).not.toContain(String.fromCharCode(0));
    // The words still cross, after the row; nothing else of the turn does.
    expect(sunk.map(event => event.type)).toEqual(['tool_start', 'tool_result', 'text_complete']);
  });

  it('a small text result crosses as it is (the guard intercepts nothing)', async () => {
    const sunk: AgentEvent[] = [];
    const agent = freshAgent(event => sunk.push(event));
    const between = turnThen(ownTurn(toolPair('line 1 of the file')));

    await runTurn(agent, 'start a background subagent');
    between.go();
    await settle(between.drained);

    const results = sunk.filter(event => event.type === 'tool_result') as ToolResult[];
    expect(results.map(event => String(event.result))).toEqual(['line 1 of the file']);
  });

  it('a guard that THROWS between turns still ends the row, with the reason in place of the result', async () => {
    const sunk: AgentEvent[] = [];
    const agent = freshAgent(event => sunk.push(event));
    const between = turnThen(ownTurn(toolPair(BINARY_RESULT)));

    await runTurn(agent, 'start a background subagent');
    guardThrowsNext = true;
    between.go();
    await settle(between.drained);

    const results = sunk.filter(event => event.type === 'tool_result') as ToolResult[];
    expect(results).toHaveLength(1);
    expect(String(results[0]!.result)).toContain('F1511-GUARD-FAILED');
    expect(String(results[0]!.result)).not.toContain(String.fromCharCode(0));
    // The reader survived: the turn's words still arrived after the failure.
    expect(sunk.some(event => event.type === 'text_complete')).toBe(true);
  });

  it('BOUNDARY — a background subagent\'s own tool pair between turns stays out (only the main thread\'s crosses)', async () => {
    const sunk: AgentEvent[] = [];
    const agent = freshAgent(event => sunk.push(event));
    const between = turnThen(toolPair('subagent read', 'toolu_f1511_agent', 'toolu_f1511_sub_read'));

    await runTurn(agent, 'start a background subagent');
    between.go();
    await settle(between.drained);

    expect(sunk.filter(event => event.type === 'tool_start' || event.type === 'tool_result')).toEqual([]);
  });

  it('CONTROL — the same tool pair INSIDE a host turn rides the turn, guarded the same way, and the door hears nothing', async () => {
    const sunk: AgentEvent[] = [];
    const agent = freshAgent(event => sunk.push(event));
    scripts.push(async function* inTurn() {
      for (const message of toolPair(BINARY_RESULT)) yield message;
      yield resultMessage();
    });

    const events = await runTurn(agent, 'read the image');

    const results = events.filter(event => event.type === 'tool_result') as ToolResult[];
    expect(results.map(event => event.toolUseId)).toEqual([TOOL_ID]);
    expect(String(results[0]!.result)).toStartWith('[Binary content detected');
    expect(sunk).toEqual([]);
  });
});

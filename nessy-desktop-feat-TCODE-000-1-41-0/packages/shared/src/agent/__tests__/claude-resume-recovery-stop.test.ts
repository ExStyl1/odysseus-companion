/**
 * UB2.2 (COR-2 + R14-11) — a Stop never re-runs the message, and nothing the
 * stopped turn finished is lost.
 *
 * Arms copied+adapted from craft-agents-oss v0.15.1 `claude-keepalive-stop.test.ts`
 * (Apache-2.0) onto OUR design, which has no persistent consumer to port: our
 * keep-alive is ONE reader per live session (`runLiveReader`, generation-bound)
 * feeding per-turn slots (`ClaudeTurnSlot`), so upstream's four hunks land as:
 *
 * 1. the empty-response recovery guard — a turn whose `lastAbortReason` is
 *    `user_stop`/`max_budget_usd` never clears the session id and never re-sends
 *    (upstream marks `activeTurnState.aborted`; ours keeps the reason on the agent
 *    until the stopped turn's own result, or its absence, settles the slot);
 * 2. `flushPending` at the top of the `AbortError` branch — a finished text block
 *    that was waiting for its `message_delta` is not missing after a reload;
 * 3. the consumer/slot bound to its own query — upstream's
 *    `persistentConsumerIterator` is our reader's `liveGeneration` guard, pinned
 *    here on the REAL `runLiveReader`/`routeLiveMessage`;
 * 4. Stop while the turn is being prepared yields `complete` (an interruption,
 *    not an error) — ours via `stopRequestedWhilePreparing`, HAVE, pinned.
 *
 * The leftover-isolation half (RT amendment, upstream's `stoppedTurn` filter) is
 * structural in ours: the stopped turn's slot stays open until its `result`, so
 * its tail is attributed to the stopped turn; after the settle, tail messages cross
 * the between-turns whitelist door, never the next turn's slot — pinned in the
 * third describe.
 *
 * The rig drives a REAL `chatImpl` with the SDK's `query` faked (the
 * `claude-steer-fifo.test.ts` rig).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@nessy-agent/core/types';
import { AbortReason, type BackendConfig } from '../backend/types.ts';

const realSdk = { ...sdkPackage };

const SDK_SESSION = 'sdk-session-ub2-2';

type Script = (prompt: string) => AsyncGenerator<unknown>;
const scripts: Script[] = [];
let queryCalls = 0;

function resultMessage(): unknown {
  return {
    type: 'result',
    subtype: 'success',
    result: 'ok',
    num_turns: 1,
    session_id: SDK_SESSION,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

async function* plainSuccess(): AsyncGenerator<unknown> {
  yield resultMessage();
}

/** A resumed turn that produces NO assistant content and NO result: the stream just ends. */
async function* emptyResumeTurn(): AsyncGenerator<unknown> {
  yield { type: 'assistant', message: { role: 'assistant', content: [] }, session_id: SDK_SESSION };
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    queryCalls += 1;
    if (typeof input.prompt === 'string') {
      const script = scripts.shift() ?? plainSuccess;
      return script(input.prompt);
    }
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    async function* serveTurns(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        const script = scripts.shift() ?? plainSuccess;
        yield* script('');
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

const { AbortError } = await import('@anthropic-ai/claude-agent-sdk');
const { ClaudeAgent } = await import('../claude-agent.ts');
const { ClaudeTurnSlot } = await import('../backend/claude/turn-slot.ts');

const WORKSPACE_ID = 'ws-ub2-2';
const WORKSPACE_ROOT = '/tmp/nessy-ub2-2';

function agentConfig(sessionId: string): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: WORKSPACE_ID,
      name: 'UB2.2',
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
  } as BackendConfig;
}

let counter = 0;
let liveAgent: InstanceType<typeof ClaudeAgent> | null = null;

beforeEach(() => {
  scripts.length = 0;
  queryCalls = 0;
});

afterEach(() => {
  liveAgent?.destroy();
  liveAgent = null;
});

function freshAgent(): InstanceType<typeof ClaudeAgent> {
  counter += 1;
  liveAgent = new ClaudeAgent(agentConfig(`session-ub2-2-${counter}`));
  return liveAgent;
}

async function runTurn(agent: InstanceType<typeof ClaudeAgent>, message: string): Promise<AgentEvent[]> {
  const chatImpl = (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<AgentEvent> }).chatImpl.bind(agent);
  const events: AgentEvent[] = [];
  for await (const event of chatImpl(message)) events.push(event);
  return events;
}

describe('UB2.2 — the empty-response recovery never re-runs a stopped message', () => {
  it('a user-stopped resumed turn with no result keeps the session id and does not re-send', async () => {
    const agent = freshAgent();
    scripts.push(plainSuccess); // turn 1: a clean turn establishes the session (wasResuming for turn 2)
    scripts.push(async function* stoppedResumeTurn() {
      // The user presses Stop; the child wedges and never answers with a result.
      (agent as unknown as { interruptLiveTurn(reason: AbortReason): void }).interruptLiveTurn(AbortReason.UserStop);
      yield { type: 'assistant', message: { role: 'assistant', content: [] }, session_id: SDK_SESSION };
      // No result, and the child dies: stdin EOF ends the fake query, the reader
      // exits, and the open slot closes 'session-ended'.
      (agent as unknown as { liveInput: { end(): void } | null }).liveInput?.end();
    });

    const events = await runTurn(agent, 'first');
    expect(events.map(e => e.type)).toContain('complete');
    const second = await runTurn(agent, 'the message the user stopped');

    // THE DEFECT: the recovery cleared the session id and re-sent the message.
    expect(second.map(e => e.type)).not.toContain('info'); // no 'Restoring conversation context...'
    expect(queryCalls).toBe(1); // no respawn, so no nested retry turn was served
    expect((agent as unknown as { sessionId: string | null }).sessionId).toBe(SDK_SESSION); // not cleared
    expect(second.filter(e => e.type === 'complete')).toHaveLength(1);
  });

  it('a budget-stopped resumed turn is guarded the same way', async () => {
    const agent = freshAgent();
    scripts.push(plainSuccess);
    scripts.push(async function* budgetStoppedResumeTurn() {
      (agent as unknown as { interruptLiveTurn(reason: AbortReason): void }).interruptLiveTurn(AbortReason.MaxBudgetUsd);
      yield { type: 'assistant', message: { role: 'assistant', content: [] }, session_id: SDK_SESSION };
      (agent as unknown as { liveInput: { end(): void } | null }).liveInput?.end();
    });

    await runTurn(agent, 'first');
    const second = await runTurn(agent, 'the message the ceiling stopped');
    expect(second.map(e => e.type)).not.toContain('info');
    expect(queryCalls).toBe(1);
    expect((agent as unknown as { sessionId: string | null }).sessionId).toBe(SDK_SESSION);
  });

  it('a resumed turn with no assistant content and NO stop still recovers (positive control)', async () => {
    const agent = freshAgent();
    scripts.push(plainSuccess); // turn 1
    scripts.push(async function* emptyResumeTurnDies() {
      yield { type: 'assistant', message: { role: 'assistant', content: [] }, session_id: SDK_SESSION };
      (agent as unknown as { liveInput: { end(): void } | null }).liveInput?.end();
    }); // turn 2: empty resume, no stop — the genuine recovery case
    scripts.push(plainSuccess); // the nested retry turn

    await runTurn(agent, 'first');
    const second = await runTurn(agent, 'second');

    // The recovery ran (its first act is the info line) and cleared the session id —
    // the guard did not block a genuine recovery. The nested retry itself needs the
    // capability-turn runtime this bare config does not carry, so the respawn count
    // is not asserted here; the two stopped tests above pin the re-send absence by
    // query count instead.
    expect(second.some(e => e.type === 'info' && e.message.includes('Restoring conversation context'))).toBe(true);
    expect((agent as unknown as { sessionId: string | null }).sessionId).toBeNull();
  });
});

describe('UB2.2 — flushPending at the top of the AbortError branch', () => {
  it('a text block finished but waiting for its message_delta is emitted once as text_complete', async () => {
    const agent = freshAgent();
    scripts.push(async function* stoppedWithPendingText() {
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'the block the Stop interrupted' }] },
        session_id: SDK_SESSION,
      };
      // The assistant text is PENDING in the adapter (no message_delta arrived). The user
      // stops; the abort surfaces as AbortError through the reader's slot.fail.
      (agent as unknown as { interruptLiveTurn(reason: AbortReason): void }).interruptLiveTurn(AbortReason.UserStop);
      throw new AbortError('Claude Code process aborted by user');
    });

    const events = await runTurn(agent, 'write me an answer');

    const textCompletions = events.filter(e => e.type === 'text_complete');
    expect(textCompletions).toHaveLength(1);
    expect((textCompletions[0] as Extract<AgentEvent, { type: 'text_complete' }>).text).toBe('the block the Stop interrupted');
    // The interrupted status still follows, from the stop reason the branch reads.
    expect(events.some(e => e.type === 'status' && e.message === 'Interrupted')).toBe(true);
    expect(events.at(-1)?.type).toBe('complete');
  });

  it('with nothing pending the flush emits nothing (control)', async () => {
    const agent = freshAgent();
    scripts.push(async function* stoppedWithNoText() {
      (agent as unknown as { interruptLiveTurn(reason: AbortReason): void }).interruptLiveTurn(AbortReason.UserStop);
      throw new AbortError('Claude Code process aborted by user');
    });

    const events = await runTurn(agent, 'anything');
    expect(events.filter(e => e.type === 'text_complete')).toHaveLength(0);
    expect(events.at(-1)?.type).toBe('complete');
  });
});

describe('UB2.2 — the reader and the between-turns door bound the stopped turn', () => {
  function slotFor(agent: InstanceType<typeof ClaudeAgent>, userMessage: string): InstanceType<typeof ClaudeTurnSlot> {
    const slot = new ClaudeTurnSlot({
      userMessage,
      isRetry: false,
      wasResuming: true,
      attemptedBranchCutoff: false,
      metadataSessionDir: `${WORKSPACE_ROOT}/sessions`,
    });
    (agent as unknown as { openSlot: unknown }).openSlot = slot;
    return slot as InstanceType<typeof ClaudeTurnSlot>;
  }

  it('a stopped turn tail is attributed to its slot, then crosses the between-turns door, never a later slot', async () => {
    const agent = freshAgent();
    const sink: AgentEvent[] = [];
    (agent as unknown as { config: BackendConfig }).config.onBetweenTurnsEvent = event => {
      sink.push(event);
    };
    const route = (m: unknown) => (agent as unknown as { routeLiveMessage(m: unknown): Promise<void> }).routeLiveMessage(m);

    const stopped = slotFor(agent, 'the stopped turn');
    // The stopped turn's own tail, while its slot is still open: attributed to it.
    await route({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'still the stopped turn words' }] },
      session_id: SDK_SESSION,
      parent_tool_use_id: null,
    });
    expect((stopped as unknown as { receivedAssistantContent: boolean }).receivedAssistantContent).toBe(true);
    stopped.close('terminal', { type: 'complete', terminalReason: 'user_stop' } as AgentEvent);

    // Between the turns (no slot open) a late leftover crosses the door — the background/host
    // sink — as a text_complete, and never a slot. The assistant text is pending until its
    // message_delta, exactly as in a real tail.
    (agent as unknown as { openSlot: unknown }).openSlot = null;
    await route({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'a late leftover' }] },
      session_id: SDK_SESSION,
      parent_tool_use_id: null,
    });
    await route({
      type: 'stream_event',
      event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      session_id: SDK_SESSION,
      parent_tool_use_id: null,
    });
    expect(sink.some(e => e.type === 'text_complete' && e.text === 'a late leftover')).toBe(true);
    // A task_notification among the leftovers reaches the same sink.
    await route({ type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed', session_id: SDK_SESSION });
    expect(sink.some(e => e.type === 'task_completed')).toBe(true);

    // The next turn's slot gets only its own traffic.
    const next = slotFor(agent, 'the next turn');
    await route({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'the next turn own answer' }] },
      session_id: SDK_SESSION,
      parent_tool_use_id: null,
    });
    expect((next as unknown as { receivedAssistantContent: boolean }).receivedAssistantContent).toBe(true);
    expect((next as unknown as { pending: AgentEvent[] }).pending.filter(e => e.type === 'text_complete' && (e as { text: string }).text === 'a late leftover')).toHaveLength(0);
  });

  it('a stale-generation reader routes nothing and settles nothing', async () => {
    const agent = freshAgent();
    const sink: AgentEvent[] = [];
    (agent as unknown as { config: BackendConfig }).config.onBetweenTurnsEvent = event => {
      sink.push(event);
    };
    const slot = slotFor(agent, 'the live turn');
    (agent as unknown as { liveGeneration: number }).liveGeneration = 7;
    const liveQuery = { fake: 'the live query' };
    (agent as unknown as { currentQuery: unknown }).currentQuery = liveQuery;

    const stale = (agent as unknown as { runLiveReader(live: unknown, generation: number): Promise<void> }).runLiveReader(
      (async function* oldQuery() {
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'from a dead query' }] }, session_id: SDK_SESSION };
      })(),
      3, // not the live generation
    );
    await stale;

    expect((slot as unknown as { pending: AgentEvent[] }).pending).toHaveLength(0);
    expect(sink).toHaveLength(0);
    // And the stale reader did not tear the live session down.
    expect((agent as unknown as { currentQuery: unknown }).currentQuery).toBe(liveQuery);
  });
});

describe('UB2.2 — a Stop while the turn is being prepared is an interruption', () => {
  it('the turn yields complete (Interrupted), never an error, and writes nothing', async () => {
    const agent = freshAgent();
    let releaseEnsure!: () => void;
    const held = new Promise<{ input: unknown; notices: AgentEvent[] }>(resolve => {
      releaseEnsure = () => resolve({ input: { write: () => {}, stream: () => {} }, notices: [] });
    });
    (agent as unknown as { ensureLiveSession: unknown }).ensureLiveSession = () => held;

    const starting = runTurn(agent, 'started too late');
    await new Promise(resolve => setTimeout(resolve, 0));
    // The user's Stop lands inside the preparation window.
    agent.forceAbort(AbortReason.UserStop);
    releaseEnsure();

    const events = await starting;
    expect(events.some(e => e.type === 'error' || e.type === 'typed_error')).toBe(false);
    expect(events.some(e => e.type === 'status' && e.message === 'Interrupted')).toBe(true);
    expect(events.at(-1)?.type).toBe('complete');
  });
});

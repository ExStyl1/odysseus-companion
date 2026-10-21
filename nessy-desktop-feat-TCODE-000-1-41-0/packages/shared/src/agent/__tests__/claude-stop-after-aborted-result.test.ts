/**
 * F1.731 — A USER STOP ON CLAUDE MUST NOT READ AS A PROVIDER ERROR.
 *
 * Origin: the 1.41.0 release sitting, lane SIT-f (packaged `5896a66d2`,
 * claude-gateway, 2026-09-25). Every Stop of the default claude card could end
 * with "Response interrupted", then an Error box reading
 * `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null`,
 * then "Stopped: the model provider returned an error"
 * (`terminal_reason:provider_error`).
 *
 * THE SHAPE, read from the vendored binary rather than guessed (2.1.267 — both
 * self-reports agree). The child builds its turn result from the engine's own
 * ending `mr` and sets `terminal_reason: mr` on every subtype. It emits
 * `subtype: 'error_during_execution'` with the `[ede_diagnostic] …` line as
 * its `errors` ONLY when `mr` is `aborted_streaming` or `aborted_tools` (the
 * predicate is the two-value function the builder calls) AND the last
 * transcript message is not clean assistant text: a Stop that lands right after
 * a steer began its turn (the sitting's case: `result_type=user`), or while a
 * tool runs (`last_content_type=tool_use`). The same gating is in the cached
 * 0.3.251 binary, so the SDK lift did not introduce it. Claude Code's own UI
 * drops every `[ede_diagnostic]` entry before it shows a result's errors; it is
 * a diagnostic, not an error.
 *
 * The adapter honoured `terminal_reason: aborted_*` on the `success` arm only
 * (L2's case), so this subtype fell through to `provider_error`, which pushes
 * an `error` event before the `complete`. `ClaudeAgent`'s reader belt stamps
 * `user_stop` only on a `complete` that carries NO reason, and the error had
 * already been pushed, so the belt could not help.
 *
 * The fix reads the SDK's own name for the ending on every subtype. The
 * CONTROLS are the same subtype without an aborted `terminal_reason` (a genuine
 * execution error, which must still read as one) on both instruments: the
 * adapter alone, and the live reader driven through a real `forceAbort`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as claudeAgentSdk from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import { AbortReason } from '../core/session-lifecycle.ts';
import { ClaudeEventAdapter, type ClaudeAdapterCallbacks } from '../backend/claude/event-adapter.ts';

/** The diagnostic line the sitting's Error box showed, byte for byte. */
const EDE_AFTER_STEER = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null';
/** The same builder's line for a Stop that lands while a tool runs. */
const EDE_DURING_TOOL = '[ede_diagnostic] result_type=assistant last_content_type=tool_use stop_reason=tool_use';

function resultMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    result: 'ok',
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0,
    session_id: 'fake-stop-session',
    stop_reason: null,
    modelUsage: {},
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...overrides,
  };
}

/** The result the 2.1.267 child sends after a Stop that lands before the model's text. */
function abortedExecutionResult(terminalReason: string, diagnostic: string): Record<string, unknown> {
  return resultMessage({
    subtype: 'error_during_execution',
    is_error: true,
    terminal_reason: terminalReason,
    errors: [diagnostic],
  });
}

function createCallbacks(): ClaudeAdapterCallbacks {
  return {
    mapSDKError: async (errorCode) => ({
      type: 'typed_error' as const,
      error: {
        code: 'unknown_error',
        title: 'Test Error',
        message: `Mock error for ${errorCode}`,
        details: [],
        actions: [],
        canRetry: false,
      },
    }),
  };
}

async function adaptOne(message: Record<string, unknown>): Promise<AgentEvent[]> {
  const adapter = new ClaudeEventAdapter(createCallbacks());
  adapter.startTurn();
  return adapter.adapt(message as never);
}

function completeOf(events: AgentEvent[]): { terminalReason?: string } {
  const complete = events.find(event => event.type === 'complete');
  expect(complete).toBeDefined();
  return complete as { terminalReason?: string };
}

describe('F1.731 — the adapter reads an aborted result as a Stop on every subtype', () => {
  it('the sitting shape (error_during_execution, aborted_streaming, result_type=user) is user_stop with no error event', async () => {
    const events = await adaptOne(abortedExecutionResult('aborted_streaming', EDE_AFTER_STEER));
    expect(events.filter(event => event.type === 'error' || event.type === 'typed_error')).toEqual([]);
    expect(completeOf(events).terminalReason).toBe('user_stop');
  });

  it('a Stop during a tool (aborted_tools, last_content_type=tool_use) is user_stop with no error event', async () => {
    const events = await adaptOne(abortedExecutionResult('aborted_tools', EDE_DURING_TOOL));
    expect(events.filter(event => event.type === 'error' || event.type === 'typed_error')).toEqual([]);
    expect(completeOf(events).terminalReason).toBe('user_stop');
  });

  it('L2 still holds: an aborted SUCCESS result is user_stop', async () => {
    const events = await adaptOne(resultMessage({ is_error: true, terminal_reason: 'aborted_streaming', result: '' }));
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(completeOf(events).terminalReason).toBe('user_stop');
  });

  it('CONTROL: a genuine execution error (no aborted terminal_reason) still reads as a provider error, with its text', async () => {
    const withoutReason = await adaptOne(resultMessage({ subtype: 'error_during_execution', is_error: true, errors: ['boom'] }));
    expect(withoutReason.filter(event => event.type === 'error').map(event => (event as { message: string }).message))
      .toEqual(['boom']);
    expect(completeOf(withoutReason).terminalReason).toBe('provider_error');

    const modelError = await adaptOne(resultMessage({
      subtype: 'error_during_execution', is_error: true, terminal_reason: 'model_error', errors: ['upstream 500'],
    }));
    expect(modelError.filter(event => event.type === 'error').map(event => (event as { message: string }).message))
      .toEqual(['upstream 500']);
    expect(completeOf(modelError).terminalReason).toBe('provider_error');
  });
});

// ---------------------------------------------------------------------------
// The live reader, driven through a real Stop. A fake CLI that reads the input
// channel and stays open between turns — the rig of `claude-live-session.test.ts`,
// cut down to what these arms read.
// ---------------------------------------------------------------------------

/** A SNAPSHOT taken before the mock, never the live namespace (AGENTS.md, the `mock.module` bullet). */
const realSdk = { ...claudeAgentSdk };

const scripts: Array<() => AsyncGenerator<unknown>> = [];
const interrupts: number[] = [];

function assistantMessage(text: string): unknown {
  return {
    type: 'assistant',
    session_id: 'fake-stop-session',
    message: {
      id: `msg-${text}`,
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
}

async function* plainSuccess(): AsyncGenerator<unknown> {
  yield assistantMessage('ok');
  yield resultMessage();
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown }) => {
    const index = interrupts.push(0) - 1;
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    async function* serveTurns(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield* (scripts.shift() ?? plainSuccess)();
      }
    }
    const stream = serveTurns() as AsyncGenerator<unknown> & {
      interrupt(): Promise<unknown>;
      setModel(model?: string): Promise<void>;
    };
    stream.interrupt = async () => {
      interrupts[index] = (interrupts[index] ?? 0) + 1;
      return { still_queued: [] };
    };
    stream.setModel = async () => {};
    return stream;
  },
}));

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
});

const { ClaudeAgent } = await import('../claude-agent.ts');
type Agent = InstanceType<typeof ClaudeAgent>;

const WORKSPACE_ROOT = '/tmp/nessy-f1731-stop';
let sessionCounter = 0;
let agents: Agent[] = [];

function makeAgent(): Agent {
  sessionCounter += 1;
  const agent = new ClaudeAgent({
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f1731-stop',
      name: 'F1.731 Stop',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: `session-f1731-${sessionCounter}`,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: WORKSPACE_ROOT,
    } as never,
  } as BackendConfig) as Agent;
  agents.push(agent);
  return agent;
}

async function runTurn(agent: Agent, message: string): Promise<AgentEvent[]> {
  const chatImpl = (agent as unknown as {
    chatImpl: (message: string) => AsyncGenerator<AgentEvent>;
  }).chatImpl.bind(agent);
  const events: AgentEvent[] = [];
  for await (const event of chatImpl(message)) events.push(event);
  return events;
}

beforeEach(() => {
  scripts.length = 0;
  interrupts.length = 0;
});

afterEach(() => {
  for (const agent of agents.splice(0)) agent.destroy();
});

describe('F1.731 — the live reader: a Stop answered with error_during_execution', () => {
  it('reads as a user stop: no error event, the Interrupted status, user_stop, and the next message is answered', async () => {
    const agent = makeAgent();
    scripts.push(async function* stoppedAfterSteer() {
      yield assistantMessage('once upon a time');
      agent.forceAbort(AbortReason.UserStop);
      yield abortedExecutionResult('aborted_streaming', EDE_AFTER_STEER);
    });

    const stopped = await runTurn(agent, 'write a long story');

    expect(interrupts).toEqual([1]);
    expect(stopped.filter(event => event.type === 'error' || event.type === 'typed_error')).toEqual([]);
    expect(stopped.some(event => event.type === 'status' && event.message === 'Interrupted')).toBe(true);
    expect(completeOf(stopped).terminalReason).toBe('user_stop');

    const next = await runTurn(agent, 'now a short one');
    expect(interrupts).toHaveLength(1);
    expect(completeOf(next).terminalReason).toBeUndefined();
  });

  it('CONTROL: the same subtype with no Stop and no aborted terminal_reason still reaches the turn as an error', async () => {
    const agent = makeAgent();
    scripts.push(async function* failedTurn() {
      yield assistantMessage('once upon a time');
      yield resultMessage({ subtype: 'error_during_execution', is_error: true, errors: ['boom'] });
    });

    const failed = await runTurn(agent, 'write a long story');

    expect(interrupts).toEqual([0]);
    expect(failed.filter(event => event.type === 'error').map(event => (event as { message: string }).message))
      .toEqual(['boom']);
    expect(failed.some(event => event.type === 'status' && event.message === 'Interrupted')).toBe(false);
    expect(completeOf(failed).terminalReason).toBe('provider_error');
  });
});

// F1.745 (origin WJ-crit-x, F1.731's three follow-ups).
describe('F1.745 — the adapter keeps Claude Code\'s diagnostic lines out of the Error box', () => {
  it('a real error beside a [session_crash] / [ede_diagnostic] line shows the real error alone', async () => {
    const events = await adaptOne(resultMessage({
      subtype: 'error_during_execution', is_error: true, errors: ['[session_crash] reader ended', 'boom', EDE_AFTER_STEER],
    }));
    expect(events.filter(event => event.type === 'error').map(event => (event as { message: string }).message))
      .toEqual(['boom']);
    expect(completeOf(events).terminalReason).toBe('provider_error');
  });

  it('BOUNDARY: a provider error carrying ONLY diagnostic lines is still an error, with the generic text', async () => {
    const events = await adaptOne(resultMessage({
      subtype: 'error_during_execution', is_error: true, result: '', errors: ['[session_crash] reader ended'],
    }));
    expect(events.filter(event => event.type === 'error').map(event => (event as { message: string }).message))
      .toEqual(['Query failed']);
  });
});

describe('F1.745 — the live reader: a host stop that is not the user\'s', () => {
  it('a BUDGET stop the child settles as aborted reads max_budget_usd, not user_stop, and says no Interrupted', async () => {
    const agent = makeAgent();
    scripts.push(async function* budgetStopped() {
      yield assistantMessage('once upon a time');
      agent.forceAbort(AbortReason.MaxBudgetUsd);
      yield abortedExecutionResult('aborted_streaming', EDE_AFTER_STEER);
    });

    const stopped = await runTurn(agent, 'write a long story');

    expect(interrupts).toEqual([1]);
    expect(stopped.filter(event => event.type === 'error' || event.type === 'typed_error')).toEqual([]);
    expect(stopped.some(event => event.type === 'status' && event.message === 'Interrupted')).toBe(false);
    expect(completeOf(stopped).terminalReason).toBe('max_budget_usd');
  });

  it('READING: a plan/auth HANDOFF the child settles as aborted reads user_stop — no Error box and no Interrupted status', async () => {
    const agent = makeAgent();
    scripts.push(async function* handedOff() {
      yield assistantMessage('here is the plan');
      agent.interruptForHandoff(AbortReason.PlanSubmitted);
      yield abortedExecutionResult('aborted_streaming', EDE_AFTER_STEER);
    });

    const handoff = await runTurn(agent, 'plan it');

    expect(interrupts).toEqual([1]);
    expect(handoff.filter(event => event.type === 'error' || event.type === 'typed_error')).toEqual([]);
    expect(handoff.some(event => event.type === 'status' && event.message === 'Interrupted')).toBe(false);
    expect(completeOf(handoff).terminalReason).toBe('user_stop');
  });
});

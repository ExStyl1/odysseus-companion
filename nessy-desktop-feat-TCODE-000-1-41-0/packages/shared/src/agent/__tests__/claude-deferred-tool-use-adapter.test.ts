/**
 * P2.525 — THE DEFERRAL THE CLAUDE HOST COULD NOT RECEIVE.
 *
 * `hooks.md#defer-a-tool-call-for-later` (verified on the rendered page,
 * 2026-09-02) describes both endings of a deferred tool call in the SDK's own
 * vocabulary:
 *
 * > "The hook returns `permissionDecision: "defer"`. The tool doesn't execute.
 * > The process exits with `stop_reason: "tool_deferred"` and the pending tool
 * > call preserved in the transcript."
 *
 * > "If the deferred tool is no longer available when you resume, the process
 * > exits with `stop_reason: "tool_deferred_unavailable"` and `is_error: true`
 * > before the hook fires. … The `deferred_tool_use` payload is still included
 * > so you can identify which tool went missing."
 *
 * Both values are members of the SDK's `TerminalReason` union and both are
 * already in this fork's own `TERMINAL_REASON_VALUES`, with `AgentDeferredToolUse`
 * typed beside them and `SessionManager` forwarding both fields
 * (`turn-terminal-reason.test.ts`). `pi-agent.ts` and
 * `backend/nestor-cloud/turn.ts` fill them. The CLAUDE adapter did not — it read
 * `terminal_reason` for exactly the two abort values and nothing else — so a
 * real deferral arrived as an ordinary reason-free completion, which is the
 * shape `BaseAgent.chat`'s pass loop holds back and CONTINUES from, and the
 * unavailable exit arrived as `provider_error` with an error bubble blaming the
 * provider for a hook's decision.
 *
 * WHAT THIS FILE DOES NOT CLAIM. It pins the RECEIVE half only. The claude gate
 * still refuses to defer (`buildClaudePreToolUseContinue` degrades one rank to
 * `ask`, P3.262), so nothing produces these results on this backend today; the
 * emission half additionally needs the resume port ungated and that degrade
 * removed in the same commit. Filling the fields is the prerequisite that
 * refusal named, and it is what makes a future deferral legible instead of
 * silent.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ClaudeEventAdapter, type ClaudeAdapterCallbacks } from '../backend/claude/event-adapter.ts';

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

function freshAdapter(): ClaudeEventAdapter {
  const adapter = new ClaudeEventAdapter(createCallbacks());
  adapter.startTurn();
  return adapter;
}

const resultMessage = (overrides: Record<string, unknown>) => ({
  type: 'result',
  usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  total_cost_usd: 0,
  modelUsage: {},
  session_id: 'sess-defer',
  stop_reason: null,
  num_turns: 1,
  duration_ms: 5,
  duration_api_ms: 4,
  is_error: false,
  subtype: 'success',
  ...overrides,
}) as never;

const DEFERRED = {
  id: 'toolu_01abc',
  name: 'AskUserQuestion',
  input: { questions: [{ question: 'Which framework?', header: 'Framework' }] },
};

/**
 * The SDK side of the contract, read off the INSTALLED typings rather than
 * quoted from the page — the page is the contract for behaviour, the bundle is
 * the denominator for what exists, and this file depends on both agreeing.
 */
describe('the installed SDK types both halves of a deferral', () => {
  it('declares the two terminal reasons and the payload that rides with them', () => {
    const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
    const typings = readFileSync(`${sdkEntry.slice(0, sdkEntry.lastIndexOf('/'))}/sdk.d.ts`, 'utf8');
    expect(typings).toContain("'tool_deferred'");
    expect(typings).toContain("'tool_deferred_unavailable'");
    expect(typings).toContain('deferred_tool_use?: SDKDeferredToolUse;');
    expect(typings).toContain('export declare type SDKDeferredToolUse = {');
  });
});

describe('ClaudeEventAdapter receives a deferral (P2.525)', () => {
  it('names `tool_deferred` and carries the pending call', async () => {
    const events = await freshAdapter().adapt(resultMessage({
      terminal_reason: 'tool_deferred',
      deferred_tool_use: DEFERRED,
      result: '',
    }));

    const complete = events.find(event => event.type === 'complete') as Record<string, unknown>;
    expect(complete).toBeDefined();
    // Without this the turn is a reason-free `complete`, which the pass loop
    // holds back and continues from — i.e. the deferral would be ignored and the
    // turn would run on with the tool unrun.
    expect(complete.terminalReason).toBe('tool_deferred');
    expect(complete.deferredToolUse).toEqual(DEFERRED);
    // The ordinary exit is a SUCCESS: "terminates success with the pending call
    // preserved". No error tone, no error event.
    expect(complete.terminalIsError).toBeUndefined();
    expect(events.some(event => event.type === 'error')).toBe(false);
  });

  it('names `tool_deferred_unavailable` as an error and blames no provider', async () => {
    const events = await freshAdapter().adapt(resultMessage({
      terminal_reason: 'tool_deferred_unavailable',
      is_error: true,
      deferred_tool_use: { id: 'toolu_01abc', name: 'mcp__gone__ask', input: {} },
      result: 'deferred tool is unavailable',
    }));

    const complete = events.find(event => event.type === 'complete') as Record<string, unknown>;
    expect(complete.terminalReason).toBe('tool_deferred_unavailable');
    // "exits with … `is_error: true`" — the tone, mirrored off the SDK's own field.
    expect(complete.terminalIsError).toBe(true);
    // "The `deferred_tool_use` payload is still included so you can identify
    // which tool went missing."
    expect(complete.deferredToolUse).toMatchObject({ name: 'mcp__gone__ask' });
    // THE NEGATIVE THAT MATTERS. Before this row an `is_error: true` success
    // result fell through to `provider_error`, which additionally pushes an
    // `error` event — so a hook's own resume failure was reported to the user as
    // the model provider failing.
    expect(complete.terminalReason).not.toBe('provider_error');
    expect(events.some(event => event.type === 'error')).toBe(false);
  });

  it('reads `stop_reason` when the binary sends no `terminal_reason` — the RE-DEFER exit', async () => {
    // MEASURED in the shipped 0.3.233 bundle, not assumed. The binary has two
    // emit sites for an ordinary deferral. The in-turn one fills
    // `terminal_reason` from its own computed reason; the one that fires when a
    // RESUMED session's hook defers the same call again builds its result with
    // `stop_reason: "tool_deferred"` and NO `terminal_reason` key, and the
    // result assembler is a plain spread that synthesises nothing. That second
    // exit is the documented loop — hooks.md: "If the answer is not ready when
    // you resume, the hook can return `defer` again and the process exits the
    // same way."
    //
    // Reading `terminal_reason` alone therefore made the FIRST deferral legible
    // and the SECOND a reason-free `complete` — the shape the pass loop holds
    // back and CONTINUES from. `terminal_reason` is optional on both result
    // members in `sdk.d.ts`; `stop_reason` is `string | null` and always there.
    const events = await freshAdapter().adapt(resultMessage({
      stop_reason: 'tool_deferred',
      deferred_tool_use: DEFERRED,
      result: '',
    }));

    const complete = events.find(event => event.type === 'complete') as Record<string, unknown>;
    expect(complete.terminalReason).toBe('tool_deferred');
    expect(complete.deferredToolUse).toEqual(DEFERRED);
    expect(complete.terminalIsError).toBeUndefined();
    expect(events.some(event => event.type === 'error')).toBe(false);
  });

  it('THE CONTROL — another `stop_reason` is not read as a deferral', async () => {
    // The widening must not turn every stop_reason into a terminal reason. A
    // refusal rides a success result the same way and keeps its own answer.
    const events = await freshAdapter().adapt(resultMessage({ stop_reason: 'end_turn', result: 'done' }));
    const complete = events.find(event => event.type === 'complete') as Record<string, unknown>;
    expect(complete.terminalReason).toBeUndefined();
  });

  it('does not attach a payload to an ordinary completion', async () => {
    // The guard on the spread. A `deferred_tool_use` without one of the two
    // reasons would tell `SessionManager` to persist a held call that nothing is
    // holding.
    const events = await freshAdapter().adapt(resultMessage({ result: 'done', deferred_tool_use: DEFERRED }));
    const complete = events.find(event => event.type === 'complete') as Record<string, unknown>;
    expect(complete.terminalReason).toBeUndefined();
    expect(complete.deferredToolUse).toBeUndefined();
  });
});

describe('the native compaction-thrashing breaker reaches our vocabulary (P6.55)', () => {
  // The compaction lane measured the vendored 2.1.223 binary: `n1_`/`CEo` trip
  // after 3 consecutive rapid refills — the same threshold as the shared
  // `AUTO_COMPACTION_THRASHING_REFILL_LIMIT` — and end the turn with
  // `{reason:"rapid_refill_breaker"}`. `sdk.d.ts` publishes that value on
  // `TerminalReason`. So the SDK already HAS the mechanism; the gap was that its
  // verdict arrived as `provider_error` here while the identical failure is
  // `auto_compaction_thrashing` on Pi and codex.
  it('declares the value on the terminal-reason union', () => {
    const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
    const typings = readFileSync(`${sdkEntry.slice(0, sdkEntry.lastIndexOf('/'))}/sdk.d.ts`, 'utf8');
    expect(typings).toContain("'rapid_refill_breaker'");
  });

  it('ends the turn on the SHARED reason, not on provider_error', async () => {
    const events = await freshAdapter().adapt(resultMessage({
      terminal_reason: 'rapid_refill_breaker',
      is_error: true,
      result: 'Autocompact is thrashing',
    }));
    const complete = events.find(event => event.type === 'complete') as Record<string, unknown>;
    expect(complete.terminalReason).toBe('auto_compaction_thrashing');
    // The switch-visible half: this is the value Pi and codex already emit, so
    // the same failure now reads the same on all three.
    expect(complete.terminalReason).not.toBe('provider_error');
    // And the provider is no longer blamed for the host's own compaction loop.
    expect(events.some(event => event.type === 'error')).toBe(false);
  });

  it('says what happened and what to do, the way codex already does', async () => {
    const events = await freshAdapter().adapt(resultMessage({
      terminal_reason: 'rapid_refill_breaker',
      is_error: true,
      result: '',
    }));
    const notice = events.find(event => event.type === 'info') as Record<string, unknown> | undefined;
    expect(notice).toBeDefined();
    expect(notice?.level).toBe('warning');
    expect(String(notice?.message)).toContain('Auto-compaction is thrashing');
    // The three recovery steps, because `auto_compaction_thrashing` is
    // deliberately absent from `TERMINAL_REASON_NOTICE_VALUES` — the reason
    // renders nothing on its own, so without this the stop would be silent.
    expect(String(notice?.message)).toContain('/compact');
    expect(String(notice?.message)).toContain('/clear');
  });

  it('emits no thrashing notice on any other ending', async () => {
    for (const overrides of [{ result: 'done' }, { is_error: true, result: '' }, { terminal_reason: 'aborted_tools', is_error: true, result: '' }]) {
      const events = await freshAdapter().adapt(resultMessage(overrides));
      expect(events.some(event => event.type === 'info' && String((event as { message?: string }).message).includes('thrashing'))).toBe(false);
    }
  });
});

describe('ClaudeEventAdapter neighbouring endings', () => {
  it('leaves every neighbouring ending exactly where it was', async () => {
    // The regression surface of inserting a branch into that chain: an abort, a
    // refusal, a plain failure and a cap all keep their answers.
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ terminal_reason: 'aborted_streaming', is_error: true, result: '' }, 'user_stop'],
      [{ stop_reason: 'refusal', result: '' }, 'provider_refusal'],
      [{ is_error: true, api_error_status: 529, result: '' }, 'provider_error'],
      [{ subtype: 'error_max_turns', is_error: true, errors: ['cap'] }, 'max_agent_turns'],
    ];
    for (const [overrides, expected] of cases) {
      const events = await freshAdapter().adapt(resultMessage(overrides));
      const complete = events.find(event => event.type === 'complete') as Record<string, unknown>;
      expect(complete.terminalReason).toBe(expected);
      expect(complete.deferredToolUse).toBeUndefined();
    }
  });
});

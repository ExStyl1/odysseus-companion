/**
 * L1 BASELINE — which field on an SDK `result` message says the turn failed.
 *
 * L0 measured it on a real model: **an errored turn arrives as
 * `subtype: 'success'` with `is_error: true`.** The installed typings confirm
 * it is by design rather than an accident of one run — `SDKResultSuccess`
 * carries a REQUIRED `is_error: boolean` (and an `api_error_status`), while
 * `SDKResultError` is a separate union member for a different failure class
 * (turn caps, budget caps, structured-output retry exhaustion, execution
 * errors). The two are not alternatives: a network failure is the FORMER.
 *
 * `ClaudeEventAdapter.adaptResult` (event-adapter.ts:797-804) resolves the
 * turn's outcome from `stop_reason` and then `subtype`, and never reads
 * `is_error`. So today a failed turn is adapted into a clean `complete`.
 *
 * These are CHARACTERIZATION tests. They pin the current — wrong — behaviour so
 * that L2's consumer, which must key on `is_error`, has a baseline that goes
 * red. Each carries the sentence saying what the replacement should assert.
 *
 * The `complete` AgentEvent already has the field the fix needs:
 * `terminalIsError`, produced today only by `pi-agent.ts` and forwarded by
 * `SessionManager` (`turn-terminal-reason.test.ts`). Nothing new is required on
 * the wire — only that the Claude adapter fill it.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { SDKResultError, SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeEventAdapter, type ClaudeAdapterCallbacks } from '../backend/claude/event-adapter.ts';

function createCallbacks(): ClaudeAdapterCallbacks {
  return {
    onDebug: undefined,
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

const resultUsage = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

const resultMessage = (overrides: Record<string, unknown>) => ({
  type: 'result',
  usage: resultUsage,
  total_cost_usd: 0,
  modelUsage: {},
  session_id: 'sess-1',
  stop_reason: null,
  num_turns: 1,
  duration_ms: 10,
  duration_api_ms: 8,
  is_error: false,
  ...overrides,
}) as never;

// ---------------------------------------------------------------------------
// Compile-time half of the contract.
//
// `is_error` lives on the SUCCESS member and is required. If the SDK ever moves
// it, makes it optional, or drops it, these stop compiling under
// `bun run typecheck:shared` (packages/shared/tsconfig.json includes
// `src/**/*`, tests included) — which is the point: the whole L2 consumer keys
// off this field.
// ---------------------------------------------------------------------------
type IsErrorIsRequiredOnSuccess =
  undefined extends SDKResultSuccess['is_error'] ? never : true;
const _isErrorIsRequiredOnSuccess: IsErrorIsRequiredOnSuccess = true;
void _isErrorIsRequiredOnSuccess;

type SuccessSubtypeIsLiterallySuccess =
  SDKResultSuccess['subtype'] extends 'success' ? true : never;
const _successSubtypeIsLiterallySuccess: SuccessSubtypeIsLiterallySuccess = true;
void _successSubtypeIsLiterallySuccess;

// The error member's subtypes are the FOUR agent-loop failure classes. A
// network/API failure is not among them — which is precisely why it has to
// arrive on the success member.
type ErrorSubtypes = SDKResultError['subtype'];
const _errorSubtypes: ErrorSubtypes[] = [
  'error_during_execution',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
];
void _errorSubtypes;

/** Read the installed typings so a runtime `bun test` sees the drift too. */
function sdkTypingsSource(): string {
  const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
  const typingsPath = `${sdkEntry.slice(0, sdkEntry.lastIndexOf('/'))}/sdk.d.ts`;
  return readFileSync(typingsPath, 'utf8');
}

function declaredBlock(source: string, typeName: string): string {
  const start = source.indexOf(`export declare type ${typeName} = {`);
  if (start === -1) throw new Error(`Could not find ${typeName} in the installed sdk.d.ts`);
  const end = source.indexOf('\n};', start);
  if (end === -1) throw new Error(`Could not find the end of ${typeName} in the installed sdk.d.ts`);
  return source.slice(start, end);
}

describe('SDK result contract: is_error, not subtype', () => {
  it('the installed typings put a required is_error on BOTH result members', () => {
    const source = sdkTypingsSource();
    const success = declaredBlock(source, 'SDKResultSuccess');
    const error = declaredBlock(source, 'SDKResultError');

    // Required, not optional: `is_error:` and not `is_error?:`.
    expect(success).toContain('\n    is_error: boolean;');
    expect(error).toContain('\n    is_error: boolean;');
    // And the success member is pinned to the one literal subtype, so `subtype`
    // alone can never express "this succeeded structurally but failed".
    expect(success).toContain("subtype: 'success';");
    // The companion field that says WHICH API failure it was.
    expect(success).toContain('api_error_status?: number | null;');
  });
});

describe('ClaudeEventAdapter result contract (L2 — the baseline these replaced)', () => {
  // WHY THESE TWO CHANGED. L1 wrote them as CHARACTERIZATION tests: they pinned
  // the wrong behaviour on purpose, each carrying the sentence saying what the
  // replacement must assert, so that L2's fix could not land green-and-dead.
  // They are the two of the nineteen that were MEANT to go red. The other
  // seventeen still assert exactly what they asserted before.
  it('names a failed turn (subtype success + is_error true) as a failure', async () => {
    const events = await freshAdapter().adapt(
      resultMessage({ subtype: 'success', is_error: true, api_error_status: 529, result: '' }),
    );

    const complete = events.find(event => event.type === 'complete') as Record<string, unknown>;
    expect(complete).toBeDefined();

    // The turn is FAILED and says so on the field the `complete` contract
    // already had and `SessionManager` already forwards.
    expect(complete.terminalIsError).toBe(true);
    expect(complete.terminalReason).toBe('provider_error');
    // And the user is told, on the same channel a genuine execution error uses.
    // Before L2 a rate-limited or 5xx turn was silent: the answer simply did not
    // arrive and nothing said why.
    const error = events.find(event => event.type === 'error') as { message: string } | undefined;
    expect(error?.message).toBe('Query failed (API status 529)');

    // The SESSION is still alive — L0 established that a turn failure and a
    // session death are distinguishable without guessing — so nothing here
    // claims otherwise.
  });

  it('an INTERRUPTED turn is named `user_stop`, and that is what stops the pass loop resuming it', async () => {
    // The sharpest consequence of the fix. `Query.interrupt()` settles the
    // cancelled turn with an ORDINARY result — `subtype: 'success'`, the SDK's
    // own `terminal_reason: 'aborted_streaming'` — and `BaseAgent.chat`'s pass
    // loop HOLDS BACK a reason-free `complete` and CONTINUES from it
    // (`base-agent.ts:3789`). Without a terminal reason here, pressing Stop
    // would resume the turn.
    const events = await freshAdapter().adapt(
      resultMessage({ subtype: 'success', is_error: true, terminal_reason: 'aborted_streaming', result: '' }),
    );

    const complete = events.find(event => event.type === 'complete') as Record<string, unknown>;
    expect(complete.terminalReason).toBe('user_stop');
    expect(complete.terminalIsError).toBe(true);
    // A stop is not a provider failure: no error event, so the assistant text
    // already produced this turn survives on screen.
    expect(events.some(event => event.type === 'error')).toBe(false);
  });

  it('`aborted_tools` is the same ending — the other half of the SDK\'s own pair', async () => {
    const events = await freshAdapter().adapt(
      resultMessage({ subtype: 'success', is_error: true, terminal_reason: 'aborted_tools', result: '' }),
    );
    const complete = events.find(event => event.type === 'complete') as Record<string, unknown>;
    expect(complete.terminalReason).toBe('user_stop');
  });

  it('positive control: a genuinely clean turn is still reason-free and error-free', async () => {
    // Without this, "the failed turn is named" proves only that the adapter
    // names everything. Same rig, same fixture builder, one field different.
    const events = await freshAdapter().adapt(
      resultMessage({ subtype: 'success', is_error: false, result: 'hi' }),
    );
    const complete = events.find(event => event.type === 'complete') as Record<string, unknown>;
    expect('terminalReason' in complete).toBe(false);
    expect('terminalIsError' in complete).toBe(false);
    expect(events.some(event => event.type === 'error')).toBe(false);
  });

  it('positive control on the same rig: the ERROR member does produce an error event', async () => {
    // Without this, "no error event was emitted" above proves only that the
    // rig is quiet. Same adapter, same fixture builder, one field different.
    const events = await freshAdapter().adapt(
      resultMessage({ subtype: 'error_during_execution', is_error: true, errors: ['boom'] }),
    );

    expect(events.some(event => event.type === 'error')).toBe(true);
    const complete = events.find(event => event.type === 'complete') as Record<string, unknown>;
    expect(complete.terminalReason).toBe('provider_error');
  });

  it('is_error is READ — flipping the one field that says "this turn failed" changes what the consumer sees', async () => {
    // The mirror of the defect this replaced. L1 pinned it the other way round:
    // "a success result is byte-identical with it true or false", which was the
    // sharpest statement that the field was unread. It must now differ.
    const ok = await freshAdapter().adapt(
      resultMessage({ subtype: 'success', is_error: false, result: 'hi' }),
    );
    const failed = await freshAdapter().adapt(
      resultMessage({ subtype: 'success', is_error: true, api_error_status: 500, result: '' }),
    );

    expect(JSON.stringify(failed)).not.toBe(JSON.stringify(ok));
    const okComplete = ok.find(event => event.type === 'complete') as Record<string, unknown>;
    const failedComplete = failed.find(event => event.type === 'complete') as Record<string, unknown>;
    expect('terminalIsError' in okComplete).toBe(false);
    expect(failedComplete.terminalIsError).toBe(true);
  });

  it('the refusal precedent shows a sibling of subtype already decides the outcome', async () => {
    // `stop_reason: 'refusal'` already overrides a `success` subtype
    // (event-adapter.ts:797-801, "stop_reason is resolved BEFORE the subtype").
    // `is_error` is the same shape of fact on the same message and is the one
    // that was missed — this test exists so the asymmetry is on the record.
    const events = await freshAdapter().adapt(
      resultMessage({ subtype: 'success', stop_reason: 'refusal' }),
    );
    const complete = events.find(event => event.type === 'complete') as Record<string, unknown>;
    expect(complete.terminalReason).toBe('provider_refusal');
  });
});

/**
 * P3.262 → P2.525 — a hook's `defer` on the claude runtime, and what happens
 * to it now.
 *
 * ## What was wrong, and what was done about it twice
 *
 * `runClaudePreToolUseHookPipeline` narrowed the host union to `'allow' | 'ask'`
 * one hop before the payload was built, so a `defer` from a user, project or
 * plugin hook fell into the empty branch and `buildClaudePreToolUseContinue`,
 * seeing no decision at all, named `allow`. `hooks.md`
 * § `#pretooluse-decision-control`: "When multiple PreToolUse hooks return
 * different decisions, precedence is `deny` > `defer` > `ask` > `allow`." So the
 * strongest of the three non-terminal values arrived as the one value it can
 * never lose to — a silent upgrade past `ask`, reachable by any hook.
 *
 * P3.262 closed that by degrading the decision exactly one rank, to `ask`, and
 * said in the same breath why it could not pass the value through: the host
 * could not RECEIVE a deferral, so emitting one would have traded a permission
 * bypass for a stranded turn.
 *
 * P2.525 met that prerequisite — the event adapter reads both endings, the
 * resume port is ungated, `tool_deferred` has transcript copy — so the value is
 * now EMITTED and this suite pins the new posture. The degrade and its reason
 * string are gone; a test that still asserted them would be asserting the
 * runtime cannot do something it now does.
 *
 * ## What this suite pins
 *
 * That the decision survives the pipeline (the original defect), that the
 * payload names `defer` and carries NOTHING else, and that the three companion
 * fields the page withholds for this one value stay withheld while still
 * arriving on an `ask` — the positive control without which those assertions
 * would pass against a pipeline that had stopped reading them for every value.
 *
 * Every rank comparison reads `PRE_TOOL_USE_DECISION_PRECEDENCE` rather than
 * restating the ordering, so a change to the documented precedence fails here
 * instead of quietly redefining what the values mean.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import { bracedRegion } from '../../testing/source-regions.ts';
import type { HookPermissionDecision } from '@anthropic-ai/claude-agent-sdk';
import {
  ClaudeAgent,
  buildClaudePreToolUseContinue,
  runClaudePreToolUseHookPipeline,
  TRUSTED_HOOK_ASK_REASON,
} from '../claude-agent.ts';
import {
  PRE_TOOL_USE_DECISION_PRECEDENCE,
  preToolUseDecisionRank,
} from '../../automations/hook-decision-contract.ts';
import type {
  AgentAutomationSystem,
  PreToolUseDecision,
  PreToolUseDecisionValue,
  SdkAutomationInput,
} from '../../automations/types.ts';

const ALLOW: HookPermissionDecision = 'allow';
const ASK: HookPermissionDecision = 'ask';
const DEFER: HookPermissionDecision = 'defer';

type PayloadLike = {
  continue?: boolean;
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
  };
};

/** A PreToolUse automation system returning exactly one decision object. */
function automationReturning(decision: PreToolUseDecision | undefined): AgentAutomationSystem {
  return {
    executeAgentEvent: async () => ({ matchedCount: decision ? 1 : 0, ...(decision ? { decision } : {}) }),
  } as unknown as AgentAutomationSystem;
}

const ORIGINAL_INPUT = { command: 'ls' };

const HOOK_INPUT = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: ORIGINAL_INPUT,
} as unknown as SdkAutomationInput;

/** The live composition: pipeline first, then the payload the SDK is handed. */
async function livePath(decision: PreToolUseDecision | undefined, alreadyApproved = false) {
  const pipeline = await runClaudePreToolUseHookPipeline({
    automationSystem: automationReturning(decision),
    hookInput: HOOK_INPUT,
    revalidate: input => input,
  });
  if (pipeline.kind === 'blocked') throw new Error('unexpected block');
  const payload = buildClaudePreToolUseContinue({
    ...(pipeline.hookDecision ? { hookDecision: pipeline.hookDecision } : {}),
    ...(pipeline.hookReason ? { hookReason: pipeline.hookReason } : {}),
    ...(pipeline.additionalContext ? { additionalContext: pipeline.additionalContext } : {}),
  })(undefined, alreadyApproved) as PayloadLike;
  return { pipeline, payload };
}

describe('P3.262: a defer reaches the payload builder instead of being dropped', () => {
  it('carries the value through the pipeline, where it used to vanish', async () => {
    const { pipeline } = await livePath({ decision: 'defer' });
    // The narrowing this row removed: before it, this field was `undefined` for
    // a defer and the builder could not tell it apart from a hook that ran and
    // said nothing.
    expect(pipeline.kind).toBe('validated');
    if (pipeline.kind !== 'validated') throw new Error('unreachable');
    expect(pipeline.hookDecision).toBe('defer' satisfies PreToolUseDecisionValue);
  });

  it('a hook that says nothing is still distinguishable from one that defers', async () => {
    // The control for the assertion above: `undefined` must stay `undefined`,
    // or "carried" would be indistinguishable from "invented".
    const { pipeline } = await livePath(undefined);
    if (pipeline.kind !== 'validated') throw new Error('unreachable');
    expect(pipeline.hookDecision).toBeUndefined();
  });
});

describe('P2.525: the decision is emitted, at its own rank, carrying nothing else', () => {
  it('names `defer` — not the `allow` it used to, and not the `ask` it degraded to', async () => {
    const { payload } = await livePath({ decision: 'defer' });
    expect(payload.hookSpecificOutput?.permissionDecision).toBe(DEFER);
    expect(payload.hookSpecificOutput?.permissionDecision).not.toBe(ALLOW);
    expect(payload.hookSpecificOutput?.permissionDecision).not.toBe(ASK);
  });

  it('emits the value at ITS OWN rank, read from the precedence record', async () => {
    // Derived, never restated: if the documented ordering changes, this fails
    // rather than silently meaning something else. The whole point of P2.525 is
    // that the rank is no longer lowered, so the assertion is equality.
    const { payload } = await livePath({ decision: 'defer' });
    const emitted = payload.hookSpecificOutput?.permissionDecision as PreToolUseDecisionValue;
    expect(preToolUseDecisionRank(emitted)).toBe(PRE_TOOL_USE_DECISION_PRECEDENCE.defer);
    expect(preToolUseDecisionRank(emitted)).toBeGreaterThan(PRE_TOOL_USE_DECISION_PRECEDENCE.ask);
  });

  it('carries no reason, no updatedInput and no additionalContext', async () => {
    // `permissionDecisionReason` — "For `defer`, ignored"; `updatedInput` — "For
    // `defer`, ignored"; `additionalContext` — "Ignored when `permissionDecision`
    // is `defer`". Three separate sentences, one per field. A payload that sent
    // them anyway would be relying on the runtime to drop what we should not
    // have said.
    const { payload } = await livePath({ decision: 'defer' });
    const out = payload.hookSpecificOutput!;
    expect(out.permissionDecisionReason).toBeUndefined();
    expect(out.updatedInput).toBeUndefined();
    expect(out.additionalContext).toBeUndefined();
    // And nothing else rode along: exactly the event name and the decision.
    expect(Object.keys(out).sort()).toEqual(['hookEventName', 'permissionDecision']);
  });

  it('is NOT satisfied by an approval the user already gave', async () => {
    // `hookAskAlreadyApproved` answers "may this run". A defer is not a question
    // about permission — it is a request to come back later — so an approval
    // already given must not collapse it into an `allow`, which is exactly what
    // the degraded shape did.
    const { payload } = await livePath({ decision: 'defer' }, true);
    expect(payload.hookSpecificOutput?.permissionDecision).toBe(DEFER);
    // THE CONTROL on the same knob: an `ask` still IS satisfied by it, so the
    // assertion above is about `defer` and not about the flag being ignored.
    const askPayload = await livePath({ decision: 'ask' }, true);
    expect(askPayload.payload.hookSpecificOutput?.permissionDecision).toBe(ALLOW);
  });
});

describe('P2.525: the fields the page drops for `defer` stay dropped', () => {
  const RICH: PreToolUseDecision = {
    decision: 'defer',
    reason: 'hook reason that the page ignores for defer',
    updatedInput: { command: 'rm -rf /' },
    additionalContext: 'context the page ignores for defer',
  };

  it('ignores updatedInput, reason and additionalContext on a defer', async () => {
    // Three separate sentences in `hooks.md` § `#pretooluse-decision-control`,
    // one per field. The `updatedInput` case is the sharp one: it is the input
    // the gate revalidates, so honouring it on a value we are refusing would let
    // a defer rewrite the command it was trying to hold.
    const { pipeline, payload } = await livePath(RICH);
    if (pipeline.kind !== 'validated') throw new Error('unreachable');
    expect(pipeline.input).toEqual(ORIGINAL_INPUT);
    expect(pipeline.hookReason).toBeUndefined();
    expect(pipeline.additionalContext).toBeUndefined();
    expect(payload.hookSpecificOutput?.permissionDecisionReason).toBeUndefined();
    expect(payload.hookSpecificOutput?.additionalContext).toBeUndefined();
  });

  it('POSITIVE CONTROL — the same three fields do arrive on an ask', async () => {
    // Without this, the assertions above would pass just as well against a
    // pipeline that had stopped reading those fields for every value.
    const { pipeline, payload } = await livePath({ ...RICH, decision: 'ask' });
    if (pipeline.kind !== 'validated') throw new Error('unreachable');
    expect(pipeline.input).toEqual({ ...ORIGINAL_INPUT, ...RICH.updatedInput });
    expect(pipeline.hookReason).toBe(RICH.reason);
    expect(pipeline.additionalContext).toBe(RICH.additionalContext);
    expect(payload.hookSpecificOutput?.permissionDecisionReason).toBe(RICH.reason);
    expect(payload.hookSpecificOutput?.additionalContext).toBe(RICH.additionalContext);
  });
});

describe('P2.525: the pass-through is logged where an operator meets it', () => {
  const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');

  it('the live PreToolUse callback names the deferred call on the debug channel', () => {
    // The user's half is the transcript verdict the turn's `tool_deferred`
    // ending composes; this reaches whoever is reading logs for "which call is
    // being held". The live callback is nested inside the `query()` options
    // object and has no unit seam, so this is a source-level pin — the same
    // technique the sibling R1 suite uses to prove `continueWith` is bound to
    // the exported builder.
    const branch = source.indexOf("if (hookPipeline.hookDecision === 'defer') {");
    expect(branch).toBeGreaterThan(-1);
    // D1.111 — the branch's own braces. The anchor ENDS in `{`, so the region is
    // that `if` body exactly and no character count has to be maintained.
    const window = bracedRegion(source, branch);
    expect(window).toContain('this.onDebug?.(');
    expect(window).toContain('PreToolUse defer for');
    // BOUNDARY CONTROL: the next declaration below the branch, by its NAME alone —
    // F1.238 wrapped its right-hand side and the fuller needle vanished (F1.308).
    expect(window).not.toContain('const continueWith = ');
    // The refusal is gone, and its sentence with it: a log line still saying
    // "refused" beside a value we now emit is the stale-prose defect class.
    expect(source).not.toContain('PreToolUse defer refused for');
  });
});

/**
 * P2.525: the session's held-call record, written from the RUNTIME's verdict.
 *
 * The port (`onToolCallDeferred` / `getDeferredToolCall`) was `provider === 'pi'`
 * in `SessionManager` on the premise that nothing in this fork keeps a promise
 * to come back. It is ungated in the same commit as the emission above, and the
 * claude backend fills it at the TERMINAL EVENT rather than beside the `defer`
 * it sends — because `hooks.md#defer-a-tool-call-for-later` gives the runtime
 * two documented reasons to decline the value (an interactive session, and a
 * turn carrying more than one tool call) and in both "the tool proceeds through
 * the normal permission flow". A record written when we ASKED would claim a
 * call is held that is already running.
 */
describe('P2.525: the held-call record follows the runtime, not the hook', () => {
  const DEFERRED = {
    id: 'toolu_01held',
    name: 'AskUserQuestion',
    input: { questions: [{ question: 'Which framework?', header: 'Framework' }] },
  };

  function agentWithPort(seed?: unknown) {
    const writes: unknown[] = [];
    let held: unknown = seed;
    const agent = new ClaudeAgent({
      provider: 'anthropic',
      providerType: 'anthropic',
      model: 'claude-sonnet-4-6',
      isHeadless: true,
      skipConfigWatcher: true,
      workspace: {
        id: 'ws-defer-record',
        name: 'Defer Workspace',
        rootPath: '/tmp/ws-defer-record',
        workspaceRootPath: '/tmp/ws-defer-record',
        sessionRootPath: '/tmp/ws-defer-record/sessions',
      } as never,
      session: {
        id: 'session-defer-record',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        workingDirectory: '/tmp/ws-defer-record',
      } as never,
      onToolCallDeferred: (record: unknown) => { writes.push(record); held = record; },
      getDeferredToolCall: () => held,
    } as never);
    const reconcile = (event: Record<string, unknown>) =>
      (agent as unknown as { reconcileDeferredToolCall: (e: unknown) => void })
        .reconcileDeferredToolCall(event);
    return { writes, reconcile, held: () => held };
  }

  it('writes the record from the terminal event, with the runtime\'s own payload', () => {
    const { writes, reconcile } = agentWithPort();
    reconcile({ type: 'complete', terminalReason: 'tool_deferred', deferredToolUse: DEFERRED });
    expect(writes.length).toBe(1);
    expect(writes[0]).toMatchObject({
      schemaVersion: 1,
      toolUseId: DEFERRED.id,
      toolName: DEFERRED.name,
      input: DEFERRED.input,
    });
    // The mode is captured so a resume can apply the documented restore rules,
    // the same field Pi's own record carries.
    expect(typeof (writes[0] as { permissionMode?: unknown }).permissionMode).toBe('string');
  });

  it('THE CONTROL — an ordinary ending writes nothing when nothing is held', () => {
    // Without this the assertion above cannot tell "a deferral is recorded" from
    // "every turn writes a record", and the second would persist the session on
    // every single turn end.
    const { writes, reconcile } = agentWithPort();
    reconcile({ type: 'complete' });
    expect(writes).toEqual([]);
  });

  it('clears a held call on any other ending, including the unavailable exit', () => {
    // `tool_deferred_unavailable` is a RESOLUTION, not a hold: there is nothing
    // left to come back to, so a record that survived it would show a promise
    // the runtime has already broken.
    for (const ending of [
      { type: 'complete' },
      { type: 'complete', terminalReason: 'tool_deferred_unavailable', terminalIsError: true },
      { type: 'complete', terminalReason: 'user_stop' },
    ]) {
      const { writes, reconcile, held } = agentWithPort({ schemaVersion: 1, toolUseId: 'toolu_01held' });
      reconcile(ending);
      expect(writes).toEqual([undefined]);
      expect(held()).toBeUndefined();
    }
  });

  it('does not write a record for a `tool_deferred` that carries no payload', () => {
    // The guard on the pair. Without a `deferred_tool_use` there is no id to
    // come back to, so a record would name nothing.
    const { writes, reconcile } = agentWithPort();
    reconcile({ type: 'complete', terminalReason: 'tool_deferred' });
    expect(writes).toEqual([]);
  });
});

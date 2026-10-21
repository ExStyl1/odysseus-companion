/**
 * P3.124 — the four `permissionDecision` values, measured end to end on the
 * claude runtime's LIVE PreToolUse path, and the one place the answer to
 * "sending a value vs omitting the field" can be read off code rather than
 * inferred.
 *
 * ## Why this suite exists beside `claude-pre-tool-use-permission-decision.test.ts`
 *
 * That suite proves the PAYLOAD BUILDER speaks the SDK vocabulary. It exercises
 * `buildClaudePreToolUseContinue` directly with the two values that builder
 * accepts. What nothing covered is the HOP IN FRONT OF IT: a user, project or
 * plugin PreToolUse hook runs inside `runClaudePreToolUseHookPipeline`, and it
 * is that function which decides which of the union's members survive to reach
 * the builder at all. The two functions have separate, hand-written value
 * unions, and this suite is the only thing that composes them.
 *
 * ## The vocabulary is derived, never restated
 *
 * `PRE_TOOL_USE_DECISION_PRECEDENCE` is a total
 * `Record<PreToolUseDecisionValue, number>` — the ONE union, after P3.193/P3.194
 * collapsed three rank tables into it and P3.196 deleted a fourth, three-valued
 * copy from `plugins/types.ts` rather than promoting it. So the host-side value
 * list below is `Object.keys` of that record, and the SDK-side list is parsed
 * out of the installed `sdk.d.ts`. Neither is spelled here. A sixth host value
 * or a fifth SDK value fails this file instead of arriving unnoticed, which is
 * the failure mode both of those rows were about.
 *
 * ## What it measured (2026-09-01, load average 9.93)
 *
 * Per host decision value, what the SDK is handed:
 *
 * | host value | claude live path | documented meaning of what it gets |
 * | ---------- | ---------------- | ---------------------------------- |
 * | `deny`     | pipeline `blocked`, payload from `denyToolWithReason` | deny |
 * | `block`    | pipeline `blocked`, same                             | deny |
 * | `ask`      | `permissionDecision: "ask"`                          | ask  |
 * | `allow`    | `permissionDecision: "allow"`                        | allow |
 * | `defer`    | `permissionDecision: "defer"`, and nothing else       | defer |
 *
 * The last row WAS the finding, and it read `permissionDecision: "allow"` until
 * P3.262 closed it. `hooks.md` § `#pretooluse-decision-control`: "When multiple
 * PreToolUse hooks return different decisions, precedence is `deny` > `defer` >
 * `ask` > `allow`." A `defer` outranks an `ask`, and on that path the `ask`
 * survived while the `defer` was downgraded to the one value it can never lose
 * to. P3.262 degraded it exactly one rank instead, to `ask`, and named the
 * prerequisite that would let the value through: a host that can RECEIVE a
 * deferral. P2.525 built it — the event adapter reads both endings, the resume
 * port is ungated, `tool_deferred` has transcript copy — so the value now
 * travels as itself, carrying no reason, no `updatedInput` and no
 * `additionalContext`, because the page withholds all three from it. The
 * posture and its measurement live on `buildClaudePreToolUseContinue`.
 *
 * Per-runtime: Pi honours `defer` under the same documented headless and
 * single-call constraints, enforced in its own harness because Pi IS the
 * harness; claude hands the value to a runtime that enforces them itself, and
 * in both declining cases "the tool proceeds through the normal permission
 * flow", i.e. our gate still decides; codex's own `pre-tool-use.command.output`
 * schema has no `defer` member at all, so there the runtime genuinely cannot.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { HookPermissionDecision } from '@anthropic-ai/claude-agent-sdk';
import { buildClaudePreToolUseContinue, runClaudePreToolUseHookPipeline } from '../../../claude-agent.ts';
import { PRE_TOOL_USE_DECISION_PRECEDENCE } from '../../../../automations/hook-decision-contract.ts';
import type {
  AgentAutomationSystem,
  PreToolUseDecision,
  PreToolUseDecisionValue,
  SdkAutomationInput,
} from '../../../../automations/types.ts';

/** Every member of the one host-side union, in precedence order. */
const HOST_DECISION_VALUES = (Object.keys(PRE_TOOL_USE_DECISION_PRECEDENCE) as PreToolUseDecisionValue[])
  .sort((a, b) => PRE_TOOL_USE_DECISION_PRECEDENCE[b] - PRE_TOOL_USE_DECISION_PRECEDENCE[a]);

/**
 * The SDK's own union, read from the installed typings rather than restated —
 * the same technique the sibling suite uses, and the reason a rename in the SDK
 * fails here by name.
 */
function readSdkPermissionDecisions(): string[] {
  const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
  const typingsPath = `${sdkEntry.slice(0, sdkEntry.lastIndexOf('/'))}/sdk.d.ts`;
  const source = readFileSync(typingsPath, 'utf8');
  const match = source.match(/^export declare type HookPermissionDecision = (.+?);$/m);
  if (!match) throw new Error(`Could not find HookPermissionDecision in ${typingsPath}`);
  return match[1]!.split('|').map(value => value.trim().replace(/^'|'$/g, ''));
}

/**
 * Whether the SDK types the field as OPTIONAL. This is the half of the row's
 * question that belongs to the vendor: if the field were required, omitting it
 * would be inexpressible for anyone and the blocker would not be ours.
 */
function sdkPermissionDecisionIsOptional(): boolean {
  const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
  const typingsPath = `${sdkEntry.slice(0, sdkEntry.lastIndexOf('/'))}/sdk.d.ts`;
  const source = readFileSync(typingsPath, 'utf8');
  return /permissionDecision\?: HookPermissionDecision;/.test(source);
}

type PayloadLike = {
  continue?: boolean;
  hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string };
};

/** A PreToolUse automation system that returns exactly one decision. */
function automationReturning(decision: PreToolUseDecision | undefined): AgentAutomationSystem {
  return {
    executeAgentEvent: async () => ({ matchedCount: decision ? 1 : 0, ...(decision ? { decision } : {}) }),
  } as unknown as AgentAutomationSystem;
}

const HOOK_INPUT = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
} as unknown as SdkAutomationInput;

/**
 * Run the live path for one host decision and report what the SDK would be
 * handed: either the terminal block, or the `permissionDecision` string, or the
 * sentinel for an omitted field.
 */
async function wireDecisionFor(decision: PreToolUseDecisionValue | undefined): Promise<string> {
  const pipeline = await runClaudePreToolUseHookPipeline({
    automationSystem: automationReturning(decision ? { decision } : undefined),
    hookInput: HOOK_INPUT,
    revalidate: input => input,
  });
  if (pipeline.kind === 'blocked') return '(pipeline blocked before the payload)';
  const payload = buildClaudePreToolUseContinue({
    ...(pipeline.hookDecision ? { hookDecision: pipeline.hookDecision } : {}),
  })() as PayloadLike;
  return payload.hookSpecificOutput?.permissionDecision ?? '(field omitted)';
}

const BLOCKED = '(pipeline blocked before the payload)';
const OMITTED = '(field omitted)';

describe('P3.124: what the claude live path does with each member of the one union', () => {
  it('exercises every member of the host union, derived rather than restated', () => {
    // A sixth value added to `PreToolUseDecisionValue` lands here first.
    expect(HOST_DECISION_VALUES).toEqual(['deny', 'block', 'defer', 'ask', 'allow']);
  });

  it('still has exactly the four documented SDK values', () => {
    expect(readSdkPermissionDecisions()).toEqual(['allow', 'deny', 'ask', 'defer']);
  });

  it('sends deny and block to the terminal branch, and ask and allow to their own values', async () => {
    expect(await wireDecisionFor('deny')).toBe(BLOCKED);
    expect(await wireDecisionFor('block')).toBe(BLOCKED);
    expect(await wireDecisionFor('ask')).toBe('ask' satisfies HookPermissionDecision);
    expect(await wireDecisionFor('allow')).toBe('allow' satisfies HookPermissionDecision);
  });

  it('CLOSED (P3.262 → P2.525) — a defer reaches the SDK as itself, never as allow', async () => {
    // The residue this row carried asserted `allow` here, deliberately, so the
    // fix could not land unnoticed. The invariant survives both fixes: whatever
    // a defer becomes, it may never be the value the documented precedence says
    // it outranks. P3.262 satisfied that with a one-rank degrade; P2.525 built
    // the receive half the degrade was standing in for, so it is now the value
    // itself.
    expect(await wireDecisionFor('defer')).not.toBe('allow' satisfies HookPermissionDecision);
    expect(await wireDecisionFor('defer')).toBe('defer' satisfies HookPermissionDecision);
    expect(PRE_TOOL_USE_DECISION_PRECEDENCE.defer).toBeGreaterThan(PRE_TOOL_USE_DECISION_PRECEDENCE.ask);
  });
});

describe('P3.124: omitting the field is the SDK\'s to allow and ours to reach', () => {
  it('is optional in the SDK typings, so the vendor is not the blocker', () => {
    expect(sdkPermissionDecisionIsOptional()).toBe(true);
  });

  it('is unreachable from the live emitter under every combination of its inputs', () => {
    // P3.93 arm A4 — a PreToolUse payload carrying NO `permissionDecision` — is
    // the only measured shape that lets the SDK's auto-mode classifier run. Our
    // emitter always names one, so A4 cannot be produced here no matter what a
    // hook says. That is the blocker, and it is ours.
    const emitted = new Set<string>();
    // `defer` joins the cartesian product now that the emitter accepts it: a
    // value the builder can be handed but that this loop never tries would leave
    // the omission claim unproven for exactly that value.
    for (const hookDecision of [undefined, 'allow', 'ask', 'defer'] as const) {
      for (const alreadyApproved of [false, true]) {
        for (const updatedInput of [undefined, { command: 'ls -la' }]) {
          const payload = buildClaudePreToolUseContinue({
            ...(hookDecision ? { hookDecision } : {}),
          })(updatedInput, alreadyApproved) as PayloadLike;
          emitted.add(payload.hookSpecificOutput?.permissionDecision ?? OMITTED);
        }
      }
    }
    expect(emitted.has(OMITTED)).toBe(false);
    expect([...emitted].sort()).toEqual(['allow', 'ask', 'defer']);
  });

  it('reaches the emitter for every non-terminal hook value, so nothing else can omit it', async () => {
    for (const value of HOST_DECISION_VALUES) {
      const wire = await wireDecisionFor(value);
      expect(wire).not.toBe(OMITTED);
    }
    expect(await wireDecisionFor(undefined)).toBe('allow' satisfies HookPermissionDecision);
  });
});

/**
 * UB12.98 — a Claude-contract PreToolUse hook's deprecated top-level
 * `decision: "approve"` is an `allow`.
 *
 * `hooks.md#pretooluse-decision-control` (curl'd 2026-10-17), verbatim:
 * "PreToolUse previously used top-level `decision` and `reason` fields, but
 * these are deprecated for this event. Use `hookSpecificOutput.permissionDecision`
 * and `hookSpecificOutput.permissionDecisionReason` instead. The deprecated
 * values `"approve"` and `"block"` map to `"allow"` and `"deny"` respectively."
 *
 * The premise at HEAD (`52ef711fd`): since UB12.70 (`f7cb6ea78`) `approve`
 * passes the bundle's output schema (`SyncHookJSONOutput` `decision?:
 * 'approve' | 'block'`), but `parseHookCommandOutput` ranked only `allow`,
 * `ask`, `block`, `deny` and `defer`, so `{"decision":"approve"}` gave no
 * candidate: no decision, no notice, and the call went to the normal
 * permission flow. `block` already ranked with `deny` and needs no mapping.
 */
import { describe, expect, it } from 'bun:test';
import { parseHookCommandOutput } from '../../automations/hook-command.ts';
import { isBlockingHookDecision } from '../../automations/hook-decision-contract.ts';
import { executePluginHookAutomations } from '../hooks-automation.ts';
import type { AgentEvent, AutomationsConfig, HookCommandAction, HookCommandActionResult } from '../../automations/types.ts';

const workspaceRootPath = process.cwd();
const CLAUDE_CONTRACT: Partial<HookCommandAction> = { blockOnNonZero: false };

function commandConfig(event: AgentEvent, action: Partial<HookCommandAction>): AutomationsConfig {
  return {
    automations: {
      [event]: [{ id: 'policy/guard', name: 'policy/guard', actions: [{ type: 'command', command: './guard.sh', ...action }] }],
    },
  } as unknown as AutomationsConfig;
}

function exit0(stdout: string): HookCommandActionResult {
  return { type: 'command', command: './guard.sh', success: true, exitCode: 0, signal: null, durationMs: 1, stdout };
}

function inputFor(event: AgentEvent) {
  return event === 'PreToolUse' || event === 'PermissionRequest'
    ? { hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'ls' } }
    : { hook_event_name: event };
}

async function fireCommand(event: AgentEvent, action: Partial<HookCommandAction>, output: object) {
  return executePluginHookAutomations(commandConfig(event, action), event, inputFor(event), {
    workspaceRootPath,
    runner: async () => exit0(JSON.stringify(output)),
  });
}

describe('UB12.98 — PreToolUse\'s deprecated top-level "approve" and "block"', () => {
  it('POSITIVE: a Claude-contract command hook\'s {"decision":"approve"} allows, its reason kept, with no notice', async () => {
    const result = await fireCommand('PreToolUse', CLAUDE_CONTRACT, { decision: 'approve', reason: 'ls is read-only' });
    expect(result.decision?.decision).toBe('allow');
    expect(result.decision?.reason).toBe('ls is read-only');
    expect(result.hookErrors).toBeUndefined();
    expect(result.hookRuns?.map(run => run.outcome)).toEqual(['success']);
  });

  it('through the existing precedence: a nested "ask" or "deny" beside the approve wins', async () => {
    const asked = await fireCommand('PreToolUse', CLAUDE_CONTRACT, {
      decision: 'approve',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
    });
    expect(asked.decision?.decision).toBe('ask');
    const denied = await fireCommand('PreToolUse', CLAUDE_CONTRACT, {
      decision: 'approve',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'policy says no' },
    });
    expect(denied.decision?.decision).toBe('deny');
  });

  it('an http body\'s approve allows too — a body is read under Claude\'s contract', async () => {
    const config = {
      automations: { PreToolUse: [{ id: 'policy', actions: [{ type: 'plugin-http', http: { url: 'https://example.invalid/policy' } }] }] },
    } as unknown as AutomationsConfig;
    const result = await executePluginHookAutomations(config, 'PreToolUse', inputFor('PreToolUse'), {
      workspaceRootPath,
      httpRunner: async () => ({ body: JSON.stringify({ decision: 'approve' }) }),
    });
    expect(result.decision?.decision).toBe('allow');
    expect(result.hookErrors).toBeUndefined();
  });

  it('"block" is the deny it maps to, and outranks a nested allow', async () => {
    const result = await fireCommand('PreToolUse', CLAUDE_CONTRACT, {
      decision: 'block',
      reason: 'not on main',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
    expect(isBlockingHookDecision(result.decision)).toBe(true);
    expect(result.decision?.reason).toBe('not on main');
  });

  it('NEGATIVE: approve on Stop decides nothing', async () => {
    const result = await fireCommand('Stop', CLAUDE_CONTRACT, { decision: 'approve' });
    expect(result.decision?.decision).toBeUndefined();
    expect(result.hookErrors).toBeUndefined();
  });

  it('NEGATIVE: approve on the events whose surface DOES take an allow still decides nothing — the page maps it on PreToolUse alone', async () => {
    for (const event of ['PermissionRequest', 'PreModelSwitch'] as const) {
      const result = await fireCommand(event, CLAUDE_CONTRACT, { decision: 'approve' });
      expect({ event, decision: result.decision?.decision }).toEqual({ event, decision: undefined });
    }
  });

  it('BOUNDARY: a native hook\'s approve is still nothing — its own vocabulary never had it', async () => {
    const native = await fireCommand('PreToolUse', {}, { decision: 'approve' });
    expect(native.decision?.decision).toBeUndefined();
    // Control on the same instrument: the native vocabulary's own allow decides.
    const nativeAllow = await fireCommand('PreToolUse', {}, { decision: 'allow' });
    expect(nativeAllow.decision?.decision).toBe('allow');
    // And the event-agnostic parse, with no reading, keeps its old answer.
    expect(parseHookCommandOutput('{"decision":"approve"}')).toBeUndefined();
    expect(parseHookCommandOutput('{"decision":"approve"}', { event: 'PreToolUse', claudeContract: true })).toEqual({ decision: 'allow' });
  });
});

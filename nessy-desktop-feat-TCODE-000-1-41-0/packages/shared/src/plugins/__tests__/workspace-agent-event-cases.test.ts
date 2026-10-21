/**
 * F1.10 (origin D1.366) — the agent-event cases `automations/automation-system.test.ts`
 * drove through `AutomationSystem.executeAgentEvent`, re-homed onto the executor
 * a workspace `automations.json` agent-event entry really reaches.
 *
 * That method had no production caller (D1.351: the only production
 * `new AutomationSystem` is `SessionManager`'s per-workspace system, built for
 * the scheduler and the App-event handlers, and `buildPinnedAgentAutomationSystem`
 * never passes `nativeSystem`), so F1.10 removed it. The entry itself is not
 * dead: `capabilities/native-sources.ts` registers `automations.json` as a
 * workspace-scoped automation resource, `capabilities/runtime-automations.ts`
 * parses it with `parseHooksConfigContent` and files it as the WORKSPACE tier
 * (`workspaceHookConfig`, D1.429), and `PluginScopedAutomationSystem` dispatches
 * that tier through `executePluginHookAutomations`. Each case below is built the
 * same way — the same parser over the same document shape, the same tier — so it
 * pins what a session really does with the entry the old case described.
 *
 * Re-homed here, one for one: the matcher-and-conditions pair, the PreToolUse
 * `decision` action returned to the caller, PermissionDenied as observational,
 * TaskCreated/TaskCompleted as canonical and observational. The two agent-event
 * WEBHOOK cases were deleted rather than re-homed: on this executor a `webhook`
 * action is the `http` hook under its stored name, which fires only through an
 * injected runner under the network permission contract, and that contract is
 * already driven by `hooks-automation.test.ts` ("fires an http hook only under
 * the network permission contract…") and `hook-runner-authority-notices.test.ts`
 * (an http hook with no runner is reported, with one it fires). The removed path
 * delivered agent-event webhooks to the workspace's `onWebhookResults`, which no
 * production caller ever reached.
 */
import { describe, expect, it } from 'bun:test';
import { PluginScopedAutomationSystem } from '../hooks-automation.ts';
import { parseHooksConfigContent } from '../../automations/hooks-config.ts';
import { AGENT_EVENTS } from '../../automations/types.ts';

/** A system whose only hooks are one workspace `automations.json`, filed as runtime-automations files it. */
function workspaceSystem(automations: Record<string, unknown>): PluginScopedAutomationSystem {
  const parsed = parseHooksConfigContent(JSON.stringify({ automations }), 'automations.json');
  expect(parsed.errors).toEqual([]);
  return new PluginScopedAutomationSystem({
    workspaceHookConfig: parsed.config,
    pluginHookConfig: { automations: {} },
    workspaceRootPath: '/tmp/f1-10-workspace',
  });
}

const BASH_INPUT = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo original' },
} as const;

describe('F1.10 — workspace automations.json agent-event entries, on the executor that runs them', () => {
  it('matches an agent event when the matcher and its conditions pass', async () => {
    const system = workspaceSystem({
      PreToolUse: [{
        matcher: '^Bash$',
        conditions: [{ condition: 'state', field: 'hook_event_name', value: 'PreToolUse' }],
        actions: [{ type: 'decision', decision: 'allow', additionalContext: 'matched' }],
      }],
    });
    const result = await system.executeAgentEvent('PreToolUse', BASH_INPUT);
    expect({ matchedCount: result.matchedCount, context: result.decision?.additionalContext })
      .toEqual({ matchedCount: 1, context: 'matched' });
  });

  it('does not match when a condition fails', async () => {
    const system = workspaceSystem({
      PreToolUse: [{
        matcher: '^Bash$',
        conditions: [{ condition: 'state', field: 'hook_event_name', value: 'PostToolUse' }],
        actions: [{ type: 'decision', decision: 'allow', additionalContext: 'matched' }],
      }],
    });
    const result = await system.executeAgentEvent('PreToolUse', BASH_INPUT);
    expect({ matchedCount: result.matchedCount, decision: result.decision }).toEqual({ matchedCount: 0, decision: undefined });
  });

  it('returns a PreToolUse decision action to the caller', async () => {
    const system = workspaceSystem({
      PreToolUse: [{
        matcher: '^Bash$',
        actions: [{
          type: 'decision',
          decision: 'allow',
          updatedInput: { command: 'echo rewritten' },
          additionalContext: 'Use the rewritten command.',
        }],
      }],
    });
    expect(await system.executeAgentEvent('PreToolUse', BASH_INPUT)).toEqual({
      matchedCount: 1,
      decision: {
        decision: 'allow',
        updatedInput: { command: 'echo rewritten' },
        additionalContext: 'Use the rewritten command.',
      },
    });
  });

  it('treats PermissionDenied as observational: it matches, and not even a deny becomes a policy decision', async () => {
    expect(AGENT_EVENTS.filter(event => event === 'PermissionDenied')).toHaveLength(1);
    const system = workspaceSystem({
      PermissionDenied: [{ matcher: '.*', actions: [{ type: 'decision', decision: 'deny', reason: 'observed' }] }],
    });
    const result = await system.executeAgentEvent('PermissionDenied', { hook_event_name: 'PermissionDenied', tool_name: 'Bash' });
    expect({ matchedCount: result.matchedCount, decision: result.decision?.decision }).toEqual({ matchedCount: 1, decision: undefined });
  });

  it('keeps TaskCreated and TaskCompleted canonical and observational', async () => {
    expect(AGENT_EVENTS.filter(event => event === 'TaskCreated')).toHaveLength(1);
    expect(AGENT_EVENTS.filter(event => event === 'TaskCompleted')).toHaveLength(1);
    const system = workspaceSystem({});
    expect(await system.executeAgentEvent('TaskCreated', { hook_event_name: 'TaskCreated', task_id: 'task-1' })).toEqual({ matchedCount: 0 });
    expect(await system.executeAgentEvent('TaskCompleted', { hook_event_name: 'TaskCompleted', task_id: 'task-1' })).toEqual({ matchedCount: 0 });
  });
});

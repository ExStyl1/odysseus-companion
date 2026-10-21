/**
 * R20 Task 4 — `TaskCreated` and `TaskCompleted` become decision-bearing.
 *
 * They already existed in `AGENT_EVENT_CONTRACTS_V1` as `observational`, and
 * R9 already classified them `exit-code-only` in the decision table. What was
 * missing is that the `exit-code-only` surface carried NO decision values, so
 * `hookEventCanDecide` was false, so `automation-system.ts` took the
 * stdout-parsing branch instead of the one that reads the exit code — and exit
 * 2 was silently dropped.
 *
 * Contract source, `hooks.md`:
 * - `:708-709` — exit code 2 "Rolls back the task creation" / "Prevents the
 *   task from being marked as completed".
 * - `:2064`, `:2119` — "the stderr message is fed back to the model as
 *   feedback. To stop the teammate entirely instead of re-running it, return
 *   JSON with `{"continue": false, "stopReason": "..."}`."
 * - `:262` — these events "don't support matchers and always fire on every
 *   occurrence. If you add a `matcher` field to these events, it is silently
 *   ignored."
 * - `:2068`, `:2123` — inputs are `task_id`, `task_subject`, and optionally
 *   `task_description`, `teammate_name`, `team_name`.
 * - `:2117` — `TaskCompleted` "fires in two situations: when any agent
 *   explicitly marks a task as completed through the TaskUpdate tool, or when
 *   an agent team teammate finishes its turn with in-progress tasks."
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginScopedAutomationSystem } from '../plugins/hooks-automation.ts';
import { AGENT_EVENT_CONTRACTS_V1, getAgentEventContractV1 } from './types.ts';
import {
  hookDecisionPattern,
  hookEventCanDecide,
  isBlockingHookDecision,
} from './hook-decision-contract.ts';
import { matcherMatchesSdk } from './utils.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'r20-task-hooks-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * D1.354 — the settings tier, through the executor that dispatches it.
 *
 * This helper built an `AutomationSystem` over a real `hooks.json` until
 * D1.351 measured that class's `executeAgentEvent` as having no production
 * caller at all. A workspace hooks file reaches a session through
 * `runtime-automations.ts`, which files it into `userGlobalHookConfig` and
 * dispatches it through `executePluginHookAutomations` — which is what
 * `PluginScopedAutomationSystem` does here, under the same direct-spawn
 * authority (`allowDirectCommandRunner`, the opt-in
 * `buildPinnedAgentAutomationSystem` really passes for the non-Pi providers).
 * Same real commands, same assertions, on a path that runs.
 */
function systemWithHook(event: 'TaskCreated' | 'TaskCompleted', command: string, matcher?: string) {
  return new PluginScopedAutomationSystem({
    userGlobalHookConfig: {
      automations: { [event]: [{ ...(matcher ? { matcher } : {}), actions: [{ type: 'command', command }] }] },
    } as never,
    pluginHookConfig: { automations: {} },
    workspaceRootPath: tempDir,
    workingDir: tempDir,
    allowDirectCommandRunner: true,
  });
}

// `as const` on a NAMED variable makes this a `readonly` tuple, and none of
// bun:test's three `each` overloads accepts one holding scalars — the
// scalar overload is `each<const T>(table: T[])`, mutable. The callback
// parameter then infers as `unknown` and every use of it below is an error.
// Spelling the element type instead keeps the literal union AND matches that
// overload. (Inline `as const` at the call site does work, which is why the
// sibling hook-decision-contract.test.ts never showed this.)
const events: ('TaskCreated' | 'TaskCompleted')[] = ['TaskCreated', 'TaskCompleted'];

describe('the contract entries are decision-bearing', () => {
  it.each(events)('%s is kind: decision, owned by task-service', event => {
    const contract = getAgentEventContractV1(event, 1);
    expect(contract.kind).toBe('decision');
    expect(contract.owner).toBe('task-service');
  });

  it('no other event silently changed kind', () => {
    const decisionEvents = AGENT_EVENT_CONTRACTS_V1
      .filter(contract => contract.kind === 'decision')
      .map(contract => contract.event)
      .sort();
    // R24 added the two elicitation events: hooks.md:2735/:2783 give both a real
    // `hookSpecificOutput.{action, content}` surface that answers the MCP server.
    // P3.374 added `PreModelSwitch` — hooks.md#premodelswitch: "Can block the
    // switch", with allow/ask/deny and `decision: "block"`. Its twin
    // `PostModelSwitch` is deliberately NOT here: "It can't block, because the
    // model has already changed."
    expect(decisionEvents).toEqual([
      'ElicitationResult', 'McpElicitation', 'PermissionRequest', 'PreModelSwitch', 'PreToolUse',
      'TaskCompleted', 'TaskCreated',
    ]);
  });

  it.each(events)('%s keeps its documented exit-code-only pattern but can now decide', event => {
    // The pattern is unchanged — it is the SURFACE that gains a block value.
    expect(hookDecisionPattern(event)).toBe('exit-code-only');
    expect(hookEventCanDecide(event)).toBe(true);
  });
});

describe('exit code 2 blocks, and the model is told why', () => {
  it.each(events)('%s: exit 2 produces a blocking decision carrying stderr', async event => {
    const system = systemWithHook(event, 'echo "subject must start with a ticket number" >&2; exit 2');
    const result = await system.executeAgentEvent(event, {
      hook_event_name: event,
      task_id: 'task-001',
      task_subject: 'Implement user authentication',
    });

    expect(result.matchedCount).toBe(1);
    expect(isBlockingHookDecision(result.decision)).toBe(true);
    // hooks.md:2097 — "the stderr message is fed back to the model as feedback".
    expect(result.decision?.reason).toContain('subject must start with a ticket number');
  });

  it.each(events)('%s: exit 0 does not block', async event => {
    const system = systemWithHook(event, 'exit 0');
    const result = await system.executeAgentEvent(event, { hook_event_name: event, task_id: 'task-001' });

    expect(result.matchedCount).toBe(1);
    expect(isBlockingHookDecision(result.decision)).toBe(false);
  });

  it.each(events)('%s: {continue:false, stopReason} stops the agent', async event => {
    const system = systemWithHook(
      event,
      `printf %s '{"continue":false,"stopReason":"halting the teammate"}'`,
    );
    const result = await system.executeAgentEvent(event, { hook_event_name: event, task_id: 'task-001' });

    // The universal half is what a `Stop`-shaped halt reads; the decision half
    // is what refuses the task operation.
    expect(result.universal?.continue).toBe(false);
    expect(result.universal?.stopReason).toBe('halting the teammate');
    expect(isBlockingHookDecision(result.decision)).toBe(true);
  });
});

describe('the documented inputs reach the hook', () => {
  it.each(events)('%s receives task_id, task_subject and task_description', async event => {
    // Native command hooks take their input through the environment, not stdin
    // (`runHookCommand` spawns with stdio ignored), so the documented fields
    // have to be present as NESSY_* vars as well as inside NESSY_EVENT_DATA.
    const marker = join(tempDir, 'payload.json');
    const system = systemWithHook(
      event,
      `printf '%s\\n%s\\n%s\\n%s' "$NESSY_TASK_ID" "$NESSY_TASK_SUBJECT" "$NESSY_TASK_DESCRIPTION" "$NESSY_EVENT_DATA" > ${JSON.stringify(marker)}`,
    );
    await system.executeAgentEvent(event, {
      hook_event_name: event,
      task_id: 'task-001',
      task_subject: 'Implement user authentication',
      task_description: 'Add login and signup endpoints',
    });

    const [taskId, subject, description, ...rest] = (await Bun.file(marker).text()).split('\n');
    expect(taskId).toBe('task-001');
    expect(subject).toBe('Implement user authentication');
    expect(description).toBe('Add login and signup endpoints');

    // NESSY_EVENT_DATA is shell-sanitised rather than raw JSON, so assert on
    // its content rather than re-parsing it.
    const eventData = rest.join('\n');
    expect(eventData).toContain(event);
    expect(eventData).toContain('Implement user authentication');
  });
});

describe('matchers are silently ignored — the hook always fires', () => {
  it.each(events)('%s fires despite a matcher that could never match', async event => {
    // hooks.md:262 — "If you add a `matcher` field to these events, it is
    // silently ignored." Before R20 these events had no match value at all, so
    // any matcher meant the hook never ran.
    const system = systemWithHook(event, 'exit 2', '^SomethingElse$');
    const result = await system.executeAgentEvent(event, { hook_event_name: event, task_id: 'task-001' });

    expect(result.matchedCount).toBe(1);
    expect(isBlockingHookDecision(result.decision)).toBe(true);
  });

  it.each(events)('%s ignores a matcher at the matcher predicate itself', event => {
    for (const matcher of ['^Bash$', 'never-matches', '*']) {
      expect(matcherMatchesSdk({ matcher, actions: [] } as never, event, {
        hook_event_name: event,
        task_id: 'task-001',
      } as never)).toBe(true);
    }
  });

  it('an explicitly disabled matcher is still honoured', () => {
    // "Silently ignored" is about the MATCHER field, not about the enabled flag:
    // a disabled automation must stay disabled.
    expect(matcherMatchesSdk({ enabled: false, actions: [] } as never, 'TaskCreated', {
      hook_event_name: 'TaskCreated',
      task_id: 'task-001',
    } as never)).toBe(false);
  });

  it('an event that DOES support matchers is unaffected', () => {
    expect(matcherMatchesSdk({ matcher: '^Bash$', actions: [] } as never, 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
    } as never)).toBe(false);
  });
});

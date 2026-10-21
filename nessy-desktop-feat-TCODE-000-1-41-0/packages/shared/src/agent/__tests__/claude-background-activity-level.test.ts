/**
 * UA4.8 — the Claude background-task level WITHOUT the SDK's `ambient` tasks, which the Tasks Conductor's settlement
 * gate reads (`SessionManager.getBackendBackgroundActivity` → `AgentBackend.backgroundActivityCount`).
 *
 * The contract sentence (vendored `sdk.d.ts`, `SDKBackgroundTasksChangedMessage.tasks[].ambient`): "True for tasks
 * that are not activity (every skip_transcript task, plus every live-update watcher, requested or auto-started); hosts
 * should exclude them from activity indicators." A node whose only live task is an ambient watcher is not doing work
 * the DAG waits for, so counting it would hold the node `running` for as long as the watcher lives.
 *
 * Positive: a non-ambient task counts, and the count falls back to zero when the payload empties.
 * Negative: an ambient task is NOT counted by the activity level while the liveness level
 * (`backgroundTaskCount`, read by the idle reaper and the ceiling) still counts it.
 *
 * Follow-up 3 (verifier finding, UA4.8): when the task ends, the level empties and the CLI opens a turn OF ITS OWN to
 * deliver the result (F1.492; F1.509's `runtimeOwnTurn` marker, expected from the `task_notification`, F1.524 (1)).
 * That turn writes the node's real answer and may edit files, so the activity level holds 1 through it — driven here
 * through the agent's real between-turns routing (no slot open). Boundary: the marker's end (the turn's `result`, or
 * the start bound when no turn follows) returns the level to 0, so the gate never holds a node for good.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { ClaudeEventAdapter, type ClaudeAdapterCallbacks } from '../backend/claude/event-adapter.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

// Importing `claude-agent.ts` is this file's wall-clock cost; the cases are milliseconds.
setDefaultTimeout(120_000);

function callbacks(): ClaudeAdapterCallbacks {
  return {
    onDebug: undefined,
    mapSDKError: async () => ({
      type: 'typed_error' as const,
      error: { code: 'unknown_error', title: 't', message: 'm', details: [], actions: [], canRetry: false },
    }),
  } as ClaudeAdapterCallbacks;
}

function level(tasks: Array<{ task_id: string; task_type: string; description: string; ambient?: boolean }>): unknown {
  return { type: 'system', subtype: 'background_tasks_changed', tasks, uuid: `u-${Math.random()}`, session_id: 'sdk-ua4-8' };
}

describe('UA4.8 — the Claude background ACTIVITY level excludes ambient tasks', () => {
  it('a background agent counts; the level falls to zero when the payload empties (positive)', async () => {
    const adapter = new ClaudeEventAdapter(callbacks());
    await adapter.adapt(level([{ task_id: 'a1', task_type: 'local_agent', description: 'bg agent' }]) as never);
    expect(adapter.activityBackgroundTaskCount).toBe(1);
    expect(adapter.backgroundTaskCount).toBe(1);
    await adapter.adapt(level([]) as never);
    expect(adapter.activityBackgroundTaskCount).toBe(0);
    expect(adapter.backgroundTaskCount).toBe(0);
  });

  it('an ambient watcher is not activity, while the liveness level still counts it (negative)', async () => {
    const adapter = new ClaudeEventAdapter(callbacks());
    await adapter.adapt(level([
      { task_id: 'w1', task_type: 'local_bash', description: 'watcher', ambient: true },
      { task_id: 'b1', task_type: 'local_bash', description: 'npm test' },
    ]) as never);
    expect(adapter.backgroundTaskCount).toBe(2);
    expect(adapter.activityBackgroundTaskCount).toBe(1);
    await adapter.adapt(level([{ task_id: 'w1', task_type: 'local_bash', description: 'watcher', ambient: true }]) as never);
    expect(adapter.backgroundTaskCount).toBe(1);
    expect(adapter.activityBackgroundTaskCount).toBe(0);
  });

  it('ClaudeAgent.backgroundActivityCount reads the adapter\'s activity level, not the liveness level', () => {
    const method = (ClaudeAgent.prototype as unknown as { backgroundActivityCount?: () => number }).backgroundActivityCount;
    expect(typeof method).toBe('function');
    const fake = { eventAdapter: { activityBackgroundTaskCount: 1, backgroundTaskCount: 3 } };
    expect(method!.call(fake)).toBe(1);
  });
});

const OWN_TURN_ROOT = '/tmp/nessy-ua4-8-own-turn';
/** The agent's real routing and level, reached past `private` (an intersection with the class would be `never`). */
interface RoutingAgent {
  routeLiveMessage(message: unknown): Promise<void>;
  backgroundActivityCount(): number;
  runtimeOwnTurnStartBoundMs: number;
  destroy?: () => void;
}

function ownTurnAgent(): RoutingAgent {
  return new ClaudeAgent({
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-ua4-8-own', name: 'UA4.8', rootPath: OWN_TURN_ROOT, workspaceRootPath: OWN_TURN_ROOT,
      sessionRootPath: `${OWN_TURN_ROOT}/sessions`,
    } as never,
    session: { id: 'ua4-8-own', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: OWN_TURN_ROOT } as never,
    onBetweenTurnsEvent: () => {},
  } as BackendConfig) as unknown as RoutingAgent;
}

const notification = (taskId: string) => ({
  type: 'system', subtype: 'task_notification', task_id: taskId, status: 'completed',
  output_file: '/tmp/ua4-8/out.txt', summary: 'done', session_id: 'sdk-ua4-8', uuid: `n-${taskId}`,
});
const ownInit = { type: 'system', subtype: 'init', session_id: 'sdk-ua4-8', uuid: 'u-own-init' };
const ownReply = {
  type: 'assistant', parent_tool_use_id: null, session_id: 'sdk-ua4-8', uuid: 'a-own',
  message: { id: 'msg_a-own', role: 'assistant', content: [{ type: 'text', text: 'the real answer' }] },
};
const ownResult = {
  type: 'result', subtype: 'success', result: 'the real answer', num_turns: 1,
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
};

describe('UA4.8 follow-up 3 — the activity level holds through the turn the CLI opens to deliver a task', () => {
  let agent: RoutingAgent | null = null;
  afterEach(() => {
    try { agent?.destroy?.(); } catch { /* best effort */ }
    agent = null;
  });

  it('a background agent ends between turns: the level stays 1 until the delivery turn\'s result (positive)', async () => {
    const a = ownTurnAgent();
    agent = a;
    await a.routeLiveMessage(level([{ task_id: 'bg1', task_type: 'local_agent', description: 'bg agent' }]));
    expect(a.backgroundActivityCount()).toBe(1);
    await a.routeLiveMessage(level([]));
    await a.routeLiveMessage(notification('bg1'));
    expect(a.backgroundActivityCount()).toBe(1); // expected: the CLI opens its own turn tens of ms later
    await a.routeLiveMessage(ownInit);
    expect(a.backgroundActivityCount()).toBe(1);
    await a.routeLiveMessage(ownReply);
    expect(a.backgroundActivityCount()).toBe(1); // the reply is being written: dependents must not start
    await a.routeLiveMessage(ownResult);
    expect(a.backgroundActivityCount()).toBe(0); // boundary: the delivery turn ended
  });

  it('a notification no turn follows releases the hold after the start bound (boundary)', async () => {
    const a = ownTurnAgent();
    agent = a;
    a.runtimeOwnTurnStartBoundMs = 30;
    await a.routeLiveMessage(notification('bg2'));
    expect(a.backgroundActivityCount()).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(a.backgroundActivityCount()).toBe(0);
  });
});

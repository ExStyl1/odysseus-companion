/**
 * UA12.18 — the Claude half of the background-task chip lifecycle.
 *
 * Three facts the renderer's chip needs from this side, each with its control:
 *
 *  1. THE FEED NAMES THE CALL THAT STARTED EACH TASK. A row rebuilt from
 *     `background_tasks_replaced` used to carry `toolUseId = taskId`, while
 *     `task_progress` is keyed by the starting call's `tool_use_id` — so no
 *     progress ever reached such a row and its elapsed/liveness could not move.
 *     `task_started` carries that `tool_use_id`; the feed now repeats it.
 *  2. ONLY THE SESSION'S OWN AGENT MINTS A ROW FROM A TOOL RESULT. A subagent's
 *     own background launch (a sidechain result, `parent_tool_use_id` set) is
 *     that subagent's to track. Upstream v0.14.0 wrote the filter `=== null`;
 *     ours passes an ABSENT `parent_tool_use_id` for a main-line result, so the
 *     filter is `== null` and the absent case is pinned.
 *  3. THE DECISION: Claude stays OFF `task_backgrounded` from `task_started` /
 *     `task_updated(is_backgrounded)` (upstream v0.14.0's creation half). Our
 *     native REPLACE feed already rows every Claude background task, and
 *     `task_backgrounded` is the Pi registration seam in `SessionManager` (it
 *     writes `piBackgroundTaskKinds` and retains a child authority). UA12.192
 *     REVISED it for `local_bash` alone: that arm IS ported (`shell_backgrounded`).
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { ClaudeEventAdapter, type ClaudeAdapterCallbacks } from '../backend/claude/event-adapter.ts';
import { ToolIndex, extractToolResults, type ContentBlock } from '../tool-matching.ts';

function createCallbacks(): ClaudeAdapterCallbacks {
  return {
    onDebug: undefined,
    mapSDKError: async () => ({
      type: 'typed_error' as const,
      error: { code: 'unknown_error', title: 'T', message: 'M', details: [], actions: [], canRetry: false },
    }),
  };
}

const started = (taskId: string, toolUseId: string | undefined, extra: Record<string, unknown> = {}) => ({
  type: 'system', subtype: 'task_started', task_id: taskId,
  ...(toolUseId ? { tool_use_id: toolUseId } : {}),
  description: `task ${taskId}`, uuid: 'u', session_id: 's', ...extra,
});

const changed = (tasks: Array<{ task_id: string; task_type?: string; description?: string }>) => ({
  type: 'system', subtype: 'background_tasks_changed', tasks, uuid: 'u', session_id: 's',
});

type Row = { taskId: string; toolUseId?: string; description?: string; taskType?: string };
const rowsOf = (events: readonly unknown[]): Row[] | undefined =>
  (events.find(e => (e as { type: string }).type === 'background_tasks_replaced') as { tasks: Row[] } | undefined)?.tasks;

describe('UA12.18 — the feed carries the starting call of each task', () => {
  let adapter: ClaudeEventAdapter;
  beforeEach(() => {
    adapter = new ClaudeEventAdapter(createCallbacks());
    adapter.startTurn();
  });

  it('a task seen at task_started is fed with that call\'s tool_use_id, the key task_progress uses', async () => {
    await adapter.adapt(started('agent-1', 'toolu_agent_1', { task_type: 'local_agent', is_backgrounded: true }) as any);
    const events = await adapter.adapt(changed([{ task_id: 'agent-1', task_type: 'local_agent', description: 'Review' }]) as any);
    expect(rowsOf(events)).toEqual([
      { taskId: 'agent-1', description: 'Review', taskType: 'local_agent', toolUseId: 'toolu_agent_1' },
    ]);
    // And the progress the SDK sends for that task is addressed to the same key.
    const progress = await adapter.adapt({
      type: 'system', subtype: 'task_progress', task_id: 'agent-1', tool_use_id: 'toolu_agent_1',
      description: 'Review', usage: { total_tokens: 10, tool_uses: 1, duration_ms: 7_000 }, uuid: 'u', session_id: 's',
    } as any);
    expect(progress.find(e => e.type === 'task_progress')).toMatchObject({ toolUseId: 'toolu_agent_1', elapsedSeconds: 7 });
  });

  it('a task never seen with a tool_use_id carries no toolUseId at all (never a guessed one)', async () => {
    await adapter.adapt(started('orphan-1', undefined) as any);
    const events = await adapter.adapt(changed([{ task_id: 'orphan-1' }, { task_id: 'unseen-2' }]) as any);
    const rows = rowsOf(events)!;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect('toolUseId' in row).toBe(false);
  });

  it('a CLI restart drops the attribution with the dead child\'s tasks', async () => {
    await adapter.adapt(started('agent-1', 'toolu_agent_1') as any);
    await adapter.adapt(changed([{ task_id: 'agent-1' }]) as any);
    const reset = adapter.resetBackgroundTaskLevel();
    expect(rowsOf(reset)).toEqual([]);
    // A new child that happens to reuse the id is not attributed to the old call.
    const events = await adapter.adapt(changed([{ task_id: 'agent-1' }]) as any);
    expect(rowsOf(events)).toEqual([{ taskId: 'agent-1' }]);
  });
});

// UA12.192 (P-LF-6-1) — the decision above is REVISED for `local_bash` only: v0.14.0's `local_bash` arm is ported, so
// a main-line Claude background Bash is a `shell_backgrounded` (a Shell chip; `backgroundShellCommands`, so the Stop
// hook's `background_tasks`, `/tasks` and `killShell` see it). Monitor and MCP tasks stay off (no `task_backgrounded`
// kind 'task': that event is the Pi registration seam in SessionManager).
describe('UA12.192 — the local_bash arm: a main-line Claude background Bash is a shell, announced once', () => {
  let adapter: ClaudeEventAdapter;
  beforeEach(() => {
    adapter = new ClaudeEventAdapter(createCallbacks());
    adapter.startTurn();
  });

  const assistantCalls = (calls: Array<{ id: string; name: string; input: Record<string, unknown> }>, parent: string | null) => ({
    type: 'assistant', parent_tool_use_id: parent, uuid: 'u', session_id: 's',
    message: { role: 'assistant', content: calls.map(c => ({ type: 'tool_use', ...c })) },
  });
  const updated = (taskId: string, patch: Record<string, unknown>) => ({
    type: 'system', subtype: 'task_updated', task_id: taskId, patch, uuid: 'u', session_id: 's',
  });
  const shellsOf = (events: readonly unknown[]) => events.filter(e => (e as { type: string }).type === 'shell_backgrounded');

  it('task_started(is_backgrounded) for a main-line Bash mints ONE shell_backgrounded, id = task id, before the re-stated feed', async () => {
    await adapter.adapt(assistantCalls([{ id: 'toolu_bash', name: 'Bash', input: { command: 'sleep 120', run_in_background: true } }], null) as any);
    await adapter.adapt(changed([{ task_id: 'bash-1', task_type: 'local_bash', description: 'Sleep two minutes' }]) as any);
    const events = await adapter.adapt(started('bash-1', 'toolu_bash', { task_type: 'local_bash', is_backgrounded: true, description: 'Sleep two minutes' }) as any);
    expect(shellsOf(events)).toEqual([{
      type: 'shell_backgrounded', toolUseId: 'toolu_bash', shellId: 'bash-1', intent: 'Sleep two minutes', command: 'sleep 120',
    }]);
    const kinds = events.map(e => e.type);
    expect(kinds.indexOf('shell_backgrounded')).toBeLessThan(kinds.indexOf('background_tasks_replaced'));
    // Emits once: a later move patch for the same task announces nothing more.
    expect(shellsOf(await adapter.adapt(updated('bash-1', { is_backgrounded: true }) as any))).toEqual([]);
  });

  it('a foreground Bash moved to the background later is announced by the task_updated patch (an ABSENT parent is main-line)', async () => {
    await adapter.adapt(assistantCalls([{ id: 'toolu_fg', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }], undefined as unknown as null) as any);
    expect(shellsOf(await adapter.adapt(started('bash-2', 'toolu_fg', { task_type: 'local_bash', is_backgrounded: false }) as any))).toEqual([]);
    expect(shellsOf(await adapter.adapt(updated('bash-2', { is_backgrounded: true }) as any))).toEqual([{
      type: 'shell_backgrounded', toolUseId: 'toolu_fg', shellId: 'bash-2', intent: 'task bash-2', command: 'npm test',
    }]);
  });

  it('NEGATIVE: a subagent\'s own background Bash (sidechain call), an unseen call, and a Monitor / MCP task mint nothing', async () => {
    await adapter.adapt(assistantCalls([{ id: 'toolu_side', name: 'Bash', input: { command: 'sleep 9' } }], 'toolu_parent_agent') as any);
    await adapter.adapt(assistantCalls([
      { id: 'toolu_mon', name: 'Monitor', input: { command: 'tail -f log' } },
      { id: 'toolu_mcp', name: 'mcp__srv__scan', input: {} },
    ], null) as any);
    const all = [
      ...await adapter.adapt(started('bash-side', 'toolu_side', { task_type: 'local_bash', is_backgrounded: true }) as any),
      ...await adapter.adapt(started('bash-unseen', 'toolu_never_seen', { task_type: 'local_bash', is_backgrounded: true }) as any),
      ...await adapter.adapt(started('mon-1', 'toolu_mon', { task_type: 'monitor', is_backgrounded: true }) as any),
      ...await adapter.adapt(started('mcp-1', 'toolu_mcp', { task_type: 'mcp_task' }) as any),
      ...await adapter.adapt(updated('mcp-1', { is_backgrounded: true }) as any),
    ];
    expect(all.some(e => e.type === 'task_backgrounded' || e.type === 'shell_backgrounded')).toBe(false);
  });

  it('a CLI restart retires an announced shell the level still names (stopped), never one that already ended', async () => {
    await adapter.adapt(assistantCalls([
      { id: 'toolu_a', name: 'Bash', input: { command: 'sleep 300' } },
      { id: 'toolu_b', name: 'Bash', input: { command: 'sleep 1' } },
    ], null) as any);
    await adapter.adapt(changed([{ task_id: 'bash-a', task_type: 'local_bash' }, { task_id: 'bash-b', task_type: 'local_bash' }]) as any);
    await adapter.adapt(started('bash-a', 'toolu_a', { task_type: 'local_bash', is_backgrounded: true }) as any);
    await adapter.adapt(started('bash-b', 'toolu_b', { task_type: 'local_bash', is_backgrounded: true }) as any);
    // bash-b ends: the level shrinks (and its own task_notification reports it).
    await adapter.adapt(changed([{ task_id: 'bash-a', task_type: 'local_bash' }]) as any);
    const reset = adapter.resetBackgroundTaskLevel();
    expect(reset.filter(e => e.type === 'task_completed')).toEqual([{ type: 'task_completed', taskId: 'bash-a', status: 'stopped' }]);
    // The next child starts clean: nothing is retired twice.
    expect(adapter.resetBackgroundTaskLevel().filter(e => e.type === 'task_completed')).toEqual([]);
  });
});

describe('UA12.18 — only the session\'s own agent mints a row from a tool result (`== null`)', () => {
  const launch = 'Async agent launched successfully.\nagentId: a1b2c3';
  const resultBlocks = (): ContentBlock[] => [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: launch, is_error: false } as ContentBlock];
  let index: ToolIndex;
  beforeEach(() => {
    index = new ToolIndex();
    index.register('toolu_bg', 'Agent', { description: 'Scan inventory', prompt: 'Scan' });
  });

  it('a sidechain result (a subagent launching its own background agent) mints no task_backgrounded', () => {
    const events = extractToolResults(resultBlocks(), 'toolu_parent_agent', undefined, index);
    expect(events.map(e => e.type)).toEqual(['tool_result']);
  });

  it('a main-line result with parent_tool_use_id null mints it', () => {
    const events = extractToolResults(resultBlocks(), null, undefined, index);
    expect(events.map(e => e.type)).toEqual(['tool_result', 'task_backgrounded']);
  });

  it('a main-line result with parent_tool_use_id ABSENT mints it too — the case `=== null` would misread', () => {
    const events = extractToolResults(resultBlocks(), undefined as unknown as null, undefined, index);
    expect(events.map(e => e.type)).toEqual(['tool_result', 'task_backgrounded']);
  });

  it('the launched agent\'s intent falls back to the call\'s description when it has no _intent', () => {
    const events = extractToolResults(resultBlocks(), null, undefined, index);
    expect(events[1]).toMatchObject({ type: 'task_backgrounded', taskId: 'a1b2c3', intent: 'Scan inventory' });
  });

  it('the convenience-field fallback is untouched: there the parent id IS the tool\'s own id', () => {
    const events = extractToolResults([], 'toolu_bg', launch, index);
    expect(events.map(e => e.type)).toEqual(['tool_result', 'task_backgrounded']);
  });
});

// UA12.18 follow-up — the START order the vendored SDK documents for `SDKBackgroundTasksChangedMessage`
// (claudeCodeVersion 2.1.274): "Ordering relative to the bookends for the same transition is unspecified (in practice
// the level precedes them)". The level arrives BEFORE `task_started`, so the first feed for a new task cannot name its
// call; `task_started` must re-state the set once it can, or a Workflow, Monitor or Bash row waits for the next
// membership change to learn the id `task_progress` is addressed to.
describe('UA12.18 follow-up — level first, task_started second', () => {
  let adapter: ClaudeEventAdapter;
  beforeEach(() => {
    adapter = new ClaudeEventAdapter(createCallbacks());
    adapter.startTurn();
  });

  it('task_started for a task the level already named re-states the feed with its call id', async () => {
    const first = await adapter.adapt(changed([{ task_id: 'wf-1', task_type: 'local_workflow', description: 'spec' }]) as any);
    expect(rowsOf(first)).toEqual([{ taskId: 'wf-1', description: 'spec', taskType: 'local_workflow' }]);
    const events = await adapter.adapt(started('wf-1', 'toolu_wf', { task_type: 'local_workflow' }) as any);
    expect(rowsOf(events)).toEqual([{ taskId: 'wf-1', description: 'spec', taskType: 'local_workflow', toolUseId: 'toolu_wf' }]);
  });

  it('task_started for a task the level has not named emits no feed (the level stays the only membership source)', async () => {
    const events = await adapter.adapt(started('agent-9', 'toolu_9', { task_type: 'local_agent' }) as any);
    expect(rowsOf(events)).toBeUndefined();
  });
});

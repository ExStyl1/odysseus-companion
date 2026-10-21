/**
 * UB9.8 — the Claude SDK's `task_progress` becomes `task_activity` for the session's OWN tasks, in a turn and
 * between turns (craft-agents-oss v0.15.1 `classifyClaudeTaskProgress`, the event adapter's `task_progress` branch
 * and `ClaudeAgent.routeBackgroundMessage`; Apache-2.0; upstream pins them in `claude-event-adapter-tasks.test.ts`).
 *
 * Positive: a task started by a main-line call reports its activity (step count, last tool, an MCP task's own
 * status) on both doors. Negative: a subagent's nested task (its call was never main-line) reports nothing on
 * either door, and a progress message with no task id is not activity. The host's own gate (registered tasks only)
 * is `server-core`'s `claude-background-task-output.test.ts`.
 */
import { beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { AgentEvent } from '@nessy-agent/core/types';
import { ClaudeEventAdapter, type ClaudeAdapterCallbacks } from '../backend/claude/event-adapter.ts';
import { classifyClaudeTaskProgress } from '../backend/claude/task-notification.ts';
import { ClaudeAgent } from '../claude-agent.ts';

// Importing `claude-agent.ts` is this file's wall-clock cost; the cases are milliseconds.
setDefaultTimeout(120_000);

function callbacks(): ClaudeAdapterCallbacks {
  return {
    onDebug: undefined,
    mapSDKError: async () => ({
      type: 'typed_error' as const,
      error: { code: 'unknown_error', title: 'T', message: 'M', details: [], actions: [], canRetry: false },
    }),
  };
}

const assistantCall = (id: string, parent: string | null) => ({
  type: 'assistant', parent_tool_use_id: parent, uuid: `a-${id}`, session_id: 's',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'Review', run_in_background: true } }] },
});

const progress = (taskId: string, toolUseId: string | undefined, extra: Record<string, unknown> = {}) => ({
  type: 'system', subtype: 'task_progress', task_id: taskId,
  ...(toolUseId ? { tool_use_id: toolUseId } : {}),
  description: 'Review', usage: { total_tokens: 100, tool_uses: 3, duration_ms: 4_000 }, last_tool_name: 'Read',
  uuid: `p-${taskId}`, session_id: 's', ...extra,
});

const activities = (events: readonly AgentEvent[]) => events.filter(event => event.type === 'task_activity');

describe('UB9.8 — classifyClaudeTaskProgress', () => {
  it('reads the step count, the last tool and a trimmed status', () => {
    expect(classifyClaudeTaskProgress(progress('m1', 'toolu_m', { summary: '  Indexing 3/10  ' })))
      .toEqual({ taskId: 'm1', toolUseId: 'toolu_m', summary: 'Indexing 3/10', lastToolName: 'Read', toolUses: 3 });
  });

  it('is null for anything else, and for a progress with no task id', () => {
    expect(classifyClaudeTaskProgress({ type: 'system', subtype: 'task_started', task_id: 'a1' })).toBeNull();
    expect(classifyClaudeTaskProgress({ type: 'system', subtype: 'task_progress', task_id: '' })).toBeNull();
    expect(classifyClaudeTaskProgress(null)).toBeNull();
  });
});

describe('UB9.8 — in a turn: the event adapter', () => {
  let adapter: ClaudeEventAdapter;
  beforeEach(() => {
    adapter = new ClaudeEventAdapter(callbacks());
    adapter.startTurn();
  });

  it("a main-line call's task reports its activity, after the orchestration task_progress", async () => {
    await adapter.adapt(assistantCall('toolu_main', null) as never);
    const events = await adapter.adapt(progress('a1', 'toolu_main') as never);
    expect(activities(events)).toEqual([
      expect.objectContaining({ type: 'task_activity', taskId: 'a1', toolUseId: 'toolu_main', lastToolName: 'Read', toolUses: 3 }),
    ]);
    expect(events.map(event => event.type)).toEqual(['task_progress', 'task_activity']);
    expect(adapter.wasLaunchedByMainAgent('a1', 'toolu_main')).toBe(true);
  });

  it("NEGATIVE — a subagent's nested task reports no activity (its call was never main-line)", async () => {
    await adapter.adapt(assistantCall('toolu_nested', 'toolu_parent') as never);
    const events = await adapter.adapt(progress('a2', 'toolu_nested') as never);
    expect(activities(events)).toEqual([]);
    // The orchestration panel still gets its progress: only the chip's activity is gated.
    expect(events.map(event => event.type)).toEqual(['task_progress']);
  });
});

describe('UB9.8 — between turns: ClaudeAgent.noteBetweenTurnsMessage', () => {
  type BetweenTurns = (this: unknown, message: unknown) => Promise<void>;
  const noteBetweenTurns = (ClaudeAgent.prototype as unknown as { noteBetweenTurnsMessage: BetweenTurns }).noteBetweenTurnsMessage;

  async function between(adapter: ClaudeEventAdapter, message: unknown): Promise<AgentEvent[]> {
    const sunk: AgentEvent[] = [];
    const fake = { config: { onBetweenTurnsEvent: (event: AgentEvent) => { sunk.push(event); } }, eventAdapter: adapter, debug() {} };
    await noteBetweenTurns.call(fake, message);
    return sunk;
  }

  it("a main-line task's activity crosses the door as task_activity, and nothing else of the message does", async () => {
    const adapter = new ClaudeEventAdapter(callbacks());
    adapter.startTurn();
    await adapter.adapt(assistantCall('toolu_main', null) as never);
    expect(await between(adapter, progress('a1', 'toolu_main'))).toEqual([
      { type: 'task_activity', taskId: 'a1', toolUseId: 'toolu_main', lastToolName: 'Read', toolUses: 3 },
    ]);
  });

  it("NEGATIVE — a subagent's nested task's activity does not cross", async () => {
    const adapter = new ClaudeEventAdapter(callbacks());
    adapter.startTurn();
    await adapter.adapt(assistantCall('toolu_nested', 'toolu_parent') as never);
    expect(await between(adapter, progress('a2', 'toolu_nested'))).toEqual([]);
  });
});

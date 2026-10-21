/**
 * P6.642 — the AgentPanel hid entirely on claude, because nothing produced
 * child state there.
 *
 * H13 of P6.305: "state it in a string" has no surface on a runtime that
 * publishes no roster. The codex adapter already builds an `OrchestrationProgress`
 * from its collab-agent items (`adaptForeignChildThread`, verified at HEAD); the
 * claude adapter emitted `task_progress` with an elapsed clock and nothing else,
 * and `orchestrationProgress` scored ZERO occurrences in it.
 *
 * Native-first, and everything mapped here is already published: `task_started`
 * opens the row, `SDKTaskProgressMessage` carries `description`,
 * `subagent_type`, `usage.{total_tokens,tool_uses}`, `last_tool_name` and the
 * `summary` that `Options.agentProgressSummaries` turns on (enabled in
 * `claude-agent.ts` by `6f3d5239b`, OFF again since F1.919 — its ~30 s fork
 * raised a duplicate permission card — so `last_tool_name` is the line users
 * see), and `task_updated.patch.status` closes it. Nothing is invented.
 *
 * ## P6.641 lands here too, and it is the reason the wire type changed
 *
 * `SDKTaskProgressMessage.usage` is `{ total_tokens, tool_uses, duration_ms }`
 * — agent-sdk 0.3.233 — with no input/output split anywhere on the message,
 * while `OrchestrationProgressAgent.tokensIn`/`tokensOut` were REQUIRED. The two
 * ways to satisfy that were to invent a split or to send `0`/`0`, and a card
 * reading "0 in / 0 out" beside a real total states a fact the runtime never
 * reported. So the split is now optional and honestly ABSENT here, with
 * `tokensTotal` carrying what the SDK does give.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { AgentEvent } from '@nessy-agent/core/types';
import { ClaudeEventAdapter, type ClaudeAdapterCallbacks } from '../backend/claude/event-adapter.ts';

function callbacks(): ClaudeAdapterCallbacks {
  return {
    mapSDKError: async () => ({
      type: 'typed_error' as const,
      error: {
        code: 'unknown_error',
        title: 'Test Error',
        message: 'unused',
        details: [],
        actions: [],
        canRetry: false,
      },
    }),
  };
}

function freshAdapter(): ClaudeEventAdapter {
  const adapter = new ClaudeEventAdapter(callbacks());
  adapter.startTurn();
  return adapter;
}

const TOOL_USE_ID = 'toolu_child_1';
const TASK_ID = 'task_child_1';

const started = (overrides: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'task_started',
  task_id: TASK_ID,
  tool_use_id: TOOL_USE_ID,
  description: 'Audit the auth module',
  subagent_type: 'explorer',
  uuid: 'u1',
  session_id: 's1',
  ...overrides,
}) as never;

const progress = (overrides: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'task_progress',
  task_id: TASK_ID,
  tool_use_id: TOOL_USE_ID,
  description: 'Audit the auth module',
  subagent_type: 'explorer',
  usage: { total_tokens: 4210, tool_uses: 7, duration_ms: 12_400 },
  uuid: 'u2',
  session_id: 's1',
  ...overrides,
}) as never;

const updated = (patch: string | Record<string, unknown>) => ({
  type: 'system',
  subtype: 'task_updated',
  task_id: TASK_ID,
  patch: typeof patch === 'string' ? { status: patch } : patch,
  uuid: 'u3',
  session_id: 's1',
}) as never;

/** The last `task_progress`'s roster, read into a local before any assertion. */
function roster(events: AgentEvent[]) {
  const carriers = events.filter(
    (event): event is Extract<AgentEvent, { type: 'task_progress' }> => event.type === 'task_progress',
  );
  const last = carriers[carriers.length - 1];
  return last?.orchestrationProgress;
}

describe('P6.642 · the claude child-state producer', () => {
  it('maps a started subagent onto the shape both cards read', async () => {
    const adapter = freshAdapter();

    const snapshot = roster(await adapter.adapt(started()));

    expect(snapshot?.kind).toBe('subagent');
    expect(snapshot?.runId).toBe(TOOL_USE_ID);
    const agent = snapshot?.agents[0];
    expect(agent?.id).toBe(TASK_ID);
    expect(agent?.label).toBe('Audit the auth module');
    expect(agent?.agentType).toBe('explorer');
    expect(agent?.status).toBe('running');
  });

  it('I2.9 — carries the two nesting facts, and ABSENT is a third answer', async () => {
    // Both are rendered only where the runtime stated them, so the arms that
    // matter are the three states rather than two: background, foreground, and
    // the runtime never said. Pi and codex are the third, permanently.
    const withFacts = roster(await freshAdapter().adapt(
      started({ is_backgrounded: true, spawn_depth: 3 }),
    ));
    expect(withFacts?.agents[0]?.isBackgrounded).toBe(true);
    expect(withFacts?.agents[0]?.spawnDepth).toBe(3);

    // The FOREGROUND arm is not the same as the absent one and must survive as
    // `false`: the card distinguishes them (only `=== true` draws a chip), so a
    // producer that dropped `false` would be indistinguishable from a runtime
    // that never reported — the exact confusion the optional field exists to
    // avoid.
    const foreground = roster(await freshAdapter().adapt(started({ is_backgrounded: false })));
    expect(foreground?.agents[0]?.isBackgrounded).toBe(false);

    // The control: a `task_started` with neither field carries neither key —
    // never `false`, never `0`. `spawn_depth` is absent on every task that is
    // not a `local_agent`, by the SDK's own gloss, so this is the common shape
    // and not an edge case.
    const bare = roster(await freshAdapter().adapt(started()));
    expect('isBackgrounded' in (bare?.agents[0] ?? {})).toBe(false);
    expect('spawnDepth' in (bare?.agents[0] ?? {})).toBe(false);
  });

  it('I2.9 — a later move to the background arrives as a PATCH and is taken', async () => {
    // `is_backgrounded`'s own gloss: "A later move to the background arrives as
    // `task_updated` patch.is_backgrounded". Without this arm the panel pins
    // whatever `task_started` said and is wrong for the rest of the run.
    const adapter = freshAdapter();
    await adapter.adapt(started({ is_backgrounded: false }));

    const events = await adapter.adapt(updated({ is_backgrounded: true }));

    // Emitted even though the STATUS did not move — the fact did, and a patch
    // carrying no status is the shape the SDK sends for exactly this.
    expect(roster(events)?.agents[0]?.isBackgrounded).toBe(true);

    // The negative on the same seam: a patch that repeats what we already hold
    // mints no event, so a chatty runtime cannot spam the panel.
    const repeat = await adapter.adapt(updated({ is_backgrounded: true }));
    expect(repeat.filter(event => event.type === 'task_progress')).toHaveLength(0);
  });

  it('P6.641 — carries the TOTAL and leaves the split honestly absent', async () => {
    const adapter = freshAdapter();
    await adapter.adapt(started());

    const snapshot = roster(await adapter.adapt(progress()));

    const agent = snapshot?.agents[0];
    expect(agent?.tokensTotal).toBe(4210);
    expect(agent?.toolCalls).toBe(7);
    // The whole point: ABSENT, not zero. A `0` here would be a fabricated split
    // beside a real total, and the SDK's own type is the ceiling.
    expect(agent?.tokensIn).toBeUndefined();
    expect(agent?.tokensOut).toBeUndefined();
    expect('tokensIn' in (agent ?? {})).toBe(false);
  });

  it('prefers the agentProgressSummaries sentence, falls back to the tool name', async () => {
    const adapter = freshAdapter();
    await adapter.adapt(started());

    // Since F1.919 the fallback arm IS production: `claude-agent.ts` sends the
    // option as `false`, so a local agent's `task_progress` carries no `summary`.
    // The summary arm still pins the preference, for an MCP task's own status
    // (sent with no option) and for any later re-enable.
    const withTool = roster(await adapter.adapt(progress({ last_tool_name: 'Grep' })));
    expect(withTool?.agents[0]?.lastActivity).toBe('Grep');

    const withSummary = roster(await adapter.adapt(progress({
      last_tool_name: 'Grep',
      summary: 'Analyzing authentication module',
    })));
    expect(withSummary?.agents[0]?.lastActivity).toBe('Analyzing authentication module');
  });

  it('closes the row on a terminal status, through the task_id index', async () => {
    const adapter = freshAdapter();
    await adapter.adapt(started());
    await adapter.adapt(progress());

    // `SDKTaskUpdatedMessage` carries NO `tool_use_id`, which is why the adapter
    // keeps a task→run index at all; without it a card would open and never close.
    const done = roster(await adapter.adapt(updated('completed')));
    expect(done?.agents[0]?.status).toBe('done');
    expect(done?.agents[0]?.endedAt).toBeDefined();
  });

  it('a status with no place in the vocabulary changes nothing', async () => {
    const adapter = freshAdapter();
    await adapter.adapt(started());
    const before = roster(await adapter.adapt(progress()));
    expect(before?.agents[0]?.status).toBe('running');

    // `paused` and `pending` are not terminal and have no row in
    // `OrchestrationAgentStatus`; inventing one would be worse than keeping the
    // state we know.
    const after = await adapter.adapt(updated('paused'));
    expect(roster(after)).toBeUndefined();
  });

  it('a task with no tool_use_id is still not surfaced — the pre-existing rule', async () => {
    const adapter = freshAdapter();

    const events = await adapter.adapt(progress({ tool_use_id: undefined }));

    expect(roster(events)).toBeUndefined();
  });

  it('a respawn drops the roster rather than showing agents that stopped existing', async () => {
    const adapter = freshAdapter();
    await adapter.adapt(started());

    adapter.resetBackgroundTaskLevel();

    // A progress for the same task now opens a FRESH row rather than resuming a
    // roster whose child is gone.
    const snapshot = roster(await adapter.adapt(progress()));
    expect(snapshot?.agents).toHaveLength(1);
    expect(snapshot?.agents[0]?.tokensTotal).toBe(4210);
  });
});

describe('P6.641 · the SDK type is the ceiling, read off the installed typings', () => {
  it('SDKTaskProgressMessage.usage carries a total and no split', () => {
    const entry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
    const dts = readFileSync(`${entry.slice(0, entry.lastIndexOf('/'))}/sdk.d.ts`, 'utf8');
    const start = dts.indexOf('export declare type SDKTaskProgressMessage');
    expect(start).toBeGreaterThan(0);
    const block = dts.slice(start, dts.indexOf('};', start));

    expect(block).toContain('total_tokens: number');
    // The claim the row rests on: there is no split to project.
    expect(block).not.toContain('input_tokens');
    expect(block).not.toContain('output_tokens');
  });
});

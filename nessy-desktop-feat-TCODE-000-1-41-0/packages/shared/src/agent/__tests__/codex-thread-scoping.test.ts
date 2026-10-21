/**
 * A spawned subagent's thread must not drive the parent session.
 *
 * The app-server multiplexes every thread's notifications over ONE connection,
 * and a codex agent role spawns a real subagent thread. Measured live on the
 * CDX-ROLES gate (2026-08-13): the child's `turn/completed` finished the
 * parent's turn sink while the parent was still composing its final report —
 * that report never reached the transcript — and the child's own agentMessage
 * landed in the parent transcript as the last assistant row. Every
 * thread-scoped notification carries `threadId`
 * (`codex-protocol/generated/v2/*Notification.ts`), so the fix is attribution,
 * not heuristics: `isForeignThreadNotification` drops what is not ours.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { OrchestrationProgress } from '@nessy-agent/core';
import type { BackendConfig } from '../backend/types.ts';
import { cleanupModeState } from '../mode-manager.ts';
import { CodexAgent, isForeignThreadNotification } from '../codex-agent.ts';

const WORKSPACE_ID = 'ws-thread-scope';
const SESSION_ID = 'session-thread-scope';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Thread Scope Workspace',
      rootPath: '/tmp/ws-thread-scope-root',
      workspaceRootPath: '/tmp/ws-thread-scope-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-thread-scope',
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: '/tmp/ws-thread-scope-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

const PARENT = 'parent-thread';
const CHILD = 'child-thread';

interface Harness {
  agent: CodexAgent;
  notify: (method: string, params: unknown) => void;
  events: Array<{ type: string }>;
  finished: () => boolean;
}

function harness(): Harness {
  const agent = new CodexAgent(createConfig());
  const internals = agent as unknown as {
    threadId: string | null;
    turnSink: { push: (e: { type: string }) => void; finish: () => void } | null;
    handleNotification: (method: string, params: unknown) => void;
  };
  const events: Array<{ type: string }> = [];
  let done = false;
  internals.threadId = PARENT;
  internals.turnSink = { push: e => events.push(e), finish: () => { done = true; } };
  return {
    agent,
    notify: (method, params) => internals.handleNotification(method, params),
    events,
    finished: () => done,
  };
}

const agentMessageItem = (threadId: string, text: string) => ({
  threadId,
  turnId: 'turn-1',
  completedAtMs: 0,
  item: { type: 'agentMessage', id: `msg-${threadId}`, text },
});

afterEach(() => {
  cleanupModeState({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID });
});

describe('isForeignThreadNotification', () => {
  it('filters exactly the notifications addressed to another thread', () => {
    expect(isForeignThreadNotification({ threadId: CHILD }, PARENT)).toBe(true);
    expect(isForeignThreadNotification({ threadId: PARENT }, PARENT)).toBe(false);
    // Connection-scoped (no threadId) is never filtered.
    expect(isForeignThreadNotification({ message: 'boom' }, PARENT)).toBe(false);
    // Before the session's own thread exists there is nothing to attribute to.
    expect(isForeignThreadNotification({ threadId: CHILD }, null)).toBe(false);
  });
});

describe('CodexAgent thread scoping', () => {
  it("a child's turn/completed does not finish the parent's turn, the parent's does", () => {
    const h = harness();
    try {
      h.notify('turn/completed', { threadId: CHILD, turn: {} });
      expect(h.finished()).toBe(false);

      h.notify('turn/completed', { threadId: PARENT, turn: {} });
      expect(h.finished()).toBe(true);
      expect(h.events.some(e => e.type === 'complete')).toBe(true);
    } finally {
      h.agent.destroy();
    }
  });

  it("a child's agentMessage stays out of the parent transcript; the parent's final report lands", () => {
    const h = harness();
    try {
      h.notify('item/completed', agentMessageItem(CHILD, 'ZEPHYR-from-the-child'));
      expect(h.events).toHaveLength(0);

      h.notify('item/completed', agentMessageItem(PARENT, 'the three-part report'));
      expect(h.events.map(e => e.type)).toEqual(['text_complete']);
    } finally {
      h.agent.destroy();
    }
  });
});

/**
 * P3.4 — model-driven parallel agents render as orchestration.
 *
 * The SAME child thread the scoping suite above proves is kept OUT of the parent
 * transcript must, when it is one WE spawned, still reach the UI — as
 * `OrchestrationProgress` on a `task_progress` event keyed by the parent turn,
 * not as transcript rows. A `spawn_agent` collab call (on the parent thread, so
 * not foreign) establishes the roster; the child's own notifications are foreign
 * by threadId but are re-admitted because they belong to that roster. A thread
 * in no roster stays dropped — the control.
 */
type ProgressEvent = {
  type: string;
  toolUseId?: string;
  turnId?: string;
  orchestrationProgress?: OrchestrationProgress;
};

const CHILD_B = 'child-thread-b';

/** A parent-thread `spawn_agent` collab item/started that names `childIds`. */
const collabSpawnStarted = (childIds: string[], turnId = 'turn-1') => ({
  threadId: PARENT,
  turnId,
  startedAtMs: 0,
  item: {
    type: 'collabAgentToolCall',
    id: 'collab-1',
    tool: 'spawnAgent',
    status: 'inProgress',
    senderThreadId: PARENT,
    receiverThreadIds: childIds,
    prompt: 'spawn two agents to check X and Y in parallel',
    model: null,
  },
});

const progressEvents = (h: Harness): ProgressEvent[] =>
  (h.events as ProgressEvent[]).filter(e => e.type === 'task_progress');

describe('CodexAgent spawned-child orchestration (P3.4)', () => {
  it("admits a spawned child's events as OrchestrationProgress keyed by the parent turn", () => {
    const h = harness();
    try {
      // The parent's spawn_agent call establishes the roster. Seeding is pure
      // bookkeeping — it emits a tool row but no progress event yet.
      h.notify('item/started', collabSpawnStarted([CHILD]));
      expect(progressEvents(h)).toHaveLength(0);

      // The child's own turn is foreign by threadId, but it is OUR child.
      h.notify('turn/started', { threadId: CHILD, turn: { id: 'child-turn-1' } });

      const progress = progressEvents(h);
      expect(progress).toHaveLength(1);
      const evt = progress[0]!;
      expect(evt.toolUseId).toBe('collab-1'); // anchored to the spawn's row
      expect(evt.turnId).toBe('turn-1'); // keyed by the PARENT turn
      const op = evt.orchestrationProgress!;
      expect(op.kind).toBe('subagent');
      expect(op.runId).toBe('collab-1');
      expect(op.agents.map(a => a.id)).toEqual([CHILD]);
      expect(op.agents[0]!.status).toBe('running');

      // The child still must NOT drive the parent: no transcript text, and the
      // parent turn is not finished by the child's activity.
      expect(h.events.some(e => e.type === 'text_complete')).toBe(false);
      expect(h.finished()).toBe(false);
    } finally {
      h.agent.destroy();
    }
  });

  it("folds a child's token usage into its agent row and tracks two agents in spawn order", () => {
    const h = harness();
    try {
      h.notify('item/started', collabSpawnStarted([CHILD, CHILD_B]));
      h.notify('thread/tokenUsage/updated', {
        threadId: CHILD,
        turnId: 'child-turn-1',
        tokenUsage: {
          total: { inputTokens: 120, outputTokens: 45 },
          last: { inputTokens: 10, outputTokens: 5 },
        },
      });

      const progress = progressEvents(h);
      expect(progress).toHaveLength(1);
      const op = progress[0]!.orchestrationProgress!;
      // Both spawned agents are tracked, in the order they were named.
      expect(op.agents.map(a => a.id)).toEqual([CHILD, CHILD_B]);
      const childRow = op.agents.find(a => a.id === CHILD)!;
      expect(childRow.tokensIn).toBe(120);
      expect(childRow.tokensOut).toBe(45);
    } finally {
      h.agent.destroy();
    }
  });

  it('a genuinely foreign thread is still dropped even while a spawn is live — control', () => {
    const h = harness();
    try {
      h.notify('item/started', collabSpawnStarted([CHILD]));
      h.notify('turn/started', { threadId: CHILD, turn: { id: 'child-turn-1' } });
      expect(progressEvents(h)).toHaveLength(1); // our child produced progress

      // A thread that is NOT in any roster — another session, a compaction
      // thread — must remain filtered: no progress, no transcript leak, and it
      // does not finish the parent turn.
      const stranger = 'other-session-thread';
      h.notify('turn/started', { threadId: stranger, turn: { id: 's1' } });
      h.notify('item/completed', agentMessageItem(stranger, 'this must not leak'));
      h.notify('turn/completed', { threadId: stranger, turn: { id: 's1' } });
      h.notify('thread/tokenUsage/updated', {
        threadId: stranger,
        turnId: 's1',
        tokenUsage: { total: { inputTokens: 9, outputTokens: 9 } },
      });

      const progress = progressEvents(h);
      expect(progress).toHaveLength(1); // still only the one from CHILD
      expect(progress[0]!.orchestrationProgress!.agents.map(a => a.id)).toEqual([CHILD]);
      expect(h.events.some(e => e.type === 'text_complete')).toBe(false);
      expect(h.finished()).toBe(false);
    } finally {
      h.agent.destroy();
    }
  });
});

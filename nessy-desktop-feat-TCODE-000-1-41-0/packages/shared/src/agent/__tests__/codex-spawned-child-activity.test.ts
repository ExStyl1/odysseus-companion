/**
 * UA12.99 (P-UA-am-1) — a codex `spawn_agent` child left running after its parent's turn is ACTIVITY the Tasks
 * Conductor's settlement gate can read.
 *
 * Read from `openai/codex` at `rust-v0.159.3` (the shipped app-server reports `codex-app-server 0.159.3`) before
 * building, per the codex rule (source outranks docs): a child's terminal turn reaches its parent through
 * `LocalAgentControl::notify_parent_of_terminal_turn` (`core/src/agent/control/completion.rs`) as an
 * `InterAgentCommunication` built with `/*trigger_turn*\/ false`, and the legacy (non-v2) path calls
 * `inject_fragment_without_turn(SubagentNotification)` (`core/src/agent/control.rs`). Neither starts a parent turn: the
 * result waits in the parent's input for its NEXT turn. So a node whose child runs past the node's last turn gets no
 * host door when the child ends, and the gate must count the child itself.
 *
 * The child's own lifecycle already reaches the agent between parent turns: its notifications are foreign by
 * threadId and `handleNotification` reads every foreign thread's lifecycle first (F1.493 (2)), whether or not a parent
 * turn is open. What was missing is a SESSION-scoped roster — the adapter's collab maps clear at every turn start.
 *
 * Arms:
 * 1. a child spawned without `wait_agent` counts after the parent's turn ends, and stops counting at its own
 *    `turn/completed` (no parent turn in between);
 * 2. boundary — a child the parent waited for (its turn ended inside the parent turn) counts zero;
 * 3. a child that finished before the parent learned its id (the spawn's `item/completed`) counts zero;
 * 4. a later child turn (`send_input`) counts again until it completes; `thread/closed` ends it;
 * 5. negative — a foreign thread no spawn named (a review or compaction thread) never counts, and a FAILED spawn
 *    registers nothing;
 * 6. UA12.191 (P-LF-5-1) — the reaper's and the ceiling's liveness level (`backgroundWorkCount`) counts a running
 *    child too, so a codex session whose child works between turns is not reaped (UA12.99 had kept it terminals only);
 * 6b. the bound — a running child that has sent NOTHING for `SPAWNED_CHILD_LIVENESS_BOUND_MS` stops counting there,
 *    so a roster entry whose end never arrives cannot make a session unreapable; any child notification renews it,
 *    and the settlement level (`backgroundActivityCount`) is not bounded (the node's own deadline is its bound);
 * 7. teardown — `/clear` (`clearHistory` → `teardownRuntime`) kills the app-server and every child thread inside it,
 *    so no lifecycle can ever end a child it was running: the roster is forgotten with the connection (as the
 *    background terminals are), or a node's settlement gate would read activity 1 for the agent's life.
 * 8. UA12.191 (P-LF-5-3) — a child that never runs a turn and is never closed (an init failure) ends at its
 *    `thread/status/changed` `systemError`: read at `rust-v0.159.3`, `ThreadWatchManager::note_system_error`
 *    (`app-server/src/thread_status.rs`, called on every `EventMsg::Error` in `bespoke_event_handling.rs`) sets
 *    `running = false`; boundary — a `systemError` inside a child turn that is running does NOT end it (codex sends
 *    `ActiveTurnNotSteerable` / `ThreadRollbackFailed` errors that leave the turn going; `turn/completed` ends it).
 */
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import { CodexEventAdapter } from '../backend/codex/event-adapter.ts';
import { cleanupModeState } from '../mode-manager.ts';
import { CodexAgent } from '../codex-agent.ts';

const WS = 'ws-ua12-99';
const SESS = 'session-ua12-99';
const PARENT = 'parent-thread';
const CHILD = 'child-thread';
/** Mirrors `CodexEventAdapter.SPAWNED_CHILD_LIVENESS_BOUND_MS` (asserted in the bound arm). */
const LIVENESS_BOUND_MS = 30 * 60_000;

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: { id: WS, name: 'UA12.99', rootPath: '/tmp/ua12-99', workspaceRootPath: '/tmp/ua12-99', sessionRootPath: '/tmp/ua12-99/sessions' } as never,
    session: { id: SESS, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: '/tmp/ua12-99' } as never,
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig;
}

interface Harness {
  agent: CodexAgent & { backgroundActivityCount?: () => number };
  notify: (method: string, params: unknown) => void;
  openTurn: () => void;
  closeTurn: () => void;
}

function harness(): Harness {
  const agent = new CodexAgent(createConfig());
  const internals = agent as unknown as {
    threadId: string | null;
    turnSink: { push: (e: unknown) => void; finish: () => void } | null;
    handleNotification: (method: string, params: unknown) => void;
  };
  internals.threadId = PARENT;
  return {
    agent: agent as Harness['agent'],
    notify: (method, params) => internals.handleNotification(method, params),
    openTurn: () => { internals.turnSink = { push: () => {}, finish: () => {} }; },
    closeTurn: () => { internals.turnSink = null; },
  };
}

const spawnItem = (method: 'item/started' | 'item/completed', childIds: string[], status = method === 'item/started' ? 'inProgress' : 'completed') => [method, {
  threadId: PARENT,
  turnId: 'turn-1',
  ...(method === 'item/started' ? { startedAtMs: 0 } : { completedAtMs: 0 }),
  item: {
    type: 'collabAgentToolCall', id: 'collab-spawn-1', tool: 'spawnAgent', status,
    senderThreadId: PARENT, receiverThreadIds: childIds, prompt: 'check X', model: null,
  },
}] as const;

const activity = (h: Harness): number => h.agent.backgroundActivityCount?.() ?? h.agent.backgroundWorkCount();

describe('UA12.99 — a codex spawn_agent child left running after its parent\'s turn is activity', () => {
  afterEach(() => cleanupModeState({ workspaceId: WS, sessionId: SESS }));

  it('counts a child spawned without wait_agent after the parent turn ends, until the child\'s own turn completes', () => {
    const h = harness();
    try {
      h.openTurn();
      h.notify(...spawnItem('item/started', []));
      h.notify('turn/started', { threadId: CHILD, turn: { id: 'child-turn-1' } });
      h.notify(...spawnItem('item/completed', [CHILD]));
      h.closeTurn(); // the parent turn is over; the child still runs
      expect(activity(h)).toBe(1);
      // A parent turn start clears the adapter's turn-scoped maps — the roster must survive it.
      (h.agent as unknown as { eventAdapter: { startTurn: () => void } }).eventAdapter.startTurn();
      expect(activity(h)).toBe(1);
      h.notify('turn/completed', { threadId: CHILD, turn: { id: 'child-turn-1', status: 'completed' } });
      expect(activity(h)).toBe(0);
    } finally {
      h.agent.destroy();
    }
  });

  it('boundary: a child the parent waited for ends inside the parent turn and counts zero', () => {
    const h = harness();
    try {
      h.openTurn();
      h.notify(...spawnItem('item/completed', [CHILD]));
      h.notify('turn/started', { threadId: CHILD, turn: { id: 'child-turn-1' } });
      h.notify('turn/completed', { threadId: CHILD, turn: { id: 'child-turn-1', status: 'completed' } });
      h.closeTurn();
      expect(activity(h)).toBe(0);
    } finally {
      h.agent.destroy();
    }
  });

  it('a child that finished before the spawn named it counts zero', () => {
    const h = harness();
    try {
      h.openTurn();
      h.notify('turn/started', { threadId: CHILD, turn: { id: 'child-turn-1' } });
      h.notify('turn/completed', { threadId: CHILD, turn: { id: 'child-turn-1', status: 'completed' } });
      h.notify(...spawnItem('item/completed', [CHILD]));
      h.closeTurn();
      expect(activity(h)).toBe(0);
    } finally {
      h.agent.destroy();
    }
  });

  it('a later child turn counts again until it completes; thread/closed ends the child', () => {
    const h = harness();
    try {
      h.openTurn();
      h.notify(...spawnItem('item/completed', [CHILD]));
      h.notify('turn/completed', { threadId: CHILD, turn: { id: 'child-turn-1', status: 'completed' } });
      h.closeTurn();
      expect(activity(h)).toBe(0);
      h.notify('turn/started', { threadId: CHILD, turn: { id: 'child-turn-2' } });
      expect(activity(h)).toBe(1);
      h.notify('thread/closed', { threadId: CHILD });
      expect(activity(h)).toBe(0);
    } finally {
      h.agent.destroy();
    }
  });

  it('negative: a foreign thread no spawn named never counts, and a failed spawn registers nothing', () => {
    const h = harness();
    try {
      h.notify('turn/started', { threadId: 'review-thread', turn: { id: 'r-1' } });
      expect(activity(h)).toBe(0);
      h.openTurn();
      h.notify(...spawnItem('item/completed', ['child-refused'], 'failed'));
      h.closeTurn();
      h.notify('turn/started', { threadId: 'child-refused', turn: { id: 'x-1' } });
      expect(activity(h)).toBe(0);
    } finally {
      h.agent.destroy();
    }
  });

  it('UA12.191: the reaper\'s liveness level counts a running child, once (not twice in the activity level)', () => {
    const h = harness();
    try {
      h.openTurn();
      h.notify(...spawnItem('item/completed', [CHILD]));
      h.notify('turn/started', { threadId: CHILD, turn: { id: 'child-turn-1' } });
      h.closeTurn();
      expect(h.agent.backgroundWorkCount()).toBe(1);
      expect(activity(h)).toBe(1);
      h.notify('turn/completed', { threadId: CHILD, turn: { id: 'child-turn-1', status: 'completed' } });
      expect(h.agent.backgroundWorkCount()).toBe(0);
    } finally {
      h.agent.destroy();
    }
  });

  it('UA12.191: bound — a child silent past the bound stops holding the reaper; a notification renews it', () => {
    const h = harness();
    const start = Date.now();
    try {
      expect(CodexEventAdapter.SPAWNED_CHILD_LIVENESS_BOUND_MS).toBe(LIVENESS_BOUND_MS);
      h.openTurn();
      h.notify(...spawnItem('item/completed', [CHILD]));
      h.notify('turn/started', { threadId: CHILD, turn: { id: 'child-turn-1' } });
      h.closeTurn();
      setSystemTime(new Date(start + LIVENESS_BOUND_MS - 1_000));
      expect(h.agent.backgroundWorkCount()).toBe(1);
      // Any notification of the child is liveness (an item it streams, a delta) — not only its lifecycle.
      h.notify('item/started', { threadId: CHILD, turnId: 'child-turn-1', item: { type: 'commandExecution', id: 'c-1' } });
      setSystemTime(new Date(start + LIVENESS_BOUND_MS + 1_000));
      expect(h.agent.backgroundWorkCount()).toBe(1);
      setSystemTime(new Date(start + 2 * LIVENESS_BOUND_MS));
      expect(h.agent.backgroundWorkCount()).toBe(0); // its end never arrived: the bound cannot latch
      expect(activity(h)).toBe(1); // the settlement level is not bounded
      h.notify('item/completed', { threadId: CHILD, turnId: 'child-turn-1', item: { type: 'commandExecution', id: 'c-1' } });
      expect(h.agent.backgroundWorkCount()).toBe(1); // it spoke again: it counts again
    } finally {
      setSystemTime();
      h.agent.destroy();
    }
  });

  it('UA12.191: a child that only reports systemError (it never ran a turn) is not running', () => {
    const h = harness();
    try {
      h.openTurn();
      h.notify(...spawnItem('item/completed', [CHILD]));
      h.closeTurn();
      expect(activity(h)).toBe(1); // spawned, not yet seen: pending init counts
      h.notify('thread/status/changed', { threadId: CHILD, status: { type: 'systemError' } });
      expect(activity(h)).toBe(0);
      expect(h.agent.backgroundWorkCount()).toBe(0);
      // Before the spawn names it, too (a fast failure): the unclaimed map keeps the verdict for the claim.
      h.notify('thread/status/changed', { threadId: 'child-fast', status: { type: 'systemError' } });
      h.openTurn();
      h.notify(...spawnItem('item/completed', ['child-fast']));
      h.closeTurn();
      expect(activity(h)).toBe(0);
    } finally {
      h.agent.destroy();
    }
  });

  it('UA12.191 boundary: a systemError inside a running child turn does not end it; its turn/completed does', () => {
    const h = harness();
    try {
      h.openTurn();
      h.notify(...spawnItem('item/completed', [CHILD]));
      h.notify('turn/started', { threadId: CHILD, turn: { id: 'child-turn-1' } });
      h.closeTurn();
      h.notify('thread/status/changed', { threadId: CHILD, status: { type: 'systemError' } });
      expect(activity(h)).toBe(1);
      expect(h.agent.backgroundWorkCount()).toBe(1);
      h.notify('turn/completed', { threadId: CHILD, turn: { id: 'child-turn-1', status: 'failed' } });
      expect(activity(h)).toBe(0);
    } finally {
      h.agent.destroy();
    }
  });

  it('teardown: /clear forgets a child still running, whose app-server it killed', async () => {
    const h = harness();
    try {
      h.openTurn();
      h.notify(...spawnItem('item/completed', [CHILD]));
      h.closeTurn();
      expect(activity(h)).toBe(1);
      await h.agent.clearHistory();
      expect(activity(h)).toBe(0);
    } finally {
      h.agent.destroy();
    }
  });
});

/**
 * UA12.204 (P-LG-4-1) — a GRANDCHILD: with `[agents].max_depth` above 1 (an operator ceiling this fork writes, see
 * `codex-explicit-operator-ceilings.test.ts`) a `spawn_agent` child can spawn its own child. Only the PARENT thread's
 * collab items registered, so the grandchild never joined the roster and a node whose child left it running settled
 * while it ran. The child's own `item/completed` `spawnAgent` reaches `handleNotification`'s foreign-thread branch like
 * every child notification, so the roster follows it: a registered child's spawn registers its children.
 */
describe('UA12.204 — a spawn_agent grandchild (spawned by a child) is in the roster', () => {
  afterEach(() => cleanupModeState({ workspaceId: WS, sessionId: SESS }));

  const GRANDCHILD = 'grandchild-thread';
  const childItem = (tool: string, receivers: string[], from = CHILD, status = 'completed') => ['item/completed', {
    threadId: from,
    turnId: 'child-turn-1',
    completedAtMs: 0,
    item: {
      type: 'collabAgentToolCall', id: `collab-${tool}-${from}`, tool, status,
      senderThreadId: from, receiverThreadIds: receivers, prompt: 'dig deeper', model: null,
    },
  }] as const;

  function childSpawnedAndEnded(h: Harness): void {
    h.openTurn();
    h.notify(...spawnItem('item/completed', [CHILD]));
    h.closeTurn();
    h.notify('turn/started', { threadId: CHILD, turn: { id: 'child-turn-1' } });
  }

  it('RED: a grandchild the child spawned keeps the node unsettled after the child\'s turn ends, until its own turn completes', () => {
    const h = harness();
    try {
      childSpawnedAndEnded(h);
      h.notify(...childItem('spawnAgent', [GRANDCHILD]));
      h.notify('turn/started', { threadId: GRANDCHILD, turn: { id: 'grandchild-turn-1' } });
      h.notify('turn/completed', { threadId: CHILD, turn: { id: 'child-turn-1', status: 'completed' } });
      expect(activity(h)).toBe(1);
      expect(h.agent.backgroundWorkCount()).toBe(1);
      h.notify('turn/completed', { threadId: GRANDCHILD, turn: { id: 'grandchild-turn-1', status: 'completed' } });
      expect(activity(h)).toBe(0);
      expect(h.agent.backgroundWorkCount()).toBe(0);
    } finally {
      h.agent.destroy();
    }
  });

  it('RED (fast grandchild): a grandchild whose turn started before the child\'s spawn item named it is claimed at registration', () => {
    const h = harness();
    try {
      childSpawnedAndEnded(h);
      h.notify('turn/started', { threadId: GRANDCHILD, turn: { id: 'grandchild-turn-1' } });
      h.notify(...childItem('spawnAgent', [GRANDCHILD]));
      h.notify('turn/completed', { threadId: CHILD, turn: { id: 'child-turn-1', status: 'completed' } });
      expect(activity(h)).toBe(1);
    } finally {
      h.agent.destroy();
    }
  });

  it('NEGATIVE: a child\'s FAILED spawn or non-spawn collab call, and a spawn from a thread no spawn named, register nothing', () => {
    const h = harness();
    try {
      childSpawnedAndEnded(h);
      h.notify(...childItem('spawnAgent', [GRANDCHILD], CHILD, 'failed'));
      h.notify(...childItem('sendInput', ['grandchild-2']));
      h.notify(...childItem('spawnAgent', ['grandchild-3'], 'review-thread'));
      h.notify('turn/started', { threadId: GRANDCHILD, turn: { id: 'g-1' } });
      h.notify('turn/started', { threadId: 'grandchild-2', turn: { id: 'g-2' } });
      h.notify('turn/started', { threadId: 'grandchild-3', turn: { id: 'g-3' } });
      h.notify('turn/completed', { threadId: CHILD, turn: { id: 'child-turn-1', status: 'completed' } });
      expect(activity(h)).toBe(0);
    } finally {
      h.agent.destroy();
    }
  });
});

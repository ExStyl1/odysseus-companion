/**
 * P6.111 — a codex session holding a live background terminal reported ZERO
 * background work, so the idle reaper and the live-agent ceiling were free to
 * take it.
 *
 * `SessionManager` reads `AgentInstance.backgroundWorkCount?.() ?? 0` into
 * `backendBackgroundTasks`, and `CodexAgent` defined no such method — the `?? 0`
 * answered for every codex session. The LEVEL existed all along
 * (`CodexEventAdapter`'s announced-terminal map, filled from
 * `thread/backgroundTerminals/list`); what was missing was a reader, and then a
 * way for the level to MOVE between turns.
 *
 * Four propositions, in the order they can fail:
 *
 * 1. **The reader answers the map.** Zero on a fresh agent, one while a terminal
 *    is announced, zero again once it is retired — the control that makes arm 2
 *    mean something, since a reader that always answered 1 would also "survive
 *    the reaper".
 * 2. **The turn-end refresh closes the spawn window.** A terminal spawned during
 *    a turn is announced at the head of the NEXT turn, so between those moments
 *    the level read zero while real work ran. The refresh polls once as the turn
 *    ends; with no host door (`BackendConfig.onBetweenTurnsEvent`, which codex
 *    joined in UA12.101) its chip events are PARKED rather than dropped.
 * 3. **The parked events are delivered, not lost.** They must reach the next
 *    turn's head — otherwise the fix would trade a wrong count for a missing
 *    chip, which is the worse defect.
 * 4. **The count comes back DOWN without a turn.** The direction that would
 *    otherwise latch: a terminal ending after the last turn must not hold the
 *    session busy forever. The read itself schedules the poll that retires it,
 *    throttled so a ceiling admission storm cannot drive an RPC loop.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import type { AgentEvent } from '@nessy-agent/core/types';
import { CodexAgent } from '../codex-agent.ts';
import { cleanupModeState } from '../mode-manager.ts';
import type { BackendConfig } from '../backend/types.ts';
import type { SessionKey } from '../../sessions/session-key.ts';

const WS = 'ws-bgwork';
const SESS = 'session-bgwork';
const KEY: SessionKey = { workspaceId: WS, sessionId: SESS };

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: WS,
      name: 'BG Work Count',
      rootPath: '/tmp/ws-bgwork',
      workspaceRootPath: '/tmp/ws-bgwork',
      sessionRootPath: '/tmp/ws-bgwork/sessions',
    } as never,
    session: {
      id: SESS,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-bgwork',
    } as never,
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig;
}

type Private = {
  syncBackgroundTerminalsIntoSink: (sink: { push: (e: AgentEvent) => void }, timeoutMs?: number) => Promise<void>;
  scheduleBackgroundTerminalRefresh: () => void;
  backgroundTerminalRefresh: Promise<void> | null;
  pendingBackgroundTerminalEvents: AgentEvent[];
  lastBackgroundTerminalRefreshAt: number;
};

/** A CodexAgent whose app-server answers `list` from a mutable script. */
function makeAgent(): {
  agent: CodexAgent;
  priv: Private;
  listCalls: number;
  setTerminals: (terminals: unknown[]) => void;
  calls: () => number;
} {
  const agent = new CodexAgent(createConfig());
  let terminals: unknown[] = [];
  let listCalls = 0;
  const client = {
    request(method: string) {
      if (method === 'thread/backgroundTerminals/list') {
        listCalls += 1;
        return Promise.resolve({ terminals });
      }
      return Promise.resolve({});
    },
    notify() {},
    close() {},
  };
  const internals = agent as unknown as { client: unknown; threadId: string | null };
  internals.client = client;
  internals.threadId = 'thread-bgwork';
  return {
    agent,
    priv: agent as unknown as Private,
    listCalls,
    setTerminals: next => { terminals = next; },
    calls: () => listCalls,
  };
}

describe('P6.111 · a codex session reports the background terminals it is holding', () => {
  afterEach(() => cleanupModeState(KEY));

  it('answers the announced-terminal level, and comes back to zero when it retires', async () => {
    const { agent, priv, setTerminals } = makeAgent();
    expect(agent.backgroundWorkCount()).toBe(0);

    setTerminals([{ id: 'term-1', command: 'python3 -m http.server' }]);
    await priv.syncBackgroundTerminalsIntoSink({ push: () => {} });
    expect(agent.backgroundWorkCount()).toBe(1);

    setTerminals([]);
    await priv.syncBackgroundTerminalsIntoSink({ push: () => {} });
    expect(agent.backgroundWorkCount()).toBe(0);
  });

  it('the between-turns refresh sees a terminal the last turn never announced', async () => {
    const { agent, priv, setTerminals } = makeAgent();
    // The spawn happens mid-turn: nothing has polled since, so the level is 0.
    setTerminals([{ id: 'term-2', command: 'npm run dev' }]);
    expect(agent.backgroundWorkCount()).toBe(0);

    priv.scheduleBackgroundTerminalRefresh();
    await priv.backgroundTerminalRefresh;

    expect(agent.backgroundWorkCount()).toBe(1);
    // Parked, not dropped — this construction has no host door (UA12.101).
    expect(priv.pendingBackgroundTerminalEvents.map(e => e.type)).toEqual(['shell_backgrounded']);
  });

  it('a read schedules the poll that retires a terminal, and the schedule is throttled', async () => {
    const { agent, priv, setTerminals, calls } = makeAgent();
    setTerminals([{ id: 'term-3' }]);
    await priv.syncBackgroundTerminalsIntoSink({ push: () => {} });
    const afterSeed = calls();

    // The terminal ended after the last turn. The next read still answers the
    // stale 1 — and kicks the poll that notices, which nothing else would,
    // because codex has no between-turns channel at all.
    setTerminals([]);
    expect(agent.backgroundWorkCount()).toBe(1);
    await priv.backgroundTerminalRefresh;
    expect(agent.backgroundWorkCount()).toBe(0);
    expect(calls()).toBe(afterSeed + 1);

    // Second read inside the gap: no second walk. (The count is 0 now, so force
    // the level back up to prove the THROTTLE and not the zero short-circuit.)
    setTerminals([{ id: 'term-4' }]);
    await priv.syncBackgroundTerminalsIntoSink({ push: () => {} });
    const beforeThrottled = calls();
    expect(agent.backgroundWorkCount()).toBe(1);
    expect(agent.backgroundWorkCount()).toBe(1);
    expect(calls()).toBe(beforeThrottled);

    // The gap is a clock, not a latch: an older stamp lets the next read poll.
    priv.lastBackgroundTerminalRefreshAt = 0;
    setTerminals([]);
    expect(agent.backgroundWorkCount()).toBe(1);
    await priv.backgroundTerminalRefresh;
    expect(agent.backgroundWorkCount()).toBe(0);
  });
});

describe('UA12.101 · a between-turns refresh hands its terminal events to the host door when no turn is open', () => {
  afterEach(() => cleanupModeState(KEY));

  function withDoor(processing: boolean): { priv: Private; delivered: AgentEvent[]; setTerminals: (t: unknown[]) => void } {
    const delivered: AgentEvent[] = [];
    const made = makeAgent();
    (made.agent as unknown as { config: BackendConfig }).config.onBetweenTurnsEvent = event => { delivered.push(event); };
    (made.agent as unknown as { processing: boolean }).processing = processing;
    return { priv: made.priv, delivered, setTerminals: made.setTerminals };
  }

  it('no turn open: the announcement and the exit reach the door, nothing is parked', async () => {
    const { priv, delivered, setTerminals } = withDoor(false);
    setTerminals([{ id: 'term-5', command: 'sleep 20' }]);
    priv.scheduleBackgroundTerminalRefresh();
    await priv.backgroundTerminalRefresh;
    setTerminals([]);
    priv.lastBackgroundTerminalRefreshAt = 0;
    priv.scheduleBackgroundTerminalRefresh();
    await priv.backgroundTerminalRefresh;
    expect(delivered.map(e => e.type)).toEqual(['shell_backgrounded', 'task_completed']);
    expect((delivered[1] as { taskId?: string }).taskId).toBe('term-5');
    expect(priv.pendingBackgroundTerminalEvents).toEqual([]);
  });

  it('a turn open: the events stay parked for that turn\'s head, the door gets nothing', async () => {
    const { priv, delivered, setTerminals } = withDoor(true);
    setTerminals([{ id: 'term-6' }]);
    priv.scheduleBackgroundTerminalRefresh();
    await priv.backgroundTerminalRefresh;
    expect(delivered).toEqual([]);
    expect(priv.pendingBackgroundTerminalEvents.map(e => e.type)).toEqual(['shell_backgrounded']);
  });

  it('a refresh that sees the exit while a turn is open reaches the door when that turn ends, not at the next turn', async () => {
    // The verifier's scenario, through the real `chatImpl`: a terminal known from
    // turn N exits during turn N+1, and a busy/reaper read (`backgroundWorkCount`)
    // runs the throttled refresh that sees it while `processing` is true — so it
    // parks. The adapter has already forgotten the terminal, the turn-end refresh
    // is inside the throttle gap and the level is 0, so nothing polls again: only
    // the turn's own end can hand the parked `task_completed` to the host.
    const delivered: AgentEvent[] = [];
    const { agent, priv, setTerminals } = makeAgent();
    (agent as unknown as { config: BackendConfig }).config.onBetweenTurnsEvent = event => { delivered.push(event); };
    const internals = agent as unknown as {
      client: { request: (method: string, params?: unknown) => Promise<unknown> };
      ensureRuntime: () => Promise<void>;
      handleNotification: (m: string, p: unknown) => void;
      chatImpl: (m: string) => AsyncGenerator<AgentEvent>;
    };
    const listOnly = internals.client;
    let midTurnCount = -1;
    internals.client = {
      ...listOnly,
      request(method: string, params?: unknown) {
        if (method === 'turn/start') {
          void (async () => {
            setTerminals([]);
            midTurnCount = agent.backgroundWorkCount();
            await priv.backgroundTerminalRefresh;
            internals.handleNotification('turn/completed', {});
          })();
          return Promise.resolve({});
        }
        if (method === 'thread/backgroundTerminals/list') return listOnly.request(method, params);
        return Promise.resolve({ thread: { id: 'thread-bgwork' } });
      },
    };
    const client = internals.client;
    internals.ensureRuntime = async () => { internals.client = client; };
    agent.setCapabilityTurnRuntime({ view: { skills: [] } } as never);
    setTerminals([{ id: 'term-x', command: 'npm run dev' }]);

    const events: AgentEvent[] = [];
    for await (const event of internals.chatImpl('turn N+1')) events.push(event);
    await priv.backgroundTerminalRefresh;

    // Control: the turn's head announced it and the mid-turn read saw the level 1.
    expect(events.filter(e => e.type === 'shell_backgrounded').length).toBe(1);
    expect(midTurnCount).toBe(1);
    expect(agent.backgroundWorkCount()).toBe(0);
    expect(delivered.map(e => e.type)).toEqual(['task_completed']);
    expect((delivered[0] as { taskId?: string }).taskId).toBe('term-x');
    expect(priv.pendingBackgroundTerminalEvents).toEqual([]);
  });

  it('the turn whose refresh saw the exit sends its Stop hook a background_tasks without the ended terminal', async () => {
    // The same scenario, read where the row names it: the Stop hook's
    // `background_tasks`. `SessionManager`'s port reads `backgroundShellCommands`,
    // which the turn's `shell_backgrounded` fills and the door's `task_completed`
    // retires (synchronously, before `processEvent`'s first await) — mirrored
    // here by one set. The parked `task_completed` must reach the door BEFORE
    // `chatImpl`'s `finally` builds the Stop input, or the hook of the very turn
    // that saw the exit is told the shell still runs.
    const shells = new Set<string>();
    const stopReads: string[][] = [];
    const { agent, priv, setTerminals } = makeAgent();
    const config = (agent as unknown as { config: BackendConfig }).config;
    config.onBetweenTurnsEvent = event => {
      if (event.type === 'task_completed') shells.delete(event.taskId);
    };
    config.hookTaskRegistryPort = {
      backgroundTasks: () => {
        const ids = [...shells];
        stopReads.push(ids);
        return ids.map(id => ({ id, type: 'shell', status: 'running' })) as never;
      },
      sessionCrons: () => [],
    };
    const internals = agent as unknown as {
      client: { request: (method: string, params?: unknown) => Promise<unknown> };
      ensureRuntime: () => Promise<void>;
      handleNotification: (m: string, p: unknown) => void;
      chatImpl: (m: string) => AsyncGenerator<AgentEvent>;
    };
    const listOnly = internals.client;
    internals.client = {
      ...listOnly,
      request(method: string, params?: unknown) {
        if (method === 'turn/start') {
          void (async () => {
            setTerminals([]);
            agent.backgroundWorkCount();
            await priv.backgroundTerminalRefresh;
            internals.handleNotification('turn/completed', {});
          })();
          return Promise.resolve({});
        }
        if (method === 'thread/backgroundTerminals/list') return listOnly.request(method, params);
        return Promise.resolve({ thread: { id: 'thread-bgwork' } });
      },
    };
    const client = internals.client;
    internals.ensureRuntime = async () => { internals.client = client; };
    agent.setCapabilityTurnRuntime({ view: { skills: [] } } as never);
    setTerminals([{ id: 'term-x', command: 'npm run dev' }]);

    let announced = 0;
    for await (const event of internals.chatImpl('turn N+1')) {
      if (event.type === 'shell_backgrounded') {
        announced += 1;
        shells.add(event.shellId);
      }
    }
    await priv.backgroundTerminalRefresh;

    // Control: the head announced term-x, so the set held it during the turn.
    expect(announced).toBe(1);
    // Exactly one Stop read, and it no longer lists the terminal that exited.
    expect(stopReads).toEqual([[]]);
    expect([...shells]).toEqual([]);
    expect(priv.pendingBackgroundTerminalEvents).toEqual([]);
  });
});

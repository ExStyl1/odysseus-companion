/**
 * T5 — the codex host-callback bridge, driven end to end at the process level.
 *
 * The REAL bundled `session-mcp-server` is spawned with
 * `--external-standalone-only` and talks MCP over stdio, exactly as codex
 * spawns it; the REAL host bridge (`startCodexSessionCallbackBridge`) serves it
 * over loopback. Only the PORTS behind the bridge are fakes, and they are the
 * right place for a fake: what these rows measure is the transport and the
 * advertisement, and the ports' real behaviour is measured against a real
 * `SessionCronService`, a real `GoalService` and the real Monitor gate in
 * `server-core/.../codex-callback-bridge-host.test.ts`.
 *
 * The three rows the plan asks for, plus the wakeup pair:
 *   - no bridge port → the 18-tool surface, unchanged
 *   - a bridge port → 27 (26 until `ReviewDiff` was bridged), and `CronCreate` reaches the host port for real
 *   - a request naming another session is rejected before any port is touched
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChildPool, type PooledRpcResponse } from './__tests__/child-pool.ts';
import type {
  SessionCronPort,
  SessionGoalPort,
  SessionMonitorPort,
} from '@nessy-agent/session-tools-core';
import { closedStatusRefusal } from '@nessy-agent/session-tools-core';
import {
  startCodexSessionCallbackBridge,
  type CodexSessionCallbackBridgeHandle,
} from '@nessy-agent/shared/agent/backend/codex/session-callback-bridge';

const SESSION_ID = 'codex-bridge-session';
const PROJECTED = ['Monitor', 'CronCreate', 'CronList', 'CronDelete', 'CronControl', 'ScheduleWakeup'];
/**
 * P3.10 — the bridge also carries `ProcessStop` (its monitor half).
 * P2.2 — and the goal pair, over the three `goal/*` routes.
 * P3.222 — and the ROSTER pair, over `session/list` and `session/info`. They are
 * a DELTA now for a reason the other names are not: they were advertised on the
 * bare surface until this row and could only answer "not available in this
 * context" there, so joining the bridged set is what makes the advertisement
 * true rather than what widens it.
 */
/**
 * P6.184 — and `PushNotification`, whose difference from every other name here
 * is that codex has NO notification the model can reach; the others were host
 * ports whose binding site was merely gated.
 *
 * TWO of the names on this line were already missing when P6.184 measured it,
 * and the case was RED at HEAD for both: `CronControl` (P6.295 arm 2) and
 * `archive_session` (P6.466) joined the bridged set without this local list
 * growing. It is a hand-written mirror of
 * `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK` — it has to be, because this case
 * drives a REAL subprocess and asserts the delta the flag makes — so it goes
 * stale exactly one row at a time.
 */
// `ReviewDiff` joined the bridged set with C4.42 (2026-09-13, the codex detached review's callback bridge);
// the 1.38.0 close-out run found this row one name short.
// UA1.3 (2026-10-02) — `set_session_labels` and `set_session_status` joined it, and this mirror moved in the same commit.
// UA1.18 (2026-10-02) — `publish_artifact` and `list_artifacts` joined it, and this mirror moved in the same commit.
// UA3.5 (2026-10-02) — `create_board_task` joined it, and this mirror moved in the same commit.
// UA6.3 (2026-10-02) — the six page tools joined it, and this mirror moved in the same commit.
const BRIDGED = [...PROJECTED, 'ProcessStop', 'GoalGet', 'Goal', 'send_agent_message', 'list_sessions', 'get_session_info', 'archive_session', 'PushNotification', 'EnterWorktree', 'ExitWorktree', 'WorktreeBatch', 'ReviewDiff', 'set_session_labels', 'set_session_status', 'publish_artifact', 'list_artifacts', 'create_board_task', 'project_memory_append', 'list_pages', 'get_page', 'create_page', 'update_page', 'write_page_data', 'delete_page', 'source_list_prompts', 'source_get_prompt']; // UB1.12 — the append-only project-memory note joins the bridged set; UB7.11 — the MCP prompt pair joins it

/** P3.222 — the pair `cross-session-messaging.md` names as one capability. */
const ROSTER = ['list_sessions', 'get_session_info'];

/** This file's reply shape; the pool is generic in exactly this (P6.908). */
type RpcResponse = PooledRpcResponse<{
  tools?: Array<{ name: string }>;
  content?: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

/**
 * ONE child per distinct argv for the WHOLE FILE, instead of one per case
 * (P6.901).
 *
 * This server's boot is a cold, I/O-bound module graph — 28.3–46.6 s in a direct
 * probe and 70 689 ms under `bun test` at load 12.8 (P6.893's measurements). The
 * sixteen cases below spawned EIGHTEEN children between them and paid it
 * eighteen times, for children that differ in exactly two spawn-time facts: the
 * bridge port and the advisor flag. Seven distinct argv remain, so seven boots
 * do.
 *
 * WHAT THE CASES ARE NO LONGER ISOLATED FROM, stated because sharing a child is
 * a real trade and an unstated one is a trap:
 *  - the WORKSPACE directory, the plans folder and the config root, now created
 *    once for the file rather than once per case;
 *  - the SERVER PROCESS, for every case that spawns the same argv, so anything
 *    `index.ts` keeps between requests is carried between them. Every tool these
 *    cases call is a BRIDGED one, proxied straight to the host ports below, so
 *    none of them writes server-local state;
 *  - the BRIDGES, three of them, on stable ports for the life of the file — the
 *    port is in the child's argv, so a per-case bridge is a per-case child.
 * What stays PER CASE is the thing that would make a shared child dishonest: the
 * host ports and the advisor behind those bridges. `resolvePorts` is consulted
 * per REQUEST and `advisorConsult` delegates to a per-case value, so every
 * assertion about what the host was ASKED, every id it minted and every refusal
 * a case reads is still that case's own. A case does not return until every id
 * it asked for has answered, so a call raised by an earlier case cannot land on
 * a later case's ports — which is the property the per-case SIGKILL used to buy.
 *
 * What is NOT shared, deliberately: the three bridges differ in facts a case
 * cannot swap underneath a running child — the session that owns the bridge, and
 * whether a consult is bound on `options.advisorConsult` at construction. Those
 * cases keep their own bridge and therefore their own child.
 */
const pool = createChildPool<RpcResponse['result']>();

/** Run one exchange on the child that owns this argv, and answer by CALLER id. */
const runMcpSession = (args: string[], requests: object[]) => pool.runMcpSession(args, requests);

/** Records every call so a row can assert what the host was actually asked. */
function fakePorts() {
  const calls: Array<{ method: string; args: unknown }> = [];
  const cronPort: SessionCronPort = {
    create: async input => {
      calls.push({ method: 'cron.create', args: input });
      return { id: 'ab12cd34', schedule: input.schedule ?? 'dynamic', recurring: input.recurring, prompt: input.prompt };
    },
    list: async () => {
      calls.push({ method: 'cron.list', args: undefined });
      return [{ id: 'ab12cd34', schedule: '0 9 * * *', recurring: true, prompt: 'daily standup' }];
    },
    remove: async id => {
      calls.push({ method: 'cron.remove', args: id });
      return true;
    },
    rearmWakeup: async input => {
      calls.push({ method: 'cron.rearmWakeup', args: input });
      return { firesAt: 1_800_000_000_000 };
    },
    stopWakeup: async () => {
      calls.push({ method: 'cron.stopWakeup', args: undefined });
      return true;
    },
  };
  // A live-watch registry so "the watch ended" is a real state transition the
  // ProcessStop round-trip can observe, not just a recorded call.
  const liveWatches = new Set<string>();
  let monitorSeq = 0;
  const monitorPort: SessionMonitorPort = {
    start: async input => {
      calls.push({ method: 'monitor.start', args: input });
      const taskId = `monitor-${++monitorSeq}`;
      liveWatches.add(taskId);
      return { taskId, timeoutMs: 300_000, ...(input.persistent ? { persistent: true } : {}) };
    },
    stop: async taskId => {
      calls.push({ method: 'monitor.stop', args: taskId });
      return liveWatches.delete(taskId);
    },
  };
  // P2.2 — a goal store just real enough for "the record changed" to be a state
  // transition the round-trip can observe, not merely a recorded call.
  let goal: Record<string, unknown> | undefined;
  const goalPort: SessionGoalPort = {
    execute: async args => {
      calls.push({ method: 'goal.execute', args });
      const action = (args as { action?: string }).action;
      if (action === 'create') {
        goal = { id: 'goal-77', revision: 1, status: 'active', condition: (args as { condition?: string }).condition };
      }
      if (action === 'cancel') goal = { ...goal, status: 'cancelled', revision: 2 };
      return { schemaVersion: 1, ...(goal ? { goal } : {}) };
    },
  };
  // P3.222 — the roster half of the messaging pair. A workspace with a real peer
  // in it, so "the roster arrived" is a name the subprocess could not have
  // invented rather than an empty list that also matches a dead binding.
  const listSessionsFn = (options?: { limit?: number }) => {
    calls.push({ method: 'sessions.list', args: options });
    return {
      total: 2,
      returned: 2,
      sessions: [
        { id: SESSION_ID, name: 'this codex session', labels: [], status: 'todo', createdAt: 1 },
        { id: 'peer-9', name: 'the peer worth messaging', labels: ['bug'], status: 'todo', createdAt: 2 },
      ],
    };
  };
  const getSessionInfoFn = (sessionId?: string) => {
    calls.push({ method: 'sessions.info', args: sessionId });
    return {
      id: sessionId ?? SESSION_ID,
      name: sessionId === 'peer-9' ? 'the peer worth messaging' : 'this codex session',
      labels: [],
      status: 'todo',
      permissionMode: 'default',
      createdAt: 1,
      isActive: true,
    };
  };
  return {
    calls,
    liveWatches,
    cronPort,
    monitorPort,
    goalPort,
    listSessionsFn,
    getSessionInfoFn,
    currentGoal: () => goal,
  };
}

let ports: ReturnType<typeof fakePorts>;
let workspace: string;

/**
 * The three bridges, all built once and all on stable ports. They differ only in
 * the two facts a case cannot swap underneath a running child: WHO owns the
 * session, and whether a consult is bound at construction on
 * `options.advisorConsult` (which the bridge prefers over the resolve seam, so
 * "bound" and "unbound" cannot be the same handle).
 */
let ownBridge!: CodexSessionCallbackBridgeHandle;
let ownBridgeUnboundAdvisor!: CodexSessionCallbackBridgeHandle;
let foreignBridge!: CodexSessionCallbackBridgeHandle;

/** Per case, and read per REQUEST — this is what keeps a shared bridge honest. */
let boundAdvisor: ((args: Record<string, unknown>) => Promise<string>) | undefined;
let seamAdvisor: ((args: Record<string, unknown>) => Promise<string>) | undefined;
let rosterBound = false;
/** UA1.3 — the self-management pair's four registry slots, bound per case like the roster. */
let statusLabelsBound: ReturnType<typeof fakeStatusLabelsPorts> | undefined;
/** UA1.18 — the artifact pair's two registry slots, bound per case like the roster. */
let artifactsBound: ReturnType<typeof fakeArtifactPorts> | undefined;
/** UA3.5 — the board task tool's registry slot, bound per case like the roster. */
let boardTaskBound: ReturnType<typeof fakeBoardTaskPort> | undefined;
/** UB1.12 — the project-memory registry slot, bound per case like the board task's. */
let projectMemoryBound: ReturnType<typeof fakeProjectMemoryPort> | undefined;
/** UA6.3 — the page tools' grouped registry slot (`pages`), bound per case like the roster. */
let pagesBound: ReturnType<typeof fakePagesPort> | undefined;
/** UB7.11 — the MCP prompts' grouped registry slot (`mcpSources`), bound per case like the pages'. */
let mcpSourcesBound: ReturnType<typeof fakeMcpSourcesPort> | undefined;

const resolvePortsForCase = () => ({
  cronPort: ports.cronPort,
  monitorPort: ports.monitorPort,
  goalPort: ports.goalPort,
  ...(rosterBound ? { listSessionsFn: ports.listSessionsFn, getSessionInfoFn: ports.getSessionInfoFn } : {}),
  ...(statusLabelsBound ?? {}),
  ...(artifactsBound ? { publishArtifactFn: artifactsBound.publishArtifactFn, listArtifactsFn: artifactsBound.listArtifactsFn } : {}),
  ...(boardTaskBound ? { createBoardTaskFn: boardTaskBound.createBoardTaskFn } : {}),
  ...(projectMemoryBound ? { appendProjectMemoryFn: projectMemoryBound.appendProjectMemoryFn } : {}),
  ...(pagesBound ? { pages: pagesBound.pages } : {}),
  ...(mcpSourcesBound ? { mcpSources: mcpSourcesBound.mcpSources } : {}),
  ...(seamAdvisor ? { advisorConsultFn: seamAdvisor } : {}),
});

/** Bound at construction, delegating to the case's own advisor. */
const consultViaCaseAdvisor = async (args: Record<string, unknown>): Promise<string> => {
  if (!boundAdvisor) throw new Error('no case bound an advisor on this bridge');
  return boundAdvisor(args);
};

beforeAll(async () => {
  ports = fakePorts();
  workspace = mkdtempSync(join(tmpdir(), 'smcp-bridge-'));
  ownBridge = await startCodexSessionCallbackBridge({
    sessionKey: { workspaceId: 'ws-1', sessionId: SESSION_ID },
    resolvePorts: resolvePortsForCase,
    advisorConsult: consultViaCaseAdvisor,
  });
  ownBridgeUnboundAdvisor = await startCodexSessionCallbackBridge({
    sessionKey: { workspaceId: 'ws-1', sessionId: SESSION_ID },
    resolvePorts: resolvePortsForCase,
  });
  foreignBridge = await startCodexSessionCallbackBridge({
    sessionKey: { workspaceId: 'ws-1', sessionId: 'a-different-session' },
    resolvePorts: resolvePortsForCase,
    advisorConsult: consultViaCaseAdvisor,
  });
});

beforeEach(() => {
  ports = fakePorts();
  boundAdvisor = undefined;
  seamAdvisor = undefined;
  rosterBound = false;
  statusLabelsBound = undefined;
  artifactsBound = undefined;
  boardTaskBound = undefined;
  projectMemoryBound = undefined;
  pagesBound = undefined;
  mcpSourcesBound = undefined;
});

afterAll(async () => {
  await pool.killAll();
  await Promise.all([ownBridge?.close(), ownBridgeUnboundAdvisor?.close(), foreignBridge?.close()]);
  rmSync(workspace, { recursive: true, force: true });
});

/** The case binds its advisor where `options.advisorConsult` is the supplier. */
function withBoundAdvisor(
  advisor: ReturnType<typeof fakeAdvisor>,
  handle: CodexSessionCallbackBridgeHandle = ownBridge,
): CodexSessionCallbackBridgeHandle {
  boundAdvisor = advisor.consult;
  return handle;
}

/** The case publishes its consult on the RESOLVE seam instead — the other
 *  supplier of the same route, which is why this needs the unbound handle. */
function withSeamAdvisor(advisor: ReturnType<typeof fakeAdvisor>): CodexSessionCallbackBridgeHandle {
  seamAdvisor = advisor.consult;
  return ownBridgeUnboundAdvisor;
}

/** The case binds the roster pair behind the bridge. */
function withRoster(): CodexSessionCallbackBridgeHandle {
  rosterBound = true;
  return ownBridge;
}

function spawnArgs(bridgePort?: number, advisorConsult = false): string[] {
  return [
    '--session-id', SESSION_ID,
    '--workspace-root', workspace,
    '--plans-folder', join(workspace, 'plans'),
    '--config-root', workspace,
    '--external-standalone-only',
    ...(typeof bridgePort === 'number' ? ['--host-callback-port', String(bridgePort)] : []),
    // P3.13 — the second flag. The host emits it only when a bridge exists AND
    // `advisorEnabled` is on; here the rows set the two independently, which is
    // what lets the "flag alone lifts nothing" case be measured.
    ...(advisorConsult ? ['--advisor-consult'] : []),
  ];
}

/** P3.13 — a host-side consult that records what it was actually handed. */
function fakeAdvisor() {
  const seen: Array<Record<string, unknown>> = [];
  return {
    seen,
    consult: async (args: Record<string, unknown>) => {
      seen.push(args);
      return `Advisor (advisor-model-x):\n\nCheck the assumption before you write the migration.`;
    },
  };
}

describe('session-mcp-server host-callback bridge (real process, real bridge)', () => {
  /**
   * Counts here are RELATIVE, deliberately. The absolute 18 → 23 is pinned at
   * the registry, in `session-tools-core/src/scheduling-projection.test.ts`;
   * this process additionally resolves `isDeveloperFeedbackEnabled()` from its
   * own environment, so an absolute here would measure that flag as well as the
   * bridge. What must hold at the process level is the DELTA and its membership.
   */
  test('WITHOUT the bridge port the five are absent and refuse recoverably', async () => {
    const responses = await runMcpSession(spawnArgs(), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'CronCreate', arguments: { schedule: '0 9 * * *', prompt: 'daily standup' } } },
    ]);

    const list = responses.get(2)?.result?.tools?.map(t => t.name) ?? [];
    for (const name of PROJECTED) expect(list).not.toContain(name);
    // Positive control: the filter ran and kept the standalone tools.
    expect(list).toContain('source_test');
    expect(list.length).toBeGreaterThan(0);

    // A gated tool still answers recoverably rather than throwing.
    expect(responses.get(3)?.result?.isError).toBe(true);
    expect(responses.get(3)?.result?.content?.[0]?.text ?? '').toContain('requires a Nessy-side host callback');
  }, 330_000);

  test('WITH the bridge port the six are advertised and CronCreate round-trips to the host', async () => {
    const bridge = ownBridge;

    const plain = await runMcpSession(spawnArgs(), [{ jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    const responses = await runMcpSession(spawnArgs(bridge.port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'CronCreate', arguments: { schedule: '0 9 * * *', prompt: 'daily standup' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'CronList', arguments: {} } },
    ]);

    const before = plain.get(2)?.result?.tools?.map(t => t.name) ?? [];
    const list = responses.get(2)?.result?.tools?.map(t => t.name) ?? [];
    // The same binary, the same arguments but one — so the difference IS the flag.
    expect(list.filter(name => !before.includes(name)).sort()).toEqual([...BRIDGED].sort());
    expect(list.length - before.length).toBe(BRIDGED.length);
    for (const name of BRIDGED) expect(list).toContain(name);

    // The tool answered for real: the host port was called with what the
    // handler parsed, and the reply carries the host's own record id.
    const created = responses.get(3)?.result;
    expect(created?.isError).toBeFalsy();
    expect(created?.content?.[0]?.text ?? '').toContain('ab12cd34');
    expect(ports.calls.filter(c => c.method === 'cron.create')).toEqual([
      { method: 'cron.create', args: { schedule: '0 9 * * *', recurring: true, prompt: 'daily standup' } },
    ]);
    expect(responses.get(4)?.result?.content?.[0]?.text ?? '').toContain('daily standup');
  }, 330_000);

  test('ScheduleWakeup re-arms and stops through the bridge', async () => {
    const bridge = ownBridge;

    const responses = await runMcpSession(spawnArgs(bridge.port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ScheduleWakeup', arguments: { delaySeconds: 60, reason: 'poll again' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ScheduleWakeup', arguments: { stop: true } } },
    ]);

    expect(responses.get(2)?.result?.isError).toBeFalsy();
    expect(responses.get(3)?.result?.isError).toBeFalsy();
    expect(ports.calls.map(c => c.method)).toEqual(['cron.rearmWakeup', 'cron.stopWakeup']);
    expect(ports.calls[0]?.args).toEqual({ delayMs: 60_000 });
  }, 330_000);

  // P3.10 — the row's subject: a persistent codex watch, started over the real
  // bridge through the real subprocess, is stopped by ProcessStop, and the watch
  // actually ends. The fake port tracks a live-watch registry so "ended" is a
  // state transition, not merely a recorded call. Its companion in
  // `server-core/.../codex-callback-bridge-host.test.ts` re-proves the end
  // against the REAL SessionMonitorService.
  test('ProcessStop stops a persistent Monitor watch through the bridge', async () => {
    const bridge = ownBridge;

    const responses = await runMcpSession(spawnArgs(bridge.port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'Monitor', arguments: { description: 'watch the log', persistent: true, command: 'tail -f /var/log/system.log' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ProcessStop', arguments: { shell_id: 'monitor-1' } } },
    ]);

    // ProcessStop is advertised now — the near-miss T5 left is closed.
    expect(responses.get(2)?.result?.tools?.map(t => t.name) ?? []).toContain('ProcessStop');

    // The persistent watch started and is live.
    const started = responses.get(3)?.result;
    expect(started?.isError).toBeFalsy();
    expect(started?.content?.[0]?.text ?? '').toContain('persistent: true');
    expect((started?.structuredContent as { taskId?: string })?.taskId).toBe('monitor-1');

    // ProcessStop ended it — over the bridge's `monitor/stop`, with the watch
    // gone from the live registry.
    const stopped = responses.get(4)?.result;
    expect(stopped?.isError).toBeFalsy();
    expect(stopped?.content?.[0]?.text ?? '').toContain('Stopped monitor');
    expect(ports.calls.filter(c => c.method === 'monitor.stop')).toEqual([
      { method: 'monitor.stop', args: 'monitor-1' },
    ]);
    expect(ports.liveWatches.size).toBe(0);
  }, 330_000);

  /**
   * P2.2 — the goal pair, through the REAL subprocess over the REAL bridge.
   *
   * The subprocess resolves ONE port (`ctx.goalPort`) and its client picks the
   * route from the action, so this is the row that proves the split routing
   * works end to end: three tool calls, three different routes, one host port —
   * and the fake's own record moves from absent to active to cancelled, so
   * "it round-tripped" is a state transition rather than a recorded call.
   */
  test('Goal and GoalGet round-trip to the host port over the three goal routes', async () => {
    const bridge = ownBridge;

    const responses = await runMcpSession(spawnArgs(bridge.port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'Goal', arguments: { action: 'create', condition: 'Ship the retry' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'GoalGet', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'Goal', arguments: { action: 'cancel', id: 'goal-77', revision: 1, reason: 'changed my mind' } } },
    ]);

    for (const id of [2, 3, 4]) expect(responses.get(id)?.result?.isError).toBeFalsy();
    expect(responses.get(3)?.result?.content?.[0]?.text ?? '').toContain('Ship the retry');
    expect(responses.get(4)?.result?.content?.[0]?.text ?? '').toContain('cancelled');

    // `GoalGet` carries no arguments — the handler mints `{ action: 'get' }`,
    // which the client routes to `goal/get`; the other two split by effect.
    expect(ports.calls.filter(c => c.method === 'goal.execute').map(c => c.args)).toEqual([
      { action: 'create', condition: 'Ship the retry' },
      { action: 'get' },
      { action: 'cancel', id: 'goal-77', revision: 1, reason: 'changed my mind' },
    ]);
    expect(ports.currentGoal()).toMatchObject({ status: 'cancelled', revision: 2 });
  }, 330_000);

  // The negative half at the process level: without a bridge the goal pair is
  // absent from the surface and refuses recoverably, exactly like the cron four.
  test('WITHOUT the bridge port the goal pair is absent and refuses recoverably', async () => {
    const responses = await runMcpSession(spawnArgs(), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'Goal', arguments: { action: 'create', condition: 'Ship it' } } },
    ]);

    const list = responses.get(2)?.result?.tools?.map(t => t.name) ?? [];
    expect(list).not.toContain('Goal');
    expect(list).not.toContain('GoalGet');
    expect(responses.get(3)?.result?.isError).toBe(true);
    expect(responses.get(3)?.result?.content?.[0]?.text ?? '').toContain('requires a Nessy-side host callback');
  }, 330_000);

  /**
   * P3.13 — the row's subject, end to end: a codex session consults the advisor
   * and the guidance comes back as ordinary tool text the next model step reads.
   *
   * `advisor_consult` is `executionMode: 'backend'`, the one class the eight
   * bridged PORT tools never lifted, so this is also the proof that the second
   * flag reaches the filter rather than being accepted and dropped.
   */
  test('advisor_consult is advertised on its own flag and round-trips guidance to the host', async () => {
    const advisor = fakeAdvisor();
    const bridge = withBoundAdvisor(advisor);

    const bridgeOnly = await runMcpSession(spawnArgs(bridge.port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    const responses = await runMcpSession(spawnArgs(bridge.port, true), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: {
          name: 'advisor_consult',
          arguments: {
            moment: 'approach',
            question: 'Should I migrate the store first?',
            context: 'Two callers still read the old shape',
            // Not in the schema — the host's whitelist drops it before the
            // consult sees it, the belt `pickMonitorStartInput` established.
            sessionKey: { workspaceId: 'other', sessionId: 'other' },
          },
        },
      },
    ]);

    // Same binary, same arguments but the one flag — so the delta IS the flag.
    const before = bridgeOnly.get(2)?.result?.tools?.map(t => t.name) ?? [];
    const list = responses.get(2)?.result?.tools?.map(t => t.name) ?? [];
    expect(before).not.toContain('advisor_consult');
    expect(list.filter(name => !before.includes(name))).toEqual(['advisor_consult']);

    // The guidance arrived verbatim, as a NON-error result — the model reads it
    // and continues the same turn, which is the whole injection channel.
    const consulted = responses.get(3)?.result;
    expect(consulted?.isError).toBeFalsy();
    expect(consulted?.content?.[0]?.text ?? '').toContain('Check the assumption before you write the migration.');

    // The host was handed the three declared fields and nothing else.
    expect(advisor.seen).toEqual([{
      moment: 'approach',
      question: 'Should I migrate the store first?',
      context: 'Two callers still read the old shape',
    }]);
  }, 330_000);

  // Fail-closed control, first half: the bridge alone does not lift it. Without
  // the advisor flag the tool is absent AND a call refuses recoverably — the
  // turn survives, and the host consult is never reached.
  test('WITH the bridge but WITHOUT the advisor flag it is absent and refuses recoverably', async () => {
    const advisor = fakeAdvisor();
    const bridge = withBoundAdvisor(advisor);

    const responses = await runMcpSession(spawnArgs(bridge.port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'advisor_consult', arguments: { moment: 'approach', question: 'anything?' } } },
    ]);

    const list = responses.get(2)?.result?.tools?.map(t => t.name) ?? [];
    expect(list).not.toContain('advisor_consult');
    // Positive control: the bridged eight ARE there, so "absent" is this flag
    // and not a spawn that lost its bridge.
    for (const name of BRIDGED) expect(list).toContain(name);
    expect(responses.get(3)?.result?.isError).toBe(true);
    expect(responses.get(3)?.result?.content?.[0]?.text ?? '').toContain('requires a Nessy-side host callback');
    expect(advisor.seen).toEqual([]);
  }, 330_000);

  // Fail-closed control, second half: the flag alone does not lift it either.
  // Its route lives on the bridge, so a spawn claiming the advisor without one
  // must advertise nothing — never a tool whose call has nowhere to land.
  test('the advisor flag WITHOUT a bridge port lifts nothing', async () => {
    const responses = await runMcpSession(spawnArgs(undefined, true), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'advisor_consult', arguments: { moment: 'approach', question: 'anything?' } } },
    ]);

    const list = responses.get(2)?.result?.tools?.map(t => t.name) ?? [];
    expect(list).not.toContain('advisor_consult');
    expect(list).toContain('source_test');
    expect(responses.get(3)?.result?.isError).toBe(true);
    expect(responses.get(3)?.result?.content?.[0]?.text ?? '').toContain('requires a Nessy-side host callback');
  }, 330_000);

  /**
   * Fail-closed control, the one that matters most: the route exists, the tool
   * is advertised, and NOTHING is bound behind it. The turn proceeds — the reply
   * is the documented sentence, it is not an error, and no guidance is invented.
   *
   * The same sentence the Claude adapter returns from its own empty-callback
   * branch (`ADVISOR_UNBOUND_REPLY`), which is why this route resolves the
   * consult instead of `requirePort`-ing it like the ten port routes.
   */
  test('an unbound consult answers the documented sentence, not an error and not advice', async () => {
    // No `advisorConsult`, and the registry slot is empty too.
    const bridge = ownBridgeUnboundAdvisor;

    const responses = await runMcpSession(spawnArgs(bridge.port, true), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'advisor_consult', arguments: { moment: 'before-done', question: 'am I finished?' } } },
    ]);

    expect(responses.get(2)?.result?.tools?.map(t => t.name) ?? []).toContain('advisor_consult');
    const reply = responses.get(3)?.result;
    expect(reply?.isError).toBeFalsy();
    expect(reply?.content?.[0]?.text ?? '').toBe('The advisor is not available in this context. Continue on your own.');
  }, 330_000);

  // The seam the host resolves from when a host publishes the consult in the
  // per-session registry instead of binding it on the bridge (the slot the
  // Claude adapter reads). One route, two suppliers, one reply.
  test('a consult published on the resolve seam is served the same way', async () => {
    const advisor = fakeAdvisor();
    const bridge = withSeamAdvisor(advisor);

    const responses = await runMcpSession(spawnArgs(bridge.port, true), [
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'advisor_consult', arguments: { moment: 'recurring-error', question: 'why does this keep failing?' } } },
    ]);

    expect(responses.get(3)?.result?.isError).toBeFalsy();
    expect(responses.get(3)?.result?.content?.[0]?.text ?? '').toContain('Check the assumption');
    expect(advisor.seen).toEqual([{ moment: 'recurring-error', question: 'why does this keep failing?' }]);
  }, 330_000);

  // The T5 owner belt covers the eleventh route too: a bridge bound to another
  // session refuses before the consult is resolved, let alone called.
  test('a bridge bound to another session rejects the consult and never calls it', async () => {
    const advisor = fakeAdvisor();
    const bridge = withBoundAdvisor(advisor, foreignBridge);

    const responses = await runMcpSession(spawnArgs(bridge.port, true), [
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'advisor_consult', arguments: { moment: 'approach', question: 'anything?' } } },
    ]);

    const rejected = responses.get(3)?.result;
    expect(rejected?.isError).toBe(true);
    expect(rejected?.content?.[0]?.text ?? '').toContain('session id does not match');
    expect(advisor.seen).toEqual([]);
  }, 330_000);

  test('a bridge bound to another session rejects the call and touches no port', async () => {
    // Same transport, same routes — only the owner differs. This is the shape a
    // second session on the same machine would have.
    const bridge = foreignBridge;

    const responses = await runMcpSession(spawnArgs(bridge.port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'CronCreate', arguments: { schedule: '0 9 * * *', prompt: 'daily standup' } } },
    ]);

    // The advertisement is a spawn-time decision and stays honest — what fails
    // is the call, with the reason named.
    const advertised = responses.get(2)?.result?.tools?.map(t => t.name) ?? [];
    for (const name of BRIDGED) expect(advertised).toContain(name);
    const rejected = responses.get(3)?.result;
    expect(rejected?.isError).toBe(true);
    expect(rejected?.content?.[0]?.text ?? '').toContain('session id does not match');
    expect(ports.calls).toEqual([]);
  }, 330_000);

  /**
   * P3.222 — the residue `6173c9778` left, driven at the process level.
   *
   * That commit closed "a codex session could LIST its peers and not message
   * one" by bridging `send_agent_message`. MEASURED 2026-09-02, the pair it left
   * behind was the SAME defect with the halves swapped, and worse than the row
   * thought: `list_sessions` and `get_session_info` were in NEITHER host-callback
   * set, so they survived the `externalStandaloneOnly` filter and were
   * ADVERTISED on both codex surfaces — while `createCodexContext` bound neither
   * closure, so every call answered `list_sessions is not available in this
   * context.` A codex session could write to a peer it had no way to enumerate,
   * and the roster tool it WAS offered was dead on arrival.
   *
   * `cross-session-messaging.md` names ONE capability with two tools — "Claude
   * uses two tools for this: `ListAgents` to discover which agents it can reach,
   * and `SendMessage` to deliver a message to one of them by name" — so the
   * halves now travel together: both withheld without a bridge, both real with
   * one.
   */
  test('WITHOUT the bridge the roster pair is withheld rather than advertised-and-dead', async () => {
    const responses = await runMcpSession(spawnArgs(), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } },
    ]);

    const list = responses.get(2)?.result?.tools?.map(t => t.name) ?? [];
    // The row: not offered at all. Before this change both names were HERE, and
    // the call below answered "not available in this context" — an offer the
    // runtime could never honour.
    for (const name of ROSTER) expect(list).not.toContain(name);
    // Its write sibling is withheld on the same surface, which is the property
    // that makes the pair uniform instead of half-advertised.
    expect(list).not.toContain('send_agent_message');
    // Positive control: the filter ran and kept the standalone tools.
    expect(list).toContain('source_test');

    // Withheld, not silent: the dispatcher answers recoverably and names WHY.
    expect(responses.get(3)?.result?.isError).toBe(true);
    expect(responses.get(3)?.result?.content?.[0]?.text ?? '')
      .toContain('requires a Nessy-side host callback');
  }, 330_000);

  test('WITH the bridge the roster pair answers for real, from the host registry', async () => {
    const bridge = withRoster();

    const responses = await runMcpSession(spawnArgs(bridge.port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_sessions', arguments: { limit: 5 } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_session_info', arguments: { sessionId: 'peer-9' } } },
    ]);

    const list = responses.get(2)?.result?.tools?.map(t => t.name) ?? [];
    for (const name of ROSTER) expect(list).toContain(name);
    // Both halves of the capability, on the same surface, at the same time.
    expect(list).toContain('send_agent_message');

    // The roster is the HOST's roster: a peer name this subprocess has no other
    // way to know. An empty list would also match a dead binding, which is why
    // the fake carries a real peer.
    const roster = responses.get(3)?.result;
    expect(roster?.isError).toBeFalsy();
    expect(roster?.content?.[0]?.text ?? '').toContain('the peer worth messaging');
    expect(roster?.content?.[0]?.text ?? '').toContain('peer-9');
    // The handler's own arguments reached the host port rather than being
    // dropped by the route's field narrowing.
    expect(ports.calls.filter(c => c.method === 'sessions.list')).toEqual([
      { method: 'sessions.list', args: { limit: 5 } },
    ]);

    const info = responses.get(4)?.result;
    expect(info?.isError).toBeFalsy();
    expect(info?.content?.[0]?.text ?? '').toContain('peer-9');
    expect(ports.calls.filter(c => c.method === 'sessions.info')).toEqual([
      { method: 'sessions.info', args: 'peer-9' },
    ]);
  }, 330_000);

  /**
   * The host closure is the authority, and an ABSENT one must read as absent
   * rather than as an empty workspace. A codex session handed `{"total": 0}`
   * would conclude it has no peers — the exact "reported as success" shape the
   * messaging page calls out for the write half.
   */
  test('a bridge with no roster binding refuses by name instead of answering an empty roster', async () => {
    const bridge = ownBridge;

    const responses = await runMcpSession(spawnArgs(bridge.port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } },
    ]);

    // Advertisement is a spawn-time decision and stays honest; the CALL fails.
    for (const name of ROSTER) {
      expect(responses.get(2)?.result?.tools?.map(t => t.name) ?? []).toContain(name);
    }
    const refused = responses.get(3)?.result;
    expect(refused?.isError).toBe(true);
    expect(refused?.content?.[0]?.text ?? '').toContain('list_sessions is unavailable for this session.');
    expect(refused?.content?.[0]?.text ?? '').not.toContain('"total": 0');
  }, 330_000);

  /**
   * UA1.3 — `set_session_status` and `set_session_labels` through the REAL subprocess, the real client functions and
   * the real bridge, onto registry slots shaped like `SessionManager`'s (exact id, then case-insensitive label; the
   * status carries its category). The handler that runs is the one Pi and Claude run, so the label resolves to its id
   * and UA1.2's closure refusal is the same sentence — and nothing reaches the set slot.
   */
  test('WITH the bridge the status/labels pair resolves and sets on the host, and a closed status is refused', async () => {
    const statusPorts = fakeStatusLabelsPorts();
    statusLabelsBound = statusPorts;

    const responses = await runMcpSession(spawnArgs(ownBridge.port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'set_session_status', arguments: { status: 'Needs Review' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'set_session_status', arguments: { status: 'Done' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'set_session_labels', arguments: { labels: ['Bug'] } } },
    ]);

    const list = responses.get(2)?.result?.tools?.map(t => t.name) ?? [];
    expect(list).toContain('set_session_status');
    expect(list).toContain('set_session_labels');

    const set = responses.get(3)?.result;
    expect(set?.isError).toBeFalsy();
    expect(set?.content?.[0]?.text ?? '').toContain('Status set to "needs-review" on current session.');

    const refused = responses.get(4)?.result;
    expect(refused?.isError).toBe(true);
    expect(refused?.content?.[0]?.text ?? '').toBe(`[ERROR] ${closedStatusRefusal('done')}`);

    const labels = responses.get(5)?.result;
    expect(labels?.isError).toBeFalsy();
    expect(labels?.content?.[0]?.text ?? '').toContain('Labels set on current session: bug');

    // The host saw exactly one status write and one label write — the refused `done` never left the subprocess.
    // UA1.18 — compared as a SET: the three calls are pipelined, so the two writes can land in either order (measured
    // 2026-10-02: labels landed first in a run of this file).
    expect([...statusPorts.writes].sort((a, b) => a.method.localeCompare(b.method))).toEqual([
      { method: 'labels.set', sessionId: undefined, value: ['bug'] },
      { method: 'status.set', sessionId: undefined, value: 'needs-review' },
    ]);
  }, 330_000);

  /** UA1.3 CONTROL — without the bridge port neither tool is advertised (withheld, not advertised-and-dead). */
  test('WITHOUT the bridge the status/labels pair is withheld', async () => {
    statusLabelsBound = fakeStatusLabelsPorts();
    const responses = await runMcpSession(spawnArgs(), [{ jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    const list = responses.get(2)?.result?.tools?.map(t => t.name) ?? [];
    expect(list.length).toBeGreaterThan(0);
    expect(list).not.toContain('set_session_status');
    expect(list).not.toContain('set_session_labels');
  }, 330_000);

  /**
   * UA1.18 — `publish_artifact` and `list_artifacts` through the REAL subprocess, the real client functions and the
   * real bridge, onto registry slots shaped like `SessionManager`'s closures: the publish body arrives NARROWED to the
   * tool's fields (camelCase), the host's verdict becomes the tool's `{ url, expires_at, updated }`, a host refusal
   * reaches the model as an error, and the list answers the slot's rows.
   */
  test('WITH the bridge the artifact pair reaches the host closures, and a refusal is an error', async () => {
    artifactsBound = fakeArtifactPorts();
    const responses = await runMcpSession(spawnArgs(ownBridge.port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'publish_artifact', arguments: { file_path: 'report.html', title: 'Q3', retention_days: 3 } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'publish_artifact', arguments: { file_path: 'refuse-me.html' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_artifacts', arguments: {} } },
    ]);

    const list = responses.get(2)?.result?.tools?.map(t => t.name) ?? [];
    expect(list).toContain('publish_artifact');
    expect(list).toContain('list_artifacts');

    const published = responses.get(3)?.result;
    expect(published?.isError).toBeFalsy();
    const payload = JSON.parse(published?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
    expect(payload.url).toBe('https://t-artifacts.t-tech.team/a/abcdefghijklmnopqrstuv');
    expect(payload.expires_at).toBe('2026-10-05T00:00:00.000Z');
    expect(payload.updated).toBe(false);

    const refused = responses.get(4)?.result;
    expect(refused?.isError).toBe(true);
    expect(refused?.content?.[0]?.text ?? '').toContain('nothing was published');

    const listed = JSON.parse(responses.get(5)?.result?.content?.[0]?.text ?? '{}') as { artifacts?: Array<{ id: string }> };
    expect(listed.artifacts?.map(entry => entry.id)).toEqual(['abcdefghijklmnopqrstuv']);

    // The body crossed narrowed to the declared fields; the absent ones stayed absent.
    expect([...artifactsBound.calls].sort((a, b) => a.filePath.localeCompare(b.filePath))).toEqual([
      { filePath: 'refuse-me.html' },
      { filePath: 'report.html', title: 'Q3', retentionDays: 3 },
    ]);
  }, 330_000);

  /**
   * UA1.18 CONTROL — without the bridge port neither tool is advertised (a publish with no card behind it).
   * UA3.5 — the same spawn is `create_board_task`'s control: a codex spawn without the bridge does not offer it.
   */
  test('WITHOUT the bridge the artifact pair and the board task tool are withheld', async () => {
    artifactsBound = fakeArtifactPorts();
    boardTaskBound = fakeBoardTaskPort();
    const responses = await runMcpSession(spawnArgs(), [{ jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    const list = responses.get(2)?.result?.tools?.map(t => t.name) ?? [];
    expect(list.length).toBeGreaterThan(0);
    expect(list).not.toContain('publish_artifact');
    expect(list).not.toContain('list_artifacts');
    expect(list).not.toContain('create_board_task');
    expect(list).not.toContain('project_memory_append');
    expect(list).not.toContain('source_list_prompts');
    expect(list).not.toContain('source_get_prompt');
    expect(artifactsBound.calls).toEqual([]);
    expect(boardTaskBound.calls).toEqual([]);
  }, 330_000);

  /** UA6.3 CONTROL — a codex spawn without the bridge advertises none of the six page tools (and calls nothing). */
  test('WITHOUT the bridge the six page tools are withheld', async () => {
    pagesBound = fakePagesPort();
    const responses = await runMcpSession(spawnArgs(), [{ jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    const list = responses.get(2)?.result?.tools?.map(t => t.name) ?? [];
    expect(list.length).toBeGreaterThan(0);
    expect(list.filter(name => PAGE_TOOLS.includes(name))).toEqual([]);
    expect(pagesBound.calls).toEqual([]);
  }, 330_000);

  /**
   * UA6.3 — the six page tools through the REAL subprocess, the real client (`createBridgePages`) and the real bridge,
   * onto a `pages` slot shaped like `SessionManager`'s closure: every tool is advertised, each call reaches its own
   * member with the body narrowed to the tool's fields (UA8.2: a `refresh` crosses as the script-content object the
   * schema declares), and a host refusal of `delete_page` (the card declined) reaches the model as an error.
   */
  test('WITH the bridge the six page tools reach the host closure, and a declined delete is an error', async () => {
    pagesBound = fakePagesPort();
    const responses = await runMcpSession(spawnArgs(ownBridge.port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_pages', arguments: { projectId: 'proj_1' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_page', arguments: { slug: 'build-health', includeContent: true } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'create_page', arguments: { name: 'Build Health', kind: 'live', refresh: { cron: '*/15 * * * *', scriptContent: 'console.log(1)' } } } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'update_page', arguments: { slug: 'build-health', projectId: null } } },
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'write_page_data', arguments: { slug: 'build-health', set: { a: 1 }, appendSeries: { m: [{ v: 2 }] } } } },
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'delete_page', arguments: { slug: 'build-health' } } },
    ]);

    const list = responses.get(2)?.result?.tools?.map(t => t.name) ?? [];
    expect(list.filter(name => PAGE_TOOLS.includes(name)).sort()).toEqual([...PAGE_TOOLS].sort());

    const listed = JSON.parse(responses.get(3)?.result?.content?.[0]?.text ?? '{}') as { total?: number };
    expect(listed.total).toBe(1);
    expect(responses.get(4)?.result?.isError).toBeFalsy();
    expect(responses.get(5)?.result?.isError).toBeFalsy();
    expect(responses.get(6)?.result?.isError).toBeFalsy();
    expect(JSON.parse(responses.get(7)?.result?.content?.[0]?.text ?? '{}')).toMatchObject({ slug: 'build-health', kvCount: 1 });

    const declined = responses.get(8)?.result;
    expect(declined?.isError).toBe(true);
    expect(declined?.content?.[0]?.text ?? '').toContain('The user declined deleting the page');

    expect([...pagesBound.calls].sort((a, b) => a.method.localeCompare(b.method))).toEqual([
      { method: 'createPage', args: [{ name: 'Build Health', kind: 'live', refresh: { cron: '*/15 * * * *', scriptContent: 'console.log(1)' } }] },
      { method: 'deletePage', args: ['build-health'] },
      { method: 'getPage', args: ['build-health', { includeContent: true }] },
      { method: 'listPages', args: [] },
      { method: 'updatePage', args: ['build-health', { projectId: null }] },
      { method: 'writePageData', args: ['build-health', { set: { a: 1 }, appendSeries: { m: [{ v: 2 }] } }] },
    ]);
  }, 330_000);

  /**
   * UA3.5 — `create_board_task` through the REAL subprocess, the real client function and the real bridge, onto a
   * registry slot shaped like `SessionManager`'s closure: the body arrives NARROWED to the tool's fields, the host's
   * result becomes the tool's JSON, and a host refusal reaches the model as an error.
   */
  test('WITH the bridge create_board_task reaches the host closure, and a refusal is an error', async () => {
    boardTaskBound = fakeBoardTaskPort();
    const responses = await runMcpSession(spawnArgs(ownBridge.port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_board_task', arguments: { title: 'Fix login', description: 'Find the loop', sources: ['github'] } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_board_task', arguments: { title: 'Elsewhere', description: 'd', workingDirectory: '/etc' } } },
    ]);

    const list = responses.get(2)?.result?.tools?.map(t => t.name) ?? [];
    expect(list).toContain('create_board_task');

    const created = responses.get(3)?.result;
    expect(created?.isError).toBeFalsy();
    expect(JSON.parse(created?.content?.[0]?.text ?? '{}')).toEqual({ slug: 'fix-login', orchestratorSessionId: 'orch-1', warnings: [] });

    const refused = responses.get(4)?.result;
    expect(refused?.isError).toBe(true);
    expect(refused?.content?.[0]?.text ?? '').toContain('project-handle-required');

    expect([...boardTaskBound.calls].sort((a, b) => a.title.localeCompare(b.title))).toEqual([
      { title: 'Elsewhere', description: 'd', workingDirectory: '/etc' },
      { title: 'Fix login', description: 'Find the loop', sources: ['github'] },
    ]);
  }, 330_000);

  /**
   * UB1.12 — `project_memory_append` through the REAL subprocess, the real client function and the real bridge, onto
   * a registry slot shaped like `SessionManager`'s closure: the body arrives NARROWED to the tool's one field, the
   * host's result becomes the tool's sentence, and both refusals (a host throw, a session with no project) reach the
   * model as errors.
   */
  test('WITH the bridge project_memory_append reaches the host closure, and both refusals are errors', async () => {
    projectMemoryBound = fakeProjectMemoryPort();
    const responses = await runMcpSession(spawnArgs(ownBridge.port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project_memory_append', arguments: { note: 'The consent page needs a JS click.' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'project_memory_append', arguments: { note: 'unbound' } } },
    ]);

    const list = responses.get(2)?.result?.tools?.map(t => t.name) ?? [];
    expect(list).toContain('project_memory_append');

    const added = responses.get(3)?.result;
    expect(added?.isError).toBeFalsy();
    expect(added?.content?.[0]?.text ?? '').toContain('Added to /ws/projects/acme/MEMORY.md under "## 2026-10-14T10:00:00.000Z — codex-1"');

    const refused = responses.get(4)?.result;
    expect(refused?.isError).toBe(true);
    expect(refused?.content?.[0]?.text ?? '').toContain('This session is not bound to a project.');

    // The closure saw both calls — the refused one included, the way the board task's fake records.
    expect(projectMemoryBound.calls).toEqual([
      { note: 'The consent page needs a JS click.' },
      { note: 'unbound' },
    ]);
  }, 330_000);

  /**
   * UB7.11 — the MCP prompt pair through the REAL subprocess, the real client
   * functions and the real bridge, onto a registry slot shaped like
   * `SessionManager`'s `mcpSources` closure: the bodies arrive NARROWED to the
   * tools' declared fields, the host's texts become the tools' sentences, the
   * enabled-source refusal reaches the model as an error, and a malformed
   * arguments record is refused at the route (400 class) rather than reaching
   * the closure.
   */
  test('WITH the bridge the MCP prompt pair reaches the host closure, and the refusals are errors', async () => {
    mcpSourcesBound = fakeMcpSourcesPort();
    const responses = await runMcpSession(spawnArgs(ownBridge.port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'source_list_prompts', arguments: { sourceSlug: 'linear' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'source_get_prompt', arguments: { sourceSlug: 'linear', name: 'triage', arguments: { queue: 'inbox' } } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'source_list_prompts', arguments: { sourceSlug: 'not-enabled' } } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'source_get_prompt', arguments: { sourceSlug: 'linear', name: 'triage', arguments: { queue: 7 } } } },
    ]);

    const list = responses.get(2)?.result?.tools?.map(t => t.name) ?? [];
    expect(list).toContain('source_list_prompts');
    expect(list).toContain('source_get_prompt');

    const listed = responses.get(3)?.result;
    expect(listed?.isError).toBeFalsy();
    expect(listed?.content?.[0]?.text ?? '').toContain('1 prompt from "linear"');
    expect(listed?.content?.[0]?.text ?? '').toContain('"triage"');

    const got = responses.get(4)?.result;
    expect(got?.isError).toBeFalsy();
    expect(got?.content?.[0]?.text ?? '').toContain('[user]\nTriage the inbox queue.');

    const refused = responses.get(5)?.result;
    expect(refused?.isError).toBe(true);
    expect(refused?.content?.[0]?.text ?? '').toContain('not enabled in this session');

    const malformed = responses.get(6)?.result;
    // A non-string argument value is refused — at the tool schema or at the
    // route's narrowing — and the prompt body never reaches the model.
    expect(malformed?.isError).toBe(true);
    expect(malformed?.content?.[0]?.text ?? '').not.toContain('Triage');

    // The closure saw the three well-formed calls only — the malformed one was
    // narrowed away at the route, the way the page routes narrow.
    expect(mcpSourcesBound.calls).toEqual([
      { method: 'listPrompts', sourceSlug: 'linear' },
      { method: 'getPrompt', sourceSlug: 'linear', name: 'triage', args: { queue: 'inbox' } },
      { method: 'listPrompts', sourceSlug: 'not-enabled' },
    ]);
  }, 330_000);
});

/** UA1.3 — the four registry slots behind the pair, resolving the way `SessionManager`'s closures do. */
function fakeStatusLabelsPorts() {
  const statuses = [
    { id: 'todo', label: 'Todo', category: 'open' as const },
    { id: 'needs-review', label: 'Needs Review', category: 'open' as const },
    { id: 'done', label: 'Done', category: 'closed' as const },
  ];
  const labelIds = ['bug', 'urgent'];
  const writes: Array<{ method: string; sessionId: string | undefined; value: unknown }> = [];
  return {
    writes,
    resolveStatusFn: (status: string) => {
      const hit = statuses.find(s => s.id === status) ?? statuses.find(s => s.label.toLowerCase() === status.toLowerCase());
      const available = statuses.map(s => s.id);
      return hit ? { resolved: hit.id, available, category: hit.category } : { resolved: null, available };
    },
    setSessionStatusFn: async (sessionId: string | undefined, status: string) => {
      writes.push({ method: 'status.set', sessionId, value: status });
    },
    resolveLabelsFn: (labels: string[]) => {
      const resolved = labels.map(label => label.toLowerCase()).filter(label => labelIds.includes(label));
      const unknown = labels.filter(label => !labelIds.includes(label.toLowerCase()));
      return { resolved, unknown, available: labelIds };
    },
    setSessionLabelsFn: async (sessionId: string | undefined, labels: string[]) => {
      writes.push({ method: 'labels.set', sessionId, value: labels });
    },
  };
}

/** UA1.18 — the two registry slots behind the artifact pair; the verdicts are the closure's shapes. */
function fakeArtifactPorts() {
  const calls: Array<{ filePath: string; title?: string; description?: string; emoji?: string; url?: string; retentionDays?: number }> = [];
  return {
    calls,
    publishArtifactFn: async (input: { filePath: string; title?: string; description?: string; emoji?: string; url?: string; retentionDays?: number }) => {
      calls.push(input);
      if (input.filePath === 'refuse-me.html') {
        return { status: 'refused' as const, note: 'refuse-me.html is outside the session\'s working folder, so nothing was published.' };
      }
      return {
        status: 'published' as const,
        note: 'Published report.html.',
        url: 'https://t-artifacts.t-tech.team/a/abcdefghijklmnopqrstuv',
        expiresAt: '2026-10-05T00:00:00.000Z',
      };
    },
    listArtifactsFn: () => ({
      artifacts: [{ id: 'abcdefghijklmnopqrstuv', title: 'Q3', url: 'https://t-artifacts.t-tech.team/a/abcdefghijklmnopqrstuv', expiresAt: '2026-10-05T00:00:00.000Z' }],
    }),
  };
}

/** UA3.5 — the board task tool's registry slot, refusing a foreign folder the way the host closure does. */
function fakeBoardTaskPort() {
  const calls: Array<{ title: string; description: string; workingDirectory?: string; sources?: string[] }> = [];
  return {
    calls,
    createBoardTaskFn: async (input: { title: string; description: string; workingDirectory?: string; sources?: string[] }) => {
      calls.push(input);
      if (input.workingDirectory === '/etc') {
        throw new Error('project-handle-required: a task created by an agent runs in the creating session\'s own working folder');
      }
      return { slug: 'fix-login', orchestratorSessionId: 'orch-1', warnings: [] as string[] };
    },
  };
}

/**
 * UB1.12 — the project-memory registry slot, shaped like `SessionManager`'s closure: the note arrives, the dated
 * heading is added here, and a session with no bound project is refused with the sentence the model reads.
 */
function fakeProjectMemoryPort() {
  const calls: Array<{ note: string }> = [];
  return {
    calls,
    appendProjectMemoryFn: async (input: { note: string }) => {
      calls.push(input);
      if (input.note === 'unbound') throw new Error('This session is not bound to a project.');
      return { path: '/ws/projects/acme/MEMORY.md', heading: '2026-10-14T10:00:00.000Z — codex-1', bytesAppended: 48 };
    },
  };
}

/** UA6.3 — the six page tools' names, in the registry's order. */
const PAGE_TOOLS = ['list_pages', 'get_page', 'create_page', 'update_page', 'write_page_data', 'delete_page'];

/**
 * UB7.11 — the MCP prompts' grouped registry slot, shaped like
 * `SessionManager`'s `mcpSources` closure: listing renders the tool's summary
 * text, get renders the prompt body, an unknown slug throws the
 * enabled-source sentence the handler wraps.
 */
function fakeMcpSourcesPort() {
  const calls: Array<{ method: string; sourceSlug: string; name?: string; args?: Record<string, string> }> = [];
  return {
    calls,
    mcpSources: {
      listPrompts: async (sourceSlug: string) => {
        calls.push({ method: 'listPrompts', sourceSlug });
        if (sourceSlug === 'not-enabled') throw new Error('Source "not-enabled" is not enabled in this session (enabled: linear).');
        return { prompts: [{ name: 'triage', arguments: [{ name: 'queue', required: true }] }] };
      },
      getPrompt: async (sourceSlug: string, name: string, args?: Record<string, string>) => {
        calls.push({ method: 'getPrompt', sourceSlug, name, args });
        return `[user]\nTriage the ${args?.queue ?? 'default'} queue.`;
      },
    },
  };
}

/** UA6.3 — the `pages` registry slot, declining every delete the way the host's unanswered card does. */
function fakePagesPort() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const summary = {
    slug: 'build-health', name: 'Build Health', kind: 'live', projectId: 'proj_1', createdAt: 1, updatedAt: 2,
    hasContent: true, shared: false, folderPath: '/ws/pages/build-health',
  };
  const details = { ...summary, id: 'page_1a2b3c4d', contentPath: '/ws/pages/build-health/index.html', data: null, grants: [] };
  return {
    calls,
    pages: {
      listPages: () => { calls.push({ method: 'listPages', args: [] }); return [summary, { ...summary, slug: 'notes', projectId: undefined }]; },
      getPage: (slug: string, options?: { includeContent?: boolean }) => { calls.push({ method: 'getPage', args: [slug, options] }); return details; },
      createPage: async (input: unknown) => { calls.push({ method: 'createPage', args: [input] }); return details; },
      updatePage: async (slug: string, patch: unknown) => { calls.push({ method: 'updatePage', args: [slug, patch] }); return details; },
      writePageData: async (slug: string, patch: unknown) => {
        calls.push({ method: 'writePageData', args: [slug, patch] });
        return { slug, kvCount: 1, seriesCount: 1, generatedAt: 3, snapshotPath: '/ws/pages/build-health/data/snapshot.json', durationMs: 4 };
      },
      deletePage: async (slug: string): Promise<{ deleted: true; publicCopyMayRemain: boolean }> => {
        calls.push({ method: 'deletePage', args: [slug] });
        throw new Error('The user declined deleting the page "Build Health" (build-health); nothing was deleted.');
      },
    },
  };
}

// UB6.11 — the decide client maps the tool's request onto HOST_CALLBACK_BRIDGE_ROUTES.decide
// (the same join the scheduling-projection route pin makes, asserted here on the CLIENT half:
// a request that reaches the bridge carries the spawn-time session id and the route the host
// registered — anything else is a rewrite of the contract).
describe('UB6.11 — createBridgeDecide', () => {
  test('posts the request to /decide with the bound session id, and unwraps result / raises error', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ result: { ok: true, model: 'jev', answers: {}, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 2, truncated: false } }), { status: 200 });
    };
    const originalFetch = globalThis.fetch;
    // Bun 1.3.14: delete-then-assign (the documented env trap's fetch sibling — a plain
    // assignment is enough for fetch, but the save/restore below must survive either path).
    globalThis.fetch = impl as unknown as typeof fetch;
    try {
      const { createBridgeDecide } = await import('./host-callback-bridge-client.ts');
      const { HOST_CALLBACK_BRIDGE_ROUTES } = await import('@nessy-agent/session-tools-core');
      const port = createBridgeDecide({ port: '4567', sessionId: 'sess-9' });
      const result = await port.decide({ state: 'x', questions: { q: { type: 'noul', instructions: 'yes?' } } });
      expect(result.ok).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe(`http://127.0.0.1:4567${HOST_CALLBACK_BRIDGE_ROUTES.decide}`);
      expect(seen[0]!.body.sessionId).toBe('sess-9');
      expect((seen[0]!.body.payload as Record<string, unknown>).state).toBe('x');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('the host-side refusal arrives as the tool error the agent relays', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'decide is not available in this context.' }), { status: 200 })) as unknown as typeof fetch;
    try {
      const { createBridgeDecide } = await import('./host-callback-bridge-client.ts');
      const port = createBridgeDecide({ port: '4567', sessionId: 'sess-9' });
      await expect(port.decide({ state: 'x', questions: { q: { type: 'noul', instructions: 'yes?' } } })).rejects.toThrow('not available in this context');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

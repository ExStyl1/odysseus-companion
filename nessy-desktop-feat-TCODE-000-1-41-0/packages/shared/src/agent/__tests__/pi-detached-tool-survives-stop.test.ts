/**
 * UB2.10 (B2-12; "Stop ends only the reply") — a DETACHED Pi MCP call survives a
 * Stop.
 *
 * The premise, confirmed by reading at HEAD before this fix: the R10 detach arm
 * (`pi-agent-server/src/index.ts`, the `task-mcp-*` path) dissociates the call
 * from the TURN's abort signal (`pendingRef.removeAbort`) but re-registers it
 * under a fresh controller still held in the host's `pendingToolExecutions` —
 * and `forceAbort`'s pending-tool-executions sweep aborts that map wholesale, so
 * a Stop killed a running detached MCP write by construction.
 *
 * The fix is a two-half protocol:
 * - the subprocess half (pi-agent-server/src/index.ts, commit cf31de0ce): the
 *   detach point sends `tool_execute_detached {requestId, taskId}`;
 * - the host half (this row, pi-agent.ts): the receiver MOVES the entry into
 *   `detachedToolExecutions`, a set the Stop sweep cannot reach, while
 *   `rejectPendingSubprocessRequests` (session death) still settles it.
 *
 * The completion pass (2026-10-16, L-PI) found the host half incomplete in
 * three ways, each pinned below:
 * - `stopBackgroundTask` (stopTask, `/workflows stop`) aborts the subprocess's
 *   own controller, which answers with `tool_execute_cancel {requestId}` — and
 *   that arm looked only in `pendingToolExecutions`, so after the move a stop
 *   left the host's MCP call running (a regression of half 2);
 * - `forceAbort` spared detached calls for EVERY reason, a capability revoke
 *   (`InternalError`) included — now only the turn-scoped two
 *   `ClaudeAgent.forceAbort` interrupts (`UserStop`, `MaxBudgetUsd`);
 * - a detached call that settled after the Stop (or any turn end) failed the
 *   post-route turn checks — the released lease, the cleared manifest — so it
 *   answered "stale"/"revoked" for a write that ran.
 *
 * UB12.12 (2026-10-16) put the LEASE check back for a detached call: the host
 * already retains the turn's lease for it (`task_backgrounded` →
 * `retainPiBackgroundChildAuthority`, no kind filter) and now releases it at the
 * call's `task_notification`, so after the turn ends the lease is held unless
 * REVOKED — and a revoke while no turn runs refuses the late result. The rig
 * models that host lease (`retainForTask`, `endTurn`, `revoke`); only the turn
 * IDENTITY check (manifest, runtime) stays skipped for a detached call.
 *
 * The packaged Pi drive (a live detached call across a Stop, and the result it
 * reports) is the sitting ASK (RS-127, UB2.12).
 */
import { describe, expect, it } from 'bun:test';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { PiAgent } from '../pi-agent.ts';
import { AbortReason, type BackendConfig, type CapabilityTurnRuntime } from '../backend/types.ts';
import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import type { PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';
import { finalizePiExecutionManifest } from '../pi-harness/harness-manifest.ts';
import { PI_STATIC_MODEL_CONTRACT_HASHES, PI_TOOL_BINDINGS, getHarnessToolDescriptor } from '../pi-harness/harness-tool-descriptor.ts';

function makeAgent(): PiAgent {
  return new PiAgent({
    provider: 'pi',
    providerType: 'pi',
    model: '',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: { id: 'pi-detach-ub2-10', name: 'UB2.10', rootPath: '/tmp/pi-detach-ub2-10' } as never,
  } as BackendConfig);
}

describe('UB2.10 — the tool_execute_detached receiver moves the call out of the Stop sweep', () => {
  it('POSITIVE — the detached call survives forceAbort; a NON-detached call is still aborted (control)', () => {
    const agent = makeAgent() as any;
    const detachedController = new AbortController();
    const liveController = new AbortController();
    (agent as any).pendingToolExecutions.set('req-detached', detachedController);
    (agent as any).pendingToolExecutions.set('req-live', liveController);

    // The subprocess tells the host the call detached past the R10 threshold.
    (agent as any).dispatchSubprocessMessage('tool_execute_detached', { requestId: 'req-detached', taskId: 'task-mcp-test' });

    // MOVED: out of the Stop sweep's map, kept for session death.
    expect((agent as any).pendingToolExecutions.has('req-detached')).toBe(false);
    expect((agent as any).detachedToolExecutions.has('req-detached')).toBe(true);

    // A Stop sweeps the pending executions…
    agent.forceAbort(AbortReason.UserStop);
    expect(liveController.signal.aborted).toBe(true);
    // …and the DETACHED call survives it.
    expect(detachedController.signal.aborted).toBe(false);
    expect((agent as any).detachedToolExecutions.has('req-detached')).toBe(true);
  });

  it('NEGATIVE (control) — session death still settles a detached call', () => {
    const agent = makeAgent() as any;
    const detachedController = new AbortController();
    (agent as any).pendingToolExecutions.set('req-d2', detachedController);
    (agent as any).dispatchSubprocessMessage('tool_execute_detached', { requestId: 'req-d2', taskId: 'task-mcp-test-2' });
    expect((agent as any).detachedToolExecutions.has('req-d2')).toBe(true);

    // Not a Stop: a dead subprocess (session death) settles everything, detached included.
    (agent as any).rejectPendingSubprocessRequests(new Error('subprocess died'));
    expect(detachedController.signal.aborted).toBe(true);
    expect((agent as any).detachedToolExecutions.has('req-d2')).toBe(false);
  });

  it('NEGATIVE (control) — an unknown requestId leaves nothing behind', () => {
    const agent = makeAgent() as any;
    (agent as any).dispatchSubprocessMessage('tool_execute_detached', { requestId: 'req-unknown', taskId: 'task-mcp-x' });
    expect((agent as any).detachedToolExecutions.size).toBe(0);
    expect((agent as any).pendingToolExecutions.size).toBe(0);
  });
});

describe('UB2.10 — the stopping seams still reach a detached call', () => {
  it('NEGATIVE (control, `/workflows stop`) — the subprocess cancel after a background-task stop aborts the detached call', () => {
    const agent = makeAgent() as any;
    const detachedController = new AbortController();
    agent.pendingToolExecutions.set('req-stop', detachedController);
    agent.dispatchSubprocessMessage('tool_execute_detached', { requestId: 'req-stop', taskId: 'task-mcp-stop' });

    // `stop_background_task` aborted the subprocess's controller; its listener answers with this.
    agent.dispatchSubprocessMessage('tool_execute_cancel', { requestId: 'req-stop' });
    expect(detachedController.signal.aborted).toBe(true);
    expect(agent.detachedToolExecutions.has('req-stop')).toBe(false);
  });

  it('BOUNDARY — a capability revoke (forceAbort InternalError) takes a detached call; MaxBudgetUsd, turn-scoped like a Stop, does not', () => {
    const agent = makeAgent() as any;
    const spared = new AbortController();
    agent.pendingToolExecutions.set('req-budget', spared);
    agent.dispatchSubprocessMessage('tool_execute_detached', { requestId: 'req-budget', taskId: 'task-mcp-budget' });
    agent.forceAbort(AbortReason.MaxBudgetUsd);
    expect(spared.signal.aborted).toBe(false);

    agent.forceAbort(AbortReason.InternalError);
    expect(spared.signal.aborted).toBe(true);
    expect(agent.detachedToolExecutions.size).toBe(0);
  });
});

/**
 * UB12.13 — a plan or auth HANDOFF is turn-scoped like a Stop. On Claude, `interruptForHandoff` takes the SDK's
 * `interrupt()` (query kept), the same call a Stop takes, so a background task outlives the plan card or the auth card.
 * On Pi, `BaseAgent.interruptForHandoff` routes every handoff through `forceAbort` (F1.1242), and before this row
 * `PI_DETACHED_CALL_SURVIVING_ABORT_REASONS` held only the Stop pair, so the handoff swept the detached MCP call.
 * Driven through `interruptForHandoff`, the host's own door (`SessionManager.interruptForHandoffKeepingSteers`).
 */
describe('UB12.13 — a plan or auth handoff ends the reply, not a detached MCP call', () => {
  for (const reason of [AbortReason.PlanSubmitted, AbortReason.AuthRequest]) {
    it(`POSITIVE — the detached call survives interruptForHandoff(${reason}); a NON-detached call is still aborted (control)`, () => {
      const agent = makeAgent() as any;
      const detached = new AbortController();
      const live = new AbortController();
      agent.pendingToolExecutions.set('req-handoff-detached', detached);
      agent.pendingToolExecutions.set('req-handoff-live', live);
      agent.dispatchSubprocessMessage('tool_execute_detached', { requestId: 'req-handoff-detached', taskId: 'task-mcp-handoff' });

      agent.interruptForHandoff(reason);

      expect(live.signal.aborted).toBe(true);
      expect(detached.signal.aborted).toBe(false);
      expect(agent.detachedToolExecutions.has('req-handoff-detached')).toBe(true);
    });
  }

  it('NEGATIVE (control) — session death after a handoff (forceAbort InternalError, the revoke arm) still takes the detached call', () => {
    const agent = makeAgent() as any;
    const detached = new AbortController();
    agent.pendingToolExecutions.set('req-handoff-revoke', detached);
    agent.dispatchSubprocessMessage('tool_execute_detached', { requestId: 'req-handoff-revoke', taskId: 'task-mcp-handoff-revoke' });
    agent.interruptForHandoff(AbortReason.PlanSubmitted);
    expect(detached.signal.aborted).toBe(false);

    agent.forceAbort(AbortReason.InternalError);
    expect(detached.signal.aborted).toBe(true);
    expect(agent.detachedToolExecutions.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The real handler over the real readline wire (the F1.930 / UB3.9 rig): a
// manifest built by `finalizePiExecutionManifest`, `routeToolCall` stubbed to a
// call the test settles by hand, and a runtime whose lease the test releases the
// way the host's turn end does.
// ---------------------------------------------------------------------------

function createRigConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-ub210',
      name: 'UB2.10 Workspace',
      rootPath: '/tmp/nessy-ub210-ws',
      workspaceRootPath: '/tmp/nessy-ub210-ws',
      sessionRootPath: '/tmp/nessy-ub210-sessions/ws-ub210',
    } as never,
    session: {
      id: 'session-ub210',
      workspaceRootPath: '/tmp/nessy-ub210-ws',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as never,
    isHeadless: true,
    skipConfigWatcher: true,
  } as BackendConfig;
}

function rigWithHeldRoute() {
  const agent = new PiAgent(createRigConfig()) as any;
  const sent: Array<Record<string, unknown>> = [];
  agent.send = (message: Record<string, unknown>) => { sent.push(message); };
  agent.debug = () => {};
  agent.subprocess = {};
  agent.emitAutomationEvent = async () => {};
  const input = new Readable({ read() {} });
  const readline = createInterface({ input, crlfDelay: Infinity });
  readline.on('line', (line: string) => { agent.handleLine(line); });
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const push = async (message: Record<string, unknown>) => {
    input.push(JSON.stringify(message) + '\n');
    await tick();
  };

  const binding = PI_TOOL_BINDINGS.find(candidate => candidate.bindingName === 'mcp__session__SubmitPlan');
  if (!binding) throw new Error('PI_TOOL_BINDINGS carries no mcp__session__SubmitPlan binding');
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'ub210-generation',
    sessionKey: { workspaceId: 'ws-ub210', sessionId: 'session-ub210' },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: [
      ...PI_TOOL_BINDINGS.flatMap(candidate => {
        const hash = PI_STATIC_MODEL_CONTRACT_HASHES[candidate.bindingName];
        return hash ? [{
          descriptor: getHarnessToolDescriptor(candidate.descriptorId),
          binding: candidate,
          source: { kind: 'piBuiltin' as const, bindingId: candidate.bindingName },
          modelContractHash: hash,
        }] : [];
      }),
      {
        descriptor: getHarnessToolDescriptor(binding.descriptorId),
        binding,
        source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
        modelContractHash: PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName] ?? 'ub210-test-only-placeholder-unverified-by-finalize',
      },
    ],
  };
  const manifest = finalizePiExecutionManifest(seed, []);
  const tool = manifest.tools.find(candidate => candidate.binding.permissionName === 'SubmitPlan');
  if (!tool) throw new Error('the test manifest carries no SubmitPlan binding');
  // UB12.12 — the host's lease as SessionManager holds it: the TURN owns one reference
  // (`createRetainedCapabilityLease`, released at the send's end), a detached call's task authority a
  // second (`task_backgrounded` → `retainPiBackgroundChildAuthority`, released at its `task_notification`);
  // the snapshot is released when both are gone, and a revoke marks it inactive while it is still held
  // (resolver.ts `isLeaseActive`). `pi-detached-mcp-lease.test.ts` (server-core) pins the host half.
  let turnHoldsLease = true;
  let taskHoldsLease = false;
  let leaseRevoked = false;
  const runtime = {
    view: { generation: manifest.snapshotGeneration },
    materializer: {
      assertActive() {
        if (leaseRevoked || (!turnHoldsLease && !taskHoldsLease)) throw new Error('capability-snapshot-revoked');
      },
    },
    piExecutionManifestSeed: { snapshotGeneration: manifest.snapshotGeneration },
  } as unknown as CapabilityTurnRuntime;
  // setCapabilityTurnRuntime clears manifest authority, so the accessor goes in after it.
  agent.setCapabilityTurnRuntime(runtime);
  let manifestCleared = false;
  Object.defineProperty(agent, 'activeExecutionManifest', {
    get: () => (manifestCleared ? null : manifest),
    set: (value: unknown) => { if (value === null) manifestCleared = true; },
    configurable: true,
  });

  let settleRoute!: (result: { content: string; isError: boolean }) => void;
  let routeSignal: AbortSignal | undefined;
  agent.routeToolCall = (_toolName: string, _args: unknown, signal: AbortSignal) => {
    routeSignal = signal;
    return new Promise(resolve => { settleRoute = resolve; });
  };

  return {
    agent,
    sent,
    push,
    tick,
    request: {
      type: 'tool_execute_request',
      requestId: 'ub210-mcp-write',
      toolName: tool.binding.bindingName,
      piName: tool.binding.piName,
      manifestGeneration: manifest.snapshotGeneration,
      manifestHash: manifest.manifestHash,
      args: {},
    },
    /** What the host does on the detach's `task_backgrounded {kind: 'mcp'}`: the task authority retains the lease. */
    retainForTask: () => { taskHoldsLease = true; },
    /** What the host's turn end does after a Stop: drop the runtime and release the TURN's reference to the lease. */
    endTurn: () => {
      agent.setCapabilityTurnRuntime(null);
      turnHoldsLease = false;
    },
    /** A capability revoke (`revoke-active-snapshot`) while no turn runs: the held lease turns inactive. */
    revoke: () => { leaseRevoked = true; },
    settle: (result: { content: string; isError: boolean }) => settleRoute(result),
    routeAborted: () => routeSignal?.aborted === true,
    dispose: () => {
      readline.removeAllListeners();
      readline.close();
      input.push(null);
      agent.subprocess = null;
      agent.destroy();
    },
  };
}

describe('UB2.10 — a detached call that settles after a Stop reports its result', () => {
  // UB12.12's NEGATIVE arm too: the lease the host's task authority retains is unrevoked, so the
  // restored lease check passes and the result is reported.
  it('POSITIVE — detached, then Stop and the turn ends; the call settles and answers with its RESULT, and leaves the set', async () => {
    const rig = rigWithHeldRoute();
    try {
      await rig.push(rig.request);
      await rig.push({ type: 'tool_execute_detached', requestId: 'ub210-mcp-write', taskId: 'task-mcp-ub210' });
      rig.retainForTask();
      rig.agent.forceAbort(AbortReason.UserStop);
      rig.endTurn();
      expect(rig.routeAborted()).toBe(false);

      rig.settle({ content: 'row 42 written', isError: false });
      await rig.tick();
      expect(rig.sent).toContainEqual({
        type: 'tool_execute_response',
        requestId: 'ub210-mcp-write',
        result: { content: 'row 42 written', isError: false },
      });
      expect(rig.agent.detachedToolExecutions.size).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('CONTROL — the same sequence WITHOUT the detach: the Stop aborts the call and the turn checks refuse its late result', async () => {
    const rig = rigWithHeldRoute();
    try {
      await rig.push(rig.request);
      rig.agent.forceAbort(AbortReason.UserStop);
      rig.endTurn();
      expect(rig.routeAborted()).toBe(true);

      rig.settle({ content: 'row 42 written', isError: false });
      await rig.tick();
      const response = rig.sent.find(message => message.type === 'tool_execute_response') as
        | { result: { content: string; isError: boolean } } | undefined;
      expect(response?.result.isError).toBe(true);
      expect(response?.result.content).not.toBe('row 42 written');
    } finally {
      rig.dispose();
    }
  });
});

describe('UB12.12 — a capability revoked while no turn runs refuses a detached call\'s late result', () => {
  it('POSITIVE — detached, Stop, the turn ends, then a revoke: the late result is refused as revoked, and the call leaves the set', async () => {
    const rig = rigWithHeldRoute();
    try {
      await rig.push(rig.request);
      await rig.push({ type: 'tool_execute_detached', requestId: 'ub210-mcp-write', taskId: 'task-mcp-ub1212' });
      rig.retainForTask();
      rig.agent.forceAbort(AbortReason.UserStop);
      rig.endTurn();
      // No turn runs: the revoke arm force-aborts no session (UB12.36 aborts this call by task id, below);
      // the lease the task authority still holds refuses a result that settles before that abort lands.
      rig.revoke();
      expect(rig.routeAborted()).toBe(false);

      rig.settle({ content: 'row 42 written', isError: false });
      await rig.tick();
      const response = rig.sent.find(message => message.type === 'tool_execute_response') as
        | { result: { content: string; isError: boolean } } | undefined;
      expect(response?.result).toEqual({ content: 'capability-snapshot-revoked', isError: true });
      expect(rig.agent.detachedToolExecutions.size).toBe(0);
    } finally {
      rig.dispose();
    }
  });
});

/**
 * UB12.36 — the host's revoke arm reaches a detached call while no turn of its lease runs: SessionManager walks the
 * retained task authorities and calls `abortDetachedToolCallsForTask` (server-core
 * `pi-detached-mcp-revoke-idle.test.ts` pins that half). The route is stubbed the way the MCP pool settles an aborted
 * call (`mcp-pool.ts` `settleOnAbort`: it rejects with the signal's reason), so the subprocess is answered with it.
 */
describe('UB12.36 — a revoke while no turn runs aborts the detached call it reaches, by task id', () => {
  function rigRejectingOnAbort() {
    const rig = rigWithHeldRoute();
    let signal: AbortSignal | undefined;
    let settle!: (result: { content: string; isError: boolean }) => void;
    rig.agent.routeToolCall = (_toolName: string, _args: unknown, routeSignal: AbortSignal) => {
      signal = routeSignal;
      return new Promise((resolve, reject) => {
        settle = resolve;
        routeSignal.addEventListener('abort', () => reject(routeSignal.reason), { once: true });
      });
    };
    return { rig, signal: () => signal, settle: (result: { content: string; isError: boolean }) => settle(result) };
  }

  it('POSITIVE — detached, Stop, the turn ends; the task\'s abort aborts the route signal and answers capability-snapshot-revoked', async () => {
    const { rig, signal } = rigRejectingOnAbort();
    try {
      await rig.push(rig.request);
      await rig.push({ type: 'tool_execute_detached', requestId: 'ub210-mcp-write', taskId: 'task-mcp-ub1236' });
      rig.retainForTask();
      rig.agent.forceAbort(AbortReason.UserStop);
      rig.endTurn();
      expect(signal()?.aborted).toBe(false);

      expect(rig.agent.abortDetachedToolCallsForTask('task-mcp-ub1236', new CapabilityMaterializationError('revoked'))).toBe(1);
      await rig.tick();
      expect(signal()?.aborted).toBe(true);
      expect(rig.sent).toContainEqual({
        type: 'tool_execute_response',
        requestId: 'ub210-mcp-write',
        result: { content: 'capability-snapshot-revoked', isError: true },
      });
      expect(rig.agent.detachedToolExecutions.size).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('NEGATIVE — another task\'s id aborts nothing: the call runs on and reports its result', async () => {
    const { rig, signal, settle } = rigRejectingOnAbort();
    try {
      await rig.push(rig.request);
      await rig.push({ type: 'tool_execute_detached', requestId: 'ub210-mcp-write', taskId: 'task-mcp-ub1236' });
      rig.retainForTask();
      rig.agent.forceAbort(AbortReason.UserStop);
      rig.endTurn();

      expect(rig.agent.abortDetachedToolCallsForTask('task-mcp-other', new CapabilityMaterializationError('revoked'))).toBe(0);
      expect(signal()?.aborted).toBe(false);
      settle({ content: 'row 42 written', isError: false });
      await rig.tick();
      expect(rig.sent).toContainEqual({
        type: 'tool_execute_response',
        requestId: 'ub210-mcp-write',
        result: { content: 'row 42 written', isError: false },
      });
    } finally {
      rig.dispose();
    }
  });
});

/**
 * UA4.1 — adapted from craft-agents-oss `v0.13.4:packages/server-core/src/tasks/TaskRunner.test.ts` (Apache-2.0),
 * rebranded. Upstream's 31 cases run against our `ConductorSessionHost` mock (no `getSessionFinalText`, no
 * `getSessionWorkingDirectory`; the orchestrator's handle, project and mode instead), with two cases INVERTED as the
 * plan's manifest says: the omitted-mode default is no longer `allow-all`, and children never fall back to
 * `spec.cwd`. Legacy mode spellings in the fixtures parse to our canonical modes (`safe` → `plan`, `ask` → `default`).
 * The NESSY arms (TaskRunner header items 3–11) follow in their own `describe`, and the v0.15.1 `depends_on`
 * hand-over cases (UB1.14) with our controls close the first `describe`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
// UB6.6 — the decision-model arms (rebased from upstream v0.15.1 TaskRunner.test.ts decision blocks).
import type { DecisionResult } from '@nessy-agent/shared/decisions';
import type { TaskRunnerDeps } from './TaskRunner';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TokenUsage } from '@nessy-agent/core/types';
import type { CreateSessionOptions } from '@nessy-agent/shared/protocol';
import type { PermissionMode } from '@nessy-agent/shared/agent/mode-types';
import { parseTaskSpec, saveTaskSpec, readRunLog, readNodeOutput, appendRunLog, writeRunSpecSnapshot, taskYamlPath, type RunLogEntry, type TaskSpec } from '@nessy-agent/shared/tasks';
import type { SessionCompletionEvent } from '../sessions/SessionManager';
import { TaskRunner, recordOrchestratorModeChange, recordedLiveRunPermissionCeiling, runStatusFromLog, type ConductorSessionHost } from './TaskRunner';

// Flush pending microtasks so the runner's async dispatch (create → column → send) settles.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function tu(inputTokens: number, outputTokens: number): TokenUsage {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, contextTokens: 0, costUsd: 0 };
}

function specOf(raw: unknown): TaskSpec {
  const r = parseTaskSpec(raw);
  if (!r.success) throw new Error('bad fixture: ' + JSON.stringify(r.error.issues));
  return r.data;
}

type CompleteOpts = { reason?: SessionCompletionEvent['reason']; finalText?: string; tokenUsage?: TokenUsage; terminalIsError?: boolean; fromUser?: boolean };

/** Mock host: records calls; the test drives completions via complete(). */
class MockHost implements ConductorSessionHost {
  // A Set, mirroring SessionManager — the Conductor keeps its main subscription AND a one-shot
  // verdict listener attached at the same time while a run is `verifying`.
  private readonly listeners = new Set<(evt: SessionCompletionEvent) => void>();
  readonly created: { id: string; options: CreateSessionOptions }[] = [];
  readonly sent: { sessionId: string; message: string }[] = [];
  readonly statuses: { sessionId: string; status: string }[] = [];
  readonly columns: { sessionId: string; column: string | null }[] = [];
  readonly nodeCounts: { sessionId: string; count: number }[] = [];
  readonly cancelled: string[] = [];

  async createSession(_workspaceId: string, options: CreateSessionOptions): Promise<{ id: string }> {
    const id = `sess-${options.name}`;
    this.created.push({ id, options });
    return { id };
  }
  async sendMessage(sessionId: string, message: string): Promise<void> {
    this.sent.push({ sessionId, message });
  }
  async setSessionStatus(sessionId: string, status: string): Promise<void> {
    this.statuses.push({ sessionId, status });
  }
  async setKanbanColumn(sessionId: string, column: string | null): Promise<void> {
    this.columns.push({ sessionId, column });
  }
  async setTaskNodeCount(sessionId: string, count: number): Promise<void> {
    this.nodeCounts.push({ sessionId, count });
  }
  async cancelProcessing(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId);
  }
  onSessionComplete(listener: (evt: SessionCompletionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  // NESSY — the orchestrator context a child inherits (replaces getSessionFinalText / getSessionWorkingDirectory).
  readonly handleById = new Map<string, string>();
  readonly projectById = new Map<string, string>();
  readonly modeById = new Map<string, PermissionMode>();
  async getSessionProjectHandleId(sessionId: string): Promise<string | undefined> {
    return this.handleById.get(sessionId);
  }
  getSessionProjectId(sessionId: string): string | undefined {
    return this.projectById.get(sessionId);
  }
  getSessionPermissionMode(sessionId: string): PermissionMode | undefined {
    return this.modeById.get(sessionId);
  }

  // --- test helpers (sessionId is derived from the node title, which defaults to the node id) ---
  sessionIdFor(nodeId: string): string {
    return `sess-${nodeId}`;
  }
  promptFor(nodeId: string): string | undefined {
    return this.sent.find((s) => s.sessionId === this.sessionIdFor(nodeId))?.message;
  }
  dispatchedNames(): string[] {
    return this.created.map((c) => c.options.name!).filter(Boolean);
  }
  complete(nodeId: string, opts: CompleteOpts = {}): void {
    this.completeSession(this.sessionIdFor(nodeId), opts);
  }
  /** Fire a completion for an arbitrary session id (e.g. the orchestrator's verification verdict). */
  completeSession(sessionId: string, opts: CompleteOpts = {}): void {
    const evt: SessionCompletionEvent = {
      sessionId,
      workspaceId: 'ws',
      reason: opts.reason ?? 'complete',
      finalText: opts.finalText,
      tokenUsage: opts.tokenUsage,
      ...(opts.terminalIsError ? { terminalIsError: true } : {}),
      ...(opts.fromUser === false ? { fromUser: false } : {}),
    };
    for (const listener of [...this.listeners]) listener(evt);
  }
}

describe('TaskRunner (Conductor)', () => {
  let root: string;
  let host: MockHost;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conductor-test-'));
    host = new MockHost();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeRunner(deps: Partial<TaskRunnerDeps> = {}) {
    return new TaskRunner({ host, workspaceId: 'ws', workspaceRoot: root, now: () => '2026-06-07T00:00:00.000Z', ...deps });
  }

  it('runs a dependency chain, feeding each output into the next', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'demo',
        title: 'Demo',
        goal: 'audit then design then implement',
        nodes: [
          { id: 'audit', prompt: 'Audit the code' },
          { id: 'design', depends_on: ['audit'], prompt: 'Design using ${nodes.audit.output}' },
          { id: 'impl', depends_on: ['design'], prompt: 'Implement ${nodes.design.output}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('demo', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();

    expect(host.dispatchedNames()).toEqual(['audit']);
    expect(host.promptFor('audit')).toBe('Audit the code');

    host.complete('audit', { finalText: 'AUDIT', tokenUsage: tu(10, 5) });
    await tick();
    expect(host.dispatchedNames()).toEqual(['audit', 'design']);
    expect(host.promptFor('design')).toBe('Design using AUDIT');

    host.complete('design', { finalText: 'DESIGN', tokenUsage: tu(20, 10) });
    await tick();
    expect(host.promptFor('impl')).toBe('Implement DESIGN');

    host.complete('impl', { finalText: 'IMPL', tokenUsage: tu(5, 5) });
    await tick();

    // All nodes done → the run is verifying (not yet terminal) until the orchestrator returns a verdict.
    expect(runner.getRunState('demo', 'r1')!.status).toBe('verifying');
    expect(host.sent.some((s) => s.sessionId === 'orch' && s.message.includes('finished running'))).toBe(true);

    host.completeSession('orch', { finalText: 'Looks correct.\nVERDICT: PASS' });
    await tick();

    const snap = runner.getRunState('demo', 'r1')!;
    expect(snap.status).toBe('completed');
    expect(snap.nodes.every((n) => n.state === 'done')).toBe(true);
    expect(snap.tokensUsed).toBe(55);

    // Run-log + node output persisted.
    const log = readRunLog(root, 'demo', 'r1');
    expect(log[0]).toMatchObject({ kind: 'run-started' });
    expect(log.some((e) => e.kind === 'run-completed')).toBe(true);
    expect(readNodeOutput(root, 'demo', 'r1', 'audit')).toEqual({ text: 'AUDIT' });
  });

  it('passes llmConnection (node value, else the task default) to createSession', async () => {
    // Regression: pi/* models complete instantly with empty output unless the child session is
    // created with the connection slug that serves the model.
    saveTaskSpec(
      root,
      specOf({
        id: 'conn',
        title: 'Conn',
        goal: 'g',
        defaults: { llmConnection: 'default-conn' },
        nodes: [
          { id: 'a', prompt: 'a', model: 'pi/gpt-5.5', llmConnection: 'pi-conn' },
          { id: 'b', prompt: 'b', model: 'claude-opus-4-8' }, // inherits the task default
        ],
      }),
    )
    const runner = makeRunner()
    runner.run('conn', { runId: 'r1' })
    await tick()

    const optsA = host.created.find((c) => c.options.name === 'a')?.options
    const optsB = host.created.find((c) => c.options.name === 'b')?.options
    expect(optsA?.llmConnection).toBe('pi-conn')
    expect(optsB?.llmConnection).toBe('default-conn')
  })

  it('resolves permissionMode: node override → task default → child (never the workspace default)', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'perm',
        title: 'Perm',
        goal: 'g',
        defaults: { permissionMode: 'ask' },
        nodes: [
          { id: 'a', prompt: 'a', permissionMode: 'safe' }, // node override wins
          { id: 'b', prompt: 'b' }, // inherits the task default
        ],
      }),
    )
    const runner = makeRunner()
    runner.run('perm', { runId: 'r1' })
    await tick()

    // Legacy spellings parse to canonical modes (UA3.2): `safe` → `plan`, `ask` → `default`.
    expect(host.created.find((c) => c.options.name === 'a')?.options.permissionMode).toBe('plan')
    expect(host.created.find((c) => c.options.name === 'b')?.options.permissionMode).toBe('default')
  })

  it('INVERTED (UA4.1): an omitted permission mode inherits the orchestrator\'s, and is never allow-all', async () => {
    // Upstream defaulted an omitted mode to `allow-all` (spec §19 defect 3). Ours: the orchestrator's current mode;
    // with no orchestrator the field is left unset (the workspace default, as for any new session).
    saveTaskSpec(
      root,
      specOf({ id: 'perm2', title: 'Perm2', goal: 'g', nodes: [{ id: 'c', prompt: 'c' }] }),
    )
    host.modeById.set('orch', 'default')
    const runner = makeRunner()
    runner.run('perm2', { runId: 'r1', orchestratorSessionId: 'orch' })
    await tick()
    expect(host.created.find((c) => c.options.name === 'c')?.options.permissionMode).toBe('default')

    host.created.length = 0
    const runner2 = makeRunner()
    runner2.run('perm2', { runId: 'r2' })
    await tick()
    const opts = host.created.find((c) => c.options.name === 'c')?.options
    expect(opts?.permissionMode).toBeUndefined()
    expect(opts?.permissionMode).not.toBe('bypassPermissions')
  })

  it('stamps task/run/node linkage on each dispatched child session', async () => {
    // The manual subtask composer skips Conductor-owned children by checking taskRunId.
    saveTaskSpec(
      root,
      specOf({ id: 'link', title: 'Link', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }),
    )
    const runner = makeRunner()
    runner.run('link', { runId: 'r1', orchestratorSessionId: 'orch' })
    await tick()

    const optsA = host.created.find((c) => c.options.name === 'a')?.options
    expect(optsA?.taskSlug).toBe('link')
    expect(optsA?.taskRunId).toBe('r1')
    expect(optsA?.taskNodeId).toBe('a')
  })

  it('creates a child session per node (createSession announces each to the renderer by default)', async () => {
    // Renderer visibility depends on createSession emitting session_created; the runner's job is
    // simply to create one session per node (the host's createSession owns the announcement).
    saveTaskSpec(
      root,
      specOf({ id: 'announce', title: 'Announce', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }, { id: 'b', prompt: 'b' }] }),
    )
    const runner = makeRunner()
    runner.run('announce', { runId: 'r1' })
    await tick()

    expect(host.created.map((c) => c.id)).toEqual([host.sessionIdFor('a'), host.sessionIdFor('b')])
  })

  it("INVERTED (UA4.1): children take the orchestrator's folder handle and project, never spec.cwd or spec.project", async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'cwd', title: 'Cwd', goal: 'g', cwd: '/spec/dir', project: 'spec-project', nodes: [{ id: 'a', prompt: 'a' }] }),
    )
    host.handleById.set('orch', 'handle-orch')
    host.projectById.set('orch', 'project-orch')
    const runner = makeRunner()
    runner.run('cwd', { runId: 'r1', orchestratorSessionId: 'orch' })
    await tick()
    const opts = host.created.find((c) => c.options.name === 'a')?.options
    expect(opts?.projectHandleId).toBe('handle-orch')
    expect(opts?.projectId).toBe('project-orch')
    expect(opts?.workingDirectory).toBeUndefined()

    // With no orchestrator folder there is NO fallback to spec.cwd: no handle, no path, no spec project.
    host.created.length = 0
    host.handleById.clear()
    host.projectById.clear()
    const runner2 = makeRunner()
    runner2.run('cwd', { runId: 'r2', orchestratorSessionId: 'orch' })
    await tick()
    const opts2 = host.created.find((c) => c.options.name === 'a')?.options
    expect(opts2?.projectHandleId).toBeUndefined()
    expect(opts2?.workingDirectory).toBeUndefined()
    expect(opts2?.projectId).toBeUndefined()
    expect(JSON.stringify(opts2)).not.toContain('/spec/dir')
  })

  it('moves the orchestrator tile to in-progress on start and done on completion', async () => {
    saveTaskSpec(root, specOf({ id: 'col', title: 'Col', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }))
    const runner = makeRunner()
    runner.run('col', { runId: 'r1', orchestratorSessionId: 'orch', verifyOnComplete: false })
    await tick()
    expect(host.columns).toContainEqual({ sessionId: 'orch', column: 'in-progress' })

    host.complete('a', { finalText: 'A' })
    await tick()
    expect(host.columns).toContainEqual({ sessionId: 'orch', column: 'done' })
  })

  it('runs a fan-out and joins at the synthesizer', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'fan',
        title: 'Fan',
        goal: 'g',
        nodes: [
          { id: 'design', prompt: 'design' },
          { id: 'impl-a', depends_on: ['design'], prompt: 'A: ${nodes.design.output}' },
          { id: 'impl-b', depends_on: ['design'], prompt: 'B: ${nodes.design.output}' },
          { id: 'review', depends_on: ['impl-a', 'impl-b'], prompt: 'review ${nodes.impl-a.output} ${nodes.impl-b.output}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('fan', { runId: 'r1' });
    await tick();
    expect(host.dispatchedNames()).toEqual(['design']);

    host.complete('design', { finalText: 'D' });
    await tick();
    // Both siblings dispatch in parallel; review waits for the barrier.
    expect(host.dispatchedNames().sort()).toEqual(['design', 'impl-a', 'impl-b']);
    expect(host.promptFor('review')).toBeUndefined();

    host.complete('impl-a', { finalText: 'A' });
    await tick();
    expect(host.promptFor('review')).toBeUndefined(); // still waiting on impl-b

    host.complete('impl-b', { finalText: 'B' });
    await tick();
    expect(host.promptFor('review')).toBe('review A B');

    host.complete('review', { finalText: 'R' });
    await tick();
    expect(runner.getRunState('fan', 'r1')!.status).toBe('completed');
  });

  it('marks a node failed, leaves dependents pending, and settles the run as failed', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'fail',
        title: 'F',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b ${nodes.a.output}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('fail', { runId: 'r1' });
    await tick();

    host.complete('a', { reason: 'error' });
    await tick();

    const snap = runner.getRunState('fail', 'r1')!;
    expect(snap.status).toBe('failed');
    expect(snap.nodes.find((n) => n.id === 'a')!.state).toBe('failed');
    expect(snap.nodes.find((n) => n.id === 'b')!.state).toBe('pending');
    expect(host.promptFor('b')).toBeUndefined();
    expect(host.statuses.some((s) => s.sessionId === 'sess-a' && s.status === 'needs-review')).toBe(true);

    const log = readRunLog(root, 'fail', 'r1');
    expect(log.some((e) => e.kind === 'node-finished' && (e as { state?: string }).state === 'failed')).toBe(true);
    expect(log.some((e) => e.kind === 'run-failed')).toBe(true);
  });

  it('honors max_parallel', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'par',
        title: 'P',
        goal: 'g',
        max_parallel: 1,
        nodes: [
          { id: 'x', prompt: 'x' },
          { id: 'y', prompt: 'y' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('par', { runId: 'r1' });
    await tick();
    expect(host.dispatchedNames()).toEqual(['x']); // only one slot

    host.complete('x', { finalText: 'X' });
    await tick();
    expect(host.dispatchedNames()).toEqual(['x', 'y']);

    host.complete('y', { finalText: 'Y' });
    await tick();
    expect(runner.getRunState('par', 'r1')!.status).toBe('completed');
  });

  it('pauses scheduling and resumes', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'pz',
        title: 'Pz',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b ${nodes.a.output}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('pz', { runId: 'r1' });
    await tick();

    runner.pause('pz', 'r1');
    host.complete('a', { finalText: 'A' });
    await tick();
    expect(host.promptFor('b')).toBeUndefined(); // paused → no scheduling
    expect(runner.getRunState('pz', 'r1')!.status).toBe('paused');

    runner.resume('pz', 'r1');
    await tick();
    expect(host.promptFor('b')).toBe('b A');

    host.complete('b', { finalText: 'B' });
    await tick();
    expect(runner.getRunState('pz', 'r1')!.status).toBe('completed');
  });

  it('stops a run and cancels in-flight children', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'st',
        title: 'St',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('st', { runId: 'r1' });
    await tick();

    await runner.stop('st', 'r1');
    const snap = runner.getRunState('st', 'r1')!;
    expect(snap.status).toBe('stopped');
    expect(snap.nodes.find((n) => n.id === 'a')!.state).toBe('cancelled');
    expect(host.cancelled).toContain('sess-a');
  });

  it('resumes a run from the persisted run-log after a restart, reusing finished node outputs', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'res',
        title: 'Res',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b ${nodes.a.output}' },
        ],
      }),
    );
    // First runner: complete 'a' (output persisted), leave 'b' pending, then "crash" (drop the runner).
    const r1 = makeRunner();
    r1.run('res', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    r1.pause('res', 'r1'); // so completing 'a' does not dispatch 'b'
    host.complete('a', { finalText: 'A', tokenUsage: tu(3, 4) });
    await tick();
    expect(readNodeOutput(root, 'res', 'r1', 'a')).toEqual({ text: 'A' });

    // Simulate an app restart: a brand-new runner + host with empty in-memory state.
    const host2 = new MockHost();
    const r2 = new TaskRunner({ host: host2, workspaceId: 'ws', workspaceRoot: root, now: () => '2026-06-07T00:00:00.000Z' });
    r2.resume('res', 'r1'); // not in memory → rehydrate from the run-log
    await tick();

    // 'a' is reused from disk (NOT re-spawned); only 'b' dispatches, seeded with a's recovered output.
    expect(host2.dispatchedNames()).toEqual(['b']);
    expect(host2.promptFor('b')).toBe('b A');
    // The orchestrator linkage is recovered from the run-log.
    expect(host2.created.find((c) => c.options.name === 'b')?.options.parentSessionId).toBe('orch');

    host2.complete('b', { finalText: 'B' });
    await tick();
    // Resumed run re-verifies (orchestrator recovered from the run-log) before going terminal.
    expect(r2.getRunState('res', 'r1')!.status).toBe('verifying');
    host2.completeSession('orch', { finalText: 'VERDICT: PASS' });
    await tick();
    expect(r2.getRunState('res', 'r1')!.status).toBe('completed');
  });

  it('retries a failed node up to retry.limit, then fails', async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'rt', title: 'Rt', goal: 'g', nodes: [{ id: 'a', prompt: 'do a', retry: { limit: 1 } }] }),
    );
    const runner = makeRunner();
    runner.run('rt', { runId: 'r1' });
    await tick();

    // First failure → within budget → re-dispatched (still running, attempt 2).
    host.complete('a', { reason: 'error' });
    await tick();
    expect(host.created.filter((c) => c.options.name === 'a')).toHaveLength(2);
    let snap = runner.getRunState('rt', 'r1')!;
    expect(snap.nodes[0]!.state).toBe('running');
    expect(snap.nodes[0]!.attempt).toBe(2);

    // Second failure → budget exhausted → failed.
    host.complete('a', { reason: 'error' });
    await tick();
    snap = runner.getRunState('rt', 'r1')!;
    expect(snap.status).toBe('failed');
    expect(snap.nodes[0]!.state).toBe('failed');
    expect(readRunLog(root, 'rt', 'r1').some((e) => e.kind === 'node-retry')).toBe(true);
  });

  it('does not retry when retry.limit is 0', async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'rt0', title: 'Rt0', goal: 'g', nodes: [{ id: 'a', prompt: 'a', retry: { limit: 0 } }] }),
    );
    const runner = makeRunner();
    runner.run('rt0', { runId: 'r1' });
    await tick();
    host.complete('a', { reason: 'error' });
    await tick();
    expect(runner.getRunState('rt0', 'r1')!.status).toBe('failed');
    expect(host.created.filter((c) => c.options.name === 'a')).toHaveLength(1);
  });

  it('feeds the prior failure into the retried prompt and can then succeed', async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'rtok', title: 'RtOk', goal: 'g', nodes: [{ id: 'a', prompt: 'do a', retry: { limit: 2 } }] }),
    );
    const runner = makeRunner();
    runner.run('rtok', { runId: 'r1' });
    await tick();

    // UB2.8: a `timeout` is a user Stop and WAITS now — the retry class is driven by `error`.
    host.complete('a', { reason: 'error' });
    await tick();
    const retryPrompt = host.sent.filter((s) => s.sessionId === 'sess-a')[1]!.message;
    expect(retryPrompt).toContain('Previous attempt failed: error');
    expect(retryPrompt).toContain('do a');

    host.complete('a', { finalText: 'OK' });
    await tick();
    expect(runner.getRunState('rtok', 'r1')!.status).toBe('completed');
  });

  it('does not retry on error when retry.when targets a different failure class', async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'rtw', title: 'RtW', goal: 'g', nodes: [{ id: 'a', prompt: 'a', retry: { limit: 3, when: 'empty' } }] }),
    );
    const runner = makeRunner();
    runner.run('rtw', { runId: 'r1' });
    await tick();
    host.complete('a', { reason: 'error' });
    await tick();
    expect(runner.getRunState('rtw', 'r1')!.status).toBe('failed');
    expect(host.created.filter((c) => c.options.name === 'a')).toHaveLength(1);
  });

  it('completes without verifying when there is no orchestrator', async () => {
    saveTaskSpec(root, specOf({ id: 'nov', title: 'NoV', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('nov', { runId: 'r1' }); // no orchestratorSessionId → nothing to verify against
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    expect(runner.getRunState('nov', 'r1')!.status).toBe('completed');
    expect(readRunLog(root, 'nov', 'r1').some((e) => e.kind === 'run-verifying')).toBe(false);
  });

  it('gates the run on the orchestrator verdict and includes acceptance_criteria in the prompt', async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'vp', title: 'Vp', goal: 'g', acceptance_criteria: 'must be perfect', nodes: [{ id: 'a', prompt: 'do a' }] }),
    );
    const runner = makeRunner();
    runner.run('vp', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    expect(runner.getRunState('vp', 'r1')!.status).toBe('verifying');
    const vmsg = host.sent.find((s) => s.sessionId === 'orch')!.message;
    expect(vmsg).toContain('must be perfect');
    expect(vmsg).toContain('VERDICT: PASS');

    host.completeSession('orch', { finalText: 'VERDICT: PASS' });
    await tick();
    expect(runner.getRunState('vp', 'r1')!.status).toBe('completed');
  });

  it('re-runs the terminal node once on a FAIL verdict, then completes on PASS', async () => {
    saveTaskSpec(root, specOf({ id: 'vf', title: 'Vf', goal: 'g', nodes: [{ id: 'a', prompt: 'do a' }] }));
    const runner = makeRunner();
    runner.run('vf', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'first' });
    await tick();

    host.completeSession('orch', { finalText: 'Not good enough.\nVERDICT: FAIL — missing X' });
    await tick();
    const snap = runner.getRunState('vf', 'r1')!;
    expect(snap.status).toBe('running');
    expect(snap.nodes[0]!.state).toBe('running');
    expect(snap.nodes[0]!.attempt).toBe(2);
    const retryPrompt = host.sent.filter((s) => s.sessionId === 'sess-a')[1]!.message;
    expect(retryPrompt).toContain('rejected on verification: missing X');

    host.complete('a', { finalText: 'second' });
    await tick();
    expect(runner.getRunState('vf', 'r1')!.status).toBe('verifying');
    host.completeSession('orch', { finalText: 'VERDICT: PASS' });
    await tick();
    expect(runner.getRunState('vf', 'r1')!.status).toBe('completed');
  });

  it('fails the run when FAIL verdicts exhaust the repair budget (max_iterations)', async () => {
    // max_iterations: 1 → one repair allowed; the second FAIL breaches the iteration budget.
    saveTaskSpec(root, specOf({ id: 'vff', title: 'Vff', goal: 'g', max_iterations: 1, nodes: [{ id: 'a', prompt: 'do a' }] }));
    const runner = makeRunner();
    runner.run('vff', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    host.completeSession('orch', { finalText: 'VERDICT: FAIL — nope' });
    await tick();
    expect(runner.getRunState('vff', 'r1')!.status).toBe('running'); // first repair in flight

    host.complete('a', { finalText: 'y' });
    await tick();
    host.completeSession('orch', { finalText: 'VERDICT: FAIL — still nope' });
    await tick();
    expect(runner.getRunState('vff', 'r1')!.status).toBe('failed');
    const log = readRunLog(root, 'vff', 'r1');
    expect(log.filter((e) => e.kind === 'verdict').length).toBe(2);
    expect(log.some((e) => e.kind === 'budget-breach' && (e as { metric?: string }).metric === 'iterations')).toBe(true);
    expect(log.some((e) => e.kind === 'run-failed')).toBe(true);
  });

  it('re-asks on an unparsable verdict and fails only after the re-ask budget is exhausted', async () => {
    saveTaskSpec(root, specOf({ id: 'unp', title: 'Unp', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('unp', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();

    // First malformed reply → re-asked, run stays verifying (not terminal).
    host.completeSession('orch', { finalText: 'I think it is fine but forgot the verdict line.' });
    await tick();
    expect(runner.getRunState('unp', 'r1')!.status).toBe('verifying');
    expect(host.sent.filter((s) => s.sessionId === 'orch' && s.message.includes('did not include a parseable verdict')).length).toBe(1);

    // Second malformed reply → re-asked again (MAX_UNPARSED_REASKS = 2).
    host.completeSession('orch', { finalText: 'still no verdict line, sorry' });
    await tick();
    expect(runner.getRunState('unp', 'r1')!.status).toBe('verifying');

    // Third malformed reply → budget exhausted → failed.
    host.completeSession('orch', { finalText: 'nope, no verdict again' });
    await tick();
    expect(runner.getRunState('unp', 'r1')!.status).toBe('failed');
    expect(readRunLog(root, 'unp', 'r1').filter((e) => e.kind === 'verdict' && (e as { result?: string }).result === 'unparsed').length).toBe(3);
  });

  it('scopes a repair to the named nodes and their transitive dependents', async () => {
    // Chain a → b → c. A FAIL naming only `b` must re-run b AND c (downstream), but leave a done.
    saveTaskSpec(
      root,
      specOf({
        id: 'scope',
        title: 'Scope',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b ${nodes.a.output}' },
          { id: 'c', depends_on: ['b'], prompt: 'c ${nodes.b.output}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('scope', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'A' });
    await tick();
    host.complete('b', { finalText: 'B' });
    await tick();
    host.complete('c', { finalText: 'C' });
    await tick();
    expect(runner.getRunState('scope', 'r1')!.status).toBe('verifying');

    host.completeSession('orch', { finalText: 'VERDICT: FAIL — nodes=b — b is wrong' });
    await tick();
    const snap = runner.getRunState('scope', 'r1')!;
    expect(snap.status).toBe('running');
    expect(snap.nodes.find((n) => n.id === 'a')!.state).toBe('done'); // upstream untouched
    expect(snap.nodes.find((n) => n.id === 'b')!.state).toBe('running'); // re-dispatched
    expect(snap.nodes.find((n) => n.id === 'c')!.state).toBe('pending'); // waits on b
    // a ran once; b re-dispatched (2); c not yet re-dispatched.
    expect(host.created.filter((c) => c.options.name === 'a')).toHaveLength(1);
    expect(host.created.filter((c) => c.options.name === 'b')).toHaveLength(2);
    expect(host.created.filter((c) => c.options.name === 'c')).toHaveLength(1);
  });

  it('an unparsed re-ask does not consume the repair budget', async () => {
    // max_iterations: 1. An intervening unparsed verdict must not eat the single repair allowance.
    saveTaskSpec(root, specOf({ id: 'unb', title: 'Unb', goal: 'g', max_iterations: 1, nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('unb', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();

    host.completeSession('orch', { finalText: 'no verdict here' }); // unparsed → re-ask
    await tick();
    expect(runner.getRunState('unb', 'r1')!.status).toBe('verifying');

    host.completeSession('orch', { finalText: 'VERDICT: FAIL — fix it' }); // first real FAIL → repair still allowed
    await tick();
    expect(runner.getRunState('unb', 'r1')!.status).toBe('running');
  });

  it('does not hang in verifying when the verification send rejects', async () => {
    saveTaskSpec(root, specOf({ id: 'snd', title: 'Snd', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('snd', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    // Make the orchestrator verification send reject (the verdict can never arrive).
    const origSend = host.sendMessage.bind(host);
    host.sendMessage = async (sessionId: string, message: string) => {
      if (sessionId === 'orch') throw new Error('send boom');
      return origSend(sessionId, message);
    };
    host.complete('a', { finalText: 'x' });
    await tick();
    await tick();
    expect(runner.getRunState('snd', 'r1')!.status).toBe('failed');
  });

  it('ignores a verdict that arrives after the run was stopped', async () => {
    saveTaskSpec(root, specOf({ id: 'late', title: 'Late', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('late', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    expect(runner.getRunState('late', 'r1')!.status).toBe('verifying');

    await runner.stop('late', 'r1');
    expect(runner.getRunState('late', 'r1')!.status).toBe('stopped');

    // A late verdict for the (now stopped) run must not flip it back to completed/failed.
    host.completeSession('orch', { finalText: 'VERDICT: PASS' });
    await tick();
    expect(runner.getRunState('late', 'r1')!.status).toBe('stopped');
  });

  it('reconstructs the repair counter from the run-log on a cross-restart resume', async () => {
    // max_iterations: 1. Consume the single repair, then "restart": the resumed run must remember
    // repairsUsed=1 (from the persisted FAIL verdict) so the next FAIL fails immediately.
    // NESSY (UA4.3, TaskRunner header item 13): the repair dispatched before the restart is replayed, so the resumed
    // run re-runs 'a' and verifies ITS output (upstream went straight to `verifying` the rejected one).
    saveTaskSpec(root, specOf({ id: 'hyd', title: 'Hyd', goal: 'g', max_iterations: 1, nodes: [{ id: 'a', prompt: 'a' }] }));
    const r1 = makeRunner();
    r1.run('hyd', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    host.completeSession('orch', { finalText: 'VERDICT: FAIL — redo' }); // consumes the one repair
    await tick();
    expect(r1.getRunState('hyd', 'r1')!.status).toBe('running');

    // Restart: fresh host + runner with empty in-memory state, resume from the run-log.
    const host2 = new MockHost();
    const r2 = new TaskRunner({ host: host2, workspaceId: 'ws', workspaceRoot: root, now: () => '2026-06-07T00:00:00.000Z' });
    r2.resume('hyd', 'r1');
    await tick();
    expect(r2.getRunState('hyd', 'r1')!.status).toBe('running');
    expect(host2.dispatchedNames()).toEqual(['a']);
    host2.complete('a', { finalText: 'y' });
    await tick();
    expect(r2.getRunState('hyd', 'r1')!.status).toBe('verifying');

    // A single FAIL now exhausts the (carried-over) budget immediately.
    host2.completeSession('orch', { finalText: 'VERDICT: FAIL — still bad' });
    await tick();
    expect(r2.getRunState('hyd', 'r1')!.status).toBe('failed');
  });

  it('fails a node that completes with no text despite declaring outputs (instead of marking it done)', async () => {
    // Bug 2: a clean turn-completion is not proof of success. A node that declared `outputs` but
    // produced empty final text delivered nothing — it must fail (→ needs-review), not silently pass.
    saveTaskSpec(
      root,
      specOf({
        id: 'empty',
        title: 'Empty',
        goal: 'g',
        nodes: [{ id: 'a', prompt: 'a', outputs: [{ name: 'result' }] }],
      }),
    );
    const runner = makeRunner();
    runner.run('empty', { runId: 'r1' });
    await tick();

    host.complete('a', { finalText: '   ' }); // whitespace-only → counts as empty
    await tick();

    const snap = runner.getRunState('empty', 'r1')!;
    expect(snap.nodes.find((n) => n.id === 'a')!.state).toBe('failed');
    expect(snap.status).toBe('failed');
    expect(host.statuses.some((s) => s.sessionId === 'sess-a' && s.status === 'needs-review')).toBe(true);
  });

  it('UB2.8 (B4-19): an empty reply fails the node even when it declares NO outputs (the lenient default is gone)', async () => {
    // B4-19: a finished turn that delivered nothing fails the node — declared outputs or not —
    // so the dependents never read an empty answer as done. The retry policy applies from here.
    saveTaskSpec(root, specOf({ id: 'lenient', title: 'Lenient', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('lenient', { runId: 'r1' });
    await tick();

    host.complete('a', { finalText: '' });
    await tick();

    expect(runner.getRunState('lenient', 'r1')!.nodes.find((n) => n.id === 'a')!.state).toBe('failed');
  });

  it('publishes the total node count to the orchestrator at run start (stable board denominator)', async () => {
    // Bug 3: the board derives subtask progress from lazily-spawned child sessions, so without an
    // up-front total the denominator grows (0/1 → 1/2 …). The runner publishes spec.nodes.length once.
    saveTaskSpec(
      root,
      specOf({
        id: 'count',
        title: 'Count',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b' },
          { id: 'c', depends_on: ['b'], prompt: 'c' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('count', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();

    expect(host.nodeCounts).toContainEqual({ sessionId: 'orch', count: 3 });
  });

  // v0.15.1 (B4-16, UB1.14) — upstream's two cases plus our controls: a reply the prompt already places by an
  // explicit ref arrives once, not twice, and an empty upstream reply adds nothing.
  describe('depends_on hands the upstream reply to the dependent', () => {
    it('adds the reply unless the prompt already places it with ${nodes.<id>.output}', async () => {
      saveTaskSpec(
        root,
        specOf({
          id: 'hand',
          title: 'Hand',
          goal: 'g',
          nodes: [
            { id: 'explore', title: 'Explore the platform', prompt: 'Map the site' },
            { id: 'journeys', prompt: 'Based on the exploration output, write the journeys', depends_on: ['explore'] },
            { id: 'inline', prompt: 'Summarize: ${nodes.explore.output}', depends_on: ['explore'] },
          ],
        }),
      );
      const runner = makeRunner();
      runner.run('hand', { runId: 'r1' });
      await tick();
      host.completeSession('sess-Explore the platform', { finalText: 'SITE MAP' }); // the mock names sessions by title
      await tick();

      expect(host.promptFor('journeys')).toBe(
        'Replies of the step this one depends on:\n\n### Explore the platform\nSITE MAP\n\n---\n\nBased on the exploration output, write the journeys',
      );
      expect(host.promptFor('inline')).toBe('Summarize: SITE MAP');
    });

    it('cuts a very long reply and points at the full one', async () => {
      saveTaskSpec(
        root,
        specOf({
          id: 'long',
          title: 'Long',
          goal: 'g',
          nodes: [{ id: 'a', prompt: 'a' }, { id: 'b', prompt: 'b', depends_on: ['a'] }],
        }),
      );
      const runner = makeRunner();
      runner.run('long', { runId: 'r1' });
      await tick();
      host.complete('a', { finalText: 'x'.repeat(50_000) });
      await tick();

      const prompt = host.promptFor('b')!;
      expect(prompt.length).toBeLessThan(41_000);
      expect(prompt).toContain(`the full reply is in ${join(root, 'tasks', 'long', 'runs', 'r1', 'nodes', 'a.json')}`);
    });

    it('CONTROL: an explicit ref gets the reply once, not twice', async () => {
      saveTaskSpec(
        root,
        specOf({
          id: 'once',
          title: 'Once',
          goal: 'g',
          nodes: [
            { id: 'explore', prompt: 'Map the site' },
            { id: 'inline', prompt: 'Summarize: ${nodes.explore.output}', depends_on: ['explore'] },
          ],
        }),
      );
      const runner = makeRunner();
      runner.run('once', { runId: 'r1' });
      await tick();
      host.complete('explore', { finalText: 'SITE MAP' });
      await tick();

      const prompt = host.promptFor('inline')!;
      expect(prompt).toBe('Summarize: SITE MAP');
      expect(prompt.split('SITE MAP')).toHaveLength(2); // exactly one copy
      expect(prompt).not.toContain('Replies of the step');
    });

    it('CONTROL: an empty upstream reply adds nothing', async () => {
      saveTaskSpec(
        root,
        specOf({
          id: 'empty',
          title: 'Empty',
          goal: 'g',
          nodes: [
            { id: 'explore', prompt: 'Map the site' },
            { id: 'write', prompt: 'based on the exploration, write the doc', depends_on: ['explore'] },
          ],
        }),
      );
      const runner = makeRunner();
      runner.run('empty', { runId: 'r1' });
      await tick();
      // UB2.8 (B4-19): an empty reply FAILS the upstream node, so the dependent is never
      // dispatched — an empty answer cannot reach a dependent at all (the section-less prompt
      // shape it used to assert is unreachable by construction now).
      host.complete('explore', { finalText: '   ' });
      await tick();

      expect(runner.getRunState('empty', 'r1')!.nodes.find((n) => n.id === 'explore')!.state).toBe('failed');
      expect(host.promptFor('write')).toBeUndefined();
    });
  });

  // ==========================================================================
  // UB6.6 — decision-model verdicts and repair scoping (rebased from upstream
  // v0.15.1 TaskRunner.test.ts; the settlement-gate door of UB2.8 stays: an
  // unparsed verdict at an unsettled orchestrator waits, which only the
  // dv-* arms touch through completeSession completions that are settled).
  // ==========================================================================

  function decisionResult(choice: 'pass' | 'fail' | 'unclear', opts: { confidence?: number; rework?: Record<string, number> } = {}): DecisionResult {
    const confidence = opts.confidence ?? 0.9;
    const p = Math.max(confidence, 0.99 - confidence);
    const answers: DecisionResult['answers'] = {
      verdict: { type: 'choice', choice, confidence, probabilities: { pass: choice === 'pass' ? p : (1 - p) / 2, fail: choice === 'fail' ? p : (1 - p) / 2, unclear: choice === 'unclear' ? p : 0 } },
    };
    for (const [id, noul] of Object.entries(opts.rework ?? {})) {
      answers[`rework:${id}`] = { type: 'noul', noul };
    }
    return { model: 'jev-test', modelReported: true, requestedModel: 'jev-test', answers, usage: { inputTokens: 10, outputTokens: 1 }, latencyMs: 10, state: { sha256: 'x', bytes: 10, truncated: false } };
  }

  describe('repair scoping via the decision model (UB6.6)', () => {
    const chain = [
      { id: 'a', prompt: 'fetch the data' },
      { id: 'b', depends_on: ['a'], prompt: 'summarize ${nodes.a.output}' },
      { id: 'c', depends_on: ['b'], prompt: 'format ${nodes.b.output}' },
    ];
    const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

    async function failWithoutNodes(slug: string, runner: TaskRunner) {
      saveTaskSpec(root, specOf({ id: slug, title: slug, goal: 'g', nodes: chain }));
      runner.run(slug, { runId: 'r1', orchestratorSessionId: 'orch' });
      await tick();
      for (const id of ['a', 'b', 'c']) {
        host.complete(id, { finalText: id.toUpperCase() });
        await tick();
      }
      host.completeSession('orch', { finalText: 'VERDICT: FAIL — the summary drops the totals' });
      await settle();
      return runner.getRunState(slug, 'r1')!;
    }

    it('positive: repairs only the subtasks the reason implicates, and their dependents', async () => {
      const asked: Array<{ reason: string; ids: string[] }> = [];
      const runner = makeRunner({
        pickRepairNodes: async (reason, nodes) => { asked.push({ reason, ids: nodes.map((n) => n.id) }); return ['b']; },
      });
      const snap = await failWithoutNodes('pick', runner);
      expect(asked).toEqual([{ reason: 'the summary drops the totals', ids: ['a', 'b', 'c'] }]);
      expect(snap.status).toBe('running');
      expect(snap.nodes.find((n) => n.id === 'a')!.state).toBe('done');
      expect(snap.nodes.find((n) => n.id === 'b')!.state).toBe('running');
      expect(snap.nodes.find((n) => n.id === 'c')!.state).toBe('pending');
    });

    it('negative (control): repairs the whole DAG when the model has no answer or fails', async () => {
      for (const [slug, pick] of [
        ['none', async () => null],
        ['boom', async () => { throw new Error('down'); }],
      ] as const) {
        const snap = await failWithoutNodes(slug, makeRunner({ pickRepairNodes: pick }));
        expect(snap.nodes.find((n) => n.id === 'a')!.state).toBe('running');
      }
    });

    it('negative (control): repairs the whole DAG when a narrowed repair fails again', async () => {
      const asked: string[] = [];
      const runner = makeRunner({ pickRepairNodes: async (reason) => { asked.push(reason); return ['c']; } });
      const first = await failWithoutNodes('escalate', runner);
      expect(first.nodes.map((n) => n.state)).toEqual(['done', 'done', 'running']);
      host.complete('c', { finalText: 'C again' });
      await tick();
      host.completeSession('orch', { finalText: 'VERDICT: FAIL — the summary drops the totals' });
      await settle();
      expect(asked).toHaveLength(1);
      expect(runner.getRunState('escalate', 'r1')!.nodes.find((n) => n.id === 'a')!.state).toBe('running');
    });

    it('negative (control): does not scope a FAIL the decision model read out of a reply without a VERDICT line', async () => {
      let asked = 0;
      const runner = makeRunner({
        decide: async () => decisionResult('fail'),
        pickRepairNodes: async () => { asked++; return ['c']; },
      });
      saveTaskSpec(root, specOf({ id: 'decided-fail', title: 'decided-fail', goal: 'g', nodes: chain }));
      runner.run('decided-fail', { runId: 'r1', orchestratorSessionId: 'orch' });
      await tick();
      for (const id of ['a', 'b', 'c']) {
        host.complete(id, { finalText: id });
        await tick();
      }
      host.completeSession('orch', { finalText: 'Not quite there: the totals are missing.' });
      await settle();
      expect(asked).toBe(0);
      expect(runner.getRunState('decided-fail', 'r1')!.nodes.find((n) => n.id === 'a')!.state).toBe('running');
    });

    it('negative (control): never consults the model when the verdict names the subtasks', async () => {
      let asked = 0;
      const runner = makeRunner({ pickRepairNodes: async () => { asked++; return ['a']; } });
      saveTaskSpec(root, specOf({ id: 'named', title: 'named', goal: 'g', nodes: chain }));
      runner.run('named', { runId: 'r1', orchestratorSessionId: 'orch' });
      await tick();
      for (const id of ['a', 'b', 'c']) {
        host.complete(id, { finalText: id });
        await tick();
      }
      host.completeSession('orch', { finalText: 'VERDICT: FAIL — nodes=c — formatting' });
      await settle();
      expect(asked).toBe(0);
      expect(runner.getRunState('named', 'r1')!.nodes.find((n) => n.id === 'b')!.state).toBe('done');
    });
  });

  describe('decision-model verdicts, unparsed replies only (UB6.6)', () => {
    async function runToVerifying(slug: string, runner: TaskRunner, nodes: Array<{ id: string; prompt: string; deps?: string[] }>) {
      saveTaskSpec(root, specOf({ id: slug, title: slug, goal: 'g', nodes }));
      runner.run(slug, { runId: 'r1', orchestratorSessionId: 'orch' });
      await tick();
      for (const n of nodes) {
        host.complete(n.id, { finalText: `${n.id} output` });
        await tick();
      }
      expect(runner.getRunState(slug, 'r1')!.status).toBe('verifying');
    }

    it('positive: completes on a confident PASS read out of a reply without a VERDICT line', async () => {
      const requests: unknown[] = [];
      const runner = makeRunner({ decide: async (request) => { requests.push(request); return decisionResult('pass'); } });
      await runToVerifying('dv-pass', runner, [{ id: 'a', prompt: 'a' }]);

      host.completeSession('orch', { finalText: 'Everything checks out, the summary matches the criteria.' });
      await tick();
      expect(runner.getRunState('dv-pass', 'r1')!.status).toBe('completed');
      expect(requests).toHaveLength(1);
      expect(host.sent.some((s) => s.message.includes('did not include a parseable verdict'))).toBe(false);
      const verdicts = readRunLog(root, 'dv-pass', 'r1').filter((e) => e.kind === 'verdict');
      expect(verdicts).toEqual([{ t: '2026-06-07T00:00:00.000Z', kind: 'verdict', result: 'pass', via: 'decision', confidence: 0.9 }]);
    });

    it('negative (control): never consults the model when the reply has a parseable VERDICT line', async () => {
      let calls = 0;
      const runner = makeRunner({ decide: async () => { calls += 1; return decisionResult('fail'); } });
      await runToVerifying('dv-parsed', runner, [{ id: 'a', prompt: 'a' }]);
      host.completeSession('orch', { finalText: 'Reviewed.\nVERDICT: PASS' });
      await tick();
      expect(runner.getRunState('dv-parsed', 'r1')!.status).toBe('completed');
      expect(calls).toBe(0);
      const verdict = readRunLog(root, 'dv-parsed', 'r1').find((e) => e.kind === 'verdict') as { via?: string };
      expect(verdict.via).toBeUndefined();
    });

    it('negative (control): falls back to the re-ask when the model is unavailable, unsure, or throws (layer off logs no via)', async () => {
      const outcomes: Array<{ decide: () => Promise<DecisionResult | null>; via: 'decision' | undefined }> = [
        { decide: async () => null, via: undefined },                                   // layer off: no decision ran
        { decide: async () => decisionResult('unclear'), via: 'decision' },             // model answered "unclear"
        { decide: async () => decisionResult('pass', { confidence: 0.3 }), via: 'decision' }, // below threshold → unsure
        { decide: async () => { throw new Error('boom'); }, via: undefined },             // failed → no decision
      ];
      for (const [i, { decide, via }] of outcomes.entries()) {
        const slug = `dv-fallback-${i}`;
        const runner = makeRunner({ decide });
        await runToVerifying(slug, runner, [{ id: 'a', prompt: 'a' }]);
        host.completeSession('orch', { finalText: 'hmm, not sure what to say here' });
        await tick();
        expect(runner.getRunState(slug, 'r1')!.status).toBe('verifying');
        expect(host.sent.filter((s) => s.sessionId === 'orch' && s.message.includes('did not include a parseable verdict')).length).toBe(i + 1);
        const verdict = readRunLog(root, slug, 'r1').find((e) => e.kind === 'verdict') as { result: string; via?: string };
        expect(verdict.result).toBe('unparsed');
        expect(verdict.via).toBe(via);
        // Detach this run's verdict listener so the next iteration's orchestrator completion is not
        // also consumed by it (all iterations share one mock host / orchestrator id).
        await runner.stop(slug, 'r1');
      }
    });

    it('positive: repairs only the nodes the model flags on a confident FAIL', async () => {
      const runner = makeRunner({ decide: async () => decisionResult('fail', { rework: { research: 0.1, report: 0.95 } }) });
      await runToVerifying('dv-fail', runner, [
        { id: 'research', prompt: 'r' },
        { id: 'report', prompt: 'p', deps: ['research'] },
      ]);
      const dispatchedBefore = host.created.length;

      host.completeSession('orch', { finalText: 'The research is solid.\nThe report is missing the revenue table and needs another pass.' });
      await tick();
      expect(runner.getRunState('dv-fail', 'r1')!.status).toBe('running');
      // Only `report` was reset and re-dispatched; `research` keeps its output.
      expect(host.created.length).toBe(dispatchedBefore + 1);
      expect(host.created.at(-1)!.options.name).toBe('report');
      const retried = readRunLog(root, 'dv-fail', 'r1').filter((e) => e.kind === 'node-retry') as Array<{ nodeId: string; reason: string }>;
      expect(retried.map((e) => e.nodeId)).toEqual(['report']);
      // The repair reason never quotes the reply (an arbitrary line could mislead the re-run).
      expect(retried[0]!.reason).toContain('no VERDICT line');
      expect(retried[0]!.reason).not.toContain('needs another pass');
      const verdict = readRunLog(root, 'dv-fail', 'r1').find((e) => e.kind === 'verdict') as { result: string; nodes?: string[]; via?: string };
      expect(verdict).toMatchObject({ result: 'fail', nodes: ['report'], via: 'decision' });
    });

    it('negative (control): ignores a classification that resolves after the run was stopped', async () => {
      let release!: (value: DecisionResult | null) => void;
      const pending = new Promise<DecisionResult | null>((resolve) => { release = resolve; });
      const runner = makeRunner({ decide: () => pending });
      await runToVerifying('dv-stop', runner, [{ id: 'a', prompt: 'a' }]);
      host.completeSession('orch', { finalText: 'no verdict line here' });
      await tick();
      await runner.stop('dv-stop', 'r1');
      release(decisionResult('pass'));
      await tick();
      expect(runner.getRunState('dv-stop', 'r1')!.status).toBe('stopped');
    });
  });
  // ==========================================================================
  // UB6.7 — child outcome via the decision model (rebased from upstream v0.15.1;
  // the RT negative added: a STOPPED (waitingForUser) node is neither classified
  // nor marked done before the user's next turn).
  // ==========================================================================

  describe('child outcome via the decision model (UB6.7)', () => {
    type Outcome = 'finished' | 'needs_input' | 'blocked' | null;
    const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

    it('positive: retries a child that asked for input, telling the retry to decide, then completes', async () => {
      saveTaskSpec(root, specOf({ id: 'ask', title: 'Ask', goal: 'g', nodes: [{ id: 'a', prompt: 'do a', retry: { limit: 1 } }] }));
      const answers: Outcome[] = ['needs_input', 'finished'];
      const seen: string[] = [];
      const runner = makeRunner({ classifyNodeOutcome: async (text) => { seen.push(text); return answers.shift() ?? null; } });
      runner.run('ask', { runId: 'r1' });
      await tick();

      host.complete('a', { finalText: 'Which colour should the button be?' });
      await settle();
      expect(seen).toEqual(['Which colour should the button be?']);
      expect(host.created.filter((c) => c.options.name === 'a')).toHaveLength(2);
      const retryPrompt = host.sent.filter((s) => s.sessionId === 'sess-a')[1]!.message;
      // The reason travels on the retry so the board can show it (tasks.nodeOutcomeReason).
      expect(retryPrompt).toContain('asked for input instead of finishing');

      host.complete('a', { finalText: 'Made it blue.' });
      await settle();
      expect(runner.getRunState('ask', 'r1')!.status).toBe('completed');
    });

    it('positive: fails a child that reports it is blocked when no retry budget remains (needs-review status)', async () => {
      saveTaskSpec(root, specOf({ id: 'blk', title: 'Blk', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
      const runner = makeRunner({ classifyNodeOutcome: async () => 'blocked' });
      runner.run('blk', { runId: 'r1' });
      await tick();

      host.complete('a', { finalText: 'I cannot reach the database.' });
      await settle();
      const snap = runner.getRunState('blk', 'r1')!;
      expect(snap.nodes[0]!.state).toBe('failed');
      expect(host.statuses.some((s) => s.sessionId === 'sess-a' && s.status === 'needs-review')).toBe(true);
    });

    it('negative (control): marks the child done when the model finds it finished, is unavailable, or throws', async () => {
      for (const [slug, classify] of [
        ['fin', async () => 'finished' as const],
        ['off', async () => null],
        ['boom', async () => { throw new Error('boom'); }],
      ] as const) {
        saveTaskSpec(root, specOf({ id: slug, title: slug, goal: 'g', nodes: [{ id: `n-${slug}`, prompt: 'x' }] }));
        const runner = makeRunner({ classifyNodeOutcome: classify });
        runner.run(slug, { runId: 'r1' });
        await tick();
        host.complete(`n-${slug}`, { finalText: 'Done.' });
        await settle();
        expect(runner.getRunState(slug, 'r1')!.nodes[0]!.state).toBe('done');
      }
    });

    it('negative (control): drops an outcome that arrives after the run was stopped', async () => {
      saveTaskSpec(root, specOf({ id: 'late', title: 'Late', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
      let release: (outcome: Outcome) => void = () => {};
      const runner = makeRunner({ classifyNodeOutcome: () => new Promise<Outcome>((resolve) => { release = resolve; }) });
      runner.run('late', { runId: 'r1' });
      await tick();

      host.complete('a', { finalText: 'Should I continue?' });
      await tick();
      await runner.stop('late', 'r1');
      await tick();
      const before = runner.getRunState('late', 'r1')!.nodes[0]!.state;
      release('needs_input');
      await settle();
      expect(runner.getRunState('late', 'r1')!.nodes[0]!.state).toBe(before);
      expect(host.created.filter((c) => c.options.name === 'a')).toHaveLength(1);
    });

    it('negative (RT): a stopped (waitingForUser) node is neither classified nor marked done before the user\u2019s next turn', async () => {
      saveTaskSpec(root, specOf({ id: 'wait', title: 'Wait', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
      const classified: string[] = [];
      const runner = makeRunner({ classifyNodeOutcome: async (text) => { classified.push(text); return 'finished'; } });
      runner.run('wait', { runId: 'r1' });
      await tick();
      host.complete('a', { reason: 'interrupted', finalText: 'partial work before the stop' });
      await settle();
      // UB2.8's waiting arm answers FIRST: the node is waiting for its user, the classifier
      // never ran, and the node is still running in its own session.
      expect(classified).toEqual([]);
      const snap = runner.getRunState('wait', 'r1')!;
      expect(snap.nodes[0]!.state).toBe('running');
      // The SESSION is flagged needs-review (WAITING_FOR_USER_STATUS); the RUN keeps going.
      expect(host.statuses.some((s) => s.sessionId === 'sess-a' && s.status === 'needs-review')).toBe(true);
      expect(runner.getRunState('wait', 'r1')!.status).toBe('running');
      // The user's next turn completes it without a classification.
      host.complete('a', { finalText: 'the user continued it', fromUser: true });
      await settle();
      expect(runner.getRunState('wait', 'r1')!.nodes[0]!.state).toBe('done');
    });
  });

});

describe('UA4.1 — NESSY adaptations (TaskRunner header items 3–11)', () => {
  let root: string;
  let host: MockHost;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conductor-nessy-'));
    host = new MockHost();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const makeRunner = (extra: Partial<ConstructorParameters<typeof TaskRunner>[0]> = {}) =>
    new TaskRunner({ host, workspaceId: 'ws', workspaceRoot: root, now: () => '2026-10-02T00:00:00.000Z', ...extra });
  const one = (id: string, node: Record<string, unknown> = {}) =>
    specOf({ id, title: id, goal: 'g', nodes: [{ id: 'a', prompt: 'a', ...node }] });

  it('item 4 + UB2.8 (B4-19): a node turn with only intermediate rows (no finalText) FAILS as finished-without-a-reply — no earlier-turn fallback', async () => {
    saveTaskSpec(root, one('scoped'));
    const runner = makeRunner();
    runner.run('scoped', { runId: 'r1' });
    await tick();
    host.complete('a', {}); // the seam's turn-scoped event: no finalText because this turn produced none
    await tick();
    // The turn-scoped contract stands (no earlier turn's answer is read); B4-19 turns the empty
    // acceptance into a failure instead of recording ''.
    expect(runner.getRunState('scoped', 'r1')!.nodes[0]!.state).toBe('failed');
    expect(readNodeOutput(root, 'scoped', 'r1', 'a')).toBeNull();
    // Control: the same node with text records it.
    saveTaskSpec(root, one('scoped2'));
    const runner2 = makeRunner();
    runner2.run('scoped2', { runId: 'r2' });
    await tick();
    host.completeSession(host.created.at(-1)!.id, { finalText: 'THIS TURN' });
    await tick();
    expect(readNodeOutput(root, 'scoped2', 'r2', 'a')).toEqual({ text: 'THIS TURN' });
  });

  it('item 5: a complete whose backend verdict is an error fails the node (needs-review); a clean one does not', async () => {
    saveTaskSpec(root, one('err'));
    const runner = makeRunner();
    runner.run('err', { runId: 'r1' });
    await tick();
    host.complete('a', { finalText: 'partial', terminalIsError: true });
    await tick();
    expect(runner.getRunState('err', 'r1')!.nodes[0]!.state).toBe('failed');
    expect(host.statuses).toContainEqual({ sessionId: 'sess-a', status: 'needs-review' });
    expect(readNodeOutput(root, 'err', 'r1', 'a')).toBeNull();
  });

  it('item 9 (UB2.8): a HOST interruption (fromUser: false) PAUSES the run (not failed), and Resume re-dispatches it', async () => {
    saveTaskSpec(root, one('intr'));
    const runner = makeRunner();
    runner.run('intr', { runId: 'r1' });
    await tick();
    host.complete('a', { reason: 'interrupted', fromUser: false });
    await tick();
    let snap = runner.getRunState('intr', 'r1')!;
    expect(snap.status).toBe('paused');
    expect(snap.nodes[0]!.state).toBe('cancelled');
    expect(readRunLog(root, 'intr', 'r1').some((e) => e.kind === 'run-failed')).toBe(false);

    await runner.resume('intr', 'r1');
    await tick();
    expect(host.created.filter((c) => c.options.name === 'a')).toHaveLength(2);
    snap = runner.getRunState('intr', 'r1')!;
    expect(snap.status).toBe('running');
    expect(snap.nodes[0]!.attempt).toBe(2);
  });

  // --- UB2.8 (B4-15/17/19, OQ-B4-3 (a)): a stopped step waits for the user; a stopped
  // verify turn is not the verdict; an empty reply fails the node ---

  it.each(['interrupted', 'timeout'] as const)('UB2.8: a USER %s sets waitingForUser — the node stays running in its own session, the run keeps going, the next user turn completes it', async (reason) => {
    saveTaskSpec(root, one('wait'));
    const runner = makeRunner();
    runner.run('wait', { runId: 'r1' });
    await tick();
    host.complete('a', { reason, fromUser: true });
    await tick();

    const snap = runner.getRunState('wait', 'r1')!;
    expect(snap.status).toBe('running'); // no pause, no cancel
    expect(snap.nodes[0]!.state).toBe('running');
    expect(snap.nodes[0]!.sessionId).toBe('sess-a'); // its OWN session — no re-dispatch
    expect(readRunLog(root, 'wait', 'r1').some((e) => e.kind === 'node-waiting' && (e as { reason?: string }).reason === 'stopped')).toBe(true);
    expect(host.statuses).toContainEqual({ sessionId: 'sess-a', status: 'needs-review' });

    // The user's next turn in that session completes it with its reply.
    host.complete('a', { finalText: 'the steered answer', fromUser: true });
    await tick();
    const done = runner.getRunState('wait', 'r1')!;
    expect(done.nodes[0]!.state).toBe('done');
    expect(readNodeOutput(root, 'wait', 'r1', 'a')).toEqual({ text: 'the steered answer' });
  });

  it('UB2.8: background wake-up does not complete a stopped step (fromUser: false keeps it waiting)', async () => {
    saveTaskSpec(root, one('bgwait'));
    const runner = makeRunner();
    runner.run('bgwait', { runId: 'r1' });
    await tick();
    host.complete('a', { reason: 'interrupted', fromUser: true });
    await tick();

    // A background task ends and wakes the session for another turn.
    host.complete('a', { finalText: 'background task output', fromUser: false });
    await tick();
    const snap = runner.getRunState('bgwait', 'r1')!;
    expect(snap.nodes[0]!.state).toBe('running');
    expect(readNodeOutput(root, 'bgwait', 'r1', 'a')).toBeNull();

    // The user's own turn still completes it.
    host.complete('a', { finalText: 'the user reply', fromUser: true });
    await tick();
    expect(readNodeOutput(root, 'bgwait', 'r1', 'a')).toEqual({ text: 'the user reply' });
  });

  it('UB2.8: Stop during verify sends no re-ask, and the continuing VERDICT turn completes the run', async () => {
    saveTaskSpec(root, one('vstop'));
    const runner = makeRunner();
    runner.run('vstop', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    expect(runner.getRunState('vstop', 'r1')!.status).toBe('verifying');

    // The user stops the verification turn, then continues it.
    host.completeSession('orch', { reason: 'interrupted', fromUser: true });
    await tick();
    expect(runner.getRunState('vstop', 'r1')!.status).toBe('verifying'); // not failed by the stop
    expect(host.sent.filter((s2) => s2.sessionId === 'orch')).toHaveLength(1); // no re-ask was sent

    host.completeSession('orch', { finalText: 'VERDICT: PASS', fromUser: true });
    await tick();
    expect(runner.getRunState('vstop', 'r1')!.status).toBe('completed');
  });

  it('UB2.8: an unparsed verdict at an UNSETTLED door waits instead of re-asking; a settled unparsed reply still re-asks', async () => {
    saveTaskSpec(root, one('vdoor'));
    let settled = true; // the node's own completion passes the gate; the verdict door flips it
    const gated = Object.assign(host, { isSessionSettled: async () => settled });
    const runner = new TaskRunner({ host: gated, workspaceId: 'ws', workspaceRoot: root });
    runner.run('vdoor', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    expect(runner.getRunState('vdoor', 'r1')!.status).toBe('verifying');

    settled = false; // the orchestrator's door is unsettled now
    host.completeSession('orch', { finalText: 'thinking out loud, no verdict yet' });
    await tick();
    // Unsettled: the listener stays armed, no re-ask, still verifying.
    expect(runner.getRunState('vdoor', 'r1')!.status).toBe('verifying');
    expect(host.sent.filter((s2) => s2.sessionId === 'orch')).toHaveLength(1);

    // Settled unparsed: the bounded re-ask (the run's existing contract).
    settled = true;
    host.completeSession('orch', { finalText: 'still no verdict line' });
    await tick();
    expect(host.sent.filter((s2) => s2.sessionId === 'orch')).toHaveLength(2);
    expect(host.sent.at(-1)!.message).toMatch(/VERDICT/i);
  });

  it('UB2.8 (B4-19): an accepted completion with an EMPTY reply fails the node — declared outputs or not', async () => {
    saveTaskSpec(root, one('void'));
    const runner = makeRunner();
    runner.run('void', { runId: 'r1' });
    await tick();
    host.complete('a', { finalText: '' });
    await tick();
    const snap = runner.getRunState('void', 'r1')!;
    expect(snap.nodes[0]!.state).toBe('failed');
    const finished = readRunLog(root, 'void', 'r1').find((e) => e.kind === 'node-finished' && (e as { state?: string }).state === 'failed');
    expect(finished).toBeDefined();
    expect(readNodeOutput(root, 'void', 'r1', 'a')).toBeNull();

    // CONTROL: an `error` still fails at once, unchanged.
    saveTaskSpec(root, one('errctl'));
    const runner2 = makeRunner();
    runner2.run('errctl', { runId: 'r1' });
    await tick();
    host.complete('a', { reason: 'error' });
    await tick();
    expect(runner2.getRunState('errctl', 'r1')!.nodes[0]!.state).toBe('failed');
  });

  it('item 6: an unsettled idle door defers completion; the next settled door completes with the deferred text', async () => {
    let settled = false;
    const gated = Object.assign(host, { isSessionSettled: async () => settled });
    saveTaskSpec(root, one('gate'));
    const runner = new TaskRunner({ host: gated, workspaceId: 'ws', workspaceRoot: root });
    runner.run('gate', { runId: 'r1' });
    await tick();
    host.complete('a', { finalText: 'ANSWER' });
    await tick();
    expect(runner.getRunState('gate', 'r1')!.nodes[0]!.state).toBe('running');

    settled = true;
    host.complete('a', {}); // the woken turn produced no new text
    await tick();
    expect(runner.getRunState('gate', 'r1')!.status).toBe('completed');
    expect(readNodeOutput(root, 'gate', 'r1', 'a')).toEqual({ text: 'ANSWER' });
  });

  it('item 6: a gate read that throws is NOT settled (fail-closed)', async () => {
    const gated = Object.assign(host, { isSessionSettled: async () => { throw new Error('snapshot failed'); } });
    saveTaskSpec(root, one('gate2'));
    const runner = new TaskRunner({ host: gated, workspaceId: 'ws', workspaceRoot: root });
    runner.run('gate2', { runId: 'r1' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    expect(runner.getRunState('gate2', 'r1')!.nodes[0]!.state).toBe('running');
  });

  it('item 6: a turn in a node already done is logged node-woke-after-done and never re-read as output', async () => {
    saveTaskSpec(root, specOf({ id: 'woke', title: 'w', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }, { id: 'b', depends_on: ['a'], prompt: 'b' }] }));
    const runner = makeRunner();
    runner.run('woke', { runId: 'r1' });
    await tick();
    host.complete('a', { finalText: 'FIRST' });
    await tick();
    host.complete('a', { finalText: 'LATER' });
    await tick();
    const woke = readRunLog(root, 'woke', 'r1').filter((e) => e.kind === 'node-woke-after-done');
    expect(woke).toEqual([{ t: '2026-10-02T00:00:00.000Z', kind: 'node-woke-after-done', nodeId: 'a', sessionId: 'sess-a' }]);
    expect(readNodeOutput(root, 'woke', 'r1', 'a')).toEqual({ text: 'FIRST' });
  });

  it('item 11: a completion from a previous attempt\'s session is not taken as the current attempt', async () => {
    let n = 0;
    host.createSession = async (_ws, options) => {
      const id = `sess-${options.name}-${++n}`;
      host.created.push({ id, options });
      return { id };
    };
    saveTaskSpec(root, one('att', { retry: { limit: 1 } }));
    const runner = makeRunner();
    runner.run('att', { runId: 'r1' });
    await tick();
    host.completeSession('sess-a-1', { reason: 'error' });
    await tick();
    expect(runner.getRunState('att', 'r1')!.nodes[0]!.sessionId).toBe('sess-a-2');
    host.completeSession('sess-a-1', { finalText: 'STALE' }); // the old session wakes
    await tick();
    expect(runner.getRunState('att', 'r1')!.nodes[0]!.state).toBe('running');
    host.completeSession('sess-a-2', { finalText: 'FRESH' });
    await tick();
    expect(readNodeOutput(root, 'att', 'r1', 'a')).toEqual({ text: 'FRESH' });
  });

  it('item 7: the verdict turn must start after the verify message — a completion before its delivery is ignored', async () => {
    saveTaskSpec(root, one('vd'));
    let deliver: (() => void) | undefined;
    const origSend = host.sendMessage.bind(host);
    host.sendMessage = async (sessionId: string, message: string) => {
      if (sessionId === 'orch') {
        host.sent.push({ sessionId, message });
        await new Promise<void>((r) => { deliver = r; });
        return;
      }
      return origSend(sessionId, message);
    };
    const runner = makeRunner();
    runner.run('vd', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    expect(runner.getRunState('vd', 'r1')!.status).toBe('verifying');
    // An earlier turn of the orchestrator ends before the verify message is delivered.
    host.completeSession('orch', { finalText: 'VERDICT: PASS (an older turn)' });
    await tick();
    expect(runner.getRunState('vd', 'r1')!.status).toBe('verifying');
    deliver!();
    await tick();
    host.completeSession('orch', { finalText: 'VERDICT: FAIL — nope' });
    await tick();
    expect(readRunLog(root, 'vd', 'r1').filter((e) => e.kind === 'verdict')).toEqual([
      { t: '2026-10-02T00:00:00.000Z', kind: 'verdict', result: 'fail', reason: 'nope' },
    ]);
  });

  it('item 8: the running status is written only when the workspace defines it; the column always moves', async () => {
    saveTaskSpec(root, one('rs'));
    makeRunner().run('rs', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    expect(host.statuses.some((s) => s.status === 'in-progress')).toBe(false);
    expect(host.created[0]!.options.sessionStatus).toBeUndefined();
    expect(host.columns).toContainEqual({ sessionId: 'orch', column: 'in-progress' });

    const defined = Object.assign(new MockHost(), { hasSessionStatus: (s: string) => s === 'in-progress' });
    saveTaskSpec(root, one('rs2'));
    new TaskRunner({ host: defined, workspaceId: 'ws', workspaceRoot: root }).run('rs2', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    expect(defined.statuses).toContainEqual({ sessionId: 'orch', status: 'in-progress' });
    expect(defined.created[0]!.options.sessionStatus).toBe('in-progress');
  });

  it('item 3: a requested mode above the orchestrator\'s is clamped to it; a narrower one is kept', async () => {
    host.modeById.set('orch', 'default');
    saveTaskSpec(root, specOf({ id: 'clamp', title: 'c', goal: 'g', nodes: [
      { id: 'wide', prompt: 'w', permissionMode: 'bypassPermissions' },
      { id: 'narrow', prompt: 'n', permissionMode: 'plan' },
    ] }));
    makeRunner().run('clamp', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    expect(host.created.find((c) => c.options.name === 'wide')?.options.permissionMode).toBe('default');
    expect(host.created.find((c) => c.options.name === 'narrow')?.options.permissionMode).toBe('plan');
  });

  it('item 10: a preflight refusal rejects the run before anything is created or logged; resume runs it too', async () => {
    const calls: string[] = [];
    saveTaskSpec(root, one('pre'));
    const refusing = makeRunner({ preflight: async (_spec, ctx) => { calls.push(ctx.phase); throw new Error('RUNTIME_UNHOSTABLE: node a'); } });
    await expect(refusing.run('pre', { runId: 'r1', orchestratorSessionId: 'orch' })).rejects.toThrow('RUNTIME_UNHOSTABLE');
    expect(host.created).toEqual([]);
    expect(readRunLog(root, 'pre', 'r1')).toEqual([]);

    // Control: an accepting preflight lets the same task run, and a cross-restart resume calls it with phase resume.
    const accepting = makeRunner({ preflight: async (_spec, ctx) => { calls.push(ctx.phase); } });
    await accepting.run('pre', { runId: 'r2', orchestratorSessionId: 'orch' });
    await tick();
    expect(host.created.map((c) => c.options.name)).toEqual(['a']);
    accepting.pause('pre', 'r2');
    const restarted = makeRunner({ preflight: async (_spec, ctx) => { calls.push(ctx.phase); } });
    await restarted.resume('pre', 'r2');
    expect(calls).toEqual(['run', 'run', 'resume']);
  });

  it('item 10: resuming a paused run that is still IN MEMORY runs the preflight too — a refusal keeps it paused, nothing dispatched', async () => {
    const calls: { phase: string; orchestratorSessionId?: string; specId: string }[] = [];
    let refuse = false;
    saveTaskSpec(root, one('memres'));
    const runner = makeRunner({
      preflight: async (spec, ctx) => {
        calls.push({ phase: ctx.phase, orchestratorSessionId: ctx.orchestratorSessionId, specId: spec.id });
        if (refuse) throw new Error('task-cwd-untrusted: node a');
      },
    });
    await runner.run('memres', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { reason: 'interrupted', fromUser: false }); // item 9 (host arm): the run pauses, node a is cancelled
    await tick();
    expect(runner.getRunState('memres', 'r1')!.status).toBe('paused');

    // Probe: trust (or hostability) was lost while paused — the in-memory resume is refused by name.
    refuse = true;
    await expect(runner.resume('memres', 'r1')).rejects.toThrow('task-cwd-untrusted');
    await tick();
    expect(host.created.filter((c) => c.options.name === 'a')).toHaveLength(1);
    let snap = runner.getRunState('memres', 'r1')!;
    expect(snap.status).toBe('paused');
    expect(snap.nodes[0]!.state).toBe('cancelled');
    expect(readRunLog(root, 'memres', 'r1').some((e) => e.kind === 'run-resumed')).toBe(false);

    // Control: an accepting preflight sees phase resume with the run's own spec and orchestrator, and re-dispatches.
    refuse = false;
    await runner.resume('memres', 'r1');
    await tick();
    expect(host.created.filter((c) => c.options.name === 'a')).toHaveLength(2);
    snap = runner.getRunState('memres', 'r1')!;
    expect(snap.status).toBe('running');
    expect(calls).toEqual([
      { phase: 'run', orchestratorSessionId: 'orch', specId: 'memres' },
      { phase: 'resume', orchestratorSessionId: 'orch', specId: 'memres' },
      { phase: 'resume', orchestratorSessionId: 'orch', specId: 'memres' },
    ]);
  });

  /** createSession that names sessions `sess-<node>-<n>` and holds the `holdAt`-th creation until `release()`. */
  const holdNthCreate = (holdAt: number) => {
    let n = 0;
    let release: (() => void) | undefined;
    host.createSession = async (_ws, options) => {
      const id = `sess-${options.name}-${++n}`;
      if (n === holdAt) await new Promise<void>((r) => { release = r; });
      host.created.push({ id, options });
      return { id };
    };
    return () => release!();
  };

  it('item 11: while a RETRY is being created, the previous attempt\'s session cannot complete the node', async () => {
    const release = holdNthCreate(2);
    saveTaskSpec(root, one('win', { retry: { limit: 1 } }));
    const runner = makeRunner();
    runner.run('win', { runId: 'r1' });
    await tick();
    host.completeSession('sess-a-1', { reason: 'error' }); // attempt 2 is scheduled; its createSession is held
    await tick();
    // Probe: the old session wakes inside the window — the node stays running, nothing is recorded.
    host.completeSession('sess-a-1', { finalText: 'STALE' });
    await tick();
    let snap = runner.getRunState('win', 'r1')!;
    expect(snap.nodes[0]!.state).toBe('running');
    expect(snap.nodes[0]!.sessionId).toBeUndefined();
    expect(readNodeOutput(root, 'win', 'r1', 'a')).toBeNull();
    // Control: the session the retry was created in completes it, with ITS text.
    release();
    await tick();
    host.completeSession('sess-a-2', { finalText: 'FRESH' });
    await tick();
    snap = runner.getRunState('win', 'r1')!;
    expect(snap.status).toBe('completed');
    expect(snap.nodes[0]!.sessionId).toBe('sess-a-2');
    expect(readNodeOutput(root, 'win', 'r1', 'a')).toEqual({ text: 'FRESH' });
  });

  it('item 11: while a verdict-FAIL REPAIR is being created, the done session that wakes cannot complete it', async () => {
    const release = holdNthCreate(3); // a, b, then a's repair
    saveTaskSpec(root, specOf({ id: 'rep', title: 'r', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }, { id: 'b', depends_on: ['a'], prompt: '${nodes.a.output}' }] }));
    const runner = makeRunner();
    runner.run('rep', { runId: 'r1', orchestratorSessionId: 'orch', verifyOnComplete: true });
    await tick();
    host.completeSession('sess-a-1', { finalText: 'FIRST' });
    await tick();
    host.completeSession('sess-b-2', { finalText: 'B1' });
    await tick();
    expect(runner.getRunState('rep', 'r1')!.status).toBe('verifying');
    host.completeSession('orch', { finalText: 'VERDICT: FAIL — nodes=a — a is wrong' }); // a's repair is held
    await tick();
    // Probe: a's done session ends a turn a monitor started — inside the window it is not the repair's answer.
    host.completeSession('sess-a-1', { finalText: 'STALE' });
    await tick();
    expect(runner.getRunState('rep', 'r1')!.nodes[0]!.state).toBe('running');
    expect(host.created.filter((c) => c.options.name === 'b')).toHaveLength(1);
    // Control: the repair session's answer is a's output and feeds b's re-run.
    release();
    await tick();
    host.completeSession('sess-a-3', { finalText: 'FRESH' });
    await tick();
    expect(readNodeOutput(root, 'rep', 'r1', 'a')).toEqual({ text: 'FRESH' });
    const bRerun = host.sent.filter((s) => s.sessionId === 'sess-b-4').map((s) => s.message);
    expect(bRerun).toHaveLength(1);
    expect(bRerun[0]!.endsWith('FRESH')).toBe(true);
  });

  it('item 15 (UA12.152): a cross-restart resume re-dispatches under the orchestrator\'s recorded mode, not the restore-demoted live one', async () => {
    // SIT-D F2: the orchestrator ran in bypassPermissions; the app quit mid-node; on restart the session
    // restore demotes the persisted bypass to the new-session start mode (the resume table), so the LIVE
    // ceiling read at the rehydrate dispatch spawned the resumed child in `auto` — its Bash card was never
    // answered and the run wedged. The run-log now records the mode (run-started + every node-spawned) and
    // a rehydrated run merges it with the live reading, taking the BROADER of the two.
    saveTaskSpec(root, one('rec'));
    host.modeById.set('orch', 'bypassPermissions');
    const r1 = makeRunner();
    r1.run('rec', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    // Node 'a' is mid-flight (no completion) — the quit scenario. The mode rides the log at both carriers.
    expect(host.created.find((c) => c.options.name === 'a')?.options.permissionMode).toBe('bypassPermissions');
    expect(readRunLog(root, 'rec', 'r1').find((e) => e.kind === 'run-started')).toMatchObject({ permissionMode: 'bypassPermissions' });
    expect(readRunLog(root, 'rec', 'r1').find((e) => e.kind === 'node-spawned')).toMatchObject({ permissionMode: 'bypassPermissions' });

    // Restart: the resume table demotes the orchestrator to `auto`. Resume re-dispatches 'a' (in flight at
    // shutdown → pending). Probe: the child spawns in the RECORDED mode, so the resumed run is not wedged.
    const host2 = new MockHost();
    host2.modeById.set('orch', 'auto');
    const r2 = new TaskRunner({ host: host2, workspaceId: 'ws', workspaceRoot: root, now: () => '2026-10-02T00:00:00.000Z' });
    r2.resume('rec', 'r1');
    await tick();
    expect(host2.created.find((c) => c.options.name === 'a')?.options.permissionMode).toBe('bypassPermissions');

    // Control 1 (a post-restart RAISE still propagates): the recorded mode is a floor, never a cap on a
    // live raise — otherwise raising the orchestrator after the restart would wedge the resumed run the
    // same way the demotion did.
    saveTaskSpec(root, one('raise'));
    host.modeById.set('orch-raise', 'default');
    const r3 = makeRunner();
    r3.run('raise', { runId: 'r1', orchestratorSessionId: 'orch-raise' });
    await tick();
    expect(host.created.filter((c) => c.options.name === 'a').at(-1)?.options.permissionMode).toBe('default');
    const host4 = new MockHost();
    host4.modeById.set('orch-raise', 'bypassPermissions');
    const r4 = new TaskRunner({ host: host4, workspaceId: 'ws', workspaceRoot: root, now: () => '2026-10-02T00:00:00.000Z' });
    r4.resume('raise', 'r1');
    await tick();
    expect(host4.created.find((c) => c.options.name === 'a')?.options.permissionMode).toBe('bypassPermissions');

    // Control 2 (boundary — a log with NO recorded mode, from before UA12.152): the rehydrate falls back to
    // the live reading exactly as before, and the clamp still caps a node that asks above the ceiling.
    const legacySpec = one('legacy', { permissionMode: 'bypassPermissions' });
    saveTaskSpec(root, legacySpec);
    writeRunSpecSnapshot(root, 'legacy', 'r1', legacySpec);
    const t = '2026-10-01T00:00:00.000Z';
    appendRunLog(root, 'legacy', 'r1', { t, kind: 'run-started', taskId: 'legacy', runId: 'r1', orchestratorSessionId: 'orch-legacy' });
    appendRunLog(root, 'legacy', 'r1', { t, kind: 'node-scheduled', nodeId: 'a' });
    appendRunLog(root, 'legacy', 'r1', { t, kind: 'node-spawned', nodeId: 'a', sessionId: 'sess-a-old' });
    const host6 = new MockHost();
    host6.modeById.set('orch-legacy', 'default');
    const r6 = new TaskRunner({ host: host6, workspaceId: 'ws', workspaceRoot: root, now: () => '2026-10-02T00:00:00.000Z' });
    r6.resume('legacy', 'r1');
    await tick();
    expect(host6.created.find((c) => c.options.name === 'a')?.options.permissionMode).toBe('default');
  });

  it('item 15 residue (UA12.152, corrected by V-fw3): a lower after the last dispatch is honoured by NO rehydrate of that run', async () => {
    // The landed residue sentence said the run's own next `node-spawned` records the lowered mode, so the NEXT
    // rehydrate honours it. Measured: a re-dispatch records its own MERGED mode (the broadest) as its carrier,
    // so the record cannot narrow while it is the broader side of the merge — a lower is picked up only by a
    // dispatch a run that was never rehydrated makes under it, or by a fresh `run-started`. Both halves pinned.
    // UA12.171: this pins a lower the host never RECORDED (the mock host's mode moves with no `mode-changed`); a lower
    // through a host door is recorded and honoured — the UA12.171 describe at the end of this file.
    saveTaskSpec(root, one('res'));
    host.modeById.set('orch', 'bypassPermissions');
    makeRunner().run('res', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    // The orchestrator is LOWERED to `default` after the last dispatch (persisted), then the app restarts and
    // the lowered mode restores as `default` (the resume table demotes `bypassPermissions` only).
    const host2 = new MockHost();
    host2.modeById.set('orch', 'default');
    const r2 = new TaskRunner({ host: host2, workspaceId: 'ws', workspaceRoot: root, now: () => '2026-10-02T00:00:00.000Z' });
    r2.resume('res', 'r1');
    await tick();
    expect(host2.created.find((c) => c.options.name === 'a')?.options.permissionMode).toBe('bypassPermissions'); // the residue: the lower does not cap
    expect(readRunLog(root, 'res', 'r1').filter((e) => e.kind === 'node-spawned').at(-1)).toMatchObject({ permissionMode: 'bypassPermissions' }); // NOT the lowered mode
    // The NEXT rehydrate reads that same broad carrier back — no rehydrate of this run ever honours the lower.
    const host3 = new MockHost();
    host3.modeById.set('orch', 'default');
    const r3 = new TaskRunner({ host: host3, workspaceId: 'ws', workspaceRoot: root, now: () => '2026-10-02T00:00:00.000Z' });
    r3.resume('res', 'r1');
    await tick();
    expect(host3.created.find((c) => c.options.name === 'a')?.options.permissionMode).toBe('bypassPermissions');

    // The corrected clause's true half: a LIVE run (never rehydrated) records the lowered mode at its next
    // dispatch, and a rehydrate AFTER that honours it.
    saveTaskSpec(root, specOf({
      id: 'liv', title: 'liv', goal: 'g',
      nodes: [
        { id: 'a', prompt: 'a' },
        { id: 'b', depends_on: ['a'], prompt: 'b' },
      ],
    }));
    const liveHost = new MockHost();
    liveHost.modeById.set('orch', 'bypassPermissions');
    const r4 = new TaskRunner({ host: liveHost, workspaceId: 'ws', workspaceRoot: root, now: () => '2026-10-02T00:00:00.000Z' });
    r4.run('liv', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    liveHost.modeById.set('orch', 'default'); // the lower, after 'a' dispatched
    liveHost.complete('a', { finalText: 'A' });
    await tick();
    expect(liveHost.created.find((c) => c.options.name === 'b')?.options.permissionMode).toBe('default');
    // 'b' is mid-flight at the quit; the restart rehydrates and re-dispatches under the RECORDED lowered mode.
    const host5 = new MockHost();
    host5.modeById.set('orch', 'default');
    const r5 = new TaskRunner({ host: host5, workspaceId: 'ws', workspaceRoot: root, now: () => '2026-10-02T00:00:00.000Z' });
    r5.resume('liv', 'r1');
    await tick();
    expect(host5.created.find((c) => c.options.name === 'b')?.options.permissionMode).toBe('default');
  });
});

describe('UA12.90 — run the confirmed bytes (P-UAal-2)', () => {
  let root: string;
  let host: MockHost;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conductor-test-'));
    host = new MockHost();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The digest spelling the run confirmation checks (`rpc/tasks.ts` `taskYamlDigest`). */
  const digestOf = (slug: string) =>
    `sha256:${createHash('sha256').update(readFileSync(taskYamlPath(root, slug))).digest('hex')}`;

  function seed(id: string) {
    saveTaskSpec(root, specOf({
      id, title: id, goal: 'g',
      nodes: [
        { id: 'a', prompt: 'do a' },
        { id: 'b', depends_on: ['a'], prompt: 'do b' },
      ],
    }));
  }

  function makeRunner() {
    return new TaskRunner({ host, workspaceId: 'ws', workspaceRoot: root, now: () => '2026-06-07T00:00:00.000Z' });
  }

  it('NEGATIVE (the row\'s control): an edit landing between the confirmation check and the run\'s read is refused, nothing dispatches', async () => {
    seed('demo');
    const confirmed = digestOf('demo');
    // The edit lands AFTER the check: the confirmed digest now names bytes that are no longer on disk.
    const path = taskYamlPath(root, 'demo');
    writeFileSync(path, readFileSync(path, 'utf-8').replace('do b', 'do something else'));
    expect(digestOf('demo')).not.toBe(confirmed);
    const runner = makeRunner();
    await expect(runner.run('demo', { runId: 'r1', orchestratorSessionId: 'orch', confirmedDigest: confirmed }))
      .rejects.toThrow('run-confirmation-required');
    await tick();
    expect(host.dispatchedNames()).toEqual([]);
  });

  it('POSITIVE: a run whose read matches the confirmed digest runs', async () => {
    seed('demo');
    const runner = makeRunner();
    const snap = await runner.run('demo', { runId: 'r1', orchestratorSessionId: 'orch', confirmedDigest: digestOf('demo') });
    expect(snap.status).toBe('running');
    await tick();
    expect(host.dispatchedNames()).toEqual(['a']);
  });

  it('BOUNDARY: no confirmedDigest runs as before; a missing task.yaml still reads not-found with one set', async () => {
    seed('demo');
    const snap = await makeRunner().run('demo', { runId: 'r1', orchestratorSessionId: 'orch' });
    expect(snap.status).toBe('running');
    await expect(makeRunner().run('absent', { confirmedDigest: digestOf('demo') }))
      .rejects.toThrow('not found or has no valid task.yaml');
  });
});

describe('UA12.171 — a deliberate orchestrator mode change is a run-log carrier (header item 15)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conductor-test-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const chain = (id: string) =>
    specOf({ id, title: id, goal: 'g', nodes: [{ id: 'a', prompt: 'a' }, { id: 'b', depends_on: ['a'], prompt: 'b' }] });
  const T = '2026-10-08T00:00:00.000Z';
  const runnerOn = (h: MockHost) => new TaskRunner({ host: h, workspaceId: 'ws', workspaceRoot: root, now: () => T });

  it('a resumed (hydrated) run caps its next dispatch at a deliberate lower recorded after the resume', async () => {
    saveTaskSpec(root, chain('hyd'));
    const host1 = new MockHost();
    host1.modeById.set('orch', 'bypassPermissions');
    runnerOn(host1).run('hyd', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    // Restart: the resume table demotes the orchestrator to `auto`; Resume re-dispatches 'a' under the run's
    // recorded bypass (UA12.152 — unchanged).
    const host2 = new MockHost();
    host2.modeById.set('orch', 'auto');
    const r2 = runnerOn(host2);
    await r2.resume('hyd', 'r1');
    await tick();
    expect(host2.created.find((c) => c.options.name === 'a')?.options.permissionMode).toBe('bypassPermissions');
    // The user then LOWERS the orchestrator to `default`: SessionManager records the deliberate change
    // (`recordOrchestratorModeChange`, the shape below) and the live mode follows.
    appendRunLog(root, 'hyd', 'r1', { t: T, kind: 'mode-changed', permissionMode: 'default' });
    host2.modeById.set('orch', 'default');
    host2.complete('a', { finalText: 'A' });
    await tick();
    // Probe: the next dispatch of the SAME in-memory run is capped at the lower, not at the hydrated grant.
    expect(host2.created.find((c) => c.options.name === 'b')?.options.permissionMode).toBe('default');
  });

  it('a later rehydrate honours a recorded deliberate lower (85d910220\'s residue closed for recorded lowers)', async () => {
    saveTaskSpec(root, chain('next'));
    const host1 = new MockHost();
    host1.modeById.set('orch', 'bypassPermissions');
    runnerOn(host1).run('next', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    // Lowered deliberately after the last dispatch, recorded; then the app restarts.
    appendRunLog(root, 'next', 'r1', { t: T, kind: 'mode-changed', permissionMode: 'default' });
    const host2 = new MockHost();
    host2.modeById.set('orch', 'default');
    await runnerOn(host2).resume('next', 'r1');
    await tick();
    expect(host2.created.find((c) => c.options.name === 'a')?.options.permissionMode).toBe('default');
  });

  it('control: with no recorded change the restart-demoted resume keeps the grant (UA12.152 / UA12.165 arm)', async () => {
    saveTaskSpec(root, chain('keep'));
    const host1 = new MockHost();
    host1.modeById.set('orch', 'bypassPermissions');
    runnerOn(host1).run('keep', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    const host2 = new MockHost();
    host2.modeById.set('orch', 'auto');
    const r2 = runnerOn(host2);
    await r2.resume('keep', 'r1');
    await tick();
    host2.complete('a', { finalText: 'A' });
    await tick();
    expect(host2.created.find((c) => c.options.name === 'a')?.options.permissionMode).toBe('bypassPermissions');
    expect(host2.created.find((c) => c.options.name === 'b')?.options.permissionMode).toBe('bypassPermissions');
  });

  it('the run-log readers: mode-changed never moves the run status and is the newest recorded carrier', () => {
    const log: RunLogEntry[] = [
      { t: T, kind: 'run-started', taskId: 'x', runId: 'r1', orchestratorSessionId: 'orch', permissionMode: 'bypassPermissions' },
      { t: T, kind: 'node-spawned', nodeId: 'a', sessionId: 's', permissionMode: 'bypassPermissions' },
      { t: T, kind: 'mode-changed', permissionMode: 'default' },
    ];
    expect(runStatusFromLog(log)).toBe('running');
    expect(runStatusFromLog([...log.slice(0, 2), { t: T, kind: 'run-paused' }, log[2]!])).toBe('paused');
    expect(runStatusFromLog([...log, { t: T, kind: 'run-completed' }])).toBe('completed');
    for (const e of log) appendRunLog(root, 'x', 'r1', e);
    expect(recordedLiveRunPermissionCeiling(root, 'x', 'r1')).toBe('default');
    // Boundary: a terminal log answers nothing, whatever it recorded.
    appendRunLog(root, 'x', 'r1', { t: T, kind: 'run-stopped' });
    expect(recordedLiveRunPermissionCeiling(root, 'x', 'r1')).toBeUndefined();
  });

  it('the writer records only in the live runs of THAT orchestrator (recordOrchestratorModeChange)', () => {
    const started = (runId: string, orchestratorSessionId: string): RunLogEntry =>
      ({ t: T, kind: 'run-started', taskId: 'w', runId, orchestratorSessionId, permissionMode: 'bypassPermissions' });
    appendRunLog(root, 'w', 'live', started('live', 'orch'));
    appendRunLog(root, 'w', 'paused', started('paused', 'orch'));
    appendRunLog(root, 'w', 'paused', { t: T, kind: 'run-paused' });
    appendRunLog(root, 'w', 'done', started('done', 'orch'));
    appendRunLog(root, 'w', 'done', { t: T, kind: 'run-completed' });
    appendRunLog(root, 'w', 'other', started('other', 'orch-2'));
    expect(recordOrchestratorModeChange(root, 'w', 'orch', 'default', T).sort()).toEqual(['live', 'paused']);
    expect(readRunLog(root, 'w', 'live').at(-1)).toEqual({ t: T, kind: 'mode-changed', permissionMode: 'default' });
    expect(readRunLog(root, 'w', 'paused').at(-1)).toEqual({ t: T, kind: 'mode-changed', permissionMode: 'default' });
    // Negative arms: an ended run and another orchestrator's run are untouched; no slug writes nothing.
    expect(readRunLog(root, 'w', 'done').some((e) => e.kind === 'mode-changed')).toBe(false);
    expect(readRunLog(root, 'w', 'other').some((e) => e.kind === 'mode-changed')).toBe(false);
    expect(recordOrchestratorModeChange(root, undefined, 'orch', 'default', T)).toEqual([]);
  });
});

describe('UA12.75 — a rehydrate withdraws the pending card of an abandoned child (header item 13)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conductor-test-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A host that records card withdrawals; `prefix` keeps the restarted host's new children apart from abandoned ones. */
  class WithdrawingHost extends MockHost {
    readonly withdrawn: string[] = [];
    constructor(private readonly prefix = 'sess') {
      super();
    }
    override async createSession(workspaceId: string, options: CreateSessionOptions): Promise<{ id: string }> {
      const id = `${this.prefix}-${options.name}`;
      this.created.push({ id, options });
      void workspaceId;
      return { id };
    }
    async withdrawPendingApproval(sessionId: string): Promise<void> {
      this.withdrawn.push(sessionId);
    }
  }
  const chain = (id: string) =>
    specOf({ id, title: id, goal: 'g', nodes: [{ id: 'a', prompt: 'a' }, { id: 'b', depends_on: ['a'], prompt: 'b' }] });
  const runnerOn = (h: MockHost) => new TaskRunner({ host: h, workspaceId: 'ws', workspaceRoot: root });

  it('CONTROL: the child in flight at the restart has its card withdrawn on Resume, before the node re-dispatches', async () => {
    saveTaskSpec(root, chain('ab'));
    const host1 = new WithdrawingHost();
    runnerOn(host1).run('ab', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    expect(host1.created.map((c) => c.id)).toEqual(['sess-a']);
    // Restart: a brand-new runner + host; Resume rehydrates from the run log.
    const host2 = new WithdrawingHost('new');
    await runnerOn(host2).resume('ab', 'r1');
    await tick();
    expect(host2.withdrawn).toEqual(['sess-a']);
    expect(host2.columns).toContainEqual({ sessionId: 'sess-a', column: 'todo' });
    expect(host2.created.map((c) => c.id)).toEqual(['new-a']); // the node re-runs in a NEW child
  });

  it('NEGATIVE: a node that finished before the restart is not withdrawn — only the one in flight', async () => {
    saveTaskSpec(root, chain('done'));
    const host1 = new WithdrawingHost();
    runnerOn(host1).run('done', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host1.complete('a', { finalText: 'A' });
    await tick();
    expect(host1.created.map((c) => c.id)).toEqual(['sess-a', 'sess-b']);
    const host2 = new WithdrawingHost('new');
    await runnerOn(host2).resume('done', 'r1');
    await tick();
    expect(host2.withdrawn).toEqual(['sess-b']);
  });

  it('NEGATIVE: an in-memory pause and resume (no restart) abandons nothing and withdraws nothing', async () => {
    saveTaskSpec(root, chain('live'));
    const host = new WithdrawingHost();
    const runner = runnerOn(host);
    await runner.run('live', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    runner.pause('live', 'r1');
    await runner.resume('live', 'r1');
    await tick();
    expect(host.withdrawn).toEqual([]);
  });
});

describe('UA12.78 — a dispatch with no orchestrator never sends a mode above default', () => {
  let root: string;
  let host: MockHost;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conductor-test-'));
    host = new MockHost();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const modeOf = (name: string) => host.created.find((c) => c.options.name === name)?.options.permissionMode;

  it('CONTROL: a node asking for bypassPermissions (and a task default of acceptEdits) is clamped to default', async () => {
    saveTaskSpec(root, specOf({
      id: 'noorch', title: 'n', goal: 'g', defaults: { permissionMode: 'acceptEdits' },
      nodes: [{ id: 'wide', prompt: 'w', permissionMode: 'bypassPermissions' }, { id: 'dflt', prompt: 'd' }],
    }));
    await new TaskRunner({ host, workspaceId: 'ws', workspaceRoot: root }).run('noorch', { runId: 'r1' });
    await tick();
    expect(modeOf('wide')).toBe('default');
    expect(modeOf('dflt')).toBe('default');
    expect(readRunLog(root, 'noorch', 'r1').filter((e) => e.kind === 'node-spawned').map((e) => (e as { permissionMode?: string }).permissionMode))
      .toEqual(['default', 'default']);
  });

  it('NEGATIVE: a narrower request is kept, and an unset mode stays unset (the workspace default, as for any new session)', async () => {
    saveTaskSpec(root, specOf({
      id: 'narrow', title: 'n', goal: 'g',
      nodes: [{ id: 'plan', prompt: 'p', permissionMode: 'plan' }, { id: 'unset', prompt: 'u' }],
    }));
    await new TaskRunner({ host, workspaceId: 'ws', workspaceRoot: root }).run('narrow', { runId: 'r1' });
    await tick();
    expect(modeOf('plan')).toBe('plan');
    expect(modeOf('unset')).toBeUndefined();
  });

  it('BOUNDARY: with an orchestrator the ceiling is still the orchestrator\'s (a bypass orchestrator grants bypass)', async () => {
    saveTaskSpec(root, specOf({ id: 'withorch', title: 'n', goal: 'g', nodes: [{ id: 'wide', prompt: 'w', permissionMode: 'bypassPermissions' }] }));
    host.modeById.set('orch', 'bypassPermissions');
    await new TaskRunner({ host, workspaceId: 'ws', workspaceRoot: root }).run('withorch', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    expect(modeOf('wide')).toBe('bypassPermissions');
  });

});

describe('UA12.173 — the run log carries the dispatch CEILING, not the child\'s clamped mode (header item 15)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conductor-test-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const T = '2026-10-09T00:00:00.000Z';
  const runnerOn = (h: MockHost) => new TaskRunner({ host: h, workspaceId: 'ws', workspaceRoot: root, now: () => T });
  const chain = (id: string) => specOf({
    id, title: id, goal: 'g',
    nodes: [
      { id: 'a', prompt: 'a' },
      { id: 'b', depends_on: ['a'], prompt: 'b', permissionMode: 'plan' },
      { id: 'c', depends_on: ['b'], prompt: 'c' },
    ],
  });

  it('CONTROL: bypass orchestrator, node b (override plan) dispatched last, restart with live auto -> node c re-dispatches bypassPermissions', async () => {
    saveTaskSpec(root, chain('ceil'));
    const host1 = new MockHost();
    host1.modeById.set('orch', 'bypassPermissions');
    await runnerOn(host1).run('ceil', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host1.complete('a', { finalText: 'A' });
    await tick();
    expect(host1.created.find((c) => c.options.name === 'b')?.options.permissionMode).toBe('plan');
    // The app quits while b runs; the resume table demotes the orchestrator to `auto`.
    const host2 = new MockHost();
    host2.modeById.set('orch', 'auto');
    await runnerOn(host2).resume('ceil', 'r1');
    await tick();
    expect(host2.created.find((c) => c.options.name === 'b')?.options.permissionMode).toBe('plan');
    host2.complete('b', { finalText: 'B' });
    await tick();
    expect(host2.created.find((c) => c.options.name === 'c')?.options.permissionMode).toBe('bypassPermissions');
  });

  it('the entry keeps the child\'s effective mode in permissionMode and the ceiling in ceilingPermissionMode', async () => {
    saveTaskSpec(root, chain('both'));
    const host = new MockHost();
    host.modeById.set('orch', 'bypassPermissions');
    await runnerOn(host).run('both', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'A' });
    await tick();
    const spawnedB = readRunLog(root, 'both', 'r1').filter((e) => e.kind === 'node-spawned').at(-1);
    expect(spawnedB).toMatchObject({ nodeId: 'b', permissionMode: 'plan', ceilingPermissionMode: 'bypassPermissions' });
    // The live reader (SessionManager's child clamp) reads the ceiling, so a running child keeps the run's grant.
    expect(recordedLiveRunPermissionCeiling(root, 'both', 'r1')).toBe('bypassPermissions');
  });

  it('NEGATIVE: a node-spawned without the ceiling field is no carrier — the child\'s own mode never narrows the run', () => {
    appendRunLog(root, 'old', 'r1', { t: T, kind: 'run-started', taskId: 'old', runId: 'r1', orchestratorSessionId: 'orch', permissionMode: 'bypassPermissions' });
    appendRunLog(root, 'old', 'r1', { t: T, kind: 'node-spawned', nodeId: 'b', sessionId: 's-b', permissionMode: 'plan' });
    expect(recordedLiveRunPermissionCeiling(root, 'old', 'r1')).toBe('bypassPermissions');
    // Boundary: a deliberate lower (UA12.171) is still the newest carrier and still caps.
    appendRunLog(root, 'old', 'r1', { t: T, kind: 'mode-changed', permissionMode: 'default' });
    expect(recordedLiveRunPermissionCeiling(root, 'old', 'r1')).toBe('default');
  });


});

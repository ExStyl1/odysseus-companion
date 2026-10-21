import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts';
import { LLM_QUERY_TIMEOUT_MS } from '../llm-tool.ts';
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
} from '../pi-harness/harness-tool-descriptor.ts';
import {
  parseAndFreezePiPermissionReceipt,
  type PiPermissionAuthorizationRequest,
} from '../pi-harness/permission-receipt.ts';

interface TestStartupAttempt {
  cancelled: boolean;
  ready: Promise<void>;
  startup: Promise<void>;
}

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-readiness',
      name: 'Readiness',
      rootPath: '/tmp/nessy-pi-readiness',
      workspaceRootPath: '/tmp/nessy-pi-readiness',
      sessionRootPath: '/tmp/nessy-pi-readiness-sessions',
    } as never,
    session: { id: 'session-readiness', createdAt: 0, lastUsedAt: 0 } as never,
    isHeadless: true,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

function installStaticManifest(agent: PiAgent, permissionName = 'Bash') {
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'generation-readiness',
    sessionKey: { workspaceId: 'ws-readiness', sessionId: 'session-readiness' },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: PI_TOOL_BINDINGS.flatMap(binding => {
      const modelContractHash = PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName];
      return modelContractHash ? [{
        descriptor: getHarnessToolDescriptor(binding.descriptorId),
        binding,
        source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
        modelContractHash,
      }] : [];
    }),
  };
  const manifest = finalizePiExecutionManifest(seed, []);
  const tool = manifest.tools.find(candidate => candidate.binding.permissionName === permissionName);
  if (!tool) throw new Error(`missing ${permissionName} test tool`);
  const runtime = {
    view: {
      generation: manifest.snapshotGeneration,
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return '/tmp/nessy-pi-readiness'; },
      async readText() { return ''; },
      resolveCredential() { throw new Error('not used by readiness contract'); },
    },
    piExecutionManifestSeed: seed,
  } as CapabilityTurnRuntime;
  agent.setCapabilityTurnRuntime(runtime);
  (agent as never as { activeExecutionManifest: typeof manifest }).activeExecutionManifest = manifest;
  (agent as never as { adapter: { setExecutionManifest(value: typeof manifest): void } })
    .adapter.setExecutionManifest(manifest);
  return { manifest, tool };
}

function allowReceipt(request: PiPermissionAuthorizationRequest) {
  return parseAndFreezePiPermissionReceipt({
    version: 1,
    sessionKey: request.subject.sessionKey,
    binding: {
      provider: 'pi',
      surfaceVersion: request.subject.surfaceVersion,
      piName: request.subject.piName,
      bindingName: request.subject.bindingName,
      semanticId: request.subject.semanticId,
      descriptorId: request.subject.descriptorId,
    },
    manifest: {
      generation: request.subject.manifestGeneration,
      hash: request.subject.manifestHash,
      provenance: request.subject.manifestProvenance,
      responseEpoch: request.subject.responseEpoch,
    },
    decisionId: 'readiness-allow',
    outcome: 'allow',
    canonicalInput: request.canonicalInput,
    contextProfile: request.subject.contextProfile,
    sandboxRequirement: request.subject.sandboxRequirement,
  }, request.subject);
}

function installAttempt(agent: PiAgent) {
  const calls = { kill: 0, childRemove: 0, readlineRemove: 0, close: 0 };
  const runtime = agent as never as {
    beginSubprocessAttempt(): TestStartupAttempt;
    subprocess: unknown;
    readline: unknown;
  };
  const attempt = runtime.beginSubprocessAttempt();
  const child = {
    stdin: { writable: true, write: () => true },
    kill: () => { calls.kill += 1; },
    removeAllListeners: () => { calls.childRemove += 1; },
  };
  const readline = {
    close: () => { calls.close += 1; },
    removeAllListeners: () => { calls.readlineRemove += 1; },
  };
  runtime.subprocess = child;
  runtime.readline = readline;
  return { calls, ready: attempt.ready, attempt, child, readline };
}

describe('PiAgent runtime readiness', () => {
  it('shares one concurrent startup, rejects both callers, and permits one clean retry', async () => {
    const agent = new PiAgent(createConfig());
    const runtime = agent as never as {
      ensureSubprocess(): Promise<void>;
      spawnSubprocess(attempt: TestStartupAttempt): Promise<void>;
      handleLine(line: string): void;
      subprocess: unknown;
      readline: unknown;
      subprocessAttempt: TestStartupAttempt | null;
      pendingMiniCompletions: Map<string, { reject(error: Error): void }>;
    };
    let starts = 0;
    runtime.spawnSubprocess = async () => {
      starts += 1;
      throw new Error('credential lookup failed');
    };

    const failed = await Promise.allSettled([
      runtime.ensureSubprocess(),
      runtime.ensureSubprocess(),
    ]);
    expect(starts).toBe(1);
    expect(failed.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(failed.map(result => result.status === 'rejected' ? result.reason.message : ''))
      .toEqual(['credential lookup failed', 'credential lookup failed']);
    expect(runtime.subprocess).toBeNull();
    expect(runtime.readline).toBeNull();
    expect(runtime.subprocessAttempt).toBeNull();

    runtime.spawnSubprocess = async attempt => {
      starts += 1;
      await attempt.ready;
    };
    const retryA = runtime.ensureSubprocess();
    const retryB = runtime.ensureSubprocess();
    expect(starts).toBe(2);
    runtime.handleLine(JSON.stringify({
      type: 'ready',
      sessionId: 'pi-session-retry',
      runtimeVersion: '0.80.2',
    }));
    await Promise.all([retryA, retryB]);
    // F1.710: `ready` names no callback port any more (type, sessionId and
    // runtimeVersion only). The session id is what the CURRENT attempt's ready
    // records, so it is the witness that this retry's ready was the one taken.
    expect(agent.getSessionId()).toBe('pi-session-retry');
    expect(runtime.subprocessAttempt).not.toBeNull();

    agent.destroy();
    expect(runtime.subprocessAttempt).toBeNull();
  });

  it('cancels a deferred pre-child attempt without letting late work affect its retry', async () => {
    const agent = new PiAgent(createConfig());
    const runtime = agent as never as {
      ensureSubprocess(): Promise<void>;
      spawnSubprocess(attempt: TestStartupAttempt): Promise<void>;
      assertCurrentSubprocessAttempt(attempt: TestStartupAttempt): void;
      handleLine(line: string, attempt?: TestStartupAttempt, child?: unknown): void;
      handleSubprocessError(error: Error, attempt: TestStartupAttempt, child: unknown, readline: unknown): void;
      handleSubprocessExit(code: number, signal: null, attempt: TestStartupAttempt, child: unknown, readline: unknown): void;
      subprocess: unknown;
      readline: unknown;
      subprocessAttempt: TestStartupAttempt | null;
      subprocessTermination: Promise<void> | null;
      pendingMiniCompletions: Map<string, { reject(error: Error): void }>;
    };
    let releaseOld!: () => void;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    const attempts: TestStartupAttempt[] = [];
    let oldPublished = 0;
    const oldChild = { kill: () => { throw new Error('stale child touched'); } };
    const oldReadline = { close: () => {}, removeAllListeners: () => {} };
    const newCalls = { kills: [] as string[], close: 0 };
    const newChild = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: string | null;
      stdin: { writable: boolean };
      kill(signal: string): boolean;
    };
    newChild.exitCode = null;
    newChild.signalCode = null;
    newChild.stdin = { writable: true };
    newChild.kill = signal => {
      newCalls.kills.push(signal);
      newChild.emit('exit', 0, signal);
      return true;
    };
    const newReadline = {
      close: () => { newCalls.close += 1; },
      removeAllListeners: () => {},
    };

    runtime.spawnSubprocess = async attempt => {
      attempts.push(attempt);
      if (attempts.length === 1) {
        await oldGate;
        runtime.assertCurrentSubprocessAttempt(attempt);
        oldPublished += 1;
        return;
      }
      runtime.subprocess = newChild;
      runtime.readline = newReadline;
      await attempt.ready;
    };

    const staleStartup = runtime.ensureSubprocess();
    await Promise.resolve();
    await agent.reconnect();
    await expect(staleStartup).rejects.toThrow(/cancelled/);

    const retry = runtime.ensureSubprocess();
    expect(attempts).toHaveLength(2);
    const [oldAttempt, newAttempt] = attempts;
    if (!oldAttempt || !newAttempt) {
      throw new Error('expected two startup attempts');
    }
    runtime.handleLine(JSON.stringify({
      type: 'ready',
      sessionId: 'pi-session-new',
      runtimeVersion: '0.80.2',
    }), newAttempt, newChild);
    await retry;

    releaseOld();
    await Promise.resolve();
    await Promise.resolve();
    runtime.handleSubprocessError(new Error('late old error'), oldAttempt, oldChild, oldReadline);
    runtime.handleSubprocessExit(1, null, oldAttempt, oldChild, oldReadline);

    expect(oldPublished).toBe(0);
    expect(newCalls.kills).toEqual([]);
    expect(agent.getSessionId()).toBe('pi-session-new');
    expect(runtime.subprocess).toBe(newChild);
    expect(runtime.subprocessAttempt).toBe(newAttempt);

    let lateOldRejected = 0;
    runtime.pendingMiniCompletions.set('new-generation', {
      reject: () => { lateOldRejected += 1; },
    });
    runtime.handleSubprocessExit(1, null, oldAttempt, oldChild, oldReadline);
    expect(lateOldRejected).toBe(0);
    expect(runtime.pendingMiniCompletions.has('new-generation')).toBe(true);

    agent.destroy();
    expect(lateOldRejected).toBe(1);
    expect(newCalls).toEqual({ kills: ['SIGTERM'], close: 1 });
    expect(runtime.subprocess).toBeNull();
    expect(runtime.readline).toBeNull();
    expect(runtime.subprocessAttempt).toBeNull();
    await runtime.subprocessTermination;
    expect(runtime.subprocessTermination).toBeNull();
  });

  it('rejects a pre-ready compatibility error, cleans state, and permits a clean retry', async () => {
    const agent = new PiAgent(createConfig());
    const first = installAttempt(agent);

    (agent as never as { handleLine(line: string): void }).handleLine(JSON.stringify({
      type: 'startup_error',
      code: 'pi_runtime_incompatible',
      message: 'Unsupported Pi runtime 0.80.1; expected 0.80.2',
    }));

    await expect(first.ready).rejects.toThrow(/expected 0\.80\.2/);
    expect(first.calls.kill).toBe(1);
    expect(first.calls.childRemove).toBe(0);
    expect(first.calls.readlineRemove).toBe(1);
    expect(first.calls.close).toBe(1);
    expect((agent as never as { subprocess: unknown }).subprocess).toBeNull();
    expect((agent as never as { readline: unknown }).readline).toBeNull();
    expect((agent as never as { subprocessAttempt: unknown }).subprocessAttempt).toBeNull();

    const retry = installAttempt(agent);
    (agent as never as { handleLine(line: string): void }).handleLine(JSON.stringify({
      type: 'ready',
      sessionId: 'pi-session-retry',
      runtimeVersion: '0.80.2',
    }));
    await retry.ready;
    expect(agent.getSessionId()).toBe('pi-session-retry');

    agent.destroy();
  });

  it('rejects a pre-ready child error while preserving child listeners and closing readline', async () => {
    const agent = new PiAgent(createConfig());
    const attempt = installAttempt(agent);

    (agent as never as { handleSubprocessError(error: Error): void })
      .handleSubprocessError(new Error('spawn failed'));

    await expect(attempt.ready).rejects.toThrow('spawn failed');
    expect(attempt.calls).toEqual({
      kill: 1,
      childRemove: 0,
      readlineRemove: 1,
      close: 1,
    });
    expect((agent as never as { subprocess: unknown }).subprocess).toBeNull();
    expect((agent as never as { readline: unknown }).readline).toBeNull();
    agent.destroy();
  });

  it('does not double-clean or double-reject when startup_error is followed by exit', async () => {
    const agent = new PiAgent(createConfig());
    const attempt = installAttempt(agent);
    let rejectionCount = 0;
    const observed = attempt.ready.catch(error => {
      rejectionCount += 1;
      throw error;
    });

    (agent as never as { handleLine(line: string): void }).handleLine(JSON.stringify({
      type: 'startup_error',
      code: 'pi_runtime_incompatible',
      message: 'Unsupported Pi runtime 0.80.1; expected 0.80.2',
    }));
    await expect(observed).rejects.toThrow(/expected 0\.80\.2/);

    (agent as never as { handleSubprocessExit(code: number, signal: null): void })
      .handleSubprocessExit(78, null);
    await Promise.resolve();

    expect(rejectionCount).toBe(1);
    expect(attempt.calls).toEqual({
      kill: 1,
      childRemove: 0,
      readlineRemove: 1,
      close: 1,
    });
    agent.destroy();
  });

  it('rejects and clears a subprocess exit before ready', async () => {
    const agent = new PiAgent(createConfig());
    const attempt = installAttempt(agent);

    (agent as never as { handleSubprocessExit(code: number, signal: null): void })
      .handleSubprocessExit(78, null);

    await expect(attempt.ready).rejects.toThrow(/exited.*78/i);
    expect((agent as never as { subprocess: unknown }).subprocess).toBeNull();
    expect((agent as never as { subprocessAttempt: unknown }).subprocessAttempt).toBeNull();
    agent.destroy();
  });

  it('rejects shared startup after ready when initial auto-compaction reports an invalid session shape', async () => {
    const agent = new PiAgent(createConfig());
    const runtime = agent as never as {
      ensureSubprocess(): Promise<void>;
      spawnSubprocess(attempt: TestStartupAttempt): Promise<void>;
      requestSetAutoCompaction(
        policy: { enabled: boolean; thresholdPercent?: number; contextWindow?: number },
        protocolAlreadyReady: boolean,
      ): Promise<boolean>;
      handleLine(line: string, attempt?: TestStartupAttempt, child?: unknown): void;
      pendingAutoCompactionToggles: Map<string, unknown>;
      subprocess: unknown;
      readline: unknown;
      subprocessAttempt: TestStartupAttempt | null;
    };
    let starts = 0;
    const firstChild = {
      stdin: { writable: true, write: () => true },
      kill: () => {},
      removeAllListeners: () => {},
    };
    const firstReadline = { close: () => {}, removeAllListeners: () => {} };
    runtime.spawnSubprocess = async attempt => {
      starts += 1;
      runtime.subprocess = firstChild;
      runtime.readline = firstReadline;
      runtime.handleLine(JSON.stringify({
        type: 'ready',
        sessionId: 'pi-session-first',
        runtimeVersion: '0.80.2',
      }), attempt, firstChild);
      await runtime.requestSetAutoCompaction({ enabled: true }, true);
    };

    const startupA = runtime.ensureSubprocess();
    const startupB = runtime.ensureSubprocess();
    await Promise.resolve();
    const [requestId] = runtime.pendingAutoCompactionToggles.keys();
    if (!requestId || !runtime.subprocessAttempt) {
      throw new Error('expected initial auto-compaction request');
    }
    runtime.handleLine(JSON.stringify({
      type: 'set_auto_compaction_result',
      id: requestId,
      success: false,
      errorMessage: 'Unsupported Pi session shape: missing setAutoCompactionEnabled',
    }), runtime.subprocessAttempt, firstChild);

    const failed = await Promise.allSettled([startupA, startupB]);
    expect(starts).toBe(1);
    expect(failed.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(failed.map(result => result.status === 'rejected' ? result.reason.message : ''))
      .toEqual([
        'Unsupported Pi session shape: missing setAutoCompactionEnabled',
        'Unsupported Pi session shape: missing setAutoCompactionEnabled',
      ]);
    expect(runtime.subprocess).toBeNull();
    expect(runtime.readline).toBeNull();
    expect(runtime.subprocessAttempt).toBeNull();

    runtime.spawnSubprocess = async attempt => {
      starts += 1;
      runtime.handleLine(JSON.stringify({
        type: 'ready',
        sessionId: 'pi-session-retry',
        runtimeVersion: '0.80.2',
      }), attempt);
    };
    await runtime.ensureSubprocess();
    expect(starts).toBe(2);
    expect(agent.getSessionId()).toBe('pi-session-retry');
    agent.destroy();
  });

  it('does not swallow the initial auto-compaction readiness failure', () => {
    const source = readFileSync(new URL('../pi-agent.ts', import.meta.url), 'utf8');
    const start = source.indexOf('// Seed the subprocess before it constructs the Pi session.');
    const end = source.indexOf('private buildCurrentProxyToolDefinitions', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const startupBlock = source.slice(start, end);
    expect(startupBlock).toContain('await this.requestSetAutoCompaction(autoCompaction, true)');
    expect(startupBlock).not.toContain('(continuing)');
  });

  it('rejects and clears every subprocess-owned pending request on explicit teardown', () => {
    const agent = new PiAgent(createConfig());
    const rejectNames = [
      'pendingMiniCompletions',
      'pendingLlmQueries',
      'pendingEnsureSessionReady',
      'pendingCompactions',
      'pendingContextUsageRequests',
      'pendingAutoCompactionToggles',
      'pendingRuntimeConfigUpdates',
      'pendingManifestRegistrations',
    ] as const;
    const abortNames = ['pendingToolExecutions', 'pendingProcessStarts'] as const;
    const runtime = agent as never as {
      killSubprocess(): void;
    } & Record<(typeof rejectNames)[number], Map<string, { reject(error: Error): void }>>
      & Record<(typeof abortNames)[number], Map<string, AbortController>>;
    const rejected: string[] = [];
    for (const name of rejectNames) {
      runtime[name].set(name, {
        reject: error => rejected.push(`${name}:${error.message}`),
      });
    }
    const controllers = abortNames.map(name => {
      const controller = new AbortController();
      runtime[name].set(name, controller);
      return controller;
    });

    runtime.killSubprocess();

    expect(rejected).toHaveLength(rejectNames.length);
    expect(rejected.every(value => value.includes('Pi subprocess'))).toBe(true);
    expect(controllers.every(controller => controller.signal.aborted)).toBe(true);
    for (const name of [...rejectNames, ...abortNames]) {
      expect(runtime[name].size, name).toBe(0);
    }
  });

  it('clears mini-completion and llm-query timers during teardown', async () => {
    const agent = new PiAgent(createConfig());
    const runtime = agent as never as {
      ensureSubprocess(): Promise<void>;
      send(command: Record<string, unknown>): void;
      killSubprocess(): void;
      subprocess: unknown;
      pendingMiniCompletions: Map<string, {
        resolve(value: string | null): void;
      }>;
      pendingLlmQueries: Map<string, {
        resolve(value: unknown): void;
      }>;
    };
    runtime.ensureSubprocess = async () => {};
    runtime.send = () => {};
    // runMiniCompletion reuses a running subprocess (title/summary must never
    // cold-spawn a manifest-registering child), so a live child must be present
    // for the mini path to enqueue its request.
    const miniChild = { stdin: { writable: true, write: () => true }, kill: () => {}, exitCode: 0, signalCode: null };
    runtime.subprocess = miniChild;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const handles: Array<ReturnType<typeof setTimeout>> = [];
    const cleared: Array<ReturnType<typeof setTimeout>> = [];
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      const timeout = args[1];
      if (timeout === LLM_QUERY_TIMEOUT_MS) {
        const handle = { rpcTimer: handles.length + 1 } as unknown as ReturnType<typeof setTimeout>;
        handles.push(handle);
        return handle;
      }
      const handle = originalSetTimeout(...args);
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
      if (handles.includes(handle)) {
        cleared.push(handle);
        return;
      }
      originalClearTimeout(handle);
    }) as typeof clearTimeout;

    try {
      const mini = agent.runMiniCompletion('title');
      const llm = agent.queryLlm({ prompt: 'query' });
      await Promise.resolve();
      await Promise.resolve();
      expect(runtime.pendingMiniCompletions.size).toBe(1);
      expect(runtime.pendingLlmQueries.size).toBe(1);

      const settled = Promise.allSettled([mini, llm]);
      runtime.killSubprocess();
      const rejected = await settled;
      expect(rejected.map(result => result.status)).toEqual(['rejected', 'rejected']);
      expect(rejected.map(result => result.status === 'rejected' ? result.reason.message : ''))
        .toEqual(['Pi subprocess startup cancelled', 'Pi subprocess startup cancelled']);
      expect(cleared).toEqual(handles.slice(0, 2));

      // killSubprocess cleared this.subprocess; restore it so the mini path can
      // enqueue again for the resolve-after-teardown leg.
      runtime.subprocess = miniChild;
      const resolvedMini = agent.runMiniCompletion('resolved title');
      const resolvedLlm = agent.queryLlm({ prompt: 'resolved query' });
      await Promise.resolve();
      await Promise.resolve();
      const [miniId, miniPending] = runtime.pendingMiniCompletions.entries().next().value ?? [];
      const [llmId, llmPending] = runtime.pendingLlmQueries.entries().next().value ?? [];
      if (!miniId || !miniPending || !llmId || !llmPending) {
        throw new Error('expected pending mini-completion and llm-query requests');
      }
      runtime.pendingMiniCompletions.delete(miniId);
      runtime.pendingLlmQueries.delete(llmId);
      miniPending.resolve('resolved');
      const llmResult = { text: 'resolved' };
      llmPending.resolve(llmResult);

      expect(await resolvedMini).toBe('resolved');
      expect(await resolvedLlm).toBe(llmResult);
      expect(cleared).toEqual(handles);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it('cleans only the captured old generation during graceful restart', async () => {
    const agent = new PiAgent(createConfig());
    const runtime = agent as never as {
      killSubprocessGracefully(timeoutMs: number): Promise<void>;
      subprocess: unknown;
      readline: unknown;
      subprocessAttempt: unknown;
      preToolMetadataByCallId: Map<string, unknown>;
      adapter: { setExecutionManifest(value: unknown): void; resetOverflowState(): void };
      pendingMiniCompletions: Map<string, { reject(error: Error): void }>;
      pendingAutoCompactionToggles: Map<string, { reject(error: Error): void }>;
    };
    let exitListener: ((code: number, signal: string | null) => void) | undefined;
    const oldKills: string[] = [];
    let oldReadlineCloses = 0;
    let newReadlineCloses = 0;
    let overflowResets = 0;
    const oldChild = {
      pid: 42,
      exitCode: null,
      signalCode: null,
      stdin: { writable: true, write: () => true },
      once: (event: string, listener: (code: number, signal: string | null) => void) => {
        if (event === 'exit') exitListener = listener;
      },
      removeListener: (event: string, listener: (code: number, signal: string | null) => void) => {
        if (event === 'exit' && exitListener === listener) exitListener = undefined;
      },
      kill: (signal: string) => {
        oldKills.push(signal);
        if (signal === 'SIGKILL') exitListener?.(137, 'SIGKILL');
      },
    };
    const oldReadline = {
      close: () => { oldReadlineCloses += 1; },
      removeAllListeners: () => {},
    };
    const newChild = { stdin: { writable: true, write: () => true } };
    const newReadline = { close: () => { newReadlineCloses += 1; } };
    const newAttempt = { generation: 'new' };
    runtime.subprocess = oldChild;
    runtime.readline = oldReadline;
    runtime.preToolMetadataByCallId.set('old', {});
    runtime.adapter = {
      setExecutionManifest: () => {},
      resetOverflowState: () => { overflowResets += 1; },
    };
    const rejected: string[] = [];
    runtime.pendingMiniCompletions.set('mini', {
      reject: error => rejected.push(error.message),
    });
    runtime.pendingAutoCompactionToggles.set('toggle', {
      reject: error => rejected.push(error.message),
    });

    const stopping = runtime.killSubprocessGracefully(0);
    runtime.subprocess = newChild;
    runtime.readline = newReadline;
    runtime.subprocessAttempt = newAttempt;
    runtime.preToolMetadataByCallId.clear();
    runtime.preToolMetadataByCallId.set('new', {});
    await stopping;

    expect(rejected).toHaveLength(2);
    expect(runtime.pendingMiniCompletions.size).toBe(0);
    expect(runtime.pendingAutoCompactionToggles.size).toBe(0);
    expect(oldKills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(oldReadlineCloses).toBe(1);
    expect(newReadlineCloses).toBe(0);
    expect(runtime.subprocess).toBe(newChild);
    expect(runtime.readline).toBe(newReadline);
    expect(runtime.subprocessAttempt).toBe(newAttempt);
    expect([...runtime.preToolMetadataByCallId.keys()]).toEqual(['new']);
    expect(overflowResets).toBe(0);
  });

  it('rejects restart disposal until the retained child exit is confirmed on retry', async () => {
    const agent = new PiAgent(createConfig());
    const runtime = agent as never as {
      subprocess: unknown;
      readline: unknown;
      subprocessTermination: Promise<void> | null;
    };
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: string | null;
      stdin: { writable: boolean; write(value: string): boolean };
      kill(signal: string): boolean;
    };
    child.pid = 43;
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = { writable: true, write: () => true };
    const kills: string[] = [];
    let confirmRetry = false;
    child.kill = signal => {
      kills.push(signal);
      if (confirmRetry && signal === 'SIGTERM') child.emit('exit', 0, 'SIGTERM');
      return true;
    };
    runtime.subprocess = child;
    runtime.readline = { close: () => {}, removeAllListeners: () => {} };
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => {
      if (delay === 2_000 || delay === 1_000) {
        queueMicrotask(() => typeof handler === 'function' && handler(...args));
        return { terminationTimer: delay } as unknown as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout;

    try {
      await expect(agent.disposeForRestart())
        .rejects.toThrow('pi-subprocess-termination-unconfirmed:43');
      expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
      expect(runtime.subprocess).toBe(child);
      expect(runtime.subprocessTermination).not.toBeNull();

      confirmRetry = true;
      await agent.disposeForRestart();
      expect(kills).toEqual(['SIGTERM', 'SIGKILL', 'SIGTERM']);
      expect(runtime.subprocess).toBeNull();
      expect(runtime.subprocessTermination).toBeNull();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('completes active event drains on external teardown but not resume recovery', async () => {
    for (const action of ['reconnect', 'destroy'] as const) {
      const agent = new PiAgent(createConfig());
      const runtime = agent as never as {
        eventQueue: { isComplete: boolean; drain(): AsyncGenerator<unknown> };
      };
      const waiting = runtime.eventQueue.drain().next();
      if (action === 'reconnect') await agent.reconnect();
      else agent.destroy();
      expect(runtime.eventQueue.isComplete, action).toBe(true);
      expect((await waiting).done, action).toBe(true);
    }

    const recoveryAgent = new PiAgent(createConfig());
    const recovery = recoveryAgent as never as {
      killSubprocess(options?: { completeEventQueue?: boolean }): void;
      eventQueue: { isComplete: boolean };
    };
    recovery.killSubprocess({ completeEventQueue: false });
    expect(recovery.eventQueue.isComplete).toBe(false);

    const source = readFileSync(new URL('../pi-agent.ts', import.meta.url), 'utf8');
    const recoveryStart = source.indexOf('// If resume failed, clear and try fresh');
    const recoveryEnd = source.indexOf('await this.ensureSubprocess();', recoveryStart);
    expect(source.slice(recoveryStart, recoveryEnd))
      .toContain('this.killSubprocess({ completeEventQueue: false });');
  });

  it('settles permissions once and never sends an old ask_user response to a replacement child', async () => {
    const authorizeStarted = deferred<void>();
    const authorizeRelease = deferred<void>();
    const config = createConfig();
    config.contextProfile = 'bare';
    config.permissionServicePort = {
      async authorize(request) {
        authorizeStarted.resolve();
        await authorizeRelease.promise;
        return allowReceipt(request);
      },
    };
    const agent = new PiAgent(config);
    const { manifest, tool } = installStaticManifest(agent, 'Bash');
    const runtime = agent as never as {
      handleAskUserRequest(request: {
        requestId: string;
        question: string;
        options: string[];
        allowFreeText: boolean;
      }): void;
      handlePreToolUseRequest(request: {
        requestId: string;
        toolName: string;
        semanticId: string;
        piName: string;
        surfaceVersion: number;
        manifestResponseEpoch: number;
        manifestGeneration: string;
        manifestHash: string;
        input: Record<string, unknown>;
      }): Promise<void>;
      emitAutomationEvent(): Promise<{ matchedCount: number }>;
      killSubprocess(): void;
      subprocess: unknown;
      pendingPermissions: Map<string, {
        kind: 'permission' | 'ask_user';
        resolve(response: unknown): void;
      }>;
      eventQueue: { drain(): AsyncGenerator<{ type: string; requestId?: string }> };
    };
    const oldWrites: string[] = [];
    const newWrites: string[] = [];
    const oldChild = {
      stdin: { writable: true, write: (line: string) => { oldWrites.push(line); return true; } },
      kill: () => {},
    };
    const newChild = {
      stdin: { writable: true, write: (line: string) => { newWrites.push(line); return true; } },
      kill: () => {},
    };
    let askPermissionRequestId: string | undefined;
    agent.setPermissionMode('default');
    runtime.emitAutomationEvent = async () => ({ matchedCount: 0 });
    agent.onPermissionRequest = request => {
      if (request.toolName === 'ask_user') askPermissionRequestId = request.requestId;
    };
    runtime.subprocess = oldChild;
    const ordinaryContinuation = runtime.handlePreToolUseRequest({
      requestId: 'old-permission',
      toolName: 'Bash',
      semanticId: tool.descriptor.id,
      piName: tool.binding.piName,
      surfaceVersion: manifest.surfaceVersion,
      manifestResponseEpoch: 0,
      manifestGeneration: manifest.snapshotGeneration,
      manifestHash: manifest.manifestHash,
      input: { command: 'npm install left-pad' },
    });
    await authorizeStarted.promise;
    runtime.handleAskUserRequest({
      requestId: 'old-ask',
      question: 'Continue?',
      options: ['Yes', 'No'],
      allowFreeText: false,
    });
    expect(askPermissionRequestId).toBeString();
    expect(runtime.pendingPermissions.size).toBe(1);

    runtime.killSubprocess();
    runtime.killSubprocess();
    runtime.subprocess = newChild;
    authorizeRelease.resolve();
    await ordinaryContinuation;
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.pendingPermissions.size).toBe(0);
    expect(newWrites).toEqual([]);
    expect(oldWrites.filter(line => line.includes('pre_tool_use_response'))).toEqual([]);
    expect(oldWrites.filter(line => line.includes('ask_user_response'))).toEqual([]);
    const events: Array<{ type: string; requestId?: string }> = [];
    for await (const event of runtime.eventQueue.drain()) events.push(event);
    expect(events.filter(event => event.type === 'permission_request_cancelled'))
      .toEqual([{ type: 'permission_request_cancelled', requestId: askPermissionRequestId }]);
  });

  it('never sends a stale tool execution response to a replacement child', async () => {
    const staleResponses: Array<{ outcome: 'resolved' | 'rejected'; responses: string[] }> = [];
    for (const outcome of ['resolved', 'rejected'] as const) {
      const agent = new PiAgent(createConfig());
      const { manifest, tool } = installStaticManifest(agent, 'Bash');
      const runtime = agent as never as {
        beginSubprocessAttempt(): TestStartupAttempt;
        finishSubprocessAttempt(attempt: TestStartupAttempt): void;
        handleToolExecuteRequest(request: {
          requestId: string;
          toolName: string;
          piName: string;
          manifestGeneration: string;
          manifestHash: string;
          args: Record<string, unknown>;
        }): Promise<void>;
        routeToolCall(): Promise<{ content: string; isError: boolean }>;
        subprocess: unknown;
        readline: unknown;
        subprocessTermination: Promise<void> | null;
      };
      const createChild = (writes: string[]) => {
        const child = new EventEmitter() as EventEmitter & {
          pid: number;
          exitCode: number | null;
          signalCode: string | null;
          stdin: { writable: boolean; write(line: string): boolean };
          kill(signal: string): boolean;
        };
        child.pid = outcome === 'resolved' ? 4101 : 4102;
        child.exitCode = null;
        child.signalCode = null;
        child.stdin = {
          writable: true,
          write: line => {
            writes.push(line);
            return true;
          },
        };
        child.kill = signal => {
          child.signalCode = signal;
          child.emit('exit', 0, signal);
          return true;
        };
        return child;
      };
      const oldWrites: string[] = [];
      const replacementWrites: string[] = [];
      const oldChild = createChild(oldWrites);
      const replacementChild = createChild(replacementWrites);
      const oldReadline = { close: () => {}, removeAllListeners: () => {} };
      const replacementReadline = { close: () => {}, removeAllListeners: () => {} };
      runtime.subprocess = oldChild;
      runtime.readline = oldReadline;
      const oldAttempt = runtime.beginSubprocessAttempt();
      runtime.finishSubprocessAttempt(oldAttempt);

      let markRouteStarted!: () => void;
      const routeStarted = new Promise<void>(resolve => { markRouteStarted = resolve; });
      let resolveRoute!: (result: { content: string; isError: boolean }) => void;
      let rejectRoute!: (error: Error) => void;
      const delayedRoute = new Promise<{ content: string; isError: boolean }>((resolve, reject) => {
        resolveRoute = resolve;
        rejectRoute = reject;
      });
      runtime.routeToolCall = async () => {
        markRouteStarted();
        return delayedRoute;
      };

      const oldResponse = runtime.handleToolExecuteRequest({
        requestId: 'colliding-request-id',
        toolName: tool.binding.bindingName,
        piName: tool.binding.piName,
        manifestGeneration: manifest.snapshotGeneration,
        manifestHash: manifest.manifestHash,
        args: {},
      });
      await routeStarted;
      await agent.reconnect();
      await runtime.subprocessTermination;

      runtime.subprocess = replacementChild;
      runtime.readline = replacementReadline;
      const replacementAttempt = runtime.beginSubprocessAttempt();
      runtime.finishSubprocessAttempt(replacementAttempt);

      if (outcome === 'resolved') {
        resolveRoute({ content: 'old success', isError: false });
      } else {
        rejectRoute(new Error('old failure'));
      }
      await oldResponse;

      staleResponses.push({
        outcome,
        responses: replacementWrites.filter(line => JSON.parse(line).type === 'tool_execute_response'),
      });

      agent.destroy();
      await runtime.subprocessTermination;
    }

    expect(staleResponses).toEqual([
      { outcome: 'resolved', responses: [] },
      { outcome: 'rejected', responses: [] },
    ]);
  });

  it('rejects startup-owned pending RPCs when the child exits after ready but before startup settles', async () => {
    const agent = new PiAgent(createConfig());
    const installed = installAttempt(agent);
    const runtime = agent as never as {
      handleLine(line: string, attempt: TestStartupAttempt, child: unknown): void;
      handleSubprocessExit(
        code: number,
        signal: null,
        attempt: TestStartupAttempt,
        child: unknown,
        readline: unknown,
      ): void;
      pendingAutoCompactionToggles: Map<string, { reject(error: Error): void }>;
    };
    let rejected: Error | undefined;
    runtime.handleLine(JSON.stringify({
      type: 'ready',
      sessionId: 'pi-session-startup',
      runtimeVersion: '0.80.2',
    }), installed.attempt, installed.child);
    runtime.pendingAutoCompactionToggles.set('startup-toggle', {
      reject: error => { rejected = error; },
    });

    runtime.handleSubprocessExit(1, null, installed.attempt, installed.child, installed.readline);
    await expect(installed.attempt.startup).rejects.toThrow(/exited.*code 1/i);
    expect(rejected?.message).toMatch(/exited.*code 1/i);
    expect(runtime.pendingAutoCompactionToggles.size).toBe(0);
  });

  it('observes resistant startup-child termination before a retry can spawn', async () => {
    const agent = new PiAgent(createConfig());
    const runtime = agent as never as {
      beginSubprocessAttempt(): TestStartupAttempt;
      failSubprocessAttempt(
        attempt: TestStartupAttempt,
        error: Error,
        child: unknown,
        readline: unknown,
      ): boolean;
      ensureSubprocess(): Promise<void>;
      spawnSubprocess(attempt: TestStartupAttempt): Promise<void>;
      subprocess: unknown;
      readline: unknown;
    };
    const oldChild = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: string | null;
      stdin: { writable: boolean; write(): boolean };
      kill(signal: string): boolean;
    };
    oldChild.pid = 41;
    oldChild.exitCode = null;
    oldChild.signalCode = null;
    oldChild.stdin = { writable: true, write: () => true };
    const kills: string[] = [];
    let oldAlive = true;
    oldChild.kill = signal => {
      kills.push(signal);
      if (signal === 'SIGKILL') {
        oldAlive = false;
        oldChild.emit('exit', 137, 'SIGKILL');
      }
      return true;
    };
    let observedLateError = 0;
    oldChild.on('error', () => { observedLateError += 1; });
    const oldReadline = { close: () => {}, removeAllListeners: () => {} };
    runtime.subprocess = oldChild;
    runtime.readline = oldReadline;
    const oldAttempt = runtime.beginSubprocessAttempt();
    let spawnedWhileOldAlive = false;
    const newChild = { stdin: { writable: true, write: () => true } };
    runtime.spawnSubprocess = async () => {
      spawnedWhileOldAlive = oldAlive;
      runtime.subprocess = newChild;
    };
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => {
      if (delay === 2_000 || delay === 1_000) {
        queueMicrotask(() => typeof handler === 'function' && handler(...args));
        return { terminationTimer: delay } as unknown as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout;

    try {
      expect(runtime.failSubprocessAttempt(
        oldAttempt,
        new Error('startup failed'),
        oldChild,
        oldReadline,
      )).toBe(true);
      await runtime.ensureSubprocess();

      expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
      expect(spawnedWhileOldAlive).toBe(false);
      expect(oldAlive).toBe(false);
      expect(oldChild.listenerCount('error')).toBeGreaterThan(0);
      oldChild.emit('error', new Error('late old-child error'));
      expect(observedLateError).toBe(1);
      expect(runtime.subprocess).toBe(newChild);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('retires a post-startup child error only after forced exit is observed', async () => {
    const agent = new PiAgent(createConfig());
    const runtime = agent as never as {
      beginSubprocessAttempt(): TestStartupAttempt;
      finishSubprocessAttempt(attempt: TestStartupAttempt): void;
      handleSubprocessError(error: Error, attempt: TestStartupAttempt, child: unknown, readline: unknown): void;
      ensureSubprocess(): Promise<void>;
      spawnSubprocess(attempt: TestStartupAttempt): Promise<void>;
      subprocess: unknown;
      readline: unknown;
      pendingMiniCompletions: Map<string, { reject(error: Error): void }>;
    };
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: string | null;
      stdin: { writable: boolean; write(): boolean };
      kill(signal: string): boolean;
    };
    child.pid = 42;
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = { writable: true, write: () => true };
    const kills: string[] = [];
    child.kill = signal => {
      kills.push(signal);
      if (signal === 'SIGKILL') child.emit('exit', 137, 'SIGKILL');
      return true;
    };
    const readline = { close: () => {}, removeAllListeners: () => {} };
    runtime.subprocess = child;
    runtime.readline = readline;
    const attempt = runtime.beginSubprocessAttempt();
    runtime.finishSubprocessAttempt(attempt);
    let rejected: Error | undefined;
    runtime.pendingMiniCompletions.set('pending', {
      reject: error => { rejected = error; },
    });
    let retries = 0;
    const replacement = { stdin: { writable: true, write: () => true } };
    runtime.spawnSubprocess = async () => {
      retries += 1;
      runtime.subprocess = replacement;
    };
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => {
      if (delay === 2_000 || delay === 1_000) {
        queueMicrotask(() => typeof handler === 'function' && handler(...args));
        return { terminationTimer: delay } as unknown as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout;

    try {
      runtime.handleSubprocessError(new Error('broken pipe'), attempt, child, readline);
      await runtime.ensureSubprocess();

      expect(rejected?.message).toBe('broken pipe');
      expect(runtime.pendingMiniCompletions.size).toBe(0);
      expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
      expect(retries).toBe(1);
      expect(runtime.subprocess).toBe(replacement);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('clears RPC timers and pending entries when send throws synchronously', async () => {
    const agent = new PiAgent(createConfig());
    const runtime = agent as never as {
      ensureSubprocess(): Promise<void>;
      send(command: Record<string, unknown>): void;
      subprocess: unknown;
      pendingMiniCompletions: Map<string, unknown>;
      pendingLlmQueries: Map<string, unknown>;
    };
    runtime.ensureSubprocess = async () => {};
    runtime.send = () => { throw new Error('serialization failed'); };
    // A live child lets the mini path reach its (throwing) send instead of
    // skipping — runMiniCompletion reuses a subprocess rather than cold-spawning.
    runtime.subprocess = { stdin: { writable: true, write: () => true } };
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const handles: Array<ReturnType<typeof setTimeout>> = [];
    const cleared: Array<ReturnType<typeof setTimeout>> = [];
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      if (args[1] === LLM_QUERY_TIMEOUT_MS) {
        const handle = { sendFailureTimer: handles.length + 1 } as unknown as ReturnType<typeof setTimeout>;
        handles.push(handle);
        return handle;
      }
      return originalSetTimeout(...args);
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
      if (handles.includes(handle)) {
        cleared.push(handle);
        return;
      }
      originalClearTimeout(handle);
    }) as typeof clearTimeout;

    try {
      const settled = await Promise.allSettled([
        agent.runMiniCompletion('title'),
        agent.queryLlm({ prompt: 'query' }),
      ]);
      expect(settled.map(result => result.status)).toEqual(['rejected', 'rejected']);
      expect(settled.map(result => result.status === 'rejected' ? result.reason.message : ''))
        .toEqual(['serialization failed', 'serialization failed']);
      expect(runtime.pendingMiniCompletions.size).toBe(0);
      expect(runtime.pendingLlmQueries.size).toBe(0);
      expect(cleared).toEqual(handles);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  // Regression: title/summary mini completions run on an ephemeral subprocess
  // session with no proxy tools, so they must never DRIVE a cold spawn (which both
  // requires an active capability turn and publishes the execution manifest via
  // register_tools). Off-turn title generation previously reached spawnSubprocess
  // -> publishExecutionManifest and surfaced "Pi execution manifest registration
  // requires an active capability runtime" on the first message of a new chat.
  it('never drives a manifest-registering spawn for an off-turn mini completion', async () => {
    const agent = new PiAgent(createConfig());
    const runtime = agent as never as {
      spawnSubprocess(attempt: TestStartupAttempt): Promise<void>;
      subprocess: unknown;
      subprocessAttempt: TestStartupAttempt | null;
      capabilityTurnRuntime: unknown;
      pendingMiniCompletions: Map<string, unknown>;
    };
    let starts = 0;
    runtime.spawnSubprocess = async () => { starts += 1; };

    // No subprocess, no in-flight startup attempt, and no capability turn — exactly
    // the off-turn title-generation cold start. Must skip gracefully, never spawn.
    expect(runtime.subprocess).toBeNull();
    expect(runtime.subprocessAttempt).toBeNull();
    expect(runtime.capabilityTurnRuntime).toBeNull();

    const result = await agent.runMiniCompletion('Name this chat');

    expect(result).toBeNull();
    expect(starts).toBe(0);
    expect(runtime.subprocessAttempt).toBeNull();
    expect(runtime.pendingMiniCompletions.size).toBe(0);
    agent.destroy();
  });

  it('reuses a running subprocess for a mini completion without respawning', async () => {
    const agent = new PiAgent(createConfig());
    const runtime = agent as never as {
      spawnSubprocess(attempt: TestStartupAttempt): Promise<void>;
      handleLine(line: string): void;
      pendingMiniCompletions: Map<string, unknown>;
    };
    let starts = 0;
    runtime.spawnSubprocess = async () => { starts += 1; };

    // installAttempt wires this.subprocess to a writable fake child, standing in
    // for a subprocess the owning chat turn already spawned.
    installAttempt(agent);

    const completion = agent.runMiniCompletion('Name this chat');
    const [id] = runtime.pendingMiniCompletions.keys();
    if (!id) throw new Error('expected a pending mini completion');
    runtime.handleLine(JSON.stringify({ type: 'mini_completion_result', id, text: 'Fixing the bug' }));

    expect(await completion).toBe('Fixing the bug');
    expect(starts).toBe(0);
    agent.destroy();
  });

  it('retains failed cleanup authority and blocks replacement until retry confirms exit', async () => {
    const agent = new PiAgent(createConfig());
    const runtime = agent as never as {
      subprocessTermination: Promise<void> | null;
      queueCapturedSubprocessTermination(child: unknown, readline: unknown): void;
      ensureSubprocess(): Promise<void>;
      spawnSubprocess(attempt: TestStartupAttempt): Promise<void>;
      subprocess: unknown;
    };
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: string | null;
      kill(signal: string): boolean;
    };
    child.pid = 51;
    child.exitCode = null;
    child.signalCode = null;
    const kills: string[] = [];
    let alive = true;
    let forcedAttempts = 0;
    child.kill = signal => {
      kills.push(signal);
      if (signal === 'SIGKILL') {
        forcedAttempts += 1;
        if (forcedAttempts === 2) {
          alive = false;
          child.emit('exit', 137, 'SIGKILL');
        }
      }
      return true;
    };
    const logs: string[] = [];
    agent.onDebug = message => logs.push(message);
    runtime.subprocess = null;
    let spawnedWhileAlive = false;
    const replacement = { stdin: { writable: true, write: () => true } };
    runtime.spawnSubprocess = async () => {
      spawnedWhileAlive = alive;
      runtime.subprocess = replacement;
    };
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => {
      if (delay === 2_000 || delay === 1_000) {
        queueMicrotask(() => typeof handler === 'function' && handler(...args));
        return { terminationTimer: delay } as unknown as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout;

    try {
      runtime.queueCapturedSubprocessTermination(child, null);
      const failedBarrier = runtime.subprocessTermination;
      if (!failedBarrier) throw new Error('expected captured subprocess termination barrier');
      await expect(failedBarrier).rejects.toThrow('pi-subprocess-termination-unconfirmed:51');
      expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
      expect(alive).toBe(true);
      expect(runtime.subprocessTermination).toBe(failedBarrier);

      await runtime.ensureSubprocess();
      expect(kills).toEqual(['SIGTERM', 'SIGKILL', 'SIGTERM', 'SIGKILL']);
      expect(spawnedWhileAlive).toBe(false);
      expect(runtime.subprocess).toBe(replacement);
      expect(runtime.subprocessTermination).toBeNull();
      expect(logs.some(line => line.includes('pi-subprocess-termination-unconfirmed:51'))).toBe(true);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('awaits a detached post-start error cleanup before restart disposal resolves', async () => {
    const agent = new PiAgent(createConfig());
    const runtime = agent as never as {
      beginSubprocessAttempt(): TestStartupAttempt;
      finishSubprocessAttempt(attempt: TestStartupAttempt): void;
      handleSubprocessError(error: Error, attempt: TestStartupAttempt, child: unknown, readline: unknown): void;
      subprocess: unknown;
      readline: unknown;
      subprocessTermination: Promise<void> | null;
    };
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: string | null;
      stdin: { writable: boolean; write(value: string): boolean };
      kill(signal: string): boolean;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = { writable: true, write: () => true };
    const kills: string[] = [];
    child.kill = signal => { kills.push(signal); return true; };
    const readline = { close: () => {}, removeAllListeners: () => {} };
    runtime.subprocess = child;
    runtime.readline = readline;
    const attempt = runtime.beginSubprocessAttempt();
    runtime.finishSubprocessAttempt(attempt);
    let releaseGrace: (() => void) | undefined;
    let releaseForced: (() => void) | undefined;
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => {
      if (delay === 2_000) {
        releaseGrace = () => { if (typeof handler === 'function') handler(...args); };
        return { terminationTimer: delay } as unknown as ReturnType<typeof setTimeout>;
      }
      if (delay === 1_000) {
        releaseForced = () => { if (typeof handler === 'function') handler(...args); };
        return { terminationTimer: delay } as unknown as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout;

    let disposal: Promise<void> | undefined;
    try {
      runtime.handleSubprocessError(new Error('broken pipe'), attempt, child, readline);
      expect(kills).toEqual(['SIGTERM']);
      expect(runtime.subprocess).toBeNull();
      disposal = agent.disposeForRestart();
      expect(await Promise.race([
        disposal.then(() => 'resolved' as const),
        new Promise<'pending'>(resolve => originalSetTimeout(() => resolve('pending'), 0)),
      ])).toBe('pending');

      releaseGrace?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
      expect(await Promise.race([
        disposal.then(() => 'resolved' as const),
        new Promise<'pending'>(resolve => originalSetTimeout(() => resolve('pending'), 0)),
      ])).toBe('pending');

      child.emit('exit', 137, 'SIGKILL');
      await disposal;
      expect(runtime.subprocessTermination).toBeNull();
    } finally {
      releaseGrace?.();
      await Promise.resolve();
      await Promise.resolve();
      child.emit('exit', 137, 'SIGKILL');
      releaseForced?.();
      await disposal?.catch(() => {});
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('routes reconnect and recovery teardown through the termination barrier', async () => {
    for (const mode of ['reconnect', 'recovery'] as const) {
      const agent = new PiAgent(createConfig());
      const runtime = agent as never as {
        beginSubprocessAttempt(): TestStartupAttempt;
        finishSubprocessAttempt(attempt: TestStartupAttempt): void;
        killSubprocess(options?: { completeEventQueue?: boolean }): void;
        ensureSubprocess(): Promise<void>;
        spawnSubprocess(attempt: TestStartupAttempt): Promise<void>;
        handleSubprocessError(error: Error, attempt: TestStartupAttempt, child: unknown, readline: unknown): void;
        handleSubprocessExit(code: number, signal: null, attempt: TestStartupAttempt, child: unknown, readline: unknown): void;
        subprocess: unknown;
        readline: unknown;
        eventQueue: { isComplete: boolean; drain(): AsyncGenerator<unknown> };
      };
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        exitCode: number | null;
        signalCode: string | null;
        stdin: { writable: boolean; write(value: string): boolean };
        kill(signal: string): boolean;
      };
      child.pid = 52;
      child.exitCode = null;
      child.signalCode = null;
      child.stdin = { writable: true, write: () => true };
      const kills: string[] = [];
      let alive = true;
      child.kill = signal => {
        kills.push(signal);
        if (signal === 'SIGKILL') {
          alive = false;
          child.emit('exit', 137, 'SIGKILL');
        }
        return true;
      };
      const readline = { close: () => {}, removeAllListeners: () => {} };
      runtime.subprocess = child;
      runtime.readline = readline;
      const oldAttempt = runtime.beginSubprocessAttempt();
      runtime.finishSubprocessAttempt(oldAttempt);
      const waiting = mode === 'reconnect' ? runtime.eventQueue.drain().next() : null;
      let spawnedWhileAlive = false;
      const replacement = { stdin: { writable: true, write: () => true } };
      runtime.spawnSubprocess = async () => {
        spawnedWhileAlive = alive;
        runtime.subprocess = replacement;
      };
      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => {
        if (delay === 2_000 || delay === 1_000) {
          queueMicrotask(() => typeof handler === 'function' && handler(...args));
          return { terminationTimer: delay } as unknown as ReturnType<typeof setTimeout>;
        }
        return originalSetTimeout(handler, delay, ...args);
      }) as typeof setTimeout;

      try {
        if (mode === 'reconnect') await agent.reconnect();
        else runtime.killSubprocess({ completeEventQueue: false });
        await runtime.ensureSubprocess();

        expect(kills, mode).toEqual(['SIGTERM', 'SIGKILL']);
        expect(spawnedWhileAlive, mode).toBe(false);
        expect(runtime.eventQueue.isComplete, mode).toBe(mode === 'reconnect');
        if (waiting) expect((await waiting).done).toBe(true);
        runtime.handleSubprocessError(new Error('late old error'), oldAttempt, child, readline);
        runtime.handleSubprocessExit(1, null, oldAttempt, child, readline);
        expect(runtime.subprocess, mode).toBe(replacement);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
      }
    }
  });

  it('rejects replacement admission when SIGKILL is unconfirmed and retries the same child', async () => {
    const agent = new PiAgent(createConfig());
    const runtime = agent as never as {
      queueCapturedSubprocessTermination(child: unknown, readline: unknown): void;
      ensureSubprocess(): Promise<void>;
      spawnSubprocess(attempt: TestStartupAttempt): Promise<void>;
      subprocessTermination: Promise<void> | null;
    };
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: string | null;
      kill(signal: string): boolean;
    };
    child.pid = 53;
    child.exitCode = null;
    child.signalCode = null;
    let confirmForcedExit = false;
    child.kill = signal => {
      if (signal === 'SIGKILL') {
        if (!confirmForcedExit) throw new Error('kill failed');
        child.emit('exit', 137, 'SIGKILL');
      }
      return true;
    };
    let spawned = 0;
    let resolveSpawnCalled!: () => void;
    const spawnCalled = new Promise<void>(resolve => { resolveSpawnCalled = resolve; });
    runtime.spawnSubprocess = async () => {
      spawned += 1;
      resolveSpawnCalled();
    };
    let releaseForcedExit: (() => void) | undefined;
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => {
      if (delay === 2_000) {
        queueMicrotask(() => typeof handler === 'function' && handler(...args));
        return { terminationTimer: delay } as unknown as ReturnType<typeof setTimeout>;
      }
      if (delay === 1_000) {
        releaseForcedExit = () => { if (typeof handler === 'function') handler(...args); };
        return { terminationTimer: delay } as unknown as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout;

    try {
      runtime.queueCapturedSubprocessTermination(child, null);
      const firstAdmission = runtime.ensureSubprocess();
      const beforeForcedExit = await Promise.race([
        spawnCalled.then(() => 'spawned' as const),
        new Promise<'pending'>(resolve => originalSetTimeout(() => resolve('pending'), 0)),
      ]);
      expect(releaseForcedExit).toBeFunction();
      expect(beforeForcedExit).toBe('pending');
      releaseForcedExit?.();
      await expect(firstAdmission).rejects.toThrow('pi-subprocess-termination-unconfirmed:53');
      expect(spawned).toBe(0);
      expect(runtime.subprocessTermination).not.toBeNull();

      confirmForcedExit = true;
      await runtime.ensureSubprocess();
      expect(spawned).toBe(1);
      expect(runtime.subprocessTermination).toBeNull();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});

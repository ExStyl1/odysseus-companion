import { describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url'; import { join } from 'node:path';

import { buildPiInitMessage, PI_INIT_FIELD_CLASSIFICATION } from '../pi-agent.ts'; import { getSessionDirPath } from '../../sessions/storage.ts';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts';
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';
import { getHarnessToolDescriptor, getPiToolBinding } from '../pi-harness/harness-tool-descriptor.ts';
import { parseAndFreezePiPermissionReceipt, type PiPermissionServicePort } from '../pi-harness/permission-receipt.ts';

function config(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'workspace-1',
      name: 'Workspace',
      rootPath: '/tmp/h2-workspace',
      workspaceRootPath: '/tmp/h2-workspace',
      sessionRootPath: '/tmp/h2-sessions',
    } as never,
    session: { id: 'session-1', createdAt: 0, lastUsedAt: 0 } as never,
    isHeadless: true,
  };
}

function runtimeAndManifest() {
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'generation-1',
    sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: [{
      descriptor: getHarnessToolDescriptor('notebook_edit'),
      binding: getPiToolBinding('notebook_edit'),
      source: { kind: 'piBuiltin', bindingId: 'NotebookEdit' },
      modelSchema: { type: 'object' },
    }],
  };
  const manifest = finalizePiExecutionManifest(seed, []);
  const runtime = {
    view: { generation: 'generation-1', sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [] },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return '/tmp/h2-resource'; },
      async readText() { return ''; },
      resolveCredential() { throw new Error('not used by this contract'); },
    },
    piExecutionManifestSeed: seed,
  } as CapabilityTurnRuntime;
  return { runtime, manifest };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('bounded H2 test wait expired')), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('PiAgent init protocol classification', () => {
  it('suppresses a whole-capability deny from the Pi schema manifest', () => {
    const agent = new PiAgent(config());
    const { runtime } = runtimeAndManifest();
    agent.setCapabilityTurnRuntime(runtime);
    (agent as any).permissionManager.setCapabilityPermissionLayers([{
      scope: 'global',
      content: JSON.stringify({
        permissionDsl: {
          version: 1,
          generation: 'generation-1',
          rules: [{ id: 'deny-notebook', action: 'deny', match: { kind: 'tool', semanticId: 'notebook_edit' } }],
        },
      }),
    }], 'generation-1', true);

    try {
      const execution = (agent as any).buildExecutionManifestForCurrentTurn();
      expect(execution.manifest.tools.some((tool: any) => tool.descriptor.id === 'notebook_edit')).toBe(false);
    } finally {
      agent.destroy();
    }
  });

  it('fails before subprocess spawn without a finalized capability manifest', async () => {
    const agent = new PiAgent(config());
    let spawnCalls = 0;
    const state = agent as unknown as {
      spawnProcess: () => never;
      spawnSubprocess(attempt: unknown): Promise<void>;
    };
    state.spawnProcess = () => {
      spawnCalls += 1;
      throw new Error('spawn must not run');
    };

    await expect(state.spawnSubprocess({})).rejects.toThrow('Pi capability runtime manifest is required');
    expect(spawnCalls).toBe(0);
  });

  it('forwards the manifest and all eleven effective orchestrator fields', () => {
    const orchestrator = Object.fromEntries(
      PI_INIT_FIELD_CLASSIFICATION.orchestratorFields.map((field, index) => [field, index + 1]),
    );
    const message = buildPiInitMessage({
      apiKey: 'test-key',
      authType: 'api_key',
      baseUrl: 'https://example.test',
      capabilityCatalogKinds: ['skill'],
      branchFromSdkSessionId: 'sdk-parent',
      branchFromSdkTurnId: 'turn-parent',
      branchFromSessionPath: '/sessions/parent', startFresh: true, resumeSessionFile: '/sessions/session-1/.pi-sessions/20260101T000000_sdk-parent.jsonl', // UA12.217 — the one-shot spawn posture forwards like the branch fields beside it
      // T7 (2026-08-21) · the synthesized parent a FIRST cross-runtime switch
      // into Pi forks from. Host-forwarded like the branch fields beside it,
      // and for the same reason: the subprocess must not derive a path the
      // host has not verified is loadable.
      carryHistorySessionFile: '/sessions/session-1/.pi-carry/handoff.jsonl',
      customEndpoint: { api: 'openai-completions' },
      customModels: ['model-a'],
      continuationActivatedTools: ['search'],
      cwd: '/workspace',
      deferredMcpToolLoading: true,
      filesystemScope: {
        session: { workspaceId: 'workspace-1', sessionId: 'session-1' },
        primaryRoot: '/workspace/current',
        cwd: '/workspace/current',
        additionalRoots: [],
        managedExclusions: ['/managed'],
        generation: 'generation-1',
      },
      // R10: host-authoritative headless flag gating MCP auto-backgrounding.
      isHeadless: false,
      miniModel: 'mini',
      model: 'model',
      piAuth: { provider: 'openai', credential: { type: 'api_key', key: 'test-key' } },
      plansFolderPath: '/sessions/plans',
      projectTrusted: true,
      providerType: 'pi',
      sessionId: 'session-1',
      sessionPath: '/sessions/session-1',
      thinkingLevel: 'medium',
      // R48: the session WebSearch budget seed (JSONL-only; never on
      // `orchestrator`, which is normalized into the signed manifest identity).
      webSearchesUsed: 12,
      workflowSizeGuideline: 'medium',
      workingDirectory: '/workspace/current',
      workspaceId: 'workspace-1',
      workspaceRootPath: '/workspace',
      agentDir: '/attacker-controlled-agent-dir',
      orchestrator,
      executionManifest: { surfaceVersion: 2, snapshotGeneration: 'generation-1', manifestHash: 'hash-1' },
      allowedToolNames: ['read'],
      piContextResources: [],
      piRuntimeAgentDefinitions: [],
      unknownFutureField: 'must-be-omitted',
    });

    expect(Object.keys(message).sort()).toEqual(['type', ...PI_INIT_FIELD_CLASSIFICATION.hostForwarded].sort());
    expect(message.type).toBe('init');
    expect(message).not.toHaveProperty('agentDir');
    expect(message.orchestrator).toEqual(orchestrator);
    expect(message.executionManifest).toEqual({ surfaceVersion: 2, snapshotGeneration: 'generation-1', manifestHash: 'hash-1' });
    expect(message.capabilityCatalogKinds).toEqual(['skill']);
    expect(message.continuationActivatedTools).toEqual(['search']);
    expect(message.projectTrusted).toBe(true);
    // ADVICE forwarded verbatim; the hard off switch travels as the manifest
    // omitting the workflow tool, never as an init flag.
    expect(message.workflowSizeGuideline).toBe('medium');
    // R48: the budget seed rides the init JSONL verbatim.
    expect(message.webSearchesUsed).toBe(12);
    expect(message.carryHistorySessionFile).toBe('/sessions/session-1/.pi-carry/handoff.jsonl'); expect(message.startFresh).toBe(true); expect(message.resumeSessionFile).toBe('/sessions/session-1/.pi-sessions/20260101T000000_sdk-parent.jsonl'); // UA12.217
    expect(message).not.toHaveProperty('unknownFutureField');
    expect(PI_INIT_FIELD_CLASSIFICATION.serverDerived.agentDir).toBe('server-derived');
  });

  it('keeps agentDir server-derived and requires the current child manifest', () => {
    const source = readFileSync(fileURLToPath(new URL(
      '../../../../pi-agent-server/src/index.ts',
      import.meta.url,
    )), 'utf8');
    const initStart = source.indexOf('interface InitMessage');
    const initEnd = source.indexOf('interface RuntimeConfigUpdateMessage', initStart);
    const initContract = source.slice(initStart, initEnd);
    const topLevelFields = [...initContract.matchAll(/^  ([A-Za-z][A-Za-z0-9_]*)\??:/gm)]
      .map(match => match[1]!);
    const orchestratorStart = initContract.indexOf('  orchestrator?: {');
    const orchestratorEnd = initContract.indexOf('  };', orchestratorStart);
    const orchestratorContract = initContract.slice(orchestratorStart, orchestratorEnd);
    const orchestratorFields = [...orchestratorContract.matchAll(/^    ([A-Za-z][A-Za-z0-9_]*)\??:/gm)]
      .map(match => match[1]!);

    expect(initStart).toBeGreaterThanOrEqual(0);
    expect(initEnd).toBeGreaterThan(initStart);
    expect(initContract).not.toContain('agentDir?:');
    expect(initContract).toContain('orchestrator?: {');
    expect(topLevelFields.filter(field => field !== 'type').sort())
      .toEqual([...PI_INIT_FIELD_CLASSIFICATION.hostForwarded].sort());
    expect(orchestratorFields.sort())
      .toEqual([...PI_INIT_FIELD_CLASSIFICATION.orchestratorFields].sort());
    expect(source).toContain('tierModelMap: config.orchestrator?.tierModelMap');
    expect(source).toContain('concurrency: config.orchestrator?.concurrency');
    expect(source).toContain('maxDepth: config.orchestrator?.depth');
    expect(source).toContain('getMaxParallelTasks: () => generationConfig.orchestrator?.maxParallelTasks');
    expect(source).toContain('getMaxAgents: () => generationConfig.orchestrator?.maxAgents');
    expect(source).toContain('getTokenBudget: () => generationConfig.orchestrator?.tokenBudget ?? undefined');
    expect(source).toContain('orchestrator: msg.executionManifest.orchestrator');
    expect(source).toContain('activeExecutionManifest = sealPiExecutionManifest(msg.executionManifest);');
    expect(source).not.toContain('createStandalonePiExecutionManifest({');
    expect(source).not.toContain('initConfig.agentDir');
    expect(source).not.toContain('initConfig!.agentDir');
    expect(source).toContain("agentDir = join(config.sessionPath, '.pi-agent')");
  });

  it('clears manifest authority on turn release and rejects late manifest routes', async () => {
    const agent = new PiAgent(config());
    const { runtime, manifest } = runtimeAndManifest();
    const state = agent as unknown as {
      activeExecutionManifest: typeof manifest | null;
      routeToolCall(): Promise<unknown>;
      handleToolExecuteRequest(request: Record<string, unknown>): Promise<void>;
    };
    let executions = 0;
    state.routeToolCall = async () => {
      executions += 1;
      return { content: 'executed', isError: false };
    };
    agent.setCapabilityTurnRuntime(runtime);
    state.activeExecutionManifest = manifest;
    agent.setCapabilityTurnRuntime(null);

    expect(state.activeExecutionManifest).toBeNull();
    await state.handleToolExecuteRequest({
      requestId: 'late-route',
      toolName: 'NotebookEdit',
      piName: 'notebook_edit',
      manifestGeneration: manifest.snapshotGeneration,
      manifestHash: manifest.manifestHash,
      args: {},
    });
    expect(executions).toBe(0);
    agent.destroy();
  });

  it('publishes manifest authority only after a current-owner child acknowledgement', async () => {
    for (const replacement of ['none', 'runtime', 'subprocess'] as const) {
      const agent = new PiAgent(config());
      const { runtime, manifest } = runtimeAndManifest();
      const state = agent as unknown as {
        activeExecutionManifest: typeof manifest | null;
        lastExecutionManifestIdentity: { generation: string; manifestHash: string } | null;
        subprocess: { stdin: { writable: boolean } } | null;
        subprocessResponseEpoch: number;
        send(message: Record<string, unknown>): void;
        publishExecutionManifest(execution: { manifest: typeof manifest; tools: [] }, previous: typeof manifest): Promise<void>;
        pendingManifestRegistrations: Map<string, {
          resolve(identity: { generation: string; manifestHash: string }): void;
        }>;
      };
      state.send = () => {};
      state.subprocess = { stdin: { writable: true } };
      agent.setCapabilityTurnRuntime(runtime);
      const pending = state.publishExecutionManifest({ manifest, tools: [] }, manifest);
      await Promise.resolve();
      const registration = [...state.pendingManifestRegistrations.values()][0]!;

      if (replacement === 'runtime') agent.setCapabilityTurnRuntime(null);
      if (replacement === 'subprocess') state.subprocessResponseEpoch += 1;
      registration.resolve({ generation: manifest.snapshotGeneration, manifestHash: manifest.manifestHash });

      if (replacement === 'none') {
        await expect(pending).resolves.toBeUndefined();
        expect(state.activeExecutionManifest).toBe(manifest);
      } else {
        await expect(pending).rejects.toThrow(replacement === 'runtime' ? 'owner' : 'subprocess');
        expect(state.activeExecutionManifest).toBeNull();
      }
      expect(state.lastExecutionManifestIdentity).toEqual({
        generation: manifest.snapshotGeneration,
        manifestHash: manifest.manifestHash,
      });
      state.subprocess = null;
      agent.destroy();
    }
  });

  it('rejects an unwritable manifest registration without retaining a pending promise', async () => {
    const agent = new PiAgent(config());
    const { runtime, manifest } = runtimeAndManifest();
    const state = agent as unknown as {
      subprocess: { stdin: { writable: boolean } } | null;
      publishExecutionManifest(execution: { manifest: typeof manifest; tools: [] }, previous: typeof manifest): Promise<void>;
      pendingManifestRegistrations: Map<string, unknown>;
    };
    agent.setCapabilityTurnRuntime(runtime);
    state.subprocess = { stdin: { writable: false } };

    await expect(bounded(state.publishExecutionManifest({ manifest, tools: [] }, manifest)))
      .rejects.toThrow('stdin not writable');
    expect(state.pendingManifestRegistrations.size).toBe(0);
    state.subprocess.stdin.writable = true;
    (state as any).send = () => { throw new Error('manifest write failed'); };
    await expect(state.publishExecutionManifest({ manifest, tools: [] }, manifest))
      .rejects.toThrow('manifest write failed');
    expect(state.pendingManifestRegistrations.size).toBe(0);
    state.subprocess = null;
    agent.destroy();
  });

  it('rejects a proxy route whose binding does not match its advertised piName', async () => {
    const agent = new PiAgent(config());
    const { runtime, manifest } = runtimeAndManifest();
    const state = agent as unknown as {
      activeExecutionManifest: typeof manifest | null;
      routeToolCall(): Promise<unknown>;
      handleToolExecuteRequest(request: Record<string, unknown>): Promise<void>;
    };
    let executions = 0;
    state.routeToolCall = async () => {
      executions += 1;
      return { content: 'executed', isError: false };
    };
    agent.setCapabilityTurnRuntime(runtime);
    state.activeExecutionManifest = manifest;

    await state.handleToolExecuteRequest({
      requestId: 'mismatched-route',
      toolName: 'NotebookEdit',
      piName: 'write',
      manifestGeneration: manifest.snapshotGeneration,
      manifestHash: manifest.manifestHash,
      args: {},
    });
    expect(executions).toBe(0);
    agent.destroy();
  });

  it('blocks manifest pre-tool authorization released during hook or permission awaits', async () => {
    for (const boundary of ['hook', 'permission'] as const) {
      const entered = deferred<void>();
      const permission = deferred<void>();
      const permissionServicePort: PiPermissionServicePort = {
        async authorize(request) {
          if (boundary === 'permission') {
            entered.resolve();
            await permission.promise;
          }
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
            decisionId: `released-${boundary}`,
            outcome: 'allow',
            canonicalInput: request.canonicalInput,
            contextProfile: request.subject.contextProfile,
            sandboxRequirement: request.subject.sandboxRequirement,
          }, request.subject);
        },
      };
      const testConfig = config();
      testConfig.permissionServicePort = permissionServicePort;
      testConfig.contextProfile = 'bare';
      const agent = new PiAgent(testConfig);
      const { runtime, manifest } = runtimeAndManifest();
      const sent: Array<Record<string, unknown>> = [];
      const hook = deferred<{ matchedCount: number }>();
      const state = agent as unknown as {
        activeExecutionManifest: typeof manifest | null;
        send(message: Record<string, unknown>): void;
        emitAutomationEvent(): Promise<{ matchedCount: number }>;
        handlePreToolUseRequest(request: Record<string, unknown>): Promise<void>;
      };
      state.send = message => { sent.push(message); };
      agent.setPermissionMode(boundary === 'hook' ? 'bypassPermissions' : 'default');
      state.emitAutomationEvent = boundary === 'hook'
        ? () => { entered.resolve(); return hook.promise; }
        : async () => ({ matchedCount: 0 });
      agent.setCapabilityTurnRuntime(runtime);
      state.activeExecutionManifest = manifest;
      const tool = manifest.tools[0]!;
      const pending = state.handlePreToolUseRequest({
        requestId: `released-${boundary}`,
        toolName: tool.binding.permissionName,
        semanticId: tool.descriptor.id,
        piName: tool.binding.piName,
        surfaceVersion: tool.binding.surfaceVersion,
        manifestResponseEpoch: 0,
        manifestGeneration: manifest.snapshotGeneration,
        manifestHash: manifest.manifestHash,
        input: {},
      });

      await bounded(entered.promise);
      agent.setCapabilityTurnRuntime(null);
      if (boundary === 'hook') hook.resolve({ matchedCount: 0 });
      else permission.resolve();
      await bounded(pending);

      const responses = sent.filter(message => message.type === 'pre_tool_use_response');
      expect(responses).toHaveLength(1);
      expect(responses.at(-1)).toMatchObject({ action: 'block' });
      expect(responses.some(message => message.action === 'allow' || message.action === 'modify')).toBe(false);
      agent.destroy();
    }
  });

  it('blocks a suspended source activation when its manifest owner is revoked', async () => {
    const agent = new PiAgent(config());
    const { runtime, manifest } = runtimeAndManifest();
    const activation = deferred<boolean>();
    const entered = deferred<void>();
    const sent: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    let routes = 0;
    const state = agent as any;
    state.send = (message: Record<string, unknown>) => { sent.push(message); };
    state.emitAutomationEvent = async () => ({ matchedCount: 0 });
    state.sourceManager.getActiveSlugs = () => new Set<string>();
    state.sourceManager.getAllSources = () => [{ config: { slug: 'github' } }];
    state.eventQueue.enqueue = (event: Record<string, unknown>) => { events.push(event); };
    state.routeToolCall = async () => { routes += 1; };
    agent.onSourceActivationRequest = () => {
      entered.resolve();
      return activation.promise;
    };
    agent.setPermissionMode('bypassPermissions');
    agent.setCapabilityTurnRuntime(runtime);
    state.activeExecutionManifest = manifest;
    const dynamic = finalizePiExecutionManifest({
      ...runtime.piExecutionManifestSeed!,
      provenance: [{ capabilityKey: 'github', generation: runtime.view.generation }],
      mcpSources: [{ wireName: 'github', capabilityKey: 'github', generation: runtime.view.generation }],
    }, [{
      bindingName: 'mcp__github__send',
      description: 'Send',
      inputSchema: { type: 'object' },
      modelSchemaVersion: 1,
      bindingSchemaVersion: 1,
      provenance: { capabilityKey: 'github', generation: runtime.view.generation },
    }]);
    state.activeExecutionManifest = dynamic;

    const pending = state.handlePreToolUseRequest({
      requestId: 'released-source-activation',
      toolName: 'mcp__github__send',
      semanticId: 'mcp_dynamic',
      piName: 'mcp__github__send',
      surfaceVersion: 2,
      manifestResponseEpoch: 0,
      manifestGeneration: dynamic.snapshotGeneration,
      manifestHash: dynamic.manifestHash,
      input: {},
    });
    await bounded(entered.promise);
    agent.setCapabilityTurnRuntime(null);
    activation.resolve(true);
    await bounded(pending);

    const responses = sent.filter(message => message.type === 'pre_tool_use_response');
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ action: 'block' });
    expect(responses.some(message => message.action === 'allow' || message.action === 'modify')).toBe(false);
    expect(events.filter(event => event.type === 'source_activated')).toEqual([]);
    expect(routes).toBe(0);
    agent.destroy();
  });

  it('passes the one proxy cancellation signal to the host LSP route', async () => {
    let received: AbortSignal | undefined
    const agent = new PiAgent({
      ...config(),
      lspPort: {
        health: () => ({ status: 'ready' }),
        request: async (_input, signal) => {
          received = signal
          return { ok: true }
        },
      },
    })
    const state = agent as any
    state.assertCapabilityTurnActive = () => {}
    const controller = new AbortController()
    expect(await state.routeToolCall('lsp', { operation: 'workspace_symbols', query: 'A' }, controller.signal))
      .toEqual({ content: '{"ok":true}', isError: false })
    expect(received).toBe(controller.signal)
    agent.destroy()
  })

  // UA12.217 — /clear must not let the next spawn resume the cleared conversation by directory
  // (the subprocess's continueRecent), and /resume must reopen the NAMED sidecar or refuse.
  it('arms a one-shot startFresh at /clear and consumes it at the next init', async () => {
    const agent = new PiAgent(config());
    const state = agent as unknown as {
      takePiResumeInitFields(): { startFresh?: true; resumeSessionFile?: string };
      clearHistory(): Promise<void>;
      piStartFreshNextSpawn: boolean;
    };
    expect(state.takePiResumeInitFields()).toEqual({});
    await state.clearHistory();
    expect(state.piStartFreshNextSpawn).toBe(true);
    expect(state.takePiResumeInitFields()).toEqual({ startFresh: true });
    expect(state.takePiResumeInitFields()).toEqual({}); // one-shot: a later respawn carries neither field
    agent.destroy();
  });

  it('adopts only a /resume id whose sidecar is on disk and arms that exact file', async () => {
    const agent = new PiAgent(config());
    const state = agent as unknown as {
      adoptRuntimeSessionAnchor(sessionId: string): Promise<boolean>;
      takePiResumeInitFields(): { startFresh?: true; resumeSessionFile?: string };
    };
    const piSessionsDir = join(getSessionDirPath('workspace-1', 'session-1'), '.pi-sessions');
    mkdirSync(piSessionsDir, { recursive: true });
    const sidecar = join(piSessionsDir, '20260101T000000_u217-sidecar-id.jsonl');
    writeFileSync(sidecar, '{}\n');
    expect(await state.adoptRuntimeSessionAnchor('u217-sidecar-id')).toBe(true);
    expect(state.takePiResumeInitFields()).toEqual({ resumeSessionFile: sidecar });
    expect(await state.adoptRuntimeSessionAnchor('u217-gone-id')).toBe(false);
    expect(state.takePiResumeInitFields()).toEqual({});
    agent.destroy();
  });

  it('drops the armed spawn posture at a workspace change', async () => {
    const agent = new PiAgent(config());
    const state = agent as unknown as {
      clearHistory(): Promise<void>;
      setWorkspace(workspace: unknown): void;
      piStartFreshNextSpawn: boolean;
      takePiResumeInitFields(): { startFresh?: true; resumeSessionFile?: string };
    };
    await state.clearHistory();
    expect(state.piStartFreshNextSpawn).toBe(true);
    state.setWorkspace({ id: 'workspace-2', name: 'W2', rootPath: '/tmp/h2-w2', workspaceRootPath: '/tmp/h2-w2', sessionRootPath: '/tmp/h2-w2-sessions' });
    expect(state.piStartFreshNextSpawn).toBe(false);
    expect(state.takePiResumeInitFields()).toEqual({});
    agent.destroy();
  });
});

import { CapabilityMaterializationError } from '@nessy-agent/shared/capabilities/materializer';
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SessionManager,
  type CompactionResult,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Agent } from '@earendil-works/pi-agent-core';
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, streamSimple } from '@earendil-works/pi-ai/compat';
import { getCurrentTools, type TranscriptContext } from '@earendil-works/pi-ai';
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '../../../shared/src/agent/pi-harness/harness-manifest.ts';
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
  getPiToolBinding,
} from '../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts';
import {
  CURATED_PI_BUILD_MANIFEST,
  PINNED_NESSY_FACTORIES,
  PINNED_NESSY_RESOURCES,
} from '../extensions/registry.ts';
import type { VerifiedSignedBundleRootCapability } from '../extensions/descriptor.ts';
import type { ToolExecutionRequest, ToolExecutor } from '../../../shared/src/agent/pi-harness/tool-executor.ts';
import { materializePiContextResources } from '../../../shared/src/agent/pi-harness/context-resource.ts';
import { buildDeferredMcpToolSurface } from '../deferred-mcp-tools.ts';
import { createDeferredMcpRegistrationController } from '../extensions/deferred-mcp-extension.ts';
import { createPiToolProgressBridge } from '../local-tools/tool-wrapper.ts';
import {
  SUPPORTED_PI_RUNTIME_VERSION,
  createPiRuntimeAdapter,
  type PiRuntimeBindings,
  type PiRuntimePublicSurface,
} from './pi-runtime-adapter.ts';
import { exercisePublicExtensionContract } from './fixtures/public-extension-contract.ts';

type PromptHook = (event: { systemPrompt: string }) => Promise<{ systemPrompt: string }>;

function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    agent: { toolExecution: 'sequential' },
    sessionId: 'session-test',
    sessionManager: { getLeafId: () => null },
    prompt: async () => {},
    subscribe: () => () => {},
    compact: async (instructions?: string) => ({ instructions }),
    abort: async () => {},
    setModel: async () => {},
    setThinkingLevel: () => {},
    /**
     * DA1.30 — the member C3.385 taught the host to READ.
     *
     * `56ab8aeb1` made `handleSetThinkingLevel` publish the level Pi actually
     * holds after its own clamp (`packages/pi-agent-server/src/index.ts` reads
     * `piSession.thinkingLevel` twice: once for the previous level and once for
     * the effective one), and `compact()` passes the same member through. The
     * real session answers it — a `thinkingLevel` getter in the Pi SDK's
     * `dist/core/agent-session.d.ts` at the installed 0.84.4 — and this double
     * did not, so a host read here would get `undefined` from a member that is
     * never absent in production. `0ebcbe550` closed exactly this gap for
     * `packages/pi-agent-server/src/__tests__/pi-runtime-cwd-transaction.test.ts`,
     * where it was not preventive at all: that file failed 3 of 3 runs alone.
     *
     * This one is GREEN today — no case in this file drives a host path that
     * reads the level — so it is a double catching up with a seam rather than a
     * fix. It reads through `agent.state`, which is where every override in this
     * file that sets a level writes it (`setThinkingLevel: level => { agent.state.thinkingLevel = level }`),
     * so a case that sets and then reads gets the truth instead of `undefined`.
     * Optional throughout: an override may replace `agent` wholesale with an
     * object that has no `state`, and answering `undefined` there is the same
     * thing the real getter does for a session that has never been set.
     */
    get thinkingLevel(): unknown {
      return (this.agent as { state?: { thinkingLevel?: unknown } } | undefined)?.state?.thinkingLevel;
    },
    steer: async () => {},
    setAutoCompactionEnabled: () => {},
    autoCompactionEnabled: true,
    isCompacting: false,
    messages: [],
    dispose: () => {},
    ...overrides,
  };
}

function notebookManifest() {
  const binding = getPiToolBinding('notebook_edit');
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'generation-adapter',
    sessionKey: { workspaceId: 'workspace-adapter', sessionId: 'session-adapter' },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: [{
      descriptor: getHarnessToolDescriptor(binding.descriptorId),
      binding,
      source: { kind: 'piBuiltin', bindingId: binding.bindingName },
    }],
  };
  return finalizePiExecutionManifest(seed, []);
}

function fakeBindings(overrides: Partial<PiRuntimeBindings> = {}) {
  const calls = {
    auth: 0,
    modelRuntime: 0,
    modelRegistry: 0,
    settings: 0,
    settingsReload: 0,
    resourceLoader: 0,
    resourceReload: 0,
    createSession: 0,
    inMemory: [] as Array<string | undefined>,
    create: [] as Array<[string, string]>,
    continueRecent: [] as Array<[string, string]>,
    open: [] as Array<[string, string]>,
    forkFrom: [] as Array<[string, string, string]>,
    branch: [] as string[],
    order: [] as string[],
    loaderOptions: [] as unknown[],
    compactionSettings: [] as unknown[],
  };
  let extensionFactories: Array<(api: unknown) => unknown> = [];
  const session = fakeSession();
  const bindings: PiRuntimeBindings = {
    version: SUPPORTED_PI_RUNTIME_VERSION,
    credentialStoreInMemory: () => {
      calls.auth += 1;
      return { kind: 'credentials' } as never;
    },
    createModelRuntime: async credentials => {
      calls.modelRuntime += 1;
      return { kind: 'model-runtime', credentials } as never;
    },
    modelRegistryFromRuntime: modelRuntime => {
      calls.modelRegistry += 1;
      return { kind: 'registry', modelRuntime } as never;
    },
    sessionManager: {
      inMemory: cwd => {
        calls.inMemory.push(cwd);
        return { kind: 'memory', cwd } as never;
      },
      create: (cwd, sessionDir) => {
        calls.create.push([cwd, sessionDir]);
        return { kind: 'fresh', cwd, sessionDir } as never;
      },
      continueRecent: (cwd, sessionDir) => {
        calls.continueRecent.push([cwd, sessionDir]);
        return { kind: 'continue', cwd, sessionDir } as never;
      },
      open: (parentFile, cwd) => {
        calls.open.push([parentFile, cwd]);
        return {
          getEntry: (id: string) => id === 'entry-7' ? { id } : undefined,
        } as never;
      },
      forkFrom: (parentFile, cwd, sessionDir) => {
        calls.forkFrom.push([parentFile, cwd, sessionDir]);
        return {
          kind: 'fork',
          getEntry: (id: string) => ({ id }),
          getSessionFile: () => undefined,
          branch: (id: string) => calls.branch.push(id),
        } as never;
      },
    },
    settingsManagerInMemory: settings => {
      calls.settings += 1;
      calls.order.push('settings');
      calls.compactionSettings.push(settings);
      return {
        kind: 'settings',
        reload: async () => {
          calls.settingsReload += 1;
          calls.order.push('settingsReload');
        },
      } as never;
    },
    createResourceLoader: options => {
      calls.resourceLoader += 1;
      calls.order.push('resourceLoader');
      calls.loaderOptions.push(options);
      // `extensionFactories` is optional on the loader options (the SDK's own
      // `ResourceLoaderOptions`), so the spread guards it; the length pin below
      // (`toHaveLength(2 + PINNED_NESSY_FACTORIES.length)`) is the arm that goes
      // red if the adapter ever stops passing the field. The cast is the double's
      // own simplification — the SDK's `InlineExtension` union also allows a
      // `{ name, factory }` wrapper the adapter never produces.
      extensionFactories = [...(options.extensionFactories ?? [])] as Array<(api: unknown) => unknown>;
      return {
        kind: 'resource-loader',
        options,
        reload: async () => {
          calls.resourceReload += 1;
          calls.order.push('resourceReload');
          await options.settingsManager?.reload();
        },
      } as never;
    },
    createAgentSession: async () => {
      calls.createSession += 1;
      calls.order.push('createSession');
      return { session } as never;
    },
    ...overrides,
  };
  return { bindings, calls, session, getExtensionFactories: () => extensionFactories };
}

function fakePublicSurface() {
  const calls = { construction: 0 };
  class ResourceLoader {
    constructor() { calls.construction += 1; }
    async reload() {}
  }
  class CredentialStore {
    constructor() { calls.construction += 1; }
    async read() { return undefined; }
    async list() { return []; }
    async modify() { return undefined; }
    async delete() {}
  }
  class Registry {
    constructor() { calls.construction += 1; }
    find() { return undefined; }
    registerProvider() {}
    async getApiKeyAndHeaders() { return { ok: false, error: 'fake' }; }
  }
  const surface = {
    VERSION: SUPPORTED_PI_RUNTIME_VERSION,
    InMemoryCredentialStore: CredentialStore,
    ModelRuntime: { create: async () => { calls.construction += 1; return {} as never; } },
    ModelRegistry: Registry,
    SessionManager: {
      inMemory: () => { calls.construction += 1; return {} as never; },
      create: () => { calls.construction += 1; return {} as never; },
      continueRecent: () => { calls.construction += 1; return {} as never; },
      open: () => { calls.construction += 1; return {} as never; },
      forkFrom: () => { calls.construction += 1; return {} as never; },
    },
    SettingsManager: {
      create: () => { calls.construction += 1; return {} as never; },
      inMemory: () => { calls.construction += 1; return {} as never; },
    },
    DefaultResourceLoader: ResourceLoader,
    createAgentSession: async () => { calls.construction += 1; return {} as never; },
  } as unknown as PiRuntimePublicSurface;
  return { surface, calls };
}

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      files.push(...productionTypeScriptFiles(path));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

describe('PiRuntimeAdapter 0.84.3 contract', () => {
  it('orders the prompt and lifecycle built-ins before the closed curated registry', async () => {
    const fake = fakeBindings()
    const events: string[] = []
    const adapter = createPiRuntimeAdapter(fake.bindings)
    await adapter.createSession({
      cwd: '/workspace',
      registry: await adapter.createRegistry(),
      strategy: { kind: 'memory' },
      lifecycleEventSink: async event => { events.push(event) },
      getOriginalUserPrompt: () => 'original',
      sessionOptions: {} as never,
    })

    expect(fake.getExtensionFactories()).toHaveLength(2)
    expect(CURATED_PI_BUILD_MANIFEST.components).toEqual([
      { id: 'nessy.prompt-extension', kind: 'builtin' },
      { id: 'nessy.lifecycle-bridge', kind: 'builtin' },
      { id: 'nessy.deferred-mcp-extension', kind: 'builtin' },
    ])
    expect(events).toEqual([])
  })
  it('pins the supported Pi runtime to exact 0.87.1', () => {
    expect(SUPPORTED_PI_RUNTIME_VERSION).toBe('0.87.1');
  });

  it('fails before constructing runtime state on a wrong VERSION', () => {
    const wrong = fakeBindings({ version: '0.83.0' });
    // Built from the constant, not written out: a hand-typed version here
    // survived the 0.84.0 → 0.84.2 bump silently until the run caught it,
    // asserting that a refusal names a version we no longer support.
    expect(() => createPiRuntimeAdapter(wrong.bindings))
      .toThrow(new RegExp(SUPPORTED_PI_RUNTIME_VERSION.replace(/\./g, '\\.')));
    expect(wrong.calls.auth).toBe(0);
    expect(wrong.calls.createSession).toBe(0);
  });

  it('builds the model runtime offline and off the global models.json', async () => {
    // The two self-discovery surfaces Pi 0.84 added: `modelsPath` defaults to
    // the GLOBAL ~/.pi/agent/models.json and providers are wrapped in a pi.dev
    // catalog fetcher. Both must be opted out, and PI_OFFLINE is what keeps a
    // later `refresh()` (which defaults `allowNetwork` to the runtime's own
    // flag) from reaching the network.
    const seen: Array<Record<string, unknown> | undefined> = [];
    const surface = {
      ...fakePublicSurface().surface,
      ModelRuntime: {
        create: async (options?: Record<string, unknown>) => {
          seen.push(options);
          return {} as never;
        },
      },
    } as unknown as PiRuntimePublicSurface;
    const previousOffline = process.env.PI_OFFLINE;
    delete process.env.PI_OFFLINE;
    try {
      const adapter = createPiRuntimeAdapter(undefined, surface);
      await adapter.createRegistry();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ modelsPath: null, allowModelNetwork: false });
      expect(seen[0]).toHaveProperty('credentials');
      expect(String(process.env.PI_OFFLINE)).toBe('1');
    } finally {
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
    }
  });

  it('pins Pi 0.84.3 tool execution explicitly to parallel', async () => {
    const fake = fakeBindings();
    const adapter = createPiRuntimeAdapter(fake.bindings);
    const handle = await adapter.createSession({
      cwd: '/workspace',
      registry: await adapter.createRegistry(),
      strategy: { kind: 'memory' },
      sessionOptions: { tools: [] },
    });

    expect((handle.session.agent as { toolExecution: string }).toolExecution).toBe('parallel');
    handle.dispose();
  });

  it('seeds Pi SettingsManager with the resolved compaction policy', async () => {
    const fake = fakeBindings();
    const adapter = createPiRuntimeAdapter(fake.bindings);
    const handle = await adapter.createSession({
      cwd: '/workspace',
      registry: await adapter.createRegistry(),
      strategy: { kind: 'memory' },
      compaction: { enabled: false, reserveTokens: 100_000 },
      sessionOptions: { tools: [] },
    });

    expect(fake.calls.compactionSettings).toEqual([{
      compaction: { enabled: false, reserveTokens: 100_000 },
    }]);
    handle.dispose();
  });

  it('UB7.16 — passes an explicit cacheWarming through to the settings manager, and keeps the settings empty without one', async () => {
    const fake = fakeBindings();
    const adapter = createPiRuntimeAdapter(fake.bindings);
    const handle = await adapter.createSession({
      cwd: '/workspace',
      registry: await adapter.createRegistry(),
      strategy: { kind: 'memory' },
      cacheWarming: 'off',
      sessionOptions: { tools: [] },
    });
    handle.dispose();

    // The utility-session pin lands in the settings verbatim.
    expect(fake.calls.compactionSettings).toEqual([{ cacheWarming: 'off' }]);

    // Control: a caller that names nothing (every main-chat site) keeps the
    // empty settings shape — Pi's own `streaming` default applies, stated in
    // pi-session-settings.ts — and the existing empty-settings pin above stays
    // the enforcer of that shape.
    const plain = fakeBindings();
    const plainAdapter = createPiRuntimeAdapter(plain.bindings);
    const plainHandle = await plainAdapter.createSession({
      cwd: '/workspace',
      registry: await plainAdapter.createRegistry(),
      strategy: { kind: 'memory' },
      sessionOptions: { tools: [] },
    });
    plainHandle.dispose();
    expect(plain.calls.compactionSettings).toEqual([{}]);
  });

  it('UB2.15 — seeds an explicit providerRetry block into the settings at creation, as a copy, and nothing without one', async () => {
    const block = Object.freeze({ maxRetries: 2, maxRetryDelayMs: 10_000 });
    const fake = fakeBindings();
    const adapter = createPiRuntimeAdapter(fake.bindings);
    const handle = await adapter.createSession({
      cwd: '/workspace',
      registry: await adapter.createRegistry(),
      strategy: { kind: 'memory' },
      providerRetry: block,
      sessionOptions: { tools: [] },
    });
    handle.dispose();

    // The block is in the settings `createAgentSession` is built from — the
    // only place its `maxRetryDelayMs` cap binds (gateway-retry-settings.ts).
    expect(fake.calls.compactionSettings).toEqual([{ retry: { provider: { maxRetries: 2, maxRetryDelayMs: 10_000 } } }]);
    // A copy: the frozen profile object never becomes Pi's own settings state.
    const seeded = fake.calls.compactionSettings[0] as { retry: { provider: unknown } };
    expect(seeded.retry.provider).not.toBe(block);

    // Control: the UB7.16 arm above already pins a caller naming nothing to `{}`
    // (every main-chat site); a caller naming only cacheWarming gets no retry key.
    const plain = fakeBindings();
    const plainAdapter = createPiRuntimeAdapter(plain.bindings);
    const plainHandle = await plainAdapter.createSession({
      cwd: '/workspace',
      registry: await plainAdapter.createRegistry(),
      strategy: { kind: 'memory' },
      cacheWarming: 'off',
      sessionOptions: { tools: [] },
    });
    plainHandle.dispose();
    expect(plain.calls.compactionSettings).toEqual([{ cacheWarming: 'off' }]);
  });

  it('refreshes deferred MCP tools between model turns of one prompt', async () => {
    const faux = registerFauxProvider({ models: [{ id: 'deferred-mcp-same-request' }] });
    const capabilityKey = 'mcp:bulk';
    const generation = 'generation-same-request';
    const definitions = Array.from({ length: 49 }, (_, index) => ({
      name: `mcp__bulk__tool_${index}`,
      description: `Deferred tool ${index}`,
      parameters: { type: 'object', additionalProperties: false },
      async execute() {
        throw new Error('Deferred proxy candidates must execute through ToolExecutor');
      },
    }));
    const manifest = finalizePiExecutionManifest({
      surfaceVersion: 2,
      snapshotGeneration: generation,
      sessionKey: { workspaceId: 'workspace-same-request', sessionId: 'session-same-request' },
      provenance: [{ capabilityKey, generation }],
      mcpSources: [{ wireName: 'bulk', capabilityKey, generation }],
      orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
      staticTools: PI_TOOL_BINDINGS
        .filter(binding => PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName] !== undefined)
        .map(binding => ({
          descriptor: getHarnessToolDescriptor(binding.descriptorId),
          binding,
          source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
          modelContractHash: PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName]!,
        })),
    }, definitions.map(definition => ({
      bindingName: definition.name,
      description: definition.description,
      inputSchema: definition.parameters,
      modelSchemaVersion: 1,
      bindingSchemaVersion: 1,
      provenance: { capabilityKey, generation },
    })), { deferredMcpEnabled: true });
    const loaded = new Set<string>();
    let controller: ReturnType<typeof createDeferredMcpRegistrationController>;
    const surface = buildDeferredMcpToolSurface({
      enabled: true,
      generation,
      proxyTools: definitions as never,
      loadedToolNames: loaded,
      onLoadToolNames: names => names.forEach(name => controller.register(name)),
    });
    const executions: string[] = [];
    controller = createDeferredMcpRegistrationController({
      candidates: definitions as never,
      manifest,
      responseEpoch: 1, progressBridge: createPiToolProgressBridge(), // F1.1128: required since F1.925
      toolExecutor: {
        async execute(request: ToolExecutionRequest) {
          executions.push(request.presentedName);
          return {
            outcome: 'success',
            result: { content: `executed ${request.presentedName}` },
          };
        },
      } as never,
    });

    const target = definitions[0]!.name;
    const providerTools: string[][] = [];
    // 0.87 moved the offered set into the transcript: `getCurrentTools` replays the
    // system-message deltas the loop declared — exactly what the request carries.
    const offeredTools = (context: TranscriptContext) => getCurrentTools(context.messages).map(tool => tool.name);
    faux.setResponses([
      context => {
        providerTools.push(offeredTools(context));
        return fauxAssistantMessage(fauxToolCall('mcp__tool_search', { query: target }), { stopReason: 'toolUse' });
      },
      context => {
        providerTools.push(offeredTools(context));
        return fauxAssistantMessage(fauxToolCall('mcp__tool_load', { name: target }), { stopReason: 'toolUse' });
      },
      context => {
        providerTools.push(offeredTools(context));
        return fauxAssistantMessage(fauxToolCall(target, {}), { stopReason: 'toolUse' });
      },
      context => {
        providerTools.push(offeredTools(context));
        return fauxAssistantMessage('done');
      },
    ]);

    const fake = fakeBindings({
      createAgentSession: async options => {
        const agent = new Agent({
          initialState: {
            model: faux.getModel('deferred-mcp-same-request')!,
            systemPrompt: 'Search, load, and execute the requested MCP tool.',
            tools: [...(options.customTools ?? [])] as never,
          },
          convertToLlm: messages => messages as never,
          // The stream the run used anyway: the SDK's entry module installs
          // this exact function as pi-agent-core's default at load
          // (`setDefaultStreamFn(streamSimple)`), so naming it here only makes
          // the required `AgentOptions.streamFn` field honest.
          streamFn: streamSimple,
        });
        for (const factory of fake.getExtensionFactories()) {
          await factory({
            on() {},
            registerTool(tool: ToolDefinition) {
              agent.state.tools = [
                ...agent.state.tools.filter(candidate => candidate.name !== tool.name),
                tool as never,
              ];
            },
          } as never);
        }
        return {
          session: fakeSession({
            agent,
            messages: agent.state.messages,
            prompt: (message: string) => agent.prompt(message),
            subscribe: agent.subscribe.bind(agent),
            abort: () => agent.abort(),
            dispose: () => agent.abort(),
            setModel: async (model: unknown) => { agent.state.model = model as never; },
            setThinkingLevel: (level: unknown) => { agent.state.thinkingLevel = level as never; },
          }),
        } as never;
      },
    });
    const adapter = createPiRuntimeAdapter(fake.bindings);
    try {
      const handle = await adapter.createSession({
        cwd: '/workspace',
        registry: await adapter.createRegistry(),
        strategy: { kind: 'memory' },
        executionManifest: manifest,
        responseEpoch: 1,
        deferredMcpExtension: controller.factory,
        sessionOptions: {
          customTools: surface.tools,
          tools: surface.tools.map(tool => tool.name),
        },
      });

      await handle.session.prompt('Find and run the deferred MCP tool.');

      expect(providerTools).toHaveLength(4);
      expect(providerTools[0]).not.toContain(target);
      expect(providerTools[1]).not.toContain(target);
      expect(providerTools[2]).toContain(target);
      expect(executions).toEqual([target]);
      handle.dispose();
    } finally {
      faux.unregister();
    }
  });

  /**
   * **RE-SCOPED 2026-08-21 by T7, deliberately, and the narrowing is the
   * point.** `docs/architecture/runtime-capability-gaps.md` cited this test as
   * the proof of the Pi row's *"we choose where the JSONL lives and which file
   * to open, **never its shape**"* — and that clause no longer holds in full:
   * a first cross-runtime switch into Pi now AUTHORS a v3 session file for the
   * subprocess to fork from (the new DECISION row beside it records why).
   *
   * What this test proves is the half that survives, and it is the half that
   * matters most: **a session file we did not author is never rewritten.** The
   * strategy here is `reopen` — the resume path, over a file the vendor owns —
   * and the legacy tool-call fix-up stays in memory, leaving the bytes on disk
   * untouched. The carry file T7 writes is a different file, at a different
   * path, created by us and read exactly once; it is verified by its own
   * writer's read-back and by `pi-carry-session.test.ts`, not here.
   *
   * Do not widen this back into "we never write the format" — that claim is
   * now false, and a test asserting it would be asserting the wrong thing.
   */
  it('normalizes legacy structured tool calls in memory without rewriting a session file we did not author', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-adapter-history-'));
    const sessionFile = join(root, 'session.jsonl');
    const stored = '{"type":"message","name":"NotebookEdit"}\n';
    writeFileSync(sessionFile, stored);
    const messages = [{
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'NotebookEdit', arguments: {} }],
    }];
    const fake = fakeBindings({
      createAgentSession: async () => ({ session: fakeSession({ messages }) }) as never,
    });
    const adapter = createPiRuntimeAdapter(fake.bindings);
    const handle = await adapter.createSession({
      cwd: '/workspace-next',
      registry: await adapter.createRegistry(),
      strategy: { kind: 'reopen', sessionFile },
      executionManifest: notebookManifest(),
      sessionOptions: { tools: [] },
    });

    expect(messages[0]!.content[0]).toMatchObject({
      name: 'notebook_edit',
      originalName: 'NotebookEdit',
    });
    expect(readFileSync(sessionFile, 'utf8')).toBe(stored);
    handle.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('fails closed and disposes when the parallel execution assignment does not stick', async () => {
    let disposed = 0;
    const agent = {} as { toolExecution: string };
    Object.defineProperty(agent, 'toolExecution', {
      get: () => 'sequential',
      set: () => {},
      enumerable: true,
    });
    const fake = fakeBindings({
      createAgentSession: async () => ({
        session: fakeSession({ agent, dispose: () => { disposed += 1; } }),
      }) as never,
    });
    const adapter = createPiRuntimeAdapter(fake.bindings);

    await expect(adapter.createSession({
      cwd: '/workspace',
      registry: await adapter.createRegistry(),
      strategy: { kind: 'memory' },
      sessionOptions: { tools: [] },
    })).rejects.toThrow(/parallel tool execution/);
    expect(disposed).toBe(1);
  });

  it('validates the initial Pi toolExecution shape before pinning parallel', async () => {
    for (const initial of [undefined, 'serial']) {
      let disposed = 0;
      const fake = fakeBindings({
        createAgentSession: async () => ({
          session: fakeSession({
            agent: initial === undefined ? {} : { toolExecution: initial },
            dispose: () => { disposed += 1; },
          }),
        }) as never,
      });
      const adapter = createPiRuntimeAdapter(fake.bindings);

      await expect(adapter.createSession({
        cwd: '/workspace',
        registry: await adapter.createRegistry(),
        strategy: { kind: 'memory' },
        sessionOptions: { tools: [] },
      })).rejects.toThrow(/toolExecution/);
      expect(disposed, String(initial)).toBe(1);
    }

    for (const initial of ['sequential', 'parallel'] as const) {
      const fake = fakeBindings({
        createAgentSession: async () => ({
          session: fakeSession({ agent: { toolExecution: initial } }),
        }) as never,
      });
      const adapter = createPiRuntimeAdapter(fake.bindings);
      const handle = await adapter.createSession({
        cwd: '/workspace',
        registry: await adapter.createRegistry(),
        strategy: { kind: 'memory' },
        sessionOptions: { tools: [] },
      });
      expect((handle.session.agent as { toolExecution: string }).toolExecution).toBe('parallel');
      handle.dispose();
    }
  });

  it('validates every required binding and SessionManager strategy before construction', () => {
    const missingBindings: Array<{
      name: string;
      remove(bindings: PiRuntimeBindings): void;
    }> = [
      { name: 'credentialStoreInMemory', remove: bindings => { bindings.credentialStoreInMemory = undefined as never; } },
      { name: 'createModelRuntime', remove: bindings => { bindings.createModelRuntime = undefined as never; } },
      { name: 'modelRegistryFromRuntime', remove: bindings => { bindings.modelRegistryFromRuntime = undefined as never; } },
      { name: 'sessionManager', remove: bindings => { bindings.sessionManager = undefined as never; } },
      { name: 'sessionManager.inMemory', remove: bindings => { bindings.sessionManager.inMemory = undefined as never; } },
      { name: 'sessionManager.create', remove: bindings => { bindings.sessionManager.create = undefined as never; } },
      { name: 'sessionManager.continueRecent', remove: bindings => { bindings.sessionManager.continueRecent = undefined as never; } },
      { name: 'sessionManager.open', remove: bindings => { bindings.sessionManager.open = undefined as never; } },
      { name: 'sessionManager.forkFrom', remove: bindings => { bindings.sessionManager.forkFrom = undefined as never; } },
      { name: 'settingsManagerInMemory', remove: bindings => { bindings.settingsManagerInMemory = undefined as never; } },
      { name: 'createResourceLoader', remove: bindings => { bindings.createResourceLoader = undefined as never; } },
      { name: 'createAgentSession', remove: bindings => { bindings.createAgentSession = undefined as never; } },
    ];

    for (const { name, remove } of missingBindings) {
      const missing = fakeBindings();
      remove(missing.bindings);
      expect(() => createPiRuntimeAdapter(missing.bindings)).toThrow(name);
      expect({
        auth: missing.calls.auth,
        modelRuntime: missing.calls.modelRuntime,
        modelRegistry: missing.calls.modelRegistry,
        settings: missing.calls.settings,
        settingsReload: missing.calls.settingsReload,
        resourceLoader: missing.calls.resourceLoader,
        resourceReload: missing.calls.resourceReload,
        createSession: missing.calls.createSession,
      }).toEqual({
        auth: 0,
        modelRuntime: 0,
        modelRegistry: 0,
        settings: 0,
        settingsReload: 0,
        resourceLoader: 0,
        resourceReload: 0,
        createSession: 0,
      });
    }
  });

  it('validates the selected public Pi surface before wrapping or constructing it', () => {
    const missingSurfaces: Array<{
      name: string;
      remove(surface: PiRuntimePublicSurface): void;
    }> = [
      { name: 'InMemoryCredentialStore', remove: surface => { surface.InMemoryCredentialStore = undefined as never; } },
      {
        name: 'InMemoryCredentialStore.prototype.modify',
        remove: surface => { surface.InMemoryCredentialStore.prototype.modify = undefined as never; },
      },
      { name: 'ModelRuntime.create', remove: surface => { surface.ModelRuntime = undefined as never; } },
      { name: 'ModelRuntime.create', remove: surface => { surface.ModelRuntime.create = undefined as never; } },
      { name: 'ModelRegistry', remove: surface => { surface.ModelRegistry = undefined as never; } },
      {
        name: 'ModelRegistry.prototype.getApiKeyAndHeaders',
        remove: surface => { surface.ModelRegistry.prototype.getApiKeyAndHeaders = undefined as never; },
      },
      { name: 'SessionManager.inMemory', remove: surface => { surface.SessionManager = undefined as never; } },
      { name: 'SessionManager.inMemory', remove: surface => { surface.SessionManager.inMemory = undefined as never; } },
      { name: 'SessionManager.create', remove: surface => { surface.SessionManager.create = undefined as never; } },
      { name: 'SessionManager.continueRecent', remove: surface => { surface.SessionManager.continueRecent = undefined as never; } },
      { name: 'SessionManager.open', remove: surface => { surface.SessionManager.open = undefined as never; } },
      { name: 'SessionManager.forkFrom', remove: surface => { surface.SessionManager.forkFrom = undefined as never; } },
      { name: 'SettingsManager.inMemory', remove: surface => { surface.SettingsManager = undefined as never; } },
      {
        name: 'SettingsManager.inMemory',
        remove: surface => {
          (surface.SettingsManager as unknown as { inMemory?: unknown }).inMemory = undefined;
        },
      },
      { name: 'DefaultResourceLoader', remove: surface => { surface.DefaultResourceLoader = undefined as never; } },
      {
        name: 'DefaultResourceLoader.prototype.reload',
        remove: surface => { surface.DefaultResourceLoader.prototype.reload = undefined as never; },
      },
      { name: 'createAgentSession', remove: surface => { surface.createAgentSession = undefined as never; } },
    ];

    for (const { name, remove } of missingSurfaces) {
      const missing = fakePublicSurface();
      remove(missing.surface);
      expect(() => createPiRuntimeAdapter(undefined, missing.surface)).toThrow(name);
      expect(missing.calls.construction, name).toBe(0);
    }
  });

  it('uses empty in-memory settings with fail-closed project trust', async () => {
    const calls = {
      settings: [] as Array<[unknown, unknown]>,
      loaderOptions: [] as unknown[],
    };
    const settingsManager = {
      reload: async () => {},
      isProjectTrusted: () => false,
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({}),
    };
    class ResourceLoader {
      constructor(options: unknown) { calls.loaderOptions.push(options); }
      async reload() {}
    }
    class CredentialStore {
      async read() { return undefined }
      async list() { return [] }
      async modify() { return undefined }
      async delete() {}
    }
    class Registry {
      find() { return undefined }
      registerProvider() {}
      async getApiKeyAndHeaders() { return { ok: false, error: 'fake' } }
    }
    const surface = {
      VERSION: SUPPORTED_PI_RUNTIME_VERSION,
      InMemoryCredentialStore: CredentialStore,
      ModelRuntime: { create: async () => ({}) },
      ModelRegistry: Registry,
      SessionManager: {
        inMemory: () => ({}),
        create: () => ({}),
        continueRecent: () => ({}),
        open: () => ({}),
        forkFrom: () => ({}),
      },
      SettingsManager: {
        inMemory: (settings: unknown, options: unknown) => {
          calls.settings.push([settings, options]);
          return settingsManager;
        },
      },
      DefaultResourceLoader: ResourceLoader,
      createAgentSession: async () => ({ session: fakeSession() }),
    } as unknown as PiRuntimePublicSurface;

    const adapter = createPiRuntimeAdapter(undefined, surface);
    const handle = await adapter.createSession({
      cwd: '/hostile-workspace',
      agentDir: fixtureAgentDir('hostile-agent-dir'),
      registry: await adapter.createRegistry(),
      strategy: { kind: 'memory' },
      sessionOptions: { tools: [] },
    });
    handle.dispose();

    expect(calls.settings).toEqual([[{}, { projectTrusted: false }]]);
    expect(calls.loaderOptions).toHaveLength(1);
    expect(calls.loaderOptions[0]).toMatchObject({
      cwd: '/hostile-workspace',
      agentDir: fixtureAgentDir('hostile-agent-dir'),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
  });

  it('loads exactly promptExtension then the immutable curated registry with closed resource overrides', async () => {
    const fake = fakeBindings();
    const adapter = createPiRuntimeAdapter(fake.bindings);
    const handle = await adapter.createSession({
      cwd: '/hostile-workspace',
      agentDir: fixtureAgentDir('hostile-agent-dir'),
      registry: await adapter.createRegistry(),
      strategy: { kind: 'memory' },
      sessionOptions: { tools: [] },
    });
    handle.dispose();

    expect(PINNED_NESSY_FACTORIES).toEqual([]);
    expect(PINNED_NESSY_RESOURCES).toEqual([]);
    expect(CURATED_PI_BUILD_MANIFEST.components).toEqual([
      { id: 'nessy.prompt-extension', kind: 'builtin' },
      { id: 'nessy.lifecycle-bridge', kind: 'builtin' },
      { id: 'nessy.deferred-mcp-extension', kind: 'builtin' },
    ]);
    expect(fake.getExtensionFactories()).toHaveLength(2 + PINNED_NESSY_FACTORIES.length);
    const options = fake.calls.loaderOptions[0] as Record<string, (...args: unknown[]) => unknown>;
    expect(options.skillsOverride!({ skills: ['ambient'], diagnostics: ['ambient'] })).toEqual({ skills: [], diagnostics: [] });
    expect(options.promptsOverride!({ prompts: ['ambient'], diagnostics: ['ambient'] })).toEqual({ prompts: [], diagnostics: [] });
    expect(options.themesOverride!({ themes: ['ambient'], diagnostics: ['ambient'] })).toEqual({ themes: [], diagnostics: [] });
    expect(options.agentsFilesOverride!({ agentsFiles: [{ path: '/ambient', content: 'ambient' }] })).toEqual({ agentsFiles: [] });
  });

  it('materializes pinned memory without injecting an unselected skill or MCP resource metadata', async () => {
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const contents = new Map([
      ['skill', '# Selected skill'],
      ['rule', 'Always preserve user work.'],
    ]);
    let pathResolutions = 0;
    const native = (resourceId: string) => ({
      source: 'workspace',
      scope: { kind: 'workspace', workspaceId: 'workspace-a' },
      resourceId,
      absolutePath: `/not-discovered/${resourceId}`,
      revision: 'pinned',
      contentHash: digest(contents.get(resourceId)!),
    });
    const resources = await materializePiContextResources({
      view: {
        generation: 'generation-7',
        sources: [], mcpServers: [], hooks: [], automations: [], agents: [], permissionLayers: [], commands: [], apps: [],
        skills: [{ key: 'skill:review', logicalName: 'review', description: '', selectedAsUnqualifiedAlias: true, resource: native('skill') }],
        promptLayers: [],
        memory: [{ key: 'rule:safety', resource: native('rule'), readOnly: true, format: 'rule' }],
      } as never,
      materializer: {
        assertActive: () => {},
        verifyPlugin: async () => {},
        resolvePath: async () => { pathResolutions += 1; return '/unexpected'; },
        readText: async resource => contents.get((resource as { resourceId: string }).resourceId)!,
        resolveCredential: () => { throw new CapabilityMaterializationError('credential-not-ready') },
      },
      mcpResources: [{ sourceSlug: 'hostile', kind: 'resource', value: { uri: 'nessy://hostile', description: 'MCP_RESOURCE_INJECTION_SENTINEL' } }],
    });

    expect(pathResolutions).toBe(0);
    expect(resources).toHaveLength(1);
    expect(Object.isFrozen(resources)).toBe(true);
    expect(resources.every(Object.isFrozen)).toBe(true);
    expect(resources.map(resource => resource.provenance)).toEqual([
      'rule:safety@generation-7',
    ]);
    expect(resources[0]?.sha256).toBe(digest('Always preserve user work.'));
    expect(resources.some(resource => resource.content.includes('# Selected skill'))).toBe(false);
    expect(resources.some(resource => resource.content.includes('MCP_RESOURCE_INJECTION_SENTINEL'))).toBe(false);

    const fake = fakeBindings();
    const adapter = createPiRuntimeAdapter(fake.bindings);
    const handle = await adapter.createSession({
      cwd: '/workspace',
      registry: await adapter.createRegistry(),
      strategy: { kind: 'memory' },
      contextResources: resources,
      sessionOptions: { tools: [] },
    });
    handle.dispose();

    const options = fake.calls.loaderOptions[0] as Record<string, (...args: unknown[]) => unknown>;
    const projected = options.agentsFilesOverride!({ agentsFiles: [] }) as {
      agentsFiles: Array<{ content: string; sourceInfo: { source: string } }>
    };
    expect(projected.agentsFiles.map(resource => resource.sourceInfo.source)).toEqual(resources.map(resource => resource.provenance));
    expect(projected.agentsFiles.map(resource => digest(resource.content))).toEqual(resources.map(resource => resource.sha256));
    expect(projected.agentsFiles.some(resource => resource.content.includes('# Selected skill'))).toBe(false);
    expect(projected.agentsFiles.some(resource => resource.content.includes('MCP_RESOURCE_INJECTION_SENTINEL'))).toBe(false);
  });

  it('does not materialize an available plugin skill until explicit invocation', async () => {
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const content = '# Marketplace skill\n';
    let reads = 0;
    const resources = await materializePiContextResources({
      view: {
        generation: 'generation-plugin',
        sources: [], mcpServers: [], hooks: [], automations: [], agents: [], permissionLayers: [], commands: [], apps: [],
        skills: [{
          key: 'plugin:skill:review',
          logicalName: 'review',
          description: '',
          selectedAsUnqualifiedAlias: true,
          resource: {
            pluginInstanceId: 'plugin://skills-market/review@1.0.0#bundle',
            relativePath: 'skills/review/SKILL.md',
            contentHash: digest('whole normalized bundle'),
          },
        }],
        promptLayers: [],
        memory: [],
      } as never,
      materializer: {
        assertActive: () => {},
        verifyPlugin: async () => {},
        resolvePath: async () => '/unexpected',
        readText: async () => { reads += 1; return content; },
        resolveCredential: () => { throw new CapabilityMaterializationError('credential-not-ready') },
      },
      mcpResources: [],
    });

    expect(reads).toBe(0);
    expect(resources).toEqual([]);
  });

  it('threads the exact session executor and response epoch into curated composition', async () => {
    const fake = fakeBindings();
    const toolExecutor: ToolExecutor = { execute: async request => ({
      executionId: request.executionId,
      semanticId: request.semanticId,
      decisionId: 'not-requested',
      isolationProfile: 'no-host-isolation',
      manifestGeneration: request.manifestIdentity.generation,
      responseEpoch: request.manifestIdentity.responseEpoch,
      effect: 'read',
      startedAt: 1,
      completedAt: 2,
      outcome: 'success',
      result: { content: '', isError: false },
    }) };
    const adapter = createPiRuntimeAdapter(fake.bindings);
    const handle = await adapter.createSession({
      cwd: '/workspace',
      registry: await adapter.createRegistry(),
      strategy: { kind: 'memory' },
      executionManifest: notebookManifest(),
      toolExecutor,
      responseEpoch: 9,
      sessionOptions: { tools: [] },
    });
    handle.dispose();

    const adapterSource = readFileSync(fileURLToPath(new URL('./pi-runtime-adapter.ts', import.meta.url)), 'utf8');
    expect(adapterSource).toContain('options.toolExecutor')
    expect(adapterSource).toContain('options.responseEpoch')
  });

  it('passes only the construction-time verified signed-root capability to the pinned resource loader', async () => {
    let readPropertyAccesses = 0;
    const capability = Object.defineProperty({}, 'read', {
      get() {
        readPropertyAccesses += 1;
        return () => { throw new Error('production registry is empty'); };
      },
    }) as VerifiedSignedBundleRootCapability;
    const fake = fakeBindings();
    const adapter = createPiRuntimeAdapter(fake.bindings, undefined, {
      verifiedSignedBundleRoot: capability,
    });
    const handle = await adapter.createSession({
      cwd: '/workspace',
      registry: await adapter.createRegistry(),
      strategy: { kind: 'memory' },
      sessionOptions: { tools: [] },
    });
    handle.dispose();
    expect(readPropertyAccesses).toBe(1);
    expect(fake.getExtensionFactories()).toHaveLength(2);
  });

  it('ignores hostile workspace settings and local extension sources on the real Pi surface', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-pi-adapter-hostile-settings-'));
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const projectConfigDir = join(cwd, '.pi');
    const localPackageDir = join(projectConfigDir, 'hostile-package');
    const extensionPath = join(projectConfigDir, 'hostile-extension.js');
    const packageExtensionPath = join(localPackageDir, 'extension.js');
    const markerPath = join(root, 'hostile-loaded');
    try {
      mkdirSync(projectConfigDir, { recursive: true });
      mkdirSync(localPackageDir, { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      const markerSource = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markerPath)}, 'loaded');\nexport default () => {};\n`;
      writeFileSync(extensionPath, markerSource);
      writeFileSync(packageExtensionPath, markerSource);
      writeFileSync(join(localPackageDir, 'package.json'), JSON.stringify({
        name: 'hostile-local-package',
        version: '1.0.0',
        pi: { extensions: ['./extension.js'] },
      }));
      const settingsPath = join(projectConfigDir, 'settings.json');
      const settings = JSON.stringify({
        packages: ['./hostile-package'],
        extensions: ['./hostile-extension.js'],
      });
      writeFileSync(settingsPath, settings);

      const adapter = createPiRuntimeAdapter();
      const handle = await adapter.createSession({
        cwd,
        agentDir,
        registry: await adapter.createRegistry(),
        strategy: { kind: 'memory' },
        sessionOptions: { tools: [] },
      });
      handle.dispose();

      expect(existsSync(markerPath)).toBe(false);
      expect(readFileSync(settingsPath, 'utf8')).toBe(settings);
      expect(readFileSync(extensionPath, 'utf8')).toBe(markerSource);
      expect(readFileSync(packageExtensionPath, 'utf8')).toBe(markerSource);
      expect(readdirSync(agentDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates one registry and uses memory, continue, and anchored fork strategies', async () => {
    const fake = fakeBindings();
    const adapter = createPiRuntimeAdapter(fake.bindings);
    const registry = await adapter.createRegistry();
    expect(fake.calls.auth).toBe(1);
    expect(fake.calls.modelRuntime).toBe(1);
    expect(fake.calls.modelRegistry).toBe(1);

    for (const strategy of [
      { kind: 'memory' as const },
      { kind: 'continue' as const, sessionDir: '/sessions/main' },
      { kind: 'fresh' as const, sessionDir: '/sessions/main' }, // UA12.217 — the post-/clear posture builds a NEW session
      { kind: 'fork' as const, sessionDir: '/sessions/child', parentSessionFile: '/sessions/parent/session.jsonl', anchorEntryId: 'entry-7' },
    ]) {
      const handle = await adapter.createSession({
        cwd: '/workspace',
        registry,
        strategy,
        sessionOptions: { tools: [] },
      });
      expect(handle.session).toBe(fake.session as never);
      handle.dispose();
    }

    expect(fake.calls.inMemory).toEqual(['/workspace']);
    expect(fake.calls.create).toEqual([['/workspace', '/sessions/main']]);
    expect(fake.calls.continueRecent).toEqual([['/workspace', '/sessions/main']]);
    expect(fake.calls.open).toEqual([['/sessions/parent/session.jsonl', '/workspace']]);
    expect(fake.calls.forkFrom).toEqual([['/sessions/parent/session.jsonl', '/workspace', '/sessions/child']]);
    expect(fake.calls.branch).toEqual(['entry-7']);
  });

  it('reopens the exact persisted Pi session under a different cwd without losing history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-pi-adapter-reopen-'));
    const oldCwd = join(root, 'old-cwd');
    const nextCwd = join(root, 'next-cwd');
    const sessionDir = join(root, 'sessions');
    const agentDir = join(root, 'agent');
    mkdirSync(oldCwd, { recursive: true });
    mkdirSync(nextCwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    try {
      const persisted = SessionManager.create(oldCwd, sessionDir);
      persisted.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: 'history-before-cwd-change' }],
        timestamp: Date.now(),
      } as never);
      persisted.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'history-answer-before-cwd-change' }],
        timestamp: Date.now(),
      } as never);
      const sessionFile = persisted.getSessionFile();
      if (!sessionFile) throw new Error('expected persisted Pi session file');

      const adapter = createPiRuntimeAdapter();
      const handle = await adapter.createSession({
        cwd: nextCwd,
        agentDir,
        registry: await adapter.createRegistry(),
        strategy: { kind: 'reopen', sessionFile } as never,
        sessionOptions: { tools: [] },
      });

      expect((handle as unknown as { sessionFile?: string }).sessionFile).toBe(sessionFile);
      expect(JSON.stringify(handle.session.messages)).toContain('history-before-cwd-change');
      expect(JSON.stringify(handle.session.messages)).toContain('history-answer-before-cwd-change');
      handle.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reloads one SettingsManager before creation and preserves prompt replacement across turns', async () => {
    const seenPrompts: string[] = [];
    let beforeAgentStart: PromptHook | undefined;
    const fake = fakeBindings({
      createAgentSession: async () => {
        fake.calls.createSession += 1;
        fake.calls.order.push('createSession');
        return {
          session: fakeSession({
            prompt: async () => {
              seenPrompts.push((await beforeAgentStart!({ systemPrompt: 'PI_DEFAULT' })).systemPrompt);
            },
          }),
        } as never;
      },
    });
    const adapter = createPiRuntimeAdapter(fake.bindings);
    const handle = await adapter.createSession({
      cwd: '/workspace',
      registry: await adapter.createRegistry(),
      strategy: { kind: 'memory' },
      agentDir: fixtureAgentDir('session/.pi-agent'),
      systemPrompt: 'FIRST',
      sessionOptions: { tools: [] },
    });

    const factory = fake.getExtensionFactories()[0]!;
    await factory({
      on(event: string, handler: PromptHook) {
        if (event === 'before_agent_start') beforeAgentStart = handler;
      },
    });
    await handle.session.prompt('one');
    handle.setSystemPrompt('SECOND');
    await handle.session.prompt('two');

    // F1.907 — each replacement also carries Pi's own working-directory line,
    // taken from the adapter's `cwd` when the event (this fake) has no options.
    expect(seenPrompts).toEqual([
      'FIRST\nCurrent working directory: /workspace\n',
      'SECOND\nCurrent working directory: /workspace\n',
    ]);
    expect(fake.calls.settings).toBe(1);
    expect(fake.calls.settingsReload).toBe(1);
    expect(fake.calls.resourceLoader).toBe(1);
    expect(fake.calls.resourceReload).toBe(1);
    expect(fake.calls.order).toEqual([
      'settings', 'resourceLoader', 'resourceReload', 'settingsReload',
      'createSession',
    ]);
  });

  describe('F1.907 · Pi\'s own working-directory line survives the host prompt replacement', () => {
    type StartHook = (event: unknown) => unknown;
    type MidRunAgent = {
      prepareNextTurnWithContext(turn: unknown): Promise<{ context: { systemPrompt?: string } }>;
      transformContext(messages: Array<{ role: string; content: string; timestamp: number }>): Promise<Array<{ role: string; content: unknown }>>;
    };

    async function startSession(systemPrompt: string | undefined) {
      let beforeAgentStart: StartHook | undefined;
      const agent = { toolExecution: 'sequential', state: { tools: [] as unknown[] } };
      const fake = fakeBindings({
        createAgentSession: async () => ({ session: fakeSession({ agent }) }) as never,
      });
      const adapter = createPiRuntimeAdapter(fake.bindings);
      const handle = await adapter.createSession({
        cwd: '/adapter/cwd',
        registry: await adapter.createRegistry(),
        strategy: { kind: 'memory' },
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
        sessionOptions: { tools: [] },
      });
      await fake.getExtensionFactories()[0]!({
        on(event: string, handler: StartHook) {
          if (event === 'before_agent_start') beforeAgentStart = handler;
        },
      });
      return { handle, agent: agent as unknown as MidRunAgent, beforeAgentStart: beforeAgentStart! };
    }

    it('appends the cwd Pi hands before_agent_start, on the request start and on the next model call', async () => {
      const { handle, agent, beforeAgentStart } = await startSession('HOST PROMPT');

      // Pi's value wins over the adapter's own `cwd`, and a Windows path is
      // spelled with forward slashes exactly as Pi's own prompt spells it.
      const started = await beforeAgentStart({
        systemPrompt: 'PI_DEFAULT\nCurrent working directory: C:/pi/own',
        systemPromptOptions: { cwd: 'C:\\pi\\own' },
      }) as { systemPrompt: string };
      expect(started.systemPrompt).toBe('HOST PROMPT\nCurrent working directory: C:/pi/own\n');

      // F1.838's mid-request path carries the same line, not the bare host prompt.
      // 0.87: the loop no longer reads `context.systemPrompt`, and Pi's forced projection
      // re-reads `_runSystemPromptOptions`, which Pi rebuilds per turn — so the mid-request
      // update re-renders the projected head through the `transformContext` seam, the same
      // seam Pi's own projection runs on.
      handle.setSystemPrompt('HOST PROMPT 2');
      const transformed = await agent.transformContext([
        { role: 'system', content: 'PI_DEFAULT\nCurrent working directory: C:/pi/own', timestamp: 0 },
        { role: 'user', content: 'hi', timestamp: 0 },
      ]);
      expect(transformed[0]!.content).toBe('HOST PROMPT 2\nCurrent working directory: C:/pi/own\n');
      expect(transformed[1]!.role).toBe('user');
      handle.dispose();
    });

    it('leaves Pi its own prompt, which already carries the line, when the host sets none', async () => {
      const { handle, agent, beforeAgentStart } = await startSession(undefined);

      expect(await beforeAgentStart({
        systemPrompt: 'PI_DEFAULT\nCurrent working directory: /pi/own',
        systemPromptOptions: { cwd: '/pi/own' },
      })).toBeUndefined();
      const next = await agent.prepareNextTurnWithContext({ context: { systemPrompt: 'PI_DEFAULT', messages: [] } });
      expect(next.context.systemPrompt).toBe('PI_DEFAULT');
      handle.dispose();
    });
  });

  it('rejects a missing fork anchor before creating a child session artifact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-pi-adapter-fork-'));
    const cwd = join(root, 'workspace');
    const parentDir = join(root, 'parent');
    const childDir = join(root, 'child');
    const agentDir = join(root, 'agent');
    try {
      const parent = SessionManager.create(cwd, parentDir);
      parent.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: 'parent' }],
        timestamp: Date.now(),
      } as never);
      parent.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'parent answer' }],
        timestamp: Date.now(),
      } as never);
      const parentFile = parent.getSessionFile();
      expect(parentFile).toBeString();

      const adapter = createPiRuntimeAdapter();
      await expect(adapter.createSession({
        cwd,
        agentDir,
        registry: await adapter.createRegistry(),
        strategy: {
          kind: 'fork',
          parentSessionFile: parentFile!,
          sessionDir: childDir,
          anchorEntryId: 'missing-anchor',
        },
        sessionOptions: { tools: [] },
      })).rejects.toThrow('missing-anchor');

      expect(existsSync(childDir) ? readdirSync(childDir) : []).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('disposes a partially created session when its required shape is invalid', async () => {
    let disposed = 0;
    const fake = fakeBindings({
      createAgentSession: async () => ({
        session: { dispose: () => { disposed += 1; } },
      }) as never,
    });
    const adapter = createPiRuntimeAdapter(fake.bindings);

    await expect(adapter.createSession({
      cwd: '/workspace',
      registry: await adapter.createRegistry(),
      strategy: { kind: 'memory' },
      sessionOptions: { tools: [] },
    })).rejects.toThrow(/session shape/);
    expect(disposed).toBe(1);
  });

  it('rejects every directly consumed AgentSession method and property before returning a handle', async () => {
    const missing: Array<[string, Record<string, unknown>, number]> = [
      ['prompt', { prompt: undefined }, 1],
      ['subscribe', { subscribe: undefined }, 1],
      ['compact', { compact: undefined }, 1],
      ['abort', { abort: undefined }, 1],
      ['dispose', { dispose: undefined }, 0],
      ['setModel', { setModel: undefined }, 1],
      ['setThinkingLevel', { setThinkingLevel: undefined }, 1],
      ['steer', { steer: undefined }, 1],
      ['setAutoCompactionEnabled', { setAutoCompactionEnabled: undefined }, 1],
      ['sessionId', { sessionId: undefined }, 1],
      ['sessionManager.getLeafId', { sessionManager: {} }, 1],
      ['autoCompactionEnabled', { autoCompactionEnabled: undefined }, 1],
      ['isCompacting', { isCompacting: undefined }, 1],
      ['messages', { messages: undefined }, 1],
      ['agent', { agent: undefined }, 1],
    ];

    for (const [label, overrides, expectedDisposals] of missing) {
      let disposed = 0;
      const fake = fakeBindings({
        createAgentSession: async () => ({
          session: fakeSession({ dispose: () => { disposed += 1; }, ...overrides }),
        }) as never,
      });
      const adapter = createPiRuntimeAdapter(fake.bindings);
      await expect(adapter.createSession({
        cwd: '/workspace',
        registry: await adapter.createRegistry(),
        strategy: { kind: 'memory' },
        sessionOptions: { tools: [] },
      })).rejects.toThrow(label);
      expect(disposed, label).toBe(expectedDisposals);
    }
  });

  it('removes only a newly created fork artifact when session creation fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-pi-adapter-fork-rollback-'));
    const cwd = join(root, 'workspace');
    const parentDir = join(root, 'parent');
    const childDir = join(root, 'child');
    const throwingDisposeChildDir = join(root, 'throwing-dispose-child');
    try {
      const parent = SessionManager.create(cwd, parentDir);
      parent.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: 'parent' }],
        timestamp: Date.now(),
      } as never);
      parent.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'parent answer' }],
        timestamp: Date.now(),
      } as never);
      const parentFile = parent.getSessionFile();
      if (!parentFile) throw new Error('expected persisted parent session');
      const parentBefore = readFileSync(parentFile, 'utf8');

      const fake = fakeBindings({
        sessionManager: {
          inMemory: cwdArg => SessionManager.inMemory(cwdArg),
          create: (cwdArg, sessionDir) => SessionManager.create(cwdArg, sessionDir),
          continueRecent: (cwdArg, sessionDir) => SessionManager.continueRecent(cwdArg, sessionDir),
          open: (file, cwdArg) => SessionManager.open(file, undefined, cwdArg),
          forkFrom: (file, cwdArg, sessionDir) => SessionManager.forkFrom(file, cwdArg, sessionDir),
        },
        createAgentSession: async () => { throw new Error('injected createAgentSession failure'); },
      });
      const adapter = createPiRuntimeAdapter(fake.bindings);

      await expect(adapter.createSession({
        cwd,
        registry: await adapter.createRegistry(),
        strategy: {
          kind: 'fork',
          parentSessionFile: parentFile,
          sessionDir: childDir,
        },
        sessionOptions: { tools: [] },
      })).rejects.toThrow('injected createAgentSession failure');

      expect(existsSync(parentFile)).toBe(true);
      expect(readFileSync(parentFile, 'utf8')).toBe(parentBefore);
      expect(existsSync(childDir) ? readdirSync(childDir) : []).toEqual([]);

      const throwingDispose = fakeBindings({
        sessionManager: {
          inMemory: cwdArg => SessionManager.inMemory(cwdArg),
          create: (cwdArg, sessionDir) => SessionManager.create(cwdArg, sessionDir),
          continueRecent: (cwdArg, sessionDir) => SessionManager.continueRecent(cwdArg, sessionDir),
          open: (file, cwdArg) => SessionManager.open(file, undefined, cwdArg),
          forkFrom: (file, cwdArg, sessionDir) => SessionManager.forkFrom(file, cwdArg, sessionDir),
        },
        createAgentSession: async () => ({
          session: { dispose: () => { throw new Error('injected dispose failure'); } },
        }) as never,
      });
      const throwingDisposeAdapter = createPiRuntimeAdapter(throwingDispose.bindings);
      await expect(throwingDisposeAdapter.createSession({
        cwd,
        registry: await throwingDisposeAdapter.createRegistry(),
        strategy: {
          kind: 'fork',
          parentSessionFile: parentFile,
          sessionDir: throwingDisposeChildDir,
        },
        sessionOptions: { tools: [] },
      })).rejects.toThrow('Unsupported Pi session shape: missing prompt');

      expect(existsSync(parentFile)).toBe(true);
      expect(readFileSync(parentFile, 'utf8')).toBe(parentBefore);
      expect(existsSync(throwingDisposeChildDir) ? readdirSync(throwingDisposeChildDir) : []).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('executes one capture-only public lowercase tool contract', async () => {
    const { tool, result } = await exercisePublicExtensionContract();
    expect(tool.name).toBe('nessy_contract_tool');
    expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(result).toEqual({
      content: [{ type: 'text', text: 'captured' }],
      details: {},
    });
  });

  it('delegates compact and makes dispose idempotent', async () => {
    let compactedWith: string | undefined;
    let disposed = 0;
    const fake = fakeBindings({
      createAgentSession: async () => ({
        session: fakeSession({
          // The double now answers the SDK's own `CompactionResult` (summary,
          // firstKeptEntryId, tokensBefore) instead of the `{ ok: true }` it
          // invented: the host reads `firstKeptEntryId` / `tokensBefore` /
          // `summary` off `handle.compact`'s pass-through, so a fixture in the
          // real shape is what pins the delegation — and an invented shape is
          // exactly the drift the typecheck exclusion hid.
          compact: async (instructions?: string): Promise<CompactionResult> => {
            compactedWith = instructions;
            return { summary: 'kept the decisions', firstKeptEntryId: 'entry-kept', tokensBefore: 4242 };
          },
          dispose: () => { disposed += 1; },
        }),
      }) as never,
    });
    const adapter = createPiRuntimeAdapter(fake.bindings);
    const handle = await adapter.createSession({
      cwd: '/workspace',
      registry: await adapter.createRegistry(),
      strategy: { kind: 'memory' },
      sessionOptions: { tools: [] },
    });

    expect(await handle.compact('keep decisions')).toEqual({
      summary: 'kept the decisions',
      firstKeptEntryId: 'entry-kept',
      tokensBefore: 4242,
    });
    expect(compactedWith).toBe('keep decisions');
    handle.dispose();
    handle.dispose();
    expect(disposed).toBe(1);
  });

  it('allows a failed runtime cleanup to be retried', async () => {
    let attempts = 0;
    const fake = fakeBindings({
      createAgentSession: async () => ({
        session: fakeSession({
          dispose: () => {
            attempts += 1;
            if (attempts === 1) throw new Error('injected cleanup failure');
          },
        }),
      }) as never,
    });
    const adapter = createPiRuntimeAdapter(fake.bindings);
    const handle = await adapter.createSession({
      cwd: '/workspace',
      registry: await adapter.createRegistry(),
      strategy: { kind: 'memory' },
      sessionOptions: { tools: [] },
    });

    expect(() => handle.dispose()).toThrow('injected cleanup failure');
    expect(() => handle.dispose()).not.toThrow();
    expect(attempts).toBe(2);
  });

  /**
   * An EXPLICIT budget, because this case's cost is I/O over the whole package
   * and not the assertion (WB-d, 2026-09-14, while landing DA1.30).
   *
   * It walks every production `.ts` under `src/` and reads each one. Measured
   * twice on this box, the same bytes: **14 171 ms** and **18 071 ms** against
   * the 5 000 ms default, inside file totals of 201 s and 311 s whose own
   * `user 1.57 / sys 0.63` is 0.7 % of wall — I/O wait, not CPU contention and
   * not this case getting slower. The known-failing register already carries
   * one reading of exactly this case (timed out at 6 168 ms in a four-file
   * batch, then 30 pass / 0 fail alone) and records that it *"did not recur in
   * any later run"*; it has now recurred twice, so the budget is the honest
   * instrument rather than a re-measurement.
   *
   * 60 s is ~3.3x the largest observed run. It is a FLOOR against this box's
   * I/O, not a licence for the scan to grow: a walk that genuinely needs a
   * minute is a finding about the package, not about the runner.
   */
  it('confines direct createAgentSession use to the adapter', () => {
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const offenders = productionTypeScriptFiles(srcRoot)
      .filter(path => !path.endsWith('/compat/pi-runtime-adapter.ts'))
      .filter(path => readFileSync(path, 'utf8').includes('createAgentSession'));
    expect(offenders).toEqual([]);
  }, 60_000);
});

/**
 * UB1.19 (590d6b761) made the adapter CREATE the agentDir it is handed
 * (`resolveNessyAgentDir`, upstream v0.15.1 parity), so a fixture's agentDir must
 * be writable: the literal '/hostile-agent-dir' and '/session/.pi-agent' failed
 * three contract tests with EROFS on macOS (found by UB7.16's gate, 2026-10-16).
 * The same name gives the same path, so an assertion can name it again; one
 * scratch root per process, removed at exit. Declared at the end of the file so
 * the doc-cited lines above keep their numbers.
 */
function fixtureAgentDir(name: string): string {
  if (!fixtureAgentRoot) {
    const root = mkdtempSync(join(tmpdir(), 'nessy-pi-adapter-agent-dir-'));
    fixtureAgentRoot = root;
    process.once('exit', () => rmSync(root, { recursive: true, force: true }));
  }
  return join(fixtureAgentRoot, name);
}
let fixtureAgentRoot: string | undefined;

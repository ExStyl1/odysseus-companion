import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '../../../shared/src/agent/pi-harness/harness-manifest.ts';
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
} from '../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts';
import type { ToolExecutor, ToolExecutionRequest } from '../../../shared/src/agent/pi-harness/tool-executor.ts';
import { hashProjectedPiToolDefinition } from '../harness/tool-manifest.ts';
import { buildRuntimeBackedBuiltinToolDefinitions } from '../local-tools/runtime-backed-tools.ts';
import type {
  CuratedPiExtensionDescriptor,
  CuratedPiResourceDescriptor,
  VerifiedSignedBundleRootCapability,
} from './descriptor.ts';
import { guardCuratedPiExtensionFactory } from './guard.ts';
import {
  CURATED_PI_BUILD_MANIFEST,
  PINNED_NESSY_FACTORIES,
  PINNED_NESSY_RESOURCES,
  composeCuratedPiExtensionFactories,
  createCuratedPiBuildManifest,
} from './registry.ts';
import { createCuratedResourceOverrides, loadCuratedPiResources } from './resource-loader.ts';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function testManifest() {
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'x2-test-generation',
    sessionKey: { workspaceId: 'workspace-x2', sessionId: 'session-x2' },
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
  return finalizePiExecutionManifest(seed, []);
}

function readContract(
  factory: ExtensionFactory,
  definition?: ReturnType<typeof buildRuntimeBackedBuiltinToolDefinitions>[number],
): CuratedPiExtensionDescriptor {
  const manifest = testManifest();
  const read = manifest.tools.find(tool => tool.binding.piName === 'read');
  if (!read?.modelContractHash) throw new Error('missing read model contract');
  return {
    id: 'nessy.test.read',
    upstream: { repository: 'nessy://builtin', revision: 'bed5aefd', license: 'proprietary' },
    factory,
    tools: [{
      semanticId: 'read',
      piName: 'read',
      modelContractHash: definition
        ? hashProjectedPiToolDefinition(manifest, read, definition)
        : read.modelContractHash,
    }],
    events: ['before_agent_start'],
    commands: ['nessy_test'],
    allowedApi: ['registerTool', 'on', 'registerCommand'],
    ui: 'none',
  };
}

function rawApiRecorder() {
  const tools: unknown[] = [];
  const events: Array<[string, (...args: unknown[]) => unknown]> = [];
  const commands: Array<[string, Record<string, unknown>]> = [];
  const api = {
    registerTool: (tool: unknown) => tools.push(tool),
    on: (event: string, handler: (...args: unknown[]) => unknown) => events.push([event, handler]),
    registerCommand: (name: string, options: Record<string, unknown>) => commands.push([name, options]),
  } as unknown as ExtensionAPI;
  return { api, tools, events, commands };
}

describe('closed curated Pi extension host', () => {
  it('freezes an exact empty production registry and accounts for fixed built-ins', () => {
    expect(PINNED_NESSY_FACTORIES).toEqual([]);
    expect(PINNED_NESSY_RESOURCES).toEqual([]);
    expect(CURATED_PI_BUILD_MANIFEST.components).toEqual([
      { id: 'nessy.prompt-extension', kind: 'builtin' },
      { id: 'nessy.lifecycle-bridge', kind: 'builtin' },
      { id: 'nessy.deferred-mcp-extension', kind: 'builtin' },
    ]);
    expect(Object.isFrozen(CURATED_PI_BUILD_MANIFEST)).toBe(true);
    expect(() => (PINNED_NESSY_FACTORIES as unknown[]).push('malicious')).toThrow();
    expect(() => (CURATED_PI_BUILD_MANIFEST.components as unknown[]).push('malicious')).toThrow();
  });

  it('composes promptExtension first and validates H2 identities without copying its registry', () => {
    const promptExtension: ExtensionFactory = () => {};
    const descriptor = readContract(() => {});
    const manifest = testManifest();
    const staticBuild = createCuratedPiBuildManifest([descriptor], []);
    expect(staticBuild.extensions[0]).toMatchObject({ id: descriptor.id, tools: descriptor.tools });
    const build = createCuratedPiBuildManifest([descriptor], [], manifest);
    expect(build.extensions[0]).toMatchObject({ id: descriptor.id, tools: descriptor.tools });
    const lifecycleExtension: ExtensionFactory = () => {};
    expect(composeCuratedPiExtensionFactories(promptExtension, lifecycleExtension, undefined, [descriptor], manifest).slice(0, 2)).toEqual([
      promptExtension,
      lifecycleExtension,
    ]);
    expect(() => composeCuratedPiExtensionFactories(promptExtension, lifecycleExtension, undefined, [descriptor])).toThrow(/session manifest/i);
    expect(() => createCuratedPiBuildManifest([{ ...descriptor, id: descriptor.id } , descriptor], [], manifest)).toThrow(/duplicate/i);
    expect(() => createCuratedPiBuildManifest([{
      ...descriptor,
      tools: [{ ...descriptor.tools[0]!, modelContractHash: '0'.repeat(64) }],
    }], [])).toThrow(/static model contract/i);
    const staleManifest = structuredClone(manifest);
    const staleRead = staleManifest.tools.find(tool => tool.binding.piName === 'read')!;
    (staleRead as { modelContractHash?: string }).modelContractHash = '0'.repeat(64);
    expect(() => createCuratedPiBuildManifest([descriptor], [], staleManifest)).toThrow(/session model contract/i);
    expect(() => createCuratedPiBuildManifest([{
      ...descriptor,
      tools: [{ ...descriptor.tools[0]!, semanticId: 'unknown_semantic' }],
    }], [], manifest)).toThrow(/binding|semantic/i);
    expect(() => createCuratedPiBuildManifest([{
      ...descriptor,
      tools: [{ ...descriptor.tools[0]!, piName: 'bash' }],
    }], [], manifest)).toThrow(/binding|semantic/i);
  });

  it('captures then atomically audits registrations and exposes only closed handler contexts', async () => {
    const definition = buildRuntimeBackedBuiltinToolDefinitions('/workspace').find(tool => tool.name === 'read')!;
    let eventContext: unknown;
    let commandContext: unknown;
    let reflection: unknown;
    const descriptor = readContract((api) => {
      reflection = {
        keys: Object.keys(api),
        ownKeys: Reflect.ownKeys(api),
        prototype: Object.getPrototypeOf(api),
        descriptors: Object.keys(Object.getOwnPropertyDescriptors(api)),
      };
      api.registerTool(definition);
      api.on('before_agent_start', (_event, context) => { eventContext = context; });
      api.registerCommand('nessy_test', { handler: (_args, context) => { commandContext = context; } });
    }, definition);
    const manifest = testManifest();
    const raw = rawApiRecorder();
    await guardCuratedPiExtensionFactory(descriptor, manifest)(raw.api);
    expect(raw.tools).toHaveLength(1);
    expect(raw.events.map(([event]) => event)).toEqual(['before_agent_start']);
    expect(raw.commands.map(([name]) => name)).toEqual(['nessy_test']);
    await raw.events[0]![1]({}, { ui: {}, modelRegistry: {}, sessionManager: {} });
    await (raw.commands[0]![1].handler as (...args: unknown[]) => unknown)('', { ui: {}, modelRegistry: {} });
    expect(reflection).toEqual({
      keys: ['registerTool', 'on', 'registerCommand'],
      ownKeys: ['registerTool', 'on', 'registerCommand'],
      prototype: null,
      descriptors: ['registerTool', 'on', 'registerCommand'],
    });
    for (const context of [eventContext, commandContext]) {
      expect(Object.keys(context as object)).toEqual([]);
      expect(Reflect.ownKeys(context as object)).toEqual([]);
      expect(Object.getPrototypeOf(context)).toBe(null);
      expect(Object.getOwnPropertyDescriptors(context as object)).toEqual({});
      expect(() => (context as Record<string, unknown>).ui).toThrow(/denied/i);
    }
    await expect((raw.tools[0] as { execute: (...args: unknown[]) => unknown }).execute()).rejects.toThrow(/session ToolExecutor/);
  });

  it('submits curated callbacks as public requests to the injected executor', async () => {
    const definition = buildRuntimeBackedBuiltinToolDefinitions('/workspace').find(tool => tool.name === 'read')!;
    const descriptor = readContract(api => { api.registerTool(definition); }, definition);
    descriptor.events = [];
    descriptor.commands = [];
    descriptor.allowedApi = ['registerTool'];
    const manifest = testManifest();
    const requests: ToolExecutionRequest[] = [];
    const toolExecutor: ToolExecutor = {
      async execute(request) {
        requests.push(request);
        return {
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
          result: { content: 'curated-result', isError: false },
        };
      },
    };
    const raw = rawApiRecorder();
    await guardCuratedPiExtensionFactory(descriptor, manifest, toolExecutor, 7)(raw.api);
    const result = await (raw.tools[0] as { execute: (...args: unknown[]) => Promise<unknown> }).execute(
      'curated-1', { path: 'README.md' }, new AbortController().signal,
    );

    expect(requests).toEqual([{
      executionId: 'curated-1',
      sessionKey: manifest.sessionKey,
      manifestIdentity: {
        generation: manifest.snapshotGeneration,
        manifestHash: manifest.manifestHash,
        responseEpoch: 7,
      },
      semanticId: 'read',
      canonicalInput: { path: 'README.md' },
      source: 'pi',
      presentedName: 'read',
      abortSignal: expect.any(AbortSignal),
    }]);
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'curated-result' }] });
  });

  it('fails closed for every denied or unknown API and for partial registration', async () => {
    const manifest = testManifest();
    for (const key of [
      'registerProvider', 'unregisterProvider', 'setModel', 'setThinkingLevel', 'registerFlag', 'getFlag',
      'registerShortcut', 'registerMessageRenderer', 'sendMessage', 'sendUserMessage', 'appendEntry',
      'setSessionName', 'setLabel', 'exec', 'spawn', 'processSupervisor', 'processSupervisorPort',
      'getActiveTools', 'setActiveTools', 'events', 'ui', '__raw',
    ]) {
      const descriptor = readContract(api => { void (api as unknown as Record<string, unknown>)[key]; });
      const raw = rawApiRecorder();
      await expect(guardCuratedPiExtensionFactory(descriptor, manifest)(raw.api)).rejects.toThrow(/denied/i);
      expect([raw.tools, raw.events, raw.commands]).toEqual([[], [], []]);
    }
    const raw = rawApiRecorder();
    await expect(guardCuratedPiExtensionFactory(readContract(() => {}), manifest)(raw.api)).rejects.toThrow(/missing/i);
    expect([raw.tools, raw.events, raw.commands]).toEqual([[], [], []]);

    const definition = buildRuntimeBackedBuiltinToolDefinitions('/workspace').find(tool => tool.name === 'read')!;
    for (const factory of [
      ((api: ExtensionAPI) => { api.registerTool(definition); api.registerTool(definition); }),
      ((api: ExtensionAPI) => { api.on('before_agent_start', () => {}); api.on('before_agent_start', () => {}); }),
      ((api: ExtensionAPI) => { api.registerCommand('nessy_test', { handler: () => {} }); api.registerCommand('nessy_test', { handler: () => {} }); }),
      ((api: ExtensionAPI) => { api.on('turn_start', () => {}); }),
      ((api: ExtensionAPI) => { api.registerCommand('unapproved', { handler: () => {} }); }),
    ]) {
      const duplicateRaw = rawApiRecorder();
      await expect(guardCuratedPiExtensionFactory(readContract(factory), manifest)(duplicateRaw.api)).rejects.toThrow(/duplicate|denied/i);
      expect([duplicateRaw.tools, duplicateRaw.events, duplicateRaw.commands]).toEqual([[], [], []]);
    }
  });

  it('keeps the build manifest independent of hostile ambient state', () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-x2-ambient-'));
    const previous = { ...process.env };
    try {
      for (const path of ['home/.pi', 'workspace/.pi', 'agent', 'app-data', 'session']) {
        mkdirSync(join(root, path), { recursive: true });
        writeFileSync(join(root, path, 'settings.json'), '{"extensions":["malicious"]}');
      }
      Object.assign(process.env, {
        HOME: join(root, 'home'),
        PI_AGENT_DIR: join(root, 'agent'),
        XDG_CONFIG_HOME: join(root, 'app-data'),
        NESSY_SESSION_FILE: join(root, 'session', 'settings.json'),
        PI_EXTENSIONS: 'malicious',
      });
      expect(createCuratedPiBuildManifest([], [])).toEqual(CURATED_PI_BUILD_MANIFEST);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads only immutable digest-pinned relative resources', () => {
    const content = '# Curated prompt';
    const resource: CuratedPiResourceDescriptor = {
      id: 'nessy.test.prompt',
      kind: 'prompt',
      relativePath: 'prompts/test.md',
      sha256: sha256(content),
      bundledContent: content,
    };
    const loaded = loadCuratedPiResources([resource]);
    expect(loaded).toEqual([{ ...resource, content }]);
    expect(Object.isFrozen(loaded)).toBe(true);
    for (const relativePath of ['/tmp/prompt.md', '../prompt.md', 'prompts/../../prompt.md', 'prompts\\prompt.md']) {
      expect(() => loadCuratedPiResources([{ ...resource, relativePath }])).toThrow(/relative resource path/i);
    }
    expect(() => loadCuratedPiResources([{ ...resource, sha256: '0'.repeat(64) }])).toThrow(/digest/i);
    expect(() => createCuratedResourceOverrides([{ ...resource, kind: 'skill' }])).toThrow(/skill.*signed/i);
  });

  it('projects signed skills from their verified readable root only', () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-x2-skill-'));
    const bundleRoot = join(root, 'bundle');
    const skillRoot = join(bundleRoot, 'skills', 'verified-skill');
    const entryPath = join(skillRoot, 'SKILL.md');
    const assetPath = join(skillRoot, 'assets', 'example.txt');
    const content = '# Verified skill';
    mkdirSync(join(skillRoot, 'assets'), { recursive: true });
    writeFileSync(entryPath, content);
    writeFileSync(assetPath, 'relative asset');
    const resource: CuratedPiResourceDescriptor = {
      id: 'nessy.test.skill',
      kind: 'skill',
      relativePath: 'skills/test/SKILL.md',
      sha256: sha256(content),
      skillMetadata: {
        name: 'verified-skill',
        description: 'Descriptor-owned metadata',
        disableModelInvocation: true,
      },
      signedAsset: { bundleRelativeRoot: 'skills/test', entryFile: 'SKILL.md', treeSha256: sha256('tree') },
    };
    const capability: VerifiedSignedBundleRootCapability = {
      read: () => ({
        rootPath: bundleRoot,
        entryPath,
        treeSha256: sha256('tree'),
        content,
      }),
    };
    try {
      const overrides = createCuratedResourceOverrides([resource], capability);
      const projected = overrides.skillsOverride({ skills: [], diagnostics: [] }).skills[0]!;
      expect(projected.filePath).toBe(realpathSync(entryPath));
      expect(projected.baseDir).toBe(realpathSync(skillRoot));
      expect(projected).toMatchObject({
        name: 'verified-skill',
        description: 'Descriptor-owned metadata',
        disableModelInvocation: true,
      });
      expect(projected.sourceInfo).toMatchObject({
        path: realpathSync(entryPath),
        baseDir: realpathSync(skillRoot),
      });
      expect(readFileSync(join(projected.baseDir, 'assets', 'example.txt'), 'utf8')).toBe('relative asset');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects signed-root symlink escape and tree drift', () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-x2-resource-'));
    const bundle = join(root, 'bundle');
    const outside = join(root, 'outside');
    mkdirSync(bundle);
    mkdirSync(outside);
    writeFileSync(join(outside, 'prompt.md'), 'escaped');
    symlinkSync(outside, join(bundle, 'escape'));
    const resource: CuratedPiResourceDescriptor = {
      id: 'nessy.test.signed',
      kind: 'prompt',
      relativePath: 'prompts/signed.md',
      sha256: sha256('escaped'),
      signedAsset: { bundleRelativeRoot: 'assets', entryFile: 'prompt.md', treeSha256: sha256('tree') },
    };
    const wrongTree: VerifiedSignedBundleRootCapability = {
      read: () => ({
        rootPath: bundle,
        entryPath: join(bundle, 'prompt.md'),
        treeSha256: sha256('wrong-tree'),
        content: 'escaped',
      }),
    };
    try {
      writeFileSync(join(bundle, 'prompt.md'), 'escaped');
      expect(() => loadCuratedPiResources([resource], wrongTree)).toThrow(/tree digest/i);
      const escaped: VerifiedSignedBundleRootCapability = {
        read: () => ({
          rootPath: bundle,
          entryPath: join(bundle, 'escape', 'prompt.md'),
          treeSha256: sha256('tree'),
          content: 'escaped',
        }),
      };
      expect(() => loadCuratedPiResources([resource], escaped)).toThrow(/root escape/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

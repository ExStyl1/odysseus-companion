import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { materializeRuntimePoolServers } from '../../mcp/runtime-pool-servers.ts';
import { CapabilityPolicyStore } from '../../capabilities/policy-store.ts';
import { CapabilityTrustStore } from '../../capabilities/trust-store.ts';
import { CredentialManager } from '../../credentials/manager.ts';
import { SecureStorageBackendV2 } from '../../credentials/backends/secure-storage.ts';
import type { CapabilityTurnRuntime } from '../../agent/backend/types.ts';
import type { CapabilitySnapshotMaterializer } from '../../capabilities/materializer.ts';
import { normalizePluginBundle } from '../format-adapters.ts';
import { PluginInstallService } from '../acquisition.ts';
import { PluginManagementServiceV2 } from '../management-service-v2.ts';
import { extractMcpbArchive } from '../mcpb-archive.ts';
import { PluginStoreV2 } from '../store-v2.ts';
import type { PluginOrigin } from '../types.ts';

const fixtureRoot = join(import.meta.dir, 'fixtures', 'mcpb');
const temporaryRoots: string[] = [];

afterEach(async () => { await installs.settle(); // F1.424 — never remove a root under an install still copying into it
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('MCPB adapter', () => {
  it.each([
    ['node', 'node'],
    ['python', 'python3'],
    ['binary', '${NESSY_PLUGIN_ROOT}/server/test-server'],
  ] as const)('normalizes the official %s runtime shape', async (fixture, expectedCommand) => {
    const bundle = copyFixture(fixture);
    if (fixture === 'binary') chmodSync(join(bundle, 'server', 'test-server'), 0o755);

    const normalized = await normalizePluginBundle(bundle, origin(bundle));
    expect(normalized.ok).toBe(true);
    expect(normalized.adapterId).toBe('mcpb-v1');
    const mcp = normalized.value?.capabilities.find(capability => capability.kind === 'mcp');
    expect(mcp?.mcp?.command).toBe(expectedCommand);
    expect(normalized.compatibility?.state).toBe('supported');
  });

  it('maps public settings and preserves value-free configuration metadata', async () => {
    const bundle = copyFixture('node');
    const normalized = await normalizePluginBundle(bundle, origin(bundle));
    expect(normalized.ok).toBe(true);

    const manifest = normalized.value!;
    const mcp = manifest.capabilities.find(capability => capability.kind === 'mcp');
    expect(manifest.capabilities.filter(capability => capability.kind === 'setting').map(capability => capability.setting?.key)).toEqual(['region']);
    expect(mcp?.mcp?.credentialEnvironment).toEqual({ API_KEY: 'api_key', MCPB_CONFIG_REGION: 'region' });
    expect(mcp?.mcp?.userConfiguration).toEqual([
      { key: 'region', valueType: 'string', required: true, defaultValue: 'eu' },
      { key: 'api_key', valueType: 'secret-ref', required: true },
    ]);
    expect(mcp?.mcp?.env).toEqual({ REGION: '${MCPB_CONFIG_REGION}' });
    expect(JSON.stringify(manifest)).not.toContain('runtime-canary-secret');
  });

  it('stages a local MCPB ZIP through the existing install service', async () => {
    const archive = temporaryPath('node.mcpb');
    writeFileSync(archive, zipSync({
      'manifest.json': strToU8(JSON.stringify(nodeManifest())),
      'server/index.js': strToU8('process.stdout.write("ready")\n'),
    }));
    const service = new PluginInstallService({ baseTempDir: temporaryDirectory('staging') });
    const plan = await service.createInstallPlanFromSource(archive);
    const staged = await service.stageInstall(plan);
    const normalized = await service.normalizeStagedInstall(staged);

    expect(staged.diagnostics).toEqual([]);
    expect(normalized.adapterId).toBe('mcpb-v1');
    expect(normalized.manifest?.id).toBe('mcpb-node');
  });

  it('preserves the legacy local-file path for an ordinary ZIP', async () => {
    const archive = temporaryPath('ordinary.zip');
    writeFileSync(archive, zipSync({
      'plugin/plugin.json': strToU8(JSON.stringify({ schemaVersion: 1, kind: 'plugin', id: 'ordinary', name: 'Ordinary', version: '1.0.0', capabilities: [] })),
    }));
    const service = new PluginInstallService({ baseTempDir: temporaryDirectory('staging') });
    const staged = await service.stageInstall(await service.createInstallPlanFromSource(archive));

    expect(staged.diagnostics).toEqual([]);
    expect(readdirSync(staged.rawDirectory)).toEqual(['ordinary.zip']);
    expect(existsSync(join(staged.rawDirectory, 'plugin', 'plugin.json'))).toBe(false);
  });

  it('positively identifies a root MCPB manifest even when the suffix is .zip', async () => {
    const archive = temporaryPath('extension.zip');
    writeFileSync(archive, zipSync({
      'manifest.json': strToU8(JSON.stringify(nodeManifest())),
      'server/index.js': strToU8('process.stdout.write("ready")\n'),
    }));
    const service = new PluginInstallService({ baseTempDir: temporaryDirectory('staging') });
    const staged = await service.stageInstall(await service.createInstallPlanFromSource(archive));
    const normalized = await service.normalizeStagedInstall(staged);

    expect(normalized.adapterId).toBe('mcpb-v1');
  });

  it.each([
    ['path traversal', { '../escape': strToU8('bad') }],
    ['canonical duplicate', { 'café': strToU8('a'), 'cafe\u0301': strToU8('b') }],
    ['symlink', { link: [strToU8('target'), { os: 3, attrs: 0o120777 << 16 }] }],
  ] as const)('rejects %s archive entries', async (_label, contents) => {
    const archive = temporaryPath('bad.mcpb');
    const output = temporaryDirectory('output');
    writeFileSync(archive, zipSync({
      'manifest.json': strToU8(JSON.stringify(nodeManifest())),
      'server/index.js': strToU8(''),
      ...contents,
    } as Zippable));
    await expect(extractMcpbArchive(archive, output)).rejects.toThrow(/escape|duplicate canonical path|symlinks/);
  });

  it('rejects executable files that are not the declared binary entrypoint', async () => {
    const archive = temporaryPath('executable.mcpb');
    const manifest = nodeManifest();
    writeFileSync(archive, zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'server/index.js': strToU8('process.stdout.write("ready")\n'),
      'scripts/undeclared.sh': [strToU8('#!/bin/sh\n'), { os: 3, attrs: 0o100755 << 16 }],
    } as Zippable));

    await expect(extractMcpbArchive(archive, temporaryDirectory('output')))
      .rejects.toThrow(/executable entry is not the declared binary server/);
  });

  it('rejects unsupported versions and redacts rejected sensitive defaults', async () => {
    const bundle = temporaryDirectory('invalid');
    mkdirSync(join(bundle, 'server'), { recursive: true });
    writeFileSync(join(bundle, 'server', 'index.js'), '');
    writeFileSync(join(bundle, 'manifest.json'), JSON.stringify({
      ...nodeManifest(),
      manifest_version: '9.9',
      user_config: {
        token: { type: 'string', sensitive: true, default: 'CANARY_SECRET' },
      },
      server: {
        ...nodeManifest().server,
        mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'], env: { TOKEN: '${user_config.token}' } },
      },
    }));

    const normalized = await normalizePluginBundle(bundle, origin(bundle));
    expect(normalized.ok).toBe(false);
    expect(normalized.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.format.mcpb_version_unsupported');
    expect(JSON.stringify(normalized)).not.toContain('CANARY_SECRET');
  });
});

describe('MCPB credential runtime', () => {
  it('injects a resolved sensitive value only into the child environment', async () => {
    const secret = 'runtime-canary-secret';
    const runtime = runtimeWithCredential({ ready: true, revision: 7, value: JSON.stringify({ api_key: secret, count: 4, enabled: false }) });
    const out = await materializeRuntimePoolServers(runtime, {
      workspaceRootPath: '/workspace',
      workspaceId: 'workspace-id',
      pluginNodeRuntime: { command: process.execPath },
    });

    expect(out.mergedMcpServers.mcpb).toEqual(expect.objectContaining({
      env: expect.objectContaining({ API_KEY: secret, COUNT: '4', ENABLED: 'false' }),
      inheritProcessEnv: false,
    }));
    expect(process.env.API_KEY).not.toBe(secret);
  });

  it('fails closed when the sensitive value is unavailable', async () => {
    const debug: string[] = [];
    const runtime = runtimeWithCredential({ ready: false, revision: 0 });
    const out = await materializeRuntimePoolServers(runtime, {
      workspaceRootPath: '/workspace',
      workspaceId: 'workspace-id',
      pluginNodeRuntime: { command: process.execPath },
      debug: message => debug.push(message),
    });

    expect(out.mergedMcpServers).toEqual({});
    expect(debug.join('\n')).toContain('missing credential configuration: API_KEY');
  });
});

describe('MCPB configuration management', () => {
  it('validates typed values, stores a secret only encrypted, and supports missing -> ready -> missing', async () => {
    const root = temporaryDirectory('configuration');
    const credentialFile = join(root, 'credentials.enc');
    const credentials = new CredentialManager(new SecureStorageBackendV2({ filePath: credentialFile }));
    const store = new PluginStoreV2({ rootDirectory: join(root, 'plugins') });
    const service = installs.track(new PluginManagementServiceV2({
      store,
      policyStore: new CapabilityPolicyStore({
        globalPath: join(root, 'capabilities.json'),
        workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
      }),
      trustStore: new CapabilityTrustStore({ path: join(root, 'trust.json') }),
      credentialManager: credentials,
      baseTempDir: join(root, 'staging'),
    }));
    const bundle = configurableFixture();
    const installed = await service.install({ kind: 'local-path', path: bundle });
    expect(installed.ok).toBe(true);
    const pluginKey = installed.installed!.pluginKey;

    const missing = await service.configurationStatus(pluginKey, 'workspace');
    expect(missing.state).toBe('needs_configuration');
    expect(missing.fields).toContainEqual(expect.objectContaining({ key: 'api_key', valueType: 'secret-ref', missing: true, configured: false }));
    expect(missing.fields).toContainEqual(expect.objectContaining({ key: 'count', valueType: 'number', hasDefault: true, missing: false }));
    await expect(service.configure(pluginKey, 'workspace', { count: 'four' }))
      .rejects.toThrow('plugin.configuration.invalid-values');

    const secret = 'MCPB_SECRET_CANARY';
    const ready = await service.configure(pluginKey, 'workspace', {
      api_key: secret,
      count: 4,
      enabled: false,
    });
    expect(ready.state).toBe('ready');
    expect(ready.fields.find(field => field.key === 'api_key')?.configured).toBe(true);
    expect(JSON.stringify(ready)).not.toContain(secret);
    expect(JSON.stringify(await store.readInstalledRegistry())).not.toContain(secret);
    expect(readFileSync(credentialFile, 'utf8')).not.toContain(secret);
    expect((await service.configure(pluginKey, 'workspace', { count: 5 })).state).toBe('ready');

    const cleared = await service.clearConfiguration(pluginKey, 'workspace');
    expect(cleared.state).toBe('needs_configuration');
    expect(cleared.fields.find(field => field.key === 'api_key')?.missing).toBe(true);
  });
});

function nodeManifest() {
  return {
    manifest_version: '0.3',
    name: 'mcpb-node',
    version: '1.0.0',
    server: {
      type: 'node',
      entry_point: 'server/index.js',
      mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] },
    },
  };
}

function copyFixture(name: string): string {
  const destination = temporaryDirectory(name);
  cpSync(join(fixtureRoot, name), destination, { recursive: true });
  return destination;
}

function configurableFixture(): string {
  const bundle = temporaryDirectory('configurable-bundle');
  mkdirSync(join(bundle, 'server'), { recursive: true });
  writeFileSync(join(bundle, 'server', 'index.js'), 'process.stdout.write("ready")\n');
  writeFileSync(join(bundle, 'manifest.json'), JSON.stringify({
    ...nodeManifest(),
    server: {
      ...nodeManifest().server,
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/index.js'],
        env: {
          API_KEY: '${user_config.api_key}',
          COUNT: '${user_config.count}',
          ENABLED: '${user_config.enabled}',
        },
      },
    },
    user_config: {
      api_key: { type: 'string', sensitive: true, required: true },
      count: { type: 'number', required: true, default: 2 },
      enabled: { type: 'boolean' },
    },
  }));
  return bundle;
}

function temporaryDirectory(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `nessy-mcpb-${name}-`));
  temporaryRoots.push(root);
  return root;
}

function temporaryPath(name: string): string {
  const root = temporaryDirectory('files');
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function origin(path: string): PluginOrigin {
  return { source: 'local-path', localPath: path, resolvedAt: 1 };
}

function runtimeWithCredential(result: { ready: boolean; revision: number; value?: string }): CapabilityTurnRuntime {
  const materializer: CapabilitySnapshotMaterializer = {
    assertActive: () => {},
    verifyPlugin: async () => {},
    resolvePath: async () => '/unused',
    readText: async () => '{}',
    resolveCredential: () => result,
  };
  return {
    view: {
      generation: 'generation',
      sources: [],
      skills: [],
      hooks: [],
      automations: [],
      agents: [],
      promptLayers: [],
      memory: [],
      permissionLayers: [],
      commands: [],
      promptCommands: [],
      apps: [],
      lspServers: [],
      mcpServers: [{
        key: 'plugin#mcpb',
        wireName: 'mcpb',
        definition: { type: 'stdio', command: 'node', args: ['${NESSY_PLUGIN_ROOT}/server/index.js'] },
        descriptorEnvironment: {
          COUNT: '${MCPB_CONFIG_COUNT}',
          ENABLED: '${MCPB_CONFIG_ENABLED}',
        },
        credentialEnvironment: {
          API_KEY: {
            configKey: 'api_key',
            credential: { id: { type: 'source_apikey', workspaceId: 'workspace-id', sourceId: 'mcpb' }, expectedRevision: 7 },
          },
          MCPB_CONFIG_COUNT: {
            configKey: 'count',
            credential: { id: { type: 'source_apikey', workspaceId: 'workspace-id', sourceId: 'mcpb' }, expectedRevision: 7 },
          },
          MCPB_CONFIG_ENABLED: {
            configKey: 'enabled',
            credential: { id: { type: 'source_apikey', workspaceId: 'workspace-id', sourceId: 'mcpb' }, expectedRevision: 7 },
          },
        },
        pluginRuntime: {
          rootPath: '/cache/mcpb',
          dataPath: '/data/mcpb',
          bundleHash: 'a'.repeat(64),
          profile: 'generic-plugin-env-v1',
        },
        pluginInstanceId: 'plugin://mcpb',
      }],
    },
    materializer,
  } as unknown as CapabilityTurnRuntime;
}

// F1.424 — every case here runs a REAL plugin-store install: a per-CASE budget, and a teardown that waits for every
// install still copying before it removes a root (`packages/shared/src/testing/install-tracker.ts` says why and what
// the tracker does not change). Placed last so no cited line moves: imports hoist, and bun applies a default set
// at module load to the cases registered above it (measured 2026-09-24).
import { MODULE_GRAPH_CASE_BUDGET_MS } from '../../testing/module-graph-budgets.ts';
import { createInstallTracker } from '../../testing/install-tracker.ts';
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS);
const installs = createInstallTracker();

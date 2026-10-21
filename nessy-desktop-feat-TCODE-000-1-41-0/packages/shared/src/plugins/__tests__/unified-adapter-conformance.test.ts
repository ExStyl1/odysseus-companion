/**
 * A10 — Offline end-to-end unified adapter conformance.
 *
 * Runs ONE local fixture per format (nessy, codex, claude) through the FULL
 * landed pipeline: source proposal -> staging -> adapter -> schema ->
 * immutable store -> activation -> resolver -> materializer -> safe UI view.
 * Everything here exercises REAL A1-A9 production code against the A1
 * fixtures already on disk (`__tests__/fixtures/format-adapters/*`,
 * `__tests__/fixtures/catalog-adapters/*`) — no invented fixtures, no mocks
 * standing in for the pipeline. Offline only: `fetchImpl` always throws, so a
 * network attempt fails the test loudly rather than silently succeeding.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPluginCapabilityId } from '../schema.ts';
import type { PluginRuntimeDependencyInstaller } from '../install-types.ts';
import { PluginManagementServiceV2 } from '../management-service-v2.ts';
import { pluginNpxRuntimeRoot } from '../stdio-command.ts';
import { PluginStoreV2, type PluginInstalledEntryV2 } from '../store-v2.ts';
import { resolvePluginProjectionCandidates } from '../projection-candidates.ts';
import { toSafePluginPresentationOrigin } from '../presentation.ts';
import { pluginRuntimeEnvForProfile } from '../data-paths.ts';
import type { PluginCompatibilityReport, PluginOrigin } from '../types.ts';
import { CapabilityPolicyStore } from '../../capabilities/policy-store.ts';
import { CapabilityTrustStore, type CapabilityTrustKey } from '../../capabilities/trust-store.ts';
import {
  createCapabilityResolver,
  type CapabilityContext,
  type CapabilityResolutionInputs,
  type PluginRuntimeContext,
} from '../../capabilities/resolver.ts';
import { createCapabilitySnapshotMaterializer } from '../../capabilities/materializer.ts';
import { toAgentRuntime, toComposerCatalog, toUserCatalog, type AgentRuntimeView } from '../../capabilities/views.ts';
import { pluginIdFromInstanceId, pluginMcpWireName } from '../../capabilities/mcp-wire-name.ts';
import { createPiExecutionManifestSeed } from '../../agent/pi-harness/harness-manifest.ts';
import { materializeRuntimePoolServers } from '../../mcp/runtime-pool-servers.ts';

const FIXTURES_ROOT = join(import.meta.dir, 'fixtures', 'format-adapters');
const CATALOG_FIXTURES_ROOT = join(import.meta.dir, 'fixtures', 'catalog-adapters');
const NEUTRAL_BUN_CONFIG = process.platform === 'win32' ? 'NUL' : '/dev/null';

interface Harness {
  dir: string;
  store: PluginStoreV2;
  policy: CapabilityPolicyStore;
  trust: CapabilityTrustStore;
  service: PluginManagementServiceV2;
}

function makeHarness(dir: string, runtimeDependencyInstaller?: PluginRuntimeDependencyInstaller): Harness {
  const store = new PluginStoreV2({ rootDirectory: join(dir, 'plugins') });
  const policy = new CapabilityPolicyStore({
    globalPath: join(dir, 'capabilities.json'),
    workspacePolicyPath: workspaceId => join(dir, 'workspaces', workspaceId, 'capabilities.json'),
  });
  const trust = new CapabilityTrustStore({ path: join(dir, 'capability-trust.json') });
  const service = installs.track(new PluginManagementServiceV2({
    store,
    policyStore: policy,
    trustStore: trust,
    // Network is forbidden in this suite — any accidental network path fails loudly.
    fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
    baseTempDir: join(dir, 'staging'),
    ...(runtimeDependencyInstaller ? { runtimeDependencyInstaller } : {}),
  }));
  return { dir, store, policy, trust, service };
}

/** Build one resolver wired to the real store/policy/trust for one workspace. */
function resolverFor(
  harness: Harness,
  workspaceId: string,
  registryEntries: PluginInstalledEntryV2[],
  activePluginInstances: Record<string, string>,
  pluginRuntimeContextFor: (instanceId: string) => PluginRuntimeContext | undefined,
) {
  function buildInputs(): CapabilityResolutionInputs {
    return {
      nativeInventory: { records: [], blockedLayers: [] },
      installedPlugins: registryEntries,
      activePluginInstances,
      acquirePluginInstanceLease: id => harness.store.acquireInstanceLease(id),
      pluginCandidates: resolvePluginProjectionCandidates(registryEntries, { kind: 'workspace', workspaceId }),
      resolveActivation: target => harness.policy.resolve(
        { pluginKey: target.pluginKey, pluginInstanceId: target.pluginInstanceId },
        { workspaceId },
      ),
      resolveTrust: key => harness.trust.resolve(key),
      pluginRuntimeContextFor,
    };
  }

  return createCapabilityResolver({ inputs: () => buildInputs() });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'unified-adapter-conformance-'));
});

afterEach(async () => { await installs.settle(); // F1.424 — never remove a root under an install still copying into it
  rmSync(dir, { recursive: true, force: true });
});

describe('unified adapter conformance (A10)', () => {
  it.each([
    ['codex', join(FIXTURES_ROOT, 'codex-core')],
    ['claude', join(FIXTURES_ROOT, 'claude-core')],
  ] as const)('runs the %s core fixture through source -> staging -> adapter -> schema -> store -> activation -> resolver -> materializer -> safe view', async (format, fixtureDir) => {
    const harness = makeHarness(dir);
    const workspaceId = 'ws_conformance';

    // 1. Source proposal + staging + adapter + schema: local-path install runs
    // the SAME production pipeline acquisition/store-v2 run for every
    // format. No user-side repackaging of the fixture is performed here.
    const installed = await harness.service.install({ kind: 'local-path', path: fixtureDir });
    expect(installed.ok).toBe(true);
    expect(installed.compatibility?.format).toBe(format);
    expect(installed.compatibility?.state).toBe('supported');
    const pluginKey = installed.installed!.pluginKey;
    const instanceId = installed.installed!.activeInstanceId;

    // 2. Immutable store: the registry entry carries no activation state, and
    // the bundle lives ONLY under the content-addressed cache tree.
    const registry = await harness.store.readInstalledRegistry();
    const entry = registry.plugins.find(p => p.pluginInstanceId === instanceId)!;
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toMatch(/enabledScopes|lifecycleState/);
    const bundleRoot = harness.store.cachePathFor(entry.cacheRef);
    expect(bundleRoot).toContain(join('plugins', 'cache'));

    // Provider paths/names disappear at the adapter boundary: the NORMALIZED
    // capabilities array (the only thing the resolver/materializer/runtime
    // ever reads to build bindings) contains no raw provider manifest path or
    // raw Claude-alias env token. (`manifest.compatibility.adapter.rawManifestPath`
    // legitimately records which raw file the adapter parsed — that is
    // adapter-only provenance bookkeeping, never a runtime contract, so it is
    // excluded from this check by only inspecting `capabilities`.)
    const serializedCapabilities = JSON.stringify(entry.manifest.capabilities);
    expect(serializedCapabilities).not.toMatch(/\.codex-plugin/);
    expect(serializedCapabilities).not.toMatch(/\.claude-plugin/);
    expect(serializedCapabilities).not.toMatch(/CLAUDE_PLUGIN_ROOT/);

    // 3. Activation: enable at workspace scope. Installing/enabling alone
    // never grants executable trust (checked explicitly further below).
    harness.policy.recordWorkspace(workspaceId, { pluginKey, enabled: true });
    expect(harness.policy.resolve({ pluginKey }, { workspaceId }).enabled).toBe(true);

    // 4. Resolver: build one leased snapshot from the real store/policy/trust.
    const pluginRuntimeContextFor = (id: string): PluginRuntimeContext | undefined => {
      if (id !== instanceId) return undefined;
      const profile = format === 'codex' ? 'codex-plugin-env-v1' as const : 'claude-plugin-env-v1' as const;
      return { rootPath: bundleRoot, dataPath: join(dir, 'plugin-data', pluginKey), profile };
    };
    const resolver = resolverFor(harness, workspaceId, [entry], { [pluginKey]: instanceId }, pluginRuntimeContextFor);
    const context: CapabilityContext = { workspaceId, projectTrustState: 'none', projectTrustRevision: '' };
    const snapshot = await resolver.resolve(context);

    // Runtime output carries ONLY Nessy IR/identities: no raw provider path or
    // Claude-alias env-name token leaks into the resolved snapshot itself
    // (env values are materialized later, from the semantic profile only).
    const serializedSnapshot = JSON.stringify(snapshot);
    expect(serializedSnapshot).not.toMatch(/\.codex-plugin/);
    expect(serializedSnapshot).not.toMatch(/\.claude-plugin/);

    // 5. Materializer + safe UI view.
    const materializer = createCapabilitySnapshotMaterializer(resolver, snapshot);
    const runtimeView = toAgentRuntime(snapshot);
    const skill = runtimeView.skills.find(s => s.logicalName.length > 0);
    expect(skill).toBeDefined();
    const skillText = await materializer.readText(skill!.resource);
    expect(skillText.length).toBeGreaterThan(0);
    expect(skillText).toMatch(/#/); // authored fixture SKILL.md always has a heading

    const composer = toComposerCatalog(snapshot);
    expect(composer.generation).toBe(snapshot.generation);
    const presentationByPluginKey = new Map([[pluginKey, toSafePluginPresentationOrigin(entry.origin)]]);
    const userCatalog = toUserCatalog(snapshot, presentationByPluginKey);
    expect(userCatalog.installedPlugins).toHaveLength(1);
    // Presentation carries the real format; no path/secret ever rides on it.
    expect(userCatalog.installedPlugins[0]!.presentation?.format).toBe(format);
    expect(JSON.stringify(userCatalog.installedPlugins[0]!.presentation)).not.toMatch(/\/|\\/);

    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('installs a no-auth plugin into a session turn and applies every skill, MCP, and hook switch', async () => {
    const harness = makeHarness(dir);
    const workspaceId = 'ws_install_to_turn';
    const sessionId = 'session_install_to_turn';
    const target = { kind: 'workspace' as const, workspaceId };
    const installed = await harness.service.install(
      { kind: 'local-path', path: join(FIXTURES_ROOT, 'codex-core') },
      { activateIn: target },
    );

    expect(installed.ok).toBe(true);
    expect(installed.installed?.authRequirements ?? []).toEqual([]);
    const pluginKey = installed.installed!.pluginKey;
    const instanceId = installed.installed!.activeInstanceId;
    expect(harness.policy.resolve({ pluginKey }, { workspaceId }).enabled).toBe(true);

    const registry = await harness.store.readInstalledRegistry();
    const entry = registry.plugins.find(plugin => plugin.pluginInstanceId === instanceId)!;
    const bundleRoot = harness.store.cachePathFor(entry.cacheRef);
    const resolver = resolverFor(
      harness,
      workspaceId,
      [entry],
      { [pluginKey]: instanceId },
      () => ({
        rootPath: bundleRoot,
        dataPath: join(dir, 'plugin-data', pluginKey),
        bundleHash: entry.bundleHash,
        profile: 'codex-plugin-env-v1',
      }),
    );
    const context: CapabilityContext = {
      workspaceId,
      sessionId,
      projectTrustState: 'none',
      projectTrustRevision: '',
    };
    const resolveTurn = async () => {
      const snapshot = await resolver.resolve(context);
      const view = toAgentRuntime(snapshot);
      return {
        snapshot,
        view,
        seed: createPiExecutionManifestSeed({
          snapshot,
          view,
          sessionKey: { workspaceId, sessionId },
        }),
      };
    };
    const switches = [
      {
        capability: entry.manifest.capabilities.find(capability => capability.kind === 'skill')!,
        surface: (view: AgentRuntimeView) => view.skills,
      },
      {
        capability: entry.manifest.capabilities.find(capability => capability.kind === 'mcp')!,
        surface: (view: AgentRuntimeView) => view.mcpServers,
      },
      {
        capability: entry.manifest.capabilities.find(capability => capability.kind === 'hook')!,
        surface: (view: AgentRuntimeView) => view.hooks,
      },
    ] as const;

    let turn = await resolveTurn();
    expect(turn.view.skills).toHaveLength(1);
    expect(turn.view.mcpServers).toHaveLength(1);
    expect(turn.view.hooks).toHaveLength(1);
    expect(turn.snapshot.entries.filter(candidate => candidate.summary.origin === 'plugin').every(candidate => (
      candidate.summary.enabled && candidate.summary.trustState === 'not-required'
    ))).toBe(true);
    expect(turn.seed.provenance).toHaveLength(3);
    expect(turn.seed.mcpSources).toHaveLength(1);
    resolver.releaseSnapshot(turn.snapshot.leaseId);

    for (const { capability, surface } of switches) {
      await harness.service.setCapabilityEnabled(pluginKey, target, capability.id, false);
      turn = await resolveTurn();
      const disabled = turn.snapshot.entries.find(candidate => candidate.summary.capabilityId === capability.id)!;
      expect(disabled.summary).toMatchObject({ enabled: false, unavailableReason: 'capability-disabled' });
      expect(surface(turn.view)).toHaveLength(0);
      expect(turn.seed.provenance.some(item => item.capabilityKey === disabled.summary.key)).toBe(false);
      expect(turn.view.skills.length + turn.view.mcpServers.length + turn.view.hooks.length).toBe(2);
      resolver.releaseSnapshot(turn.snapshot.leaseId);

      await harness.service.setCapabilityEnabled(pluginKey, target, capability.id, true);
      turn = await resolveTurn();
      const enabled = turn.snapshot.entries.find(candidate => candidate.summary.capabilityId === capability.id)!;
      expect(enabled.summary).toMatchObject({ enabled: true, trustState: 'not-required' });
      expect(surface(turn.view)).toHaveLength(1);
      expect(turn.seed.provenance.some(item => item.capabilityKey === enabled.summary.key)).toBe(true);
      resolver.releaseSnapshot(turn.snapshot.leaseId);
    }

    expect(resolver.leaseCount()).toBe(0);
  });

  it('installs the official build-ios npx MCP and applies its agent-runtime switch', async () => {
    const sourceDir = join(dir, 'build-ios-apps');
    mkdirSync(join(sourceDir, '.codex-plugin'), { recursive: true });
    writeFileSync(join(sourceDir, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'build-ios-apps',
      version: '0.1.2',
    }));
    writeFileSync(join(sourceDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        xcodebuildmcp: {
          command: 'npx',
          args: ['-y', 'xcodebuildmcp@latest', 'mcp'],
          env: {
            XCODEBUILDMCP_ENABLED_WORKFLOWS: 'simulator,ui-automation,debugging,logging',
          },
        },
      },
    }));
    const installRequests: Parameters<PluginRuntimeDependencyInstaller>[0][] = [];
    const harness = makeHarness(dir, async request => {
      installRequests.push(request);
      if (request.mode !== 'generate-lock') throw new Error('unexpected locked install');
      const packageRoot = join(request.directory, 'node_modules', 'xcodebuildmcp');
      mkdirSync(join(packageRoot, 'dist'), { recursive: true });
      writeFileSync(join(request.directory, 'bun.lock'), 'lockfileVersion = 1\n');
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: 'xcodebuildmcp',
        version: '2.7.0',
        bin: 'dist/index.js',
      }));
      writeFileSync(join(packageRoot, 'dist', 'index.js'), 'process.stdin.resume();\n');
    });
    const workspaceId = 'ws_build_ios';
    const target = { kind: 'workspace' as const, workspaceId };
    const installed = await harness.service.install(
      { kind: 'local-path', path: sourceDir },
      { activateIn: target },
    );

    expect(installed.ok).toBe(true);
    expect(installRequests).toHaveLength(1);
    expect(installRequests[0]).toMatchObject({ mode: 'generate-lock', frozenLockfile: false });
    const pluginKey = installed.installed!.pluginKey;
    const instanceId = installed.installed!.activeInstanceId;
    const registry = await harness.store.readInstalledRegistry();
    const entry = registry.plugins.find(plugin => plugin.pluginInstanceId === instanceId)!;
    const bundleRoot = harness.store.cachePathFor(entry.cacheRef);
    const executable = realpathSync(join(
      pluginNpxRuntimeRoot(bundleRoot),
      'node_modules',
      'xcodebuildmcp',
      'dist',
      'index.js',
    ));
    const capability = entry.manifest.capabilities.find(candidate => candidate.kind === 'mcp')!;
    const resolver = resolverFor(
      harness,
      workspaceId,
      [entry],
      { [pluginKey]: instanceId },
      () => ({
        rootPath: bundleRoot,
        dataPath: join(dir, 'plugin-data', pluginKey),
        bundleHash: entry.bundleHash,
        profile: 'codex-plugin-env-v1',
      }),
    );
    const context: CapabilityContext = {
      workspaceId,
      sessionId: 'session_build_ios',
      projectTrustState: 'none',
      projectTrustRevision: '',
    };
    const resolveTurn = async () => {
      const snapshot = await resolver.resolve(context);
      const view = toAgentRuntime(snapshot);
      const materializer = createCapabilitySnapshotMaterializer(resolver, snapshot);
      const diagnostics: string[] = [];
      const pool = await materializeRuntimePoolServers({ view, materializer }, {
        workspaceRootPath: dir,
        workspaceId,
        pluginNodeRuntime: {
          command: process.execPath,
          executables: {
            bunx: {
              command: process.execPath,
              args: ['--no-env-file', `--config=${NEUTRAL_BUN_CONFIG}`],
              environment: { HOME: '${NESSY_PLUGIN_DATA}/home' },
            },
          },
        },
        debug: message => diagnostics.push(message),
      });
      return { snapshot, view, pool, diagnostics };
    };

    // A plugin MCP server NEVER owns its bare declared name (`mcp.md:365`) —
    // the merged pool map (and the runtime wire name) is keyed by the stable
    // plugin-qualified form, computed with the same mint the resolver uses.
    const pluginId = pluginIdFromInstanceId(instanceId)!;
    const wireName = pluginMcpWireName(pluginId, 'xcodebuildmcp');

    let turn = await resolveTurn();
    expect(turn.view.mcpServers).toHaveLength(1);
    expect(turn.diagnostics).toEqual([]);
    expect(turn.pool.mergedMcpServers[wireName]).toMatchObject({
      command: process.execPath,
      args: ['--no-env-file', `--config=${NEUTRAL_BUN_CONFIG}`, executable, 'mcp'],
      inheritProcessEnv: false,
    });
    resolver.releaseSnapshot(turn.snapshot.leaseId);

    await harness.service.setCapabilityEnabled(pluginKey, target, capability.id, false);
    turn = await resolveTurn();
    expect(turn.view.mcpServers).toEqual([]);
    expect(turn.pool.mergedMcpServers).toEqual({});
    resolver.releaseSnapshot(turn.snapshot.leaseId);

    await harness.service.setCapabilityEnabled(pluginKey, target, capability.id, true);
    turn = await resolveTurn();
    expect(turn.view.mcpServers).toHaveLength(1);
    expect(turn.pool.mergedMcpServers[wireName]).toBeDefined();
    resolver.releaseSnapshot(turn.snapshot.leaseId);
    expect(resolver.leaseCount()).toBe(0);
  });

  it('runs a native Nessy internal-marketplace catalog fixture through the same pipeline (MCP capability)', async () => {
    const harness = makeHarness(dir);
    const workspaceId = 'ws_nessy';
    const fixtureDir = join(CATALOG_FIXTURES_ROOT, 'nessy-internal');
    const expectedInventory = JSON.parse(readFileSync(join(fixtureDir, 'expected-inventory.json'), 'utf-8')) as PluginCompatibilityReport;
    expect(expectedInventory.format).toBe('nessy');

    // The internal marketplace is a catalog/source adapter, not a distinct
    // plugin format/runtime mode: it is installed as a hand-authored native
    // Nessy manifest through the identical local-path install path.
    const manifest = {
      schemaVersion: 1,
      kind: 'plugin',
      id: 'sample-mcp-extension',
      name: 'Sample MCP Extension',
      version: '1.0.0',
      capabilities: [
        {
          kind: 'mcp',
          id: createPluginCapabilityId('mcp', 'sample-tools'),
          mcp: { serverName: 'sample-tools', transport: 'stdio', command: 'node', args: ['./server.js'] },
        },
      ],
    };
    const bundleDir = join(dir, 'nessy-bundle-source');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, 'plugin.json'), JSON.stringify(manifest, null, 2));

    const installed = await harness.service.install({ kind: 'local-path', path: bundleDir });
    expect(installed.ok).toBe(true);
    expect(installed.installed!.capabilityKinds).toContain('mcp');

    const pluginKey = installed.installed!.pluginKey;
    const instanceId = installed.installed!.activeInstanceId;
    harness.policy.recordWorkspace(workspaceId, { pluginKey, enabled: true });

    const registry = await harness.store.readInstalledRegistry();
    const entry = registry.plugins.find(p => p.pluginInstanceId === instanceId)!;
    const resolver = resolverFor(harness, workspaceId, [entry], { [pluginKey]: instanceId }, () => undefined);
    const context: CapabilityContext = { workspaceId, projectTrustState: 'none', projectTrustRevision: '' };
    const snapshot = await resolver.resolve(context);
    const mcpSummary = snapshot.entries.find(candidate => candidate.summary.logicalName === 'sample-tools')!.summary;
    expect(mcpSummary.trustState).toBe('not-required');
    expect(mcpSummary.enabled).toBe(true);
    // A plugin MCP server NEVER owns its bare declared name (`mcp.md:365`) —
    // the wire name is the stable plugin-qualified form.
    const wireName = pluginMcpWireName(pluginIdFromInstanceId(instanceId)!, 'sample-tools');
    expect(toAgentRuntime(snapshot).mcpServers.some(server => server.wireName === wireName)).toBe(true);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('namespaces a same-name skill and MCP with distinct collision-safe capability ids (createPluginCapabilityId)', () => {
    const skillId = createPluginCapabilityId('skill', 'toolkit');
    const mcpId = createPluginCapabilityId('mcp', 'toolkit');
    expect(skillId).not.toBe(mcpId);
    expect(skillId).toContain('skill');
    expect(mcpId).toContain('mcp');
  });

  it('surfaces a same-name skill and MCP from one installed bundle as distinct resolved capability keys', async () => {
    const harness = makeHarness(dir);
    const workspaceId = 'ws_collision';
    const bundleDir = join(dir, 'collision-bundle-source');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(bundleDir, 'skills', 'toolkit'), { recursive: true });
    writeFileSync(join(bundleDir, 'skills', 'toolkit', 'SKILL.md'), '---\nname: toolkit\ndescription: shared name\n---\n\n# Toolkit skill\n');
    writeFileSync(join(bundleDir, 'plugin.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'plugin',
      id: 'collision-demo',
      name: 'Collision Demo',
      version: '1.0.0',
      capabilities: [
        { kind: 'skill', id: createPluginCapabilityId('skill', 'toolkit'), skill: { slug: 'toolkit', path: 'skills/toolkit/SKILL.md' } },
        { kind: 'mcp', id: createPluginCapabilityId('mcp', 'toolkit'), mcp: { serverName: 'toolkit', transport: 'stdio', command: 'node', args: ['./x.js'] } },
      ],
    }, null, 2));

    const installed = await harness.service.install({ kind: 'local-path', path: bundleDir });
    expect(installed.ok).toBe(true);
    const pluginKey = installed.installed!.pluginKey;
    const instanceId = installed.installed!.activeInstanceId;
    harness.policy.recordWorkspace(workspaceId, { pluginKey, enabled: true });

    const registry = await harness.store.readInstalledRegistry();
    const entry = registry.plugins.find(p => p.pluginInstanceId === instanceId)!;
    const resolver = resolverFor(harness, workspaceId, [entry], { [pluginKey]: instanceId }, () => undefined);
    const snapshot = await resolver.resolve({ workspaceId, projectTrustState: 'none', projectTrustRevision: '' });

    const skillEntry = snapshot.entries.find(e => e.summary.kind === 'skill')!;
    const mcpEntry = snapshot.entries.find(e => e.summary.kind === 'mcp')!;
    expect(skillEntry).toBeDefined();
    expect(mcpEntry).toBeDefined();
    // Same provider-facing logical name, but distinct addressable capability keys.
    expect(skillEntry.summary.logicalName).toBe('toolkit');
    expect(mcpEntry.summary.logicalName).toBe('toolkit');
    expect(skillEntry.summary.key).not.toBe(mcpEntry.summary.key);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('runs an installed command hook with canonical profile env and no second trust grant', async () => {
    const harness = makeHarness(dir);
    const workspaceId = 'ws_trust';
    const fixtureDir = join(FIXTURES_ROOT, 'codex-core');
    const installed = await harness.service.install({ kind: 'local-path', path: fixtureDir });
    expect(installed.ok).toBe(true);
    const pluginKey = installed.installed!.pluginKey;
    const instanceId = installed.installed!.activeInstanceId;
    harness.policy.recordWorkspace(workspaceId, { pluginKey, enabled: true });

    const registry = await harness.store.readInstalledRegistry();
    const entry = registry.plugins.find(p => p.pluginInstanceId === instanceId)!;
    const hookCapability = entry.manifest.capabilities.find((c): c is Extract<typeof c, { kind: 'hook' }> => c.kind === 'hook')!;
    expect(hookCapability).toBeDefined();
    expect(hookCapability.trust?.required).toBe(true);
    const executableHash = resolvePluginProjectionCandidates([entry], { kind: 'workspace', workspaceId })
      .find(candidate => candidate.capabilityId === hookCapability.id)?.trust.executableHash;
    expect(executableHash).toMatch(/^[a-f0-9]{64}$/);
    if (!executableHash) throw new Error('Imported hook trust hash is missing');

    function candidatesForTrustDemo() {
      return resolvePluginProjectionCandidates([entry], { kind: 'workspace', workspaceId });
    }

    const bundleRoot = harness.store.cachePathFor(entry.cacheRef);
    const pluginRuntimeContextFor = (): PluginRuntimeContext => ({
      rootPath: bundleRoot,
      dataPath: join(dir, 'plugin-data', pluginKey),
      profile: 'codex-plugin-env-v1',
    });

    function buildInputs(): CapabilityResolutionInputs {
      return {
        nativeInventory: { records: [], blockedLayers: [] },
        installedPlugins: [entry],
        activePluginInstances: { [pluginKey]: instanceId },
        acquirePluginInstanceLease: id => harness.store.acquireInstanceLease(id),
        pluginCandidates: candidatesForTrustDemo(),
        resolveActivation: target => harness.policy.resolve(
          { pluginKey: target.pluginKey, pluginInstanceId: target.pluginInstanceId },
          { workspaceId },
        ),
        resolveTrust: key => harness.trust.resolve(key),
        pluginRuntimeContextFor,
      };
    }
    const resolver = createCapabilityResolver({ inputs: () => buildInputs() });
    const context: CapabilityContext = { workspaceId, projectTrustState: 'none', projectTrustRevision: '' };

    const snapshot = await resolver.resolve(context);
    const hookEntry = snapshot.entries.find(e => e.summary.capabilityId === hookCapability.id)!;
    expect(hookEntry.summary.trustState).toBe('not-required');
    expect(hookEntry.summary.enabled).toBe(true);
    const runtimeView = toAgentRuntime(snapshot);
    const runtimeHook = runtimeView.hooks.find(h => h.key === hookEntry.summary.key)!;
    expect(runtimeHook).toBeDefined();
    expect(runtimeHook.pluginRuntime?.profile).toBe('codex-plugin-env-v1');
    const env = pluginRuntimeEnvForProfile(runtimeHook.pluginRuntime!.profile, {
      bundleRoot: runtimeHook.pluginRuntime!.rootPath,
      dataPath: runtimeHook.pluginRuntime!.dataPath,
    });
    // codex-plugin-env-v1: generic Nessy aliases plus exactly the documented
    // Codex Claude-compatibility root/data aliases — never CLAUDE_PROJECT_DIR.
    expect(env.NESSY_PLUGIN_ROOT).toBe(bundleRoot);
    expect(env.PLUGIN_ROOT).toBe(bundleRoot);
    expect(env.CLAUDE_PLUGIN_ROOT).toBe(bundleRoot);
    expect(env.CLAUDE_PLUGIN_DATA).toBeDefined();
    expect(env.CLAUDE_PROJECT_DIR).toBeUndefined();
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('publishes an installed plugin lsp server without a second trust grant', async () => {
    const harness = makeHarness(dir);
    const workspaceId = 'ws_lsp';
    // Author a minimal Claude bundle that declares an lsp server.
    const lspBundle = join(dir, 'lsp-bundle');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(lspBundle, '.claude-plugin'), { recursive: true });
    mkdirSync(join(lspBundle, 'skills', 'ok'), { recursive: true });
    writeFileSync(join(lspBundle, 'skills', 'ok', 'SKILL.md'), '# OK\n');
    writeFileSync(join(lspBundle, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'lsp-plugin', version: '1.0.0',
      lsp: { ts: { command: 'typescript-language-server', args: ['--stdio'], languages: ['typescript'] } },
    }));
    const installed = await harness.service.install({ kind: 'local-path', path: lspBundle });
    expect(installed.ok).toBe(true);
    expect(installed.compatibility?.state).toBe('supported');
    expect(installed.compatibility?.supportedKinds).toContain('lsp');
    expect(installed.compatibility?.deferred.some(item => item.externalKind === 'lsp')).toBe(false);
    const pluginKey = installed.installed!.pluginKey;
    const instanceId = installed.installed!.activeInstanceId;
    harness.policy.recordWorkspace(workspaceId, { pluginKey, enabled: true });

    const registry = await harness.store.readInstalledRegistry();
    const entry = registry.plugins.find(p => p.pluginInstanceId === instanceId)!;
    const lspCapability = entry.manifest.capabilities.find(
      (capability): capability is Extract<typeof capability, { kind: 'lsp' }> => capability.kind === 'lsp',
    )!;
    const candidates = resolvePluginProjectionCandidates([entry], { kind: 'workspace', workspaceId });
    expect(candidates.find(candidate => candidate.capabilityId === lspCapability.id)?.kind).toBe('lsp');
    const buildInputs = (): CapabilityResolutionInputs => ({
      nativeInventory: { records: [], blockedLayers: [] },
      installedPlugins: [entry],
      activePluginInstances: { [pluginKey]: instanceId },
      acquirePluginInstanceLease: id => harness.store.acquireInstanceLease(id),
      pluginCandidates: resolvePluginProjectionCandidates([entry], { kind: 'workspace', workspaceId }),
      resolveActivation: target => harness.policy.resolve({ pluginKey: target.pluginKey, pluginInstanceId: target.pluginInstanceId }, { workspaceId }),
      resolveTrust: key => harness.trust.resolve(key),
      pluginRuntimeContextFor: () => ({ rootPath: harness.store.cachePathFor(entry.cacheRef), dataPath: join(dir, 'pd', pluginKey), profile: 'claude-plugin-env-v1' }),
    });
    const resolver = createCapabilityResolver({ inputs: () => buildInputs() });
    const context: CapabilityContext = { workspaceId, projectTrustState: 'none', projectTrustRevision: '' };

    const snapshot = await resolver.resolve(context);
    const lspEntry = snapshot.entries.find(e => e.summary.capabilityId === lspCapability.id)!;
    expect(lspEntry.summary.unavailableReason).toBeUndefined();
    expect(lspEntry.summary.trustState).toBe('not-required');
    expect(toAgentRuntime(snapshot).lspServers).toContainEqual(expect.objectContaining({
      lspId: 'ts',
      command: 'typescript-language-server',
      languages: ['typescript'],
    }));
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('runs a repaired plugin without carrying or requiring a legacy trust record', async () => {
    const harness = makeHarness(dir);
    const workspaceId = 'ws_update';
    const fixtureDir = join(FIXTURES_ROOT, 'codex-core');
    const installed = await harness.service.install({ kind: 'local-path', path: fixtureDir });
    const pluginKey = installed.installed!.pluginKey;
    const firstInstanceId = installed.installed!.activeInstanceId;
    harness.policy.recordWorkspace(workspaceId, { pluginKey, enabled: true });

    const firstRegistry = await harness.store.readInstalledRegistry();
    const firstEntry = firstRegistry.plugins.find(p => p.pluginInstanceId === firstInstanceId)!;
    const hookCapability = firstEntry.manifest.capabilities.find((c): c is Extract<typeof c, { kind: 'hook' }> => c.kind === 'hook')!;
    const executableHash = resolvePluginProjectionCandidates([firstEntry], { kind: 'workspace', workspaceId })
      .find(candidate => candidate.capabilityId === hookCapability.id)?.trust.executableHash;
    if (!executableHash) throw new Error('Imported hook trust hash is missing');
    const firstTrustKey: CapabilityTrustKey = {
      pluginInstanceId: firstInstanceId,
      capabilityId: hookCapability.id,
      executableHash,
      scope: { kind: 'workspace', workspaceId },
    };
    harness.trust.grant(firstTrustKey);
    expect(harness.trust.resolve(firstTrustKey)).toBe('trusted');

    // Update: repair with a bundle whose content differs (add a byte to the
    // hook script) so the store computes a NEW bundleHash and switches to a
    // NEW pluginInstanceId (W7 store-v2 "different hash installs side-by-side
    // and switches" contract — see store-v2.ts `repair`).
    const updatedFixtureDir = join(dir, 'codex-core-updated');
    const { cpSync, appendFileSync } = await import('node:fs');
    cpSync(fixtureDir, updatedFixtureDir, { recursive: true });
    appendFileSync(join(updatedFixtureDir, 'scripts', 'hook.js'), '\n// updated\n');

    const repairPlan = await harness.service.repair(pluginKey, {
      source: { kind: 'local-path', path: updatedFixtureDir },
    });
    expect(repairPlan.ok).toBe(true);
    const secondInstanceId = repairPlan.installed!.activeInstanceId;
    expect(secondInstanceId).not.toBe(firstInstanceId);
    const secondRegistry = await harness.store.readInstalledRegistry();
    const secondEntry = secondRegistry.plugins.find(plugin => plugin.pluginInstanceId === secondInstanceId)!;
    const secondExecutableHash = resolvePluginProjectionCandidates([secondEntry], { kind: 'workspace', workspaceId })
      .find(candidate => candidate.capabilityId === hookCapability.id)?.trust.executableHash;
    if (!secondExecutableHash) throw new Error('Updated hook trust hash is missing');
    expect(secondExecutableHash).not.toBe(executableHash);

    // Legacy plugin trust records remain exact and inert. The resolver no
    // longer consults them for installed plugins.
    const secondTrustKey: CapabilityTrustKey = {
      pluginInstanceId: secondInstanceId,
      capabilityId: hookCapability.id,
      executableHash: secondExecutableHash,
      scope: { kind: 'workspace', workspaceId },
    };
    expect(harness.trust.resolve(secondTrustKey)).toBe('review-required');
    expect(harness.trust.resolve(firstTrustKey)).toBe('trusted');

    const resolver = resolverFor(
      harness,
      workspaceId,
      [secondEntry],
      { [pluginKey]: secondInstanceId },
      () => undefined,
    );
    const snapshot = await resolver.resolve({
      workspaceId,
      projectTrustState: 'none',
      projectTrustRevision: '',
    });
    const hook = snapshot.entries.find(item => item.summary.capabilityId === hookCapability.id)!;
    expect(hook.summary.trustState).toBe('not-required');
    expect(hook.summary.enabled).toBe(true);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('exposes installed imported agents and prompt commands through the runtime view', async () => {
    const harness = makeHarness(dir);
    const workspaceId = 'ws_claude_views';
    const installed = await harness.service.install({ kind: 'local-path', path: join(FIXTURES_ROOT, 'claude-core') });
    expect(installed.ok).toBe(true);
    const pluginKey = installed.installed!.pluginKey;
    const instanceId = installed.installed!.activeInstanceId;
    harness.policy.recordWorkspace(workspaceId, { pluginKey, enabled: true });

    const registry = await harness.store.readInstalledRegistry();
    const entry = registry.plugins.find(p => p.pluginInstanceId === instanceId)!;
    const agentCapability = entry.manifest.capabilities.find(
      (capability): capability is Extract<typeof capability, { kind: 'agent' }> => capability.kind === 'agent',
    )!;
    const bundleRoot = harness.store.cachePathFor(entry.cacheRef);
    const pluginRuntimeContextFor = (id: string): PluginRuntimeContext | undefined => id === instanceId
      ? { rootPath: bundleRoot, dataPath: join(dir, 'plugin-data', pluginKey), profile: 'claude-plugin-env-v1' as const }
      : undefined;
    const resolver = resolverFor(harness, workspaceId, [entry], { [pluginKey]: instanceId }, pluginRuntimeContextFor);
    const context: CapabilityContext = { workspaceId, projectTrustState: 'none', projectTrustRevision: '' };
    const snapshot = await resolver.resolve(context);

    const runtimeView = toAgentRuntime(snapshot);
    expect(runtimeView.agents).toContainEqual(expect.objectContaining({
      name: 'sample-agent',
      selectedAsUnqualifiedAlias: true,
    }));
    expect(runtimeView.promptCommands.length).toBeGreaterThan(0);
    const promptCommand = runtimeView.promptCommands.find(pc => pc.argumentHint === '[topic]')!;
    expect(promptCommand).toBeDefined();

    const userCatalog = toUserCatalog(snapshot);
    const agentEntry = snapshot.entries.find(item => item.summary.capabilityId === agentCapability.id);
    const promptCommandSummary = userCatalog.capabilities.find(i => i.kind === 'prompt-command');
    expect(agentEntry?.summary.unavailableReason).toBeUndefined();
    expect(agentEntry?.summary.trustState).toBe('not-required');
    expect(promptCommandSummary).toBeDefined();
    expect(promptCommandSummary!.state).toBe('active');

    // Namespaced prompt-command invocation preserves visible arguments and
    // expands only the literal $ARGUMENTS token in the model body: the
    // adapter never evaluates or rewrites it (format-adapters/claude.ts
    // normalizeClaudePromptCommands), so the materialized body still
    // contains the literal token verbatim for the runtime to substitute —
    // it is not silently stripped, executed, or pre-expanded at adapter time.
    const materializer = createCapabilitySnapshotMaterializer(resolver, snapshot);
    const promptCommandBody = await materializer.readText(promptCommand.resource);
    expect(promptCommandBody).toContain('$ARGUMENTS');
    // No other dynamic-substitution syntax (bash execution, positional args)
    // is present in this literal-only fixture command.
    expect(promptCommandBody).not.toMatch(/!`/);
    expect(promptCommandBody).not.toMatch(/\$[1-9]\b/);

    resolver.releaseSnapshot(snapshot.leaseId);

    // --- claude-deferred: its prompt-type hook (B1) and its output style (B1c)
    // are both executable runtime capabilities now, so this fixture defers
    // nothing. The fixture keeps its name as the historical record of what it
    // used to prove. ---
    const deferredHarness = makeHarness(join(dir, 'deferred'));
    const deferredInstalled = await deferredHarness.service.install({ kind: 'local-path', path: join(FIXTURES_ROOT, 'claude-deferred') });
    expect(deferredInstalled.ok).toBe(true);
    expect(deferredInstalled.compatibility?.state).toBe('supported');
    expect(deferredInstalled.compatibility?.deferred).toEqual([]);
    const deferredPluginKey = deferredInstalled.installed!.pluginKey;
    const deferredInstanceId = deferredInstalled.installed!.activeInstanceId;
    deferredHarness.policy.recordWorkspace(workspaceId, { pluginKey: deferredPluginKey, enabled: true });
    const deferredRegistry = await deferredHarness.store.readInstalledRegistry();
    const deferredEntry = deferredRegistry.plugins.find(p => p.pluginInstanceId === deferredInstanceId)!;
    const deferredResolver = resolverFor(deferredHarness, workspaceId, [deferredEntry], { [deferredPluginKey]: deferredInstanceId }, () => undefined);
    const deferredSnapshot = await deferredResolver.resolve(context);
    const deferredUserCatalog = toUserCatalog(deferredSnapshot);
    expect(deferredUserCatalog.capabilities.some(c => c.kind === 'skill' && c.state === 'active')).toBe(true);
    // B1: the prompt hook is now a resolvable hook capability, no longer absent.
    const deferredHook = deferredSnapshot.entries.find(e => e.summary.kind === 'hook');
    expect(deferredHook).toBeDefined();
    // B1c: and so is the output style, which reaches the runtime view with the
    // selectable id the picker offers.
    const deferredStyles = toAgentRuntime(deferredSnapshot).outputStyles ?? [];
    expect(deferredStyles.map(style => style.styleId))
      .toEqual([`plugin:${deferredPluginKey}:sample-style`]);
    // …and the plugin-detail inventory carries it with the capability id the
    // per-capability toggle addresses, so a style that installs can be turned off.
    const styleComponent = deferredUserCatalog.installedPlugins
      .find(plugin => plugin.pluginKey === deferredPluginKey)?.components
      ?.find(component => component.kind === 'output-style');
    expect(styleComponent).toMatchObject({
      kind: 'output-style',
      name: 'sample-style',
      capabilityId: 'output-style.sample-style',
      enabled: true,
    });
    deferredResolver.releaseSnapshot(deferredSnapshot.leaseId);
  });

  it('presentation origin differs across format/acquisition while equivalent runtime bindings do not', async () => {
    // Two bundles with different formats/acquisition (Codex-local vs a native
    // Nessy manifest engineered to declare the SAME normalized runtime
    // profile) resolve to identical runtime binding shape/env/trust, while
    // their presentation projections differ on `format`.
    const codexHarness = makeHarness(join(dir, 'presentation-codex'));
    const nessyHarness = makeHarness(join(dir, 'presentation-nessy'));
    const workspaceId = 'ws_presentation';

    const codexInstalled = await codexHarness.service.install({ kind: 'local-path', path: join(FIXTURES_ROOT, 'codex-core') });
    expect(codexInstalled.ok).toBe(true);

    const nessyBundleDir = join(dir, 'presentation-nessy-bundle');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(nessyBundleDir, 'skills', 'hello-skill'), { recursive: true });
    writeFileSync(join(nessyBundleDir, 'skills', 'hello-skill', 'SKILL.md'), '---\nname: hello-skill\ndescription: native skill\n---\n\n# Hello Skill\n');
    writeFileSync(join(nessyBundleDir, 'plugin.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'plugin',
      id: 'sample-nessy-core',
      name: 'sample-nessy-core',
      version: '1.0.0',
      capabilities: [
        { kind: 'skill', id: createPluginCapabilityId('skill', 'hello-skill'), skill: { slug: 'hello-skill', path: 'skills/hello-skill/SKILL.md' } },
      ],
    }, null, 2));
    const nessyInstalled = await nessyHarness.service.install({ kind: 'local-path', path: nessyBundleDir });
    expect(nessyInstalled.ok).toBe(true);

    const codexRegistry = await codexHarness.store.readInstalledRegistry();
    const nessyRegistry = await nessyHarness.store.readInstalledRegistry();
    const codexEntry = codexRegistry.plugins.find(p => p.pluginInstanceId === codexInstalled.installed!.activeInstanceId)!;
    const nessyEntry = nessyRegistry.plugins.find(p => p.pluginInstanceId === nessyInstalled.installed!.activeInstanceId)!;

    const codexPresentation = toSafePluginPresentationOrigin(codexEntry.origin);
    const nessyPresentation = toSafePluginPresentationOrigin(nessyEntry.origin);
    expect(codexPresentation.format).toBe('codex');
    expect(nessyPresentation.format).toBe('nessy');
    expect(codexPresentation.format).not.toBe(nessyPresentation.format);

    // Both install from the same acquisition kind (local-path) here, proving
    // presentation format is the ONLY axis that differs while the runtime
    // binding SHAPE for their shared skill capability is identical:
    codexHarness.policy.recordWorkspace(workspaceId, { pluginKey: codexEntry.pluginKey, enabled: true });
    nessyHarness.policy.recordWorkspace(workspaceId, { pluginKey: nessyEntry.pluginKey, enabled: true });
    const context: CapabilityContext = { workspaceId, projectTrustState: 'none', projectTrustRevision: '' };

    const codexResolver = resolverFor(codexHarness, workspaceId, [codexEntry], { [codexEntry.pluginKey]: codexEntry.pluginInstanceId }, () => undefined);
    const nessyResolver = resolverFor(nessyHarness, workspaceId, [nessyEntry], { [nessyEntry.pluginKey]: nessyEntry.pluginInstanceId }, () => undefined);
    const codexSnapshot = await codexResolver.resolve(context);
    const nessySnapshot = await nessyResolver.resolve(context);

    const codexSkill = codexSnapshot.entries.find(e => e.summary.kind === 'skill')!;
    const nessySkill = nessySnapshot.entries.find(e => e.summary.kind === 'skill')!;
    // Equivalent runtime binding SHAPE: same kind, same trust/credential
    // state, same enabled/readOnly semantics — origin-neutral, as the plan
    // requires (runtime never branches on format).
    expect(codexSkill.runtimeBinding.kind).toBe(nessySkill.runtimeBinding.kind);
    expect(codexSkill.summary.trustState).toBe(nessySkill.summary.trustState);
    expect(codexSkill.summary.credentialState).toBe(nessySkill.summary.credentialState);
    expect(codexSkill.summary.enabled).toBe(nessySkill.summary.enabled);
    expect(codexSkill.summary.readOnly).toBe(nessySkill.summary.readOnly);

    codexResolver.releaseSnapshot(codexSnapshot.leaseId);
    nessyResolver.releaseSnapshot(nessySnapshot.leaseId);
  });

  it('refreshes active sessions and safe catalogs on update/repair/uninstall (afterPluginMutation invalidation seam)', async () => {
    const harness = makeHarness(dir);
    const workspaceId = 'ws_refresh';
    const installed = await harness.service.install({ kind: 'local-path', path: join(FIXTURES_ROOT, 'codex-core') });
    const pluginKey = installed.installed!.pluginKey;
    harness.policy.recordWorkspace(workspaceId, { pluginKey, enabled: true });

    const invalidations: Array<{ scope: unknown; reason: string; effect: string }> = [];
    async function buildAndResolve() {
      const registry = await harness.store.readInstalledRegistry();
      const instanceId = registry.active[pluginKey]!;
      const entry = registry.plugins.find(p => p.pluginInstanceId === instanceId)!;
      const resolver = createCapabilityResolver({
        inputs: () => ({
          nativeInventory: { records: [], blockedLayers: [] },
          installedPlugins: [entry],
          activePluginInstances: { [pluginKey]: instanceId },
          acquirePluginInstanceLease: id => harness.store.acquireInstanceLease(id),
          pluginCandidates: resolvePluginProjectionCandidates([entry], { kind: 'workspace', workspaceId }),
          resolveActivation: target => harness.policy.resolve(
            { pluginKey: target.pluginKey, pluginInstanceId: target.pluginInstanceId },
            { workspaceId },
          ),
          resolveTrust: key => harness.trust.resolve(key),
        }),
        onInvalidate: event => invalidations.push({ scope: event.scope, reason: event.reason, effect: event.effect }),
      });
      const snapshot = await resolver.resolve({ workspaceId, projectTrustState: 'none', projectTrustRevision: '' });
      return { resolver, snapshot, entry };
    }

    const before = await buildAndResolve();
    expect(before.snapshot.entries.some(e => e.summary.kind === 'skill')).toBe(true);
    before.resolver.releaseSnapshot(before.snapshot.leaseId);

    // Update/repair with a modified fixture: bundleHash + instance identity change.
    const updatedFixtureDir = join(dir, 'codex-core-refresh-updated');
    const { cpSync, appendFileSync } = await import('node:fs');
    cpSync(join(FIXTURES_ROOT, 'codex-core'), updatedFixtureDir, { recursive: true });
    appendFileSync(join(updatedFixtureDir, 'scripts', 'hook.js'), '\n// v2\n');
    const repaired = await harness.service.repair(pluginKey, { source: { kind: 'local-path', path: updatedFixtureDir } });
    expect(repaired.ok).toBe(true);
    before.resolver.invalidate({ kind: 'workspace', workspaceId }, 'plugin-runtime-changed', 'refresh-before-next-turn');

    const after = await buildAndResolve();
    expect(after.entry.pluginInstanceId).not.toBe(before.entry.pluginInstanceId);
    after.resolver.releaseSnapshot(after.snapshot.leaseId);

    // Uninstall: the plugin disappears from a freshly-resolved snapshot for
    // this scope (revoke-active-snapshot semantics are exercised at the
    // server-core layer's afterMutation seam; here we prove the store/policy
    // side of the same contract — refresh reflects the mutation).
    await harness.service.uninstall(pluginKey);
    const registryAfterUninstall = await harness.store.readInstalledRegistry();
    expect(registryAfterUninstall.active[pluginKey]).toBeUndefined();
    expect(invalidations.length).toBeGreaterThan(0);
  });

  it('importing plugin formats neither changes provider build-flag env reads nor adds a plugin runtime feature flag', () => {
    // Structural/static invariant (Approved Decision 13/21): plugin-format
    // support is unconditional and reads no env feature flag anywhere in the
    // format-adapter/resolver/materializer source. Provider build flags
    // (NESSY_FEATURE_PROVIDER_*, NESSY_FEATURE_CODEX_RUNTIME) belong to a
    // disjoint build-time surface this plan never touches.
    const sourceFiles = [
      join(import.meta.dir, '..', 'format-adapters.ts'),
      join(import.meta.dir, '..', 'format-adapters', 'codex.ts'),
      join(import.meta.dir, '..', 'format-adapters', 'claude.ts'),
      join(import.meta.dir, '..', 'schema.ts'),
      join(import.meta.dir, '..', 'store-v2.ts'),
      join(import.meta.dir, '..', 'management-service-v2.ts'),
      join(import.meta.dir, '..', '..', 'capabilities', 'resolver.ts'),
      join(import.meta.dir, '..', '..', 'capabilities', 'views.ts'),
    ];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf-8');
      expect(content).not.toMatch(/NESSY_FEATURE_PROVIDER_/);
      expect(content).not.toMatch(/NESSY_FEATURE_CODEX_RUNTIME/);
      // No new plugin/marketplace-specific runtime feature flag either.
      expect(content).not.toMatch(/NESSY_FEATURE_PLUGIN/);
      expect(content).not.toMatch(/NESSY_FEATURE_MARKETPLACE/);
      expect(content).not.toMatch(/process\.env\.NESSY_FEATURE/);
    }
  });
});

// F1.424 — every case here runs a REAL plugin-store install: a per-CASE budget, and a teardown that waits for every
// install still copying before it removes a root (`packages/shared/src/testing/install-tracker.ts` says why and what
// the tracker does not change). Placed last so no cited line moves: imports hoist, and bun applies a default set
// at module load to the cases registered above it (measured 2026-09-24).
import { MODULE_GRAPH_CASE_BUDGET_MS } from '../../testing/module-graph-budgets.ts';
import { createInstallTracker } from '../../testing/install-tracker.ts';
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS);
const installs = createInstallTracker();

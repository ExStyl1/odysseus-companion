import { describe, expect, it } from 'bun:test';
import { normalizeNessyPluginManifest } from '../schema.ts';
import { resolvePluginProjectionCandidates } from '../projection-candidates.ts';
import {
  createCapabilityResolver,
  type CapabilityContext,
  type CapabilityResolutionInputs,
  type PluginRuntimeContext,
} from '../../capabilities/resolver.ts';
import { buildHeadlessInitView, toUserCatalog } from '../../capabilities/views.ts';
import type { PluginInstalledEntryV2 } from '../store-v2.ts';
import type { NessyPluginManifest, PluginCacheRef, PluginOrigin } from '../types.ts';
import type { CapabilityScopeRef } from '../../capabilities/types.ts';

const SCOPE: CapabilityScopeRef = { kind: 'workspace', workspaceId: 'ws_a' };

function origin(): PluginOrigin {
  return { source: 'marketplace', marketplaceId: 'internal', resolvedAt: 1 };
}

function entry(pluginId: string, manifest: NessyPluginManifest): PluginInstalledEntryV2 {
  const bundleHash = 'a'.repeat(64);
  const cacheRef: PluginCacheRef = { marketplaceId: 'internal', pluginId, version: manifest.version, bundleHash };
  return {
    pluginInstanceId: `plugin://internal/${pluginId}@${manifest.version}#${bundleHash}`,
    pluginKey: `key-${pluginId}`,
    marketplaceId: 'internal',
    pluginId,
    version: manifest.version,
    bundleHash,
    cacheRef,
    manifest,
    origin: origin(),
    installedAt: 1,
    diagnostics: [],
  };
}

function manifest(id: string, capabilities: NessyPluginManifest['capabilities']): NessyPluginManifest {
  return { schemaVersion: 1, kind: 'plugin', id, name: id, version: '1.0.0', capabilities };
}

describe('resolvePluginProjectionCandidates', () => {
  it('projects skills from the immutable bundle with no native target path', () => {
    const e = entry('toolkit', manifest('toolkit', [
      {
        kind: 'skill',
        id: 'review',
        displayName: 'Review Changes',
        description: 'Review a change before it lands',
        skill: { slug: 'review', path: 'skills/review/SKILL.md' },
      },
    ]));
    const [candidate] = resolvePluginProjectionCandidates([e], SCOPE);
    expect(candidate?.kind).toBe('skill');
    expect(candidate?.logicalName).toBe('review');
    expect(candidate).toMatchObject({
      displayName: 'Review Changes',
      description: 'Review a change before it lands',
    });
    expect(candidate?.resource).toEqual({
      pluginInstanceId: e.pluginInstanceId,
      relativePath: 'skills/review/SKILL.md',
      contentHash: e.bundleHash,
    });
    // No fake native target path is present anywhere on the candidate.
    expect(JSON.stringify(candidate)).not.toContain('targetPath');
    expect(JSON.stringify(candidate)).not.toContain('sourcePath');
  });

  it('keeps duplicate skill slugs across plugins as separate candidates', () => {
    const a = entry('a', manifest('a', [{ kind: 'skill', id: 's', skill: { slug: 'review', path: 'a/SKILL.md' } }]));
    const b = entry('b', manifest('b', [{ kind: 'skill', id: 's', skill: { slug: 'review', path: 'b/SKILL.md' } }]));
    const candidates = resolvePluginProjectionCandidates([a, b], SCOPE);
    expect(candidates.filter(c => c.logicalName === 'review')).toHaveLength(2);
    expect(new Set(candidates.map(c => c.key)).size).toBe(2);
  });

  it('applies a host-derived trust floor to dangerous plugin capabilities', () => {
    const e = entry('bypass', manifest('bypass', [
      {
        kind: 'mcp',
        id: 'remote',
        trust: { required: false, executableHash: 'attacker' },
        mcp: { serverName: 'remote', transport: 'http', url: 'https://example.invalid/mcp' },
      },
      { kind: 'skill', id: 'docs', skill: { slug: 'docs', path: 'skills/docs/SKILL.md' } },
    ]));

    const candidates = resolvePluginProjectionCandidates([e], SCOPE);
    const mcp = candidates.find(candidate => candidate.kind === 'mcp')!;
    const skill = candidates.find(candidate => candidate.kind === 'skill')!;
    expect(mcp.trust.required).toBe(true);
    expect(mcp.trust.executableHash).toMatch(/^[a-f0-9]{64}$/);
    expect(mcp.trust.executableHash).not.toBe('attacker');
    expect(skill.trust.required).toBe(false);
  });

  it('drops the resource for a traversing/absolute bundle path but keeps the candidate', () => {
    const e = entry('bad', manifest('bad', [
      { kind: 'skill', id: 'x', skill: { slug: 'x', path: '../escape/SKILL.md' } },
    ]));
    const [candidate] = resolvePluginProjectionCandidates([e], SCOPE);
    expect(candidate?.resource).toBeUndefined();
    expect(candidate?.kind).toBe('skill');
  });

  it('retains setting/command/asset capabilities without nessyExtensions provenance as unsupported-runtime', () => {
    // e.g. an older adapter (or a hand-written manifest) that still declares
    // these kinds directly in capabilities without the namespaced section.
    const m = manifest('legacyish', [
      { kind: 'setting', id: 'mode', setting: { key: 'mode', valueType: 'string' } },
      { kind: 'command', id: 'sync', command: { command: 'sync' } },
      { kind: 'asset', id: 'logo', asset: { path: 'assets/logo.svg' } },
    ]);
    const candidates = resolvePluginProjectionCandidates([entry('legacyish', m)], SCOPE);
    // Never active without explicit provenance, but never silently discarded.
    expect(candidates.map(c => c.kind)).toEqual(['unsupported-runtime', 'unsupported-runtime', 'unsupported-runtime']);
    expect(candidates.map(c => c.logicalName)).toEqual(['mode', 'sync', 'assets/logo.svg']);
  });

  it('projects explicitly namespaced primitive settings without duplicates', () => {
    const m = manifest('provenanced', [
      { kind: 'setting', id: 'mode', setting: { key: 'mode', valueType: 'string' } },
      { kind: 'setting', id: 'other', setting: { key: 'other', valueType: 'string' } },
    ]);
    m.nessyExtensions = { settings: [{ key: 'mode', valueType: 'string' }] };
    const candidates = resolvePluginProjectionCandidates([entry('provenanced', m)], SCOPE);

    const retained = candidates.filter(c => c.kind === 'unsupported-runtime');
    expect(candidates.filter(c => c.kind === 'setting').map(c => c.logicalName)).toEqual(['mode']);
    expect(retained.map(c => c.logicalName)).toEqual(['other']);
  });

  it('projects trusted agents and prompt commands with immutable bundle resources', () => {
    const m = manifest('withAgent', [
      {
        kind: 'agent',
        id: 'reviewer',
        displayName: 'Reviewer',
        agent: { name: 'reviewer', path: 'agents/reviewer.md', model: 'sonnet' },
      },
      {
        kind: 'prompt-command',
        id: 'summarize',
        promptCommand: { name: 'summarize', path: 'commands/summarize.md', argumentHint: '<topic>' },
      },
    ]);
    const e = entry('withAgent', m);
    const candidates = resolvePluginProjectionCandidates([e], SCOPE);
    expect(candidates.map(c => c.kind)).toEqual(['agent', 'prompt-command']);

    const agentCandidate = candidates.find(c => c.capabilityId === 'reviewer')!;
    expect(agentCandidate.logicalName).toBe('reviewer');
    expect(agentCandidate.resource).toEqual({
      pluginInstanceId: e.pluginInstanceId,
      relativePath: 'agents/reviewer.md',
      contentHash: e.bundleHash,
    });
    expect(agentCandidate.trust.required).toBe(true);

    const promptCandidate = candidates.find(c => c.kind === 'prompt-command')!;
    expect(promptCandidate.logicalName).toBe('summarize');
    expect(promptCandidate.resource).toEqual({
      pluginInstanceId: e.pluginInstanceId,
      relativePath: 'commands/summarize.md',
      contentHash: e.bundleHash,
    });
  });

  it('projects trusted language servers and monitors with pinned bundle identity', () => {
    const e = entry('peripherals', manifest('peripherals', [
      {
        kind: 'lsp', id: 'typescript',
        lsp: { id: 'typescript', command: '${NESSY_PLUGIN_ROOT}/bin/ts-lsp', languages: ['typescript'] },
      },
      {
        kind: 'monitor', id: 'remind',
        monitor: { id: 'remind', path: 'monitors/remind.md', cron: '0 * * * *', timezone: 'UTC' },
      },
    ]));

    const candidates = resolvePluginProjectionCandidates([e], SCOPE);
    expect(candidates.map(candidate => candidate.kind)).toEqual(['lsp', 'monitor']);
    expect(candidates.every(candidate => candidate.trust.required)).toBe(true);
    expect(candidates.find(candidate => candidate.kind === 'monitor')?.resource).toEqual({
      pluginInstanceId: e.pluginInstanceId,
      relativePath: 'monitors/remind.md',
      contentHash: e.bundleHash,
    });
  });

  it('projects an unsupported capability as an unsupported-runtime candidate, never a generic asset', () => {
    const m = manifest('withUnsupported', [
      {
        kind: 'unsupported',
        id: 'mcp.xcodebuildmcp',
        displayName: 'xcodebuildmcp',
        unsupported: {
          externalKind: 'mcp',
          sourcePath: '.mcp.json.xcodebuildmcp',
          reasonCode: 'plugin.deferred.codex_mcp_npx_unmaterialized',
          executable: true,
        },
      },
    ]);
    const [candidate] = resolvePluginProjectionCandidates([entry('withUnsupported', m)], SCOPE);
    expect(candidate?.kind).toBe('unsupported-runtime');
    expect(candidate?.kind).not.toBe('asset');
    expect(candidate?.logicalName).toBe('xcodebuildmcp');
    expect(candidate?.componentKind).toBe('mcp');
  });

  it('projects apps and nessyExtensions candidates', () => {
    const m = manifest('conn', []);
    m.apps = [{ id: 'gmail', connectorId: 'connector://gmail' }];
    m.nessyExtensions = {
      settings: [{ key: 'token', valueType: 'string' }],
      commands: [{ command: 'sync' }],
      assets: [{ path: 'assets/icon.svg' }],
    };
    const candidates = resolvePluginProjectionCandidates([entry('conn', m)], SCOPE);
    expect(candidates.map(c => c.kind).sort()).toEqual([
      'app', 'setting', 'unsupported-runtime', 'unsupported-runtime',
    ]);
    expect(candidates.find(c => c.kind === 'app')?.logicalName).toBe('gmail');
    expect(candidates.find(c => c.kind === 'setting')?.logicalName).toBe('token');
    expect(candidates.filter(c => c.kind === 'unsupported-runtime').map(c => c.logicalName)).toEqual(['sync', 'assets/icon.svg']);
  });

  it('attaches the resolved connector to an app candidate that routes to it (K1)', () => {
    const m = manifest('conn', []);
    m.apps = [{ id: 'gmail-app', displayName: 'Gmail', connectorId: 'gmail' }];
    m.connectors = [{
      id: 'gmail',
      displayName: 'Gmail Connector',
      description: 'Email over MCP',
      mcpServers: [{ serverName: 'gmail-mcp', transport: 'http', url: 'https://example.invalid/mcp' }],
      auth: { type: 'oauth', timing: 'ON_FIRST_USE' },
    }];
    const candidates = resolvePluginProjectionCandidates([entry('conn', m)], SCOPE);
    const app = candidates.find(c => c.kind === 'app');
    expect(app?.logicalName).toBe('gmail-app');
    expect(app?.displayName).toBe('Gmail');
    expect(app?.description).toBe('Email over MCP');
    expect(app?.app).toEqual({ id: 'gmail-app', displayName: 'Gmail', connectorId: 'gmail' });
    expect(app?.connector?.id).toBe('gmail');
    expect(app?.connector?.auth).toEqual({ type: 'oauth', timing: 'ON_FIRST_USE' });
    expect(app?.connector?.mcpServers.map(s => s.serverName)).toEqual(['gmail-mcp']);
    // The app is declarative routing only. Each materialized connector Source
    // owns the single network trust decision, so the app must not create a
    // duplicate executable grant.
    expect(app?.trust).toEqual({ required: false });
    // A connector is declarative data: never a secret, never a target/source path.
    expect(JSON.stringify(app)).not.toContain('targetPath');
    expect(JSON.stringify(app)).not.toContain('sourcePath');
  });

  it('projects an app candidate with no connector when connectorId has no match (K1)', () => {
    const m = manifest('conn', []);
    m.apps = [{ id: 'orphan', connectorId: 'missing' }];
    m.connectors = [{ id: 'other', mcpServers: [{ serverName: 's', transport: 'stdio', command: 'x' }] }];
    const [app] = resolvePluginProjectionCandidates([entry('conn', m)], SCOPE);
    expect(app?.kind).toBe('app');
    expect(app?.connector).toBeUndefined();
  });
});

describe('manifest surface (W7 Step 5)', () => {
  it('retains first-class apps and namespaced nessyExtensions through normalization', () => {
    const result = normalizeNessyPluginManifest({
      schemaVersion: 1,
      kind: 'plugin',
      id: 'conn',
      name: 'Connector',
      version: '1.0.0',
      capabilities: [],
      apps: [{ id: 'gmail', connectorId: 'connector://gmail', displayName: 'Gmail' }],
      nessyExtensions: {
        // B5: a safe presentation setting is retained; the old credential-shaped
        // `secret-ref` setting would now be rejected by the forbidden-key guard.
        settings: [{ key: 'verbosity', valueType: 'string', defaultValue: 'normal' }],
        commands: [{ command: 'sync' }],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.value?.apps).toEqual([{ id: 'gmail', connectorId: 'connector://gmail', displayName: 'Gmail' }]);
    expect(result.value?.nessyExtensions?.settings).toHaveLength(1);
    expect(result.value?.nessyExtensions?.commands).toHaveLength(1);
  });

  it('retains first-class connectors and drops malformed connector/server entries (K1)', () => {
    const result = normalizeNessyPluginManifest({
      schemaVersion: 1,
      kind: 'plugin',
      id: 'conn',
      name: 'Connector',
      version: '1.0.0',
      capabilities: [],
      connectors: [
        {
          id: 'gmail',
          displayName: 'Gmail',
          mcpServers: [
            { serverName: 'gmail-mcp', transport: 'http', url: 'https://example.invalid/mcp' },
            { serverName: 'no-transport' },
            { transport: 'http', url: 'https://example.invalid/x' },
          ],
          auth: { type: 'oauth', timing: 'ON_INSTALL' },
        },
        { id: 'no-servers', mcpServers: [] },
        { mcpServers: [{ serverName: 's', transport: 'stdio', command: 'x' }] },
        'not-an-object',
      ],
    });
    expect(result.ok).toBe(true);
    // C3: the well-formed server rides the capability path (auth-carrying
    // twin); malformed connector/server entries still drop, and a connector no
    // app references does not survive normalization.
    expect(result.value?.connectors ?? []).toEqual([]);
    const twins = result.value?.capabilities.filter(capability => capability.kind === 'mcp') ?? [];
    // The id-less connector is malformed and drops whole, so only the
    // well-formed server reroutes.
    expect(twins.map(capability => (capability.kind === 'mcp' ? capability.mcp : undefined))).toEqual([
      {
        serverName: 'gmail-mcp',
        transport: 'http',
        url: 'https://example.invalid/mcp',
        authType: 'oauth',
      },
    ]);
  });

  it('drops an unknown connector auth type/timing without inventing one (K1)', () => {
    const result = normalizeNessyPluginManifest({
      schemaVersion: 1,
      kind: 'plugin',
      id: 'conn',
      name: 'Connector',
      version: '1.0.0',
      capabilities: [],
      connectors: [{
        id: 'gmail',
        mcpServers: [{ serverName: 'g', transport: 'sse', url: 'https://example.invalid/sse' }],
        auth: { type: 'totally-made-up', timing: 'WHENEVER' },
      }],
    });
    expect(result.ok).toBe(true);
    // Unknown auth.type → the whole auth block is dropped (no fabricated
    // policy); the rerouted capability therefore carries NO auth descriptor.
    const capability = result.value?.capabilities.find(entry => entry.kind === 'mcp');
    expect(capability?.kind === 'mcp' ? capability.mcp.authType : 'set').toBeUndefined();
  });
});

describe('legacy connector-server projection (C4, behind the capability-path flag)', () => {
  /** A PERSISTED pre-C3 entry: twin-less connectors, exactly as old installs look on disk. */
  function preC3Entry(): ReturnType<typeof entry> {
    return entry('legacy-kit', {
      schemaVersion: 1,
      kind: 'plugin',
      id: 'legacy-kit',
      name: 'Legacy Kit',
      version: '1.0.0',
      capabilities: [],
      apps: [{ id: 'tracker-app', connectorId: 'tracker' }],
      connectors: [{
        id: 'tracker',
        displayName: 'Tracker',
        mcpServers: [
          { serverName: 'tracker-mcp', transport: 'http', url: 'https://tracker.example.test/mcp', oauthResource: 'https://tracker.example.test/' },
          { serverName: 'tracker-local', transport: 'stdio', command: 'node' },
        ],
        auth: { type: 'oauth', timing: 'ON_FIRST_USE' },
      }],
    } as NessyPluginManifest);
  }

  it('flag ON: twin-less remote servers project as auth-carrying mcp candidates with host-derived trust', () => {
    const candidates = resolvePluginProjectionCandidates([preC3Entry()], SCOPE, {
      projectLegacyConnectorServers: true,
    });

    const mcp = candidates.find(candidate => candidate.kind === 'mcp');
    expect(mcp).toBeDefined();
    expect(mcp?.capabilityId).toBe('mcp.tracker.tracker-mcp');
    expect(mcp?.logicalName).toBe('tracker-mcp');
    expect(mcp?.runtimeDefinition?.kind === 'mcp' ? mcp.runtimeDefinition.mcp : undefined).toEqual({
      serverName: 'tracker-mcp',
      transport: 'http',
      url: 'https://tracker.example.test/mcp',
      authType: 'oauth',
      oauthResource: 'https://tracker.example.test/',
    });
    expect(mcp?.trust.required).toBe(true);
    expect(mcp?.trust.executableHash).toMatch(/^[a-f0-9]{64}$/);
    // The stdio member never projects here (T9's class stays dead).
    expect(candidates.filter(candidate => candidate.kind === 'mcp')).toHaveLength(1);
    // App routing still resolves against the persisted connector metadata.
    const app = candidates.find(candidate => candidate.kind === 'app');
    expect(app?.connector?.id).toBe('tracker');
  });

  it('flag OFF: nothing projects — the Source projection keeps serving pre-C3 entries', () => {
    const candidates = resolvePluginProjectionCandidates([preC3Entry()], SCOPE, {
      projectLegacyConnectorServers: false,
    });
    expect(candidates.filter(candidate => candidate.kind === 'mcp')).toHaveLength(0);
  });

  it('a twinned server (post-C3 manifest) is NEVER double-projected under the flag', () => {
    const manifest = normalizeNessyPluginManifest({
      schemaVersion: 1,
      kind: 'plugin',
      id: 'new-kit',
      name: 'New Kit',
      version: '1.0.0',
      capabilities: [],
      apps: [{ id: 'tracker-app', connectorId: 'tracker' }],
      connectors: [{
        id: 'tracker',
        mcpServers: [{ serverName: 'tracker-mcp', transport: 'http', url: 'https://tracker.example.test/mcp' }],
        auth: { type: 'oauth', timing: 'ON_FIRST_USE' },
      }],
    }, { origin: origin() });
    expect(manifest.ok).toBe(true);

    const candidates = resolvePluginProjectionCandidates([entry('new-kit', manifest.value!)], SCOPE, {
      projectLegacyConnectorServers: true,
    });
    expect(candidates.filter(candidate => candidate.kind === 'mcp')).toHaveLength(1);
  });
});

/**
 * P2.169 — a deferred `command`/`asset` names its own kind.
 *
 * `deferUnavailablePluginSurfaces` (`format-adapters/shared.ts`) rewrites both
 * kinds into `kind: 'unsupported'` during `normalizePluginBundle`, so the shapes
 * below — not the `case 'command'`/`case 'asset'` branches — are what an
 * INSTALLED bundle projects. Measured end to end 2026-08-25.
 */
describe('deferred command and asset declarations (P2.169)', () => {
  const deferredCapability = (
    externalKind: 'command' | 'asset' | 'bin',
    id: string,
    sourcePath?: string,
  ): NessyPluginManifest['capabilities'][number] => ({
    kind: 'unsupported',
    id,
    unsupported: {
      externalKind,
      reasonCode: `plugin.deferred.nessy_${externalKind}_runtime_unavailable`,
      ...(sourcePath ? { sourcePath } : {}),
      executable: externalKind === 'command',
    },
  });

  it('names a deferred COMMAND a command, and does not duplicate its extension twin', () => {
    const m = manifest('cmdkit', [deferredCapability('command', 'c-cmd', 'command.mytool')]);
    m.nessyExtensions = { commands: [{ command: 'mytool', args: ['--sync'] }] };
    const candidates = resolvePluginProjectionCandidates([entry('cmdkit', m)], SCOPE);

    // One declaration, one row.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.kind).toBe('unsupported-runtime');
    expect(candidates[0]?.componentKind).toBe('command');
    expect(candidates[0]?.logicalName).toBe('mytool');
  });

  it('names a deferred ASSET an asset, and does not duplicate its extension twin', () => {
    const m = manifest('assetkit', [deferredCapability('asset', 'c-asset', 'asset.assets/logo.svg')]);
    m.nessyExtensions = { assets: [{ path: 'assets/logo.svg', role: 'icon' }] };
    const candidates = resolvePluginProjectionCandidates([entry('assetkit', m)], SCOPE);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.kind).toBe('unsupported-runtime');
    expect(candidates[0]?.componentKind).toBe('asset');
    expect(candidates[0]?.logicalName).toBe('assets/logo.svg');
  });

  it('leaves a deferred surface that names no component kind unlabelled', () => {
    // BOUNDARY: the map must not become a catch-all. `bin` is a real deferral
    // (`addClaudeBinSurfaceDeferral`) and is not a component kind.
    const m = manifest('binkit', [deferredCapability('bin', 'c-bin', 'bin')]);
    const [candidate] = resolvePluginProjectionCandidates([entry('binkit', m)], SCOPE);
    expect(candidate?.componentKind).toBeUndefined();
    expect(candidate?.logicalName).toBe('bin');
  });

  it('keeps the kind-word name and the extension row when a deferral carries no sourcePath', () => {
    // BOUNDARY: `sourcePath` is optional on a persisted capability. With no name
    // to recover, the declaration must NOT be marked consumed — otherwise the
    // author's own name disappears with the row that carried it.
    const m = manifest('nopath', [deferredCapability('command', 'c-cmd')]);
    m.nessyExtensions = { commands: [{ command: 'mytool' }] };
    const candidates = resolvePluginProjectionCandidates([entry('nopath', m)], SCOPE);

    expect(candidates.map(candidate => candidate.logicalName)).toEqual(['command', 'mytool']);
    expect(candidates.map(candidate => candidate.componentKind)).toEqual(['command', 'command']);
  });

  it('labels a hand-built command/asset capability that never went through an adapter', () => {
    // Defence in depth: these branches are unreachable from an install, but a
    // hand-written manifest still deserves a row that says what it declared.
    const m = manifest('handmade', [
      { kind: 'command', id: 'sync', command: { command: 'sync' } },
      { kind: 'asset', id: 'logo', asset: { path: 'assets/logo.svg' } },
    ]);
    const candidates = resolvePluginProjectionCandidates([entry('handmade', m)], SCOPE);
    expect(candidates.map(candidate => candidate.kind)).toEqual(['unsupported-runtime', 'unsupported-runtime']);
    expect(candidates.map(candidate => candidate.componentKind)).toEqual(['command', 'asset']);
  });

  it('reaches the user component list as one unavailable command row', async () => {
    // END TO END: projection -> resolver -> toUserCatalog. `componentKind` is
    // presentation only, so the row must stay unavailable while saying "command".
    const m = manifest('e2e', [deferredCapability('command', 'c-cmd', 'command.mytool')]);
    m.nessyExtensions = { commands: [{ command: 'mytool' }] };
    const installed = entry('e2e', m);
    const runtime: PluginRuntimeContext = {
      rootPath: '/tmp/p2169-root',
      dataPath: '/tmp/p2169-data',
      profile: 'claude-plugin-env-v1',
    };
    const inputs: CapabilityResolutionInputs = {
      nativeInventory: { records: [], blockedLayers: [] },
      installedPlugins: [installed],
      activePluginInstances: { [installed.pluginKey]: installed.pluginInstanceId },
      pluginCandidates: resolvePluginProjectionCandidates([installed], SCOPE),
      resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
      resolveTrust: () => 'trusted',
      pluginRuntimeContextFor: () => runtime,
    };
    const context: CapabilityContext = {
      workspaceId: 'ws_a',
      sessionId: 'sess-1',
      projectTrustState: 'trusted',
      projectTrustRevision: 'trust-r1',
    };
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(context);
    const catalog = toUserCatalog(snapshot);
    const components = (catalog.installedPlugins[0]?.components ?? []).map(component => ({
      kind: component.kind, name: component.name, enabled: component.enabled,
      unavailableReason: component.unavailableReason,
    }));
    resolver.releaseSnapshot(snapshot.leaseId);

    expect(components).toEqual([{
      kind: 'command',
      name: 'mytool',
      enabled: false,
      unavailableReason: 'unsupported-runtime',
    }]);
    expect(catalog.installedPlugins[0]?.capabilityKinds).toEqual(['command']);
  });
});


describe('every refusal kind in the unsupported branch (P2.182)', () => {
  const refusal = (
    externalKind: string,
    options: { sourcePath?: string; displayName?: string } = {},
  ): NessyPluginManifest['capabilities'][number] => ({
    kind: 'unsupported',
    id: `cap-${externalKind}`,
    ...(options.displayName ? { displayName: options.displayName } : {}),
    unsupported: {
      externalKind,
      reasonCode: `plugin.deferred.probe_${externalKind}`,
      ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
      executable: true,
    },
  });

  /**
   * Every `externalKind` spelling this tree emits, and the component kind each
   * one names. Measured through this function on 2026-08-26; the `undefined`
   * column is the boundary, not a gap.
   *
   * The mutations this kills: reverting to the three-entry `{mcp, command,
   * asset}` table (29 of these rows go wrong); widening the rule to a catch-all
   * (the ten `undefined` rows get labelled); matching `startsWith(name)` instead
   * of `startsWith(`${name}-`)` (`settings` and `settings-agent` become
   * `setting`); and dropping the one alias (`catalog-authenticated-mcp`).
   */
  const CLASSIFICATION: readonly [string, string | undefined][] = [
    ['mcp', 'mcp'],
    ['catalog-authenticated-mcp', 'mcp'],
    ['command', 'command'],
    ['command-dynamic-substitution-bash', 'command'],
    ['asset', 'asset'],
    ['hook', 'hook'],
    ['hook-event-Setup', 'hook'],
    ['hook-event-TeammateIdle', 'hook'],
    ['hook-type-Notification', 'hook'],
    ['hook-type-agent-on-Stop', 'hook'],
    ['lsp', 'lsp'],
    ['monitor', 'monitor'],
    ['monitor-skill-trigger', 'monitor'],
    ['workflow', 'workflow'],
    ['output-style', 'output-style'],
    ['output-style-force', 'output-style'],
    ['skill', 'skill'],
    ['agent', 'agent'],
    ['prompt-command', 'prompt-command'],
    ['setting', 'setting'],
    ['app', 'app'],
    ['app-connector', 'app'],
    // Unmapped: none of these names a component kind.
    ['settings', undefined],
    ['settings-agent', undefined],
    ['bin', undefined],
    ['dependency-auto-install', undefined],
    ['theme', undefined],
    ['user-config', undefined],
    ['channel', undefined],
    ['custom-hooks-path', undefined],
    ['ignored-default-agents-folder', undefined],
    ['inline-mcp-config', undefined],
  ];

  it('labels every externalKind that names a component kind, and only those', () => {
    const measured: [string, string | undefined][] = CLASSIFICATION.map(([externalKind]) => {
      const m = manifest('kinds', [refusal(externalKind)]);
      const [candidate] = resolvePluginProjectionCandidates([entry('kinds', m)], SCOPE);
      // The routing decision is unchanged for every one of them.
      expect(candidate?.kind).toBe('unsupported-runtime');
      return [externalKind, candidate?.componentKind];
    });
    const expected: [string, string | undefined][] = CLASSIFICATION.map(
      ([kind, componentKind]) => [kind, componentKind],
    );
    expect(measured).toEqual(expected);
  });

  it('routes a catalog-authenticated MCP refusal to the headless mcp_server_errors producer', async () => {
    // The row's live consequence. `buildHeadlessInitView`'s PRODUCER 2 keys on
    // `componentKind === 'mcp'`, so before this label the refusal reached NO
    // channel a headless run reports errors on. Kills: dropping the
    // `catalog-authenticated-mcp` alias, and dropping the `sourcePath` the
    // producer now writes (the name falls back to the capability id).
    const m = manifest('gateway', [refusal(
      'catalog-authenticated-mcp',
      { sourcePath: 'catalog-authenticated-mcp.cloudflare-api' },
    )]);
    m.capabilities[0]!.id = 'mcp.cloudflare-api';
    const installed = entry('gateway', m);
    const runtime: PluginRuntimeContext = {
      rootPath: '/tmp/p2182-root', dataPath: '/tmp/p2182-data', profile: 'claude-plugin-env-v1',
    };
    const inputs: CapabilityResolutionInputs = {
      nativeInventory: { records: [], blockedLayers: [] },
      installedPlugins: [installed],
      activePluginInstances: { [installed.pluginKey]: installed.pluginInstanceId },
      pluginCandidates: resolvePluginProjectionCandidates([installed], SCOPE),
      resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
      resolveTrust: () => 'trusted',
      pluginRuntimeContextFor: () => runtime,
    };
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve({
      workspaceId: 'ws_a', sessionId: 'sess-1',
      projectTrustState: 'trusted', projectTrustRevision: 'trust-r1',
    } satisfies CapabilityContext);
    const headless = buildHeadlessInitView(snapshot);
    const catalog = toUserCatalog(snapshot);
    resolver.releaseSnapshot(snapshot.leaseId);

    expect(headless.mcp_server_errors).toEqual([{
      name: 'cloudflare-api',
      type: 'plugin.deferred.probe_catalog-authenticated-mcp',
      message: 'MCP server "cloudflare-api" declared by plugin gateway could not be imported and was skipped.',
    }]);
    // `:220` — "Affected servers are absent from `mcp_servers`."
    expect(headless.mcp_servers).toEqual([]);
    // Still inert, still one row: `componentKind` is presentation only.
    expect(catalog.installedPlugins[0]?.components).toEqual([{
      kind: 'mcp',
      name: 'cloudflare-api',
      enabled: false,
      unavailableReason: 'unsupported-runtime',
    }]);
  });

  it('leaves a refusal that names no component kind out of every typed channel', async () => {
    // BOUNDARY, and the mutation it kills is the tempting one: making the rule a
    // catch-all would put `bin` on `mcp_server_errors` the moment someone reads
    // "check every refusal kind" as "label every refusal kind".
    const m = manifest('binkit', [refusal('bin', { sourcePath: 'bin' })]);
    const installed = entry('binkit', m);
    const inputs: CapabilityResolutionInputs = {
      nativeInventory: { records: [], blockedLayers: [] },
      installedPlugins: [installed],
      activePluginInstances: { [installed.pluginKey]: installed.pluginInstanceId },
      pluginCandidates: resolvePluginProjectionCandidates([installed], SCOPE),
      resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
      resolveTrust: () => 'trusted',
      pluginRuntimeContextFor: () => ({
        rootPath: '/tmp/p2182-root', dataPath: '/tmp/p2182-data', profile: 'claude-plugin-env-v1',
      }),
    };
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve({
      workspaceId: 'ws_a', sessionId: 'sess-1',
      projectTrustState: 'trusted', projectTrustRevision: 'trust-r1',
    } satisfies CapabilityContext);
    const headless = buildHeadlessInitView(snapshot);
    resolver.releaseSnapshot(snapshot.leaseId);

    expect('mcp_server_errors' in headless).toBe(false);
    expect(headless.mcp_servers).toEqual([]);
  });
});

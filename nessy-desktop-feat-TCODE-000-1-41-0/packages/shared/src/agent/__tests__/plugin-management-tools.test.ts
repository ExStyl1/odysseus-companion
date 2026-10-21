import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityPolicyStore } from '../../capabilities/policy-store.ts';
import { CapabilityTrustStore } from '../../capabilities/trust-store.ts';
import { PluginInstallService } from '../../plugins/acquisition.ts';
import { PluginManagementServiceV2 } from '../../plugins/management-service-v2.ts';
import { PluginMutationCommittedError } from '../../plugins/management-types.ts';
import { PluginStoreV2 } from '../../plugins/store-v2.ts';
import { MarketplaceProposalRegistry } from '../../marketplace/proposal-registry.ts';
import { MarketplaceService } from '../../marketplace/service.ts';
import { proposeRepositoryInstall } from '../../marketplace/repository-install.ts';
import type { MarketplaceCatalogItem, MarketplaceInstallRequest } from '../../marketplace/types.ts';
import type {
  PluginManagementInstalledSummary,
  PluginManagementRepairOptions,
} from '../../plugins/management-types.ts';
import {
  createPluginManagementTools,
  type PluginManagementMarketplaceApi,
  type PluginManagementToolsDeps,
} from '../plugin-management-tools.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plugin-management-tools-'));
});

afterEach(async () => { await installs.settle(); // F1.424 — never remove a root under an install still copying into it
  rmSync(dir, { recursive: true, force: true });
});

function createBundle(
  name = 'toolkit',
  options: { version?: string; dependencies?: Array<{ name: string; version: string }> } = {},
): string {
  const version = options.version ?? '1.0.0';
  const root = join(dir, `source-${name}-${version}`);
  mkdirSync(join(root, 'skills', 'review'), { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    id: name,
    name,
    version,
    ...(options.dependencies ? { dependencies: options.dependencies } : {}),
    capabilities: [{
      kind: 'skill',
      id: 'review',
      skill: { slug: 'review', path: 'skills/review/SKILL.md' },
    }],
  }));
  writeFileSync(join(root, 'skills', 'review', 'SKILL.md'), '# Review');
  return root;
}

/**
 * One catalog row as `peekCachedItems()` serves it — cached, path-free, and
 * joined to a local install by `marketplaceRegistryId` + `name`
 * (`findCatalogRowForInstalled`; a local-path install stamps no listing id).
 */
function catalogRow(name: string, version: string): MarketplaceCatalogItem {
  return {
    id: `acme-tools:${name}`,
    kind: 'plugin',
    listKind: 'plugins',
    name,
    version,
    icon: { kind: 'symbol', name: 'plugin' },
    capabilities: [],
    install: { sourceConfidence: 'primary' },
    raw: {},
    marketplaceRegistryId: 'local',
    structuredInstallSource: {
      kind: 'repository',
      repositoryUrl: `https://example.test/acme-tools/${name}.git`,
    },
  };
}

/**
 * D1: the agent install now goes THROUGH `MarketplaceService.install`, so the
 * fixture has to be the real service over the harness's own plugin management —
 * a stub here would test the wiring we just removed.
 */
function fakeMarketplace(pluginService: PluginManagementServiceV2): PluginManagementMarketplaceApi {
  const service = new MarketplaceService({
    pluginService,
    fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
  });
  return {
    // Real (offline, no fetch) repository detection logic — matches what
    // MarketplaceService.proposeInstall delegates to.
    proposeInstall: (request) => proposeRepositoryInstall(request),
    inspect: async () => { throw new Error('inspect should not be called in this fixture'); },
    install: request => service.install(request),
  };
}

function createHarness(options: {
  scope?: { workspaceId: string; projectKey?: string };
  /** Omitted wires NO catalog reader at all — the shape a host that never passed one has. */
  catalogItems?: MarketplaceCatalogItem[];
  /** Suffix every on-disk root, so two harnesses in ONE test do not share a plugin store. */
  id?: string;
} = {}) {
  const id = options.id ?? '';
  const store = new PluginStoreV2({ rootDirectory: join(dir, `plugins${id}`) });
  const policy = new CapabilityPolicyStore({
    globalPath: join(dir, `capabilities${id}.json`),
    workspacePolicyPath: workspaceId => join(dir, `workspaces${id}`, workspaceId, 'capabilities.json'),
  });
  const trust = new CapabilityTrustStore({ path: join(dir, `capability-trust${id}.json`) });
  const installer = new PluginInstallService({
    fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
    baseTempDir: join(dir, `staging${id}`),
  });
  const pluginManagement = installs.track(new PluginManagementServiceV2({
    store,
    policyStore: policy,
    trustStore: trust,
    installer,
  }));
  const proposalRegistry = new MarketplaceProposalRegistry();
  const afterMutationCalls: string[] = [];
  const afterMutationEffects: Array<'add-or-refresh' | 'remove' | undefined> = [];
  const catalogPeeks: number[] = [];
  const deps: PluginManagementToolsDeps = {
    pluginManagement,
    marketplaceService: fakeMarketplace(pluginManagement),
    proposalRegistry,
    clientId: 'session:ws_a:s1',
    resolveScope: () => options.scope ?? { workspaceId: 'ws_a' },
    afterMutation: (reason, _target, effect) => {
      afterMutationCalls.push(reason);
      afterMutationEffects.push(effect);
    },
    ...(options.catalogItems ? {
      marketplaceCatalogReader: {
        async peekCachedItems() { catalogPeeks.push(1); return options.catalogItems!; },
        // D2: cache-only single-row lookup, served from the same fixture rows.
        async findCatalogItem(marketplaceRegistryId: string, itemId: string) {
          return options.catalogItems!.find(
            item => item.marketplaceRegistryId === marketplaceRegistryId && item.id === itemId,
          );
        },
      },
    } : {}),
  };
  const tools = createPluginManagementTools(deps);
  return {
    tools, store, policy, proposalRegistry, afterMutationCalls, afterMutationEffects, catalogPeeks, deps,
    /** Install a real bundle from a local path and return its real pluginKey. */
    async installBundle(name = 'toolkit', bundleOptions: Parameters<typeof createBundle>[1] = {}) {
      const proposalId = proposalRegistry.issue({
        clientId: 'session:ws_a:s1',
        source: { kind: 'local-path', path: createBundle(name, bundleOptions) },
        displaySource: 'local',
        detectedFormat: 'nessy-plugin',
      }).proposalId;
      const result = await tools.install({ proposalId });
      return parseJson(result).pluginKey as string;
    },
  };
}

function parseJson(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0]!.text);
}

/**
 * D1 — the agent install enters at `MarketplaceService.install`, the same door
 * the UI uses, instead of the mutation boundary beneath it. That door is what
 * runs `acquireDependencies` (so a plugin with declared dependencies stops
 * landing installed-but-inert) and what forwards the catalog's auth hints.
 */
describe('plugin_install goes through the marketplace service (D1)', () => {
  function catalogItemWithHints(): MarketplaceCatalogItem {
    return {
      ...catalogRow('vault-kit', '1.0.0'),
      // `install.source` is what makes the item installable — the cached row
      // fixture above carries only the structured hint used for updates.
      install: {
        sourceConfidence: 'primary',
        source: { type: 'npm', packageName: '@acme/vault-kit', version: '1.0.0', raw: {} as never },
      },
      connectorAuthTiming: 'ON_INSTALL',
      catalogAuthenticationPolicy: 'tenant-managed',
    };
  }

  it('installs through the marketplace door and carries the catalog hints with it', async () => {
    const store = new PluginStoreV2({ rootDirectory: join(dir, 'plugins-d1') });
    const pluginManagement = installs.track(new PluginManagementServiceV2({
      store,
      policyStore: new CapabilityPolicyStore({
        globalPath: join(dir, 'capabilities-d1.json'),
        workspacePolicyPath: workspaceId => join(dir, 'workspaces-d1', workspaceId, 'capabilities.json'),
      }),
      trustStore: new CapabilityTrustStore({ path: join(dir, 'capability-trust-d1.json') }),
      installer: new PluginInstallService({
        fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
        baseTempDir: join(dir, 'staging-d1'),
      }),
    }));

    const requests: MarketplaceInstallRequest[] = [];
    const real = fakeMarketplace(pluginManagement);
    const proposalRegistry = new MarketplaceProposalRegistry();
    const tools = createPluginManagementTools({
      pluginManagement,
      marketplaceService: {
        ...real,
        inspect: async () => ({ item: catalogItemWithHints(), diagnostics: [] }) as never,
        install: request => { requests.push(request); return real.install(request); },
      },
      proposalRegistry,
      clientId: 'session:ws_a:s1',
      resolveScope: () => ({ workspaceId: 'ws_a' }),
      afterMutation: () => {},
    });

    const planned = parseJson(await tools.planInstall({ marketplaceItemId: 'acme-tools:vault-kit' }));
    expect(planned.status).toBe('installable');
    await tools.install({ proposalId: planned.proposalId });

    // It entered at the marketplace layer — this is the whole point of D1, and
    // it is what makes `acquireDependencies` run for a plugin that declares any.
    expect(requests).toHaveLength(1);
    expect(requests[0]!.source).toBeDefined();
    // …and the catalog's auth hints survived plan → proposal → install, where
    // the old path (straight to `pluginManagement.install`) dropped them.
    expect(requests[0]!.connectorAuthTiming).toBe('ON_INSTALL');
    expect(requests[0]!.catalogAuthenticationPolicy).toBe('tenant-managed');
  });
});

describe('plugin-management-tools', () => {
  describe('plugin_plan_install', () => {
    it('accepts a repository URL and returns an opaque proposalId (no raw install source leak)', async () => {
      const { tools } = createHarness();
      const result = await tools.planInstall({ repositoryUrl: 'https://github.com/acme/widgets' });
      expect(result.isError).not.toBe(true);
      const payload = parseJson(result);
      expect(typeof payload.proposalId).toBe('string');
      expect(payload.proposalId.length).toBeGreaterThan(0);
      expect(payload.status).toBe('installable');
      // The proposal DTO carries an opaque id + safe metadata only — never the
      // structured PluginInstallSource (repositoryUrl/path/kind) itself.
      expect(payload).not.toHaveProperty('source');
      expect(payload).not.toHaveProperty('repositoryUrl');
      // F1.805 — the model is told the repository was not contacted, so an
      // `installable` answer for a repository that does not exist is not read
      // as a verified one.
      expect(payload.diagnosticCodes).toContain('marketplace.repository.not_contacted');
    });

    it('resolves a BYO-registry listing id from the cached catalog (D2)', async () => {
      // Before D2 this id went to the Skills Market client and 404'd.
      const { tools, catalogPeeks } = createHarness({
        id: '-d2',
        catalogItems: [{
          ...catalogRow('widgets', '1.0.0'),
          id: 'acme:widgets',
          marketplaceRegistryId: 'acme',
          install: {
            sourceConfidence: 'primary',
            source: { type: 'npm', packageName: '@acme/widgets', version: '1.0.0', raw: {} as never },
          },
        }],
      });

      const payload = parseJson(await tools.planInstall({ marketplaceItemId: 'acme:widgets' }));

      expect(payload.status).toBe('installable');
      expect(typeof payload.proposalId).toBe('string');
      // Cache-only: resolved through findCatalogItem, so the peek counter — the
      // other reader entry point — never moved.
      expect(catalogPeeks).toEqual([]);
    });

    it('plans a BYO-registry row from its typed structuredInstallSource (D4 live fix)', async () => {
      // A registry row carries no DTO `install.source` at all — deriving from
      // the descriptor answers `unsupported_source`, which is what the live rig
      // hit. The typed source is the one the UI path has always used.
      const { tools } = createHarness({
        id: '-structured',
        catalogItems: [{
          ...catalogRow('cdp-echo-probe', '1.0.0'),
          id: 'registry-x:cdp-echo-probe',
          marketplaceRegistryId: 'registry-x',
          install: { sourceConfidence: 'primary' },
          structuredInstallSource: { kind: 'local-path', path: '/tmp/cdp-echo-probe' },
        } as unknown as MarketplaceCatalogItem],
      })

      const payload = parseJson(await tools.planInstall({ marketplaceItemId: 'registry-x:cdp-echo-probe' }))

      expect(payload.status).toBe('installable')
      expect(typeof payload.proposalId).toBe('string')
      // Still opaque: the typed source never reaches the model.
      expect(payload).not.toHaveProperty('source')
    })

    it('says which half of a registry listing id is wrong when it resolves to nothing (D2)', async () => {
      const { tools } = createHarness({ id: '-d2-miss', catalogItems: [] });

      const result = await tools.planInstall({ marketplaceItemId: 'acme:absent' });

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('<registryId>:<pluginName>');
    });

    it('rejects passing both marketplaceItemId and repositoryUrl', async () => {
      const { tools } = createHarness();
      const result = await tools.planInstall({ marketplaceItemId: 'abc', repositoryUrl: 'https://github.com/acme/widgets' });
      expect(result.isError).toBe(true);
    });

    it('rejects passing neither marketplaceItemId nor repositoryUrl', async () => {
      const { tools } = createHarness();
      const result = await tools.planInstall({});
      expect(result.isError).toBe(true);
    });

    it('is read-only: proposing an install never mutates the plugin store', async () => {
      const { tools, store } = createHarness();
      await tools.planInstall({ repositoryUrl: 'https://github.com/acme/widgets' });
      expect((await store.readInstalledRegistry()).plugins).toEqual([]);
    });
  });

  describe('plugin_install', () => {
    it('rejects a raw local path instead of a proposalId', async () => {
      const { tools } = createHarness();
      const result = await tools.install({ path: createBundle() } as any);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('proposalId is required');
    });

    it('installs and activates a supported package via a proposalId, then fires afterMutation', async () => {
      const { tools, proposalRegistry, store, policy, afterMutationCalls } = createHarness();
      const proposalId = proposalRegistry.issue({
        clientId: 'session:ws_a:s1',
        source: { kind: 'local-path', path: createBundle() },
        displaySource: 'local',
        detectedFormat: 'nessy-plugin',
      }).proposalId;

      const result = await tools.install({ proposalId, scope: 'workspace' });
      expect(result.isError).not.toBe(true);
      const payload = parseJson(result);
      expect(payload.ok).toBe(true);
      expect(typeof payload.pluginKey).toBe('string');
      expect((await store.readInstalledRegistry()).plugins).toHaveLength(1);
      expect(policy.resolve({ pluginKey: payload.pluginKey }, { workspaceId: 'ws_a' }).enabled).toBe(true);
      expect(afterMutationCalls).toEqual(['plugin_install']);
    });

    it('returns the same requirement set the RPC result carries, plus a model-relayable setup summary (T2)', async () => {
      const { tools, proposalRegistry } = createHarness();
      const root = join(dir, 'source-auth-bearing');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'plugin.json'), JSON.stringify({
        schemaVersion: 1,
        kind: 'plugin',
        id: 'auth-bearing',
        name: 'Auth Bearing',
        version: '1.0.0',
        capabilities: [
          { kind: 'mcp', id: 'jira', mcp: { serverName: 'jira', transport: 'stdio', command: 'dp', args: ['ai', 'mcp', 'jira'] } },
          { kind: 'mcp', id: 'gitlab', mcp: { serverName: 'gitlab', transport: 'stdio', command: 'dp', args: ['ai', 'mcp', 'gitlab'] } },
        ],
        connectors: [{
          id: 'tracker',
          mcpServers: [{ serverName: 'tracker-mcp', transport: 'http', url: 'https://tracker.example.test/mcp' }],
          auth: { type: 'oauth', timing: 'ON_FIRST_USE' },
        }],
      }));
      const proposalId = proposalRegistry.issue({
        clientId: 'session:ws_a:s1',
        source: { kind: 'local-path', path: root },
        displaySource: 'local',
        detectedFormat: 'nessy-plugin',
      }).proposalId;

      const result = await tools.install({ proposalId, scope: 'workspace' });
      expect(result.isError).not.toBe(true);
      const payload = parseJson(result);
      expect(payload.ok).toBe(true);
      // The identical manifest-derived requirement set the RPC boundary carries.
      expect(payload.authRequirements).toEqual([
        { kind: 'dp', capabilityIds: ['gitlab', 'jira'], serverNames: ['gitlab', 'jira'], sharedProvider: 'dp', timing: 'ON_FIRST_USE' },
        // C3 (capability path): `connectorIds` carries the auth-bearing MCP
        // capability id — the qualified `mcp.<connector>.<server>` shape every
        // sibling suite pins — not the raw connector id.
        { kind: 'oauth', timing: 'ON_FIRST_USE', connectorIds: ['mcp.tracker.tracker-mcp'], serverNames: ['tracker-mcp'] },
      ]);
      // The model-relayable summary: the dp count and the first-use servers.
      expect(payload.setup.ready).toBe(false);
      expect(payload.setup.dp).toEqual({ count: 2, serverNames: ['gitlab', 'jira'] });
      expect(payload.setup.connectOnFirstUse).toEqual({ serverNames: ['tracker-mcp'] });
      expect(payload.setup.notes.some((note: string) => note.includes('One Developer Platform sign-in unblocks 2'))).toBe(true);
    });

    it('a ready plugin reports setup.ready with no outstanding notes', async () => {
      const { tools, proposalRegistry } = createHarness();
      const proposalId = proposalRegistry.issue({
        clientId: 'session:ws_a:s1',
        source: { kind: 'local-path', path: createBundle('ready-kit') },
        displaySource: 'local',
        detectedFormat: 'nessy-plugin',
      }).proposalId;
      const result = await tools.install({ proposalId, scope: 'workspace' });
      const payload = parseJson(result);
      expect(payload.setup).toEqual({ ready: true, notes: ['All installed servers are ready to use.'] });
      expect(payload).not.toHaveProperty('authRequirements');
    });

    it('a single-use proposalId cannot be consumed twice', async () => {
      const { tools, proposalRegistry } = createHarness();
      const proposalId = proposalRegistry.issue({
        clientId: 'session:ws_a:s1',
        source: { kind: 'local-path', path: createBundle() },
        displaySource: 'local',
        detectedFormat: 'nessy-plugin',
      }).proposalId;

      const first = await tools.install({ proposalId });
      expect(first.isError).not.toBe(true);
      const second = await tools.install({ proposalId });
      expect(second.isError).toBe(true);
    });

    it('never grants executable trust on install', async () => {
      const { tools, proposalRegistry } = createHarness();
      const proposalId = proposalRegistry.issue({
        clientId: 'session:ws_a:s1',
        source: { kind: 'local-path', path: createBundle() },
        displaySource: 'local',
        detectedFormat: 'nessy-plugin',
      }).proposalId;
      const result = await tools.install({ proposalId });
      const payload = parseJson(result);
      // The install result itself carries no trust grant; CapabilityTrustStore
      // is a completely separate store this module never touches.
      expect(JSON.stringify(payload)).not.toMatch(/trust/i);
    });

    describe('partial-compatibility packages', () => {
      function createPartialHarness() {
        const store = new PluginStoreV2({ rootDirectory: join(dir, 'plugins') });
        const policy = new CapabilityPolicyStore({
          globalPath: join(dir, 'capabilities.json'),
          workspacePolicyPath: workspaceId => join(dir, 'workspaces', workspaceId, 'capabilities.json'),
        });
        const trust = new CapabilityTrustStore({ path: join(dir, 'capability-trust.json') });
        const baseInstaller = new PluginInstallService({
          fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
          baseTempDir: join(dir, 'staging'),
        });
        const installer = {
          createInstallPlanFromSource: baseInstaller.createInstallPlanFromSource.bind(baseInstaller),
          stageInstall: baseInstaller.stageInstall.bind(baseInstaller),
          normalizeStagedInstall: async (staged: Parameters<typeof baseInstaller.normalizeStagedInstall>[0]) => {
            const normalized = await baseInstaller.normalizeStagedInstall(staged);
            return {
              ...normalized,
              compatibility: normalized.compatibility ? { ...normalized.compatibility, state: 'partial' as const } : normalized.compatibility,
            };
          },
        };
        const pluginManagement = installs.track(new PluginManagementServiceV2({ store, policyStore: policy, trustStore: trust, installer }));
        const proposalRegistry = new MarketplaceProposalRegistry();
        const afterMutationCalls: string[] = [];
        const deps: PluginManagementToolsDeps = {
          pluginManagement,
          marketplaceService: fakeMarketplace(pluginManagement),
          proposalRegistry,
          clientId: 'session:ws_a:s1',
          resolveScope: () => ({ workspaceId: 'ws_a' }),
          afterMutation: (reason) => { afterMutationCalls.push(reason); },
        };
        return { tools: createPluginManagementTools(deps), store, policy, proposalRegistry, afterMutationCalls };
      }

      for (const allowPartial of [undefined, true]) {
        it(`activates the supported subset when deprecated allowPartial is ${String(allowPartial)}`, async () => {
          const { tools, proposalRegistry, store, policy } = createPartialHarness();
          const proposalId = proposalRegistry.issue({
            clientId: 'session:ws_a:s1',
            source: { kind: 'local-path', path: createBundle() },
            displaySource: 'local',
            detectedFormat: 'nessy-plugin',
          }).proposalId;

          const result = await tools.install({ proposalId, scope: 'workspace', allowPartial });
          const payload = parseJson(result);
          expect(payload.ok).toBe(true);
          expect(payload.requiresConfirmation).toBeUndefined();
          expect((await store.readInstalledRegistry()).plugins).toHaveLength(1);
          expect(policy.resolve({ pluginKey: payload.pluginKey }, { workspaceId: 'ws_a' }).enabled).toBe(true);
        });
      }
    });

    it('invalidates a committed install before surfacing connector activation failure', async () => {
      const { tools, deps, proposalRegistry, afterMutationCalls, afterMutationEffects } = createHarness();
      const proposalId = proposalRegistry.issue({
        clientId: 'session:ws_a:s1',
        source: { kind: 'local-path', path: createBundle() },
        displaySource: 'local',
        detectedFormat: 'nessy-plugin',
      }).proposalId;
      deps.pluginManagement.install = async () => {
        throw new PluginMutationCommittedError(
          'install',
          'local.toolkit',
          new Error('connector-activation-failed'),
        );
      };

      const result = await tools.install({ proposalId, scope: 'workspace' });

      expect(result.isError).toBe(true);
      expect(afterMutationCalls).toEqual(['plugin_install']);
      expect(afterMutationEffects).toEqual(['remove']);
    });
  });

  describe('plugin_status', () => {
    it('is read-only and lists installed plugins without mutating state', async () => {
      const { tools, proposalRegistry, store } = createHarness();
      const proposalId = proposalRegistry.issue({
        clientId: 'session:ws_a:s1',
        source: { kind: 'local-path', path: createBundle() },
        displaySource: 'local',
        detectedFormat: 'nessy-plugin',
      }).proposalId;
      await tools.install({ proposalId });

      const before = await store.readInstalledRegistry();
      const result = await tools.status({});
      const after = await store.readInstalledRegistry();
      expect(after).toEqual(before);

      const payload = parseJson(result);
      expect(payload.installed).toHaveLength(1);
      expect(payload.installed[0]!.name).toBe('toolkit');
    });

    it('filters by pluginKey when provided', async () => {
      const { tools, proposalRegistry } = createHarness();
      const proposalId = proposalRegistry.issue({
        clientId: 'session:ws_a:s1',
        source: { kind: 'local-path', path: createBundle() },
        displaySource: 'local',
        detectedFormat: 'nessy-plugin',
      }).proposalId;
      await tools.install({ proposalId });

      const missing = await tools.status({ pluginKey: 'nonexistent.key' });
      expect(parseJson(missing).installed).toEqual([]);
    });
  });

  describe('plugin_manage', () => {
    it('marks partial repair and update mutations as removals', async () => {
      // The catalog is AHEAD, so `update` resolves a source and reaches the
      // stub. Pre-R88b this test passed against a `pluginKey` that was never
      // installed, because `update` was called with nothing and the stub took
      // anything — the same blindness that let the defect ship.
      const { tools, deps, afterMutationEffects, installBundle } = createHarness({
        catalogItems: [catalogRow('toolkit', '2.0.0')],
      });
      const pluginKey = await installBundle();
      const partial = async () => ({
        ok: true,
        diagnostics: [],
        requiresConfirmation: true,
        compatibility: {
          format: 'nessy' as const,
          state: 'partial' as const,
          supportedKinds: ['skill' as const],
          deferred: [],
          blocked: [],
        },
      });
      deps.pluginManagement.repair = partial;
      deps.pluginManagement.update = partial;
      afterMutationEffects.length = 0;

      expect((await tools.manage({ pluginKey, action: 'repair' })).isError).not.toBe(true);
      expect((await tools.manage({ pluginKey, action: 'update' })).isError).not.toBe(true);
      expect(afterMutationEffects).toEqual(['remove', 'remove']);
    });

    it('enables/disables an installed plugin by pluginKey and fires afterMutation, without granting trust', async () => {
      const { tools, proposalRegistry, policy, afterMutationCalls } = createHarness();
      const proposalId = proposalRegistry.issue({
        clientId: 'session:ws_a:s1',
        source: { kind: 'local-path', path: createBundle() },
        displaySource: 'local',
        detectedFormat: 'nessy-plugin',
      }).proposalId;
      const installed = parseJson(await tools.install({ proposalId, scope: 'workspace' }));
      const pluginKey = installed.pluginKey as string;

      const disableResult = await tools.manage({ pluginKey, action: 'disable', scope: 'workspace' });
      expect(disableResult.isError).not.toBe(true);
      expect(policy.resolve({ pluginKey }, { workspaceId: 'ws_a' }).enabled).toBe(false);

      const enableResult = await tools.manage({ pluginKey, action: 'enable', scope: 'workspace' });
      expect(enableResult.isError).not.toBe(true);
      expect(policy.resolve({ pluginKey }, { workspaceId: 'ws_a' }).enabled).toBe(true);
      expect(JSON.stringify(parseJson(enableResult))).not.toMatch(/trust/i);

      expect(afterMutationCalls).toEqual(['plugin_install', 'plugin_manage:disable', 'plugin_manage:enable']);
    });

    it('reports what else was enabled, and omits the key when nothing else moved', async () => {
      // `plugin-dependencies.md` § *Enable or disable a plugin with dependencies*:
      // "The success message lists what else was enabled along with the plugin you
      // named." P6.628 — the set is `enableUnlocked`'s (pinned by
      // `management-service-v2.test.ts`); what this reader owes is passing it
      // through to the model instead of dropping it, which is what
      // `{ ok, pluginKey, action }` did. Stubbed the way `captureUpdate` stubs
      // `update`, so the assertion is about the projection, not about resolution.
      const { tools, deps } = createHarness();
      const summary = (enabledDependencies?: string[]) => ({
        pluginKey: 'acme.toolkit',
        ...(enabledDependencies ? { enabledDependencies } : {}),
      } as unknown as PluginManagementInstalledSummary);

      deps.pluginManagement.enable = async () => summary(['acme.vault', 'acme.audit']);
      const withDeps = await tools.manage({ pluginKey: 'acme.toolkit', action: 'enable' });
      expect(parseJson(withDeps)).toMatchObject({
        ok: true,
        action: 'enable',
        enabledDependencies: ['acme.vault', 'acme.audit'],
      });

      deps.pluginManagement.enable = async () => summary();
      const alone = await tools.manage({ pluginKey: 'acme.toolkit', action: 'enable' });
      expect(Object.keys(parseJson(alone))).not.toContain('enabledDependencies');

      // `disable` shares this branch, and the only reason its response cannot
      // grow the key is that `disableUnlocked` never sets it — asserted where it
      // is decided, in `management-service-v2.test.ts`, rather than re-stated
      // here against a double that could be made to say anything.
    });

    it('uninstalls an installed plugin by pluginKey', async () => {
      const { tools, proposalRegistry, store } = createHarness();
      const proposalId = proposalRegistry.issue({
        clientId: 'session:ws_a:s1',
        source: { kind: 'local-path', path: createBundle() },
        displaySource: 'local',
        detectedFormat: 'nessy-plugin',
      }).proposalId;
      const installed = parseJson(await tools.install({ proposalId }));
      const pluginKey = installed.pluginKey as string;

      const result = await tools.manage({ pluginKey, action: 'uninstall' });
      expect(result.isError).not.toBe(true);
      expect((await store.readInstalledRegistry()).active[pluginKey]).toBeUndefined();
    });

    it('invalidates committed disable and uninstall revokes even when cleanup reports failure', async () => {
      const {
        tools,
        deps,
        afterMutationCalls,
        afterMutationEffects,
      } = createHarness();
      const pluginKey = 'local.toolkit';
      deps.pluginManagement.disable = async () => {
        throw new PluginMutationCommittedError(
          'disable',
          pluginKey,
          new Error('connector-cleanup-failed'),
        );
      };
      deps.pluginManagement.uninstall = async () => {
        throw new PluginMutationCommittedError(
          'uninstall',
          pluginKey,
          new Error('managed-data-cleanup-failed'),
        );
      };

      const disable = await tools.manage({
        pluginKey,
        action: 'disable',
        scope: 'workspace',
      });
      const uninstall = await tools.manage({ pluginKey, action: 'uninstall' });

      expect(disable.isError).toBe(true);
      expect(uninstall.isError).toBe(true);
      expect(afterMutationCalls).toEqual([
        'plugin_manage:disable',
        'plugin_manage:uninstall',
      ]);
      expect(afterMutationEffects).toEqual(['remove', 'remove']);
    });

    it('rejects an unknown action', async () => {
      const { tools } = createHarness();
      const result = await tools.manage({ pluginKey: 'a.b', action: 'delete-everything' } as any);
      expect(result.isError).toBe(true);
    });

    it('rejects a missing pluginKey', async () => {
      const { tools } = createHarness();
      const result = await tools.manage({ action: 'enable' } as any);
      expect(result.isError).toBe(true);
    });
  });

  /**
   * R88b — the AGENT's own update must fetch the NEW version.
   *
   * `PluginManagementServiceV2.update` is `repair` plus a caller-supplied
   * source, and its docstring says so: "Called with no `source`, it therefore
   * re-fetches the version that is already installed. That is a real limit and
   * it is the caller's to fix: this service holds no catalog and must not grow
   * one." `plugin_manage` was that caller and passed nothing, so the tool
   * re-installed the version already on disk and reported `{ ok: true, action:
   * "update" }` to the model — the third no-op caller of the defect R88 closed
   * on the user-clicked RPC path, and the only one an agent can reach.
   *
   * Every case is decided from a CACHED catalog peek, never `listItems()`: R81
   * disqualified that read for kicking a git clone onto the request, spending a
   * failed registry's retry budget and writing `marketplaces.json`.
   */
  describe('plugin_manage update source (R88b)', () => {
    /** Capture `update`'s SECOND argument — the whole point of the unit. */
    function captureUpdate(deps: PluginManagementToolsDeps) {
      const calls: Array<PluginManagementRepairOptions | undefined> = [];
      deps.pluginManagement.update = async (_key, options) => {
        calls.push(options);
        return { ok: true, diagnostics: [] };
      };
      return calls;
    }

    it('installs the catalog version when the marketplace is ahead', async () => {
      const { tools, deps, catalogPeeks, installBundle } = createHarness({
        catalogItems: [catalogRow('toolkit', '2.0.0')],
      });
      const pluginKey = await installBundle('toolkit', { version: '1.0.0' });
      const updateOptions = captureUpdate(deps);

      const result = await tools.manage({ pluginKey, action: 'update' });

      expect(result.isError).not.toBe(true);
      expect(parseJson(result)).toMatchObject({ ok: true, action: 'update' });
      // THE defect: pre-R88b this was `undefined`, so `update` fell through to
      // `repair(pluginKey, {})` and re-fetched 1.0.0 while claiming success.
      expect(updateOptions).toEqual([{
        source: {
          kind: 'repository',
          repositoryUrl: 'https://example.test/acme-tools/toolkit.git',
          marketplace: expect.objectContaining({
            marketplaceId: 'local',
            itemId: 'acme-tools:toolkit',
            name: 'toolkit',
            version: '2.0.0',
          }),
        },
      }]);
      expect(catalogPeeks).toHaveLength(1);
    });

    it('repairs from the pinned origin when the catalog holds nothing newer', async () => {
      // Nothing newer exists, so re-materializing the pinned origin is right —
      // and it is what this tool did before R88b. Not a new error surface.
      const { tools, deps, installBundle } = createHarness({
        catalogItems: [catalogRow('toolkit', '1.0.0')],
      });
      const pluginKey = await installBundle('toolkit', { version: '1.0.0' });
      const updateOptions = captureUpdate(deps);

      const result = await tools.manage({ pluginKey, action: 'update' });

      expect(result.isError).not.toBe(true);
      expect(updateOptions).toEqual([{}]);
    });

    it('fails honestly when no cached catalog row backs the installed plugin', async () => {
      // Without a row we cannot distinguish a real update from a same-version
      // reinstall, and reporting "updated" for the latter is the whole defect.
      const cases: Array<MarketplaceCatalogItem[] | undefined> = [
        // An empty cache, a cache holding only OTHER plugins, and no reader
        // wired at all — all three are "we cannot tell".
        [],
        [catalogRow('other-plugin', '9.9.9')],
        undefined,
      ];
      for (const [index, catalogItems] of cases.entries()) {
        const { tools, deps, installBundle } = createHarness({
          id: `-no-row-${index}`,
          ...(catalogItems ? { catalogItems } : {}),
        });
        const pluginKey = await installBundle('toolkit', { version: '1.0.0' });
        const updateOptions = captureUpdate(deps);

        const result = await tools.manage({ pluginKey, action: 'update' });

        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain('no installable marketplace catalog entry');
        // Nothing was re-installed, and nothing claimed it was.
        expect(updateOptions).toEqual([]);
      }
    });

    it('refuses a plugin an installed dependent holds back', async () => {
      // `plugins/host-marketplace.md#hold-users-on-one-version` — "The dependency stays at `2.1.0`.
      // Auto-update skips newer versions while plugin A is installed." An agent
      // call must not do what the unattended pass refuses.
      const held = createHarness({ id: '-held', catalogItems: [catalogRow('toolkit', '3.0.0')] });
      const pluginKey = await held.installBundle('toolkit', { version: '2.1.0' });
      await held.installBundle('plugin-a', {
        version: '1.0.0',
        dependencies: [{ name: 'toolkit', version: '=2.1.0' }],
      });
      const heldUpdates = captureUpdate(held.deps);

      const refusal = await held.tools.manage({ pluginKey, action: 'update' });

      expect(refusal.isError).toBe(true);
      expect(refusal.content[0]!.text).toContain('plugin-a');
      expect(heldUpdates).toEqual([]);

      // POSITIVE CONTROL — same catalog, same installed toolkit, dependent
      // never installed. Without it the refusal above could just as well be a
      // failed catalog join.
      const freed = createHarness({ id: '-freed', catalogItems: [catalogRow('toolkit', '3.0.0')] });
      const freedKey = await freed.installBundle('toolkit', { version: '2.1.0' });
      const freedUpdates = captureUpdate(freed.deps);

      expect((await freed.tools.manage({ pluginKey: freedKey, action: 'update' })).isError).not.toBe(true);
      expect(freedUpdates).toEqual([{ source: expect.objectContaining({ kind: 'repository' }) }]);
    });

    it('rejects an update for a plugin that is not installed', async () => {
      const { tools, deps } = createHarness({ catalogItems: [catalogRow('toolkit', '2.0.0')] });
      const updateOptions = captureUpdate(deps);

      const result = await tools.manage({ pluginKey: 'bG9jYWw.dG9vbGtpdA', action: 'update' });

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('plugin.manage.not-installed');
      expect(updateOptions).toEqual([]);
    });

    it('leaves repair on the pinned origin — it never consults the catalog', async () => {
      // Repair's whole purpose is re-materializing the PINNED origin, so it must
      // take no source and must not peek. The update fix must not leak into it.
      const { tools, deps, catalogPeeks, installBundle } = createHarness({
        catalogItems: [catalogRow('toolkit', '2.0.0')],
      });
      const pluginKey = await installBundle('toolkit', { version: '1.0.0' });
      const repairArgs: unknown[][] = [];
      deps.pluginManagement.repair = async (...args) => {
        repairArgs.push(args);
        return { ok: true, diagnostics: [] };
      };

      const result = await tools.manage({ pluginKey, action: 'repair' });

      expect(result.isError).not.toBe(true);
      expect(repairArgs).toEqual([[pluginKey]]);
      expect(catalogPeeks).toEqual([]);
    });
  });
});

/**
 * F1.265 — the tool answer says WHICH sessions are live when the host's refresh
 * failed for some of them. The host (`SessionManager.afterAgentPluginMutation`)
 * throws the refresh's whole summary on the error; `refreshAfterCommit` reads it
 * structurally (this package cannot import the host) into
 * `runtimeRefreshSessions`. A plain error — any host that carries no summary —
 * keeps F1.211's answer exactly.
 */
describe('F1.265 — runtimeRefreshSessions rides beside a failed refresh', () => {
  async function installWith(afterMutationError: Error) {
    const { tools, proposalRegistry, deps } = createHarness({ id: `-f1265-${afterMutationError.message.length}` });
    deps.afterMutation = async () => { throw afterMutationError; };
    const proposalId = proposalRegistry.issue({
      clientId: 'session:ws_a:s1',
      source: { kind: 'local-path', path: createBundle(`f1265-${afterMutationError.message.length}`) },
      displaySource: 'local',
      detectedFormat: 'nessy-plugin',
    }).proposalId;
    const result = await tools.install({ proposalId, scope: 'workspace' });
    expect(result.isError).not.toBe(true);
    return parseJson(result);
  }

  it('a host summary on the error → the counts and the failed session ids reach the answer', async () => {
    const summary = {
      applied: 1, deferred: 0, untouched: 1, reloaded: 0,
      failed: 1, failures: [{ sessionId: 'codex-bad', error: 'codex-runtime-session-disposal-failed' }],
    };
    const payload = await installWith(Object.assign(new Error('codex-runtime-session-disposal-failed'), { summary }));
    expect(payload.ok).toBe(true);
    expect(payload.runtimeRefresh).toBe('failed');
    expect(payload.runtimeRefreshError).toBe('codex-runtime-session-disposal-failed');
    expect(payload.runtimeRefreshSessions).toEqual({
      applied: 1, reloaded: 0, deferred: 0, untouched: 1, failed: 1, failedSessionIds: ['codex-bad'],
    });
  });

  it('CONTROL — a plain error (no summary) keeps F1.211\'s answer: no runtimeRefreshSessions key', async () => {
    const payload = await installWith(new Error('codex-runtime-session-disposal-failed-plain'));
    expect(payload.ok).toBe(true);
    expect(payload.runtimeRefresh).toBe('failed');
    expect(payload).not.toHaveProperty('runtimeRefreshSessions');
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

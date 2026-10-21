import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { CapabilityPolicyStore } from '../../capabilities/policy-store.ts';
import { CapabilityTrustStore } from '../../capabilities/trust-store.ts';
import { getPluginDataRoot } from '../../workspaces/paths.ts';
import { PluginInstallService } from '../acquisition.ts';
import type { PluginRuntimeDependencyInstaller } from '../install-types.ts';
import { hasMaterializedPluginPackageRunner, pluginNpxRuntimeRoot } from '../stdio-command.ts';
import { removePluginData, resolvePluginDataPath } from '../data-paths.ts';
import { PluginSettings } from '../plugin-settings.ts';
import {
  PluginManagementServiceV2,
  type PluginDataLifecycle,
} from '../management-service-v2.ts';
import {
  PluginMutationCommittedError,
  type PluginInstallStager,
} from '../management-types.ts';
import { PluginStoreV2 } from '../store-v2.ts';
import type { PluginCompatibilityReport, PluginConnectorDescriptor } from '../types.ts';

let dir: string;
const PROJECT_KEY = `p_${'b'.repeat(32)}` as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plugin-management-v2-'));
});

afterEach(async () => { await installs.settle(); // F1.424 — never remove a root under an install still copying into it
  rmSync(dir, { recursive: true, force: true });
});

describe('PluginManagementServiceV2', () => {
  it('installs through PluginStoreV2 and records activation separately', async () => {
    const { service, policy } = createService();
    const result = await service.install(
      { kind: 'local-path', path: createBundle() },
      { activateIn: { kind: 'workspace', workspaceId: 'ws_a' } },
    );

    expect(result.ok).toBe(true);
    expect(result.installed).toMatchObject({
      marketplaceId: 'local',
      pluginId: 'toolkit',
      version: '1.0.0',
      capabilityKinds: ['skill'],
    });
    expect(policy.resolve(
      { pluginKey: result.installed?.pluginKey },
      { workspaceId: 'ws_a' },
    ).enabled).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/enabledScopes|lifecycleState|cacheDirectory|versionDirectory/);
  });

  it('carries the persisted adapter warnings onto the install result', async () => {
    // P2.155. `manifest.compatibility.adapter.warnings` is the adapter's
    // deliberate NON-GATING record of what it dropped. Five adapters wrote it
    // and nothing outside tests read it, so the install result — the one thing
    // the renderer sees — could not report the drop at all. Read from the STORED
    // manifest, not recomputed from `diagnostics`, so the reader and the file on
    // disk cannot disagree.
    const { service } = createService();
    const result = await service.install({ kind: 'local-path', path: createCodexListingBundle() });

    expect(result.ok).toBe(true);
    expect(result.installed?.adapterWarnings).toContain('plugin.format.codex_listing_metadata_dropped');
    // The posture: dropped listing metadata has no runtime effect, so it must
    // NOT gate the install. `deferred` is the channel that would.
    expect(result.compatibility?.state).toBe('supported');
    expect(result.compatibility?.deferred).toEqual([]);
    expect(result.requiresConfirmation).toBeUndefined();
  });

  it('omits adapterWarnings entirely for a bundle the adapter dropped nothing from', async () => {
    // The boundary: the field is omit-when-empty, so a clean install carries no
    // key at all and the renderer's notice cannot fire on every install.
    const { service } = createService();
    const result = await service.install({ kind: 'local-path', path: createBundle() });

    expect(result.ok).toBe(true);
    expect(result.installed?.adapterWarnings).toBeUndefined();
    expect('adapterWarnings' in (result.installed ?? {})).toBe(false);
  });

  it('preserves the Codex runtime profile for a mixed-format Honey bundle', async () => {
    const { service, store } = createService();
    const result = await service.install({ kind: 'local-path', path: createMixedHoneyBundle() });

    expect(result.ok).toBe(true);
    const registry = await store.readInstalledRegistry();
    const entry = registry.plugins.find(plugin => plugin.pluginId === 'honey');
    expect(entry?.manifest.compatibility?.adapter?.adapterId).toBe('codex-plugin-json');
    expect(entry?.manifest.runtimeCompatibility).toEqual({ profiles: ['codex-plugin-env-v1'] });
  });

  it('uses global, Workspace and private project policy targets without granting trust', async () => {
    const { service, policy } = createService();
    const installed = await service.install({ kind: 'local-path', path: createBundle() });
    const pluginKey = installed.installed?.pluginKey ?? '';

    await service.enable(pluginKey, { kind: 'global' });
    await service.disable(pluginKey, { kind: 'workspace', workspaceId: 'ws_a' });
    await service.enable(pluginKey, { kind: 'project', workspaceId: 'ws_b', projectKey: PROJECT_KEY });

    expect(policy.resolve({ pluginKey }).enabled).toBe(true);
    expect(policy.resolve({ pluginKey }, { workspaceId: 'ws_a' })).toMatchObject({ enabled: false, suppressed: true });
    expect(policy.resolve({ pluginKey }, { workspaceId: 'ws_b', projectKey: PROJECT_KEY }).enabled).toBe(true);
  });

  it('flips one capability via a capabilityId-scoped record without touching plugin activation', async () => {
    const { service, policy } = createService();
    const installed = await service.install({ kind: 'local-path', path: createBundle() });
    const pluginKey = installed.installed?.pluginKey ?? '';
    await service.enable(pluginKey, { kind: 'workspace', workspaceId: 'ws_a' });

    await service.setCapabilityEnabled(pluginKey, { kind: 'workspace', workspaceId: 'ws_a' }, 'review', false);
    const resolved = policy.resolve({ pluginKey }, { workspaceId: 'ws_a' });
    expect(resolved).toMatchObject({ enabled: true, suppressed: false });
    expect(resolved.capabilities).toEqual({ review: false });
    // Whole-plugin per-scope state is untouched by the capability toggle.
    expect(policy.resolveScopes({ pluginKey }, { workspaceId: 'ws_a' }).workspace).toBe('enabled');

    await service.setCapabilityEnabled(pluginKey, { kind: 'workspace', workspaceId: 'ws_a' }, 'review', true);
    expect(policy.resolve({ pluginKey }, { workspaceId: 'ws_a' }).capabilities).toEqual({ review: true });

    // Not-installed plugin, unknown capability id, and invalid target are all
    // rejected before any write.
    await expect(service.setCapabilityEnabled('local.ghost', { kind: 'workspace', workspaceId: 'ws_a' }, 'review', false))
      .rejects.toThrow('plugin.manage.not-installed');
    await expect(service.setCapabilityEnabled(pluginKey, { kind: 'workspace', workspaceId: 'ws_a' }, 'not-declared', false))
      .rejects.toThrow('plugin.manage.unknown-capability');
    await expect(service.setCapabilityEnabled(pluginKey, { kind: 'workspace', workspaceId: '../escape' }, 'review', false))
      .rejects.toThrow();
  });

  it('applies typed settings through the existing value-free configuration boundary', async () => {
    const { service } = createService();
    const installed = await service.install({ kind: 'local-path', path: createSettingsBundle() });
    const pluginKey = installed.installed!.pluginKey;
    const pluginInstanceId = installed.installed!.activeInstanceId;
    const descriptors = [
      { key: 'theme', valueType: 'string' as const, defaultValue: 'system' },
      { key: 'retries', valueType: 'number' as const, required: true },
    ];
    const owner = new PluginSettings({
      dataPath: resolvePluginDataPath(
        pluginKey,
        { workspaceId: 'ws_a' },
        join(dir, 'plugins', 'data'),
      ),
      pluginInstanceId,
      descriptors,
    });

    expect(await service.configurationStatus(pluginKey, 'ws_a')).toEqual({
      state: 'needs_configuration',
      fields: [
        { key: 'theme', valueType: 'string', required: false, hasDefault: true, configured: false, missing: false, sensitive: false },
        { key: 'retries', valueType: 'number', required: true, hasDefault: false, configured: false, missing: true, sensitive: false },
      ],
    });
    expect(existsSync(owner.path)).toBe(false);

    expect(await service.configure(pluginKey, 'ws_a', { retries: 3 })).toMatchObject({ state: 'ready' });
    expect(JSON.parse(readFileSync(owner.path, 'utf8'))).toEqual({ retries: 3 });
    await service.configure(pluginKey, 'ws_a', { theme: 'dark' });
    expect(JSON.parse(readFileSync(owner.path, 'utf8'))).toEqual({ retries: 3, theme: 'dark' });
    await expect(service.configure(pluginKey, 'ws_a', { globalPreference: true }))
      .rejects.toThrow('plugin.configuration.invalid-values');

    expect(await service.clearConfiguration(pluginKey, 'ws_a')).toMatchObject({ state: 'needs_configuration' });
    expect(existsSync(owner.path)).toBe(false);
  });

  /**
   * D15 — `plugins/manifest-reference.md#user-configuration` calls `userConfig` "User-configurable values
   * prompted at enable time", and `:543` — "the values that Claude Code prompts
   * the user for when the plugin is enabled. Use this instead of requiring users
   * to hand-edit `settings.json`."
   *
   * Nothing prompted, because nothing told the caller there was anything to ask.
   * The status returned here is what the renderer raises the dialog from; it is
   * value-free, like every other status this service returns.
   */
  it('returns the value-free configuration status from enable, so a caller can prompt', async () => {
    const { service } = createService();
    const installed = await service.install({ kind: 'local-path', path: createSettingsBundle() });
    const pluginKey = installed.installed!.pluginKey;

    const enabled = await service.enable(pluginKey, { kind: 'workspace', workspaceId: 'ws_a' });
    expect(enabled.configuration?.state).toBe('needs_configuration');
    expect(enabled.configuration?.fields.map(field => field.key)).toEqual(['theme', 'retries']);
    // Value-free: the status says WHICH field is missing and never what is in it.
    expect(JSON.stringify(enabled.configuration)).not.toContain('system');

    // Once configured, a later enable has nothing to ask about.
    await service.configure(pluginKey, 'ws_a', { retries: 3 });
    const reEnabled = await service.enable(pluginKey, { kind: 'workspace', workspaceId: 'ws_a' });
    expect(reEnabled.configuration?.state).toBe('ready');
  });

  it('says nothing at enable for a plugin that declares no options', async () => {
    // The silent path every plugin had before D15, unchanged.
    const { service } = createService();
    const installed = await service.install({ kind: 'local-path', path: createBundle() });
    const enabled = await service.enable(
      installed.installed!.pluginKey,
      { kind: 'workspace', workspaceId: 'ws_a' },
    );
    expect(enabled.configuration).toBeUndefined();
  });

  it('rejects an invalid activation target before committing a bundle', async () => {
    const { service, store } = createService();
    await expect(service.install(
      { kind: 'local-path', path: createBundle() },
      { activateIn: { kind: 'workspace', workspaceId: '../escape' } },
    )).rejects.toThrow();
    expect((await store.readInstalledRegistry()).plugins).toEqual([]);
  });

  it('repairs side-by-side and uninstalls by stable PluginKey while preserving a lease', async () => {
    const { service, store } = createService();
    const bundle = createBundle();
    const installed = await service.install({ kind: 'local-path', path: bundle });
    const pluginKey = installed.installed?.pluginKey ?? '';
    const first = (await store.readInstalledRegistry()).plugins[0]!;
    const release = store.acquireInstanceLease(first.pluginInstanceId);

    writeFileSync(join(bundle, 'skills', 'review', 'SKILL.md'), '# Review changed');
    const repaired = await service.repair(pluginKey);
    expect(repaired.ok).toBe(true);
    expect(repaired.installed?.activeInstanceId).not.toBe(first.pluginInstanceId);
    expect(existsSync(store.cachePathFor(first.cacheRef))).toBe(true);

    await service.uninstall(pluginKey);
    expect((await store.readInstalledRegistry()).active[pluginKey]).toBeUndefined();
    release();
    await store.prune();
    expect((await service.status()).installed).toEqual([]);
  });

  it('repairs a registry-local install from its durable server-only path', async () => {
    const { service, store } = createService();
    const bundle = createBundle();
    const installed = await service.install({
      kind: 'local-path',
      path: bundle,
      marketplace: {
        marketplaceId: 'registry-1',
        itemId: 'registry-1:toolkit',
        listKind: 'plugins',
        itemKind: 'plugin',
        name: 'toolkit',
      },
    });
    const pluginKey = installed.installed!.pluginKey;
    expect(JSON.stringify(installed.installed)).not.toContain(bundle);
    expect((await store.readInstalledRegistry()).plugins[0]?.origin.localPath).toBe(bundle);

    writeFileSync(join(bundle, 'skills', 'review', 'SKILL.md'), '# Review updated');
    const repaired = await service.repair(pluginKey);

    expect(repaired.ok).toBe(true);
    expect(repaired.installed?.activeInstanceId).not.toBe(installed.installed?.activeInstanceId);
    expect(repaired.installed?.source?.marketplaceItemId).toBe('registry-1:toolkit');
    expect(JSON.stringify(repaired.installed)).not.toContain(bundle);
  });

  it('reconstructs npm repair from the persisted custom registry and integrity', async () => {
    const seenSources: unknown[] = [];
    const real = new PluginInstallService({
      fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
      baseTempDir: join(dir, 'staging'),
    });
    const installer: PluginInstallStager = {
      createInstallPlanFromSource: source => {
        seenSources.push(source);
        return real.createInstallPlanFromSource(source);
      },
      stageInstall: (plan, options) => real.stageInstall(plan, options),
      normalizeStagedInstall: staged => real.normalizeStagedInstall(staged),
    };
    const { service } = createService({ installer });
    const installed = await service.install({ kind: 'local-path', path: createBundle() });
    const pluginKey = installed.installed!.pluginKey;

    // Model an installed marketplace record without exposing a repair source
    // through the renderer. Repair must recover it from durable provenance.
    const registryPath = join(dir, 'plugins', 'installed.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
      plugins: Array<{ origin: Record<string, unknown> }>;
    };
    registry.plugins[0]!.origin = {
      source: 'marketplace',
      marketplaceId: 'skills-market',
      marketplaceBaseUrl: 'https://market.example/api',
      sourceUrl: 'https://gitlab.example/toolkit',
      resolvedAt: 44,
      provenance: {
        itemId: 'toolkit',
        listKind: 'plugins',
        itemKind: 'plugin',
        name: 'Toolkit',
        version: '1.0.0',
        packageName: '@ai-office/toolkit',
        registry: 'https://artifactory.example/api/npm/npm-all',
        integrity: 'sha512-cGlubmVk',
      },
    };
    writeFileSync(registryPath, JSON.stringify(registry));

    const repaired = await service.repair(pluginKey);

    expect(repaired.ok).toBe(false); // the test fetch seam is intentionally offline
    expect(seenSources.at(-1)).toEqual({
      kind: 'marketplace-npm-package',
      packageName: '@ai-office/toolkit',
      version: '1.0.0',
      registry: 'https://artifactory.example/api/npm/npm-all',
      integrity: 'sha512-cGlubmVk',
      marketplace: {
        marketplaceId: 'skills-market',
        marketplaceBaseUrl: 'https://market.example/api',
        itemId: 'toolkit',
        name: 'Toolkit',
        version: '1.0.0',
        sourceUrl: 'https://gitlab.example/toolkit',
        packageName: '@ai-office/toolkit',
      },
    });
  });

  it('uninstall purges activation, executable trust, and persisted plugin settings before identical-byte reinstall', async () => {
    const { service, policy, trust } = createService();
    const bundle = createBundle();
    const first = await service.install(
      { kind: 'local-path', path: bundle },
      { activateIn: { kind: 'workspace', workspaceId: 'ws_a' } },
    );
    const pluginKey = first.installed!.pluginKey;
    const pluginInstanceId = first.installed!.activeInstanceId;
    const trustKey = {
      pluginInstanceId,
      capabilityId: 'hook:review',
      executableHash: 'sha256-review',
      scope: { kind: 'workspace' as const, workspaceId: 'ws_a' },
    };
    trust.grant(trustKey);
    const dataPath = getPluginDataRoot(pluginKey, join(dir, 'plugins', 'data'));
    const settings = new PluginSettings({
      dataPath,
      pluginInstanceId,
      descriptors: [{ key: 'theme', valueType: 'string', defaultValue: 'system' }],
    });
    await settings.write({ theme: 'dark' });
    expect(existsSync(settings.path)).toBe(true);

    await service.uninstall(pluginKey);

    expect(policy.resolve({ pluginKey }, { workspaceId: 'ws_a' }).enabled).toBe(false);
    expect(trust.resolve(trustKey)).toBe('review-required');
    expect(existsSync(settings.path)).toBe(false);
    expect(existsSync(dataPath)).toBe(false);

    const second = await service.install({ kind: 'local-path', path: bundle });
    expect(second.installed?.activeInstanceId).toBe(pluginInstanceId);
    expect(policy.resolve({ pluginKey }, { workspaceId: 'ws_a' }).enabled).toBe(false);
    expect(trust.resolve(trustKey)).toBe('review-required');
  });

  it('fails closed with the plugin disabled but still installed when managed-data cleanup fails', async () => {
    const { service, policy } = createService({
      dataLifecycle: {
        onPluginUninstall: () => { throw new Error('managed-data-cleanup-failed'); },
      },
    });
    const installed = await service.install(
      { kind: 'local-path', path: createBundle() },
      { activateIn: { kind: 'workspace', workspaceId: 'ws_a' } },
    );
    const pluginKey = installed.installed!.pluginKey;

    const error = await service.uninstall(pluginKey).catch(value => value);

    expect(error).toBeInstanceOf(PluginMutationCommittedError);
    expect(error).toMatchObject({
      action: 'uninstall',
      pluginKey,
      effect: 'remove',
      message: 'managed-data-cleanup-failed',
    });
    expect(policy.resolve({ pluginKey }, { workspaceId: 'ws_a' }).enabled).toBe(false);
    expect((await service.status()).installed.map(plugin => plugin.pluginKey)).toContain(pluginKey);
  });

  it('C5: install-with-activation of a connector bundle has no materialization step left to fail', async () => {
    // Pre-C3 a throwing connector lifecycle committed the registry and
    // re-threw as a PluginMutationCommittedError; the lifecycle itself is
    // deleted now — the install simply succeeds and activates.
    const { service, policy, store } = createService();

    const result = await service.install(
      { kind: 'local-path', path: createConnectorBundle() },
      { activateIn: { kind: 'workspace', workspaceId: 'ws_a' } },
    );

    expect(result.ok).toBe(true);
    const installed = (await store.readInstalledRegistry()).plugins[0]!;
    expect(policy.resolve({ pluginKey: installed.pluginKey }, { workspaceId: 'ws_a' }).enabled).toBe(true);
  });

  it('serializes lifecycle mutations so enable cannot recreate policy during uninstall', async () => {
    let markUninstallStarted!: () => void;
    let releaseUninstall!: () => void;
    const uninstallStarted = new Promise<void>(resolve => { markUninstallStarted = resolve; });
    const uninstallGate = new Promise<void>(resolve => { releaseUninstall = resolve; });
    const dataLifecycle: PluginDataLifecycle = {
      onPluginUninstall: async () => {
        markUninstallStarted();
        await uninstallGate;
      },
    };
    const { service, policy } = createService({ dataLifecycle });
    const installed = await service.install(
      { kind: 'local-path', path: createBundle() },
      { activateIn: { kind: 'workspace', workspaceId: 'ws_a' } },
    );
    const pluginKey = installed.installed!.pluginKey;

    const uninstall = service.uninstall(pluginKey);
    await uninstallStarted;
    const racingEnable = service.enable(pluginKey, { kind: 'workspace', workspaceId: 'ws_a' });
    releaseUninstall();

    await uninstall;
    await expect(racingEnable).rejects.toThrow('plugin.manage.not-installed');
    expect(policy.resolve({ pluginKey }, { workspaceId: 'ws_a' }).enabled).toBe(false);
  });

  it('surfaces the adapter compatibility report on a supported install and status', async () => {
    const { service } = createService();
    const result = await service.install({ kind: 'local-path', path: createBundle() });

    expect(result.ok).toBe(true);
    expect(result.compatibility).toMatchObject({ format: 'nessy', state: 'supported' });
    expect(result.installed?.compatibility).toMatchObject({ format: 'nessy', state: 'supported' });

    const status = await service.status();
    expect(status.installed[0]?.compatibility).toMatchObject({ format: 'nessy', state: 'supported' });
  });

  it('activates a partial install while keeping its unavailable native MCP inert', async () => {
    const { service, store, policy } = createService();
    const result = await service.install(
      { kind: 'local-path', path: createUnsupportedNativeMcpBundle() },
      { activateIn: { kind: 'workspace', workspaceId: 'ws_a' } },
    );

    expect(result.ok).toBe(true);
    expect(result.requiresConfirmation).toBeUndefined();
    expect(result.compatibility).toMatchObject({
      format: 'nessy',
      state: 'partial',
      deferred: [{ externalKind: 'mcp', reasonCode: 'plugin.deferred.nessy_mcp_command_unavailable' }],
    });
    expect(policy.resolve(
      { pluginKey: result.installed?.pluginKey },
      { workspaceId: 'ws_a' },
    ).enabled).toBe(true);
    const installed = (await store.readInstalledRegistry()).plugins[0];
    expect(installed?.manifest.capabilities).toEqual([
      expect.objectContaining({ kind: 'unsupported', id: 'unavailable-deno' }),
    ]);
  });

  it('blocks cache commit when the adapter compatibility report is blocked', async () => {
    const { service, store } = createService({ forceCompatibilityState: 'blocked' });

    const result = await service.install(
      { kind: 'local-path', path: createBundle() },
      { activateIn: { kind: 'workspace', workspaceId: 'ws_a' } },
    );

    expect(result.ok).toBe(false);
    expect(result.compatibility?.state).toBe('blocked');
    expect(result.installed).toBeUndefined();
    expect((await store.readInstalledRegistry()).plugins).toEqual([]);
  });

  it('does not invoke dependency installation for a self-contained executable plugin', async () => {
    let invoked = false;
    const { service } = createService({
      runtimeDependencyInstaller: async () => { invoked = true; },
    });

    const result = await service.install({
      kind: 'local-path',
      path: createExecutableBundle('self-contained'),
    });

    expect(result.ok).toBe(true);
    expect(invoked).toBe(false);
  });

  it('accepts fully vendored executable dependencies without an installer or lockfile', async () => {
    const bundle = createExecutableBundle('vendored', { sdk: '1.0.0' });
    rmSync(join(bundle, 'package-lock.json'));
    writeVendoredPackage(bundle, 'sdk');
    const { service } = createService();

    const result = await service.install({ kind: 'local-path', path: bundle });

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('does not treat an incomplete vendored dependency graph as self-contained', async () => {
    const bundle = createExecutableBundle('vendored-incomplete', { sdk: '1.0.0' });
    rmSync(join(bundle, 'package-lock.json'));
    writeVendoredPackage(bundle, 'sdk', { transitive: '1.0.0' });
    const { service } = createService();

    const result = await service.install({ kind: 'local-path', path: bundle });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'plugin.install.runtime_dependency_lock_missing',
    );
  });

  it('materializes locked production dependencies before the StoreV2 commit', async () => {
    const requests: Parameters<PluginRuntimeDependencyInstaller>[0][] = [];
    const { service, store } = createService({
      runtimeDependencyInstaller: async request => {
        requests.push(request);
        writeVendoredPackage(request.directory, '@modelcontextprotocol/sdk');
      },
    });

    const result = await service.install({
      kind: 'local-path',
      path: createExecutableBundle('locked', { '@modelcontextprotocol/sdk': '1.29.0' }),
    });

    expect(result.ok).toBe(true);
    expect((await store.readInstalledRegistry()).plugins).toHaveLength(1);
    expect(requests).toEqual([{
      mode: 'locked',
      directory: expect.stringContaining('/normalized'),
      packageJsonPath: expect.stringContaining('/normalized/package.json'),
      lockfilePath: expect.stringContaining('/normalized/package-lock.json'),
      production: true,
      ignoreScripts: true,
      frozenLockfile: true,
    }]);
  });

  it('materializes declared npx packages into the immutable bundle before commit', async () => {
    const packageSpec = 'xcodebuildmcp@^2.7.0';
    const requests: Parameters<PluginRuntimeDependencyInstaller>[0][] = [];
    const { service, store } = createService({
      runtimeDependencyInstaller: async request => {
        requests.push(request);
        if (request.frozenLockfile) throw new Error('unexpected locked install');
        writeFileSync(join(request.directory, 'bun.lock'), 'lockfileVersion = 1\n');
        writeVendoredPackageWithBin(request.directory, 'xcodebuildmcp');
        expect(hasMaterializedPluginPackageRunner(request.directory, [packageSpec])).toBe(true);
      },
    });

    const result = await service.install({
      kind: 'local-path',
      path: createNpxBundle(packageSpec),
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(requests).toEqual([expect.objectContaining({
      mode: 'generate-lock',
      frozenLockfile: false,
      production: true,
      ignoreScripts: true,
    })]);
    const installed = (await store.readInstalledRegistry()).plugins[0]!;
    const runtimeRoot = pluginNpxRuntimeRoot(store.cachePathFor(installed.cacheRef));
    expect(existsSync(join(runtimeRoot, 'bun.lock'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'node_modules', 'xcodebuildmcp', 'bin', 'server.mjs'))).toBe(true);
  });

  it('rejects conflicting versions of one declared npx package before installation', async () => {
    const bundle = createNpxBundle('xcodebuildmcp@^2.0.0');
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({
      private: true,
      dependencies: { xcodebuildmcp: '^2.0.0' },
    }));
    writeVendoredPackageWithBin(bundle, 'xcodebuildmcp');
    const manifestPath = join(bundle, 'plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.capabilities.push({
      kind: 'mcp',
      id: 'xcodebuildmcp-next',
      mcp: {
        serverName: 'xcodebuildmcp-next',
        transport: 'stdio',
        command: 'npx',
        args: ['xcodebuildmcp@^3.0.0', 'mcp'],
      },
    });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    let invoked = false;
    const { service, store } = createService({
      runtimeDependencyInstaller: async () => { invoked = true; },
    });

    const result = await service.install({ kind: 'local-path', path: bundle });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'plugin.install.npx_dependency_conflict',
    );
    expect(invoked).toBe(false);
    expect((await store.readInstalledRegistry()).plugins).toEqual([]);
  });

  it('rejects a plugin-authored reserved npx runtime before installation', async () => {
    const bundle = createNpxBundle('xcodebuildmcp@latest');
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({
      private: true,
      dependencies: { xcodebuildmcp: 'latest' },
    }));
    writeVendoredPackageWithBin(bundle, 'xcodebuildmcp');
    writeVendoredPackageWithBin(join(bundle, '.nessy-runtime', 'npx'), 'xcodebuildmcp');
    let invoked = false;
    const { service, store } = createService({
      runtimeDependencyInstaller: async () => { invoked = true; },
    });

    const result = await service.install({ kind: 'local-path', path: bundle });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'plugin.install.npx_runtime_path_reserved',
    );
    expect(invoked).toBe(false);
    expect((await store.readInstalledRegistry()).plugins).toEqual([]);
  });

  it('accepts the publishable npm shrinkwrap lock contract', async () => {
    const bundle = createExecutableBundle('shrinkwrap', { sdk: '1.0.0' });
    renameSync(join(bundle, 'package-lock.json'), join(bundle, 'npm-shrinkwrap.json'));
    let lockfilePath = '';
    const { service } = createService({
      runtimeDependencyInstaller: async request => {
        if (!request.frozenLockfile) throw new Error('unexpected registry install');
        lockfilePath = request.lockfilePath;
        writeVendoredPackage(request.directory, 'sdk');
      },
    });

    const result = await service.install({ kind: 'local-path', path: bundle });

    expect(result.ok).toBe(true);
    expect(basename(lockfilePath)).toBe('npm-shrinkwrap.json');
  });

  it('rejects executable plugins with multiple supported lockfiles', async () => {
    const bundle = createExecutableBundle('ambiguous-locks', { sdk: '1.0.0' });
    writeFileSync(join(bundle, 'npm-shrinkwrap.json'), '{}');
    let invoked = false;
    const { service, store } = createService({
      runtimeDependencyInstaller: async () => { invoked = true; },
    });

    const result = await service.install({ kind: 'local-path', path: bundle });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'plugin.install.runtime_dependency_lock_ambiguous',
    );
    expect(invoked).toBe(false);
    expect((await store.readInstalledRegistry()).plugins).toEqual([]);
  });

  it('rejects unsafe executable dependency specs before invoking the installer', async () => {
    let invoked = false;
    const { service, store } = createService({
      runtimeDependencyInstaller: async () => { invoked = true; },
    });

    const result = await service.install({
      kind: 'local-path',
      path: createExecutableBundle('unsafe', { sdk: 'file:../sdk' }),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'plugin.install.runtime_dependency_spec_unsafe',
    );
    expect(invoked).toBe(false);
    expect((await store.readInstalledRegistry()).plugins).toEqual([]);
  });

  it('aborts before StoreV2 when dependency installation fails', async () => {
    const { service, store } = createService({
      runtimeDependencyInstaller: async () => { throw new Error('installer failed'); },
    });

    const result = await service.install({
      kind: 'local-path',
      path: createExecutableBundle('failure', { sdk: '1.0.0' }),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'plugin.install.runtime_dependency_install_failed',
    );
    expect((await store.readInstalledRegistry()).plugins).toEqual([]);
  });

  it('reports a bounded quota failure without committing the executable plugin', async () => {
    const { service, store } = createService({
      runtimeDependencyInstaller: async () => {
        throw new Error('plugin-runtime-dependency-quota-exceeded');
      },
    });

    const result = await service.install({
      kind: 'local-path',
      path: createExecutableBundle('quota-failure', { sdk: '1.0.0' }),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'plugin.install.runtime_dependency_quota_exceeded',
    );
    expect((await store.readInstalledRegistry()).plugins).toEqual([]);
  });

  it('applies requested auto-activation to the supported subset of a partial install', async () => {
    const { service, store, policy } = createService({ forceCompatibilityState: 'partial' });

    const result = await service.install(
      { kind: 'local-path', path: createBundle() },
      { activateIn: { kind: 'workspace', workspaceId: 'ws_a' } },
    );

    expect(result.ok).toBe(true);
    expect(result.compatibility?.state).toBe('partial');
    expect(result.requiresConfirmation).toBeUndefined();
    expect((await store.readInstalledRegistry()).plugins).toHaveLength(1);
    expect(policy.resolve(
      { pluginKey: result.installed?.pluginKey },
      { workspaceId: 'ws_a' },
    ).enabled).toBe(true);
  });

  it('fails a previously enabled plugin closed when repair changes compatibility to partial', async () => {
    let compatibilityState: PluginCompatibilityReport['state'] = 'supported';
    const real = new PluginInstallService({
      fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
      baseTempDir: join(dir, 'staging'),
    });
    const installer: PluginInstallStager = {
      createInstallPlanFromSource: source => real.createInstallPlanFromSource(source),
      stageInstall: (plan, options) => real.stageInstall(plan, options),
      normalizeStagedInstall: async staged => {
        const normalized = await real.normalizeStagedInstall(staged);
        return {
          ...normalized,
          ...(normalized.compatibility
            ? { compatibility: { ...normalized.compatibility, state: compatibilityState } }
            : {}),
        };
      },
    };
    const { service, store, policy } = createService({ installer });
    const installed = await service.install({ kind: 'local-path', path: createBundle() });
    const pluginKey = installed.installed?.pluginKey ?? '';
    await service.enable(pluginKey, { kind: 'workspace', workspaceId: 'ws_a' });
    expect(policy.resolve({ pluginKey }, { workspaceId: 'ws_a' }).enabled).toBe(true);

    compatibilityState = 'partial';
    const activeBeforeRepair = (await store.readInstalledRegistry()).active[pluginKey];
    const purgePlugin = policy.purgePlugin.bind(policy);
    policy.purgePlugin = (() => {
      throw new Error('policy persistence failed');
    }) as typeof policy.purgePlugin;
    await expect(service.repair(pluginKey)).rejects.toThrow('policy persistence failed');
    const registryAfterFailedPurge = await store.readInstalledRegistry();
    expect(registryAfterFailedPurge.active[pluginKey]).toBe(activeBeforeRepair);
    expect(registryAfterFailedPurge.plugins.find(
      entry => entry.pluginInstanceId === activeBeforeRepair,
    )?.compatibility?.state).toBe('supported');

    policy.purgePlugin = purgePlugin;
    const repaired = await service.repair(pluginKey);
    expect(repaired).toMatchObject({
      ok: true,
      requiresConfirmation: true,
      compatibility: { state: 'partial' },
    });
    expect(policy.resolve({ pluginKey }, { workspaceId: 'ws_a' }).enabled).toBe(false);
    expect((await service.status()).installed[0]?.compatibility?.state).toBe('partial');
  });

  it('never grants executable trust on install or enable — only an explicit CapabilityTrustStore.grant() does', async () => {
    const { service } = createService();
    const trustStore = new CapabilityTrustStore({ path: join(dir, 'capability-trust.json') });

    const installed = await service.install(
      { kind: 'local-path', path: createBundle() },
      { activateIn: { kind: 'workspace', workspaceId: 'ws_a' } },
    );
    const pluginKey = installed.installed?.pluginKey ?? '';
    await service.enable(pluginKey, { kind: 'global' });
    await service.enable(pluginKey, { kind: 'project', workspaceId: 'ws_b', projectKey: PROJECT_KEY });

    // Install/enable never create a trust record: a trust key for any
    // capability of this plugin resolves review-required either way.
    expect(trustStore.resolve({
      pluginInstanceId: installed.installed?.activeInstanceId ?? '',
      capabilityId: 'review',
      executableHash: 'any-hash',
      scope: { kind: 'workspace', workspaceId: 'ws_a' },
    })).toBe('review-required');
    // The trust file itself was never even created by install/enable.
    expect(existsSync(join(dir, 'capability-trust.json'))).toBe(false);
  });

  it('C5: connector-backed plugins activate at project scope — nothing materializes anywhere', async () => {
    // The pre-C5 refusal existed because connector servers materialized
    // per-workspace Sources a project scope cannot own. With the projection
    // deleted, project scope is a normal activation target for BOTH a fresh
    // install and a persisted pre-C3 entry.
    const { service, policy, store } = createService();
    const { pluginKey } = await installPersistedPreC3ConnectorEntry(store);

    await service.enable(pluginKey, { kind: 'project', workspaceId: 'ws_a', projectKey: PROJECT_KEY });
    expect(policy.resolve(
      { pluginKey },
      { workspaceId: 'ws_a', projectKey: PROJECT_KEY },
    ).enabled).toBe(true);

    const accepted = await service.install(
      { kind: 'local-path', path: createConnectorBundle('https://example.invalid/second', '2.0.0') },
      { activateIn: { kind: 'project', workspaceId: 'ws_a', projectKey: PROJECT_KEY } },
    );
    expect(accepted.ok).toBe(true);
  });

  it('C3: a connector-bundle install rides the capability path — twin capability, retained app routing, zero materialization', async () => {
    const { service, store } = createService();

    await service.install(
      { kind: 'local-path', path: createConnectorBundle() },
      { activateIn: { kind: 'workspace', workspaceId: 'ws_a' } },
    );

    const installed = (await store.readInstalledRegistry()).plugins[0]!;
    const twin = installed.manifest.capabilities.find(capability => (
      capability.kind === 'mcp' && capability.mcp.serverName === 'gmail-mcp'
    ));
    expect(twin?.kind === 'mcp' ? twin.mcp : undefined).toMatchObject({
      serverName: 'gmail-mcp',
      transport: 'http',
      url: 'https://example.invalid/mcp',
      authType: 'oauth',
    });
    // The app-referenced connector survives as declarative routing metadata.
    expect(installed.manifest.connectors?.map(connector => connector.id)).toEqual(['gmail']);
    expect(installed.manifest.apps).toEqual([{ id: 'gmail-app', connectorId: 'gmail' }]);
  });

  it('summarizes plugin server authentication without credential values (capability path)', async () => {
    const { service } = createService();
    const result = await service.install({ kind: 'local-path', path: createConnectorBundle() });

    // The requirement now names the auth-carrying CAPABILITY; the RPC shape
    // (kind/connectorIds/serverNames/timing) is unchanged.
    expect(result.installed?.authRequirements).toEqual([{
      kind: 'oauth', connectorIds: ['mcp.gmail.gmail-mcp'], serverNames: ['gmail-mcp'], timing: 'ON_FIRST_USE',
    }]);
    expect(JSON.stringify(result.installed?.authRequirements)).not.toContain('https://');
  });

  it('applies and persists external catalog auth timing for mixed app connectors', async () => {
    const { service, store } = createService();

    const result = await service.install(
      { kind: 'local-path', path: createConnectorBundle() },
      {
        activateIn: { kind: 'workspace', workspaceId: 'ws_a' },
        connectorAuthTiming: 'ON_INSTALL',
      },
    );
    expect(result.ok).toBe(true);
    const pluginKey = result.installed?.pluginKey ?? '';
    let active = (await store.readInstalledRegistry()).plugins.find(entry => entry.pluginKey === pluginKey);
    // The retained app-routing connector still records the catalog timing…
    expect(active?.manifest.connectors?.[0]?.auth?.timing).toBe('ON_INSTALL');
    expect(active?.origin.provenance?.connectorAuthTiming).toBe('ON_INSTALL');

    const repaired = await service.repair(pluginKey, {
      source: { kind: 'local-path', path: createConnectorBundle('https://example.invalid/v2', '2.0.0') },
    });
    expect(repaired.ok).toBe(true);
    active = (await store.readInstalledRegistry()).plugins.find(entry => entry.pluginInstanceId === repaired.installed?.activeInstanceId);
    expect(active?.manifest.connectors?.[0]?.auth?.timing).toBe('ON_INSTALL');
  });

  it('promotes a catalog-authenticated simple remote MCP to trusted OAuth instead of anonymous HTTP', async () => {
    const { service, store } = createService();

    const result = await service.install(
      { kind: 'local-path', path: createCatalogRemoteMcpBundle() },
      {
        activateIn: { kind: 'workspace', workspaceId: 'ws_a' },
        connectorAuthTiming: 'ON_INSTALL',
        catalogAuthenticationPolicy: 'ON_INSTALL',
      },
    );

    expect(result.ok).toBe(true);
    const active = (await store.readInstalledRegistry()).plugins.find(
      entry => entry.pluginInstanceId === result.installed?.activeInstanceId,
    );
    // C3: the catalog-authenticated server STAYS a capability, carrying the
    // endpoint auth descriptor — no synthesized catalog.* connector, and the
    // lifecycle is never consulted.
    const capability = active?.manifest.capabilities[0];
    expect(capability?.kind === 'mcp' ? capability.mcp : undefined).toMatchObject({
      serverName: 'cloudflare-api',
      transport: 'http',
      url: 'https://mcp.cloudflare.com/mcp',
      authType: 'oauth',
    });
    expect(active?.manifest.connectors ?? []).toEqual([]);
    expect(active?.origin.provenance).toMatchObject({
      connectorAuthTiming: 'ON_INSTALL',
      catalogAuthenticationPolicy: 'ON_INSTALL',
    });
  });

  it('refuses an unpromotable catalog-authenticated remote MCP as an mcp-labelled row a headless run can read', async () => {
    // POSITIVE CONTROL for P2.182's live half: this is the only producer of
    // `externalKind: 'catalog-authenticated-mcp'`, and it had no test at all.
    // The refusal must carry the SERVER name in `sourcePath` — that is what
    // `projection-candidates.ts` recovers so `buildHeadlessInitView`'s
    // PRODUCER 2 can name the server instead of the capability id.
    const { service, store } = createService();

    const result = await service.install(
      { kind: 'local-path', path: createUnpromotableCatalogMcpBundle() },
      {
        activateIn: { kind: 'workspace', workspaceId: 'ws_a' },
        connectorAuthTiming: 'ON_INSTALL',
        catalogAuthenticationPolicy: 'ON_INSTALL',
      },
    );

    expect(result.ok).toBe(true);
    const active = (await store.readInstalledRegistry()).plugins.find(
      entry => entry.pluginInstanceId === result.installed?.activeInstanceId,
    );
    const capability = active?.manifest.capabilities[0];
    expect(capability?.kind).toBe('unsupported');
    expect(capability?.kind === 'unsupported' ? capability.unsupported : undefined).toMatchObject({
      externalKind: 'catalog-authenticated-mcp',
      reasonCode: 'plugin.deferred.catalog_authenticated_mcp_auth_ambiguous',
      sourcePath: 'catalog-authenticated-mcp.cloudflare-api',
      executable: true,
    });
    // Nothing was promoted, so no anonymous HTTP server survives either.
    expect(active?.manifest.connectors ?? []).toEqual([]);
  });

  it('promotes a catalog-authenticated remote MCP carrying a tool timeout, keeping the ceiling', async () => {
    // A per-server ceiling is benign configuration, not ambiguous auth: it must
    // not turn the whole server into an `unsupported` capability, and the
    // promoted connector has to carry it rather than silently drop it.
    const { service, store } = createService();

    const result = await service.install(
      { kind: 'local-path', path: createCatalogRemoteMcpBundle(600) },
      {
        activateIn: { kind: 'workspace', workspaceId: 'ws_a' },
        connectorAuthTiming: 'ON_INSTALL',
        catalogAuthenticationPolicy: 'ON_INSTALL',
      },
    );

    expect(result.ok).toBe(true);
    const active = (await store.readInstalledRegistry()).plugins.find(
      entry => entry.pluginInstanceId === result.installed?.activeInstanceId,
    );
    // C3: stays a capability, keeping both the auth descriptor and the ceiling.
    const capability = active?.manifest.capabilities[0];
    expect(capability?.kind === 'mcp' ? capability.mcp : undefined).toMatchObject({
      serverName: 'cloudflare-api',
      transport: 'http',
      url: 'https://mcp.cloudflare.com/mcp',
      authType: 'oauth',
      toolTimeoutMs: 600_000,
    });
    expect(active?.manifest.connectors ?? []).toEqual([]);
  });

  it('rejects an official app-only .app.json bundle without connector metadata, but keeps a mixed bundle partial', async () => {
    const first = createService();
    const rejected = await first.service.install({ kind: 'local-path', path: createCodexAppBundle(false) });
    expect(rejected.ok).toBe(false);
    expect(rejected.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'plugin.install.app_connector_metadata_missing',
    );
    expect((await first.store.readInstalledRegistry()).plugins).toEqual([]);

    const second = createService();
    const mixed = await second.service.install({ kind: 'local-path', path: createCodexAppBundle(true) });
    expect(mixed.ok).toBe(true);
    expect(mixed.compatibility?.state).toBe('partial');
    expect(mixed.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'plugin.format.codex_app_connector_unresolved',
    );
    expect((await second.store.readInstalledRegistry()).plugins).toHaveLength(1);
  });

  it('keeps an app-only plugin with only unsupported capabilities inactive', async () => {
    const { service, store } = createService();

    const result = await service.install({ kind: 'local-path', path: createUnsupportedAppBundle() });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'plugin.install.app_connector_metadata_missing',
    );
    expect((await store.readInstalledRegistry()).plugins).toEqual([]);
  });

  it('C3: repairing a pre-C3 entry moves its servers to the capability path and sweeps the projection', async () => {
    const { service, store } = createService();
    const { pluginKey } = await installPersistedPreC3ConnectorEntry(store);

    const repaired = await service.repair(pluginKey, {
      source: { kind: 'local-path', path: createConnectorBundle('https://example.invalid/v2', '2.0.0') },
    });

    expect(repaired.ok).toBe(true);
    const active = (await store.readInstalledRegistry()).plugins.find(
      entry => entry.pluginInstanceId === repaired.installed?.activeInstanceId,
    );
    const twin = active?.manifest.capabilities.find(capability => (
      capability.kind === 'mcp' && capability.mcp.serverName === 'gmail-mcp'
    ));
    expect(twin?.kind === 'mcp' ? twin.mcp.authType : undefined).toBe('oauth');
  });

});

// plugin-dependencies.md § Enable or disable a plugin with dependencies.
describe('PluginManagementServiceV2 — plugin dependencies', () => {
  const target = { kind: 'workspace', workspaceId: 'ws_dep' } as const;

  async function installPair(dependencyRange?: string) {
    const { service, policy } = createService();
    const dependency = await service.install({ kind: 'local-path', path: createDependencyBundle() });
    const dependent = await service.install({
      kind: 'local-path',
      path: createDependentBundle(dependencyRange),
    });
    return {
      service,
      policy,
      dependencyKey: dependency.installed?.pluginKey ?? '',
      dependentKey: dependent.installed?.pluginKey ?? '',
    };
  }

  // P6.386. `plugins-reference.md` § Default enablement — "Set `defaultEnabled:
  // false` in `plugin.json` to ship a plugin that installs disabled. The user
  // turns it on with `claude plugin enable <plugin>` or the `/plugin`
  // interface." The field was parsed, precedence-resolved and stored, and the
  // V2 install path activated every plugin unconditionally.
  it('installs a defaultEnabled:false plugin DISABLED, and says so', async () => {
    const { service, policy } = createService();

    const result = await service.install(
      { kind: 'local-path', path: createDependencyBundle() },
      { activateIn: target },
    );

    expect(result.ok).toBe(true);
    const pluginKey = result.installed?.pluginKey ?? '';
    expect(policy.resolve({ pluginKey }, { workspaceId: target.workspaceId }).enabled).toBe(false);
    // Nothing was written at the target scope at all — the plugin is parked on
    // its own default, not held down by an explicit `false` a later enable would
    // have to fight.
    expect(policy.resolveScopes({ pluginKey }, { workspaceId: target.workspaceId }))
      .toMatchObject({ workspace: 'unset' });
    // The user is TOLD, rather than left to wonder why nothing loaded.
    expect(result.diagnostics.map(diagnostic => diagnostic.code))
      .toContain('plugin.install.default_disabled');
  });

  // The positive control, in the same pass: today's behaviour is unchanged for
  // every plugin that declares nothing.
  it('installs a plugin that declares no defaultEnabled ENABLED, as before', async () => {
    const { service, policy } = createService();

    const result = await service.install(
      { kind: 'local-path', path: createDependentBundle() },
      { activateIn: target },
    );

    const pluginKey = result.installed?.pluginKey ?? '';
    expect(policy.resolve({ pluginKey }, { workspaceId: target.workspaceId }).enabled).toBe(true);
    expect(result.diagnostics.map(diagnostic => diagnostic.code))
      .not.toContain('plugin.install.default_disabled');
  });

  // `plugins-reference.md` § Default enablement, the one precedence that must
  // survive at INSTALL time: "when a plugin is required by another one that is
  // active, Claude Code writes `true` for it at install or enable time. That
  // gives it an explicit setting, so its own default no longer applies." This is
  // the shape `marketplace/service.ts`'s `acquireDependencies` drives — the root
  // is installed and enabled first, each dependency after it.
  it('still enables a defaultEnabled:false plugin installed to satisfy an enabled dependent', async () => {
    const { service, policy } = createService();

    const dependent = await service.install(
      { kind: 'local-path', path: createDependentBundle() },
      { activateIn: target },
    );
    expect(policy.resolve({ pluginKey: dependent.installed?.pluginKey ?? '' }, { workspaceId: target.workspaceId }).enabled)
      .toBe(true);

    const dependency = await service.install(
      { kind: 'local-path', path: createDependencyBundle() },
      { activateIn: target },
    );

    const dependencyKey = dependency.installed?.pluginKey ?? '';
    expect(policy.resolve({ pluginKey: dependencyKey }, { workspaceId: target.workspaceId }).enabled).toBe(true);
    expect(dependency.diagnostics.map(diagnostic => diagnostic.code))
      .not.toContain('plugin.install.default_disabled');
  });

  // `:158` — "When you enable a plugin, Claude Code also enables its
  // dependencies at the same scope." `:165`/`:167` — an explicit `true` that
  // outranks the dependency's own `defaultEnabled: false`.
  it('enables a dependency at the same scope, overriding its defaultEnabled: false', async () => {
    const { service, policy, dependencyKey, dependentKey } = await installPair();

    await service.enable(dependentKey, target);

    expect(policy.resolve({ pluginKey: dependentKey }, { workspaceId: target.workspaceId }).enabled).toBe(true);
    expect(policy.resolve({ pluginKey: dependencyKey }, { workspaceId: target.workspaceId }).enabled).toBe(true);
    // Written at the TARGET scope, not globally.
    expect(policy.resolveScopes({ pluginKey: dependencyKey }, { workspaceId: target.workspaceId }))
      .toMatchObject({ workspace: 'enabled', global: 'unset' });
  });

  // "The success message lists what else was enabled along with the plugin you
  // named." (P6.628.) The service resolved that set already and DISCARDED it, so
  // no reader could say it without deriving it a second time. Reported on the
  // summary; `disable` never carries it, and neither does an enable that moved
  // nothing else — absent, not an empty array, so a caller cannot print an empty
  // list by accident.
  it('reports the transitive set it enabled, and only on enable', async () => {
    const { service, dependencyKey, dependentKey } = await installPair();

    const enabled = await service.enable(dependentKey, target);
    expect(enabled.enabledDependencies).toEqual([dependencyKey]);

    // The dependency itself depends on nothing, so its own enable says nothing.
    const leaf = await service.enable(dependencyKey, target);
    expect(leaf.enabledDependencies).toBeUndefined();

    const disabled = await service.disable(dependentKey, target);
    expect(disabled.enabledDependencies).toBeUndefined();
  });

  // `:162` — "Enable fails and prints the `claude plugin install` command for each
  // missing dependency."
  it('refuses the whole enable when a dependency is not installed', async () => {
    const { service, policy } = createService();
    const dependent = await service.install({ kind: 'local-path', path: createDependentBundle() });
    const dependentKey = dependent.installed?.pluginKey ?? '';

    await expect(service.enable(dependentKey, target)).rejects.toThrow(/dependency-not-installed:vault/);
    // Nothing was written: the refusal is of the whole operation.
    expect(policy.resolveScopes({ pluginKey: dependentKey }, { workspaceId: target.workspaceId }))
      .toMatchObject({ workspace: 'unset' });
  });

  // `:165` — "writes `true` for the plugin and each dependency that was not
  // already enabled at the target scope", which overwrites a same-scope `false`.
  //
  // `:164`'s higher-precedence refusal is deliberately NOT tested, because it is
  // not expressible here: precedence is narrowest-wins, and a workspace or global
  // target names no single narrower scope to read. See
  // `resolveTransitiveDependencies`.
  it('overwrites a same-scope disable of the dependency when enabling the dependent', async () => {
    const { service, policy, dependencyKey, dependentKey } = await installPair();
    await service.disable(dependencyKey, target);
    expect(policy.resolve({ pluginKey: dependencyKey }, { workspaceId: target.workspaceId }).enabled).toBe(false);

    await service.enable(dependentKey, target);

    expect(policy.resolve({ pluginKey: dependencyKey }, { workspaceId: target.workspaceId }).enabled).toBe(true);
  });

  // `:169`-`:176` — the refusal, its named dependents, and the chained command
  // that ends with the plugin the user asked about.
  it('refuses to disable a plugin an enabled plugin still depends on', async () => {
    const { service, policy, dependencyKey, dependentKey } = await installPair();
    await service.enable(dependentKey, target);

    await expect(service.disable(dependencyKey, target)).rejects.toThrow(
      new RegExp(`${dependencyKey} is still required by ${dependentKey}\\..*`
        + `disable everything together: nessy-general-agent plugin disable ${dependentKey}`
        + ` && nessy-general-agent plugin disable ${dependencyKey}`),
    );
    // Still enabled: a refused disable writes nothing.
    expect(policy.resolve({ pluginKey: dependencyKey }, { workspaceId: target.workspaceId }).enabled).toBe(true);

    // And once the dependent is off, the disable goes through.
    await service.disable(dependentKey, target);
    await service.disable(dependencyKey, target);
    expect(policy.resolve({ pluginKey: dependencyKey }, { workspaceId: target.workspaceId }).enabled).toBe(false);
  });

  it('carries the declared range and marketplace through install into the store', async () => {
    const { service, store } = createService();
    await service.install({ kind: 'local-path', path: createDependentBundle('~2.1.0') });
    const registry = await store.readInstalledRegistry();
    const entry = registry.plugins.find(plugin => plugin.pluginId === 'deploy-kit');
    expect(entry?.manifest.dependencies).toEqual([{ name: 'vault', version: '~2.1.0', versionRangeValid: true }]);
  });
});

function createService(options: {
  forceCompatibilityState?: PluginCompatibilityReport['state'];
  installer?: PluginInstallStager;
  dataLifecycle?: PluginDataLifecycle;
  runtimeDependencyInstaller?: PluginRuntimeDependencyInstaller;
} = {}): {
  service: PluginManagementServiceV2;
  store: PluginStoreV2;
  policy: CapabilityPolicyStore;
  trust: CapabilityTrustStore;
} {
  const store = new PluginStoreV2({ rootDirectory: join(dir, 'plugins') });
  const policy = new CapabilityPolicyStore({
    globalPath: join(dir, 'capabilities.json'),
    workspacePolicyPath: workspaceId => join(dir, 'workspaces', workspaceId, 'capabilities.json'),
    workspaceIds: () => existsSync(join(dir, 'workspaces')) ? readdirSync(join(dir, 'workspaces')) : [],
  });
  const trust = new CapabilityTrustStore({ path: join(dir, 'capability-trust.json') });
  const dataLifecycle = options.dataLifecycle ?? {
    onPluginUninstall: ({ pluginKey }) => removePluginData(pluginKey, join(dir, 'plugins', 'data')),
  } satisfies PluginDataLifecycle;
  const installer = options.installer ?? (options.forceCompatibilityState
    ? wrapWithForcedCompatibilityState(
        new PluginInstallService({
          fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
          baseTempDir: join(dir, 'staging'),
        }),
        options.forceCompatibilityState,
      )
    : undefined);
  return {
    store,
    policy,
    trust,
    service: installs.track(new PluginManagementServiceV2({
      store,
      policyStore: policy,
      trustStore: trust,
      fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
      baseTempDir: join(dir, 'staging'),
      ...(options.runtimeDependencyInstaller ? { runtimeDependencyInstaller: options.runtimeDependencyInstaller } : {}),
      ...(installer ? { installer } : {}),
      dataLifecycle,
      pluginDataDir: join(dir, 'plugins', 'data'),
    })),
  };
}

/** Test seam: force a real install's adapter compatibility report to a given state. */
function wrapWithForcedCompatibilityState(
  real: PluginInstallService,
  state: PluginCompatibilityReport['state'],
): PluginInstallStager {
  return {
    createInstallPlanFromSource: source => real.createInstallPlanFromSource(source),
    stageInstall: (plan, opts) => real.stageInstall(plan, opts),
    normalizeStagedInstall: async staged => {
      const normalized = await real.normalizeStagedInstall(staged);
      return {
        ...normalized,
        ...(normalized.compatibility ? { compatibility: { ...normalized.compatibility, state } } : {}),
      };
    },
  };
}

function createBundle(): string {
  const root = join(dir, 'source');
  mkdirSync(join(root, 'skills', 'review'), { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    id: 'toolkit',
    name: 'Toolkit',
    version: '1.0.0',
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
 * `plugins/host-marketplace.md#depend-on-and-recommend-other-plugins`'s case: the dependency ships
 * `defaultEnabled: false`, and a dependency requirement still writes an explicit
 * `true` for it.
 */
function createDependencyBundle(): string {
  const root = join(dir, 'dependency-source');
  mkdirSync(join(root, 'skills', 'guard'), { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    id: 'vault',
    name: 'Vault',
    version: '2.1.4',
    defaultEnabled: false,
    capabilities: [{
      kind: 'skill',
      id: 'guard',
      skill: { slug: 'guard', path: 'skills/guard/SKILL.md' },
    }],
  }));
  writeFileSync(join(root, 'skills', 'guard', 'SKILL.md'), '# Guard');
  return root;
}

/** `plugins/manifest-reference.md#dependencies`'s bundle plugin, optionally version-constrained. */
function createDependentBundle(dependencyRange?: string): string {
  const root = join(dir, `dependent-source-${dependencyRange ?? 'any'}`.replace(/[^a-zA-Z0-9-]/g, '_'));
  mkdirSync(join(root, 'skills', 'deploy'), { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    id: 'deploy-kit',
    name: 'Deploy Kit',
    version: '3.1.0',
    dependencies: [dependencyRange ? { name: 'vault', version: dependencyRange } : 'vault'],
    capabilities: [{
      kind: 'skill',
      id: 'deploy',
      skill: { slug: 'deploy', path: 'skills/deploy/SKILL.md' },
    }],
  }));
  writeFileSync(join(root, 'skills', 'deploy', 'SKILL.md'), '# Deploy');
  return root;
}

function createSettingsBundle(): string {
  const root = join(dir, 'settings-source');
  mkdirSync(join(root, 'skills', 'review'), { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    id: 'settings-toolkit',
    name: 'Settings Toolkit',
    version: '1.0.0',
    capabilities: [{
      kind: 'skill',
      id: 'review',
      skill: { slug: 'review', path: 'skills/review/SKILL.md' },
    }],
    nessyExtensions: {
      settings: [
        { key: 'theme', valueType: 'string', defaultValue: 'system' },
        { key: 'retries', valueType: 'number', required: true },
      ],
    },
  }));
  writeFileSync(join(root, 'skills', 'review', 'SKILL.md'), '# Review');
  return root;
}

function createUnsupportedNativeMcpBundle(): string {
  const root = join(dir, 'unsupported-native-mcp-source');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    id: 'unsupported-native-mcp',
    name: 'Unsupported Native MCP',
    version: '1.0.0',
    capabilities: [{
      kind: 'mcp',
      id: 'unavailable-deno',
      mcp: {
        serverName: 'unavailable-deno',
        transport: 'stdio',
        command: 'deno',
        args: ['run', 'server.ts'],
      },
    }],
  }));
  return root;
}

function createUnsupportedAppBundle(): string {
  const root = join(dir, 'unsupported-app-only');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    id: 'unsupported-app-only',
    name: 'Unsupported App Only',
    version: '1.0.0',
    apps: [{ id: 'unsupported-app', connectorId: 'missing-connector' }],
    capabilities: [{
      kind: 'unsupported',
      id: 'unsupported-runtime',
      unsupported: {
        externalKind: 'legacy-widget',
        reasonCode: 'plugin.compat.legacy_widget_unsupported',
        executable: false,
      },
    }],
  }));
  return root;
}

/**
 * A Codex bundle whose listing metadata the adapter drops (D3's measured case:
 * all 180 published manifests carry `keywords`, and every one drops its whole
 * `interface` block). It installs SUCCESSFULLY — that is the point.
 */
function createCodexListingBundle(): string {
  const root = join(dir, 'codex-listing-source');
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  mkdirSync(join(root, 'skills', 'triage'), { recursive: true });
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'linear',
    version: '0.0.3',
    skills: './skills/',
    repository: 'https://github.com/openai/plugins',
    license: 'MIT',
    keywords: ['issues'],
  }));
  writeFileSync(join(root, 'skills', 'triage', 'SKILL.md'), [
    '---',
    'name: triage',
    'description: Triage relevant issues.',
    '---',
    '',
    'Triage.',
  ].join('\n'));
  return root;
}

function createMixedHoneyBundle(): string {
  const root = join(dir, 'mixed-honey-source');
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'skills', 'honey'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'honey',
    version: '1.1.0',
    skills: './skills/',
    hooks: './hooks/hooks.json',
  }));
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'honey',
    version: '1.1.0',
  }));
  writeFileSync(join(root, 'skills', 'honey', 'SKILL.md'), [
    '---',
    'name: honey',
    'description: Minimal Honey compatibility fixture.',
    '---',
    '',
    '`node "${CLAUDE_PLUGIN_ROOT}/hooks/honey-state.js" set full`',
  ].join('\n'));
  writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({
    hooks: {
      SessionStart: [{
        hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/honey-session.js"' }],
      }],
    },
  }));
  writeFileSync(join(root, 'hooks', 'honey-session.js'), 'process.stdout.write("{}\\n");\n');
  writeFileSync(join(root, 'hooks', 'honey-state.js'), 'process.stdout.write("full\\n");\n');
  return root;
}

/**
 * C3 (capability-path): persist a PRE-C3 shaped entry directly through the
 * store — a manifest whose connector servers have NO capability twins, exactly
 * as every install written before the capability-path redirect looks on disk.
 * The normalization funnel can no longer produce this shape, and the connector
 * lifecycle exists only to serve it until the C5 deletion.
 */
async function installPersistedPreC3ConnectorEntry(
  store: PluginStoreV2,
  url = 'https://example.invalid/mcp',
  version = '0.9.0',
): Promise<{ pluginKey: string }> {
  const bundle = createConnectorBundle(url, `pre-c3-${version}`);
  const entry = await store.install({
    normalizedDirectory: bundle,
    manifest: {
      schemaVersion: 1,
      kind: 'plugin',
      id: 'gmail-toolkit',
      name: 'Gmail Toolkit',
      version,
      capabilities: [],
      apps: [{ id: 'gmail-app', connectorId: 'gmail' }],
      connectors: [{
        id: 'gmail',
        displayName: 'Gmail',
        mcpServers: [{ serverName: 'gmail-mcp', transport: 'http', url }],
        auth: { type: 'oauth', timing: 'ON_FIRST_USE' },
      }],
    },
    origin: { source: 'local-path', localPath: bundle, resolvedAt: 1 },
  });
  return { pluginKey: entry.pluginKey };
}

function createConnectorBundle(url = 'https://example.invalid/mcp', version = '1.0.0'): string {
  const root = join(dir, `connector-source-${version}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    id: 'gmail-toolkit',
    name: 'Gmail Toolkit',
    version,
    capabilities: [],
    apps: [{ id: 'gmail-app', connectorId: 'gmail' }],
    connectors: [{
      id: 'gmail',
      displayName: 'Gmail',
      mcpServers: [{ serverName: 'gmail-mcp', transport: 'http', url }],
      auth: { type: 'oauth', timing: 'ON_FIRST_USE' },
    }],
  }));
  return root;
}

function createCodexAppBundle(withSkill: boolean): string {
  const root = join(dir, withSkill ? 'codex-app-mixed' : 'codex-app-only');
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: withSkill ? 'figma-mixed' : 'figma-app-only',
    version: '2.0.16',
    apps: './.app.json',
    ...(withSkill ? { skills: './skills/' } : {}),
  }));
  writeFileSync(join(root, '.app.json'), JSON.stringify({
    apps: { figma: { id: 'connector_68df038e0ba48191908c8434991bbac2' } },
  }));
  if (withSkill) {
    mkdirSync(join(root, 'skills', 'figma-help'), { recursive: true });
    writeFileSync(join(root, 'skills', 'figma-help', 'SKILL.md'), [
      '---',
      'name: figma-help',
      'description: Explain Figma workflows.',
      '---',
      '',
      '# Figma Help',
    ].join('\n'));
  }
  return root;
}

function createCatalogRemoteMcpBundle(toolTimeoutSeconds?: number): string {
  const root = join(dir, toolTimeoutSeconds === undefined ? 'catalog-remote-mcp' : 'catalog-remote-mcp-timeout');
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'cloudflare',
    version: '0.1.2',
    mcpServers: './.mcp.json',
  }));
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({
    mcpServers: {
      'cloudflare-api': {
        type: 'http',
        url: 'https://mcp.cloudflare.com/mcp',
        note: 'Uses OAuth on first connection.',
        ...(toolTimeoutSeconds === undefined ? {} : { tool_timeout_sec: toolTimeoutSeconds }),
      },
    },
  }));
  return root;
}

/**
 * A catalog-authenticated remote MCP that CANNOT be promoted to OAuth: it
 * declares `env`, which the promoted connector cannot carry, so
 * `applyCatalogAuthentication` refuses the server rather than silently dropping
 * the field. This is the live producer of `externalKind:
 * 'catalog-authenticated-mcp'` (P2.182).
 */
function createUnpromotableCatalogMcpBundle(): string {
  const root = join(dir, 'catalog-remote-mcp-env');
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'cloudflare-env',
    version: '0.1.3',
    mcpServers: './.mcp.json',
  }));
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({
    mcpServers: {
      'cloudflare-api': {
        type: 'http',
        url: 'https://mcp.cloudflare.com/mcp',
        env: { CLOUDFLARE_REGION: 'eu' },
      },
    },
  }));
  return root;
}

function createExecutableBundle(id: string, dependencies: Record<string, string> = {}): string {
  const root = join(dir, `executable-${id}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    id: `executable-${id}`,
    name: `Executable ${id}`,
    version: '1.0.0',
    capabilities: [{
      kind: 'mcp',
      id: 'tools',
      mcp: { serverName: 'tools', transport: 'stdio', command: 'node', args: ['server.js'] },
    }],
  }));
  writeFileSync(join(root, 'server.js'), 'process.stdin.resume();\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: `executable-${id}`,
    version: '1.0.0',
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
  }));
  if (Object.keys(dependencies).length > 0) {
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
      name: `executable-${id}`,
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { name: `executable-${id}`, version: '1.0.0', dependencies } },
    }));
  }
  return root;
}

function createNpxBundle(packageSpec: string): string {
  const root = join(dir, 'npx-source');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    id: 'npx-toolkit',
    name: 'Npx Toolkit',
    version: '1.0.0',
    capabilities: [{
      kind: 'mcp',
      id: 'xcodebuildmcp',
      mcp: {
        serverName: 'xcodebuildmcp',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', packageSpec, 'mcp'],
      },
    }],
  }));
  return root;
}

function writeVendoredPackage(
  root: string,
  name: string,
  dependencies: Record<string, string> = {},
): void {
  const packageDirectory = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
  }));
}

function writeVendoredPackageWithBin(root: string, name: string): void {
  const packageDirectory = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(join(packageDirectory, 'bin'), { recursive: true });
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({
    name,
    version: '2.7.0',
    bin: { [name.split('/').pop()!]: 'bin/server.mjs' },
  }));
  writeFileSync(join(packageDirectory, 'bin', 'server.mjs'), 'process.stdin.resume();\n');
}

// F1.424 — every case here runs a REAL plugin-store install: a per-CASE budget, and a teardown that waits for every
// install still copying before it removes a root (`packages/shared/src/testing/install-tracker.ts` says why and what
// the tracker does not change). Placed last so no cited line moves: imports hoist, and bun applies a default set
// at module load to the cases registered above it (measured 2026-09-24).
import { MODULE_GRAPH_CASE_BUDGET_MS } from '../../testing/module-graph-budgets.ts';
import { createInstallTracker } from '../../testing/install-tracker.ts';
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS);
const installs = createInstallTracker();

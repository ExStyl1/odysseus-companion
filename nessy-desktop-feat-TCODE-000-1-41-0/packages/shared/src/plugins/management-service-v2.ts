import { rm } from 'node:fs/promises';
import type { CapabilityPolicyStore } from '../capabilities/policy-store.ts';
import type { CapabilityTrustStore } from '../capabilities/trust-store.ts';
import type { CredentialManager } from '../credentials/manager.ts';
import { PLUGIN_MCP_CREDENTIAL_TYPES } from '../credentials/types.ts';
import type { DpSessionBroker } from '../auth/dp/session-broker.ts';
import { isValidProjectKey } from '../projects/project-identity.ts';
import { assertStorageId, getPluginDataRoot } from '../workspaces/paths.ts';
import { resolvePluginDataPath } from './data-paths.ts';
import { derivePluginMcpAuthRequirements } from './auth-requirements.ts';
import { PluginInstallService } from './acquisition.ts';
import type { PluginArtifactAuthProvider, PluginRuntimeDependencyInstaller } from './install-types.ts';
import type {
  PluginActivationTarget,
  PluginInstallStager,
  PluginManagementApi,
  PluginManagementInstallOptions,
  PluginManagementInstallResult,
  PluginManagementInstalledSourceSummary,
  PluginManagementInstalledSummary,
  PluginManagementRepairOptions,
  PluginManagementStatusResult,
  PluginPruneOptions,
  PluginPruneRemoval,
  PluginPruneResult,
  PluginUninstallOptions,
  PluginUninstallResult,
} from './management-types.ts';
import { PluginMutationCommittedError } from './management-types.ts';
import { PluginSettings, PluginUserConfigStore } from './plugin-settings.ts';
import { toSafePluginPresentationOrigin } from './presentation.ts';
import { normalizeNessyPluginManifest, pluginDiagnostic } from './schema.ts';
import type { PluginInstalledEntryV2, PluginStoreV2 } from './store-v2.ts';
import {
  mergePluginConfiguration,
  pluginConfigurationStatus,
  readPluginConfiguration,
  resolvePluginConfigurationCapability,
  resolvePluginUserConfiguration,
  type PluginConfigurationStatus,
  type PluginConfigurationValue,
  type PluginUserConfiguration,
} from './mcpb-configuration.ts';
import type {
  PluginCompatibilityReport,
  PluginConnectorAuthTiming,
  PluginDiagnostic,
  PluginFormatAdapter,
  PluginInstallSource,
  PluginKey,
  PluginMarketplaceInstallMetadata,
  PluginOrigin,
  PluginCapability,
  PluginConnectorDescriptor,
  NessyPluginManifest,
  PluginSettingDescriptor,
  PluginUserConfigurationDescriptor,
} from './types.ts';

/** Host-owned cleanup for writable plugin state. Bundle paths never cross this boundary. */
export interface PluginDataLifecycle {
  onPluginUninstall(input: { pluginKey: PluginKey }): Promise<void> | void;
}

export interface PluginManagementServiceV2Options {
  store: PluginStoreV2;
  policyStore: CapabilityPolicyStore;
  trustStore: CapabilityTrustStore;
  installer?: PluginInstallStager;
  fetchImpl?: typeof fetch;
  artifactAuthProvider?: PluginArtifactAuthProvider;
  dpSessionBroker?: DpSessionBroker;
  runtimeDependencyInstaller?: PluginRuntimeDependencyInstaller;
  baseTempDir?: string;
  formatAdapters?: PluginFormatAdapter[];
  now?: () => number;
  /** Optional host-owned managed-data cleanup used by the production composition root. */
  dataLifecycle?: PluginDataLifecycle;
  /** Focused-test override; production uses the host-owned plugin data root. */
  pluginDataDir?: string;
  /** Existing encrypted credential boundary used for workspace plugin configuration. */
  credentialManager?: Pick<CredentialManager, 'get' | 'set' | 'delete' | 'list'>;
}

/** Runtime-owned v2 plugin mutation boundary. Installation and activation are separate. */
export class PluginManagementServiceV2 implements PluginManagementApi {
  private readonly store: PluginStoreV2;
  private readonly policyStore: CapabilityPolicyStore;
  private readonly trustStore: CapabilityTrustStore;
  private readonly installer: PluginInstallStager;
  private readonly baseTempDir?: string;
  private readonly dataLifecycle?: PluginDataLifecycle;
  private readonly pluginDataDir?: string;
  private readonly credentialManager?: Pick<CredentialManager, 'get' | 'set' | 'delete' | 'list'>;

  constructor(options: PluginManagementServiceV2Options) {
    this.store = options.store;
    this.policyStore = options.policyStore;
    this.trustStore = options.trustStore;
    this.baseTempDir = options.baseTempDir;
    this.dataLifecycle = options.dataLifecycle;
    this.pluginDataDir = options.pluginDataDir;
    this.credentialManager = options.credentialManager;
    this.installer = options.installer ?? new PluginInstallService({
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.artifactAuthProvider ? { artifactAuthProvider: options.artifactAuthProvider } : {}),
      ...(options.dpSessionBroker ? { dpSessionBroker: options.dpSessionBroker } : {}),
      ...(options.runtimeDependencyInstaller ? { runtimeDependencyInstaller: options.runtimeDependencyInstaller } : {}),
      ...(options.baseTempDir ? { baseTempDir: options.baseTempDir } : {}),
      ...(options.formatAdapters ? { formatAdapters: options.formatAdapters } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  async status(): Promise<PluginManagementStatusResult> {
    const registry = await this.store.readInstalledRegistry();
    const installed = Object.entries(registry.active)
      .map(([pluginKey, instanceId]) => registry.plugins.find(entry => (
        entry.pluginKey === pluginKey && entry.pluginInstanceId === instanceId
      )))
      .filter((entry): entry is PluginInstalledEntryV2 => entry !== undefined)
      .map(entry => summarizeInstalled(entry))
      .sort((a, b) => a.pluginKey.localeCompare(b.pluginKey));
    return {
      installed,
      diagnostics: installed.flatMap(entry => entry.diagnostics),
    };
  }

  install(
    source: PluginInstallSource,
    options: PluginManagementInstallOptions = {},
  ): Promise<PluginManagementInstallResult> {
    return this.withMutation(() => this.installUnlocked(source, options));
  }

  private async installUnlocked(
    source: PluginInstallSource,
    options: PluginManagementInstallOptions,
  ): Promise<PluginManagementInstallResult> {
    if (options.activateIn) validateActivationTarget(options.activateIn);
    const materialized = await this.materialize(source, options.baseTempDir);
    if (!materialized.ok) return materialized.result;
    const { staged, diagnostics, compatibility } = materialized;
    const manifest = applyCatalogAuthentication(materialized.manifest, options.connectorAuthTiming);
    // T6 (plugin-install plan): the catalog listing said one version, the
    // bundle another — say so instead of silently installing whichever the
    // artifact carried. Info only: version skew between a marketplace index
    // and a registry artifact is common and never blocks.
    const listingVersion = stringValue(staged.plan.origin.provenance?.version);
    if (listingVersion && listingVersion !== manifest.version) {
      diagnostics.push(pluginDiagnostic(
        'info',
        'plugin.install.version_mismatch',
        `Marketplace listing version ${listingVersion} differs from the installed bundle version ${manifest.version}.`,
        undefined,
        { listingVersion, bundleVersion: manifest.version },
      ));
    }
    try {
      // Blocked: the adapter's own compatibility report says this bundle
      // cannot run. Never commit it to the cache; the caller never asked for
      // enough context (activation, etc.) to matter.
      if (compatibility?.state === 'blocked') {
        return { ok: false, diagnostics, compatibility };
      }
      if (isUnresolvedAppOnly(manifest)) {
        return unresolvedAppOnly(diagnostics, compatibility);
      }
      const installed = await this.store.install({
        normalizedDirectory: staged.normalizedDirectory,
        manifest,
        origin: applyCatalogAuthenticationOrigin(
          staged.plan.origin,
          options.connectorAuthTiming,
          options.catalogAuthenticationPolicy,
        ),
        ...(compatibility ? { compatibility } : {}),
        // P6.557 — provenance, written only where the distinction is known.
        ...(options.autoInstalled ? { autoInstalled: true } : {}),
      });
      // Installation is the consent boundary. A partial compatibility report
      // disables only deferred capabilities; the supported subset activates in
      // the requested scope without a second confirmation step. (C5: connector
      // servers ride the capability path — there is no Source materialization
      // step left to fail after the registry commit.)
      //
      // `defaultEnabled` (P6.386). `plugins-reference.md` § Default enablement —
      // "Set `defaultEnabled: false` in `plugin.json` to ship a plugin that
      // installs disabled. The user turns it on with `claude plugin enable
      // <plugin>` or the `/plugin` interface." The field has been parsed,
      // precedence-resolved (the marketplace entry over the bundle,
      // `format-adapters/claude.ts`) and stored on the manifest for months, and
      // NOTHING read it: this call site activated unconditionally, so an opt-in
      // plugin installed enabled and started contributing components the user
      // never asked for.
      //
      // The page names exactly one precedence that survives here: "when a plugin
      // is required by another one that is active, Claude Code writes `true` for
      // it at install or enable time. That gives it an explicit setting, so its
      // own default no longer applies." That is the dependency-acquisition path
      // (`marketplace/service.ts`'s `acquireDependencies`, which installs each
      // dependency AFTER the root is committed and enabled), and it is honoured
      // by asking the page's own question — is this plugin required by an
      // ENABLED active plugin at this target — rather than by a flag the caller
      // has to remember to set.
      //
      // The page's other precedence, "an entry for the plugin in `enabledPlugins`
      // at any settings scope … persists across plugin updates and reinstalls",
      // has no subject on a FIRST install and is left to `enableUnlocked`, which
      // writes the explicit `true` that outranks this default and is unchanged.
      const installsDisabled = manifest.defaultEnabled === false
        && (await this.enabledDependentsOf(installed, options.activateIn)).length === 0;
      if (options.activateIn && !installsDisabled) {
        this.setActivation(installed.pluginKey, options.activateIn, true);
      }
      if (installsDisabled) {
        diagnostics.push(pluginDiagnostic(
          'info',
          'plugin.install.default_disabled',
          `Plugin ${manifest.name} declares defaultEnabled: false and was installed disabled. `
          + 'Enable it to load its components.',
          undefined,
          { pluginName: manifest.name },
        ));
      }
      // T2 (plugin-install plan): install-with-activation is an enable, so it
      // raises the same enable-time truths the separate enable RPC does —
      // `plugins/components.md#when-the-configuration-dialog-appears`'s userConfig prompt used to fire only on
      // that second RPC, leaving config-needing servers silently parked at
      // `user-config-missing` after a one-step install.
      //
      // ...and an install that did NOT enable raises none of them: `:543` scopes
      // the prompt to "when the plugin is enabled", so a plugin parked at its own
      // `defaultEnabled: false` must not ask for credentials it will not use.
      const configuration = options.activateIn && !installsDisabled
        ? await this.enableTimeConfiguration(installed, options.activateIn)
        : undefined;
      return {
        ok: true,
        installed: {
          ...summarizeInstalled(installed),
          ...(configuration ? { configuration } : {}),
        },
        diagnostics,
        ...(compatibility ? { compatibility } : {}),
      };
    } finally {
      await rm(staged.stageDirectory, { recursive: true, force: true });
    }
  }

  enable(pluginKey: PluginKey, target: PluginActivationTarget): Promise<PluginManagementInstalledSummary> {
    return this.withMutation(() => this.enableUnlocked(pluginKey, target));
  }

  private async enableUnlocked(pluginKey: PluginKey, target: PluginActivationTarget): Promise<PluginManagementInstalledSummary> {
    const installed = await this.findActive(pluginKey);
    validateActivationTarget(target);
    // `plugins/host-marketplace.md#depend-on-and-recommend-other-plugins` — "When you enable a plugin, Claude Code also
    // enables its dependencies at the same scope. If a dependency has its own
    // dependencies, Claude Code enables those too." `:165` — it "writes `true`
    // for the plugin and each dependency that was not already enabled at the
    // target scope", and `:167` says that explicit `true` outranks a dependency's
    // own `defaultEnabled: false`, which is exactly what `setActivation` writes.
    //
    // Resolved BEFORE the plugin itself is enabled, because `:162`-`:164` make
    // every failure a refusal of the whole operation: "Enable fails" leaves
    // nothing written.
    const transitive = await this.resolveTransitiveDependencies(installed, target);
    this.setActivation(pluginKey, target, true);
    for (const dependency of transitive) {
      this.setActivation(dependency.pluginKey, target, true);
    }
    // `plugins/components.md#when-the-configuration-dialog-appears` — "The `userConfig` field declares values that
    // Claude Code prompts the user for when the plugin is enabled." The prompt
    // is the caller's to raise; what this returns is the value-free status that
    // says whether there is anything to ask about. Read AFTER the activation is
    // written, so a caller that dismisses the prompt still has an enabled plugin
    // whose affected capabilities carry `user-config-missing` — an explainable
    // state, not a half-enabled one.
    const configuration = await this.enableTimeConfiguration(installed, target);
    // `plugin-dependencies.md` § *Enable or disable a plugin with dependencies*
    // — "The success message lists what else was enabled along with the plugin
    // you named." The set was already resolved above and was DISCARDED, so no
    // caller could say it without deriving it a second time. Reported here, once,
    // for every reader; see `PluginManagementInstalledSummary.enabledDependencies`
    // for why it is the whole transitive set rather than only the values that
    // changed.
    return {
      ...summarizeInstalled(installed),
      ...(configuration ? { configuration } : {}),
      ...(transitive.length > 0
        ? { enabledDependencies: transitive.map(dependency => dependency.pluginKey) }
        : {}),
    };
  }

  /**
   * The enable-time configuration status, or undefined when there is nothing to
   * ask about.
   *
   * Fail-soft in both directions: a global-scope target has no workspace to read
   * a credential against, and a host with no credential manager cannot answer
   * either. Neither is a reason to fail an enable that has already been written.
   */
  private async enableTimeConfiguration(
    installed: PluginInstalledEntryV2,
    target: PluginActivationTarget,
  ): Promise<PluginConfigurationStatus | undefined> {
    if (target.kind === 'global') return undefined;
    try {
      const status = await this.configurationStatus(installed.pluginKey, target.workspaceId);
      return status.state === 'not-required' ? undefined : status;
    } catch {
      return undefined;
    }
  }

  disable(pluginKey: PluginKey, target: PluginActivationTarget): Promise<PluginManagementInstalledSummary> {
    return this.withMutation(() => this.disableUnlocked(pluginKey, target));
  }

  private async disableUnlocked(pluginKey: PluginKey, target: PluginActivationTarget): Promise<PluginManagementInstalledSummary> {
    const installed = await this.findActive(pluginKey);
    validateActivationTarget(target);
    // `plugins/host-marketplace.md#depend-on-and-recommend-other-plugins` — "When you disable a plugin, Claude Code
    // refuses if another enabled plugin still depends on it. The error names the
    // plugins that depend on it and gives you a chained command that disables
    // them in the right order, ending with the one you asked for."
    await this.assertNoEnabledDependents(installed, target);
    this.setActivation(pluginKey, target, false);
    return summarizeInstalled(installed);
  }

  /**
   * Flip ONE capability of an installed plugin at a scope. Persists a
   * capabilityId-scoped policy record — a pure per-capability toggle that never
   * activates or suppresses the plugin itself (see CapabilityPolicyStore.resolve).
   */
  setCapabilityEnabled(
    pluginKey: PluginKey,
    target: PluginActivationTarget,
    capabilityId: string,
    enabled: boolean,
  ): Promise<PluginManagementInstalledSummary> {
    return this.withMutation(() => this.setCapabilityEnabledUnlocked(
      pluginKey,
      target,
      capabilityId,
      enabled,
    ));
  }

  private async setCapabilityEnabledUnlocked(
    pluginKey: PluginKey,
    target: PluginActivationTarget,
    capabilityId: string,
    enabled: boolean,
  ): Promise<PluginManagementInstalledSummary> {
    const installed = await this.findActive(pluginKey);
    validateActivationTarget(target);
    if (target.kind === 'project' && installed.manifest.apps?.some(app => app.id === capabilityId)) {
      throw new Error('plugin.manage.connector-project-scope-unavailable');
    }
    // Only manifest-declared ids may persist a record — a safe-boundary caller
    // must not be able to grow capabilities.json with unbounded junk keys.
    const validIds = new Set<string>([
      ...installed.manifest.capabilities.map(capability => capability.id),
      ...(installed.manifest.apps ?? []).map(app => app.id),
      ...(installed.manifest.nessyExtensions?.settings ?? []).map(setting => setting.key),
      ...(installed.manifest.nessyExtensions?.commands ?? []).map(command => command.command),
      ...(installed.manifest.nessyExtensions?.assets ?? []).map(asset => asset.path),
    ]);
    if (!validIds.has(capabilityId)) throw new Error('plugin.manage.unknown-capability');
    const record = { pluginKey, capabilityId, enabled };
    switch (target.kind) {
      case 'global':
        this.policyStore.recordGlobal(record);
        break;
      case 'workspace':
        this.policyStore.recordWorkspace(target.workspaceId, record);
        break;
      case 'project':
        this.policyStore.recordProjectOverride(target.workspaceId, target.projectKey, record);
    }
    return summarizeInstalled(installed);
  }

  async configurationStatus(pluginKey: PluginKey, workspaceId: string): Promise<PluginConfigurationStatus> {
    assertStorageId('workspace', workspaceId);
    const installed = await this.findActive(pluginKey);
    const configuration = resolvePluginConfigurationCapability(installed, workspaceId);
    const settings = this.resolvePluginSettings(installed, workspaceId, configuration?.fields);
    const userConfig = this.resolvePluginUserConfig(installed, workspaceId);
    if (!configuration && !settings && !userConfig) return { state: 'not-required', fields: [] };
    const fields = combinePluginConfigurationFields(
      configuration?.fields ?? [],
      settings?.fields ?? [],
      userConfig?.configuration.fields ?? [],
    );
    const configurationValues = configuration
      ? readPluginConfiguration(
          await this.requireCredentialManager().get(configuration.credentialId),
          configuration.fields,
        )
      : {};
    const settingValues = settings ? await settings.owner.readOverrides() : {};
    const userConfigValues = userConfig ? await this.readPluginUserConfigValues(userConfig) : {};
    return pluginConfigurationStatus(fields, { ...configurationValues, ...settingValues, ...userConfigValues });
  }

  configure(
    pluginKey: PluginKey,
    workspaceId: string,
    values: Record<string, unknown>,
  ): Promise<PluginConfigurationStatus> {
    return this.withMutation(async () => {
      assertStorageId('workspace', workspaceId);
      const installed = await this.findActive(pluginKey);
      const configuration = resolvePluginConfigurationCapability(installed, workspaceId);
      const settings = this.resolvePluginSettings(installed, workspaceId, configuration?.fields);
      const userConfig = this.resolvePluginUserConfig(installed, workspaceId);
      if (!configuration && !settings && !userConfig) throw new Error('plugin.configuration.not-required');
      const fields = combinePluginConfigurationFields(
        configuration?.fields ?? [],
        settings?.fields ?? [],
        userConfig?.configuration.fields ?? [],
      );
      const credentials = configuration || userConfig?.configuration.sensitiveFields.length
        ? this.requireCredentialManager()
        : undefined;
      const currentConfiguration = configuration && credentials
        ? readPluginConfiguration(await credentials.get(configuration.credentialId), configuration.fields)
        : {};
      const currentSettings = settings ? await settings.owner.readOverrides() : {};
      const currentUserConfig = userConfig ? await this.readPluginUserConfigValues(userConfig) : {};
      const merged = mergePluginConfiguration(
        fields,
        { ...currentConfiguration, ...currentSettings, ...currentUserConfig },
        values,
      );

      if (configuration && credentials) {
        const keys = new Set(configuration.fields.map(field => field.key));
        const next = selectPluginConfigurationValues(merged, keys);
        if (Object.keys(next).length === 0) await credentials.delete(configuration.credentialId);
        else await credentials.set(configuration.credentialId, { value: JSON.stringify(next) });
      }
      if (settings) {
        const keys = new Set(settings.fields.map(field => field.key));
        const next = selectPluginConfigurationValues(merged, keys);
        if (Object.keys(next).length === 0) await settings.owner.clear();
        else await settings.owner.write(next);
      }
      if (userConfig) {
        // `:591`/`:589` — the sensitive half goes to the credential manager, the
        // rest to the user-scoped option file. Written as two disjoint key sets
        // so a sensitive value can never reach the plaintext file even if a
        // descriptor list is later reordered.
        const sensitiveKeys = new Set(userConfig.configuration.sensitiveFields.map(field => field.key));
        const plainKeys = new Set(userConfig.configuration.plainFields.map(field => field.key));
        const nextSensitive = selectPluginConfigurationValues(merged, sensitiveKeys);
        const nextPlain = selectPluginConfigurationValues(merged, plainKeys);
        if (sensitiveKeys.size > 0 && credentials) {
          if (Object.keys(nextSensitive).length === 0) {
            await credentials.delete(userConfig.configuration.credentialId);
          } else {
            await credentials.set(userConfig.configuration.credentialId, {
              value: JSON.stringify(nextSensitive),
            });
          }
        }
        if (userConfig.store) {
          if (Object.keys(nextPlain).length === 0) await userConfig.store.clear();
          else await userConfig.store.write(nextPlain);
        }
      }
      return pluginConfigurationStatus(fields, merged);
    });
  }

  clearConfiguration(pluginKey: PluginKey, workspaceId: string): Promise<PluginConfigurationStatus> {
    return this.withMutation(async () => {
      assertStorageId('workspace', workspaceId);
      const installed = await this.findActive(pluginKey);
      const configuration = resolvePluginConfigurationCapability(installed, workspaceId);
      const settings = this.resolvePluginSettings(installed, workspaceId, configuration?.fields);
      const userConfig = this.resolvePluginUserConfig(installed, workspaceId);
      if (!configuration && !settings && !userConfig) return { state: 'not-required', fields: [] };
      if (configuration) await this.requireCredentialManager().delete(configuration.credentialId);
      if (settings) await settings.owner.clear();
      if (userConfig) {
        if (userConfig.configuration.sensitiveFields.length > 0) {
          await this.requireCredentialManager().delete(userConfig.configuration.credentialId);
        }
        if (userConfig.store) await userConfig.store.clear();
      }
      return pluginConfigurationStatus(combinePluginConfigurationFields(
        configuration?.fields ?? [],
        settings?.fields ?? [],
        userConfig?.configuration.fields ?? [],
      ), {});
    });
  }

  /**
   * Plugin-level `userConfig` (B1b). `store` is absent when every declared
   * option is sensitive, in which case nothing is written outside the credential
   * manager at all.
   */
  private resolvePluginUserConfig(
    installed: PluginInstalledEntryV2,
    workspaceId: string,
  ): { configuration: PluginUserConfiguration; store?: PluginUserConfigStore } | undefined {
    const configuration = resolvePluginUserConfiguration(installed, workspaceId);
    if (!configuration) return undefined;
    if (configuration.plainFields.length === 0) return { configuration };
    return {
      configuration,
      store: new PluginUserConfigStore({
        // The data path is derived from the validated plugin key and the
        // host-owned data root only. No workspace file, no project root: the
        // values a cloned repository could plant have no path in.
        dataPath: resolvePluginDataPath(installed.pluginKey, { workspaceId }, this.pluginDataDir),
        pluginInstanceId: installed.pluginInstanceId,
        descriptors: configuration.plainFields,
      }),
    };
  }

  private async readPluginUserConfigValues(
    userConfig: { configuration: PluginUserConfiguration; store?: PluginUserConfigStore },
  ): Promise<Record<string, PluginConfigurationValue>> {
    const sensitive = userConfig.configuration.sensitiveFields.length > 0
      ? readPluginConfiguration(
          await this.requireCredentialManager().get(userConfig.configuration.credentialId),
          userConfig.configuration.sensitiveFields,
        )
      : {};
    const plain = userConfig.store ? await userConfig.store.read() : {};
    return { ...sensitive, ...plain };
  }

  private resolvePluginSettings(
    installed: PluginInstalledEntryV2,
    workspaceId: string,
    configurationFields: readonly PluginUserConfigurationDescriptor[] = [],
  ): { fields: PluginSettingDescriptor[]; owner: PluginSettings } | undefined {
    // MCPB mirrors public user_config fields into settings for inventory. The
    // server-bound configuration remains their sole storage/injection owner.
    const configurationKeys = new Set(configurationFields.map(field => field.key));
    const fields = (installed.manifest.nessyExtensions?.settings ?? [])
      .filter(field => !configurationKeys.has(field.key));
    if (fields.length === 0) return undefined;
    return {
      fields,
      owner: new PluginSettings({
        dataPath: resolvePluginDataPath(
          installed.pluginKey,
          { workspaceId },
          this.pluginDataDir,
        ),
        pluginInstanceId: installed.pluginInstanceId,
        descriptors: fields,
      }),
    };
  }

  repair(
    pluginKey: PluginKey,
    options: PluginManagementRepairOptions = {},
  ): Promise<PluginManagementInstallResult> {
    return this.withMutation(() => this.repairUnlocked(pluginKey, options));
  }

  private async repairUnlocked(
    pluginKey: PluginKey,
    options: PluginManagementRepairOptions,
  ): Promise<PluginManagementInstallResult> {
    const installed = await this.findActive(pluginKey);
    const source = options.source ?? reconstructInstallSource(installed);
    if (!source) {
      return {
        ok: false,
        diagnostics: [pluginDiagnostic(
          'error',
          'plugin.repair.source_unavailable',
          'The installed plugin has no reusable repair source.',
        )],
      };
    }
    const materialized = await this.materialize(source, options.baseTempDir);
    if (!materialized.ok) return materialized.result;
    const { staged, diagnostics, compatibility } = materialized;
    const connectorAuthTiming = readConnectorAuthTiming(installed.origin.provenance?.connectorAuthTiming);
    const catalogAuthenticationPolicy = stringValue(installed.origin.provenance?.catalogAuthenticationPolicy);
    const manifest = applyCatalogAuthentication(materialized.manifest, connectorAuthTiming);
    try {
      if (compatibility?.state === 'blocked') {
        return { ok: false, diagnostics, compatibility };
      }
      if (isUnresolvedAppOnly(manifest)) {
        return unresolvedAppOnly(diagnostics, compatibility);
      }
      // Revoke every durable activation grant before a partial bundle can
      // become active in the registry. This ordering is intentionally
      // fail-closed: if policy persistence or the subsequent repair fails, the
      // previously installed instance may remain selected, but no new partial
      // instance can inherit its pluginKey-scoped authority.
      if (compatibility?.state === 'partial') {
        this.policyStore.purgePlugin(pluginKey, [installed.pluginInstanceId]);
      }
      const repaired = await this.store.repair(installed.pluginInstanceId, {
        normalizedDirectory: staged.normalizedDirectory,
        manifest,
        origin: applyCatalogAuthenticationOrigin(
          staged.plan.origin,
          connectorAuthTiming,
          catalogAuthenticationPolicy,
        ),
        marketplaceId: installed.marketplaceId,
        ...(compatibility ? { compatibility } : {}),
        // P6.557 — an UPDATE must not launder provenance: a repaired or updated
        // dependency is still a dependency. The same-hash branch of
        // `store.repair` preserves it by spreading the current entry; the
        // different-hash branch re-installs, and that is the branch this feeds.
        ...(installed.autoInstalled ? { autoInstalled: true } : {}),
      });
      return {
        ok: true,
        installed: summarizeInstalled(repaired),
        diagnostics,
        ...(compatibility ? { compatibility } : {}),
        ...(compatibility?.state === 'partial' ? { requiresConfirmation: true } : {}),
      };
    } finally {
      await rm(staged.stageDirectory, { recursive: true, force: true });
    }
  }

  /**
   * `plugins/loading.md#when-auto-update-runs` — "updates installed plugins to their latest
   * versions on disk."
   *
   * Shares {@link repair}'s mechanism deliberately: re-materialize a source and
   * swap the bundle under the same pluginKey, with the same fail-closed grant
   * revocation. What makes it an UPDATE rather than a repair is which source the
   * caller hands it — `options.source` from the marketplace's CURRENT catalog
   * row (see `MarketplaceService.updateInstalledBundles`) instead of the pinned
   * origin `repair` reconstructs.
   *
   * Called with no `source`, it therefore re-fetches the version that is already
   * installed. That is a real limit and it is the caller's to fix: this service
   * holds no catalog and must not grow one, because the catalog's allowlist
   * gates live on the registry controller.
   */
  update(pluginKey: PluginKey, options: PluginManagementRepairOptions = {}): Promise<PluginManagementInstallResult> {
    return this.repair(pluginKey, options);
  }

  /**
   * P6.437 — `plugins/components.md#path-variables-and-persistent-data`, verbatim: *"The
   * CLI deletes by default; pass `--keep-data` to preserve it."* Delete-by-
   * default is the page's posture and stays ours; `keepData` is the documented
   * opt-out that this fork did not have.
   *
   * The retention is expressed by NOT calling the host's data lifecycle, rather
   * than by teaching that port a second mode: the port's whole contract is
   * "remove this plugin's writable state", and a `keepData` argument on it would
   * be a delete call that sometimes does not delete.
   */
  uninstall(pluginKey: PluginKey, options: PluginUninstallOptions = {}): Promise<PluginUninstallResult> {
    return this.withMutation(() => this.uninstallUnlocked(pluginKey, options));
  }

  private async uninstallUnlocked(
    pluginKey: PluginKey,
    options: PluginUninstallOptions,
  ): Promise<PluginUninstallResult> {
    assertPluginKey(pluginKey);
    const registry = await this.store.readInstalledRegistry();
    const pluginInstanceIds = registry.plugins
      .filter(entry => entry.pluginKey === pluginKey)
      .map(entry => entry.pluginInstanceId);
    // Managed activation and executable trust are consent, not plugin data.
    // Purge them before any external cleanup or cache mutation so a partial
    // uninstall can only fail closed. Reinstalling identical bytes therefore
    // starts disabled and review-required.
    this.policyStore.purgePlugin(pluginKey, pluginInstanceIds);
    try {
      this.trustStore.purgePluginInstances(pluginInstanceIds);
      if (pluginInstanceIds.length > 0 && !options.keepData) {
        await this.dataLifecycle?.onPluginUninstall({ pluginKey });
      }
      if (this.credentialManager) {
        const ids = await this.credentialManager.list({ type: 'source_apikey' });
        await Promise.all(ids
          .filter(id => id.sourceId?.startsWith(`mcpb:${pluginKey}:`))
          .map(id => this.credentialManager!.delete(id)));
        // C2 (capability-path ADR § 2): plugin MCP server slots die with the
        // plugin. Enumerated from the store, not the manifest, so rows from
        // renamed/removed servers of older versions die too.
        for (const type of PLUGIN_MCP_CREDENTIAL_TYPES) {
          const rows = await this.credentialManager.list({ type });
          await Promise.all(rows
            .filter(id => id.pluginKey === pluginKey)
            .map(id => this.credentialManager!.delete(id)));
        }
      }
      await this.store.uninstall(pluginKey);
    } catch (error) {
      throw new PluginMutationCommittedError('uninstall', pluginKey, error);
    }
    // Reported only when something was actually retained. The path is the
    // version-LESS stable root `data-paths.ts` documents ("Because the plugin
    // key omits the version, data survives version updates"), which is exactly
    // what a reinstall at a new version finds again — the invariant the page
    // gives as the reason for the flag.
    return options.keepData && pluginInstanceIds.length > 0
      ? { keptDataPath: getPluginDataRoot(pluginKey, this.pluginDataDir) }
      : {};
  }

  refresh(): Promise<PluginManagementStatusResult> {
    return this.withMutation(async () => {
      await this.store.prune();
      return this.status();
    });
  }

  /**
   * P6.557 — `plugins/cli-reference.md#plugin-prune`: *"Remove auto-installed plugin
   * dependencies that are no longer required by any installed plugin.
   * Dependencies that Claude Code pulled in to satisfy another plugin's
   * `dependencies` field are removed; plugins you installed directly are never
   * touched."*
   *
   * **Named `pruneDependencies`, not `prune`, deliberately.** `PluginStoreV2`
   * already has a `prune()` and it is a DIFFERENT sweep — inactive instances,
   * leases and superseded versions — which `refresh()` above calls. Two methods
   * one word apart doing unrelated things is how a caller reaches for the wrong
   * one; the user-facing verb stays the page's `prune`.
   *
   * Iterated to a FIXED POINT rather than filtered once: removing an orphan can
   * orphan the dependencies it alone required, and the page's "no longer
   * required by any installed plugin" is a property of the FINAL set, not of the
   * starting one. Each pass removes one plugin, so it terminates.
   *
   * An entry with no provenance bit — every plugin installed before P6.557 — is
   * read as user-installed. That default can only make prune skip something; the
   * opposite default could delete a plugin the user chose.
   */
  pruneDependencies(options: PluginPruneOptions = {}): Promise<PluginPruneResult> {
    return this.withMutation(async () => {
      const active = await this.activeInstalledPlugins();
      const removed: PluginPruneRemoval[] = [];
      let remaining = active;
      for (;;) {
        const orphan = remaining.find(entry => entry.autoInstalled === true
          && !remaining.some(other => declaresAsDependency(other, entry)));
        if (!orphan) break;
        removed.push({
          pluginKey: orphan.pluginKey,
          name: orphan.manifest.name,
          marketplaceId: orphan.marketplaceId,
        });
        remaining = remaining.filter(entry => entry.pluginKey !== orphan.pluginKey);
      }
      const kept = remaining
        .filter(entry => entry.autoInstalled === true)
        .map(entry => ({
          pluginKey: entry.pluginKey,
          requiredBy: remaining
            .filter(other => declaresAsDependency(other, entry))
            .map(other => other.pluginKey)
            .sort(),
        }));
      if (!options.dryRun) {
        // Through the same uninstall the user's own gesture takes, so a pruned
        // dependency loses its consent records, credentials and writable data
        // exactly as an explicit uninstall does. `uninstallUnlocked` because
        // this method already holds the mutation lock.
        for (const entry of removed) await this.uninstallUnlocked(entry.pluginKey, {});
      }
      return {
        removed,
        kept,
        userInstalledCount: active.filter(entry => entry.autoInstalled !== true).length,
        dryRun: options.dryRun === true,
      };
    });
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.trustStore.runExclusive(operation);
  }

  private async findActive(pluginKey: PluginKey): Promise<PluginInstalledEntryV2> {
    assertPluginKey(pluginKey);
    const registry = await this.store.readInstalledRegistry();
    const instanceId = registry.active[pluginKey];
    const installed = instanceId
      ? registry.plugins.find(entry => entry.pluginInstanceId === instanceId && entry.pluginKey === pluginKey)
      : undefined;
    if (!installed) throw new Error('plugin.manage.not-installed');
    return installed;
  }

  private requireCredentialManager(): Pick<CredentialManager, 'get' | 'set' | 'delete' | 'list'> {
    if (!this.credentialManager) throw new Error('plugin.configuration.runtime-unavailable');
    return this.credentialManager;
  }

  /**
   * Every active installed plugin, keyed by plugin key. One registry read shared
   * by both dependency passes, so an enable and its refusal check can never
   * disagree about what is installed.
   */
  private async activeInstalledPlugins(): Promise<PluginInstalledEntryV2[]> {
    const registry = await this.store.readInstalledRegistry();
    return Object.entries(registry.active)
      .map(([pluginKey, instanceId]) => registry.plugins.find(entry => (
        entry.pluginKey === pluginKey && entry.pluginInstanceId === instanceId
      )))
      .filter((entry): entry is PluginInstalledEntryV2 => entry !== undefined);
  }

  /**
   * The transitive closure of `installed`'s dependencies, refusing before it
   * writes anything (`plugins/host-marketplace.md#depend-on-and-recommend-other-plugins`).
   *
   * Three of the table's four rows are enforceable here:
   *
   * - `:162` "A dependency is not installed" → `plugin.manage.dependency-not-installed`,
   *   naming each missing dependency so the caller can print the install command.
   * - `:165` "All dependencies are installed and allowed" → the caller writes
   *   `true` for each, at the target scope, overwriting a same-scope `false`
   *   ("writes `true` for … each dependency that was not already enabled at the
   *   target scope").
   *
   * Two rows are recorded rather than enforced, both because the input is not
   * here:
   *
   * - `:163`'s organization plugin policy is a managed-policy read that lives in
   *   `server-core`'s resolution inputs, not in this store-only service.
   * - `:164`'s "set to `false` at a scope with higher precedence than the target
   *   scope" is not expressible in Nessy's scope model. Precedence is
   *   narrowest-wins, so only a NARROWER scope can outrank the target — and a
   *   global or workspace target names no single narrower scope to read. Claude
   *   has one active workspace and project; we have many, and a check that picked
   *   one would refuse an enable that is legal in every other. The load-time gate
   *   in `resolvePluginDependencyErrors` still reports the resulting
   *   `dependency-unsatisfied` inside the scope where it actually applies, which
   *   is the outcome `:156` describes for versions before the enable-time check
   *   existed.
   */
  private async resolveTransitiveDependencies(
    installed: PluginInstalledEntryV2,
    target: PluginActivationTarget,
  ): Promise<PluginInstalledEntryV2[]> {
    if ((installed.manifest.dependencies?.length ?? 0) === 0) return [];
    const active = await this.activeInstalledPlugins();
    const find = (name: string, marketplaceId: string) => active.find(entry => (
      entry.marketplaceId === marketplaceId
      && (entry.pluginId === name || entry.manifest.name === name)
    ));
    const resolved = new Map<PluginKey, PluginInstalledEntryV2>();
    const missing: string[] = [];
    const queue = [installed];
    const visited = new Set<PluginKey>([installed.pluginKey]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const dependency of current.manifest.dependencies ?? []) {
        const marketplaceId = dependency.marketplace ?? current.marketplaceId;
        const entry = find(dependency.name, marketplaceId);
        if (!entry) {
          const label = dependency.marketplace ? `${dependency.name}@${dependency.marketplace}` : dependency.name;
          if (!missing.includes(label)) missing.push(label);
          continue;
        }
        if (visited.has(entry.pluginKey)) continue;
        visited.add(entry.pluginKey);
        resolved.set(entry.pluginKey, entry);
        queue.push(entry);
      }
    }
    if (missing.length > 0) {
      throw new Error(`plugin.manage.dependency-not-installed:${missing.join(',')}`);
    }
    return [...resolved.values()];
  }

  /**
   * The active plugins that DECLARE `installed` as a dependency and are enabled
   * at `target`.
   *
   * One predicate, two readers: the disable path refuses while any of these
   * exist (`plugin-dependencies.md`'s "still required by"), and the install path
   * uses the same question to decide whether a `defaultEnabled: false` plugin is
   * being pulled in to satisfy one — the page's own carve-out. Extracted rather
   * than duplicated so the two can never drift into disagreeing about what
   * "required by an active plugin" means.
   *
   * A `undefined` target means the caller is not activating anything, so nothing
   * is required at any scope.
   */
  private async enabledDependentsOf(
    installed: PluginInstalledEntryV2,
    target: PluginActivationTarget | undefined,
  ): Promise<PluginInstalledEntryV2[]> {
    if (!target) return [];
    const active = await this.activeInstalledPlugins();
    return active.filter(entry => {
      if (!declaresAsDependency(entry, installed)) return false;
      const activation = this.policyStore.resolve(
        { pluginKey: entry.pluginKey, pluginInstanceId: entry.pluginInstanceId },
        {
          ...(target.kind !== 'global' ? { workspaceId: target.workspaceId } : {}),
          ...(target.kind === 'project' ? { projectKey: target.projectKey } : {}),
        },
      );
      return activation.enabled && !activation.suppressed;
    });
  }

  /**
   * `:169`-`:176` — refuse a disable that another ENABLED plugin still needs, with
   * the documented chained command.
   *
   * "Enabled" is the merged policy verdict at the disable target's own context,
   * not "installed": a dependent the user already turned off cannot block
   * anything. The chained command lists the dependents first and the named plugin
   * last, which is `:176`'s "disables them in the right order, ending with the one
   * you asked for".
   */
  private async assertNoEnabledDependents(
    installed: PluginInstalledEntryV2,
    target: PluginActivationTarget,
  ): Promise<void> {
    const dependents = await this.enabledDependentsOf(installed, target);
    if (dependents.length === 0) return;
    const names = dependents.map(entry => entry.pluginKey).sort();
    const chained = [...names, installed.pluginKey]
      .map(key => `nessy-general-agent plugin disable ${key}`)
      .join(' && ');
    throw new Error(
      `plugin.manage.dependency-required-by:${names.join(',')}:`
      + `${installed.pluginKey} is still required by ${names.join(', ')}. `
      + `Disable that plugin first, or disable everything together: ${chained}`,
    );
  }

  private setActivation(pluginKey: PluginKey, target: PluginActivationTarget, enabled: boolean): void {
    validateActivationTarget(target);
    const record = { pluginKey, enabled };
    switch (target.kind) {
      case 'global':
        this.policyStore.recordGlobal(record);
        return;
      case 'workspace':
        this.policyStore.recordWorkspace(target.workspaceId, record);
        return;
      case 'project':
        this.policyStore.recordProjectOverride(target.workspaceId, target.projectKey, record);
    }
  }

  private materialize(
    source: PluginInstallSource,
    baseTempDir?: string,
  ): Promise<MaterializedBundle> {
    return materializeStagedBundle(this.installer, source, baseTempDir ?? this.baseTempDir);
  }
}

export type MaterializedBundle =
  | {
      ok: true;
      staged: Awaited<ReturnType<PluginInstallStager['stageInstall']>>;
      manifest: PluginInstalledEntryV2['manifest'];
      diagnostics: PluginDiagnostic[];
      compatibility?: PluginCompatibilityReport;
    }
  | { ok: false; result: PluginManagementInstallResult };

/**
 * Stage a bundle into a temporary directory, run the format adapters over it and
 * validate the normalized manifest. Nothing here reaches the plugin store: the
 * only writes are inside `staged.stageDirectory`, and every failure branch
 * removes it before returning. `install`, `repair` and `validatePluginBundle`
 * all share this one normalization path so there is a single validator.
 *
 * D1.69 made it a FOURTH caller and that is why it is exported: a session-scoped
 * plugin (`plugins/session-scoped.ts`) is precisely this result and no store
 * write, so re-composing the three acquisition calls beside it would create the
 * second validator this function exists to prevent. The guarantee the new
 * caller depends on is the paragraph above, verbatim — nothing here reaches the
 * store, so the staging directory is the whole of what that caller must own.
 */
export async function materializeStagedBundle(
  installer: PluginInstallStager,
  source: PluginInstallSource,
  baseTempDir?: string,
): Promise<MaterializedBundle> {
  let staged: Awaited<ReturnType<PluginInstallStager['stageInstall']>> | undefined;
  try {
    const plan = await installer.createInstallPlanFromSource(source);
    staged = await installer.stageInstall(plan, baseTempDir ? { baseTempDir } : {});
    if (hasErrors(staged.diagnostics)) {
      const diagnostics = staged.diagnostics;
      await rm(staged.stageDirectory, { recursive: true, force: true });
      return { ok: false, result: { ok: false, diagnostics } };
    }
    const normalized = await installer.normalizeStagedInstall(staged);
    // T6 (plugin-install plan): every RETURN below dedupes. The doubling is
    // structural — `normalizeStagedInstall` both appends its diagnostics to
    // `staged.diagnostics` and returns them, and the manifest is validated
    // twice (adapter-internally and again below) — so every install used to
    // report each finding twice (npx installer-unavailable ×2, Codex app
    // warnings ×2 in the measured probe). Error-presence is preserved, so the
    // install/repair verdict cannot change.
    const diagnostics = [...staged.diagnostics, ...normalized.diagnostics];
    if (!normalized.manifest || hasErrors(diagnostics)) {
      await rm(staged.stageDirectory, { recursive: true, force: true });
      return { ok: false, result: { ok: false, diagnostics: dedupeDiagnostics(diagnostics) } };
    }
    const validated = normalizeNessyPluginManifest(normalized.manifest, { origin: staged.plan.origin });
    if (!validated.ok || !validated.value) {
      const allDiagnostics = dedupeDiagnostics([...diagnostics, ...validated.diagnostics]);
      await rm(staged.stageDirectory, { recursive: true, force: true });
      return { ok: false, result: { ok: false, diagnostics: allDiagnostics } };
    }
    return {
      ok: true,
      staged,
      manifest: {
        ...validated.value,
        ...(normalized.manifest.compatibility ? { compatibility: normalized.manifest.compatibility } : {}),
      },
      diagnostics: dedupeDiagnostics([...diagnostics, ...validated.diagnostics]),
      ...(normalized.compatibility ? { compatibility: normalized.compatibility } : {}),
    };
  } catch {
    if (staged) await rm(staged.stageDirectory, { recursive: true, force: true });
    return {
      ok: false,
      result: {
        ok: false,
        diagnostics: [pluginDiagnostic(
          'error',
          'plugin.install.failed',
          'Plugin installation failed before the verified bundle could be committed.',
        )],
      },
    };
  }
}

/** Bundle summary a validation reports. Manifest metadata only — never a path. */
export interface PluginValidationSummary {
  pluginId: string;
  name: string;
  version: string;
  /** Sorted manifest capability kinds, the same set `status()` reports. */
  capabilityKinds: string[];
}

export interface PluginBundleValidationResult {
  /** Whether the bundle passes. Under `strict`, a warning also fails it. */
  ok: boolean;
  /** Echoed so a caller rendering the result can say which rule produced `ok`. */
  strict: boolean;
  diagnostics: PluginDiagnostic[];
  errorCount: number;
  warningCount: number;
  /** Present only when normalization produced a manifest. */
  plugin?: PluginValidationSummary;
  /** Adapter-owned compatibility report, when the adapter emitted one. */
  compatibility?: PluginCompatibilityReport;
}

export interface PluginBundleValidationOptions {
  /**
   * `plugins/cli-reference.md#plugin-validate` — "Pass `--strict` to treat warnings as errors.
   * Use it in CI to catch a misspelled field name or a field left over from
   * another tool's manifest before publishing, even though the plugin would load
   * at runtime."
   */
  strict?: boolean;
  baseTempDir?: string;
}

/**
 * Validate a bundle WITHOUT installing it — the door the normalizer never had.
 *
 * `plugins/cli-reference.md#plugin-validate` — "Run `claude plugin validate ./my-plugin` or
 * `/plugin validate ./my-plugin`, where `./my-plugin` is your plugin directory,
 * to check `plugin.json`, skill/agent/command frontmatter, and
 * `hooks/hooks.json` for syntax and schema errors". `:477` — "`claude plugin
 * validate` reports unrecognized fields as warnings, not errors." `:479` — "A
 * plugin with only unrecognized-field warnings still passes validation and loads
 * at runtime", which is why the non-strict verdict ignores warnings entirely.
 * `:482` — "Fields with the wrong type still fail", which the normalizer already
 * reports as an error diagnostic.
 *
 * Deliberately NOT a second validator: this is `materializeStagedBundle` — the
 * exact staging + adapter + `normalizeNessyPluginManifest` path `install` and
 * `repair` run — with the commit removed. A caller therefore cannot get a
 * validation verdict that disagrees with what an install would have decided.
 *
 * Non-mutating by construction rather than by care: it never touches a
 * `PluginStoreV2`, a `CapabilityPolicyStore` or a `CapabilityTrustStore`, and the
 * staging directory is removed on every path including the success one. The
 * staging half of `PluginInstallService` reads its own store only inside
 * `commitInstall`, which is not on this path.
 */
export async function validatePluginBundle(
  installer: PluginInstallStager,
  source: PluginInstallSource,
  options: PluginBundleValidationOptions = {},
): Promise<PluginBundleValidationResult> {
  const strict = options.strict === true;
  const materialized = await materializeStagedBundle(installer, source, options.baseTempDir);
  if (!materialized.ok) {
    return validationVerdict(materialized.result.diagnostics, strict, {
      ...(materialized.result.compatibility ? { compatibility: materialized.result.compatibility } : {}),
    });
  }
  try {
    return validationVerdict([
      ...materialized.diagnostics,
      ...pluginIdKebabCaseDiagnostics(materialized.manifest.id),
    ], strict, {
      plugin: {
        pluginId: materialized.manifest.id,
        name: materialized.manifest.name,
        version: materialized.manifest.version,
        capabilityKinds: [...new Set(materialized.manifest.capabilities.map(c => c.kind))].sort(),
      },
      ...(materialized.compatibility ? { compatibility: materialized.compatibility } : {}),
    });
  } finally {
    // The success path is the one that would otherwise leak a staged copy of the
    // bundle: `materializeStagedBundle` cleans up only its failure branches.
    await rm(materialized.staged.stageDirectory, { recursive: true, force: true });
  }
}

/**
 * `^[a-z0-9]+(-[a-z0-9]+)*$`, DERIVED by probing the shipped binary rather than
 * guessed from the phrase "lowercase letters, digits, and hyphens only".
 *
 * `claude plugin validate` on a plugin directory, one fixture per row, warns on
 * `my--plugin`, `-my-plugin`, `my-plugin-`, `my.plugin`, `my_plugin`,
 * `MyPlugin` and `my-Plugin`, and stays silent on `my-plugin`, `my-1-plugin`,
 * `plugin1`, `123` and `a`. So: no empty segment, no leading or trailing
 * hyphen, digits are fine anywhere, and a single segment is fine.
 */
const KEBAB_CASE_PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * P2.443 — the ONE cross-product name warning that belongs to a surface this
 * fork owns. The other three do not; the ownership table and the reasoning are
 * in `marketplace/reserved-names.ts`, next to the reservation guard, and are not
 * repeated here.
 *
 * THE RULE COMES FROM THE PAGE. `plugins/manifest-reference.md#name` (re-pointed
 * 2026-10-01, F1.1033: the quote below was read off the `name` row of the old
 * plugins reference page's required-fields table, located by byte offset on the
 * rendered page; that page left the docs index and its `name` row became this
 * section). Verbatim as read then: "Unique identifier in
 * kebab-case, with no spaces, control
 * characters, or bidirectional-formatting characters. … This is public-facing:
 * users see it when installing". `plugins/marketplace-reference.md#validation-messages`,
 * Warnings (non-blocking): "`Plugin name \"x\" is not kebab-case`: rename to
 * lowercase letters, digits, and hyphens only (for example, `my-plugin`). Claude
 * Code accepts other forms, but the claude.ai marketplace sync rejects them."
 *
 * THE SEVERITY COMES FROM THE BINARY, measured rather than inferred: the shipped
 * `claude plugin validate` reports this as a non-blocking warning and exits 0
 * ("Validation passed with warnings"). So this is a WARNING and never an error —
 * refusing a bundle here would reject a plugin both supported runtimes load.
 *
 * WHY `id` AND NOT `name`. Upstream's `plugin.json` has one field doing both
 * jobs, and the page's own words make it the IDENTIFIER ("Unique identifier …
 * users see it when installing"). A Nessy-native manifest splits the two: `id`
 * is the identifier, `name` is a display label. Measured on the Claude adapter,
 * a `plugin.json` `name` is preserved verbatim into BOTH fields (`My_Plugin` ->
 * id `My_Plugin`), so checking `id` catches exactly what upstream catches for the
 * format upstream defines — while a display label like `Toolkit`, whose id is
 * `toolkit`, is correctly left alone. Checking `name` would apply an identifier
 * rule to a caption.
 *
 * `--strict` PROMOTES IT, like every other warning, and that is deliberate
 * rather than incidental: `plugins/cli-reference.md#plugin-validate` — "Pass `--strict` to treat
 * warnings as errors. Use it in CI to catch … before publishing" — and a name
 * the claude.ai marketplace sync will reject is precisely a publish-time
 * problem. The cost is stated rather than hidden: a CI job running `--strict`
 * over a plugin whose identifier is not kebab-case starts failing, and the
 * message says which name and what to rename it to.
 *
 * Not exported. An exported predicate with one caller is the inert-code shape
 * this row exists to avoid.
 */
function pluginIdKebabCaseDiagnostics(id: string): PluginDiagnostic[] {
  if (KEBAB_CASE_PLUGIN_ID.test(id)) return [];
  return [pluginDiagnostic(
    'warning',
    'plugin.validate.name_not_kebab_case',
    `Plugin identifier "${id}" is not kebab-case — in a Claude \`plugin.json\` this is the `
    + '`name` field. Claude Code and this runtime both accept it, but the claude.ai '
    + 'marketplace sync requires kebab-case: lowercase letters, digits, and hyphens only, '
    + 'with no leading, trailing or doubled hyphen (for example, "my-plugin").',
    'id',
  )];
}

function validationVerdict(
  raw: PluginDiagnostic[],
  strict: boolean,
  extra: Omit<PluginBundleValidationResult, 'ok' | 'strict' | 'diagnostics' | 'errorCount' | 'warningCount'>,
): PluginBundleValidationResult {
  const diagnostics = dedupeDiagnostics(raw);
  const errorCount = diagnostics.filter(diagnostic => diagnostic.severity === 'error').length;
  const warningCount = diagnostics.filter(diagnostic => diagnostic.severity === 'warning').length;
  return {
    ok: errorCount === 0 && (!strict || warningCount === 0),
    strict,
    diagnostics,
    errorCount,
    warningCount,
    ...extra,
  };
}

/**
 * The staging path reports the same manifest diagnostic twice: the adapter's
 * normalization validates the manifest, and `materializeStagedBundle` validates
 * the adapter's output again (plus `normalizeStagedInstall` both appends its
 * findings to `staged.diagnostics` and returns them).
 *
 * Since T6 of the plugin-install plan this is ALSO applied inside
 * `materializeStagedBundle`: the install result is a user surface now (the
 * post-install checklist and the agent tool relay it), and the measured probe
 * showed every finding printed twice. The old reason for not collapsing there —
 * "would change what install/repair persist on the installed entry" — was
 * hollow by measurement: `store-v2` persists `diagnostics: []` on the entry.
 * Presence of an error is preserved, so no verdict can change.
 */
function dedupeDiagnostics(diagnostics: readonly PluginDiagnostic[]): PluginDiagnostic[] {
  const seen = new Set<string>();
  const unique: PluginDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify([
      diagnostic.severity,
      diagnostic.code,
      diagnostic.message,
      diagnostic.path ?? null,
      diagnostic.details ?? null,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(diagnostic);
  }
  return unique;
}

/**
 * Compose a validator over the default staging seam.
 *
 * The staging class stays off the public plugin barrel (retired post-W10), so a
 * caller with no plugin store of its own — the CLI — gets a factory rather than
 * the class, exactly as `createPluginRegistrySource` does for the marketplace
 * registry. `fetchImpl` is injectable so a caller can forbid network reach; the
 * default keeps remote sources working for hosts that want them.
 */
export function createPluginBundleValidator(options: {
  fetchImpl?: typeof fetch;
  baseTempDir?: string;
  formatAdapters?: PluginFormatAdapter[];
} = {}): {
  validate(
    source: PluginInstallSource,
    validateOptions?: PluginBundleValidationOptions,
  ): Promise<PluginBundleValidationResult>;
} {
  const installer = new PluginInstallService({
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.baseTempDir ? { baseTempDir: options.baseTempDir } : {}),
    ...(options.formatAdapters ? { formatAdapters: options.formatAdapters } : {}),
  });
  return {
    validate: (source, validateOptions = {}) => validatePluginBundle(installer, source, {
      ...(options.baseTempDir ? { baseTempDir: options.baseTempDir } : {}),
      ...validateOptions,
    }),
  };
}

/**
 * Apply an authenticated external-catalog policy without ever downgrading a
 * remote MCP server to anonymous access. Existing explicit header/env bindings
 * (for example Codex `bearer_token_env_var`) remain supervised plugin MCP.
 * A simple remote MCP with no auth metadata is promoted to a Source-backed
 * OAuth connector so discovery happens only after exact connector trust.
 */
function applyCatalogAuthentication(
  manifest: NessyPluginManifest,
  timing: PluginConnectorAuthTiming | undefined,
): NessyPluginManifest {
  if (!timing) return manifest;

  const connectors: PluginConnectorDescriptor[] = (manifest.connectors ?? []).map(connector => {
    const hasRemoteServer = connector.mcpServers.some(server => (
      (server.transport === 'http' || server.transport === 'sse') && !!server.url
    ));
    if (!hasRemoteServer) return connector;
    const type = connector.auth?.type && connector.auth.type !== 'none'
      ? connector.auth.type
      : 'oauth';
    return { ...connector, auth: { type, timing } };
  });
  const capabilities: PluginCapability[] = [];

  for (const capability of manifest.capabilities) {
    if (capability.kind !== 'mcp'
      || (capability.mcp.transport !== 'http' && capability.mcp.transport !== 'sse')
      || !capability.mcp.url) {
      capabilities.push(capability);
      continue;
    }

    const descriptor = capability.mcp;
    const hasReviewedAuthBinding = Object.keys(descriptor.headers ?? {}).length > 0
      || (descriptor.url?.includes('${') === true && (
        Object.keys(descriptor.environmentSources ?? {}).length > 0
        || (descriptor.requiredEnvironmentNames?.length ?? 0) > 0
      ));
    if (hasReviewedAuthBinding) {
      capabilities.push(capability);
      continue;
    }

    // Every field here is one the promoted connector cannot carry, so keeping
    // it would mean silently dropping it. `toolTimeoutMs` used to be on this
    // list for the same reason and is no longer: the connector descriptor
    // carries it through to `McpSourceConfig.timeoutMs`. Leaving it would have
    // refused an entire server over a benign documented ceiling — and only
    // now that the Claude adapter emits the field would that have started
    // happening.
    const canPromoteToOAuth = !descriptor.command
      && !descriptor.args?.length
      && !descriptor.cwd
      && !descriptor.env
      && !descriptor.environmentDefaults
      && !descriptor.environmentSources
      && !descriptor.requiredEnvironmentNames?.length
      && descriptor.required === undefined;
    if (!canPromoteToOAuth) {
      capabilities.push({
        id: capability.id,
        kind: 'unsupported',
        ...(capability.displayName ? { displayName: capability.displayName } : {}),
        ...(capability.description ? { description: capability.description } : {}),
        unsupported: {
          externalKind: 'catalog-authenticated-mcp',
          reasonCode: 'plugin.deferred.catalog_authenticated_mcp_auth_ambiguous',
          // The server NAME, in the `${externalKind}.${logicalName}` spelling
          // `deferUnavailablePluginSurfaces` established, because the descriptor
          // that carried it does not survive the rewrite. P2.182 measured the
          // cost of omitting it: the refusal reached the headless
          // `mcp_server_errors` channel identified only by the capability id.
          sourcePath: `catalog-authenticated-mcp.${descriptor.serverName}`,
          executable: true,
        },
      });
      continue;
    }

    // C3 (capability-path): the catalog-authenticated server STAYS a
    // capability, gaining the endpoint auth descriptor that binds it to its
    // global plugin credential slot — no synthesized `catalog.*` connector and
    // no Source. The catalog's per-server auth TIMING has no capability-path
    // field; pending auth is state-based (empty slot ⇒ surfaced), so timing
    // granularity is intentionally dropped here.
    capabilities.push({
      ...capability,
      mcp: { ...descriptor, authType: 'oauth' },
    });
  }

  return {
    ...manifest,
    capabilities,
    ...(connectors.length > 0 ? { connectors } : {}),
  };
}

function applyCatalogAuthenticationOrigin(
  origin: PluginOrigin,
  timing: PluginConnectorAuthTiming | undefined,
  catalogAuthenticationPolicy: string | undefined,
): PluginOrigin {
  if (!timing && !catalogAuthenticationPolicy) return origin;
  return {
    ...origin,
    provenance: {
      ...origin.provenance,
      ...(timing ? { connectorAuthTiming: timing } : {}),
      ...(catalogAuthenticationPolicy ? { catalogAuthenticationPolicy } : {}),
    },
  };
}

function readConnectorAuthTiming(value: unknown): PluginConnectorAuthTiming | undefined {
  return value === 'ON_INSTALL' || value === 'ON_FIRST_USE' ? value : undefined;
}

function summarizeInstalled(
  entry: PluginInstalledEntryV2,
): PluginManagementInstalledSummary {
  const source = summarizeInstalledSource(entry);
  const authRequirements = derivePluginMcpAuthRequirements(entry.manifest);
  // P2.155 — the persisted adapter warnings, read from the manifest that is on
  // disk. Deliberately NOT `entry.diagnostics.filter(severity === 'warning')`:
  // that would be a second derivation of the same fact, and the point of the row
  // is that the stored field finally has a reader.
  const adapterWarnings = (entry.manifest.compatibility?.adapter?.warnings ?? [])
    .map(warning => warning.code);
  return {
    pluginKey: entry.pluginKey,
    activeInstanceId: entry.pluginInstanceId,
    marketplaceId: entry.marketplaceId,
    pluginId: entry.pluginId,
    version: entry.version,
    name: entry.manifest.name,
    ...(entry.manifest.description ? { description: entry.manifest.description } : {}),
    installedAt: entry.installedAt,
    capabilityKinds: capabilityKinds(entry),
    diagnostics: entry.diagnostics,
    ...(source ? { source } : {}),
    ...(entry.compatibility ? { compatibility: entry.compatibility } : {}),
    ...(adapterWarnings.length > 0 ? { adapterWarnings } : {}),
    ...(authRequirements.length > 0 ? { authRequirements } : {}),
    // `plugins/host-marketplace.md#depend-on-and-recommend-other-plugins` — the acquisition step's input. Carried on the
    // summary rather than re-read from the registry so the caller that just
    // installed a bundle resolves exactly the set that bundle declares.
    ...(entry.manifest.dependencies?.length ? { dependencies: entry.manifest.dependencies } : {}),
    presentation: toSafePluginPresentationOrigin(entry.origin),
  };
}

function capabilityKinds(entry: PluginInstalledEntryV2): string[] {
  const kinds = new Set<string>(entry.manifest.capabilities.map(capability => capability.kind));
  if (entry.manifest.apps?.length) kinds.add('app');
  if (entry.manifest.nessyExtensions?.settings?.length) kinds.add('setting');
  if (entry.manifest.nessyExtensions?.commands?.length) kinds.add('command');
  if (entry.manifest.nessyExtensions?.assets?.length) kinds.add('asset');
  return [...kinds].sort();
}

function summarizeInstalledSource(entry: PluginInstalledEntryV2): PluginManagementInstalledSourceSummary | undefined {
  const provenance = entry.origin.provenance ?? {};
  const marketplaceItemId = stringValue(provenance.itemId);
  const packageName = stringValue(provenance.packageName);
  const packageVersion = stringValue(provenance.version);
  const source: PluginManagementInstalledSourceSummary = {
    ...(marketplaceItemId ? { marketplaceItemId, rawSkillId: marketplaceItemId } : {}),
    ...(packageName ? { packageName } : {}),
    ...(packageVersion ? { packageVersion } : {}),
    ...(entry.origin.repositoryUrl ? { repositoryUrl: entry.origin.repositoryUrl } : {}),
    ...(entry.origin.sourceUrl ? { sourceUrl: entry.origin.sourceUrl } : {}),
  };
  return Object.keys(source).length > 0 ? source : undefined;
}

function reconstructInstallSource(entry: PluginInstalledEntryV2): PluginInstallSource | undefined {
  const origin = entry.origin;
  const provenance = origin.provenance ?? {};
  const marketplace = marketplaceMetadata(entry, origin);
  const packageName = stringValue(provenance.packageName);
  if (packageName) {
    return {
      kind: 'marketplace-npm-package',
      packageName,
      version: stringValue(provenance.version) ?? entry.version,
      ...(stringValue(provenance.registry) ? { registry: stringValue(provenance.registry) } : {}),
      ...(stringValue(provenance.integrity) ? { integrity: stringValue(provenance.integrity) } : {}),
      ...(marketplace ? { marketplace } : {}),
    };
  }
  if (origin.repositoryUrl) {
    return {
      kind: 'repository',
      repositoryUrl: origin.repositoryUrl,
      ...(stringValue(provenance.ref) ? { ref: stringValue(provenance.ref) } : {}),
      ...(stringValue(provenance.subdirectory) ? { subdirectory: stringValue(provenance.subdirectory) } : {}),
      ...(marketplace ? { marketplace } : {}),
    };
  }
  if (origin.localPath) {
    return { kind: 'local-path', path: origin.localPath, ...(marketplace ? { marketplace } : {}) };
  }
  if (origin.sourceUrl) {
    return origin.source === 'marketplace'
      ? { kind: 'marketplace-url', url: origin.sourceUrl, ...(marketplace ? { marketplace } : {}) }
      : { kind: 'url', url: origin.sourceUrl };
  }
  return undefined;
}

function marketplaceMetadata(
  entry: PluginInstalledEntryV2,
  origin: PluginOrigin,
): PluginMarketplaceInstallMetadata | undefined {
  const provenance = origin.provenance ?? {};
  if (origin.source !== 'marketplace' && !origin.marketplaceId && !stringValue(provenance.itemId)) return undefined;
  return {
    ...(origin.marketplaceId ? { marketplaceId: origin.marketplaceId } : {}),
    ...(origin.marketplaceBaseUrl ? { marketplaceBaseUrl: origin.marketplaceBaseUrl } : {}),
    ...(stringValue(provenance.itemId) ? { itemId: stringValue(provenance.itemId) } : {}),
    name: stringValue(provenance.name) ?? entry.manifest.name,
    version: stringValue(provenance.version) ?? entry.version,
    ...(origin.sourceUrl ? { sourceUrl: origin.sourceUrl } : {}),
    ...(stringValue(provenance.packageName) ? { packageName: stringValue(provenance.packageName) } : {}),
  };
}

function assertPluginKey(pluginKey: PluginKey): void {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(pluginKey)) {
    throw new Error('plugin.manage.invalid-plugin-key');
  }
}

function combinePluginConfigurationFields(
  ...groups: (readonly PluginUserConfigurationDescriptor[])[]
): PluginUserConfigurationDescriptor[] {
  const fields: PluginUserConfigurationDescriptor[] = [];
  const keys = new Set<string>();
  for (const group of groups) {
    for (const field of group) {
      if (keys.has(field.key)) throw new Error('plugin.configuration.duplicate-field');
      keys.add(field.key);
      fields.push(field);
    }
  }
  return fields;
}

function selectPluginConfigurationValues(
  values: Record<string, PluginConfigurationValue>,
  keys: ReadonlySet<string>,
): Record<string, PluginConfigurationValue> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => keys.has(key)));
}

function validateActivationTarget(target: PluginActivationTarget): void {
  if (target.kind === 'global') return;
  assertStorageId('workspace', target.workspaceId);
  if (target.kind === 'project' && !isValidProjectKey(target.projectKey)) {
    throw new Error('plugin.manage.invalid-project-key');
  }
}

function isUnresolvedAppOnly(manifest: NessyPluginManifest): boolean {
  if (!manifest.apps?.length) return false;
  const remoteConnectorIds = new Set((manifest.connectors ?? [])
    .filter(connector => connector.mcpServers.some(server => (
      (server.transport === 'http' || server.transport === 'sse') && !!server.url
    )))
    .map(connector => connector.id));
  if (manifest.apps.some(app => remoteConnectorIds.has(app.connectorId))) return false;
  if (manifest.capabilities.some(capability => capability.kind !== 'unsupported')) return false;
  const extensions = manifest.nessyExtensions;
  return !extensions?.settings?.length && !extensions?.commands?.length && !extensions?.assets?.length;
}

function unresolvedAppOnly(
  diagnostics: PluginDiagnostic[],
  compatibility?: PluginCompatibilityReport,
): PluginManagementInstallResult {
  return unavailableInstallResult(
    diagnostics,
    compatibility,
    'plugin.install.app_connector_metadata_missing',
    'This app requires trusted connector endpoint metadata. Install a bundle that includes its MCP connector declaration.',
  );
}

function unavailableInstallResult(
  diagnostics: PluginDiagnostic[],
  compatibility: PluginCompatibilityReport | undefined,
  code: string,
  message: string,
): PluginManagementInstallResult {
  return {
    ok: false,
    diagnostics: [...diagnostics, pluginDiagnostic('error', code, message)],
    ...(compatibility ? { compatibility } : {}),
  };
}

function hasErrors(diagnostics: readonly PluginDiagnostic[]): boolean {
  return diagnostics.some(diagnostic => diagnostic.severity === 'error');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Does `candidate` declare `subject` in its own `dependencies` array?
 *
 * ONE predicate with two readers — the disable/install path's
 * `enabledDependentsOf` and P6.557's prune — so the two can never drift into
 * disagreeing about what "required by" means. A plugin never depends on itself.
 *
 * The name match accepts either spelling the manifest may use, which is what
 * the acquisition path resolves against: `plugin-dependencies.md` names the
 * dependency by `name`, and a bundle's `id` and `name` are not always the same
 * string in this fork.
 */
function declaresAsDependency(
  candidate: PluginInstalledEntryV2,
  subject: PluginInstalledEntryV2,
): boolean {
  if (candidate.pluginKey === subject.pluginKey) return false;
  return (candidate.manifest.dependencies ?? []).some(dependency => {
    const marketplaceId = dependency.marketplace ?? candidate.marketplaceId;
    return marketplaceId === subject.marketplaceId
      && (dependency.name === subject.pluginId || dependency.name === subject.manifest.name);
  });
}

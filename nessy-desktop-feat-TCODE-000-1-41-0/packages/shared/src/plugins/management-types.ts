import type { SafePluginPresentationOrigin } from '../protocol/capabilities.ts';
import type { ProjectKey } from '../projects/project-identity.ts';
import type {
  NessyPluginManifest,
  PluginCompatibilityReport,
  PluginConnectorAuthTiming,
  PluginDependencyDescriptor,
  PluginDiagnostic,
  PluginInstallPlan,
  PluginInstallSource,
  PluginKey,
  PluginStagedInstall,
} from './types.ts';
import type { PluginDependencyError } from './dependencies.ts';
import type { PluginConfigurationStatus } from './mcpb-configuration.ts';
import type { PluginMcpAuthRequirement } from './auth-requirements.ts';

export type PluginActivationTarget =
  | { kind: 'global' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'project'; workspaceId: string; projectKey: ProjectKey };

export type PluginCommittedMutationAction = 'install' | 'disable' | 'uninstall';

/**
 * The durable mutation succeeded, but post-commit lifecycle work failed.
 * Callers must invalidate active capability snapshots before surfacing the
 * failure; stale leases may still reference the previous registry selection.
 */
export class PluginMutationCommittedError extends Error {
  readonly code = 'plugin.mutation.committed_cleanup_failed';
  readonly effect = 'remove' as const;
  readonly cause: unknown;

  constructor(
    readonly action: PluginCommittedMutationAction,
    readonly pluginKey: PluginKey,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'PluginMutationCommittedError';
    this.cause = cause;
  }
}

export function isPluginMutationCommittedError(value: unknown): value is PluginMutationCommittedError {
  if (value instanceof PluginMutationCommittedError) return true;
  if (!value || typeof value !== 'object') return false;
  const candidate = value as {
    code?: unknown;
    effect?: unknown;
    action?: unknown;
    pluginKey?: unknown;
  };
  return candidate.code === 'plugin.mutation.committed_cleanup_failed'
    && candidate.effect === 'remove'
    && (candidate.action === 'install' || candidate.action === 'disable' || candidate.action === 'uninstall')
    && typeof candidate.pluginKey === 'string';
}

export interface PluginManagementInstalledSourceSummary {
  marketplaceItemId?: string;
  rawSkillId?: string;
  packageName?: string;
  packageVersion?: string;
  repositoryUrl?: string;
  sourceUrl?: string;
}

export interface PluginConnectorAuthRequest {
  workspaceId: string;
  sourceSlug: string;
  /**
   * Connector identity + auth timing (T2, plugin-install plan). The service
   * layer now reports EVERY connector source still awaiting auth — not only the
   * ON_INSTALL subset — so the RPC boundary can split the one-shot ON_INSTALL
   * `performOAuth` handoff (unchanged renderer contract, § 0b-2: no OAuth
   * chaining for ON_FIRST_USE at install) from the informational pending-auth
   * report the post-install checklist and the agent tool result consume.
   */
  connectorId?: string;
  serverName?: string;
  timing?: PluginConnectorAuthTiming;
}

export interface PluginManagementInstalledSummary {
  pluginKey: PluginKey;
  activeInstanceId: string;
  marketplaceId: string;
  pluginId: string;
  version: string;
  name: string;
  description?: string;
  installedAt: number;
  capabilityKinds: string[];
  diagnostics: PluginDiagnostic[];
  source?: PluginManagementInstalledSourceSummary;
  /**
   * P6.628 — the transitive dependencies this enable wrote `true` for, at the
   * same scope, in `resolveTransitiveDependencies` order. Absent when the
   * operation enabled nothing else, and absent entirely outside `enable`.
   *
   * `plugin-dependencies.md` § *Enable or disable a plugin with dependencies*:
   * "The success message lists what else was enabled along with the plugin you
   * named." Every reader needs that list and only the service can know it —
   * `enableUnlocked` already resolves the set before writing anything, and it
   * used to DISCARD it, so both the CLI verb and `plugin_manage`'s `enable`
   * action had to either stay silent or diff two inventory reads. A second
   * derivation of a fact the service knows precisely is the thing this field
   * exists to prevent, which is why it is carried on the summary rather than
   * inferred at either caller.
   *
   * Honest about ONE difference from the page. The same section's table says
   * enable "writes `true` for the plugin and each dependency that was not
   * already enabled at the target scope"; this is the WHOLE resolved transitive
   * set, because `enableUnlocked` writes `true` for every member unconditionally
   * and never reads the prior per-scope value. So each name here is genuinely
   * enabled at the target scope after the call, and the set can be a superset of
   * the ones whose value actually changed. Narrowing it would mean a per-scope
   * read-before-write the store does not offer today.
   */
  enabledDependencies?: PluginKey[];
  /** Adapter-owned compatibility report (D12); never recomputed at this layer. */
  compatibility?: PluginCompatibilityReport;
  /**
   * P2.155 — the diagnostic CODES held by the persisted
   * `manifest.compatibility.adapter.warnings`, read from the stored manifest
   * rather than recomputed from `diagnostics`.
   *
   * That field is the adapter's deliberate NON-GATING record: a `deferred` entry
   * flips `compatibility.state` to `partial` and gates the install behind a
   * confirmation, which is right for a lost component and wrong for the dropped
   * listing metadata this carries (`codex-contract-fields.test.ts` states and
   * pins the split). It was written at five sites and read by nothing outside
   * tests, so a real drop was recorded on disk and shown to nobody. Codes only —
   * the messages carry bundle paths and stay server-side.
   */
  adapterWarnings?: string[];
  /**
   * Display-only origin presentation (A9), derived from the persisted
   * installed-origin adapter provenance. Cosmetic only; never read by
   * activation/trust/credential decisions.
   */
  presentation?: SafePluginPresentationOrigin;
  /** Immutable-manifest presentation only; never runtime readiness or authority. */
  authRequirements?: PluginMcpAuthRequirement[];
  /** One-shot ON_INSTALL handoff; omitted from status rows. */
  authRequests?: PluginConnectorAuthRequest[];
  /**
   * `plugins/manifest-reference.md#user-configuration` — `userConfig` declares "User-configurable values
   * prompted at enable time", and `:543` — "the values that Claude Code prompts
   * the user for when the plugin is enabled. Use this instead of requiring users
   * to hand-edit `settings.json`."
   *
   * Present on the ENABLE result and on an INSTALL that activates (T2:
   * install-with-activation IS an enable, so it raises the same prompt), and
   * only when the plugin declares options, so the caller can raise that prompt
   * at the one moment the contract names. Value-free, like every other status
   * this layer returns.
   */
  configuration?: PluginConfigurationStatus;
  /**
   * `plugins/manifest-reference.md#dependencies` — the plugin's own declared `dependencies`,
   * carried on the summary so the caller that just installed it can resolve
   * them without re-reading the registry. Present only when non-empty.
   *
   * This is the manifest's MERGED view (manifest + marketplace entry, resolved
   * by the format adapter), which is the same set the load-time verdict reads,
   * so acquisition and the disable-until-resolved rule can never disagree about
   * what a plugin declared.
   */
  dependencies?: PluginDependencyDescriptor[];
}

export interface PluginManagementStatusResult {
  installed: PluginManagementInstalledSummary[];
  diagnostics: PluginDiagnostic[];
}

export interface PluginManagementInstallOptions {
  activateIn?: PluginActivationTarget;
  baseTempDir?: string;
  /** Trusted server-side catalog policy; applied to authenticated connectors. */
  connectorAuthTiming?: PluginConnectorAuthTiming;
  /** Raw external catalog spelling retained only as installed-origin provenance. */
  catalogAuthenticationPolicy?: string;
  /**
   * P6.557 — set by the dependency-acquisition path and by nothing else.
   * `plugin-dependencies.md` § *Remove orphaned auto-installed dependencies*:
   * *"Plugins you installed yourself are never pruned, only those installed
   * automatically through another plugin's `dependencies` array."* The bit is
   * what tells the two apart, so it is written where the distinction is KNOWN
   * — at the call that pulls a dependency in — rather than inferred later.
   */
  autoInstalled?: boolean;
}

/** `plugins/cli-reference.md#plugin-prune` — `--dry-run`: "List what would be removed without removing anything". */
export interface PluginPruneOptions {
  dryRun?: boolean;
}

export interface PluginPruneRemoval {
  pluginKey: PluginKey;
  name: string;
  marketplaceId: string;
}

/**
 * P6.557 — what a prune did, or would have done.
 *
 * `kept` lists ONLY auto-installed dependencies that survived, each with the
 * plugins still requiring it: those are the ones a caller might expect to be
 * gone, and `plugins/cli-reference.md#plugin-prune` scopes the verb to
 * "auto-installed plugin dependencies that are no longer required by any
 * installed plugin". `userInstalledCount` is the population the verb never
 * considers at all — reported as a NUMBER rather than a list, because naming
 * every directly-installed plugin as "refused" would misdescribe the page's
 * "plugins you installed directly are never touched".
 */
export interface PluginPruneResult {
  removed: PluginPruneRemoval[];
  kept: Array<{ pluginKey: PluginKey; requiredBy: PluginKey[] }>;
  userInstalledCount: number;
  dryRun: boolean;
}

export interface PluginManagementInstallResult {
  ok: boolean;
  installed?: PluginManagementInstalledSummary;
  diagnostics: PluginDiagnostic[];
  /** Adapter-owned compatibility report for this install/repair attempt (D12). */
  compatibility?: PluginCompatibilityReport;
  /**
   * Repair/update compatibility marker retained for existing management
   * callers. Install activates its supported subset immediately.
   */
  requiresConfirmation?: boolean;
  authRequests?: PluginConnectorAuthRequest[];
  /**
   * `plugins/host-marketplace.md#depend-on-and-recommend-other-plugins` — "Claude Code resolves and installs them
   * automatically". What the dependency step actually added, in install order,
   * so the caller can report it. Present only when non-empty.
   */
  installedDependencies?: Array<{
    pluginKey: PluginKey;
    name: string;
    marketplaceId: string;
    version: string;
    /** The `{name}--v{version}` tag the version constraint resolved to (`:134`). */
    tag?: string;
  }>;
  /**
   * `:127`/`:208` — the dependency problems that made this install not deliver
   * what was asked for. Their presence is why `ok` is `false`: the plugin's own
   * bundle may be on disk, but every one of its capabilities is disabled by the
   * load-time verdict until the error is resolved.
   */
  dependencyErrors?: PluginDependencyError[];
}

export interface PluginManagementRepairOptions {
  source?: PluginInstallSource;
  baseTempDir?: string;
}

export interface PluginInstallStager {
  createInstallPlanFromSource(source: PluginInstallSource): Promise<PluginInstallPlan>;
  stageInstall(plan: PluginInstallPlan, options?: { baseTempDir?: string }): Promise<PluginStagedInstall>;
  normalizeStagedInstall(staged: PluginStagedInstall): Promise<{
    manifest?: NessyPluginManifest;
    diagnostics: PluginDiagnostic[];
    compatibility?: PluginCompatibilityReport;
  }>;
}

/**
 * P6.437 — `plugins/cli-reference.md#plugin-uninstall`, the `--keep-data` option:
 * *"Preserve the plugin's persistent data directory"*, and `#persistent-data-directory`
 * *"The CLI deletes by default; pass `--keep-data` to preserve it."*
 *
 * Delete-by-default is therefore the page's own posture and stays ours; this is
 * the opt-out the page documents and this fork did not have (`keepData` /
 * `keep-data` scored 0 files across `packages/` and `apps/` at HEAD, against
 * `CLAUDE_PLUGIN_DATA` at 12 on the same globs).
 */
export interface PluginUninstallOptions {
  keepData?: boolean;
}

/**
 * What an uninstall reports back. `keptDataPath` is present exactly when the
 * data root was RETAINED — the page's own reason for the flag is "when
 * reinstalling after testing a new version", so the caller must be able to say
 * WHERE the kept data is rather than merely that something was kept.
 */
export interface PluginUninstallResult {
  keptDataPath?: string;
}

export interface PluginManagementApi {
  status(): Promise<PluginManagementStatusResult>;
  install(source: PluginInstallSource, options?: PluginManagementInstallOptions): Promise<PluginManagementInstallResult>;
  enable(pluginKey: PluginKey, target: PluginActivationTarget): Promise<PluginManagementInstalledSummary>;
  disable(pluginKey: PluginKey, target: PluginActivationTarget): Promise<PluginManagementInstalledSummary>;
  /** Flip ONE capability at a scope via a capabilityId-scoped policy record. */
  setCapabilityEnabled(
    pluginKey: PluginKey,
    target: PluginActivationTarget,
    capabilityId: string,
    enabled: boolean,
  ): Promise<PluginManagementInstalledSummary>;
  configurationStatus(pluginKey: PluginKey, workspaceId: string): Promise<PluginConfigurationStatus>;
  configure(
    pluginKey: PluginKey,
    workspaceId: string,
    values: Record<string, unknown>,
  ): Promise<PluginConfigurationStatus>;
  clearConfiguration(pluginKey: PluginKey, workspaceId: string): Promise<PluginConfigurationStatus>;
  repair(pluginKey: PluginKey, options?: PluginManagementRepairOptions): Promise<PluginManagementInstallResult>;
  update(pluginKey: PluginKey, options?: PluginManagementRepairOptions): Promise<PluginManagementInstallResult>;
  uninstall(pluginKey: PluginKey, options?: PluginUninstallOptions): Promise<PluginUninstallResult>;
  /** `plugins/cli-reference.md#plugin-prune` — remove auto-installed dependencies nothing requires any more. */
  pruneDependencies(options?: PluginPruneOptions): Promise<PluginPruneResult>;
  refresh(): Promise<PluginManagementStatusResult>;
}

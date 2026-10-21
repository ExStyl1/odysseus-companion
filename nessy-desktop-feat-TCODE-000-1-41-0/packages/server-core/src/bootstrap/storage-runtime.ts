/** Verified-v2 storage composition root. Construction requires the exact layout
 * capability returned by production startup readiness; there is no legacy fallback,
 * migration, import, or dual-read path. */

import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { createSessionStore, type SessionStore } from '@nessy-agent/shared/sessions'
import {
  credentialIdToAccount,
  initializeCredentialManagerV2,
  type CredentialManager,
  type ResolvedRuntimeCredential,
  type RuntimeCredentialBinding,
} from '@nessy-agent/shared/credentials'
import { getSessionMemoryFilePath } from '@nessy-agent/shared/agent/memory'
// P3.339 — the ONE reader of the persisted `additionalDirectories` setting, the
// same one `SessionManager.sessionAdditionalDirectories` uses. Memoized on the
// raw entries, so calling it per capability pass costs a JSON.stringify.
import { getConfiguredAdditionalDirectories } from '@nessy-agent/shared/agent'
import type { DpSessionBroker } from '@nessy-agent/shared/auth/dp'
import {
  areManagedPluginHooksAllowed,
  DEFAULT_MANAGED_PI_POLICY,
  isManagedAllHooksDisabled,
  isManagedHooksOnly,
  isManagedMcpServerAllowed,
  isManagedPluginAllowed,
  isStrictPluginOnlyCustomizationLocked,
  reportManagedPolicyCaveats,
  reportManagedPolicyDrops,
  resolveManagedPluginActivation,
  type ManagedMcpServerIdentityV1,
  type ManagedPiPolicyV1,
  type ManagedPolicyCaveatV1,
  type ManagedPolicyDropV1,
} from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { buildNativeCapabilityInventory, type NativeSourcesEnv } from '@nessy-agent/shared/capabilities/native-sources'
import { isPluginMcpCapabilityPathEnabled } from '@nessy-agent/shared/feature-flags'
import {
  CapabilityPolicyStore,
  type TrustedProjectOverlay,
} from '@nessy-agent/shared/capabilities/policy-store'
import { CapabilityTrustStore } from '@nessy-agent/shared/capabilities/trust-store'
import type {
  NativeCapabilityInventory,
  NativeCapabilitySourceRecord,
  WorkspacePolicyContext,
} from '@nessy-agent/shared/capabilities/types'
import type { CapabilityScopeRef } from '@nessy-agent/shared/capabilities/types'
import type {
  CapabilityContext,
  CapabilityResolver,
  CapabilityResolutionInputProvider,
  CapabilityResolutionInputs,
} from '@nessy-agent/shared/capabilities/resolver'
import { createCapabilityResolver } from '@nessy-agent/shared/capabilities/resolver'
import { isSafeModeEnabled } from '@nessy-agent/shared/config/safe-mode'
import {
  bundledSkillsDisabledByEnv,
  bundledSkillsDisabledBySetting,
} from '@nessy-agent/shared/config/bundled-skills-settings'
import {
  loadStoredConfig,
  parseBuiltinDpMcpSettingsV1,
  resolveSkillOverride,
  resolveSkillOverrides,
} from '@nessy-agent/shared/config'
import { BUILTIN_DP_MCP_SERVERS, isBuiltinDpMcpServerEnabled } from '@nessy-agent/shared/mcp'
import { bundledSkillSlugs, getAdminAgentSkillsDirs, getManagedSkillsRoot, readBundledSkillSeedReceipt } from '@nessy-agent/shared/skills'
import {
  onCapabilityCatalogInvalidation,
  onCapabilityInvalidation,
} from '@nessy-agent/shared/capabilities/invalidation'
import { ProjectHandleService, resolveMainCheckoutProjectKey } from '@nessy-agent/shared/projects/project-handle-service'
import { RecentProjectStore } from '@nessy-agent/shared/projects/recent-store'
import type {
  CapabilityInvalidationScope,
  CapabilityInvalidationEffectKind,
} from '@nessy-agent/shared/capabilities/resolver'
import {
  createPluginDataCleanupParticipant,
  migrateConnectorSourceCredentialsToGlobal,
  migrateConnectorCredentialsToPluginSlots,
  migrateOutdatedPluginAdaptersOnStartup,
  pluginMcpCredentialId,
  PluginManagementServiceV2,
  createPluginStoreV2,
  listRepositoryTags,
  loadProjectNessyAgentConfig,
  removePluginData,
  resolvePluginDataPath,
  resolvePluginProjectionCandidates,
  missingPluginConfigurationKeys,
  readPluginConfiguration,
  readPluginOptionEnvironment,
  resolvePluginConfigurationCapability,
  sweepAbandonedPluginStages,
  mergeSessionScopedPlugins,
  sessionScopedInstanceIds,
  sessionScopedPluginsFor,
  type PluginInstalledEntryV2,
  type PluginKey,
  type SessionScopedPlugin,
  type PluginManagementApi,
  type PluginProjectionCandidate,
  type PluginStoreV2,
} from '@nessy-agent/shared/plugins'
import { deleteLegacySourceCredentialCaches } from '@nessy-agent/shared/sources'
import {
  MarketplaceProposalRegistry,
  MarketplaceService,
  createPluginRegistrySource,
  resolveAvailableUpdateVersions,
  type CachedMarketplaceCatalogReader,
  type InstalledUpdateSubject,
  type MarketplaceRegistryController,
} from '@nessy-agent/shared/marketplace'
import {
  createWorkspaceService,
  type RemoteWorkspaceGateway,
  type VerifiedStorageLayoutV2,
  type WorkspaceService,
  type ResolvedWorkspace,
} from '@nessy-agent/shared/workspaces'
import { WorkspaceQuiescenceCoordinator } from '../workspaces/workspace-quiescence'
import {
  createPluginRuntimeDependencyInstaller,
  type PluginRuntimeDependencyHostContext,
} from './plugin-runtime-dependencies'
import { shadowedManagedFileWarning } from '@nessy-agent/shared/config/config-doctor'
import { setManagedModelPolicy } from '@nessy-agent/shared/config/managed-models'
import { onManagedDeliveryChange } from '@nessy-agent/shared/config/managed-delivery'
import { resolveEnforcedManagedPolicy } from './managed-policy-resolution'
import { resolveHostSandboxSettings } from './host-sandbox-settings'
import { probeIsolationCapabilities, type IsolationCapabilityReport } from '../pi-harness/isolation-capabilities'
import type { WindowsSandboxRuntimeBinding } from '@nessy-agent/shared/agent/backend'
import { createPiOtlpTelemetry, type PiOtlpTelemetry } from '../pi-harness/otlp-telemetry'
import { createUsageMetrics, type UsageMetrics } from '@nessy-agent/shared/telemetry/usage-metrics'
import { createHostTracer, type HostTracer } from '@nessy-agent/shared/telemetry/host-tracer'
import { startOtlpRearming } from './otlp-rearm'

export interface StorageRuntime {
  sessionStore: SessionStore
  pluginStore: PluginStoreV2
  pluginManagement: PluginManagementApi
  /** Marketplace list/inspect/propose-install façade for the agent-driven plugin_plan_install tool. */
  marketplaceService: MarketplaceService
  /** R3 bring-your-own registry controller (add/upgrade/remove/list + browse-merge). */
  marketplaceRegistrySource: MarketplaceRegistryController
  /** Server-only opaque proposal registry for the agent-driven plugin_plan_install/plugin_install tools. */
  marketplaceProposalRegistry: MarketplaceProposalRegistry
  capabilityPolicyStore: CapabilityPolicyStore
  capabilityTrustStore: CapabilityTrustStore
  credentialManager: CredentialManager
  capabilityResolver: CapabilityResolver
  projectHandleService: ProjectHandleService
  recentProjectStore: RecentProjectStore
  workspaceService: WorkspaceService
  workspaceQuiescence: WorkspaceQuiescenceCoordinator
  /**
   * One immutable policy shared by resolver and session authority, composed
   * from BOTH admin-controlled managed sources — the server-delivered payload
   * and the host-owned file. See {@link resolveEnforcedManagedPolicy}; the rule
   * is `server-managed-settings.md#settings-precedence` — "Within the managed
   * tier, Claude Code by default uses the first source that delivers at least one
   * policy key, checking server-managed settings first and then endpoint-managed
   * settings" — and it is not a merge.
   */
  managedPiPolicy: ManagedPiPolicyV1
  /**
   * D4 — the SAME composition, re-resolved on demand.
   *
   * `managedPiPolicy` above is the boot snapshot, and a snapshot is what let a
   * fleet keep pre-incident rules for as long as a user left the app open.
   * `SessionManager` calls this on a delivery signal and at each turn boundary
   * (it never polls), so a tightened policy reaches a running session without a
   * restart. Pure and cheap: the file half is a small read, the delivered half
   * is the in-memory session state or the cache the docs already require to
   * apply at startup.
   */
  resolveManagedPiPolicy: () => ManagedPiPolicyV1
  /**
   * D4 — the delivery publish site, forwarded so hosts do not each import the
   * delivery module. Every state change (a landed fetch, a granted approval, a
   * cache re-seed) goes through it.
   */
  subscribeManagedPolicyChange: (listener: () => void) => () => void
  /**
   * Every managed entry the tolerant parse refused, with its source and field.
   * Carried on the runtime because the three documented consumers all read it
   * after bootstrap. `managed-settings.md#invalid-entries-in-managed-settings`:
   * "To find a dropped entry, look in one of three places: Interactive sessions
   * show a dialog at startup listing the invalid entries. Non-interactive runs
   * with `-p` print a summary to stderr. `claude doctor` lists each invalid entry
   * with its source and field."
   *
   * Two of the three have a reader here. `createStorageRuntime` prints the
   * summary at load time, which is that section's STDERR bullet and, in the
   * desktop shell, a startup line in the main log. Its `claude doctor` bullet
   * landed in R30b as `nessy-general-agent doctor`, which reads the same
   * `formatManagedPolicyDrop` line through `collectConfigDoctorInput` rather
   * than through this field — that command runs without a session, so it never
   * builds a storage runtime. The interactive startup DIALOG bullet is still
   * missing and is recorded as such in `2026-07-29-deviation-unit-4.md`.
   */
  managedPiPolicyDrops: readonly ManagedPolicyDropV1[]
  /**
   * Entries that ARE enforced, and not the way they read — P2.398.
   *
   * The third state beside "enforced" and "refused", carried BESIDE
   * {@link managedPiPolicyDrops} rather than inside it: every disposition of a
   * drop means *not applied*, while a caveat is applied — on the denylist, more
   * broadly than it was written. Folding them together would file a widened
   * deny under a heading that says it did nothing, which is worse than not
   * reporting it at all.
   *
   * `createStorageRuntime` prints the summary at load, on the same
   * stderr/main-log channel the drop summary uses. `doctor` carries it too
   * since P2.409 — through `collectConfigDoctorInput`'s `caveats` field rather
   * than through this one, exactly as the drop listing does, because that
   * command runs without a session and never builds a storage runtime.
   *
   * The renderer's MCP list deliberately does NOT carry it, and that is a
   * decision rather than a gap: a caveat is about a policy ENTRY and both of
   * its dispositions manifest as a server row that is ABSENT, so there is
   * nothing for a row badge to attach to. The reasons are recorded in full at
   * `config-doctor.ts`'s `caveatLines`, beside the surface that does carry it.
   */
  managedPiPolicyCaveats: readonly ManagedPolicyCaveatV1[]
  /**
   * Per-profile isolation availability, probed ONCE at startup. Read-only
   * diagnosis: it never gates a run, and an unavailable backend still fails
   * closed at execution time.
   */
  isolationCapabilities: IsolationCapabilityReport
  /** Server-host-owned DP auth authority shared by plugin installs and MCP runtime gating. */
  dpSessionBroker: DpSessionBroker
  piTelemetry?: PiOtlpTelemetry
  /**
   * Token/cost counters for EVERY backend, unlike `piTelemetry`, whose emit is
   * gated on the Pi provider. Absent when no OTLP endpoint is configured.
   */
  usageMetrics?: UsageMetrics
  /**
   * P6.732 — the host span source. Absent unless the operator opted into
   * telemetry AND named a traces exporter this host implements, which is what
   * makes tracing-off mean no span and no minted `traceparent`.
   *
   * P6.882 — RE-ARMED, where this docblock said it was not until that row. It
   * is the third `startOtlpRearming` facade, so a managed delivery that
   * turns tracing on reaches a live session instead of waiting for a restart,
   * and — like its two siblings — it is handed over UNCONDITIONALLY, inert until
   * a delegate exists. That is what makes the first-launch case reachable at
   * all: a conditional field could never be armed later, the session manager
   * having been given `undefined`.
   *
   * The question a metrics batch does not raise, and its answer: a span is open
   * across a turn, so the swap ENDS the in-flight span on the outgoing tracer
   * with `nessy.telemetry.rearmed = true` rather than migrating it. See
   * `RearmingHostTracer` in `otlp-rearm.ts`.
   *
   * Still optional on this interface, because a caller that never opts into
   * telemetry hands over nothing at all in tests and both hosts read it with
   * `?.`.
   */
  hostTracer?: HostTracer
  resolveRuntimeCredential(binding: RuntimeCredentialBinding): ResolvedRuntimeCredential
  onCapabilityInvalidation(listener: (event: {
    scope: CapabilityInvalidationScope
    effect: CapabilityInvalidationEffectKind
    revokedLeaseIds: string[]; reason?: string // F1.493 (1) — the resolver's reason, carried to the host so a revoked turn can say why
  }) => void): () => void
  dispose(): void
}

export interface StorageRuntimeOptions {
  /** Process-host authority shared by gateway, install staging, and runtime gating. */
  dpSessionBroker: DpSessionBroker
  remoteGateway?: RemoteWorkspaceGateway
  nativeSourcesEnv?: NativeSourcesEnv
  pluginRuntimeHost?: PluginRuntimeDependencyHostContext
  /**
   * Host-resolved Windows sandbox toolchain, when this host has one. The
   * startup isolation probe needs the SAME binding the supervisor will use, or
   * it reports every win32 profile unavailable even where the toolchain exists.
   */
  windowsSandboxRuntime?: WindowsSandboxRuntimeBinding
}

/**
 * Re-exported so `createStorageRuntime`'s neighbourhood still names the seam a
 * test drives. The definition moved to `managed-policy-resolution.ts` when the
 * session-free `doctor` reader landed: composing the enforced policy must not
 * require the plugin store, the credential manager or the process supervisor.
 */
export {
  registerEnforcedManagedInAppBrowserProvider,
  registerEnforcedManagedInAppUpdatesProvider,
  registerEnforcedManagedModelPricing,
  registerEnforcedManagedNonGatewayConnections,
  registerEnforcedManagedPolicyProvider,
  registerEnforcedManagedRetentionProvider,
  registerEnforcedManagedSandboxEnabledProvider,
  resolveEnforcedManagedPolicy,
  type EnforcedManagedPolicySeams,
  type EnforcedManagedPolicyV1,
} from './managed-policy-resolution'
import { managedPolicyExpansionEnvironment } from './startup-environment'

/** Compose a fresh runtime only after verified-v2 readiness. */
export async function createStorageRuntime(
  layout: VerifiedStorageLayoutV2,
  options: StorageRuntimeOptions,
): Promise<StorageRuntime> {
  const dpSessionBroker = options.dpSessionBroker
  const enforcedManagedPolicy = resolveEnforcedManagedPolicy()
  const { policy: managedPiPolicy, drops: managedPiPolicyDrops } = enforcedManagedPolicy
  // `settings-reference.md#availablemodels`'s model allowlist ("Restrict which
  // models people can select for the main session, subagents, skills, and the
  // advisor") reaches the pure model-resolution
  // helpers in `shared` from here — one writer, the same composed policy this
  // function hands `SessionManager`, so the process registry and the session
  // layer cannot disagree about what is allowed. It is set BEFORE anything below
  // can resolve a connection.
  setManagedModelPolicy(managedPiPolicy)
  // P2.396 — `managed-mcp.md#how-policy-entries-expand`: a POLICY ENTRY expands
  // from "The environment Claude Code started with, plus `env` values from
  // managed settings", while the server's own configured value keeps reading
  // the live one. Composed HERE because this is the only place both halves are
  // in hand, and once because a per-resolve snapshot would pin nothing.
  const managedPolicyEnvironment = managedPolicyExpansionEnvironment(
    enforcedManagedPolicy.envComposition.env,
  ) as Record<string, string | undefined>
  // `managed-settings.md#invalid-entries-in-managed-settings`, the stderr bullet
  // ("Non-interactive runs with `-p` print a summary to stderr") — the drop list
  // stops being write-only here. Printed at
  // load rather than by each host so no host can forget it; the desktop shell
  // and the headless server both route `console.warn` to stderr/the main log.
  // Values never travel: a drop carries a field path and the parser's own
  // reason, and the renderer strips control characters out of both.
  reportManagedPolicyDrops(managedPiPolicyDrops)
  // P2.398 — the entries that ARE enforced and not the way they read. A
  // SEPARATE call and a separate heading, deliberately: `reportManagedPolicyDrops`
  // opens with "N managed settings entries were not applied", and a widened
  // deny filed under that sentence would be a report that lies in the
  // reassuring direction. Same channel, so an administrator reads both in one
  // place.
  const managedPiPolicyCaveats = enforcedManagedPolicy.caveats
  reportManagedPolicyCaveats(managedPiPolicyCaveats)
  // The one composition outcome an administrator cannot observe from disk: a
  // policy file that is deployed, valid and enforcing nothing because a
  // delivered payload took the whole tier
  // (`server-managed-settings.md#settings-precedence`). Warned here rather than
  // left to the doctor alone because the same section describes it as a state
  // people reach by accident — "If you clear your server-managed configuration in
  // the admin console with the intent of falling back to an endpoint-managed
  // plist or registry policy, be aware that cached settings persist on client
  // machines until the next successful fetch" — and the cache outlives that
  // expectation.
  const shadowWarning = shadowedManagedFileWarning(
    enforcedManagedPolicy.winner,
    enforcedManagedPolicy.fileCarriesSettings,
  )
  if (shadowWarning) console.warn(`[managed-settings] ${shadowWarning}`)
  // Probed once here rather than lazily per use: the audit's gap was that
  // nothing ever reported availability, only a spawn that failed much later.
  //
  // The network posture rides the same report. `resolveHostSandboxSettings` is
  // the one composition the supervisor enforces from, and it is called here
  // WITHOUT `onDiagnostic` on purpose: the session manager already warns each
  // unenforceable rule once per host, and a report must not log as a side
  // effect of being built (`host-sandbox-settings.ts`).
  const isolationCapabilities = await probeIsolationCapabilities({
    ...(options.windowsSandboxRuntime ? { windowsSandboxRuntime: options.windowsSandboxRuntime } : {}),
    network: resolveHostSandboxSettings(managedPiPolicy).network,
  })
  const credentialBackend = initializeCredentialManagerV2(layout)
  // P3.53 — the two exporters this plan asked about, and the row's premise is
  // narrower than it reads. Both are built ONCE, here, from `process.env`.
  //
  // The row asked whether a managed `OTEL_EXPORTER_OTLP_ENDPOINT` marked
  // `immediate` can arm one. `immediate` is OUR category name for
  // `server-managed-settings.md#fetch-and-caching-behavior`'s remainder rule —
  // "Every other key in the cached `env` block, such as telemetry and
  // OpenTelemetry configuration, applies at startup as before" — so the promise
  // it carries is a STARTUP promise, not a mid-session one, and that promise IS
  // kept: both hosts run `startManagedDeliveryEnvApplication` before
  // `createStorageRuntime` (pinned in
  // `bootstrap/__tests__/managed-settings-delivery.test.ts`), so a CACHED block
  // is in the environment before this line runs.
  //
  // What is genuinely uncovered, stated rather than implied, is the case where
  // the value is not in the cache when this line runs:
  //  - a FIRST launch with no cache, where the delivered block arrives on the
  //    sign-in hook or the hourly poll — i.e. after bootstrap. An administrator
  //    who also sets `forceRemoteSettingsRefresh` does not have this window:
  //    that gate awaits the fetch inside `startManagedSettingsDelivery`, above.
  //  - any later CHANGE to the endpoint, which reaches `process.env` and not
  //    these two objects until the next restart.
  // Both used to be restart-to-apply. They are not any more: `startOtlpRearming`
  // hands over a stable facade for each and swaps the delegate behind it when a
  // managed delivery changes the `immediate` slice of the environment. Read
  // `otlp-rearm.ts` for why a facade and not a rebuild — `SessionManager`
  // captures both as `private readonly`, so a rebuilt object would reach
  // nobody — and for why both are handed over UNCONDITIONALLY, which is what
  // covers the first-launch case.
  //
  // Per-runtime the asymmetry this closes ran the reassuring way and is worth
  // keeping in view: `resolveCodexOtelExport()` is read per spawn
  // (`codex-agent.ts`), so codex already picked up a changed endpoint on its
  // next session while these two did not until a restart.
  const otlp = await startOtlpRearming({
    buildPiTelemetry: () => createPiOtlpTelemetry(credentialBackend),
    buildUsageMetrics: () => createUsageMetrics(),
    // P6.882 — the span source joins the other two rather than being built
    // beside them. `createHostTracer` still answers `undefined` whenever tracing
    // is not opted into, so an unarmed facade is a no-op in every method.
    buildHostTracer: () => createHostTracer(),
    // Registered AFTER `startManagedDeliveryEnvApplication` (both hosts call it
    // before this function), so the snapshot it compares is the environment the
    // delivery has already been applied to.
    subscribe: listener => onManagedDeliveryChange(() => listener()),
  })
  const piTelemetry: PiOtlpTelemetry = otlp.piTelemetry
  const usageMetrics: UsageMetrics = otlp.usageMetrics
  // P6.732 built this beside the facade and P6.882 moved it inside: same
  // environment, same swap, and one place that decides what happens to a span
  // open when the endpoint changes.
  const hostTracer: HostTracer = otlp.hostTracer
  const pluginStore = createPluginStoreV2(layout)
  await pluginStore.pruneOnStartup()
  // D1.187 — the OTHER thing a hard kill leaves behind. The store's prune is
  // about placed bundles; this is about the staging directories under the OS
  // temp root that `releaseSessionScopedPlugins` removes on `deleteSession` and
  // on `cleanup()` — neither of which runs when the process is killed. Beside
  // the prune because it is the same startup and the same best-effort contract:
  // the sweep removes only a stage carrying OUR ownership marker whose owning
  // pid is gone, and it cannot throw.
  const sweptStages = await sweepAbandonedPluginStages()
  if (sweptStages > 0) {
    console.info(`[plugin-stage-sweep] removed ${sweptStages} abandoned staging director${sweptStages === 1 ? 'y' : 'ies'}`)
  }
  const capabilityPolicyStore = new CapabilityPolicyStore()
  const capabilityTrustStore = new CapabilityTrustStore()
  const runtimeDependencyInstaller = createPluginRuntimeDependencyInstaller(options.pluginRuntimeHost)
  const pluginManagement = new PluginManagementServiceV2({
    store: pluginStore,
    policyStore: capabilityPolicyStore,
    trustStore: capabilityTrustStore,
    credentialManager: credentialBackend,
    dpSessionBroker,
    dataLifecycle: {
      onPluginUninstall: ({ pluginKey }) => removePluginData(pluginKey),
    },
    ...(runtimeDependencyInstaller ? { runtimeDependencyInstaller } : {}),
  })
  // R3: bring-your-own registry controller. The factory (in @nessy-agent/shared)
  // composes a PluginMarketplaceRegistryStore (marketplaces.json) + a
  // PluginInstallService (the R1 governed staging seam — same Artifactory auth
  // path as plugin installs, NO new network client), both defaulting to
  // PLUGINS_DIR (the same root as the V2 store above). server-core never
  // constructs either class directly.
  // S9: `plugins/org.md#allowlist-with-strictknownmarketplaces`'s `strictKnownMarketplaces` reaches the one
  // component that adds and re-fetches marketplace sources. Undefined imposes no
  // restriction, so an unmanaged install is unchanged.
  // D13: `settings-reference.md#extraknownmarketplaces`'s `extraKnownMarketplaces`
  // ("Register additional plugin marketplaces by name, so that people who open the
  // repository, or everyone your managed settings reach, get the marketplace
  // without adding it themselves") reaches the same component,
  // so an administrator can SUPPLY the internal marketplace and not merely
  // permit it. Registration runs through the ordinary add path on first read, so
  // the restriction above still refuses a delivered source it does not admit.
  const marketplaceRegistrySource: MarketplaceRegistryController = createPluginRegistrySource({
    dpSessionBroker,
    ...(managedPiPolicy.strictKnownMarketplaces === undefined
      ? {}
      : { strictKnownMarketplaces: managedPiPolicy.strictKnownMarketplaces }),
    // P2.481: `blockedMarketplaces` reaches the same component, and until it did
    // the gate P2.467 built and proved had NO production feed — the parameter
    // existed and only tests set it. An unenforced blocklist fails OPEN, so this
    // line is the difference between an administrator's key blocking a source and
    // an administrator's key doing nothing at all.
    ...(managedPiPolicy.blockedMarketplaces === undefined
      ? {}
      : { blockedMarketplaces: managedPiPolicy.blockedMarketplaces }),
    ...(managedPiPolicy.extraKnownMarketplaces === undefined
      ? {}
      : { extraKnownMarketplaces: managedPiPolicy.extraKnownMarketplaces }),
    // `settings-reference.md#pluginsuggestionmarketplaces` — "A name takes effect
    // only when the marketplace is registered on the machine and its registered
    // source is also declared in the same managed settings, either as the
    // `extraKnownMarketplaces` entry for that name or as an entry of
    // `strictKnownMarketplaces`." The NAME allowlist
    // reaches the same component because that is where the source half of the
    // rule is decidable: only here are the registered rows, the delivered
    // entries and `strictKnownMarketplaces` all in scope at once.
    ...(managedPiPolicy.pluginSuggestionMarketplaces === undefined
      ? {}
      : { pluginSuggestionMarketplaces: managedPiPolicy.pluginSuggestionMarketplaces }),
    // P2.501 — the four lines above are the BOOT SNAPSHOT and stay as the
    // fallback; this is what the gates actually read. Until it existed, a
    // managed marketplace list edited while the app ran reached the gate only at
    // the next start, and an unenforced blocklist fails OPEN.
    //
    // `managed-settings.md#where-and-when-a-policy-applies` names the keys that
    // wait for a restart — `forceRemoteSettingsRefresh`,
    // `requiredMinimumVersion`, `policyHelper` — and none of these four is among
    // them; the file mechanism's own row reads "Read at startup and reloaded
    // when a file changes". So a restart here was ours, not the vendor's.
    //
    // The SAME `resolveEnforcedManagedPolicy` D4 uses, and the same shape the
    // three providers in `managed-policy-resolution.ts` use ("re-resolves on
    // every read"). NOT the session-time re-read: a marketplace add/install is
    // an action, not a turn, so this resolves where the check is.
    resolveManagedMarketplacePolicy: () => resolveEnforcedManagedPolicy().policy,
  })
  const marketplaceService = new MarketplaceService({
    pluginService: pluginManagement,
    registrySource: marketplaceRegistrySource,
    // `plugins/host-marketplace.md#run-release-channels` — "Claude Code lists the marketplace's tags".
    // The dependency step resolves a declared range against the marketplace
    // repository's `{plugin-name}--v{version}` tags; without this it would fall
    // back to whatever the catalog holds, which is `:137`'s documented
    // non-git behaviour and NOT what a git-backed marketplace promises.
    listRepositoryTags: repositoryUrl => listRepositoryTags(repositoryUrl, { dpSessionBroker }),
  })
  const marketplaceProposalRegistry = new MarketplaceProposalRegistry(); installProjectContextMirror() // UA5.5 — the host's one context.md mirror registration
  const invalidationListeners = new Set<(event: {
    scope: CapabilityInvalidationScope
    effect: CapabilityInvalidationEffectKind
    revokedLeaseIds: string[]; reason?: string // F1.493 (1) — the resolver's reason, carried to the host so a revoked turn can say why
  }) => void>()
  let workspaceService!: WorkspaceService
  const capabilityResolver = createCapabilityResolver({
    inputs: createCapabilityResolutionInputProviderV2({
      pluginStore,
      policyStore: capabilityPolicyStore,
      trustStore: capabilityTrustStore,
      credentialBackend,
      managedPiPolicy,
      managedPolicyEnvironment,
      // `plugins/loading.md#which-marketplaces-and-plugins-auto-update`'s READ half. The controller is passed as the
      // narrow `CachedMarketplaceCatalogReader`, so this per-turn path can only
      // ever peek at catalogs some other caller already resolved.
      marketplaceCatalogReader: marketplaceRegistrySource,
      nativeSourcesEnv: options.nativeSourcesEnv,
      resolveWorkspaceRootPath: workspaceId => {
        try {
          return workspaceService.resolve(workspaceId).workspaceRootPath
        } catch {
          return undefined
        }
      },
    }),
    onInvalidate: event => {
      for (const listener of invalidationListeners) {
        listener({ scope: event.scope, effect: event.effect, revokedLeaseIds: event.revokedLeaseIds, reason: event.reason }) // F1.493 (1)
      }
    },
  })
  const unsubscribeCatalogInvalidation = onCapabilityCatalogInvalidation(event => {
    capabilityResolver.invalidate(event.scope, event.reason, event.effect, event.pluginKey) // F1.766 — a plugin-named revoke reaches only the leases holding it
  })
  const unsubscribeCapabilityInvalidation = onCapabilityInvalidation(event => {
    // Plugin mutations also emit the richer W8 catalog invalidation below;
    // consume that once rather than revoking/refreshing the same lease twice.
    if (event.kind === 'plugin') return
    capabilityResolver.invalidate(
      event.scope.kind === 'project' && event.scope.projectKey
        ? { kind: 'project', workspaceId: event.scope.workspaceId, projectKey: event.scope.projectKey }
        : event.scope.kind === 'workspace'
          ? { kind: 'workspace', workspaceId: event.scope.workspaceId }
          : { kind: 'global' },
      `capability.${event.kind}.changed`,
      'refresh-before-next-turn',
    )
  })
  const projectHandleService = new ProjectHandleService()
  const recentProjectStore = new RecentProjectStore(layout)
  const workspaceQuiescence = new WorkspaceQuiescenceCoordinator()
  workspaceService = createWorkspaceService({
    credentialManager: credentialBackend,
    remoteGateway: options.remoteGateway,
    quiescence: workspaceQuiescence,
    defaultProjectResolver: {
      getProject: async (workspaceId, stored) => {
        try {
          const issued = await projectHandleService.validateProjectDirectory(
            workspaceId,
            stored.workingDirectory,
          )
          const project = await projectHandleService.resolveHandle({
            workspaceId,
            projectHandleId: issued.id,
          })
          if (stored.projectKey && project?.projectKey !== stored.projectKey) return null
          return project ? {
            handleId: issued.id,
            name: basename(project.displayPath),
            trusted: project.trustDecision === 'trusted',
          } : null
        } catch {
          return null
        }
      },
    },
    cleanupParticipants: [
      createPluginDataCleanupParticipant(),
      capabilityPolicyStore.cleanupParticipant(),
      capabilityTrustStore.cleanupParticipant(),
      recentProjectStore.cleanupParticipant(),
    ],
  })
  // Retire plaintext credential artifacts before any session/plugin process can
  // start. Current runtimes read only the encrypted credential store.
  await workspaceService.list()
  const adapterMigration = await migrateOutdatedPluginAdaptersOnStartup({
    store: pluginStore,
    trustStore: capabilityTrustStore,
  })
  for (const diagnostic of adapterMigration.diagnostics) {
    const message = `[plugin-adapter-migration] ${diagnostic.code}: ${diagnostic.message}`
    if (diagnostic.severity === 'info') console.info(message)
    else console.warn(message)
  }
  for (const workspace of workspaceService.listResolved()) {
    deleteLegacySourceCredentialCaches(workspace.workspaceRootPath)
  }
  // T5 (owner § 0b-1): one-shot move of connector-source credentials from
  // per-workspace `source_oauth::{ws}::{slug}` rows to the global slot.
  // Idempotent — a store with no workspace-scoped connector rows is a no-op.
  try {
    await migrateConnectorSourceCredentialsToGlobal({
      workspaceRootPaths: workspaceService.listResolved().map(workspace => workspace.workspaceRootPath),
    })
  } catch (error) {
    console.warn(`[connector-credentials] global-slot migration failed; will retry next startup: ${error instanceof Error ? error.message : String(error)}`)
  }
  // C4 (capability-path, ADR § 2): COPY T5's global connector rows into the
  // plugin MCP slots. Runs AFTER the T5 collapse (same startup) so a machine
  // skipping releases still migrates in one pass. Copy-only + copy-if-absent:
  // never deletes or overwrites a source row, never clobbers a refreshed
  // plugin slot, idempotent with no marker, and NEVER throws on this path —
  // a failed row is retried next launch while the old rows stay authoritative.
  try {
    const registry = await pluginStore.readInstalledRegistry()
    await migrateConnectorCredentialsToPluginSlots({
      activePluginKeys: new Set(Object.keys(registry.active)),
      log: message => console.info(message),
    })
  } catch (error) {
    console.warn(`[plugin-mcp-migration] slot migration failed; will retry next startup: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    sessionStore: createSessionStore(layout),
    pluginStore,
    pluginManagement,
    marketplaceService,
    marketplaceRegistrySource,
    marketplaceProposalRegistry,
    capabilityPolicyStore,
    capabilityTrustStore,
    credentialManager: credentialBackend,
    capabilityResolver,
    projectHandleService,
    recentProjectStore,
    workspaceService,
    workspaceQuiescence,
    managedPiPolicy,
    // D4: the same function this boot snapshot came from, so the enforced value
    // and the re-read can never be composed by two different code paths.
    resolveManagedPiPolicy: () => resolveEnforcedManagedPolicy().policy,
    subscribeManagedPolicyChange: listener => onManagedDeliveryChange(() => { listener() }),
    managedPiPolicyDrops,
    managedPiPolicyCaveats,
    isolationCapabilities,
    dpSessionBroker,
    // Always present now, and inert until a delegate exists. The conditional
    // spread these lines replaced is exactly what made a first launch with no
    // cache unfixable: the session manager was handed `undefined` and there was
    // nothing left to arm.
    piTelemetry,
    usageMetrics,
    // P6.882 — unconditional now, for the reason the two lines above give: a
    // facade handed over only when tracing is already on could never be armed by
    // a later delivery.
    hostTracer,
    resolveRuntimeCredential: binding => credentialBackend.resolveRuntimeCredential(binding),
    onCapabilityInvalidation(listener) {
      invalidationListeners.add(listener)
      return () => invalidationListeners.delete(listener)
    },
    dispose() {
      unsubscribeCatalogInvalidation()
      unsubscribeCapabilityInvalidation()
      invalidationListeners.clear()
    },
  }
}

export interface CapabilityInputsV2Deps {
  resolveWorkspaceRootPath: (workspaceId: string) => string | undefined
  nativeSourcesEnv?: NativeSourcesEnv
  pluginStore: PluginStoreV2
  /**
   * D1.69 test seam: which session-lifetime plugins this context carries.
   * Production omits it and the host-wide register answers, which is how the
   * resolver — built in this file before any `SessionManager` exists — reads
   * what `SessionManager.createSession` wrote without either composition root
   * having to thread a parameter between them.
   */
  sessionPluginOverlay?: (sessionId: string | undefined) => readonly SessionScopedPlugin[]
  policyStore: CapabilityPolicyStore
  trustStore: CapabilityTrustStore
  credentialBackend: Pick<CredentialManager, 'bind' | 'getRuntimeCredentialStatus'>
    & Partial<Pick<CredentialManager, 'get'>>
  resolveSessionMemoryFilePath?: (workspaceId: string, sessionId: string) => string
  /** Required by production composition; omitted test callers use the built-in policy. */
  managedPiPolicy?: ManagedPiPolicyV1
  /**
   * The PINNED environment a managed MCP policy entry expands from — P2.396,
   * `managed-mcp.md#how-policy-entries-expand`: "A policy entry expands from a
   * pinned environment instead, so a variable set by a project or user settings
   * file can't change what an allowlist entry means."
   *
   * Composed once in `createStorageRuntime` from the startup snapshot and the
   * managed `env` block. Threaded rather than read here, because this function
   * runs once per turn and a snapshot taken per turn pins nothing.
   *
   * Omitted callers keep the pre-P2.396 live-environment behaviour, which is
   * what every test that does not care about expansion wants.
   */
  managedPolicyEnvironment?: Record<string, string | undefined>
  /** Injectable environment for the safe-mode gate; production reads `process.env`. */
  safeModeEnv?: Record<string, string | undefined>
  /** Already-loaded `config.json` for the `disableBundledSkills` setting. */
  storedConfig?: unknown
  /** Injectable environment for the bundled-skills switch; production reads `process.env`. */
  bundledSkillsEnv?: Record<string, string | undefined>
  /** Test seam for the bundled-skill source/managed roots; production resolves both. */
  bundledSkillRoots?: { bundledRoot?: string; skillsRoot?: string }
  /**
   * Cached-only marketplace catalog reader for `availableUpdateVersion`
   * (`plugins/loading.md#which-marketplaces-and-plugins-auto-update`). Optional/additive: with no reader the field is
   * simply never produced and `actions.canUpdate` stays false, which is the
   * behaviour every pre-existing caller already had.
   *
   * It MUST be a peek. This function runs once per turn, so anything that
   * fetches, retries or writes here does so per turn — see
   * `PluginRegistrySource.peekCachedItems` for the three side effects
   * `listItems()` would have brought with it.
   */
  marketplaceCatalogReader?: CachedMarketplaceCatalogReader
}

const EMPTY_INVENTORY: NativeCapabilityInventory = { records: [], blockedLayers: [] }

/**
 * Safe mode's ENTIRE production decision point (`config/safe-mode.ts`).
 *
 * `env-vars.md:318` names eleven-plus surfaces that must not load. This
 * function is the one funnel every one of them is discovered through, so the
 * switch is applied to the INPUTS rather than to each loader: with no records
 * and no plugins there is nothing for the resolver to resolve, and every
 * projection built from the snapshot (`toAgentRuntime`, `toUserCatalog`,
 * `toComposerCatalog`) is empty by construction. A capability KIND added
 * tomorrow is covered on the day it is added, because it has no record to be
 * resolved from — which a scatter of per-loader `if`s could not promise.
 *
 * Managed policy is deliberately NOT read here. `managedPiPolicy` only ever
 * RESTRICTS discovered records, and the permission rules an organization
 * relies on are resolved by `managed-policy-resolution.ts` on a different path
 * entirely. So a managed deny still denies under safe mode, while managed
 * plugins, managed skills and policy-configured MCP servers do not load — the
 * exact asymmetry the doc line states.
 */
const SAFE_MODE_INPUTS: CapabilityResolutionInputs = Object.freeze({
  nativeInventory: EMPTY_INVENTORY,
  installedPlugins: [],
  activePluginInstances: {},
  pluginCandidates: [],
  resolveActivation: () => ({ enabled: false, suppressed: false, capabilities: {} }),
  resolveTrust: () => 'not-required' as const,
})

/**
 * A plugin MCP candidate's identity for the managed lists.
 *
 * The normalized bundle descriptor already carries the transport, URL and
 * command, so a plugin server is matched on what it actually starts rather than
 * on the `serverName` its manifest chose. Values go through UNEXPANDED — the
 * matcher expands both sides itself (`managed-mcp.md:176`).
 */
function pluginMcpServerIdentity(
  candidate: PluginProjectionCandidate,
): ManagedMcpServerIdentityV1 {
  const mcp = candidate.runtimeDefinition?.kind === 'mcp' ? candidate.runtimeDefinition.mcp : undefined
  return {
    name: candidate.logicalName,
    ...(mcp?.transport ? { transport: mcp.transport } : {}),
    ...(mcp?.url ? { url: mcp.url } : {}),
    ...(mcp?.command ? { command: [mcp.command, ...(mcp.args ?? [])] } : {}),
  }
}

/**
 * Capability-key prefix of the built-in dp-backed MCP set (A7).
 *
 * Collision-free against every key shape already in use: plugin capabilities are
 * `<pluginKey>#<capabilityId>`, native sources are `source:workspace:<ws>:<slug>`,
 * and nothing else produces a `builtin:`-scoped record.
 */
const BUILTIN_DP_MCP_KEY_PREFIX = 'builtin:mcp:'

/**
 * The built-in dp-backed MCP set (A7) as ORDINARY capability records.
 *
 * Owner decision 2026-08-01: "нам нужно общее поведение для всего, единственное
 * отличие это то что они встроены" — a built-in must behave like every other
 * capability, and being built in is the only difference. Projecting the set here
 * is what makes the MCP row clickable, the detail page real, the tools section
 * work and the metadata table honest, with no second screen: everything
 * downstream already keys off a capability key.
 *
 * Three things this projection deliberately does NOT do.
 *
 * 1. **It does not change the WRITE path.** Enablement still persists through
 *    `setBuiltinDpMcpServerEnabled` into `config.json`'s `builtinDpMcpServers`
 *    key; this is a READ-side mirror of that key. A capability policy record is
 *    a different mechanism with a different lifetime, and routing the switch
 *    through `set-capability-enabled` would write the wrong file.
 * 2. **It never resolves or runs `dp`.** Availability ("dp is not installed") is
 *    a filesystem lookup that belongs to `readBuiltinDpMcpSettingsView`, which
 *    the MCP list already reads over RPC; doing it here would put a PATH scan on
 *    every capability resolve — and every turn resolves.
 * 3. **It does not apply the managed MCP policy ITSELF** — its CALLER does, and
 *    the distinction is what keeps this function's contract (the whole set, as
 *    the preference describes it) separate from what a given resolve is allowed
 *    to show. Until P2.368 the set was not filtered anywhere at all, and the
 *    reason recorded here was sound as far as it went: the runtime fold that
 *    actually starts these servers
 *    (`mcp/runtime-pool-servers.ts:foldBuiltinDpMcpServers`) read the preference
 *    key directly and applied no managed policy, so filtering the mirror alone
 *    would have hidden a row while its server still started — a display lie, and
 *    exactly the "enforcement one layer up" trap. The owed work landed in the
 *    FOLD, so the mirror may now follow it, and both match on the SAME identity:
 *    `mcpServerIdentity` carries the logical `dp ai mcp <sub>` argv, which
 *    `builtinDpMcpServerIdentity` is the single definition of. Resolving dp here
 *    to match on the absolute path is still forbidden — see (2).
 */
export function builtinDpMcpCapabilityRecords(storedConfig: unknown): NativeCapabilitySourceRecord[] {
  const enabled = parseBuiltinDpMcpSettingsV1(
    (storedConfig as { builtinDpMcpServers?: unknown } | null | undefined)?.builtinDpMcpServers,
  ).enabled ?? {}
  return BUILTIN_DP_MCP_SERVERS.map(definition => {
    // Identity of the DEFINITION, not of a file: there is no document on disk
    // to stat, and the set only moves when the app ships a new one. It still
    // has to move then, or a pinned snapshot keeps serving a renamed server.
    const contentHash = createHash('sha256')
      .update(`${definition.name}\u0000${definition.subcommand}\u0000${definition.description}`)
      .digest('hex')
    return {
      key: `${BUILTIN_DP_MCP_KEY_PREFIX}${definition.name}`,
      kind: 'mcp' as const,
      scope: { kind: 'builtin' as const },
      logicalName: definition.name,
      description: definition.description,
      // Server-only, and the source of the row's `stdio` transport badge. The
      // command is the LOGICAL argv; the runtime substitutes the resolved
      // absolute dp path, which this projection never looks up.
      mcpServerIdentity: {
        transport: 'stdio' as const,
        command: ['dp', 'ai', 'mcp', definition.subcommand],
      },
      // The effective state, from the same preference the pools fold with —
      // never a second source of truth.
      sourceEnabled: isBuiltinDpMcpServerEnabled(definition.name, enabled),
      sourcePath: '',
      revision: contentHash,
      contentHash,
      // Nothing about a built-in is editable in place.
      mutable: false,
    }
  })
}

/** Gather one immutable resolver input snapshot from verified-v2 stores. */
export async function buildCapabilityResolutionInputsV2(
  context: CapabilityContext,
  deps: CapabilityInputsV2Deps,
): Promise<CapabilityResolutionInputs> {
  // The single safe-mode gate. Placed before every read so a compromised
  // plugin bundle, skill or `.mcp.json` is not even opened, let alone resolved.
  if (isSafeModeEnabled(deps.safeModeEnv ?? process.env)) return SAFE_MODE_INPUTS
  const managedPiPolicy = deps.managedPiPolicy ?? DEFAULT_MANAGED_PI_POLICY
  // P2.396. One options object, built once, handed to every managed-MCP gate
  // below — the four call sites are the whole of this process's use of that
  // gate outside `mcp/runtime-pool-servers.ts`, and building it per call site
  // is how three of them would end up pinned and the fourth would not.
  //
  // An ABSENT snapshot is spelled as an empty options object rather than as
  // `{ policyEnvironment: undefined }` so the gate's own default applies: the
  // field is optional-by-omission there, and passing the key with `undefined`
  // would read as "pinned to nothing" to anyone skimming.
  const managedMcpGateOptions = deps.managedPolicyEnvironment === undefined
    ? {}
    : { policyEnvironment: deps.managedPolicyEnvironment }
  // Does this resolve serve a RUNTIME turn, or the provider-neutral browse?
  //
  // P2.314. This read `context.provider === 'pi'`, so the managed narrowing
  // below — the managed MCP denylist/allowlist and the managed plugin
  // allow/deny lists — lapsed on every other runtime: a claude-runtime or
  // codex-runtime session resolved its capabilities with an administrator's MCP
  // and plugin restrictions not applied at all.
  // `managed-mcp.md#how-a-server-is-evaluated` is unconditional about the
  // denylist — "A server that matches any denylist entry, by URL, command, or
  // name, is blocked. Nothing overrides a denylist match." — and a per-provider
  // early return is an override.
  //
  // The gate was never a decision about what a runtime CAN honour. This filter
  // is host-side and runs before any runtime exists, over the same snapshot all
  // four providers consume, so there is nothing here that only the Pi harness
  // can apply; it was Pi-era scope (`managedPiPolicy` still carries the name)
  // pinned by a characterization test rather than reasoned about.
  //
  // What survives is that provider-neutral BROWSE still LISTS what the policy
  // denies. `CapabilityContext.provider` is "omitted for provider-neutral
  // catalog/browse resolution", and
  // `workspace-mcp-pool-registry.ts:buildResolveContext` omits it in terms
  // ("browse is provider-neutral"). A catalog that silently dropped a denied row
  // would reproduce what `managed-mcp.md#how-restrictions-appear-to-users`
  // records as the outcome — "The server silently disappears from `/mcp` and
  // `claude mcp list` with no warning" — with no surface left to explain it.
  //
  // Read that page carefully, because P2.351 was created by reading it loosely:
  // the sentence is a DESCRIPTION of what Claude Code does under a denylist, in
  // a table telling administrators what their users will see, not a rule saying
  // the row must be kept. Keeping it is our own decision and a strict
  // improvement on the documented behaviour — it is NOT a licence to leave a
  // denied record otherwise untouched, which is precisely the mistake this gate
  // used to make (see the managed-MCP filter below).
  //
  // P2.351 also measured the limit of what this buys: the catalog RPC resolves
  // WITH a provider whenever the ref carries a `sessionId`
  // (`domain/capabilities/context.ts` sets `provider` on both session-bearing
  // exits), so once a session is selected the row is already dropped outright
  // and only the session-less workspace read still lists it. Separating catalog
  // from agent on a provider-BEARING context would need a discriminator this
  // context does not have.
  //
  // So the distinction this gate needed was RUNTIME TURN vs BROWSE, never Pi vs
  // everything — and "browse" means unnarrowed LISTING, never unnarrowed
  // execution.
  //
  // Two neighbours already made this trip and are not re-litigated here: the
  // managed hook kill switches (`disableAllHooks`, `allowPluginHooks`) moved to
  // `buildPinnedAgentAutomationSystem`, which reads the floor
  // runtime-independently (P2.206), and managed ACTIVATION is applied for every
  // provider and for the catalog too (see `resolveActivation` below for why).
  const isRuntimeCapabilityTurn = context.provider !== undefined
  const workspaceRootPath = deps.resolveWorkspaceRootPath(context.workspaceId)
  const discoveredNativeInventory = workspaceRootPath
    ? buildNativeCapabilityInventory(
        toWorkspacePolicyContext(
          context,
          workspaceRootPath,
          deps.resolveSessionMemoryFilePath ?? getSessionMemoryFilePath,
        ),
        {
          // The administrator skill roots. P2.461 made this field REQUIRED on
          // `NativeSourcesEnv` precisely so that this — the ONE caller in the
          // tree that wants the machine's own roots — has to say so, and every
          // other caller (all of them rigs) has to say what it wants instead of
          // silently inheriting a machine-wide directory. It is written ABOVE
          // the spread so an injected `nativeSourcesEnv` still wins.
          adminSkillsDirs: getAdminAgentSkillsDirs(),
          ...(deps.nativeSourcesEnv ?? {}),
          // The MANAGED scope of `claudeMdExcludes` (`large-codebases.md:155`:
          // "You can set `claudeMdExcludes` at any settings scope: user,
          // project, local, or managed. Arrays merge across scopes"). Only this
          // caller knows which managed source won the composition, so the
          // resolver in `agent/memory/instruction-excludes.ts` takes the value
          // instead of reading it. An explicit seam value still wins.
          managedInstructionExcludes: deps.nativeSourcesEnv?.managedInstructionExcludes
            ?? managedPiPolicy.claudeMdExcludes,
        },
      )
    : EMPTY_INVENTORY
  const enabledSourceNames = new Set(context.enabledSourceNames ?? [])
  const registry = await deps.pluginStore.readInstalledRegistry()
  const selectedScope = selectedCapabilityScope(context), mainCheckoutProjectKey = context.projectKey ? await resolveMainCheckoutProjectKey(context.projectRoot) : undefined // F1.11 — a linked worktree's plugin ACTIVATION reads its main checkout's project records first; trust stays per directory
  const allByInstance = new Map(registry.plugins.map(entry => [entry.pluginInstanceId, entry]))
  const storeActiveEntries = Object.values(registry.active)
    .map(instanceId => allByInstance.get(instanceId))
    .filter((entry): entry is PluginInstalledEntryV2 => entry !== undefined)
    .sort((a, b) => a.pluginInstanceId.localeCompare(b.pluginInstanceId))
  // D1.69 — this session's own plugins, merged at the ONE point that makes them
  // ordinary. Everything below derives from `activeEntries`: the projection
  // candidates, the managed plugin allow/deny gate, per-scope activation,
  // trust. Merging here and not later is what makes a session plugin subject to
  // exactly the same managed policy as an installed one — a managed denial must
  // not be escapable by starting a session with the bundle instead of
  // installing it. A `pluginKey` match SHADOWS the installed copy for this
  // resolve; see `plugins/session-scoped.ts` for why the key is the whole rule.
  const sessionPlugins = (deps.sessionPluginOverlay ?? sessionScopedPluginsFor)(context.sessionId)
  const storeInstanceIds = new Set(storeActiveEntries.map(entry => entry.pluginInstanceId))
  const sessionPluginRootPaths = sessionScopedInstanceIds(sessionPlugins)
  const activeEntries = mergeSessionScopedPlugins(storeActiveEntries, sessionPlugins)
  const trustedProjectOverlay = buildTrustedProjectPolicyOverlay(context, activeEntries)
  const byInstance = new Map(activeEntries.map(entry => [entry.pluginInstanceId, entry]))
  const byKey = new Map(activeEntries.map(entry => [entry.pluginKey, entry]))
  // `settings-reference.md#disablebundledskills` — "Claude Code removes bundled
  // skills and workflows entirely", which has to
  // cover the copies a previous run seeded into the managed skills root. Each
  // copy is an ordinary directory carrying no marker of its own, so they are
  // matched by the pair (bundled slug, exact managed-root path): a plugin skill,
  // a project skill and a user skill of the same slug in any other root all
  // survive, which is the doc's "Skills from plugins, `.claude/skills/`, and
  // `.claude/commands/` are unaffected".
  //
  // P3.208(b) — this comment used to say the copies carry no marker AT ALL, as
  // the reason the pair is the only available identity. That stopped being true
  // with P2.281 (`57ca0ef1b`): the seed now leaves `.bundled-skill-seed.json` at
  // the ROOT of this directory, naming per slug whether the content is ours
  // (`skills`) or the user's (`customized`). The pair is still what all three
  // consumers below match on — the receipt widens the SLUG half of it rather
  // than adding a second identity; see the union at `isSeededBundledSkill`, and
  // `capabilities/types.ts:skillTier` for the half deliberately left undone.
  const seededSkillsRoot = deps.bundledSkillRoots?.skillsRoot ?? getManagedSkillsRoot()
  // ONE `config.json` read per resolve, shared by the bundled-skills switch and
  // the built-in dp MCP preferences. Memoized rather than eager so the
  // bundled-skills env short-circuit still avoids the read when nothing else
  // needs it — and so two readers can never disagree within one snapshot.
  let storedConfigValue: unknown
  let storedConfigRead = false
  const readStoredConfig = (): unknown => {
    if (!storedConfigRead) {
      storedConfigValue = deps.storedConfig !== undefined ? deps.storedConfig : loadStoredConfig()
      storedConfigRead = true
    }
    return storedConfigValue
  }
  // The env half is checked first so the settings file is not read at all when
  // an operator already turned the switch on from the environment.
  const bundledSkillsOff = bundledSkillsDisabledByEnv(deps.bundledSkillsEnv ?? process.env)
    || bundledSkillsDisabledBySetting(readStoredConfig())
  // `settings-reference.md#strictpluginonlycustomization-skills` — under a locked
  // `skills` surface Claude Code "keeps loading plugin skills, bundled skills, and
  // skills in the managed policy directory", so bundled skills are on the
  // still-loads side and the same pair (bundled slug, exact seeded root path)
  // that the bundled-skills switch DROPS is what the origin lock KEEPS.
  // One memoized read serves both, and neither reader pays the `readdir` when
  // nothing asks: the switch short-circuits on `bundledSkillsOff` and the lock is
  // consulted only for a skill record while `strictSkillsLocked`.
  //
  // R78 added a THIRD reader — the `skillTier` stamp below — which unlike those
  // two asks about every skill record on every resolve. That is why the cheap
  // path gate exists inside this predicate rather than at the new call site: a
  // record outside the seeded root can never be a seeded bundle, so the gate is a
  // strict superset of the set membership below and can produce no false
  // negative, while keeping the `readdir` off the common path (a project- or
  // workspace-only skill catalog never triggers it).
  let seededBundledSkillPaths: Set<string> | undefined
  const isSeededBundledSkill = (record: NativeCapabilityInventory['records'][number]): boolean => {
    if (record.kind !== 'skill') return false
    // `skillRecords` sets `sourcePath` to the slug DIRECTORY; the second arm
    // covers a record pointed at the `SKILL.md` inside it. Both arms below match
    // the two `has(...)` checks exactly.
    const parent = dirname(record.sourcePath)
    if (parent !== seededSkillsRoot && dirname(parent) !== seededSkillsRoot) return false
    // TWO sources, unioned — P3.208(a). The bundle answers what it SHIPS today;
    // the seed receipt answers what THIS PROFILE holds because we wrote it
    // (`skills`, one entry per slug we seeded, refreshed or adopted). A slug an
    // older bundle seeded and the current one no longer ships is in the second
    // and not the first, and it was invisible to all three consumers of this
    // predicate at once: the off-switch would not remove it — against
    // `settings-reference.md#disablebundledskills`'s "removes bundled skills and
    // workflows entirely" — the origin lock would not keep
    // it, and untagged it OUTRANKED a project skill of the same name, which is
    // the inversion `capabilities/types.ts:skillTier` exists to prevent.
    //
    // A UNION rather than a replacement, and that is the whole safety argument:
    // it can only ADD a slug, never withdraw one, so a profile that has not yet
    // run a post-P2.281 seed reads an empty receipt and behaves exactly as
    // before. Replacing the bundle list with the receipt would have regressed
    // that entire installed base to no stamps at all.
    //
    // `receipt.customized` is deliberately NOT read. It is informational by its
    // own contract ("never read back into the update decision"), it is a plain
    // file in the user's profile, and reading it would make skill alias
    // precedence editable by hand. Reading only `skills` keeps the question
    // "did WE write this" answerable from content we recorded writing.
    seededBundledSkillPaths ??= new Set([
      ...bundledSkillSlugs(deps.bundledSkillRoots?.bundledRoot
        ? { bundledRoot: deps.bundledSkillRoots.bundledRoot }
        : {}),
      ...Object.keys(readBundledSkillSeedReceipt(seededSkillsRoot).skills),
    ].map(slug => join(seededSkillsRoot, slug)))
    return seededBundledSkillPaths.has(parent)
      || seededBundledSkillPaths.has(record.sourcePath)
  }
  // `settings-reference.md#strictpluginonlycustomization` — "Block skills,
  // agents, hooks, and MCP servers from user and project sources, so they can
  // come only from plugins or managed settings" — resolved once
  // per snapshot. `hooks` is deliberately absent from this list: it rides the
  // `allowManagedHooksOnly` gate in `SessionManager.buildAgentAutomationSystem`,
  // which drops the hooks while still reading the same document's
  // `disableAllHooks` key — a record dropped here would lose that read too.
  const strictSkillsLocked = isStrictPluginOnlyCustomizationLocked(managedPiPolicy, 'skills')
  const strictAgentsLocked = isStrictPluginOnlyCustomizationLocked(managedPiPolicy, 'agents')
  const strictMcpLocked = isStrictPluginOnlyCustomizationLocked(managedPiPolicy, 'mcp')
  // P2.351 — native records the BROWSE resolve keeps for the catalog but must
  // never let run. Filled by the managed-MCP gate below and consumed by the
  // `sourceEnabled: false` stamp in the record map; empty on every runtime turn,
  // where a denied record is dropped outright instead.
  const browseDeniedMcpRecordKeys = new Set<string>()
  const discoveredRecords = discoveredNativeInventory.records.filter(record => {
    if (bundledSkillsOff && isSeededBundledSkill(record)) return false
    // C5 (capability-path): connector-origin SOURCE records never serve —
    // their servers project as capability-path mcp candidates
    // (`resolvePluginProjectionCandidates`), reading the migrated plugin
    // slots. The materialized directories stay on disk as rollback material.
    if (record.connectorOrigin) return false
    // `settings-reference.md#strictpluginonlycustomization` — "Block skills,
    // agents, hooks, and MCP servers from user and project sources, so they can
    // come only from plugins or managed settings." Each sub-key then spells its
    // own surface; `#strictpluginonlycustomization-skills` is the one this
    // predicate is closest to: "Claude Code stops loading skills from
    // `~/.claude/skills/` and `.claude/skills/`, custom commands from
    // `~/.claude/commands/` and `.claude/commands/`, skills under `--add-dir`
    // directories, and skills synced from your claude.ai account". The rule this
    // comment quoted for it — one sentence about skipping user-level and
    // project-level sources for each locked surface — is on no Claude page in
    // those words any more (checked 2026-09-10), so it is restated from the
    // entries that carry it rather than re-anchored.
    // Every scope but `builtin` here is a user-controlled tier:
    // `<CONFIG_DIR>` is the user's own config dir, the workspace root is theirs,
    // and the project tier is admitted by a per-USER trust prompt — which is the
    // decision this administrator key exists to take away. The three are named
    // rather than expressed as `!== 'builtin'` so a scope kind added later is
    // classified deliberately instead of being locked by accident.
    //
    // Placed BEFORE the browse early return below on purpose. That gate used to
    // read `provider === 'pi'`, which is why the managed MCP lists lapsed on a
    // Claude or Codex turn until P2.314; an ORIGIN lock that silently lapses per
    // provider is the "declared on one path, enforced on another" defect this
    // policy keeps guarding against, and placing it here means the lock never
    // depended on that gate being right.
    if (record.scope.kind === 'global' || record.scope.kind === 'workspace' || record.scope.kind === 'project') {
      // `:1185` keeps three things under a locked `skills`: plugin skills, which
      // ride `pluginCandidates` and never enter this list; skills in the managed
      // policy directory, which we carry none of (`config/managed-approval.ts:16`
      // records that our admin channel distributes no components); and bundled
      // skills, which ARE native records. So the seed is the one exemption this
      // filter needs.
      if (strictSkillsLocked && record.kind === 'skill' && !isSeededBundledSkill(record)) return false
      if (strictAgentsLocked && record.kind === 'agent') return false
      // `:1188`'s blocked column is "Servers in `~/.claude.json` and `.mcp.json`"
      // — user-scope and project-scope MCP configuration. Ours arrives as both an
      // `mcp` record (a `mcp.json`/`.mcp.json` entry) and an MCP Source, so both
      // are dropped; plugin MCP servers ride `pluginCandidates` and are untouched.
      if (strictMcpLocked && (record.kind === 'mcp' || record.sourceType === 'mcp')) return false
    }
    // `managed-mcp.md#match-servers-by-url-command-or-name` — the name "is not
    // a security control … To enforce which servers actually run, add
    // `serverCommand` or `serverUrl` entries." `mcpServerIdentity` is pinned by
    // the inventory for exactly this, so a denied server cannot escape by being
    // renamed.
    //
    // P2.351 — this runs for the BROWSE resolve too, and used to sit behind an
    // `if (!isRuntimeCapabilityTurn) return true` early return. That carve-out
    // was not inert. The browse resolve is what
    // `WorkspaceMcpPoolRegistry.runSync` drives (`buildResolveContext` omits the
    // provider in terms), and a session start is one of its NEEDs
    // (`SessionManager.maybeConnectSourcesAtSessionStart`, default-on), so a
    // denied record survived into `materializeRuntimePoolServers` →
    // `pool.sync` → `reconcileUnion` → `connectOnce` and the server was SPAWNED
    // on the host with its configured `env` and headers. Per-leaser call
    // authorisation kept the MODEL from invoking it, which is why this looked
    // contained; it never touched host-side execution or credential exposure.
    // `#how-a-server-is-evaluated` is unconditional and pre-load: "Before
    // loading a server … A server that matches any denylist entry, by URL,
    // command, or name, is blocked. Nothing overrides a denylist match."
    //
    // What the carve-out was PROTECTING survives, because listing and spawning
    // are separable here without a new seam: on browse the record is KEPT (so
    // the catalog still shows the row rather than reproducing
    // `#how-restrictions-appear-to-users`'s "The server silently disappears
    // from `/mcp` and `claude mcp list` with no warning") and stamped
    // `sourceEnabled: false` below, which the resolver turns into
    // `enabled: false` and `views.ts:isRunnable` then keeps out of
    // `toAgentRuntime` — the only door to the pool. Listed, and unrunnable.
    //
    // The two arms are ONE condition rather than the two sequential `if`s this
    // replaced: they always called the predicate with identical arguments, and
    // splitting them is what let a re-break assertion pass with either arm
    // deleted (`expect.not.toEqual(arrayContaining([a, b]))` is satisfied by
    // one absence).
    if (record.kind === 'mcp' || record.sourceType === 'mcp') {
      if (!isManagedMcpServerAllowed(managedPiPolicy, {
        name: record.logicalName,
        ...record.mcpServerIdentity,
      }, undefined, managedMcpGateOptions)) {
        if (isRuntimeCapabilityTurn) return false
        browseDeniedMcpRecordKeys.add(record.key)
      }
    }
    return true
  })
  // A7 (option A): the built-in dp set joins the SAME record list, so every
  // reader downstream — catalog, detail page, MCP tools, runtime view — treats
  // it as an ordinary capability. Appended AFTER the discovered records so a
  // record actually on disk keeps its position; see
  // `builtinDpMcpCapabilityRecords` for what this projection deliberately does
  // not do (managed policy, dp resolution, and the write path).
  //
  // `skills.md:663` — per-skill visibility from SETTINGS instead of the skill's
  // own frontmatter, merged local > project > user. Resolved lazily, and only
  // when a skill record actually exists: an override map is pointless without
  // one, and the two `.claude/settings*.json` reads must not become a cost every
  // workspace pays on every resolve. The user leg rides the SAME memoized
  // `readStoredConfig()` the bundled-skills switch uses — see its comment above
  // for why a second config read is not acceptable here.
  let skillOverridesValue: ReturnType<typeof resolveSkillOverrides> | undefined
  const readSkillOverrides = (): ReturnType<typeof resolveSkillOverrides> => {
    skillOverridesValue ??= resolveSkillOverrides({
      userConfig: readStoredConfig(),
      ...(context.workingDirectory ? { workingDirectory: context.workingDirectory } : {}),
      projectTrusted: context.projectTrustState === 'trusted',
    })
    return skillOverridesValue
  }
  const nativeInventory: NativeCapabilityInventory = {
    ...discoveredNativeInventory,
    records: [
      // A `.map()`, NOT a widening of the filter above: an overridden skill has
      // to stay in the catalog so the Skills list can still show it and take the
      // override back off, and a filter predicate is the wrong place to mutate a
      // record from. Only NATIVE records pass through here — plugin skills
      // arrive via `pluginCandidates` below, which is how `skills.md:689`
      // ("Plugin skills are not affected by `skillOverrides`") holds by
      // construction. `'on'` is left UNSTAMPED: it is the documented default for
      // an absent name (`skills.md:678`), so writing it would move the
      // capability generation for every skill in the catalog and say nothing.
      //
      // R78 rides the SAME map with a second conditional stamp. `skills.md:122`
      // — "A skill at any of these levels also overrides a bundled skill with the
      // same name" — cannot be honoured by scope alone here, because
      // `ensureBundledSkills` COPIES the packaged skills into the managed skills
      // root that is pushed at `global` scope, so a seeded bundle is
      // indistinguishable from a skill the user wrote and (since the
      // global-over-project inversion) outranks a project skill of the same slug.
      // This is the only place that can tell them apart: `isSeededBundledSkill`
      // already owns that identity for the off-switch and the origin lock, and
      // reusing it is what keeps the three decisions agreeing on what "bundled"
      // means. The tag is PROVENANCE — a user-EDITED seed keeps it, deliberately;
      // see `capabilities/types.ts:skillTier`. Absent for every other record, on
      // the same shape-stability rule as `'on'` above.
      ...discoveredRecords.map(record => {
        // P2.351, and it runs FIRST because the skill fast-path below returns
        // the record untouched for every non-skill kind — which is every kind an
        // MCP denial can land on. `sourceEnabled: false` is the one lever this
        // layer owns that the resolver already honours (`resolver.ts`:
        // `enabled = record.sourceEnabled !== false`), and `isRunnable` is what
        // then keeps the entry out of `toAgentRuntime` and therefore out of the
        // pool's desired set. Stamped rather than filtered so the row stays in
        // the catalog; see the gate above for why that half is deliberate.
        if (browseDeniedMcpRecordKeys.has(record.key)) return { ...record, sourceEnabled: false }
        if (record.kind !== 'skill') return record
        const state = resolveSkillOverride(readSkillOverrides(), record.logicalName)
        const bundled = isSeededBundledSkill(record)
        if (state === 'on' && !bundled) return record
        return {
          ...record,
          ...(state === 'on' ? {} : { skillOverrideState: state }),
          ...(bundled ? { skillTier: 'bundled' as const } : {}),
        }
      }),
      // P2.368 — the SAME managed-MCP treatment the discovered records get
      // above, on the same identity the runtime fold now matches on
      // (`builtinDpMcpServerIdentity`). Applied HERE rather than inside
      // `builtinDpMcpCapabilityRecords` so that function keeps describing the
      // whole set as the preference does, and only the resolve decides what may
      // be shown.
      //
      // Runtime turn: dropped outright, as its discovered sibling is. Browse:
      // KEPT and stamped `sourceEnabled: false`, so the row survives in the
      // catalog rather than reproducing `managed-mcp.md`'s "The server silently
      // disappears from `/mcp` and `claude mcp list` with no warning", while the
      // resolver reads it as `enabled: false`. Before this, an administrator who
      // denied a built-in saw the row still reading ENABLED — and it was, because
      // the fold started it.
      ...builtinDpMcpCapabilityRecords(readStoredConfig()).flatMap(record => {
        if (isManagedMcpServerAllowed(managedPiPolicy, {
          name: record.logicalName,
          ...record.mcpServerIdentity,
        }, undefined, managedMcpGateOptions)) return [record]
        // P3.218 — `sourceEnabled: false` is ALSO what the user's own OFF
        // produces, so the row could not say WHICH, and the detail page told an
        // administrator's victim to flip a switch that reverts. The second flag
        // is what makes the two distinguishable downstream; this is the only
        // site that sets it.
        return isRuntimeCapabilityTurn ? [] : [{ ...record, sourceEnabled: false, managedDenied: true }]
      }),
    ],
  }
  const activePluginInstances = Object.fromEntries(
    activeEntries.map(entry => [entry.pluginKey, entry.pluginInstanceId]),
  ) as Record<PluginKey, string>
  const projectionCandidates = resolvePluginProjectionCandidates(activeEntries, selectedScope)
  // P2.351, the plugin half of the same hole. A plugin-provided MCP server is
  // materialized from the SAME `toAgentRuntime` view and reaches the SAME
  // `connectOnce`, so the browse carve-out spawned it exactly as it spawned a
  // native one — and a plugin server runs an executable out of the installed
  // bundle. The candidate is KEPT for the catalog, like the native record above,
  // and disabled per-capability through `resolveActivation`'s
  // `capabilities` map, which the resolver reads as
  // `unavailableReason: 'capability-disabled'`. Keyed by plugin instance because
  // that is the identity `resolveActivation` resolves its target to.
  const browseDeniedPluginMcpCapabilityIds = new Map<string, Set<string>>()
  if (!isRuntimeCapabilityTurn) {
    for (const candidate of projectionCandidates) {
      if (candidate.kind !== 'mcp') continue
      if (isManagedMcpServerAllowed(
        managedPiPolicy,
        pluginMcpServerIdentity(candidate),
        undefined,
        managedMcpGateOptions,
      )) continue
      const denied = browseDeniedPluginMcpCapabilityIds.get(candidate.pluginInstanceId) ?? new Set<string>()
      denied.add(candidate.capabilityId)
      browseDeniedPluginMcpCapabilityIds.set(candidate.pluginInstanceId, denied)
    }
  }
  const pluginCandidates = projectionCandidates.filter(candidate => (
    !isRuntimeCapabilityTurn || (
      isManagedPluginAllowed(managedPiPolicy, candidate.pluginKey)
      && (candidate.kind !== 'mcp'
        || isManagedMcpServerAllowed(
          managedPiPolicy,
          pluginMcpServerIdentity(candidate),
          undefined,
          managedMcpGateOptions,
        ))
      && (candidate.kind !== 'hook' || areManagedPluginHooksAllowed(managedPiPolicy))
      // `hooks.md:612`/`:614` — the managed level of `disableAllHooks` turns
      // every hook off; plugin hook candidates are dropped here, before any
      // trust or projection work happens on them.
      && (candidate.kind !== 'hook' || !isManagedAllHooksDisabled(managedPiPolicy))
      // `settings-reference.md#what-runs-under-allowmanagedhooksonly` — under
      // `allowManagedHooksOnly` the ONLY plugin hooks that load are those from
      // "plugins your managed settings force-enable through `enabledPlugins`.
      // Claude Code matches on the full `plugin@marketplace` ID, so a plugin with
      // the same name from a different marketplace stays blocked."
      // This is the per-plugin half of that carve-out, and it
      // is deliberately keyed on the force-enable set rather than on
      // `allowedPluginKeys`: an allowlist means "these plugins may be used", and
      // reading it here would grant in-process hook execution to every plugin on
      // an organisation allowlist (the defect `93f886f1` removed).
      && (candidate.kind !== 'hook'
        || !isManagedHooksOnly(managedPiPolicy)
        || resolveManagedPluginActivation(managedPiPolicy, candidate.pluginKey) === 'force-enabled')
    )
  ))
  const credentialIds = new Map(
    nativeInventory.records.flatMap(record => record.credentialId
      ? [[credentialIdToAccount(record.credentialId), record.credentialId] as const]
      : []),
  )
  const credentialRefByCapability = new Map(
    nativeInventory.records.flatMap(record => record.credentialId
      ? [[record.key, credentialIdToAccount(record.credentialId)] as const]
      : []),
  )
  const pluginCredentialRefsByCapability = new Map<string, Record<string, string>>()
  const pluginConfigurationMissingByCapability = new Map<string, string[]>()
  for (const candidate of pluginCandidates) {
    if (candidate.runtimeDefinition?.kind !== 'mcp') continue
    const credentialEnvironment = candidate.runtimeDefinition.mcp.credentialEnvironment
    if (!credentialEnvironment || Object.keys(credentialEnvironment).length === 0) continue
    const installed = byInstance.get(candidate.pluginInstanceId)
    if (!installed) continue
    const configuration = resolvePluginConfigurationCapability(installed, context.workspaceId)
    if (!configuration || configuration.capability.id !== candidate.capabilityId) continue
    const credential = deps.credentialBackend.get
      ? await deps.credentialBackend.get(configuration.credentialId)
      : null
    const values = readPluginConfiguration(credential, configuration.fields)
    pluginConfigurationMissingByCapability.set(
      candidate.key,
      missingPluginConfigurationKeys(configuration.fields, values),
    )
    const configuredEnvironmentNames = Object.entries(credentialEnvironment)
      .filter(([, configKey]) => Object.hasOwn(values, configKey))
      .map(([name]) => name)
    if (configuredEnvironmentNames.length === 0) continue
    const id = configuration.credentialId
    const ref = credentialIdToAccount(id)
    credentialIds.set(ref, id)
    pluginCredentialRefsByCapability.set(
      candidate.key,
      Object.fromEntries(configuredEnvironmentNames.sort().map(name => [name, ref])),
    )
  }
  // C3 (capability-path): a plugin http/sse server with declared endpoint auth
  // binds to its GLOBAL plugin credential slot. The resolver's existing
  // credentialRefFor/bindCredential machinery delivers the binding to the
  // pool's Authorization injection; the summary's credentialState reports the
  // slot's ready/missing/expired state.
  for (const candidate of pluginCandidates) {
    if (candidate.runtimeDefinition?.kind !== 'mcp') continue
    const mcp = candidate.runtimeDefinition.mcp
    if (!mcp.authType || mcp.transport === 'stdio') continue
    const id = pluginMcpCredentialId(mcp.authType, candidate.pluginKey, mcp.serverName)
    const ref = credentialIdToAccount(id)
    credentialIds.set(ref, id)
    credentialRefByCapability.set(candidate.key, ref)
  }

  // `plugins/manifest-reference.md#environment-variables` — the `CLAUDE_PLUGIN_OPTION_<KEY>` export for
  // hook processes. Resolved here, once per active instance, because this is
  // where the credential backend lives; the resolver itself never reads a value.
  // Values are attached to hook registrations only and never enter a diagnostic,
  // a log line or the capability generation hash.
  const pluginOptionEnvironments = new Map<string, Record<string, string>>()
  if (deps.credentialBackend.get) {
    const readCredential = deps.credentialBackend.get.bind(deps.credentialBackend)
    for (const entry of activeEntries) {
      const environment = await readPluginOptionEnvironment({
        installed: entry,
        workspaceId: context.workspaceId,
        readCredential,
      })
      if (environment) pluginOptionEnvironments.set(entry.pluginInstanceId, environment)
    }
  }

  // `plugins/loading.md#which-marketplaces-and-plugins-auto-update` — "refreshes the marketplace data and updates
  // installed plugins to their latest versions on disk." R63 shipped the
  // refresh and R72 the bundle re-materialization; this is the half that tells
  // the user BEFORE either happens, and the only half that says anything at all
  // for a marketplace with auto-update off — which `:454` makes the default for
  // "Third-party and local development marketplaces".
  //
  // Gated on there being an active plugin at all, so the overwhelmingly common
  // no-plugins install pays literally nothing for this per turn. The reader is
  // a cached-only peek by contract (see `CapabilityInputsV2Deps`), and a failure
  // to read it must never take a turn down — a missing badge is a strictly
  // better outcome than an unresolvable capability snapshot.
  let availableUpdateVersions = new Map<string, string>()
  // P2.159 — the plugins whose versions cannot be ORDERED, carried separately
  // from the ones with nothing to advertise. `canUpdate` is false for both, and
  // until now nothing downstream could tell "already current" from "no update can
  // ever be offered for this plugin", which is the state the official
  // `claude-security` bundle sat in from install onwards.
  let uncomparableUpdateVersions = new Set<string>()
  if (deps.marketplaceCatalogReader && activeEntries.length > 0) {
    try {
      const catalogItems = await deps.marketplaceCatalogReader.peekCachedItems()
      const subjects: InstalledUpdateSubject[] = activeEntries.map(entry => ({
        pluginKey: entry.pluginKey,
        pluginId: entry.pluginId,
        marketplaceId: entry.marketplaceId,
        version: entry.version,
        ...(entry.origin.provenance?.itemId
          ? { marketplaceItemId: String(entry.origin.provenance.itemId) }
          : {}),
        manifest: {
          name: entry.manifest.name,
          ...(entry.manifest.dependencies ? { dependencies: entry.manifest.dependencies } : {}),
        },
      }))
      const availability = resolveAvailableUpdateVersions(catalogItems, subjects)
      availableUpdateVersions = availability.versions
      uncomparableUpdateVersions = availability.uncomparable
    } catch {
      availableUpdateVersions = new Map()
      uncomparableUpdateVersions = new Set()
    }
  }

  return {
    nativeInventory,
    installedPlugins: activeEntries.map(entry => ({
      ...entry,
      lifecycleState: 'ready' as const,
      ...(entry.origin.provenance?.itemId
        ? { listingId: String(entry.origin.provenance.itemId) }
        : {}),
      ...(availableUpdateVersions.has(entry.pluginKey)
        ? { availableUpdateVersion: availableUpdateVersions.get(entry.pluginKey)! }
        : {}),
      ...(uncomparableUpdateVersions.has(entry.pluginKey)
        ? { updateVersionUncomparable: true as const }
        : {}),
    })),
    activePluginInstances,
    pluginCandidates,
    credentialRefFor: (key: string) => credentialRefByCapability.get(key),
    credentialRefsFor: (key: string) => pluginCredentialRefsByCapability.get(key),
    configurationMissingFor: (key: string) => pluginConfigurationMissingByCapability.get(key) ?? [],
    resolveCredentialStatus: (ref: string) => {
      const id = credentialIds.get(ref)
      if (!id) return { state: 'missing' as const, revision: '0' }
      const status = deps.credentialBackend.getRuntimeCredentialStatus(id)
      return { state: status.state, revision: String(status.revision) }
    },
    bindCredential: (ref: string) => {
      const id = credentialIds.get(ref)
      return id ? deps.credentialBackend.bind(id) : undefined
    },
    isEnvironmentVariableAvailable: name => !!process.env[name]?.trim(),
    ...(context.sessionId
      ? {
          sessionSelection: {
            // Only `kind === 'source'` records participate in session selection.
            // MCP (`kind === 'mcp'` natives + plugin connectors) is EXEMPT and
            // governed by plugin/config activation alone (R3 contract; the
            // composer picker also excludes MCP). Keeping the filter
            // `source`-only means an activated MCP server is never dropped by a
            // non-empty folder/API selection set. See the paired gate in
            // `resolver.ts` (`session-not-selected`).
            enabledSourceKeys: nativeInventory.records
              .filter(record => record.kind === 'source' && enabledSourceNames.has(record.logicalName))
              .map(record => record.key)
              .sort(),
            revision: createHash('sha256')
              .update([...enabledSourceNames].sort().join('\u0000'))
              .digest('hex'),
          },
        }
      : {}),
    // Returns the merged plugin-level verdict plus the per-capability map;
    // the resolver applies `capabilities[capabilityId] === false` itself so a
    // capability-level disable carries its own reason ('capability-disabled')
    // instead of masquerading as plugin-level suppression.
    resolveActivation: (target) => {
      const entry = target.pluginInstanceId
        ? byInstance.get(target.pluginInstanceId)
        : target.pluginKey
          ? byKey.get(target.pluginKey)
          : undefined
      if (!entry) return { enabled: false, suppressed: false, capabilities: {} }
      // `settings-reference.md#enabledplugins`'s managed tier — "**Managed
      // settings**: organization-wide policy. A plugin set to `false` here is
      // blocked from installation at every scope and hidden from the
      // marketplace" — is an ACTIVATION, not a runtime
      // narrowing, so unlike the allow/deny lists below it is applied for every
      // provider and for the catalog view too. Gating a force-enable on the Pi
      // turn would make the plugin run for the agent and read as inactive in the
      // UI; gating the block would make it read as active while nothing ran.
      const managedActivation = resolveManagedPluginActivation(managedPiPolicy, entry.pluginKey)
      const activation = deps.policyStore.resolve(
        { pluginKey: entry.pluginKey, pluginInstanceId: entry.pluginInstanceId },
        {
          workspaceId: context.workspaceId,
          projectKey: context.projectKey, ...(mainCheckoutProjectKey ? { mainCheckoutProjectKey } : {}), // F1.11
          ...(trustedProjectOverlay ? { trustedProjectOverlay } : {}),
          ...(managedActivation ? { managedActivation } : {}),
        },
      )
      // P2.351 — the browse resolve's per-capability MCP denial. Merged over the
      // policy store's own map rather than replacing it, and only for the
      // capability ids the managed denylist actually matched, so nothing else
      // this plugin contributes changes state. Empty on a runtime turn: there the
      // candidate was dropped from `pluginCandidates` outright.
      const deniedMcpCapabilityIds = browseDeniedPluginMcpCapabilityIds.get(entry.pluginInstanceId)
      const withDeniedMcp = deniedMcpCapabilityIds?.size
        ? {
            ...activation,
            capabilities: {
              ...activation.capabilities,
              ...Object.fromEntries([...deniedMcpCapabilityIds].map(id => [id, false as const])),
            },
          }
        : activation
      return !isRuntimeCapabilityTurn || isManagedPluginAllowed(managedPiPolicy, entry.pluginKey)
        ? withDeniedMcp
        : { enabled: false, suppressed: true, capabilities: {} }
    },
    // Real per-scope activation for the safe view's row-menu labels (U4 defect
    // fix). Pure READ of the SAME policy layers `resolveActivation` reads.
    resolvePluginScopeActivation: (target) => {
      const entry = target.pluginInstanceId
        ? byInstance.get(target.pluginInstanceId)
        : target.pluginKey
          ? byKey.get(target.pluginKey)
          : undefined
      if (!entry) return { global: 'unset', workspace: 'unset', project: 'ineligible' }
      const managedActivation = resolveManagedPluginActivation(managedPiPolicy, entry.pluginKey)
      return deps.policyStore.resolveScopes(
        { pluginKey: entry.pluginKey, pluginInstanceId: entry.pluginInstanceId },
        {
          workspaceId: context.workspaceId,
          projectKey: context.projectKey, ...(mainCheckoutProjectKey ? { mainCheckoutProjectKey } : {}), // F1.11
          ...(trustedProjectOverlay ? { trustedProjectOverlay } : {}),
          ...(managedActivation ? { managedActivation } : {}),
        },
      )
    },
    resolveTrust: key => deps.trustStore.resolve(key),
    // D1.69 — a session plugin was never placed in the store's cache, so there
    // is nothing there to lease and nothing that prune could take away; its
    // bytes live in a staging directory the session itself owns until it ends.
    // The test is which MAP the instance came from, never the id's spelling:
    // a session bundle byte-identical to an installed one mints the SAME id
    // (the id is a function of the bytes), and that one really does want the
    // store's lease, because the store's copy is what prune can reach.
    acquirePluginInstanceLease: instanceId => (
      storeInstanceIds.has(instanceId)
        ? deps.pluginStore.acquireInstanceLease(instanceId)
        : () => {}
    ),
    pluginRuntimeContextFor: instanceId => {
      const entry = byInstance.get(instanceId)
      if (!entry) return undefined
      const profiles = entry.manifest.runtimeCompatibility?.profiles ?? []
      if (profiles.length > 1) {
        // A bundle is one format; multiple declared profiles is an unsupported
        // conflicting declaration. Fail closed rather than guess an alias set.
        throw new Error(`plugin-runtime-compatibility-profile-conflict:${instanceId}`)
      }
      const profile = profiles[0] ?? 'generic-plugin-env-v1'
      const projectPath = context.projectRoot ?? context.workingDirectory
      return {
        // D1.69 — a session plugin's root is its staging directory. The store
        // arm stays the default so a session id that never registered anything
        // reads exactly as it did before this field existed.
        rootPath: sessionPluginRootPaths.get(instanceId) ?? deps.pluginStore.cachePathFor(entry.cacheRef),
        dataPath: resolvePluginDataPath(entry.pluginKey, {
          workspaceId: context.workspaceId,
          projectKey: context.projectKey,
        }),
        bundleHash: entry.bundleHash,
        profile,
        ...(projectPath ? { projectPath } : {}),
      }
    },
    pluginOptionEnvironmentFor: instanceId => pluginOptionEnvironments.get(instanceId),
  }
}

function buildTrustedProjectPolicyOverlay(
  context: CapabilityContext,
  activeEntries: PluginInstalledEntryV2[],
): TrustedProjectOverlay | undefined {
  if (context.projectTrustState !== 'trusted' || !context.projectRoot || !context.projectKey) return undefined
  const projectConfig = loadProjectNessyAgentConfig(context.projectRoot, { projectTrusted: true })
  if (!projectConfig) return undefined

  return {
    records: projectConfig.plugins.flatMap(config => activeEntries
      .filter(entry => config.pluginInstanceId
        ? config.pluginInstanceId === entry.pluginInstanceId
        : config.pluginId === entry.pluginId)
      .map(entry => ({
        scope: { kind: 'project' as const, workspaceId: context.workspaceId, projectKey: context.projectKey },
        ...(config.pluginInstanceId
          ? { pluginInstanceId: entry.pluginInstanceId }
          : { pluginKey: entry.pluginKey }),
        enabled: config.enabled,
        ...(config.capabilities ? { capabilities: config.capabilities } : {}),
        updatedAt: new Date(0).toISOString(),
      }))),
  }
}

function selectedCapabilityScope(context: CapabilityContext): CapabilityScopeRef {
  if (context.projectKey) {
    return { kind: 'project', workspaceId: context.workspaceId, projectKey: context.projectKey }
  }
  return { kind: 'workspace', workspaceId: context.workspaceId }
}


function toWorkspacePolicyContext(
  context: CapabilityContext,
  workspaceRootPath: string,
  resolveSessionMemoryFilePath: (workspaceId: string, sessionId: string) => string,
): WorkspacePolicyContext {
  return {
    workspaceId: context.workspaceId,
    workspaceRootPath,
    // `memorySessionId` is the fork's parent (sub-agents.md:1041); everything
    // else about the child still resolves under its own id.
    ...(context.memorySessionId ?? context.sessionId
      ? { sessionMemoryFilePath: resolveSessionMemoryFilePath(context.workspaceId, (context.memorySessionId ?? context.sessionId)!) }
      : {}),
    ...(context.workingDirectory ? { workingDirectory: context.workingDirectory } : {}),
    ...(context.projectRoot ? { projectRoot: context.projectRoot } : {}),
    ...(context.projectKey ? { projectKey: context.projectKey } : {}),
    projectTrustState: context.projectTrustState,
    projectTrustRevision: context.projectTrustRevision,
    // P3.339 — THE PRODUCER, added on the owner's sitting §1.4 answer (A):
    // "wire the Pi arm behind the existing off-by-default opt-in so the setting
    // means one thing". Until this line, `NESSY_ADDITIONAL_DIRECTORIES_MEMORY`
    // was a documented opt-in that could not take effect on any runtime, because
    // this function is the ONE production producer of a `WorkspacePolicyContext`
    // and it set nothing.
    //
    // WHY THE FIELD IS FED UNCONDITIONALLY AND THE GATE STAYS WHERE IT IS.
    // The opt-in already exists and is already enforced at the consumer:
    // `native-sources.ts` reads this list only inside
    // `additionalDirectoryRulesEnabled()`. Duplicating that env read here would
    // be a second gate on the same switch — the drift shape this plan keeps
    // finding — so the producer supplies the roots and the operator's env var
    // remains the single thing that decides whether any of them is read.
    // With the opt-in off (the default), behaviour is byte-identical to before.
    //
    // WHY THIS DOES NOT CONTRADICT `large-codebases.md`. That page scores the
    // `additionalDirectories` SETTING "Never / Never" for memory files and says
    // "The environment variable has no effect on directories listed in the
    // `additionalDirectories` setting." Our config key of that name is NOT that
    // settings key: `claude-agent.ts` hands it to the SDK as the
    // `additionalDirectories` OPTION, and `permissions.md` says of that option
    // "The SDK passes each entry to Claude Code as `--add-dir`, so those
    // directories behave like flag-added directories". So on claude our key IS
    // the flag and its roots already load components at the child; this line is
    // what makes the host say the same thing on Pi and codex, which is the whole
    // point of "one setting, one meaning".
    //
    // BLAST RADIUS, stated plainly because this widens what the model reads: an
    // operator who set BOTH the `additionalDirectories` setting AND the opt-in
    // env var now gets `CLAUDE.md`/`.claude/rules/*`/`.agents/rules/*` from those
    // roots on every runtime instead of on claude alone. That is what they asked
    // for twice.
    //
    // `settingSources` still has no producer, and that one is benign TODAY only
    // because its own docblock says "Absent means all sources, which is the CLI
    // default" — the default happens to be the permissive one. Named here rather
    // than left to be rediscovered: this is the one producer, so an absence here
    // is an absence everywhere.
    ...(() => {
      const roots = getConfiguredAdditionalDirectories()
      return roots.length > 0 ? { additionalRuleDirectories: roots } : {}
    })(),
  }
}

/** Build the resolver input provider bound exclusively to verified-v2 stores. */
export function createCapabilityResolutionInputProviderV2(
  deps: CapabilityInputsV2Deps,
): CapabilityResolutionInputProvider {
  return async (context: CapabilityContext) =>
    withManagedOrgMcpRecords(context, deps, await withProjectContextLayer(context, deps, await buildCapabilityResolutionInputsV2(context, deps))) // UA5.5 + F1.635
}

// UA5.5 — appended below every cited line of this file; imports are hoisted.
import type { HostApprovalsKeyProvider } from '@nessy-agent/shared/approvals/host-approvals'
import { installProjectContextMirror, resolveProjectContextLayer } from '@nessy-agent/shared/projects/project-context'

export interface CapabilityInputsV2Deps {
  /** UA5.5 test seam: the host-approvals key for the project-context digest; production reads the installed provider. */
  projectContextKeyProvider?: HostApprovalsKeyProvider
}

/**
 * UA5.5 — the session's project context as ONE file-backed `instruction` record (spec §12 "Context"), added to the
 * native inventory so the resolver's ordinary instruction arm binds it and `toAgentRuntime` carries it in
 * `promptLayers` to every runtime. `resolveProjectContextLayer` binds `projects/<slug>/context.md` only for bytes the
 * host-approvals ledger vouches for, and otherwise re-renders it from `config.json` (logging
 * `project-context-tampered`). Not added under safe mode (no native instruction file loads there either), nor for a
 * context with no `projectId` (no project; every browse resolve), nor for an id this workspace does not hold. A
 * failure to produce it costs the layer, never the turn: it is logged and the inputs go on without it.
 */
async function withProjectContextLayer(
  context: CapabilityContext,
  deps: CapabilityInputsV2Deps,
  inputs: CapabilityResolutionInputs,
): Promise<CapabilityResolutionInputs> {
  if (!context.projectId || inputs === SAFE_MODE_INPUTS) return inputs
  const workspaceRootPath = deps.resolveWorkspaceRootPath(context.workspaceId)
  if (!workspaceRootPath) return inputs
  let layer: Awaited<ReturnType<typeof resolveProjectContextLayer>>
  try {
    layer = await resolveProjectContextLayer({
      workspaceRootPath,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      ...(deps.projectContextKeyProvider ? { keyProvider: deps.projectContextKeyProvider } : {}),
    })
  } catch (error) {
    console.warn(`[project-context] layer not produced for ${context.projectId}: ${error instanceof Error ? error.message : String(error)}`)
    return inputs
  }
  if (!layer) return inputs
  return {
    ...inputs,
    nativeInventory: { ...inputs.nativeInventory, records: [...inputs.nativeInventory.records, layer.record] },
  }
}

// F1.635 — appended below every cited line of this file (UA5.5's pattern); the
// one import this pass needs is hoisted here with the others below the ceiling.
import { managedOrgMcpDenyOnlyPolicy } from '@nessy-agent/shared/mcp/runtime-pool-servers'

/**
 * Capability-key prefix of the organisation's `managedMcpServers` (F1.593),
 * beside the built-in dp set's `builtin:mcp:`. Collision-free against every key
 * shape already in use: plugin capabilities are `<pluginKey>#<capabilityId>`,
 * native sources are `source:workspace:<ws>:<slug>`, and the name side is the
 * policy parser's own `[A-Za-z0-9_-]{1,64}`, so nothing else produces a
 * `managed:`-scoped record.
 */
const MANAGED_ORG_MCP_KEY_PREFIX = 'managed:mcp:'

/**
 * F1.635 — the organisation's `managedMcpServers` (F1.593) as ORDINARY
 * capability records, the way `builtinDpMcpCapabilityRecords` mirrors the
 * built-in dp set: one read-only `kind: 'mcp'` row per delivered server, so the
 * Sources list shows where a tool came from. The scope is the managed tier's
 * established `builtin` (`native-sources.ts`'s managed instruction/subagent
 * rows) with the ambiguity resolved by the key and the `managedOrg` provenance
 * tag, which the resolver maps to `origin: 'managed'` on the wire.
 *
 * Four things this projection deliberately does NOT do, for the same reasons
 * its built-in sibling names:
 *
 * 1. **It does not materialize the servers.** The runtime fold
 *    (`mcp/runtime-pool-servers.ts:foldManagedOrgMcpServers`) stays the single
 *    materialization path; the record's binding pins no document (the resolver
 *    gives a `builtin`-scoped mcp record an empty command), so the snapshot
 *    branch cannot produce a second, competing entry under the wire name.
 * 2. **It does not read headers into the record.** Static `headers` are the key's
 *    only authentication shape and they are NEVER a credential slot — the row
 *    must not claim a sign-in is outstanding. The content hash covers header
 *    NAMES only, never values, so no secret rides the cache token.
 * 3. **It does not apply the managed denylist ITSELF — its CALLER does**, with
 *    the SAME `denyOnly` policy the fold judges on
 *    (`managedOrgMcpDenyOnlyPolicy`): "deniedMcpServers still applies, and they
 *    need no allowedMcpServers entry", so judging on the full policy would hide
 *    a row for a server the pool actually starts.
 * 4. **It does not decide enablement.** A delivered entry is on unless the
 *    policy denies it — there is no user preference to consult.
 */
export function managedOrgMcpCapabilityRecords(policy: ManagedPiPolicyV1): NativeCapabilitySourceRecord[] {
  const delivered = policy.managedMcpServers
  if (!delivered) return []
  return Object.entries(delivered).map(([name, entry]) => {
    // Identity of the POLICY ENTRY, not of a file: like the built-in set, the
    // record only moves when the policy does. Header names move it; values never.
    const contentHash = createHash('sha256')
      .update([name, entry.type, entry.url, ...Object.keys(entry.headers ?? {}).sort()].join('\u0000'))
      .digest('hex')
    return {
      key: `${MANAGED_ORG_MCP_KEY_PREFIX}${name}`,
      kind: 'mcp' as const,
      scope: { kind: 'builtin' as const },
      managedOrg: true as const,
      logicalName: name,
      // What the deny gate matches on, and what the detail page's transport
      // badge reads — the entry's declared transport and URL, never the headers.
      mcpServerIdentity: { transport: entry.type, url: entry.url },
      sourceEnabled: true,
      sourcePath: '',
      revision: contentHash,
      contentHash,
      // The documented rule, verbatim: "users keep the servers they add
      // themselves and can't edit or remove the ones you provide".
      mutable: false,
    }
  })
}

/**
 * F1.635 — the org records join the inventory AFTER everything on disk and the
 * built-in dp set, wrapped outside {@link withProjectContextLayer} for the same
 * appending order that layer documents (a record actually on disk keeps its
 * position). The deny treatment is the built-in set's own P2.368/P3.218 pair:
 * a runtime turn DROPS a denied record outright; the provider-neutral browse
 * KEPT it and stamps `sourceEnabled: false` + `managedDenied: true`, so the row
 * survives in the catalog and says WHOSE the decision is instead of reproducing
 * `managed-mcp.md`'s silent disappearance.
 */
function withManagedOrgMcpRecords(
  context: CapabilityContext,
  deps: CapabilityInputsV2Deps,
  inputs: CapabilityResolutionInputs,
): CapabilityResolutionInputs {
  if (inputs === SAFE_MODE_INPUTS) return inputs
  const policy = deps.managedPiPolicy
  if (!policy) return inputs
  const delivered = policy.managedMcpServers
  if (!delivered || Object.keys(delivered).length === 0) return inputs
  // P2.396's one-options-object shape, rebuilt at this fifth gate site the same
  // way: an ABSENT environment is an empty options object, never a pinned
  // "pinned to nothing".
  const gateOptions = deps.managedPolicyEnvironment === undefined
    ? {}
    : { policyEnvironment: deps.managedPolicyEnvironment }
  // The DENY LIST ALONE, the same policy object the runtime fold judges on —
  // one definition, two readers, so the row and the pool cannot disagree.
  const denyOnly = managedOrgMcpDenyOnlyPolicy(policy)
  const isRuntimeCapabilityTurn = context.provider !== undefined
  const records = managedOrgMcpCapabilityRecords(policy).flatMap(record => {
    if (isManagedMcpServerAllowed(denyOnly, {
      name: record.logicalName,
      ...record.mcpServerIdentity,
    }, undefined, gateOptions)) return [record]
    return isRuntimeCapabilityTurn ? [] : [{ ...record, sourceEnabled: false, managedDenied: true }]
  })
  if (records.length === 0) return inputs
  return {
    ...inputs,
    nativeInventory: { ...inputs.nativeInventory, records: [...inputs.nativeInventory.records, ...records] },
  }
}

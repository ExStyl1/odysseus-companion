/**
 * The managed-policy composition, and the inputs a `/doctor`-class report needs.
 *
 * Split out of `storage-runtime.ts` for one reason: the reader behind
 * `managed-settings.md#invalid-entries-in-managed-settings` — "`claude doctor`
 * lists each invalid entry with its source and field" — has to run WITHOUT a
 * session — `debug-your-config.md:46`, "From the terminal,
 * `claude doctor` prints read-only installation and settings diagnostics without
 * starting a session" — and `storage-runtime.ts` pulls in the plugin store, the
 * credential manager, the capability resolver and the process supervisor before
 * it can answer a question about a JSON file.
 *
 * The composition is NOT duplicated here to make that cheap. It MOVED. One
 * definition with two readers is the only arrangement in which a diagnosis
 * surface cannot report a policy different from the one being enforced, and a
 * second copy is precisely how the delivered policy came to be composed on one
 * path and enforced on another (R25c).
 */

import {
  loadManagedPiPolicyWithDiagnostics,
  managedPiPolicyPathForPlatform,
  type ManagedPiPolicyLoadV1,
} from '../pi-harness/managed-policy-loader'
import {
  composeManagedPolicySources,
  type ManagedPolicyWinnerV1,
} from '@nessy-agent/shared/config/managed-composition'
import {
  getDeliveredManagedPolicy,
  getManagedDeliveryCachePath,
  getManagedDeliveryState,
  isManagedDeliveryEnabled,
} from '@nessy-agent/shared/config/managed-delivery'
import {
  carriesManagedSettings,
  collectManagedPolicyCaveats,
  registerManagedPiPolicyProvider,
  registerManagedPolicyExpansionEnvironmentProvider,
  type ManagedPiPolicyV1,
  type ManagedPolicyCaveatV1,
} from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import type {
  ConfigDoctorInputV1,
  RetentionDoctorInputV1,
  SandboxNetworkDoctorInputV1,
} from '@nessy-agent/shared/config/config-doctor'
import {
  collectRejectedUserSettingsLayers,
  readRetentionDecision,
  registerComposedManagedEnvProvider,
  registerManagedBrowserCdpDisabledProvider,
  registerManagedBrowserExternalNavigationDisabledProvider,
  registerManagedBrowserExternalPageToolsDisabledProvider,
  registerManagedBrowserHostAllowlistProvider,
  registerManagedInAppBrowserDisabledProvider,
  registerManagedInAppUpdatesDisabledProvider,
  registerManagedRetentionDaysProvider,
  parseManagedModelPricing,
  setManagedModelPricing,
  registerManagedSandboxEnabledProvider,
  resolveSandboxNetworkEnforcement,
  resolveSandboxFilesystemConsequences,
} from '@nessy-agent/shared/config'
import { collectMandatedPluginFindings } from '@nessy-agent/shared/config/doctor-collectors'
import type { MandatedPluginFindingV1 } from '@nessy-agent/shared/plugins'
import { registerManagedNonGatewayConnectionsDisabledProvider } from '@nessy-agent/shared/config/llm-connections'
import type { ManagedEnvCompositionV1 } from '@nessy-agent/shared/config/managed-env'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
// F1.193 — the credential floor's seed is `hostCredentialDenyRoots()`, the ONE resolver the
// ProcessSupervisor's sandbox reads too, anchored on the latched home rather than homedir().
import { hostCredentialDenyRoots, resolveHostSandboxSettings } from './host-sandbox-settings.ts'

import {
  managedPolicyExpansionEnvironment,
  startupEnvironment,
} from './startup-environment.ts'

export interface EnforcedManagedPolicySeams {
  /** The host-owned policy FILE and its drop-in fragments. */
  file?: () => ManagedPiPolicyLoadV1
  /** The server-delivered payload that applies right now, when one does. */
  delivered?: () => ManagedPiPolicyV1 | undefined
}

/**
 * One managed-policy resolution: what is enforced, what was refused, and WHICH
 * SOURCE supplied it.
 *
 * The last two fields exist for the diagnosis surface, never for a gate. Before
 * R30b `composeManagedPolicySources` computed `winner` and the caller threw it
 * away, so `managed-settings.md#read-the-source-in-/status`'s "(remote)"/"(file)"
 * channel and `server-managed-settings.md#settings-precedence`'s "Run `/status`
 * to see which managed source is active" had no producer anything could read. Composition is pure, so
 * carrying the label out beside the policy is the only way the two cannot
 * disagree — deriving it a second time is what makes a diagnostics surface lie.
 */
export interface EnforcedManagedPolicyV1 extends ManagedPiPolicyLoadV1 {
  readonly winner: ManagedPolicyWinnerV1
  /**
   * Whether the host-owned FILE policy carries any setting.
   *
   * `winner === 'delivered'` together with this being `true` is the one state an
   * administrator cannot see from disk: a policy file that reads as deployed and
   * enforces nothing, because managed sources do not merge.
   */
  readonly fileCarriesSettings: boolean
  /**
   * The per-variable `env` merge across both admin sources, with each
   * variable's origin — the input `applyManagedDeliveryEnv` needs to decide the
   * withhold per variable rather than per block.
   */
  readonly envComposition: ManagedEnvCompositionV1
  /**
   * Entries that ARE enforced, and not the way they read — P2.398.
   *
   * A third state beside "enforced" and "refused", and it had no producer:
   * P2.375's expansion guard silently ignores an allowlist URL entry whose
   * scope a variable decides and silently WIDENS the denylist counterpart, and
   * an administrator had no surface that showed either. {@link drops} cannot
   * carry them — every one of its dispositions means *not applied*.
   *
   * Derived from the COMPOSED policy rather than from the file, so a delivered
   * payload's entries are covered too; a caveat is a property of what runs.
   */
  readonly caveats: readonly ManagedPolicyCaveatV1[]
}

/**
 * The ONE managed policy this process enforces, composed from both
 * admin-controlled managed sources.
 *
 * Until R25c this read the host-owned FILE alone, so a delivered payload was
 * fetched, salvaged, approved, cached — and dropped. `env` and
 * `forceRemoteSettingsRefresh` were the only two keys with a consumer;
 * `permissionDsl`, `claudeRules`, the MCP and plugin lists, `sandbox`,
 * `workflow`, `channelsEnabled`, the http-hook containments, `autoMode`,
 * `cleanupPeriodDays` and `autoCompactEnabled` all enforced nothing when an
 * organization delivered them.
 *
 * `composeManagedPolicySources` owns the rule and its citations. Kept as a named
 * export rather than inlined into `createStorageRuntime` because this is the
 * assertable seam: a test can drive both sources and check that a delivered key
 * reaches a real enforcement decision, which is the assertion whose absence let
 * the gap ship.
 *
 * ## Boot ordering
 *
 * Delivery is asynchronous and hangs off sign-in; this runs at boot. In the
 * desktop shell the two are not even in the same order as the headless host —
 * `createStorageRuntime` runs several hundred lines BEFORE
 * `initializeManagedDeliveryFromCache()`, while `startManagedSettingsDelivery`
 * completes before the headless session manager exists. Waiting for a fetch is
 * not an option either: `server-managed-settings.md#fetch-and-caching-behavior`
 * fetches asynchronously and, "if the fetch fails, Claude Code continues without
 * server-managed settings and warns in interactive sessions that no remote policy
 * applies; endpoint-managed settings still apply".
 *
 * So the CACHE is the input, exactly as that same section prescribes — "Cached
 * settings apply immediately at startup" — and `getDeliveredManagedPolicy` reads
 * the live session state first only because it can be fresher, never because it
 * is required to be there. That is the same model the withheld-`env` rule already
 * runs on: the cache applies immediately, minus the categories that section holds
 * back until a fetch confirms the payload — it withholds them "until the server
 * confirms the payload for the session". An unapproved payload cannot arrive
 * through either path — the session holds one behind `awaitingApproval` and
 * `loadCachedManagedDelivery` re-checks `approvedDigest` on every read.
 *
 * `SessionManager.refreshManagedPiPolicy` calls this again at each turn boundary,
 * but `createStorageRuntime` keeps its BOOT call: the capability resolver's
 * plugin/hook/MCP-record filters, marketplaces, models, `env` and the sandbox
 * network rules read that snapshot and need a restart (hook locks, MCP lists: a
 * loosening only); docs-site `core-concepts/permissions.md` states the same.
 */
export function resolveEnforcedManagedPolicy(
  seams: EnforcedManagedPolicySeams = {},
): EnforcedManagedPolicyV1 {
  const file = (seams.file ?? loadManagedPiPolicyWithDiagnostics)()
  const delivered = (seams.delivered ?? getDeliveredManagedPolicy)()
  const composed = composeManagedPolicySources({ delivered, file: file.policy })
  return Object.freeze({
    policy: composed.policy,
    drops: file.drops,
    winner: composed.winner,
    fileCarriesSettings: carriesManagedSettings(file.policy),
    envComposition: composed.envComposition,
    // From `composed.policy`, never `file.policy`: composition is
    // winner-takes-all, so reporting the file's entries when a delivered
    // payload took the tier would describe a policy that is not running.
    caveats: collectManagedPolicyCaveats(composed.policy),
  })
}

/**
 * Register the managed `cleanupPeriodDays` reader for `ensureConfigDir()`'s
 * startup retention sweep, fed by the ENFORCED composition rather than the
 * host-owned file.
 *
 * Until this fix (R25, third pass) both hosts fed the sweep from
 * `loadManagedPiPolicy()` — the FILE alone — so a delivered-only
 * `cleanupPeriodDays` was fetched, salvaged, approved, digest-pinned, cached
 * and then ignored by the one consumer the key has. The provider re-resolves
 * on every read, so a delivered payload that lands after registration is seen
 * by the next retention decision; a managed file that cannot be loaded yields
 * no managed value here (the sweep stays on its conservative path) while
 * `createStorageRuntime` resolves the same composition and fails closed for
 * real.
 *
 * Both hosts must call this BEFORE their first `ensureConfigDir()` — the
 * headless bootstrap does so in `bootstrapConfigArtifacts`, and the desktop
 * shell at the top of its ready handler, because its sweep runs lazily inside
 * the first config write (`saveConfig`/`savePreferences`) rather than at an
 * explicit bootstrap site.
 */
export function registerEnforcedManagedRetentionProvider(
  seams: EnforcedManagedPolicySeams = {},
): void {
  registerManagedRetentionDaysProvider(() => {
    try {
      return resolveEnforcedManagedPolicy(seams).policy.cleanupPeriodDays
    } catch {
      return undefined
    }
  })
}

/**
 * Register the managed `sandbox.enabled` reader for the two OS-wrap contours
 * that live in `packages/shared` and cannot import
 * {@link resolveHostSandboxSettings} — `getMacosSeatbeltBashSandboxEnabled`
 * (contour b) and `CodexAgent`'s `sandboxGloballyEnabled` (contour e).
 * Contour (a) (`ProcessSupervisor`, via `resolveHostSandboxSettings`) needs no
 * bridge: it already composes this same floor in-process, straight from the
 * `ManagedPiPolicyV1` object.
 *
 * Mirrors {@link registerEnforcedManagedRetentionProvider} exactly — same
 * seams, same call-before-first-use requirement, same tolerant fallback: a
 * policy this run cannot resolve yields no managed floor, which every
 * non-managed install (and every unit test that never calls this) already
 * gets by construction.
 */
export function registerEnforcedManagedSandboxEnabledProvider(
  seams: EnforcedManagedPolicySeams = {},
): void {
  registerManagedSandboxEnabledProvider(() => {
    try {
      return resolveEnforcedManagedPolicy(seams).policy.sandbox?.enabled
    } catch {
      return undefined
    }
  })
}

/**
 * Register the managed `disableInAppUpdates` reader for the desktop host's own
 * updater (P2.7 clause (d), the precondition the rest of the row rests on).
 *
 * P2.10 shipped the gate — every updater entry point asks
 * `areInAppUpdatesManagedDisabled()` — with NO host-side writer, because the key
 * had no field on `ManagedPiPolicyV1` and `refuseUnknownKeys` stripped it out of
 * a policy file that carried it. The field exists now, so this is the writer,
 * and it reads the same enforced composition the retention and sandbox bridges
 * do, which is what makes a server-DELIVERED value work as well as a file one.
 *
 * ORDER MATTERS here in a way it does not for its two siblings, and P2.7 clause
 * (c) is that order: the electron host must call this BEFORE
 * `checkForUpdatesOnLaunch()`. The launch check is the one update entry point
 * with no user behind it, so a registration that lands after it has already let
 * an unmanaged check run — and with `autoDownload` on, stage a download the
 * policy forbids.
 *
 * Registering also BROADCASTS, through
 * `subscribeManagedInAppUpdatesChange` (clause (b)) — a settings page already on
 * screen flips with no user action.
 */
export function registerEnforcedManagedInAppUpdatesProvider(
  seams: EnforcedManagedPolicySeams = {},
): void {
  registerManagedInAppUpdatesDisabledProvider(() => {
    try {
      return resolveEnforcedManagedPolicy(seams).policy.disableInAppUpdates
    } catch {
      return undefined
    }
  })
}

/**
 * Register the managed `disableInAppBrowser` reader for the desktop host's own
 * built-in browser — P2.399, and the twin of the function above in every
 * respect that matters.
 *
 * P2.373 measured that codex does not act on its own `in_app_browser` flag and
 * that nothing in this tree did either, so an administrator deploying the
 * documented switch got a browser pane with tabs and a toolbar. P2.399 built
 * the gate in `main/browser-pane-manager.ts`; this is the tier that feeds it
 * from the same enforced composition the retention, sandbox and in-app-updates
 * bridges read, which is what makes a server-DELIVERED value work as well as a
 * file one.
 *
 * ORDER matters less than it does for the updates twin, and for a reason worth
 * writing down rather than leaving to inference: the updates registration has
 * to beat `checkForUpdatesOnLaunch()` because that entry point has no user
 * behind it. Every browser entry point has a user or an agent behind it, so
 * there is no launch-time race to lose — but the registration still belongs
 * beside its siblings at bootstrap, because the manager's startup enforcement
 * pass (which CLOSES a pane the policy forbids) reads it once at that point.
 *
 * Deliberately NOT called from `headless-start.ts`: the headless server injects
 * `NullBrowserPaneManager`, which refuses every browser method already, so
 * there is nothing there for this to gate.
 */
export function registerEnforcedManagedInAppBrowserProvider(
  seams: EnforcedManagedPolicySeams = {},
): void {
  registerManagedInAppBrowserDisabledProvider(() => {
    try {
      return resolveEnforcedManagedPolicy(seams).policy.disableInAppBrowser
    } catch {
      return undefined
    }
  })
  // P6.338 — the three GRADED locks, registered from the SAME function as the
  // all-or-nothing switch above, deliberately. They are one operator decision
  // about one pane, read from one composition, and a caller that armed the kill
  // switch while leaving the graded keys unfed would produce exactly the
  // half-built gate this family keeps being caught by: an administrator's
  // allowlist parsed, scored and enforcing nothing.
  registerManagedBrowserExternalNavigationDisabledProvider(() => {
    try {
      return resolveEnforcedManagedPolicy(seams).policy.disableBrowserExternalNavigation
    } catch {
      return undefined
    }
  })
  // P6.765 — the P6.536 CDP lock, FED. The gate and its predicate had shipped
  // with no production caller at all, so `done_means`'s "an administrator can
  // lock CDP off SEPARATELY from the pane" was unreachable: every operator who
  // wrote the key got nothing, silently. Registered from this function and not
  // its own, for the reason the block above gives — one operator decision about
  // one pane, read from one composition.
  registerManagedBrowserCdpDisabledProvider(() => {
    try {
      return resolveEnforcedManagedPolicy(seams).policy.disableBrowserCdp
    } catch {
      return undefined
    }
  })
  registerManagedBrowserHostAllowlistProvider(() => {
    try {
      return resolveEnforcedManagedPolicy(seams).policy.browserHostAllowlist
    } catch {
      // NOT an empty list: an unreadable policy is "no opinion", and an empty
      // allowlist is an operator's decision to admit nothing. Collapsing the two
      // would turn a transient read failure into a fleet-wide browsing outage.
      return undefined
    }
  })
  registerManagedBrowserExternalPageToolsDisabledProvider(() => {
    try {
      return resolveEnforcedManagedPolicy(seams).policy.browserExternalPageTools === 'disabled'
        ? true
        : undefined
    } catch {
      return undefined
    }
  })
}

/**
 * Register the operator's model PRICE TABLE — P6.537, owner decision D11 (A).
 *
 * The table landed with `f530b51df` and nothing set it, so every figure kept
 * its previous basis and a gateway model still read as costing zero. This is
 * the channel that makes it live, and it is the same enforced delivered+file
 * composition the retention, sandbox and in-app bridges read — so a
 * SERVER-delivered table works as well as a file one.
 *
 * PUSH rather than pull, unlike its neighbours above, because the parse has a
 * second output: `parseManagedModelPricing` returns its REJECTIONS instead of
 * throwing, and those have to reach a channel rather than be recomputed on
 * every price lookup. A provider closure would have to either drop them or
 * re-parse the table for each figure.
 *
 * An unreadable policy clears the table rather than leaving a stale one
 * standing. That is the opposite of the in-app switches next door and
 * deliberate: a withdrawn or broken price table must not keep pricing sessions
 * from a document that no longer says anything, and the safe reading of "no
 * table" is UNPRICED, which the cost surface renders as such rather than as
 * free.
 */
/**
 * Register the "gateway sign-in only" lock — P6.498, Q-den 15 = option A.
 *
 * Beside the browser locks and for the same reason: the reader lives in a
 * shared module the renderer also bundles, and the value arrives through a
 * registration rather than an import so that module can stay import-free of
 * anything `node:`.
 *
 * Registered on BOTH hosts. The headless server has no connection cards of its
 * own, but it serves the very clients that do — a lock that applied to the
 * desktop shell and not to a remote client would be the one-path defect this
 * series keeps finding.
 */
export function registerEnforcedManagedNonGatewayConnections(
  seams: EnforcedManagedPolicySeams = {},
): void {
  registerManagedNonGatewayConnectionsDisabledProvider(() => {
    try {
      return resolveEnforcedManagedPolicy(seams).policy.disableNonGatewayConnections
    } catch {
      return undefined
    }
  })
}

export function registerEnforcedManagedModelPricing(
  seams: EnforcedManagedPolicySeams = {},
): void {
  try {
    const { pricing, rejected } = parseManagedModelPricing(
      resolveEnforcedManagedPolicy(seams).policy.modelPricing,
    )
    setManagedModelPricing(pricing)
    for (const entry of rejected) {
      // `console.warn`, the channel `storage-runtime.ts` uses for the same
      // class of managed-settings finding: both hosts route it to stderr and the
      // main log, and a rejected RATE names a model, never a credential.
      console.warn(`[managed-settings] modelPricing: dropped ${entry.path} (${entry.reason})`)
    }
  } catch {
    setManagedModelPricing(undefined)
  }
}

/**
 * Register the WHOLE composed policy for the two shared-package readers that
 * need the document rather than one key — today, the Claude spawn's
 * `Options.managedSettings` projection (`agent/claude-managed-settings.ts`).
 *
 * Same seams, same call-before-first-use requirement and same tolerant fallback
 * as the three single-key bridges above. It does not replace them: a consumer
 * that needs one key keeps its own narrow reader, because a narrow reader cannot
 * accidentally grow a dependency on a field it has no business reading.
 */
export function registerEnforcedManagedPolicyProvider(
  seams: EnforcedManagedPolicySeams = {},
): void {
  registerManagedPiPolicyProvider(() => {
    try {
      return resolveEnforcedManagedPolicy(seams).policy
    } catch {
      return undefined
    }
  })
  // Registered from the SAME function, deliberately: `env` is the one key that
  // merges across the two admin sources, and its consumer
  // (`applyManagedDeliveryEnv`) needs the per-variable ORIGIN, which the policy
  // document cannot carry. Folding it in here rather than adding a fifth
  // register-me call is what keeps the two hosts in step — both already call
  // this, and both call it before they apply the block (desktop:
  // `index.ts:424` registers, `:1244` applies).
  registerComposedManagedEnvProvider(() => {
    try {
      return resolveEnforcedManagedPolicy(seams).envComposition
    } catch {
      return undefined
    }
  })
  // P2.410, and registered from this same function for the reason above: the
  // pinned policy-expansion environment is read at the two managed-MCP gates in
  // `@nessy-agent/shared/mcp/runtime-pool-servers`, which read the policy
  // itself from the registration two lines up. A separate register-me call is a
  // second thing a host can wire the policy through and forget the environment
  // for — and the symptom of forgetting it is silent: the gate goes back to
  // expanding an administrator's entry through the live environment and every
  // verdict still looks reasonable.
  //
  // `managed-mcp.md#how-policy-entries-expand` names what is being assembled:
  // `allowedMcpServers` expands from "The environment Claude Code started with,
  // plus `env` values from managed settings".
  //
  // The COMPOSED `env`, exactly as `createStorageRuntime` uses it, not the
  // block as applied to `process.env`: a delivered variable can be withheld
  // pending server confirmation, so the applied block moves when a fetch lands,
  // and a policy whose meaning moved when a fetch landed is the defect one tier
  // up (`startup-environment.ts` carries the whole reason).
  //
  // A failure falls back to the startup snapshot ALONE rather than to
  // `undefined`. Losing the managed `env` layer leaves a `${VAR}` unresolved,
  // and P2.375 already answers an unresolved reference in the enforcing
  // direction on both lists — an allow entry admits nothing, a deny entry
  // widens. Returning `undefined` would instead hand the entry back to the live
  // environment, which is the one direction that can be steered.
  registerManagedPolicyExpansionEnvironmentProvider(() => {
    try {
      return managedPolicyExpansionEnvironment(resolveEnforcedManagedPolicy(seams).envComposition.env)
    } catch {
      return startupEnvironment()
    }
  })
}

/**
 * Assemble everything {@link ConfigDoctorInputV1} needs, tolerating every
 * failure it is being run to diagnose.
 *
 * Nothing here may throw. `settings-reference.md#requiredminimumversion` and
 * `#requiredmaximumversion` require `claude doctor` to keep working when the
 * version gate refuses to start the app — "`claude update`, `claude install`, and
 * `claude doctor` keep working below the floor so users can recover", and the
 * same sentence above the ceiling — and
 * `managed-policy-loader.ts` still fails closed on a file-level defect (broken
 * JSON, an oversized file, an unsafe path) by throwing `managed-pi-policy-invalid`
 * — which is exactly the state an administrator reaches for a doctor in. A
 * diagnosis tool that crashes on the defect it exists to name is not a tool.
 *
 * A failed load is therefore reported as a whole-document drop, which is the
 * shape `formatManagedPolicyDrop` already renders as "(whole document)".
 */
/**
 * The effective sandbox network policy, from the SAME composition the process
 * supervisor is built from (`resolveHostSandboxSettings`).
 *
 * Tolerant like everything else here: a user settings file this run cannot parse
 * must not take the whole report down, and reporting nothing is honest — the
 * section is omitted rather than guessed at.
 */
function collectSandboxNetwork(policy: ManagedPiPolicyV1): SandboxNetworkDoctorInputV1 | undefined {
  try {
    const settings = resolveHostSandboxSettings(policy).network
    return {
      enforcement: resolveSandboxNetworkEnforcement(settings),
      settings,
      fromManagedSettings: policy.sandbox?.network !== undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * T1 (2026-08-12) — the resolved `sandbox.enabled` master switch, from the
 * SAME composition the process supervisor is built from. Tolerant like every
 * other collector here: a settings file this run cannot parse must not take
 * the whole report down, and reporting nothing is honest.
 */
function collectSandboxEnabled(policy: ManagedPiPolicyV1): boolean | undefined {
  try {
    return resolveHostSandboxSettings(policy).enabled
  } catch {
    return undefined
  }
}

/**
 * What `sandbox.filesystem.disabled` gave up on this host, from the SAME
 * composition the process supervisor is built from.
 *
 * Tolerant like everything else here: a settings file this run cannot parse
 * must not take the report down, and reporting nothing is honest.
 */
function collectSandboxFilesystem(policy: ManagedPiPolicyV1): readonly string[] | undefined {
  try {
    const lines = resolveSandboxFilesystemConsequences(
      resolveHostSandboxSettings(policy),
      process.platform,
      // The floor is seeded INTO the settings layers, so without it the report
      // would list every credential root as surrendered — which the isolation
      // funnel does not do. Passing it is what keeps `doctor` and the funnel
      // saying the same thing about the one rule that survives the key.
      { credentialFloor: hostCredentialDenyRoots() },
    )
    return lines.length > 0 ? lines : undefined
  } catch {
    return undefined
  }
}

/**
 * What the retention sweep would do, resolved WITHOUT running one.
 *
 * Tolerant like everything else here: reporting nothing is honest, and a
 * diagnosis surface must never be the thing that deletes a transcript.
 */
function collectRetention(policy: ManagedPiPolicyV1): RetentionDoctorInputV1 | undefined {
  try {
    const decision = readRetentionDecision(
      policy.cleanupPeriodDays === undefined ? {} : { managedRetentionDays: policy.cleanupPeriodDays },
    )
    return {
      sweeps: decision.sweep,
      state: decision.state,
      ...(decision.sweep ? { retentionDays: decision.retentionDays, source: decision.source } : {}),
      ...(decision.warning ? { warning: decision.warning } : {}),
    }
  } catch {
    return undefined
  }
}

export function collectConfigDoctorInput(
  seams: EnforcedManagedPolicySeams = {},
): ConfigDoctorInputV1 {
  let filePath: string | undefined
  try {
    filePath = managedPiPolicyPathForPlatform()
  } catch {
    // No managed policy location on this platform (win32 without ProgramData).
    filePath = undefined
  }

  let deliveryCachePath: string | undefined
  try {
    deliveryCachePath = getManagedDeliveryCachePath()
  } catch {
    deliveryCachePath = undefined
  }

  let rejectedLayers: readonly { source: string; key: string; reason: string }[] = []
  try {
    rejectedLayers = collectRejectedUserSettingsLayers()
  } catch {
    rejectedLayers = []
  }

  // P6.246(c) — the delivery OUTCOME, which is a different question from which
  // source won. `winner` says what is enforced; this says whether the
  // organisation's remote policy was asked for at all, and if it was, whether it
  // arrived. Read from the live state rather than recomputed, for the reason
  // `winner` itself is carried out of the composition: a second derivation is
  // what makes a diagnosis surface lie.
  let delivery: ConfigDoctorInputV1['delivery']
  try {
    const state = getManagedDeliveryState()
    delivery = Object.freeze({
      enabled: isManagedDeliveryEnabled(),
      source: state.source,
      confirmed: state.confirmed,
      ...(state.fetchError === undefined ? {} : { fetchError: state.fetchError }),
    })
  } catch {
    delivery = undefined
  }

  try {
    const enforced = resolveEnforcedManagedPolicy(seams)
    return {
      drops: enforced.drops,
      winner: enforced.winner,
      fileCarriesSettings: enforced.fileCarriesSettings,
      filePath,
      deliveryCachePath,
      rejectedLayers,
      ...(delivery === undefined ? {} : { delivery }),
      // `settings-reference.md#availablemodels` and `#enforceavailablemodels` —
      // the one enforced policy an administrator
      // cannot read back from anywhere else. Reported from the ENFORCED policy,
      // not the file, so the listing matches what sessions actually apply.
      availableModels: enforced.policy.availableModels,
      enforceAvailableModels: enforced.policy.enforceAvailableModels,
      sandboxEnabled: collectSandboxEnabled(enforced.policy),
      sandboxNetwork: collectSandboxNetwork(enforced.policy),
      sandboxFilesystem: collectSandboxFilesystem(enforced.policy),
      // `settings-reference.md#cleanupperioddays` is the key; the pause it can
      // cause is `claude-directory.md#cleaned-up-automatically` — Claude Code
      // "also shows a warning in `/status` until you fix the settings errors".
      // This report is the read-only surface that shows it.
      retention: collectRetention(enforced.policy),
      // P2.409 — the same list `createStorageRuntime` prints at boot, on the
      // surface an administrator actually runs when their policy misbehaves
      // (`managed-settings.md#check-that-a-policy-is-in-force`: "Two commands on
      // that machine answer it: `/status` shows which managed source Claude Code
      // selected, and `claude doctor` lists what it dropped.").
      // Read from the resolution rather than recomputed,
      // so `doctor` and the boot summary cannot disagree about what the
      // enforced policy is doing.
      caveats: enforced.caveats,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // The load failed whole, so nothing is enforced from the file. The delivered
    // payload is read on its own so the report can still name the source that IS
    // in effect — the two are independent, and saying "none" here would be wrong
    // whenever a remote policy is live.
    let deliveredOnly: ManagedPiPolicyV1 | undefined
    try {
      deliveredOnly = (seams.delivered ?? getDeliveredManagedPolicy)()
    } catch {
      deliveredOnly = undefined
    }
    const composed = composeManagedPolicySources({
      delivered: deliveredOnly,
      file: DEFAULT_MANAGED_PI_POLICY,
    })
    return {
      drops: [{
        source: filePath ?? 'managed policy',
        field: '',
        reason,
        disposition: 'stripped',
      }],
      winner: composed.winner,
      fileCarriesSettings: false,
      filePath,
      deliveryCachePath,
      rejectedLayers,
      ...(delivery === undefined ? {} : { delivery }),
      // The file failed whole, so only the delivered payload can be enforcing
      // an allowlist here — the same composition the winner above came from.
      availableModels: composed.policy.availableModels,
      enforceAvailableModels: composed.policy.enforceAvailableModels,
      sandboxEnabled: collectSandboxEnabled(composed.policy),
      sandboxNetwork: collectSandboxNetwork(composed.policy),
      sandboxFilesystem: collectSandboxFilesystem(composed.policy),
      retention: collectRetention(composed.policy),
      // The file failed whole, so any surviving entry came from the delivered
      // payload — collected from the SAME composition every other field in this
      // branch reads, never from the file that just failed to load.
      caveats: collectManagedPolicyCaveats(composed.policy),
    }
  }
}

/**
 * The mandate collector, wired to the ENFORCED managed policy — P6.788.
 *
 * The one collector that cannot be parameter-free. `enabledPlugins` is
 * `server-core`'s to resolve, one layer above the shared module, so every caller
 * has to resolve it and hand the map over. That wiring was written THREE times —
 * `apps/cli/src/doctor.ts`'s `collectMandatedPluginFindingsHere`, the
 * `GET_CONFIG_DOCTOR` handler (whose comment said "the CLI's … verbatim in
 * intent", which is a copy admitting it is one) and `SessionManager` — and it is
 * three lines of which one is a `catch` that decides what the user is told.
 *
 * It lives here, beside {@link collectConfigDoctorInput}, for that module's own
 * stated reason: one definition with two readers is the only arrangement in which
 * a diagnosis surface cannot report a policy different from the one enforced.
 *
 * **`undefined` means "I could not look", and the section is omitted.** That is
 * the collectors' documented convention and it is the whole point of the catch: a
 * managed policy that cannot be resolved must not render as *"no mandate exists"*.
 * The catch covers the COLLECT as well as the resolve, which the CLI's copy did
 * not — the handler's copy did, and its suite pins it
 * (`settings-config-doctor.test.ts`, "keeps 'found none' and 'could not look'
 * apart, and survives both"). Unifying to the wider catch is the honest direction:
 * a `doctor` run that dies on a malformed plugin registry is worse than one that
 * omits a section and reports the rest, which is exactly what
 * `collectMandatedPluginFindings`'s own header already argues for its file reads.
 *
 * **`SessionManager` deliberately does NOT call this**, and that is not an
 * oversight left behind: it holds the policy it enforces for the life of the
 * session and passes `this.managedPiPolicy.enabledPlugins` straight to the
 * collector. Re-resolving there would let the session's settings line describe a
 * policy the session is not running — the defect this whole module was split out
 * to make impossible.
 */
export function collectMandatedPluginFindingsFromEnforcedPolicy(
  seams: EnforcedManagedPolicySeams = {},
): readonly MandatedPluginFindingV1[] | undefined {
  try {
    return collectMandatedPluginFindings(resolveEnforcedManagedPolicy(seams).policy.enabledPlugins)
  } catch {
    return undefined
  }
}

/**
 * The operator-visible notice for a managed policy that could not be READ, or
 * `undefined` when the error is something else — P6.246(a).
 *
 * The defect this closes, measured at HEAD: the desktop shell's version-gate
 * call site catches everything that is not a `ManagedSettingsStartupError` and
 * calls `mainLog.warn`. `loadManagedPiPolicy()` throws
 * `managed-pi-policy-invalid` — a FAIL-CLOSED error — so an unparsable managed
 * file degraded to a warning, the admin version floor was skipped, and startup
 * continued. A packaged build writes nothing outside debug mode, so that
 * warning reached no operator at all.
 *
 * **This does not decide the posture, it makes the existing one legible.** The
 * composition already fails closed for real in `createStorageRuntime`, so the
 * app was going to stop anyway; what the operator got was the downstream
 * failure, which names no file. The caller renders THIS notice first.
 *
 * Two things worth knowing before changing it:
 *
 *  - `managedPiPolicyPathForPlatform` throws the SAME `managed-pi-policy-invalid`
 *    when the system directory cannot be resolved (win32 without an absolute
 *    `%ProgramFiles%`), so resolving the path here is wrapped. A notice whose
 *    own path lookup threw would turn a legible refusal back into a crash.
 *  - `ManagedSettingsStartupError` is recognised by NAME rather than
 *    `instanceof`. It is declared in `headless-start.ts`, which imports this
 *    module; importing it back would close a cycle. The class pins
 *    `readonly name`, so the check cannot drift silently, and the test asserts
 *    it against the real class.
 */
export function managedPolicyUnreadableNotice(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
  programFiles = process.env.ProgramFiles,
): { readonly title: string; readonly message: string; readonly reason: string } | undefined {
  if (!(error instanceof Error)) return undefined
  if (error.name === 'ManagedSettingsStartupError') return undefined
  if (error.message !== MANAGED_POLICY_UNREADABLE_REASON) return undefined
  let filePath: string
  try {
    filePath = managedPiPolicyPathForPlatform(platform, programFiles)
  } catch {
    filePath = 'the managed policy file in the system directory'
  }
  return Object.freeze({
    title: 'Managed policy could not be read',
    // Names the file, because that is the only thing the operator can act on,
    // and says what state the install is in. `managed-settings.md` puts repair
    // in the administrator's hands, so the sentence points there rather than
    // offering a fix the user cannot perform.
    message: `The managed policy at ${filePath} could not be read, so this installation `
      + 'cannot apply the settings your organisation requires. Ask your administrator to repair or '
      + 'remove that file, then start Nessy Desktop again.',
    reason: MANAGED_POLICY_UNREADABLE_REASON,
  })
}

/**
 * The loader's own throw message. Spelled once here rather than at each reader;
 * `invalid()` in `managed-policy-loader.ts` is the writer.
 */
const MANAGED_POLICY_UNREADABLE_REASON = 'managed-pi-policy-invalid'

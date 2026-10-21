/**
 * Safe capability wire DTOs (W8 Step 6).
 *
 * This module re-declares the renderer/remote-facing capability contract as
 * plain, path-free data. It NEVER imports server-only `capabilities/types`,
 * runtime bindings, `Resolved*` records, leases or credential refs — the
 * combined TypeScript in the plan documents matching wire VALUES, not a package
 * import direction. Everything here is safe to serialize across RPC and hold in
 * a renderer/query cache.
 *
 * Hard rule enforced by the validators below: no absolute managed path, install
 * source, temp path, command, executable hash, environment value, header,
 * secret ref or secret value ever crosses this boundary.
 */

// ---------------------------------------------------------------------------
// Primitive unions (re-declared; must match the server enums by VALUE only)
// ---------------------------------------------------------------------------

export type SafeCapabilityKind =
  | 'source' | 'skill' | 'mcp' | 'hook' | 'automation' | 'app'
  | 'agent' | 'instruction' | 'memory' | 'permission'
  | 'command' | 'setting' | 'asset' | 'prompt-command' | 'lsp' | 'monitor'
  | 'output-style';

export type SafeCapabilityOrigin = 'builtin' | 'native' | 'plugin' | 'managed'; // F1.635 — the organisation's managedMcpServers (policy-delivered, read-only); the record half is `NativeCapabilitySourceRecord.managedOrg`, the mirror is `storage-runtime.ts`'s managed-org pass

export type SafeCapabilityScopeKind = 'builtin' | 'global' | 'workspace' | 'project';

export interface SafeCapabilityScopeRef {
  kind: SafeCapabilityScopeKind;
  workspaceId?: string;
  /** Opaque path-free project key; never an absolute path. */
  projectKey?: string;
}

export type SafeCapabilityTrustState =
  | 'not-required' | 'trusted' | 'review-required' | 'blocked';

/**
 * UB14.48 — a Source's stored connection verdict, by VALUE the app's `SourceConnectionStatus`
 * (`sources/types.ts`), re-declared here per this module's no-import rule.
 */
export type SafeSourceConnectionStatus =
  | 'connected' | 'needs_auth' | 'failed' | 'untested' | 'local_disabled';

export type SafeCredentialAvailabilityState =
  | 'not-required' | 'ready' | 'missing' | 'expired';

export type SafeCapabilityAvailabilityState =
  | 'active' | 'disabled' | 'shadowed' | 'review-required'
  | 'missing-credential' | 'unsupported-runtime' | 'invalid';

export type SafeCapabilityDiagnosticSeverity = 'info' | 'warning' | 'error';

// ---------------------------------------------------------------------------
// Safe context ingress (renderer/remote callers never supply a project root)
// ---------------------------------------------------------------------------

export type SafeProjectCapabilityContextRef =
  | { workspaceId: string; sessionId: string }
  | { workspaceId: string; projectHandleId: string };

export type SafeCapabilityContextRef =
  | { workspaceId: string }
  | SafeProjectCapabilityContextRef;

/** Backend-issued, expiring project handle. Carries the user-visible path only. */
export interface SafeProjectHandle {
  id: string;
  workspaceId: string;
  /** User-selected project path already visible in session UI; not a managed path. */
  displayPath: string;
  /** Selection alone is unknown; explicit distrust is distinct from no decision. */
  trustState: 'unknown' | 'trusted' | 'untrusted';
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Project-contribution detection (read-only, Codex-parity, pre-trust consent)
// ---------------------------------------------------------------------------

/**
 * Kind of contribution a project folder can provide. Mirrors the vendored
 * `ExternalAgentConfigMigrationItemType` (codex-protocol) MINUS `SESSIONS` and
 * `PLUGINS` — Nessy detects + consents in place; it never migrates/copies.
 */
export type ProjectContributionItemType =
  | 'AGENTS_MD'
  | 'CONFIG'
  | 'SKILLS'
  | 'MCP_SERVER_CONFIG'
  | 'SUBAGENTS'
  | 'HOOKS' | 'COMMANDS'
  | 'LANGUAGE_SERVERS'; // Nessy-only (F1.809): Pi plugin language servers, `piLanguageServerContribution`

/**
 * One detected contribution group. Deliberately path-free: `names` holds
 * basenames / MCP server slugs only, `sourceLabel` is a well-known convention
 * label (e.g. "project .mcp.json"). NEVER an absolute path, file content, or
 * env value.
 */
export interface ProjectContributionItem {
  itemType: ProjectContributionItemType;
  /** Number of discovered entries of this type in this source group (>= 1). */
  count: number;
  /** Bounded, path-free display names. May be shorter than `count`. */
  names: string[];
  /** True when `names` was truncated below `count`. */
  truncated?: boolean;
  /** Path-free convention label for the source (e.g. ".claude/agents"). */
  sourceLabel: string;
}

/**
 * What a project folder would contribute if trusted. Bounded and path-free;
 * an empty `items` array means "nothing detected" (dialog renders as today).
 */
export interface ProjectContributionReport {
  items: ProjectContributionItem[];
}

/**
 * D1.223 — should the folder-trust prompt be shown for a project whose
 * `trustState` is `'unknown'`?
 *
 * The prompt used to fire on the ABSENCE of a decision alone, so a folder with
 * nothing in it to trust asked a question with no consequence — and a question
 * with no consequence is the kind that teaches people to click through the next
 * one. What trust gates is narrow and enumerable: `native-sources.ts` includes
 * repository-owned project layers ONLY when the project is trusted, and gates
 * no file access; on Pi it also starts plugin language servers and post-edit checks (F1.809).
 *
 * It lives here, beside the report's own type, because the renderer decides and
 * `capabilities/project-contribution-detect.ts` — which produces the report —
 * imports `node:fs` and cannot be loaded in a browser context.
 *
 * FAIL-SOFT IN ONE DIRECTION ONLY. A null report — detection failed, the RPC
 * threw, the root was unreadable — answers TRUE and the user is asked, exactly
 * as before. Only a positive "this folder contributes nothing" suppresses the
 * question, and that is safe to act on because the check is re-run per session
 * view and per launch: the prompt returns the moment a `.claude/` or a
 * `.mcp.json` appears. The trust STATE is never touched — nothing is
 * auto-trusted, and the two residues the detector cannot see (layers between a
 * deeper working directory and the root, not the ones ABOVE it, read since F1.844;
 * nested skill roots, a function of what a session has read) are in its header.
 */
export function projectWouldContribute(report: ProjectContributionReport | null | undefined): boolean {
  if (!report) return true;
  return report.items.length > 0;
}

// ---------------------------------------------------------------------------
// Catalog rows
// ---------------------------------------------------------------------------

export interface SafeCapabilitySummary {
  key: string;
  kind: SafeCapabilityKind;
  logicalName: string;
  displayName?: string;
  description?: string;
  /** Source transport category used by existing renderer filters/badges. */
  sourceType?: 'api' | 'mcp' | 'local';
  /**
   * C6 (capability-path): the MCP transport of a `kind:'mcp'` row or an
   * MCP-transport source row, for the unified MCP servers panel. Value only —
   * never a URL, command or path.
   */
  mcpTransport?: 'stdio' | 'http' | 'sse' | 'ws';
  /**
   * Existing bracket-mention metadata; IDs are logical names, never paths.
   *
   * P6.694 widened the union by `'agent'`. `sub-agents.md#invoke-subagents-explicitly`:
   * *"Subagents provided by an enabled plugin appear in the typeahead under
   * their scoped name, such as `my-plugin:code-reviewer`"* — an identity the
   * catalog's `logicalName` cannot express, because that field holds the agent's
   * frontmatter `name` and two plugins may ship the same one. Before the
   * widening no agent row could legally carry this record at all, so the
   * renderer's `agentMentionInvocationId` fell through to `logicalName` and
   * emitted the bare name for every plugin agent.
   */
  mention?: {
    type: 'source' | 'skill' | 'agent';
    id: string;
    /** Exact path-free capability key for duplicate disambiguation/actions. */
    qualifiedId: string;
    selectedAsShortAlias: boolean;
    label: string;
  };
  /** Opaque app/data URL only (never an absolute managed path). */
  iconUrl?: string;
  origin: SafeCapabilityOrigin;
  /** Optional display-only projection (A9); never fed into activation/trust. */
  presentation?: SafePluginPresentationOrigin;
  /**
   * Presentation-only connector provenance (K4) for a connector-materialized
   * source. Cosmetic labeling only; never an activation/trust/credential input.
   */
  connectorOrigin?: SafeSourceConnectorOrigin;
  scope: SafeCapabilityScopeRef;
  state: SafeCapabilityAvailabilityState;
  readOnly: boolean;
  trustState: SafeCapabilityTrustState;
  credentialState: SafeCredentialAvailabilityState;
  selectedAsUnqualifiedAlias: boolean;
  unavailableReason?: string;
  diagnosticCodes: string[];
  /**
   * UB14.48 (v0.15.0 "A failed source test shows in the list") — Source-only: the verdict the source's
   * config.json stores from its last connection check (`source_test`'s save, the OAuth re-auth mark, the
   * token-refresh manager), already in the app's vocabulary: `source_test`'s `error`/`disconnected` read
   * `failed`, an unknown value `untested`. Absent when nothing was stored. Display only — the renderer's
   * `capabilitySummaryConnectionStatus` paints `failed` from it after `local_disabled` and `needs_auth`;
   * no activation, trust or credential decision reads it.
   */
  lastTestStatus?: SafeSourceConnectionStatus;
  /**
   * UB14.48 — Source-only: the reason stored beside {@link lastTestStatus}, reduced on the host
   * (`sanitizeStoredConnectionError`): URLs to scheme and host, absolute paths to their last segment,
   * recognised secrets to a marker, at most 1000 characters. Absent when nothing was stored; a passing
   * `source_test` clears it.
   */
  connectionError?: string;
}

export type SafeSourceCatalogItem = SafeCapabilitySummary & { kind: 'source' };
export type SafeSkillCatalogItem = SafeCapabilitySummary & { kind: 'skill' };

export function isSafeSourceCatalogItem(
  item: SafeCapabilitySummary,
): item is SafeSourceCatalogItem {
  return item.kind === 'source';
}

export function isSafeSkillCatalogItem(
  item: SafeCapabilitySummary,
): item is SafeSkillCatalogItem {
  return item.kind === 'skill';
}

export interface SafePluginOriginIdentity {
  marketplaceId: string;
  pluginId: string;
  listingId?: string;
  sourceId?: string;
}

/**
 * Display-only origin presentation (A9). Cosmetic ONLY: no path, URL,
 * executable declaration or secret ever lives here, and it is NEVER read by
 * activation/trust/permission/credential decisions. `format` is the detected
 * ecosystem format of the bundle (unknown pre-inspection or when no adapter
 * evidence exists); `acquisition` is how the plugin reached this machine.
 * Present only as an OPTIONAL field on user-facing projections
 * (`SafeCapabilitySummary`, `SafeInstalledPluginSummary`,
 * `SafeMarketplaceCatalogItem`) — absent from `EffectiveCapabilitySnapshot`,
 * resolver generation, runtime bindings, policy records, trust keys and
 * credential keys.
 */
export interface SafePluginPresentationOrigin {
  format: 'nessy' | 'codex' | 'claude' | 'unknown';
  acquisition:
    | 'nessy-marketplace' | 'external-marketplace' | 'repository'
    | 'local' | 'url' | 'unknown';
}

/**
 * Presentation-only connector provenance (K4) for a connector-materialized
 * source. Cosmetic labeling only — carries no secret/path and is never an
 * activation/trust/credential input. `authTiming` is scheduling metadata.
 */
export interface SafeSourceConnectorOrigin {
  pluginKey: string;
  connectorId: string;
  serverName: string;
  authTiming?: 'ON_INSTALL' | 'ON_FIRST_USE';
}

/** Value-free plugin MCP authentication presentation; never runtime readiness. */
export type SafePluginMcpAuthRequirement =
  | { kind: 'dp'; capabilityIds: string[]; serverNames: string[]; sharedProvider: 'dp'; timing: 'ON_FIRST_USE' }
  | { kind: 'oauth' | 'bearer'; connectorIds: string[]; serverNames: string[]; timing: 'ON_INSTALL' | 'ON_FIRST_USE' }
  | { kind: 'environment'; capabilityIds: string[]; serverNames: string[]; requiredNames: string[] }
  | { kind: 'unsupported-app'; appIds: string[]; connectorIds: string[] };

/** The sign-in kinds that can be attributed to one named MCP server. */
export type SafePluginServerAuthKind = 'dp' | 'oauth' | 'bearer' | 'environment';

/**
 * B2: which sign-in ONE plugin MCP server needs, so a surface listing servers
 * can tell the kind it is able to complete (`oauth`, via `performOAuth`) from
 * the kinds it is not (`bearer`/`environment` are configured on the plugin's
 * own page; `dp` is the one workspace-wide gateway sign-in).
 *
 * The join key is the server's `SafeCapabilitySummary.logicalName`, which for
 * a plugin MCP capability is the manifest `mcp.serverName`
 * (`projection-candidates.ts` pushes `capability.mcp.serverName` as the
 * logical name) — the same string `derivePluginMcpAuthRequirements` reports in
 * `serverNames`. Requirement order is the derivation's own precedence, so a
 * server carrying both an `authType` and required environment names answers
 * `oauth`: the OAuth flow is the half a list row can run.
 *
 * Deliberately NOT a new field on `SafeCapabilitySummary`. The kind already
 * crosses the wire per plugin on `SafeInstalledPluginSummary.authRequirements`
 * (`views.ts` projects it from the manifest), and a second projection of the
 * same manifest fact could disagree with the one the plugin page renders.
 */
export function pluginServerAuthKind(
  authRequirements: readonly SafePluginMcpAuthRequirement[] | undefined,
  serverName: string,
): SafePluginServerAuthKind | undefined {
  for (const requirement of authRequirements ?? []) {
    if (requirement.kind === 'unsupported-app') continue;
    if (requirement.serverNames.includes(serverName)) return requirement.kind;
  }
  return undefined;
}

export type SafePluginLifecycleViewState =
  | 'ready' | 'installing' | 'updating' | 'repair-required' | 'uninstalling' | 'error';

/**
 * One component a plugin contributes, for the plugin-detail inventory (U4).
 * Path-free by construction: name/description/kind come straight from the
 * resolved capability, and `capabilityKey` is the same opaque, path-free key
 * every other safe view already uses for actions/navigation. Never a path,
 * config, secret ref or bundle hash. Purely additive display data.
 */
export interface SafePluginComponent {
  /** The resolved capability's kind (skill / mcp / source / hook / …). */
  kind: SafeCapabilityKind;
  /** Already-resolved display name (displayName ?? logicalName). */
  name: string;
  description?: string;
  /**
   * Opaque path-free capability key. Present when the component maps to a
   * capability with its own detail page (skills, sources) — the renderer makes
   * such rows clickable. Absent for kinds with no dedicated detail route.
   */
  capabilityKey?: string;
  /**
   * Manifest-declared capability id (path-free) — the `set-capability-enabled`
   * action target. Present for plugin-projected components.
   */
  capabilityId?: string;
  /** Resolved enablement for the toggle switch; absent on legacy payloads. */
  enabled?: boolean;
  /** Reason CODE when disabled (e.g. 'capability-disabled'); never a path. */
  unavailableReason?: string;
}

export interface SafeInstalledPluginSummary {
  pluginKey: string;
  activeInstanceId: string;
  origin: SafePluginOriginIdentity;
  /** Optional display-only projection (A9); never fed into activation/trust. */
  presentation?: SafePluginPresentationOrigin;
  name: string;
  version: string;
  installedAt: number;
  lifecycleState: SafePluginLifecycleViewState;
  availableUpdateVersion?: string;
  capabilityKinds: SafeCapabilityKind[];
  /** Persisted path-free compatibility from the installed registry entry. */
  compatibility?: SafeInstalledPluginCompatibility;
  /** Immutable-manifest presentation only; never runtime readiness or authority. */
  authRequirements?: SafePluginMcpAuthRequirement[];
  /**
   * Unsatisfied declared plugin dependencies (`plugins/host-marketplace.md#depend-on-and-recommend-other-plugins`).
   * Present only when non-empty, which is `:217`'s shape ("Plugins that loaded
   * cleanly omit the field"), and always accompanied by
   * `activation.effective: 'inactive'` — `:208` disables the plugin until the
   * error is resolved. Path-free: a plugin name, an optional marketplace name,
   * and version strings.
   */
  dependencyErrors?: Array<{
    code:
      | 'dependency-unsatisfied'
      | 'dependency-version-unsatisfied'
      | 'range-conflict'
      /** `:127`/`:215` — no `{name}--v*` tag satisfies the range. */
      | 'no-matching-tag';
    dependency: string;
    marketplace?: string;
    range?: string;
    installedVersion?: string;
    /** `:127` — the versions the repository does tag, newest first. */
    availableVersions?: string[];
    message: string;
  }>;
  activation: {
    effective: 'active' | 'inactive' | 'blocked';
    global: 'enabled' | 'disabled' | 'unset';
    workspace: 'enabled' | 'disabled' | 'unset';
    project?: 'enabled' | 'disabled' | 'unset' | 'ineligible';
    /**
     * The managed policy's own `enabledPlugins` entry. `'enabled'` is a
     * fleet-wide force-enable that no user scope can undo, which is why
     * `actions.canDisable` is `false` alongside it. Path-free: a plugin key
     * verdict, never a policy path or file.
     */
    managed?: 'enabled' | 'disabled' | 'unset';
  };
  actions: {
    canEnable: boolean;
    canDisable: boolean;
    canUpdate: boolean;
    canRepair: boolean;
    canUninstall: boolean;
    reasonCodes: string[];
  };
  /**
   * Full component inventory for the plugin-detail page (U4). Additive: absent
   * on catalog projections that do not need it, populated by `toUserCatalog`
   * from the resolver snapshot entries that carry this plugin's `pluginKey`.
   * Path-free — see `SafePluginComponent`. Omitted when the plugin contributes
   * no resolved components (renderer shows a placeholder, never hides).
   */
  components?: SafePluginComponent[];
}

// ---------------------------------------------------------------------------
// Action requests (ID/ref-based only)
// ---------------------------------------------------------------------------

export type SafePluginActivationTarget =
  | { kind: 'global' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'project'; context: SafeProjectCapabilityContextRef };

export type SafePluginManagementActionRequest =
  | { pluginKey: string; action: 'enable' | 'disable'; target: SafePluginActivationTarget }
  | {
      pluginKey: string;
      action: 'set-capability-enabled';
      target: SafePluginActivationTarget;
      /** Manifest-declared capability id (path-free) inside the plugin. */
      capabilityId: string;
      enabled: boolean;
    }
  | { pluginKey: string; action: 'update' | 'repair' | 'uninstall' }
  | { pluginKey: string; action: 'configuration-status' | 'clear-configuration'; workspaceId: string }
  | {
      pluginKey: string;
      action: 'configure';
      workspaceId: string;
      /** One-way values: accepted by the privileged server and never echoed. */
      values: Record<string, string | number | boolean>;
    };

export interface SafePluginConfigurationFieldStatus {
  key: string;
  valueType: 'string' | 'number' | 'boolean' | 'file' | 'directory' | 'secret-ref';
  required: boolean;
  hasDefault: boolean;
  configured: boolean;
  missing: boolean;
  /**
   * `plugins/manifest-reference.md#user-configuration` — a sensitive option "masks input and stores the
   * value in secure storage". A NAME-ONLY flag: it says the field must be
   * masked, and carries no value, like every other field on this boundary.
   *
   * It has to cross: masking used to key off `valueType === 'secret-ref'`, which
   * is only MCPB's spelling, so a Claude `{"type": "string", "sensitive": true}`
   * token rendered as a plain text input.
   */
  sensitive: boolean;
  /** `:569` — "Label shown in the configuration dialog". */
  title?: string;
  /** `:570` — "Help text shown beneath the field". */
  description?: string;
}

export interface SafePluginConfigurationStatus {
  state: 'not-required' | 'needs_configuration' | 'ready';
  fields: SafePluginConfigurationFieldStatus[];
}

/** Path-free handoff to the existing Source OAuth UI. */
export interface SafeConnectorAuthRequest {
  workspaceId: string;
  sourceSlug: string;
}

/**
 * One connector source still awaiting authentication (T2, plugin-install
 * plan). INFORMATIONAL — unlike `authRequests` (the one-shot ON_INSTALL
 * `performOAuth` chain), this list names EVERY unauthenticated connector
 * source with its declared timing so the post-install checklist can tell the
 * whole truth without triggering any flow (§ 0b-2: Claude's no-chaining
 * model). Path-free: workspace id, source slug, connector identity, timing.
 */
export interface SafeConnectorPendingAuth {
  workspaceId: string;
  sourceSlug: string;
  connectorId?: string;
  serverName?: string;
  timing?: 'ON_INSTALL' | 'ON_FIRST_USE';
}

export interface SafePluginManagementActionResult {
  ok: boolean;
  pluginKey: string;
  action: SafePluginManagementActionRequest['action'];
  /** Repair/update compatibility, preserved at the same safe boundary as install. */
  state?: SafeMarketplacePluginCompatibilityState;
  requiresConfirmation?: boolean;
  deferred?: SafeMarketplacePluginDeferredCapability[];
  authRequests?: SafeConnectorAuthRequest[];
  /** Every connector source still awaiting auth, with timing (T2). */
  pendingAuth?: SafeConnectorPendingAuth[];
  authRequirements?: SafePluginMcpAuthRequirement[];
  /** Value-free configuration status; configured values never cross back. */
  configuration?: SafePluginConfigurationStatus;
}

export interface SafeNativeSourceCreateResult {
  ok: true;
  capabilityKey: string;
}

export type SafeMarketplaceListKind = 'skills' | 'plugins';
export type SafeMarketplaceItemKind = 'skill' | 'plugin' | 'mcp' | 'hook';
export type SafeMarketplaceSort = 'installs' | 'name' | 'tenant' | 'path';
export type SafeMarketplaceInstallSourceConfidence =
  | 'primary' | 'fallback' | 'command-derived'
  /** Coordinates derived from the listing's repository path, not published. */
  | 'coordinates-derived'
  | 'command-only'
  | 'unsupported-commands' | 'missing';

export type SafeMarketplaceIcon =
  | { kind: 'symbol'; name: 'skill' | 'plugin' | 'mcp' | 'hook' }
  | { kind: 'url'; url: string };

/** Allowlisted marketplace listing row. No raw DTO, install source or status. */
export interface SafeMarketplaceCatalogItem {
  marketplaceId: string;
  id: string;
  kind: SafeMarketplaceItemKind;
  listKind: SafeMarketplaceListKind;
  name: string;
  description?: string;
  version?: string;
  icon: SafeMarketplaceIcon;
  sourceUrl?: string;
  detailUrl?: string;
  tenant?: string;
  repo?: string;
  capabilities: string[];
  install: { sourceConfidence: SafeMarketplaceInstallSourceConfidence };
  /** Optional display-only projection (A9); never fed into activation/trust. */
  presentation?: SafePluginPresentationOrigin;
  /**
   * Path-free registry DISPLAY label (registry name only) for bring-your-own
   * registry rows (R2, additive, omit-when-empty). NEVER an absolute path
   * (`installedRoot`/`catalogRoot`). Absent on built-in Skills Market rows.
   * The registry id itself rides `marketplaceId`.
   */
  registryLabel?: string;
  /**
   * Listing ids this row previously had in the SAME marketplace, from the
   * catalog's `renames` map (C3, additive, omit-when-empty). The installed-vs-
   * catalog join reads these so a plugin installed under a former name is still
   * recognised as installed after an upstream rename. Removals (`renames`
   * values of `null`) never appear here. Absent on Skills Market rows.
   */
  formerIds?: string[];
  /**
   * `plugins/org.md#recommend-plugins` — "plugins marked as relevant to your current
   * working directory are pinned at the top with a **suggested for this
   * directory** label."
   *
   * Carries the matched SIGNAL, never a rendered sentence, so the label stays
   * translatable in the renderer. Additive and omit-when-absent: with no managed
   * allowlist, no cwd, or no `relevance` the field is missing and the list is
   * byte-identical to what it was before.
   *
   * P6.519 widened this to the second signal this fork decides,
   * `manifestDeps` — the label differs, so the kind has to cross. It stays a
   * closed union rather than `string`: `PluginRelevanceSignalKind` names three
   * further signals (`cli`, `hosts`, `filesRead`) that need a per-session
   * behavioural record this fork deliberately does not keep, and a widening
   * here is where that decision would silently unwind.
   */
  suggestion?: { signal: 'cwd' | 'manifestDeps' };
}

/** Path-free per-registry load failure surfaced to the renderer (R2, additive). */
export interface SafeMarketplaceRegistryLoadError {
  marketplaceId: string;
  displayName?: string;
  diagnosticCodes: string[];
}

export interface SafeMarketplaceListRequest {
  kind: SafeMarketplaceListKind;
  /**
   * The session whose WORKING DIRECTORY the `cwd` relevance signal is matched
   * against (`plugins/org.md#recommend-plugins`). An opaque session id, never a path —
   * the directory is resolved server-side and never crosses back. Optional: with
   * no session the suggestion pass simply produces nothing.
   */
  sessionId?: string;
  query?: string;
  page?: number;
  pageSize?: number;
  sort?: SafeMarketplaceSort;
  capabilities?: string[];
  phases?: string[];
  professions?: string[];
  tenants?: string[];
}

/**
 * Path-free request for one skill's raw SKILL.md body (frontmatter + markdown)
 * from the built-in Skills Market. `id` is the market skill id (the same id used
 * by the catalog rows and `/v1/skills/{id}`), never a filesystem path.
 */
export interface SafeMarketplaceSkillContentRequest {
  id: string;
}

export interface SafeMarketplaceListResult {
  items: SafeMarketplaceCatalogItem[];
  page: number;
  pageSize: number;
  total: number;
  visible: number;
  generatedAt?: string;
  nextPage?: number;
  /** Per-registry load failures for a `plugins` list (R2, additive, omit-when-empty). */
  registryLoadErrors?: SafeMarketplaceRegistryLoadError[];
  /**
   * P6.245 — the administrator's own text for the pre-install trust
   * confirmation, from the enforced managed policy's `pluginTrustMessage`.
   *
   * `settings-reference.md#plugintrustmessage`: "Add your organization's own
   * text to the plugin trust warning Claude Code shows before installation".
   * The vendored runtime renders it in the CLI's interactive UI, which this fork
   * never shows, so the host renders it — the same sentence on all three
   * runtimes.
   *
   * Additive and OMIT-WHEN-ABSENT, which is the managed-pair invariant stated on
   * the wire: a policy that says nothing sends nothing, so a fleet with no
   * managed trust message is byte-identical to what it was before. It rides the
   * list result rather than a channel of its own for the same reason
   * `registryLoadErrors` does — it describes the whole list, not one row — and
   * a reader takes it from the LAST page.
   */
  pluginTrustMessage?: string;
}

export type SafeMarketplaceListingRef =
  | {
      kind: 'listing';
      marketplaceId: string;
      listingId: string;
      listingKind: 'skills' | 'plugins';
    }
  | { kind: 'proposal'; proposalId: string };

export interface SafeMarketplacePluginInstallRequest {
  source: SafeMarketplaceListingRef;
  activateIn?: SafePluginActivationTarget;
}

/**
 * Path-free request for ONE not-yet-installed listing's declared composition,
 * fired when its detail page opens (D3). Ids only — the server owns the source.
 */
export interface SafeMarketplaceDeclaredComponentsRequest {
  marketplaceId: string;
  listingId: string;
  listingKind: 'skills' | 'plugins';
}

/**
 * What a LISTING declares it contains — never a measured inventory.
 *
 * `known: false` is the honest "the listing does not say". It covers BOTH "no
 * manifest was addressable" and "a manifest was read and declares nothing",
 * because those are the same fact to a reader: `plugins-reference.md` § Plugin
 * manifest schema — "The manifest is optional. If omitted, Claude Code
 * auto-discovers components in default locations." A silent manifest is
 * therefore no evidence of an empty plugin, and collapsing the two states stops
 * a caller from ever rendering one as if it were.
 *
 * Only an INSTALLED bundle's inventory can be empty, and that is a different
 * field on a different surface.
 */
export interface SafeMarketplaceDeclaredComponents {
  known: boolean;
  /** Declared kinds when `known`; always empty otherwise. Never a count. */
  kinds: string[];
}

export interface SafeMarketplacePluginProposalRequest {
  /** Explicit external user input; validated to reject credentials/non-allowlisted hosts. */
  sourceUrl: string;
  ref?: string;
  subdirectory?: string;
}

export type SafeMarketplacePluginDetectedFormat =
  | 'codex-plugin' | 'nessy-extension' | 'nessy-plugin' | 'skill' | 'mcpb' | 'unknown';

export type SafeMarketplacePluginInstallProposal =
  | {
      status: 'installable';
      /** Backend/client-bound, content-pinned, expiring and single-use. */
      proposalId: string;
      /** Normalized host/repository label; no userinfo/query/secret. */
      displaySource: string;
      detectedFormat: SafeMarketplacePluginDetectedFormat;
      expiresAt: number;
      diagnosticCodes: string[];
    }
  | {
      status: 'unsupported';
      displaySource: string;
      diagnosticCodes: string[];
    };

/**
 * Safe deferred-capability summary (A9 A7-carry). Preserves only the
 * external kind and reason code for a capability the runtime could not fully
 * support — never a source path.
 */
export interface SafeMarketplacePluginDeferredCapability {
  externalKind: string;
  reasonCode: string;
}

/** Re-declared by VALUE to match `PluginCompatibilityState` (plugins/types.ts). */
export type SafeMarketplacePluginCompatibilityState = 'supported' | 'partial' | 'blocked';

export interface SafeInstalledPluginCompatibility {
  state: SafeMarketplacePluginCompatibilityState;
  deferred: SafeMarketplacePluginDeferredCapability[];
}

export interface SafeMarketplacePluginInstallResult {
  ok: boolean;
  pluginKey?: string;
  diagnosticCodes: string[];
  /**
   * Server-computed compatibility state (A7), surfaced at the RPC boundary
   * (A9 A7-carry) so the renderer can drive partial-enable/blocked UI. Absent
   * when the install failed before a compatibility report existed.
   */
  state?: SafeMarketplacePluginCompatibilityState;
  /** Mirrors the install's `requiresConfirmation` (A7); a `partial` install
   * that needs an explicit user confirmation before it may be enabled. */
  requiresConfirmation?: boolean;
  /** Safe, path-free summary of capabilities the runtime deferred (A7). */
  deferred?: SafeMarketplacePluginDeferredCapability[];
  /**
   * P2.155 — the codes on the installed manifest's
   * `compatibility.adapter.warnings`: what the importer DROPPED while still
   * installing the bundle successfully.
   *
   * Deliberately separate from `deferred`, and it must never gate the install.
   * A `deferred` entry means a component was lost, so it makes the report
   * `partial` and demands a confirmation; these are dropped listing metadata
   * with no runtime effect, so they are shown on the SUCCESS path and block
   * nothing. Codes only — the messages name bundle paths and stay server-side.
   */
  adapterWarnings?: string[];
  /**
   * P2.107 — the SERVER's verdict on whether the installed plugin is live in the
   * running sessions: `'applied'` when every affected session took the refresh
   * (or had no runtime to refresh), `'deferred'` when at least one had a turn in
   * flight and its refresh is parked until the turn boundary.
   *
   * Absent means "cannot say" — the install committed but the refresh failed
   * soft, or the mutation never reached the refresh — and a client must fall
   * back to the conservative needs-refresh affordance rather than claim the
   * plugin is active. The renderer used to DERIVE this from the active session's
   * `isProcessing` flag, which mirrors only the first operand of the server's own
   * between-turns gate.
   */
  /**
   * P6.412 adds `'reloaded'`: at least one live session took the runtime's OWN
   * plugin reload (`Query.reloadPlugins()`, `sdk.d.ts:2544`) instead of being
   * torn down or deferred. Stronger than `'applied'` for the user — the plugin
   * is live in the very session they are looking at — and it carries a cost
   * `'applied'` does not, which is why it is a third value rather than folded
   * in: `plugins/loading.md#check-which-stage-a-plugin-reached` says
   * "Reloading has a token cost on the next request".
   */
  runtimeRefresh?: 'applied' | 'deferred' | 'reloaded' | 'failed'; // F1.396 — `failed`: a live session's refresh threw (F1.265's summary) — never 'cannot say'
  authRequests?: SafeConnectorAuthRequest[];
  /** Every connector source still awaiting auth, with timing (T2). */
  pendingAuth?: SafeConnectorPendingAuth[];
  authRequirements?: SafePluginMcpAuthRequirement[];
  /**
   * Enable-time configuration status for install-with-activation (T2), so the
   * userConfig dialog can fire on install, not only on the separate enable
   * RPC. Value-free, same shape as `configuration-status`.
   */
  configuration?: SafePluginConfigurationStatus;
}

// ---------------------------------------------------------------------------
// Bring-your-own registries (R3, additive)
// ---------------------------------------------------------------------------

/**
 * Add-registry request (Codex `MarketplaceAddParams`). `source` is a plain
 * string (repo `org/repo`, git URL, or local folder) — git-vs-local is
 * classified SERVER-side (no `gitlocal` enum crosses the boundary).
 */
export interface SafeMarketplaceAddRegistryRequest {
  source: string;
  refName?: string;
  sparsePaths?: string[];
}

/**
 * Add-registry result (Codex `MarketplaceAddResponse` MINUS `installedRoot` —
 * that absolute clone path NEVER crosses the boundary, Stop Condition).
 */
export interface SafeMarketplaceAddRegistryResult {
  marketplaceId: string;
  displayName: string;
  alreadyAdded: boolean;
}

/** Upgrade/remove a registry by its opaque id. */
export interface SafeMarketplaceRegistryRef {
  marketplaceId: string;
}

/** Upgrade result. Local-folder registries are a typed no-op (`upgraded:false`). */
export interface SafeMarketplaceUpgradeRegistryResult {
  marketplaceId: string;
  upgraded: boolean;
  /**
   * Why nothing was upgraded, when `upgraded` is false. The wire type carried
   * only `{marketplaceId, upgraded}` until now, so the renderer could say THAT
   * an upgrade failed but never WHY — it fell back to showing the opaque
   * registry id as the description. `0268e8f5` recorded the gap ("reason/
   * diagnosticCodes still stop at the RPC ... widening it is outside this
   * zone"); this is that widening.
   *
   * SAFE by construction: a fixed enum of server-chosen tags, never a message,
   * a path, or a source string.
   */
  reason?: 'not-git' | 'not-found' | 'fetch-failed' | 'fetch-timeout';
}

export interface SafeMarketplaceRemoveRegistryResult {
  marketplaceId: string;
  removed: boolean;
}

/** Path-free registry row for the manage surface (NO source path / installedRoot). */
export interface SafeMarketplaceRegistrySummary {
  marketplaceId: string;
  displayName: string;
  refName?: string;
  /**
   * The EFFECTIVE background-auto-update answer for this marketplace, already
   * resolved server-side through managed value → user toggle → default
   * polarity. `settings-reference.md#extraknownmarketplaces` — "Set
   * `"autoUpdate": true` alongside `source` to make Claude Code refresh that
   * marketplace and update its installed plugins in the background after
   * startup. When omitted, `claude-plugins-official` and most other official
   * Anthropic marketplaces default to `true`, and third-party marketplaces
   * default to `false`." Additive and optional so an older renderer is
   * unaffected; a missing value reads as `false`, which is the documented
   * default for every marketplace this fork can register.
   */
  autoUpdate?: boolean;
  /**
   * True when the managed policy fixed `autoUpdate` for this marketplace, so the
   * per-marketplace toggle is an administrator's decision and the control
   * renders disabled instead of offering a click the server will refuse.
   */
  autoUpdateManaged?: boolean;
}

/** Set the per-marketplace auto-update toggle (`plugins/install.md#turn-auto-update-on-or-off-for-a-marketplace`). */
export interface SafeMarketplaceSetRegistryAutoUpdateRequest {
  marketplaceId: string;
  autoUpdate: boolean;
}

export interface SafeMarketplaceSetRegistryAutoUpdateResult {
  marketplaceId: string;
  autoUpdate: boolean;
}

/**
 * P6.319 — the workflow governance settings as one RESOLVED read.
 *
 * The three keys are resolved host-side from the user layer, the managed layer
 * and the env off switch (`resolveWorkflowSettings`), and the advisory agent
 * threshold is derived from the guideline by `largeWorkflowAgentThreshold`. It
 * travels PRE-COMPUTED because a renderer that composed the layers itself would
 * be a second resolver, free to disagree with the one the model actually gets.
 *
 * `userSizeGuideline` is the value THIS user set, or absent when the resolved
 * value came from a managed layer or from the default — that is the difference
 * between a control that is showing your choice and one that is showing
 * somebody else's.
 *
 * The guideline union is RE-DECLARED here rather than imported, per this file's
 * own rule: the wire matches `config/workflow-settings.ts`'s
 * `WorkflowSizeGuideline` by VALUE, and the handler assigns one to the other, so
 * a member added there without a member here fails to compile.
 */
export type SafeWorkflowSizeGuideline = 'unrestricted' | 'small' | 'medium' | 'large';

export interface SafeWorkflowSettingsView {
  disableWorkflows: boolean;
  sizeGuideline: SafeWorkflowSizeGuideline;
  keywordTriggerEnabled: boolean;
  /** The advisory large-run warning threshold the guideline implies (25 by default). */
  agentThreshold: number;
  /** Present only when the user's own `config.json` layer set the guideline. */
  userSizeGuideline?: SafeWorkflowSizeGuideline;
}

/**
 * P6.209 (A44, A45) — the rules this installation hands the Claude Code
 * runtime's own auto-mode judge, for a READ-ONLY viewer.
 *
 * Sent as the four arrays are COMPOSED, not as they are configured: the page's
 * whole purpose is to show what the classifier is actually told, and a view
 * derived from the inputs would be a second composition that could disagree with
 * the one on the wire.
 *
 * `allow` is absent on purpose and is not an omission to fix — a deployment
 * policy may narrow what the judge permits and never widen it, so nothing here
 * ever grants. The renderer says so rather than leaving a blank section.
 *
 * The environment rules are split because ONE of them is session-scoped: the
 * gateway sentence is emitted only for a session whose adapter resolved the
 * `nestor` upstream, and a settings page has no session. Splitting is what lets
 * the page state the condition instead of picking a side and being wrong for
 * half the installs.
 */
export interface SafeClaudeAutoModePolicyView {
  /** Sent to every auto-mode Claude session. */
  environment: string[];
  /** Added on top, only for a session on the verified Nessy Gateway. */
  gatewayEnvironment: string[];
  hardDeny: string[];
  softDeny: string[];
  /** True when a managed policy asks for every shell command to be classified. */
  classifyAllShell: boolean;
}

/**
 * P6.209 (A42) — one refusal the Claude Code runtime's own auto-mode judge made
 * in this session, for a READ-ONLY list.
 *
 * A SAFE view rather than the receipt itself, and the two fields it drops are
 * the point. `toolInput` stays server-side: `auto-mode-config.md:377` records
 * that the vendor's own surface shows a shell command BY DESCRIPTION and not by
 * input, and a settings page that printed the refused arguments would be
 * publishing exactly the payload a judge just declined — a redaction policy this
 * row is not the place to invent. `toolUseId` stays too: it joins a turn's tool
 * call and means nothing outside the transcript.
 *
 * What remains is what makes the row an audit line rather than a rumour: what
 * was refused, in whose words, under which mode, and when. Listing a refusal is
 * NOT an offer to re-issue it — a retry re-executes a call a safety judge
 * declined and is a product posture, so it is deliberately absent from this
 * shape as well as from the surface.
 */
export interface SafeAutoModeDenialView {
  /** The tool the judge refused. */
  toolName: string;
  /** The denying component's own words (`hooks.md#permissiondenied` enumerates them). */
  reason: string;
  /** This app's permission mode at the moment of the refusal. */
  permissionMode: string;
  /** ISO-8601, minted by the producer's clock. */
  deniedAt: string;
}

/**
 * P6.721 — the denials ANSWER, with its own capability attached.
 *
 * A bare {@link SafeAutoModeDenialView} list could not distinguish *"the judge
 * refused nothing"* from *"this runtime has no judge history"*, and only ONE
 * client — the settings section — carried a static sentence saying which. A
 * second client reading the same channel would have reported the first for a Pi
 * or codex session. The capability rides WITH the answer so that every client
 * renders the same honest state without repeating a runtime check of its own.
 */
export interface AutoModeDenialsView {
  /** Whether this session's runtime mints denial receipts at all. */
  supported: boolean;
  /** The runtime that answered, so an unsupported answer can name it. */
  runtime: string;
  /** Oldest first, as the ring holds them. Always empty when `supported` is false. */
  denials: SafeAutoModeDenialView[];
}

/**
 * P6.517 / P6.518 — a built-in catalog that is DELIVERED but still switched off.
 *
 * Path-free by construction: the offer's `source` is a public `owner/repo` slug
 * pinned in `marketplace/built-in-marketplaces.ts`, never a clone path. The
 * name is the subject of the reserved-name rules, so it is the only thing the
 * enable call sends back — a source from the renderer is refused server-side.
 */
export interface SafeMarketplaceOffer {
  name: string;
  source: string;
  description: string;
}

export interface SafeMarketplaceRegistryListResult {
  registries: SafeMarketplaceRegistrySummary[];
  /**
   * Offers still off. Omitted when empty so an older renderer is unaffected and
   * the list is byte-identical to what it was before this existed. An offer an
   * administrator's `strictKnownMarketplaces` or `blockedMarketplaces` would
   * refuse never appears here, so no click is offered that the policy rejects.
   */
  available?: SafeMarketplaceOffer[];
}

/**
 * Enable one delivered built-in catalog. Carries the NAME only — the source is
 * pinned server-side, which is the property that keeps this from being an
 * `addRegistry` a caller could point anywhere.
 */
export interface SafeMarketplaceEnableOfferRequest {
  name: string;
}

// ---------------------------------------------------------------------------
// Managed-resource refs
// ---------------------------------------------------------------------------

export type SafeSessionRef = { workspaceId: string; sessionId: string };

export type CapabilityManagedResourceRef =
  | { scope: 'source'; workspaceId: string; sourceId: string; file: 'config' | 'permissions' | 'guide' }
  | { scope: 'skill'; tier: 'global'; skillId: string; file: 'manifest' | 'instructions' }
  | { scope: 'skill'; tier: 'workspace'; workspaceId: string; skillId: string; file: 'manifest' | 'instructions' }
  | { scope: 'skill'; tier: 'project'; session: SafeSessionRef; skillId: string; file: 'manifest' | 'instructions' }
  | { scope: 'skill'; tier: 'plugin'; pluginInstanceId: string; capabilityId: string; file: 'manifest' | 'instructions' };

export type MutableCapabilityManagedResourceRef = Exclude<
  CapabilityManagedResourceRef,
  { scope: 'skill'; tier: 'plugin' }
>;

export type PreviewableCapabilityManagedResourceRef =
  | Exclude<CapabilityManagedResourceRef, { scope: 'source' }>
  | { scope: 'source'; workspaceId: string; sourceId: string; file: 'permissions' | 'guide' };

export type CapabilityEditContextKey =
  | 'skill-instructions' | 'skill-metadata'
  | 'source-guide' | 'source-config' | 'source-permissions' | 'source-tool-permissions';

export type GlobalManagedResourceRef = {
  scope: 'global';
  kind: 'preferences-notes' | 'tool-icons' | 'default-permissions';
};

export type WorkspaceManagedResourceRef = {
  scope: 'workspace';
  workspaceId: string;
  kind: 'permissions' | 'labels' | 'statuses' | 'views' | 'automations' | 'sources-root' | 'skills-root';
};

export type ManagedResourceRef =
  | CapabilityManagedResourceRef
  | GlobalManagedResourceRef
  | WorkspaceManagedResourceRef;

export type MutableManagedResourceRef =
  | MutableCapabilityManagedResourceRef
  | GlobalManagedResourceRef
  | WorkspaceManagedResourceRef;

export type PreviewableManagedResourceRef =
  | PreviewableCapabilityManagedResourceRef
  | { scope: 'global'; kind: 'preferences-notes' | 'default-permissions' }
  | { scope: 'workspace'; workspaceId: string; kind: 'permissions' | 'labels' | 'statuses' | 'views' };

export type ManagedEditContextKey =
  | CapabilityEditContextKey
  | 'workspace-permissions' | 'default-permissions'
  | 'preferences-notes'
  | 'add-source' | 'add-source-api' | 'add-source-mcp' | 'add-source-local'
  | 'add-skill'
  | 'add-automation' | 'add-automation-scheduled' | 'add-automation-event'
  | 'add-automation-agentic' | 'automation-config'
  | 'edit-statuses' | 'edit-labels' | 'edit-auto-rules' | 'add-label'
  | 'edit-views' | 'edit-tool-icons';

export interface SafeCapabilityDetail {
  summary: SafeCapabilitySummary;
  /** Allowlisted display metadata only. */
  safeFields: Array<{ label: string; value: string }>;
  resources: Array<{
    ref: CapabilityManagedResourceRef;
    canPreview: boolean;
    canEdit: boolean;
    canOpen: boolean;
  }>;
  /**
   * Skill permission-mode projection (U2). Present only for a skill whose
   * SKILL.md frontmatter declares `alwaysAllow` tools; each row states how the
   * always-allowed set behaves under one of the five picker modes (F1.1052). Omitted
   * when the skill declares no always-allowed tools (renderer shows a
   * placeholder). Contains NO absolute paths — mode ids + a behavior code only.
   */
  permissionModes?: Array<{ mode: string; behavior: SafePermissionModeBehavior }>;
  /**
   * Source permission projection (U2). Present only for a source whose
   * `permissions.json` carries tool/bash/api/mcp rules; a read-only pattern +
   * access view. Path-based rules (write/denied paths) are deliberately
   * EXCLUDED so no absolute path can reach the renderer (Safe model).
   */
  permissions?: Array<{ pattern: string; access: SafePermissionAccess }>;
  /** Actionable diagnostics for this exact capability (A9); path-/secret-free. */
  diagnostics?: SafeCapabilityDiagnostic[];
}

/** How a skill's always-allowed tools behave under one permission mode (U2). */
export type SafePermissionModeBehavior = 'allowed' | 'blocked' | 'neutral';

/** Read-only access verdict for one source permission pattern (U2). */
export type SafePermissionAccess = 'allowed' | 'blocked';

export interface ManagedResourcePreview {
  title: string;
  content: string;
  contentType: 'text' | 'markdown';
  provenance?: string;
}

/**
 * One tool reported by a connected MCP source (U3). Name + description only —
 * the allowed-state is intentionally NOT projected (see the refusal note on
 * SafeMcpToolsResult / the U3 tracker). Never carries a schema, path or secret.
 */
export interface SafeMcpTool {
  name: string;
  description?: string;
}

/**
 * Why the MCP tools list could not be produced for a capability (U3). The RPC
 * NEVER throws to the renderer — every non-listable case fails soft to one of
 * these codes so the renderer can render an explanatory placeholder:
 *   - not-mcp:      the capability is not an MCP-transport source
 *   - no-session:   the context carries no live session to read a pool from
 *   - disabled:     the source is not active (disabled / unavailable) — NO
 *                   connection attempt is made
 *   - disconnected: the source is active but not connected YET. Since connect
 *                   left the turn's critical path this is the normal resting
 *                   state — the pool connects such a server on demand.
 *   - failed:       the source is active and the pool recorded a connect
 *                   failure (transport error or the connect deadline). It will
 *                   NOT be retried until its config changes, so it must read
 *                   differently from `disconnected`.
 *   - error:        the pool reply was malformed / listing failed
 */
export type SafeMcpToolsRefusalCode =
  | 'not-mcp' | 'no-session' | 'disabled' | 'disconnected' | 'failed' | 'error';

/** Result of `capabilities.listMcpTools` (U3). Fails soft — never throws. */
export type SafeMcpToolsResult =
  | { status: 'ok'; tools: SafeMcpTool[] }
  | { status: 'refused'; reason: SafeMcpToolsRefusalCode };

export interface SafeManagedResourceSummary {
  title: string;
  fields: Array<{ label: string; value: string }>;
  redacted: boolean;
}

export interface ManagedResourceEditRequest {
  session: SafeSessionRef;
  resource: MutableManagedResourceRef;
  contextKey: ManagedEditContextKey;
  instructions: string;
}

export type ManagedResourceEditResult = void;

export interface SafeCapabilityDiagnostic {
  severity: SafeCapabilityDiagnosticSeverity;
  code: string;
  /** Allowlisted/localized renderer key, never an internal exception string. */
  messageKey: string;
  /** Names/status only; no paths, commands, URLs or secret refs. */
  safeArgs?: Record<string, string>;
  capabilityKey?: string;
}

// ---------------------------------------------------------------------------
// View envelopes
// ---------------------------------------------------------------------------

export interface ComposerCatalogView {
  generation: string;
  items: SafeCapabilitySummary[];
}

export interface UserCapabilityCatalog {
  generation: string;
  installedPlugins: SafeInstalledPluginSummary[];
  capabilities: SafeCapabilitySummary[];
  diagnostics: SafeCapabilityDiagnostic[];
}

export interface CapabilityCatalogChangedEvent {
  workspaceId: string;
  sessionId?: string;
  generation: string;
  reasonCode: string;
  effect: 'refresh-before-next-turn' | 'revoke-active-snapshot';
}

// ---------------------------------------------------------------------------
// Trust review (path-free; server reconstructs the real trust key)
// ---------------------------------------------------------------------------

export type SafeTrustExecutableKind = 'plugin' | 'native-project';

/** Allowlisted review metadata only — never a path, env value or credential. */
export interface SafeTrustReviewItem {
  capabilityKey: string;
  capabilityName: string;
  executableKind: SafeTrustExecutableKind;
  scope: SafeCapabilityScopeRef;
  reasonCode: string;
  /** Allowlisted environment names reviewed by the user; never their values. */
  environmentNames?: string[];
}

export interface SafeTrustReviewsResult {
  items: SafeTrustReviewItem[];
}

/** Client supplies ONLY the capability key + capability context; never a hash/instance. */
export interface SafeGrantTrustRequest {
  capabilityKey: string;
  context: SafeCapabilityContextRef;
}

export interface SafeRevokeTrustRequest {
  capabilityKey: string;
  context: SafeCapabilityContextRef;
}

export interface SafeTrustMutationResult {
  ok: boolean;
  capabilityKey: string;
  authRequest?: SafeConnectorAuthRequest;
}

// ---------------------------------------------------------------------------
// Validators — the ingress guards. Reject any unsafe field at the boundary.
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every(key => keys.has(key));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/**
 * Validate a safe capability context ref from an untrusted (renderer/remote)
 * caller. Rejects any raw project/workspace root or other unexpected key so a
 * client can never smuggle a filesystem path through the safe ingress.
 */
export function isSafeCapabilityContextRef(value: unknown): value is SafeCapabilityContextRef {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.workspaceId)) return false;
  const keys = Object.keys(value);
  // Forbid any path-bearing or unexpected field on the ingress ref.
  const allowed = new Set(['workspaceId', 'sessionId', 'projectHandleId']);
  for (const key of keys) {
    if (!allowed.has(key)) return false;
  }
  if ('sessionId' in value && !isNonEmptyString(value.sessionId)) return false;
  if ('projectHandleId' in value && !isNonEmptyString(value.projectHandleId)) return false;
  // A session and a handle are mutually exclusive project addressers.
  if ('sessionId' in value && 'projectHandleId' in value) return false;
  return true;
}

function isSafeActivationTarget(value: unknown): value is SafePluginActivationTarget {
  if (!isPlainObject(value)) return false;
  if (value.kind === 'global') return hasOnlyKeys(value, ['kind']);
  if (value.kind === 'workspace') {
    return hasOnlyKeys(value, ['kind', 'workspaceId']) && isNonEmptyString(value.workspaceId);
  }
  if (value.kind === 'project') {
    return hasOnlyKeys(value, ['kind', 'context']) && isSafeCapabilityContextRef(value.context);
  }
  return false;
}

/** Validate a plugin management action request; every variant is ID/ref-based. */
export function isSafePluginManagementActionRequest(
  value: unknown,
): value is SafePluginManagementActionRequest {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.pluginKey)) return false;
  const action = value.action;
  if (action === 'enable' || action === 'disable') {
    return hasOnlyKeys(value, ['pluginKey', 'action', 'target'])
      && isSafeActivationTarget(value.target);
  }
  if (action === 'set-capability-enabled') {
    return hasOnlyKeys(value, ['pluginKey', 'action', 'target', 'capabilityId', 'enabled'])
      && isSafeActivationTarget(value.target)
      && isNonEmptyString(value.capabilityId)
      && typeof value.enabled === 'boolean';
  }
  if (action === 'configuration-status' || action === 'clear-configuration') {
    return hasOnlyKeys(value, ['pluginKey', 'action', 'workspaceId'])
      && isNonEmptyString(value.workspaceId);
  }
  if (action === 'configure') {
    if (!hasOnlyKeys(value, ['pluginKey', 'action', 'workspaceId', 'values'])
      || !isNonEmptyString(value.workspaceId)
      || !isPlainObject(value.values)
      || Object.keys(value.values).length > 128) return false;
    return Object.entries(value.values).every(([key, configured]) => (
      /^[A-Za-z0-9._-]+$/.test(key)
      && key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
      && ((typeof configured === 'string' && configured.length > 0 && configured.length <= 65_536)
        || (typeof configured === 'number' && Number.isFinite(configured))
        || typeof configured === 'boolean')
    ));
  }
  return (action === 'update' || action === 'repair' || action === 'uninstall')
    && hasOnlyKeys(value, ['pluginKey', 'action']);
}

const FORBIDDEN_PROPOSAL_URL_MARKERS = ['@']; // reject userinfo/credentials in URLs.

/**
 * Validate a marketplace proposal request. The URL is explicit user input, but
 * embedded credentials (userinfo) are rejected here before the backend ever
 * dereferences it.
 */
export function isSafeMarketplacePluginProposalRequest(
  value: unknown,
): value is SafeMarketplacePluginProposalRequest {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, ['sourceUrl', 'ref', 'subdirectory'])) return false;
  if (!isNonEmptyString(value.sourceUrl)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value.sourceUrl);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (FORBIDDEN_PROPOSAL_URL_MARKERS.some(marker => parsed.host.includes(marker))) return false;
  if ('ref' in value && value.ref !== undefined && typeof value.ref !== 'string') return false;
  if ('subdirectory' in value && value.subdirectory !== undefined && typeof value.subdirectory !== 'string') return false;
  return true;
}

/** Validate the path-free, filter-only marketplace catalog request. */
export function isSafeMarketplaceListRequest(
  value: unknown,
): value is SafeMarketplaceListRequest {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, [
    'kind', 'sessionId', 'query', 'page', 'pageSize', 'sort',
    'capabilities', 'phases', 'professions', 'tenants',
  ])) return false;
  if (value.kind !== 'skills' && value.kind !== 'plugins') return false;
  if ('sessionId' in value && value.sessionId !== undefined && !isNonEmptyString(value.sessionId)) return false;
  if ('query' in value && value.query !== undefined && typeof value.query !== 'string') return false;
  if ('page' in value && value.page !== undefined
    && (!Number.isInteger(value.page) || (value.page as number) < 1)) return false;
  if ('pageSize' in value && value.pageSize !== undefined
    && (!Number.isInteger(value.pageSize) || (value.pageSize as number) < 1 || (value.pageSize as number) > 100)) return false;
  if ('sort' in value && value.sort !== undefined
    && value.sort !== 'installs' && value.sort !== 'name'
    && value.sort !== 'tenant' && value.sort !== 'path') return false;
  for (const key of ['capabilities', 'phases', 'professions', 'tenants'] as const) {
    if (key in value && value[key] !== undefined && !isStringArray(value[key])) return false;
  }
  return true;
}

/** Validate a skill-content request: a single non-empty market skill id. */
export function isSafeMarketplaceSkillContentRequest(
  value: unknown,
): value is SafeMarketplaceSkillContentRequest {
  return isPlainObject(value) && hasOnlyKeys(value, ['id']) && isNonEmptyString(value.id);
}

/** Validate a declared-components request: ids only, same shape as a listing ref. */
export function isSafeMarketplaceDeclaredComponentsRequest(
  value: unknown,
): value is SafeMarketplaceDeclaredComponentsRequest {
  return isPlainObject(value)
    && hasOnlyKeys(value, ['marketplaceId', 'listingId', 'listingKind'])
    && isNonEmptyString(value.marketplaceId)
    && isNonEmptyString(value.listingId)
    && (value.listingKind === 'skills' || value.listingKind === 'plugins');
}

/** Validate a marketplace install request; only stable IDs / opaque proposalId. */
export function isSafeMarketplacePluginInstallRequest(
  value: unknown,
): value is SafeMarketplacePluginInstallRequest {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, ['source', 'activateIn'])) return false;
  const source = value.source;
  if (!isPlainObject(source)) return false;
  if (source.kind === 'listing') {
    if (!hasOnlyKeys(source, ['kind', 'marketplaceId', 'listingId', 'listingKind'])) return false;
    if (!isNonEmptyString(source.marketplaceId) || !isNonEmptyString(source.listingId)) return false;
    if (source.listingKind !== 'skills' && source.listingKind !== 'plugins') return false;
  } else if (source.kind === 'proposal') {
    if (!hasOnlyKeys(source, ['kind', 'proposalId'])) return false;
    if (!isNonEmptyString(source.proposalId)) return false;
  } else {
    return false;
  }
  if ('activateIn' in value && value.activateIn !== undefined && !isSafeActivationTarget(value.activateIn)) {
    return false;
  }
  return true;
}

/**
 * Validate an add-registry request (R3). `source` is a non-empty string; the
 * server classifies git-vs-local. Optional `refName` string + `sparsePaths`
 * string array. No absolute-path field is allowed in.
 */
export function isSafeMarketplaceAddRegistryRequest(
  value: unknown,
): value is SafeMarketplaceAddRegistryRequest {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, ['source', 'refName', 'sparsePaths'])) return false;
  if (!isNonEmptyString(value.source)) return false;
  if ('refName' in value && value.refName !== undefined && typeof value.refName !== 'string') return false;
  if ('sparsePaths' in value && value.sparsePaths !== undefined && !isStringArray(value.sparsePaths)) return false;
  return true;
}

/**
 * Validate an enable-offer request: a single non-empty `name` and nothing else.
 * `hasOnlyKeys` is what stops a caller smuggling a `source` in beside it.
 */
export function isSafeMarketplaceEnableOfferRequest(
  value: unknown,
): value is SafeMarketplaceEnableOfferRequest {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, ['name'])) return false;
  return isNonEmptyString(value.name);
}

/** Validate an upgrade/remove registry ref (R3): only an opaque `marketplaceId`. */
export function isSafeMarketplaceRegistryRef(
  value: unknown,
): value is SafeMarketplaceRegistryRef {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, ['marketplaceId'])) return false;
  return isNonEmptyString(value.marketplaceId);
}

/** Validate the auto-update toggle request: an opaque id plus a strict Boolean. */
export function isSafeMarketplaceSetRegistryAutoUpdateRequest(
  value: unknown,
): value is SafeMarketplaceSetRegistryAutoUpdateRequest {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, ['marketplaceId', 'autoUpdate'])) return false;
  return isNonEmptyString(value.marketplaceId) && typeof value.autoUpdate === 'boolean';
}

export function isCapabilityManagedResourceRef(
  value: unknown,
): value is CapabilityManagedResourceRef {
  if (!isPlainObject(value) || (value.scope !== 'source' && value.scope !== 'skill')) return false;
  if (value.scope === 'source') {
    return Object.keys(value).every(key => ['scope', 'workspaceId', 'sourceId', 'file'].includes(key))
      && isNonEmptyString(value.workspaceId)
      && isNonEmptyString(value.sourceId)
      && (value.file === 'config' || value.file === 'permissions' || value.file === 'guide');
  }
  if (!isNonEmptyString(value.tier) || !isNonEmptyString(value.file)) return false;
  if (value.file !== 'manifest' && value.file !== 'instructions') return false;
  if (value.tier === 'global') {
    return Object.keys(value).every(key => ['scope', 'tier', 'skillId', 'file'].includes(key))
      && isNonEmptyString(value.skillId);
  }
  if (value.tier === 'workspace') {
    return Object.keys(value).every(key => ['scope', 'tier', 'workspaceId', 'skillId', 'file'].includes(key))
      && isNonEmptyString(value.workspaceId)
      && isNonEmptyString(value.skillId);
  }
  if (value.tier === 'project') {
    return Object.keys(value).every(key => ['scope', 'tier', 'session', 'skillId', 'file'].includes(key))
      && isPlainObject(value.session)
      && Object.keys(value.session).every(key => key === 'workspaceId' || key === 'sessionId')
      && isNonEmptyString(value.session.workspaceId)
      && isNonEmptyString(value.session.sessionId)
      && isNonEmptyString(value.skillId);
  }
  if (value.tier === 'plugin') {
    return Object.keys(value).every(key => ['scope', 'tier', 'pluginInstanceId', 'capabilityId', 'file'].includes(key))
      && isNonEmptyString(value.pluginInstanceId)
      && isNonEmptyString(value.capabilityId);
  }
  return false;
}

export function isManagedResourceRef(value: unknown): value is ManagedResourceRef {
  if (isCapabilityManagedResourceRef(value)) return true;
  if (!isPlainObject(value)) return false;
  if (value.scope === 'global') {
    return hasOnlyKeys(value, ['scope', 'kind'])
      && (value.kind === 'preferences-notes'
        || value.kind === 'tool-icons'
        || value.kind === 'default-permissions');
  }
  if (value.scope === 'workspace') {
    return hasOnlyKeys(value, ['scope', 'workspaceId', 'kind'])
      && isNonEmptyString(value.workspaceId)
      && (value.kind === 'permissions'
        || value.kind === 'labels'
        || value.kind === 'statuses'
        || value.kind === 'views'
        || value.kind === 'automations'
        || value.kind === 'sources-root'
        || value.kind === 'skills-root');
  }
  return false;
}

export function isMutableManagedResourceRef(value: unknown): value is MutableManagedResourceRef {
  return isManagedResourceRef(value)
    && !(value.scope === 'skill' && value.tier === 'plugin');
}

export function isPreviewableManagedResourceRef(value: unknown): value is PreviewableManagedResourceRef {
  if (!isManagedResourceRef(value)) return false;
  if (value.scope === 'source') return value.file !== 'config';
  if (value.scope === 'skill') return true;
  if (value.scope === 'global') return value.kind !== 'tool-icons';
  return value.kind === 'permissions'
    || value.kind === 'labels'
    || value.kind === 'statuses'
    || value.kind === 'views';
}

const MANAGED_EDIT_CONTEXT_KEYS = new Set<ManagedEditContextKey>([
  'skill-instructions', 'skill-metadata',
  'source-guide', 'source-config', 'source-permissions', 'source-tool-permissions',
  'workspace-permissions', 'default-permissions', 'preferences-notes',
  'add-source', 'add-source-api', 'add-source-mcp', 'add-source-local', 'add-skill',
  'add-automation', 'add-automation-scheduled', 'add-automation-event',
  'add-automation-agentic', 'automation-config',
  'edit-statuses', 'edit-labels', 'edit-auto-rules', 'add-label',
  'edit-views', 'edit-tool-icons',
]);

export function isManagedEditContextKey(value: unknown): value is ManagedEditContextKey {
  return typeof value === 'string' && MANAGED_EDIT_CONTEXT_KEYS.has(value as ManagedEditContextKey);
}

export function isManagedResourceEditRequest(
  value: unknown,
): value is ManagedResourceEditRequest {
  return isPlainObject(value)
    && hasOnlyKeys(value, ['session', 'resource', 'contextKey', 'instructions'])
    && isPlainObject(value.session)
    && hasOnlyKeys(value.session, ['workspaceId', 'sessionId'])
    && isNonEmptyString(value.session.workspaceId)
    && isNonEmptyString(value.session.sessionId)
    && isMutableManagedResourceRef(value.resource)
    && isManagedEditContextKey(value.contextKey)
    && isNonEmptyString(value.instructions);
}

/**
 * Validate a grant-trust request. ID/ref-based only: the client supplies a
 * `capabilityKey` and a capability context — never an executable hash,
 * plugin instance id or scope. The server reconstructs those from a fresh
 * snapshot before calling `CapabilityTrustStore`.
 */
export function isSafeGrantTrustRequest(value: unknown): value is SafeGrantTrustRequest {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, ['capabilityKey', 'context'])) return false;
  return isNonEmptyString(value.capabilityKey) && isSafeCapabilityContextRef(value.context);
}

/** Validate a revoke-trust request; same path-free shape as grant. */
export function isSafeRevokeTrustRequest(value: unknown): value is SafeRevokeTrustRequest {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, ['capabilityKey', 'context'])) return false;
  return isNonEmptyString(value.capabilityKey) && isSafeCapabilityContextRef(value.context);
}

/**
 * Availability views (W8 Steps 5-6).
 *
 * Three pure projections of one `EffectiveCapabilitySnapshot`:
 * - `toAgentRuntime` — server-only runtime view Pi/BaseAgent consume. Resources
 *   stay pinned (revision + contentHash); secrets resolve lazily immediately
 *   before start via the captured `RuntimeCredentialBinding`.
 * - `toComposerCatalog` / `toUserCatalog` — path-/secret-free renderer DTOs.
 *
 * Every projection carries the SAME `generation` as its snapshot and never
 * rediscovers candidates, re-reads policy or re-runs precedence.
 */

import type {
  ComposerCatalogView,
  SafeCapabilityAvailabilityState,
  SafeCapabilityDiagnostic,
  SafeCapabilityKind,
  SafeCapabilitySummary,
  SafeCredentialAvailabilityState,
  SafeInstalledPluginSummary,
  SafeCapabilityTrustState,
  SafePluginComponent,
  SafePluginMcpAuthRequirement,
  SafePluginPresentationOrigin,
  UserCapabilityCatalog,
} from '../protocol/capabilities.ts';
import type { PluginMcpAuthRequirement } from '../plugins/auth-requirements.ts';
import { pluginIdFromInstanceId } from './mcp-wire-name.ts';
import type {
  CapabilityDiagnostic,
  EffectiveCapabilitySnapshot,
  ResolvedCapability,
  ResolvedCapabilityEntry,
  ResolvedInstalledPlugin,
  RuntimeAgentDefinition,
  RuntimeAppRegistration,
  RuntimeAutomationRegistration,
  RuntimeCommandRegistration,
  RuntimeHookRegistration,
  RuntimeLspRegistration,
  RuntimeMonitorRegistration,
  RuntimeMcpServer,
  RuntimeMemoryHandle,
  RuntimePermissionLayer,
  PluginRuntimeContext,
  RuntimeOutputStyleDefinition,
  RuntimePromptCommandDefinition,
  RuntimePromptLayer,
  ResolvedCapabilityKind,
} from './resolver.ts';
import type { NativeResourceRef } from './resolver.ts';
import type { AgentProvider } from '../agent/backend/types.ts';
import { describePluginDependencyError } from '../plugins/dependencies.ts';
import type { PluginBundleResourceRef, PluginInstanceId, PluginKey } from '../plugins/types.ts';
import type { RuntimeCredentialBinding } from '../credentials/types.ts';
import type { SkillOverrideState } from '../config/skill-overrides.ts';

// ---------------------------------------------------------------------------
// Agent runtime view (server-only; keeps resources/paths)
// ---------------------------------------------------------------------------

export interface RuntimeSourceHandle {
  key: string;
  logicalName: string;
  resource: NativeResourceRef | PluginBundleResourceRef;
  guideResource?: NativeResourceRef;
  credential?: RuntimeCredentialBinding;
  /** Present only for Source configs whose transport is MCP. */
  mcpWireName?: string;
}

export interface RuntimeSkillHandle {
  key: string;
  logicalName: string;
  description: string;
  selectedAsUnqualifiedAlias: boolean;
  resource: NativeResourceRef | PluginBundleResourceRef;
  /**
   * Pinned invocation controls from the SKILL.md frontmatter (P7). The skill
   * listing, the model-invocation refusal and the `/slug` registration all read
   * these from the handle and NEVER from disk. Absent means "not stated", so the
   * documented defaults apply (`disableModelInvocation: false`,
   * `userInvocable: true`).
   */
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  /**
   * The SETTINGS-side visibility state (`skills.md:663`, R61), pinned on the
   * handle for the same reason the frontmatter pair above is: the listing, the
   * `/slug` registration and the invocation gate must all read ONE value and
   * never re-derive it. Absent means the documented default `"on"`
   * (`skills.md:678`).
   *
   * Never present on a plugin skill — `skills.md:689` exempts them, and the
   * resolver's plugin branch does not carry the field at all.
   */
  overrideState?: SkillOverrideState;
  /**
   * `allowed-tools`. ENFORCED since R17b: `materializeRuntimeSkillInvocation`
   * pins it onto the invocation record and `collectSkillToolGrants` turns it
   * into the turn's PRE-APPROVAL — the listed tools skip the permission prompt,
   * and unlisted tools stay callable (it stopped being a ceiling on
   * 2026-08-13). This handle is also what the capability view displays, so the
   * two must be the same value read the same way.
   */
  allowedTools?: string[];
  /**
   * `paths` (`skills.md:267`) — when set, the MODEL may invoke the skill only
   * while working with a file matching one of these patterns. The user's own
   * invocation is never gated by it.
   */
  paths?: string[];
  /**
   * The directory BELOW the working directory that owns this skill (R79) —
   * `apps/web`. Present only on a nested skill.
   *
   * THE handle field for `skills.md:128`'s directory-qualified name. Three
   * consumers spell `${directoryQualifier}:${logicalName}` from it and must
   * never spell it three ways: the `/` menu entry
   * (`custom-commands.ts:selectSkillSlashCommands` → `/apps/web:deploy`), the
   * model-facing listing (`prompt-builder.ts:skillListingReference`), and the
   * reference form both invocation paths resolve
   * (`base-agent.ts:resolveSkillReferences`).
   *
   * Distinct from {@link paths}, which is the adjacent mechanism this fork
   * already had: `paths` says "this ROOT skill applies while working under
   * apps/web", the qualifier says "apps/web owns this skill".
   */
  directoryQualifier?: string;
  /** Compatibility profile and immutable/data roots for plugin-authored text. */
  pluginRuntime?: PluginRuntimeContext;
  /**
   * `plugins/manifest-reference.md#environment-variables` — "Non-sensitive values can also be substituted
   * in skill and agent content."
   *
   * NON-SENSITIVE ONLY. The resolver builds this map from
   * `pluginUserConfigContentValues`, which never admits a sensitive field, so a
   * secret cannot reach a skill body, the invocation record persisted from it,
   * or the transcript that record renders into.
   */
  pluginUserConfig?: Record<string, string>;
}

/**
 * P6.411 — why one capability the user installed is NOT in the view above.
 *
 * `isRunnable` drops a non-runnable entry with a bare `continue`, and that
 * silence is the row's defect: a session could not say which plugins actually
 * loaded and which did not. The reason is recorded HERE, at the single point all
 * three runtimes pass through, so the answer cannot differ between them.
 *
 * `reason` is the FIRST test that rejected the entry, in `isRunnable`'s own
 * order — a value, never a sentence, so the surface that shows it owns the
 * wording and the locale.
 */
export interface RuntimeWithheldCapability {
  /** The capability key, as the runnable entries carry it. */
  key: string;
  kind: ResolvedCapabilityKind;
  logicalName: string;
  /** Absent for a builtin or native capability — those belong to no plugin. */
  pluginKey?: PluginKey;
  pluginInstanceId?: PluginInstanceId;
  reason: 'disabled' | 'review-required' | 'blocked' | 'unsupported-runtime';
}

export interface AgentRuntimeView {
  generation: string;
  sources: RuntimeSourceHandle[];
  skills: RuntimeSkillHandle[];
  mcpServers: RuntimeMcpServer[];
  hooks: RuntimeHookRegistration[];
  automations: RuntimeAutomationRegistration[];
  agents: RuntimeAgentDefinition[];
  promptLayers: RuntimePromptLayer[];
  memory: RuntimeMemoryHandle[];
  permissionLayers: RuntimePermissionLayer[];
  commands: RuntimeCommandRegistration[];
  promptCommands: RuntimePromptCommandDefinition[];
  apps: RuntimeAppRegistration[];
  /**
   * Plugin-declared language servers (B3), provisioned by the trusted-project
   * LSP owner. Optional so pre-B3 hand-built views/fixtures stay valid; the
   * real producer (`toAgentRuntime`) always populates it.
   */
  lspServers?: RuntimeLspRegistration[];
  /** Trusted plugin monitors, delivered only while the owning agent is live. */
  monitors?: RuntimeMonitorRegistration[];
  /**
   * Plugin-shipped output styles the user MAY select (`output-styles.md:83`).
   * Presence in this list grants nothing: the prompt builder applies one only
   * when `config.json:outputStyleId` names it. Optional so pre-existing
   * hand-built views/fixtures stay valid.
   */
  outputStyles?: RuntimeOutputStyleDefinition[];
  /**
   * Every capability the snapshot carried that this view deliberately does NOT
   * expose, with the reason (P6.411). Optional so pre-existing hand-built views
   * and fixtures stay valid; the real producer always populates it, empty
   * included — an empty array is "nothing was withheld", which is a different
   * statement from the field being absent.
   */
  withheld?: RuntimeWithheldCapability[];
}

/**
 * Why this capability may not run this turn, or `null` when it may.
 *
 * The order is load-bearing and is the order the old boolean tested in: a
 * capability that is both disabled AND review-required reports `disabled`,
 * because that is the one the user can act on without a trust decision.
 */
function withheldReason(entry: ResolvedCapabilityEntry): RuntimeWithheldCapability['reason'] | null {
  const s = entry.summary;
  if (!s.enabled) return 'disabled';
  if (s.trustState === 'review-required') return 'review-required';
  if (s.trustState === 'blocked') return 'blocked';
  if (s.unavailableReason === 'unsupported-runtime') return 'unsupported-runtime';
  return null;
}

/**
 * True only when the capability may actually run this turn.
 *
 * Kept as the one predicate the loop reads, derived from {@link withheldReason}
 * so the runnable test and the withheld record can never disagree — the pair
 * used to be two independent condition lists, which is how a reason can drift
 * away from the decision it explains.
 */
function isRunnable(entry: ResolvedCapabilityEntry): boolean {
  return withheldReason(entry) === null;
}

export function toAgentRuntime(snapshot: EffectiveCapabilitySnapshot): AgentRuntimeView {
  const sources: RuntimeSourceHandle[] = [];
  const skills: RuntimeSkillHandle[] = [];
  const mcpServers: RuntimeMcpServer[] = [];
  const hooks: RuntimeHookRegistration[] = [];
  const automations: RuntimeAutomationRegistration[] = [];
  const agents: RuntimeAgentDefinition[] = [];
  const promptLayers: RuntimePromptLayer[] = [];
  const memory: RuntimeMemoryHandle[] = [];
  const permissionLayers: RuntimePermissionLayer[] = [];
  const commands: RuntimeCommandRegistration[] = [];
  const promptCommands: RuntimePromptCommandDefinition[] = [];
  const apps: RuntimeAppRegistration[] = [];
  const lspServers: RuntimeLspRegistration[] = [];
  const monitors: RuntimeMonitorRegistration[] = [];
  const outputStyles: RuntimeOutputStyleDefinition[] = [];
  const withheld: RuntimeWithheldCapability[] = [];

  for (const entry of snapshot.entries) {
    const reason = withheldReason(entry);
    if (reason) {
      const s = entry.summary;
      withheld.push({
        key: s.key,
        kind: s.kind,
        logicalName: s.logicalName,
        ...(s.pluginKey ? { pluginKey: s.pluginKey } : {}),
        ...(s.pluginInstanceId ? { pluginInstanceId: s.pluginInstanceId } : {}),
        reason,
      });
      continue;
    }
    const binding = entry.runtimeBinding;
    const s = entry.summary;
    switch (binding.kind) {
      case 'source':
        sources.push({
          key: s.key,
          logicalName: s.logicalName,
          resource: binding.resource,
          ...(binding.guideResource ? { guideResource: binding.guideResource } : {}),
          ...(binding.credential ? { credential: binding.credential } : {}),
          ...(binding.mcpWireName ? { mcpWireName: binding.mcpWireName } : {}),
        });
        break;
      case 'skill':
        skills.push({
          key: s.key,
          logicalName: s.logicalName,
          description: s.description ?? '',
          selectedAsUnqualifiedAlias: s.selectedAsUnqualifiedAlias,
          resource: binding.resource,
          ...(s.skillDisableModelInvocation === undefined
            ? {}
            : { disableModelInvocation: s.skillDisableModelInvocation }),
          ...(s.skillUserInvocable === undefined ? {} : { userInvocable: s.skillUserInvocable }),
          ...(s.skillOverrideState ? { overrideState: s.skillOverrideState } : {}),
          ...(s.skillAllowedTools ? { allowedTools: s.skillAllowedTools } : {}),
          ...(s.skillPaths ? { paths: s.skillPaths } : {}),
          ...(s.skillDirectoryQualifier
            ? { directoryQualifier: s.skillDirectoryQualifier }
            : {}),
          ...(binding.pluginRuntime ? { pluginRuntime: binding.pluginRuntime } : {}),
          ...(binding.pluginUserConfig ? { pluginUserConfig: binding.pluginUserConfig } : {}),
        });
        break;
      case 'mcp':
        mcpServers.push(binding.server);
        break;
      case 'hook':
        hooks.push(binding.hook);
        break;
      case 'automation':
        automations.push(binding.automation);
        break;
      case 'agent':
        agents.push({
          ...binding.agent,
          selectedAsUnqualifiedAlias: s.selectedAsUnqualifiedAlias,
        });
        break;
      case 'instruction':
        promptLayers.push(binding.layer);
        break;
      case 'memory':
        memory.push(binding.memory);
        break;
      case 'permission':
        permissionLayers.push(binding.layer);
        break;
      case 'command':
        commands.push(binding.command);
        break;
      case 'prompt-command':
        promptCommands.push(binding.promptCommand);
        break;
      case 'workflow':
        // Task 4 projects plugin workflows into the Pi recipe store. The host
        // slash registry consumes this binding directly from the snapshot.
        break;
      case 'app':
        apps.push(binding.app);
        break;
      case 'lsp':
        lspServers.push(binding.lsp);
        break;
      case 'monitor':
        monitors.push(binding.monitor);
        break;
      case 'output-style':
        outputStyles.push(binding.outputStyle);
        break;
      case 'setting':
      case 'asset':
        // Not directly executable; carried in catalogs only.
        break;
    }
  }

  promptLayers.sort((a, b) => a.order - b.order);
  permissionLayers.sort((a, b) => a.order - b.order);

  return {
    generation: snapshot.generation,
    sources, skills, mcpServers, hooks, automations, agents,
    promptLayers, memory, permissionLayers, commands, promptCommands, apps, lspServers, monitors,
    outputStyles, withheld,
  };
}

// ---------------------------------------------------------------------------
// Safe renderer views (path-/secret-free)
// ---------------------------------------------------------------------------

function availabilityState(cap: ResolvedCapability): SafeCapabilityAvailabilityState {
  if (cap.trustState === 'review-required') return 'review-required';
  if (cap.trustState === 'blocked') return 'invalid';
  if (cap.credentialState === 'missing' || cap.credentialState === 'expired') return 'missing-credential';
  if (cap.unavailableReason === 'unsupported-runtime') return 'unsupported-runtime';
  if (!cap.enabled) return 'disabled';
  return 'active';
}

/**
 * P6.694 — the identity the `@` typeahead emits for one subagent.
 *
 * `sub-agents.md#invoke-subagents-explicitly`, verbatim: *"Subagents provided by
 * an enabled plugin appear in the typeahead under their scoped name, such as
 * `my-plugin:code-reviewer`"*, and the CLI half of the same page says why it
 * matters — *"If multiple plugins provide agents with the same name, pass the
 * scoped name to disambiguate"*. `logicalName` is the agent's frontmatter
 * `name` (or its filename), so two plugins shipping a `security` agent are
 * indistinguishable by it.
 *
 * The plugin id comes from `pluginInstanceId`
 * (`plugin://<marketplaceId>/<pluginId>@<version>#<bundleHash>`) and NOT from
 * `pluginKey`, which is `enc(marketplaceId).enc(pluginId)` — two base64url
 * segments, not a name anyone types. Same reader the MCP wire-name mint uses,
 * so the two spellings of "which plugin is this" cannot drift apart.
 *
 * A NATIVE agent — project, user or builtin — keeps its bare name, which is
 * what the same page documents for it (*"`@agent-<name>` for local
 * subagents"*). So the record is emitted for every agent row and only its `id`
 * differs, rather than being emitted for plugin rows alone: a row that carries
 * `mention` on some installs and not others is the shape a renderer forgets to
 * handle.
 *
 * NOT covered, and deliberately: the page's SUBFOLDER form
 * (*"a file at `agents/review/security.md` in plugin `my-plugin` registers as
 * `my-plugin:review:security`"*). The subfolder never reaches this projection —
 * `normalizeClaudeAgents` names the capability from the frontmatter `name` or
 * the file's basename and drops the directory — so it is a divergence in the
 * ADAPTER, one layer down, and inventing a middle segment here would be
 * inventing a name the rest of the system does not know.
 */
function agentMentionId(cap: ResolvedCapability): string {
  if (cap.origin !== 'plugin' || !cap.pluginInstanceId) return cap.logicalName;
  const pluginId = pluginIdFromInstanceId(cap.pluginInstanceId);
  return pluginId ? `${pluginId}:${cap.logicalName}` : cap.logicalName;
}

/**
 * Project one resolved capability to its safe summary. No path/secret/hash.
 * `presentationByPluginKey` is an OPTIONAL join-only lookup (A9): supplying
 * it attaches display-only origin presentation for plugin-owned
 * capabilities; omitting it (e.g. from `toComposerCatalog`/`toAgentRuntime`
 * callers) leaves `presentation` absent. Never derived here — always
 * pre-computed by the caller from persisted installed-origin provenance.
 */
/**
 * P6.791 (P6.342 (b)) — the capability KEY → MCP WIRE NAME map.
 *
 * Every agent definition in this fork declares its servers as resolved
 * capability keys, and every runtime that can honour that declaration wants a
 * NAME: `sub-agents.md#scope-mcp-servers-to-a-subagent`, verbatim — *"Each entry
 * in the list is either an inline server definition or a string referencing an
 * MCP server already configured in your session"* — and *"String references
 * share the parent session's connection."* Between the two sits a translation
 * that existed nowhere: `buildClaudeRuntimeAgentOptions` received no capability
 * view at all, so it could only drop the declaration.
 *
 * The map is built HERE rather than at that seam because this is where both
 * halves live and neither is claude-specific. Two producers, and both are
 * needed: a plugin/native MCP capability arrives as a `RuntimeMcpServer`
 * carrying its own `wireName`, and a SOURCE whose transport is MCP arrives as a
 * {@link RuntimeSourceHandle} carrying `mcpWireName` instead. A map built from
 * either alone silently loses half the servers a session actually has.
 *
 * `wireName`, not `logicalName`: a collision — scope precedence, or plugin
 * qualification — rewrites the wire name, and the wire name is the one the
 * session's tools are actually registered under (`mcp__<wireName>__<tool>`).
 * Naming the logical one would hand a child whatever server answered to it,
 * which is the failure the claude-side drop was protecting against.
 *
 * Only RUNNABLE capabilities are in the view at all (`toAgentRuntime` skips the
 * rest), so a key that is absent from this map is one this turn cannot name —
 * which is a different statement from "the author was wrong", and the callers
 * report it as such.
 */
export function mcpWireNamesByCapabilityKey(view: AgentRuntimeView): ReadonlyMap<string, string> {
  const wireNames = new Map<string, string>();
  // A key names exactly one capability entry, so the two loops describe
  // disjoint sets and cannot disagree about a key.
  for (const server of view.mcpServers ?? []) {
    if (server.key && server.wireName) wireNames.set(server.key, server.wireName);
  }
  for (const source of view.sources ?? []) {
    if (source.key && source.mcpWireName) wireNames.set(source.key, source.mcpWireName);
  }
  return wireNames;
}

export function toSafeSummary(
  cap: ResolvedCapability,
  presentationByPluginKey?: ReadonlyMap<string, SafePluginPresentationOrigin>,
): SafeCapabilitySummary {
  const presentation = cap.pluginKey ? presentationByPluginKey?.get(cap.pluginKey) : undefined;
  return {
    key: cap.key,
    kind: cap.kind as SafeCapabilityKind,
    logicalName: cap.logicalName,
    ...(cap.displayName ? { displayName: cap.displayName } : {}),
    ...(cap.description ? { description: cap.description } : {}),
    ...(cap.sourceType ? { sourceType: cap.sourceType } : {}),
    ...(cap.mcpTransport ? { mcpTransport: cap.mcpTransport } : {}),
    ...(cap.iconResource ? { iconUrl: cap.iconResource.dataUrl } : {}),
    ...((cap.kind === 'source' || cap.kind === 'skill' || cap.kind === 'agent')
      ? {
          mention: {
            type: cap.kind,
            id: cap.kind === 'agent' ? agentMentionId(cap) : cap.logicalName,
            qualifiedId: cap.key,
            selectedAsShortAlias: cap.selectedAsUnqualifiedAlias,
            label: cap.displayName ?? cap.logicalName,
          },
        }
      : {}),
    origin: cap.origin,
    ...(presentation ? { presentation } : {}),
    ...(cap.connectorOrigin ? { connectorOrigin: cap.connectorOrigin } : {}),
    scope: {
      kind: cap.scope.kind,
      ...(cap.scope.workspaceId ? { workspaceId: cap.scope.workspaceId } : {}),
      ...(cap.scope.projectKey ? { projectKey: cap.scope.projectKey } : {}),
    },
    state: availabilityState(cap),
    readOnly: cap.readOnly,
    trustState: cap.trustState as SafeCapabilityTrustState,
    credentialState: cap.credentialState as SafeCredentialAvailabilityState,
    selectedAsUnqualifiedAlias: cap.selectedAsUnqualifiedAlias,
    ...(cap.unavailableReason ? { unavailableReason: cap.unavailableReason } : {}),
    diagnosticCodes: cap.diagnostics.map(d => d.code),
    // UB14.48 — the stored connection verdict and its reason; both were normalised and reduced when
    // the inventory read config.json (`sources/connection-status.ts`), so they are copied as they are.
    ...(cap.lastTestStatus ? { lastTestStatus: cap.lastTestStatus } : {}),
    ...(cap.connectionError ? { connectionError: cap.connectionError } : {}),
  };
}

export function toComposerCatalog(snapshot: EffectiveCapabilitySnapshot): ComposerCatalogView {
  return {
    generation: snapshot.generation,
    items: snapshot.entries.map(entry => toSafeSummary(entry.summary)),
  };
}

/**
 * Kinds whose resolved capability has its own detail page (skills, sources —
 * incl. mcp/connector sources). A component of one of these kinds is emitted
 * with its `capabilityKey`, so the plugin-detail row is clickable through to it.
 * Other kinds (hook/command/…) render as inert inventory rows.
 */
const CLICKABLE_COMPONENT_KINDS: ReadonlySet<SafeCapabilityKind> = new Set([
  'skill', 'source', 'mcp',
]);

/**
 * Plugin component inventory (U4). Projects every snapshot entry that carries
 * this plugin's `pluginKey` into a path-free `SafePluginComponent`. Pure over
 * the already-resolved entries — reads no files, computes no policy, and copies
 * only display fields + the opaque capability key.
 */
function buildPluginComponents(
  pluginKey: string,
  entries: readonly ResolvedCapabilityEntry[],
): SafePluginComponent[] {
  const components: SafePluginComponent[] = [];
  for (const entry of entries) {
    const cap = entry.summary;
    if (cap.pluginKey !== pluginKey) continue;
    const inert = cap.unavailableReason === 'unsupported-runtime';
    const kind = cap.componentKind ?? cap.kind;
    const description = cap.description || (entry.runtimeBinding.kind === 'hook'
      ? `${entry.runtimeBinding.hook.event} · ${entry.runtimeBinding.hook.type ?? 'command'}`
      : undefined);
    components.push({
      kind: kind as SafeCapabilityKind,
      name: cap.displayName ?? cap.logicalName,
      ...(description ? { description } : {}),
      ...(!inert && CLICKABLE_COMPONENT_KINDS.has(kind as SafeCapabilityKind)
        ? { capabilityKey: cap.key }
        : {}),
      // Per-capability toggle inputs (T3): the manifest capability id addresses
      // the set-capability-enabled action; enabled/reason render the switch and
      // the dimmed-row copy. All path-free by construction.
      ...(!inert && cap.capabilityId ? { capabilityId: cap.capabilityId } : {}),
      enabled: cap.enabled,
      ...(cap.unavailableReason ? { unavailableReason: cap.unavailableReason } : {}),
    });
  }
  return components;
}

function toSafeInstalledPlugin(
  plugin: ResolvedInstalledPlugin,
  presentationByPluginKey?: ReadonlyMap<string, SafePluginPresentationOrigin>,
  components?: SafePluginComponent[],
): SafeInstalledPluginSummary {
  const presentation = presentationByPluginKey?.get(plugin.pluginKey);
  const authRequirements = plugin.authRequirements?.map(toSafePluginMcpAuthRequirement);
  return {
    pluginKey: plugin.pluginKey,
    activeInstanceId: plugin.activeInstanceId,
    origin: {
      marketplaceId: plugin.origin.marketplaceId,
      pluginId: plugin.origin.pluginId,
      ...(plugin.origin.listingId ? { listingId: plugin.origin.listingId } : {}),
      ...(plugin.origin.sourceId ? { sourceId: plugin.origin.sourceId } : {}),
    },
    ...(presentation ? { presentation } : {}),
    name: plugin.name,
    version: plugin.version,
    installedAt: plugin.installedAt,
    lifecycleState: plugin.lifecycleState,
    ...(plugin.availableUpdateVersion ? { availableUpdateVersion: plugin.availableUpdateVersion } : {}),
    capabilityKinds: plugin.capabilityKinds as SafeCapabilityKind[],
    ...(plugin.compatibility ? {
      compatibility: {
        state: plugin.compatibility.state,
        deferred: [...plugin.compatibility.deferred, ...plugin.compatibility.blocked].map(entry => ({
          externalKind: entry.externalKind,
          reasonCode: entry.reasonCode,
        })),
      },
    } : {}),
    ...(authRequirements?.length ? { authRequirements } : {}),
    ...(plugin.dependencyErrors?.length
      ? {
          dependencyErrors: plugin.dependencyErrors.map(error => ({
            ...error,
            message: describePluginDependencyError(error),
          })),
        }
      : {}),
    activation: {
      effective: plugin.lifecycleState === 'ready' && plugin.activationEnabled
        ? 'active'
        : 'inactive',
      // Real per-scope activation from the persisted policy layers (U4 defect
      // fix) so the Sources/marketplace row menus label Enable-vs-Disable
      // correctly. `resolvePluginScopeActivation` is optional on the resolver
      // input, so fall back to 'unset' when it is absent (tests / no policy).
      global: plugin.activation?.global ?? 'unset',
      workspace: plugin.activation?.workspace ?? 'unset',
      ...(plugin.activation ? { project: plugin.activation.project } : {}),
      ...(plugin.activation?.managed ? { managed: plugin.activation.managed } : {}),
    },
    actions: {
      canEnable: true,
      // `settings-reference.md#enabledplugins` — "Plugins force-enabled by
      // managed settings can't be disabled this way, since managed settings
      // override local settings." The resolver already overrides a user
      // disable, so offering the action would be a control that silently does
      // nothing.
      canDisable: plugin.activation?.managed !== 'enabled',
      canUpdate: !!plugin.availableUpdateVersion,
      canRepair: plugin.lifecycleState === 'repair-required',
      canUninstall: true,
      // `reasonCodes` explains a WITHHELD action, and P2.159 gave it its second
      // reason and its first reader. `canUpdate` is false both for a plugin that
      // is already current and for one whose versions cannot be ordered at all
      // (a four-part `0.10.2.3` against `0.10.0`: strict `semver.parse` refuses
      // both sides of the comparison, so the answer is permanently "no"), and
      // only the second is news — it never resolves on its own and the user is
      // otherwise told nothing, indefinitely, with auto-update on.
      //
      // Non-gating by construction: it adds no state, changes no `canUpdate`,
      // and an empty array stays empty for every ordinary plugin.
      reasonCodes: [
        ...(plugin.activation?.managed === 'enabled' ? ['managed-force-enabled'] : []),
        ...(plugin.updateVersionUncomparable ? [PLUGIN_UPDATE_VERSION_UNCOMPARABLE_REASON] : []),
      ],
    },
    ...(components && components.length > 0 ? { components } : {}),
  };
}

function toSafePluginMcpAuthRequirement(
  requirement: PluginMcpAuthRequirement,
): SafePluginMcpAuthRequirement {
  switch (requirement.kind) {
    case 'dp': return { ...requirement, capabilityIds: [...requirement.capabilityIds], serverNames: [...requirement.serverNames] };
    case 'oauth':
    case 'bearer': return { ...requirement, connectorIds: [...requirement.connectorIds], serverNames: [...requirement.serverNames] };
    case 'environment': return { ...requirement, capabilityIds: [...requirement.capabilityIds], serverNames: [...requirement.serverNames], requiredNames: [...requirement.requiredNames] };
    case 'unsupported-app': return { ...requirement, appIds: [...requirement.appIds], connectorIds: [...requirement.connectorIds] };
  }
}

/**
 * `actions.reasonCodes` member for "the Update action is withheld because these
 * two version strings cannot be ordered" (P2.159).
 *
 * Named once and exported so the renderer reads THE FIELD rather than
 * re-deriving the condition from `version`/`availableUpdateVersion` — a second
 * derivation renderer-side is how a badge ends up contradicting the server.
 */
export const PLUGIN_UPDATE_VERSION_UNCOMPARABLE_REASON = 'update-version-uncomparable';

export function toSafeDiagnostic(diagnostic: CapabilityDiagnostic): SafeCapabilityDiagnostic {
  return {
    severity: diagnostic.severity,
    code: diagnostic.code,
    // The internal message is never forwarded; the code doubles as the
    // allowlisted localization key until the renderer maps it.
    messageKey: diagnostic.code,
    ...(diagnostic.safeArgs ? { safeArgs: diagnostic.safeArgs } : {}),
    ...(diagnostic.capabilityKey ? { capabilityKey: diagnostic.capabilityKey } : {}),
  };
}

/**
 * The runtime that keeps a hook table of its OWN, and is deliberately
 * under-filled (P2.414, owner decision 2026-08-29: project ONLY hooks the host
 * itself authored).
 *
 * Compared here rather than added as a fifth record to
 * `runtime-agent-support.ts`, because the fact is not "can this runtime run
 * hooks" — every runtime runs every hook host-side, which is precisely why
 * `resolver.ts` never gates a hook row on `context.provider` and must not start.
 * The fact is "does this runtime ALSO have a native hook table we hand less
 * than everything", and codex is the only member.
 */
const HOST_AUTHORED_HOOK_PROJECTION_RUNTIME: AgentProvider = 'codex-runtime';

/**
 * Catalog-level diagnostic code for consequence (2) of the owner's P2.414
 * decision: a codex session must SAY that user- and plugin-authored hooks are
 * not projected into codex's own `[hooks]` table, and WHY, in the same surface
 * that lists hooks on Pi.
 *
 * A CODE and not the sentence, and the reason is a measured bundling
 * constraint rather than a preference: the sentence itself lives in
 * `CODEX_HOOK_PROJECTION_NOTICE` (`@nessy-agent/codex-responses-adapter/config-writer`),
 * whose module imports `node:fs` and `node:path` — and this file is imported by
 * the RENDERER for a value already (`plugin-update-affordance.tsx` reads
 * {@link PLUGIN_UPDATE_VERSION_UNCOMPARABLE_REASON}), so importing it here
 * would drag a node-only module into the browser bundle. The renderer therefore
 * maps this code to its localized copy, and
 * `__tests__/codex-hook-projection-notice.test.ts` pins the English string
 * BYTE-EQUAL to the constant so the two cannot drift.
 *
 * Rides `UserCapabilityCatalog.diagnostics` with no `capabilityKey`, which is
 * what keeps it off every detail page: `handlers/rpc/capabilities.ts`'s
 * `buildDetail` filters that array by `capabilityKey === <this capability>`.
 */
export const CODEX_HOOK_PROJECTION_DIAGNOSTIC_CODE = 'capability.hook.codex_projection_host_authored_only';

/**
 * The notice, as a catalog diagnostic. `info`, not `warning`: nothing is
 * broken and nothing is unavailable — the hooks run, host-side, on the events
 * this runtime emits. What is being reported is a residual DIFFERENCE, which
 * the native-first rule requires be uniform or honest.
 *
 * Emitted whenever the context resolves to codex, whether or not this context
 * has any hooks at all — an empty list with no explanation is the exact
 * half-truth consequence (2) exists to end, and it is the case where the
 * sentence matters most.
 */
function codexHookProjectionDiagnostic(): SafeCapabilityDiagnostic {
  return {
    severity: 'info',
    code: CODEX_HOOK_PROJECTION_DIAGNOSTIC_CODE,
    messageKey: CODEX_HOOK_PROJECTION_DIAGNOSTIC_CODE,
  };
}

/**
 * Project the full user-facing catalog. `presentationByPluginKey` is an
 * OPTIONAL join-only map of display presentation (A9), keyed by the stable
 * `pluginKey` and computed by the caller from persisted installed-origin
 * provenance (see `plugins/presentation.ts`) — this function never derives
 * it and never reads it from the snapshot itself. `toAgentRuntime` has no
 * equivalent parameter: presentation must never reach the runtime view.
 */
export function toUserCatalog(
  snapshot: EffectiveCapabilitySnapshot,
  presentationByPluginKey?: ReadonlyMap<string, SafePluginPresentationOrigin>,
): UserCapabilityCatalog {
  const diagnostics = snapshot.diagnostics.map(toSafeDiagnostic);
  if (snapshot.context.provider === HOST_AUTHORED_HOOK_PROJECTION_RUNTIME) {
    diagnostics.push(codexHookProjectionDiagnostic());
  }
  return {
    generation: snapshot.generation,
    installedPlugins: snapshot.installedPlugins.map(plugin => toSafeInstalledPlugin(
      plugin,
      presentationByPluginKey,
      buildPluginComponents(plugin.pluginKey, snapshot.entries),
    )),
    capabilities: snapshot.entries.map(entry => toSafeSummary(entry.summary, presentationByPluginKey)),
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Headless init view (`system/init`) — a CLI/CI projection, NOT a renderer one
// ---------------------------------------------------------------------------

/**
 * The capability diagnostics that mean "a declared component of this plugin was
 * REFUSED", pinned BY CODE.
 *
 * Pinned by code and never by position, because the list this is drawn from
 * (`resolver.ts`'s `capabilityDiagnostics`) has already grown once and will
 * again — and the two codes that are NOT here are the reason the distinction
 * has to be explicit:
 *
 * - `plugin.user_config.unredacted_sink` is a WARNING about where a value was
 *   substituted, and its own docblock says "Substituted, not refused". Mapping
 *   it in would fail a CI gate on a plugin that loaded correctly — the exact
 *   inverse of what `headless.md:211` is for.
 * - `plugin.dependency.*` is the same set as `ResolvedInstalledPlugin
 *   .dependencyErrors`, which this builder already projects with the richer
 *   per-dependency message. Mapping both reports every dependency failure twice.
 */
const HEADLESS_DEMOTING_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
  'plugin.user_config.unset',
  'plugin.app.connector_unresolved',
  'plugin.mcp.required_environment_missing',
]);

/** One plugin that loaded cleanly (`headless.md:210`). */
export interface HeadlessInitPlugin {
  name: string;
  /** The immutable bundle root. Absent when no runtime context pinned one. */
  path?: string;
}

/** One plugin load-time error (`headless.md:211`). */
export interface HeadlessInitPluginError {
  plugin: string;
  type: string;
  message: string;
}

/** One MCP server the session actually has (`headless.md:219`). */
export interface HeadlessInitMcpServer {
  name: string;
  /**
   * `pending` is the honest answer at init time and is a status the page itself
   * uses ("shows `pending` in `system/init`, and connects on its first tool
   * call", `:213`): live connection state does not exist until the runtime has
   * started, which is after the first send.
   */
  status: 'connected' | 'failed' | 'pending';
}

/** One MCP entry skipped by config validation (`headless.md:220`). */
export interface HeadlessInitMcpServerError {
  name: string;
  type: string;
  message: string;
}

/**
 * The `system/init` payload, in the page's own snake_case.
 *
 * The casing here is a DELIBERATE MIX with the rest of our headless stream and
 * must not be "fixed" in either direction: this frame is Claude's documented
 * shape and is spelled Claude's way, while every subsequent line is a verbatim
 * Nessy `session:event` in our own camelCase. A consumer written against
 * Claude's contract reads line 1; a consumer written against ours reads the
 * rest. Renaming these keys breaks the first, renaming the events breaks the
 * second and every renderer besides.
 *
 * `plugin_errors` and `mcp_server_errors` are OMITTED when empty. That omission
 * is the contract, not a style choice — `:211` and `:220` both spell it, and
 * `:220` names the consequence: "The key is omitted when there are no errors,
 * so a CI gate can fail on a non-empty array."
 */
export interface HeadlessInitView {
  plugins: HeadlessInitPlugin[];
  plugin_errors?: HeadlessInitPluginError[];
  mcp_servers: HeadlessInitMcpServer[];
  mcp_server_errors?: HeadlessInitMcpServerError[];
  /**
   * P6.263 — the PROTOCOL capabilities this session's runtime advertises.
   *
   * ALWAYS PRESENT, unlike the two `*_errors` arrays above, and the difference
   * is deliberate. Those are omitted when empty because the page makes the
   * omission the contract (*"the key is omitted when there are no errors, so a
   * CI gate can fail on a non-empty array"*). This one is the opposite kind of
   * fact: an empty list is the ANSWER for pi and codex — they advertise none —
   * and omitting it would leave a reader unable to tell "advertises none" from
   * "this build does not report capabilities".
   *
   * Values are verbatim and unfiltered: the SDK calls it an *"open set — ignore
   * unknown values"*, so a name we do not recognise is passed through rather
   * than dropped.
   */
  capabilities: string[];
}

/** Live per-server MCP state, when a runtime has already started. */
export interface HeadlessInitMcpHealth {
  connected: readonly string[];
  failed: readonly string[];
}

/**
 * Project one snapshot to the headless `system/init` payload.
 *
 * A SIBLING of `toUserCatalog`, never an edit to it, and deliberately NOT a
 * Safe view: `plugins[].path` is `bundleRootPath`, which
 * `SafeInstalledPluginSummary` strips by design. This builder feeds the CLI and
 * a CI job on the same machine — it must never be routed to a renderer.
 */
export function buildHeadlessInitView(
  snapshot: EffectiveCapabilitySnapshot,
  mcpHealth?: HeadlessInitMcpHealth,
  protocolCapabilities?: readonly string[],
): HeadlessInitView {
  const pluginNameByKey = new Map<string, string>();
  for (const plugin of snapshot.installedPlugins) pluginNameByKey.set(plugin.pluginKey, plugin.name);
  const pluginKeyByCapabilityKey = new Map<string, string>();
  for (const entry of snapshot.entries) {
    if (entry.summary.pluginKey) pluginKeyByCapabilityKey.set(entry.summary.key, entry.summary.pluginKey);
  }

  const pluginErrors: HeadlessInitPluginError[] = [];
  // Plugins whose `plugins` entry is forfeit because something they declared was
  // refused. `:211` — "Affected plugins are demoted and absent from `plugins`."
  // The two arrays are computed from ONE set so they cannot disagree: a plugin
  // that appears in `plugin_errors` is never also in `plugins`.
  const demoted = new Set<string>();

  for (const plugin of snapshot.installedPlugins) {
    for (const error of plugin.dependencyErrors ?? []) {
      demoted.add(plugin.pluginKey);
      pluginErrors.push({
        plugin: plugin.name,
        type: error.code,
        message: describePluginDependencyError(error),
      });
    }
  }

  for (const diagnostic of snapshot.diagnostics) {
    if (!HEADLESS_DEMOTING_DIAGNOSTIC_CODES.has(diagnostic.code)) continue;
    const pluginKey = diagnostic.capabilityKey
      ? pluginKeyByCapabilityKey.get(diagnostic.capabilityKey)
      : undefined;
    const name = pluginKey ? pluginNameByKey.get(pluginKey) : undefined;
    if (!pluginKey || !name) continue;
    demoted.add(pluginKey);
    // The internal message, not the safe messageKey: these name configuration
    // KEYS and environment-variable NAMES and never a value (see the refusal
    // sites in `resolver.ts`), and a CI log that says which key is unset is the
    // whole reason to surface it.
    pluginErrors.push({ plugin: name, type: diagnostic.code, message: diagnostic.message });
  }

  const plugins: HeadlessInitPlugin[] = [];
  for (const plugin of snapshot.installedPlugins) {
    if (demoted.has(plugin.pluginKey)) continue;
    // A plugin the user turned off, or one mid-install/repair, did not fail to
    // load — it is simply not loaded. Neither array claims it.
    if (plugin.lifecycleState !== 'ready' || !plugin.activationEnabled) continue;
    plugins.push({
      name: plugin.name,
      ...(plugin.bundleRootPath ? { path: plugin.bundleRootPath } : {}),
    });
  }

  const mcpServers: HeadlessInitMcpServer[] = [];
  const mcpServerErrors: HeadlessInitMcpServerError[] = [];
  const seenServerNames = new Set<string>();
  for (const entry of snapshot.entries) {
    const summary = entry.summary;
    // PRODUCER 2 of `mcp_server_errors`: a plugin-bundled MCP server the format
    // adapter refused at import time (an unqualified stdio command, an invalid
    // cwd, an unusable package runner). It is retained as an inert catalog row
    // — `kind: 'asset'`, `componentKind: 'mcp'` — so it never reaches
    // `mcp_servers`, and until now it reached nothing a headless consumer could
    // read either. Build only PRODUCER 1 below and this failure stays invisible.
    if (summary.componentKind === 'mcp' && summary.unavailableReason === 'unsupported-runtime') {
      const serverName = summary.displayName ?? summary.logicalName;
      mcpServerErrors.push({
        name: serverName,
        type: summary.unsupportedReasonCode ?? 'invalid_config',
        message: `MCP server "${serverName}" declared by plugin ${
          summary.pluginKey ? pluginNameByKey.get(summary.pluginKey) ?? summary.pluginKey : 'unknown'
        } could not be imported and was skipped.`,
      });
      continue;
    }
    if (!isRunnable(entry)) continue;
    const binding = entry.runtimeBinding;
    const name = binding.kind === 'mcp'
      ? binding.server.wireName
      : binding.kind === 'source' && summary.sourceType === 'mcp'
        ? binding.mcpWireName ?? summary.logicalName
        : undefined;
    if (!name || seenServerNames.has(name)) continue;
    seenServerNames.add(name);
    mcpServers.push({
      name,
      status: mcpHealth?.connected.includes(name)
        ? 'connected'
        : mcpHealth?.failed.includes(name)
          ? 'failed'
          : 'pending',
    });
  }

  // PRODUCER 1: the inventory scan's own config-validation refusals (a Source
  // `config.json` that is not an object or declares no recognised `type`, an
  // `mcp.json`/`.mcp.json` that does not parse).
  for (const skip of snapshot.mcpConfigSkips ?? []) {
    mcpServerErrors.push({ name: skip.name, type: skip.type, message: skip.message });
  }

  return {
    plugins,
    ...(pluginErrors.length > 0 ? { plugin_errors: pluginErrors } : {}),
    mcp_servers: mcpServers,
    ...(mcpServerErrors.length > 0 ? { mcp_server_errors: mcpServerErrors } : {}),
    // P6.263 — see the field. `[]` when the caller passed nothing, which is the
    // same answer a pi or codex session gives and is never an omission.
    capabilities: [...(protocolCapabilities ?? [])],
  };
}

/**
 * Unified capability resolver (W8 Steps 3-4).
 *
 * Combines the W6 native-source inventory and the W7 plugin projection
 * candidates into ONE immutable `EffectiveCapabilitySnapshot` per context.
 * Every downstream view (Pi runtime, Composer catalog, user catalog) is a pure
 * projection of the same snapshot — nothing re-reads policy or re-runs
 * precedence. The resolver is server-only and side-effect free: it never
 * launches an MCP server nor runs a hook.
 *
 * Key guarantees implemented here:
 * - one snapshot, one `generation` hash across all views;
 * - policy precedence with explicit `enabled:false` as a terminal deny;
 * - duplicates are retained; keys are fully qualified; a short unqualified
 *   alias is chosen deterministically (nearest scope, then native > plugin,
 *   then lexical key); MCP wire aliases register only when unique;
 * - `generation` hashes revisions/status but never secret bytes;
 * - `leaseId` lifecycle so an inactive plugin instance is pruned only after
 *   every referencing lease is released; `revoke-active-snapshot` fails closed.
 */

import { createHash } from 'node:crypto';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { AgentProvider } from '../agent/backend/types.ts';
import {
  runtimeDispatchesAgentDefinitions,
  runtimeDispatchesWorkflows,
  runtimeProvisionsPluginLsp,
  runtimeRunsPluginMonitors,
} from '../agent/runtime-agent-support.ts';
import type { ProjectKey } from '../projects/project-identity.ts';
import type { PermissionMode } from '../agent/mode-types.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import type { AgentTier } from '../agents/definitions.ts';
import type { RuntimeCredentialBinding } from '../credentials/types.ts';
import type {
  PluginBundleResourceRef,
  PluginCompatibilityReport,
  PluginInstanceId,
  PluginKey,
  PluginLspSupervision,
  PluginRuntimeCompatibilityProfile,
} from '../plugins/types.ts';
import { isCommandMonitorDescriptor } from '../plugins/types.ts';
import {
  describePluginDependencyError,
  resolvePluginDependencyErrors,
  type PluginDependencyError,
} from '../plugins/dependencies.ts';
import type { PluginInstalledEntryV2 } from '../plugins/store-v2.ts';
import type { PluginMcpAuthRequirement } from '../plugins/auth-requirements.ts';
import { derivePluginMcpAuthRequirements } from '../plugins/auth-requirements.ts';
import type { PluginProjectionCandidate } from '../plugins/projection-candidates.ts';
import { pluginRuntimeEnvForProfile } from '../plugins/data-paths.ts';
import {
  pluginUserConfigContentValues,
  PluginUserConfigValues,
  substitutePluginCapabilityUserConfig,
} from '../plugins/user-config-substitution.ts';
import { expandConfigVariables, materializeMcpDescriptorEnvironment } from '../mcp/server-config-values.ts';
import type { CapabilityTrustKey } from './trust-store.ts';
import type { CapabilityInvalidationScope } from './invalidation.ts';
import { capMcpNameSegment, pluginIdFromInstanceId, pluginMcpWireName, sanitizeMcpNameSegment, translatePluginMcpToolName } from './mcp-wire-name.ts';
import { tryParsePiDynamicMcpBindingName } from '../agent/pi-harness/harness-manifest.ts';
import type { SkillOverrideState } from '../config/skill-overrides.ts';
import type {
  BlockedCapabilityLayer,
  CapabilityScopeRef,
  DroppedInstructionLayer,
  McpConfigSkip,
  NativeCapabilityInventory,
  NativeCapabilityIconResource,
  OutsideProjectImport,
  NativeCapabilitySourceRecord,
  ProjectTrustDecisionState,
  ProjectTrustState,
  ResolvedCapabilityActivation,
  SafeSourceConnectorOrigin,
} from './types.ts';

// ---------------------------------------------------------------------------
// Context + resolver contract types (server-only; safe DTOs live in protocol/)
// ---------------------------------------------------------------------------

/** The resolvable capability kinds. Plugin-ness is carried by `origin`. */
export type ResolvedCapabilityKind =
  | 'source' | 'skill' | 'mcp' | 'hook' | 'automation' | 'app'
  | 'agent' | 'instruction' | 'memory' | 'permission'
  | 'command' | 'setting' | 'asset' | 'prompt-command' | 'workflow' | 'lsp' | 'monitor'
  | 'output-style';

export type CapabilityTrustState = 'not-required' | 'trusted' | 'review-required' | 'blocked';
export type CredentialAvailabilityState = 'not-required' | 'ready' | 'missing' | 'expired';

export type CapabilityDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface CapabilityDiagnostic {
  severity: CapabilityDiagnosticSeverity;
  code: string;
  message: string;
  /** Explicit path-free renderer interpolation values; never inferred from message. */
  safeArgs?: Record<string, string>;
  capabilityKey?: string;
}

/** Immutable resolution inputs for one agent turn. */
export interface CapabilityContext {
  workspaceId: string;
  sessionId?: string;
  /**
   * The session whose session-scoped MEMORY.md this turn reads, when it differs
   * from `sessionId`.
   *
   * Only a conversation fork sets it, to its parent's id: `sub-agents.md:1041`
   * makes a fork's system prompt "Same as main session", and session memory is
   * keyed by session id, so a fork's own fresh id reads an empty file. Server-
   * derived from `piParentSessionKey`; never accepted from a renderer, and never
   * an identity, permission or storage-scope input — the fork still owns its own
   * session directory for everything else.
   */
  memorySessionId?: string;
  /** Internal backend discriminator; omitted for provider-neutral catalog/browse resolution. */
  provider?: AgentProvider;
  /** Server-owned session selection, expressed as logical Source names. */
  enabledSourceNames?: string[];
  workingDirectory?: string;
  /** Canonical, validated active project root (server-side only). */
  projectRoot?: string;
  projectKey?: ProjectKey;
  projectTrustState: ProjectTrustState;
  projectTrustRevision: string;
}

/** Backend-issued project handle (server-only record; never serialized whole). */
export interface ResolvedProjectHandle {
  id: string;
  workspaceId: string;
  displayPath: string;
  trustState: ProjectTrustDecisionState;
  expiresAt: number;
  canonicalPath: string;
  projectKey: ProjectKey;
  identityFingerprint: string;
}

export interface CapabilityToolPolicy {
  defaultApproval: 'auto' | 'prompt' | 'writes' | 'approve';
  enabledTools?: string[];
  disabledTools?: string[];
  perTool?: Record<string, { approval: 'auto' | 'prompt' | 'approve' }>;
}

export interface NativeResourceRef {
  source: 'managed-global' | 'shared-personal' | 'workspace' | 'project';
  scope: CapabilityScopeRef;
  resourceId: string;
  /** Server-only; stripped from Composer/user views. */
  absolutePath: string;
  revision: string;
  contentHash: string;
}

export interface ResolvedCapability {
  key: string;
  kind: ResolvedCapabilityKind;
  /** Catalog-only kind for an inert retained declaration; never runtime authority. */
  componentKind?: ResolvedCapabilityKind;
  logicalName: string;
  description?: string;
  sourceType?: 'api' | 'mcp' | 'local';
  /** C6: MCP transport of an mcp/mcp-source row (value only, never a URL/command). */
  mcpTransport?: 'stdio' | 'http' | 'sse' | 'ws';
  /**
   * SERVER-ONLY builtin MCP endpoint identity, carried through unchanged from
   * {@link NativeCapabilitySourceRecord.mcpServerIdentity}. T4's `mcp.md:457`
   * builtin-identity dedup pass (`buildEntries`, before `applyCollisionPolicy`)
   * matches a plugin's DECLARED stdio argv tail against the `dp ai mcp <sub>`
   * set this carries. Never copied into `SafeCapabilitySummary` (see
   * `toSafeSummary`) — it carries a raw argv, the same class of value as
   * {@link NativeCapabilitySourceRecord.sourcePath}.
   */
  mcpServerIdentity?: NativeCapabilitySourceRecord['mcpServerIdentity'];
  displayName?: string;
  /** Pinned native icon metadata; only `dataUrl` reaches safe views. */
  iconResource?: NativeCapabilityIconResource;
  origin: 'builtin' | 'native' | 'plugin' | 'managed'; // F1.635 — mirrors SafeCapabilityOrigin; the org policy's own servers read `managed`
  /** Same-scope alias tier: nessy-native > portable > plugin presentation. */
  sourceTier?: 'nessy' | 'portable';
  /** Presentation-only connector provenance (K4); never an auth input. */
  connectorOrigin?: SafeSourceConnectorOrigin;
  scope: CapabilityScopeRef;
  pluginKey?: PluginKey;
  pluginInstanceId?: PluginInstanceId;
  capabilityId?: string;
  enabled: boolean;
  selectedAsUnqualifiedAlias: boolean;
  readOnly: boolean;
  /**
   * Skill-only: pinned `alwaysAllow` tool names (U2). Server-only detail input;
   * projected to `SafeCapabilityDetail.permissionModes` by the detail handler
   * and NEVER copied into `SafeCapabilitySummary` (see `toSafeSummary`).
   */
  skillAlwaysAllow?: string[];
  /**
   * Skill-only: pinned invocation controls (P7). Server-only; carried onto
   * `RuntimeSkillHandle` so the listing, the model-invocation refusal and the
   * `/slug` registration all read one pinned value instead of re-reading disk.
   * Never copied into `SafeCapabilitySummary`.
   */
  skillDisableModelInvocation?: boolean;
  skillUserInvocable?: boolean;
  skillAllowedTools?: string[];
  skillPaths?: string[];
  /**
   * Skill-only: the `skillOverrides` state (`skills.md:663`, R61), carried the
   * same way the frontmatter pair above is — NOT routed into `enabled` /
   * `unavailableReason`. An `"off"` skill must stay in the catalog so the
   * Skills list can still show it and take the override back off; only the
   * three enforcement sites read this. Absent means `"on"`.
   *
   * Never set on a plugin skill (`skills.md:689`).
   */
  skillOverrideState?: SkillOverrideState;
  /**
   * Skill-only: the record occupies a BUNDLED slot (R78). Provenance, not
   * content — see `types.ts:skillTier` for what the tag claims and what it
   * deliberately cannot tell apart.
   *
   * Read by exactly one decision, {@link aliasScopeRank}, where it sits BELOW
   * `project` so `skills.md:122`'s "a skill at any of these levels also
   * overrides a bundled skill with the same name" holds in a fork whose bundled
   * skills are seeded copies at `global` scope. Never copied into
   * `SafeCapabilitySummary`, and deliberately absent from the generation
   * material (see {@link computeGeneration}).
   */
  skillTier?: 'bundled';
  /**
   * Skill-only: the directory BELOW the working directory that owns this skill
   * (R79) — `apps/web`. See `types.ts:skillDirectoryQualifier`.
   *
   * Two readers, and they are the two halves of `skills.md:132`. The alias
   * policy uses it to keep a nested variant off the bare name when a
   * same-name skill at the same rank claims it; `views.ts` copies it onto the
   * runtime handle so the `/` menu, the model listing and the invocation path
   * can all spell the qualified name `apps/web:deploy` the same way.
   */
  skillDirectoryQualifier?: string;
  /**
   * Source-only: pinned read-only permission projection (U2). Server-only
   * detail input for `SafeCapabilityDetail.permissions`; path-free by
   * construction and never copied into `SafeCapabilitySummary`.
   */
  sourcePermissions?: Array<{ pattern: string; access: 'allowed' | 'blocked' }>;
  /**
   * UB14.48 — Source-only: the stored connection verdict and its reduced reason, carried unchanged from
   * {@link NativeCapabilitySourceRecord.sourceLastTestStatus} / `sourceConnectionError` and copied to
   * `SafeCapabilitySummary.lastTestStatus` / `connectionError` by `toSafeSummary`. Display only: no
   * activation, trust or credential decision reads them.
   */
  lastTestStatus?: NativeCapabilitySourceRecord['sourceLastTestStatus'];
  connectionError?: string;
  trustState: CapabilityTrustState;
  credentialState: CredentialAvailabilityState;
  /** Non-secret revision captured with credential status; never serialized. */
  credentialRevision?: string;
  unavailableReason?: string;
  /**
   * The adapter's own reason a RETAINED-but-unsupported declaration cannot run
   * (`PluginUnsupportedDescriptor.reasonCode`). Server-only: `unavailableReason`
   * is already `'unsupported-runtime'` for every one of these, which is enough
   * for a renderer badge but NOT enough for the headless init frame's
   * `mcp_server_errors[].type`, where a CI gate needs to tell an unqualified
   * stdio command apart from an invalid cwd. Never copied into
   * `SafeCapabilitySummary`.
   */
  unsupportedReasonCode?: string;
  diagnostics: CapabilityDiagnostic[];
}

/**
 * The secret-free projection of one resolved MCP server.
 *
 * **`alwaysLoad` is carried here and honoured on ONE runtime — P2.446.** The
 * user's per-server `alwaysLoad` reaches the pool, and `pi-agent.ts` reads it
 * back out (`mcpPool.alwaysLoadProxyToolNames`) to pin those tools out of
 * deferral. The claude-runtime seam drops it: `createSourceProxyServers`
 * (`agent/claude-agent.ts`) builds each source's in-process server with
 * `createSdkMcpServer({ name, version, instructions, tools })` and its tools
 * with a four-argument `tool(...)`, so neither of the two places the vendored
 * SDK accepts the flag is written.
 *
 * That is a NOT-PASSED, not an inexpressible field, and the difference is the
 * whole point of the row: `docs/architecture/runtime-capability-gaps.md` called
 * it a structural limit of the proxy seam for weeks. Measured in the vendored
 * SDK's own declaration (`@anthropic-ai/claude-agent-sdk/sdk.d.ts`,
 * `claudeCodeVersion 2.1.223`): `CreateSdkMcpServerOptions.alwaysLoad` — "When
 * true, all tools from this server are always included in the prompt and never
 * deferred behind tool search. Applied via `_meta['anthropic/alwaysLoad']` on
 * each tool. Equivalent to `defer_loading: false` on the API. Per-tool
 * `tool({ alwaysLoad })` still works and is OR'd with this."
 *
 * The per-server `timeout` beside it genuinely IS inexpressible — the options
 * type has no such field — which is why only this half was reclassified.
 */
export type SdkMcpServerConfigWithoutSecrets =
  | {
      // `ws` rides the same remote arm as http/sse: same url, headers, timeout
      // and alwaysLoad fields (mcp.md:147), and the same secret-free projection.
      type: 'http' | 'sse' | 'ws';
      url: string;
      headerNames?: string[];
      bearerCredentialRequired?: boolean;
      forwardedEnvironmentNames?: string[];
      forwardedEnvironmentSources?: Record<string, string>;
      requiredEnvironmentNames?: string[];
      toolTimeoutMs?: number;
      required?: boolean;
      alwaysLoad?: boolean;
    }
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      cwd?: string;
      forwardedEnvironmentNames?: string[];
      forwardedEnvironmentSources?: Record<string, string>;
      requiredEnvironmentNames?: string[];
      toolTimeoutMs?: number;
      required?: boolean;
      alwaysLoad?: boolean;
    };

/**
 * Immutable-bundle root + writable data root for a plugin instance, plus the
 * ONE normalized semantic selector for compatibility env aliases. `profile` is
 * sourced exclusively from `manifest.runtimeCompatibility` — NEVER from
 * adapterId/origin/format. `projectPath` is the server-validated active project
 * root (if any); it never derives from renderer input.
 */
export interface PluginRuntimeContext {
  rootPath: string;
  dataPath: string;
  /** Expected normalized hash; required by executable plugin runtimes and rechecked before spawn. */
  bundleHash?: string;
  projectPath?: string;
  profile: PluginRuntimeCompatibilityProfile;
}

export type CapabilityRuntimeBinding =
  | { kind: 'source'; resource: NativeResourceRef | PluginBundleResourceRef; guideResource?: NativeResourceRef; credential?: RuntimeCredentialBinding; pluginRuntime?: PluginRuntimeContext; mcpWireName?: string }
  | {
      kind: 'skill';
      resource: NativeResourceRef | PluginBundleResourceRef;
      pluginRuntime?: PluginRuntimeContext;
      /** Server-only identity present only when the skill declares an executable entrypoint. */
      executableHash?: string;
      /**
       * `plugins/manifest-reference.md#environment-variables` — "Non-sensitive values can also be
       * substituted in skill and agent content." NON-SENSITIVE ONLY, by
       * construction: `pluginUserConfigContentValues` never puts a sensitive
       * value in this map, so the skill body pass cannot reach one.
       */
      pluginUserConfig?: Record<string, string>;
    }
  | { kind: 'mcp'; server: RuntimeMcpServer }
  | { kind: 'hook'; hook: RuntimeHookRegistration }
  | { kind: 'automation'; automation: RuntimeAutomationRegistration }
  | {
      kind: 'agent';
      agent: RuntimeAgentDefinition;
      /** Server-only identity used to grant/revoke the exact imported agent definition. */
      executableHash?: string;
    }
  | { kind: 'instruction'; layer: RuntimePromptLayer }
  | { kind: 'memory'; memory: RuntimeMemoryHandle }
  | { kind: 'permission'; layer: RuntimePermissionLayer }
  | { kind: 'command'; command: RuntimeCommandRegistration }
  | { kind: 'prompt-command'; promptCommand: RuntimePromptCommandDefinition }
  | { kind: 'workflow'; workflow: RuntimeWorkflowDefinition }
  | { kind: 'output-style'; outputStyle: RuntimeOutputStyleDefinition }
  | { kind: 'app'; app: RuntimeAppRegistration }
  | { kind: 'setting'; valueType: 'string' | 'number' | 'boolean'; defaultValue?: string | number | boolean }
  | { kind: 'asset'; resource: NativeResourceRef | PluginBundleResourceRef; pluginRuntime?: PluginRuntimeContext }
  | { kind: 'lsp'; lsp: RuntimeLspRegistration }
  | { kind: 'monitor'; monitor: RuntimeMonitorRegistration };

export interface RuntimeMcpServer {
  key: string;
  wireName: string;
  /**
   * The server's stable short name — independent of `wireName`, which a
   * collision (scope precedence, or plugin qualification) can rewrite.
   * Consumers that only see this runtime view (not the full resolved
   * snapshot) use it to translate a bare-name reference onto the current
   * wire name, e.g. a plugin's own hook/skill/agent content.
   */
  logicalName: string;
  /** Pinned native mcp.json/.mcp.json document, materialized lazily. */
  resource?: NativeResourceRef;
  sourceName?: string;
  definition: SdkMcpServerConfigWithoutSecrets;
  /** Host-derived exact trust identity for plugin MCP network/process authority. */
  executableHash?: string;
  /** Server-only pinned descriptor values; never projected to safe views/hashes. */
  descriptorEnvironment?: Record<string, string>;
  descriptorEnvironmentDefaults?: Record<string, string>;
  descriptorHeaders?: Record<string, string>;
  /**
   * `mcp.md:768`: the declared dynamic-header shell command. Server-only and
   * pinned exactly like `descriptorHeaders`; deliberately NOT part of
   * `SdkMcpServerConfigWithoutSecrets` — the safe view carries `headerNames`
   * rather than values, and a shell command is closer to `command` than to a
   * name list.
   */
  descriptorHeadersHelper?: string;
  credential?: RuntimeCredentialBinding;
  /**
   * C3 (capability-path): declared endpoint auth of a plugin http/sse server.
   * Names the GLOBAL plugin credential slot the `credential` binding points at
   * and lets the pool surface a needs-auth `externalAuthRequirements` entry
   * (instead of silently dropping the server) while the slot is empty.
   */
  endpointAuth?: {
    authType: 'oauth' | 'bearer';
    pluginKey: string;
    serverName: string;
    oauthResource?: string;
    clientId?: string;
  };
  /** MCPB child env bindings; config keys and revisions only, never secret values. */
  credentialEnvironment?: Record<string, { configKey: string; credential: RuntimeCredentialBinding }>;
  toolPolicy?: CapabilityToolPolicy;
  pluginRuntime?: PluginRuntimeContext;
  pluginInstanceId?: PluginInstanceId;
}

export interface RuntimeHookRegistration {
  key: string;
  event: string;
  resource: NativeResourceRef | PluginBundleResourceRef;
  executableHash: string;
  pluginRuntime?: PluginRuntimeContext;
  pluginInstanceId?: PluginInstanceId;
  /**
   * `plugins/manifest-reference.md#environment-variables`'s `CLAUDE_PLUGIN_OPTION_<KEY>` export, already
   * resolved to names and values by the host.
   *
   * It rides the HOOK registration and not `PluginRuntimeContext`, because that
   * context is shared with skills, MCP servers and agents, and `:577` exports
   * these to hook processes only — `:334` says a monitor process must not get
   * them. Widening it to the shared context would hand every plugin subprocess a
   * plugin's sensitive option values.
   */
  optionEnvironment?: Record<string, string>;
  type?: 'command' | 'http' | 'mcp' | 'prompt' | 'agent';
  matcher?: string;
  command?: string;
  /**
   * hooks.md § Exec form and shell form: present `args` makes `command` an
   * executable spawned directly with this argument vector and no shell. The
   * registration has to carry it or the runtime rebuilds a shell-form hook.
   */
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  /** hooks.md common field: the spinner label shown while this hook runs. */
  statusMessage?: string;
  /** Background command hook (R22): fire-and-forget, never decision-bearing. */
  async?: boolean;
  /** Implies `async`; the idle-wake half is R3's mechanism (R22 stores it). */
  asyncRewake?: boolean;
  /** Claude's 0/2/other exit contract; absent means the native any-non-zero one. */
  exitCodeContract?: 'claude-three-way';
  /** hooks.md `shell`: bash or powershell for shell form; ignored with `args`. */
  shell?: 'bash' | 'powershell';
  /** UB12.67 — hooks.md `onFailure: "block"` on a command or http hook; absent is `"continue"`. */
  onFailure?: 'block';
  /** Skill-frontmatter-only semantics; stored and reported, not honoured (R22). */
  once?: boolean;
  /** Unevaluated permission-rule filter; fails open until R1's parser (R22). */
  ifRule?: string;
  /** Literal one-shot prompt body for a `prompt` hook (B1). */
  prompt?: string;
  /** Model requested for a `prompt`/`agent` hook (R22). */
  model?: string;
  /** Stored-inert `continueOnBlock` (R22); R9 consumes it. */
  continueOnBlock?: boolean;
  /** Sub-agent name a `agent` hook spawns (B1). */
  agentName?: string;
  /** Fully-qualified MCP proxy tool name an `mcp` hook invokes (B2). */
  mcpTool?: string;
  /** Static arguments for the `mcp` hook's tool (B2). */
  mcpArgs?: Record<string, unknown>;
  /** HTTP request descriptor an `http` hook fires (B2). */
  http?: PluginHookDescriptorHttp;
}

/** HTTP request shape an http-hook fires (B2); mirrors the IR descriptor. */
export interface PluginHookDescriptorHttp {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  /** Header env-interpolation allowlist (R22); intersected with the managed key. */
  allowedEnvVars?: string[];
}

export interface RuntimeAutomationRegistration {
  key: string;
  event: string;
  resource: NativeResourceRef;
}

/**
 * A plugin-declared language server (B3). Materialized through the EXISTING
 * trusted-project LSP provisioner — never a second LSP owner. `command`/`args`
 * launch the server under the supervised `workspace` isolation profile.
 */
export interface RuntimeLspRegistration {
  key: string;
  lspId: string;
  command: string;
  args?: string[];
  languages: string[];
  workingDirectory?: string;
  /**
   * `plugins-reference.md` § Environment variables — "| LSP servers |
   * `command`, `args`, `env`, `workspaceFolder` |". Both reach the process
   * through {@link resolvePluginLspLaunch}: `env` is layered under the host's
   * own runtime environment, `workspaceFolder` becomes the launch directory.
   */
  env?: Record<string, string>;
  workspaceFolder?: string;
  /**
   * P6.417 — the supervision knobs, carried as one field for the reason the
   * descriptor states: a new one is added in a single place at every hop. The
   * host reads them in `SessionManager`'s LSP provisioning and hands them to
   * `LspService`.
   */
  supervision?: PluginLspSupervision;
  executableHash: string;
  pluginRuntime?: PluginRuntimeContext;
  pluginInstanceId?: PluginInstanceId;
}

/** What {@link resolvePluginLspLaunch} hands the LSP process supervisor. */
export interface PluginLspLaunch {
  env: Record<string, string>;
  workingDirectory: string;
}

/**
 * Turn one plugin LSP registration into the two launch inputs the supervisor
 * takes, resolving the documented path placeholders against the same plugin
 * runtime environment an MCP stdio server gets.
 *
 * Layering matches `runtime-pool-servers`' stdio branch — the plugin's own
 * declaration sits ABOVE the placeholder layer and BELOW `hostEnvironment`,
 * which carries the host-resolved runtime binding (managed Node, dp) that a
 * plugin declaration must never be able to redirect.
 *
 * The launch directory prefers Claude's `workspaceFolder` over our earlier
 * `workingDirectory` spelling. `workspaceFolder` may be rooted at the project
 * (`schema.ts:validatePluginLspWorkspaceFolder` accepts all three documented
 * roots), so a still-relative value resolves against `defaultWorkingDirectory`,
 * while `workingDirectory` is bundle-relative by its own validator. Anything
 * that lands outside the bundle, its data directory, the project or the default
 * falls back to the default rather than starting a supervised process in a
 * directory no root covers.
 */
export function resolvePluginLspLaunch(
  registration: Pick<RuntimeLspRegistration, 'env' | 'workspaceFolder' | 'workingDirectory' | 'pluginRuntime'>,
  pluginEnvironment: Record<string, string>,
  hostEnvironment: Record<string, string>,
  defaultWorkingDirectory: string,
): PluginLspLaunch {
  const declared = Object.fromEntries(
    Object.entries(registration.env ?? {})
      .map(([name, value]) => [name, expandConfigVariables(value, pluginEnvironment).value]),
  );
  const runtime = registration.pluginRuntime;
  const candidate = registration.workspaceFolder
    ? { value: registration.workspaceFolder, base: defaultWorkingDirectory }
    : registration.workingDirectory && runtime
      ? { value: registration.workingDirectory, base: runtime.rootPath }
      : undefined;
  const resolved = candidate
    ? resolve(candidate.base, expandConfigVariables(candidate.value, pluginEnvironment).value)
    : defaultWorkingDirectory;
  const roots = [defaultWorkingDirectory, runtime?.rootPath, runtime?.dataPath, runtime?.projectPath]
    .filter((root): root is string => Boolean(root));
  return {
    env: { ...pluginEnvironment, ...declared, ...hostEnvironment },
    workingDirectory: roots.some(root => isPathContainedBy(root, resolved))
      ? resolved
      : defaultWorkingDirectory,
  };
}

function isPathContainedBy(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

interface RuntimeMonitorRegistrationBase {
  key: string;
  monitorId: string;
  executableHash: string;
  pluginRuntime?: PluginRuntimeContext;
  pluginInstanceId: PluginInstanceId;
}

/** A scheduled plugin text resource delivered only into an already-live turn. */
export interface RuntimeScheduledMonitorRegistration extends RuntimeMonitorRegistrationBase {
  form?: 'schedule';
  resource: PluginBundleResourceRef;
  cron: string;
  timezone?: string;
}

/**
 * Claude's `experimental.monitors` command form: a persistent background shell
 * process whose stdout lines reach the agent as notifications
 * (`plugins/components.md#monitors`).
 *
 * It carries NO `optionEnvironment`. `plugins/components.md#monitors` — "Monitor
 * processes don't receive `CLAUDE_PLUGIN_OPTION_<KEY>` environment variables, so
 * have the monitor script read the value from a config file it owns." B1b routed
 * that map onto `RuntimeHookRegistration` only, and the resolver asks for it
 * exclusively on `kind === 'hook'` candidates, so there is no field here for it
 * to arrive in.
 */
export interface RuntimeCommandMonitorRegistration extends RuntimeMonitorRegistrationBase {
  form: 'command';
  command: string;
  description: string;
  when: 'always' | `on-skill-invoke:${string}`;
  /**
   * The plugin's STABLE key, which `pluginInstanceId` is not: an instance id
   * carries the version and bundle hash, so an update mints a new one.
   *
   * The host keys its start-once set on `pluginKey` + `monitorId` for two
   * documented reasons at once. `:322` — the name "Prevents duplicate processes
   * when the plugin reloads". `:707` — "When a plugin updates mid-session …
   * monitors require a session restart", so an update must NOT start a second
   * process alongside the one already running the old path.
   */
  pluginKey: PluginKey;
}

export type RuntimeMonitorRegistration =
  | RuntimeScheduledMonitorRegistration
  | RuntimeCommandMonitorRegistration;

/** Narrow a monitor registration to Claude's command form. */
export function isCommandMonitorRegistration(
  monitor: RuntimeMonitorRegistration,
): monitor is RuntimeCommandMonitorRegistration {
  return monitor.form === 'command';
}

export interface RuntimeAgentDefinition {
  key: string;
  name: string;
  description: string;
  /** Resolver-selected short alias; every definition remains addressable by `key`. */
  selectedAsUnqualifiedAlias?: boolean;
  instructionsResource: NativeResourceRef | PluginBundleResourceRef;
  model?: string;
  tools?: string[];
  disallowedTools?: string[];
  tier?: AgentTier;
  effort?: ThinkingLevel;
  maxTurns?: number;
  permissionMode?: PermissionMode;
  skillKeys?: string[];
  mcpServerKeys?: string[];
}

/**
 * P6.129 — a definition codex REFUSES must not read `active` in the catalog.
 *
 * ## The disagreement this ends, and the exact half it ends
 *
 * `buildCodexAgentRoles` (`codex-responses-adapter/src/config-writer.ts`) denies
 * a role that declares a tool grant — `it declares a tool grant, and codex has
 * no per-role tool policy to honour it with` — and
 * `formatCodexAgentRoleDropDiagnostics` tells the user the definition "cannot be
 * spawned in this session". The catalog kept saying `active` about the same
 * definition. Two surfaces, one subject, opposite answers; P3.377 measured that
 * and left it, because the row it closed assumed a reader where a SEAM is
 * needed.
 *
 * Both halves are answered here now, and the second one's price turned out to
 * be a sentence rather than a seam:
 *
 *  - a PLUGIN-bundled agent's grant is already resolved — it arrives on
 *    `RuntimeAgentDefinition` from the plugin manifest, synchronously, which is
 *    what this predicate reads;
 *  - a FILE-based (native) agent's grant is in the markdown frontmatter, and
 *    P6.551 measured the claim that used to stand here — *"the resolver never
 *    opens the file"* — and REFUTED it. `markdownAgentRecords`
 *    (`capabilities/native-sources.ts`) calls `pinnedAgentMetadata`, which has
 *    read and parsed the frontmatter with `matter()` since it was written, for
 *    `description`. The file was already open. So the choice the row weighed —
 *    a synchronous read per file on every scan, or carrying
 *    `materializePiRuntimeAgentDefinitions`' per-session verdict back into the
 *    capability layer — was a false one: the scan pays no new read, and the
 *    second option's own question (what `active` means for a definition denied
 *    on one session and live on another) does not have to be answered, because
 *    the frontmatter is a property of the FILE and not of the session.
 *
 * The native record therefore carries `agentDeclaresToolGrant`, a boolean and
 * not the list: the condition is PRESENCE, so the content would be carried to
 * the renderer for nothing. The native loop applies the same predicate through
 * a synthesized descriptor, so both halves go through this one function and
 * there is still exactly one place the writer's condition is mirrored.
 *
 * ## Why the condition is truthiness and not length
 *
 * The writer's own test is `if (descriptor.tools || descriptor.disallowedTools)`,
 * so an EMPTY array denies there: an author who writes `tools: []` has declared a
 * grant of nothing, and codex refuses the role rather than silently widening it
 * to the session's whole surface. A `.length` test here would read `active` for
 * exactly that definition. The two conditions are pinned against each other in
 * `capabilities/__tests__/resolver.test.ts` by calling `buildCodexAgentRoles`
 * itself, because a duplicated predicate that no test compares is the drift this
 * file's Q7 comment already warns about.
 */
export function codexDeclinesAgentToolGrant(
  provider: AgentProvider | undefined,
  agent: Pick<RuntimeAgentDefinition, 'tools' | 'disallowedTools'>,
): boolean {
  if (provider !== 'codex-runtime') return false;
  return Boolean(agent.tools) || Boolean(agent.disallowedTools);
}

export interface RuntimePromptLayer {
  key: string;
  resource: NativeResourceRef | PluginBundleResourceRef;
  order: number;
  /**
   * The instruction file whose `@path` import pulled this one in (R77), mirroring
   * {@link RuntimeMemoryHandle.importParentPath}. Present only on imported
   * layers; it is the documented `parent_file_path` an `InstructionsLoaded`
   * `include` load reports, and it is what tells the body composer this layer
   * belongs inside another one rather than shipping on its own.
   */
  importParentPath?: string;
}

export interface RuntimeMemoryHandle {
  key: string;
  resource: NativeResourceRef;
  readOnly: boolean;
  format?: 'rule';
  /**
   * The instruction file whose `@path` import pulled this one in. Present only
   * on imported layers; it is the documented `parent_file_path` an
   * `InstructionsLoaded` `include` load reports.
   */
  importParentPath?: string;
}

export interface RuntimePermissionLayer {
  key: string;
  resource: NativeResourceRef;
  order: number;
  scope?: CapabilityScopeRef['kind'];
  sourceSlug?: string;
}

export interface RuntimeCommandRegistration {
  key: string;
  resource: NativeResourceRef | PluginBundleResourceRef;
  executableHash: string;
  pluginRuntime?: PluginRuntimeContext;
  pluginInstanceId?: PluginInstanceId;
}

/**
 * A prompt/slash-command template. This is DATA (a Markdown prompt body to
 * read and expand), never a subprocess invocation — it carries no
 * `executableHash` and MUST NOT be executed or hashed as a shell command.
 */
export interface RuntimePromptCommandDefinition {
  key: string;
  resource: NativeResourceRef | PluginBundleResourceRef;
  argumentHint?: string;
  model?: string;
  pluginRuntime?: PluginRuntimeContext;
  pluginInstanceId?: PluginInstanceId;
}

export interface RuntimeWorkflowDefinition {
  key: string;
  resource: PluginBundleResourceRef;
  pluginRuntime?: PluginRuntimeContext;
  pluginInstanceId: PluginInstanceId;
  /**
   * Server-only identity used to grant/revoke the exact workflow body, exactly
   * as {@link RuntimeAgentDefinition.executableHash} does for an imported agent.
   *
   * A workflow is the one plugin capability the resolver gates on a
   * per-capability grant ({@link TRUST_GATED_PLUGIN_CAPABILITY_KINDS}), so the
   * hash the gate compared has to survive onto the binding: the trust RPC
   * reconstructs its key from a FRESH snapshot and never from a client field,
   * and without this it had nothing to reconstruct from. Absent when the
   * candidate declared no trust requirement.
   */
  executableHash?: string;
}

/**
 * A plugin-shipped output style (`plugins/components.md#themes-and-output-styles`, `output-styles.md`).
 *
 * DATA, like {@link RuntimePromptCommandDefinition}: a Markdown body read at
 * prompt-composition time, never executed, so it carries no `executableHash`.
 * It reaches the system prompt only when the USER selects `styleId`; nothing
 * here applies a style on its own (`output-styles.md:94`'s `force-for-plugin` is
 * recorded by the adapter and never honoured).
 */
export interface RuntimeOutputStyleDefinition {
  key: string;
  /** The selectable id (`plugin:<pluginKey>:<slug>`) `config.json:outputStyleId` holds. */
  styleId: string;
  /** `output-styles.md:49`'s style name, for the picker's fallback label. */
  name: string;
  resource: PluginBundleResourceRef;
  pluginRuntime?: PluginRuntimeContext;
  pluginInstanceId: PluginInstanceId;
}

export interface RuntimeAppRegistration {
  key: string;
  mcpServerKeys: string[];
  credential?: RuntimeCredentialBinding;
  pluginInstanceId?: PluginInstanceId;
}

export interface ResolvedCapabilityEntry {
  summary: ResolvedCapability;
  runtimeBinding: CapabilityRuntimeBinding;
}

/**
 * The plugin capability kinds whose availability is gated on a PER-CAPABILITY
 * trust grant, rather than inheriting trust from the bundle's installation.
 *
 * Read by exactly two sites, and that is the point (P2.158): the resolver's
 * plugin loop, which puts a member into `review-required` until a grant matches,
 * and the `capabilities:grantTrust` / `listTrustReviews` handlers, which mint the
 * key for it. Before this list existed the two disagreed — the resolver gated
 * `workflow` while the grant endpoint accepted only a native project hook — so a
 * plugin workflow installed into a state nothing in the product, UI or raw RPC,
 * could ever leave. One list makes "can be gated" and "can be granted" the same
 * set by construction; adding a kind here reaches both halves at once.
 *
 * A member MUST carry its host-derived `executableHash` on its runtime binding
 * (see {@link pluginCapabilityTrustKeyMaterial}), because the grant key is
 * reconstructed from a fresh snapshot and never from a client-supplied field.
 *
 * THE TRUST SEMANTICS THIS LIST COMMITS TO. Stated here rather than only at the
 * grant handler, because this constant is what a reader lands on when they ask
 * why a downloaded bundle's JavaScript is allowed to run — and adding a kind
 * here is what extends the answer to another capability:
 *
 * - A grant is for ONE tuple: (plugin instance, capability id, exact
 *   host-derived `executableHash`, selected scope). It is never "this plugin is
 *   trusted" and never "this kind is trusted".
 * - The hash is `sha256(bundleHash || capability definition)`
 *   (`projection-candidates.ts`), and a plugin bundle is content-addressed, so
 *   ANY change to the bytes or to the declaration produces a different key and
 *   the capability falls back to `review-required`. **A grant therefore cannot
 *   survive an update** — which is the property that makes widening the gate a
 *   per-artifact consent rather than a standing permission.
 * - Scope is the resolver's SELECTED scope, carried verbatim, so consent given
 *   for one workspace or project is not replayable at another.
 * - Uninstall purges the record (`CapabilityTrustStore.purgePluginInstances`),
 *   so re-installing the same bytes starts un-granted.
 * - Membership is the *narrow* claim: every plugin kind NOT listed here stays
 *   `not-required` and its grant attempts stay refused, because install is
 *   already its authorization boundary. A workflow is here because invoking one
 *   evaluates arbitrary JavaScript in the orchestration sandbox with no
 *   per-invocation approval.
 */
export const TRUST_GATED_PLUGIN_CAPABILITY_KINDS = ['workflow'] as const;

export type TrustGatedPluginCapabilityKind = typeof TRUST_GATED_PLUGIN_CAPABILITY_KINDS[number];

export function isTrustGatedPluginCapabilityKind(kind: string): kind is TrustGatedPluginCapabilityKind {
  return (TRUST_GATED_PLUGIN_CAPABILITY_KINDS as readonly string[]).includes(kind);
}

/**
 * The three fields a plugin capability's {@link import('./trust-store.ts').CapabilityTrustKey}
 * needs beyond its scope, or `undefined` when this entry is not a trust-gated
 * plugin capability at all.
 *
 * The hash is taken off the RUNTIME BINDING, which is the value the resolver
 * itself compared, so a grant minted from this cannot address anything other
 * than the exact bundle bytes that were gated. It is deliberately not derived
 * from the summary: a summary field would have to cross `toSafeSummary`, and the
 * hash is server-only.
 */
export function pluginCapabilityTrustKeyMaterial(entry: ResolvedCapabilityEntry): {
  pluginInstanceId: PluginInstanceId;
  capabilityId: string;
  executableHash: string;
} | undefined {
  const { summary, runtimeBinding } = entry;
  if (summary.origin !== 'plugin' || !isTrustGatedPluginCapabilityKind(summary.kind)) return undefined;
  if (!summary.pluginInstanceId || !summary.capabilityId) return undefined;
  const executableHash = runtimeBinding.kind === 'workflow'
    ? runtimeBinding.workflow.executableHash
    : undefined;
  if (!executableHash) return undefined;
  return { pluginInstanceId: summary.pluginInstanceId, capabilityId: summary.capabilityId, executableHash };
}

export interface PluginOriginIdentity {
  marketplaceId: string;
  pluginId: string;
  listingId?: string;
  sourceId?: string;
}

export type PluginLifecycleViewState =
  | 'ready' | 'installing' | 'updating' | 'repair-required' | 'uninstalling' | 'error';

export type PluginScopeActivationState = 'enabled' | 'disabled' | 'unset';

/**
 * True per-scope activation for one installed plugin, read from the persisted
 * capability-policy layers (never derived from a bundle or an installed entry).
 * `project` is `'ineligible'` when the resolved context has no project. All
 * fields default to `'unset'` when no policy record exists at that scope.
 */
export interface ResolvedPluginActivation {
  global: PluginScopeActivationState;
  workspace: PluginScopeActivationState;
  project: PluginScopeActivationState | 'ineligible';
  /**
   * The managed tier's own entry for this plugin — `enabledPlugins` at managed
   * scope, `settings-reference.md#enabledplugins`: "**Managed settings**:
   * organization-wide policy. A plugin set to `false` here is blocked from
   * installation at every scope and hidden from the marketplace".
   * `'enabled'` is a force-enable no other
   * scope can undo and `'disabled'` a block; absent/`'unset'` means the managed
   * policy said nothing. Optional so pre-existing hand-built activations stay
   * valid.
   */
  managed?: PluginScopeActivationState;
}

export interface ResolvedInstalledPlugin {
  pluginKey: PluginKey;
  activeInstanceId: PluginInstanceId;
  origin: PluginOriginIdentity;
  name: string;
  version: string;
  installedAt: number;
  lifecycleState: PluginLifecycleViewState;
  availableUpdateVersion?: string;
  /**
   * The installed version and its catalog row cannot be ORDERED — at least one
   * is not a semantic version, so no update can ever be advertised for this
   * plugin (P2.159). Distinct from "no newer version exists": the badge is
   * withheld in both cases, and only this one is worth telling the user about,
   * because it never resolves on its own. Absent means the comparison worked.
   */
  updateVersionUncomparable?: boolean;
  capabilityKinds: ResolvedCapabilityKind[];
  /** Server-side persisted adapter compatibility; safe projection strips paths. */
  compatibility?: PluginCompatibilityReport;
  /** Immutable-manifest presentation only; never read by runtime authority. */
  authRequirements?: PluginMcpAuthRequirement[];
  /**
   * Real per-scope activation for the menu-label direction (U4 defect fix).
   * Populated from the persisted policy layers via
   * `CapabilityResolutionInputs.resolvePluginScopeActivation`; absent when the
   * input provider does not supply that reader (tests / non-policy contexts),
   * in which case the safe view falls back to `'unset'`.
   */
  activation?: ResolvedPluginActivation;
  /**
   * Unsatisfied declared dependencies (`plugins/host-marketplace.md#depend-on-and-recommend-other-plugins`). Present
   * only when non-empty, matching `:217`'s "Plugins with problems include an
   * `errors` field listing them. Plugins that loaded cleanly omit the field."
   * Every entry here forces `activationEnabled: false`.
   */
  dependencyErrors?: ResolvedPluginDependencyError[];
  /** Canonical precedence-merged plugin policy verdict for this context. */
  activationEnabled: boolean;
  /** Server-only immutable bundle identity; stripped from safe views. */
  bundleHash: string;
  /** Server-only immutable bundle root paired with `bundleHash`; stripped from safe views. */
  bundleRootPath?: string;
}

export interface EffectiveCapabilitySnapshot {
  context: CapabilityContext;
  generation: string;
  /** Server-only lifetime lease for referenced immutable plugin instances. */
  leaseId: string;
  entries: ResolvedCapabilityEntry[];
  installedPlugins: ResolvedInstalledPlugin[];
  diagnostics: CapabilityDiagnostic[];
  /**
   * MCP declarations this context's inventory scan refused at config-validation
   * time, carried through untouched from `NativeCapabilityInventory`. Present
   * only when non-empty, mirroring `ResolvedInstalledPlugin.dependencyErrors` —
   * and the omission is the contract, not tidiness: `headless.md:220` puts a CI
   * gate on the emptiness of the array this projects into.
   */
  mcpConfigSkips?: McpConfigSkip[];
}

export type CapabilityInvalidationEffectKind =
  | 'refresh-before-next-turn'
  | 'revoke-active-snapshot';

// ---------------------------------------------------------------------------
// Resolver inputs — the single "read W6/W7 once" seam (injected/testable)
// ---------------------------------------------------------------------------

export interface CapabilityCredentialStatus {
  state: CredentialAvailabilityState;
  revision: string;
}

export interface CapabilitySessionSelection {
  /** Source keys explicitly enabled for the session. */
  enabledSourceKeys?: string[];
  /** Capability keys transiently disabled for the session. */
  transientlyDisabledKeys?: string[];
  /** Monotonic revision so a selection change alters the generation. */
  revision?: string;
}

export interface InstalledPluginInput extends PluginInstalledEntryV2 {
  /** Lifecycle view state (repair/update/etc.); defaults to 'ready'. */
  lifecycleState?: PluginLifecycleViewState;
  availableUpdateVersion?: string;
  /**
   * The installed version and its catalog row cannot be ORDERED — at least one
   * is not a semantic version, so no update can ever be advertised for this
   * plugin (P2.159). Distinct from "no newer version exists": the badge is
   * withheld in both cases, and only this one is worth telling the user about,
   * because it never resolves on its own. Absent means the comparison worked.
   */
  updateVersionUncomparable?: boolean;
  listingId?: string;
  sourceId?: string;
}

/** Everything the resolver reads for one context, gathered exactly once. */
export interface CapabilityResolutionInputs {
  nativeInventory: NativeCapabilityInventory;
  installedPlugins: InstalledPluginInput[];
  activePluginInstances: Record<PluginKey, PluginInstanceId>;
  /** Store-owned immutable-instance lease; W10 injects PluginStoreV2 here. */
  acquirePluginInstanceLease?: (instanceId: PluginInstanceId) => () => void;
  /** Projection candidates for the active instances at the resolved scope. */
  pluginCandidates: PluginProjectionCandidate[];
  /**
   * Effective PLUGIN-LEVEL activation (already precedence-merged) plus the
   * per-capability map. Providers MUST NOT fold `capabilities[capabilityId]`
   * into `enabled`/`suppressed` — the resolver applies the map itself so a
   * capability-level disable carries its own 'capability-disabled' reason.
   * `capabilityId` is advisory context only.
   */
  resolveActivation: (
    target: { pluginKey?: PluginKey; pluginInstanceId?: PluginInstanceId },
    capabilityId?: string,
  ) => ResolvedCapabilityActivation;
  /**
   * True per-scope activation for one plugin, read from the persisted policy
   * layers (U4 defect fix). Unlike `resolveActivation` (which returns the single
   * precedence-merged verdict for the current context) this reports each scope
   * independently so the safe view can label the row menu Enable-vs-Disable
   * correctly. Optional/additive: when absent the safe view falls back to
   * `'unset'` for every scope. MUST only READ existing policy records — never a
   * new store or mutation.
   */
  resolvePluginScopeActivation?: (
    target: { pluginKey?: PluginKey; pluginInstanceId?: PluginInstanceId },
  ) => ResolvedPluginActivation;
  /** Executable trust for a plugin capability requiring a grant. */
  resolveTrust: (key: CapabilityTrustKey) => CapabilityTrustState;
  /** Non-secret credential status/revision for a required credential ref. */
  resolveCredentialStatus?: (credentialRef: string) => CapabilityCredentialStatus;
  /** Runtime credential binding to attach for lazy secret resolution. */
  bindCredential?: (credentialRef: string) => RuntimeCredentialBinding | undefined;
  /** Required credential ref per capability key (source/mcp/app), if any. */
  credentialRefFor?: (key: string) => string | undefined;
  /** Child environment name to credential ref for multi-secret plugin MCP servers. */
  credentialRefsFor?: (key: string) => Record<string, string> | undefined;
  /** Missing required imported configuration keys, computed server-side from the encrypted store. */
  configurationMissingFor?: (key: string) => string[];
  /** Name-only host environment availability; values never enter resolution. */
  isEnvironmentVariableAvailable?: (name: string) => boolean;
  /** Immutable installed-bundle root + writable data root per instance. */
  pluginRuntimeContextFor?: (instanceId: PluginInstanceId) => PluginRuntimeContext | undefined;
  /**
   * `CLAUDE_PLUGIN_OPTION_<KEY>` env for one plugin's HOOK processes
   * (`plugins/manifest-reference.md#environment-variables`), resolved by the host from the credential store
   * and the user-scoped option file. Absent when the plugin declares no
   * `userConfig` or nothing is configured.
   */
  pluginOptionEnvironmentFor?: (instanceId: PluginInstanceId) => Record<string, string> | undefined;
  sessionSelection?: CapabilitySessionSelection;
  /** Composer provider feature-matrix revision (folded into generation). */
  providerCapabilityRevision?: string;
}

export type CapabilityResolutionInputProvider = (
  context: CapabilityContext,
) => Promise<CapabilityResolutionInputs> | CapabilityResolutionInputs;

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface CapabilityResolver {
  resolve(context: CapabilityContext): Promise<EffectiveCapabilitySnapshot>;
  releaseSnapshot(leaseId: string): void;
  invalidate(
    scope: CapabilityInvalidationScope,
    reason: string,
    effect: CapabilityInvalidationEffectKind, pluginKey?: PluginKey, // F1.766 — narrows a revoke to the leases holding that plugin ({@link leaseHoldsPlugin})
  ): void;
  /** True while a lease is live and not revoked (fail-closed on revoke). */
  isLeaseActive(leaseId: string): boolean;
  /** Instance ids still referenced by a live lease (pruning gate). */
  referencedInstances(): Set<PluginInstanceId>;
  /** Count of live (unreleased) leases; tests assert this returns to zero. */
  leaseCount(): number;
}

export type { CapabilityInvalidationScope } from './invalidation.ts';

interface LeaseRecord {
  context: CapabilityContext;
  generation: string;
  instances: Set<PluginInstanceId>;
  revoked: boolean;
  releaseInstanceLeases: Array<() => void>;
}

let leaseCounter = 0;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function scopeSpecificity(scope: CapabilityScopeRef): number {
  switch (scope.kind) {
    case 'project': return 3;
    case 'workspace': return 2;
    case 'global': return 1;
    case 'builtin': return 0;
  }
}

/**
 * Scope precedence for the UNQUALIFIED-ALIAS choice only (`applyCollisionPolicy`).
 *
 * Every kind but `skill` keeps {@link scopeSpecificity}: nearest scope wins, which
 * is what the MCP arm needs (`mcp.md:431`).
 *
 * SUBAGENTS TAKE THAT WITH ONE EXCEPTION (P6.239, denominator B20). This
 * sentence used to end "…and what the subagent arm needs
 * (`features-overview.md`: 'managed > CLI flag > project > user > plugin for
 * subagents')", and that quote REFUTES the sentence it was supporting:
 * `scopeSpecificity('builtin')` is 0, the LOWEST, so the tier the page ranks
 * FIRST came last and a managed subagent lost its bare name to a project one.
 * `scopeSpecificity` does deliver the authored half — project > user — and only
 * the managed tier was upside down, so it now has a rank of its own above every
 * authored level. `sub-agents.md` § *Choose the subagent scope* says it twice:
 * the scope table gives "Managed settings" priority "1 (highest)", and the prose
 * adds "Managed definitions take precedence over project and user subagents with
 * the same name."
 *
 * THE PLUGIN END IS EXPRESSED TOO (P6.631), and it was the same defect one kind
 * along. `features-overview.md` § *Understand how features layer*: "when the same
 * name exists at multiple levels, one definition wins based on priority (managed
 * > user > project for skills; managed > CLI flag > project > user > plugin for
 * subagents)." A plugin agent is LAST there, and `scopeSpecificity` gave it the
 * rank of its PROJECTED scope — `storage-runtime.ts:selectedCapabilityScope`
 * hands a plugin capability `project` whenever the context has a project, so a
 * plugin subagent took 3 against a user subagent's 1 and won the bare name the
 * page ranks it last for. That is exactly what P2.449 closed for plugin SKILLS,
 * so the rank is the same −1 for the same reason: an UNCONTESTED plugin agent is
 * still the only member of its bucket and keeps its short name, and only an
 * authored subagent that actually claims the name takes it.
 *
 * THE CLI-FLAG TIER IS AN HONEST NULL, recorded rather than ranked (P6.631).
 * The page puts "CLI flag" between managed and project; this fork has no
 * `--agents` flag for anything to be ranked against, and that absence is not a
 * grep result — it is pinned structurally by
 * `apps/cli/src/sideload-flags-tripwire.test.ts` (P6.249), which drives the real
 * `parseArgs`: every unrecognized dash-leading token is an error before anything
 * is spawned, so `--agents` cannot reach a child under that name OR any other.
 * `agents/definitions.ts` records the matching half from the data side — the
 * main-session-agent surface the flag belongs to (`--agent`, `--agents`, an
 * `agent` setting) does not exist here either, costed as a deviation by R30c.
 * What this fork does have is the SDK's `agents` OPTION, a value:
 * `claude-runtime-agents.ts` materializes every definition from this very
 * catalog and passes it, so a flag tier would have nothing of its own to carry.
 * If such a flag is ever added, its rank belongs here, between `builtin`'s 5 and
 * `project`'s 3 — and the tripwire above is what will go red to say so.
 *
 * SKILLS INVERT IT. The same line binds skills the other way — "one definition
 * wins based on priority (managed > user > project for skills; …)" — and
 * `skills.md:122` says it independently: "When skills share the same name across
 * levels, enterprise overrides personal, and personal overrides project. A skill
 * at any of these levels also overrides a bundled skill with the same name."
 *
 * THAT SENTENCE HAS TWO HALVES AND THEY POINT IN OPPOSITE DIRECTIONS. The head
 * — "enterprise overrides personal" — puts the machine-wide managed tier ABOVE
 * every authored level. The trailing clause puts the BUNDLE below every one of
 * them. `builtin` used to carry rank 0 and stand in for the second half, which
 * was safe only while no skill record existed at that scope: the bundle already
 * has a representation of its own (`skillTier: 'bundled'`, R78, rank 1) because
 * scope alone could not express it in this fork.
 *
 * P2.449 made `builtin` REAL for skills — `native-sources.ts` now emits the
 * administrator-owned machine-wide roots there — so the scope means exactly one
 * thing, and it is the sentence's head, not its tail. Rank 5 is what
 * `features-overview.md:193`'s "managed > user > project for skills" spells, and
 * it is the ordering the agent-side loader already implements: `loadAllSkills`
 * writes the admin tier LAST into its slug map, so admin wins there. Leaving
 * `builtin` at 0 would have given the two loaders OPPOSITE precedence on the
 * same tier from the same directories — the divergence P6.8 opened to close.
 *
 * The chain is therefore monotone: `builtin` 5 > `global` 4 > `workspace` 3 >
 * `project` 2 > bundled 1 > plugin −1.
 *
 * `workspace` has no Claude counterpart; it sits between `global` and `project`
 * so the authored chain inverts monotonically. Changing that judgment is a
 * one-case edit.
 *
 * PLUGIN SKILLS ARE OUT OF CONTENTION ENTIRELY, at every scope. `skills.md:122`:
 * "Plugin skills use a `plugin-name:skill-name` namespace, so they cannot
 * conflict with other levels" (`features-overview.md:193`: "Plugin skills are
 * namespaced to avoid conflicts"). Our plugin skill candidates do NOT carry that
 * namespace — `projection-candidates.ts` pushes `capability.skill.slug` as the
 * `logicalName` — so they share the bare-name bucket and would otherwise contend.
 * `storage-runtime.ts:selectedCapabilityScope` projects them at `project` scope
 * whenever the context has a project, which pre-fix let a plugin skill take the
 * bare name from the user's personal skill; a `kind`-only gate would merely move
 * the same defect to `global`-scope plugins. Ranking them below `builtin` keeps
 * an UNCONTESTED plugin skill on its short name (it is still the only member of
 * its bucket) while never letting it displace an authored level.
 *
 * This function decides ALIAS SELECTION ONLY. `scopeSpecificity` still owns the
 * instruction/permission layer `order`, where project-last is correct.
 *
 * THE BUNDLED TIER (R78) is why `skillTier` is consulted BEFORE the scope. The
 * inversion above cannot honour `skills.md:122`'s worked example — "a
 * `code-review` skill in your project's `.claude/skills/` replaces the bundled
 * `/code-review`" — on scope alone, because this fork keeps no bundled directory
 * at runtime: `skills/seed.ts:ensureBundledSkills` COPIES the packaged skills
 * into `${CONFIG_DIR}/skills`, the same personal root `native-sources.ts` pushes
 * at `global` scope. Left untagged, a seeded bundle would OUTRANK a project skill
 * of the same slug — the exact opposite of that sentence, for the four slugs that
 * ship (`loop`, `plugin-creator`, `skill-creator`, `code-review`).
 * `storage-runtime.ts:isSeededBundledSkill` is the one producer that can tell
 * them apart (it already owns that identity for the bundled-skills off-switch and
 * the origin lock), and it stamps `skillTier: 'bundled'`. The tag is PROVENANCE,
 * not content — see `types.ts:skillTier`.
 *
 * Keyed on the TAG, not on the scope, deliberately: a bundled record is
 * `global`-scoped today, and reading the tag keeps this ordering correct if the
 * seed root is ever pushed at another scope. It sits between `project` and
 * `builtin`, so an UNCONTESTED bundled skill still wins its own bucket and keeps
 * its short name — only an authored skill that actually claims the name takes it.
 */
function aliasScopeRank(summary: ResolvedCapability): number {
  // P6.239 — the managed SUBAGENT tier, the one `scopeSpecificity` cannot
  // deliver: it is rank 0 there. 5 rather than 4, to sit above `project`'s 3
  // with the same headroom the skill chain below leaves.
  if (summary.kind === 'agent' && summary.scope.kind === 'builtin') return 5;
  // P6.631 — the tail of the same chain. `features-overview.md` ranks a plugin
  // subagent LAST, and `scopeSpecificity` gave it its projected scope's rank
  // (`project`, 3) against a user subagent's 1. Same value and same reason as
  // the plugin SKILL line below, so the two cannot drift apart.
  if (summary.kind === 'agent' && summary.origin === 'plugin') return -1;
  if (summary.kind !== 'skill') return scopeSpecificity(summary.scope);
  if (summary.origin === 'plugin') return -1;
  if (summary.skillTier === 'bundled') return 1;

  switch (summary.scope.kind) {
    // The administrator-owned machine-wide tier (P2.449). Above every authored
    // level, per `skills.md:122`'s "enterprise overrides personal".
    case 'builtin': return 5;
    case 'global': return 4;
    case 'workspace': return 3;
    case 'project': return 2;
  }
}

/**
 * Native scope → runtime resource source discriminant. `builtin`/`global` map to
 * managed-global; a personal `~/.agents` layer is shared-personal (native-sources
 * distinguishes these via the record, but for W8 we key on the scope kind).
 */
function nativeResourceSource(scope: CapabilityScopeRef): NativeResourceRef['source'] {
  switch (scope.kind) {
    case 'project': return 'project';
    case 'workspace': return 'workspace';
    default: return 'managed-global';
  }
}

function toNativeResourceRef(record: NativeCapabilitySourceRecord): NativeResourceRef {
  return {
    source: nativeResourceSource(record.scope),
    scope: record.scope,
    resourceId: record.key,
    absolutePath: record.sourcePath,
    revision: record.revision,
    contentHash: record.contentHash,
  };
}

const NATIVE_BINDING_KINDS = new Set<ResolvedCapabilityKind>([
  'source', 'skill', 'mcp', 'hook', 'automation', 'agent',
  'instruction', 'memory', 'permission',
]);

function nativeRuntimeBinding(
  record: NativeCapabilitySourceRecord,
  resource: NativeResourceRef,
  credential: RuntimeCredentialBinding | undefined,
): CapabilityRuntimeBinding {
  const key = record.key;
  switch (record.kind) {
    case 'source':
      return {
        kind: 'source',
        resource,
        ...(record.guideResource
          ? {
              guideResource: {
                source: nativeResourceSource(record.scope),
                scope: record.scope,
                resourceId: `${record.key}:guide`,
                absolutePath: record.guideResource.sourcePath,
                revision: record.guideResource.revision,
                contentHash: record.guideResource.contentHash,
              },
            }
          : {}),
        ...(credential ? { credential } : {}),
      };
    case 'skill':
      return { kind: 'skill', resource };
    case 'mcp':
      return {
        kind: 'mcp',
        server: {
          key,
          wireName: record.logicalName,
          logicalName: record.logicalName,
          // A7 (option A): a BUILT-IN mcp record pins NO document and NO
          // source name, and withholding them is load-bearing rather than
          // tidiness. A built-in has no `.mcp.json` on disk, and the ONE thing
          // that materializes its command is the built-in fold
          // (`mcp/runtime-pool-servers.ts:foldBuiltinDpMcpServers`). With a
          // resource + sourceName, `materializeSnapshotMcpServers` would take
          // the pinned-document branch for it; anything it produced under this
          // wire name would then make `mergeBuiltinDpMcpServers` treat the name
          // as already configured and STAND THE REAL BUILT-IN DOWN — the server
          // would show as enabled in the list and never start. With neither, the
          // empty `command` below makes that loop skip the entry
          // (`if (!server.definition.command) continue`), leaving the fold as
          // the single materialization path it documents itself to be.
          //
          // `wireName` still stands, and has to: it is how
          // `SessionManager.resolveMcpBindingFromContext` finds the built-in's
          // live tools in the pool for the detail page.
          ...(record.scope.kind === 'builtin'
            ? {}
            : { resource, sourceName: record.logicalName }),
          // Native MCP definitions are materialized lazily by the runtime view;
          // the resolver only pins the resource identity here.
          definition: { type: 'stdio', command: '' },
          ...(credential ? { credential } : {}),
        },
      };
    case 'hook':
      return { kind: 'hook', hook: { key, event: record.logicalName, resource, executableHash: record.contentHash } };
    case 'automation':
      return { kind: 'automation', automation: { key, event: record.logicalName, resource } };
    case 'agent':
      // P6.602 — the frontmatter `description` the definition file declares,
      // pinned onto the record by `native-sources.ts`. `sub-agents.md`
      // § *Supported frontmatter fields* makes it required ("Only `name` and
      // `description` are required") and the SDK takes it as-is; an empty one
      // here is what makes `claude-runtime-agents.ts` substitute
      // `Imported <name> agent.`, so every native agent used to reach the model
      // under the same contentless sentence. The `?? ''` keeps a file that
      // declares none on exactly the old path.
      return { kind: 'agent', agent: { key, name: record.logicalName, description: record.description ?? '', instructionsResource: resource } };
    case 'instruction':
      return {
        kind: 'instruction',
        layer: {
          key,
          resource,
          order: scopeSpecificity(record.scope),
          ...(record.memoryImportParentPath ? { importParentPath: record.memoryImportParentPath } : {}),
        },
      };
    case 'memory':
      return {
        kind: 'memory',
        memory: {
          key,
          resource,
          readOnly: !record.mutable,
          ...(record.memoryFormat ? { format: record.memoryFormat } : {}),
          ...(record.memoryImportParentPath ? { importParentPath: record.memoryImportParentPath } : {}),
        },
      };
    case 'permission':
      return {
        kind: 'permission',
        layer: {
          key,
          resource,
          order: scopeSpecificity(record.scope),
          scope: record.scope.kind,
          ...(record.permissionSourceSlug ? { sourceSlug: record.permissionSourceSlug } : {}),
        },
      };
  }
}

/**
 * Author-declared invocation restrictions for a plugin skill candidate, in the
 * same `skill*`-prefixed shape the native records use so `toAgentRuntime` maps
 * both through one branch. Restrictions only — never a grant.
 */
function pluginSkillInvocationControls(candidate: PluginProjectionCandidate): {
  skillDisableModelInvocation?: boolean;
  skillUserInvocable?: boolean;
  skillAllowedTools?: string[];
  skillPaths?: string[];
} {
  const definition = candidate.runtimeDefinition;
  if (candidate.kind !== 'skill' || definition?.kind !== 'skill') return {};
  return {
    ...(definition.skill.disableModelInvocation === undefined
      ? {}
      : { skillDisableModelInvocation: definition.skill.disableModelInvocation }),
    ...(definition.skill.userInvocable === undefined
      ? {}
      : { skillUserInvocable: definition.skill.userInvocable }),
    // R17b made `allowed-tools` enforced at invocation. Reporting it here is
    // what stops the capability view from under-reporting a restriction that is
    // already in force for an imported plugin skill.
    ...(definition.skill.allowedTools ? { skillAllowedTools: definition.skill.allowedTools } : {}),
    ...(definition.skill.paths ? { skillPaths: definition.skill.paths } : {}),
  };
}

function pluginRuntimeBinding(
  candidate: PluginProjectionCandidate,
  pluginRuntime: PluginRuntimeContext | undefined,
  credential: RuntimeCredentialBinding | undefined,
  credentialEnvironment?: Record<string, { configKey: string; credential: RuntimeCredentialBinding }>,
  optionEnvironment?: Record<string, string>,
  skillUserConfig?: Record<string, string>,
): CapabilityRuntimeBinding {
  const key = candidate.key;
  const resource = candidate.resource;
  const executableHash = candidate.trust.executableHash ?? '';
  const runtimeDefinition = candidate.runtimeDefinition;
  switch (candidate.kind) {
    case 'skill':
      return resource
        ? {
            kind: 'skill',
            resource,
            ...(pluginRuntime ? { pluginRuntime } : {}),
            ...(candidate.trust.required ? { executableHash } : {}),
            ...(skillUserConfig ? { pluginUserConfig: skillUserConfig } : {}),
          }
        : { kind: 'asset', resource: resource as never, ...(pluginRuntime ? { pluginRuntime } : {}) };
    case 'mcp':
      if (runtimeDefinition?.kind !== 'mcp') {
        return { kind: 'asset', resource: resource ?? { pluginInstanceId: candidate.pluginInstanceId, relativePath: '', contentHash: '' }, ...(pluginRuntime ? { pluginRuntime } : {}) };
      }
      return {
        kind: 'mcp',
        server: {
          key,
          wireName: candidate.logicalName,
          logicalName: candidate.logicalName,
          definition: runtimeDefinition.mcp.transport === 'stdio'
            ? {
                type: 'stdio',
                command: runtimeDefinition.mcp.command ?? '',
                ...(runtimeDefinition.mcp.args ? { args: runtimeDefinition.mcp.args } : {}),
                ...(runtimeDefinition.mcp.cwd ? { cwd: runtimeDefinition.mcp.cwd } : {}),
                ...((runtimeDefinition.mcp.env
                  || runtimeDefinition.mcp.environmentDefaults
                  || runtimeDefinition.mcp.requiredEnvironmentNames)
                  ? {
                      forwardedEnvironmentNames: [...new Set([
                        ...Object.keys(runtimeDefinition.mcp.env ?? {}),
                        ...Object.keys(runtimeDefinition.mcp.environmentDefaults ?? {}),
                        ...(runtimeDefinition.mcp.requiredEnvironmentNames ?? []),
                      ])].sort(),
                    }
                  : {}),
                ...(runtimeDefinition.mcp.requiredEnvironmentNames
                  ? { requiredEnvironmentNames: [...runtimeDefinition.mcp.requiredEnvironmentNames].sort() }
                  : {}),
                ...(runtimeDefinition.mcp.environmentSources
                  ? {
                      forwardedEnvironmentSources: Object.fromEntries(
                        Object.entries(runtimeDefinition.mcp.environmentSources).sort(([left], [right]) => left.localeCompare(right)),
                      ),
                    }
                  : {}),
                ...(runtimeDefinition.mcp.toolTimeoutMs
                  ? { toolTimeoutMs: runtimeDefinition.mcp.toolTimeoutMs }
                  : {}),
                ...(runtimeDefinition.mcp.required !== undefined
                  ? { required: runtimeDefinition.mcp.required }
                  : {}),
                ...(runtimeDefinition.mcp.alwaysLoad === true ? { alwaysLoad: true } : {}),
              }
            : {
                type: runtimeDefinition.mcp.transport,
                url: runtimeDefinition.mcp.url ?? '',
                ...(runtimeDefinition.mcp.headers
                  ? { headerNames: Object.keys(runtimeDefinition.mcp.headers).sort() }
                  : {}),
                ...((runtimeDefinition.mcp.env
                  || runtimeDefinition.mcp.environmentDefaults
                  || runtimeDefinition.mcp.requiredEnvironmentNames)
                  ? {
                      forwardedEnvironmentNames: [...new Set([
                        ...Object.keys(runtimeDefinition.mcp.env ?? {}),
                        ...Object.keys(runtimeDefinition.mcp.environmentDefaults ?? {}),
                        ...(runtimeDefinition.mcp.requiredEnvironmentNames ?? []),
                      ])].sort(),
                    }
                  : {}),
                ...(runtimeDefinition.mcp.requiredEnvironmentNames
                  ? { requiredEnvironmentNames: [...runtimeDefinition.mcp.requiredEnvironmentNames].sort() }
                  : {}),
                ...(runtimeDefinition.mcp.environmentSources
                  ? {
                      forwardedEnvironmentSources: Object.fromEntries(
                        Object.entries(runtimeDefinition.mcp.environmentSources).sort(([left], [right]) => left.localeCompare(right)),
                      ),
                    }
                  : {}),
                ...(runtimeDefinition.mcp.toolTimeoutMs
                  ? { toolTimeoutMs: runtimeDefinition.mcp.toolTimeoutMs }
                  : {}),
                ...(runtimeDefinition.mcp.required !== undefined
                  ? { required: runtimeDefinition.mcp.required }
                  : {}),
                ...(runtimeDefinition.mcp.alwaysLoad === true ? { alwaysLoad: true } : {}),
              },
          ...(candidate.trust.required ? { executableHash } : {}),
          // C3 (capability-path): a remote server with declared auth carries
          // its plugin-slot identity to the pool.
          ...(runtimeDefinition.mcp.transport !== 'stdio' && runtimeDefinition.mcp.authType
            ? {
                endpointAuth: {
                  authType: runtimeDefinition.mcp.authType,
                  pluginKey: candidate.pluginKey,
                  serverName: runtimeDefinition.mcp.serverName,
                  ...(runtimeDefinition.mcp.oauthResource
                    ? { oauthResource: runtimeDefinition.mcp.oauthResource }
                    : {}),
                  ...(runtimeDefinition.mcp.clientId
                    ? { clientId: runtimeDefinition.mcp.clientId }
                    : {}),
                },
              }
            : {}),
          ...(runtimeDefinition.mcp.env
            ? { descriptorEnvironment: { ...runtimeDefinition.mcp.env } }
            : {}),
          ...(runtimeDefinition.mcp.environmentDefaults
            ? { descriptorEnvironmentDefaults: { ...runtimeDefinition.mcp.environmentDefaults } }
            : {}),
          ...(runtimeDefinition.mcp.headers
            ? { descriptorHeaders: { ...runtimeDefinition.mcp.headers } }
            : {}),
          ...(runtimeDefinition.mcp.transport !== 'stdio' && runtimeDefinition.mcp.headersHelper
            ? { descriptorHeadersHelper: runtimeDefinition.mcp.headersHelper }
            : {}),
          ...(credential ? { credential } : {}),
          ...(credentialEnvironment && Object.keys(credentialEnvironment).length
            ? { credentialEnvironment }
            : {}),
          ...(pluginRuntime ? { pluginRuntime } : {}),
          pluginInstanceId: candidate.pluginInstanceId,
        },
      };
    case 'hook':
      return {
        kind: 'hook',
        hook: {
          key,
          event: runtimeDefinition?.kind === 'hook'
            ? runtimeDefinition.hook.event
            : candidate.logicalName,
          resource: resource ?? { pluginInstanceId: candidate.pluginInstanceId, relativePath: '', contentHash: '' },
          executableHash,
          ...(pluginRuntime ? { pluginRuntime } : {}),
          ...(optionEnvironment && Object.keys(optionEnvironment).length
            ? { optionEnvironment }
            : {}),
          pluginInstanceId: candidate.pluginInstanceId,
          ...(runtimeDefinition?.kind === 'hook'
            ? {
                type: runtimeDefinition.hook.type,
                ...(runtimeDefinition.hook.matcher ? { matcher: runtimeDefinition.hook.matcher } : {}),
                ...(runtimeDefinition.hook.command ? { command: runtimeDefinition.hook.command } : {}),
                ...(runtimeDefinition.hook.args ? { args: [...runtimeDefinition.hook.args] } : {}),
                ...(runtimeDefinition.hook.cwd ? { cwd: runtimeDefinition.hook.cwd } : {}),
                ...(runtimeDefinition.hook.timeoutMs !== undefined
                  ? { timeoutMs: runtimeDefinition.hook.timeoutMs }
                  : {}),
                ...(runtimeDefinition.hook.statusMessage
                  ? { statusMessage: runtimeDefinition.hook.statusMessage }
                  : {}),
                ...(runtimeDefinition.hook.async ? { async: true } : {}),
                ...(runtimeDefinition.hook.asyncRewake ? { asyncRewake: true } : {}),
                ...(runtimeDefinition.hook.exitCodeContract
                  ? { exitCodeContract: runtimeDefinition.hook.exitCodeContract }
                  : {}),
                ...(runtimeDefinition.hook.shell ? { shell: runtimeDefinition.hook.shell } : {}),
                ...(runtimeDefinition.hook.onFailure ? { onFailure: runtimeDefinition.hook.onFailure } : {}),
                ...(runtimeDefinition.hook.once ? { once: true } : {}),
                ...(runtimeDefinition.hook.ifRule ? { ifRule: runtimeDefinition.hook.ifRule } : {}),
                ...(runtimeDefinition.hook.prompt ? { prompt: runtimeDefinition.hook.prompt } : {}),
                ...(runtimeDefinition.hook.model ? { model: runtimeDefinition.hook.model } : {}),
                ...(runtimeDefinition.hook.continueOnBlock ? { continueOnBlock: true } : {}),
                ...(runtimeDefinition.hook.agentName ? { agentName: runtimeDefinition.hook.agentName } : {}),
                ...(runtimeDefinition.hook.mcpTool ? { mcpTool: runtimeDefinition.hook.mcpTool } : {}),
                ...(runtimeDefinition.hook.mcpArgs ? { mcpArgs: runtimeDefinition.hook.mcpArgs } : {}),
                ...(runtimeDefinition.hook.http ? { http: runtimeDefinition.hook.http } : {}),
              }
            : {}),
        },
      };
    case 'command':
      return {
        kind: 'command',
        command: {
          key,
          resource: resource ?? { pluginInstanceId: candidate.pluginInstanceId, relativePath: candidate.logicalName, contentHash: '' },
          executableHash,
          ...(pluginRuntime ? { pluginRuntime } : {}),
          pluginInstanceId: candidate.pluginInstanceId,
        },
      };
    case 'app': {
      // K1: an app routes ONLY to its connector's declared MCP server keys.
      // The connector's `mcpServers[].serverName` is the closed allow-list; the
      // app's `routing` may select a subset, but a routing target not present in
      // the connector is dropped (never reaches beyond the declared servers).
      const declaredKeys = (candidate.connector?.mcpServers ?? []).map(server => server.serverName);
      const declaredKeySet = new Set(declaredKeys);
      const routingTargets = Object.values(candidate.app?.routing ?? {});
      const mcpServerKeys = routingTargets.length > 0
        ? routingTargets.filter(target => declaredKeySet.has(target))
        : declaredKeys;
      return {
        kind: 'app',
        app: {
          key,
          mcpServerKeys,
          pluginInstanceId: candidate.pluginInstanceId,
          ...(credential ? { credential } : {}),
        },
      };
    }
    case 'agent':
      return {
        kind: 'agent',
        ...(candidate.trust.required ? { executableHash } : {}),
        agent: {
          key,
          name: candidate.logicalName,
          description: candidate.description ?? '',
          instructionsResource: resource ?? { pluginInstanceId: candidate.pluginInstanceId, relativePath: '', contentHash: '' },
          ...(runtimeDefinition?.kind === 'agent' && runtimeDefinition.agent.model ? { model: runtimeDefinition.agent.model } : {}),
          ...(runtimeDefinition?.kind === 'agent' && runtimeDefinition.agent.tools ? { tools: runtimeDefinition.agent.tools } : {}),
        },
      };
    case 'prompt-command':
      // A prompt-command is data (a Markdown prompt template), never a
      // subprocess invocation — it gets its own dedicated binding kind with
      // NO executableHash, so it can never be executed/hashed as a command.
      return {
        kind: 'prompt-command',
        promptCommand: {
          key,
          resource: resource ?? { pluginInstanceId: candidate.pluginInstanceId, relativePath: candidate.logicalName, contentHash: '' },
          ...(runtimeDefinition?.kind === 'prompt-command' && runtimeDefinition.promptCommand.argumentHint
            ? { argumentHint: runtimeDefinition.promptCommand.argumentHint }
            : {}),
          ...(runtimeDefinition?.kind === 'prompt-command' && runtimeDefinition.promptCommand.model
            ? { model: runtimeDefinition.promptCommand.model }
            : {}),
          ...(pluginRuntime ? { pluginRuntime } : {}),
          pluginInstanceId: candidate.pluginInstanceId,
        },
      };
    case 'workflow':
      return {
        kind: 'workflow',
        workflow: {
          key,
          resource: resource ?? {
            pluginInstanceId: candidate.pluginInstanceId,
            relativePath: '',
            contentHash: '',
          },
          ...(pluginRuntime ? { pluginRuntime } : {}),
          pluginInstanceId: candidate.pluginInstanceId,
          // Same carry the `skill`/`agent` branches make, and for the same
          // reason: the trust RPC reconstructs the grant key from a fresh
          // snapshot, so the hash the gate compared must be ON the binding.
          ...(candidate.trust.required ? { executableHash } : {}),
        },
      };
    case 'output-style':
      return {
        kind: 'output-style',
        outputStyle: {
          key,
          // The candidate's logical name IS the composed selectable id
          // (`projection-candidates.ts`), which is the only place the installed
          // plugin key is authoritative.
          styleId: candidate.logicalName,
          name: runtimeDefinition?.kind === 'output-style'
            ? runtimeDefinition.outputStyle.name
            : candidate.logicalName,
          resource: resource ?? {
            pluginInstanceId: candidate.pluginInstanceId,
            relativePath: '',
            contentHash: '',
          },
          ...(pluginRuntime ? { pluginRuntime } : {}),
          pluginInstanceId: candidate.pluginInstanceId,
        },
      };
    case 'setting':
      return runtimeDefinition?.kind === 'setting'
        ? {
            kind: 'setting',
            valueType: runtimeDefinition.setting.valueType,
            ...(runtimeDefinition.setting.defaultValue !== undefined
              ? { defaultValue: runtimeDefinition.setting.defaultValue }
              : {}),
          }
        : { kind: 'setting', valueType: 'string' };
    case 'asset':
      return { kind: 'asset', resource: resource ?? { pluginInstanceId: candidate.pluginInstanceId, relativePath: '', contentHash: '' }, ...(pluginRuntime ? { pluginRuntime } : {}) };
    case 'lsp':
      return {
        kind: 'lsp',
        lsp: {
          key,
          lspId: runtimeDefinition?.kind === 'lsp' ? runtimeDefinition.lsp.id : candidate.logicalName,
          command: runtimeDefinition?.kind === 'lsp' ? runtimeDefinition.lsp.command : '',
          executableHash,
          ...(runtimeDefinition?.kind === 'lsp' && runtimeDefinition.lsp.args ? { args: runtimeDefinition.lsp.args } : {}),
          ...(runtimeDefinition?.kind === 'lsp' ? pluginLspRoutingFields(runtimeDefinition.lsp) : { languages: [] }),
          ...(runtimeDefinition?.kind === 'lsp' && runtimeDefinition.lsp.workingDirectory ? { workingDirectory: runtimeDefinition.lsp.workingDirectory } : {}),
          ...(runtimeDefinition?.kind === 'lsp' && runtimeDefinition.lsp.env ? { env: runtimeDefinition.lsp.env } : {}),
          ...(runtimeDefinition?.kind === 'lsp' && runtimeDefinition.lsp.workspaceFolder ? { workspaceFolder: runtimeDefinition.lsp.workspaceFolder } : {}),
          ...(runtimeDefinition?.kind === 'lsp' && runtimeDefinition.lsp.supervision ? { supervision: runtimeDefinition.lsp.supervision } : {}),
          ...(pluginRuntime ? { pluginRuntime } : {}),
          pluginInstanceId: candidate.pluginInstanceId,
        },
      };
    case 'monitor': {
      const descriptor = runtimeDefinition?.kind === 'monitor' ? runtimeDefinition.monitor : undefined;
      const monitorBase = {
        key,
        monitorId: descriptor?.id ?? candidate.logicalName,
        executableHash,
        ...(pluginRuntime ? { pluginRuntime } : {}),
        pluginInstanceId: candidate.pluginInstanceId,
      };
      if (descriptor && isCommandMonitorDescriptor(descriptor)) {
        return {
          kind: 'monitor',
          monitor: {
            ...monitorBase,
            form: 'command',
            command: descriptor.command,
            description: descriptor.description,
            when: descriptor.when,
            pluginKey: candidate.pluginKey,
          },
        };
      }
      return {
        kind: 'monitor',
        monitor: {
          ...monitorBase,
          resource: resource ?? { pluginInstanceId: candidate.pluginInstanceId, relativePath: '', contentHash: '' },
          cron: descriptor?.cron ?? '',
          ...(descriptor?.timezone ? { timezone: descriptor.timezone } : {}),
        },
      };
    }
    case 'unsupported-runtime':
      // Retained for catalog/provenance; not executable. Modeled as an asset
      // binding with an empty resource so the view can render it as unavailable.
      return { kind: 'asset', resource: resource ?? { pluginInstanceId: candidate.pluginInstanceId, relativePath: '', contentHash: '' }, ...(pluginRuntime ? { pluginRuntime } : {}) };
  }
}

/**
 * True when this plugin is active in the current context ONLY because the
 * project layer says so — the Nessy equivalent of Claude's project-scope plugin
 * (`plugins/components.md#monitors`).
 *
 * An ABSENT reader is not project scope. `resolvePluginScopeActivation` is
 * optional on the inputs and is supplied by the one production wiring
 * (`server-core/src/bootstrap/storage-runtime.ts`); a context that does not
 * supply it has no project policy layer at all, so nothing there can be
 * project-scoped. Treating absence as project scope would refuse every monitor
 * in every non-policy context instead.
 *
 * A managed force-enable counts as an administrator's own decision, not the
 * repository's, so it lifts the restriction the same way a user's global enable
 * does.
 */
function isProjectScopeOnlyActivation(activation: ResolvedPluginActivation | undefined): boolean {
  if (!activation) return false;
  if (activation.project !== 'enabled') return false;
  return activation.global !== 'enabled'
    && activation.workspace !== 'enabled'
    && activation.managed !== 'enabled';
}

function pluginKindToResolved(kind: PluginProjectionCandidate['kind']): ResolvedCapabilityKind {
  if (kind === 'unsupported-runtime') return 'asset';
  return kind;
}

function missingRequiredEnvironmentNames(
  candidate: PluginProjectionCandidate,
  inputs: CapabilityResolutionInputs,
): string[] {
  if (candidate.runtimeDefinition?.kind !== 'mcp') return [];
  const descriptor = candidate.runtimeDefinition.mcp;
  const pluginRuntime = inputs.pluginRuntimeContextFor?.(candidate.pluginInstanceId);
  const pluginEnvironment = pluginRuntime
    ? pluginRuntimeEnvForProfile(pluginRuntime.profile, {
        bundleRoot: pluginRuntime.rootPath,
        dataPath: pluginRuntime.dataPath,
        ...(pluginRuntime.projectPath ? { projectPath: pluginRuntime.projectPath } : {}),
      })
    : {};
  const forwardedNames = new Set([
    ...Object.keys(descriptor.env ?? {}),
    ...Object.keys(descriptor.environmentDefaults ?? {}),
    ...(descriptor.requiredEnvironmentNames ?? []),
  ]);
  const forwardedEnvironment = Object.fromEntries(
    [...forwardedNames, ...Object.keys(descriptor.environmentSources ?? {})]
      .map(name => [name, descriptor.environmentSources?.[name] ?? name] as const)
      .filter(([, sourceName]) => inputs.isEnvironmentVariableAvailable?.(sourceName))
      // Values never enter resolution; a non-empty sentinel models only the
      // exact name availability used later by runtime materialization.
      .map(([name]) => [name, 'available'] as const),
  );
  const configuredEnvironment = Object.fromEntries(
    Object.keys(inputs.credentialRefsFor?.(candidate.key) ?? {})
      .map(name => [name, 'available'] as const),
  );
  // Same authority `runtime-pool-servers` materializes with. This used to be a
  // local `${VAR}`-only regex over a differently ordered base environment, so
  // the precompute and the runtime decided over different strings: a
  // `${TOKEN:-}` reference did not match the local pattern at all, stayed
  // non-empty, and reported AVAILABLE for a server the runtime then withheld.
  return materializeMcpDescriptorEnvironment(descriptor, {
    plugin: pluginEnvironment,
    forwarded: forwardedEnvironment,
    configured: configuredEnvironment,
  }).missingRequiredNames.sort();
}

export interface CreateCapabilityResolverOptions {
  inputs: CapabilityResolutionInputProvider;
  /** Optional external invalidation sink (e.g. the catalog-changed emitter). */
  onInvalidate?: (event: {
    scope: CapabilityInvalidationScope;
    reason: string;
    effect: CapabilityInvalidationEffectKind;
    revokedLeaseIds: string[];
  }) => void;
}

export function createCapabilityResolver(options: CreateCapabilityResolverOptions): CapabilityResolver {
  const leases = new Map<string, LeaseRecord>();

  async function resolve(context: CapabilityContext): Promise<EffectiveCapabilitySnapshot> {
    const inputs = await options.inputs(context);
    const built = buildEntries(context, inputs);

    leaseCounter += 1;
    const leaseId = `lease-${leaseCounter}`;
    const instances = new Set<PluginInstanceId>(); const pluginKeys = new Set<PluginKey>(); // F1.766 — whose instances they are
    for (const entry of built.entries) {
      if (entry.summary.pluginInstanceId) { instances.add(entry.summary.pluginInstanceId); if (entry.summary.pluginKey) pluginKeys.add(entry.summary.pluginKey); }
    }

    const generation = computeGeneration(context, inputs, built.entries);
    const releaseInstanceLeases: Array<() => void> = [];
    try {
      if (inputs.acquirePluginInstanceLease) {
        for (const instanceId of [...instances].sort()) {
          releaseInstanceLeases.push(inputs.acquirePluginInstanceLease(instanceId));
        }
      }
    } catch (error) {
      for (const release of releaseInstanceLeases.reverse()) release();
      throw error;
    }
    leases.set(leaseId, {
      context,
      generation,
      instances, pluginKeys,
      revoked: false,
      releaseInstanceLeases,
    });

    const mcpConfigSkips = inputs.nativeInventory.mcpConfigSkips ?? [];
    return {
      context,
      generation,
      leaseId,
      entries: built.entries,
      installedPlugins: built.installedPlugins,
      diagnostics: built.diagnostics,
      ...(mcpConfigSkips.length > 0 ? { mcpConfigSkips } : {}),
    };
  }

  function releaseSnapshot(leaseId: string): void {
    const record = leases.get(leaseId);
    if (!record) return;
    leases.delete(leaseId);
    for (const release of record.releaseInstanceLeases.reverse()) release();
  }

  function invalidate(
    scope: CapabilityInvalidationScope,
    reason: string,
    effect: CapabilityInvalidationEffectKind, pluginKey?: PluginKey, // F1.766
  ): void {
    const revokedLeaseIds: string[] = [];
    if (effect === 'revoke-active-snapshot') {
      for (const [leaseId, record] of leases) {
        if (leaseMatchesScope(record, scope) && leaseHoldsPlugin(record, pluginKey)) { // F1.766 — the scope, then the plugin
          record.revoked = true;
          revokedLeaseIds.push(leaseId);
        }
      }
    }
    options.onInvalidate?.({ scope, reason, effect, revokedLeaseIds });
  }

  function isLeaseActive(leaseId: string): boolean {
    const record = leases.get(leaseId);
    return !!record && !record.revoked;
  }

  function referencedInstances(): Set<PluginInstanceId> {
    const all = new Set<PluginInstanceId>();
    for (const record of leases.values()) {
      for (const id of record.instances) all.add(id);
    }
    return all;
  }

  function leaseCount(): number {
    return leases.size;
  }

  return { resolve, releaseSnapshot, invalidate, isLeaseActive, referencedInstances, leaseCount };
}

function leaseMatchesScope(record: LeaseRecord, scope: CapabilityInvalidationScope): boolean {
  const ctx = record.context;
  switch (scope.kind) {
    case 'global':
      return true;
    case 'workspace':
      return ctx.workspaceId === scope.workspaceId;
    case 'project':
      return ctx.workspaceId === scope.workspaceId && (ctx.projectKey === scope.projectKey || (!!ctx.mainCheckoutProjectKey && ctx.mainCheckoutProjectKey === scope.projectKey)); // F1.11 — a worktree answers to its main checkout's project changes too
    case 'project-trust':
      // Whole-project trust fans out to every context with that ProjectKey.
      return ctx.projectKey === scope.projectKey;
    case 'session':
      return ctx.workspaceId === scope.workspaceId && ctx.sessionId === scope.sessionId;
    case 'plugin':
      // A plugin scope revokes any lease (instance membership is resolved by the
      // caller when it emits per-instance); conservatively fail closed here.
      return true;
  }
}

interface BuiltEntries {
  entries: ResolvedCapabilityEntry[];
  installedPlugins: ResolvedInstalledPlugin[];
  diagnostics: CapabilityDiagnostic[];
}

function buildEntries(context: CapabilityContext, inputs: CapabilityResolutionInputs): BuiltEntries {
  const diagnostics: CapabilityDiagnostic[] = [];
  const entries: ResolvedCapabilityEntry[] = [];

  const disabled = new Set(inputs.sessionSelection?.transientlyDisabledKeys ?? []);
  const sessionEnabledSources = inputs.sessionSelection?.enabledSourceKeys
    ? new Set(inputs.sessionSelection.enabledSourceKeys)
    : undefined;
  // Computed once and read twice — by the per-capability gate below and by the
  // installed-plugin view — so a plugin cannot read disabled in one and active in
  // the other.
  const dependencyErrors = resolveActiveDependencyErrors(inputs);

  // ---- Native records ----
  for (const record of inputs.nativeInventory.records) {
    const kind = record.kind as ResolvedCapabilityKind;
    const resource = toNativeResourceRef(record);
    const credentialRef = inputs.credentialRefFor?.(record.key);
    const credentialStatus = credentialRef && inputs.resolveCredentialStatus
      ? inputs.resolveCredentialStatus(credentialRef)
      : undefined;
    const credential = credentialRef && inputs.bindCredential
      ? inputs.bindCredential(credentialRef)
      : undefined;

    let enabled = record.sourceEnabled !== false;
    let unavailableReason: string | undefined;
    // P3.218 — a managed denial and a user's own OFF are the same flag and not
    // the same fact. The distinct code is what lets the renderer translate the
    // difference; `source-disabled` stays the default, so nothing that was not
    // stamped by the managed-MCP fold moves.
    if (!enabled) unavailableReason = record.managedDenied ? 'managed-denied' : 'source-disabled';
    // Session Source selection: when a session provides an explicit enabled set,
    // a Source not in it is disabled for that session (transient). This gate is
    // deliberately folder/API sources ONLY — MCP (native `.mcp.json` records
    // with `kind === 'mcp'`, plugin connectors, AND source-transport MCP
    // configs carrying `sourceType: 'mcp'`) is EXEMPT from session selection
    // and governed by plugin/config activation alone (R3 contract: analogous
    // to Codex/Claude). The composer picker likewise excludes ALL of those
    // (`capability-catalog.ts:isComposerSelectableSourceRow`), so there is no
    // per-session MCP toggle: an activated MCP server stays available in a
    // session regardless of its folder/API selection set. Without the
    // `sourceType !== 'mcp'` carve-out an MCP-transport source config was
    // impossible to activate at all: the picker never offered it, so every
    // session selection set excluded it → permanently 'session-not-selected'
    // (live-audit finding 2026-07-20). Do NOT widen this condition to
    // `kind === 'mcp'` without changing that decided contract.
    if (record.kind === 'source' && record.sourceType !== 'mcp'
      && sessionEnabledSources && !sessionEnabledSources.has(record.key)) {
      enabled = false;
      unavailableReason = 'session-not-selected';
    }
    if (disabled.has(record.key)) {
      enabled = false;
      unavailableReason = 'session-disabled';
    }
    // Q7 — an agent must not read `active` on a runtime that registers none.
    // The gate reads the SAME constant `SessionManager` uses to decide whether
    // to materialize definitions at all, so the catalog cannot promise a
    // dispatch the session path is not performing.
    if (kind === 'agent' && !runtimeDispatchesAgentDefinitions(context.provider)) {
      enabled = false;
      unavailableReason = 'unsupported-runtime';
    }
    // P6.551 — the twin of the plugin loop's P6.129 gate, for a FILE-based
    // agent. Codex registers agents and then denies, by name, any role
    // declaring a tool grant; the catalog kept reading `active` for a native
    // definition beside a notice saying it "cannot be spawned in this session".
    // `agentDeclaresToolGrant` is set by the inventory scan, which was already
    // parsing the frontmatter — see {@link codexDeclinesAgentToolGrant}, which
    // is the ONE place the writer's condition lives for both halves. The
    // synthesized descriptor carries a marker array rather than the declared
    // list because the predicate tests presence, and the record deliberately
    // does not carry the names.
    if (kind === 'agent' && record.agentDeclaresToolGrant
      && codexDeclinesAgentToolGrant(context.provider, { tools: [] })) {
      enabled = false;
      unavailableReason = 'unsupported-runtime';
    }

    let trustState: CapabilityTrustState = 'not-required';
    if (record.kind === 'hook' && record.scope.kind === 'project') {
      trustState = inputs.resolveTrust({
        capabilityId: record.key,
        executableHash: record.contentHash,
        scope: record.scope,
      });
      if (trustState !== 'trusted') {
        enabled = false;
        unavailableReason = 'review-required';
      }
    }
    const credentialState: CredentialAvailabilityState = credentialStatus?.state ?? 'not-required';
    if (trustState !== 'review-required' && trustState !== 'blocked'
      && (credentialState === 'missing' || credentialState === 'expired')) {
      enabled = false;
      unavailableReason = credentialState === 'expired' ? 'credential-expired' : 'credential-missing';
    }

    entries.push({
      summary: {
        key: record.key,
        kind,
        logicalName: record.logicalName,
        ...(record.sourceType ? { sourceType: record.sourceType } : {}),
        // C6: safe transport for the unified MCP panel, taken/derived from the
        // pinned server identity (never the URL/command values themselves).
        ...(record.mcpServerIdentity
          ? {
              mcpTransport: record.mcpServerIdentity.transport
                ?? (record.mcpServerIdentity.command ? 'stdio' as const : 'http' as const),
              // T4: the raw identity itself, server-only — see the field doc
              // on `ResolvedCapability.mcpServerIdentity`.
              mcpServerIdentity: record.mcpServerIdentity,
            }
          : {}),
        ...(record.displayName ? { displayName: record.displayName } : {}),
        ...(record.description ? { description: record.description } : {}),
        ...(record.skillAlwaysAllow ? { skillAlwaysAllow: record.skillAlwaysAllow } : {}),
        ...(record.skillDisableModelInvocation === undefined
          ? {}
          : { skillDisableModelInvocation: record.skillDisableModelInvocation }),
        ...(record.skillUserInvocable === undefined ? {} : { skillUserInvocable: record.skillUserInvocable }),
        ...(record.skillOverrideState ? { skillOverrideState: record.skillOverrideState } : {}),
        ...(record.skillTier ? { skillTier: record.skillTier } : {}),
        ...(record.skillDirectoryQualifier
          ? { skillDirectoryQualifier: record.skillDirectoryQualifier }
          : {}),
        ...(record.skillAllowedTools ? { skillAllowedTools: record.skillAllowedTools } : {}),
        ...(record.skillPaths ? { skillPaths: record.skillPaths } : {}),
        ...(record.sourcePermissions ? { sourcePermissions: record.sourcePermissions } : {}),
        ...(record.sourceLastTestStatus ? { lastTestStatus: record.sourceLastTestStatus } : {}),
        ...(record.sourceConnectionError ? { connectionError: record.sourceConnectionError } : {}),
        ...(record.iconResource ? { iconResource: record.iconResource } : {}),
        origin: record.scope.kind === 'builtin' ? (record.managedOrg === true ? 'managed' as const : 'builtin') : 'native', // F1.635 — the org policy's own servers read `managed`, never `builtin`: a built-in is ours, this is the administrator's
        ...(record.sourceTier ? { sourceTier: record.sourceTier } : {}),
        scope: record.scope,
        enabled,
        selectedAsUnqualifiedAlias: false,
        readOnly: !record.mutable,
        trustState,
        credentialState,
        ...(credentialStatus ? { credentialRevision: credentialStatus.revision } : {}),
        ...(unavailableReason ? { unavailableReason } : {}),
        diagnostics: [],
      },
      runtimeBinding: nativeRuntimeBinding(record, resource, credential),
    });
  }

  // ---- Plugin candidates ----
  for (const candidate of inputs.pluginCandidates) {
    const activation = inputs.resolveActivation(
      { pluginKey: candidate.pluginKey, pluginInstanceId: candidate.pluginInstanceId },
      candidate.capabilityId,
    );
    let enabled = activation.enabled;
    let unavailableReason: string | undefined = activation.suppressed ? 'policy-disabled' : undefined;
    const unresolvedAppConnector = candidate.kind === 'app' && !candidate.connector;
    // Per-capability policy override: disables ONLY this capability, with its
    // own reason. Plugin-level suppression stays terminal and wins the reason;
    // an absent map entry means enabled (byte-equivalent when the map is empty).
    if (!activation.suppressed && activation.capabilities[candidate.capabilityId] === false) {
      enabled = false;
      unavailableReason = 'capability-disabled';
    }
    // `plugins/host-marketplace.md#depend-on-and-recommend-other-plugins` — "Claude Code disables the affected plugin
    // until you resolve the error." Every capability of the dependent plugin, not
    // a badge: the whole point is that a bundle whose guard hook lives in a
    // dependency must not activate the rest of itself without it.
    const pluginDependencyErrors = dependencyErrors.get(candidate.pluginKey);
    if (pluginDependencyErrors?.length) {
      enabled = false;
      unavailableReason = pluginDependencyErrors[0]!.code;
    }

    let trustState: CapabilityTrustState = 'not-required';
    // Installed executable capabilities normally inherit trust from installation.
    // Workflows are different: invoking one evaluates arbitrary JavaScript in
    // the orchestration sandbox, so its host-derived exact hash must be granted
    // before the runtime or slash-command registry can see it.
    //
    // The KIND is read off {@link TRUST_GATED_PLUGIN_CAPABILITY_KINDS} rather
    // than spelled here, because the grant endpoint's predicate reads the same
    // list: a capability that can enter `review-required` and a capability the
    // grant RPC will mint a key for are the same set BY CONSTRUCTION, so the
    // state P2.158 measured — gated here, refused there, inert forever — cannot
    // be reached again by adding a kind to one site only.
    if (isTrustGatedPluginCapabilityKind(candidate.kind) && candidate.trust.required) {
      const executableHash = candidate.trust.executableHash;
      if (!executableHash) {
        trustState = 'blocked';
        enabled = false;
        unavailableReason = 'review-required';
      } else {
        trustState = inputs.resolveTrust({
          pluginInstanceId: candidate.pluginInstanceId,
          capabilityId: candidate.capabilityId,
          executableHash,
          scope: candidate.selectedScope,
        });
        if (trustState !== 'trusted') {
          enabled = false;
          unavailableReason = 'review-required';
        }
      }
    }

    // `plugins/components.md#monitors` — for a project-scope plugin, "[Background
    // monitors](#monitors) do not load". It is the one component in that list
    // Claude refuses OUTRIGHT rather than gating behind an approval: an MCP
    // server gets a per-server prompt and an LSP server starts once the
    // workspace is trusted, but a monitor auto-starts an unsandboxed shell
    // command with no per-invocation approval, so a plugin checked into a
    // repository would run shell on every collaborator's machine.
    //
    // Nessy has no bundle that lives in a repository — installs are
    // content-addressed and explicit — so the equivalent exposure is a plugin
    // whose ACTIVATION comes from the repository-resident project layer
    // (`trustedProjectOverlay`). The predicate is therefore "enabled at project
    // scope and nowhere the user owns". It is deliberately one notch stricter
    // than the doc: `resolveScopes` merges the repo overlay with the host-side
    // per-project override into one `project` state, so a user's own
    // project-scoped enable is treated as repository-scoped too. Fail-closed is
    // the right direction for a shell process nobody approves, and widening
    // `ResolvedPluginActivation` to split the two layers is the fix if that ever
    // costs a real user something.
    //
    // Only the command form is refused: a scheduled monitor reads a pinned
    // bundle text resource and spawns nothing.
    if (candidate.kind === 'monitor'
      && candidate.runtimeDefinition?.kind === 'monitor'
      && isCommandMonitorDescriptor(candidate.runtimeDefinition.monitor)
      && isProjectScopeOnlyActivation(inputs.resolvePluginScopeActivation?.({
        pluginKey: candidate.pluginKey,
        pluginInstanceId: candidate.pluginInstanceId,
      }))) {
      enabled = false;
      unavailableReason = 'project-scope-monitor';
    }
    if (candidate.kind === 'unsupported-runtime') {
      enabled = false;
      unavailableReason = 'unsupported-runtime';
    }
    if (unresolvedAppConnector) {
      enabled = false;
      unavailableReason = 'unsupported-runtime';
    }
    if (disabled.has(candidate.key)) {
      enabled = false;
      unavailableReason = 'session-disabled';
    }
    // Q7 — same gate as the native loop above. A plugin-bundled agent is no more
    // dispatchable on a runtime with no registration path than a workspace one.
    if (candidate.kind === 'agent' && !runtimeDispatchesAgentDefinitions(context.provider)) {
      enabled = false;
      unavailableReason = 'unsupported-runtime';
    }
    // P6.129 — the gate above asks whether the RUNTIME registers definitions at
    // all; this one asks whether it can express THIS definition. Codex registers
    // agents (it is in `AGENT_DEFINITION_RUNTIMES`) and then denies, by name, any
    // role declaring a tool grant — so the row above cannot catch it and the
    // catalog kept reading `active` beside a notice saying the opposite.
    //
    // Reuses `unavailableReason: 'unsupported-runtime'` rather than minting a
    // reason code: the renderer already renders it
    // (`plugin-components-groups.ts` → `pluginDetail.componentUnsupportedRuntime`),
    // `isRunnable`/`mayReachRuntimePool` already exclude it, and the sentence it
    // carries — this runtime cannot run this component — is exactly true here.
    // A new code would be a new locale pair and a new renderer branch for a fact
    // the existing one already states.
    //
    // The native loop above carries its TWIN since P6.551 — the file-based
    // grant turned out to be knowable here after all, because the inventory
    // scan was already parsing the frontmatter. Both go through the one
    // predicate, so the writer's condition is mirrored once.
    if (candidate.kind === 'agent'
      && candidate.runtimeDefinition?.kind === 'agent'
      && codexDeclinesAgentToolGrant(context.provider, candidate.runtimeDefinition.agent)) {
      enabled = false;
      unavailableReason = 'unsupported-runtime';
    }
    // T17 — the same promise, for the two peripherals. `getOrCreateAgentUnchecked`
    // provisioned plugin LSP servers and started plugin monitors behind ONE
    // `provider === 'pi'` gate, while this row reported the plugin's language
    // server and its background monitor as `active` anyway.
    // Reads the shared predicate rather than restating `=== 'pi'`, so the
    // catalog and the session path cannot drift apart in the direction that
    // hurt before: the catalog still calling something active after the session
    // path stopped starting it.
    //
    // Deliberately NOT widened to `hook`: a plugin's command hooks run on every
    // runtime (`buildPinnedAgentAutomationSystem` supplies
    // `pluginCommandHookRunner` unconditionally), and only the four non-command
    // ACTION kinds go unwired. A whole-row gate would lie in the other direction.
    //
    // P6.175 — the two kinds are decided by two records now, and the change is
    // not cosmetic: monitors run on all three coding runtimes and language
    // servers on Pi alone, so ONE predicate here would have to lie about one of
    // them. Same reason the constants were split, one package over.
    if (candidate.kind === 'lsp' && !runtimeProvisionsPluginLsp(context.provider)) {
      enabled = false;
      unavailableReason = 'unsupported-runtime';
    }
    if (candidate.kind === 'monitor' && !runtimeRunsPluginMonitors(context.provider)) {
      enabled = false;
      unavailableReason = 'unsupported-runtime';
    }
    // P3.34 — the same promise, for the workflow. `BaseAgent.chat` has refused a
    // `workflowInvocation` off Pi since P2.212 and the `ultracode` keyword has
    // been runtime-gated since P2.315; the CATALOG kept advertising the command
    // anyway, so a user could only ever pick it to be told it is unavailable.
    // That is the `ADVERTISED` shape the two gates above were built to end.
    //
    // Reads the shared predicate rather than restating `=== 'pi'`, so this row
    // and `BaseAgent.canDispatchWorkflowCommands()` cannot answer differently.
    // Disabling here also removes the command from the slash registry:
    // `SessionManager.pluginPromptCommandEntries` filters on `summary.enabled`.
    //
    // Deliberately NOT widened to `prompt-command`: a plugin's prompt command is
    // expanded HOST-side into ordinary prose and needs no orchestrator, so it
    // runs everywhere. A whole-plugin gate would lie in the other direction —
    // the same carve-out the peripheral gate above makes for `hook`.
    if (candidate.kind === 'workflow' && !runtimeDispatchesWorkflows(context.provider)) {
      enabled = false;
      unavailableReason = 'unsupported-runtime';
    }

    const credentialRef = inputs.credentialRefFor?.(candidate.key);
    const credentialStatus = credentialRef && inputs.resolveCredentialStatus
      ? inputs.resolveCredentialStatus(credentialRef)
      : undefined;
    const credential = credentialRef && inputs.bindCredential
      ? inputs.bindCredential(credentialRef)
      : undefined;
    const credentialRefs = inputs.credentialRefsFor?.(candidate.key) ?? {};
    const credentialEnvironment = candidate.runtimeDefinition?.kind === 'mcp' && inputs.bindCredential
      ? Object.fromEntries(Object.entries(credentialRefs).flatMap(([name, ref]) => {
          const binding = inputs.bindCredential?.(ref);
          const configKey = candidate.runtimeDefinition?.kind === 'mcp'
            ? candidate.runtimeDefinition.mcp.credentialEnvironment?.[name]
            : undefined;
          return binding && configKey ? [[name, { configKey, credential: binding }]] : [];
        }))
      : undefined;
    const credentialEnvironmentStatuses = Object.values(credentialRefs).map(ref => (
      inputs.resolveCredentialStatus?.(ref) ?? { state: 'missing' as const, revision: '0' }
    ));
    const configurationMissing = inputs.configurationMissingFor?.(candidate.key) ?? [];
    const credentialState: CredentialAvailabilityState = credentialStatus?.state
      ?? (configurationMissing.length > 0
        ? 'missing'
        : credentialEnvironmentStatuses.some(status => status.state === 'expired')
        ? 'expired'
        : credentialEnvironmentStatuses.some(status => status.state === 'missing')
          ? 'missing'
          : credentialEnvironmentStatuses.length ? 'ready' : 'not-required');
    // C3 (capability-path): a plugin http/sse server with DECLARED endpoint
    // auth (oauth/bearer bound to its global plugin slot) is not parked while
    // its slot is empty — it stays enabled, reaches the pool, and the pool
    // surfaces it through `externalAuthRequirements` (the dp model). The
    // credentialState still reports 'missing'/'expired' for the UI.
    const pluginEndpointAuthDeclared = candidate.runtimeDefinition?.kind === 'mcp'
      && candidate.runtimeDefinition.mcp.transport !== 'stdio'
      && candidate.runtimeDefinition.mcp.authType !== undefined
      // A missing user configuration is still a parking state — the exemption
      // covers only the endpoint's own empty/expired credential slot.
      && configurationMissing.length === 0;
    if ((credentialState === 'missing' || credentialState === 'expired') && !pluginEndpointAuthDeclared) {
      enabled = false;
      unavailableReason = configurationMissing.length > 0 || Object.keys(credentialRefs).length
        ? 'needs_configuration'
        : credentialState === 'expired' ? 'credential-expired' : 'credential-missing';
    }

    // ---- `${user_config.KEY}` (`plugins/manifest-reference.md#environment-variables`) ----
    //
    // Strictly AFTER the trust decisions above: the executable hash is derived
    // in `projection-candidates.ts` from the UNSUBSTITUTED declaration, so a
    // grant survives a rotated token and the hash is never an oracle for the
    // value it would otherwise contain.
    //
    // The values come from the host seam that already reads the credential
    // store; the declared schema on the candidate supplies the original key
    // case the `CLAUDE_PLUGIN_OPTION_<KEY>` spelling uppercased away. No value
    // is read here and none is retained past the substitution.
    const pluginOptionEnvironment = inputs.pluginOptionEnvironmentFor?.(candidate.pluginInstanceId);
    const userConfigFields = candidate.userConfiguration ?? [];
    let runtimeDefinition = candidate.runtimeDefinition;
    let unresolvedUserConfigKeys: string[] = [];
    let unredactedUserConfigKeys: string[] = [];
    if (userConfigFields.length > 0
      && (candidate.kind === 'mcp' || candidate.kind === 'lsp')
      && runtimeDefinition) {
      const substituted = substitutePluginCapabilityUserConfig(
        runtimeDefinition,
        new PluginUserConfigValues(userConfigFields, pluginOptionEnvironment),
      );
      runtimeDefinition = substituted.capability;
      unresolvedUserConfigKeys = substituted.report.unresolved;
      unredactedUserConfigKeys = substituted.report.sensitiveUnredacted;
    }
    // An unset key must NOT start the server. An empty substitution would send
    // `Bearer ` and authenticate as nobody; a literal placeholder would send the
    // string `${user_config.TOKEN}` — both are a 401 at the first tool call with
    // no hint of the cause. Refusing names the field instead, which is the same
    // shape `environment-missing` already takes one branch below, and D15's
    // enable-time prompt is what stops a user reaching this state at all.
    if (unresolvedUserConfigKeys.length > 0) {
      enabled = false;
      unavailableReason = 'user-config-missing';
    }
    const skillUserConfig = candidate.kind === 'skill' && userConfigFields.length > 0
      ? pluginUserConfigContentValues(userConfigFields, pluginOptionEnvironment)
      : undefined;

    const missingEnvironmentNames = enabled
      ? missingRequiredEnvironmentNames(candidate, inputs)
      : [];
    const capabilityDiagnostics: CapabilityDiagnostic[] = [
      // Names the KEYS and never a value — the whole point of the refusal is to
      // tell the user which field to fill in.
      ...(unresolvedUserConfigKeys.length > 0 ? [{
        severity: 'warning' as const,
        code: 'plugin.user_config.unset',
        message: `Plugin configuration is not set: ${unresolvedUserConfigKeys.join(', ')}.`,
        safeArgs: { keys: unresolvedUserConfigKeys.join(', ') },
        capabilityKey: candidate.key,
      }] : []),
      // Substituted, not refused — `:577` places no restriction on WHICH field
      // takes a sensitive value. What the author is told is that this one is
      // outside the pool's result-redaction set (`headers` and `env` only), so
      // a server that echoes its own argv will echo the token.
      ...(unredactedUserConfigKeys.length > 0 ? [{
        severity: 'warning' as const,
        code: 'plugin.user_config.unredacted_sink',
        message: 'Plugin configuration is substituted into a command, argument, working directory'
          + ` or URL, which tool-result redaction does not cover: ${unredactedUserConfigKeys.join(', ')}.`
          + ' Prefer the server\'s env or headers block for a secret.',
        safeArgs: { keys: unredactedUserConfigKeys.join(', ') },
        capabilityKey: candidate.key,
      }] : []),
      ...(unresolvedAppConnector ? [{
        severity: 'warning' as const,
        code: 'plugin.app.connector_unresolved',
        message: 'Plugin app has no matching connector metadata and cannot be activated.',
        capabilityKey: candidate.key,
      }] : []),
      ...(missingEnvironmentNames.length > 0 ? [{
        severity: 'warning' as const,
        code: 'plugin.mcp.required_environment_missing',
        message: `Required environment variables are not configured: ${missingEnvironmentNames.join(', ')}.`,
        safeArgs: { names: missingEnvironmentNames.join(', ') },
        capabilityKey: candidate.key,
      }] : []),
      // `:208` — the problems surface "as descriptive error messages rather than
      // the literal codes in this table", with `:212`'s remedy named.
      ...(pluginDependencyErrors?.length ? [{
        severity: 'warning' as const,
        code: `plugin.dependency.${pluginDependencyErrors[0]!.code.replace(/-/g, '_')}`,
        message: describePluginDependencyError(pluginDependencyErrors[0]!),
        safeArgs: { dependency: pluginDependencyErrors[0]!.dependency },
        capabilityKey: candidate.key,
      }] : []),
    ];
    if (missingEnvironmentNames.length > 0) {
      enabled = false;
      unavailableReason = 'environment-missing';
    }
    diagnostics.push(...capabilityDiagnostics);

    const pluginRuntime = inputs.pluginRuntimeContextFor?.(candidate.pluginInstanceId);

    entries.push({
      summary: {
        key: candidate.key,
        kind: pluginKindToResolved(candidate.kind),
        ...(candidate.componentKind
          ? { componentKind: pluginKindToResolved(candidate.componentKind) }
          : {}),
        logicalName: candidate.logicalName,
        ...(candidate.displayName ? { displayName: candidate.displayName } : {}),
        ...(candidate.description ? { description: candidate.description } : {}),
        ...(candidate.runtimeDefinition?.kind === 'mcp'
          ? { mcpTransport: candidate.runtimeDefinition.mcp.transport }
          : {}),
        // A plugin skill's author-declared invocation restrictions, pinned by the
        // bundle hash in `runtimeDefinition`. The native branch above carries the
        // same two fields; without them here the model-invocation refusal reads
        // `undefined` for every plugin skill and never fires.
        ...pluginSkillInvocationControls(candidate),
        origin: 'plugin',
        scope: candidate.selectedScope,
        pluginKey: candidate.pluginKey,
        pluginInstanceId: candidate.pluginInstanceId,
        capabilityId: candidate.capabilityId,
        enabled,
        selectedAsUnqualifiedAlias: false,
        readOnly: true,
        trustState,
        credentialState,
        ...(credentialStatus ? { credentialRevision: credentialStatus.revision } : {}),
        ...(unavailableReason ? { unavailableReason } : {}),
        ...(candidate.runtimeDefinition?.kind === 'unsupported'
          ? { unsupportedReasonCode: candidate.runtimeDefinition.unsupported.reasonCode }
          : {}),
        diagnostics: capabilityDiagnostics,
      },
      runtimeBinding: pluginRuntimeBinding(
        // The MCP/LSP declaration with `${user_config.KEY}` already resolved.
        // Identical by reference when nothing referenced a placeholder.
        runtimeDefinition === candidate.runtimeDefinition
          ? candidate
          : { ...candidate, ...(runtimeDefinition ? { runtimeDefinition } : {}) },
        pluginRuntime,
        credential,
        credentialEnvironment,
        // Hook capabilities only — `:577` exports to hook PROCESSES, and every
        // other candidate kind ignores the argument.
        candidate.kind === 'hook' ? pluginOptionEnvironment : undefined,
        skillUserConfig,
      ),
    });
  }

  // `mcp.md:457`: "Plugins and connectors match by endpoint" — our stdio
  // endpoint identity for the builtin set is the `dp ai mcp <sub>` argv tail.
  // An ENABLED builtin wins; the plugin copy is an activation-level duplicate
  // (bundles are immutable and hash-verified, so this is `enabled: false` + a
  // reason, never a bundle mutation). Runs BEFORE `applyCollisionPolicy` so the
  // disabled state and diagnostic are settled before that pass reads `enabled`,
  // and before the T3 skill/agent translation pass right after it.
  const enabledBuiltinSubcommands = new Map<string, string>();
  for (const entry of entries) {
    if (entry.summary.kind !== 'mcp' || entry.summary.origin !== 'builtin' || !entry.summary.enabled) continue;
    const command = entry.summary.mcpServerIdentity?.command;
    if (command && command[1] === 'ai' && command[2] === 'mcp' && command[3]) {
      enabledBuiltinSubcommands.set(command[3], entry.summary.logicalName);
    }
  }
  if (enabledBuiltinSubcommands.size) {
    for (const entry of entries) {
      if (entry.summary.origin !== 'plugin' || entry.summary.kind !== 'mcp' || !entry.summary.enabled) continue;
      const definition = entry.runtimeBinding.kind === 'mcp' ? entry.runtimeBinding.server.definition : undefined;
      if (definition?.type !== 'stdio' || !definition.args || definition.args.length < 3) continue;
      const tail = definition.args.slice(-3);
      if (tail[0] !== 'ai' || tail[1] !== 'mcp') continue;
      const builtinName = enabledBuiltinSubcommands.get(tail[2]!);
      if (!builtinName) continue;
      entry.summary.enabled = false;
      entry.summary.unavailableReason = 'duplicates-builtin';
      const inertComponents = entry.summary.pluginInstanceId
        ? inertPluginComponentNames(entries, entry.summary.pluginInstanceId, entry.summary.logicalName)
        : [];
      diagnostics.push({
        severity: 'info',
        code: 'capability.dedup.builtin-identity',
        message: `Plugin MCP server "${entry.summary.logicalName}" duplicates the enabled built-in "${builtinName}" and was not started`,
        capabilityKey: entry.summary.key,
        ...(inertComponents.length ? { safeArgs: { inertComponents: inertComponents.join(', ') } } : {}),
      });
    }
  }

  // T4b — `mcp.md:457` (second half): "Plugins and connectors match by
  // endpoint" — plugin-vs-plugin only; T4 just above settles builtin-vs-plugin.
  // Scoped/native entries do NOT participate (review finding, Fix 3,
  // 2026-08-10): see the comment on `declaredEndpointIdentity` for why folding
  // them in would risk the false-positive direction this pass exists to
  // avoid. Among plugin entries sharing one DECLARED endpoint identity, the
  // lexically-smallest `summary.key` wins — deterministic, so the choice is
  // stable across resolves regardless of `entries` array order. Runs in the
  // same loop, still before `applyCollisionPolicy`, and only entries T4 left
  // ENABLED participate, so a reason T4 already set is never re-decided.
  const endpointGroups = new Map<string, ResolvedCapabilityEntry[]>();
  for (const entry of entries) {
    if (entry.summary.kind !== 'mcp' || entry.summary.origin !== 'plugin' || !entry.summary.enabled) continue;
    const identity = declaredEndpointIdentity(entry);
    if (!identity) continue;
    (endpointGroups.get(identity) ?? endpointGroups.set(identity, []).get(identity)!).push(entry);
  }
  for (const group of endpointGroups.values()) {
    if (group.length < 2) continue; // a lone entry has nothing to dedup against
    const byKeyAscending = (a: ResolvedCapabilityEntry, b: ResolvedCapabilityEntry) => a.summary.key.localeCompare(b.summary.key);
    const winner = [...group].sort(byKeyAscending)[0]!;
    for (const entry of group) {
      if (entry === winner) continue;
      entry.summary.enabled = false;
      entry.summary.unavailableReason = 'duplicates-endpoint';
      const inertComponents = entry.summary.pluginInstanceId
        ? inertPluginComponentNames(entries, entry.summary.pluginInstanceId, entry.summary.logicalName)
        : [];
      diagnostics.push({
        severity: 'info',
        code: 'capability.dedup.endpoint-identity',
        message: `Plugin MCP server "${entry.summary.logicalName}" duplicates the endpoint already served by "${winner.summary.logicalName}" and was not started`,
        capabilityKey: entry.summary.key,
        ...(inertComponents.length ? { safeArgs: { inertComponents: inertComponents.join(', ') } } : {}),
      });
    }
  }

  applyCollisionPolicy(entries, diagnostics);
  // F3 net: after the mint above, say so out loud if any runnable MCP entry's
  // wire name still cannot parse (see the function doc — this should be
  // unreachable through this resolver's own inputs).
  diagnoseUnusableMcpWireNames(entries, diagnostics);

  // Plugin skills' `allowed-tools` and plugin hooks' `mcpTool` may reference
  // the plugin's own bundled servers by bare name; qualify both to the wire
  // names minted above. This pass is the LOAD-BEARING translation for both —
  // in particular for hooks. It used to have a lookalike twin in
  // `projection.ts`, whose only production caller was the legacy V1
  // `install-service.ts` path; F1's live verification (2026-08-10/11) found the
  // translation attached to that dead road, and F4 deleted both files. This is
  // now the only such pass (see the F2–F4 plan's Deviations log).
  const ownMcpNamesByInstance = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.summary.origin !== 'plugin' || entry.summary.kind !== 'mcp' || !entry.summary.pluginInstanceId) continue;
    const set = ownMcpNamesByInstance.get(entry.summary.pluginInstanceId) ?? new Set<string>();
    set.add(entry.summary.logicalName);
    ownMcpNamesByInstance.set(entry.summary.pluginInstanceId, set);
  }
  for (const entry of entries) {
    if (entry.summary.origin !== 'plugin' || !entry.summary.pluginInstanceId) continue;
    const own = ownMcpNamesByInstance.get(entry.summary.pluginInstanceId);
    const pluginId = pluginIdFromInstanceId(entry.summary.pluginInstanceId);
    if (!own?.size || !pluginId) continue;
    if (entry.summary.skillAllowedTools?.length) {
      entry.summary.skillAllowedTools = entry.summary.skillAllowedTools.map(pattern => {
        // THREE accepted shapes, not two. `sub-agents.md` § *Available tools*:
        // "Both fields accept MCP server-level patterns in addition to exact
        // tool names: `mcp__<server>` or `mcp__<server>__*` grants or removes
        // every tool from the named server." P6.556 — the wildcard and the exact
        // form were qualified here and the BARE server-level form was not, so a
        // plugin skill naming its own bundled server without a tool was left
        // pointing at a logical name no wire carries.
        const wildcard = /^mcp__([A-Za-z0-9_-]+)__\*$/.exec(pattern);
        if (wildcard && own.has(wildcard[1]!)) return `mcp__${pluginMcpWireName(pluginId, wildcard[1]!)}__*`;
        // The exact form is tried BEFORE the bare one and its result wins,
        // because a server logical name may itself contain `__`: `mcp__a__b` is
        // then ambiguous between server `a` tool `b` and bare server `a__b`, and
        // the two-segment reading is the one the page writes out.
        const translated = translatePluginMcpToolName(pattern, pluginId, own);
        if (translated !== pattern) return translated;
        const bare = /^mcp__([A-Za-z0-9_-]+)$/.exec(pattern);
        if (bare && own.has(bare[1]!)) return `mcp__${pluginMcpWireName(pluginId, bare[1]!)}`;
        // A name that is not one of this plugin's own servers is left exactly as
        // written, like both siblings above: it may be a foreign server the
        // session already configured, and a diagnostic here would fire for a
        // reference that resolves fine.
        return pattern;
      });
    }
    if (entry.runtimeBinding.kind === 'hook' && entry.runtimeBinding.hook.mcpTool) {
      entry.runtimeBinding.hook.mcpTool = translatePluginMcpToolName(entry.runtimeBinding.hook.mcpTool, pluginId, own);
    }
  }

  // ---- Blocked layers → path-free diagnostics ----
  for (const layer of inputs.nativeInventory.blockedLayers) {
    diagnostics.push(blockedLayerDiagnostic(layer));
  }

  // ---- Instruction/memory layers a bound dropped → ONE counted diagnostic PER BOUND ----
  // Split by reason rather than counted together (P6.389): the ancestor cap is
  // ours and the 4 MiB skip is the page's, so one sentence for both would state
  // our invention as the vendor's rule for half its members.
  const droppedLayers = inputs.nativeInventory.droppedInstructionLayers ?? [];
  const cappedAncestors = droppedLayers.filter(layer => layer.reason === 'ancestor-layer-cap');
  if (cappedAncestors.length > 0) {
    diagnostics.push(droppedInstructionLayerDiagnostic(cappedAncestors));
  }
  const oversizeLayers = droppedLayers.filter(layer => layer.reason === 'over-size-limit');
  if (oversizeLayers.length > 0) {
    diagnostics.push(oversizeInstructionLayerDiagnostic(oversizeLayers));
  }

  // ---- `@path` imports refused for leaving the project → ONE counted diagnostic ----
  const refusedProjectImports = inputs.nativeInventory.refusedProjectImports ?? [];
  if (refusedProjectImports.length > 0) {
    diagnostics.push(refusedProjectImportDiagnostic(refusedProjectImports));
  }

  const installedPlugins = buildInstalledPlugins(inputs, dependencyErrors);

  return { entries, installedPlugins, diagnostics };
}

/**
 * The `@path` imports the containment boundary refused (P6.387).
 *
 * Same shape and same reasons as {@link droppedInstructionLayerDiagnostic}
 * above: `warning` because the author wrote the line expecting it to load; ONE
 * for the whole set because a single index can hold a dozen; path-free because
 * that is this channel's contract, with the absolute paths and their importers
 * on the inventory's own `refusedProjectImports`.
 *
 * NOT an error, and the wording must not suggest a repair the user cannot make
 * from here: the refusal is deliberate, and lifting it needs a per-file
 * approval the host does not yet have.
 */
function refusedProjectImportDiagnostic(
  refused: readonly OutsideProjectImport[],
): CapabilityDiagnostic {
  return {
    severity: 'warning',
    code: 'capability.instruction.importOutsideProject',
    message: `${refused.length} @path import(s) were not loaded: they resolve outside the project, and instructions from outside a project are not read into it`,
    safeArgs: { refusedCount: String(refused.length) },
  };
}

/**
 * The ancestor instruction files `MAX_INSTRUCTION_ANCESTOR_LAYERS` dropped
 * (P6.388).
 *
 * `warning`, not `info`: the user wrote those files expecting them to apply,
 * and until this existed the cap was a bare `break` that told nobody. One
 * diagnostic for the whole set rather than one each — a deep monorepo can drop
 * a dozen, and twelve identical warnings are noise.
 *
 * Path-free, because that is this channel's contract ("Explicit path-free
 * renderer interpolation values"). The COUNT and the cap travel in `safeArgs`;
 * the absolute paths stay on the inventory's own
 * `droppedInstructionLayers`, beside every other `sourcePath`, for a surface
 * that is allowed to show them.
 */
/**
 * The instruction or memory files skipped for being over 4 MiB (P6.389).
 *
 * `warning` and one-for-the-set, for the two reasons its siblings give. What is
 * different is the WORD: *skipped*, never *truncated*. The page's rule is
 * all-or-nothing — "Claude Code loads a CLAUDE.md file of up to 4 MiB in full
 * and skips a larger file" — and a message that said "shortened" would send the
 * user looking for the part that arrived, of which there is none.
 *
 * The limit travels in MiB because that is the unit the page states it in, and
 * a reader comparing a number in a warning against a number in the docs must
 * not have to convert.
 */
function oversizeInstructionLayerDiagnostic(
  dropped: readonly DroppedInstructionLayer[],
): CapabilityDiagnostic {
  const limitMiB = Math.round((dropped[0]?.limit ?? 0) / (1024 * 1024));
  return {
    severity: 'warning',
    code: 'capability.instruction.overSizeLimit',
    message: `${dropped.length} instruction or memory file(s) were not loaded: each is larger than ${limitMiB} MiB, and an oversized file is skipped whole rather than loaded in part`,
    safeArgs: { droppedCount: String(dropped.length), limitMiB: String(limitMiB) },
  };
}

function droppedInstructionLayerDiagnostic(
  dropped: readonly DroppedInstructionLayer[],
): CapabilityDiagnostic {
  const limit = dropped[0]?.limit ?? 0;
  return {
    severity: 'warning',
    code: 'capability.instruction.ancestorLayerCap',
    message: `${dropped.length} ancestor instruction file(s) were not loaded: the walk keeps at most ${limit} ancestor layers, counted from the project root down`,
    safeArgs: { droppedCount: String(dropped.length), limit: String(limit) },
  };
}

function blockedLayerDiagnostic(layer: BlockedCapabilityLayer): CapabilityDiagnostic {
  return {
    severity: 'info',
    code: `capability.blocked.${layer.reason}`,
    message: `Withheld ${layer.withheldKinds.join(', ')} from an untrusted project`,
  };
}

/**
 * F2: `kind:name` strings for the plugin's OWN hooks and skills that
 * reference `serverLogicalName` — the server T4/T4b is about to stand down.
 * Attached to the dedup diagnostic as `safeArgs.inertComponents` so a
 * stood-down server also says what went quiet with it, instead of a bare
 * "duplicate" reason and nothing else.
 *
 * Runs BEFORE the T3 translation pass a few lines down, so a hook's
 * `mcpTool` and a skill's `allowed-tools` pattern are still whatever the
 * plugin declared — almost always the bare logical name, but a content
 * author could already have written the fully-qualified minted wire form, so
 * both are matched.
 *
 * Agents are deliberately OUT of scope: an agent's `mcpServers:` list is
 * resolved later, in `runtime-agent-definition.ts`, and never rides
 * `ResolvedCapability` — reaching it from here would need new plumbing this
 * task does not add (`2026-08-11-mcp-followups-f2-f4.md`, Task 1).
 */
function inertPluginComponentNames(
  entries: ResolvedCapabilityEntry[],
  pluginInstanceId: PluginInstanceId,
  serverLogicalName: string,
): string[] {
  const pluginId = pluginIdFromInstanceId(pluginInstanceId);
  const wireName = pluginId ? pluginMcpWireName(pluginId, serverLogicalName) : undefined;
  const matchesServer = (name: string) => name === serverLogicalName || name === wireName;
  const components: string[] = [];
  for (const entry of entries) {
    if (entry.summary.pluginInstanceId !== pluginInstanceId) continue;
    if (entry.runtimeBinding.kind === 'hook' && entry.runtimeBinding.hook.mcpTool) {
      const parsed = tryParsePiDynamicMcpBindingName(entry.runtimeBinding.hook.mcpTool);
      if (parsed && matchesServer(parsed.wireName)) {
        components.push(`hook:${entry.summary.logicalName}`);
      }
    }
    if (entry.summary.skillAllowedTools?.some(pattern => {
      // Same THREE accepted shapes as the T3 translation pass below and
      // `pi-agent.ts`'s own alias expansion: a wildcard needs its own regex
      // (the manifest parser's `$`-anchored pattern never matches a
      // trailing `__*`), an exact reference reuses the manifest parser, and the
      // bare server-level form (`sub-agents.md` § *Available tools*) matches
      // neither. P6.556 added the third to both passes at once — a skill this
      // one failed to name would go quiet with the stood-down server while the
      // dedup diagnostic said nothing had.
      const wildcard = /^mcp__([A-Za-z0-9_-]+)__\*$/.exec(pattern);
      const bare = /^mcp__([A-Za-z0-9_-]+)$/.exec(pattern);
      const name = wildcard
        ? wildcard[1]
        : tryParsePiDynamicMcpBindingName(pattern)?.wireName ?? bare?.[1];
      return !!name && matchesServer(name);
    })) {
      components.push(`skill:${entry.summary.logicalName}`);
    }
  }
  // A plugin can legally declare two hooks against the same event, so
  // `logicalName` is not guaranteed unique per entry — dedupe before joining
  // so a repeated reference reads as one name, not a stutter.
  return [...new Set(components)].sort();
}

/**
 * Qualify collisions. Keys are already unique.
 * - non-MCP: every duplicate is retained; choose ONE unqualified alias per
 *   (kind, logicalName) by {@link aliasScopeRank}, then native > plugin, then
 *   stable lexical key; mark it and diagnose the collision;
 * - SKILLS are the one kind whose scope chain is inverted, and the inversion is
 *   documented twice. `features-overview.md:193`: "**Skills and subagents**
 *   override by name: when the same name exists at multiple levels, one
 *   definition wins based on priority (managed > user > project for skills;
 *   managed > CLI flag > project > user > plugin for subagents). Plugin skills
 *   are namespaced to avoid conflicts." `skills.md:122`: "When skills share the
 *   same name across levels, enterprise overrides personal, and personal
 *   overrides project. A skill at any of these levels also overrides a bundled
 *   skill with the same name. … Plugin skills use a `plugin-name:skill-name`
 *   namespace, so they cannot conflict with other levels." All of it lives in
 *   {@link aliasScopeRank}: the administrator tier over personal, personal over
 *   project, a SEEDED BUNDLED skill (`skillTier: 'bundled'`) below `project` so
 *   the bundled clause survives this fork's seed-into-the-personal-root design,
 *   and plugin skills out of contention at every scope. **The `managed >` head
 *   of that chain used to be an absence and no longer is:** P2.449 gave the fork
 *   a machine-wide administrator scope for skills (`builtin`, from
 *   `native-sources.ts`'s admin roots), so the head is now an ordering this
 *   function implements rather than a tier we lack.
 * - NESTED skills (R79) sit one term below that whole chain: a record carrying
 *   `skillDirectoryQualifier` loses the bare name to any same-rank sibling, so
 *   `skills.md:132`'s "Typing `/deploy` runs the project-root skill" holds. Both
 *   stay retained (`:126`, "both stay available") and the nested one is reachable
 *   as `apps/web:deploy` through `views.ts` → the `/` menu and the model listing.
 * - MCP: scope duplicates are NOT retained. "When the same server is defined in
 *   more than one place, Claude Code connects to it once, using the definition
 *   from the highest-precedence source. The entire server entry from that source
 *   is used; fields are not merged across scopes" (`mcp.md:431`), matched by
 *   name across the scope tiers (`mcp.md:439`). The shadowed definitions stay
 *   addressable in the catalog with a reason, but never reach the runtime view.
 * - Plugin MCP is exempt from that name match: Claude registers a plugin server
 *   under the scoped name `plugin:<plugin-name>:<server-name>` (`mcp.md:365`)
 *   ALWAYS — contested or not — so it can never take, move, or break a scoped
 *   server's bare name, and duplicate detection for plugins is by endpoint
 *   rather than by name (`mcp.md:439`). Our equivalent is the stable
 *   `plugin_<pluginId>_<serverName>` wire name minted in `mcp-wire-name.ts`, a
 *   pure function of plugin identity: a plugin entry is never suppressed and
 *   its wire name never depends on what else is installed.
 */
function applyCollisionPolicy(entries: ResolvedCapabilityEntry[], diagnostics: CapabilityDiagnostic[]): void {
  const byNonMcp = new Map<string, ResolvedCapabilityEntry[]>();
  const byMcp = new Map<string, ResolvedCapabilityEntry[]>();

  for (const entry of entries) {
    const s = entry.summary;
    const bucket = `${s.kind}\u0000${s.logicalName}`;
    if (s.kind === 'mcp') {
      (byMcp.get(bucket) ?? byMcp.set(bucket, []).get(bucket)!).push(entry);
    } else {
      (byNonMcp.get(bucket) ?? byNonMcp.set(bucket, []).get(bucket)!).push(entry);
      // A workspace Source whose transport is MCP participates in BOTH the
      // Source mention namespace and the one runtime MCP wire namespace.
      if (s.kind === 'source' && s.sourceType === 'mcp') {
        const mcpBucket = `mcp\u0000${s.logicalName}`;
        (byMcp.get(mcpBucket) ?? byMcp.set(mcpBucket, []).get(mcpBucket)!).push(entry);
      }
    }
  }

  // Same-scope tier: Nessy-native (.nessy-agent/managed) > portable compat
  // (.agents/*, .mcp.json, root files) > plugin presentation aliases. Untagged
  // native records keep the historical native-over-plugin preference.
  const tierRank = (entry: ResolvedCapabilityEntry): number => {
    if (entry.summary.origin === 'plugin') return 0;
    return entry.summary.sourceTier === 'portable' ? 1 : 2;
  };
  // R79 — a NESTED skill yields the bare name to a same-rank sibling.
  // `skills.md:132`: "Typing `/deploy` runs the project-root skill. Type the
  // qualified name `/apps/web:deploy` to run the nested variant explicitly."
  // A nested record and the project-root record it shadows share a scope, a
  // tier and everything else `preference` looks at, so without this term the
  // winner would fall through to the lexical key — an accident, not a rule.
  //
  // BELOW `aliasScopeRank`, not above it, and that is the same judgment R78
  // made for the bundled tier: an UNCONTESTED nested skill is the only member
  // of its bucket and still wins its own short name (`skills.md:126`'s "both
  // stay available" describes a CLASH, not the lone case). Only a skill that
  // actually claims the name takes it. Non-skill kinds never carry the field,
  // so this term is a constant 1 for them and the MCP/agent/command orders do
  // not move.
  const nestedSkillRank = (entry: ResolvedCapabilityEntry): number =>
    entry.summary.skillDirectoryQualifier ? 0 : 1;
  const preference = (entry: ResolvedCapabilityEntry): [number, number, number, string] => [
    aliasScopeRank(entry.summary),
    nestedSkillRank(entry),
    tierRank(entry),
    entry.summary.key,
  ];
  // Shared by both loops below (the non-MCP alias pick and the MCP scoped
  // tier): higher rank first, then `preference`'s own tiebreak order —
  // nearest scope (or personal-over-project for skills; see `aliasScopeRank`),
  // root skill over nested skill, nessy over portable/plugin, and finally a
  // stable lexical key.
  const sortByPreferenceDesc = (group: ResolvedCapabilityEntry[]): ResolvedCapabilityEntry[] =>
    [...group].sort((a, b) => {
      const pa = preference(a);
      const pb = preference(b);
      if (pa[0] !== pb[0]) return pb[0] - pa[0];
      if (pa[1] !== pb[1]) return pb[1] - pa[1];
      if (pa[2] !== pb[2]) return pb[2] - pa[2];
      return pa[3] < pb[3] ? -1 : pa[3] > pb[3] ? 1 : 0;
    });

  for (const [bucket, group] of byNonMcp) {
    const sorted = sortByPreferenceDesc(group);
    const winner = sorted[0];
    if (winner) winner.summary.selectedAsUnqualifiedAlias = true;
    if (group.length > 1) {
      const [, logicalName] = bucket.split('\u0000');
      diagnostics.push({
        severity: 'info',
        code: 'capability.collision.unqualified-alias',
        message: `Multiple "${logicalName}" resolved; qualified keys remain distinct`,
        capabilityKey: winner?.summary.key,
      });
    }
  }

  for (const [bucket, group] of byMcp) {
    const [, bucketName] = bucket.split('\u0000');
    const logicalName = bucketName ?? group[0]!.summary.logicalName;

    const scoped = group.filter(entry => entry.summary.origin !== 'plugin');
    const plugins = group.filter(entry => entry.summary.origin === 'plugin');

    // Scoped tier: one winner keeps the bare name; the rest are shadowed —
    // `mcp.md:449` "connects to it once, using the definition from the
    // highest-precedence source". UNCHANGED except the winner no longer
    // yields the bare name to plugin contention.
    if (scoped.length) {
      const sorted = sortByPreferenceDesc(scoped);
      const winner = sorted[0]!;
      winner.summary.selectedAsUnqualifiedAlias = true;
      // Every wire name minted in this branch is SANITIZED then capped HERE,
      // not deeper in the pool (`buildPoolProxyBaseName`, `mcp/mcp-pool.ts`):
      // a pool-side transform would run after the Pi execution-manifest seed
      // already captured the untransformed name, desyncing the two and
      // silently dropping tools (review finding, task 2 of
      // stable-plugin-mcp-wire-names, 2026-08-10). Sanitize THEN cap, not the
      // other way round — capping first can leave a trailing `_` the
      // sanitizer would have trimmed, and the cap's hash tail must be
      // computed over the value actually used (F3, 2026-08-11: a scoped
      // `.mcp.json` server named e.g. `my server.v2` used to keep the space
      // and the dot in its wire name, which `tryParsePiDynamicMcpBindingName`
      // then rejected outright).
      //
      // The `server-<hash>` fallback between the two is NOT decoration: the
      // sanitizer returns EMPTY for a name with no `[A-Za-z0-9_-]` character
      // at all — `мой сервер`, `日本語`, `!!!` — and a Cyrillic-named scoped
      // `.mcp.json` server is ordinary in this product. An empty wire name is
      // dropped from the runtime pool (`views.ts`'s `if (!name || …) continue`)
      // and trips the net below, so before this fallback the mint really could
      // produce the unusable name the net exists to catch (review finding 1,
      // G2 follow-up, 2026-08-11). `pluginMcpWireName` has carried the same
      // guard (`|| 'plugin'` / `|| 'server'`) since it was written; this site
      // adopted its sanitizer without its fallback. Keyed on `summary.key`,
      // the same stable key — and the same `sha256Hex(...).slice(0, 10)` shape
      // — the shadowed branch just below uses, so two differently-named
      // all-disallowed servers cannot collide onto one wire name.
      setMcpWireName(
        winner,
        capMcpNameSegment(
          sanitizeMcpNameSegment(winner.summary.logicalName)
            || `server-${sha256Hex(winner.summary.key).slice(0, 10)}`,
          40,
        ),
      );
      for (const shadowed of sorted.slice(1)) {
        shadowed.summary.enabled = false;
        shadowed.summary.unavailableReason = 'shadowed-by-mcp-precedence';
        // Qualified-but-inert (the `-shadowed-` infix) purely so catalog rows
        // stay distinct; disabled entries never reach the runtime view. This
        // one needs no empty-name fallback: the `-shadowed-<10 hex>` tail is
        // itself `[A-Za-z0-9_-]`, so the sanitizer's output is non-empty and
        // per-entry distinct even when the logical name contributes nothing
        // (verified over the same all-disallowed specimens as the winner mint
        // above — `мой сервер` yields `-shadowed-<hash>`, not `''`).
        setMcpWireName(
          shadowed,
          capMcpNameSegment(sanitizeMcpNameSegment(`${logicalName}-shadowed-${sha256Hex(shadowed.summary.key).slice(0, 10)}`), 40),
        );
      }
      if (sorted.length > 1) {
        diagnostics.push({
          severity: 'info',
          code: 'capability.collision.mcp-scope-precedence',
          message: `MCP server "${logicalName}" is defined in more than one scope; the highest-precedence definition is used`,
          capabilityKey: sorted[0]!.summary.key,
        });
      }
    }

    // Plugin tier: NEVER contends for the bare name (`mcp.md:365`) — a stable
    // plugin-qualified wire name, contested or not, so it never moves when an
    // unrelated install changes what else is in this bucket.
    for (const entry of plugins) {
      const pluginId = (entry.summary.pluginInstanceId && pluginIdFromInstanceId(entry.summary.pluginInstanceId))
        || entry.summary.pluginKey || 'plugin';
      // `pluginMcpWireName` already sanitizes and caps its own output
      // internally, so this outer sanitize+cap is provably a no-op here (its
      // input already matches `[A-Za-z0-9_-]+`, contains no `__` run, and is
      // never longer than 40) — applied anyway so all three assignments in
      // this branch share one uniform invariant rather than one of them
      // relying on an inner function's guarantee (pinned in
      // mcp-wire-name.test.ts and resolver.test.ts).
      setMcpWireName(entry, capMcpNameSegment(sanitizeMcpNameSegment(pluginMcpWireName(pluginId, entry.summary.logicalName)), 40));
    }
    if (plugins.length && (scoped.length || plugins.length > 1)) {
      diagnostics.push({
        severity: 'info',
        code: 'capability.collision.mcp-wire-alias',
        message: `MCP name "${logicalName}" is also provided by a plugin; plugin servers use their qualified wire names`,
      });
    }
  }
}

function setMcpWireName(entry: ResolvedCapabilityEntry, wireName: string): void {
  if (entry.runtimeBinding.kind === 'mcp') {
    entry.runtimeBinding.server.wireName = wireName;
  } else if (entry.runtimeBinding.kind === 'source' && entry.summary.sourceType === 'mcp') {
    entry.runtimeBinding.mcpWireName = wireName;
  }
}

/** The wire name {@link setMcpWireName} would target, or undefined off an entry that carries none. */
function getMcpWireName(entry: ResolvedCapabilityEntry): string | undefined {
  if (entry.runtimeBinding.kind === 'mcp') return entry.runtimeBinding.server.wireName;
  if (entry.runtimeBinding.kind === 'source' && entry.summary.sourceType === 'mcp') return entry.runtimeBinding.mcpWireName;
  return undefined;
}

/**
 * True only when the capability may actually reach the runtime pool this
 * turn — mirrors `views.ts`'s private `isRunnable` exactly (same three
 * conditions), kept as a separate copy rather than an import so this file
 * never depends on the views layer that is built from it.
 */
function mayReachRuntimePool(entry: ResolvedCapabilityEntry): boolean {
  const s = entry.summary;
  if (!s.enabled) return false;
  if (s.trustState === 'review-required' || s.trustState === 'blocked') return false;
  if (s.unavailableReason === 'unsupported-runtime') return false;
  return true;
}

/**
 * F3 net, not the main fix: `applyCollisionPolicy`'s sanitize-then-fallback-
 * then-cap mint (just above) is what makes every wire name it produces
 * parseable as `mcp__<wire>__<tool>` — this pass is the guard that says so out
 * loud if a future mint path ever bypasses it, by checking every RUNNABLE
 * MCP-carrying entry's wire name against the exact parser the Pi harness uses
 * (`tryParsePiDynamicMcpBindingName`) rather than re-deriving the wire name's
 * own validity rules. Exported so a test can force the condition directly —
 * on a hand-built entry the mint never touched — instead of weakening the
 * sanitizer to reach it through `resolve()`.
 *
 * That last clause was WRONG as originally written (it claimed the condition
 * was already unreachable through `resolve()` once F3 landed): the sanitizer
 * alone returns `''` for a logical name with no `[A-Za-z0-9_-]` character, so
 * a Cyrillic-named scoped server reached this net in production. The
 * `server-<hash>` fallback added at the winner mint on 2026-08-11 (review
 * finding 1) is what actually closes it, and the three mint sites are now
 * non-empty by construction: the winner via that fallback, the shadowed entry
 * via its `-shadowed-<hash>` tail, the plugin entry via `pluginMcpWireName`'s
 * own `|| 'plugin'` / `|| 'server'`.
 */
export function diagnoseUnusableMcpWireNames(
  entries: readonly ResolvedCapabilityEntry[],
  diagnostics: CapabilityDiagnostic[],
): void {
  for (const entry of entries) {
    if (!mayReachRuntimePool(entry)) continue;
    const wireName = getMcpWireName(entry);
    if (wireName === undefined) continue;
    if (tryParsePiDynamicMcpBindingName(`mcp__${wireName}__probe`)) continue;
    diagnostics.push({
      severity: 'warning',
      code: 'capability.mcp.unusable-wire-name',
      message: `MCP server "${entry.summary.logicalName}" has a wire name that cannot form a parseable tool name; its tools are unavailable`,
      capabilityKey: entry.summary.key,
      safeArgs: { server: entry.summary.logicalName },
    });
  }
}

/**
 * T4b — endpoint identity of a DECLARED, PLUGIN `kind: 'mcp'` entry, or null
 * when no safe identity exists to compare. Plugin-vs-plugin only — see below.
 *
 * Compared BEFORE any runtime rewrite: `resolvePluginStdioExecutable`
 * (`mcp/runtime-pool-servers.ts`) replaces a plugin's stdio command with the
 * supervised host executable at materialization time, well downstream of the
 * resolver, so reading anything but the DECLARED shape would silently stop
 * matching the moment that rewrite runs. Deliberately conservative — a false
 * positive kills a working server, a false negative only wastes a subprocess
 * — so the identity folds in a fingerprint of a NAMED list of declared
 * credential-bearing fields, read together with `declaredEnvFingerprint`:
 * `env`, `headers`, `environmentDefaults`, `headersHelper`, `endpointAuth` in
 * full (the oauth/bearer global credential-slot identity — Fix 4, review
 * pass 2, 2026-08-10), `credentialEnvironment`'s key set (the MCPB named
 * credential-slot bindings — Fix 4), and `forwardedEnvironmentSources` in
 * full plus `requiredEnvironmentNames` (Fix 5, fix pass 3, 2026-08-10 — the
 * `SdkMcpServerConfigWithoutSecrets` fields `materializePluginMcpForwardedEnvironment`
 * (`mcp/runtime-pool-servers.ts`) reads to forward a differently-named
 * ambient HOST credential into the child process; see `declaredEnvFingerprint`
 * for why folding the VALUES is safe here and not elsewhere). This is a
 * closed, named list, not a claim that it is exhaustive over every field
 * `RuntimeMcpServer` carries: identity fields
 * (`key`/`wireName`/`logicalName`/`pluginInstanceId`) are deliberately
 * excluded because matching across two different INSTALLS of the same
 * declared server is the entire point of this pass; see the field comments
 * on `RuntimeMcpServer` for what else exists and is not read here.
 * Two credentialed twins of one endpoint (different tenants, or two
 * different plugins each holding their own OAuth grant to the same
 * third-party API) are never collapsed into each other. The stdio argv is
 * JSON-encoded (`[command, ...args]`) rather than space-joined, so a command
 * containing a space (e.g. a Windows `Program Files` path) cannot collide
 * with a different (command, args) split that happens to space-join to the
 * same string.
 *
 * Scoped/native entries are excluded outright (review finding, Fix 3,
 * 2026-08-10) rather than compared: `nativeRuntimeBinding`'s `definition` is
 * an empty stdio placeholder at this stage ("materialized lazily by the
 * runtime view"), so the only declared read available for a scoped entry
 * would be the pre-computed `summary.mcpServerIdentity` transport identity —
 * and that value structurally CANNOT carry env/headers: its producer
 * (`native-sources.ts:mcpTransportIdentity`) reads only
 * `type`/`transport`/`url`/`command`/`args`, and its type
 * (`ManagedMcpServerIdentityV1`, shared with the managed-MCP denylist) has no
 * field for either. A scoped entry that DOES declare credentials would
 * therefore always fingerprint as "declares nothing" and could match a
 * genuinely credential-free plugin twin at the same URL, disabling it
 * wrongly — the exact false-positive direction this pass exists to prevent.
 * There is no other pinned signal on a scoped entry to prove it declares no
 * env/headers, so rather than guess, T4b covers plugin-vs-plugin only, which
 * is what its own title says.
 */
function declaredEndpointIdentity(entry: ResolvedCapabilityEntry): string | null {
  if (entry.summary.origin !== 'plugin') return null;
  const server = entry.runtimeBinding.kind === 'mcp' ? entry.runtimeBinding.server : undefined;
  const definition = server?.definition;
  if (!definition) return null;
  const envFingerprint = declaredEnvFingerprint(
    server?.descriptorEnvironment,
    server?.descriptorHeaders,
    server?.descriptorEnvironmentDefaults,
    server?.descriptorHeadersHelper,
    server?.endpointAuth,
    server?.credentialEnvironment,
    definition.forwardedEnvironmentSources,
    definition.requiredEnvironmentNames,
  );
  if (definition.type === 'http' || definition.type === 'sse') {
    return definition.url ? `${definition.type}:${normalizeMcpEndpointUrl(definition.url)}:${envFingerprint}` : null;
  }
  if (definition.type === 'stdio') {
    return definition.command
      ? `stdio:${JSON.stringify([definition.command, ...(definition.args ?? [])])}:${envFingerprint}`
      : null;
  }
  return null;
}

/** Trailing-slash-insensitive, case-insensitive URL identity — no other normalization (no query rewriting, no path resolution). */
function normalizeMcpEndpointUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Stable JSON of a NAMED list of declared credential-bearing fields — `env`,
 * `headers`, `environmentDefaults`, `headersHelper`, `endpointAuth`,
 * `credentialEnvironment`'s key set, `forwardedEnvironmentSources` and
 * `requiredEnvironmentNames` — with SORTED keys on every map (and SORTED
 * arrays) so key/element insertion order can never fake a difference. Not a
 * claim that this is every credential-adjacent field `RuntimeMcpServer`
 * carries; see the doc comment on `declaredEndpointIdentity`, its only
 * caller, for what is deliberately excluded and why.
 *
 * Widened three times past the original `env`/`headers` pair:
 * - (review finding, Fix 1, 2026-08-10) `environmentDefaults` (merged into
 *   the spawn environment by `materializeMcpDescriptorEnvironment`,
 *   `mcp/server-config-values.ts` — a key present only in the defaults still
 *   reaches the child process) and `headersHelper` (the declared
 *   dynamic-header shell command run by `resolveMcpDynamicHeaders`,
 *   `mcp/headers-helper.ts` — a first-class per-server credential mechanism,
 *   not a value to skip). `headersHelper` is a single string at this layer
 *   (`RuntimeMcpServer.descriptorHeadersHelper`; cwd/pluginRoot are resolved
 *   later by the runtime materializer and never stored on this record), so it
 *   needs no sorting — its full declared shape here IS the string.
 * - (review finding, Fix 4, 2026-08-10) `endpointAuth` — the oauth/bearer
 *   plugin server's declared GLOBAL credential-slot identity
 *   (`pluginMcpCredentialId(authType, pluginKey, serverName)`,
 *   `plugins/mcp-credentials.ts`); an oauth/bearer server declares no literal
 *   env/headers at all, so without this an OAuth connector bundled by one
 *   plugin could fingerprint identically to the same connector bundled by a
 *   DIFFERENT plugin. Folded via an explicit fixed-key object literal, never
 *   a bare `JSON.stringify(endpointAuth)`, so the fingerprint's key order is
 *   controlled HERE and cannot drift if the field's own construction order
 *   ever changes upstream. And `credentialEnvironment` — the MCPB named
 *   credential-slot bindings (`Record<envName, { configKey, credential }>`)
 *   — folded as its SORTED KEY SET only; `configKey` and `credential` (a
 *   `RuntimeCredentialBinding` pointer, `credentials/types.ts`) are never
 *   read into the fingerprint, so no credential-store reference or value can
 *   ever reach a diagnostic, a log line, or a test fixture through this
 *   function.
 * - (review finding, Fix 5, fix pass 3, 2026-08-10) `forwardedEnvironmentSources`
 *   — a plugin-declared `{ childEnvName: hostEnvVarName }` forwarding map
 *   read by `materializePluginMcpForwardedEnvironment`
 *   (`mcp/runtime-pool-servers.ts`) to pull a differently-named AMBIENT HOST
 *   credential (`process.env[hostEnvVarName]`) into the child process; two
 *   plugins at the same endpoint declaring no literal
 *   env/headers/environmentDefaults/headersHelper/endpointAuth but forwarding
 *   from different host variables used to fingerprint identically. Its
 *   VALUES are host env-VAR-NAMES, not secret values — the field's own doc
 *   comment (`PluginMcpDescriptor.environmentSources`, `plugins/types.ts`:
 *   "Child environment name to optional host source name forwarding map")
 *   and its only runtime consumer's indexing (`process.env[sourceName]`,
 *   never `process.env[secretValue]`, which would be meaningless) agree — so,
 *   exactly like `env`, both the keys AND the values are folded via
 *   `sortedEntries`. And `requiredEnvironmentNames` — a declared list of
 *   required child env NAMES (never values) that can likewise differ between
 *   two otherwise-identical declarations — folded sorted, the same treatment
 *   every other array-shaped field here gets.
 */
function declaredEnvFingerprint(
  env: Record<string, string> | undefined,
  headers: Record<string, string> | undefined,
  environmentDefaults: Record<string, string> | undefined,
  headersHelper: string | undefined,
  endpointAuth: RuntimeMcpServer['endpointAuth'],
  credentialEnvironment: RuntimeMcpServer['credentialEnvironment'],
  forwardedEnvironmentSources: Record<string, string> | undefined,
  requiredEnvironmentNames: readonly string[] | undefined,
): string {
  const sortedEntries = (record: Record<string, string> | undefined) =>
    Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify({
    env: sortedEntries(env),
    headers: sortedEntries(headers),
    environmentDefaults: sortedEntries(environmentDefaults),
    headersHelper: headersHelper ?? null,
    // Explicit fixed-key literal — never `JSON.stringify(endpointAuth)`
    // directly, so the key order in the fingerprint is controlled here
    // regardless of how the field itself was constructed upstream.
    endpointAuth: endpointAuth
      ? {
          authType: endpointAuth.authType,
          pluginKey: endpointAuth.pluginKey,
          serverName: endpointAuth.serverName,
          oauthResource: endpointAuth.oauthResource ?? null,
          clientId: endpointAuth.clientId ?? null,
        }
      : null,
    // Keys only — never the slot's `configKey`/`credential` values.
    credentialEnvironmentKeys: Object.keys(credentialEnvironment ?? {}).sort(),
    // Values here are host env-VAR-NAMES, not secret values (see the doc
    // comment above) — folded in full, exactly like `env`.
    forwardedEnvironmentSources: sortedEntries(forwardedEnvironmentSources),
    requiredEnvironmentNames: [...(requiredEnvironmentNames ?? [])].sort(),
  });
}

/**
 * Every installed plugin's unsatisfied dependencies, keyed by plugin key.
 *
 * The rules live in `plugins/dependencies.ts`, shared with the CLI inventory so
 * the app and `plugin list` can never disagree about whether a plugin's
 * dependencies are satisfied. This is the fix for the exposure that made
 * `dependencies` worth building at all: `plugins/host-marketplace.md#depend-on-and-recommend-other-plugins` — "Claude
 * Code disables the affected plugin until you resolve the error." A bundle whose
 * SAFETY component lives in a dependency (a `PreToolUse` guard hook, a
 * permission-narrowing plugin) previously installed and activated here with that
 * dependency absent, showing only a generic `partial` badge.
 */
function resolveActiveDependencyErrors(
  inputs: CapabilityResolutionInputs,
): Map<PluginKey, ResolvedPluginDependencyError[]> {
  const activeIds = new Set(Object.values(inputs.activePluginInstances));
  const active = inputs.installedPlugins.filter(plugin => activeIds.has(plugin.pluginInstanceId));
  return resolvePluginDependencyErrors(active, subject => {
    const plugin = active.find(entry => entry.pluginKey === subject.pluginKey)!;
    const activation = inputs.resolveActivation({
      pluginKey: plugin.pluginKey,
      pluginInstanceId: plugin.pluginInstanceId,
    });
    return activation.enabled && !activation.suppressed;
  });
}

/** Re-exported so the resolver's own consumers need not reach past it. */
export type ResolvedPluginDependencyError = PluginDependencyError;

function buildInstalledPlugins(
  inputs: CapabilityResolutionInputs,
  dependencyErrors: Map<PluginKey, ResolvedPluginDependencyError[]>,
): ResolvedInstalledPlugin[] {
  const kindsByInstance = new Map<PluginInstanceId, Set<ResolvedCapabilityKind>>();
  for (const candidate of inputs.pluginCandidates) {
    const set = kindsByInstance.get(candidate.pluginInstanceId) ?? new Set<ResolvedCapabilityKind>();
    set.add(pluginKindToResolved(candidate.componentKind ?? candidate.kind));
    kindsByInstance.set(candidate.pluginInstanceId, set);
  }

  const activeIds = new Set(Object.values(inputs.activePluginInstances));
  const result: ResolvedInstalledPlugin[] = [];
  for (const plugin of inputs.installedPlugins) {
    if (!activeIds.has(plugin.pluginInstanceId)) continue;
    const pluginRuntime = inputs.pluginRuntimeContextFor?.(plugin.pluginInstanceId);
    const activation = inputs.resolvePluginScopeActivation?.({
      pluginKey: plugin.pluginKey,
      pluginInstanceId: plugin.pluginInstanceId,
    });
    const effectiveActivation = inputs.resolveActivation({
      pluginKey: plugin.pluginKey,
      pluginInstanceId: plugin.pluginInstanceId,
    });
    const authRequirements = derivePluginMcpAuthRequirements(plugin.manifest);
    result.push({
      pluginKey: plugin.pluginKey,
      activeInstanceId: plugin.pluginInstanceId,
      origin: {
        marketplaceId: plugin.marketplaceId,
        pluginId: plugin.pluginId,
        ...(plugin.listingId ? { listingId: plugin.listingId } : {}),
        ...(plugin.sourceId ? { sourceId: plugin.sourceId } : {}),
      },
      name: plugin.manifest.name,
      version: plugin.version,
      installedAt: plugin.installedAt,
      lifecycleState: plugin.lifecycleState ?? 'ready',
      ...(plugin.availableUpdateVersion ? { availableUpdateVersion: plugin.availableUpdateVersion } : {}),
      ...(plugin.updateVersionUncomparable ? { updateVersionUncomparable: true } : {}),
      capabilityKinds: [...(kindsByInstance.get(plugin.pluginInstanceId) ?? [])].sort(),
      ...(plugin.compatibility ? { compatibility: plugin.compatibility } : {}),
      ...(authRequirements.length > 0
        ? { authRequirements }
        : {}),
      ...(activation ? { activation } : {}),
      // `:208` — a plugin with an unresolved dependency is disabled until the
      // error is resolved, so the effective verdict has to say so and not only
      // report the policy answer.
      ...((dependencyErrors.get(plugin.pluginKey)?.length ?? 0) > 0
        ? { dependencyErrors: dependencyErrors.get(plugin.pluginKey)! }
        : {}),
      activationEnabled: effectiveActivation.enabled
        && !effectiveActivation.suppressed
        && (dependencyErrors.get(plugin.pluginKey)?.length ?? 0) === 0,
      bundleHash: plugin.bundleHash,
      ...(pluginRuntime ? { bundleRootPath: pluginRuntime.rootPath } : {}),
    });
  }
  return result;
}

/**
 * Deterministic generation hash. Hashes source/content revisions, normalized
 * plugin support, policy activation, project trust, exact-hash trust, non-secret
 * credential status/revision, session selection and the provider capability
 * revision. Secret bytes never enter the hash.
 */
function computeGeneration(
  context: CapabilityContext,
  inputs: CapabilityResolutionInputs,
  entries: ResolvedCapabilityEntry[],
): string {
  const material = {
    context: {
      workspaceId: context.workspaceId,
      sessionId: context.sessionId ?? null,
      provider: context.provider ?? null,
      projectKey: context.projectKey ?? null,
      projectTrustState: context.projectTrustState,
      projectTrustRevision: context.projectTrustRevision,
    },
    entries: entries
      .map(entry => ({
        key: entry.summary.key,
        kind: entry.summary.kind,
        origin: entry.summary.origin,
        enabled: entry.summary.enabled,
        readOnly: entry.summary.readOnly,
        selectedAsUnqualifiedAlias: entry.summary.selectedAsUnqualifiedAlias,
        trustState: entry.summary.trustState,
        credentialState: entry.summary.credentialState,
        icon: entry.summary.iconResource ?? null,
        // R61: a `skillOverrides` state comes from a SETTINGS file, not from the
        // SKILL.md, so it moves neither the record's `contentHash` nor its
        // `revision`. Without it here a session that has already pinned a
        // snapshot keeps serving the pre-change listing after the user edits the
        // key. Spread CONDITIONALLY, on the same shape-stability rule the
        // `connectorRuntime: null` comment below states: an unoverridden skill
        // adds no field, so no existing generation moves.
        ...(entry.summary.skillOverrideState
          ? { skillOverrideState: entry.summary.skillOverrideState }
          : {}),
        // R78: `skillTier` is deliberately NOT hashed, and it is the opposite
        // case to `skillOverrideState` above rather than an oversight. Its only
        // consumer is `aliasScopeRank`, whose whole output is
        // `selectedAsUnqualifiedAlias` — which IS in this material two lines up.
        // So every way the tag can change an observable is already covered, and
        // hashing it would move the generation for every profile that has ever
        // been seeded, for the four slugs that ship, on the first run after this
        // lands — with nothing downstream to show for it.
        binding: bindingGenerationMaterial(entry.runtimeBinding),
        credentialRevision: entry.summary.credentialRevision ?? null,
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    activePlugins: Object.entries(inputs.activePluginInstances).sort(([a], [b]) => (a < b ? -1 : 1)),
    sessionSelection: inputs.sessionSelection
      ? {
          enabled: [...(inputs.sessionSelection.enabledSourceKeys ?? [])].sort(),
          disabled: [...(inputs.sessionSelection.transientlyDisabledKeys ?? [])].sort(),
          revision: inputs.sessionSelection.revision ?? null,
        }
      : null,
    providerCapabilityRevision: inputs.providerCapabilityRevision ?? null,
  };
  return sha256Hex(stableStringify(material));
}

function resourceGenerationMaterial(
  resource: NativeResourceRef | PluginBundleResourceRef,
): Record<string, unknown> {
  if ('pluginInstanceId' in resource) {
    return {
      pluginInstanceId: resource.pluginInstanceId,
      relativePath: resource.relativePath,
      contentHash: resource.contentHash,
    };
  }
  return {
    source: resource.source,
    scope: resource.scope,
    resourceId: resource.resourceId,
    revision: resource.revision,
    contentHash: resource.contentHash,
  };
}

function bindingGenerationMaterial(binding: CapabilityRuntimeBinding): Record<string, unknown> {
  switch (binding.kind) {
    case 'source':
      return {
        kind: binding.kind,
        resource: resourceGenerationMaterial(binding.resource),
        mcpWireName: binding.mcpWireName ?? null,
        // C5: `connectorRuntime` left the binding; the null keeps the
        // generation hash material shape-stable so existing generations do not
        // all invalidate at once.
        connectorRuntime: null,
        guideResource: binding.guideResource
          ? resourceGenerationMaterial(binding.guideResource)
          : null,
      };
    case 'skill':
      return {
        kind: binding.kind,
        resource: resourceGenerationMaterial(binding.resource),
        executableHash: binding.executableHash ?? null,
        // A DIGEST, on the same rule the hook branch below states: a
        // reconfigured plugin option has to move the generation or a pinned
        // snapshot keeps substituting the OLD value into the skill body. These
        // values are non-sensitive by construction, but the rule that no
        // configured value enters capability metadata is uniform.
        pluginUserConfigDigest: binding.pluginUserConfig
          ? sha256Hex(stableStringify(binding.pluginUserConfig))
          : null,
      };
    case 'asset':
      return { kind: binding.kind, resource: resourceGenerationMaterial(binding.resource) };
    case 'mcp':
      return {
        kind: binding.kind,
        key: binding.server.key,
        wireName: binding.server.wireName,
        // A DIGEST rather than the definition itself, since `:577` substitutes
        // `${user_config.KEY}` into `command`, `args`, `url` and `cwd`: a
        // configured token can now be IN this structure, and the same rule the
        // hook branch states applies — no configured value may enter capability
        // metadata the host holds in memory. The generation still moves on every
        // definition change, which is all this material was ever for.
        definitionDigest: sha256Hex(stableStringify(binding.server.definition)),
        executableHash: binding.server.executableHash ?? null,
        pluginInstanceId: binding.server.pluginRuntime ? binding.server.key.split('#', 1)[0] : null,
      };
    case 'hook':
      return {
        kind: binding.kind,
        event: binding.hook.event,
        executableHash: binding.hook.executableHash,
        type: binding.hook.type ?? null,
        matcher: binding.hook.matcher ?? null,
        command: binding.hook.command ?? null,
        cwd: binding.hook.cwd ?? null,
        timeoutMs: binding.hook.timeoutMs ?? null,
        // A DIGEST, never the values: a reconfigured plugin option has to move
        // the generation or a pinned snapshot keeps exporting the old value,
        // and no configured value may enter a structure the host holds in
        // memory as capability metadata. The MCP side reaches the same result
        // through `credentialRevision`, which plugin options have no equivalent
        // of.
        optionEnvironmentDigest: binding.hook.optionEnvironment
          ? sha256Hex(stableStringify(binding.hook.optionEnvironment))
          : null,
        resource: resourceGenerationMaterial(binding.hook.resource),
      };
    case 'automation':
      return {
        kind: binding.kind,
        event: binding.automation.event,
        resource: resourceGenerationMaterial(binding.automation.resource),
      };
    case 'agent':
      return {
        kind: binding.kind,
        executableHash: binding.executableHash ?? null,
        name: binding.agent.name,
        selectedAsUnqualifiedAlias: binding.agent.selectedAsUnqualifiedAlias ?? false,
        model: binding.agent.model ?? null,
        tools: binding.agent.tools ?? [],
        resource: resourceGenerationMaterial(binding.agent.instructionsResource),
      };
    case 'instruction':
      return {
        kind: binding.kind,
        order: binding.layer.order,
        resource: resourceGenerationMaterial(binding.layer.resource),
      };
    case 'memory':
      return {
        kind: binding.kind,
        readOnly: binding.memory.readOnly,
        format: binding.memory.format ?? null,
        resource: resourceGenerationMaterial(binding.memory.resource),
      };
    case 'permission':
      return {
        kind: binding.kind,
        order: binding.layer.order,
        sourceSlug: binding.layer.sourceSlug ?? null,
        resource: resourceGenerationMaterial(binding.layer.resource),
      };
    case 'command':
      return {
        kind: binding.kind,
        executableHash: binding.command.executableHash,
        resource: resourceGenerationMaterial(binding.command.resource),
      };
    case 'prompt-command':
      return {
        kind: binding.kind,
        argumentHint: binding.promptCommand.argumentHint ?? null,
        model: binding.promptCommand.model ?? null,
        resource: resourceGenerationMaterial(binding.promptCommand.resource),
      };
    case 'workflow':
      return {
        kind: binding.kind,
        resource: resourceGenerationMaterial(binding.workflow.resource),
      };
    case 'output-style':
      return {
        kind: binding.kind,
        styleId: binding.outputStyle.styleId,
        resource: resourceGenerationMaterial(binding.outputStyle.resource),
      };
    case 'app':
      return { kind: binding.kind, mcpServerKeys: [...binding.app.mcpServerKeys].sort() };
    case 'setting':
      return { kind: binding.kind, valueType: binding.valueType, defaultValue: binding.defaultValue ?? null };
    case 'lsp':
      return {
        kind: binding.kind,
        executableHash: binding.lsp.executableHash,
        command: binding.lsp.command,
        args: binding.lsp.args ?? null,
        ...pluginLspRoutingMaterial(binding.lsp),
        // A DIGEST, for the reason the `mcp` branch states: `:577` substitutes
        // `${user_config.KEY}` into an LSP config too, so a configured token can
        // be inside `env`. The generation still moves whenever the launch
        // environment or folder changes — which is what re-provisions the
        // server, since `createPiLspAuthoritySignature` hashes the generation.
        // Spread conditionally so a server declaring neither keeps the material
        // it had before these two fields existed.
        ...(binding.lsp.env || binding.lsp.workspaceFolder
          ? {
              launchDigest: sha256Hex(stableStringify({
                env: binding.lsp.env ?? null,
                workspaceFolder: binding.lsp.workspaceFolder ?? null,
              })),
            }
          : {}),
      };
    case 'monitor':
      // A command monitor's identity is its command text, not a resource+cron.
      // Hashing the wrong half would leave a re-imported bundle with a changed
      // command sharing a generation with the old one.
      return isCommandMonitorRegistration(binding.monitor)
        ? {
            kind: binding.kind,
            monitorId: binding.monitor.monitorId,
            form: 'command',
            command: binding.monitor.command,
            when: binding.monitor.when,
            executableHash: binding.monitor.executableHash,
          }
        : {
            kind: binding.kind,
            monitorId: binding.monitor.monitorId,
            cron: binding.monitor.cron,
            timezone: binding.monitor.timezone ?? null,
            executableHash: binding.monitor.executableHash,
            resource: resourceGenerationMaterial(binding.monitor.resource),
          };
  }
}

/**
 * Snapshot-scoped ephemeral projection helper. Resolves, runs the projection and
 * releases the lease in `finally` on success, projection error, abort or
 * disconnect — so repeated catalog refreshes leave the lease registry empty.
 */
export async function withCapabilitySnapshot<T>(
  resolver: CapabilityResolver,
  context: CapabilityContext,
  project: (snapshot: EffectiveCapabilitySnapshot) => T | Promise<T>,
): Promise<T> {
  const snapshot = await resolver.resolve(context);
  try {
    return await project(snapshot);
  } finally {
    resolver.releaseSnapshot(snapshot.leaseId);
  }
}

// F1.11 (origin D1.367, option (b)) — declared by interface merging so no cited line above moves.
export interface CapabilityContext {
  /**
   * Server-derived, set only by a session turn whose project is a directory inside a linked git worktree: the
   * `ProjectKey` of the same directory in the repository's MAIN CHECKOUT (`resolveMainCheckoutProjectKey`).
   * Read by `leaseMatchesScope` alone, so a project-scope plugin change keyed on the checkout revokes or
   * refreshes the worktree's live snapshot too. Plugin ACTIVATION does not read it from here — the input builder
   * derives the same key from `projectRoot` for every context, so no caller can forget it — and TRUST never
   * reads it: trust stays per directory.
   */
  mainCheckoutProjectKey?: ProjectKey;
}

// F1.766 — declared by interface merging so no cited line above moves.
interface LeaseRecord {
  /** The plugin keys of `instances` (every plugin entry carries both ids), read by {@link leaseHoldsPlugin}. */
  pluginKeys: Set<PluginKey>;
}

/**
 * F1.766 (origin SIT-b, owner decision 2026-09-26 option A) — whether a revoke that names `pluginKey` reaches this
 * lease, after {@link leaseMatchesScope} said the lease is in the revoke's scope: only when the snapshot holds an
 * instance of that plugin. A turn whose snapshot never loaded it (a busy codex session whose install refresh was
 * deferred) had none of its authority, so there is nothing to withdraw; it keeps its turn, and the plugin
 * mutation's own runtime refresh reaches it before the next one, as Claude does (`discover-plugins.md` § "Keep plugins updated":
 * "The running session keeps the versions it already loaded."). A revoke that names no plugin reaches every lease in its scope,
 * the fail-closed default every other caller keeps. Keyed by plugin, not instance, so an update's old instance counts.
 * Residue: a plugin that projects NO capability is in no lease, so removing it stops no turn — including one using a
 * plugin that depends on it; that dependant is withheld from the next turn by the dependency check.
 */
function leaseHoldsPlugin(record: LeaseRecord, pluginKey: PluginKey | undefined): boolean {
  return pluginKey === undefined || record.pluginKeys.has(pluginKey);
}

// F1.1025 — declared by interface merging so no cited line above moves.
export interface RuntimeLspRegistration {
  /**
   * The server's `extensionToLanguage`, as the descriptor carries it
   * (`PluginLspDescriptor.extensionToLanguage`). Absent for our own `languages`
   * spelling and for every install cached before the map was carried. Read by
   * {@link resolvePluginLspDocumentLanguage}.
   */
  extensionToLanguage?: Record<string, string>;
}

/**
 * F1.1025 — the registration fields a document's language is routed by, copied
 * from the descriptor at the one site that builds an `lsp` registration.
 * `languages` is unchanged; the map joins only when the descriptor has one.
 */
function pluginLspRoutingFields(
  lsp: Pick<RuntimeLspRegistration, 'languages' | 'extensionToLanguage'>,
): Pick<RuntimeLspRegistration, 'languages' | 'extensionToLanguage'> {
  return { languages: lsp.languages, ...(lsp.extensionToLanguage ? { extensionToLanguage: lsp.extensionToLanguage } : {}) };
}

/**
 * F1.1025 — the routing half of an `lsp` binding's generation material.
 *
 * The map is in it because the host keeps the registrations it routes by for as
 * long as the server's authority signature holds (`SessionManager`'s
 * `createPiLspAuthoritySignature`, which hashes the generation), so a map that
 * changed without moving the generation would keep routing by the old one.
 * Spread conditionally, on the shape-stability rule the `launchDigest` branch
 * states: a server declaring no map — every install cached before the map was
 * carried — keeps the material, and so the generation, it had.
 */
function pluginLspRoutingMaterial(lsp: RuntimeLspRegistration): Record<string, unknown> {
  return {
    languages: lsp.languages ?? null,
    ...(lsp.extensionToLanguage ? { extensionToLanguage: lsp.extensionToLanguage } : {}),
  };
}

/**
 * F1.1025 — the server and language id a document gets from its EXTENSION: for
 * an `lsp` request that names no language, and for the open that follows an
 * edit (F1.1024). The host's wiring of both lives in `SessionManager`.
 *
 * The contract, read from the pages rather than chosen:
 *   - `plugins-reference.md` § `lspServers`: `extensionToLanguage` is the "Map of
 *     file extension to LSP language ID, at least one entry. Keys start with a
 *     dot, such as `".go"`". The extension is the path's last dotted suffix
 *     (`extname`), matched EXACTLY: the official `clangd-lsp` maps `.c` to `c`
 *     and `.C` to `cpp`, so folding case would hand a C++ file to C. Indexing is
 *     safe because every key `extname` returns starts with a dot, and no
 *     `Object.prototype` member does.
 *   - `plugins/components.md#lsp-servers`: "when two enabled servers claim the
 *     same extension, the first registered handles those files and the other
 *     isn't used for them". So the FIRST registration in the order given wins;
 *     callers pass the runtime view's `lspServers` order.
 *   - A mapped language the server does not own (`languages`) is skipped —
 *     the adapter refuses such an entry by name, so this only guards a
 *     hand-written native manifest.
 * Undefined when no carried map claims the extension, which includes a file
 * with none: such a request still has to name its language, as before.
 */
export function resolvePluginLspDocumentLanguage(
  registrations: readonly Pick<RuntimeLspRegistration, 'key' | 'languages' | 'extensionToLanguage'>[],
  path: string,
): { key: string; languageId: string } | undefined {
  const extension = extname(path);
  if (!extension) return undefined;
  for (const registration of registrations) {
    const languageId = registration.extensionToLanguage?.[extension];
    if (languageId !== undefined && registration.languages.includes(languageId)) {
      return { key: registration.key, languageId };
    }
  }
  return undefined;
}

// UA5.5 — declared by interface merging so no cited line above moves.
export interface CapabilityContext {
  /**
   * The workspace project (an entity id, `projects/<slug>/config.json`) the session is bound to. Server-derived from
   * the `ManagedSession` on a session turn, never accepted from a renderer. Read by the capability input builder
   * (`bootstrap/storage-runtime.ts`), which adds the project-context `instruction` record for it
   * (`projects/project-context.ts` `resolveProjectContextLayer`); absent for a session with no project and for every
   * browse resolve.
   */
  projectId?: string;
}

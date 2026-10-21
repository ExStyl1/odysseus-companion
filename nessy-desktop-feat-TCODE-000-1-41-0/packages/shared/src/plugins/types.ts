export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1 as const;
export const PLUGIN_STORE_SCHEMA_VERSION = 1 as const;

/**
 * Where a plugin is ACTIVE. Install itself is scope-free: the store keeps one
 * immutable copy per `(version, bundleHash)` and activation is owned by the
 * capability policy store (see `store-v2.ts`, "the registry is portable and
 * activation-free").
 *
 * ## P6.414 — measured against the page's four, because the row's premise was
 * inverted
 *
 * `plugins/overview.md#understand-install-scopes` publishes four scopes and
 * names a settings file for each: `user` "Personal plugins available across all
 * projects (default)", `project` "Team plugins shared via version control",
 * `local` "Project-specific plugins, gitignored when Claude Code saves a setting
 * to it", and `managed` "Managed plugins (read-only, update only)".
 *
 * How ours land against that table (measured at HEAD in
 * `capabilities/policy-store.ts`):
 *
 * | ours | stored in | the page's |
 * | --- | --- | --- |
 * | `user/global` | `CONFIG_DIR/capabilities.json` | `user` |
 * | `workspace` | `workspaces/<id>/capabilities.json` | no analogue |
 * | `project` | `CONFIG_DIR/capabilities.json` `projectOverrides[workspaceId]` | `local` |
 * | — | — | `project` (team-shared) — NOT OFFERED, see below |
 *
 * The row was filed as *"none of its three members is gitignored"*. Inverted:
 * all three live in the host config directory and are never written into a
 * repository at all, which is strictly stronger than gitignored. What has no
 * member here is the page's TEAM-SHARED `project` scope, and its absence is a
 * recorded refusal rather than an oversight — `policy-store.ts` states it
 * verbatim: "Plugin install/enable APIs MUST NOT write a project file; only
 * `recordGlobal`/`recordWorkspace`/`recordProjectOverride` (all in managed
 * storage) mutate policy." A repository contributes a READ-ONLY overlay
 * (`.nessy-agent/config.toml`) and only when it is trusted.
 *
 * So a fourth member writing `.claude/settings.local.json` would be wrong twice:
 * it is the file of the vendored runtime's OWN plugin tree, which this fork
 * bypasses (`plugins: []`) — the same "seed a store nothing reads" trap P6.418
 * names — and it would put activation state inside a repository for the first
 * time, which is a product posture, not a lane's call.
 */
export type PluginScope = 'user/global' | 'workspace' | 'project';

export const PLUGIN_SCOPES: readonly PluginScope[] = ['user/global', 'workspace', 'project'] as const;

/**
 * P6.414 — the scopes an INSTALL offers, and the ONE list that says so.
 *
 * Q-den 50 was decided **A**: "offer the choice at install time (for me / for
 * this repository / for me in this repository only)" rather than letting one
 * store plus an enablement scope stand in for it. The wire has carried the
 * answer all along — `SafeMarketplacePluginInstallRequest.activateIn` reaches
 * `service.install({ activateIn })` through `rpc/marketplace.ts` — so what was
 * missing is only the OFFER: the renderer computed a scope for the user from
 * the listing's kind and never asked.
 *
 * The order is widest-first, which is also the page's default-first order
 * (`user` is its "(default)"), and since P6.752 it is {@link PLUGIN_SCOPES}'s
 * order rather than a second copy of it.
 * {@link PLUGIN_INSTALL_SCOPE_NOT_SHARED_KEY} records, per row, the one thing a
 * user could otherwise assume wrongly: none of these is the page's team-shared
 * `project` scope, so picking the narrowest does not mean the others are shared
 * — they are all private to this user. (That sentence named a
 * `narrowerThanShared` field until P6.752; no such field was ever declared, and
 * a comment naming a field that does not exist is how a reader is sent looking
 * for a control that is really a copy key.)
 */
export interface PluginInstallScopeOffer {
  scope: PluginScope;
  /** i18n key for the choice's label. */
  labelKey: string;
  /** i18n key for the one sentence under it. */
  hintKey: string;
}

/**
 * P6.752 — the copy for each scope, keyed by the scope rather than listed
 * beside it.
 *
 * `PLUGIN_INSTALL_SCOPE_OFFERS` used to be a hand-written array of three, and
 * {@link PLUGIN_SCOPES} — the list that says how many scopes the product HAS —
 * was exported and read by nothing but one renderer test asserting the two
 * agreed. That test is the right assertion in the wrong place: it can only fail
 * AFTER a fourth scope has shipped without an offer, and only if someone runs
 * the renderer suite.
 *
 * A `Record<PluginScope, …>` makes the same claim at COMPILE time and in the
 * package that owns both lists: a fourth `PluginScope` is a type error here
 * until its label and hint exist, and the offers below are then derived from
 * `PLUGIN_SCOPES` so it appears in the picker in the same order, without a
 * second edit. Deriving is also why the widest-first order is stated once
 * rather than twice.
 */
const PLUGIN_INSTALL_SCOPE_COPY: Record<PluginScope, Omit<PluginInstallScopeOffer, 'scope'>> = {
  'user/global': { labelKey: 'plugins.installScopeMe', hintKey: 'plugins.installScopeMeHint' },
  workspace: { labelKey: 'plugins.installScopeWorkspace', hintKey: 'plugins.installScopeWorkspaceHint' },
  project: { labelKey: 'plugins.installScopeProject', hintKey: 'plugins.installScopeProjectHint' },
};

export const PLUGIN_INSTALL_SCOPE_OFFERS: readonly PluginInstallScopeOffer[] = PLUGIN_SCOPES.map(
  scope => ({ scope, ...PLUGIN_INSTALL_SCOPE_COPY[scope] }),
);

/**
 * The sentence stating the divergence where the user meets it: every offered
 * scope is stored in the user's own settings, so none of them shares the plugin
 * with anyone else who opens the project.
 */
export const PLUGIN_INSTALL_SCOPE_NOT_SHARED_KEY = 'plugins.installScopeNotShared';

export type PluginLifecycleState =
  | 'resolved'
  | 'staged'
  | 'installed'
  | 'trusted'
  | 'enabled'
  | 'projected';

export const PLUGIN_LIFECYCLE: readonly PluginLifecycleState[] = [
  'resolved',
  'staged',
  'installed',
  'trusted',
  'enabled',
  'projected',
] as const;

export type PluginDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface PluginDiagnostic {
  severity: PluginDiagnosticSeverity;
  code: string;
  message: string;
  path?: string;
  details?: Record<string, unknown>;
}

export type PluginOriginSource =
  | 'marketplace'
  | 'url'
  | 'repository'
  | 'local-path'
  | 'agent-proposed'
  /**
   * `plugins-reference.md` § Skills-directory plugins — "Any folder under a
   * skills directory that contains a `.claude-plugin/plugin.json` manifest is
   * loaded as a plugin named `<name>@skills-dir` on the next session, with no
   * marketplace and no install step. … the plugin is discovered in place rather
   * than copied into the plugin cache."
   *
   * RESERVED, not yet produced, and the spelling is the load-bearing part: it is
   * the marketplace segment of `pluginKeyFor('skills-dir', name)` (which is what
   * makes the documented key `<name>@skills-dir`), and it is the value the
   * documented admin control names: "Admins can block this source with
   * `strictKnownMarketplaces` or by adding `{"source": "skills-dir"}` to
   * `blockedMarketplaces` in managed settings" (`plugins-reference.md`
   * § `plugin init`). Both of those are strings on disk, so the name must be
   * fixed before either half ships or the two halves disagree.
   *
   * What is missing (finding f054, none of it in this package): the scanner that
   * stats `<skills-dir>/<name>/.claude-plugin/plugin.json` and stops emitting
   * such a folder as a plain skill (`capabilities/native-sources.ts`); the
   * ephemeral, registry-free installed entry that carries it into projection
   * (`server-core/bootstrap/storage-runtime.ts`); the integrity decision for an
   * in-place, user-editable bundle whose hash changes on every save
   * (`capabilities/materializer.ts`); and the managed-policy arm that currently
   * drops `{"source": "skills-dir"}` as an unsupported source
   * (`agent/pi-harness/managed-marketplace-entries.ts`).
   */
  | 'skills-dir'
  | 'unknown';

export interface PluginOrigin {
  source: PluginOriginSource;
  marketplaceId?: string;
  marketplaceBaseUrl?: string;
  sourceUrl?: string;
  repositoryUrl?: string;
  localPath?: string;
  adapterId?: string;
  adapterVersion?: string;
  resolvedAt: number;
  provenance?: Record<string, string | number | boolean | null>;
  /**
   * The marketplace entry that defined this plugin (S9), recorded on the origin
   * because the origin is what the installed record persists. Without it an
   * adapter-version migration would re-normalize the cached bundle ALONE and
   * silently replace a plugin's entry-declared components with nothing —
   * `PluginInstalledEntry` carries no install source to recover them from.
   */
  marketplaceEntry?: PluginMarketplaceEntryDefinition;
}

export interface PluginTrustProvenance {
  source: PluginOriginSource;
  marketplaceId?: string;
  marketplaceBaseUrl?: string;
  sourceUrl?: string;
  repositoryUrl?: string;
  adapterId?: string;
  rawManifestHash?: string;
  normalizedManifestHash?: string;
}

export interface PluginCapabilityTrustRequirement {
  required: boolean;
  reason?: string;
  executablePath?: string;
  executableHash?: string;
}

interface PluginCapabilityBase {
  id: string;
  kind: PluginCapabilityKind;
  displayName?: string;
  description?: string;
  enabledByDefault?: boolean;
  trust?: PluginCapabilityTrustRequirement;
}

export type PluginCapabilityKind =
  | 'skill'
  | 'mcp'
  | 'hook'
  | 'agent'
  | 'prompt-command'
  | 'workflow'
  | 'setting'
  | 'command'
  | 'asset'
  | 'lsp'
  | 'monitor'
  | 'output-style'
  | 'unsupported';

export interface PluginSkillDescriptor {
  slug: string;
  path: string;
  entrypoint?: string;
  /**
   * Invocation restrictions the skill's own author declared in its `SKILL.md`
   * frontmatter. Read through `readSkillInvocationControls` — the single reader
   * of these field names — and never widened here: absent means "not stated", so
   * the documented defaults apply (`disableModelInvocation: false`,
   * `userInvocable: true`).
   *
   * `allowedTools` is carried because R17b made `allowed-tools` an enforced
   * grant; leaving it out made an imported plugin skill enforced at invocation
   * but silent in the capability view. `paths` gates the same skill's automatic
   * activation (`skills.md:267`).
   */
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  allowedTools?: string[];
  paths?: string[];
}

export type PluginUserConfigurationValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'file'
  | 'directory'
  | 'secret-ref';

/**
 * One user-configurable plugin option.
 *
 * Two formats land here. MCPB's `user_config` was first and encodes secrecy in
 * `valueType: 'secret-ref'`; Claude's `userConfig`
 * (`plugins/manifest-reference.md#user-configuration`) keeps the declared type and sets
 * `sensitive` instead. Read the sensitivity question through
 * `isSensitivePluginConfigurationField` — never by comparing `valueType`.
 *
 * MCPB values are stored only in CredentialManager. Claude values follow the
 * documented split at `:589`/`:591`: sensitive to the credential store,
 * everything else to the user-scoped option file.
 */
export interface PluginUserConfigurationDescriptor {
  key: string;
  valueType: PluginUserConfigurationValueType;
  required?: boolean;
  /** Imported non-secret default; never present for secret-ref or sensitive. */
  defaultValue?: string | number | boolean | string[];
  /** `:569` — label shown in the configuration dialog. */
  title?: string;
  /** `:570` — help text shown beneath the field. */
  description?: string;
  /** `:571` — masks input and stores the value in secure storage. */
  sensitive?: boolean;
  /** `:574` — `string` type only: the value is an array of strings. */
  multiple?: boolean;
  /** `:575` — `number` type only: inclusive bounds. */
  min?: number;
  max?: number;
}

export interface PluginMcpDescriptor {
  serverName: string;
  transport: 'stdio' | 'http' | 'sse' | 'ws';
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  /**
   * C3 (capability-path): declared endpoint auth for an http/sse server. An
   * 'oauth'/'bearer' server binds to its GLOBAL plugin credential slot
   * (`plugin_mcp_*::{pluginKey}::{serverName}`); the pool injects
   * `Authorization: Bearer` from that slot and surfaces the server in
   * `externalAuthRequirements` while the slot is empty. Never set on stdio.
   */
  authType?: 'oauth' | 'bearer';
  /** Explicit RFC 8707 protected-resource indicator for OAuth discovery. */
  oauthResource?: string;
  /** Pre-registered OAuth client id (skips dynamic client registration). */
  clientId?: string;
  env?: Record<string, string>;
  /** Non-secret imported descriptor defaults; caller environment wins. */
  environmentDefaults?: Record<string, string>;
  /** Child environment name to optional host source name forwarding map. */
  environmentSources?: Record<string, string>;
  /** Child environment name to MCPB user-config key; values stay in CredentialManager. */
  credentialEnvironment?: Record<string, string>;
  /** Field metadata only. No configured value is ever persisted in the manifest. */
  userConfiguration?: PluginUserConfigurationDescriptor[];
  /** Names declared as required by the imported bundle; values never live here. */
  requiredEnvironmentNames?: string[];
  /** Per-tool call timeout imported from the plugin descriptor. */
  toolTimeoutMs?: number;
  /** Upstream startup criticality metadata; Nessy keeps per-capability fail-soft semantics. */
  required?: boolean;
  /** Pin this server's tools past deferred tool loading. */
  alwaysLoad?: boolean;
  headers?: Record<string, string>;
  /**
   * `mcp.md:768`: shell command generating dynamic connection headers at
   * connect time; remote transports only. Never a secret itself — a
   * `${user_config.*}` reference inside it is refused at import
   * (`mcp.md:818`), and `user-config-substitution.ts` never substitutes into
   * it. The runtime materializer resolves cwd/plugin root (`mcp.md:816`).
   */
  headersHelper?: string;
}

export interface PluginHookDescriptor {
  id: string;
  event: string;
  type: 'command' | 'http' | 'mcp' | 'prompt' | 'agent';
  matcher?: string;
  command?: string;
  args?: string[];
  timeoutMs?: number;
  statusMessage?: string;
  cwd?: string;
  /**
   * Background command hook (hooks.md `async`): runs without blocking and its
   * output is never parsed for a decision. Command hooks only.
   */
  async?: boolean;
  /**
   * hooks.md `asyncRewake`: implies `async`, and the import path stores both
   * (`schema.ts`, `format-adapters/claude.ts`).
   *
   * ## What it means, verbatim
   *
   * `hooks.md#command-hook-fields`: *"If `true`, runs in the background and
   * wakes Claude on exit code 2. The hook's stderr, or stdout if stderr is
   * empty, is shown to Claude as a system reminder so it can react to a
   * long-running background failure"*. `hooks.md#limitations` gives the rule the
   * flag is an exception TO: *"Hook output is delivered on the next conversation
   * turn. If the session is idle, the response waits until the next user
   * interaction. Exception: an `asyncRewake` hook that exits with code 2 wakes
   * Claude immediately even when the session is idle."* Anchors verified on the
   * rendered page 2026-09-12 (516 published ids; fabricated control 0).
   *
   * ## C3.301 (2026-09-12) — BUILT, and the three stop points C3.283 measured
   *
   * C3.283 traced the flag dying in three places and refused the build on size.
   * All three are closed, and they are named here because the next reader will
   * otherwise look in the wrong one:
   *
   * 1. `pluginHookAction` (`capabilities/runtime-automations.ts`) now carries
   *    the flag onto the action, and `HookCommandAction`
   *    (`automations/types.ts`) declares it.
   * 2. The `action.async` branch of `executePluginHookAutomations`
   *    (`plugins/hooks-automation.ts`) awaits the run instead of discarding it,
   *    and hands the result to `emitAsyncHookNotes` — which is also what makes
   *    the page's delivery for a PLAIN `async` hook happen
   *    (`#how-async-hooks-execute`: *"Claude Code delivers the
   *    `additionalContext` and `systemMessage` fields from the hook's JSON
   *    response to Claude on the next conversation turn"*). One seam, two
   *    clauses, and the second was the larger of the two omissions.
   * 3. The seam gained the out-of-band emitter it had no field for:
   *    `asyncHookNoteEmitter` on `PluginScopedAutomationSystemOptions`, wired at
   *    the host's one construction site to
   *    `SessionManager.deliverAsyncHookNote`. The WAKE itself was never missing
   *    — `SessionManager.deliverMonitorEvent` already starts a turn for an idle
   *    session and groups into the next turn for a busy one — so the `'rewake'`
   *    note rides it unchanged, while a `'delivery'` note takes the same queue
   *    WITHOUT the flush, because the page's rule for it is the next user
   *    interaction and not a wake.
   *
   * The capability ledger's G19 moves back with this: the background half ran
   * before, and both documented deliveries run now.
   */
  asyncRewake?: boolean;
  /**
   * Which exit-code contract a COMMAND hook was authored against. Absent means
   * the Nessy-native one: ANY non-zero exit blocks. `'claude-three-way'` is
   * hooks.md § Exit code output — 0 parses stdout, 2 blocks with stderr fed to
   * the model, and every other non-zero is a non-blocking error.
   *
   * It is a FORMAT identity, so only the Claude adapter sets it. Applying
   * Claude's three-way contract to every imported hook is how Codex and native
   * `nessy-plugin.json` hooks silently stopped blocking on exit 1.
   */
  exitCodeContract?: 'claude-three-way';
  /**
   * hooks.md § Command hook fields, `shell`: "Shell to use for this hook.
   * Accepts `"bash"` or `"powershell"`." — and, second sentence of the same
   * row, "Ignored when `args` is set", so exec form never reads it. Absent
   * keeps the platform default spawn. Validated at import: an unknown value is
   * a registration diagnostic, never a silent default.
   */
  shell?: 'bash' | 'powershell';
  /**
   * UB12.67 — hooks.md `onFailure` on a `command` or `http` hook: `'block'`
   * makes a failed run (cannot start, an exit other than 0 or 2, an http
   * error, a timeout, unreadable JSON) do what exit 2 does on its event. Only
   * `'block'` is stored; absent is the documented default `"continue"`. Codex's
   * hook handler has no such field (`ConfiguredHookHandler`), so only the
   * Claude adapter and a native manifest set it.
   */
  onFailure?: 'block';
  /**
   * hooks.md `once`: honoured for skill-frontmatter hooks only, which
   * `capabilities/runtime-skill-content.ts` splits into a run-once tier. On a
   * PLUGIN hook it is stored and then ignored (Claude ignores it in settings
   * files too) — and nothing says so out loud: the `plugin.hooks.once_ignored`
   * diagnostic this comment used to promise was emitted only by the deleted V1
   * registration path. The rule still holds; only the message is gone.
   */
  once?: boolean;
  /**
   * hooks.md `if`: a single permission-rule filter on tool events, and it IS
   * evaluated — `hooks-automation.ts`'s `hookIfFilterRuns` runs
   * `evaluateClaudeHookIfFilter` per invocation, and a hook carrying `if` on a
   * NON-tool event produces no action at all (`pluginHookConfig` in
   * `capabilities/runtime-automations.ts`). Only an UNPARSEABLE rule still fails
   * open, and since P2.288 that one IS reported, twice and deliberately: at
   * REGISTRATION by `plugin.hook.if_unparseable_fail_open` (`schema.ts`, a
   * warning naming the rule — the author is present and the hook has not run),
   * and at EVALUATION by `reportUnparseableIfRule` (P2.277). The non-tool-event
   * drop is still silent. `plugin.hooks.if_deferred`, which this comment used to
   * promise, described the pre-parser deferral and was already stale before the
   * V1 registration path that emitted it was deleted.
   */
  ifRule?: string;
  /**
   * Literal one-shot prompt body for a `prompt` hook (B1). Injected as hidden
   * observational context on the bound event through the existing decision
   * `additionalContext` path — never a subprocess, never a second
   * prompt-assembly owner. With an injected prompt-decision runner (R22) the
   * body is judged by a fast model whose `ok:false` blocks the event.
   */
  prompt?: string;
  /** Model requested for a `prompt`/`agent` hook (hooks.md `model`, R22). */
  model?: string;
  /**
   * hooks.md `continueOnBlock` (default false) on `prompt`/`agent` hooks:
   * "Implemented as `continue: true` on the resulting `decision: block`".
   * Stored and inert today — our merge distinguishes only by decision value;
   * R9's per-event matrix consumes it.
   */
  continueOnBlock?: boolean;
  /**
   * Sub-agent name a `agent` hook spawns (B1). Resolved through the existing
   * child-session/subagent service via an injected runner — the hook never
   * gains a new spawn authority. Names the declared `agent` capability.
   */
  agentName?: string;
  /**
   * Fully-qualified MCP proxy tool name (`mcp__<server>__<tool>`) an `mcp`
   * hook invokes (B2). Qualified server name only — no short-alias bypass.
   * Invoked through the existing MCP pool via an injected runner.
   */
  mcpTool?: string;
  /** Static JSON arguments passed to the `mcp` hook's tool (B2). */
  mcpArgs?: Record<string, unknown>;
  /**
   * HTTP request an `http` hook fires (B2) under an explicit network
   * permission contract, bounded timeout + response size, through the
   * existing webhook executor. Denial has no side effect.
   */
  http?: {
    url: string;
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    headers?: Record<string, string>;
    body?: unknown;
    /**
     * Env-var names this hook may interpolate into its headers (R22). The
     * effective allowlist is the intersection with the managed
     * `httpHookAllowedEnvVars` policy key; unlisted references resolve to ''.
     */
    allowedEnvVars?: string[];
  };
}

export interface PluginSettingDescriptor {
  key: string;
  valueType: 'string' | 'number' | 'boolean';
  defaultValue?: string | number | boolean;
  required?: boolean;
}

export interface PluginCommandDescriptor {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface PluginAssetDescriptor {
  path: string;
  mediaType?: string;
  role?: 'icon' | 'image' | 'template' | 'data' | 'other';
}

/**
 * Language-server descriptor (B3). A plugin-declared LSP server materialized
 * through the EXISTING trusted-project LSP provisioner — never a second LSP
 * owner. `command`/`args` are the server launch; it runs under the same
 * supervised `workspace` isolation profile as other processes and activates
 * only for a trusted project/plugin. Every server owns a non-empty exact
 * language-id set, used for fail-closed routing.
 */
export interface PluginLspDescriptor {
  id: string;
  command: string;
  args?: string[];
  languages: string[];
  workingDirectory?: string;
  /**
   * `plugins-reference.md` § Environment variables names the four LSP fields the
   * documented path placeholders resolve in — "| LSP servers | `command`,
   * `args`, `env`, `workspaceFolder` |". These two complete that set. `env` is
   * the server subprocess environment; `workspaceFolder` is the folder the
   * server is given, which unlike `workingDirectory` may be rooted at the
   * PROJECT rather than at the bundle.
   *
   * Carried from import onward. Threading `env` into the LspService spawn is a
   * separate change and is still owed.
   */
  env?: Record<string, string>;
  workspaceFolder?: string;
  /**
   * P6.417 — the supervision knobs, carried as ONE field rather than seven, so
   * a new one is added in a single place at every hop between the adapter and
   * the process supervisor.
   *
   * Absent when the author declared none, which is the ordinary case: measured
   * on the published catalogues 2026-07-31, of 2307 community entries none
   * declare `lspServers` at all, and of the 276 official entries 12 do, of which
   * two declare exactly one of these (`startupTimeout`).
   */
  supervision?: PluginLspSupervision;
}

/**
 * P6.417 — `plugins-reference.md` § LSP servers, the optional fields a
 * SUPERVISOR reads, each quoted from the table it comes from.
 *
 * `transport` is deliberately NOT here. The page says *"`stdio` (default) or
 * `socket`. Claude Code accepts `socket` but runs every server over stdio, so
 * the stdout protocol rules apply to all servers"* — so honouring it means
 * ACCEPTING both values and running stdio either way, which is what this fork
 * already does. Carrying it would imply a choice nothing makes. What the
 * adapter does with it instead is REFUSE a third value, on the page's own rule
 * that *"Claude Code skips a server whose configuration is invalid"*.
 */
export interface PluginLspSupervision {
  /** *"Options passed to the server during initialization"* — the `initialize` request. */
  initializationOptions?: unknown;
  /** *"Settings passed via `workspace/didChangeConfiguration`"*. */
  settings?: unknown;
  /** *"Max time to wait for server startup (milliseconds)"*. */
  startupTimeout?: number;
  /**
   * *"Max time to wait for graceful shutdown (milliseconds). When the timeout
   * elapses, Claude Code terminates the server process. When unset, no timeout
   * applies"* — so ABSENT is unbounded, not a default number.
   */
  shutdownTimeout?: number;
  /**
   * *"Whether to restart the server after it crashes. Defaults to `true`. Set to
   * `false` to leave a crashed server stopped instead of restarting it"* — so
   * absent is TRUE, and only an explicit `false` stops a restart.
   */
  restartOnCrash?: boolean;
  /** *"Maximum number of restart attempts before giving up"*. */
  maxRestarts?: number;
  /**
   * *"Whether to push diagnostics into Claude's context after edits (default
   * `true`). Set to `false` to keep code navigation but suppress automatic
   * diagnostic injection"* — the one field that removes a behaviour rather than
   * bounding one, so absent is TRUE here too.
   */
  diagnostics?: boolean;
}

/**
 * Sub-agent descriptor (A2). Provider-neutral IR for a bundled agent
 * definition file — distinct from the native `agent` capability source kind
 * used by managed/workspace `.agents` inventories.
 */
export interface PluginAgentDescriptor {
  name: string;
  path: string;
  model?: string;
  tools?: string[];
}

/**
 * Prompt-command descriptor (A2). A Markdown/prompt-driven command definition
 * distinct from the executable `command` capability: this is data (a prompt
 * template), never a subprocess invocation, and never reuses
 * `PluginCommandDescriptor`.
 */
export interface PluginPromptCommandDescriptor {
  name: string;
  path: string;
  argumentHint?: string;
  model?: string;
}

export interface PluginWorkflowDescriptor {
  name: string;
  path: string;
}

/**
 * Retained-but-unsupported capability (A2). Preserves safe provider metadata
 * for a capability kind this runtime cannot execute yet, so normalization
 * never silently drops it. `executable` records whether the source provider
 * treats the underlying artifact as executable (informational only — this
 * capability kind is never run).
 */
export interface PluginUnsupportedDescriptor {
  externalKind: string;
  sourcePath?: string;
  reasonCode: string;
  executable: boolean;
}

export interface PluginSkillCapability extends PluginCapabilityBase {
  kind: 'skill';
  skill: PluginSkillDescriptor;
}

export interface PluginMcpCapability extends PluginCapabilityBase {
  kind: 'mcp';
  mcp: PluginMcpDescriptor;
}

export interface PluginHookCapability extends PluginCapabilityBase {
  kind: 'hook';
  hook: PluginHookDescriptor;
}

export interface PluginAgentCapability extends PluginCapabilityBase {
  kind: 'agent';
  agent: PluginAgentDescriptor;
}

export interface PluginPromptCommandCapability extends PluginCapabilityBase {
  kind: 'prompt-command';
  promptCommand: PluginPromptCommandDescriptor;
}

export interface PluginWorkflowCapability extends PluginCapabilityBase {
  kind: 'workflow';
  workflow: PluginWorkflowDescriptor;
}

export interface PluginSettingCapability extends PluginCapabilityBase {
  kind: 'setting';
  setting: PluginSettingDescriptor;
}

export interface PluginCommandCapability extends PluginCapabilityBase {
  kind: 'command';
  command: PluginCommandDescriptor;
}

export interface PluginAssetCapability extends PluginCapabilityBase {
  kind: 'asset';
  asset: PluginAssetDescriptor;
}

export interface PluginLspCapability extends PluginCapabilityBase {
  kind: 'lsp';
  lsp: PluginLspDescriptor;
}

/**
 * A trusted, explicit-schedule, live-session-only plugin monitor: a bundle text
 * resource delivered into an already-running turn on a cron. This is the NATIVE
 * `nessy-plugin.json` form and has no Claude equivalent — Claude monitors carry
 * no schedule at all.
 */
export interface PluginScheduledMonitorDescriptor {
  form?: 'schedule';
  id: string;
  path: string;
  cron: string;
  timezone?: string;
}

/**
 * Claude's `experimental.monitors` entry (`plugins/components.md#monitors`): a
 * shell command run as a persistent background process for the lifetime of the
 * session, every stdout line of which reaches the agent as a notification.
 *
 * `id` is the documented `name` — "Identifier unique within the plugin. Prevents
 * duplicate processes when the plugin reloads or a skill is invoked again"
 * (`:322`), which is why the host keys its start-once set on it rather than on a
 * generated handle. `description` is `:324`'s task-panel/notification summary.
 *
 * `when` is `:330`. `'always'` is the default and "starts it at session start and
 * on plugin reload"; `'on-skill-invoke:<skill-name>'` starts it the first time
 * that skill is dispatched. The second trigger has no dispatch seam here yet, so
 * such a monitor is carried, reported as deferred, and never started — the one
 * behaviour that is unambiguously safe for a trigger we cannot observe.
 */
export interface PluginCommandMonitorDescriptor {
  form: 'command';
  id: string;
  command: string;
  description: string;
  when: 'always' | `on-skill-invoke:${string}`;
}

export type PluginMonitorDescriptor =
  | PluginScheduledMonitorDescriptor
  | PluginCommandMonitorDescriptor;

/** Narrow a monitor descriptor to Claude's command form. */
export function isCommandMonitorDescriptor(
  monitor: PluginMonitorDescriptor,
): monitor is PluginCommandMonitorDescriptor {
  return monitor.form === 'command';
}

export interface PluginMonitorCapability extends PluginCapabilityBase {
  kind: 'monitor';
  monitor: PluginMonitorDescriptor;
}

/**
 * A plugin-shipped output style (`plugins/components.md#themes-and-output-styles`'s `outputStyles`,
 * `output-styles.md` § Create a custom output style).
 *
 * `name` is `output-styles.md:49`'s style name — the frontmatter `name`, or the
 * file name when it says nothing. The SELECTABLE id (`plugin:<pluginKey>:<slug>`)
 * is deliberately NOT stored here: the plugin key is decided by the store at
 * install (`pluginKeyFor(origin.marketplaceId ?? input.marketplaceId ?? 'local',
 * manifest.id)`), which an adapter cannot see in full, so a manifest-time copy
 * could disagree with the installed key and strand the selection. It is composed
 * at projection, where `entry.pluginKey` is authoritative.
 *
 * `keepCodingInstructions` is carried for DISPLAY and for the compatibility
 * record only. The prompt builder re-reads it from the pinned file content at
 * turn time through the same reader a user-authored style goes through, so a
 * manifest can never assert a subtraction the file does not declare — and no
 * value of it can remove safety text, because the split
 * `getSafetyAndEngineeringSections` applies is per BULLET, not per section.
 *
 * `forceForPlugin` is `output-styles.md:94`, recorded and NEVER honoured: it
 * applies a style "without requiring users to select it. Overrides the user's
 * `outputStyle` setting", which is a plugin writing the highest-trust text in
 * the turn unattended.
 */
export interface PluginOutputStyleDescriptor {
  name: string;
  path: string;
  keepCodingInstructions?: boolean;
  forceForPlugin?: boolean;
}

export interface PluginOutputStyleCapability extends PluginCapabilityBase {
  kind: 'output-style';
  outputStyle: PluginOutputStyleDescriptor;
}

export interface PluginUnsupportedCapability extends PluginCapabilityBase {
  kind: 'unsupported';
  unsupported: PluginUnsupportedDescriptor;
}

export type PluginCapability =
  | PluginSkillCapability
  | PluginMcpCapability
  | PluginHookCapability
  | PluginAgentCapability
  | PluginPromptCommandCapability
  | PluginWorkflowCapability
  | PluginSettingCapability
  | PluginCommandCapability
  | PluginAssetCapability
  | PluginLspCapability
  | PluginMonitorCapability
  | PluginOutputStyleCapability
  | PluginUnsupportedCapability;

export interface PluginAdapterProvenance {
  adapterId: string;
  adapterVersion?: string;
  rawKind?: string;
  rawManifestPath?: string;
  rawManifestHash?: string;
  normalizedManifestHash?: string;
  warnings?: PluginDiagnostic[];
}

/**
 * First-class app/connector descriptor (W7 Step 5). Carries connector IDs and
 * routing only — activation NEVER synthesizes authorization.
 */
export interface PluginAppDescriptor {
  id: string;
  displayName?: string;
  connectorId: string;
  routing?: Record<string, string>;
}

/**
 * Auth timing for a connector (K1). `ON_INSTALL` vs `ON_FIRST_USE` is a TIMING
 * hint only — it decides WHEN the runtime offers the existing source OAuth flow,
 * never WHETHER the connector is trusted. Denial at either timing is
 * side-effect-free (the connector simply stays unauthenticated). No timing value
 * ever grants a credential.
 */
export type PluginConnectorAuthTiming = 'ON_INSTALL' | 'ON_FIRST_USE';

/**
 * Declarative connector auth policy (K1). `type` reuses the EXISTING source auth
 * kinds — `oauth` binds through the source OAuth path
 * (`prepareMcpOAuth`/`exchangeMcpOAuth`), `bearer` through a server-owned token,
 * `none` needs no credential. This is DATA: it never carries a secret and never
 * names a credential store — the server-owned `SourceCredentialManager` remains
 * the single credential authority.
 */
export interface PluginConnectorAuthDescriptor {
  type: 'oauth' | 'bearer' | 'none';
  timing?: PluginConnectorAuthTiming;
}

/**
 * One MCP server a connector is backed by (K1). Declarative endpoint only —
 * `serverName` is the connector-local logical key an app routes to; `transport`
 * + `url`/`command` describe how the EXISTING `createSource` + MCP pool
 * materialize it. A connector is NEVER executable factory code; it is a
 * declaration the closed host projects into a normal MCP-backed source.
 */
export interface PluginConnectorMcpServerDescriptor {
  serverName: string;
  // Not `ws`: a connector materializes into a normal MCP-backed SOURCE, and
  // `McpTransport` (sources/types.ts) has no ws member. A ws plugin server
  // reaches the pool through the capability runtime, not through a source.
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  /** Explicit OAuth protected-resource indicator/discovery target (RFC 8707/9728). */
  oauthResource?: string;
  /** Optional public OAuth client ID for servers that do not support dynamic registration. */
  clientId?: string;
  command?: string;
  args?: string[];
  /**
   * Per-server wall clock for one tool call, in milliseconds (`mcp.md:238`).
   * Carried so promoting a remote MCP capability to a connector does not drop
   * the author's configured ceiling; surfaces as `McpSourceConfig.timeoutMs`.
   */
  toolTimeoutMs?: number;
}

/**
 * First-class connector descriptor (K1). A connector is a DECLARATIVE, MCP-backed
 * source bundle: an id, the MCP servers it exposes, and an optional auth policy.
 * Apps route only to the connector's declared `mcpServers[].serverName`; nothing
 * an app declares can reach beyond this list. Carries no secret and no factory
 * code.
 */
export interface PluginConnectorDescriptor {
  id: string;
  displayName?: string;
  description?: string;
  mcpServers: PluginConnectorMcpServerDescriptor[];
  auth?: PluginConnectorAuthDescriptor;
}

/**
 * Namespaced Nessy-only extensions (W7 Step 5). The generic Codex-compatible
 * core manifest surface is `skills`, `mcpServers`, `apps` and `hooks`. The
 * `setting`/`command`/`asset` adapters are Nessy extensions and are declared
 * ONLY here — a generic Codex manifest never gains them accidentally.
 */
/**
 * A plugin's own DEFAULT settings — `plugins-reference.md` § File locations
 * reference's `settings.json` row ("Default configuration applied when the
 * plugin is enabled") and `plugins.md` § Ship default settings with your plugin.
 *
 * Distinct from `PluginSettingDescriptor`, which is an MCPB-style option the
 * USER fills in. This is a value the PLUGIN asserts on the user's behalf, so it
 * is a different thing with a different trust story and gets its own shape.
 *
 * Only `agent` is carried. The docs support exactly two keys, `agent` and
 * `subagentStatusLine`, and every other key is dropped at normalization because
 * the same section says "Unknown keys are silently ignored".
 * `subagentStatusLine` is deliberately not carried even though it is supported:
 * its value is an executable declaration (`statusline.md` § Subagent status
 * lines — `{ "type": "command", "command": "…" }`) and this fork renders no
 * status line at all, so recording the command would put an unrunnable,
 * untrusted executable string in the IR. Its declaration is recorded on the
 * compatibility report instead.
 *
 * `agent` is RECORDED and NEVER honoured, for the reason already on record for
 * `PluginOutputStyleDescriptor.forceForPlugin`: `plugins.md` has it "activate
 * one of the plugin's custom agents as the main thread, applying its system
 * prompt, tool restrictions, and model", which is a plugin writing the
 * highest-trust text in the turn without the user selecting it — with more reach
 * than the output-style case this fork already refuses. Honouring it needs an
 * owner decision plus a user-visible, reversible offer; until then the author is
 * told at install (`plugin.format.claude_settings_agent_unsupported`) rather
 * than shipping a plugin that silently does nothing.
 */
export interface PluginDefaultSettingsDescriptor {
  agent?: string;
}

export interface PluginNessyExtensions {
  settings?: PluginSettingDescriptor[];
  commands?: PluginCommandDescriptor[];
  assets?: PluginAssetDescriptor[];
  /**
   * `plugins.md` § Ship default settings with your plugin. Merged
   * file-over-manifest (`settings.json` outranks `plugin.json`'s `settings`) and
   * key-filtered before it reaches here.
   */
  defaultSettings?: PluginDefaultSettingsDescriptor;
  /**
   * Plugin-level user options (`plugins/manifest-reference.md#user-configuration`'s `userConfig`).
   * MCPB hangs its own `user_config` off the single MCP capability it produces;
   * a Claude bundle declares options for the whole plugin, so they live here.
   * Field metadata only — no configured value is ever persisted in a manifest.
   */
  userConfiguration?: PluginUserConfigurationDescriptor[];
}

/**
 * Required runtime semantics for a bundled executable (A2). A profile is
 * PURELY semantic — it names which canonical environment-variable aliases a
 * runtime must expose. It carries NO adapterId, origin or format field, and
 * MUST NOT be read as (or derived from) provider provenance: two manifests
 * that differ only in adapter/origin but declare the same profile set are
 * runtime-identical. A6 reads `profiles` to pick env aliases; A2 only defines
 * and validates the type (see `validatePluginRuntimeCompatibility` in
 * schema.ts).
 */
export type PluginRuntimeCompatibilityProfile =
  | 'generic-plugin-env-v1'
  | 'codex-plugin-env-v1'
  | 'claude-plugin-env-v1';

export interface PluginRuntimeCompatibility {
  profiles: PluginRuntimeCompatibilityProfile[];
}

/**
 * One declared plugin dependency (`plugins/manifest-reference.md#dependencies`).
 *
 * The manifest form is "either a plugin name or an object with a version
 * constraint" (`:25`); a bare string normalizes to `{ name }`.
 *
 * `version` is "a semver range … The dependency is fetched at the highest tagged
 * version that satisfies this range" (`:45`). Nessy fetches nothing here — no
 * marketplace source enumerates `{plugin-name}--v{version}` git tags — so the
 * range is used for the OTHER half the docs give it: the load-time check that
 * disables the dependent plugin with `dependency-version-unsatisfied` when the
 * installed dependency falls outside it (`:137`, `:214`).
 *
 * `versionRangeValid` is `false` when `version` is not parseable semver. Carried
 * rather than dropped because `:213`'s `range-conflict` explicitly covers "a
 * range is not valid semver syntax" and disables the plugin for it — dropping the
 * range would silently turn an authoring error into an unconstrained dependency.
 *
 * `marketplace` is `:46`'s cross-marketplace target. Nessy auto-installs nothing,
 * so `:81`'s refusal has no install to refuse; the field is carried so the check
 * has its input the day auto-install exists, and so the UI can say where a
 * missing dependency is expected to come from.
 */
export interface PluginDependencyDescriptor {
  name: string;
  version?: string;
  versionRangeValid?: boolean;
  marketplace?: string;
}

/**
 * The version a bundle gets when its manifest declares none.
 *
 * Claude's `plugin.json` makes `version` OPTIONAL — `plugins-reference.md`
 * § *Plugin manifest* requires `name` and nothing else — and real marketplace
 * bundles ship without one (`playwright`, measured). Our own schema requires it
 * (`schema.ts`: `plugin.manifest.missing_version` is an ERROR, and an error
 * rejects the manifest whole), and the value is load-bearing besides: it is a
 * segment of the plugin INSTANCE identity `plugin://<marketplace>/<id>@<version>#<hash>`
 * and of the on-disk cache path. So a bundle without one is given this rather
 * than being refused.
 *
 * It is therefore a placeholder for "the author declared nothing", never a fact
 * about the plugin, and USER-FACING SURFACES MUST NOT PRINT IT. The plugin
 * detail page omits its Version row for exactly this value, which is what every
 * other absent field on that surface already does — `description`, `publisher`
 * and `homepageUrl` are omitted rather than invented by the same adapter, the
 * Capabilities row is pushed only when non-empty, and the marketplace detail
 * panel already guards its own version row with `if (detailItem.version)`.
 *
 * Named rather than repeated as a bare `'0.0.0'` so that the fabrication sites
 * and the one display rule that reads them cannot drift apart.
 */
export const UNDECLARED_PLUGIN_VERSION = '0.0.0';

/**
 * P6.577 — the OTHER placeholder, and the page's own spelling for it:
 * `plugins/loading.md#how-claude-code-computes-the-version` step 5 is "`unknown`, for `npm`
 * sources or local directories not inside a git repository".
 *
 * Deliberately a different string from {@link UNDECLARED_PLUGIN_VERSION}, which
 * means "the bundle declared no version" — an INPUT to the resolution chain.
 * This one means "the chain ran and no step could answer", which is a different
 * fact with a different remedy (declare a version, versus publish from a source
 * that has one). The chain that produces it is
 * `plugins/plugin-version-chain.ts`.
 *
 * It lives here, beside its twin, so a display rule can ask ONE module whether a
 * version string names a version — see {@link isPlaceholderPluginVersion}.
 */
export const UNKNOWN_PLUGIN_VERSION = 'unknown';

/**
 * Whether a version string names no version at all — either placeholder.
 *
 * The one predicate every display rule and comparison should ask, so a third
 * spelling can never leak past a surface that only knew about two.
 */
export function isPlaceholderPluginVersion(version: string | undefined): boolean {
  return version === UNDECLARED_PLUGIN_VERSION || version === UNKNOWN_PLUGIN_VERSION;
}

export interface NessyPluginManifest {
  schemaVersion: typeof PLUGIN_MANIFEST_SCHEMA_VERSION;
  kind: 'plugin';
  id: string;
  name: string;
  /** May be {@link UNDECLARED_PLUGIN_VERSION} — see that constant before displaying it. */
  version: string;
  description?: string;
  publisher?: string;
  homepageUrl?: string;
  capabilities: PluginCapability[];
  /**
   * Author's opt-in/opt-out default — Claude's documented `defaultEnabled`
   * (`plugins-reference.md` § Default enablement). `undefined` means the author
   * stated no opinion, which the contract treats as `true`; only an explicit
   * `false` ships a plugin that installs disabled, "for plugins that add cost or
   * scope a user should opt into, such as one that connects to an external
   * service".
   *
   * A user's own enablement entry outranks this either way, and once written it
   * "persists across plugin updates and reinstalls, so changing `defaultEnabled`
   * in a later release does not flip an existing user".
   */
  defaultEnabled?: boolean;
  /**
   * Plugins this plugin depends on (`plugins/manifest-reference.md#dependencies`-`:48`).
   *
   * "Besides the required `name`, a plugin manifest can consist of only a
   * `dependencies` array" (`:52`), which is why the field is carried even for a
   * bundle with zero capabilities.
   */
  dependencies?: PluginDependencyDescriptor[];
  /** First-class app/connector declarations (W7 Step 5). */
  apps?: PluginAppDescriptor[];
  /** First-class connector declarations (K1); MCP-backed, declarative only. */
  connectors?: PluginConnectorDescriptor[];
  /** Explicit namespaced Nessy extensions (setting/command/asset). */
  nessyExtensions?: PluginNessyExtensions;
  /** Required runtime env-alias semantics (A2); semantic only, never origin. */
  runtimeCompatibility?: PluginRuntimeCompatibility;
  compatibility?: {
    rawExternalKind?: string;
    adapter?: PluginAdapterProvenance;
  };
}

/**
 * Kind of a projected plugin candidate (W7 Step 6). The Codex core surface is
 * `skill`/`mcp`/`hook`/`app`; `setting`/`command`/`asset` come from
 * `nessyExtensions`; `agent`/`prompt-command` project as their own candidate
 * kinds (A2); a capability Pi cannot run is retained as `unsupported-runtime`
 * for catalog/provenance (never silently dropped).
 */
export type PluginProjectionCandidateKind =
  | 'skill' | 'mcp' | 'hook' | 'app'
  | 'agent' | 'prompt-command' | 'workflow'
  | 'setting' | 'command' | 'asset' | 'lsp' | 'monitor'
  | 'output-style'
  | 'unsupported-runtime';

/**
 * Ecosystem format a manifest/bundle was detected as (A2). Presentation and
 * compatibility-reporting only — NEVER a runtime discriminator; see
 * `PluginCompatibilityReport`.
 */
export type PluginEcosystemFormat = 'nessy' | 'codex' | 'claude' | 'unknown';

export type PluginCompatibilityState = 'supported' | 'partial' | 'blocked';

/**
 * A surface an adapter reports as supported (A2; extended by K1). Every
 * capability kind, plus the first-class declarative `app`/`connector` surfaces
 * once the runtime materializes them (K1). These are NOT capability kinds — an
 * app/connector is a declaration the closed host projects into an MCP-backed
 * source — so they widen the report's supported surface only, never
 * `PluginCapabilityKind`.
 */
export type PluginCompatibilitySupportedKind = PluginCapabilityKind | 'app' | 'connector';

/**
 * Lossless compatibility summary for one detected external format (A2).
 * `deferred`/`blocked` preserve safe provider metadata (external kind, reason
 * code, source path) for every capability this runtime does not fully
 * support — nothing is silently dropped.
 */
export interface PluginCompatibilityReport {
  format: PluginEcosystemFormat;
  state: PluginCompatibilityState;
  supportedKinds: PluginCompatibilitySupportedKind[];
  deferred: Array<{ externalKind: string; reasonCode: string; sourcePath?: string }>;
  blocked: Array<{ externalKind: string; reasonCode: string; sourcePath?: string }>;
}

/**
 * Plan-shape bundle normalization result (A2; Canonical Contracts "Format
 * adapters"). The plan names this exact type `PluginBundleNormalizationResult`,
 * which previously collided with a differently-shaped interface of the same
 * name in `format-adapters.ts` (adapter identity + raw IR, returned by
 * `normalizePluginBundle`). That existing type was renamed to
 * `PluginFormatBundleNormalizationResult` — a zero-ripple rename, since
 * nothing outside `format-adapters.ts` referenced it by name — so this type
 * can own the plan's canonical name here without an `export *` barrel
 * collision in `plugins/index.ts`. A4/A5 migrate `normalizePluginBundle`
 * callers onto this `compatibility`-shaped result.
 */
export interface PluginBundleNormalizationResult {
  manifest?: NessyPluginManifest;
  compatibility: PluginCompatibilityReport;
  diagnostics: PluginDiagnostic[];
}

/**
 * The plugin-defining half of a marketplace catalog entry (S9).
 *
 * `plugin-marketplaces.md` § Plugin entries (`:195`): "Each plugin entry in the
 * `plugins` array describes a plugin and where to find it. You can include any
 * field from the plugin manifest schema, such as `description`, `version`,
 * `author`, `commands`, and `hooks`, plus these marketplace-specific fields:
 * `source`, `category`, `tags`, `strict`, and `relevance`."
 *
 * So an entry is not only a locator: it is a manifest overlay. Before S9 only
 * `source` and the display name survived the parse, which is why a `strict:
 * false` entry — the case § Strict mode (`:520`) calls "the entire definition" —
 * installed a plugin with no capabilities at all.
 *
 * `fields` carries the entry's own manifest-shaped keys VERBATIM, so the format
 * adapter reads them with the same code that reads `plugin.json`. Only the keys
 * an adapter can act on are carried (see `MARKETPLACE_ENTRY_CARRIED_FIELDS`);
 * every component path in them has already been through B1a's containment gate
 * at catalog-parse time and is re-checked, symlinks included, at normalization.
 */
export interface PluginMarketplaceEntryDefinition {
  /**
   * `:520` — `false` means "The marketplace entry is the entire definition. If
   * the plugin also has a `plugin.json` that declares components, that's a
   * conflict and the plugin fails to load." Absent/`true` is `:519`'s merge.
   */
  strict?: boolean;
  /**
   * True when this entry's `source` resolved to the marketplace root itself.
   * `plugins/manifest-reference.md#how-each-key-combines-with-its-default-location` makes that the condition of the one place where
   * declared `skills` paths REPLACE the default scan instead of extending it.
   */
  sourceIsMarketplaceRoot?: boolean;
  /** Entry-level manifest-shaped fields, verbatim. */
  fields: Record<string, unknown>;
}

export interface PluginMarketplaceInstallMetadata {
  marketplaceId?: string;
  marketplaceBaseUrl?: string;
  itemId?: string;
  listKind?: 'skills' | 'plugins';
  itemKind?: 'skill' | 'plugin' | 'mcp' | 'hook';
  name?: string;
  version?: string;
  sourceUrl?: string;
  packageName?: string;
  /** The entry's own plugin definition (S9). Consumed at bundle normalization. */
  entry?: PluginMarketplaceEntryDefinition;
  raw?: unknown;
}

export type PluginInstallSource =
  | {
      kind: 'marketplace-npm-package';
      packageName: string;
      version?: string;
      registry?: string;
      integrity?: string;
      /**
       * True when the package coordinates were DERIVED from the marketplace
       * listing's repository path rather than published by it. Kept on the
       * source (and therefore on the installed record) so a later repair/update
       * can tell a guessed coordinate from a stated one.
       */
      derivedCoordinates?: boolean;
      marketplace?: PluginMarketplaceInstallMetadata;
    }
  | {
      kind: 'marketplace-gitlab-skill';
      url: string;
      ref?: string;
      path?: string;
      pluginId: string;
      skillSlug: string;
      name?: string;
      version?: string;
      marketplace?: PluginMarketplaceInstallMetadata;
    }
  | {
      /** skills-market v2 per-file snapshot listing (digest-verified files). */
      kind: 'marketplace-skill-files';
      filesUrl: string;
      pluginId: string;
      skillSlug: string;
      name?: string;
      version?: string;
      marketplace?: PluginMarketplaceInstallMetadata;
    }
  | {
      kind: 'marketplace-url';
      url: string;
      expectedHash?: string;
      marketplace?: PluginMarketplaceInstallMetadata;
    }
  | {
      kind: 'url';
      url: string;
      expectedHash?: string;
      /**
       * `plugins/host-marketplace.md#authenticate-archive-downloads`, **Archive
       * authentication fields:** — "HTTP headers Claude Code sends when it
       * downloads this entry's archive". Already filtered
       * (`plugins/archive-headers.ts`); sent on the archive URL's OWN origin
       * only, never across a redirect that leaves it.
       */
      headers?: Record<string, string>;
    }
  | {
      kind: 'repository';
      repositoryUrl: string;
      ref?: string;
      subdirectory?: string;
      marketplace?: PluginMarketplaceInstallMetadata;
    }
  | {
      kind: 'local-path';
      path: string;
      /** Listing provenance when a configured marketplace points at a local bundle. */
      marketplace?: PluginMarketplaceInstallMetadata;
    }
  | {
      kind: 'agent-proposed';
      label: string;
      source: PluginInstallSource;
      rationale?: string;
    }
  | {
      kind: 'unsupported';
      value: string;
      reason: string;
    };

export interface PluginArtifactSource {
  type: 'manifest-url' | 'archive-url' | 'repository' | 'local-path' | 'inline-manifest' | 'npm-package' | 'gitlab-skill' | 'skill-files' | 'unknown';
  url?: string;
  /** skill-files: the market v2 per-file snapshot listing URL. */
  filesUrl?: string;
  path?: string;
  manifestUrl?: string;
  manifestPath?: string;
  repositoryUrl?: string;
  manifest?: unknown;
  packageName?: string;
  version?: string;
  registry?: string;
  integrity?: string;
  ref?: string;
  skillSlug?: string;
  pluginId?: string;
  name?: string;
  expectedHash?: string;
  /** archive-url: the entry's own, already-filtered archive request headers. */
  headers?: Record<string, string>;
  display?: string;
}

export interface PluginResolvedSource {
  state: 'resolved';
  source: PluginInstallSource;
  origin: PluginOrigin;
  artifact?: PluginArtifactSource;
  diagnostics: PluginDiagnostic[];
  resolvedAt: number;
}

export interface PluginInstallPlan {
  state: 'resolved' | 'staged';
  planId: string;
  source: PluginInstallSource;
  origin: PluginOrigin;
  requestedScope?: PluginScope;
  artifact?: PluginArtifactSource;
  manifest?: NessyPluginManifest;
  marketplaceInstallCommandDisplay?: string;
  diagnostics: PluginDiagnostic[];
  createdAt: number;
  stagedAt?: number;
  stage?: {
    directory: string;
    rawDirectory: string;
    normalizedDirectory: string;
  };
  lifecycle: readonly PluginLifecycleState[];
}

export interface PluginStagedInstall {
  state: 'staged';
  plan: PluginInstallPlan;
  stageDirectory: string;
  rawDirectory: string;
  normalizedDirectory: string;
  stagedAt: number;
  diagnostics: PluginDiagnostic[];
  /**
   * P6.577 — the SHA-256 of the archive that was actually downloaded, hex, when
   * this install fetched one. `plugins/loading.md#how-claude-code-computes-the-version` step 4
   * names it as a version source for an UNPINNED archive ("or the digest of the
   * downloaded file when you set no pin"), and the bytes exist only inside
   * `fetchArchiveUrlArtifact`, so it is recorded there and read by
   * `resolveInstalledPluginVersion`. Absent for every other source kind.
   */
  artifactDigest?: string;
  /**
   * P6.577 — the RESOLVED git commit of the plugin's source, when a caller has
   * one (step 3). Never a ref name. No producer exists in this fork today; see
   * `plugin-version-chain.ts` for the measurement and what one would cost.
   */
  commitSha?: string;
}

/**
 * Stable, version-LESS logical plugin identity (W7).
 *
 * Opaque, path-free, collision-free string derived only from
 * `(marketplaceId, pluginId)` via `pluginKeyFor()`. It is the isolation key for
 * writable plugin data: it survives version updates so a plugin keeps its data
 * across upgrades. Explicit uninstall removes the data root. Callers MUST treat
 * the key as opaque — it deliberately does not embed the version or an absolute
 * path.
 */
export type PluginKey = string;

/**
 * Flat, content-addressed cache reference (W7). Persisted logical ref only — no
 * absolute path is stored. The physical directory is derived through the W1
 * helper `getPluginCachePath()` as `<version>/<bundleHash>`.
 */
export interface PluginCacheRef {
  marketplaceId: string;
  pluginId: string;
  version: string;
  bundleHash: string;
}

/**
 * Version-inclusive install identity used by the legacy v1 store. Distinct from
 * the stable version-less `PluginKey`; do not conflate the two.
 */
export interface PluginCacheReference {
  marketplaceId: string;
  pluginId: string;
  version: string;
}

/** Stable per-instance identity: `plugin://<marketplaceId>/<pluginId>@<version>#<bundleHash>`. */
export type PluginInstanceId = string;

/**
 * Immutable-bundle resource reference (W7 Step 6). Replaces the fake native
 * `sourcePath`/`targetPath` pair: projection points at a validated path inside
 * the immutable normalized bundle and never at a mutable native target.
 */
export interface PluginBundleResourceRef {
  pluginInstanceId: PluginInstanceId;
  /** Path validated to stay inside the normalized bundle; never absolute. */
  relativePath: string;
  contentHash: string;
}

export interface PluginValidationResult<T = unknown> {
  ok: boolean;
  value?: T;
  diagnostics: PluginDiagnostic[];
}

/**
 * `PluginValidationResult<NessyPluginManifest>` widened with an optional
 * `compatibility` report (A2 `PluginCompatibilityReport`). Adapters that
 * compute a compatibility summary alongside their normalized manifest (Codex,
 * Claude) return this shape directly instead of riding `compatibility` along
 * on an unrelated object shape read back through an unsafe cast (A4/A5
 * CARRY #1 — the previous cast lived at
 * `format-adapters.ts normalizePluginBundle`).
 */
export interface PluginNormalizationResult extends PluginValidationResult<NessyPluginManifest> {
  compatibility?: PluginCompatibilityReport;
}

export interface PluginFormatWarning extends PluginDiagnostic {
  severity: 'warning';
}

/**
 * Everything a bundle normalization knows beyond the bundle itself. Optional at
 * every seam so an adapter that has no use for it is unchanged (S9).
 */
export interface PluginBundleNormalizationOptions {
  /** The marketplace entry this bundle was installed from, when there was one. */
  marketplaceEntry?: PluginMarketplaceEntryDefinition;
}

export interface PluginFormatAdapter {
  id: string;
  version?: string;
  detect(rootDirectory: string, options?: PluginBundleNormalizationOptions): Promise<boolean> | boolean;
  normalize(
    rootDirectory: string,
    origin: PluginOrigin,
    options?: PluginBundleNormalizationOptions,
  ): Promise<PluginNormalizationResult>;
}

export interface PluginHostEnv {
  pluginRoot: string;
  pluginDataDirectory: string;
  eventData?: unknown;
  env: Record<string, string>;
}

/*
 * P3.196 — `PluginHookOutputDecision` and `PluginHookExecutionResult` stood
 * here, and NOTHING read either one (positive control: `PluginFormatAdapter`,
 * declared in this same file, has 25 references; these two had one apiece,
 * their own declaration, plus the field linking them together). They were the
 * type surface of `plugins/hooks-runtime.ts` — a second, unreachable hook
 * executor whose vocabulary (`continue`/`blockReason`/`permissionDecision`/
 * `systemMessage`) never matched the live `PreToolUseDecision`. The owner ruled
 * "do not revive it" (`docs/superpowers/specs/2026-07-29-inert-worklist.md` §3
 * item 5) and the file itself is gone; only its types outlived it.
 *
 * Deleted rather than made canonical, which the row left open. The
 * three-valued `permissionDecision?: 'allow' | 'deny' | 'ask'` is NOT closer to
 * the contract than the live five-valued `PreToolUseDecisionValue`: the page
 * gives PreToolUse "four outcomes (allow, deny, ask, or defer)"
 * (`hooks.md#pretooluse-decision-control`), so the missing member was `defer` —
 * the exact value P3.176/P3.193 spent two rows restoring. Promoting this shape
 * would have written that bug into the plugin-facing surface, which
 * `plugins/index.ts` re-exports wholesale, and left it as the obvious thing for
 * a plugin author to code against.
 *
 * The live surface is `PreToolUseDecision` (`automations/types.ts`), folded by
 * `mergePreToolUseDecisionObjects` (`automations/hook-decision-contract.ts`).
 *
 * P3.124 — and what a member of that union actually REACHES, which is the next
 * question a plugin author asks and had no answer anywhere. Measured
 * 2026-09-01 at load average 9.93, pinned by
 * `agent/backend/claude/__tests__/pre-tool-use-decision-values.test.ts`:
 *
 * | value | Pi | claude | codex |
 * | --- | --- | --- | --- |
 * | `deny` / `block` | denies | denies | denies |
 * | `ask` | asks | asks | asks |
 * | `allow` | allows | allows | allows |
 * | `defer` | honoured, headless and single-call only | **downgraded to `allow`** | no such member in the runtime's own schema |
 *
 * The claude cell is a SILENT divergence rather than a missing feature, and it
 * contradicts the ordering every other layer now implements: `hooks.md`
 * § `#pretooluse-decision-control` states *"precedence is `deny` > `defer` >
 * `ask` > `allow`"*, so `defer` outranks `ask` — yet on that path the weaker
 * value survives and the stronger one becomes the one value it can never lose
 * to. The cause is upstream of the payload builder P3.176 corrected:
 * `runClaudePreToolUseHookPipeline` (`agent/claude-agent.ts`) narrows the union
 * to `'allow' | 'ask'` before `buildClaudePreToolUseContinue` can see it, and
 * both of those hand-written unions are copies of this same vocabulary. Fixing
 * it carries the product question Pi already answered — whether an interactive
 * session may defer at all — so it is a unit of its own, not a widening.
 *
 * Codex is the honest *cannot*: its shipped binary's own
 * `pre-tool-use.command.output` schema enumerates `allow | deny | ask` and no
 * fourth value, so there is nowhere for a `defer` to go. That reading is
 * inherited from the binary probe recorded at
 * `codex-responses-adapter/src/config-writer.ts` and was NOT re-measured here —
 * the codex binary is not vendored in this checkout.
 */

// F1.1025 — declared by interface merging so no cited line above moves.
export interface PluginLspDescriptor {
  /**
   * `plugins-reference.md` § `lspServers`: "Map of file extension to LSP language
   * ID, at least one entry. Keys start with a dot, such as `".go"`". Carried as
   * declared (case kept) from the Claude adapter's `claudeLspExtensionMapField`,
   * which refuses by name an entry it cannot route by, so there every value is
   * one of `languages`; the schema carries a native manifest's map unvalidated
   * and the router skips a value the server does not own. Absent on our own
   * `languages` spelling. The resolver copies it onto `RuntimeLspRegistration`,
   * where `resolvePluginLspDocumentLanguage` reads it.
   */
  extensionToLanguage?: Record<string, string>;
}

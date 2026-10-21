import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'fs';
import { join, dirname, isAbsolute, resolve, sep } from 'path';
import { getCredentialManager } from '../credentials/index.ts';
import { encodeSessionKey, runRetentionSweep, type SessionKey } from '../sessions/index.ts';
import { initializeDocs } from '../docs/index.ts';
import { expandPath, getBundledAssetsDir } from '../utils/paths.ts';
import { debug } from '../utils/debug.ts';
import { readJsonFileSync } from '../utils/files.ts';
import {
  AtomicConfigWriteError,
  atomicWriteConfigFileSync,
  type ConfigWriteStep,
} from '../utils/durable-fs.ts';
import { CONFIG_DIR, STORAGE_LAYOUT_VERSION, getToolIconsDir } from './paths.ts';
// DA1.72 — `getToolIconsDir` MOVED to `config/paths.ts`, beside the `CONFIG_DIR`
// it is one `join` over, because `config/validators.ts`'s import of it from here
// was the OTHER edge of the validators/storage cycle. Re-exported unchanged.
export { getToolIconsDir } from './paths.ts';
// DA1.72 — `loadStoredConfig` and its refusal semantics MOVED to a leaf that
// imports none of `credentials`, `sessions` or `docs`. Imported here for this
// file's own readers and RE-EXPORTED below, so every existing importer of
// `loadStoredConfig` / `UnsupportedStorageLayoutError` / `getNetworkProxySettings`
// from `config/storage.ts` is unchanged. Read that module's docblock before
// adding anything to it.
import {
  CONFIG_FILE,
  CONFIG_FILE_NAME,
  MAX_CONFIG_BACKUPS,
  getNetworkProxySettings,
  loadStoredConfig,
} from './stored-config-load.ts';
export {
  CONFIG_FILE_NAME,
  UnsupportedStorageLayoutError,
  getNetworkProxySettings,
  loadStoredConfig,
  resetCorruptedConfigCopyLatchForTests,
} from './stored-config-load.ts';
import {
  CROSS_SESSION_INBOUND_SETTINGS,
  CROSS_SESSION_INBOUND_ENV_NAME,
  describeUnrecognizedCrossSessionInbound,
  type CrossSessionInboundSetting,
} from './cross-session-inbound-vocabulary.ts';
import { SESSIONS_DIR } from '../workspaces/paths.ts';
import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import {
  DEFAULT_THINKING_LEVEL,
  getHeldModelDefaultThinkingLevel,
  isValidThinkingLevel,
  normalizeThinkingLevel,
} from '../agent/thinking-levels.ts';
import { normalizeFallbackModelChain } from './fallback-model-chain.ts';
// UB6.1 (DA1.72) — the decision-layer settings model lives in `decisions/settings.ts`
// (browser-safe: it imports nothing Node-side), so the renderer can read the same
// normalization through `@nessy-agent/shared/decisions/settings`.
import {
  mergeDecisionLayerSettings,
  normalizeDecisionLayerSettings,
  type DecisionLayerSettings,
  type DecisionLayerStoredSettings,
} from '../decisions/settings.ts';
import { resolveUseAutoModeDuringPlanWithScopes } from './auto-mode-during-plan.ts';
import { parsePermissionMode, DEFAULT_CYCLABLE_PERMISSION_MODES } from '../agent/mode-types.ts';
import { DEFAULT_OUTPUT_STYLE_ID, normalizeOutputStyleId } from '../prompts/output-styles.ts';
import { type ConfigDefaults } from './config-defaults-schema.ts';
import {
  DEFAULT_NOTIFICATION_TIMING,
  isNotificationTiming,
  notificationSettingsFromLegacyEnabled,
  type NotificationSettings,
  type NotificationTiming,
} from './notification-timing.ts';
import { parseManagedSandboxSettingsV1, resolveSandboxEnabled, type SandboxSettingsV1 } from './sandbox-settings.ts';
import {
  REJECTED_LAYER_REASON_MAX,
  sanitizeSettingsDiagnostic,
  type RejectedSettingsLayerV1,
} from './managed-drops.ts';
import { parseWorktreeSettingsV1, type WorktreeSettingsV1 } from './worktree-settings.ts';
import {
  getWorkspaceActions,
  WORKSPACE_ACTIONS_SETTING_KEY,
  type ResolvedWorkspaceAction,
} from './workspace-actions.ts';
import { parseWorkflowSettingsV1, type WorkflowSettingsV1 } from './workflow-settings.ts';
import { bundledSkillsDisabledBySetting } from './bundled-skills-settings.ts';
import { parseSessionMirrorSettingsV1, type SessionMirrorSettingsV1 } from './session-mirror-settings.ts';
import { parseSourceStartupSettingsV1, type SourceStartupSettingsV1 } from './source-startup-settings.ts';
import { parseBuiltinDpMcpSettingsV1, type BuiltinDpMcpSettingsV1 } from './builtin-dp-mcp-settings.ts';
import { ConfigDefaultsSchema, isValidThemeFile, StoredConfigTopLevelSchema } from './validators.ts';
import type { StoredWorkspaceRef } from '../workspaces/types.ts';
import { assertStorageId } from '../workspaces/paths.ts';

// Re-export CONFIG_DIR for convenience (centralized in paths.ts)
export { CONFIG_DIR } from './paths.ts';
export { AtomicConfigWriteError, atomicWriteConfigFileSync, type ConfigWriteStep } from '../utils/durable-fs.ts';

// Re-export base types from core (single source of truth)
export type {
  WorkspaceInfo,
  Workspace,
  McpAuthType,
  AuthType,
  OAuthCredentials,
} from '@nessy-agent/core/types';

// Import LLM connection types
import type { LlmConnection } from './llm-connections.ts';

// Config stored in JSON file (credentials stored in encrypted file, not here)
export interface StoredConfig {
  storageLayoutVersion?: typeof STORAGE_LAYOUT_VERSION;
  // LLM Connections (authoritative source for auth and model config)
  llmConnections?: LlmConnection[];
  defaultLlmConnection?: string;  // Slug of default connection for new sessions
  defaultThinkingLevel?: ThinkingLevel;  // App-level default thinking level for new sessions
  /**
   * `model-config.md#adjust-effort-level` — the marker that RELEASES the effort
   * hold, which lasts "until you choose a level for them". Set by
   * every explicit setter ({@link setDefaultThinkingLevel} and the interactive
   * per-session `/effort` equivalent, via {@link releaseThinkingLevelHold}).
   * Absent = no explicit choice recorded yet, which is the pre-upgrade state.
   */
  defaultThinkingLevelExplicit?: boolean;
  /**
   * The model id whose documented default is currently held. Written the first time
   * a hold-listed model resolves a level, cleared by an explicit choice. The
   * held LEVEL is not stored — it is derived from the model id through
   * `getHeldModelDefaultThinkingLevel`, so `defaultThinkingLevel` keeps holding
   * the user's own previously-set level and can still "carry over" on a model
   * with no hold.
   */
  heldThinkingLevelModelId?: string;
  /**
   * I2.5 — the TIER-2 per-model effort memory, keyed by the model id this host
   * resolves, and the host's answer to a capability two of three runtimes have
   * and one does not.
   *
   * claude persists `Settings.modelSettings[<canonical model name>].effortLevel`
   * and Pi 0.84.3 persists `Settings.modelThinkingLevels` keyed by
   * `<provider>/<id>`; codex persists nothing per model. Under the owner's
   * native-first rule that asymmetry is exactly the silent divergence the host
   * exists to absorb, so the memory lives HERE, once, for all three.
   *
   * @see {@link getModelThinkingLevel} for the precedence, which is READ off
   * Pi's own resolver rather than invented.
   */
  modelThinkingLevels?: Record<string, ThinkingLevel>;
  /**
   * P6.307 — the last effort level the USER typed for a REVIEW, remembered
   * across sessions.
   *
   * `code-review.md:327`, the half this fork did not have: the review *"reuses
   * the last level from `low` through `max` you typed, **even in an earlier
   * session**"*. The bundled skill already reuses it within one conversation;
   * the cross-session half needs a store, and this is it.
   *
   * SEPARATE from {@link defaultThinkingLevel} on purpose, and the separation is
   * the point rather than a duplication: that field is the session's own effort,
   * which the review INHERITS when no level was ever typed (`:327`'s other
   * half). Folding the two together would make one `/effort` change rewrite the
   * remembered review level, and one review rewrite the session's.
   *
   * `off` is never stored: the page's own range is `low` through `max`, and a
   * remembered `off` would silently disable every later review.
   */
  lastReviewEffortLevel?: ThinkingLevel;
  // UB6.1 (DEC-0) — the decision layer ("System One", Jev-compatible classifier)
  // settings. Everything optional on disk; `decisions/settings.ts`
  // `normalizeDecisionLayerSettings` fills the defaults (OFF by default; the
  // `enabled` switch in Settings > AI is the only master gate — no env flag).
  // Declared in `StoredConfigKnownFields` (`stored-config-load.ts`) per the
  // DA1.72 recipe in the same commit as this reader.
  decisionLayer?: DecisionLayerStoredSettings;
  outputStyleId?: string;  // App-level response style for new turns

  workspaceRefs: StoredWorkspaceRef[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;  // Currently active session (primary scope)
  // Notifications
  // Legacy single switch, superseded by `notificationTiming` and the two alert
  // controls below. Still read when the newer keys are absent, and kept in step
  // when they are written — see getNotificationSettings.
  notificationsEnabled?: boolean;  // Desktop notifications for task completion (default: true)
  // `learn.chatgpt.com/docs/notifications.md#configure-desktop-notifications` — turn-completion alerts
  // appear "never, only while ChatGPT is in the background, or always".
  notificationTiming?: NotificationTiming;
  // The page's two separate controls: "Separate controls let you turn
  // permission and question notifications on or off."
  notificationPermissionAlerts?: boolean;
  notificationQuestionAlerts?: boolean;
  // Days to retain session data and other swept application data (default: 30,
  // minimum 1). A persisted 0 predates the minimum and reads as "cleanup
  // disabled"; new writes of 0 are rejected. See resolveRetentionDecision.
  retentionDays?: number;
  // The off switch for the age-based sweep. Absent/true = sweep at
  // `retentionDays`; explicit false = never sweep, whatever the window says.
  // Nessy-only: `settings.md` gives `cleanupPeriodDays` no disabled value
  // ("Setting `0` fails with a validation error"), so the off switch cannot ride
  // the number without either writing a value the documented schema rejects or
  // making validateConfig() report the user's own choice as an invalid config.
  // A managed `cleanupPeriodDays` still overrides it — see
  // resolveRetentionDecision.
  retentionSweepEnabled?: boolean;
  // P6.502 — never-persist as a FIRST-CLASS setting: every new session starts
  // in-memory only, so no transcript, checkpoint or plan file is created for it.
  //
  // Delegated decision 2026-09-05 (Q-den 19) = option A. B (the retention cap is
  // the whole answer) was refused because the minimum retention is not zero —
  // `setRetentionDays` rejects 0 — and C (let the cap reach zero) because that is
  // a FALSE never-persist: the transcript is written and then deleted. This is
  // the zero the cap above cannot reach, which is why it sits beside it.
  //
  // It RIDES the machine that already existed rather than adding one: the
  // session-create choke point ORs it into the same `ephemeral` flag the
  // documented `CLAUDE_CODE_SKIP_PROMPT_HISTORY` env feeds (P6.267), so every
  // `!managed.ephemeral` gate — the persist calls, the pending-plan store, the
  // checkpoint reporting — inherits it unchanged. Host-side and therefore
  // identical on Pi, claude and codex.
  //
  // No managed key, deliberately: the operator already has the documented env,
  // and a second operator lever for one boolean would be two things to keep in
  // step for no new power.
  neverPersistSessions?: boolean;
  // P6.182 clause (i) — the USER-settings rung of `crossSessionInbound`.
  //
  // `settings-reference.md#crosssessioninbound`, verbatim: "Claude Code reads
  // managed settings first, then the `--settings` flag, then user settings, and
  // applies the first value found." This host had the operator rung (the env)
  // and the project/local exception and NO user rung at all, so the value the
  // page says `/config` writes had nowhere to go.
  //
  // SHIPPED ABSENT, and that is the documented default rather than an omission:
  // "**Default**: unset, so Claude Code decides per message". A value in
  // `config-defaults.json` would destroy the per-message rule for every install,
  // which is why this key is the one recent addition with no fourth site.
  crossSessionInbound?: CrossSessionInboundSetting;
  // Appearance
  colorTheme?: string;  // ID of selected preset theme (e.g., 'codex', 'nord'). Default: 'default'
  zoomFactor?: number;  // Global renderer zoom factor (default: 1.0, clamped to [0.5, 3.0])
  // Auto-update
  dismissedUpdateVersion?: string;  // Version that user dismissed (skip notifications for this version)
  // Input settings
  autoCapitalisation?: boolean;  // Auto-capitalize first letter when typing (default: true)
  sendMessageKey?: 'enter' | 'cmd-enter';  // Key to send messages (default: 'enter')
  spellCheck?: boolean;  // Enable spell check in input (default: false)
  // Power settings
  keepAwakeWhileRunning?: boolean;  // Prevent screen sleep while sessions are running (default: false)
  // Tool metadata
  richToolDescriptions?: boolean;  // Add intent/action metadata to all tool calls (default: true)
  // Tools
  browserToolEnabled?: boolean;  // Enable built-in browser tool (default: true). Disable for Playwright/Puppeteer.
  allowRemoteEvaluate?: boolean;  // Allow remote agents to call `browser_tool evaluate` on local browser (default: true).
  memoryEnabled?: boolean;  // Enable MEMORY.md prompt reader and remember tool (default: true).
  // P6.272 · the host's file-checkpointing off switch. Claude's own documented
  // key name; see `getFileCheckpointingEnabled` for why it is host-side.
  fileCheckpointingEnabled?: boolean;
  // T5 (2026-08-12): `permission-modes.md` — "the first time you start an
  // interactive session with [bypassPermissions] enabled, Claude Code shows a
  // warning dialog asking you to accept responsibility … Claude Code saves
  // your acceptance to user settings". Desktop analog: the renderer's
  // one-time responsibility dialog writes this key on accept (default: false
  // / never acknowledged). NOT exposed through `update_user_preferences` or
  // any other model-invocable tool — only the renderer dialog-accept path
  // writes it (mirrors how `uiLanguage` in preferences.ts is writer-restricted
  // to the Appearance dropdown; see packages/shared/AGENTS.md).
  bypassPermissionsAcknowledged?: boolean;
  macosSeatbeltBashSandboxEnabled?: boolean;  // Wrap approved Bash commands with macOS sandbox-exec (default: false).
  // P6.202 — the read-side working-directory fence. `settings-reference.md`
  // #permissions-blockreadsoutsideworkingdirectories: "Stop Claude from reading
  // paths outside the session's working directories with the Read, Grep, Glob,
  // and LSP tools, in every permission mode including `bypassPermissions`."
  // TIGHTER-WINS across the two layers, because the page's scope note says so:
  // "If any settings source sets `true`, the block applies".
  blockReadsOutsideWorkingDirectories?: boolean;
  // P6.500 / P6.950 — the size at which reopening a conversation asks
  // compact-or-keep; zero or negative is the documented off switch. Declared on
  // the interface (and not only in `StoredConfigKnownFields`) because P6.950
  // added a WRITER, {@link disableReopenCompactPrompt}: the READ path goes
  // through an unknown-tolerant cast, but a write needs the member.
  reopenCompactPromptTokens?: number;
  mcpChannelPushEnabled?: boolean;  // Let connected MCP servers push text into a live turn via `claude/channel` (default: false).
  // Enable automatic compaction; manual /compact is independent (default: true).
  // NOT Pi-only, and this comment said it was until P6.53: the resolved policy
  // reaches every backend and each projects it onto its runtime's own knob —
  // Pi's `setAutoCompaction`, and the Claude SDK's `DISABLE_AUTO_COMPACT`
  // (`settings-reference.md#autocompactenabled`). Codex does not read it yet;
  // its `model_auto_compact_token_limit` is still written unconditionally.
  autoCompactEnabled?: boolean;
  // Idle time before an unanswered ask_user question auto-continues with the
  // selections made so far (settings.md `askUserQuestionTimeout`). Default
  // "never". USER settings only — never read from project or local layers, so
  // a checked-in repo cannot auto-answer questions. See
  // getAskUserQuestionTimeout(); permission prompts never read this.
  askUserQuestionTimeout?: AskUserQuestionTimeout;
  // Sandbox execution settings — the USER layer. Merged under the managed layer
  // and over the host-seeded credential deny floor; see sandbox-settings.ts.
  sandbox?: SandboxSettingsV1;
  // Worktree settings — `settings.md` § Worktree settings. `bgIsolation`
  // deliberately defaults to `none` here; see config/worktree-settings.ts.
  worktree?: WorktreeSettingsV1;
  // Workflow governance — `settings.md` (`disableWorkflows`,
  // `workflowSizeGuideline`, `workflowKeywordTriggerEnabled`) grouped under one
  // key. `disableWorkflows` is a hard off switch; the size guideline is advice.
  // See config/workflow-settings.ts.
  workflow?: WorkflowSettingsV1;
  // Session mirror store — best-effort transcript mirroring into a configured
  // adapter (local disk stays first and authoritative). Absent = no mirror.
  // See config/session-mirror-settings.ts and sessions/mirror/.
  sessionMirror?: SessionMirrorSettingsV1;
  // Source connection timing (T10, plugin-install plan § 9b). Default posture
  // is Claude parity — connect enabled servers at session start; setting
  // `sources.connectOnStartup: false` restores connect-by-intent. See
  // config/source-startup-settings.ts.
  sources?: SourceStartupSettingsV1;
  // Per-server on/off for the built-in dp-backed MCP set (A7). Only servers the
  // user has explicitly switched appear here; anything absent keeps its own
  // `defaultEnabled`. See config/builtin-dp-mcp-settings.ts.
  builtinDpMcpServers?: BuiltinDpMcpSettingsV1;
  // Permissions
  // Extra filesystem roots tools may write to beyond the session's own roots.
  // Absolute paths only; canonicalized through realpath before use. Widening a
  // root is a permission decision, so this is the ONLY source of extra roots —
  // see agent/additional-directories.ts.
  additionalDirectories?: string[];
  // C3.178 — which of the attached folders above is PRIMARY, as a choice rather
  // than a derivation. Display and ordering only (P6.929 option (b), by record
  // 2026-09-10): discovery stays on the project root, and the resolver in
  // config/primary-directory.ts can only ever answer with a member of the set it
  // was given, so this key cannot widen a session's filesystem authority.
  primaryDirectory?: string;
  // Instruction/rule files to skip when loading memory — Claude's
  // `claudeMdExcludes`, plus our own spelling of it. Both are read and the two
  // arrays merge, as do the arrays at the project, local and managed scopes
  // (`large-codebases.md:155`). See agent/memory/instruction-excludes.ts.
  instructionExcludes?: string[];
  claudeMdExcludes?: string[];
  // `env-vars.md:78`'s settings-file `env` block, DECLARED so that a config.json
  // carrying it still loads, and deliberately NOT applied. The refusal and its
  // park live on reportUnhonouredUserEnvBlock() below.
  env?: Readonly<Record<string, string>>;
  // Prompt caching & context
  extendedPromptCache?: boolean;  // Use 1h prompt cache TTL instead of 5m (default: false)
  // enable1MContext — removed by F1.1241 (each model's own window decides); an old file's key is tolerated by stored-config-load.ts
  // Token optimization
  rtkEnabled?: boolean;  // Route Bash commands through rtk to compress tool output (default: false). https://github.com/rtk-ai/rtk
  rtkExcludeCommands?: string[];  // UB7.4 — base commands never routed through rtk (default: []).  // Guardian safety judge (LLM command judge)
  guardianEnabled?: boolean;  // Consult the guardian judge for borderline (auto) + high-risk (allow-all) actions (default: true).
  guardianJudgeModelId?: string;  // LEGACY global judge model. Read as a fallback, no longer written by the UI — see `guardianJudgeModels`.
  /**
   * Judge model PER INTEGRATION, `connection slug → model id`.
   *
   * One global id could not work: entitlement varies per key, so a model
   * that judges fine on one connection 403s on another and silently degrades
   * every risky action to a plain ask. Resolution — including what happens to
   * a stale entry — lives in `guardian-judge-model.ts`.
   */
  guardianJudgeModels?: Record<string, string>;
  // Codex native auto-review (P3.2). Two keys, mirrored in config-defaults.json +
  // FALLBACK_CONFIG_DEFAULTS + the ConfigDefaults schema (the three-site rule),
  // and declared in the strict StoredConfig validator envelope so a config.json
  // carrying them survives the parse.
  codexAutoReviewEnabled?: boolean;  // Route escalated codex approvals through codex's `auto_review` guardian (default: false — opt-in, codex runtime only).
  codexAutoReviewPolicy?: string;    // Extra instructions appended to codex's guardian prompt (`[auto_review].policy`). Empty = none. Only used when codexAutoReviewEnabled is on.
  // C3.109 (QH3) — codex's OWN delegation off-switch, `[agents] enabled`. Same
  // three-site mirroring as the pair above, and declared in the strict envelope.
  codexSubagentsEnabled?: boolean;   // Let codex spawn its own agents (default: true — codex's own default; only an explicit false is written, as `[agents] enabled = false`).
  // Advisor (P2.1) — the second model consulted at decision points. Two keys,
  // both mirrored in config-defaults.json + FALLBACK_CONFIG_DEFAULTS + the
  // ConfigDefaults schema, because a key present in fewer than all three is the
  // known shipped-bug shape (see the note on FALLBACK_CONFIG_DEFAULTS below).
  advisorEnabled?: boolean;  // Let the model consult the advisor (default: false — opt-in, like Claude's `/advisor`).
  advisorModel?: string;     // The advising model. Empty = the session's own model. See agent/advisor.ts for the gate.
  useAutoModeDuringPlan?: boolean;  // permission-modes.md:240 (2026-08-23 fetch; the sentence at getUseAutoModeDuringPlan is the anchor) — let the classifier review plan-mode shell commands instead of prompting (default: true).
  respondToBashCommands?: boolean;  // settings-reference.md#respondtobashcommands — Claude responds after an input-box `!` shell command runs (default: true); false = output added to context without a reply.
  // P6.564 — the browser pane's download destination, as a user setting rather
  // than only P6.360's two environment variables. Read through
  // getBrowserDownloadSettings(), which is where the validation lives.
  browserDownload?: { root?: string; ask?: boolean };
  // Network proxy
  networkProxy?: import('./types.ts').NetworkProxySettings;
  // Windows: path to Git Bash (bash.exe) for the SDK subprocess
  gitBashPath?: string;
  // User chose "Setup later" during onboarding — skip showing onboarding on next launch
  setupDeferred?: boolean;
  // Server mode — embedded remote server settings
  serverConfig?: import('./server-config.ts').ServerConfig;
}

const CONFIG_DEFAULTS_FILE = join(CONFIG_DIR, 'config-defaults.json');

// Track if config-defaults have been synced this session (prevents re-sync on hot reload)
let configDefaultsSynced = false;

/**
 * Sync config-defaults.json from bundled assets.
 * Always writes on launch to ensure defaults are up-to-date with the running version.
 * Follows the same pattern as docs, themes, and other bundled assets.
 *
 * Source of truth: apps/electron/resources/config-defaults.json
 */
/** Minimal config-defaults used when bundled assets aren't available (CI, standalone server). */
/** In-code mirror of the bundled `config-defaults.json`; both must carry the same retention default. */
export const FALLBACK_CONFIG_DEFAULTS: ConfigDefaults = {
  version: '1.0',
  description: 'Default configuration values for Nessy Desktop',
  defaults: {
    notificationsEnabled: true,
    notificationTiming: 'background',
    notificationPermissionAlerts: true,
    notificationQuestionAlerts: true,
    colorTheme: 'default',
    autoCapitalisation: true,
    sendMessageKey: 'enter',
    spellCheck: false,
    keepAwakeWhileRunning: false,
    richToolDescriptions: true,
    extendedPromptCache: false,
    browserToolEnabled: true,
    allowRemoteEvaluate: true,
    memoryEnabled: true,
    macosSeatbeltBashSandboxEnabled: false,
    // P6.202 — shipped OFF, matching the page's own "Default: unset, so reads
    // outside the working directories follow your permission mode and rules".
    blockReadsOutsideWorkingDirectories: false,
    mcpChannelPushEnabled: false,
    autoCompactEnabled: true,
    guardianEnabled: true,
    // P3.2 — codex native auto-review, OPT-IN. Off by default: it changes the
    // codex approval loop, and enabling a reviewer subagent the user did not ask
    // for is the one direction a default must not move by accident. The policy
    // ships empty (no additions to codex's own guardian prompt).
    codexAutoReviewEnabled: false,
    codexAutoReviewPolicy: '',
    // C3.109 — ON by default, which is codex's own default
    // (`AgentsToml.enabled`: "Whether multi-agent tools are enabled. Defaults to
    // true"). This default therefore CHANGES NOTHING; what the key buys is that
    // an operator has a way to say `false`, which until now existed in the
    // config writer and nowhere else.
    codexSubagentsEnabled: true,
    // P2.1 — OPT-IN, matching `advisor.md`'s own posture (the advisor is turned
    // on with `/advisor`, `advisorModel` or `--advisor`; it is not on by
    // default). An always-on second model doubles the cost of a turn without
    // the user having asked for it, which is the one direction a default must
    // not move by accident.
    advisorEnabled: false,
    // Empty = "the session's own model advises", the documented default. A
    // NAMED model here would outrank the session's for every install and could
    // never be escaped — `syncConfigDefaults` rewrites the user copy from the
    // bundle on every launch — which is R52's recorded reason for shipping
    // `thinkingLevel` absent.
    advisorModel: '',
    // P6.531's floor, DECLARED here rather than only in
    // `config/unattended-approval.ts` (P6.739). It is a declaration, not a
    // lever: `syncConfigDefaults` rewrites the user's copy from the bundle on
    // every launch, so nobody can change the shipped floor by editing the file,
    // and the resolver deliberately stays a LEAF module that reads its own
    // `UNATTENDED_APPROVAL_FALLBACK_DEFAULT`. `unattended-approval-defaults.test.ts`
    // pins all four declaration sites equal to that constant, so the file an
    // operator reads to learn the defaults cannot say something the gate does
    // not do.
    unattendedApprovalFallback: 'deny',
    retentionDays: 30,
    // P6.502 — shipped OFF. Never-persist removes resume, rewind and search, so
    // it is a choice a person makes, never one they are given.
    neverPersistSessions: false,
  },
  workspaceDefaults: {
    // `thinkingLevel` is absent here for the same reason it is absent from the
    // bundled asset (R52): a workspace-tier value outranks the model's default
    // effort (model-config.md#adjust-effort-level) and would make it unreachable.
    // Auto, matching the bundled asset and Claude Code's own default since
    // 2026-08-14. Both sites must carry it: the bundled file wins on a normal
    // launch and this one only when the assets dir is missing, so a one-place
    // flip makes the app's default mode depend on the shape of the install.
    // The `?? 'default'` in `loadConfigDefaults` below is a different value on
    // purpose — that one catches an UNPARSEABLE mode, where narrowing is right.
    permissionMode: 'auto',
    cyclablePermissionModes: [...DEFAULT_CYCLABLE_PERMISSION_MODES],
    maxAgentTurns: 0,
    maxBudgetUsd: 0,
    // P6.645 — the token twin of `maxBudgetUsd`, 0 meaning no cap for the same
    // reason and with the same spelling of "off". Both this fallback and the
    // bundled asset carry it: the bundled file wins on a normal launch and this
    // one only when the assets dir is missing.
    maxBudgetTokens: 0,
    fallbackModel: [],
    // ON by default, matching upstream's `(unset)` row ("Tool search is on by
    // default"). Both this fallback and the bundled asset must carry it: the
    // bundled file wins on a normal launch, this one only when the assets dir
    // is missing, and a one-place flip works in the running session and reverts
    // on the next launch.
    deferredMcpToolLoading: true,
    localMcpServers: { enabled: true },
  },
};

function syncConfigDefaults(): void {
  if (configDefaultsSynced) return;
  configDefaultsSynced = true;

  // Get bundled config-defaults.json from resources folder
  const bundledDir = getBundledAssetsDir('.');
  if (!bundledDir) {
    debug('[config] No bundled assets dir found - using fallback config-defaults');
    if (!existsSync(CONFIG_DEFAULTS_FILE)) {
      writeFileSync(CONFIG_DEFAULTS_FILE, JSON.stringify(FALLBACK_CONFIG_DEFAULTS, null, 2), 'utf-8');
    }
    return;
  }

  const bundledFile = join(bundledDir, 'config-defaults.json');
  if (!existsSync(bundledFile)) {
    debug('[config] Bundled config-defaults.json not found at: ' + bundledFile + ' - using fallback');
    if (!existsSync(CONFIG_DEFAULTS_FILE)) {
      writeFileSync(CONFIG_DEFAULTS_FILE, JSON.stringify(FALLBACK_CONFIG_DEFAULTS, null, 2), 'utf-8');
    }
    return;
  }

  // Sync from bundled file (same pattern as docs)
  const content = readFileSync(bundledFile, 'utf-8');
  // P6.811 — say so BEFORE the file becomes the effective defaults.
  reportConfigDefaultsProblems(content, bundledFile);
  writeFileSync(CONFIG_DEFAULTS_FILE, content, 'utf-8');
  debug('[config] Synced config-defaults.json from bundled assets');
}

/**
 * P6.811 — a misspelled key inside `config-defaults.json` was OPERATOR-INVISIBLE.
 *
 * `ConfigDefaultsSchema` existed and was test-only: `loadConfigDefaults` reads
 * the file with `readJsonFileSync` and never parses it through the schema (the
 * schema's own header says so since P6.739), and the strict envelope guarding
 * `config.json` covers a different file. So a shipped `guardianEnabld` produced
 * no error, no warning and no log line — it produced a default that quietly did
 * not take effect, which is this fork's largest defect class written into the
 * one file an operator edits to change defaults.
 *
 * TWO halves, because a typo is two facts and only the pair reads as a typo:
 * the schema reports the correct key as MISSING, and the shape scan reports the
 * misspelling as UNKNOWN. Either alone leaves the reader guessing.
 *
 * NEVER A THROW. This runs on the startup path, and a defaults file that fails
 * to describe one key must not cost the user their application — the loader's
 * own per-field normalisation already keeps every other default working. It is
 * a diagnostic, on the unconditional {@link warn} channel rather than `debug()`,
 * for the reason that helper's own header gives: this is the thing the operator
 * has to be told about.
 *
 * The BUNDLED file is what is checked, deliberately: `syncConfigDefaults`
 * rewrites the user's copy from the bundle on every launch, so the bundled asset
 * is the only copy an edit can survive in, and it is the one about to become
 * effective on the next line.
 *
 * Exported so the check is assertable without a launch: `syncConfigDefaults`
 * runs once per process behind a module flag and resolves a bundled assets
 * directory, so driving it from a test would measure the rig rather than the
 * rule.
 */
export function reportConfigDefaultsProblems(content: string, sourcePath: string): void {
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      warn(
        `[config] ${sourcePath} is not valid JSON, so the shipped defaults could not be checked: `
        + (error instanceof Error ? error.message : String(error)),
      );
      return;
    }
    const problems: string[] = [];
    const result = ConfigDefaultsSchema.safeParse(parsed);
    if (!result.success) {
      for (const issue of result.error.issues) {
        problems.push(`${issue.path.join('.') || '<root>'}: ${issue.message}`);
      }
    }
    for (const key of unknownConfigDefaultsKeys(parsed)) {
      problems.push(`${key}: not a known key, so this line changes nothing`);
    }
    if (problems.length === 0) return;
    warn(
      `[config] ${sourcePath} does not match the config-defaults schema. `
      + `Each problem below is a default that will NOT take effect — `
      + problems.join('; '),
    );
  } catch (error) {
    // The checker itself must never be the reason a launch fails.
    debug('[config] config-defaults check could not run: ' + String(error));
  }
}

/**
 * Keys present on disk that the schema does not declare — the misspelling half.
 *
 * Two levels, which is where every default lives; `ConfigDefaultsSchema` is the
 * key list rather than a hand-written copy of it, so a key added to the schema
 * stops being reported here in the same commit.
 */
function unknownConfigDefaultsKeys(parsed: unknown): string[] {
  if (typeof parsed !== 'object' || parsed === null) return [];
  const record = parsed as Record<string, unknown>;
  const found: string[] = [];
  for (const key of Object.keys(record)) {
    if (!(key in ConfigDefaultsSchema.shape)) found.push(key);
  }
  collectUnknownKeysInBlock(
    'defaults', record.defaults, ConfigDefaultsSchema.shape.defaults.shape, found,
  );
  collectUnknownKeysInBlock(
    'workspaceDefaults', record.workspaceDefaults, ConfigDefaultsSchema.shape.workspaceDefaults.shape, found,
  );
  return found;
}

function collectUnknownKeysInBlock(
  block: string,
  value: unknown,
  known: Record<string, unknown>,
  found: string[],
): void {
  if (typeof value !== 'object' || value === null) return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!(key in known)) found.push(`${block}.${key}`);
  }
}

/**
 * Load config defaults from ~/.nessy-agent/config-defaults.json
 * This file is synced from bundled assets on every launch.
 */
export function loadConfigDefaults(): ConfigDefaults {
  if (!existsSync(CONFIG_DEFAULTS_FILE)) {
    throw new Error('config-defaults.json not found at ' + CONFIG_DEFAULTS_FILE + '. Ensure ensureConfigDir() was called at startup.');
  }

  const defaults = readJsonFileSync<ConfigDefaults>(CONFIG_DEFAULTS_FILE);

  const parsedPermissionMode =
    typeof defaults.workspaceDefaults?.permissionMode === 'string'
      ? parsePermissionMode(defaults.workspaceDefaults.permissionMode)
      : null;
  defaults.workspaceDefaults.permissionMode = parsedPermissionMode ?? 'default';

  const rawCyclable = Array.isArray(defaults.workspaceDefaults?.cyclablePermissionModes)
    ? defaults.workspaceDefaults.cyclablePermissionModes
    : [];

  const normalizedCyclable: PermissionMode[] = [];
  for (const mode of rawCyclable) {
    if (typeof mode !== 'string') continue;
    const parsed = parsePermissionMode(mode);
    if (!parsed) continue;
    if (!normalizedCyclable.includes(parsed)) {
      normalizedCyclable.push(parsed);
    }
  }

  defaults.workspaceDefaults.cyclablePermissionModes =
    normalizedCyclable.length >= 2 ? normalizedCyclable : [...DEFAULT_CYCLABLE_PERMISSION_MODES];

  const rawMaxAgentTurns = defaults.workspaceDefaults?.maxAgentTurns;
  defaults.workspaceDefaults.maxAgentTurns = Number.isFinite(rawMaxAgentTurns) && rawMaxAgentTurns > 0
    ? Math.floor(rawMaxAgentTurns)
    : 0;

  const rawMaxBudgetUsd = defaults.workspaceDefaults?.maxBudgetUsd;
  defaults.workspaceDefaults.maxBudgetUsd = Number.isFinite(rawMaxBudgetUsd) && rawMaxBudgetUsd > 0
    ? rawMaxBudgetUsd
    : 0;

  // P6.645 — the token twin. Floored like `maxAgentTurns` and unlike
  // `maxBudgetUsd`, because a token count is a COUNT: a fractional ceiling on
  // disk would compare against integers forever and read as an off-by-one.
  const rawMaxBudgetTokens = defaults.workspaceDefaults?.maxBudgetTokens;
  defaults.workspaceDefaults.maxBudgetTokens = Number.isFinite(rawMaxBudgetTokens) && rawMaxBudgetTokens > 0
    ? Math.floor(rawMaxBudgetTokens)
    : 0;

  // `model-config.md#fallback-model-chains` — an ordered chain. The read path
  // accepts the legacy scalar (`""` is on disk in every pre-widening install)
  // and always hands callers the normalized `string[]`.
  defaults.workspaceDefaults.fallbackModel =
    normalizeFallbackModelChain(defaults.workspaceDefaults?.fallbackModel);

  defaults.workspaceDefaults.deferredMcpToolLoading = defaults.workspaceDefaults?.deferredMcpToolLoading === true;

  return defaults;
}

/**
 * Ensure config-defaults.json exists and is up-to-date.
 * Syncs from bundled assets on every launch (like docs, themes, permissions).
 */
export function ensureConfigDefaults(): void {
  syncConfigDefaults();
}

let configDirInitialized = false;
let sessionRetentionSweepRan = false;

const CONFIG_BACKUP_DATE_RE = /^config\.json\.bak-\d{4}-\d{2}-\d{2}$/;

/**
 * Snapshot an existing config.json into a dated file (config.json.bak-YYYY-MM-DD)
 * and keep only the newest MAX_CONFIG_BACKUPS. Runs once at startup, before any
 * path can mutate or (in failure paths) overwrite the workspace registry.
 * Best-effort: failures are logged and swallowed so a backup never blocks startup.
 */
export function backupConfigFile(): void {
  try {
    if (!existsSync(CONFIG_FILE)) return;

    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const dated = join(CONFIG_DIR, `config.json.bak-${stamp}`);
    // One backup per day, never overwritten: the first snapshot of the day is taken
    // before any mutation, so it holds the good pre-reset state. A second startup that
    // day (e.g. after a reset already nuked the registry) must NOT clobber it.
    if (existsSync(dated)) return;
    writeFileSync(dated, readFileSync(CONFIG_FILE, 'utf-8'), 'utf-8');

    // ISO date in the name → lexical sort is chronological; drop all but the newest few.
    const backups = readdirSync(CONFIG_DIR).filter(f => CONFIG_BACKUP_DATE_RE.test(f)).sort();
    for (const stale of backups.slice(0, Math.max(0, backups.length - MAX_CONFIG_BACKUPS))) {
      try { rmSync(join(CONFIG_DIR, stale)); } catch { /* ignore individual cleanup errors */ }
    }
  } catch (error) {
    debug('[config] backupConfigFile failed:', error instanceof Error ? error.message : error);
  }
}

export function ensureConfigDir(): void {
  if (configDirInitialized) return;

  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  // Snapshot an existing config.json (dated, keep last 3) before anything can
  // mutate or — in a failure path — overwrite the workspace registry.
  backupConfigFile();
  // Initialize bundled docs (creates ~/.nessy-agent/docs/ with sources.md, agents.md, permissions.md)
  initializeDocs();

  // Initialize config defaults
  ensureConfigDefaults();

  // Initialize tool icons (CLI tool icons for turn card display)
  ensureToolIcons();

  runSessionRetentionSweepOnce();

  configDirInitialized = true;
}

function normalizeRetentionDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return RETENTION_DISABLED;
  }
  return Math.floor(value);
}

function getDefaultRetentionDays(): number {
  try {
    const defaults = loadConfigDefaults();
    return normalizeRetentionDays(defaults.defaults.retentionDays);
  } catch {
    return normalizeRetentionDays(FALLBACK_CONFIG_DEFAULTS.defaults.retentionDays);
  }
}

/**
 * Documented default and minimum. `settings.md` on `cleanupPeriodDays`:
 * "**Default**: `30` days, minimum `1`. … Setting `0` fails with a validation
 * error." Ours was `.min(0)` with `0` as the default — our default was a value
 * Claude's schema rejects.
 */
export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 1;
/** Not a valid retention period; only ever a value already on disk. See below. */
export const RETENTION_DISABLED = 0;

/** Thrown when a caller tries to WRITE a retention value the schema rejects. */
export class InvalidRetentionDaysError extends Error {
  constructor(value: unknown) {
    super(`retentionDays must be an integer >= ${MIN_RETENTION_DAYS}; received ${JSON.stringify(value)}`);
    this.name = 'InvalidRetentionDaysError';
  }
}

export type RetentionSource = 'managed' | 'user' | 'default';

export type RetentionDecision =
  | { sweep: false; state: 'disabled'; warning?: string }
  | { sweep: false; state: 'paused'; warning: string }
  | { sweep: true; state: 'active'; retentionDays: number; source: RetentionSource; warning?: string };

export type RetentionSweepStatus =
  | { state: 'not-run' }
  | { state: 'disabled'; warning?: string }
  | { state: 'paused'; warning: string }
  | {
    state: 'swept';
    retentionDays: number;
    source: RetentionSource;
    sessionsRemoved: number;
    pathsRemoved: number;
    warning?: string;
  };

let retentionSweepStatus: RetentionSweepStatus = { state: 'not-run' };

/**
 * The surfaced half of the fail-safe.
 *
 * `settings.md` (v2.1.203+): "If Claude Code can't read or parse a settings
 * file, it pauses the retention cleanup sweep and shows a warning in `/status`
 * until you fix the file, unless managed settings provide `cleanupPeriodDays`,
 * in which case the sweep runs at the managed value."
 *
 * This record carries the outcome of the sweep this process actually ran —
 * including how much it deleted, which no re-resolution can reconstruct. It is
 * NOT the surface: a record with no reader tells nobody, which is what the
 * earlier "this record IS the surface" note amounted to. The user-visible
 * surfaces are the retention settings card (through
 * `RPC_CHANNELS.retention.GET_SETTINGS`) and `nessy-general-agent doctor`, and
 * both read {@link readRetentionDecision} rather than this, because a process
 * that never swept has no status to report.
 */
export function getRetentionSweepStatus(): RetentionSweepStatus {
  return retentionSweepStatus;
}

let managedRetentionDaysProvider: (() => number | undefined) | undefined;

/**
 * Register the managed `cleanupPeriodDays` reader.
 *
 * The managed policy is loaded in `server-core`, which cannot be imported here,
 * and it has to be registered BEFORE `ensureConfigDir()` because the startup
 * sweep runs inside it. An unregistered provider means "no managed value", which
 * is the correct default for every non-managed install and the conservative one
 * for a destructive sweep.
 */
export function registerManagedRetentionDaysProvider(
  provider: (() => number | undefined) | undefined,
): void {
  managedRetentionDaysProvider = provider;
}

function readManagedRetentionDays(): number | undefined {
  try {
    const value = managedRetentionDaysProvider?.();
    if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_RETENTION_DAYS) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

let managedSandboxEnabledProvider: (() => boolean | undefined) | undefined;

/**
 * Register the managed `sandbox.enabled` reader.
 *
 * Mirrors {@link registerManagedRetentionDaysProvider} exactly: the managed
 * policy is loaded in `server-core`, which cannot be imported here. Contour
 * (a) (the `ProcessSupervisor` wrap) never needed this bridge — it resolves
 * the floor in-process, from the `ManagedPiPolicyV1` object
 * `resolveHostSandboxSettings` (server-core) already holds. This provider is
 * what lets the SAME managed floor reach the two contours that live in
 * `packages/shared` and have no such object to read: this file's
 * {@link getMacosSeatbeltBashSandboxEnabled} (contour b) and
 * `codex-agent.ts`'s `sandboxGloballyEnabled` (contour e). An unregistered
 * provider means "no managed floor" — every non-managed install, and every
 * unit test that never calls this, is unchanged from pre-T1 behavior.
 */
export function registerManagedSandboxEnabledProvider(
  provider: (() => boolean | undefined) | undefined,
): void {
  managedSandboxEnabledProvider = provider;
}

/**
 * The managed `sandbox.enabled` floor, shaped for
 * {@link resolveSandboxEnabled}'s `floor` argument.
 *
 * Exported — unlike the private {@link readManagedRetentionDays} this mirrors
 * — because contour (e) needs it from `codex-agent.ts`, a different file with
 * no other way to reach this module's private registration slot. `undefined`
 * means no managed floor (unregistered provider, a provider that itself
 * returns `undefined`, or one that throws); `resolveSandboxEnabled` already
 * treats an absent floor as "fall through to the layers".
 */
export function resolveManagedSandboxEnabledFloor(): SandboxSettingsV1 | undefined {
  try {
    const value = managedSandboxEnabledProvider?.();
    return value === undefined ? undefined : { enabled: value };
  } catch {
    return undefined;
  }
}

/**
 * Resolve what the sweep should do. Pure, so every branch of a destructive
 * decision is testable without a filesystem.
 *
 * Managed wins outright: managed settings are the top precedence tier and
 * "can't be overridden by anything", and the doc names this key specifically as
 * the one that also overrides the unreadable-settings pause.
 */
export function resolveRetentionDecision(input: {
  config: RetentionConfigRead;
  defaultRetentionDays: number;
  managedRetentionDays?: number;
}): RetentionDecision {
  const managed = input.managedRetentionDays;
  if (typeof managed === 'number' && Number.isInteger(managed) && managed >= MIN_RETENTION_DAYS) {
    return { sweep: true, state: 'active', retentionDays: managed, source: 'managed' };
  }

  // The product's own off switch, checked before anything can read a window.
  // Below the managed tier on purpose: managed settings are the top precedence
  // tier and `claude-directory.md#cleaned-up-automatically` names
  // `cleanupPeriodDays` as the key that overrides even the unreadable-settings
  // pause — "When managed settings provide `cleanupPeriodDays`, Claude Code runs
  // the sweep at the managed value in either case" — so an administrator's
  // window still runs. No warning — a deliberate choice is not a problem to
  // report.
  if (input.config.ok && input.config.sweepEnabled === false) {
    return { sweep: false, state: 'disabled' };
  }

  if (!input.config.ok) {
    return {
      sweep: false,
      state: 'paused',
      warning:
        'Retention cleanup is paused because the settings file could not be read or parsed'
        + ` (${input.config.error}). Fix the file, or set cleanupPeriodDays in managed policy, to resume it.`,
    };
  }

  const stored = input.config.retentionDays;
  if (stored === undefined) {
    const fallback = normalizeRetentionDays(input.defaultRetentionDays);
    return fallback >= MIN_RETENTION_DAYS
      ? { sweep: true, state: 'active', retentionDays: fallback, source: 'default' }
      : { sweep: false, state: 'disabled' };
  }

  if (stored === RETENTION_DISABLED) {
    // MIGRATION. `0` is no longer writable, but it is on disk for every install
    // that predates this change, and it is the value that means "never delete
    // my transcripts". Honouring it as "disabled" with a warning is the only
    // option that neither crashes on a file the user already has nor silently
    // starts deleting data at 30 days — which is precisely the pre-v2.1.203
    // regression the docs record: "cleanup ran at the 30-day default in that
    // state and could delete transcripts a longer cleanupPeriodDays was meant
    // to keep."
    return {
      sweep: false,
      state: 'disabled',
      warning:
        'retentionDays is 0, which is no longer a valid setting (minimum 1). Cleanup stays disabled;'
        + ` set it to ${DEFAULT_RETENTION_DAYS} to enable the documented default.`,
    };
  }

  const normalized = normalizeRetentionDays(stored);
  if (normalized < MIN_RETENTION_DAYS) {
    return {
      sweep: false,
      state: 'disabled',
      warning:
        `retentionDays is ${JSON.stringify(stored)}, which is not a valid retention period.`
        + ' Cleanup stays disabled rather than guessing a value that deletes data.',
    };
  }
  return { sweep: true, state: 'active', retentionDays: normalized, source: 'user' };
}

/** What the resolver is told about the settings file it could or could not read. */
export type RetentionConfigRead =
  | { ok: true; retentionDays?: number; sweepEnabled?: boolean }
  | { ok: false; error: string };

function readConfigForRetention(
  config: StoredConfig | null | undefined,
): RetentionConfigRead {
  const project = (stored: StoredConfig | null): RetentionConfigRead => (
    stored === null
      ? { ok: true }
      : {
        ok: true,
        ...(stored.retentionDays === undefined ? {} : { retentionDays: stored.retentionDays }),
        ...(stored.retentionSweepEnabled === undefined ? {} : { sweepEnabled: stored.retentionSweepEnabled }),
      }
  );
  if (config !== undefined) return project(config);
  try {
    return project(loadStoredConfig());
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The decision this machine's configuration produces right now.
 *
 * Exported because the sweep is not the only thing that needs it: a diagnosis
 * surface has to report the pause WITHOUT running a destructive sweep to learn
 * about it, and the settings page has to show the window it would use. Both read
 * this; neither may read `retentionSweepStatus`, which is per-process state only
 * the process that ran the sweep has.
 */
export function readRetentionDecision(
  options: { managedRetentionDays?: number } = {},
): RetentionDecision {
  // A caller that has already loaded the enforced managed policy — the doctor
  // collector does — passes the value instead of depending on whether this
  // process ever registered the provider. An unregistered provider in a
  // short-lived CLI process would otherwise report "no managed value" and
  // describe a pause the running app is not taking.
  const managedRetentionDays = options.managedRetentionDays ?? readManagedRetentionDays();
  return resolveRetentionDecision({
    config: readConfigForRetention(undefined),
    defaultRetentionDays: getDefaultRetentionDays(),
    ...(managedRetentionDays === undefined ? {} : { managedRetentionDays }),
  });
}

/** The effective retention window in days, or 0 when cleanup is off or paused. */
export function getRetentionDays(): number {
  const decision = readRetentionDecision();
  return decision.sweep ? decision.retentionDays : RETENTION_DISABLED;
}

/**
 * Write a new retention value. `0` is REJECTED here — "Setting `0` fails with a
 * validation error" — while a `0` already on disk is honoured as disabled by
 * `resolveRetentionDecision`. New writes are strict; existing files are not
 * retroactively invalidated, because a validation error on a user's config file
 * is a startup crash.
 */
export function setRetentionDays(retentionDays: number): boolean {
  if (
    typeof retentionDays !== 'number'
    || !Number.isInteger(retentionDays)
    || retentionDays < MIN_RETENTION_DAYS
  ) {
    throw new InvalidRetentionDaysError(retentionDays);
  }
  const config = loadConfigForMutation('setRetentionDays');
  if (!config) return false;
  config.retentionDays = retentionDays;
  saveConfig(config);
  return true;
}

/**
 * Turn the age-based sweep on or off.
 *
 * Separate from {@link setRetentionDays} because "off" is not a number here:
 * `settings-reference.md#cleanupperioddays` says "Setting `0` fails validation,
 * so pick a large value such as `3650` for long retention", and
 * `StoredConfigSchema` enforces `.min(1)`, so a 0 written to express "off" would
 * make `validateConfig()` — which the config watcher and the `config_validate`
 * session tool both run — report the user's own choice as an invalid config.
 * Off therefore means `sweep: false` at the decision, never a window so large
 * the sweep "does not reach anything yet".
 */
export function setRetentionSweepEnabled(enabled: boolean): boolean {
  const config = loadConfigForMutation('setRetentionSweepEnabled');
  if (!config) return false;
  config.retentionSweepEnabled = enabled;
  saveConfig(config);
  return true;
}

/**
 * P6.502 — whether every new session starts in never-persist mode.
 *
 * THE ZERO THE CAP CANNOT REACH. `setRetentionDays` rejects 0 and
 * `StoredConfigSchema` enforces `.min(1)`, so "never on disk" is unreachable
 * through the retention window however it is set — and letting the window reach
 * zero would be a false never-persist anyway, because the transcript is written
 * first and deleted afterwards. This setting says the file is never created.
 *
 * WHAT IT COSTS, and it is stated where the mode is entered rather than only
 * here: resume, rewind and search all go. `SessionManager.announceNeverPersistCost`
 * puts that sentence in the transcript, and the badge keeps it visible for the
 * life of the session.
 *
 * Fails CLOSED-TO-NORMAL on an unreadable config, matching every neighbour: a
 * session that silently stopped being saved because a file could not be parsed
 * is exactly the "lost my history to a bug" shape this row exists to remove.
 */
export function getNeverPersistSessions(): boolean {
  let config: StoredConfig | null = null;
  try {
    config = loadStoredConfig();
  } catch {
    config = null;
  }
  if (config?.neverPersistSessions !== undefined) {
    return config.neverPersistSessions === true;
  }
  return loadConfigDefaults().defaults.neverPersistSessions === true;
}

export function setNeverPersistSessions(enabled: boolean): boolean {
  const config = loadConfigForMutation('setNeverPersistSessions');
  if (!config) return false;
  config.neverPersistSessions = enabled;
  saveConfig(config);
  return true;
}

/**
 * The three accepted values, their type and the operator env-var name are
 * DECLARED in `./cross-session-inbound-vocabulary.ts` and re-exported here, so
 * every existing importer of `@nessy-agent/shared/config/storage` is unchanged.
 *
 * They moved because this module reads `fs`, `path` and `crypto`, and
 * `AppSettingsPage.tsx` — which needs only these three constants — was importing
 * them from here. That one edge was the whole second chain of P6.971: it put 175
 * modules importing a node builtin BY NAME into the renderer bundle, each of them
 * a hard rollup error against Vite's `export default {}` stub, and it is what
 * failed the packaged build. The vocabulary module's own header carries the
 * measurement. Anything else the renderer comes to need from this file belongs
 * beside them, not here.
 */
export {
  CROSS_SESSION_INBOUND_SETTINGS,
  CROSS_SESSION_INBOUND_ENV_NAME,
  // DA1.72 — these three MOVED to the vocabulary module, which is what the
  // paragraph above already asks for ("Anything else the renderer comes to need
  // from this file belongs beside them"). The mover was `config/validators.ts`:
  // its import of them from HERE was one of the two edges that made
  // `stored-config-load.ts` reach `credentials`, `sessions` and `docs` through
  // the validators/storage cycle. Re-exported so every existing importer is
  // unchanged.
  CROSS_SESSION_INBOUND_VALUE_MAX,
  crossSessionInboundUnrecognizedSentence,
  describeUnrecognizedCrossSessionInbound,
} from './cross-session-inbound-vocabulary.ts';
export type { CrossSessionInboundSetting } from './cross-session-inbound-vocabulary.ts';

/**
 * P6.182 clause (i) · the user-settings value, or `undefined` for the documented
 * "unset, so Claude Code decides per message".
 *
 * An unrecognized value reads as `undefined` here, matching the vendor's own
 * `z.enum([...]).catch(void 0)` and `parseCrossSessionInboundSetting` in the
 * enforcement module. (The page's newer warn-and-hold treatment of an
 * unrecognized value is a separate, wider divergence recorded as a proposed row;
 * silently dropping is what this fork does at every other rung today, and one
 * rung behaving differently would be worse than all of them behaving alike.)
 *
 * Fails to `undefined` on an unreadable config, like every neighbour: the
 * per-message default is the documented behaviour with no value, so an
 * unparseable file lands on the documented answer rather than on a guess.
 */
export function getCrossSessionInbound(): CrossSessionInboundSetting | undefined {
  let config: StoredConfig | null = null;
  try {
    config = loadStoredConfig();
  } catch {
    return undefined;
  }
  const value = config?.crossSessionInbound;
  return (CROSS_SESSION_INBOUND_SETTINGS as readonly string[]).includes(value as string)
    ? value as CrossSessionInboundSetting
    : undefined;
}


/**
 * P6.868 · everything a settings surface needs to render and edit this key.
 *
 * Modelled on {@link RetentionSettingsV1} beside it: one read, because a surface
 * that composed the layers itself would be a second resolver, and this key has
 * four of them.
 */
export interface CrossSessionInboundSettingsV1 {
  /**
   * The user-settings value, or `undefined` for the FOURTH state — the page's
   * *"Default: unset, so Claude Code decides per message"*, which is a distinct
   * documented behaviour and not a synonym for `accept`.
   */
  readonly mode?: CrossSessionInboundSetting;
  /**
   * Set when the stored value is present and unreadable. The page warns and
   * holds while it is there (P6.866); a surface should offer to clear it.
   */
  readonly unrecognized?: string;
  /**
   * True while the operator control sets the key.
   *
   * `settings-reference.md#crosssessioninbound`, verbatim: *"Claude Code hides it
   * while the `--settings` flag or managed settings set the key"* — because
   * *"a user-settings value wouldn't apply then"*. {@link
   * CROSS_SESSION_INBOUND_ENV_NAME} is this host's stand-in for both.
   *
   * Only one of the three exact spellings LOCKS, and since P6.872 that is a
   * DELIBERATE narrowing rather than a description of the enforcement module.
   * That module now reads this variable as the page's MANAGED half, so an
   * unreadable value there resolves to `refuse` with `explicit: true`
   * (`server-core/src/sessions/cross-session-inbound.ts`, symbol
   * `resolveCrossSessionInboundMode`) — the outcome no longer follows the user's
   * own value while the typo stands.
   *
   * The lock stays false for it anyway, because the sentence this flag renders
   * quotes the variable's VALUE back to the user —
   * `settings.crossSessionInbound.operatorLocked` reads *is set to <mode> on this
   * machine* — and a typo has no readable value to quote there. Naming the
   * refusal on that surface needed a sentence of its own, and P6.1015 built it:
   * {@link operatorUnreadable} below, with
   * `settings.crossSessionInbound.operatorUnreadable` as its wording. This flag
   * is unchanged and stays narrow — that was the point of the split.
   */
  readonly operatorLocked: boolean;
  /** The operator's value, when it locks. For the sentence that says so. */
  readonly operatorMode?: CrossSessionInboundSetting;
  /**
   * P6.1015 · the operator's value is PRESENT and this host cannot read it.
   *
   * The residue {@link operatorLocked} records above, given a field of its own
   * rather than widened into that flag. Since P6.872 the enforcement module
   * (`server-core/src/sessions/cross-session-inbound.ts`, symbol
   * `resolveCrossSessionInboundMode`) reads an unreadable value of this variable
   * as `refuse` with `explicit: true`, so the user's own value stops deciding the
   * outcome while the typo stands — and the card was rendering an editable
   * selector and saying nothing, while `/config`'s `unavailable` gate
   * (`slash-commands/config-command.ts`) has fired on any non-empty value all
   * along. Two host surfaces disagreeing about one key is the defect.
   *
   * The condition mirrors that module exactly — trimmed, case-folded, non-empty,
   * not one of the three — so the two cannot part: an empty or whitespace-only
   * variable is NOT this state (it applies nothing there and nothing here), and a
   * readable one sets {@link operatorMode} instead.
   *
   * Rendered through {@link describeUnrecognizedCrossSessionInbound}, the one
   * renderer of a quoted-and-clamped bad value in this family, so the sentence
   * this feeds cannot quote it a second way and an oversized environment variable
   * cannot become an oversized line.
   */
  readonly operatorUnreadable?: string;
}

/**
 * Read all four states in one call.
 *
 * The two lower-scope files (`.claude/settings.json`, `.claude/settings.local.json`)
 * are deliberately NOT read here: they are per-project and this is an app-wide
 * setting, they can only TIGHTEN whatever wins, and the resolver re-reads them per
 * message by design. A surface should SAY they can tighten — that is the one thing
 * the value alone cannot tell the user — rather than try to show a number that is
 * true only for the workspace that happens to be open.
 */
export function getCrossSessionInboundSettings(): CrossSessionInboundSettingsV1 {
  let raw: unknown;
  try {
    raw = loadStoredConfig()?.crossSessionInbound;
  } catch {
    raw = undefined;
  }
  const known = (value: unknown): value is CrossSessionInboundSetting =>
    (CROSS_SESSION_INBOUND_SETTINGS as readonly string[]).includes(value as string);
  // Case-folded and trimmed, matching the ENV reader in the enforcement module
  // and NOT the settings-file reader: shouting is idiomatic in an env var and
  // exact in a JSON document.
  const operatorTrimmed = process.env[CROSS_SESSION_INBOUND_ENV_NAME]?.trim();
  const operatorRaw = operatorTrimmed?.toLowerCase();
  const operatorMode = known(operatorRaw) ? operatorRaw : undefined;
  return {
    ...(known(raw) ? { mode: raw } : {}),
    ...(!known(raw) && raw !== undefined
      ? { unrecognized: describeUnrecognizedCrossSessionInbound(raw) }
      : {}),
    operatorLocked: operatorMode !== undefined,
    ...(operatorMode ? { operatorMode } : {}),
    // P6.1015 · present, non-empty, and none of the three. The trimmed value is
    // reported rather than the raw one, because that is what the enforcement
    // module compares; `!operatorTrimmed` covers both unset and whitespace-only,
    // which is the same `if (!value)` that module opens with.
    ...(operatorTrimmed && !operatorMode
      ? { operatorUnreadable: describeUnrecognizedCrossSessionInbound(operatorTrimmed) }
      : {}),
  };
}

/**
 * P6.868 · the fourth state, as a WRITE.
 *
 * {@link setCrossSessionInbound} deliberately refuses anything outside the three,
 * so before this there was no way back to unset — a selector offering the page's
 * documented default could store no value that means it. Deleting the key is the
 * only honest spelling: storing a sentinel would make the app's "unset" and a
 * hand-edited file's "unset" two different states.
 */
export function clearCrossSessionInbound(): boolean {
  const config = loadConfigForMutation('clearCrossSessionInbound');
  if (!config) return false;
  delete config.crossSessionInbound;
  saveConfig(config);
  return true;
}

/**
 * Write the user-settings value — what the page says the `/config` row does:
 * *"Claude Code writes the value you select to your user settings."*
 *
 * Rejects anything outside the three, rather than storing it and letting the
 * reader drop it: a value that persists and does nothing is the stated-but-not-
 * enforced shape this key's own module exists to avoid.
 */
export function setCrossSessionInbound(mode: CrossSessionInboundSetting): boolean {
  if (!(CROSS_SESSION_INBOUND_SETTINGS as readonly string[]).includes(mode)) return false;
  const config = loadConfigForMutation('setCrossSessionInbound');
  if (!config) return false;
  config.crossSessionInbound = mode;
  saveConfig(config);
  return true;
}

/**
 * Everything a settings surface needs to render and edit the retention policy.
 *
 * `effectiveDays` is what the sweep would use (0 when it would not run at all),
 * `days` is the stored/default window the input box edits, and `warning` is the
 * paused/disabled sentence — carried here so the surface that offers the control
 * is also the surface that reports why the control is not in force.
 */
export interface RetentionSettingsV1 {
  /** The window the editor shows: the stored value, or the packaged default. */
  days: number;
  /** False only when the user turned the sweep off. */
  sweepEnabled: boolean;
  /** What the sweep would use right now; 0 when it would not run. */
  effectiveDays: number;
  /** Where `effectiveDays` came from; absent when nothing would be swept. */
  source?: RetentionSource;
  /** Present when the sweep is paused or disabled for a reason the user should see. */
  warning?: string;
  /** True when a managed policy owns the window and the local controls cannot change it. */
  managed: boolean;
  /** The documented minimum a write is allowed to carry. */
  minDays: number;
}

export function getRetentionSettings(): RetentionSettingsV1 {
  const decision = readRetentionDecision();
  let stored: number | undefined;
  let sweepEnabled = true;
  try {
    const config = loadStoredConfig();
    stored = config?.retentionDays;
    sweepEnabled = config?.retentionSweepEnabled !== false;
  } catch {
    // An unreadable config is exactly the paused case; the decision already
    // carries the warning, and the editor falls back to the packaged default.
  }
  const fallback = getDefaultRetentionDays();
  const days = typeof stored === 'number' && Number.isInteger(stored) && stored >= MIN_RETENTION_DAYS
    ? stored
    : (fallback >= MIN_RETENTION_DAYS ? fallback : DEFAULT_RETENTION_DAYS);
  return {
    days,
    sweepEnabled,
    effectiveDays: decision.sweep ? decision.retentionDays : RETENTION_DISABLED,
    ...(decision.sweep ? { source: decision.source } : {}),
    ...(decision.warning ? { warning: decision.warning } : {}),
    managed: decision.sweep && decision.source === 'managed',
    minDays: MIN_RETENTION_DAYS,
  };
}

/**
 * Run the age-based retention sweep across every documented path class.
 *
 * Returns the number of SESSIONS removed, which is the number this has always
 * returned; the full per-path report goes to the debug log and, from Task 4, to
 * the sweep status record.
 *
 * Not archived-only any more. `claude-directory.md` describes an age sweep with
 * no archive predicate, and ours had one — so a non-zero retention would still
 * have kept every unarchived transcript forever.
 */
export function runSessionRetentionSweep(
  config?: StoredConfig | null,
  options: { dryRun?: boolean } = {},
): number {
  const managedRetentionDays = readManagedRetentionDays();
  const decision = resolveRetentionDecision({
    config: readConfigForRetention(config),
    defaultRetentionDays: getDefaultRetentionDays(),
    ...(managedRetentionDays === undefined ? {} : { managedRetentionDays }),
  });

  if (!decision.sweep) {
    // A destructive sweep that cannot read its own policy does NOT fall back to
    // a default. It stops and says so.
    retentionSweepStatus = decision.state === 'paused'
      ? { state: 'paused', warning: decision.warning }
      : { state: 'disabled', ...(decision.warning ? { warning: decision.warning } : {}) };
    if (decision.warning) warn(`[retention] ${decision.warning}`);
    return 0;
  }

  // The managed override runs even when the config is unreadable, so the
  // workspace list has to survive that: an unreadable config means "sweep every
  // workspace directory under the sessions root", which is what an omitted
  // `workspaceIds` already does.
  const readable = config === undefined ? safeLoadStoredConfig() : config;
  const workspaceIds = readable?.workspaceRefs.map(workspace => workspace.id);

  try {
    const report = runRetentionSweep({
      configDir: CONFIG_DIR,
      sessionsDir: SESSIONS_DIR,
      cutoffMs: Date.now() - (decision.retentionDays * 24 * 60 * 60 * 1000),
      ...(workspaceIds === undefined ? {} : { workspaceIds }),
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    });
    for (const failure of report.failed) {
      debug('[config] Session retention sweep could not remove', failure.path, ':', failure.error);
    }
    const sessionsRemoved = report.removed.filter(entry => entry.pathClass === 'session').length;
    retentionSweepStatus = {
      state: 'swept',
      retentionDays: decision.retentionDays,
      source: decision.source,
      sessionsRemoved,
      pathsRemoved: report.removed.length,
      ...(decision.warning ? { warning: decision.warning } : {}),
    };
    return sessionsRemoved;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    retentionSweepStatus = { state: 'paused', warning: `Retention cleanup failed: ${message}` };
    warn(`[retention] sweep failed: ${message}`);
    return 0;
  }
}

/** `loadStoredConfig` throws on a corrupt file; the sweep must never propagate that. */
function safeLoadStoredConfig(): StoredConfig | null {
  try {
    return loadStoredConfig();
  } catch {
    return null;
  }
}

/**
 * Unconditional, unlike `debug()`. A paused destructive sweep is not a debug
 * detail — it is the thing the user has to be told about.
 */
function warn(message: string): void {
  debug(message);
  console.warn(message);
}

function runSessionRetentionSweepOnce(): void {
  if (sessionRetentionSweepRan) return;
  sessionRetentionSweepRan = true;

  const deletedCount = runSessionRetentionSweep();
  if (deletedCount > 0) {
    debug(`[config] Session retention sweep deleted ${deletedCount} archived session(s)`);
  }
}


// Legacy credential helpers removed - use connection-aware credential lookup instead:
// - getAnthropicApiKey() → credentialManager.getLlmApiKey(connectionSlug)
// - getClaudeOAuthToken() → credentialManager.getLlmOAuth(connectionSlug)

export function saveConfig(config: StoredConfig): void {
  ensureConfigDir();

  const storageConfig: StoredConfig = {
    ...config,
    storageLayoutVersion: STORAGE_LAYOUT_VERSION,
    workspaceRefs: config.workspaceRefs.map(ref => ({ ...ref })),
  };

  atomicWriteConfigFileSync(CONFIG_FILE, JSON.stringify(storageConfig, null, 2));
}

/**
 * The one rule for every mutator in this file: what a setter does when its
 * backing store is absent.
 *
 * `loadStoredConfig()` returns null for exactly one reason — `config.json` does
 * not exist (every other defect throws `UnsupportedStorageLayoutError`). Both
 * hosts create it before any setter can run: the electron main process through
 * `ensureStorageLayoutV2` (`workspaces/storage-readiness.ts`), the headless
 * server through that plus `ensureGlobalConfigExists`. So a null here means the
 * file went away AFTER boot, and neither host ever re-checks.
 *
 * **P2.357 — and the safety of that reading is CONTINGENT ON A FEATURE NOT
 * EXISTING.** On a healthy host the null branch is not merely rare, it is
 * unreachable, and it is unreachable for exactly one reason: `clearAllConfig()`
 * — the only in-process deleter of `config.json` — is DEAD CODE. Wire a reset
 * or a logout feature to it and EVERY mutator that calls this helper goes live
 * in one commit, in a state nothing has ever exercised. So read the three-part
 * argument below as an argument about an IMPOSSIBLE state; whether
 * warn-and-return-`false` is still the right answer once the state is ORDINARY
 * is a separate question, deliberately left open (owner D18, 2026-09-05:
 * record the dependency now, revisit only if a reset/logout feature is built).
 * `clearAllConfig` carries the other half of this note.
 *
 * Three things this deliberately does NOT do, each for a measured reason:
 *
 *  - It does not CREATE the config. That is the exact shape
 *    `UnsupportedStorageLayoutError` exists to prevent (see `loadStoredConfig`'s
 *    docblock: callers treating a falsy return as "no config yet" and writing a
 *    fresh empty config "destroying a real legacy config.json"). It would also
 *    bypass the host lease and the v2 tree install, which are the only things
 *    allowed to build a storage root.
 *
 *  - It does not THROW. These setters are called from RPC handlers, window and
 *    auto-update event handlers, and boot-time cleanup (`clearGitBashPath` at
 *    `apps/electron/src/main/index.ts:676`). Turning a cosmetic persistence
 *    failure into an exception on those paths converts "a setting was not
 *    saved" into "boot died" or "a cleanup path was skipped" — the failure mode
 *    a sibling row spent a lane removing from teardown code.
 *
 *  - It does not stay SILENT, which is what every one of these setters used to
 *    do. The caller believed state changed and it had not.
 *
 * **How many setters that is is a reading with a date, not a fact.** This
 * docblock said 34 (P2.293's measurement) and `grep -ac "loadConfigForMutation('"
 * packages/shared/src/config/storage.ts` answers **47** on 2026-09-07 — the
 * helper acquired thirteen more callers while the prose stood still, which is
 * the drift AGENTS.md records for every count kept beside a list. Run the grep;
 * do not quote this number either.
 *
 * So: warn unconditionally, and hand the caller a `false` it can act on. This
 * generalises what `setGitBashPath` already did and documented ("Returns false
 * if the config could not be loaded") to its silent siblings.
 */
function loadConfigForMutation(setter: string): StoredConfig | null {
  const config = loadStoredConfig();
  if (!config) {
    warn(`[config] ${setter}: config.json is absent — the change was NOT persisted.`);
    return null;
  }
  return config;
}

// Legacy updateApiKey() removed - use setupLlmConnection IPC handler instead.

// Legacy getters/setters removed - use LLM connections instead:
// - getAuthType/setAuthType -> derive from getDefaultLlmConnection()/getLlmConnection()
// - getAnthropicBaseUrl/setAnthropicBaseUrl -> use connection.baseUrl
// - getCustomModel/setCustomModel -> use connection.defaultModel


/**
 * The whole desktop-notification policy: the three-position turn-completion
 * timing plus the page's two separate alert controls.
 *
 * `learn.chatgpt.com/docs/notifications.md#configure-desktop-notifications` —
 * "Open [**Settings**](codex://settings) to choose whether turn-completion
 * alerts appear never, only while ChatGPT is in the background, or always.
 * Separate controls let you turn permission and question notifications on or
 * off."
 *
 * Resolution order per key: the stored key, then what the replaced boolean
 * meant, then the bundled defaults. Per key rather than per object, so a config
 * that carries only `notificationTiming` still gets its alert controls from the
 * boolean the user actually set.
 *
 * The bundled defaults are read LAZILY, and only when nothing above answered.
 * `loadConfigDefaults` throws when the config dir has no synced defaults file,
 * and the boolean this replaced reached it only on the same last resort — an
 * eager read here would turn a config that answers the question perfectly well
 * into a throw.
 */
export function getNotificationSettings(): NotificationSettings {
  const config = loadStoredConfig();
  const legacy = notificationSettingsFromLegacyEnabled(
    typeof config?.notificationsEnabled === 'boolean' ? config.notificationsEnabled : undefined,
  );

  let bundled: ConfigDefaults['defaults'] | undefined;
  const defaults = (): ConfigDefaults['defaults'] => (bundled ??= loadConfigDefaults().defaults);

  const timing = isNotificationTiming(config?.notificationTiming)
    ? config.notificationTiming
    : legacy?.timing ?? (isNotificationTiming(defaults().notificationTiming)
      ? defaults().notificationTiming
      : DEFAULT_NOTIFICATION_TIMING);

  const permissionAlerts = typeof config?.notificationPermissionAlerts === 'boolean'
    ? config.notificationPermissionAlerts
    : legacy?.permissionAlerts ?? defaults().notificationPermissionAlerts !== false;

  const questionAlerts = typeof config?.notificationQuestionAlerts === 'boolean'
    ? config.notificationQuestionAlerts
    : legacy?.questionAlerts ?? defaults().notificationQuestionAlerts !== false;

  return { timing, permissionAlerts, questionAlerts };
}

/**
 * Write the whole policy.
 *
 * The legacy boolean is written alongside so the two never contradict each
 * other in the same file: a reader still on `getNotificationsEnabled` must not
 * see `true` next to a stored timing of "never".
 */
export function setNotificationSettings(settings: NotificationSettings): boolean {
  const config = loadConfigForMutation('setNotificationSettings');
  if (!config) return false;
  config.notificationTiming = settings.timing;
  config.notificationPermissionAlerts = settings.permissionAlerts;
  config.notificationQuestionAlerts = settings.questionAlerts;
  config.notificationsEnabled = settings.timing !== 'never';
  saveConfig(config);
  return true;
}

/**
 * Get whether desktop notifications are enabled at all.
 *
 * Now derived: "enabled" is every position except the page's first one.
 */
export function getNotificationsEnabled(): boolean {
  return getNotificationSettings().timing !== 'never';
}

/**
 * Set whether desktop notifications are enabled.
 *
 * The pre-three-position entry point, kept for callers that still speak in a
 * boolean. Turning notifications ON does NOT move an existing "always" back to
 * "background" — that would silently undo a choice this boolean cannot express.
 */
export function setNotificationsEnabled(enabled: boolean): boolean {
  const current = getNotificationSettings();
  if (enabled && current.timing !== 'never') return true;
  return setNotificationSettings(
    enabled
      ? { ...current, timing: DEFAULT_NOTIFICATION_TIMING, permissionAlerts: true, questionAlerts: true }
      : { timing: 'never', permissionAlerts: false, questionAlerts: false },
  );
}

/**
 * UB6.1 (DEC-0) — decision layer (Jev / TypeSafe System One) settings with
 * defaults applied. Off by default; the `enabled` switch is the only master gate.
 * See `../decisions/settings.ts` for the shape and `../decisions/resolve.ts` for
 * the gate order (switch → feature toggle → key → endpoint).
 */
export function getDecisionLayerSettings(): DecisionLayerSettings {
  const config = loadStoredConfig();
  return normalizeDecisionLayerSettings(config?.decisionLayer);
}

/**
 * UB6.1 — merge a settings patch (features merge key-wise; `null` clears an
 * optional string) and persist. Returns the normalized result. Throws when
 * config.json is absent: callers display the returned value — do not pretend a
 * write happened.
 */
export function setDecisionLayerSettings(patch: Partial<Record<keyof DecisionLayerStoredSettings, unknown>>): DecisionLayerSettings {
  const config = loadConfigForMutation('setDecisionLayerSettings');
  if (!config) {
    throw new Error('Cannot save decision model settings: config.json is not initialized');
  }
  config.decisionLayer = mergeDecisionLayerSettings(config.decisionLayer, patch);
  saveConfig(config);
  return normalizeDecisionLayerSettings(config.decisionLayer);
}

/**
 * Get whether auto-capitalisation is enabled.
 * Defaults to true if not set.
 */
export function getAutoCapitalisation(): boolean {
  const config = loadStoredConfig();
  if (config?.autoCapitalisation !== undefined) {
    return config.autoCapitalisation;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.autoCapitalisation;
}

/**
 * Set whether auto-capitalisation is enabled.
 */
export function setAutoCapitalisation(enabled: boolean): boolean {
  const config = loadConfigForMutation('setAutoCapitalisation');
  if (!config) return false;
  config.autoCapitalisation = enabled;
  saveConfig(config);
  return true;
}

/**
 * Get the key combination used to send messages.
 * Defaults to 'enter' if not set.
 */
export function getSendMessageKey(): 'enter' | 'cmd-enter' {
  const config = loadStoredConfig();
  if (config?.sendMessageKey !== undefined) {
    return config.sendMessageKey;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.sendMessageKey;
}

/**
 * Set the key combination used to send messages.
 */
export function setSendMessageKey(key: 'enter' | 'cmd-enter'): boolean {
  const config = loadConfigForMutation('setSendMessageKey');
  if (!config) return false;
  config.sendMessageKey = key;
  saveConfig(config);
  return true;
}

/**
 * Get whether spell check is enabled in the input.
 */
export function getSpellCheck(): boolean {
  const config = loadStoredConfig();
  if (config?.spellCheck !== undefined) {
    return config.spellCheck;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.spellCheck;
}

/**
 * Set whether spell check is enabled in the input.
 */
export function setSpellCheck(enabled: boolean): boolean {
  const config = loadConfigForMutation('setSpellCheck');
  if (!config) return false;
  config.spellCheck = enabled;
  saveConfig(config);
  return true;
}

/**
 * Get whether screen should stay awake while sessions are running.
 * Defaults to false if not set.
 */
export function getKeepAwakeWhileRunning(): boolean {
  const config = loadStoredConfig();
  if (config?.keepAwakeWhileRunning !== undefined) {
    return config.keepAwakeWhileRunning;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.keepAwakeWhileRunning;
}

/**
 * Set whether screen should stay awake while sessions are running.
 */
export function setKeepAwakeWhileRunning(enabled: boolean): boolean {
  const config = loadConfigForMutation('setKeepAwakeWhileRunning');
  if (!config) return false;
  config.keepAwakeWhileRunning = enabled;
  saveConfig(config);
  return true;
}

/**
 * Get whether rich tool descriptions are enabled.
 * When enabled, all tool calls include intent and display name metadata.
 * Defaults to true if not set.
 */
export function getRichToolDescriptions(): boolean {
  const config = loadStoredConfig();
  if (config?.richToolDescriptions !== undefined) {
    return config.richToolDescriptions;
  }
  return true;
}

/**
 * Set whether rich tool descriptions are enabled.
 */
export function setRichToolDescriptions(enabled: boolean): boolean {
  const config = loadConfigForMutation('setRichToolDescriptions');
  if (!config) return false;
  config.richToolDescriptions = enabled;
  saveConfig(config);
  return true;
}

/**
 * Get whether extended prompt cache (1h TTL) is enabled.
 * When enabled, the interceptor upgrades cache_control TTL from 5m to 1h.
 * Defaults to false if not set.
 */
export function getExtendedPromptCache(): boolean {
  const config = loadStoredConfig();
  return config?.extendedPromptCache ?? false;
}

/**
 * P6.370 — the user's answer to *"may the model answering me be swapped for
 * another one without my consent?"*, and the reason it is a THREE-STATE read.
 *
 * `switchModelsOnFlag` is the vendored SDK's own settings key (7 lines / 13
 * occurrences in the `2.1.247` binary, re-measured 2026-09-12 — it read "23
 * occurrences" at `2.1.233` with no instrument named; C3.252/C3.294) and it
 * defaults ON: when Anthropic's safety
 * classifier flags a turn, the child silently re-runs it on a different model.
 * Until this row we exposed no control over it at all.
 *
 * UNSET means "leave the vendor's default alone", and that is not the same as
 * `true`: an install that never touched this key must spawn byte-identically to
 * one built before the row, so an unset value projects NOTHING rather than
 * projecting `true`. Only an explicit `false` travels — see
 * `buildClaudeSwitchModelsOnFlagSettings` in `agent/claude-auto-mode-policy.ts`
 * for where it binds and where it is inert.
 *
 * Unknown-tolerant like every neighbour on the strict envelope: anything that
 * is not a boolean reads as unset, i.e. today's behaviour, rather than bricking
 * `config.json`.
 */
export function getClaudeSwitchModelsOnFlag(): boolean | undefined {
  const config = loadStoredConfig();
  const raw = (config as { claudeSwitchModelsOnFlag?: unknown } | null | undefined)
    ?.claudeSwitchModelsOnFlag;
  return typeof raw === 'boolean' ? raw : undefined;
}

/**
 * P6.313 — the user's answer to *"should this runtime's own Explore and Plan
 * subagents be in my roster?"*, and a THREE-STATE read for `switchModelsOnFlag`'s
 * reason above.
 *
 * `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS` is the runtime's own switch (4
 * lines / 4 occurrences in the vendored `2.1.247` binary, re-measured
 * 2026-09-12 — it read "6 occurrences" at `2.1.233` with no instrument named;
 * C3.252/C3.294) and the pair is ON by default.
 * `env-vars.md#variables`, verbatim: *"Set to `1` to disable the built-in
 * Explore and Plan subagents. Claude explores with its search tools or the
 * general-purpose subagent instead, and plan mode reads files directly rather
 * than launching Explore and Plan agents. Custom subagents named `Explore` or
 * `Plan` are unaffected."*
 *
 * UNSET means "leave the vendor's default alone" and is NOT the same as `true`:
 * an install that never touched this key must spawn byte-identically to one
 * built before the row, so an unset value emits NOTHING. Only an explicit
 * `false` travels — see `buildClaudeRuntimeBuiltinAgentEnv` in
 * `agent/claude-runtime-builtin-agent-env.ts` for the one turn shape where it
 * changes anything, and for why codex has no counterpart to offer.
 *
 * Unknown-tolerant like every neighbour on the strict envelope: anything that is
 * not a boolean reads as unset, i.e. today's behaviour, rather than bricking
 * `config.json`.
 */
export function getClaudeExplorePlanAgentsEnabled(): boolean | undefined {
  const config = loadStoredConfig();
  const raw = (config as { claudeExplorePlanAgentsEnabled?: unknown } | null | undefined)
    ?.claudeExplorePlanAgentsEnabled;
  return typeof raw === 'boolean' ? raw : undefined;
}

/**
 * P6.515 — the one operator/user append that reaches the main model's system
 * prompt on all three runtimes.
 *
 * APPEND ONLY, by the delegated owner decision of 2026-09-05 (Q-den 46, option
 * 2). There is deliberately no replacing key here and there will not be one:
 * `prompts/system-prompt-append.ts` carries the refusal beside the four
 * `cli-reference.md` flag names a reader comes looking for, and the two
 * measured reasons.
 *
 * Returned RAW. Trimming, the empty-means-absent rule and the fenced section are
 * `systemPromptAppendSection`'s, so the three runtimes cannot drift by reading
 * the setting three different ways.
 *
 * Unknown-tolerant like every neighbour on the strict envelope: a non-string
 * reads as unset, i.e. today's behaviour, rather than bricking `config.json`.
 */
export function getSystemPromptAppend(): string | undefined {
  const config = loadStoredConfig();
  const raw = (config as { systemPromptAppend?: unknown } | null | undefined)?.systemPromptAppend;
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * P6.312 — the agent a session runs AS, rather than one it can delegate to.
 *
 * NATIVE-FIRST, and only one of the three runtimes has a mechanism. The Claude
 * Agent SDK declares `Options.agent` — *"Agent name for the main thread. When
 * specified, the agent's system prompt, tool restrictions, and model will be
 * applied to the main conversation. The agent must be defined either in the
 * `agents` option or in settings."* — and the same name as a `Settings` member,
 * *"Name of an agent (built-in or custom) to use for the main thread"*. codex
 * layers role config for SPAWNED agents only; Pi's harness manifest has no
 * main-session-agent path at all. So the host holds ONE name and each runtime
 * projects it as far as it can, which is what makes the residual difference
 * legible instead of silent.
 *
 * ONE KEY, HOST-WIDE, and deliberately not claude's own spelling. Naming it
 * `agent` would collide with `.claude/settings.json`'s member, which the child
 * reads for itself out of `settingSources` — two files, one name, and only one
 * of them reaching Pi and codex is worse than two names with a stated
 * relationship.
 *
 * THE MODEL IS NOT PINNED (owner decision 2026-09-07, option (b)). The SDK's
 * sentence above says the agent's model is applied to the main conversation;
 * this host withholds that half, because pinning it would give one session two
 * upstream answers — the connection's and the agent's — which is the ledger K7
 * demotion the row was written against. The prompt, the tools and the
 * `initialPrompt` are pinned; the model declaration is dropped and SAID on the
 * degradation channel rather than dropped silently.
 *
 * Unknown-tolerant like every neighbour on the strict envelope: a non-string
 * reads as "no pinned agent", i.e. today's behaviour, rather than bricking
 * `config.json`. Empty and blank read the same way, so a user clearing the
 * value gets the ordinary session back rather than an agent named `''`.
 */
export function getSessionAgentName(): string | undefined {
  const config = loadStoredConfig();
  const raw = (config as { sessionAgent?: unknown } | null | undefined)?.sessionAgent;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * P6.500 — the size at which reopening a conversation asks compact-or-keep.
 *
 * NATIVE-FIRST, and there is nothing to enable: this is a host dialog over our
 * own transcript. The compaction it invokes is each runtime's own and already
 * exists on all three (ledger E10), so only the TRIGGER and the DEFAULT were
 * open — and the row required them to be a named setting with a default written
 * down rather than an unexplained constant.
 *
 * THE DEFAULT IS THE PAGE'S OWN NUMBER, not one of ours.
 * `sessions.md#resume-from-a-summary`, verbatim: *"On a Pro or Max plan, when
 * you resume a session that has been inactive for more than about an hour and is
 * over 100,000 tokens, Claude Code restores the conversation and then opens a
 * dialog before you send your first message."* Upstream gates it on a plan tier
 * we do not have, so the tier drops and the two measurements stay.
 *
 * ZERO OR NEGATIVE TURNS IT OFF, which is how the page's third answer is
 * spelled here: *"**Don't ask me again**: resumes the full session and stops
 * showing the dialog on all future resumes."* One number with a documented off
 * value beats a second key or a union type, and it lives where every other host
 * trigger lives.
 *
 * P6.950 gave that answer its BUTTON — the card ships all three now — and
 * {@link disableReopenCompactPrompt} is the write behind it. This paragraph said
 * *"the third answer the page's dialog has and this card does not"* until then.
 *
 * Unknown-tolerant like every neighbour on the strict envelope: a non-number
 * reads as the default rather than bricking `config.json`.
 */
export const REOPEN_COMPACT_PROMPT_DEFAULT_TOKENS = 100_000;

export function getReopenCompactPromptTokens(): number {
  const config = loadStoredConfig();
  const raw = (config as { reopenCompactPromptTokens?: unknown } | null | undefined)?.reopenCompactPromptTokens;
  return typeof raw === 'number' && Number.isFinite(raw)
    ? raw
    : REOPEN_COMPACT_PROMPT_DEFAULT_TOKENS;
}

/**
 * P6.950 — the page's third answer, as the one field write behind it.
 *
 * `sessions.md#resume-from-a-summary`, verbatim: *"**Don't ask me again**:
 * resumes the full session and stops showing the dialog on all future
 * resumes."* The "resumes the full session" half is the card's own as-is answer
 * and needs nothing here; the "stops showing the dialog" half is this.
 *
 * WRITES ZERO rather than deleting the key, and that is deliberate: zero is the
 * off value {@link getReopenCompactPromptTokens} already documents and
 * `shouldOfferReopenCompaction` already refuses to offer at, so the answer lands
 * on the SAME switch an operator reaches through `config.json`. Deleting the key
 * would restore the default instead, i.e. resume asking — the opposite of what
 * the user clicked.
 *
 * NARROW ON PURPOSE, and the balance rule is why: the only value this card can
 * ever write is the off one. A general setter would be a second way to set a
 * threshold that no surface offers, and every runtime lift makes an unused
 * setter one more thing to keep true.
 */
export function disableReopenCompactPrompt(): boolean {
  const config = loadConfigForMutation('disableReopenCompactPrompt');
  if (!config) return false;
  config.reopenCompactPromptTokens = 0;
  saveConfig(config);
  return true;
}

/**
 * Set whether extended prompt cache (1h TTL) is enabled.
 */
export function setExtendedPromptCache(enabled: boolean): boolean {
  const config = loadConfigForMutation('setExtendedPromptCache');
  if (!config) return false;
  config.extendedPromptCache = enabled;
  saveConfig(config);
  return true;
}

/**
 * Get whether the built-in browser tool is enabled.
 * When disabled, browser_tool is not included in session tools.
 * Defaults to true if not set.
 */
export function getBrowserToolEnabled(): boolean {
  const config = loadStoredConfig();
  if (config?.browserToolEnabled !== undefined) {
    return config.browserToolEnabled;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.browserToolEnabled;
}

/**
 * Set whether the built-in browser tool is enabled.
 */
export function setBrowserToolEnabled(enabled: boolean): boolean {
  const config = loadConfigForMutation('setBrowserToolEnabled');
  if (!config) return false;
  config.browserToolEnabled = enabled;
  saveConfig(config);

  // Clear session tool caches so all sessions pick up the change immediately.
  // Lazy import to avoid circular dependency (storage ← session-scoped-tools ← storage).
  import('../agent/session-scoped-tools.ts').then(m => m.invalidateAllSessionToolsCaches()).catch(() => {});
  return true;
}

/**
 * Whether remote agents may call `browser_tool evaluate <expression>` against this
 * desktop client's local browser. The check is enforced inside the local capability
 * dispatcher; the remote server cannot override it.
 *
 * Defaults to true. Users can flip it off in Settings → AI → Advanced if they don't
 * trust the remote workspaces they connect to.
 */
export function getAllowRemoteEvaluate(): boolean {
  const config = loadStoredConfig();
  if (config?.allowRemoteEvaluate !== undefined) {
    return config.allowRemoteEvaluate;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.allowRemoteEvaluate;
}

export function setAllowRemoteEvaluate(allowed: boolean): boolean {
  const config = loadConfigForMutation('setAllowRemoteEvaluate');
  if (!config) return false;
  config.allowRemoteEvaluate = allowed;
  saveConfig(config);
  return true;
}

/**
 * Get whether MEMORY.md prompt injection and the remember tool are enabled.
 * Defaults to the bundled config default (true).
 */
export function getMemoryEnabled(): boolean {
  const config = loadStoredConfig();
  if (config?.memoryEnabled !== undefined) {
    return config.memoryEnabled;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.memoryEnabled ?? true;
}

/**
 * P6.272 — one switch that turns file checkpointing off on every runtime.
 *
 * ## The row's premise was REFUTED by the page, and the refutation is the design
 *
 * The row says claude's key is *"honoured from project settings via
 * `settingSources`, so a claude session can already turn it off behind our
 * back"*. `settings-reference.md#filecheckpointingenabled` says otherwise, in
 * its own last paragraph: *"In a `-p` run or an Agent SDK session, Claude Code
 * ignores this key. The SDK turns checkpointing on with its
 * `enableFileCheckpointing` option, and a bare `-p` run needs
 * `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true`."* Every session this product
 * runs is an Agent SDK session, so the child never reads the key at all and
 * there was no behind-our-back arm to close. The lever on claude is the SDK
 * OPTION, which is exactly the "the child RECEIVES it" shape `done_means` asks
 * for — and it is what `claude-agent.ts` now sets.
 *
 * ## The name is Claude's, deliberately
 *
 * `fileCheckpointingEnabled`, verbatim from that page (*"Turn off or on the file
 * snapshots that `/rewind` restores"*, Type Boolean, Default `true`), because a
 * user who has met it there should not have to learn a second spelling for the
 * same idea. It is HOST-side here: on Pi and `nestor-cloud-agent` the host owns
 * the producer (`createFileCheckpoint`), and on claude and codex there is no
 * documented-name switch of ours to honour.
 *
 * Default `true` — the page's default, and today's behaviour. Unknown-tolerant
 * like every neighbour on the strict envelope: anything that is not a boolean
 * reads as unset rather than bricking `config.json`.
 */
export function getFileCheckpointingEnabled(): boolean {
  const config = loadStoredConfig();
  const raw = (config as { fileCheckpointingEnabled?: unknown } | null | undefined)
    ?.fileCheckpointingEnabled;
  return typeof raw === 'boolean' ? raw : true;
}

/** @see getFileCheckpointingEnabled */
/**
 * P6.217 — the session-level built-in TOOL UNIVERSE, resolved once for all three
 * runtimes.
 *
 * Denominator A55, and it was the rare row where nothing had to be BUILT on two
 * of the three legs: claude has `Options.allowedTools`/`disallowedTools` and Pi
 * has `piAllowedTools`, already enforced (`base-agent.ts` reads it as *"the
 * turn's tool universe when the host pins one"*). What was missing was an INPUT
 * — `allowedTools` had no producer anywhere in this tree, and `disallowedTools`
 * came from a host CONSTANT rather than from the user.
 *
 * Codex is structurally denied and is NOT silently dropped: its
 * `enabled_tools`/`disabled_tools` reach MCP servers only (ledger A10, restated
 * in `config-writer.ts`), so there is no per-tool wall to project onto. The cost
 * of that difference is P6.596's switch row.
 *
 * Empty arrays and absence mean the same thing — no restriction — because a
 * whitelist that is present but empty would otherwise deny every tool, which is
 * the failure direction that bricks a session rather than narrowing it. Entries
 * are trimmed and de-duplicated; a non-array reads as absent, like every
 * neighbour on this tier.
 *
 * ## P6.912 — it reads `config.json`, and the reason is that the old home could
 * not hold a value
 *
 * Until this row the two keys sat in `config-defaults.json`'s
 * `workspaceDefaults`. That file is not a user file: `syncConfigDefaults` above
 * writes the BUNDLED asset over the user copy on every launch, and the bundled
 * asset ships neither key — so a hand-written entry was gone by the next start
 * and this function returned two empty lists on every install that has ever
 * shipped. The feature was described as live in three places (`validators.ts`,
 * the doctor, `runtime-switch-costs.ts`) and its input was structurally empty.
 *
 * WHAT AN EXISTING INSTALL SEES: nothing changes. No install could carry a value
 * in the old home, so there is no value to migrate and no fallback read to keep
 * — a fallback would be dead code guarding a state that cannot exist. What
 * changes is that writing the key into `config.json` now works, which it never
 * did anywhere.
 */
export function getSessionToolUniverse(): { allowed: string[]; disallowed: string[] } {
  const config = loadStoredConfig() as {
    sessionAllowedTools?: unknown;
    sessionDisallowedTools?: unknown;
  } | null | undefined;
  const names = (raw: unknown): string[] => {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const name = entry.trim();
      if (name) seen.add(name);
    }
    return [...seen];
  };
  return { allowed: names(config?.sessionAllowedTools), disallowed: names(config?.sessionDisallowedTools) };
}

export function setFileCheckpointingEnabled(enabled: boolean): boolean {
  const config = loadConfigForMutation('setFileCheckpointingEnabled');
  if (!config) return false;
  config.fileCheckpointingEnabled = enabled;
  saveConfig(config);
  return true;
}

export function setMemoryEnabled(enabled: boolean): boolean {
  const config = loadConfigForMutation('setMemoryEnabled');
  if (!config) return false;
  config.memoryEnabled = enabled;
  saveConfig(config);
  return true;
}

/**
 * **P6.390(2) — `autoMemoryDirectory`: where auto memory is written, when the
 * default place is not the one the user wants.**
 *
 * `settings-reference.md#automemorydirectory`, verbatim: *"Store auto memory in
 * a directory of your choice instead of the per-project default."* Type: *"string,
 * an absolute or `~/`-prefixed directory path"*; default *"unset, so Claude Code
 * uses `~/.claude/projects/<project>/memory/`"*. This fork's user-scope
 * equivalent of that store is `CONFIG_DIR/MEMORY.md`, and
 * `getUserMemoryFilePath` is what this moves.
 *
 * ## Validation, taken from the shipped binary rather than guessed
 *
 * The bundle's own rejection predicate, read out of the vendored `darwin-arm64`
 * `claude` around this name (9 occurrences; `plansDirectory` 7 is the positive
 * control that the probe reads the file): a value is refused when it is not
 * absolute, when its length is under 3, when it matches a bare Windows drive
 * (`/^[A-Za-z]:$/`), or when it contains a NUL byte. A leading `~/` is expanded
 * first. All four are reproduced here — a RELATIVE auto-memory directory would
 * otherwise follow the process's working directory from chat to chat, which is
 * the one failure this setting must not have.
 *
 * ## USER SCOPE ONLY, and that is a decision with evidence, not an omission
 *
 * The row asks for project scope under the workspace-trust rider. It is refused
 * here, and both available sources say the same thing:
 *
 *  - The bundle's own schema text for this key: *"Ignored if set in
 *    projectSettings (checked-in .claude/settings.json) for security."* (Its
 *    resolver does read a project layer behind a trust gate, so the two
 *    disagree; the describe string is the stated contract and the safer arm.)
 *  - This fork's only project-scope settings surface is
 *    `.nessy-agent/config.toml`'s `[defaults]` typed allowlist, whose own
 *    docblock says a project file *"can never grant trust, credentials, provider
 *    auth, environment, filesystem roots or shell commands."* An absolute
 *    directory path IS a filesystem root, and a cloned repository could point it
 *    anywhere the app can write.
 *
 * `resolvePlansDirectory` below is the opposite case and would be admissible at
 * project scope by the same reasoning, because it cannot escape the project
 * root.
 *
 * **`config/validators.ts` declares this key, and must keep declaring it.**
 * `StoredConfigTopLevelSchema` is `.strict()` and `loadStoredConfig` throws
 * `UnsupportedStorageLayoutError` on a failed parse, so an undeclared top-level
 * key costs the user EVERY setting in `config.json` — the exact trap the `env`
 * block below records. The declaration landed with this row; deleting it does
 * not merely disable the getter, it bricks the config file of every user who
 * followed the page.
 */
export function getAutoMemoryDirectory(): string | undefined {
  const config = loadStoredConfig();
  const raw = (config as { autoMemoryDirectory?: unknown } | null)?.autoMemoryDirectory;
  if (raw === undefined || raw === null) return undefined;
  try {
    return parseAutoMemoryDirectory(raw);
  } catch (error) {
    reportRejectedUserSettingsLayer('autoMemoryDirectory', error);
    return undefined;
  }
}

/**
 * The RULE, separated from the config read so it can be exercised at all.
 *
 * Exporting the predicate is what makes the four documented refusals testable
 * without writing a config file for each, and it is the half a caller with a
 * value from somewhere else (a managed layer, an import) needs. This docblock
 * used to add that {@link getAutoMemoryDirectory} could not be driven
 * end-to-end at all, because the strict envelope refused a fixture config
 * carrying the key; `config/validators.ts` declares it now, and the suite's
 * envelope arm does drive it.
 */
export function parseAutoMemoryDirectory(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(
      '`autoMemoryDirectory` must be a non-empty string: an absolute or `~/`-prefixed directory path',
    );
  }
  const trimmed = raw.trim();
  if (trimmed.includes('\u0000')) {
    throw new Error('`autoMemoryDirectory` must not contain a NUL byte');
  }
  // ONLY the tilde is expanded, and that is a correction rather than a
  // shortcut: `expandPath` RESOLVES a still-relative path against
  // `process.cwd()`, so passing the raw value through it turns `memories` — the
  // exact shape the bundle refuses — into an accepted absolute path that
  // silently follows whichever directory the process happened to start in.
  // Measured while writing this row's negative arm, which passed against the
  // obvious implementation.
  const expanded = trimmed === '~' || trimmed.startsWith('~/') ? expandPath(trimmed) : trimmed;
  if (!isAbsolute(expanded) || expanded.length < 3 || /^[A-Za-z]:$/.test(expanded)) {
    throw new Error(
      '`autoMemoryDirectory` must resolve to an absolute directory path'
      + ` (\`~/\` is expanded); got \`${expanded}\``,
    );
  }
  return expanded;
}

/**
 * **P6.390(2) — `plansDirectory`: where plan files are written.**
 *
 * `settings-reference.md#plansdirectory`, verbatim: *"Claude Code resolves the
 * path relative to the project root and keeps the default when the path resolves
 * outside it."* Type: *"string, a path relative to the project root"*; default
 * *"unset, so Claude Code uses `~/.claude/plans`"*.
 *
 * The containment rule and its diagnostic are the bundle's, not an invention:
 * its resolver takes `plansDirectory`, resolves it against the project root, and
 * on a path that escapes logs `plansDirectory must be within project root: <value>`
 * at `level: "error"` and returns the DEFAULT. The same shape is kept here — a
 * refusal that falls back, never one that throws, because a settings typo must
 * not be able to stop a session from writing a plan.
 *
 * Returns `undefined` for "unset, or set to something that escapes", which the
 * caller reads as today's fixed path. Declared in `config/validators.ts` for
 * the reason {@link getAutoMemoryDirectory} records.
 */
export function resolvePlansDirectory(projectRoot: string | undefined): string | undefined {
  if (!projectRoot) return undefined;
  const config = loadStoredConfig();
  const raw = (config as { plansDirectory?: unknown } | null)?.plansDirectory;
  if (raw === undefined || raw === null) return undefined;
  try {
    return resolvePlansDirectoryIn(projectRoot, raw);
  } catch (error) {
    reportRejectedUserSettingsLayer('plansDirectory', error);
    return undefined;
  }
}

/**
 * The containment RULE, separated from the config read for the reason
 * {@link parseAutoMemoryDirectory} records. Throws with the bundle's own
 * message so the caller decides between reporting and falling back; every
 * caller in this file falls back.
 */
export function resolvePlansDirectoryIn(projectRoot: string, raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.includes('\u0000')) {
    throw new Error('`plansDirectory` must be a non-empty string: a path relative to the project root');
  }
  const root = resolve(projectRoot);
  const candidate = resolve(root, raw.trim());
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new Error(`plansDirectory must be within project root: ${raw.trim()}`);
  }
  return candidate;
}

/**
 * Get whether the user has accepted responsibility for `bypassPermissions`
 * on this install (`permission-modes.md`'s one-time warning dialog). Defaults
 * to false — never acknowledged. No config-defaults.json fallback: unlike a
 * feature toggle, this flag has no meaningful "factory default" other than
 * false, so it is read directly like {@link getExtendedPromptCache}.
 */
export function getBypassPermissionsAcknowledged(): boolean {
  const config = loadStoredConfig();
  return config?.bypassPermissionsAcknowledged === true;
}

/**
 * Set whether the user has accepted responsibility for `bypassPermissions`.
 * Reached only from the renderer's own gate — the dialog's accept path and the
 * one-way migration of the legacy localStorage flag — through the
 * `permissions:setBypassPermissionsAcknowledged` channel, which is LOCAL_ONLY
 * so a remote server hosting a shared workspace can never answer or store it.
 * NOT reachable from `update_user_preferences` or any other model-invocable
 * tool (those write `preferences.json` via a closed args allowlist that does
 * not include this field; this key lives in the separate config.json tier
 * entirely, so no session tool touches it at all).
 */
export function setBypassPermissionsAcknowledged(acknowledged: boolean): boolean {
  const config = loadConfigForMutation('setBypassPermissionsAcknowledged');
  if (!config) return false;
  config.bypassPermissionsAcknowledged = acknowledged;
  saveConfig(config);
  return true;
}

/**
 * Write the USER layer's two sandbox switches (P6.327).
 *
 * The panel that shows this host's isolation profiles was read-only, so the
 * master switch it reports could be seen and not changed: `sandbox.enabled`
 * defaults OFF, and a control nobody can reach is a control that does not
 * control. This is the write half.
 *
 * It writes the USER layer only, and deliberately cannot loosen anything:
 * `resolveSandboxEnabled` gives an administrator's `enabled` floor outright
 * precedence over every layer, and `resolveSandboxSettings` boolean-ANDs
 * `allowUnsandboxedCommands` across the floor and all layers, so a `false`
 * anywhere is terminal. Writing here therefore cannot defeat a managed policy —
 * the caller's job is only to stop SHOWING a switch as live when the floor has
 * already decided it, which the panel does.
 *
 * A partial: `undefined` leaves the key as it is rather than clearing it, so a
 * caller that owns one switch cannot silently reset the other.
 */
export function setUserSandboxSwitches(
  next: { enabled?: boolean; allowUnsandboxedCommands?: boolean },
): boolean {
  const config = loadConfigForMutation('setUserSandboxSwitches');
  if (!config) return false;
  const existing = (config.sandbox && typeof config.sandbox === 'object' && !Array.isArray(config.sandbox))
    ? config.sandbox as Record<string, unknown>
    : {};
  config.sandbox = {
    ...existing,
    ...(next.enabled === undefined ? {} : { enabled: next.enabled }),
    ...(next.allowUnsandboxedCommands === undefined
      ? {}
      : { allowUnsandboxedCommands: next.allowUnsandboxedCommands }),
  };
  saveConfig(config);
  return true;
}

/**
 * Get whether approved Bash commands should be wrapped in macOS sandbox-exec.
 * Defaults to false because sandbox-exec availability varies by macOS runtime.
 *
 * T1 (2026-08-12): the `sandbox.enabled` master switch OUTRANKS this legacy
 * key — `false` here short-circuits regardless of what the legacy key says,
 * so the key keeps its meaning only while the master switch is on. Delegates
 * to {@link resolveSandboxEnabled} (hazard 10's one composition helper)
 * rather than a second copy of "managed wins, else user, else default".
 *
 * This in-agent-process reader has no `ManagedPiPolicyV1` object of its own to
 * build the floor from (only `resolveHostSandboxSettings` in server-core holds
 * that) — but it must still see the SAME managed floor contour (a) does, via
 * {@link resolveManagedSandboxEnabledFloor}, or an org policy that forces the
 * master switch back on would reach the `ProcessSupervisor` wrap and stop
 * there, leaving this legacy seatbelt un-forced (this comment used to say
 * "resolves from the user layer alone", which was exactly that gap).
 */
export function getMacosSeatbeltBashSandboxEnabled(): boolean {
  if (!resolveSandboxEnabled([getUserSandboxSettings()], resolveManagedSandboxEnabledFloor())) return false;
  const config = loadStoredConfig();
  if (config?.macosSeatbeltBashSandboxEnabled !== undefined) {
    return config.macosSeatbeltBashSandboxEnabled;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.macosSeatbeltBashSandboxEnabled ?? false;
}

/**
 * P6.202 — the read-side working-directory fence, resolved TIGHTER-WINS.
 *
 * `settings-reference.md#permissions-blockreadsoutsideworkingdirectories`:
 * *"Stop Claude from reading paths outside the session's working directories
 * with the Read, Grep, Glob, and LSP tools, in every permission mode including
 * `bypassPermissions`."*
 *
 * Two layers, and the OR between them is the page's own scope rule rather than
 * our convention: *"If any settings source sets `true`, the block applies, so a
 * repository's checked-in file can turn the block on for a project but can't
 * lift a block you set."* Every other two-layer boolean in this file lets the
 * user's `config.json` OVERRIDE the shipped default in both directions; this one
 * must not, because a restriction that a lower layer can switch off is not a
 * floor. The page also spells the off value: *"`false`: the same as unset; a
 * `true` in any other settings file still blocks."*
 *
 * Fails OPEN on an unreadable config, like every neighbour here: a fence that
 * appeared because a file could not be parsed would refuse reads for a reason
 * nobody could act on.
 */
export function getBlockReadsOutsideWorkingDirectories(): boolean {
  let config: StoredConfig | null = null;
  try {
    config = loadStoredConfig();
  } catch {
    config = null;
  }
  if (config?.blockReadsOutsideWorkingDirectories === true) return true;
  return loadConfigDefaults().defaults.blockReadsOutsideWorkingDirectories === true;
}

/**
 * P6.865 — the setter P6.202 clause (3)'s **Block from now on** answer calls.
 *
 * `permission-modes.md#first-read-outside-the-working-directories`, verbatim:
 * *"Block from now on: Claude Code sets
 * `permissions.blockReadsOutsideWorkingDirectories` to `true` in your user
 * settings, which makes the file tools refuse such reads in every later session
 * and every permission mode."* The USER layer is the page's own choice of
 * layer, and it is the only layer this process owns, so there is no second
 * decision to make here.
 *
 * TIGHTER WINS, and that asymmetry is the reason this is not a plain toggle:
 * {@link getBlockReadsOutsideWorkingDirectories} ORs the shipped default over
 * the stored value, so `set(true)` always takes effect while `set(false)` only
 * clears what THIS layer contributed — *"`false`: the same as unset; a `true` in
 * any other settings file still blocks."* A caller that reads back `false` after
 * writing `false` has learnt that some other layer holds the fence up; it has
 * not failed.
 *
 * Returns `false` when the config could not be opened for mutation, exactly as
 * every neighbouring setter in this file does.
 */
export function setBlockReadsOutsideWorkingDirectories(blocked: boolean): boolean {
  const config = loadConfigForMutation('setBlockReadsOutsideWorkingDirectories');
  if (!config) return false;
  config.blockReadsOutsideWorkingDirectories = blocked;
  saveConfig(config);
  return true;
}

export function setMacosSeatbeltBashSandboxEnabled(enabled: boolean): boolean {
  const config = loadConfigForMutation('setMacosSeatbeltBashSandboxEnabled');
  if (!config) return false;
  config.macosSeatbeltBashSandboxEnabled = enabled;
  saveConfig(config);
  return true;
}

/**
 * Whether a connected MCP server may push text into a live turn through the
 * `claude/channel` notification.
 *
 * Defaults to false. Until this is on, no pooled connection gets a channel
 * dispatcher at all — the gate is at handler installation, not at dispatch
 * (`mcp/mcp-pool.ts`, `ChannelPolicy`). A managed policy can force it off but
 * never on; see `isChannelPushAllowed` in `agent/pi-harness/managed-policy.ts`.
 */
export function getMcpChannelPushEnabled(): boolean {
  const config = loadStoredConfig();
  if (config?.mcpChannelPushEnabled !== undefined) {
    return config.mcpChannelPushEnabled;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.mcpChannelPushEnabled ?? false;
}

/** Automatic Pi compaction defaults on. Manual /compact does not read this switch. */
export function getAutoCompactEnabled(): boolean {
  const config = loadStoredConfig();
  if (config?.autoCompactEnabled !== undefined) return config.autoCompactEnabled;
  return true;
}

/**
 * `askUserQuestionTimeout` (settings.md): idle time before an unanswered
 * ask_user question auto-continues with whatever was already selected.
 * Default `"never"` — with it, questions wait until answered.
 */
export const ASK_USER_QUESTION_TIMEOUT_VALUES = ['60s', '5m', '10m', 'never'] as const;
export type AskUserQuestionTimeout = typeof ASK_USER_QUESTION_TIMEOUT_VALUES[number];

/** Strict parse: anything but the four documented values reads as `never`. */
export function parseAskUserQuestionTimeout(value: unknown): AskUserQuestionTimeout {
  return (ASK_USER_QUESTION_TIMEOUT_VALUES as readonly unknown[]).includes(value)
    ? value as AskUserQuestionTimeout
    : 'never';
}

export function askUserQuestionTimeoutToMs(value: AskUserQuestionTimeout): number | undefined {
  switch (value) {
    case '60s': return 60_000;
    case '5m': return 5 * 60_000;
    case '10m': return 10 * 60_000;
    case 'never': return undefined;
  }
}

/**
 * USER settings only — deliberately reads nothing but `config.json` in the
 * user CONFIG_DIR. settings.md: "Not read from project or local settings" —
 * a checked-in repo must not be able to auto-answer a user's questions
 * (the project-config side of that boundary is `FORBIDDEN_DEFAULTS_KEYS`
 * in plugins/project-config.ts).
 */
export function getAskUserQuestionTimeout(): AskUserQuestionTimeout {
  const config = loadStoredConfig();
  return parseAskUserQuestionTimeout(config?.askUserQuestionTimeout);
}

/** `undefined` means never: no timer is armed anywhere. */
export function getAskUserQuestionTimeoutMs(): number | undefined {
  return askUserQuestionTimeoutToMs(getAskUserQuestionTimeout());
}

export function setMcpChannelPushEnabled(enabled: boolean): boolean {
  const config = loadConfigForMutation('setMcpChannelPushEnabled');
  if (!config) return false;
  config.mcpChannelPushEnabled = enabled;
  saveConfig(config);
  return true;
}

/**
 * `managed-settings.md#keys-that-fail-closed` — "User, project, and local
 * settings files remain strict: a file whose JSON or top-level shape fails
 * validation is rejected as a whole and reported, and an individual entry that
 * fails, such as a malformed permission rule, is skipped with a warning while
 * the rest of the file applies."
 *
 * Rejecting was the half we had; REPORTING is the half we did not. A silent
 * `catch { return {} }` leaves a user whose `worktree` block has one typo with
 * a session that quietly ignores every entry in it, and no way to find out.
 *
 * "Reported" is a console diagnostic rather than a thrown error on purpose: the
 * doc's rejection is of the FILE's contribution, not of the run. `config.json`
 * is this app's own config, so throwing here would turn a settings typo into a
 * failure to start — the same fleet-wide failure
 * `managed-settings.md#invalid-entries-in-managed-settings` rules out for the
 * managed tier, by dropping the offending entry and enforcing the rest. (The
 * reassurance sentence this used to quote is gone from every Claude settings
 * page; checked 2026-09-10, with the successor section's own wording as the
 * positive control. The per-key fallback table is what replaced it.)
 *
 * The parser message is sanitized because it quotes the offending key, and the
 * key comes out of a file.
 */
function reportRejectedUserSettingsLayer(key: string, error: unknown): void {
  // The cap is `REJECTED_LAYER_REASON_MAX`, not `sanitizeSettingsDiagnostic`'s
  // 200 default (P6.639): every producer of a `RejectedSettingsLayerV1` and the
  // renderer that displays one now read the same exported number, so a reason
  // cannot survive its producer and then be cut by its reader, or the reverse.
  // A strict-parse message names the offending key LAST — at 200 the key, which
  // is the only actionable word in the sentence, is what the truncation eats.
  const reason = sanitizeSettingsDiagnostic(
    error instanceof Error ? error.message : String(error),
    REJECTED_LAYER_REASON_MAX,
  );
  if (rejectedLayerSink) {
    rejectedLayerSink.push({ source: getConfigPath(), key, reason });
    return;
  }
  console.error(
    `[settings] Invalid \`${key}\` in the user config — the layer is rejected whole and ignored: ${reason}`,
  );
}

/**
 * Set while {@link collectRejectedUserSettingsLayers} runs. Non-null means the
 * report goes to the collector instead of the console.
 */
let rejectedLayerSink: RejectedSettingsLayerV1[] | null = null;

/**
 * Re-run the strict user-tier parses and RETURN what they rejected, instead of
 * printing it.
 *
 * `settings.md#fix-a-broken-settings-file` — "After you continue, run `/status`
 * to see the affected files and `claude doctor` for the details of each error."
 * The reporting half of `managed-settings.md#keys-that-fail-closed`'s
 * strict-tier rule already ships as a console diagnostic at load time; a
 * diagnosis surface needs the same records after the fact, and re-deriving them
 * with a second copy of the parse rules is how the two would drift.
 *
 * So this drives the REAL getters with the reporter redirected. Whatever a
 * getter rejects is what this returns, by construction — the collector cannot
 * report a layer the app still applies, or miss one it dropped.
 */
export function collectRejectedUserSettingsLayers(): readonly RejectedSettingsLayerV1[] {
  const collected: RejectedSettingsLayerV1[] = [];
  const previous = rejectedLayerSink;
  rejectedLayerSink = collected;
  try {
    getUserSandboxSettings();
    getUserWorktreeSettings();
    getUserWorkflowSettings();
    getUserSessionMirrorSettings();
    // P6.390(2): both take a value out of the same file and both refuse it the
    // same way, so a bad one has to reach the doctor by the same route. The
    // plans getter needs a project root to decide containment; a synthetic one
    // is enough to surface a malformed VALUE, and a path that merely escapes a
    // real root is reported at the session that resolves it.
    getAutoMemoryDirectory();
    resolvePlansDirectory(CONFIG_DIR);
    reportUnhonouredUserEnvBlock();
    reportOverriddenClaudeConfigDir();
    reportIgnoredLaunchAnthropicBaseUrl();
    reportIgnoredSettingsFileAnthropicBaseUrl();
  } finally {
    rejectedLayerSink = previous;
  }
  return Object.freeze(collected);
}

/**
 * The user-scope `env` block is DECLARED and NOT APPLIED, and this is where the
 * user is told so (R31 · f163a).
 *
 * ## Why it is declared
 *
 * `env-vars.md:78` — "Add variables under the `env` key in a `settings.json`
 * file, creating the file if it doesn't exist. Claude Code reads them directly
 * from the file, so they take effect no matter how `claude` was launched" — and
 * `:93` puts the user file (`~/.claude/settings.json`) first in the four-file
 * table. Undeclared, that key made `StoredConfigTopLevelSchema` (which is
 * `.strict()`) fail the parse, and {@link loadStoredConfig} throws
 * `UnsupportedStorageLayoutError` on a failed parse — so following the page cost
 * the user EVERY setting in `config.json`, not just this one. Declaring the key
 * removes that, and nothing else.
 *
 * ## Why the value is not applied
 *
 * Quoting the R31 decision (`docs/superpowers/plans/2026-08-04-doc-sweep-parity-wave.md`,
 * constraint 1): "`~/.nessy-agent/config.json` has no write containment against
 * the agent's own Bash tool (`protected-paths.ts` says so in its own 'Known
 * limits' block). A user-scope `env` block is therefore unprompted code
 * execution in the HOST process, plantable by one shell redirect from a
 * prompt-injected turn and persistent across restarts."
 *
 * One nuance the decision's wording flattens, recorded here so the next reader
 * does not over- or under-trust it: `agent/pi-harness/protected-paths.ts`'s
 * "Known limits" block says the protected-path floor is "File tools only" and
 * routes a Bash redirect to the OS sandbox's deny roots
 * (`isolation/self-config-deny.ts`), "which covers the config directories but
 * not the shell rcs". D1.146 — that sandbox is off at the MASTER switch and not
 * at the key this named: `SANDBOX_ENABLED_DEFAULT` is `false` and
 * `resolveIsolationDowngrade` short-circuits, so the default install is unprotected.
 *
 * `env-vars.md:104` is what makes that concrete: an applied entry replaces "the
 * value inherited from the shell", in the host process, and every child we spawn
 * inherits it — Pi, the Claude SDK subprocess, supervised plugin processes,
 * stdio MCP servers. `PATH`, `HTTP(S)_PROXY` and `NODE_EXTRA_CA_CERTS` are all
 * reachable from there.
 *
 * ## The decision, taken (P3.373 — owner sitting §1.2, 2026-09-05)
 *
 * **The park is CLOSED, and the answer is (A): refuse user-scope `env`
 * PERMANENTLY, and DISCLOSE the divergence from `env-vars.md`.** Not "unbuilt"
 * and not "pending" — a schema key that reads as supported while doing nothing
 * is the thing the decision rejects, so the refusal is stated to the user rather
 * than only to the reader of this file.
 *
 * Option (B), a name allowlist, was declined. The standing owner decision of
 * 2026-08-12/13 — OS isolation is off and not coming back — forecloses the
 * containment route the park's own first question offered, so an allowlist would
 * have been the ONLY containment against a threat model whose worst item is
 * `PATH`. Do not re-open it from the park file: that file's decision menu is
 * superseded on three of its premises.
 *
 * **All THREE user-writable scopes, and the third is why this paragraph exists.**
 * PROJECT scope refuses `env` on the record (`plugins/project-config.ts`'s
 * `FORBIDDEN_SECTIONS`, severity `error`); USER scope is this function; LOCAL
 * scope had NO Nessy file and NO recorded refusal, which under (A) is a defect
 * rather than an open design question — one scope erroring, one reporting and
 * one silent is exactly how a park gets "finished" by accident. The record is
 * that the refusal is a property of the PARSER, not of a file name: the project
 * parser refuses an `[env]` section whatever `sourceName` it is handed, so a
 * local-scope file added later is already covered, and
 * `__tests__/user-env-block-park.test.ts` pins that.
 *
 * The CA-ladder question the park raised is moot under (A): a block that is
 * never applied cannot outrank `tlsCaPath`.
 *
 * The managed tier keeps the whole mechanism (`config/managed-env.ts`,
 * `parseManagedEnvBlockV1`) and is the supported route — which the diagnostic
 * now says, because "ignored" without "use this instead" is half an answer.
 *
 * The diagnostic names the VARIABLE NAMES and never a value — a user env value
 * is as likely to be a token as a managed one.
 */
function reportUnhonouredUserEnvBlock(): void {
  let block: unknown;
  try {
    block = loadStoredConfig()?.env;
  } catch {
    // A config.json that fails the envelope has already been reported by
    // whoever loaded it; there is nothing to add here.
    return;
  }
  if (!block || typeof block !== 'object' || Array.isArray(block)) return;
  const names = Object.keys(block as Record<string, unknown>);
  if (names.length === 0) return;
  // `REJECTED_LAYER_REASON_MAX`, not the 200 default: this reason is the ONLY
  // place option (A)'s disclosure reaches a user, and at the default the
  // sentence that names the divergence is exactly what the truncation eats.
  // The literal 400 that stood here became the shared constant with P6.639.
  const reason = sanitizeSettingsDiagnostic(
    'the user-scope `env` block is PERMANENTLY REFUSED, not merely unimplemented'
    + ' — `env-vars.md` documents this key and this build applies it at no scope a'
    + ' user can write, because config.json has no write containment against the'
    + " agent's own shell; deliver environment variables through managed settings"
    + ` instead. ${names.length} variable(s) ignored: ${names.join(', ')}`,
    REJECTED_LAYER_REASON_MAX,
  );
  if (rejectedLayerSink) {
    rejectedLayerSink.push({ source: getConfigPath(), key: 'env', reason });
    return;
  }
  console.error(`[settings] ${reason}`);
}

/**
 * C4.23 (L124) — the `CLAUDE_CONFIG_DIR` overwrite stays AUTHORITATIVE, and this
 * is where the user whose value it overwrites is told so.
 *
 * ## What is overwritten, and why it stays that way
 *
 * `buildClaudeSubprocessEnv` (`agent/options.ts`) assigns `CLAUDE_CONFIG_DIR`
 * per Workspace AFTER the caller's overrides, so an ambient value in the host's
 * shell cannot put two Workspaces back in one config directory. The owner took
 * option C on 2026-09-11: keep the overwrite, disclose it. Honouring an
 * explicitly chosen directory would hand the `user` settings scope — and with it
 * a `permissions` block — authority over every project at once, which is the
 * cross-Workspace policy channel the isolation exists to close, and the
 * capability itself is already reachable by a spelling we do own.
 *
 * ## Why a diagnostic is the whole of the fix
 *
 * The capability the page's `CLAUDE_CONFIG_DIR` names — running claude against a
 * clean configuration tree — is available here today: `NESSY_CONFIG_DIR` sets
 * `CONFIG_DIR`, the workspace roots hang off it, and each Workspace's claude
 * config directory is derived from that root. So what was missing was never the
 * ability; it was the SILENCE. A user who set the vendor's documented spelling
 * got no value, no error and no alternative — which is exactly the shape
 * AGENTS.md calls indistinguishable from a defect.
 *
 * Modelled on {@link reportUnhonouredUserEnvBlock}: same sink, same cap, and the
 * same rule that a diagnostic names the variable and never echoes its value —
 * a config-directory path is a filesystem location out of a user's environment,
 * and this record is rendered by a doctor surface.
 *
 * Reported on PRESENCE, not on a comparison with the derived value: the
 * overwrite happens per session inside the subprocess environment, long after
 * this layer runs, and it happens for every Workspace-scoped claude session. A
 * comparison here would need a Workspace identity this function does not have,
 * and would go quiet in exactly the case the user needs the sentence.
 */
function reportOverriddenClaudeConfigDir(): void {
  if (!process.env.CLAUDE_CONFIG_DIR?.trim()) return;
  // Written to fit `REJECTED_LAYER_REASON_MAX` WHOLE (382 characters against the
  // 400 cap), because both halves are load-bearing and the truncation eats the
  // second: the sentence naming the working spelling is the only actionable one
  // in the report, and it is last.
  const reason = sanitizeSettingsDiagnostic(
    '`CLAUDE_CONFIG_DIR` is set here and is OVERWRITTEN for every Claude session:'
    + ' each Workspace gets its own Claude config directory, so two cannot share one'
    + ' and a user-scope Claude settings file cannot become a policy channel across'
    + ' every project. The value set here never reaches the runtime. To run against a'
    + ' different configuration tree set `NESSY_CONFIG_DIR` before the app starts.',
    REJECTED_LAYER_REASON_MAX,
  );
  if (rejectedLayerSink) {
    rejectedLayerSink.push({ source: 'process environment', key: 'CLAUDE_CONFIG_DIR', reason });
    return;
  }
  console.error(`[settings] ${reason}`);
}

/**
 * Whether the environment this module was LOADED in carried `ANTHROPIC_BASE_URL`
 * — a presence bit, never the value. Read once because the host copy does not
 * stay put: `postInit` deletes it and `resetManagedAnthropicAuthEnvVars` restores
 * it on every connection save, so a check of `process.env` alone would come and
 * go with whichever of the two ran last. Taken here rather than imported from
 * `llm-connections.ts`'s baseline, which this module does not depend on.
 */
const LAUNCH_ANTHROPIC_BASE_URL_SET = Boolean(process.env.ANTHROPIC_BASE_URL?.trim());

/**
 * F1.966 — a launch `ANTHROPIC_BASE_URL` is IGNORED, and this is where the user
 * who exported it is told so. Owner rule, 2026-09-25: the integration decides
 * the endpoint; the launch environment never overrides it.
 *
 * `buildClaudeSubprocessEnv` (`agent/options.ts`, `dropAmbientAnthropicBaseUrl`)
 * keeps the name only from the session's connection and removes the value the
 * environment brought, and codex and Pi take their endpoint from the connection
 * natively (measured by workflow wf_a0694155-7ce). Modelled on
 * {@link reportOverriddenClaudeConfigDir}: same sink, same cap, the variable
 * named and its value never echoed — an endpoint can carry a token in its query.
 *
 * RESIDUE: on a Dock-launched mac this module loads before the login shell's
 * environment is read, and the boot reset erases a login-shell-only export
 * (F1.980), so that value is not reported here — it never reaches a runtime
 * there either.
 */
function reportIgnoredLaunchAnthropicBaseUrl(): void {
  if (!LAUNCH_ANTHROPIC_BASE_URL_SET && !process.env.ANTHROPIC_BASE_URL?.trim()) return;
  const reason = sanitizeSettingsDiagnostic(
    '`ANTHROPIC_BASE_URL` is set in the environment this app was launched with and is'
    + ' IGNORED: the connection decides every session\'s endpoint, so a Claude connection'
    + ' without its own base URL uses the vendor default and the value set here never'
    + ' reaches the runtime. To use a different endpoint, set the base URL on the'
    + ' connection itself.',
    REJECTED_LAYER_REASON_MAX,
  );
  if (rejectedLayerSink) {
    rejectedLayerSink.push({ source: 'process environment', key: 'ANTHROPIC_BASE_URL', reason });
    return;
  }
  console.error(`[settings] ${reason}`);
}

/**
 * The Claude settings files a spawned Claude child in THIS process was told to
 * load that set `env.ANTHROPIC_BASE_URL` — paths only, never a value.
 */
const IGNORED_CLAUDE_SETTINGS_FILE_ENDPOINTS = new Set<string>();

/**
 * F1.981 — called by `claudeSettingsFileEndpointNotices`
 * (`agent/claude-endpoint-settings.ts`), the one reader of those files, so the
 * doctor lists what a session actually found instead of re-deriving a
 * Workspace's user tier or a session's project directory it does not know.
 */
export function recordIgnoredClaudeSettingsFileEndpoint(files: readonly string[]): void {
  for (const file of files) IGNORED_CLAUDE_SETTINGS_FILE_ENDPOINTS.add(file);
}

/**
 * F1.1009 — the same files' provider toggles (F1.1006), file → toggle names,
 * never a value. Kept apart from the endpoint set because the caller says which
 * names are toggles (`CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS`), not this module.
 */
const IGNORED_CLAUDE_SETTINGS_FILE_PROVIDER_TOGGLES = new Map<string, Set<string>>();

/**
 * F1.1017 — the same files' first-party flag (F1.1008), file → names, never a value; a file's `ANTHROPIC_AUTH_TOKEN`
 * is used since F1.1043, not cancelled ({@link CLAUDE_SETTINGS_FILE_CREDENTIALS_IN_USE}; F1.1186). Kept apart: the flag
 * is cancelled only when a loaded file names it, so the PIN (`buildClaudeEndpointFlagSettings`) records it for the doctor.
 */
const IGNORED_CLAUDE_SETTINGS_FILE_CREDENTIALS = new Map<string, Set<string>>();

function addIgnoredClaudeSettingsFileEnvNames(map: Map<string, Set<string>>, file: string, names: readonly string[]): void {
  const known = map.get(file) ?? new Set<string>();
  for (const name of names) known.add(name);
  map.set(file, known);
}

/** F1.1009 — called beside {@link recordIgnoredClaudeSettingsFileEndpoint}, by the same one reader of the files. */
export function recordIgnoredClaudeSettingsFileProviderToggles(file: string, toggles: readonly string[]): void {
  addIgnoredClaudeSettingsFileEnvNames(IGNORED_CLAUDE_SETTINGS_FILE_PROVIDER_TOGGLES, file, toggles);
}

/** F1.1017 — called by the F1.1008 pin for each loaded file whose names it cancelled. */
export function recordIgnoredClaudeSettingsFileCredentials(file: string, names: readonly string[]): void {
  addIgnoredClaudeSettingsFileEnvNames(IGNORED_CLAUDE_SETTINGS_FILE_CREDENTIALS, file, names);
}

/**
 * F1.1043 — the same files' credentials the child USES (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`), file → names,
 * never a value. Owner decision 2026-09-28: a trusted project's or workspace's own settings decide which credential
 * signs the requests, as Claude Code allows, and the app names the file. Recorded by the pin, which reads the files.
 */
const CLAUDE_SETTINGS_FILE_CREDENTIALS_IN_USE = new Map<string, Set<string>>();

export function recordClaudeSettingsFileCredentialsInUse(file: string, names: readonly string[]): void {
  addIgnoredClaudeSettingsFileEnvNames(CLAUDE_SETTINGS_FILE_CREDENTIALS_IN_USE, file, names);
}

/**
 * F1.1064 — the tiers below the token and the key (tier 4 `apiKeyHelper`, tier 5 `CLAUDE_CODE_OAUTH_TOKEN`), in the
 * words of the pin's `lowerTierCredentialNotice`: what each does, measured on the vendored 2.1.267 (DN-259).
 */
const LOWER_TIER_CLAUDE_CREDENTIALS_IN_USE: Readonly<Record<string, string>> = {
  // Kept short: the record's reason is capped at REJECTED_LAYER_REASON_MAX, and the remedy must survive the cap.
  apiKeyHelper: 'its command runs at session start, its output replaces a Claude Pro/Max sign-in and rides as a bearer'
    + ' beside an API key.',
  CLAUDE_CODE_OAUTH_TOKEN: 'it replaces a Claude Pro/Max connection\'s sign-in, and is not used beside an API key.',
};

/**
 * F1.981 — a Claude settings file's `env.ANTHROPIC_BASE_URL` is IGNORED, told
 * beside F1.966's launch-environment record above. Owner rule, extended to
 * settings files on 2026-09-26: the integration decides the endpoint, so the
 * host pins the connection's value on the `--settings` tier, which outranks the
 * user, project and local files (`buildClaudeEndpointFlagSettings`).
 *
 * F1.1009 — a file's provider toggle (F1.1006) is listed the same way, one
 * record per toggle name: the host pins every toggle off on the same tier
 * whether or not a file names one, so "IGNORED" holds for each.
 *
 * F1.1017 — and a file's first-party flag (F1.1008), one record per name,
 * recorded by the pin only for a file whose flag it cancelled on the same
 * tier, so "IGNORED" holds for it too. F1.1043 — a file's credential is NOT
 * cancelled: listed with `inUse: true`, which the doctor shows apart from the
 * rejected layers and never counts as a finding.
 *
 * RESIDUE: keyed on what a Claude session in this process found, so a file is
 * listed once a session that loads it has spawned, not before, and stays listed
 * until the app restarts even if the file is fixed in between.
 */
function reportIgnoredSettingsFileAnthropicBaseUrl(): void {
  for (const file of IGNORED_CLAUDE_SETTINGS_FILE_ENDPOINTS) {
    const reason = sanitizeSettingsDiagnostic(
      'This Claude settings file sets `ANTHROPIC_BASE_URL` in `env`, and it is IGNORED: the'
      + ' connection decides every session\'s endpoint, so the value set here never reaches'
      + ' the runtime. To use a different endpoint, set the base URL on the connection itself.',
      REJECTED_LAYER_REASON_MAX,
    );
    if (rejectedLayerSink) {
      rejectedLayerSink.push({ source: file, key: 'env.ANTHROPIC_BASE_URL', reason });
      continue;
    }
    console.error(`[settings] ${file}: ${reason}`);
  }
  reportIgnoredClaudeSettingsFileEnvNames(IGNORED_CLAUDE_SETTINGS_FILE_PROVIDER_TOGGLES, 'provider',
    'To use a different provider, choose it on the connection itself.');
  // F1.1017 — the words of the pin's own transcript notice (`claude-settings-file-first-party-ignored`).
  reportIgnoredClaudeSettingsFileEnvNames(IGNORED_CLAUDE_SETTINGS_FILE_CREDENTIALS, 'endpoint',
    'To use a different endpoint, set the base URL on the connection itself.');
  // F1.1043 — in use, in the words of `claude-settings-file-credential-in-use`; the name only, never the value.
  for (const [file, names] of CLAUDE_SETTINGS_FILE_CREDENTIALS_IN_USE) {
    for (const name of names) {
      // F1.1064 — `apiKeyHelper` is a top-level key; it and `CLAUDE_CODE_OAUTH_TOKEN` rank below the token and the key.
      const key = name === 'apiKeyHelper' ? name : `env.${name}`;
      const where = name === 'apiKeyHelper' ? `\`${name}\`` : `\`${name}\` in \`env\``;
      const reason = sanitizeSettingsDiagnostic(
        LOWER_TIER_CLAUDE_CREDENTIALS_IN_USE[name] !== undefined
          ? `This settings file sets ${where}, and it is IN USE by Claude Code's own authentication precedence,`
            + ` below ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY: ${LOWER_TIER_CLAUDE_CREDENTIALS_IN_USE[name]}`
            + ' The connection decides the endpoint and provider. Remove it here to use the connection\'s.'
          : `This settings file sets ${where}, and it is IN USE: a trusted project's or`
            + ' workspace\'s own settings choose the credential, as Claude Code allows; the connection decides'
            + ' the endpoint and provider. Through the app\'s local adapter (Nessy Gateway, custom-endpoint Claude Code)'
            + ' it stops at the adapter, which signs with the connection\'s. Remove it here to use the connection\'s.',
        REJECTED_LAYER_REASON_MAX,
      );
      if (rejectedLayerSink) {
        rejectedLayerSink.push({ source: file, key, reason, inUse: true });
        continue;
      }
      console.error(`[settings] ${file}: ${reason}`);
    }
  }
}

function reportIgnoredClaudeSettingsFileEnvNames(map: Map<string, Set<string>>, decides: string, remedy: string): void {
  for (const [file, names] of map) {
    for (const name of names) {
      const reason = sanitizeSettingsDiagnostic(
        `This Claude settings file sets \`${name}\` in \`env\`, and it is IGNORED: the`
        + ` connection decides every session's ${decides}, so the value set here never reaches`
        + ` the runtime. ${remedy}`,
        REJECTED_LAYER_REASON_MAX,
      );
      if (rejectedLayerSink) {
        rejectedLayerSink.push({ source: file, key: `env.${name}`, reason });
        continue;
      }
      console.error(`[settings] ${file}: ${reason}`);
    }
  }
}

/**
 * The USER sandbox-settings layer, straight from `config.json`.
 *
 * Returns the raw layer, not a resolved value: resolution needs the managed
 * layer and the host-seeded credential deny floor, which only the host that
 * owns the process supervisor can supply. See `resolveSandboxSettings`.
 * An unparseable or absent `sandbox` key yields an empty layer, so a bad edit
 * cannot widen anything.
 *
 * The parse is `parseManagedSandboxSettingsV1` with NO sink, which is its
 * strict mode — the posture `managed-settings.md#keys-that-fail-closed` keeps
 * for this tier. It used to be absent entirely: the layer was handed downstream
 * unvalidated and the throw
 * surfaced from `resolveSandboxSettings` inside session construction, which is
 * an app failure rather than a rejected settings layer.
 *
 * `CONFIG_DIR` is the scope root. `settings-reference.md#sandbox-path-prefixes`
 * anchors a `./`-prefixed or bare sandbox path "Relative to the project root for
 * project settings, or to `~/.claude` for user settings"; this fork's
 * user-settings directory is the Nessy config dir, and `config.json` is the file
 * the path was written in. There is no project or local sandbox tier here, so
 * the project-root half of that sentence has nothing to bind to.
 */
export function getUserSandboxSettings(): SandboxSettingsV1 {
  const config = loadStoredConfig();
  const layer = config?.sandbox;
  if (layer === undefined || layer === null) return {};
  try {
    return parseManagedSandboxSettingsV1(layer, { scope: { root: CONFIG_DIR } });
  } catch (error) {
    reportRejectedUserSettingsLayer('sandbox', error);
    return {};
  }
}

/**
 * The USER worktree-settings layer, straight from `config.json`.
 *
 * Returns the raw layer for the same reason `getUserSandboxSettings` does:
 * resolution composes it with other layers, and only the caller holds those.
 * An unparseable or absent `worktree` key yields an empty layer, so a bad edit
 * cannot silently impose a write block or redirect a worktree's base.
 */
export function getUserWorktreeSettings(): WorktreeSettingsV1 {
  const config = loadStoredConfig();
  const layer = config?.worktree;
  if (!layer || typeof layer !== 'object' || Array.isArray(layer)) return {};
  try {
    return parseWorktreeSettingsV1(layer);
  } catch (error) {
    reportRejectedUserSettingsLayer('worktree', error);
    return {};
  }
}

/**
 * P6.361 — the saved actions this install declares, resolved for this host.
 *
 * Same shape as `getUserWorktreeSettings` above and for the same reasons: the
 * parser REFUSES rather than defaults (a blank command is a mistake, not "no
 * command"), so a bad edit must not brick a read that a toolbar performs on
 * every open — it is reported as a rejected layer and the list comes back empty.
 *
 * The operator kill switch is applied inside `getWorkspaceActions`, at the READ,
 * so a caller that forgets to ask cannot offer a disabled action.
 */
export function getUserWorkspaceActions(
  platform: NodeJS.Platform = process.platform,
): ResolvedWorkspaceAction[] {
  const config = loadStoredConfig();
  if (!config) return [];
  try {
    return getWorkspaceActions(config, platform);
  } catch (error) {
    reportRejectedUserSettingsLayer(WORKSPACE_ACTIONS_SETTING_KEY, error);
    return [];
  }
}

/**
 * The USER workflow-settings layer, straight from `config.json`.
 *
 * Returns the raw layer for the same reason the two above do: resolution
 * composes it with the managed layer and the env off switch, and only the
 * caller holds those. An unparseable or absent `workflow` key yields an empty
 * layer — a bad edit can never widen anything here, because the only
 * permissive direction (`disableWorkflows: false`) is exactly what an empty
 * layer already means.
 */
export function getUserWorkflowSettings(): WorkflowSettingsV1 {
  const config = loadStoredConfig();
  // `settings-reference.md#disablebundledskills` — the key "removes bundled
  // skills and workflows entirely", both of them, so it contributes a
  // `disableWorkflows` layer here. It is folded into the SAME layer rather than
  // added as a fourth
  // key, so `resolveWorkflowSettings`'s tighter-wins rule composes the two
  // switches without any caller learning about the second one. It can only
  // turn workflows off: a `workflow.disableWorkflows: false` beside it still
  // resolves off, and an absent `disableBundledSkills` changes nothing.
  const bundledSkillsLayer: WorkflowSettingsV1 = bundledSkillsDisabledBySetting(config)
    ? { disableWorkflows: true }
    : {};
  const layer = config?.workflow;
  if (!layer || typeof layer !== 'object' || Array.isArray(layer)) return bundledSkillsLayer;
  try {
    return Object.freeze({ ...parseWorkflowSettingsV1(layer), ...bundledSkillsLayer });
  } catch (error) {
    reportRejectedUserSettingsLayer('workflow', error);
    return bundledSkillsLayer;
  }
}

/**
 * The one workflow key writable from the app — P6.319, relocated here by P6.682.
 *
 * `disableWorkflows` and the keyword trigger are deliberately absent: both are
 * tighter-wins in the resolver, so a control that appeared to turn workflows
 * back ON would write a value the resolver then ignores — a lie with a checkbox.
 * The size guideline is an ordinary last-explicit-value-wins preference, which
 * is exactly what a user control can honestly own.
 *
 * THROWS on a value the union does not carry, unlike its `false`-returning
 * siblings, and the asymmetry is deliberate: an absent `config.json` is a state
 * of the machine that the caller reports, while an unparseable guideline is a
 * bad CALL. Parsing through the module that owns the union means an unknown
 * value is refused here rather than read back as the default on the next load.
 *
 * It lived in the RPC handler until P6.682 — `config/storage.ts` was another
 * lane's file the hour P6.319 landed, and `git commit <pathspec>` takes a file's
 * whole working-tree state. Pure relocation: same composition, same refusal,
 * same `settings-workflow.test.ts`.
 */
export function setWorkflowSizeGuideline(guideline: unknown): boolean {
  const layer = parseWorkflowSettingsV1({ sizeGuideline: guideline });
  const config = loadConfigForMutation('setWorkflowSizeGuideline');
  if (!config) return false;
  config.workflow = { ...(config.workflow ?? {}), sizeGuideline: layer.sizeGuideline };
  saveConfig(config);
  return true;
}

/**
 * The USER `sessionMirror` layer, strictly parsed. Unlike the sandbox/workflow
 * off switches, a broken mirror config must never break session persistence:
 * the parse throw is contained here — the mirror fails CLOSED (disabled) with a
 * clear diagnostic on the console, and local writes proceed untouched.
 */
export function getUserSessionMirrorSettings(): SessionMirrorSettingsV1 | null {
  const config = loadStoredConfig();
  const layer = config?.sessionMirror;
  if (layer === undefined || layer === null) return null;
  try {
    return parseSessionMirrorSettingsV1(layer);
  } catch (error) {
    // Same tier, same `managed-settings.md#keys-that-fail-closed` rejection, so
    // the same collector has to see it — but the console wording stays this
    // layer's own, because the
    // consequence it names (mirroring off, local persistence untouched) is not
    // the generic one.
    if (rejectedLayerSink) {
      reportRejectedUserSettingsLayer('sessionMirror', error);
      return null;
    }
    console.error(
      `[SessionMirror] Invalid sessionMirror config — mirroring disabled (local persistence unaffected): ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * The USER `sources` layer, straight from `config.json` (T10, plugin-install
 * plan § 9b). Tolerant like the worktree/workflow layers: an absent or
 * malformed key yields an empty layer, so a bad edit falls back to the
 * Claude-parity default (connect at session start) instead of wedging it.
 */
export function getUserSourceStartupSettings(): SourceStartupSettingsV1 {
  const config = loadStoredConfig();
  return parseSourceStartupSettingsV1(config?.sources);
}

/**
 * The user's per-server on/off record for the built-in dp-backed MCP set (A7),
 * shaped for `MaterializeBuiltinDpMcpOptions.enabled`:
 *
 * ```ts
 * builtinDpMcpServers: { enabled: getBuiltinDpMcpServerPreferences() }
 * ```
 *
 * An empty record is the correct "user has expressed no preference" value — it
 * leaves every server on its own `defaultEnabled`, so a machine with no
 * `config.json`, an absent key or a malformed one all behave identically to
 * the set's measured defaults.
 */
export function getBuiltinDpMcpServerPreferences(): Readonly<Record<string, boolean>> {
  const config = loadStoredConfig();
  return parseBuiltinDpMcpSettingsV1(config?.builtinDpMcpServers).enabled ?? {};
}

/**
 * Get whether rtk Bash-output compression is enabled.
 * When enabled, the PreToolUse pipeline rewrites Bash commands to their `rtk` equivalents
 * to reduce token consumption on common dev commands (git, ls, grep, test runners, etc.).
 * Defaults to false — opt-in. Requires the `rtk` binary on PATH or bundled with the app.
 * https://github.com/rtk-ai/rtk
 */

export function getRtkEnabled(): boolean {
  const config = loadStoredConfig();
  return config?.rtkEnabled === true;
}

/**
 * UB7.4 — the per-workspace rtk exclusion list: base commands that must never
 * be routed through `rtk rewrite` (a tool whose output rtk mangles, for
 * example). Stored as `rtkExcludeCommands` in config.json; a non-array or
 * non-string entry reads as the empty list, which is the pre-UB7.4 behaviour.
 */
export function getRtkExcludeCommands(): string[] {
  const config = loadStoredConfig();
  const value = config?.rtkExcludeCommands;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Set whether rtk Bash-output compression is enabled.
 */
export function setRtkEnabled(enabled: boolean): boolean {
  const config = loadConfigForMutation('setRtkEnabled');
  if (!config) return false;
  config.rtkEnabled = enabled;
  saveConfig(config);
  return true;
}

/**
 * Whether the guardian safety judge is enabled. When on, the guardian is
 * consulted for the `auto`-mode borderline band and the `allow-all` high-risk
 * deny-net. When off, ALL guardian paths are skipped (byte-identical to
 * pre-guardian behavior). Defaults to true.
 */
export function getGuardianEnabled(): boolean {
  const config = loadStoredConfig();
  if (config?.guardianEnabled !== undefined) {
    return config.guardianEnabled;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.guardianEnabled;
}

/**
 * Set whether the guardian safety judge is enabled.
 */
export function setGuardianEnabled(enabled: boolean): boolean {
  const config = loadConfigForMutation('setGuardianEnabled');
  if (!config) return false;
  config.guardianEnabled = enabled;
  saveConfig(config);
  return true;
}

/**
 * P3.2 — whether codex's NATIVE auto-review guardian is enabled. When on (and
 * the runtime is codex, with an interactive approval policy), `CodexAgent` passes
 * `approvalsReviewer: 'auto_review'` to the config writer. Reader-side accessor;
 * an ABSENT key falls through to the shipped default (false, opt-in). Defaults
 * to false.
 */
export function getCodexAutoReviewEnabled(): boolean {
  const config = loadStoredConfig();
  if (config?.codexAutoReviewEnabled !== undefined) {
    return config.codexAutoReviewEnabled;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.codexAutoReviewEnabled;
}

/**
 * C3.109 (QH3, owner answer A, 2026-09-11) — whether codex may spawn its own
 * agents. Reader-side accessor; an ABSENT key falls through to the shipped
 * default, which is `true` because that is codex's own
 * (`AgentsToml.enabled`: *"Whether multi-agent tools are enabled. Defaults to
 * true. An enabled `features.multi_agent_v2` setting takes precedence."*).
 *
 * ONLY an explicit `false` reaches the config writer, which is
 * `CodexConfigOptions.subagentsEnabled`'s own rule: writing `true` would restate
 * codex's default and buy nothing, and the config stays byte-identical for every
 * operator who does not set the key.
 *
 * The SECOND sentence of that schema doc is the conditionality this switch
 * inherits and cannot remove: `features.multi_agent_v2` takes precedence, so the
 * off-switch binds only while that feature is off. `codex-subagents-off-switch.test.ts`
 * quotes it rather than assuming it.
 */
/**
 * C3.178 — the stored primary-folder choice, or `undefined` when the user has
 * made none (which is the positive control: the derivation stands).
 *
 * Unknown-tolerant on purpose, like every other reader on this file's strict
 * envelope: a non-string reads as "no choice", which is behaviour identical to a
 * build from before the key existed. The VALUE is decided by
 * `resolveSessionPrimaryRoot` (`config/primary-directory.ts`), which refuses a
 * relative path and a folder the session has not attached.
 */
export function getPrimaryDirectory(): string | undefined {
  const config = loadStoredConfig();
  const value = config?.primaryDirectory;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Set — or, with `undefined`, CLEAR — the primary-folder choice.
 *
 * Clearing writes nothing in its place: the absence of the key is the documented
 * "use the derivation" state, and storing a sentinel for it would be a second
 * spelling of the same answer. The path is stored as the user's own spelling
 * rather than a realpath, for {@link resolveSessionPrimaryRoot}'s reason.
 */
export function setPrimaryDirectory(value: string | undefined): boolean {
  const config = loadConfigForMutation('setPrimaryDirectory');
  if (!config) return false;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) delete config.primaryDirectory;
  else config.primaryDirectory = trimmed;
  saveConfig(config);
  return true;
}

export function getCodexSubagentsEnabled(): boolean {
  const config = loadStoredConfig();
  if (config?.codexSubagentsEnabled !== undefined) {
    return config.codexSubagentsEnabled;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.codexSubagentsEnabled;
}

/**
 * Set whether codex may spawn its own agents — C3.286, the in-app half of
 * C3.109.
 *
 * NOT live for a running session, for the same reason as
 * {@link setCodexAutoReviewEnabled}: `[agents] enabled` is an entry in codex's
 * own config FILE, written once at `writeCodexConfig` time, so the value takes
 * effect on the next codex session. The settings row says so rather than
 * implying a live toggle.
 *
 * Both positions are STORED, which is deliberate even though only `false`
 * reaches the config writer: storing the explicit `true` is what lets an
 * operator turn delegation back on when the shipped default later changes, and
 * {@link getCodexSubagentsEnabled} is the only reader that has to know the
 * difference.
 */
export function setCodexSubagentsEnabled(enabled: boolean): boolean {
  const config = loadConfigForMutation('setCodexSubagentsEnabled');
  if (!config) return false;
  config.codexSubagentsEnabled = enabled;
  saveConfig(config);
  return true;
}

/**
 * P3.2 — extra instructions appended to codex's guardian prompt
 * (`[auto_review].policy`). Empty string = none. Only used when
 * {@link getCodexAutoReviewEnabled} is on.
 */
export function getCodexAutoReviewPolicy(): string {
  const config = loadStoredConfig();
  if (typeof config?.codexAutoReviewPolicy === 'string') {
    return config.codexAutoReviewPolicy;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.codexAutoReviewPolicy;
}

/**
 * Set whether codex's native auto-review guardian is enabled — P6.225.
 *
 * Turning it OFF reaches a running session (F1.781): every codex `turn/start`
 * re-reads this value and asks for `'user'` through codex's own sticky per-turn
 * override, and the floor hook steps aside. Turning it ON does not:
 * `approvals_reviewer`, `[auto_review].policy` and F1.386's floor hook are
 * written into codex's own config FILE at `writeCodexConfig` time, so it takes
 * effect on the next codex session (guardian's toggle is read per consult).
 *
 * No session-tool cache to invalidate either, for the same reason: this changes
 * codex's approval routing, not our tool surface, so `setAdvisorEnabled`'s lazy
 * `invalidateAllSessionToolsCaches` import would be a call with nothing to do.
 */
export function setCodexAutoReviewEnabled(enabled: boolean): boolean {
  const config = loadConfigForMutation('setCodexAutoReviewEnabled');
  if (!config) return false;
  config.codexAutoReviewEnabled = enabled;
  saveConfig(config);
  return true;
}

/**
 * Set the extra instructions appended to codex's guardian prompt — P6.225.
 *
 * Stored as WRITTEN apart from the outer trim: `buildCodexAutoReviewOptions`
 * omits the key entirely when the trimmed text is empty and otherwise passes the
 * raw string, so trimming here would be a second, differently-placed rule for
 * the same value. Clearing to `''` is always permitted and means "use codex's
 * own policy unchanged".
 */
export function setCodexAutoReviewPolicy(policy: string): boolean {
  const config = loadConfigForMutation('setCodexAutoReviewPolicy');
  if (!config) return false;
  config.codexAutoReviewPolicy = policy;
  saveConfig(config);
  return true;
}

/**
 * Whether the model may consult the advisor (P2.1).
 *
 * OPT-IN: `advisor.md` turns the advisor on with `/advisor`, `advisorModel` or
 * `--advisor` rather than shipping it enabled, and an always-on second model
 * doubles the cost of a turn. An ABSENT key therefore falls through to the
 * bundled default (`false`), not to `true`.
 *
 * The three-site rule applies to the default this reads: it lives in
 * `config-defaults.json`, in `FALLBACK_CONFIG_DEFAULTS`, and in the
 * `ConfigDefaults` type + schema. Missing any one site is the known
 * shipped-bug shape.
 */
export function getAdvisorEnabled(): boolean {
  const config = loadStoredConfig();
  if (config?.advisorEnabled !== undefined) {
    return config.advisorEnabled === true;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.advisorEnabled === true;
}

/** Set whether the model may consult the advisor. */
export function setAdvisorEnabled(enabled: boolean): boolean {
  const config = loadConfigForMutation('setAdvisorEnabled');
  if (!config) return false;
  config.advisorEnabled = enabled;
  saveConfig(config);

  // The Claude adapter builds `advisor_consult` only when the setting is on and
  // caches the tool array per session, so the cache has to be cleared for a
  // toggle to be visible — the same reason and the same call as
  // `setBrowserToolEnabled`. Lazy import to avoid the circular dependency
  // (storage ← session-scoped-tools ← storage).
  import('../agent/session-scoped-tools.ts').then(m => m.invalidateAllSessionToolsCaches()).catch(() => {});
  return true;
}

/**
 * The configured advising model, or `''` for "the session's own model".
 *
 * Returns the RAW id. It is deliberately NOT validated here: the entitlement
 * and managed-allowlist gates need the session's connection catalog, which this
 * layer does not have, and they live in `agent/advisor.ts:resolveAdvisorModel`
 * — the one place that combines them.
 */
export function getAdvisorModelId(): string {
  const config = loadStoredConfig();
  if (typeof config?.advisorModel === 'string') {
    return config.advisorModel.trim();
  }
  const defaults = loadConfigDefaults();
  return typeof defaults.defaults.advisorModel === 'string'
    ? defaults.defaults.advisorModel.trim()
    : '';
}

/** Set the advising model. An empty string restores "the session's own model". */
export function setAdvisorModelId(modelId: string): boolean {
  const config = loadConfigForMutation('setAdvisorModelId');
  if (!config) return false;
  config.advisorModel = modelId.trim();
  saveConfig(config);
  return true;
}

/**
 * Whether the classifier reviews shell commands during PLAN mode instead of
 * prompting.
 *
 * "When auto mode is available and the `useAutoModeDuringPlan` setting is on,
 * which it is by default, the classifier reviews shell commands during planning
 * instead of prompting you. Approved commands run, and rejected ones are
 * blocked. Otherwise, commands outside the built-in read-only set prompt for
 * approval". THE SENTENCE IS THE ANCHOR and the number is only a convenience:
 * `permission-modes.md:240` on the 2026-08-23 fetch, where the `:156` this file
 * used to cite is a VS Code UI-label table row.
 *
 * Default ON, as documented — so an ABSENT key is on and only an explicit
 * `false` turns it off. Turning it off does not restore the old outright block:
 * the documented "Otherwise" branch prompts.
 */
export function getUseAutoModeDuringPlan(workingDirectory?: string): boolean {
  const config = loadStoredConfig();
  const operatorEnabled = config?.useAutoModeDuringPlan !== false;
  // P6.68 — the page's exception: a `false` in `.claude/settings.local.json`
  // TIGHTENS this, and a `false` in `.claude/settings.json` is IGNORED. The
  // resolver is provider-free, so one call site serves Pi, claude and codex; the
  // asymmetry, the substitution for `--settings`/user scope, and why the switch
  // verdict is earned at the resolver rather than at behaviour are all written
  // out in `auto-mode-during-plan.ts`. A caller with no directory gets exactly
  // the old value.
  return resolveUseAutoModeDuringPlanWithScopes({ operatorEnabled, workingDirectory }).enabled;
}

/** Set whether the classifier reviews plan-mode shell commands. */
export function setUseAutoModeDuringPlan(enabled: boolean): boolean {
  const config = loadConfigForMutation('setUseAutoModeDuringPlan');
  if (!config) return false;
  config.useAutoModeDuringPlan = enabled;
  saveConfig(config);
  return true;
}

/**
 * Whether Claude responds after an input-box `!` shell command runs.
 *
 * `settings-reference.md#respondtobashcommands` — "By default, Claude Code adds
 * the command's output to the conversation and Claude replies to it. Set this
 * key to `false` to add the output to context without a reply, so you can run
 * several commands and ask about them together." **Default**: `true`.
 *
 * Default ON, as documented — an ABSENT key responds and only an explicit
 * `false` keeps the pre-v2.1.186 context-only behaviour
 * (interactive-mode.md:321). Read by `SessionManager.runShellCommand`.
 */
export function getRespondToBashCommands(): boolean {
  const config = loadStoredConfig();
  return config?.respondToBashCommands !== false;
}

/** Set whether Claude responds after an input-box `!` shell command runs. */
export function setRespondToBashCommands(enabled: boolean): boolean {
  const config = loadConfigForMutation('setRespondToBashCommands');
  if (!config) return false;
  config.respondToBashCommands = enabled;
  saveConfig(config);
  return true;
}

/**
 * The model id to run the guardian judge on. An empty string means "use the
 * default" — the runner resolves the Nessy Gateway `fast` alias, falling back
 * to the session model. Returns '' when unset so callers can treat empty as
 * default without a separate presence check.
 */
export function getGuardianJudgeModelId(): string {
  const config = loadStoredConfig();
  return config?.guardianJudgeModelId ?? '';
}

/**
 * The per-integration judge models, `connection slug → model id`.
 *
 * Returns `{}` when unset so callers can index without a presence check.
 */
export function getGuardianJudgeModels(): Record<string, string> {
  const config = loadStoredConfig();
  return config?.guardianJudgeModels ?? {};
}

/**
 * Set (or clear) one connection's judge model.
 *
 * An empty model id REMOVES the entry rather than storing a blank, so the
 * resolution chain sees "no preference" instead of an unusable one — the same
 * shape a connection that was never configured has.
 */
export function setGuardianJudgeModelForConnection(slug: string, modelId: string): boolean {
  const config = loadConfigForMutation('setGuardianJudgeModelForConnection');
  if (!config) return false;
  const map = { ...(config.guardianJudgeModels ?? {}) };
  if (modelId.trim() === '') delete map[slug];
  else map[slug] = modelId.trim();
  if (Object.keys(map).length === 0) delete config.guardianJudgeModels;
  else config.guardianJudgeModels = map;
  saveConfig(config);
  return true;
}

/**
 * Set the guardian judge model id. An empty string clears the override (back to
 * the gateway `fast` alias default).
 */
export function setGuardianJudgeModelId(modelId: string): boolean {
  const config = loadConfigForMutation('setGuardianJudgeModelId');
  if (!config) return false;
  if (modelId.trim() === '') {
    delete config.guardianJudgeModelId;
  } else {
    config.guardianJudgeModelId = modelId;
  }
  saveConfig(config);
  return true;
}

/**
 * Get persisted Git Bash path (Windows only).
 * Used to set CLAUDE_CODE_GIT_BASH_PATH for the SDK subprocess.
 */
export function getGitBashPath(): string | undefined {
  const config = loadStoredConfig();
  return config?.gitBashPath;
}

/**
 * Set Git Bash path (Windows only).
 * Persists to config so it survives app restarts.
 * Returns false if the config could not be loaded (path not persisted).
 */
export function setGitBashPath(path: string): boolean {
  const config = loadConfigForMutation('setGitBashPath');
  if (!config) return false;
  config.gitBashPath = path;
  saveConfig(config);
  return true;
}

/**
 * Clear persisted Git Bash path (Windows only).
 * Used when the stored path is stale or invalid.
 */
export function clearGitBashPath(): boolean {
  const config = loadConfigForMutation('clearGitBashPath');
  if (!config) return false;
  // Already absent is the requested end state, not a failure to reach it.
  if (!config.gitBashPath) return true;
  delete config.gitBashPath;
  saveConfig(config);
  return true;
}

// Note: getDefaultWorkingDirectory/setDefaultWorkingDirectory removed
// Working directory is now stored per-workspace in workspace config.json (defaults.workingDirectory)
// Note: getDefaultPermissionMode/getEnabledPermissionModes removed
// Permission settings are now stored per-workspace in workspace config.json (defaults.permissionMode, defaults.cyclablePermissionModes)

export function getConfigPath(): string {
  return CONFIG_FILE;
}

/**
 * Clear all configuration and credentials (for logout).
 * Deletes config file and credentials file.
 *
 * **P2.357 — DEAD CODE, and every mutator in this file depends on it staying
 * that way.** This function has no caller (`git grep -a clearAllConfig` over
 * `packages/`, `apps/` and `scripts/` finds only this definition, 2026-09-07),
 * and it is the only in-process deleter of `config.json`. That is the sole
 * reason the absent-config branch of `loadConfigForMutation` is unreachable on
 * a healthy host: every mutator answers a missing store by warning and
 * returning `false`, and nothing else in the process can produce the state in
 * which they do it. How many that is — 47 today, 34 when P2.357 was written —
 * is a reading with a date; `loadConfigForMutation`'s docblock carries the
 * grep.
 *
 * **Wiring this to a reset or logout button arms all of them in one commit.**
 * That is an ordinary feature to want, and the consequence is invisible from
 * the button — which is why it is written here rather than only there. Before
 * doing so, re-read the three-part argument in `loadConfigForMutation`'s
 * docblock (never create, never throw, never stay silent): it was reasoned
 * about a state that could not happen. Whether it survives that state becoming
 * routine is deliberately NOT settled here (owner D18, 2026-09-05).
 */
export async function clearAllConfig(): Promise<void> {
  // Delete config file
  if (existsSync(CONFIG_FILE)) {
    rmSync(CONFIG_FILE);
  }

  // Delete credentials file
  const credentialsFile = join(CONFIG_DIR, 'credentials.enc');
  if (existsSync(credentialsFile)) {
    rmSync(credentialsFile);
  }

  // Optionally: Delete workspace data (conversations)
  const workspacesDir = join(CONFIG_DIR, 'workspaces');
  if (existsSync(workspacesDir)) {
    rmSync(workspacesDir, { recursive: true });
  }
}

export function setActiveWorkspace(workspaceId: string): boolean {
  const config = loadConfigForMutation('setActiveWorkspace');
  if (!config) return false;
  // An unregistered id is a rejected write, not a store failure — no warning,
  // but still `false`, because nothing was persisted either way.
  if (!config.workspaceRefs.some(ref => ref.id === workspaceId)) return false;

  config.activeWorkspaceId = workspaceId;
  saveConfig(config);
  return true;
}

// ============================================
// Session Input Drafts
// Persists composer state (text + attachments) per session across app restarts.
// Two shapes for attachments:
//  - Track P: { path, name } — absolute path captured via webUtils.getPathForFile
//    (file-picker / OS drag). Re-read on hydrate via file:readUserAttachment RPC.
//  - Track C: { path, name, content } — inline content for paste / web-drag Files
//    that never existed on disk. Hydrate reconstructs directly from the stored bytes.
// ============================================

const DRAFTS_FILE = join(CONFIG_DIR, 'drafts.json');

export interface DraftAttachmentContent {
  type: 'image' | 'pdf' | 'text' | 'office' | 'audio' | 'unknown';
  mimeType: string;
  size: number;
  base64?: string;
  text?: string;
  thumbnailBase64?: string;
  origin?: 'pasted-text';
}

export interface DraftAttachmentRef {
  path: string;
  name: string;
  /** Inline content for attachments without a real filesystem path (paste, web-drag).
   *  When present, hydrate reconstructs from these bytes and skips any disk read. */
  content?: DraftAttachmentContent;
}

export interface SessionDraft {
  text: string;
  attachments?: DraftAttachmentRef[];
  /**
   * Set only when a deep link Nessy did not produce prefilled this text. The
   * composer discloses such a prompt under the input box until it is sent or
   * cleared, so the mark has to outlive a panel switch and a restart the same
   * way the text does — hence it rides the draft rather than renderer state.
   */
  promptOrigin?: 'external-link';
}

/**
 * v2 draft record — a self-describing composite session identity plus the draft
 * payload. drafts.json is a single global file, so entries are keyed by the
 * composite {workspaceId, sessionId} via the canonical `encodeSessionKey`; two
 * workspaces that reuse the same bare sessionId never collide.
 */
interface StoredDraftRecord {
  session: SessionKey;
  draft: SessionDraft;
}

interface DraftsData {
  version: 2;
  drafts: Record<string, StoredDraftRecord>;
  updatedAt: number;
}

const ATTACHMENT_CONTENT_TYPES = new Set(['image', 'pdf', 'text', 'office', 'audio', 'unknown']);

function isAbsoluteDraftPath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  return false;
}

function isDraftAttachmentContent(value: unknown): value is DraftAttachmentContent {
  if (!value || typeof value !== 'object') return false;
  const c = value as DraftAttachmentContent;
  if (!ATTACHMENT_CONTENT_TYPES.has(c.type as string)) return false;
  if (typeof c.mimeType !== 'string') return false;
  if (typeof c.size !== 'number') return false;
  if (c.base64 !== undefined && typeof c.base64 !== 'string') return false;
  if (c.text !== undefined && typeof c.text !== 'string') return false;
  if (c.thumbnailBase64 !== undefined && typeof c.thumbnailBase64 !== 'string') return false;
  if (c.origin !== undefined && c.origin !== 'pasted-text') return false;
  return true;
}

function isDraftAttachmentRef(value: unknown): value is DraftAttachmentRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as DraftAttachmentRef;
  if (typeof ref.path !== 'string' || typeof ref.name !== 'string') return false;
  if (ref.content !== undefined && !isDraftAttachmentContent(ref.content)) return false;
  // Refs without content MUST have an absolute path. This rejects
  // the broken 0.8.11 shape (synthetic path === filename, no content) on first load —
  // user sees empty drafts once instead of attachments silently disappearing forever.
  if (ref.content === undefined && !isAbsoluteDraftPath(ref.path)) return false;
  return true;
}

function isSessionDraft(value: unknown): value is SessionDraft {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as SessionDraft;
  if (typeof candidate.text !== 'string') return false;
  if (candidate.attachments !== undefined) {
    if (!Array.isArray(candidate.attachments)) return false;
    if (!candidate.attachments.every(isDraftAttachmentRef)) return false;
  }
  if (candidate.promptOrigin !== undefined && candidate.promptOrigin !== 'external-link') return false;
  return true;
}

function isEmptyDraft(draft: SessionDraft): boolean {
  return !draft.text && (!draft.attachments || draft.attachments.length === 0);
}

function isDraftSessionKey(value: unknown): value is SessionKey {
  if (!value || typeof value !== 'object') return false;
  const key = value as SessionKey;
  return typeof key.workspaceId === 'string' && key.workspaceId.length > 0
    && typeof key.sessionId === 'string' && key.sessionId.length > 0;
}

function isStoredDraftRecord(value: unknown): value is StoredDraftRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as StoredDraftRecord;
  return isDraftSessionKey(record.session) && isSessionDraft(record.draft);
}

/**
 * Load all drafts from disk. This is a clean v2 read: entries that don't parse
 * as a composite-keyed StoredDraftRecord (e.g. pre-cutover bare-sessionId drafts,
 * legacy string drafts) are discarded silently — there is no migration.
 */
function loadDraftsData(): DraftsData {
  try {
    if (!existsSync(DRAFTS_FILE)) {
      return { version: 2, drafts: {}, updatedAt: 0 };
    }
    const raw = readJsonFileSync<{ version?: number; drafts?: Record<string, unknown>; updatedAt?: number }>(DRAFTS_FILE);
    const drafts: Record<string, StoredDraftRecord> = {};
    if (raw.version === 2) {
      for (const [key, value] of Object.entries(raw.drafts ?? {})) {
        if (isStoredDraftRecord(value)) {
          drafts[key] = value;
        }
      }
    }
    return { version: 2, drafts, updatedAt: raw.updatedAt ?? 0 };
  } catch {
    return { version: 2, drafts: {}, updatedAt: 0 };
  }
}

function saveDraftsData(data: DraftsData): void {
  ensureConfigDir();
  data.updatedAt = Date.now();
  writeFileSync(DRAFTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Get the persisted draft for a session (text + attachment refs), by composite
 * {workspaceId, sessionId} key.
 */
export function getSessionDraft(key: SessionKey): SessionDraft | null {
  if (!isDraftSessionKey(key)) return null;
  const data = loadDraftsData();
  return data.drafts[encodeSessionKey(key)]?.draft ?? null;
}

/**
 * Set the draft for a session (by composite key). Empty drafts (no text and no
 * attachments) are removed from disk.
 */
export function setSessionDraft(key: SessionKey, draft: SessionDraft): void {
  if (!isDraftSessionKey(key)) return;
  const data = loadDraftsData();
  const encoded = encodeSessionKey(key);
  if (isEmptyDraft(draft)) {
    delete data.drafts[encoded];
  } else {
    data.drafts[encoded] = {
      session: { workspaceId: key.workspaceId, sessionId: key.sessionId },
      draft: {
        text: draft.text,
        ...(draft.attachments && draft.attachments.length > 0
          ? { attachments: draft.attachments.map(normalizeDraftAttachment) }
          : {}),
        ...(draft.promptOrigin ? { promptOrigin: draft.promptOrigin } : {}),
      },
    };
  }
  saveDraftsData(data);
}

function normalizeDraftAttachment(ref: DraftAttachmentRef): DraftAttachmentRef {
  const base: DraftAttachmentRef = { path: ref.path, name: ref.name };
  if (ref.content && isDraftAttachmentContent(ref.content)) {
    const c = ref.content;
    base.content = {
      type: c.type,
      mimeType: c.mimeType,
      size: c.size,
      ...(c.base64 !== undefined ? { base64: c.base64 } : {}),
      ...(c.text !== undefined ? { text: c.text } : {}),
      ...(c.thumbnailBase64 !== undefined ? { thumbnailBase64: c.thumbnailBase64 } : {}),
      ...(c.origin !== undefined ? { origin: c.origin } : {}),
    };
  }
  return base;
}

export function deleteSessionDraft(key: SessionKey): void {
  if (!isDraftSessionKey(key)) return;
  const data = loadDraftsData();
  delete data.drafts[encodeSessionKey(key)];
  saveDraftsData(data);
}

/**
 * Get all drafts for one workspace, keyed by bare sessionId. The renderer window
 * is bound to a single workspace, so its in-memory draft map stays sessionId-keyed;
 * scoping here prevents another workspace's same-id session drafts from leaking in.
 */
export function getAllSessionDrafts(workspaceId: string): Record<string, SessionDraft> {
  const data = loadDraftsData();
  const result: Record<string, SessionDraft> = {};
  if (!workspaceId) return result;
  for (const record of Object.values(data.drafts)) {
    if (record.session.workspaceId === workspaceId) {
      result[record.session.sessionId] = record.draft;
    }
  }
  return result;
}

// ============================================
// Theme Storage (App-level only)
// ============================================

import type { ThemeOverrides, ThemeFile, PresetTheme } from './theme.ts';

const APP_THEME_FILE = join(CONFIG_DIR, 'theme.json');
const APP_THEMES_DIR = join(CONFIG_DIR, 'themes');
const RETIRED_BUNDLED_THEME_FILES = [
  'catppuccin.json',
  'default.json',
  'dracula.json',
  'ghostty.json',
  'gruvbox.json',
  'night-owl.json',
  'pierre.json',
  'rose-pine.json',
  'solarized.json',
  'tokyo-night.json',
];

/**
 * Get the path to the app-level theme override file (~/.nessy-agent/theme.json).
 */
export function getAppThemePath(): string {
  return APP_THEME_FILE;
}

// Track if preset themes have been synced this session (prevents re-init on hot reload)
let presetsInitialized = false;

/**
 * Get the app-level themes directory.
 * Preset themes are stored at ~/.nessy-agent/themes/
 */
export function getAppThemesDir(): string {
  return APP_THEMES_DIR;
}

/**
 * Load app-level theme overrides
 */
export function loadAppTheme(): ThemeOverrides | null {
  try {
    if (!existsSync(APP_THEME_FILE)) {
      return null;
    }
    return readJsonFileSync<ThemeOverrides>(APP_THEME_FILE);
  } catch {
    return null;
  }
}

/**
 * Save app-level theme overrides
 */
export function saveAppTheme(theme: ThemeOverrides): void {
  ensureConfigDir();
  writeFileSync(APP_THEME_FILE, JSON.stringify(theme, null, 2), 'utf-8');
}


// ============================================
// Preset Themes (app-level)
// ============================================

/**
 * Sync current bundled preset themes to disk on launch.
 * Removes retired bundled preset filenames, then preserves current files:
 * - If file doesn't exist → copy from bundle
 * - If file exists but is invalid/corrupt → copy from bundle (auto-heal)
 * - If file exists and is valid → skip (preserve user changes)
 *
 * User-created custom theme files (with non-bundled filenames) are untouched.
 * User color overrides live in theme.json (separate file) and are never touched.
 */
export function ensurePresetThemes(): void {
  // Skip if already initialized this session (prevents re-init on hot reload)
  if (presetsInitialized) {
    return;
  }
  presetsInitialized = true;

  const themesDir = getAppThemesDir();

  // Create themes directory if it doesn't exist
  if (!existsSync(themesDir)) {
    mkdirSync(themesDir, { recursive: true });
  }

  // Resolve bundled themes directory via shared asset resolver
  const bundledThemesDir = getBundledAssetsDir('themes');
  if (!bundledThemesDir) {
    return;
  }

  // Sync bundled preset themes to disk.
  // - If file doesn't exist → copy from bundle
  // - If file exists but is invalid/corrupt → copy from bundle (auto-heal)
  // - If file exists and is valid → skip (preserve user changes)
  try {
    for (const file of RETIRED_BUNDLED_THEME_FILES) {
      rmSync(join(themesDir, file), { force: true });
    }

    const bundledFiles = readdirSync(bundledThemesDir).filter(f => f.endsWith('.json'));
    for (const file of bundledFiles) {
      const srcPath = join(bundledThemesDir, file);
      const destPath = join(themesDir, file);

      // Skip if file exists and is valid (preserve user customizations)
      if (existsSync(destPath) && isValidThemeFile(destPath)) {
        continue;
      }

      // Copy from bundle (new file or auto-heal corrupt file)
      const content = readFileSync(srcPath, 'utf-8');
      writeFileSync(destPath, content, 'utf-8');
    }
  } catch {
    // Ignore errors - themes are optional
  }
}

/**
 * Load all preset themes from app themes directory.
 * Returns array of PresetTheme objects sorted by name.
 */
export function loadPresetThemes(): PresetTheme[] {
  ensurePresetThemes();

  const themesDir = getAppThemesDir();
  if (!existsSync(themesDir)) {
    return [];
  }

  const themes: PresetTheme[] = [];

  try {
    const files = readdirSync(themesDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const id = file.replace('.json', '');
      const path = join(themesDir, file);
      try {
        const theme = readJsonFileSync<ThemeFile>(path);
        // Resolve relative backgroundImage paths to file:// URLs
        const resolvedTheme = resolveThemeBackgroundImage(theme, path);
        themes.push({ id, path, theme: resolvedTheme });
      } catch {
        // Skip invalid theme files
      }
    }
  } catch {
    return [];
  }

  // Sort by name (default first, then alphabetically)
  return themes.sort((a, b) => {
    if (a.id === 'default') return -1;
    if (b.id === 'default') return 1;
    return (a.theme.name || a.id).localeCompare(b.theme.name || b.id);
  });
}

/**
 * Get MIME type from file extension for data URL encoding.
 */
function getMimeType(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

/**
 * Resolve relative backgroundImage paths to data URLs.
 * If the backgroundImage is a relative path (no protocol), resolve it relative to the theme's directory,
 * read the file, and convert it to a data URL. This is necessary because the renderer process
 * cannot access file:// URLs directly when running on localhost in dev mode.
 * @param theme - Theme object to process
 * @param themePath - Absolute path to the theme's JSON file
 */
function resolveThemeBackgroundImage(theme: ThemeFile, themePath: string): ThemeFile {
  if (!theme.backgroundImage) {
    return theme;
  }

  // Check if it's already an absolute URL (has protocol like http://, https://, data:)
  const hasProtocol = /^[a-z][a-z0-9+.-]*:/i.test(theme.backgroundImage);
  if (hasProtocol) {
    return theme;
  }

  // It's a relative path - resolve it relative to the theme's directory
  const themeDir = dirname(themePath);
  const absoluteImagePath = join(themeDir, theme.backgroundImage);

  // Read the file and convert to data URL so renderer can use it
  // (file:// URLs are blocked in renderer when running on localhost)
  try {
    if (!existsSync(absoluteImagePath)) {
      console.warn(`Theme background image not found: ${absoluteImagePath}`);
      return theme;
    }

    const imageBuffer = readFileSync(absoluteImagePath);
    const base64 = imageBuffer.toString('base64');
    const mimeType = getMimeType(absoluteImagePath);
    const dataUrl = `data:${mimeType};base64,${base64}`;

    return {
      ...theme,
      backgroundImage: dataUrl,
    };
  } catch (error) {
    console.warn(`Failed to read theme background image: ${absoluteImagePath}`, error);
    return theme;
  }
}

/**
 * Load a specific preset theme by ID.
 * @param id - Theme ID (filename without .json)
 */
export function loadPresetTheme(id: string): PresetTheme | null {
  ensurePresetThemes();

  const themesDir = getAppThemesDir();
  const path = join(themesDir, `${id}.json`);

  if (!existsSync(path)) {
    return null;
  }

  try {
    const theme = readJsonFileSync<ThemeFile>(path);
    // Resolve relative backgroundImage paths to file:// URLs
    const resolvedTheme = resolveThemeBackgroundImage(theme, path);
    return { id, path, theme: resolvedTheme };
  } catch {
    return null;
  }
}

/**
 * Get the path to the app-level preset themes directory.
 */
export function getPresetThemesDir(): string {
  return getAppThemesDir();
}

/**
 * Reset a preset theme to its bundled default.
 * Copies the bundled version over the user's version.
 * Resolves bundled path automatically via getBundledAssetsDir('themes').
 * @param id - Theme ID to reset
 */
export function resetPresetTheme(id: string): boolean {
  // Resolve bundled themes directory via shared asset resolver
  const bundledThemesDir = getBundledAssetsDir('themes');
  if (!bundledThemesDir) {
    return false;
  }

  const bundledPath = join(bundledThemesDir, `${id}.json`);
  const themesDir = getAppThemesDir();
  const destPath = join(themesDir, `${id}.json`);

  if (!existsSync(bundledPath)) {
    return false;
  }

  try {
    const content = readFileSync(bundledPath, 'utf-8');
    if (!existsSync(themesDir)) {
      mkdirSync(themesDir, { recursive: true });
    }
    writeFileSync(destPath, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// ============================================
// Color Theme Selection (stored in config)
// ============================================

/**
 * Get the currently selected color theme ID.
 * Returns 'default' if not set.
 */
export function getColorTheme(): string {
  const config = loadStoredConfig();
  if (config?.colorTheme !== undefined) {
    return config.colorTheme;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.colorTheme;
}

/**
 * Set the color theme ID.
 */
export function setColorTheme(themeId: string): boolean {
  const config = loadConfigForMutation('setColorTheme');
  if (!config) return false;
  config.colorTheme = themeId;
  saveConfig(config);
  return true;
}

// ============================================
// Auto-Update Dismissed Version
// ============================================

/**
 * Get the dismissed update version.
 * Returns null if no version is dismissed.
 */
export function getDismissedUpdateVersion(): string | null {
  const config = loadStoredConfig();
  return config?.dismissedUpdateVersion ?? null;
}

/**
 * Set the dismissed update version.
 * Pass the version string to dismiss notifications for that version.
 */
export function setDismissedUpdateVersion(version: string): boolean {
  const config = loadConfigForMutation('setDismissedUpdateVersion');
  if (!config) return false;
  config.dismissedUpdateVersion = version;
  saveConfig(config);
  return true;
}

/**
 * Clear the dismissed update version.
 * Call this when a new version is released (or on successful update).
 */
export function clearDismissedUpdateVersion(): boolean {
  const config = loadConfigForMutation('clearDismissedUpdateVersion');
  if (!config) return false;
  delete config.dismissedUpdateVersion;
  saveConfig(config);
  return true;
}

// ============================================
// Zoom Factor (global renderer zoom)
// ============================================

const MIN_ZOOM_FACTOR = 0.5;
const MAX_ZOOM_FACTOR = 3.0;

/**
 * Get the persisted global zoom factor.
 * Defaults to 1.0 and is clamped to [0.5, 3.0] to stay in sync with the
 * bounds enforced by the ZOOM_IN/ZOOM_OUT handlers.
 */
export function getZoomFactor(): number {
  const config = loadStoredConfig();
  const stored = config?.zoomFactor;
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return 1.0;
  return Math.min(Math.max(stored, MIN_ZOOM_FACTOR), MAX_ZOOM_FACTOR);
}

/**
 * Persist the global zoom factor (clamped to [0.5, 3.0]).
 */
export function setZoomFactor(factor: number): boolean {
  const config = loadConfigForMutation('setZoomFactor');
  if (!config) return false;
  config.zoomFactor = Math.min(Math.max(factor, MIN_ZOOM_FACTOR), MAX_ZOOM_FACTOR);
  saveConfig(config);
  return true;
}

// ============================================
// LLM Connections
// ============================================

// Re-export types for convenience (imports are at top of file)
export type {
  LlmConnection,
  LlmProviderType,
  LlmAuthType,
  LlmConnectionWithStatus,
} from './llm-connections.ts';

function modelSetEquals(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every(id => right.has(id));
}

/**
 * Ensure default LLM connection is set correctly.
 * Called internally by write operations to fix inconsistent state.
 * This is NOT called on read - reads never modify config.
 */
function ensureDefaultLlmConnection(config: StoredConfig): boolean {
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return false;
  }

  const defaultExists = config.llmConnections.some(c => c.slug === config.defaultLlmConnection);
  if (!config.defaultLlmConnection || !defaultExists) {
    config.defaultLlmConnection = config.llmConnections[0]!.slug;
    return true;
  }

  return false;
}

/**
 * Get all LLM connections.
 * Returns only user-added connections (no auto-populated built-ins).
 *
 * This function is read-only and never modifies config.
 */
export function getLlmConnections(): LlmConnection[] {
  const config = loadStoredConfig();
  if (!config) return [];

  return config.llmConnections || [];
}

/**
 * Get a specific LLM connection by slug.
 * @param slug - Connection slug
 * @returns Connection or null if not found
 */
export function getLlmConnection(slug: string): LlmConnection | null {
  const connections = getLlmConnections();
  return connections.find(c => c.slug === slug) || null;
}

/**
 * Add a new LLM connection.
 * @param connection - Connection to add (slug must be unique)
 * @returns true if added, false if slug already exists
 */
export function addLlmConnection(connection: LlmConnection): boolean {
  const config = loadConfigForMutation('addLlmConnection');
  if (!config) return false;

  // Initialize the optional v2 collection on first write.
  if (!config.llmConnections) {
    config.llmConnections = [];
  }

  // Check for duplicate slug
  if (config.llmConnections.some(c => c.slug === connection.slug)) {
    return false;
  }

  // Add connection with timestamp
  config.llmConnections.push({
    ...connection,
    createdAt: connection.createdAt || Date.now(),
  });

  // Ensure default is set after adding first connection
  ensureDefaultLlmConnection(config);

  saveConfig(config);
  return true;
}

/**
 * Update an existing LLM connection.
 * @param slug - Connection slug to update
 * @param updates - Partial updates to apply (slug is ignored)
 * @returns true if updated, false if not found
 */
export function updateLlmConnection(slug: string, updates: Partial<Omit<LlmConnection, 'slug'>>): boolean {
  const config = loadConfigForMutation('updateLlmConnection');
  if (!config) return false;

  // No connections means nothing to update
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return false;
  }

  const connections = config.llmConnections;
  const index = connections.findIndex(c => c.slug === slug);
  if (index === -1) return false;

  const existing = connections[index]!;
  const toModelIds = (models?: Array<{ id: string } | string>): string[] =>
    (models ?? []).map(m => typeof m === 'string' ? m : m.id);

  connections[index] = {
    // Preserve required fields from existing
    slug: existing.slug,
    name: updates.name ?? existing.name,
    providerType: updates.providerType ?? existing.providerType,
    authType: updates.authType ?? existing.authType,
    createdAt: updates.createdAt ?? existing.createdAt,
    // Optional fields from updates or existing
    baseUrl: updates.baseUrl !== undefined ? updates.baseUrl : existing.baseUrl,
    models: updates.models !== undefined ? updates.models : existing.models,
    defaultModel: updates.defaultModel !== undefined ? updates.defaultModel : existing.defaultModel,
    // The utility-model slot. Listed here because this merge is an ALLOWLIST:
    // a field absent from it is dropped on the next save of any OTHER field,
    // silently — the issue-#838 trap the oauth block below was added for.
    miniModel: updates.miniModel !== undefined ? updates.miniModel : existing.miniModel,
    modelSelectionMode: updates.modelSelectionMode !== undefined ? updates.modelSelectionMode : existing.modelSelectionMode,
    modelsSyncedAt: updates.modelsSyncedAt !== undefined ? updates.modelsSyncedAt : existing.modelsSyncedAt,
    // DA2.12 — in this ALLOWLIST, or the stamp is dropped on the next save of
    // any other field, silently.
    catalogueRefreshedAt: updates.catalogueRefreshedAt !== undefined ? updates.catalogueRefreshedAt : existing.catalogueRefreshedAt,
    // Pi auth provider
    piAuthProvider: updates.piAuthProvider !== undefined ? updates.piAuthProvider : existing.piAuthProvider,
    // P6.532 — the declared codex `model_provider` (the BYO Bedrock card). In
    // this ALLOWLIST because a field absent from it is dropped on the next save
    // of any OTHER field, silently: issue #838, stated on `miniModel` above.
    codexModelProvider: updates.codexModelProvider !== undefined ? updates.codexModelProvider : existing.codexModelProvider,
    // P6.374's two claude-child env toggles. They were added to `LlmConnection`
    // and NOT to this list, so every one of them was dropped on the next save of
    // any other field — the #838 trap recurring on a field written a month after
    // the comment warning about it. Found by W8-w while adding the line above.
    disableAdaptiveThinking: updates.disableAdaptiveThinking !== undefined ? updates.disableAdaptiveThinking : existing.disableAdaptiveThinking,
    disableExperimentalBetas: updates.disableExperimentalBetas !== undefined ? updates.disableExperimentalBetas : existing.disableExperimentalBetas,
    // Custom endpoint protocol (Anthropic/OpenAI compatible)
    customEndpoint: updates.customEndpoint !== undefined ? updates.customEndpoint : existing.customEndpoint,
    // Mid-stream send behavior (steer vs queue) — read via resolveMidStreamBehavior()
    midStreamBehavior: updates.midStreamBehavior !== undefined ? updates.midStreamBehavior : existing.midStreamBehavior,
    // Resolved Anthropic OAuth identity (issue #838) — preserved across unrelated saves
    oauthAccountUuid: updates.oauthAccountUuid !== undefined ? updates.oauthAccountUuid : existing.oauthAccountUuid,
    oauthAccountEmail: updates.oauthAccountEmail !== undefined ? updates.oauthAccountEmail : existing.oauthAccountEmail,
    oauthOrganizationUuid: updates.oauthOrganizationUuid !== undefined ? updates.oauthOrganizationUuid : existing.oauthOrganizationUuid,
    oauthOrganizationName: updates.oauthOrganizationName !== undefined ? updates.oauthOrganizationName : existing.oauthOrganizationName,
    oauthProfileVerifiedAt: updates.oauthProfileVerifiedAt !== undefined ? updates.oauthProfileVerifiedAt : existing.oauthProfileVerifiedAt,
    // Timestamps
    lastUsedAt: updates.lastUsedAt !== undefined ? updates.lastUsedAt : existing.lastUsedAt,
  };

  const updated = connections[index]!;
  if (updated.providerType === 'pi') {
    const beforeModelIds = toModelIds(existing.models);
    const afterModelIds = toModelIds(updated.models);
    const changed =
      existing.defaultModel !== updated.defaultModel ||
      existing.modelSelectionMode !== updated.modelSelectionMode ||
      !modelSetEquals(beforeModelIds, afterModelIds);

    if (changed) {
      const stack = (new Error().stack ?? '').split('\n').slice(2, 7).map(s => s.trim());
      debug('[storage] updateLlmConnection(pi) changed', {
        slug,
        before: {
          mode: existing.modelSelectionMode,
          defaultModel: existing.defaultModel,
          modelCount: beforeModelIds.length,
          modelsFirst5: beforeModelIds.slice(0, 5),
        },
        after: {
          mode: updated.modelSelectionMode,
          defaultModel: updated.defaultModel,
          modelCount: afterModelIds.length,
          modelsFirst5: afterModelIds.slice(0, 5),
        },
        updates: {
          keys: Object.keys(updates),
          defaultModel: updates.defaultModel,
          modelSelectionMode: updates.modelSelectionMode,
          modelsCount: Array.isArray(updates.models) ? updates.models.length : undefined,
        },
        stack,
      });
    }
  }

  saveConfig(config);
  return true;
}

/**
 * Delete an LLM connection.
 * @param slug - Connection slug to delete
 * @returns true if deleted, false if not found
 */
export function deleteLlmConnection(slug: string): boolean {
  const config = loadConfigForMutation('deleteLlmConnection');
  if (!config) return false;

  // No connections means nothing to delete
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return false;
  }

  const connections = config.llmConnections;
  const index = connections.findIndex(c => c.slug === slug);
  if (index === -1) return false;

  connections.splice(index, 1);

  // If deleted connection was the default, reset to first remaining or clear
  if (config.defaultLlmConnection === slug) {
    config.defaultLlmConnection = connections.length > 0 ? connections[0]!.slug : undefined;
  }

  saveConfig(config);

  // Clean up stored credentials for this connection (API keys, OAuth tokens)
  // This is fire-and-forget but we log errors for debugging
  const credentialManager = getCredentialManager();
  credentialManager.delete({ type: 'llm_api_key', connectionSlug: slug }).catch((error) => {
    console.error(`[storage] Failed to delete API key credential for connection '${slug}':`, error);
  });
  credentialManager.delete({ type: 'llm_oauth', connectionSlug: slug }).catch((error) => {
    console.error(`[storage] Failed to delete OAuth credential for connection '${slug}':`, error);
  });

  return true;
}

/**
 * Get the default LLM connection slug.
 * @returns Default connection slug, or null if no connections exist
 */
export function getDefaultLlmConnection(): string | null {
  const config = loadStoredConfig();
  if (!config) return null;

  // If no connections, return null
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return null;
  }

  return config.defaultLlmConnection || config.llmConnections[0]?.slug || null;
}

/**
 * Set the default LLM connection.
 * @param slug - Connection slug to set as default
 * @returns true if set, false if connection not found
 */
export function setDefaultLlmConnection(slug: string): boolean {
  const config = loadConfigForMutation('setDefaultLlmConnection');
  if (!config) return false;

  // No connections means nothing to set as default
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return false;
  }

  // Verify connection exists
  if (!config.llmConnections.some(c => c.slug === slug)) {
    return false;
  }

  config.defaultLlmConnection = slug;
  saveConfig(config);
  return true;
}

/**
 * The user's OWN app-level default, or `undefined` when they never set one.
 *
 * Split out of {@link getDefaultThinkingLevel} because `model-config.md#adjust-effort-level`
 * puts the model default BELOW the configured level, and a getter that always
 * answers makes everything below it unreachable. This one may decline to
 * answer; {@link getDefaultThinkingLevel} is still the always-concrete terminal
 * fallback and keeps its contract for every existing caller.
 */
export function getConfiguredDefaultThinkingLevel(): ThinkingLevel | undefined {
  const config = loadStoredConfig();
  if (!config?.defaultThinkingLevel) return undefined;
  return normalizeThinkingLevel(config.defaultThinkingLevel);
}

/**
 * Get the app-level default thinking level for new sessions.
 * Falls back to bundled config-defaults when unset.
 */
export function getDefaultThinkingLevel(): ThinkingLevel {
  const configured = getConfiguredDefaultThinkingLevel();
  if (configured) return configured;
  const defaults = loadConfigDefaults();
  // `thinkingLevel` ships ABSENT from config-defaults.json on purpose (R52):
  // a workspace-tier value here wins over the per-model default forever. The
  // literal below is the same `medium` the shipped `"think"` used to normalize
  // to, so removing the key changed nothing for an unlisted model.
  return normalizeThinkingLevel(defaults.workspaceDefaults.thinkingLevel) ?? DEFAULT_THINKING_LEVEL;
}

/**
 * The per-model hold of `model-config.md#adjust-effort-level`, for one model.
 *
 * Returns the model's documented default when a hold is in force — that is,
 * when the model is Opus 5.5, Sonnet 5.5 (F1.1214), Fable 5, Opus 4.8 or Opus
 * 4.7 (their 2.1.280-narrowed hold) AND the user has made no explicit effort
 * choice yet. Returns `undefined` otherwise, so the caller falls through to the
 * configured level (the page: it "keeps applying where it applied before").
 *
 * Side effect by design: applying a hold RECORDS the model it came from, which
 * is what makes it observable and clearable. The user's own
 * `defaultThinkingLevel` is never overwritten — the page requires it to survive
 * so a model with no hold can still carry it over.
 */
export function resolveHeldModelThinkingLevel(modelId: string | undefined): ThinkingLevel | undefined {
  if (!modelId) return undefined;
  const held = getHeldModelDefaultThinkingLevel(modelId);
  if (!held) return undefined;

  // Deliberately NOT routed through `loadConfigForMutation`, and this is the one
  // exception in the file. That helper's rule is for functions whose PURPOSE is
  // to persist a change; this one's purpose is to answer a question, and its
  // write is an incidental cache of which model the hold is parked on. With no
  // config there is no recorded explicit choice and no hold to report, so
  // `undefined` is the correct ANSWER rather than a swallowed failure — warning
  // about it would fire on every model resolve and say nothing true.
  const config = loadStoredConfig();
  // The page holds it "until you choose a level for them" — PER MODEL. Nessy
  // releases it on ANY explicit choice (one global flag), including for a
  // hold-listed model run for the first time afterwards. Residue F1.1214.
  if (!config || config.defaultThinkingLevelExplicit) return undefined;

  if (config.heldThinkingLevelModelId !== modelId) {
    config.heldThinkingLevelModelId = modelId;
    saveConfig(config);
  }
  return held;
}

/**
 * Release the `model-config.md#adjust-effort-level` hold after an explicit choice.
 *
 * Called by every explicit setter. The page releases it when "you choose a level
 * for them with `/effort` or the `/model` picker", and its non-interactive note
 * says a `/effort` in a `-p` run applies "to that session only" and is not saved
 * — so this is wired to the interactive per-session setter and to the settings
 * writer, and not to any headless path.
 *
 * @returns true if persisted, false if config could not be loaded
 */
export function releaseThinkingLevelHold(): boolean {
  const config = loadConfigForMutation('releaseThinkingLevelHold');
  if (!config) return false;
  if (config.defaultThinkingLevelExplicit && config.heldThinkingLevelModelId === undefined) return true;
  config.defaultThinkingLevelExplicit = true;
  delete config.heldThinkingLevelModelId;
  saveConfig(config);
  return true;
}

/**
 * I2.5 — the effort the user last chose FOR THIS MODEL, or `undefined`.
 *
 * ## Why the host holds it rather than each runtime
 *
 * Two of the three runtimes already persist this and the third does not:
 * claude's `Settings.modelSettings[<canonical model name>].effortLevel`
 * (`'low' | 'medium' | 'high' | 'xhigh'`, declared in the vendored `sdk.d.ts`)
 * and Pi 0.84.3's `Settings.modelThinkingLevels`, a
 * `Record<string, ThinkingLevel>` keyed by `<provider>/<id>`; codex persists
 * nothing per model. Native-first says enable what the runtime already has —
 * and the second half of that rule says the host must make the RESIDUAL
 * difference uniform or honest. Three runtimes each remembering in their own
 * store, with one not remembering at all, is the switch-safety problem itself:
 * the same user, the same model, a different answer depending on which runtime
 * happened to run it. So this is the tier-2 answer, held once for all three.
 *
 * ## What is deliberately NOT built, and why it would be wrong rather than big
 *
 * The two native stores are NOT written. Projecting into them would give the
 * same fact two homes per runtime — ours and the runtime's — and nothing
 * reconciles them, so a level set in one place and read from the other is a
 * defect waiting for a version bump. (It is also not cheap: nothing in this
 * tree feeds Pi's `SettingsManager` at construction today —
 * `settingsManagerInMemory` has no caller outside the compat adapter, and
 * `runtime-behavior.json` records that native settings discovery "cannot feed
 * construction".) If the owner wants the runtimes' own stores to be the source
 * of truth instead, that is a different row and it deletes this one.
 *
 * ## The precedence is READ, not invented
 *
 * Pi's own resolver (`@earendil-works/pi-coding-agent`'s
 * `core/model-resolver.js`, `findInitialModel`) resolves
 * `scopedModel.thinkingLevel ?? perModel ?? defaultThinkingLevel ?? DEFAULT`.
 * So a per-model memory sits BELOW an explicit choice for this run and ABOVE
 * the configured default — which is where the host's ladder in
 * `SessionManager` puts it too.
 *
 * Fails to `undefined` on an unreadable or malformed value, like every
 * neighbour: absent memory is the behaviour before this key existed.
 */
export function getModelThinkingLevel(modelId: string | undefined): ThinkingLevel | undefined {
  if (!modelId) return undefined;
  let config: StoredConfig | null = null;
  try {
    config = loadStoredConfig();
  } catch {
    return undefined;
  }
  const stored = config?.modelThinkingLevels;
  if (!stored || typeof stored !== 'object') return undefined;
  return normalizeThinkingLevel((stored as Record<string, unknown>)[modelId]);
}

/**
 * I2.5 — every remembered per-model level, for a settings surface that lists
 * or clears them. A copy, so a caller cannot mutate the stored object.
 */
export function getModelThinkingLevels(): Record<string, ThinkingLevel> {
  let config: StoredConfig | null = null;
  try {
    config = loadStoredConfig();
  } catch {
    return {};
  }
  const stored = config?.modelThinkingLevels;
  if (!stored || typeof stored !== 'object') return {};
  const out: Record<string, ThinkingLevel> = {};
  for (const [modelId, raw] of Object.entries(stored as Record<string, unknown>)) {
    const level = normalizeThinkingLevel(raw);
    if (level) out[modelId] = level;
  }
  return out;
}

/**
 * I2.5 — remember (or forget, with `undefined`) the effort for one model.
 *
 * It RELEASES the `model-config.md#adjust-effort-level` hold in the same write, as
 * {@link setDefaultThinkingLevel} does and for the same documented reason: the
 * hold lasts "until you choose a level for them", and choosing a level
 * for a model is one. Without this, a hold-listed model would keep answering
 * its documented default over the level the user just picked for it.
 *
 * The app-level `defaultThinkingLevel` is NOT touched — the page requires it to
 * survive so a model with no per-model memory still carries it over.
 *
 * @returns true if persisted, false if config could not be loaded
 */
export function setModelThinkingLevel(modelId: string, level: ThinkingLevel | undefined): boolean {
  const config = loadConfigForMutation('setModelThinkingLevel');
  if (!config) return false;
  const next = { ...(config.modelThinkingLevels ?? {}) };
  if (level === undefined) delete next[modelId];
  else next[modelId] = level;
  if (Object.keys(next).length === 0) delete config.modelThinkingLevels;
  else config.modelThinkingLevels = next;
  config.defaultThinkingLevelExplicit = true;
  delete config.heldThinkingLevelModelId;
  saveConfig(config);
  return true;
}

/**
 * Set the app-level default thinking level for new sessions.
 * @returns true if persisted, false if config could not be loaded
 */
export function setDefaultThinkingLevel(level: ThinkingLevel): boolean {
  const config = loadConfigForMutation('setDefaultThinkingLevel');
  if (!config) return false;

  // An explicit choice, so it releases the `#adjust-effort-level` hold in the same write.
  config.defaultThinkingLevelExplicit = true;
  delete config.heldThinkingLevelModelId;

  config.defaultThinkingLevel = level;
  saveConfig(config);
  return true;
}

/**
 * P6.307 — the effort level to reuse when a review is asked for without one.
 *
 * Returns `undefined` when nothing has been typed yet, which is exactly
 * `code-review.md:327`'s never-typed case: *"If you've never typed a level, the
 * review uses the session's current effort."* The caller must then leave
 * `effort` absent rather than substituting a level of its own — the session's
 * effort is the fallback, and it is not this function's to guess.
 */
export function getLastReviewEffortLevel(): ThinkingLevel | undefined {
  const config = loadStoredConfig();
  const level = normalizeThinkingLevel(config?.lastReviewEffortLevel);
  // A stored `off` cannot be produced by the writer below, but a hand-edited
  // config.json can carry one, and honouring it would silently disable every
  // later review. Read as "nothing remembered".
  return level && level !== 'off' ? level : undefined;
}

/**
 * P6.307 — remember the level the user typed for a review.
 *
 * Rejects `off` and anything unrecognised, so the store can only ever hold a
 * level from the page's own `low`-through-`max` range. Returns whether anything
 * was written, so a caller can tell "remembered" from "ignored" rather than
 * assuming.
 */
export function setLastReviewEffortLevel(level: unknown): boolean {
  const normalized = normalizeThinkingLevel(level);
  if (!normalized || normalized === 'off') return false;
  const config = loadConfigForMutation('setLastReviewEffortLevel');
  if (!config) return false;
  if (config.lastReviewEffortLevel === normalized) return false;
  config.lastReviewEffortLevel = normalized;
  saveConfig(config);
  return true;
}

/**
 * Get the app-level output style for system prompts.
 * Falls back to the built-in default style when unset.
 */
export function getOutputStyleId(): string {
  const config = loadStoredConfig();
  return normalizeOutputStyleId(config?.outputStyleId ?? DEFAULT_OUTPUT_STYLE_ID);
}

/**
 * Set the app-level output style for subsequent agent turns.
 * @returns true if persisted, false if config could not be loaded
 */
export function setOutputStyleId(styleId: string): boolean {
  const config = loadConfigForMutation('setOutputStyleId');
  if (!config) return false;

  const normalized = normalizeOutputStyleId(styleId);
  if (normalized === DEFAULT_OUTPUT_STYLE_ID) {
    delete config.outputStyleId;
  } else {
    config.outputStyleId = normalized;
  }
  saveConfig(config);
  return true;
}

/**
 * Update the lastUsedAt timestamp for a connection.
 * @param slug - Connection slug
 */
export function touchLlmConnection(slug: string): boolean {
  const config = loadConfigForMutation('touchLlmConnection');
  if (!config) return false;

  // No connections means nothing to touch
  if (!config.llmConnections) return false;

  const connection = config.llmConnections.find(c => c.slug === slug);
  if (!connection) return false;
  connection.lastUsedAt = Date.now();
  saveConfig(config);
  return true;
}

// ============================================
// Network Proxy Settings
// ============================================

import type { NetworkProxySettings } from './types.ts';
import { findRefusedProxyUrl } from './proxy-url-validation.ts';

function normalizeProxyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeNetworkProxySettings(
  settings: NetworkProxySettings,
): NetworkProxySettings {
  const tlsCaPath = normalizeProxyString(settings.tlsCaPath);
  const clientCertPath = normalizeProxyString(settings.clientCertPath);
  const clientKeyPath = normalizeProxyString(settings.clientKeyPath);
  return {
    enabled: Boolean(settings.enabled),
    httpProxy: normalizeProxyString(settings.httpProxy),
    httpsProxy: normalizeProxyString(settings.httpsProxy),
    noProxy: normalizeProxyString(settings.noProxy),
    tlsCaPath: tlsCaPath ? expandPath(tlsCaPath) : undefined,
    useBundledCa: settings.useBundledCa === false ? false : undefined,
    certStore: normalizeProxyString(settings.certStore),
    clientCertPath: clientCertPath ? expandPath(clientCertPath) : undefined,
    clientKeyPath: clientKeyPath ? expandPath(clientKeyPath) : undefined,
    // The passphrase is a secret value, not a path: never trim or rewrite it,
    // and never log it. Empty string means unset.
    clientKeyPassphrase: settings.clientKeyPassphrase || undefined,
  };
}

/**
 * P6.564 — the STORED half of the browser-pane download policy.
 *
 * Stored only: the environment outranks this file, and that ordering is applied
 * by `resolveBrowserDownloadPolicy` in the main process, which is the one place
 * that knows the environment variable names. Returning the file's own values
 * unmixed is what lets a Settings form show the user what THEY set rather than
 * what an operator's environment happens to be overriding it with.
 *
 * Total, and quiet only when there is nothing to say: a value of the wrong type
 * and a relative root both read as unset, which is today's behaviour. The
 * relative-root case is REPORTED by the resolver, not swallowed here — an
 * ignored setting that says nothing is indistinguishable from a defect.
 */
export function getBrowserDownloadSettings(): { root?: string; ask: boolean } {
  const stored = loadStoredConfig()?.browserDownload;
  if (!stored || typeof stored !== 'object') return { ask: false };
  const root = typeof stored.root === 'string' ? stored.root.trim() : '';
  return {
    ...(root.length > 0 ? { root } : {}),
    ask: stored.ask === true,
  };
}

/**
 * Write the browser-pane download policy. An empty or absent root REMOVES the
 * key rather than storing an empty string, so "unset" in config.json and
 * "unset" in the form are the same state.
 */
export function setBrowserDownloadSettings(next: { root?: string; ask?: boolean }): boolean {
  const config = loadConfigForMutation('setBrowserDownloadSettings');
  if (!config) return false;
  const root = (next.root ?? '').trim();
  const ask = next.ask === true;
  if (root.length === 0 && !ask) delete config.browserDownload;
  else config.browserDownload = { ...(root.length > 0 ? { root } : {}), ask };
  saveConfig(config);
  return true;
}

/**
 * Get the current network proxy settings.
 * Returns undefined if not configured.
 */
/**
 * Merge-preserve: a field the caller did not carry keeps its stored bytes.
 *
 * More than one writer, disjoint ownership — the settings form saves six
 * fields, an administrator configures the TLS client identity (`certStore`,
 * `clientCertPath`, `clientKeyPath`, `clientKeyPassphrase`) out-of-band — so
 * `undefined` on the incoming object means "not my field", never "delete".
 * This is the same contract `~/.nessy/dp_auth_creds.json` follows, for the
 * same reason. An explicit clear stays expressible: an empty string IS
 * carried, normalizes to `undefined`, and removes the field; `useBundledCa`
 * clears back to default by carrying an explicit `true`.
 *
 * Preserved fields bypass re-normalization on purpose — an out-of-band `~/`
 * path an unrelated save merely carried forward must keep its stored bytes.
 */
function preserveUncarriedProxyFields(
  normalized: NetworkProxySettings,
  incoming: NetworkProxySettings,
  stored: NetworkProxySettings | undefined,
): NetworkProxySettings {
  if (!stored) return normalized;
  const keep = <K extends keyof NetworkProxySettings>(key: K): NetworkProxySettings[K] =>
    incoming[key] === undefined ? stored[key] : normalized[key];
  return {
    enabled: normalized.enabled,
    httpProxy: keep('httpProxy'),
    httpsProxy: keep('httpsProxy'),
    noProxy: keep('noProxy'),
    tlsCaPath: keep('tlsCaPath'),
    useBundledCa: keep('useBundledCa'),
    certStore: keep('certStore'),
    clientCertPath: keep('clientCertPath'),
    clientKeyPath: keep('clientKeyPath'),
    clientKeyPassphrase: keep('clientKeyPassphrase'),
  };
}

/**
 * Persist network proxy settings, merge-preserving fields the caller does not
 * carry (see {@link preserveUncarriedProxyFields}).
 * Deletes the key when, after the merge, the proxy is disabled, every field
 * including the TLS client identity is empty, and bundled CA is at default.
 */
export function setNetworkProxySettings(settings: NetworkProxySettings): boolean {
  const config = loadConfigForMutation('setNetworkProxySettings');
  if (!config) return false;

  const merged = preserveUncarriedProxyFields(
    normalizeNetworkProxySettings(settings),
    settings,
    config.networkProxy,
  );

  // SOCKS is refused with a clear message rather than persisted and silently
  // misrouted (network-config.md:37). The message names the field and scheme
  // only — a proxy URL may carry credentials and must not be echoed back.
  // Checked on the merged result so a refused URL cannot ride in on the
  // preserved side either.
  const refused = findRefusedProxyUrl(merged);
  if (refused) {
    throw new Error(refused.message);
  }

  // Remove the key entirely when proxy is disabled and all fields are blank/default.
  if (
    !merged.enabled
    && !merged.httpProxy
    && !merged.httpsProxy
    && !merged.noProxy
    && !merged.tlsCaPath
    && merged.useBundledCa !== false
    && !merged.certStore
    && !merged.clientCertPath
    && !merged.clientKeyPath
    && !merged.clientKeyPassphrase
  ) {
    delete config.networkProxy;
  } else {
    config.networkProxy = merged;
  }

  saveConfig(config);
  return true;
}

// ============================================
// Setup Deferred (user skipped onboarding)
// ============================================

export function isSetupDeferred(): boolean {
  return loadStoredConfig()?.setupDeferred === true;
}

export function setSetupDeferred(deferred: boolean): boolean {
  const config = loadConfigForMutation('setSetupDeferred');
  if (!config) return false;
  if (deferred) {
    config.setupDeferred = true;
  } else {
    delete config.setupDeferred;
  }
  saveConfig(config);
  return true;
}

// ============================================
// Tool Icons (CLI tool icons for turn card display)
// ============================================

import { copyFileSync } from 'fs';


/**
 * Ensure tool-icons directory exists and has bundled defaults.
 * Resolves bundled path automatically via getBundledAssetsDir('tool-icons').
 * Copies bundled tool-icons.json and icon files on first run.
 * Only copies files that don't already exist (preserves user customizations).
 */
export function ensureToolIcons(): void {
  const toolIconsDir = getToolIconsDir();

  // Create tool-icons directory if it doesn't exist
  if (!existsSync(toolIconsDir)) {
    mkdirSync(toolIconsDir, { recursive: true });
  }

  // Resolve bundled tool-icons directory via shared asset resolver
  const bundledToolIconsDir = getBundledAssetsDir('tool-icons');
  if (!bundledToolIconsDir) {
    return;
  }

  // Copy each bundled file if it doesn't exist in the target dir
  // This includes tool-icons.json and all icon files (png, ico, svg, jpg)
  try {
    const bundledFiles = readdirSync(bundledToolIconsDir);
    for (const file of bundledFiles) {
      const destPath = join(toolIconsDir, file);
      if (!existsSync(destPath)) {
        const srcPath = join(bundledToolIconsDir, file);
        copyFileSync(srcPath, destPath);
      }
    }
  } catch {
    // Ignore errors — tool icons are optional enhancement
  }
}

// ============================================
// Server Mode Configuration
// ============================================

import { DEFAULT_SERVER_CONFIG, type ServerConfig } from './server-config.ts';
import { randomUUID } from 'crypto';

/**
 * Get the current server configuration.
 * Returns defaults if not yet configured.
 */
export function getServerConfig(): ServerConfig {
  const config = loadStoredConfig();
  return config?.serverConfig ?? { ...DEFAULT_SERVER_CONFIG };
}

/**
 * Persist server configuration.
 * Auto-generates a stable auth token on first enable if none exists.
 */
export function setServerConfig(serverConfig: ServerConfig): boolean {
  const config = loadConfigForMutation('setServerConfig');
  if (!config) return false;

  // Generate a stable token when first enabled (or if token is missing)
  if (serverConfig.enabled && !serverConfig.token) {
    serverConfig.token = randomUUID();
  }

  config.serverConfig = serverConfig;
  saveConfig(config);
  return true;
}

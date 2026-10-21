/**
 * Session Tools Core - Context Interface
 *
 * Defines the abstract context interface that both Claude (in-process)
 * and Codex (subprocess) implementations must provide.
 *
 * This enables writing tool handlers once and running them in both environments.
 */

import type {
  AuthRequest,
  ToolResult,
  SourceConfig,
  GoogleService,
  McpSourceConfig,
} from './types.ts';

// ============================================================
// Source Credential Types
// ============================================================

/**
 * Loaded source with context for credential operations.
 * Note: guide field omitted as credential manager doesn't use it.
 */
export interface LoadedSource {
  config: SourceConfig;
  folderPath: string;
  workspaceRootPath: string;
  workspaceId: string;
}

// ============================================================
// Callback Interface
// ============================================================

/**
 * Callbacks for session tool operations.
 * Both Claude and Codex implement this interface differently:
 * - Claude: Direct function calls via registry
 * - Codex: JSON messages over stderr
 */
export interface SessionToolCallbacks {
  /**
   * Called when a plan is submitted.
   * Claude: calls onPlanSubmitted callback
   * Codex: sends __CALLBACK__ message to stderr
   */
  onPlanSubmitted(planPath: string): void;

  /**
   * Called when authentication is requested.
   * Claude: calls onAuthRequest callback + forceAbort
   * Codex: sends __CALLBACK__ message to stderr
   */
  onAuthRequest(request: AuthRequest): void;
}

export interface BackgroundShellOutput {
  shellId: string;
  output: string;
  nextOffset: number;
  isRunning: boolean;
}

/**
 * One `Monitor` watch, already validated by the handler: exactly one source,
 * a non-empty description, and a resolved timeout.
 */
export interface MonitorStartInput {
  /** Model-supplied purpose. Required; capped where the registry entry is built. */
  description: string;
  /** Resolved deadline in ms. Ignored by the host when `persistent` is set. */
  timeoutMs: number;
  persistent: boolean;
  /** Shell script source: one event per stdout line, exit ends the watch. */
  command?: string;
  /** WebSocket source: one event per text frame. */
  ws?: { url: string; protocols?: string[] };
}

export interface MonitorStartResult {
  taskId: string;
  /** 0 when the watch is persistent, per the documented output shape. */
  timeoutMs: number;
  persistent?: boolean;
}

export interface SessionMonitorPort {
  start(input: MonitorStartInput): Promise<MonitorStartResult>;
  /**
   * Stop a watch this session owns. Resolves `false` when `taskId` is not a
   * monitor of this session, which is the signal for `ProcessStop` to fall
   * through to the background-shell half of the same registry.
   */
  stop(taskId: string): Promise<boolean>;
}

// ============================================================
// Scheduling
// ============================================================

/**
 * The host's per-session scheduling authority behind `CronCreate` / `CronList` /
 * `CronDelete` / `ScheduleWakeup`.
 *
 * `scheduled-tasks.md:168` — the 8-character id and the 50-task cap are enforced
 * by the store behind this port, never by the tool, so `CronList` cannot report
 * a task `CronCreate` failed to persist.
 *
 * A NAMED type rather than an inline one because it now has three declaration
 * sites: `SessionToolContext` here, `BackendConfig` (`shared/agent/backend/
 * types.ts`, the Pi path) and `SessionScopedToolCallbacks` (`shared/agent/
 * session-scoped-tool-callback-registry.ts`, the Claude path). The second used
 * to be a hand-copied mirror whose own comment said "mirrors context.ts exactly"
 * — the shape a rename breaks silently.
 */
export interface SessionCronPort {
  /**
   * R39 — `schedule` is optional ONLY for `dynamic: true` (a self-paced
   * `/loop`, whose fire times come from `ScheduleWakeup` wakeups);
   * `promptSource: 'loop-md'` marks the default-prompt loop whose delivered
   * text is re-resolved at each fire.
   */
  create(input: {
    schedule?: string;
    recurring: boolean;
    prompt: string;
    dynamic?: boolean;
    promptSource?: 'loop-md';
    /**
     * P6.376 — the model and effort LEVEL this task's runs dispatch on,
     * instead of whatever the session is set to when the fire lands. Both
     * optional; a record with neither behaves exactly as before.
     *
     * `effort` is typed as the level union rather than `string` so a TIER can
     * never be stored: on claude a tier cannot travel (the SDK takes only
     * `model`), so a tier-valued field would be honoured on pi and codex and
     * silently dropped on claude.
     */
    model?: string;
    effort?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  }): Promise<{
    id: string;
    schedule: string;
    recurring: boolean;
    prompt: string;
  }>;
  /**
   * P6.295 arm (2) — `paused` and `unreadRuns` are widened onto the EXISTING
   * row rather than added as a second method, because `CronList` renders one
   * row per task and a second call would be a second read of the same file
   * that could disagree with the first. Both optional and both dropped at
   * rest, so a list of untouched tasks is byte-identical to the old shape.
   */
  list(): Promise<readonly {
    id: string;
    schedule: string;
    recurring: boolean;
    prompt: string;
    paused?: boolean;
    unreadRuns?: number;
  }[]>;
  remove(id: string): Promise<boolean>;
  /**
   * P6.295 arm (2) — pause a task without deleting it, or resume it. `false`
   * for an unknown id, matching `remove`: the model gets "no such task" as a
   * result, not as an error.
   *
   * OPTIONAL for the same reason `rearmWakeup`/`stopWakeup` are: a backend
   * whose host has no such slot fails `CronControl` through the existing
   * "unavailable for this backend" path instead of pretending it paused
   * something.
   */
  setPaused?(id: string, paused: boolean): Promise<boolean>;
  /** P6.295 arm (2) — deliver this task's prompt at the next turn boundary. */
  runNow?(id: string): Promise<boolean>;
  /** P6.295 arm (2) — clear this task's unread-run count. */
  acknowledgeRuns?(id: string): Promise<boolean>;
  /**
   * R39 — self-paced `/loop` (`tools-reference.md:46`). OPTIONAL members so a
   * backend whose host has no wakeup slot fails `ScheduleWakeup` through the
   * existing "unavailable for this backend" path instead of pretending.
   * Rejects (throws) when no self-paced loop is active.
   */
  rearmWakeup?(input: { delayMs: number }): Promise<{ firesAt: number }>;
  /**
   * `stop: true` — "cancels the pending wakeup immediately"
   * (`scheduled-tasks.md:130`). `false` when no self-paced loop is active.
   */
  stopWakeup?(): Promise<boolean>;
}

/**
 * The host's goal authority for one session (`Goal` / `GoalGet`).
 *
 * ONE method carrying the action inside the payload, because that is what the
 * `Goal` tool's own discriminated-union schema is: the host parses the command,
 * stamps the fields a model must not choose (`source`, `creator`) and returns
 * the whole persisted state.
 *
 * A NAMED type for `SessionCronPort`'s stated reason — it has the same three
 * declaration sites (`SessionToolContext`, `BackendConfig` on the Pi path,
 * `SessionScopedToolCallbacks` on the Claude path) plus the codex bridge, and a
 * hand-copied mirror is the shape a rename breaks silently.
 */
export interface SessionGoalPort {
  execute(args: Record<string, unknown>): Promise<unknown>;
}

// ============================================================
// Worktrees
// ============================================================

export interface WorktreeEnterInput {
  /**
   * Absolute path of an EXISTING worktree to switch into. Omitted means create
   * a new one. The permission gate has already decided whether entering this
   * path needed a human — the port never re-decides that.
   */
  path?: string;
  /** Slug for a new worktree. Ignored when `path` is given. */
  name?: string;
  /**
   * P6.508 — the branch a NEW worktree is created on, instead of the derived
   * `nessy/<agent>/<leaseId>` spelling.
   *
   * Host-side only: the `EnterWorktree` tool does not expose it, so no model
   * can name a branch. The one producer is the batch fan-out, whose reply
   * NAMES the branches a human then submits — so those names have to be the
   * ones the leases actually get. Ignored when `path` is given (an existing
   * worktree is already on its branch).
   */
  branch?: string;
  /**
   * P6.336 (b) — create this worktree as PERMANENT: the automatic sweep names
   * it in its exemption set instead of collecting it once it goes quiet.
   *
   * Ignored when `path` is given: an existing worktree already has whatever
   * lifetime it was created with, and re-entering one must not be a way to
   * change it by accident.
   */
  permanent?: boolean;
  /**
   * P6.335 — branch the new worktree from a merge request (gitlab) or pull
   * request (github) instead of the configured base ref.
   *
   * The URL a person copies out of the forge. The host recognises it by PATH
   * SEGMENT, fetches `merge-requests/<n>/head` or `pull/<n>/head` from
   * `origin` — git's own mechanism, no forge credential anywhere — and uses
   * that as the base commit. Host-side only: the `EnterWorktree` tool does not
   * expose it, so no model can point a worktree at an arbitrary URL.
   *
   * Ignored when `path` is given: an existing worktree is already on its base.
   */
  mergeRequestUrl?: string;
  /**
   * P6.333 — carry the SOURCE checkout's uncommitted changes into the
   * destination, staged files still staged.
   *
   * The carry is a patch (`git diff HEAD --binary` in the source,
   * `git apply --index` in the destination), never a stash: the stash is a
   * repository-wide stack shared by every worktree, so two sessions moving at
   * once would pop each other's work. `checkout-move-plan.ts` carries the whole
   * decision; this flag is the request for it.
   */
  carryWork?: boolean;
}

export interface WorktreeLocation {
  worktreeLeaseId: string;
  path: string;
  branch: string;
  /** The working directory the session had before this call. */
  previousWorkingDirectory: string;
  /** True when this call created the worktree rather than entering an existing one. */
  created: boolean;
  /**
   * P6.333 — what a requested carry did. Present ONLY when `carryWork` was
   * asked for, so "not asked" and "asked and refused" can never be read as the
   * same answer — the shape {@link WorktreeExitResult.removal} already uses.
   */
  carry?: WorktreeCarryOutcome;
}

/** P6.333 — the outcome of a requested work carry, in either direction. */
export interface WorktreeCarryOutcome {
  /** True when the uncommitted work reached the destination. */
  carried: boolean;
  /** The planner's own sentence: what moved, or why it was refused. */
  summary: string;
}

export interface WorktreeLeaseSummary {
  worktreeLeaseId: string;
  path: string;
  branch: string;
  /**
   * ISO timestamp of the last enter/exit/acquire for this lease.
   *
   * The enumeration seam R12's retention sweep needs, and the only reason this
   * method exists here. R2 stamps it and stops: age-based removal, lock release
   * and the dirty/unpushed skip are all R12's, and building a second sweep here
   * is explicitly out of scope.
   */
  lastUsedAt: string;
}

export interface WorktreeExitInput {
  /**
   * Remove the worktree on the way out instead of leaving it on disk (P6.22).
   *
   * The keep-or-remove offer. Without it, leaving a worktree only ever KEPT it,
   * and the only thing that ever removed one was an age sweep the user does not
   * see. Removal REFUSES when the worktree still holds work — uncommitted
   * changes, or commits that exist nowhere else — and says which, rather than
   * destroying it on the way past.
   */
  remove?: boolean;
  /** P6.333 — carry the worktree's uncommitted changes back. See {@link WorktreeEnterInput.carryWork}. */
  carryWork?: boolean;
}

export interface WorktreeExitResult {
  path: string;
  previousWorkingDirectory: string;
  /**
   * Present only when `remove` was asked for, so "not asked" and "asked and
   * refused" can never be read as the same answer.
   */
  removal?: {
    removed: boolean;
    /** The work's handle when it was kept: `git checkout <branch>` reaches it. */
    branch: string;
    /** Why it was kept. Absent when `removed` is true. */
    keptReason?: string;
  };
  /** P6.333 — see {@link WorktreeLocation.carry}. Present only when asked for. */
  carry?: WorktreeCarryOutcome;
}

/** P6.508 — one unit of a requested batch, before the planner slugs it. */
export interface WorktreeBatchTaskInput {
  name: string;
  prompt: string;
}

/** P6.508 — what a batch actually started, and what it did not. */
export interface WorktreeBatchOutcome {
  /** Sessions that were created, each isolated on its own branch. */
  started: { sessionId: string; name: string; branch: string }[];
  /** Tasks the bound refused, NAMED — never silently dropped. */
  deferred: { name: string; reason: string }[];
  /** The bound that was applied, so the reply states it rather than a constant. */
  bound: number;
  /** `describeBatchSubmission`'s own text: the branches a human must submit. */
  summary: string;
}

export interface SessionWorktreePort {
  /** Create or enter a worktree and move the session's working directory into it. */
  enter(input: WorktreeEnterInput): Promise<WorktreeLocation>;
  /**
   * Move back to the launch directory. Resolves `null` when the session is not
   * in a worktree, which the handler reports rather than treating as an error —
   * `ExitWorktree` needs no permission and must not fail a turn.
   *
   * A refused removal is part of the RESULT, not a throw, for the same reason.
   */
  exit(input?: WorktreeExitInput): Promise<WorktreeExitResult | null>;
  /** Every lease of this session's repository, with its last use. R12's seam. */
  list(): Promise<readonly WorktreeLeaseSummary[]>;
  /**
   * P6.508 — fan one request out into N worktree-isolated sessions, each on its
   * own branch, and NEVER open a merge request (delegated decision Q-den 31,
   * option A: worktrees and branches, a human opens the MRs).
   *
   * OPTIONAL for `SessionCronPort`'s stated reason: a host with no session
   * factory behind it fails through the existing "unavailable for this backend"
   * path rather than reporting a fan-out that never happened.
   */
  batch?(input: {
    tasks: readonly WorktreeBatchTaskInput[];
    branchPrefix: string;
    bound?: number;
  }): Promise<WorktreeBatchOutcome>;
}

// ============================================================
// Desktop Notifications
// ============================================================

/**
 * Why a `PushNotification` call produced no OS notification. Named rather than
 * boolean, because the model has to be able to tell "you are already looking at
 * this" apart from "notifications are off" — the first is normal, the second is
 * a setting the user can change.
 */
export type DesktopNotificationSuppression =
  /** The window showing this session's workspace has focus. */
  | 'window-focused'
  /** The user turned notifications off in settings. */
  | 'notifications-disabled'
  /** No desktop shell is attached (headless server, unsupported platform). */
  | 'unsupported';

export interface DesktopNotificationResult {
  delivered: boolean;
  reason?: DesktopNotificationSuppression;
}

/**
 * Host authority for the model-facing `PushNotification` tool.
 *
 * The model supplies only the text. The workspace and session a notification
 * navigates to are filled in by the host from the session it is bound to, so a
 * model cannot address a notification at somebody else's session.
 *
 * `tools-reference.md:41` describes both halves of this tool: a desktop
 * notification, "and a phone push when Remote Control is connected". Only the
 * desktop half exists here — see the handler for why the push half is
 * inapplicable rather than missing.
 */
export interface SessionNotificationPort {
  notify(input: { title?: string; body: string }): Promise<DesktopNotificationResult>;
}

// ============================================================
// MCP Resources
// ============================================================

/** One discovered MCP resource, projected for the model-facing list tool. */
export interface McpResourceListEntry {
  /** Source slug the resource belongs to. */
  server: string;
  uri: string;
  name?: string;
  mimeType?: string;
  description?: string;
}

/** One discovered MCP resource TEMPLATE, projected for the list tool (UB7.10). */
export interface McpResourceTemplateEntry {
  /** Source slug the template belongs to. */
  server: string;
  /** The template uri — `{placeholders}` the model fills to form a resource uri. */
  uriTemplate: string;
  name?: string;
  mimeType?: string;
  description?: string;
}

/** What the model-facing resource list answers: both listings and the page cap. */
export interface McpResourceListing {
  resources: McpResourceListEntry[];
  resourceTemplates: McpResourceTemplateEntry[];
  /** Listing stopped at the page cap while a server still had pages */
  truncated: boolean;
}

/**
 * Host authority for the model-facing `list_mcp_resources` / `read_mcp_resource`
 * tools. Bound by SessionManager to the session's MCP pool + leaser. Absent when
 * the session has no pool, which makes the tools report unavailability rather
 * than guess. Both operations are read-only.
 */
export interface SessionMcpResourcesPort {
  /**
   * Resources — and, since UB7.10, resource TEMPLATES — across
   * resource-advertising sources, or one source when `server` is given. Each
   * source's listing follows pagination; a source that cannot be listed
   * contributes nothing instead of failing the aggregate.
   */
  list(server?: string): Promise<McpResourceListing>;
  /**
   * Read one resource as agent-ready text (UB7.10): text contents joined,
   * binary contents saved to the session's downloads/ and described, and the
   * large-result guard tool results get.
   */
  read(server: string, uri: string): Promise<string>;
}

// ============================================================
// MCP source prompts (source_list_prompts / source_get_prompt) — UB7.11,
// upstream v0.15.1 `context.ts` types, verbatim shapes.
// ============================================================

export interface McpSourcePromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/** A prompt an MCP server publishes (returned by source_list_prompts). */
export interface McpSourcePrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpSourcePromptArgument[];
}

/** Result of source_list_prompts. */
export interface McpSourcePromptList {
  prompts: McpSourcePrompt[];
  /** The listing stopped at the backend's page cap while the server still had pages */
  truncated?: boolean;
}

/**
 * MCP source prompts callbacks, injected by the backend (SessionManager, backed
 * by the session's MCP pool). Failures — source not enabled or not connected,
 * API source, capability missing — are thrown with messages written for the
 * agent. Upstream's `McpSourceToolCallbacks` carries a resources half
 * (`listResources` / `readResource`) beside this prompts half; ours is prompts
 * only, because resources stay native on Claude and codex and `pi-only` on Pi
 * (UB7.11; B4-06 HAVE, manifest "not adopted (resources native)").
 */
export interface McpSourceToolCallbacks {
  listPrompts(sourceSlug: string): Promise<McpSourcePromptList>;
  /** The prompt's messages, with the arguments filled in, rendered as text (role + content). */
  getPrompt(sourceSlug: string, name: string, args?: Record<string, string>): Promise<string>;
}

/** One supporting file of an invoked skill, served from the pinned snapshot. */
export interface SkillResourceContents {
  /** The handle that was dereferenced. */
  handle: string;
  /** The sha256 the bytes were pinned at. */
  digest: string;
  /** The file's path relative to its skill's directory — never an absolute path. */
  relativePath: string;
  /** The invoked skill's logical name. */
  skill: string;
  /** The PINNED bytes, re-verified against `digest` before being returned. */
  content: string;
}

/**
 * Host authority for the model-facing `read_skill_resource` tool. Bound by the
 * agent that owns the pinned skill-invocation snapshot, because that snapshot is
 * where the bytes live. Absent when no agent has claimed the session, which
 * makes the tool report unavailability rather than guess.
 *
 * `read` rejects rather than returning a partial result: an unknown handle, a
 * handle whose skill is no longer active, and a file that changed on disk since
 * it was pinned are all distinct named failures.
 */
export interface SessionSkillResourcesPort {
  read(handle: string): Promise<SkillResourceContents>;
}

// ============================================================
// File System Interface
// ============================================================

/**
 * File system abstraction for portability.
 * Allows mocking in tests and different implementations in different environments.
 */
export interface FileSystemInterface {
  /** Check if file/directory exists */
  exists(path: string): boolean;

  /** Read file as UTF-8 string */
  readFile(path: string): string;

  /** Read file as Buffer (for binary/images) */
  readFileBuffer(path: string): Buffer;

  /** Write file */
  writeFile(path: string, content: string): void;

  /** Atomically write file when host can provide it. */
  atomicWriteFile?(path: string, content: string): void;

  /** Check if path is a directory */
  isDirectory(path: string): boolean;

  /** List directory contents */
  readdir(path: string): string[];

  /** Get file stats */
  stat(path: string): { size: number; isDirectory(): boolean };
}

// ============================================================
// Credential Manager Interface
// ============================================================

/**
 * Credential manager abstraction.
 * Claude has full access to credential stores.
 * Codex may have limited or no access (relies on main process).
 */
export interface CredentialManagerInterface {
  /**
   * Check if a source has valid, non-expired credentials
   */
  hasValidCredentials(source: LoadedSource): Promise<boolean>;

  /**
   * Get the current access token for a source (null if expired/missing)
   */
  getToken(source: LoadedSource): Promise<string | null>;

  /**
   * Refresh the access token for a source
   */
  refresh(source: LoadedSource): Promise<string | null>;
}

// ============================================================
// Validator Interface
// ============================================================

/**
 * Config validation interface.
 * Claude uses full Zod validators from packages/shared.
 * Codex uses simplified validators from session-tools-core.
 */
export interface ValidatorInterface {
  validateConfig(): import('./types.js').ValidationResult;
  validateSource(workspaceRootPath: string, sourceSlug: string): import('./types.js').ValidationResult;
  validateAllSources(workspaceRootPath: string): import('./types.js').ValidationResult;
  validateStatuses(workspaceRootPath: string): import('./types.js').ValidationResult;
  validatePreferences(): import('./types.js').ValidationResult;
  validatePermissions(workspaceRootPath: string, sourceSlug?: string): import('./types.js').ValidationResult;
  validateAutomations(workspaceRootPath: string): import('./types.js').ValidationResult;
  validateToolIcons(): import('./types.js').ValidationResult;
  validateAll(workspaceRootPath: string): import('./types.js').ValidationResult;
  validateSkill(workspaceRootPath: string, skillSlug: string): import('./types.js').ValidationResult;
}

/**
 * Host-backed automation store. The four argument types are the ones the ONLY
 * caller — `handlers/automation-management.ts` — has already established: each
 * handler `parse`s with the schema named here and hands the PARSED value over.
 *
 * They were `Record<string, unknown>` until P3.154, and that erasure was not a
 * deliberate boundary: no plugin, no wire, no version skew crosses here, and
 * the schemas live in this same package. It was introduced with no comment in
 * `b0053399e` ("fix: align displayed app version source"), and both
 * implementations then paid for it — `session-mcp-server` with two `as`
 * assertions that P3.130 had to replace with a re-`parse`, and
 * `shared/agent/claude-context.ts` with an `as unknown as` DOUBLE cast that
 * silenced the compiler rather than checking anything.
 *
 * Naming the shapes here is what makes the agreement between these schemas and
 * the shared writers' `AutomationCreateInput`/`AutomationUpdateInput` a COMPILE
 * error on drift — the property both casts destroyed.
 */
export interface AutomationManagerInterface {
  list(args: import('./handlers/automation-management.ts').AutomationListArgs): Promise<import('./types.js').ToolResult>;
  create(args: import('./handlers/automation-management.ts').AutomationCreateArgs): Promise<import('./types.js').ToolResult>;
  update(args: import('./handlers/automation-management.ts').AutomationUpdateArgs): Promise<import('./types.js').ToolResult>;
  validate(args: import('./handlers/automation-management.ts').AutomationValidateArgs): Promise<import('./types.js').ToolResult>;
}

/**
 * Host-callback boundary for the agent-driven plugin management tools
 * (plugin_plan_install, plugin_install, plugin_status, plugin_manage).
 * The real implementation lives in `@nessy-agent/shared/agent/plugin-management-tools`
 * and is bound onto the context per-session by SessionManager; this package
 * never talks to MarketplaceService/PluginManagementService directly.
 */
export interface PluginManagementToolsInterface {
  planInstall(args: Record<string, unknown>): Promise<import('./types.js').ToolResult>;
  install(args: Record<string, unknown>): Promise<import('./types.js').ToolResult>;
  status(args: Record<string, unknown>): Promise<import('./types.js').ToolResult>;
  manage(args: Record<string, unknown>): Promise<import('./types.js').ToolResult>;
}

// ============================================================
// Session Tool Context
// ============================================================

/**
 * Main context interface for session tools.
 *
 * Both Claude and Codex create their own implementation of this interface:
 * - Claude: createClaudeContext() with direct access to Electron internals
 * - Codex: createCodexContext() with callback IPC and limited capabilities
 */
export interface SessionToolContext {
  // ============================================================
  // Session Info
  // ============================================================

  /** Trusted Nessy config root injected by the owning runtime. */
  configRoot: string;

  /** Unique session identifier */
  sessionId: string;

  /** Absolute path to the workspace folder. */
  workspacePath: string;

  /** Path to sources folder within workspace */
  get sourcesPath(): string;

  /** Path to skills folder within workspace */
  get skillsPath(): string;

  /** Path to session's plans folder */
  plansFolderPath: string;

  /** Working directory (project root) for the session, if set */
  workingDirectory?: string;

  // ============================================================
  // Callbacks (transport-agnostic)
  // ============================================================

  callbacks: SessionToolCallbacks;

  // ============================================================
  // File System
  // ============================================================

  fs: FileSystemInterface;

  // ============================================================
  // Validators (optional - may use basic or full)
  // ============================================================

  validators?: ValidatorInterface;

  /** Optional host-backed automation manager. */
  automationManager?: AutomationManagerInterface;

  /**
   * Pi-only host task authority. Omitted outside the extension-first runtime.
   *
   * `execute` is the legacy `Task` tool's channel (kept for `NESSY_ENABLE_TASKS=0`);
   * `executeDocumented` is the R20 channel the four documented tools use. Both
   * reach the SAME host store — a second store behind either method is the
   * defect this series keeps shipping.
   */
  taskPort?: {
    execute(args: Record<string, unknown>): Promise<unknown>;
    executeDocumented?(
      command: import('./tasks/documented-tasks.ts').DocumentedTaskCommand,
    ): Promise<import('./tasks/documented-tasks.ts').DocumentedTaskResult>;
    /** Turn-end sweep for the documented `TaskCompleted` no-tool-call case. */
    notifyTurnEnd?(): Promise<void>;
  };
  /**
   * Host scheduling authority (R27b). The host owns the store, the once-a-second
   * check and the between-turns delivery gate; the tools only describe what the
   * model asked for.
   *
   * T3 — no longer Pi-only. The port is bound for every runtime in
   * `SCHEDULED_DELIVERY_RUNTIMES`, so a claude-runtime session's `CronCreate`
   * reaches the same host service a Pi session's does. Absent still means the
   * backend has no scheduler, which is what makes the tools report
   * unavailability instead of pretending.
   */
  cronPort?: SessionCronPort;
  /**
   * Host goal authority. The goal record, its budgets, its evaluator and the
   * continuation that drives it are server-owned; the tools only describe what
   * the model asked for.
   *
   * P2.2 — no longer Pi-only. The port is bound for every runtime in
   * `SCHEDULED_DELIVERY_RUNTIMES`, so a claude-runtime or codex session's `Goal`
   * reaches the same host `GoalService` a Pi session's does. Absent still means
   * the backend has no goal authority, which is what makes the two tools report
   * unavailability instead of pretending.
   *
   * The stored state is still typed `PiGoalStateV1` and persisted under
   * `goalState`. The `Pi` in that name is HISTORICAL — it records where the
   * feature was built, not where it runs — and is deliberately not renamed:
   * the field is on disk in every existing session.
   */
  goalPort?: SessionGoalPort;
  planModePort?: { submit(input: { planPath: string }): Promise<void> };

  /**
   * Agent-driven plugin management (plugin_plan_install/plugin_install/
   * plugin_status/plugin_manage). Only available in backends that run
   * alongside SessionManager (Claude in-process, Pi subprocess) — the
   * host-owned MarketplaceService/PluginManagementService boundary.
   */
  pluginManagement?: PluginManagementToolsInterface;

  /**
   * P3.276 — the host-computed diff a delegated review runs on.
   *
   * `code-review.md` § *Review a diff locally* promises the same thing on every
   * runtime: the review "runs as a background subagent with its own context
   * window". P3.204 gave claude and codex the CONTEXT half by delegating to a
   * subagent; the DIFF half stayed Pi's, because the only diff computation in
   * this fork lived inside Pi's `review` tool. On the other two the delegated
   * reviewer therefore reviewed whatever diff the model chose to run for
   * itself — a different scope chosen by a different reader every time, and one
   * that quietly disagreed with the documented default.
   *
   * The computation now lives in `@nessy-agent/shared/prompts/review-diff`.
   * This package cannot import it — `shared` depends on THIS package, so the
   * arrow only points one way — which is why the tool is a thin dispatcher onto
   * a host port, exactly like {@link SessionToolContext.pluginManagement} and
   * `ctx.cronPort`. Absent means the backend has no diff authority, and the
   * tool says so rather than shelling out to a `git` of its own.
   *
   * The port answers with the TASK as well as the diff, and that is the
   * substitution Pi performs per call: `reviewerDefWithRubric` swaps
   * `REVIEW_RUBRIC_PROMPT` in as the child's system prompt so the bundled
   * `reviewer` definition stays a general-purpose reviewer. On claude the same
   * swap is impossible — `AgentDefinition.prompt` is a construction-time field
   * of the SDK's `agents` option, with no per-call override and no live setter
   * — so the rubric rides the task text instead. Same rubric, same reviewer
   * definition, delivered through the one channel each runtime has.
   */
  reviewDiff?: SessionReviewDiffPort;

  // ============================================================
  // Optional Capabilities
  // ============================================================

  /**
   * Get credential manager for source authentication checks.
   * Only available in Claude (has keychain access).
   */
  credentialManager?: CredentialManagerInterface;

  /**
   * Load a source config from the workspace.
   */
  loadSourceConfig(sourceSlug: string): SourceConfig | null;

  /**
   * Save a source config to the workspace.
   */
  saveSourceConfig?(source: SourceConfig): void;

  /**
   * Remove a source the way the UI's DELETE channel does — folder, workspace
   * default list, and the live capability snapshot. Host-bound because the
   * snapshot revocation needs a handle this package does not have; omitted
   * leaves `source_manage: remove` refusing honestly.
   */
  removeSource?(sourceSlug: string): Promise<void>;

  /**
   * Infer Google service from URL.
   */
  inferGoogleService?(url?: string): GoogleService | undefined;

  /**
   * Capability-path seam (C2): resolve a plugin-owned MCP server the model may
   * authenticate. Returns null when the plugin/server does not exist, is not
   * enabled, or does not ride the capability path. Hosts that have not wired
   * the capability path omit the seam entirely — the trigger then refuses the
   * plugin target instead of fabricating a flow.
   */
  resolvePluginMcpServer?(
    pluginKey: string,
    serverName: string,
  ): { displayName: string; authType: 'oauth' | 'bearer' | 'none' } | null;

  /**
   * Check if Google OAuth is configured.
   */
  isGoogleOAuthConfigured?(clientId?: string, clientSecret?: string): boolean;

  // ============================================================
  // Icon Management (for source_test)
  // ============================================================

  /**
   * Check if a value is a URL that can be used as an icon.
   */
  isIconUrl?(value: string): boolean;

  /**
   * Download an icon from URL to the source folder.
   * Returns the path to the cached icon, or null if download failed.
   */
  downloadSourceIcon?(sourceSlug: string, iconUrl: string): Promise<string | null>;

  /**
   * Derive a service URL from a source config (for favicon fetching).
   */
  deriveServiceUrl?(source: SourceConfig): string | null;

  /**
   * Get a high-quality logo URL from a service URL.
   */
  getHighQualityLogoUrl?(serviceUrl: string, slug: string): Promise<string | null>;

  /**
   * Download an icon to a specific destination path.
   */
  downloadIcon?(destPath: string, url: string, tag: string): Promise<string | null>;

  // ============================================================
  // MCP Connection Validation (for source_test)
  // ============================================================

  /**
   * Validate a stdio MCP connection by spawning the command.
   */
  validateStdioMcpConnection?(config: StdioMcpConfig): Promise<StdioValidationResult>;

  /**
   * Validate an HTTP/SSE MCP connection.
   */
  validateMcpConnection?(config: HttpMcpConfig): Promise<McpValidationResult>;

  /** Sanitized, timed OAuth discovery classification. Metadata never crosses this boundary. */
  discoverMcpOAuth?(url: string): Promise<boolean>;

  // ============================================================
  // API Testing (for source_test)
  // ============================================================

  /**
   * Test an API source connection with full credential handling.
   */
  testApiSource?(source: SourceConfig): Promise<ApiTestResult>;

  /**
   * Test a Google source (OAuth token validation).
   */
  testGoogleSource?(source: SourceConfig): Promise<ApiTestResult>;

  // ============================================================
  // Preferences (for update_user_preferences)
  // ============================================================

  /**
   * Submit developer feedback. Injected by each backend:
   * - Claude: writes JSON files to configRoot/feedback/
   * - Codex/Pi: could send over IPC or write directly
   */
  submitFeedback?(feedback: import('./types.ts').DeveloperFeedback): void;

  /**
   * Update user preferences. Injected by each backend:
   * - Claude: calls updatePreferences() from config/preferences.ts
   * - Codex/session-mcp-server: writes directly to preferences.json
   * - Pi: calls updatePreferences() from config/preferences.ts
   */
  updatePreferences?(updates: Record<string, unknown>): void;

  // ============================================================
  // Session Self-Management (for set_session_labels, etc.)
  // ============================================================

  /** Set labels on a session. Defaults to current session if no ID given. Injected by backend. */
  setSessionLabels?(sessionId: string | undefined, labels: string[]): void | Promise<void>;

  /** Set status on a session. Defaults to current session if no ID given. Injected by backend. */
  setSessionStatus?(sessionId: string | undefined, status: string): void | Promise<void>;

  /**
   * Get detailed info about a session. Defaults to current session if no ID
   * given. Injected by backend.
   *
   * P3.222 — the return may be a PROMISE, and the widening is what let this
   * reach codex at all. Pi and Claude resolve the host closure in-process and
   * answer synchronously; an external standalone subprocess reaches the same
   * closure over the host-callback bridge, which is HTTP. Every call site inside
   * this package awaits, so a synchronous host binding is unchanged.
   */
  getSessionInfo?(sessionId?: string): SessionInfo | null | Promise<SessionInfo | null>;

  /** List sessions in the workspace with pagination. Injected by backend. @see getSessionInfo for why the return may be a promise. */
  listSessions?(options?: ListSessionsOptions): ListSessionsResult | Promise<ListSessionsResult>;

  /** Resolve label display names to IDs against configured labels. Injected by backend; a promise on codex (UA1.3, over the bridge). */
  resolveLabels?(labels: string[]): ResolvedLabelsResult | Promise<ResolvedLabelsResult>;

  /** Resolve a status display name to its ID against configured statuses. Injected by backend; a promise on codex (UA1.3). */
  resolveStatus?(status: string): ResolvedStatusResult | Promise<ResolvedStatusResult>;

  /**
   * P6.466 — archive or unarchive a session. Defaults to the current session
   * when no id is given. Injected by backend (SessionManager).
   *
   * ## Why this port raises its own approval and the permission gate does not
   *
   * The row asks for a card in EVERY permission mode including
   * `bypassPermissions`. MEASURED, and neither candidate seam can carry that
   * for a session MCP tool:
   *
   * - `INTERACTION_ONLY_TOOLS` lives inside `runPreToolUseChecks`, which has
   *   ZERO call sites in `codex-agent.ts` — the codex answer path never runs
   *   it, so a name added there is invisible on codex.
   * - `findNonNegotiableFloors` DOES reach codex, but only through
   *   `CodexAgent.floorVerdict` → `codexApprovalFloorSubjects`, which projects
   *   codex's `command` / `commandV1` / `fileChangeV1` approvals into `Bash` and
   *   `Write` subjects. An MCP tool call produces NO subject at all, so the
   *   floor is never asked about this tool's name either.
   *
   * The seam that does reach all three is this one: the host closure behind the
   * port. Pi and Claude resolve it in process, codex over
   * `HOST_CALLBACK_BRIDGE_ROUTES.sessionArchive`, and the card is raised by
   * `SessionManager` with `directPermissionResolvers` — the same one-shot,
   * `noAlwaysAllow` mechanism `authorizeMonitor` already uses for
   * `monitorPort.start`, which consults no permission mode at all. That is what
   * makes the switch verdict UNIFORM by construction rather than by assumption.
   *
   * Returns a verdict rather than `void` so a denial is reported to the caller
   * instead of read as success: `done_means` (c) requires the target to be left
   * unarchived and the refusal named.
   */
  archiveSession?(sessionId: string | undefined, archived: boolean): Promise<ArchiveSessionVerdict>;

  // ============================================================
  // Inter-Session Messaging
  // ============================================================

  /**
   * Send one piece of text to another session. Injected by backend
   * (SessionManager), which delivers it as a between-turns task notification —
   * agent authority, no files.
   *
   * Returns the RECEIVER's verdict rather than `void`, because
   * `cross-session-messaging.md` §Limitations requires the sender to learn which
   * guard stopped a message — "Claude Code tells that session which one dropped
   * it and tells its Claude not to resend right away". A `void` return can only
   * say "sent", which is the exact shape the page calls out as the pre-v2.1.236
   * bug: "Before v2.1.236, Claude Code reported those sends as sent while the
   * receiving session dropped them."
   */
  sendAgentMessage?(
    sessionId: string,
    message: string,
    options?: SendAgentMessageOptions,
  ): Promise<AgentMessageDeliveryVerdict>;

  /** Dispatch an explicitly whitelisted slash command in the active backend session. */
  dispatchSlashCommand?(command: string): Promise<string | void> | string | void;

  /** Read buffered output from a background shell created by bash_background. */
  readBackgroundShellOutput?(shellId: string, offset?: number): Promise<BackgroundShellOutput | null> | BackgroundShellOutput | null;

  /** Stop an owner-bound background shell created by bash_background. */
  stopBackgroundShell?(shellId: string): Promise<void> | void;

  /**
   * Start and stop event-streaming watches for the Monitor tool.
   *
   * A monitor is a SECOND PRODUCER into the same owner-bound background-task
   * registry `bash_background` writes to — not a registry of its own. That is
   * why `stop` lives here rather than on a second stop tool: `ProcessStop`
   * consults this port first and falls through to
   * {@link SessionToolContext.stopBackgroundShell}, so both producers share one
   * identifier space and one stop path.
   */
  monitor?: SessionMonitorPort;

  /**
   * Create, enter and leave the session's git worktrees.
   *
   * Absent whenever the session has no repository, which is what makes
   * `EnterWorktree` report "not available here" instead of guessing at a place
   * to put a worktree.
   */
  worktree?: SessionWorktreePort;

  /**
   * Raise an OS notification for this session, for the model-facing
   * `PushNotification` tool. Absent when no desktop shell owns the session,
   * which makes the tool report unavailability instead of pretending.
   */
  notificationPort?: SessionNotificationPort;

  /**
   * Read MCP resources and prompts discovered on the session's connected
   * sources, for the model-facing `list_mcp_resources` / `read_mcp_resource`
   * tools. Absent when the session has no MCP pool.
   */
  mcpResources?: SessionMcpResourcesPort;

  /**
   * List and render the prompts the session's enabled, connected MCP sources
   * publish, for the model-facing `source_list_prompts` / `source_get_prompt`
   * tools (UB7.11, upstream v0.15.1). Bound by SessionManager from the session's
   * MCP pool; pool and enabled sources are read at call time. Absent in
   * backends that don't run alongside SessionManager's registry — the handlers
   * degrade gracefully.
   */
  mcpSources?: McpSourceToolCallbacks;

  /**
   * UB6.11 — decision-layer callback for the `decide` tool (Jev / System One
   * typed judgments over text or JSON; upstream v0.15.1's `ctx.decide`,
   * verbatim shape). Injected by the backend (SessionManager) only when a
   * decision provider is configured — the fact `SessionToolFilterOptions.decidePort`
   * names — and resolved per call behind it, so a provider that vanishes
   * mid-session fails closed with the message the agent can relay. Undefined in
   * backends that don't run alongside it — the handler tells the agent how the
   * user can enable it. Answers are hints for the agent and never grant
   * authority.
   */
  decide?: DecisionToolCallbacks;

  /**
   * Dereference a `skill-resource:` handle emitted by an invoked skill, for the
   * model-facing `read_skill_resource` tool. Absent when no agent owns the
   * session's pinned skill snapshot.
   */
  skillResources?: SessionSkillResourcesPort;

  /**
   * Activate a source in the running session: add to enabledSourceSlugs,
   * build its MCP/API servers, apply to the agent.
   *
   * Only available in backends that run alongside SessionManager (Claude in-process, Pi subprocess).
   * Codex and other backends leave this undefined — callers should degrade gracefully (restart required).
   *
   * `availability` is always `'next-turn'` when activation succeeds: both Claude SDK
   * (frozen `mcpServers` at `query()` start) and Pi (subprocess reloads proxy tools
   * on the next `handlePrompt`) require the current turn to end before new tools
   * are callable. The backend handles this via the existing source_activated + auto_retry
   * machinery — the current turn is aborted and the renderer resends the user's
   * original message with a `[{slug} activated]` suffix.
   */
  activateSourceInSession?(sourceSlug: string): Promise<{
    ok: boolean;
    reason?: string;
    availability?: 'next-turn';
  }>;

  // ============================================================
  // Session Paths (for transform_data / render_template)
  // ============================================================

  /** Absolute path to the session directory (transform_data's input files). */
  sessionPath?: string;

  /** The session's data directory (transform_data and render_template output). */
  dataPath?: string;

  /** Absolute path to user-scoped MEMORY.md in the app config directory. */
  userMemoryPath?: string;

  /** Whether MEMORY.md read/write tools are enabled for this session. */
  memoryEnabled?: boolean;

  /** F1.107 — the host's read policy for tools that spawn their own sandboxed child; an ACCESSOR
   * (contexts are cached per session), absent = none declared. `runtime/script-sandbox-read-floor.ts`. */
  sandboxReadFloor?: () => { deniedReadRoots?: readonly string[]; readsFencedToWorkingDirectory?: boolean };
  /** F1.191 — the LATCHED home that floor's credential roots anchor on; absent = the live `os.homedir()`. */
  credentialHomeDir?: () => string;
}

// ============================================================
// Session Self-Management Types — Resolution
// ============================================================

/** Result of resolving label names/IDs against configured labels. */
export interface ResolvedLabelsResult {
  /** Resolved label IDs (ready to store) */
  resolved: string[];
  /** Labels that couldn't be matched to any configured label */
  unknown: string[];
  /** All valid label IDs (for error messages) */
  available: string[];
  /**
   * Optional per-input rejection reason, keyed by the original input string.
   * Populated by `resolveSessionLabels()` from `@nessy-agent/shared/labels`.
   * Handlers use this to build clearer errors (e.g. "label X doesn't accept a value").
   */
  reasons?: Record<string, string>;
}

/** Result of resolving a status name/ID against configured statuses. */
export interface ResolvedStatusResult {
  resolved: string | null; // Matched status ID, or null if unknown
  available: string[]; // All valid status IDs (for error messages)
  /** UA1.2 — the matched status's category; set_session_status refuses 'closed' (the human owns closure). */
  category?: 'open' | 'closed';
}

/**
 * What the receiving session did with an inter-session message.
 *
 * `cross-session-messaging.md` §Message delivery: "The receiving session checks
 * each arriving message against its own inbound controls, and the check ends in
 * one of three outcomes: **Delivered** … **Held** … **Refused**". `dropped` is
 * the fourth outcome §Limitations adds — the rate limit, the identical-repeat
 * check and the queue cap — and it is kept distinct from `refused` because they
 * mean different things to the sender: a refusal is a standing posture, a drop
 * is a "not right now".
 *
 * `note` is what the sender's model reads, so it carries the guard's name and
 * the page's "not right away" instruction rather than a bare status word.
 */
export interface AgentMessageDeliveryVerdict {
  status: 'delivered' | 'held' | 'refused' | 'dropped';
  note?: string;
  /**
   * P6.465 (N6) — what happened to a `notify_when_idle` request, present only
   * when one was made.
   *
   * Separate from `status` because the page keeps the two decisions separate:
   * "Attached to a message, Claude Code delivers the message first and sends the
   * notice later", and a subagent's request is refused while its message is not
   * ("Claude Code makes no subscription and tells it so"). Folding them into one
   * status would force the handler to report a delivered message as a failure,
   * or a refused subscription as a success.
   */
  subscription?: {
    status: 'subscribed' | 'already-idle' | 'refused';
    note: string;
  };
}

/**
 * P6.465 (N6) — `cross-session-messaging.md#get-a-notice-when-another-session-goes-idle`:
 * "Claude can ask one of your sessions on this machine to send back one notice
 * when that session next goes idle or exits. Idle here means the session
 * finished a turn with nothing queued."
 *
 * A subscription can ride a message or travel alone — "either attached to a
 * message it's sending anyway or on its own" — which is why an EMPTY `message`
 * is meaningful on this port and means subscribe-only: "On its own, Claude Code
 * subscribes without starting a turn or spending tokens in the watched session".
 */
export interface SendAgentMessageOptions {
  notifyWhenIdle?: boolean;
}

// ============================================================
// Session Self-Management Types
// ============================================================

/** Full metadata for a single session (returned by get_session_info). */
export interface SessionInfo {
  id: string;
  name: string;
  labels: string[];
  status: string;
  permissionMode: string;
  createdAt: number;
  updatedAt?: number;
  workingDirectory?: string;
  llmConnection?: string;
  model?: string;
  isActive: boolean;
}

/**
 * P6.466 — the outcome of one `archive_session` call.
 *
 * Four outcomes rather than a boolean, because three of them mean different
 * things to the model and `done_means` names each: `applied` (the flag moved),
 * `unchanged` (it already read that way — not an error, and not a reason to
 * retry), `denied` (a person said no, so the target is untouched), `not-found`
 * (no such session inside the caller's own Workspace).
 *
 * `note` is what the caller's model reads, so it names which of the four
 * happened in words rather than leaving a bare status to be interpreted.
 */
export interface ArchiveSessionVerdict {
  status: 'applied' | 'unchanged' | 'denied' | 'not-found';
  note?: string;
}

/** Compact session summary (returned by list_sessions). */
export interface SessionListItem {
  id: string;
  name: string;
  labels: string[];
  status: string;
  createdAt: number;
}

/** Options for list_sessions filtering and pagination. */
export interface ListSessionsOptions {
  status?: string;
  label?: string;
  search?: string;
  sortBy?: 'recent' | 'name' | 'status';
  limit?: number;
  offset?: number;
}

/** Paginated result from list_sessions. */
export interface ListSessionsResult {
  total: number;
  returned: number;
  sessions: SessionListItem[];
}

// ============================================================
// MCP Validation Types
// ============================================================

/**
 * Config for stdio MCP connection validation
 */
export interface StdioMcpConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Config for HTTP/SSE MCP connection validation.
 * Derived from McpSourceConfig to stay in sync automatically (DRY).
 *
 * `accessToken` is the resolved OAuth / bearer token for sources whose
 * credential lives in the credential store (no `headerNames`). The probe
 * forwards it to the underlying impl, which builds an
 * `Authorization: Bearer …` header — matching the runtime path.
 */
export type HttpMcpConfig = Required<Pick<McpSourceConfig, 'url'>>
  & Pick<McpSourceConfig, 'authType' | 'headers' | 'headerNames' | 'transport'>
  & { accessToken?: string };

/**
 * Result from stdio MCP validation
 */
export interface StdioValidationResult {
  success: boolean;
  error?: string;
  toolCount?: number;
  toolNames?: string[];
  serverName?: string;
  serverVersion?: string;
  /** F1.665 — tools the server listed that the host skips, as one line; a warning, never a failure. */
  warning?: string;
}

/**
 * Result from HTTP MCP validation
 */
export interface McpValidationResult {
  success: boolean;
  error?: string;
  needsAuth?: boolean;
  toolCount?: number;
  toolNames?: string[];
  /** F1.665 — tools the server listed that the host skips, as one line; a warning, never a failure. */
  warning?: string;
  serverName?: string;
  serverVersion?: string;
}

/**
 * Result from API source test
 */
export interface ApiTestResult {
  success: boolean;
  status?: number;
  error?: string;
  hint?: string;
}

// ============================================================
// Context Factory Helpers
// ============================================================

/**
 * Create a basic file system implementation using Node.js fs.
 */
export function createNodeFileSystem(): FileSystemInterface {
  // Dynamic import to work in both environments
  const fs = require('node:fs');

  return {
    exists: (path: string) => fs.existsSync(path),
    readFile: (path: string) => fs.readFileSync(path, 'utf-8'),
    readFileBuffer: (path: string) => fs.readFileSync(path),
    writeFile: (path: string, content: string) => fs.writeFileSync(path, content, 'utf-8'),
    isDirectory: (path: string) => fs.existsSync(path) && fs.statSync(path).isDirectory(),
    readdir: (path: string) => fs.readdirSync(path),
    stat: (path: string) => {
      const stats = fs.statSync(path);
      return {
        size: stats.size,
        isDirectory: () => stats.isDirectory(),
      };
    },
  };
}

/**
 * One review target, already parsed from the tool arguments.
 *
 * The five keys are the ones `normalizeReviewTarget` reads in the shared
 * module; they are passed through verbatim rather than pre-normalized here,
 * because normalizing them in two places is how the two spellings drift. The
 * host implementation is the single normalizer.
 */
export interface SessionReviewDiffRequest {
  /** Branch or base ref; the diff is taken from its merge-base with HEAD. */
  base?: string;
  /** A single commit to review. */
  commit?: string;
  /** A literal ref range such as `main...my-feature`. */
  range?: string;
  /** File paths to review, diffed against HEAD. */
  paths?: string[];
  /** Which diff to take when no target is given: `upstream` (default) or `uncommitted`. */
  scope?: string;
  /** Extra guidance to carry into the reviewer's task. */
  instructions?: string;
  /**
   * C4.13 — run the review OFF this conversation's thread when the runtime has
   * its own mechanism for it. Only codex reads it today, at
   * `HOST_CALLBACK_BRIDGE_ROUTES.reviewDiff`, where it becomes a `review/start`
   * with `delivery: "detached"`; Pi backgrounds its review already and claude's
   * SDK backgrounds its own subagents, so on those two it is inert by
   * construction rather than refused.
   */
  background?: boolean;
}

/** What the host computed for one review target. */
export interface SessionReviewDiffAnswer {
  /** Plain-English description of what was diffed, for the model's own report. */
  target: string;
  /** The capped unified diff. Empty when the target has no changes. */
  diff: string;
  /**
   * The task text to hand the reviewer subagent — the diff plus what it is,
   * and nothing about the conversation that asked for it.
   */
  task: string;
  /**
   * The adversarial rubric the reviewer must follow. Supplied per call by the
   * host so this package holds no copy of it, and so the bundled `reviewer`
   * definition can stay a general-purpose reviewer.
   */
  rubric: string;
  /** Which agent definition to delegate to (the bundled read-only reviewer). */
  reviewerAgent: string;
  /**
   * C4.13 — present only when a detached review ALREADY STARTED: the sentence
   * to hand the user. It replaces the delegate-this instruction rather than
   * riding beside it, because a review that is already running must not be
   * delegated a second time.
   */
  backgroundReview?: string;
}

/** Host port backing the `ReviewDiff` session tool. */
export interface SessionReviewDiffPort {
  compute(request: SessionReviewDiffRequest): Promise<SessionReviewDiffAnswer>;
}

// ============================================================
// UA1.18 — publish_artifact / list_artifacts (appended: declaration merging keeps every cited line of this file)
// ============================================================

/**
 * UA1.18 — one `publish_artifact` call, as the handler hands it to the host closure (camelCase of the tool's
 * snake_case input). The host closure (`SessionManager.publishArtifactForAgent`) is the AUTHORITY for every rule —
 * the unattended refusal, the 1..30 retention range, the update target being in this workspace's registry, the
 * publish guard and the card — on all three runtimes: Pi and Claude reach it in process through the session-scoped
 * registry, codex over `HOST_CALLBACK_BRIDGE_ROUTES.artifactPublish`. The handler carries no approval logic, as
 * `archive_session`'s does not (P6.466).
 */
export interface PublishArtifactInput {
  filePath: string;
  title?: string;
  description?: string;
  emoji?: string;
  /** The link of a page this workspace published before: an UPDATE of that page. Absent = a new page. */
  url?: string;
  /** As the model sent it; validated (1..30) by the host. Absent = 7 on a create, unchanged expiry on an update. */
  retentionDays?: number;
}

/**
 * UA1.18 — the outcome of one `publish_artifact` call.
 *
 * - `published` / `updated` — the service answered; `url` and `expiresAt` (ISO, `null` = never) are set.
 * - `denied` — the person declined the card, or it timed out or was cancelled (nothing was sent).
 * - `refused` — the host refused before any card (unattended, the guard, the retention range, an unknown target,
 *   a card already pending) or after it (the file changed twice); nothing was sent.
 * - `failed` — the person approved and the service call failed (`needs-login`, `network`, …); `note` names the kind.
 *
 * `note` is what the caller's model reads: a sentence it can act on, never file content, never a token.
 */
export interface PublishArtifactVerdict {
  status: 'published' | 'updated' | 'denied' | 'refused' | 'failed';
  note: string;
  url?: string;
  expiresAt?: string | null;
}

/** UA1.18 — one row of `list_artifacts`: an artifact the CALLING session published (its registry entry). */
export interface SessionArtifactSummary {
  id: string;
  title: string;
  url: string;
  /** ISO timestamp, or `null` when the artifact never expires. */
  expiresAt: string | null;
}

export interface ListArtifactsResult {
  artifacts: SessionArtifactSummary[];
}

export interface SessionToolContext {
  /**
   * UA1.18 — `publish_artifact`'s host closure. It raises the confirmation card ITSELF (a one-shot `host_gate`
   * card with `noAlwaysAllow`, in every permission mode, `bypassPermissions` included), for `archiveSession`'s
   * measured reason: for a session MCP tool neither `INTERACTION_ONLY_TOOLS` nor `findNonNegotiableFloors` is on
   * codex's answer path, and this closure is reached by all three runtimes.
   */
  publishArtifact?(input: PublishArtifactInput): Promise<PublishArtifactVerdict>;
  /** UA1.18 — `list_artifacts`' host closure: the calling session's own registry entries, nothing else. */
  listArtifacts?(): ListArtifactsResult | Promise<ListArtifactsResult>;
}

// ============================================================
// UA3.5 — create_board_task (appended: declaration merging keeps every cited line of this file)
// ============================================================

/**
 * UA3.5 — one `create_board_task` call (v0.13.4 `CreateTaskInput`, Apache-2.0, renamed). Structured fields, mapped
 * onto a `TaskSpec` by the HOST closure (`server-core/src/tasks/create-board-task.ts`), which is the authority for
 * every restriction on the invoking agent: its own folder (`project-handle-required`), its project or one over that
 * folder (UA5.2), a subset of its enabled sources, its own connection, and no permission mode — on all three runtimes
 * (Pi and Claude in process, codex over `HOST_CALLBACK_BRIDGE_ROUTES.taskCreate`). Plain JSON: dependency-free of
 * `@nessy-agent/shared`.
 */
export interface CreateBoardTaskInput {
  /** Short task title shown on the board (also drives the slug). */
  title: string;
  /** What the task should accomplish — becomes the task goal and the prompt of its single `main` node. */
  description: string;
  /** Freeform rubric the final result is verified against. */
  acceptanceCriteria?: string;
  /** Source slugs enabled on the task's sessions; a subset of the caller's (all of them when omitted). */
  sources?: string[];
  /** Skill slugs applied to dispatched task prompts. */
  skills?: string[];
  /** LLM connection slug: only the caller's own (the default). */
  llmConnection?: string;
  /** Model id for the task's sessions. */
  model?: string;
  /** Working directory: only the caller's own folder (the default). */
  workingDirectory?: string;
  /** Project: only the caller's own (the default). */
  projectId?: string;
}

/** UA3.5 — the result of `create_board_task` (v0.13.4 `CreateTaskResult`). */
export interface CreateBoardTaskResult {
  slug: string;
  orchestratorSessionId: string;
  taskLabelId?: string;
  /** Fail-soft problems (unknown source or skill slugs, a label or sources failure, …). */
  warnings: string[];
}

/**
 * UB1.12 — one `project_memory_append` call (v0.15.1 `ProjectMemoryAppendInput`, Apache-2.0). Plain JSON:
 * dependency-free of `@nessy-agent/shared`.
 */
export interface ProjectMemoryAppendInput {
  /** Markdown note; the backend adds a dated heading naming the session. */
  note: string;
}

/** UB1.12 — the result of `project_memory_append` (v0.15.1 `ProjectMemoryAppendResult`). */
export interface ProjectMemoryAppendResult {
  path: string;
  heading: string;
  bytesAppended: number;
}

export interface SessionToolContext {
  /**
   * UA3.5 — `create_board_task`'s host closure: creates the task (yaml + orchestrator in "todo") without running it.
   * Undefined where no host closure is reachable (a codex spawn without the host-callback bridge never offers the
   * tool) — the handler degrades to "not available".
   */
  createBoardTask?(input: CreateBoardTaskInput): Promise<CreateBoardTaskResult>;

  /**
   * UB1.12 — `project_memory_append`'s host closure (v0.15.1 `appendProjectMemory`, bound by `SessionManager` as
   * `appendProjectMemoryFn`): appends the note under a dated heading naming the session, ONE `appendFileSync` and no
   * read-modify-write. Throws when the session has no project — the refusal the handler relays. Undefined where no
   * host closure is reachable (a codex spawn without the host-callback bridge never offers the tool).
   */
  appendProjectMemory?(input: ProjectMemoryAppendInput): Promise<ProjectMemoryAppendResult>;
}

// ============================================================
// UA6.3 — Pages (list_pages / get_page / create_page / update_page / write_page_data / delete_page)
// (appended: declaration merging keeps every cited line of this file)
// ============================================================
// Plain JSON shapes mirroring the page types of `@nessy-agent/shared/pages` — duplicated here on purpose so this
// package stays dependency-free (same rule as CreateBoardTaskInput). The backend
// (`server-core/src/pages/tool-callbacks.ts`) maps real PageConfig / LoadedPage onto these.
//
// Copied from craft-agents-oss `v0.13.4:packages/session-tools-core/src/context.ts` L352–L363 and L502–L647
// (Apache-2.0). Stated divergences:
// - UA8.2: v0.13.4 L508–L522, L536, L593, L604 (`PageToolRefreshSpec`, `refresh` on the summary, the create input
//   and the update patch) land REWRITTEN: the agent supplies the script's CONTENT (`PageToolRefreshInput`), the host
//   writes `pages/{slug}/refresh.ts`, and the summary echoes the stored spec (whose `script` is that host path); the
//   upstream script-path input is dropped under reason (b).
// - UA6.7: v0.13.4 L539–L540, L577–L578 (`shared`, `shareUrl` on the summary and the details) restored; the host reads
//   them from the artifact registry's live `'page'` row (published by the user's Share button; never from page.json).
// - `grants` on the details come from the host-approvals ledger (`listPageGrants`, UA9.2; wired UA9.3): MAC-verified,
//   content-digest-bound, expiring `page-grant` entries — never from page.json (reason (b)).

/**
 * Scheduled refresh as the agent supplies it (UA8.2): the script's CONTENT, never a path. Bun. The host writes it to
 * `pages/{slug}/refresh.ts`; it stays inert until the user approves its digest in the page view.
 */
export interface PageToolRefreshInput {
  /** 5-field cron expression evaluated once per minute (5-minute floor) */
  cron: string;
  /** Full source of the Bun refresh script */
  scriptContent: string;
  args?: string[];
  timezone?: string;
  timeoutMs?: number;
  enabled?: boolean;
}

/** The refresh spec as stored in page.json (`script` is the host-written path). */
export interface PageToolRefreshSpec {
  cron: string;
  script: string;
  args?: string[];
  timezone?: string;
  timeoutMs?: number;
  enabled?: boolean;
}

/** Compact page entry (returned by list_pages). */
export interface PageToolSummary {
  slug: string;
  name: string;
  description?: string;
  /** 'static' | 'interactive' | 'live' */
  kind: string;
  projectId?: string;
  createdAt: number;
  updatedAt: number;
  /** Whether index.html exists yet */
  hasContent: boolean;
  /** Scheduled refresh (UA8.2), as stored; it runs only once the user approved its script */
  refresh?: PageToolRefreshSpec;
  /** Outcome of the most recent data write (scheduled or agent write) */
  lastRefresh?: { at: number; ok: boolean; durationMs: number; error?: string };
  /** Whether the page is currently published (share link exists) */
  shared: boolean;
  /** Absolute path to the page folder (pages/{slug}/) */
  folderPath: string;
}

/** Summary of a page's data snapshot (kv keys + per-series stats, not full points). */
export interface PageToolDataSummary {
  generatedAt: number;
  kvKeys: string[];
  series: Array<{ name: string; points: number; latest?: { t: number; v: number } }>;
  /** Absolute path to data/snapshot.json — Read it for the full contents */
  snapshotPath: string;
}

/** Full page details (returned by get_page / create_page / update_page). */
export interface PageToolDetails extends PageToolSummary {
  id: string;
  /** sha256 hex of index.html (grants and render leases bind to it) */
  contentDigest?: string;
  /** Byte length of index.html when present */
  contentLength?: number;
  /** Absolute path to index.html */
  contentPath: string;
  /** Data snapshot summary, or null when no data has been written yet */
  data: PageToolDataSummary | null;
  /** Source-action grants, read by the backend from the host-approvals ledger (UA9.2/UA9.3) — never page.json. */
  grants: Array<{
    id: string;
    kind: string;
    sourceSlug?: string;
    script?: string;
    description?: string;
    expiresAt: number;
    stale: boolean;
  }>;
  /** Public share URL when published */
  shareUrl?: string;
  /** Full index.html content (only when requested with includeContent) */
  content?: string;
}

/** Input for create_page. */
export interface CreatePageToolInput {
  name: string;
  description?: string;
  /** 'static' | 'interactive' | 'live' (default: 'interactive') */
  kind?: string;
  /** Stable Project ID to bind the page to */
  projectId?: string;
  /** Full self-contained HTML document for index.html */
  content?: string;
  /** Scheduled refresh (UA8.2): script content, written by the host */
  refresh?: PageToolRefreshInput;
}

/** Patch for update_page — only provided fields change; null clears a field. */
export interface UpdatePageToolPatch {
  name?: string;
  description?: string | null;
  kind?: string;
  projectId?: string | null;
  /** Replaces index.html entirely (re-digests) */
  content?: string;
  /** Replaces the refresh (new script content needs a new approval); null removes it (UA8.2) */
  refresh?: PageToolRefreshInput | null;
}

/** Data mutation batch for write_page_data (applied in one transaction). */
export interface PageDataToolPatch {
  set?: Record<string, unknown>;
  delete?: string[];
  appendSeries?: Record<string, Array<{ t?: number; v: number }>>;
  pruneSeries?: Record<string, number>;
}

/** Result of write_page_data. */
export interface PageDataWriteSummary {
  slug: string;
  kvCount: number;
  seriesCount: number;
  generatedAt: number;
  snapshotPath: string;
  durationMs: number;
}

/** Result of delete_page. */
export interface DeletePageToolResult {
  deleted: true;
  /** True when the page was published and its public copy could not be confirmed removed (it may still be online). */
  publicCopyMayRemain: boolean;
}

/**
 * Pages tool callbacks, injected by the backend (SessionManager). All storage logic lives behind these — this package
 * never touches pages/ directly.
 */
export interface PagesToolCallbacks {
  listPages(): PageToolSummary[] | Promise<PageToolSummary[]>;
  getPage(slug: string, options?: { includeContent?: boolean }): PageToolDetails | null | Promise<PageToolDetails | null>;
  createPage(input: CreatePageToolInput): Promise<PageToolDetails>;
  updatePage(slug: string, patch: UpdatePageToolPatch): Promise<PageToolDetails>;
  writePageData(slug: string, patch: PageDataToolPatch): Promise<PageDataWriteSummary>;
  deletePage(slug: string): Promise<DeletePageToolResult>;
}

export interface SessionToolContext {
  /**
   * UA6.3 — Pages tool callbacks: workspace-scoped mini dashboards. Grouped in one object (unlike the flat
   * session-management callbacks) because the six operations always ship together. Bound by `SessionManager`
   * (`pagesToolCallbacksForAgent`) for every runtime: Pi and Claude resolve it in process through the session-scoped
   * registry, codex over the six `/page/*` host-callback routes. Undefined where no host closure is reachable (a
   * codex spawn without the host-callback bridge never offers the tools) — handlers degrade gracefully.
   */
  pages?: PagesToolCallbacks;
}

// ============================================================
// UB6.11 — Decision tool types (mirror @nessy-agent/shared/decisions — this
// package must stay free of that dependency, same rule as pages; upstream
// v0.15.1 `context.ts`, verbatim shapes).
// ============================================================

export type DecisionToolQuestionType = 'choice' | 'score' | 'noul';

/** A sentence, or a small structured object such as { question, focus }. */
export type DecisionToolInstructions = string | Record<string, unknown>;

/**
 * choice: option key → description (string, structured object, or null when self-explanatory).
 * score: ordered array of level descriptions, lowest first.
 * noul: optional { true, false } descriptions.
 */
export type DecisionToolCriteria =
  | Record<string, string | null | Record<string, unknown>>
  | Array<string | Record<string, unknown>>;

export interface DecisionToolQuestion {
  type: DecisionToolQuestionType;
  instructions: DecisionToolInstructions;
  criteria?: DecisionToolCriteria;
}

/** Text, a JSON object, or an array of text values. */
export type DecisionToolState = string | Record<string, unknown> | unknown[];

export interface DecisionToolRequest {
  state: DecisionToolState;
  questions: Record<string, DecisionToolQuestion>;
  /** Wall-clock budget for the call, in ms. */
  deadlineMs?: number;
  /** Caller context written to the decision record (redacted by key name). Never the state. */
  meta?: Record<string, unknown>;
}

export type DecisionToolAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number>; legend?: Record<string, unknown> }
  | { type: 'noul'; noul: number };

export interface DecisionToolUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Failure the agent may see. Never contains the API key or the state. */
export interface DecisionToolError {
  kind: string;
  message: string;
  status?: number;
}

export type DecisionToolResult =
  | { ok: true; model: string; answers: Record<string, DecisionToolAnswer>; usage: DecisionToolUsage; latencyMs: number; truncated: boolean }
  | { ok: false; error: DecisionToolError };

/**
 * Decision-layer callback, injected by the backend (SessionManager). Network,
 * validation, gating and recording all live behind it.
 */
export interface DecisionToolCallbacks {
  decide(request: DecisionToolRequest): Promise<DecisionToolResult>;
}

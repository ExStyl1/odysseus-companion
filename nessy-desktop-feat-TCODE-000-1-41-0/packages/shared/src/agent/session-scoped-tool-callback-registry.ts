/**
 * Session-Scoped Tool Callback Registry
 *
 * Extracted from session-scoped-tools.ts to break the dependency between
 * the callback registry (shared by Claude + Pi paths) and the Claude SDK
 * adapter layer (only used by ClaudeAgent).
 *
 * The registry is a simple Map keyed by sessionId. Each backend registers
 * callbacks when a session starts and merges additional callbacks (e.g.
 * browser pane functions) as they become available.
 */

import type { LLMQueryRequest, LLMQueryResult } from './llm-tool.ts';
import type { SpawnSessionFn } from './spawn-session-tool.ts';
import type { BrowserPaneFns } from './browser-tools.ts';
import type { AuthRequest } from '@nessy-agent/session-tools-core';
import { encodeSessionKey, type SessionKey } from '../sessions/session-key.ts';
import { debug } from '../utils/debug.ts';

/**
 * Callbacks that can be registered per-session
 */
export interface SessionScopedToolCallbacks {
  /**
   * Called when a plan is submitted via SubmitPlan tool.
   * Receives the path to the plan markdown file.
   */
  onPlanSubmitted?: (planPath: string) => void;

  /**
   * Called when authentication is requested via OAuth/credential tools.
   * The auth UI should be shown and execution paused.
   */
  onAuthRequest?: (request: AuthRequest) => void;

  /**
   * Agent-native LLM query callback for call_llm tool (OAuth path).
   * Each agent backend sets this to its own queryLlm implementation.
   */
  queryFn?: (request: LLMQueryRequest) => Promise<LLMQueryResult>;

  /**
   * P2.1 — the `advisor_consult` tool's callback. Each backend sets it to its
   * own `BaseAgent.executeAdvisorConsult`, which packages the transcript,
   * applies the settings and model gates, and rides `queryLlm`.
   *
   * Separate from `queryFn` on purpose: `queryFn` is a RAW completion the model
   * parameterises (`call_llm` chooses the model, the system prompt and the
   * schema), and routing the advisor through it would let a turn pick the
   * advising model itself — past both the entitlement gate and the managed
   * allowlist that `resolveAdvisorModel` exists to apply.
   */
  advisorConsultFn?: (args: Record<string, unknown>) => Promise<string>;

  /**
   * Callback for spawn_session tool — creates an independent session and sends initial prompt.
   * Each agent backend delegates to its onSpawnSession callback.
   */
  spawnSessionFn?: SpawnSessionFn;

  /**
   * Browser pane functions for browser_* tools.
   * Set by the Electron session manager — wraps BrowserPaneManager
   * with the session's bound browser instance.
   */
  browserPaneFns?: BrowserPaneFns;

  /** Set labels on a session (defaults to current). */
  setSessionLabelsFn?: (sessionId: string | undefined, labels: string[]) => void | Promise<void>;
  /** Set status on a session (defaults to current). */
  setSessionStatusFn?: (sessionId: string | undefined, status: string) => void | Promise<void>;
  /** Get detailed info about a session (defaults to current). */
  getSessionInfoFn?: (sessionId?: string) => import('@nessy-agent/session-tools-core').SessionInfo | null;
  /** List sessions in the workspace with pagination. */
  listSessionsFn?: (options?: import('@nessy-agent/session-tools-core').ListSessionsOptions) => import('@nessy-agent/session-tools-core').ListSessionsResult;
  /** Resolve label display names to IDs. */
  resolveLabelsFn?: (labels: string[]) => import('@nessy-agent/session-tools-core').ResolvedLabelsResult;
  /** Resolve a status display name to its ID. */
  resolveStatusFn?: (status: string) => import('@nessy-agent/session-tools-core').ResolvedStatusResult;
  /**
   * Send one piece of text to another session (inter-session messaging).
   *
   * Resolves to the RECEIVER's verdict, never `void`: the receiving side may
   * refuse, hold or drop the message, and `cross-session-messaging.md`
   * §Limitations requires the sender to be told which one did it.
   */
  sendAgentMessageFn?: (
    sessionId: string,
    message: string,
    // P6.465 (N6) — the one-shot idle subscription rides the same closure, so
    // the in-process path (pi, claude) carries it exactly as the codex bridge
    // route does. A registry that dropped it here would leave the subscription
    // working on codex alone, which is the divergence inverted.
    options?: import('@nessy-agent/session-tools-core').SendAgentMessageOptions,
  ) => Promise<import('@nessy-agent/session-tools-core').AgentMessageDeliveryVerdict>;

  /**
   * P6.466 — archive or unarchive one of the caller's own sessions.
   *
   * The closure raises the approval card itself. That is not where a permission
   * decision would normally live, and the reason is measured rather than
   * stylistic: for a session MCP tool neither `INTERACTION_ONLY_TOOLS` (inside
   * `runPreToolUseChecks`, zero call sites in `codex-agent.ts`) nor
   * `findNonNegotiableFloors` (reached on codex only through
   * `codexApprovalFloorSubjects`, whose subjects are `Bash` and `Write`) is on
   * codex's answer path. This registry slot is — in process for Pi and Claude,
   * over `HOST_CALLBACK_BRIDGE_ROUTES.sessionArchive` for codex — so the floor
   * is uniform by construction rather than by three separate edits.
   */
  archiveSessionFn?: (
    sessionId: string | undefined,
    archived: boolean,
  ) => Promise<import('@nessy-agent/session-tools-core').ArchiveSessionVerdict>;
  /** Dispatch a whitelisted slash command in the active backend session. */
  dispatchSlashCommandFn?: (command: string) => Promise<string | void> | string | void;
  /**
   * Activate a source in the running session (source_test auto-enable flow).
   * Wired by SessionManager to the per-session onSourceActivationRequest callback
   * plus a backend-aware readiness signal (Pi vs Claude).
   */
  activateSourceInSessionFn?: (sourceSlug: string) => Promise<{
    ok: boolean;
    reason?: string;
    availability?: 'immediate' | 'next-turn';
  }>;

  /**
   * Agent-driven plugin management (plugin_plan_install/plugin_install/
   * plugin_status/plugin_manage). Bound by SessionManager to a
   * `createPluginManagementTools()` instance backed by the server-owned
   * MarketplaceService/PluginManagementService deps. See
   * `agent/plugin-management-tools.ts`.
   */
  pluginManagementTools?: import('@nessy-agent/session-tools-core').PluginManagementToolsInterface;

  /**
   * Start/stop event-streaming watches for the `Monitor` tool. Bound by
   * SessionManager to the host `SessionMonitorService`, which owns the
   * ProcessSupervisor start, the registry entry and the idle-wake delivery —
   * none of which a backend can reach on its own.
   */
  monitorPort?: import('@nessy-agent/session-tools-core').SessionMonitorPort;

  /**
   * Create/list/remove scheduled prompts and re-arm the self-paced `/loop`
   * wakeup for `CronCreate` / `CronList` / `CronDelete` / `ScheduleWakeup`.
   * Bound by SessionManager to the session's own `SessionCronService`, which
   * owns the on-disk store, the once-a-second check and the between-turns
   * delivery gate — none of them reachable from a backend.
   *
   * T3 — this is the CLAUDE path's half of the port. Pi takes the identical
   * object through `BackendConfig.cronPort` (`pi-agent.ts` assigns it onto its
   * tool context directly); Claude builds its context in-process from this
   * registry, so without an entry here `ctx.cronPort` was `undefined` and the
   * four projected tools could only have answered "unavailable".
   *
   * Absent (or explicitly cleared) whenever the session has no cron service —
   * the runtime is outside `SCHEDULED_DELIVERY_RUNTIMES`, or `NESSY_DISABLE_CRON`
   * is set. Fail-closed by construction: the merge writes `undefined` rather
   * than skipping the key, so a session that leaves a scheduled runtime cannot
   * keep a stale port from the runtime it left.
   */
  cronPort?: import('@nessy-agent/session-tools-core').SessionCronPort;

  /**
   * Read/set/end the session's objective for `GoalGet` and `Goal`. Bound by
   * SessionManager to the session's own `GoalService`, which owns the persisted
   * record, the budgets, the settlement evaluator and the continuation that
   * dispatches the next turn — none of them reachable from a backend.
   *
   * P2.2 — this is the CLAUDE path's half of the port, exactly as `cronPort`
   * above is for scheduling. Pi takes the identical object through
   * `BackendConfig.goalPort`; Claude builds its context in-process from this
   * registry, so without an entry here `ctx.goalPort` was `undefined` and the
   * two projected tools could only have answered "unavailable".
   *
   * Absent (or explicitly cleared) whenever the session has no goal authority —
   * a runtime outside `SCHEDULED_DELIVERY_RUNTIMES`. Fail-closed by
   * construction: the merge writes `undefined` rather than skipping the key, so
   * a session that leaves such a runtime cannot keep a stale port from the
   * runtime it left.
   */
  goalPort?: import('@nessy-agent/session-tools-core').SessionGoalPort;

  /**
   * Create/enter/leave worktrees for the `EnterWorktree` and `ExitWorktree`
   * tools. Bound by SessionManager, which owns the `WorktreeLeaseService`, the
   * session's working-directory record and the resume path — a backend can
   * reach none of the three. Absent for a session with no repository, which is
   * what makes the tools report unavailability instead of guessing.
   */
  worktreePort?: import('@nessy-agent/session-tools-core').SessionWorktreePort;

  /**
   * P6.137 — the `EnterWorktree` approval floor, for the ONE route that reaches
   * `worktreePort` without having passed a pre-tool gate.
   *
   * A SEPARATE slot rather than a floor folded into `worktreePort`, and the
   * separation is load-bearing in both directions. Folding it in would gate the
   * Pi and claude in-process paths a SECOND time — both resolve `ctx.worktree`
   * from the slot above and both already ran `evaluateWorktreeApproval` inside
   * `runPreToolUseChecks`, and a second gate that can disagree with the first is
   * exactly what `authorizeMonitor` is written to avoid. Leaving it out entirely
   * would ship the working-directory move to codex with nothing guarding it:
   * `runPreToolUseChecks` has zero call sites in `codex-agent.ts`.
   *
   * Bound by SessionManager, which owns the permission card and the resolver
   * map. The bridge route REQUIRES it — an unbound authority refuses the enter
   * rather than performing it, so the tool and its floor cannot come apart.
   *
   * Throws to refuse: a refusal string from the floor (the scoped forms, which
   * offer no approval at all) or a denied card.
   */
  worktreeEnterAuthority?: (input: { path?: string }) => Promise<void>;

  /**
   * P3.276 — compute the review diff, the reviewer's task and the rubric for
   * the `ReviewDiff` tool. Bound by SessionManager, which owns the session's
   * working directory; `session-tools-core` holds no copy of the rubric and no
   * `git`, because `shared` depends on it and the arrow points one way.
   *
   * Absent for a session with no repository, which is what makes the tool
   * report unavailability instead of diffing somewhere arbitrary — and the same
   * absence is what `SessionToolFilterOptions.reviewDiffPort` reads, so the
   * tool is never OFFERED on a session that could not serve it.
   */
  reviewDiff?: import('@nessy-agent/session-tools-core').SessionReviewDiffPort;

  /**
   * P6.148 — this session's own hosted web search is WITHHELD, so the host may
   * offer its `web_search` tool in its place.
   *
   * A boolean rather than a port, because the tool needs none: the engine is
   * `@nessy-agent/shared/tools`' key-free DuckDuckGo module and the handler runs
   * in-process. What it needs is PERMISSION to be advertised, and that is a
   * per-session fact only the backend knows — `resolveClaudeHostedWebSearchWithheld`
   * reads the target model's wire, and a connection stamped
   * `wire: 'anthropic-messages'` keeps the native `WebSearch` instead.
   *
   * Absent or `false` means the tool is not built for this session, so a caller
   * that has not thought about it cannot accidentally show a model two search
   * tools. Mirrors `SessionToolFilterOptions.hostWebSearch`, which gates the
   * same tool on the surfaces that DO run `isOfferedByHostPorts`.
   */
  hostWebSearchOffered?: boolean;

  /**
   * P6.184 — raise an OS notification for this session, for the model-facing
   * `PushNotification` tool.
   *
   * Written for EVERY runtime rather than under `provider === 'pi'`, which is
   * the whole row: the port was never Pi-shaped — it closes over
   * `sessionRuntimeHooks.deliverDesktopNotification`, which takes a workspace id
   * and a session id, reads the user's notification setting and asks whether
   * that workspace's window has focus — and only the binding SITE was gated,
   * exactly as the cron four and the goal pair were before T1 and P2.2 moved
   * theirs.
   *
   * Binding it here does NOT advertise the tool. Claude's in-process surface
   * still withholds `PushNotification` (it ships its own, and two notification
   * tools in one pool is `Monitor`'s recorded defect); only a bridged codex
   * subprocess is offered it, through
   * `SessionToolFilterOptions.notificationPort` ANDed with the bridge. So this
   * slot is read today by `HOST_CALLBACK_BRIDGE_ROUTES.notificationPush` alone,
   * and it is written unconditionally so a runtime switch cannot leave a session
   * holding the port from the runtime it left.
   */
  notificationPort?: import('@nessy-agent/session-tools-core').SessionNotificationPort;

  /**
   * Read discovered MCP resources for the `list_mcp_resources` /
   * `read_mcp_resource` tools. Bound by SessionManager to the session's MCP pool
   * + leaser. Absent for a session with no pool, which makes the tools report
   * unavailability instead of guessing.
   */
  mcpResourcesPort?: import('@nessy-agent/session-tools-core').SessionMcpResourcesPort;

  /**
   * UB7.11 — list and render the prompts the session's enabled, connected MCP
   * sources publish, for the `source_list_prompts` / `source_get_prompt` tools
   * (upstream v0.15.1). Bound by SessionManager from the session's MCP pool;
   * pool and enabled sources are read at call time, so a source enabled
   * mid-session is reachable on the next call without a re-bind.
   */
  mcpSources?: import('@nessy-agent/session-tools-core').McpSourceToolCallbacks;

  /**
   * UB6.11 — the decision port (`ctx.decide`, upstream v0.15.1) behind the
   * `decide` tool: resolves a client from settings + credentials per call
   * (cached briefly) and records every judgment. Bound by SessionManager ONLY
   * when the decision layer is configured — the fact
   * `SessionToolFilterOptions.decidePort` reads — so the tool is offered and
   * servable together, on every runtime, the codex bridge included.
   */
  decide?: import('@nessy-agent/session-tools-core').DecisionToolCallbacks;

  /**
   * Resolve a plugin-owned MCP server the model may authenticate through
   * `source_oauth_trigger` (capability path). Bound by the AGENT rather than
   * SessionManager, because the only honest answer to "does this server exist
   * and is it enabled" is the agent's pinned capability turn view, which
   * nothing else can see. Absent until a backend publishes it — the trigger
   * then refuses the plugin target instead of fabricating a flow.
   */
  resolvePluginMcpServerFn?: NonNullable<
    import('@nessy-agent/session-tools-core').SessionToolContext['resolvePluginMcpServer']
  >;

  /**
   * Dereference a `skill-resource:` handle for the `read_skill_resource` tool.
   * Bound by the AGENT rather than SessionManager, because the pinned
   * skill-invocation snapshot the bytes are served from lives on the agent
   * (`BaseAgent.activeSkillInvocations`) and nothing else can see it.
   */
  skillResourcesPort?: import('@nessy-agent/session-tools-core').SessionSkillResourcesPort;

  /**
   * Remove a source the way the Sources DELETE channel does, for
   * `source_manage: remove` (D3). Bound by SESSIONMANAGER, not the agent: two
   * of the three cleanup ops (the workspace default list, the capability-change
   * notification) need host handles no agent has.
   */
  removeSourceFn?: (sourceSlug: string) => Promise<void>;

  /**
   * F1.709 — the permissions context this session's own pre-tool gate evaluates
   * against (`runPreToolUseChecks`: the pinned capability context, else the
   * live workspace plus the active sources). Bound by the CLAUDE agent, whose
   * `PermissionManager` holds the pin; read on every call by the claude
   * `call_llm` attachment floor (`session-scoped-tools.ts`), so a `deniedPaths`
   * entry that lives only in a pinned or managed layer refuses an attachment
   * exactly as it refuses `Read`. Pi's host route reads its own agent's context
   * directly (`BaseAgent.preExecuteCallLlm`). Absent → the floor falls back to
   * the live workspace context, which is what it read before this slot.
   */
  gatePermissionsContextFn?: () => import('./permissions-config.ts').PermissionsContext | null | undefined;

  /**
   * UA1.18 — `publish_artifact`'s host closure (`SessionManager.publishArtifactForAgent`), bound for every runtime:
   * Pi and Claude resolve it in process, codex over `HOST_CALLBACK_BRIDGE_ROUTES.artifactPublish`. It raises the
   * confirmation card itself, for `archiveSessionFn`'s measured reason, so the card is uniform by construction.
   */
  publishArtifactFn?: (
    input: import('@nessy-agent/session-tools-core').PublishArtifactInput,
  ) => Promise<import('@nessy-agent/session-tools-core').PublishArtifactVerdict>;
  /** UA1.18 — `list_artifacts`' host closure: the calling session's own registry rows. */
  listArtifactsFn?: () =>
    | import('@nessy-agent/session-tools-core').ListArtifactsResult
    | Promise<import('@nessy-agent/session-tools-core').ListArtifactsResult>;

  /**
   * UA3.5 — `create_board_task`'s host closure (`createBoardTaskForCaller`, bound by `SessionManager` for every
   * runtime): Pi and Claude resolve it in process, codex over `HOST_CALLBACK_BRIDGE_ROUTES.taskCreate`. It holds every
   * restriction on the caller, so the tool is uniform by construction.
   */
  createBoardTaskFn?: (
    input: import('@nessy-agent/session-tools-core').CreateBoardTaskInput,
  ) => Promise<import('@nessy-agent/session-tools-core').CreateBoardTaskResult>;

  /**
   * UB1.12 — `project_memory_append`'s host closure (v0.15.1 upstream field `appendProjectMemory`, bound by
   * `SessionManager` for every runtime): Pi and Claude resolve it in process, codex over
   * `HOST_CALLBACK_BRIDGE_ROUTES.projectMemoryAppend`. It holds the project read (refusing a session with no bound
   * project), the dated heading naming the session, and the ONE `appendFileSync` write — so the tool is uniform by
   * construction.
   */
  appendProjectMemoryFn?: (
    input: import('@nessy-agent/session-tools-core').ProjectMemoryAppendInput,
  ) => Promise<import('@nessy-agent/session-tools-core').ProjectMemoryAppendResult>;

  /**
   * UA6.3 — the six page tools' grouped host closure (v0.13.4 registry field `pages`, Apache-2.0), bound by
   * `SessionManager.pagesToolCallbacksForAgent` for every runtime: Pi and Claude resolve it in process, codex over the
   * six `/page/*` host-callback routes. Bound to the caller's workspace; `delete_page`'s one-shot card lives inside.
   */
  pages?: import('@nessy-agent/session-tools-core').PagesToolCallbacks;

  /**
   * F1.757 — the model ids the session's OWN connection serves, read per call by `call_llm` (`createLLMTool`): a named
   * id in this list goes to the backend as written instead of being checked against the Claude registry. Claude sets
   * it on a `claude-runtime` card only (an OpenAI-compatible catalogue the registry cannot know); absent or empty, the
   * registry check and its "Unknown model" list stand.
   */
  connectionModelIds?: () => readonly string[];
}

// Registry of callbacks keyed by the composite {workspaceId, sessionId} so two
// workspaces reusing the same bare sessionId never share callbacks.
const sessionScopedToolCallbackRegistry = new Map<string, SessionScopedToolCallbacks>();

/**
 * Register callbacks for a specific session
 */
export function registerSessionScopedToolCallbacks(
  key: SessionKey,
  callbacks: SessionScopedToolCallbacks
): void {
  sessionScopedToolCallbackRegistry.set(encodeSessionKey(key), callbacks);
  debug('session-scoped-tools', `Registered callbacks for session ${key.sessionId}`);
}

/**
 * Merge additional callbacks into an existing session's callback set.
 * Used by the Electron session manager to add browser pane functions
 * after the agent has already registered its core callbacks.
 */
export function mergeSessionScopedToolCallbacks(
  key: SessionKey,
  callbacks: Partial<SessionScopedToolCallbacks>
): void {
  const mapKey = encodeSessionKey(key);
  const existing = sessionScopedToolCallbackRegistry.get(mapKey) ?? {};
  sessionScopedToolCallbackRegistry.set(mapKey, { ...existing, ...callbacks });
  debug('session-scoped-tools', `Merged callbacks for session ${key.sessionId}`);
}

/**
 * Unregister callbacks for a session
 */
export function unregisterSessionScopedToolCallbacks(key: SessionKey): void {
  sessionScopedToolCallbackRegistry.delete(encodeSessionKey(key));
  debug('session-scoped-tools', `Unregistered callbacks for session ${key.sessionId}`);
}

/**
 * Get callbacks for a session
 */
export function getSessionScopedToolCallbacks(key: SessionKey): SessionScopedToolCallbacks | undefined {
  return sessionScopedToolCallbackRegistry.get(encodeSessionKey(key));
}

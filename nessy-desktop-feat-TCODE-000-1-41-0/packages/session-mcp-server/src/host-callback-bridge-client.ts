/**
 * T5 — the subprocess half of the codex host-callback bridge.
 *
 * Builds the two host ports the five scheduling/watching tools resolve off the
 * tool context (`ctx.cronPort`, `ctx.monitor`) as loopback HTTP calls to the
 * bridge the host started for THIS session. The registry handlers are then
 * untouched: `handleCronCreate` validates the expression, calls
 * `cronPort.create` and formats the reply exactly as it does on Pi and Claude,
 * so the three runtimes cannot answer differently.
 *
 * Errors are THROWN, never swallowed into a fake success: every one of those
 * handlers already wraps a thrown port error into its own `"<Tool> failed: …"`
 * result, which is how T2's Monitor refusal ("denied by rule … ") reaches the
 * model with the rule intact.
 *
 * The wire shape mirrors the `call_llm` fallback this subprocess has always
 * had — POST, JSON body, JSON reply — with one addition the contract file
 * explains: the spawn-time session id rides every request and the host rejects
 * a mismatch before touching a port.
 */
import {
  HOST_CALLBACK_BRIDGE_GOAL_ACTIONS,
  HOST_CALLBACK_BRIDGE_ROUTES,
  type AgentMessageDeliveryVerdict,
  type SendAgentMessageOptions,
  type ArchiveSessionVerdict,
  type HostCallbackBridgeResponse,
  type ListSessionsOptions,
  type ListSessionsResult,
  type SessionCronPort,
  type SessionGoalPort,
  type SessionInfo,
  type SessionMonitorPort,
  type DesktopNotificationResult,
  type SessionNotificationPort,
  type SessionReviewDiffAnswer,
  type SessionReviewDiffPort,
  type SessionWorktreePort,
  type WorktreeBatchOutcome,
  type WorktreeExitResult,
  type WorktreeLeaseSummary,
  type WorktreeLocation,
} from '@nessy-agent/session-tools-core';

/**
 * A scheduling call is a local map/disk write; a Monitor start spawns a
 * supervised process and may wait on a permission card the user has to answer.
 * The same 120s ceiling the callback-dependent tools already use.
 */
const BRIDGE_TIMEOUT_MS = 120000;

export interface HostCallbackBridgeClientConfig {
  /** The bridge port, from `--host-callback-port`. */
  port: string;
  /** The id this subprocess was spawned with (`--session-id`). */
  sessionId: string;
}

async function call<T>(
  config: HostCallbackBridgeClientConfig,
  route: string,
  payload?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${config.port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: config.sessionId,
        ...(payload === undefined ? {} : { payload }), ...bridgeCallOriginField(), // F1.493 (2) — which codex tool call (and thread) this request runs for
      }),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
  } catch (error) {
    // A transport failure is named as one. The alternative — reporting it as
    // the tool's own failure — sends the model looking for a bad cron
    // expression when the host is simply gone.
    throw new Error(
      `host callback bridge unreachable (${route}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let body: HostCallbackBridgeResponse<T>;
  try {
    body = (await response.json()) as HostCallbackBridgeResponse<T>;
  } catch (error) {
    throw new Error(
      `host callback bridge returned a non-JSON reply (${route}, HTTP ${response.status}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // The host answers a refusal with `error` on any status — including the
  // session-id mismatch, which is an authorization failure and carries 403.
  if (typeof body.error === 'string') throw new Error(body.error);
  if (!response.ok) {
    throw new Error(`host callback bridge failed (${route}): HTTP ${response.status}`);
  }
  return body.result as T;
}

/** `CronCreate` / `CronList` / `CronDelete` / `CronControl` / `ScheduleWakeup` over the bridge. */
export function createBridgeCronPort(config: HostCallbackBridgeClientConfig): SessionCronPort {
  return {
    create: input => call(config, HOST_CALLBACK_BRIDGE_ROUTES.cronCreate, input),
    list: () => call(config, HOST_CALLBACK_BRIDGE_ROUTES.cronList),
    remove: id => call(config, HOST_CALLBACK_BRIDGE_ROUTES.cronRemove, { id }),
    // Both members are declared OPTIONAL on the port so a host with no wakeup
    // slot can omit them; the bridge has both routes, so they are present here
    // and a host that cannot serve them answers with the port's own error.
    rearmWakeup: input => call(config, HOST_CALLBACK_BRIDGE_ROUTES.cronRearmWakeup, input),
    stopWakeup: () => call(config, HOST_CALLBACK_BRIDGE_ROUTES.cronStopWakeup),
    // P6.295 arm (2) — the three control members. Forwarded here for the same
    // reason the wakeup pair is: the bridge has all three routes, so leaving
    // them out would give a bridged codex/claude subprocess a port NARROWER
    // than the in-process Pi one, and `CronControl` would answer "unavailable
    // for this backend" on a host that can serve it.
    setPaused: (id, paused) => call(config, HOST_CALLBACK_BRIDGE_ROUTES.cronSetPaused, { id, paused }),
    runNow: id => call(config, HOST_CALLBACK_BRIDGE_ROUTES.cronRunNow, { id }),
    acknowledgeRuns: id => call(config, HOST_CALLBACK_BRIDGE_ROUTES.cronAcknowledgeRuns, { id }),
  };
}

/**
 * `Monitor` over the bridge.
 *
 * `stop` is implemented because `SessionMonitorPort` requires it, not because a
 * tool on this surface calls it yet — `ProcessStop` stays off the codex surface
 * while its background-shell half has no host binding.
 */
export function createBridgeMonitorPort(config: HostCallbackBridgeClientConfig): SessionMonitorPort {
  return {
    start: input => call(config, HOST_CALLBACK_BRIDGE_ROUTES.monitorStart, input),
    stop: taskId => call(config, HOST_CALLBACK_BRIDGE_ROUTES.monitorStop, { taskId }),
  };
}

/**
 * P2.2 — `Goal` / `GoalGet` over the bridge.
 *
 * The port has one method, so the ACTION picks the route:
 * `HOST_CALLBACK_BRIDGE_GOAL_ACTIONS` is the same table the host narrows with,
 * imported rather than restated, so a client can never send an action to a
 * route that will refuse it.
 *
 * An action neither table names — including a missing one — is sent to
 * `goal/set` deliberately, NOT rejected here: the host parses every payload
 * through the tool's own `GoalSchema` and answers with the reason, and a second
 * validation on this side is a second place for the two to disagree. What this
 * function decides is routing, nothing else.
 */
export function createBridgeGoalPort(config: HostCallbackBridgeClientConfig): SessionGoalPort {
  return {
    execute: args => {
      const action = (args as { action?: unknown })?.action;
      if (action === 'get') return call(config, HOST_CALLBACK_BRIDGE_ROUTES.goalGet);
      const route = HOST_CALLBACK_BRIDGE_GOAL_ACTIONS.clear.includes(action as never)
        ? HOST_CALLBACK_BRIDGE_ROUTES.goalClear
        : HOST_CALLBACK_BRIDGE_ROUTES.goalSet;
      return call(config, route, args);
    },
  };
}

/**
 * P3.13 — `advisor_consult` over the bridge.
 *
 * Returns the RENDERED reply, not a structured outcome: the host already turned
 * the consult (or its refusal) into the exact text pi and claude hand their
 * models, and re-deciding anything here would be a second place for the three
 * runtimes to diverge. The only thing this side can produce that the host
 * cannot is a TRANSPORT failure, which `call` throws and the dispatcher reports
 * as the tool failing — correctly, because a dead host is not advice.
 */
export function createBridgeAdvisorConsult(
  config: HostCallbackBridgeClientConfig,
): (args: Record<string, unknown>) => Promise<string> {
  return args => call<string>(config, HOST_CALLBACK_BRIDGE_ROUTES.advisorConsult, args ?? {});
}

/**
 * P6.45-adjacent — `send_agent_message` over the bridge.
 *
 * Returns the receiver's VERDICT, exactly as the in-process binding does, so the
 * codex handler formats a drop, hold or refusal into the same text pi and claude
 * produce. Reporting a dropped message as sent is the shape
 * `cross-session-messaging.md` calls out by name — "Before v2.1.236, Claude Code
 * reported those sends as sent while the receiving session dropped them" — and a
 * client that swallowed the verdict would reintroduce it on one runtime only.
 */
export function createBridgeSendAgentMessage(
  config: HostCallbackBridgeClientConfig,
): (sessionId: string, message: string, options?: SendAgentMessageOptions) => Promise<AgentMessageDeliveryVerdict> {
  // P6.465 (N6) — `notifyWhenIdle` crosses the bridge for the reason the VERDICT
  // does: a codex session that silently dropped it would subscribe to nothing
  // and wait, while pi and claude subscribed — one runtime quietly missing half
  // a capability, which is the exact divergence this route exists to prevent.
  return (sessionId, message, options) =>
    call<AgentMessageDeliveryVerdict>(config, HOST_CALLBACK_BRIDGE_ROUTES.agentMessageSend, {
      sessionId,
      message,
      ...(options?.notifyWhenIdle ? { notifyWhenIdle: true } : {}),
    });
}

/**
 * P3.222 — `list_sessions` and `get_session_info` over the bridge.
 *
 * The ROSTER half of the messaging pair. Both return a PROMISE where the Pi and
 * Claude in-process bindings return a value; `SessionToolContext` declares both
 * returns as `T | Promise<T>` for exactly this reason and every handler in
 * `session-tools-core` awaits, so no runtime sees a different shape.
 *
 * Errors are thrown, like every other route: a codex session whose host went
 * away must not be handed an EMPTY roster, which is indistinguishable from a
 * workspace with no peers and is the same "reported as success" shape
 * `createBridgeSendAgentMessage` exists to avoid.
 */
export function createBridgeListSessions(
  config: HostCallbackBridgeClientConfig,
): (options?: ListSessionsOptions) => Promise<ListSessionsResult> {
  return options =>
    call<ListSessionsResult>(config, HOST_CALLBACK_BRIDGE_ROUTES.sessionList, options ?? {});
}

export function createBridgeGetSessionInfo(
  config: HostCallbackBridgeClientConfig,
): (sessionId?: string) => Promise<SessionInfo | null> {
  return sessionId =>
    call<SessionInfo | null>(config, HOST_CALLBACK_BRIDGE_ROUTES.sessionInfo, { sessionId });
}

/**
 * P6.466 — `archive_session` over the bridge.
 *
 * Bound whenever the roster pair is, and for the stronger of the two reasons:
 * the tool is in `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK`, so a bridged codex
 * session is OFFERED it, and the approval card the verb must raise lives in the
 * host closure this route reaches. An unbound binding would advertise a verb
 * with no card behind it, not merely one that answers "not available".
 */
export function createBridgeArchiveSession(
  config: HostCallbackBridgeClientConfig,
): (sessionId: string | undefined, archived: boolean) => Promise<ArchiveSessionVerdict> {
  return (sessionId, archived) =>
    call<ArchiveSessionVerdict>(config, HOST_CALLBACK_BRIDGE_ROUTES.sessionArchive, { sessionId, archived });
}

/**
 * UA1.3 — `set_session_status` and `set_session_labels` over the bridge: one function per `SessionToolContext`
 * member, so the registry handlers run here unchanged and answer exactly as they do on Pi and Claude.
 *
 * The two RESOLVE functions return the workspace's own resolution (the status's category included), which is what
 * lets the handler refuse a closed status with UA1.2's sentence before anything is sent to the SET route. The SET
 * route's host closure re-checks both rules itself, so this side is the courtesy and the host is the authority.
 * Errors are thrown, like every other route: a status the host never wrote must not be reported as set.
 */
export function createBridgeResolveStatus(
  config: HostCallbackBridgeClientConfig,
): (status: string) => Promise<ResolvedStatusResult> {
  return status => call<ResolvedStatusResult>(config, HOST_CALLBACK_BRIDGE_ROUTES.sessionResolveStatus, { status });
}

export function createBridgeSetSessionStatus(
  config: HostCallbackBridgeClientConfig,
): (sessionId: string | undefined, status: string) => Promise<void> {
  return async (sessionId, status) => {
    await call<null>(config, HOST_CALLBACK_BRIDGE_ROUTES.sessionSetStatus, { sessionId, status });
  };
}

export function createBridgeResolveLabels(
  config: HostCallbackBridgeClientConfig,
): (labels: string[]) => Promise<ResolvedLabelsResult> {
  return labels => call<ResolvedLabelsResult>(config, HOST_CALLBACK_BRIDGE_ROUTES.sessionResolveLabels, { labels });
}

export function createBridgeSetSessionLabels(
  config: HostCallbackBridgeClientConfig,
): (sessionId: string | undefined, labels: string[]) => Promise<void> {
  return async (sessionId, labels) => {
    await call<null>(config, HOST_CALLBACK_BRIDGE_ROUTES.sessionSetLabels, { sessionId, labels });
  };
}

/**
 * P3.276 — `ReviewDiff` over the bridge.
 *
 * The tool is in `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK`, so a bridged codex
 * subprocess is offered it; without this binding every call would answer "not
 * available in this context", which is the shape P3.222 measured for the roster
 * pair and the reason both halves of a capability are bound together.
 *
 * Errors are thrown, like every other route. An empty diff is a real ANSWER
 * from the host (the target has no changes) and the handler renders it as one;
 * a transport failure must not be flattened into that same reply, or a session
 * whose host went away would report "nothing to review" and the reviewer would
 * be delegated an empty task.
 */
/**
 * P6.184 — `PushNotification` over the bridge.
 *
 * Bound whenever the bridge is, and for the strongest of the three reasons a
 * route on this file has: codex has no notification mechanism the model can
 * reach AT ALL (`push_notification`/`user_notification`/"desktop notification"
 * all score 0 on both shipped mac binaries, against `notification` 101/147 and
 * `thread/start` 5/5 as controls), so without this the tool is not "available
 * elsewhere" — it does not exist for this runtime.
 *
 * The host fills in which workspace and session the notification addresses, so
 * this client sends the model's text and nothing else. Errors are thrown, like
 * every other route: a notification the user never saw must not be reported as
 * delivered.
 */
export function createBridgeNotificationPort(
  config: HostCallbackBridgeClientConfig,
): SessionNotificationPort {
  return {
    notify: input =>
      call<DesktopNotificationResult>(config, HOST_CALLBACK_BRIDGE_ROUTES.notificationPush, input),
  };
}

export function createBridgeReviewDiff(
  config: HostCallbackBridgeClientConfig,
): SessionReviewDiffPort {
  return {
    compute: request =>
      call<SessionReviewDiffAnswer>(config, HOST_CALLBACK_BRIDGE_ROUTES.reviewDiff, request),
  };
}

/**
 * P6.137 — the worktree family over the bridge.
 *
 * Codex publishes NO worktree surface of its own (`worktree` 0 files in
 * `packages/codex-protocol`, `WorktreeCreate` 0 in the shipped
 * `codex-app-server`), so this is not a nicer version of something the runtime
 * has: it is the capability.
 *
 * The floor is on the HOST side of `worktree/enter`, deliberately and not out
 * of tidiness. A gate in this subprocess would be a gate the subprocess could
 * be restarted without, and the card it must raise belongs to `SessionManager`
 * anyway. So this client sends the model's request and lets the enter route
 * refuse it — a thrown refusal reaches the handler as a tool error carrying the
 * host's own sentence.
 *
 * `exit` resolves `null` when the session is not in a worktree, which the
 * handler reports as a successful no-op; the crossing preserves that, because
 * turning it into an error would let a tool the model is told it may always
 * call fail a turn.
 */
export function createBridgeWorktreePort(
  config: HostCallbackBridgeClientConfig,
): SessionWorktreePort {
  return {
    enter: input =>
      call<WorktreeLocation>(config, HOST_CALLBACK_BRIDGE_ROUTES.worktreeEnter, input),
    exit: input =>
      call<WorktreeExitResult | null>(config, HOST_CALLBACK_BRIDGE_ROUTES.worktreeExit, input ?? {}),
    list: () =>
      call<readonly WorktreeLeaseSummary[]>(config, HOST_CALLBACK_BRIDGE_ROUTES.worktreeList, {}),
    batch: input =>
      call<WorktreeBatchOutcome>(config, HOST_CALLBACK_BRIDGE_ROUTES.worktreeBatch, input),
  };
}

/**
 * F1.493 (2) — the `origin` member of a bridge request: the codex tool call the current async context runs for
 * (`bridge-call-origin.ts`, set by `index.ts`'s CallTool handler from the request's `_meta`), or nothing.
 * Appended so no cited line of this file moves; imports are hoisted.
 */
function bridgeCallOriginField(): { origin?: HostCallbackBridgeCallOrigin } {
  const origin = currentBridgeCallOrigin();
  return origin ? { origin } : {};
}
import { currentBridgeCallOrigin } from './bridge-call-origin.ts';
import type { DecisionToolCallbacks, DecisionToolResult, HostCallbackBridgeCallOrigin } from '@nessy-agent/session-tools-core';
import type { ResolvedLabelsResult, ResolvedStatusResult } from '@nessy-agent/session-tools-core'; // UA1.3 — appended for the reason the line above is

/**
 * UA1.18 — `publish_artifact` and `list_artifacts` over the bridge. Bound whenever the bridge is, for
 * `createBridgeArchiveSession`'s reason: both tools are in `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK`, so a bridged
 * codex session is OFFERED them, and the publish card lives in the host closure this reaches — an unbound binding
 * would advertise a publish with no card behind it.
 *
 * The publish call waits on a PERSON: the host closure resolves a card it left unanswered for
 * `PUBLISH_ARTIFACT_CARD_TIMEOUT_MS` (110 s) to a deny, inside this client's 120 s ceiling, so the model is always
 * told what happened rather than meeting "bridge unreachable".
 */
export function createBridgePublishArtifact(
  config: HostCallbackBridgeClientConfig,
): (input: PublishArtifactInput) => Promise<PublishArtifactVerdict> {
  return input => call<PublishArtifactVerdict>(config, HOST_CALLBACK_BRIDGE_ROUTES.artifactPublish, input);
}

export function createBridgeListArtifacts(
  config: HostCallbackBridgeClientConfig,
): () => Promise<ListArtifactsResult> {
  return () => call<ListArtifactsResult>(config, HOST_CALLBACK_BRIDGE_ROUTES.artifactList, {});
}
import type { ListArtifactsResult, PublishArtifactInput, PublishArtifactVerdict } from '@nessy-agent/session-tools-core'; // UA1.18 — appended, hoisted

/**
 * UA3.5 — `create_board_task` over the bridge. Bound whenever the bridge is, for `createBridgeArchiveSession`'s
 * reason: the tool is in `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK`, so a bridged codex session is OFFERED it, and every
 * restriction on the caller lives in the host closure this reaches — an unbound binding would advertise a tool that
 * answers "not available".
 */
export function createBridgeCreateBoardTask(
  config: HostCallbackBridgeClientConfig,
): (input: CreateBoardTaskInput) => Promise<CreateBoardTaskResult> {
  return input => call<CreateBoardTaskResult>(config, HOST_CALLBACK_BRIDGE_ROUTES.taskCreate, input);
}
import type { CreateBoardTaskInput, CreateBoardTaskResult } from '@nessy-agent/session-tools-core'; // UA3.5 — appended, hoisted

/**
 * UB1.12 — `project_memory_append` over the bridge (v0.15.1 upstream parity). Bound whenever the bridge is, for
 * `createBridgeCreateBoardTask`'s reason: the tool is in `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK`, so a bridged codex
 * session is OFFERED it, and the project read, the dated heading and the one O_APPEND write live in the host closure
 * this reaches — an unbound binding would advertise a tool that answers "not available".
 */
export function createBridgeAppendProjectMemory(
  config: HostCallbackBridgeClientConfig,
): (input: ProjectMemoryAppendInput) => Promise<ProjectMemoryAppendResult> {
  return input => call<ProjectMemoryAppendResult>(config, HOST_CALLBACK_BRIDGE_ROUTES.projectMemoryAppend, input);
}
import type { ProjectMemoryAppendInput, ProjectMemoryAppendResult } from '@nessy-agent/session-tools-core'; // UB1.12 — appended, hoisted

/**
 * UB7.11 — the MCP prompt pair over the bridge (upstream v0.15.1, OQ-B4-2 (c)
 * OWNER-CONFIRMED), as ONE grouped `McpSourceToolCallbacks` (upstream's
 * `ctx.mcpSources` shape), one route per member. Bound whenever the bridge is,
 * for `createBridgePages`' reason: both tools are in
 * `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK`, so a bridged codex session is
 * OFFERED them, and the enabled-source check, the pool reads, the rendering and
 * the large-result guard live in the host closure this reaches — an unbound
 * binding would advertise tools that answer "not available".
 */
export function createBridgeMcpSources(config: HostCallbackBridgeClientConfig): McpSourceToolCallbacks {
  return {
    listPrompts: sourceSlug =>
      call<McpSourcePromptList>(config, HOST_CALLBACK_BRIDGE_ROUTES.sourceListPrompts, { sourceSlug }),
    getPrompt: (sourceSlug, name, args) =>
      call<string>(config, HOST_CALLBACK_BRIDGE_ROUTES.sourceGetPrompt, { sourceSlug, name, ...(args ? { arguments: args } : {}) }),
  };
}

/**
 * UB6.11 — `decide` over the bridge (upstream v0.15.1; OQ-43.5 (a)). One
 * member, like the grouped ports. Bound whenever the bridge is, for
 * `createBridgeMcpSources`' reason — but the tool is OFFERED only on a spawn
 * whose host passed `--decide-port`, and the far side resolves the registry
 * slot per request, failing closed with the honest "not enabled" sentence when
 * the session's decision layer is off.
 */
export function createBridgeDecide(config: HostCallbackBridgeClientConfig): DecisionToolCallbacks {
  return {
    decide: request => call<DecisionToolResult>(config, HOST_CALLBACK_BRIDGE_ROUTES.decide, request as unknown as Record<string, unknown>),
  };
}import type { McpSourcePromptList, McpSourceToolCallbacks } from '@nessy-agent/session-tools-core'; // UB7.11 — appended, hoisted

/**
 * UA6.3 — the six page tools over the bridge, as ONE grouped `PagesToolCallbacks` (upstream's `ctx.pages` shape), one
 * route per member. Bound whenever the bridge is, for `createBridgeArchiveSession`'s reason: the six tools are in
 * `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK`, so a bridged codex session is OFFERED them, and the storage and
 * `delete_page`'s card live in the host closure this reaches — an unbound binding would advertise tools that answer
 * "not available".
 *
 * `deletePage` waits on a PERSON: the host closure resolves a card it left unanswered for `DELETE_PAGE_CARD_TIMEOUT_MS`
 * (110 s) to a deny, inside this client's 120 s ceiling, so the model is told "declined" rather than meeting "bridge
 * unreachable" (and a page is never deleted after the model was told the call failed).
 */
export function createBridgePages(config: HostCallbackBridgeClientConfig): PagesToolCallbacks {
  return {
    listPages: () => call<PageToolSummary[]>(config, HOST_CALLBACK_BRIDGE_ROUTES.pageList, {}),
    getPage: (slug, options) =>
      call<PageToolDetails | null>(config, HOST_CALLBACK_BRIDGE_ROUTES.pageGet, { slug, includeContent: options?.includeContent === true }),
    createPage: input => call<PageToolDetails>(config, HOST_CALLBACK_BRIDGE_ROUTES.pageCreate, input),
    updatePage: (slug, patch) => call<PageToolDetails>(config, HOST_CALLBACK_BRIDGE_ROUTES.pageUpdate, { slug, patch }),
    writePageData: (slug, patch) => call<PageDataWriteSummary>(config, HOST_CALLBACK_BRIDGE_ROUTES.pageWriteData, { slug, patch }),
    deletePage: slug => call<DeletePageToolResult>(config, HOST_CALLBACK_BRIDGE_ROUTES.pageDelete, { slug }),
  };
}
import type { DeletePageToolResult, PageDataWriteSummary, PagesToolCallbacks, PageToolDetails, PageToolSummary } from '@nessy-agent/session-tools-core'; // UA6.3 — appended, hoisted

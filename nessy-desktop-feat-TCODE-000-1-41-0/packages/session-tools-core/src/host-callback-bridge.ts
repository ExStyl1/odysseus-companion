/**
 * T5 — the wire contract of the codex host-callback bridge.
 *
 * `session-mcp-server` runs as an EXTERNAL subprocess: codex spawns it over
 * stdio, so the host ports `SessionManager` binds per session (`cronPort`,
 * `monitorPort`) are in another process entirely. Every other runtime resolves
 * them in-process — Pi through `BackendConfig`, Claude through the per-session
 * `SessionScopedToolCallbacks` registry — which is why the five scheduling and
 * watching tools were withheld from the codex surface until this bridge existed.
 *
 * The transport is the one the subprocess ALREADY speaks, not a second one:
 * loopback HTTP + a JSON body + a JSON reply, the shape `call_llm`'s fallback
 * has used since Task 5.5 (`index.ts` `handleCallLlm`, served until F1.710 by
 * `pi-agent-server`'s `/call-llm`). What is new is the route set and one rule
 * that channel never needed:
 *
 * **Every request carries the spawn-time session id and the host rejects a
 * mismatch.** The bridge is bound to ONE session's ports — the same rule
 * `monitorPort` states on itself ("the port is bound to THIS session's key, so
 * a monitor can only ever be started or stopped for its own owner"). A loopback
 * port is reachable by anything on the machine, so the id is checked before any
 * port is touched rather than trusted from the socket.
 *
 * The port name reaches the subprocess as `--host-callback-port`, deliberately
 * NOT the old `--callback-port` (removed, F1.1135): it then fell back to the ambient
 * `NESSY_LLM_CALLBACK_PORT`, whose server (Pi's) served `/call-llm` and nothing
 * else (both gone since F1.710). Reusing it would have made a codex subprocess
 * advertise five tools whose routes 404 on a server that never heard of them.
 */

/**
 * The routes, keyed by the port method they serve.
 *
 * This line said "the eleven routes" while the object held eleven; the count is
 * left out now rather than re-stated, because a number beside a
 * single-source-of-truth list is the drift this repo keeps paying for. Read the
 * object.
 *
 * Both ends import THIS object — the client builds its URLs from it and the
 * host registers its handlers from it — so a route can never be renamed on one
 * side only.
 *
 * P2.2 · the three `goal/*` routes are the one place this file's "keyed by the
 * port method" rule is bent, and deliberately. `SessionToolContext['goalPort']`
 * has a SINGLE method — `execute(args)` with the action inside the payload — so
 * one route would have carried every action through one whitelist. The split is
 * by EFFECT instead: `goal/get` reads, `goal/set` covers the actions that leave
 * a goal ACTIVE (`create`, `replace`, `resume`) and `goal/clear` the ones that
 * end it (`cancel`, `complete`, `blocked`). Each route then narrows to exactly
 * its own actions, so a payload that reached the wrong route is refused on the
 * belt rather than on the action union alone.
 */
export const HOST_CALLBACK_BRIDGE_ROUTES = {
  cronCreate: '/cron/create',
  cronList: '/cron/list',
  cronRemove: '/cron/remove',
  cronRearmWakeup: '/cron/rearmWakeup',
  cronStopWakeup: '/cron/stopWakeup',
  /**
   * P6.295 arm (2) — THREE routes for one tool, and the split is the file's own
   * "keyed by the port method" rule rather than an exception to it.
   * `CronControl` carries its action in the payload, but the PORT it reaches
   * has three separate methods (`setPaused`, `runNow`, `acknowledgeRuns`), so
   * one route per method keeps each route narrow to exactly the effect it
   * serves. The `goal/*` split below is the different case: that port has a
   * single method, which is why it had to be split by effect instead.
   */
  cronSetPaused: '/cron/setPaused',
  cronRunNow: '/cron/runNow',
  cronAcknowledgeRuns: '/cron/acknowledgeRuns',
  monitorStart: '/monitor/start',
  monitorStop: '/monitor/stop',
  goalGet: '/goal/get',
  goalSet: '/goal/set',
  goalClear: '/goal/clear',
  /**
   * P3.13 — the ONE route that does not serve a PORT.
   *
   * The other ten carry a `SessionToolContext` port the host bound for this
   * session. `advisor_consult` has no port: it is `executionMode: 'backend'`,
   * and its behaviour is `BaseAgent.executeAdvisorConsult` — the transcript
   * packaging, the `advisorEnabled` read, the entitlement and managed-allowlist
   * gates and the tool-less `queryLlm` request, all of which live on the AGENT.
   *
   * That does not make this route "a backend over the wire". Nothing about the
   * consult moves: it runs host-side, on the host's own agent, exactly as it
   * does for pi and claude. What crosses the boundary is a CALL and a rendered
   * reply — the same thing `cron/create` moves, with a method on the agent
   * standing where a port would.
   */
  advisorConsult: '/advisor/consult',
  /**
   * P3.276 — the THIRD route that carries no port in the `cronPort` sense: the
   * host computes the review diff with `@nessy-agent/shared`'s
   * `computeReviewDiffWithGit` and answers with the diff, the reviewer's task
   * and the rubric.
   *
   * It exists so the answer is the SAME on all three runtimes. Pi's own
   * `review` tool computes this diff and spawns the reviewer in one call; claude
   * and codex had neither half, so their delegated reviewer reviewed whatever
   * diff the model chose to run for itself.
   *
   * PAIRED with `SessionToolFilterOptions.reviewDiffPort`: the tool is offered
   * only when the host says it has bound the port, so registering this route and
   * advertising the tool cannot come apart the way the `--callback-port` reuse
   * warned about above.
   */
  reviewDiff: '/review/diff',
  /**
   * P6.45-adjacent — `send_agent_message`, the SECOND route that carries no
   * port, and the one whose absence was a runtime divergence rather than a
   * missing feature.
   *
   * Measured before this route existed: `list_sessions` and `get_session_info`
   * are not in `SESSION_TOOLS_REQUIRING_HOST_CALLBACK`, so a codex session could
   * ENUMERATE its peer sessions, while `send_agent_message` was in that set and
   * out of the bridged one, so the same session was told "not available under
   * Codex in this build" when it tried to write to one. Pi and claude reach the
   * host closure in-process. So switching a session to codex silently removed
   * half of a capability whose other half stayed advertised — a divergence a
   * switch cannot see, which is the class this fork keeps paying for.
   *
   * Like `advisor/consult`, the far side is a bound closure rather than a port:
   * `sendAgentMessageFn` is `SessionManager.bindSendAgentMessage(sender)`, which
   * has the SENDER baked in. That is what makes the route safe to expose — the
   * body chooses the target, never the author.
   */
  agentMessageSend: '/agent-message/send',
  /**
   * P3.222 — the ROSTER half of the messaging pair, and the residue
   * `6173c9778` left behind when it closed the write half.
   *
   * `cross-session-messaging.md` names the capability as two tools, not one:
   * "Claude uses two tools for this: `ListAgents` to discover which agents it
   * can reach, and `SendMessage` to deliver a message to one of them by name."
   * Ours are `list_sessions` and `send_agent_message`.
   *
   * MEASURED 2026-09-02, driven rather than grepped: `list_sessions` and
   * `get_session_info` were absent from `SESSION_TOOLS_REQUIRING_HOST_CALLBACK`,
   * so they survived the `externalStandaloneOnly` filter and were ADVERTISED on
   * both codex surfaces — 18 tools bare, 27 bridged. But `createCodexContext`
   * binds neither `listSessions` nor `getSessionInfo` (control on the same file:
   * `sendAgentMessage:` is bound, once), so calling either answered
   * `list_sessions is not available in this context.` — every time, bridge or no
   * bridge. So the row's own defect survived its fix with the halves swapped: a
   * codex session could write to a peer it had no way to enumerate, and the
   * roster tool it WAS offered was dead.
   *
   * Two routes rather than one because they are two ports on the host and the
   * subprocess binds them separately; both resolve fresh per request from the
   * per-session registry, for the reason the three ports do.
   */
  sessionList: '/session/list',
  sessionInfo: '/session/info',
  /**
   * P6.466 — the archive verb, and the route exists because of where its
   * approval had to go rather than because the verb is expensive.
   *
   * The row asks for a card in every permission mode including
   * `bypassPermissions`. Measured, neither of the two candidate carve-out seams
   * reaches codex for a session MCP tool: `INTERACTION_ONLY_TOOLS` lives inside
   * `runPreToolUseChecks`, which has zero call sites in `codex-agent.ts`, and
   * `findNonNegotiableFloors` is reached on codex only through
   * `codexApprovalFloorSubjects`, whose subjects are codex's own `command` /
   * `commandV1` / `fileChangeV1` approvals rendered as `Bash` and `Write`. So
   * the floor sits in the host closure — `SessionManager` raises a one-shot
   * `noAlwaysAllow` card through `directPermissionResolvers`, the same
   * mechanism `authorizeMonitor` uses for `monitorPort.start` and which
   * consults no permission mode at all — and this route is how a bridged codex
   * session reaches that closure instead of the verb.
   *
   * Like `agentMessageSend`, the far side is a closure with the CALLER already
   * bound, so the body chooses which session to archive and never who is
   * asking.
   */
  sessionArchive: '/session/archive',
  /**
   * UA1.3 — `set_session_status` and `set_session_labels`, the self-management pair a codex session was offered
   * nowhere: both sit in `SESSION_TOOLS_REQUIRING_HOST_CALLBACK`, so an external standalone subprocess was refused them
   * while Pi and Claude reached the same host closures in process.
   *
   * Native-first, step 1, measured 2026-10-02 on `packages/codex-protocol/generated/v2`: codex's `ThreadStatus` is
   * RUNTIME state (`notLoaded` / `idle` / `systemError` / `active`) and its `ThreadSection` is a sidebar section the
   * CLIENT manages (`threadSection/create|list|update|delete`, `thread/section/move` in `ClientRequest.ts`, tag
   * `rust-v0.159.3`); neither is a workflow status or a label, and the model has no tool for either.
   * So step 2: the host supplies the pair once, on the bridge every other bound closure rides.
   *
   * Two routes per tool, one per `SessionToolContext` member — the rule the cron routes follow. The RESOLVE route
   * answers the workspace's resolution (display name → id, the status's category), so the codex-side handler runs
   * the SAME code and answers with the SAME text as on Pi and Claude, the UA1.2 closure refusal included. The SET
   * route reaches the host closure, which is the authority: it refuses a closed status (UA1.2) and a target outside
   * the caller's workspace by itself, so a body that skipped the handler can do neither.
   */
  sessionResolveStatus: '/session/status/resolve',
  sessionSetStatus: '/session/status',
  sessionResolveLabels: '/session/labels/resolve',
  sessionSetLabels: '/session/labels',
  /**
   * P6.184 — `PushNotification`, and the one route added because the runtime on
   * the far side has NO mechanism of its own rather than because ours is
   * nicer.
   *
   * Measured on both shipped mac `codex-app-server` binaries: `push_notification`
   * 0, `user_notification` 0, "desktop notification" 0, against `notification`
   * 101/147 and `thread/start` 5/5 as the controls proving the binaries were
   * read. The only notification codex has is the operator-set `notify` /
   * `agent-turn-complete` PROGRAM hook, which the model cannot invoke and which
   * this fork deliberately never writes. So step 1 of native-first found
   * nothing and step 2 is this route.
   *
   * The port on the far side is not Pi-shaped and never was — P6.52 measured
   * that and this row acts on it. `ctx.notificationPort` closes over
   * `sessionRuntimeHooks.deliverDesktopNotification`, which takes a workspace id
   * and a session id, reads the user's notification setting and asks whether
   * THAT workspace's window has focus. Only the binding SITE was gated, exactly
   * as the cron four and the goal pair were before T1 and P2.2.
   *
   * The model supplies text only. Which workspace and session the notification
   * addresses is filled in on the host from the session the bridge is bound to,
   * so a body cannot aim the user's attention at somebody else's session — the
   * same property that makes `agentMessageSend` safe.
   */
  notificationPush: '/notification/push',
  /**
   * P6.137 — `EnterWorktree`, `ExitWorktree` and `WorktreeBatch`, the family
   * codex has no counterpart for AND no gate over.
   *
   * Native-first, step 1, measured: codex publishes NO worktree surface at all
   * — `worktree` 0 files in `packages/codex-protocol`, `preToolUse` 3 files as
   * the control, and `WorktreeCreate` 0 in the shipped `codex-app-server`
   * (P2.497's readings, re-run 2026-09-08). Step 2 is these routes: the port on
   * the far side is provider-free and `SessionManager` already binds it for
   * every runtime, so what was missing was the crossing and the floor, not the
   * capability.
   *
   * `worktreeEnter` is the only one of the four with an approval floor, and
   * the floor is REQUIRED rather than optional: `evaluateWorktreeApproval` runs
   * inside `runPreToolUseChecks`, which has zero call sites in
   * `codex-agent.ts`, so a bridged enter that skipped it would move the
   * session's working directory, write access and project config with nothing
   * having judged the target. The host binds
   * `worktreeEnterAuthority` beside the port and the route requires both.
   *
   * `worktreeExit`, `worktreeList` and `worktreeBatch` carry no floor because
   * the documented rule gives them none — `worktrees.md`: creation and paths
   * under the repository's worktree directory do not prompt, and
   * `tools-reference.md` marks `ExitWorktree` *Permission required: No*.
   * Measured against `runPreToolUseChecks` directly by P6.799:
   * `ENTER_WORKTREE_TOOLS` holds only the three `EnterWorktree` spellings, and
   * `ExitWorktree`/`WorktreeBatch` with no worktree context both measure
   * `allow`, beside `Read` as the control.
   */
  worktreeEnter: '/worktree/enter',
  worktreeExit: '/worktree/exit',
  worktreeList: '/worktree/list',
  worktreeBatch: '/worktree/batch',
  /**
   * UA1.18 — `publish_artifact` and `list_artifacts`, the t-artifacts pair (OQ-18, OQ-22).
   *
   * Native-first, step 1: codex has no publishing mechanism of its own for the company service — there is nothing
   * to enable — so step 2 is these routes, and the card codex meets is raised by the SAME host closure Pi and Claude
   * reach in process (`publishArtifactFn`), for `sessionArchive`'s measured reason: for a session MCP tool neither
   * `INTERACTION_ONLY_TOOLS` nor `findNonNegotiableFloors` is on codex's answer path.
   *
   * The far side has the CALLER bound, like `agentMessageSend`: the body names a file and the page fields, never
   * whose session publishes, and `artifactList` takes no body at all — it answers the calling session's own
   * registry rows. Every rule (unattended, guard, retention range, update target, one card at a time) is the
   * closure's; this route adds none (property 3 of the bridge).
   */
  artifactPublish: '/artifact/publish',
  artifactList: '/artifact/list',
  /**
   * UA3.5 — `create_board_task` (OQ-8). Native-first, step 1: codex has no board or task API of its own to enable
   * (spec §4), so step 2 is this route, and codex reaches the SAME host closure Pi and Claude reach in process
   * (`createBoardTaskFn`). The far side has the CALLER bound, like `agentMessageSend`: the body is the tool's fields,
   * never whose session creates, and every restriction (the caller's folder, project, sources and connection, no
   * mode) is the closure's; this route adds none (property 3 of the bridge).
   */
  taskCreate: '/task/create',
  /**
   * UA6.3 — the six page tools (`list_pages` … `delete_page`). Native-first, step 1: codex has no page store or
   * dashboard surface of its own to enable, so step 2 is these routes, ONE per `PagesToolCallbacks` member (the cron
   * rule), and codex reaches the SAME grouped host closure Pi and Claude reach in process (the registry slot
   * `pages`, bound by `SessionManager.pagesToolCallbacksForAgent`). The far side has the CALLER bound, like
   * `taskCreate`: the body is the tool's fields, never whose workspace; the storage, the `pages:changed` push and
   * `delete_page`'s one-shot card live in the closure, and these routes add none (property 3 of the bridge).
   */
  pageList: '/page/list',
  pageGet: '/page/get',
  pageCreate: '/page/create',
  pageUpdate: '/page/update',
  pageWriteData: '/page/write-data',
  pageDelete: '/page/delete',
  /**
   * UB1.12 — `project_memory_append` (upstream v0.15.1). Native-first, step 1: codex has no append-only shared-notes
   * primitive of its own (its Write overwrites; UA5.12 measured it writes files UNASKED), so step 2 is this route,
   * and codex reaches the SAME host closure Pi and Claude reach in process (`appendProjectMemoryFn`). The far side
   * has the CALLER bound, like `taskCreate`: the body is the tool's `note` field, never whose session appends, and
   * the project read, the dated heading and the no-project refusal are the closure's — this route adds none
   * (property 3 of the bridge). Offered unconditionally (upstream parity): the route and the tool land together.
   */
  projectMemoryAppend: '/project-memory/append',
  /**
   * UB7.11 — the MCP prompt pair (`source_list_prompts` / `source_get_prompt`,
   * upstream v0.15.1; OQ-B4-2 (c) OWNER-CONFIRMED). Native-first, step 1: codex
   * has no model-facing prompt surface of its own (`codex-protocol/generated/v2`
   * carries `McpResourceRead*` and no prompt type), so step 2 is these routes,
   * ONE per `McpSourceToolCallbacks` member (the cron rule), and codex reaches
   * the SAME grouped host closure Pi and Claude reach in process (the registry
   * slot `mcpSources`). The far side has the CALLER bound, like `taskCreate`:
   * the body is the tool's fields, never whose session asks; the enabled-source
   * check, the pool reads, the rendering and the large-result guard live in the
   * closure, and these routes add none (property 3 of the bridge). Offered
   * unconditionally (upstream parity): the routes and the tools land together.
   */
  sourceListPrompts: '/source/prompts/list',
  sourceGetPrompt: '/source/prompts/get',
  /**
   * UB6.11 — `decide` (upstream v0.15.1; OQ-43.5 (a)). Native-first, step 1:
   * codex has no decision-model surface of its own to enable, so step 2 is this
   * route, and codex reaches the SAME host closure Pi and Claude reach in
   * process (`ctx.decide`, the registry slot bound only when the decision layer
   * is configured). The far side fails closed with the honest "not enabled"
   * sentence when the slot is unbound — and the OFFER is port-gated at the
   * spawn (`--decide-port`, emitted beside the bridge port only then), so a
   * bridged codex session whose decision layer is off is not advertised the
   * tool at all.
   */
  decide: '/decide',
} as const;

/**
 * P2.2 — which `Goal` actions each mutating route accepts.
 *
 * Exported so the subprocess client routes by the SAME table the host narrows
 * with: a client that sent `cancel` to `goal/set` would otherwise be refused by
 * a rule it could not read.
 */
export const HOST_CALLBACK_BRIDGE_GOAL_ACTIONS = {
  set: ['create', 'replace', 'resume'],
  clear: ['cancel', 'complete', 'blocked'],
} as const satisfies Record<'set' | 'clear', readonly string[]>;

export type HostCallbackBridgeRoute =
  (typeof HOST_CALLBACK_BRIDGE_ROUTES)[keyof typeof HOST_CALLBACK_BRIDGE_ROUTES];

/** Every request body carries the id the subprocess was spawned with. */
export interface HostCallbackBridgeRequest {
  sessionId: string;
  /** Route-specific arguments; absent for the two no-argument routes. */
  payload?: unknown;
  /**
   * F1.493 (2) — the model tool call this request is running for, when codex named one in the MCP `tools/call`
   * `_meta` ({@link hostCallbackBridgeCallOriginOf}). Absent for a call that named none — the request is then
   * exactly what it was before this field existed.
   */
  origin?: HostCallbackBridgeCallOrigin;
}

/**
 * F1.493 (2) — WHICH codex tool call a bridged session tool is running for, so a host card it raises can be bound
 * to whoever raised it (F1.475's claude shape, carried across the loopback bridge).
 *
 * Measured on the shipped `codex-app-server` 0.156.1 (the tag `packages/codex-protocol/manifest.json` pins) with a
 * stdio MCP server recording every `tools/call` `_meta`, a main-thread call and a `spawn_agent` child's call to the
 * same tool: both carry `callId` (the model's call id) and `threadId` — the MAIN thread's id for the first, the
 * CHILD thread's (the collab item's `receiverThreadIds[0]`) for the second — while `sessionId` is the ROOT thread's
 * for both. The parent's turn completed BEFORE the child's call arrived, which is the case the binding exists for.
 * Source: `core/src/mcp_tool_call.rs` (`build_mcp_tool_call_request_meta` writes `callId`;
 * `with_mcp_tool_call_ids_meta` writes `threadId` from `sess.thread_id`), on the one path every MCP call takes.
 */
export interface HostCallbackBridgeCallOrigin {
  /** codex's `_meta.callId`. */
  callId: string;
  /** codex's `_meta.threadId`: the thread that made the call — the session's own, or a spawned subagent's. */
  threadId?: string;
  /**
   * F1.631 — codex's `_meta["x-codex-turn-metadata"].turn_id`: the turn the call was made in. MEASURED on the
   * shipped binary (0.159.3, sha = the manifest pin; the lane's probe) to EQUAL the `turn/started` `turn.id` the
   * codex agent keeps as `activeTurnId`, so the host can refuse a main-thread card whose turn ended while the
   * raise was in flight (F1.406's codex residue). In the `_meta` it NESTS under `x-codex-turn-metadata`; the
   * bridge body copies it flat as `turnId` — one reader for both shapes.
   */
  turnId?: string;
}

/** Ids are opaque and short; anything longer is not codex's and is dropped rather than carried. */
const MAX_CALL_ORIGIN_ID_LENGTH = 256;

/**
 * F1.493 (2) — read an origin from codex's `tools/call` `_meta` (the subprocess side) or from a bridge request's
 * `origin` (the host side, where the body is untrusted input): the same keys, the same validation. No `callId`
 * means no origin at all, so a call that names none is never half-attributed. F1.631 adds the turn id, which
 * arrives NESTED in the `_meta` (`x-codex-turn-metadata.turn_id`) and FLAT in the body (`turnId`).
 */
export function hostCallbackBridgeCallOriginOf(value: unknown): HostCallbackBridgeCallOrigin | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const idIn = (source: Record<string, unknown>, key: string) => {
    const candidate = source[key];
    return typeof candidate === 'string' && candidate.length > 0 && candidate.length <= MAX_CALL_ORIGIN_ID_LENGTH
      ? candidate
      : undefined;
  };
  const id = (key: string) => idIn(record, key);
  const callId = id('callId');
  if (!callId) return undefined;
  const threadId = id('threadId');
  const metaTurn = record['x-codex-turn-metadata'];
  const turnId = id('turnId')
    ?? (metaTurn && typeof metaTurn === 'object' ? idIn(metaTurn as Record<string, unknown>, 'turn_id') : undefined);
  if (!threadId && !turnId) return { callId };
  return { callId, ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}) };
}

/**
 * Exactly one of the two members is present.
 *
 * `error` is a MESSAGE, not a status: the handlers on the far side already
 * translate a thrown port error into the tool's own "<Tool> failed: …" text, so
 * a refusal from T2's Monitor gate reaches the model with the rule it names
 * intact.
 */
export interface HostCallbackBridgeResponse<T = unknown> {
  result?: T;
  error?: string;
}

/** The `sessionId` mismatch reply, so both sides assert the same sentence. */
export const HOST_CALLBACK_BRIDGE_SESSION_MISMATCH =
  'host callback bridge: session id does not match the session this bridge is bound to';

/**
 * T5 — the HOST half of the codex host-callback bridge.
 *
 * One loopback HTTP server per codex session, started beside the Responses
 * adapter and torn down with it. It carries `ctx.cronPort`, `ctx.monitor` and
 * (P2.2) `ctx.goalPort` across the process boundary that made the scheduling,
 * watching and goal tools unreachable from `session-mcp-server`: codex spawns
 * that server over stdio, so a port `SessionManager` bound in this process is
 * simply not visible there.
 *
 * P3.13 added an eleventh route that carries no port — `advisor/consult`, whose
 * host authority is a METHOD on the agent (`BaseAgent.executeAdvisorConsult`)
 * rather than a service `SessionManager` bound. It is the same boundary crossing
 * and the same three properties below; only the thing on the far side differs.
 *
 * Three properties are the whole design, and each has a reason:
 *
 * 1. **The ports are resolved FRESH per request** from the per-session
 *    `SessionScopedToolCallbacks` registry — the same entries the Claude
 *    in-process path reads (`session-self-management-bindings.ts`) and the same
 *    objects Pi takes through `BackendConfig`. Nothing is copied at start: a
 *    runtime switch re-merges (or clears) `cronPort`, and a captured reference
 *    would hand the next runtime the previous one's scheduler.
 *
 * 2. **The bridge is bound to ONE session and says so on every request.** The
 *    id travels in the body and is compared before any port is touched. This is
 *    `monitorPort`'s own rule ("the port is bound to THIS session's key, so a
 *    monitor can only ever be started or stopped for its own owner") carried
 *    onto a socket, which — unlike an in-process call — anything on the machine
 *    can reach. The server also binds 127.0.0.1 explicitly, never `0.0.0.0`.
 *    The owner id is checked on the ENVELOPE; the `Monitor` PAYLOAD is
 *    separately narrowed to `MonitorStartInput`'s own fields
 *    (`pickMonitorStartInput`), because the host sink spreads it over
 *    host-bound fields and a `sessionKey` smuggled into the body would
 *    otherwise retarget the watch at another session. The `Goal` payload is
 *    narrowed the same way and for the same class of reason
 *    (`pickGoalCommand`): the host sink stamps `source`/`creator` onto a
 *    created goal, and a body carrying its own would forge the attribution.
 *
 * 3. **A refusal is a message, not a crash.** Every handler failure — an absent
 *    port, a thrown gate refusal, a bad payload — answers with JSON `{ error }`,
 *    which the subprocess re-throws and the tool handler formats into its own
 *    documented failure text. T2's Monitor gate lives inside
 *    `SessionMonitorService.start`, i.e. behind `monitorPort.start`, so its
 *    denial reaches the model through this path with the rule it names intact.
 *    There is deliberately NO second gate here.
 */
import { createServer, type Server } from 'node:http';
import {
  GoalSchema,
  HOST_CALLBACK_BRIDGE_GOAL_ACTIONS,
  HOST_CALLBACK_BRIDGE_ROUTES,
  HOST_CALLBACK_BRIDGE_SESSION_MISMATCH, hostCallbackBridgeCallOriginOf, // F1.493 (2)
  type HostCallbackBridgeRequest,
  type AgentMessageDeliveryVerdict,
  type ArchiveSessionVerdict,
  type ListSessionsOptions,
  type ListSessionsResult,
  type MonitorStartInput,
  type SessionInfo,
  type SessionCronPort,
  type SessionGoalPort,
  type SessionMonitorPort,
  type SessionNotificationPort,
  type SessionReviewDiffPort,
  type SessionWorktreePort,
} from '@nessy-agent/session-tools-core';
import { getSessionScopedToolCallbacks } from '../../session-scoped-tool-callback-registry.ts';
import { ADVISOR_MOMENTS, ADVISOR_UNBOUND_REPLY } from '../../advisor.ts';
import type { SessionKey } from '../../../sessions/session-key.ts';

/** Bodies are small JSON objects; anything larger is a client that is not ours. */
const MAX_BODY_BYTES = 256 * 1024;

export interface CodexSessionCallbackBridgeHandle {
  /** The loopback port the subprocess is told about. */
  readonly port: number;
  close(): Promise<void>;
}

export interface CodexSessionCallbackBridgeOptions {
  /** The session this bridge answers for, and the only one it will. */
  sessionKey: SessionKey;
  /**
   * Seam for tests and for the (unlikely) day a second host wants a bridge:
   * defaults to the per-session callback registry, which is where
   * `SessionManager` publishes all three ports.
   */
  resolvePorts?: () => {
    cronPort?: SessionCronPort;
    monitorPort?: SessionMonitorPort;
    goalPort?: SessionGoalPort;
    /**
     * P3.13 — the advisor consult, when a host publishes it in the per-session
     * registry (the slot the Claude adapter reads). Listed on this seam rather
     * than beside it so ONE stub controls every resolution this bridge makes.
     */
    advisorConsultFn?: (args: Record<string, unknown>) => Promise<string>;
    /**
     * P6.45-adjacent — `send_agent_message`. Resolved through the SAME registry
     * slot the Claude in-process path reads, so a codex session's message and a
     * claude session's message reach one `SessionManager.deliverAgentMessage`
     * and one set of loop guards.
     */
    sendAgentMessageFn?: (sessionId: string, message: string, options?: { notifyWhenIdle?: boolean }) => Promise<AgentMessageDeliveryVerdict>;
    /**
     * P3.222 — the ROSTER half of the same pair, through the same registry slots
     * the Claude in-process path reads. Without them a codex session could write
     * to a peer it had no way to enumerate, and was still shown a roster tool
     * that could only answer "not available in this context".
     */
    listSessionsFn?: (options?: ListSessionsOptions) => ListSessionsResult;
    getSessionInfoFn?: (sessionId?: string) => SessionInfo | null;
    /** P6.466 — the archive verb's host closure; it raises its own card. */
    archiveSessionFn?: (sessionId: string | undefined, archived: boolean) => Promise<ArchiveSessionVerdict>;
    /**
     * P3.276 — the host-computed review diff, through the SAME registry slot
     * the Claude in-process path reads. Without it a bridged codex session is
     * offered `ReviewDiff` (the tool is in `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK`)
     * and every call answers "not available in this context" — the exact shape
     * P3.222 measured for the roster pair, arriving on the next tool.
     */
    reviewDiff?: SessionReviewDiffPort;
    /**
     * P6.184 — the desktop notification port, through the SAME registry slot Pi
     * and the Claude in-process path read. Codex has no notification mechanism
     * the model can reach at all, so this is not a convenience route: without
     * it the capability is absent on this runtime and present on the other two,
     * which is the divergence class this bridge exists to close.
     */
    notificationPort?: SessionNotificationPort;
    /**
     * P6.137 — the worktree family, through the SAME registry slot Pi and the
     * Claude in-process path read. Codex publishes no worktree surface of its
     * own (`worktree` 0 files in `packages/codex-protocol`), so the crossing is
     * the whole capability rather than a convenience.
     */
    worktreePort?: SessionWorktreePort;
    /**
     * P6.137 — the `EnterWorktree` approval floor, resolved fresh per request
     * like every port here. REQUIRED by the enter route rather than optional:
     * `evaluateWorktreeApproval` runs inside `runPreToolUseChecks`, which has
     * zero call sites in `codex-agent.ts`, so an unbound authority means the
     * move would be unjudged — and this route refuses instead.
     */
    worktreeEnterAuthority?: (input: { path?: string }) => Promise<void>;
  } & SessionSelfManagementBridgePorts & SessionArtifactBridgePorts & SessionBoardTaskBridgePorts & SessionPagesBridgePorts & SessionProjectMemoryBridgePorts & SessionMcpSourcesBridgePorts & SessionDecideBridgePorts // UA1.3 / UA1.18 / UA3.5 / UA6.3 / UB1.12 / UB7.11 / UB6.11 — slots at the file end
  /**
   * P3.13 — the consult `advisor/consult` runs, when the AGENT binds it
   * directly. Takes precedence over the registry slot above, and codex-agent
   * uses it: the consult is `BaseAgent.executeAdvisorConsult` on the very agent
   * that started this bridge, and the bridge dies with that agent, so there is
   * no lifetime a captured reference could outlive. (The three PORTS are
   * different — `SessionManager` re-merges them across a runtime switch, which
   * is why they are resolved fresh per request and never captured.)
   */
  advisorConsult?: (args: Record<string, unknown>) => Promise<string>;
  /**
   * C4.13 — start codex's OWN detached review, when the AGENT binds it. Same
   * reason as the consult above: `review/start` runs on THIS session's open
   * codex thread over THIS agent's app-server client, and the bridge dies with
   * that agent. Resolves to the line telling the user the review is running in
   * the background, or to `null` when codex could not take it — in which case
   * the route hands back the ordinary delegate-this answer and the review runs
   * inline, exactly as it did before this option existed.
   */
  detachedReview?: (input: { target: string; task: string; rubric: string }) => Promise<string | null>;
  /** Diagnostics only — never a request body, never a prompt. */
  onDiagnostic?: (message: string) => void;
}

type Handler = (payload: unknown) => Promise<unknown>;

function requirePort<T>(port: T | undefined, name: string): T {
  // The same sentence shape the in-process handlers use when a port is missing,
  // so a model reading the failure learns the capability is absent rather than
  // that its arguments were wrong.
  if (!port) throw new Error(`${name} is unavailable for this session.`);
  return port;
}

function asRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

/**
 * A handler may demand a NON-200 status for a MALFORMED request — as opposed to
 * a well-formed-but-refused one, which stays 200 `{ error }` so the tool
 * re-throws it as its own failure text. The request catch block honours this;
 * everything else it turns into 200 `{ error }`.
 */
class BridgeRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'BridgeRequestError';
  }
}

/**
 * `Monitor`'s payload is model-controllable, but the sink it flows into —
 * `SessionManager`'s `monitorPort`, which spreads the request over the
 * HOST-BOUND fields `sessionKey`, `cwd`, `workspaceRoot`, `env` and
 * `additionalWritableRoots` — would let a `sessionKey` smuggled into the raw
 * body retarget the watch at ANOTHER session and defeat the envelope owner
 * check above. So only the fields `MonitorStartInput` actually declares cross
 * this boundary; every other key is dropped here, before `monitor().start`.
 */
function pickMonitorStartInput(payload: unknown): MonitorStartInput {
  const record = asRecord(payload);
  const input: MonitorStartInput = {
    description: typeof record.description === 'string' ? record.description : '',
    timeoutMs: typeof record.timeoutMs === 'number' ? record.timeoutMs : Number.NaN,
    persistent: record.persistent === true,
  };
  if (typeof record.command === 'string') input.command = record.command;
  if (record.ws && typeof record.ws === 'object') {
    input.ws = record.ws as MonitorStartInput['ws'];
  }
  return input;
}

/**
 * P2.2 — the `Goal` payload whitelist, and the second belt beside the envelope
 * owner check.
 *
 * `GoalSchema` is the tool's own discriminated union of `.strict()` objects, so
 * parsing through it drops nothing silently: an unknown key is a REFUSAL. That
 * is what closes the smuggling hole this route would otherwise open — the host
 * sink (`SessionManager`'s goal port) stamps `source: 'agent'` and the creating
 * runtime onto a `create`/`replace` command, and a `source: 'user'` carried in
 * the raw body would let a model mint a goal the UI attributes to the human who
 * never asked for it. `GoalSchema` declares neither field, so neither crosses.
 *
 * The ACTION is narrowed a second time, per route, against
 * `HOST_CALLBACK_BRIDGE_GOAL_ACTIONS`: `goal/set` may only leave a goal active
 * and `goal/clear` may only end one, so a route cannot be used for the other's
 * effect even with a payload the union accepts.
 *
 * A payload the union rejects is MALFORMED, not refused — 400, before the port
 * is resolved — the same line `cron/rearmWakeup` draws for a non-finite delay.
 */
function pickGoalCommand(
  payload: unknown,
  route: 'set' | 'clear',
): Record<string, unknown> {
  const parsed = GoalSchema.safeParse(asRecord(payload));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new BridgeRequestError(`host callback bridge: goal/${route} payload is invalid — ${detail}`, 400);
  }
  const allowed: readonly string[] = HOST_CALLBACK_BRIDGE_GOAL_ACTIONS[route];
  if (!allowed.includes(parsed.data.action)) {
    throw new BridgeRequestError(
      `host callback bridge: goal/${route} does not serve action "${parsed.data.action}"`
        + ` (it serves ${allowed.join(', ')})`,
      400,
    );
  }
  return parsed.data as unknown as Record<string, unknown>;
}

/**
 * P3.13 — the `advisor_consult` payload whitelist, the second belt beside the
 * envelope owner check.
 *
 * Narrower than `pickGoalCommand` on purpose: it does NOT parse through
 * `AdvisorConsultSchema` and does NOT refuse. `executeAdvisorConsult` owns the
 * validation — it re-checks the moment and the question and answers a bad call
 * with the sentence naming the vocabulary — and that sentence is what pi and
 * claude return. Refusing here with a 400 would give codex a DIFFERENT reply to
 * the same mistake, which is the one thing this route exists not to do.
 *
 * What it does do is drop every other key before the args reach the agent. The
 * sink reads exactly these three today, so nothing is smuggled through it now;
 * the whitelist is what keeps that true if the sink ever grows a field, which is
 * the same bet `pickMonitorStartInput` makes about `...input`.
 */
function pickAdvisorConsultInput(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  const input: Record<string, unknown> = {};
  // `moment` is passed through as the raw value when it is one of the documented
  // three and dropped otherwise, so an unknown moment reaches the agent as an
  // ABSENT one — the case its own validation already names.
  if (ADVISOR_MOMENTS.some(moment => moment === record.moment)) input.moment = record.moment;
  if (typeof record.question === 'string') input.question = record.question;
  if (typeof record.context === 'string') input.context = record.context;
  return input;
}

/**
 * P6.183 — a bind that fails once costs the session half its tool surface, so
 * it is retried a bounded number of times before the bridge gives up.
 *
 * ## What a failed bind costs, and why one attempt was not enough
 *
 * `session-mcp-server` spreads the bridged tools behind a single conditional on
 * the port, so `sendAgentMessage`, `listSessions` and `getSessionInfo` unbind
 * together and the session lives its whole life on the bare 16-tool surface.
 * The single `server.listen` this replaces rejected on ANY listen error with no
 * discrimination, no retry, and — the part that made it undiagnosable — with
 * the error CODE recorded nowhere.
 *
 * ## Why the retry is not keyed on the error code (measured 2026-09-06)
 *
 * The row asked for the code first, because a socket rewrite buys nothing under
 * fd exhaustion while a bounded retry does. Measured on this rig, the code is
 * not a reliable discriminator, because the two runtimes this module runs on
 * disagree about it: `bun 1.3.x` reports a privileged-port refusal as
 * `EADDRINUSE` with the message "Failed to start server. Is port 1 in use?",
 * where `node v24` reports the same bind as `EACCES: permission denied`. A
 * transient-code allow-list would therefore mean different things in the
 * Electron main process (node) and in `nessy-server` (bun) — the silent
 * divergence this fork keeps paying for.
 *
 * So the rule is the simple one: retry every failure a bounded number of times,
 * and RECORD the code on each attempt. This is safe precisely because of what
 * is bound — `127.0.0.1` port 0. `EACCES` cannot arise on an ephemeral loopback
 * port, and `EADDRINUSE` on port 0 is a kernel race rather than a standing
 * condition, so nothing in the reachable failure set is permanent-and-retried.
 * The worst case an operator pays is {@link LISTEN_RETRY_DELAY_MS} times
 * {@link LISTEN_ATTEMPTS} minus one, once, at session start.
 *
 * A post-bind `error` keeps a listener deliberately: the promise below settles
 * with `once`, and an `http.Server` that emits `error` with no listener throws
 * into the process. The old code was accidentally protected by the permanent
 * `server.on('error', reject)` it installed; this one is protected on purpose.
 */
const LISTEN_ATTEMPTS = 3;
/** Long enough for a descriptor to come back, short enough to be unnoticed. */
const LISTEN_RETRY_DELAY_MS = 50;

/** The slice of `http.Server` the bind loop uses, so a test can hand it a double. */
export type LoopbackListener = Pick<Server, 'listen' | 'once' | 'on' | 'removeListener' | 'address'>;

function attemptLoopbackListen(
  server: LoopbackListener,
): Promise<{ ok: true; port: number } | { ok: false; code?: string; message: string }> {
  return new Promise(resolve => {
    const onError = (error: unknown) => {
      server.removeListener('listening', onListening);
      resolve({
        ok: false,
        code: (error as NodeJS.ErrnoException | undefined)?.code,
        message: error instanceof Error ? error.message : String(error),
      });
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const address = server.address();
      resolve({ ok: true, port: typeof address === 'object' && address ? address.port : 0 });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

export async function listenOnLoopbackWithRetry(
  server: LoopbackListener,
  onDiagnostic?: (message: string) => void,
  delayMs = LISTEN_RETRY_DELAY_MS,
): Promise<number> {
  let last: { code?: string; message: string } | undefined;
  for (let attempt = 1; attempt <= LISTEN_ATTEMPTS; attempt++) {
    const result = await attemptLoopbackListen(server);
    if (result.ok) {
      // See the docblock: `once` above leaves the server bare after a success.
      server.on('error', error => onDiagnostic?.(
        `[codex-callback-bridge] server error after bind: ${error instanceof Error ? error.message : String(error)}`,
      ));
      if (attempt > 1) {
        onDiagnostic?.(`[codex-callback-bridge] bound on attempt ${attempt} of ${LISTEN_ATTEMPTS}`);
      }
      return result.port;
    }
    last = result;
    onDiagnostic?.(
      `[codex-callback-bridge] bind attempt ${attempt} of ${LISTEN_ATTEMPTS} failed`
      + ` (${result.code ?? 'no code'}): ${result.message}`,
    );
    if (attempt < LISTEN_ATTEMPTS && delayMs > 0) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
    }
  }
  throw new Error(
    `host callback bridge: could not bind 127.0.0.1 after ${LISTEN_ATTEMPTS} attempts`
    + ` (${last?.code ?? 'no code'}): ${last?.message ?? 'unknown error'}`,
  );
}

/**
 * Start the bridge.
 *
 * Resolves once the socket is listening, so the caller can put the port into
 * the subprocess's spawn arguments and know the first tool call cannot race it.
 */
export async function startCodexSessionCallbackBridge(
  options: CodexSessionCallbackBridgeOptions,
): Promise<CodexSessionCallbackBridgeHandle> {
  const resolvePorts = options.resolvePorts
    ?? (() => getSessionScopedToolCallbacks(options.sessionKey));

  const cron = (): SessionCronPort => requirePort(resolvePorts()?.cronPort, 'Scheduling');
  const monitor = (): SessionMonitorPort => requirePort(resolvePorts()?.monitorPort, 'Monitor');
  const goal = (): SessionGoalPort => requirePort(resolvePorts()?.goalPort, 'Goal');

  const handlers: Record<string, Handler> = {
    [HOST_CALLBACK_BRIDGE_ROUTES.cronCreate]: async payload =>
      cron().create(asRecord(payload) as Parameters<SessionCronPort['create']>[0]),
    [HOST_CALLBACK_BRIDGE_ROUTES.cronList]: async () => cron().list(),
    [HOST_CALLBACK_BRIDGE_ROUTES.cronRemove]: async payload =>
      cron().remove(String(asRecord(payload).id ?? '')),
    [HOST_CALLBACK_BRIDGE_ROUTES.cronRearmWakeup]: async payload => {
      const delayMs = Number(asRecord(payload).delayMs);
      // A non-finite or negative delay is a malformed request, not a refused
      // one: reject it with 400 BEFORE the cron port is resolved, so `NaN` can
      // never reach `rearmWakeup` and arm a wakeup that would never fire.
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new BridgeRequestError(
          'host callback bridge: rearm delayMs must be a non-negative finite number',
          400,
        );
      }
      const port = cron();
      // OPTIONAL on the port type: a host with no wakeup slot must fail the way
      // `ScheduleWakeup` documents rather than pretend it armed one.
      if (!port.rearmWakeup) throw new Error('ScheduleWakeup is unavailable for this session.');
      return port.rearmWakeup({ delayMs });
    },
    [HOST_CALLBACK_BRIDGE_ROUTES.cronStopWakeup]: async () => {
      const port = cron();
      if (!port.stopWakeup) throw new Error('ScheduleWakeup is unavailable for this session.');
      return port.stopWakeup();
    },
    // P6.295 arm (2) — `CronControl`'s three port members. Each is OPTIONAL on
    // the port, so each names its own absence the way `ScheduleWakeup` does
    // above rather than reporting a pause that never happened. The id is read
    // the way `cronRemove` reads it: an empty one reaches the store and comes
    // back as `false`, which the tool renders as "no such task".
    [HOST_CALLBACK_BRIDGE_ROUTES.cronSetPaused]: async payload => {
      const port = cron();
      if (!port.setPaused) throw new Error('CronControl is unavailable for this session.');
      const body = asRecord(payload);
      return port.setPaused(String(body.id ?? ''), body.paused === true);
    },
    [HOST_CALLBACK_BRIDGE_ROUTES.cronRunNow]: async payload => {
      const port = cron();
      if (!port.runNow) throw new Error('CronControl is unavailable for this session.');
      return port.runNow(String(asRecord(payload).id ?? ''));
    },
    [HOST_CALLBACK_BRIDGE_ROUTES.cronAcknowledgeRuns]: async payload => {
      const port = cron();
      if (!port.acknowledgeRuns) throw new Error('CronControl is unavailable for this session.');
      return port.acknowledgeRuns(String(asRecord(payload).id ?? ''));
    },
    // The T2 permission gate is awaited INSIDE this call. No SECOND gate is
    // added here — that is how two doors drift apart. What IS enforced: only
    // `MonitorStartInput`'s own fields cross, via `pickMonitorStartInput`, so a
    // foreign `sessionKey`/`cwd`/`env` in the raw body cannot ride the sink's
    // `...input` spread onto another session's watch.
    [HOST_CALLBACK_BRIDGE_ROUTES.monitorStart]: async payload =>
      monitor().start(pickMonitorStartInput(payload)),
    [HOST_CALLBACK_BRIDGE_ROUTES.monitorStop]: async payload =>
      monitor().stop(String(asRecord(payload).taskId ?? '')),
    // P2.2 — the goal three. `get` takes no payload at all (`GoalGetSchema` is
    // an empty strict object), so nothing is read from the body: the only thing
    // that decides WHOSE goal is returned is the envelope owner check above.
    [HOST_CALLBACK_BRIDGE_ROUTES.goalGet]: async () => goal().execute({ action: 'get' }),
    // P2.17 — the parse is on its own line, ABOVE the port, in both mutating
    // routes. `goal().execute(pickGoalCommand(…))` evaluates the callee first,
    // so the port was resolved before the payload was read: a malformed body
    // sent to a session with no goal authority answered 200 "Goal is
    // unavailable for this session." instead of the 400 `pickGoalCommand`'s own
    // doc promises. `cron/rearmWakeup` above draws the line in this shape for
    // the same reason.
    [HOST_CALLBACK_BRIDGE_ROUTES.goalSet]: async payload => {
      const command = pickGoalCommand(payload, 'set');
      return goal().execute(command);
    },
    [HOST_CALLBACK_BRIDGE_ROUTES.goalClear]: async payload => {
      const command = pickGoalCommand(payload, 'clear');
      return goal().execute(command);
    },
    // P3.13 — the advisor consult. The only route with no `requirePort` call,
    // and the reason is the contract it mirrors: an UNBOUND consult is not a
    // failure on any runtime. The Claude adapter answers the identical sentence
    // from its own empty-callback branch, and `executeAdvisorConsult` answers
    // every other refusal (advisor off, model refused, query failed) as ordinary
    // text too — because advice is an aid, and a model told its consult ERRORED
    // retries it. So this returns the reply rather than throwing one.
    [HOST_CALLBACK_BRIDGE_ROUTES.advisorConsult]: async payload => {
      const consult = options.advisorConsult ?? resolvePorts()?.advisorConsultFn;
      if (!consult) return ADVISOR_UNBOUND_REPLY;
      return consult(pickAdvisorConsultInput(payload));
    },
    // P6.45-adjacent — `send_agent_message`. Resolved fresh per request like the
    // ports, for the ports' reason: a runtime switch re-merges the registry, and
    // a captured closure would let a session that is no longer codex keep
    // writing through this socket.
    //
    // Two fields cross and nothing else. The SENDER is not one of them: the
    // resolved closure is `bindSendAgentMessage(sender)`, bound host-side to the
    // session this bridge answers for, so a forged author is unrepresentable
    // rather than merely rejected. The receiving side's rate limit, repeat check
    // and queue cap (`cross-session-inbound.ts`) are inside that closure, so
    // codex is subject to the identical loop stop as pi and claude — which is
    // the point of routing it here instead of giving codex its own path.
    [HOST_CALLBACK_BRIDGE_ROUTES.agentMessageSend]: async payload => {
      const record = asRecord(payload);
      const targetSessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
      const message = typeof record.message === 'string' ? record.message : '';
      // P6.465 (N6) — an EMPTY message is legal only alongside `notifyWhenIdle`:
      // "Claude subscribes with the `SendMessage` tool's `notify_when_idle`
      // input, either attached to a message it's sending anyway or on its own."
      // Without this the codex arm would 400 on the subscribe-on-its-own call
      // that pi and claude accept.
      const notifyWhenIdle = record.notifyWhenIdle === true;
      // Malformed, not refused: 400 before the closure is resolved, the line
      // `cron/rearmWakeup` and `goal/set` already draw.
      if (!targetSessionId || (!message.trim() && !notifyWhenIdle)) {
        throw new BridgeRequestError(
          'host callback bridge: agent-message/send needs a non-empty sessionId and message',
          400,
        );
      }
      const send = requirePort(resolvePorts()?.sendAgentMessageFn, 'send_agent_message');
      return notifyWhenIdle ? send(targetSessionId, message, { notifyWhenIdle: true }) : send(targetSessionId, message);
    },
    // P3.222 — the roster half. Resolved fresh per request for the reason every
    // other route is: a runtime switch re-merges the registry.
    //
    // NO payload whitelist, and the difference from `Monitor`/`Goal` is the
    // reason rather than an omission: those two flow into host sinks that SPREAD
    // the body over host-bound fields, so a smuggled `sessionKey` or `source`
    // would retarget or forge. These two only READ, through closures the host
    // bound to one workspace, and neither takes a session KEY — `getSessionInfo`
    // takes a bare id that its own closure resolves inside the caller's
    // workspace. So the fields are narrowed to their declared types and nothing
    // else crosses.
    [HOST_CALLBACK_BRIDGE_ROUTES.sessionList]: async payload => {
      const record = asRecord(payload);
      const options: ListSessionsOptions = {};
      if (typeof record.status === 'string') options.status = record.status;
      if (typeof record.label === 'string') options.label = record.label;
      if (typeof record.search === 'string') options.search = record.search;
      if (record.sortBy === 'recent' || record.sortBy === 'name' || record.sortBy === 'status') {
        options.sortBy = record.sortBy;
      }
      if (typeof record.limit === 'number' && Number.isFinite(record.limit)) options.limit = record.limit;
      if (typeof record.offset === 'number' && Number.isFinite(record.offset)) options.offset = record.offset;
      return requirePort(resolvePorts()?.listSessionsFn, 'list_sessions')(options);
    },
    /**
     * P3.276 — the codex half of the one host-computed diff.
     *
     * `code-review.md` promises the review "runs as a background subagent with
     * its own context window" on every runtime. Pi keeps it with its own
     * `review` tool; claude reaches `ctx.reviewDiff` in process; without this
     * route a bridged codex session had the tool advertised and nothing behind
     * it, so its delegated reviewer went back to reviewing whatever diff the
     * model chose to `git diff` for itself — the scope drift the row removes.
     *
     * The payload is NARROWED to the six declared target keys rather than
     * forwarded whole, on `sessionList`'s rule: this body reaches a host sink
     * that spreads it into `normalizeReviewTarget`, so an unnarrowed field is a
     * smuggling surface. `paths` is filtered element-wise for the same reason —
     * a non-string entry would reach a `git` argument list.
     */
    [HOST_CALLBACK_BRIDGE_ROUTES.reviewDiff]: async payload => {
      const record = asRecord(payload)
      const text = (value: unknown): string | undefined =>
        typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
      const paths = Array.isArray(record.paths)
        ? record.paths.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : undefined
      const request = {
        ...(text(record.base) ? { base: text(record.base)! } : {}),
        ...(text(record.commit) ? { commit: text(record.commit)! } : {}),
        ...(text(record.range) ? { range: text(record.range)! } : {}),
        ...(paths && paths.length > 0 ? { paths } : {}),
        ...(text(record.scope) ? { scope: text(record.scope)! } : {}),
        ...(text(record.instructions) ? { instructions: text(record.instructions)! } : {}),
      }
      const answer = await requirePort(resolvePorts()?.reviewDiff, 'ReviewDiff').compute(request)
      // C4.13 (QH1 B) — the BACKGROUND arm, and the only runtime-specific thing
      // this route does.
      //
      // `code-review.md#review-a-diff-locally` promises the review "runs as a
      // background subagent with its own context window, so it doesn't fill your
      // conversation". Pi backgrounds it by default (P6.798) and claude's SDK
      // backgrounds its own subagents; codex ran the reviewer inline on the
      // conversation's own thread. `review/start` with `delivery: "detached"` is
      // codex's OWN mechanism for exactly this, so the flip is configuration.
      //
      // C4.42 (OWNER, 2026-09-13, option B) — the DEFAULT flipped. This arm was
      // gated on an explicit `background === true`, so the direction was decided
      // by whether the model complied with a paragraph of
      // `apps/electron/resources/skills/code-review/SKILL.md`. The page states
      // the default in the other direction —
      // `code-review.md#run-in-the-foreground`: *"The review runs in the
      // background by default; before v2.1.218, it ran inside your
      // conversation"* — Pi backgrounds it by the owner's own P6.798 ruling, and
      // claude's SDK backgrounds its subagents. codex was the one runtime whose
      // default was model compliance, so the predicate is now `!== false`.
      //
      // The ESCAPE the page documents stays reachable, and that is the second
      // line this row is made of: `toRequest`
      // (`@nessy-agent/session-tools-core`, `handlers/review-diff.ts`) forwarded
      // only the literal `true`, so an explicit `background: false` never
      // reached here; it now forwards both booleans. Without that, `!== false`
      // would have DELETED the foreground case rather than closed a divergence.
      //
      // REPORTED as an extra field rather than by rewriting the answer: `handleReviewDiff`
      // (`@nessy-agent/session-tools-core`) renders `target`/`rubric`/`task`
      // through a fixed "Delegate this to the <agent> agent" template, so a
      // review that has ALREADY started detached cannot be expressed by editing
      // those three — the model would be told to review it a second time.
      // `backgroundReview` is the field that branch reads.
      //
      // Every fallback below is untouched by the flip. `startDetachedReview`
      // returns null on an older app-server, a refusal, no open thread or an
      // inline `reviewThreadId`, and the answer then falls through
      // byte-identical to the delegate-this template; an empty diff never starts
      // one, because "no changes" is a real answer and a background thread for
      // it would report nothing, twice.
      if (record.background !== false && options.detachedReview && answer.diff.trim()) {
        const started = await options.detachedReview({
          target: answer.target, task: answer.task, rubric: answer.rubric,
        })
        // `null` is codex declining — an older app-server, a refusal, an inline
        // delivery. The unmodified answer then falls through and the review runs
        // inline, which is what this build has always done.
        if (started) return { ...answer, backgroundReview: started }
      }
      return answer
    },
    /**
     * P6.466 — the archive verb, and the ONE bridged route whose far side
     * raises a permission card of its own.
     *
     * MEASURED before this existed: neither candidate carve-out seam reaches
     * codex for a session MCP tool. `INTERACTION_ONLY_TOOLS` lives inside
     * `runPreToolUseChecks`, which has zero call sites in `codex-agent.ts`;
     * `findNonNegotiableFloors` is reached only through
     * `codexApprovalFloorSubjects`, whose subjects are codex's own `command` /
     * `commandV1` / `fileChangeV1` approvals rendered as `Bash` and `Write`.
     * So the floor sits in `archiveSessionFn` and this route is how a bridged
     * codex session meets it — the same card, from the same host code, that Pi
     * and Claude meet in process.
     *
     * The payload is NARROWED to its two declared fields on `sessionList`'s
     * rule. `archived` defaults to TRUE on a missing or non-boolean value,
     * matching the tool schema's own default, so a malformed body can only ever
     * ask for the thing the tool is named after — never silently un-archive.
     */
    [HOST_CALLBACK_BRIDGE_ROUTES.sessionArchive]: async payload => {
      const record = asRecord(payload);
      const targetSessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
      const archived = record.archived === false ? false : true;
      const archive = requirePort(resolvePorts()?.archiveSessionFn, 'archive_session');
      // An ABSENT id means "this session", exactly as `sessionInfo` treats it.
      return archive(targetSessionId || undefined, archived);
    },
    /**
     * UA1.3 — `set_session_status` / `set_session_labels`: one route per `SessionToolContext` member, each resolved
     * fresh from the registry slot `SessionManager` binds for every runtime (`resolveStatusFn`, `setSessionStatusFn`,
     * `resolveLabelsFn`, `setSessionLabelsFn`), so a codex session reaches the very closures Pi and Claude reach in
     * process.
     *
     * Payloads are NARROWED to their declared fields on `sessionList`'s rule. A missing or non-string `status`, or a
     * `labels` that is not an array of strings, is MALFORMED (400) rather than refused — the tool schema cannot
     * produce one. No second gate here, by design (property 3 above): the closure-rule and the caller-workspace
     * refusals live in the SET closures, which raise them on every runtime, and reach the model through this path
     * as the tool's own failure text.
     */
    [HOST_CALLBACK_BRIDGE_ROUTES.sessionResolveStatus]: async payload => {
      const status = asRecord(payload).status;
      if (typeof status !== 'string') {
        throw new BridgeRequestError('host callback bridge: session/status/resolve needs a string status', 400);
      }
      return requirePort(resolvePorts()?.resolveStatusFn, 'set_session_status')(status);
    },
    [HOST_CALLBACK_BRIDGE_ROUTES.sessionSetStatus]: async payload => {
      const record = asRecord(payload);
      const targetSessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
      if (typeof record.status !== 'string' || !record.status.trim()) {
        throw new BridgeRequestError('host callback bridge: session/status needs a non-empty status', 400);
      }
      const set = requirePort(resolvePorts()?.setSessionStatusFn, 'set_session_status');
      // An ABSENT id means "this session", exactly as `sessionArchive` treats it.
      await set(targetSessionId || undefined, record.status);
      return null;
    },
    [HOST_CALLBACK_BRIDGE_ROUTES.sessionResolveLabels]: async payload => {
      const labels = asRecord(payload).labels;
      if (!Array.isArray(labels) || !labels.every(label => typeof label === 'string')) {
        throw new BridgeRequestError('host callback bridge: session/labels/resolve needs an array of string labels', 400);
      }
      return requirePort(resolvePorts()?.resolveLabelsFn, 'set_session_labels')(labels as string[]);
    },
    [HOST_CALLBACK_BRIDGE_ROUTES.sessionSetLabels]: async payload => {
      const record = asRecord(payload);
      const targetSessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
      const labels = record.labels;
      if (!Array.isArray(labels) || !labels.every(label => typeof label === 'string')) {
        throw new BridgeRequestError('host callback bridge: session/labels needs an array of string labels', 400);
      }
      const set = requirePort(resolvePorts()?.setSessionLabelsFn, 'set_session_labels');
      await set(targetSessionId || undefined, labels as string[]);
      return null;
    },
    /**
     * P6.184 — `PushNotification`.
     *
     * The payload is NARROWED to the tool's own two fields on `sessionList`'s
     * rule, and the narrowing is load-bearing rather than tidy: everything that
     * decides WHO is notified — the workspace, the session, the fallback title
     * — is filled in by the host closure this resolves to, so a body cannot
     * aim the user's attention at another session however it is shaped. An
     * empty or non-string `body` is refused here rather than delivered as an
     * empty banner.
     */
    [HOST_CALLBACK_BRIDGE_ROUTES.notificationPush]: async payload => {
      const record = asRecord(payload);
      const body = typeof record.body === 'string' ? record.body.trim() : '';
      if (!body) throw new Error('PushNotification requires a non-empty body.');
      const title = typeof record.title === 'string' && record.title.trim()
        ? record.title.trim()
        : undefined;
      const notify = requirePort(resolvePorts()?.notificationPort, 'PushNotification');
      return notify.notify({ ...(title ? { title } : {}), body });
    },
    /**
     * P6.137 — the worktree family.
     *
     * The enter route awaits the FLOOR before the port, and both are required:
     * `evaluateWorktreeApproval` lives inside `runPreToolUseChecks`, which has
     * zero call sites in `codex-agent.ts`, so this is the first and only gate
     * a codex `EnterWorktree` passes. An unbound authority refuses rather than
     * entering — the same fail-closed shape `requirePort` gives every other
     * route, applied to a security floor instead of a capability.
     *
     * The payload is NARROWED to the tool schema's own fields on `sessionList`'s
     * rule, and the narrowing is load-bearing here too: `branch`,
     * `mergeRequestUrl` and every other `WorktreeEnterInput` field is HOST-side
     * only (`P6.508`: "the tool schema does not carry it, so no model can name
     * a branch"), and a body that could set them would be a way around that.
     * The floor is judged on the SAME narrowed object the port is called with,
     * so the thing approved is the thing performed.
     */
    [HOST_CALLBACK_BRIDGE_ROUTES.worktreeEnter]: async payload => {
      const record = asRecord(payload);
      const path = typeof record.path === 'string' ? record.path.trim() : '';
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      const input = {
        ...(path ? { path } : (name ? { name } : {})),
        ...(record.carryWork === true ? { carryWork: true as const } : {}),
        ...(record.permanent === true ? { permanent: true as const } : {}),
      };
      const authorize = requirePort(resolvePorts()?.worktreeEnterAuthority, 'EnterWorktree');
      await authorize(path ? { path } : {});
      const worktree = requirePort(resolvePorts()?.worktreePort, 'EnterWorktree');
      return worktree.enter(input);
    },
    [HOST_CALLBACK_BRIDGE_ROUTES.worktreeExit]: async payload => {
      const record = asRecord(payload);
      const worktree = requirePort(resolvePorts()?.worktreePort, 'ExitWorktree');
      // `null` is a real answer here — "this session is not in a worktree" —
      // and the handler on the far side reports it rather than failing, so it
      // must survive the crossing rather than being turned into an error.
      return worktree.exit({
        ...(record.remove === true ? { remove: true as const } : {}),
        ...(record.carryWork === true ? { carryWork: true as const } : {}),
      }) as Promise<unknown>;
    },
    [HOST_CALLBACK_BRIDGE_ROUTES.worktreeList]: async () =>
      requirePort(resolvePorts()?.worktreePort, 'ExitWorktree').list(),
    /**
     * `batch` is OPTIONAL on the port (`SessionCronPort`'s rule: a host with no
     * session factory behind it fails through the existing "unavailable for
     * this backend" path), so its absence is refused BY NAME here rather than
     * reaching a call on `undefined`.
     */
    [HOST_CALLBACK_BRIDGE_ROUTES.worktreeBatch]: async payload => {
      const worktree = requirePort(resolvePorts()?.worktreePort, 'WorktreeBatch');
      const batch = requirePort(worktree.batch?.bind(worktree), 'WorktreeBatch');
      return batch(asRecord(payload) as Parameters<NonNullable<SessionWorktreePort['batch']>>[0]);
    },
    [HOST_CALLBACK_BRIDGE_ROUTES.sessionInfo]: async payload => {
      const record = asRecord(payload);
      const targetSessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
      const info = requirePort(resolvePorts()?.getSessionInfoFn, 'get_session_info');
      // An ABSENT id means "this session", which is the handler's own documented
      // default; an empty string is the same absence after trimming, so it is
      // normalised here rather than passed through as a lookup for `''`.
      return info(targetSessionId || undefined);
    },
    /**
     * UA1.18 — `publish_artifact`: the SAME host closure Pi and Claude reach in process (`publishArtifactFn`), which
     * raises the card, applies the unattended refusal and the publish guard, and answers a verdict the handler on
     * the far side turns into the tool's text. No second gate here (property 3 above).
     *
     * The payload is NARROWED to the six declared fields on `sessionList`'s rule: a missing `filePath`, or a field
     * of the wrong type, is MALFORMED (400) — the tool schema cannot produce one. The retention RANGE is not checked
     * here: that is the closure's rule, with the sentence the model reads.
     */
    [HOST_CALLBACK_BRIDGE_ROUTES.artifactPublish]: async payload => {
      const record = asRecord(payload);
      if (typeof record.filePath !== 'string' || !record.filePath.trim()) {
        throw new BridgeRequestError('host callback bridge: artifact/publish needs a non-empty filePath', 400);
      }
      const input: PublishArtifactInput = { filePath: record.filePath };
      for (const field of ['title', 'description', 'emoji', 'url'] as const) {
        const value = record[field];
        if (value === undefined) continue;
        if (typeof value !== 'string') {
          throw new BridgeRequestError(`host callback bridge: artifact/publish ${field} must be a string`, 400);
        }
        input[field] = value;
      }
      if (record.retentionDays !== undefined) {
        if (typeof record.retentionDays !== 'number' || !Number.isFinite(record.retentionDays)) {
          throw new BridgeRequestError('host callback bridge: artifact/publish retentionDays must be a number', 400);
        }
        input.retentionDays = record.retentionDays;
      }
      return requirePort(resolvePorts()?.publishArtifactFn, 'publish_artifact')(input);
    },
    /** UA1.18 — `list_artifacts`: no body; the closure answers the CALLING session's registry rows only. */
    [HOST_CALLBACK_BRIDGE_ROUTES.artifactList]: async () =>
      requirePort(resolvePorts()?.listArtifactsFn, 'list_artifacts')(),
    /**
     * UA3.5 — `create_board_task`: the SAME host closure Pi and Claude reach in process (`createBoardTaskFn`), which
     * holds every restriction on the caller (its folder, project, sources and connection; no mode) and the create
     * core. No second gate here (property 3 above).
     *
     * The payload is NARROWED to the tool's declared fields on `sessionList`'s rule: a missing `title` or
     * `description`, or a field of the wrong type, is MALFORMED (400) — the tool schema cannot produce one. A blank
     * string is not malformed: the closure refuses it with the sentence the model reads.
     */
    [HOST_CALLBACK_BRIDGE_ROUTES.taskCreate]: async payload => {
      const record = asRecord(payload);
      if (typeof record.title !== 'string' || typeof record.description !== 'string') {
        throw new BridgeRequestError('host callback bridge: task/create needs a title and a description', 400);
      }
      const input: CreateBoardTaskInput = { title: record.title, description: record.description };
      for (const field of ['acceptanceCriteria', 'llmConnection', 'model', 'workingDirectory', 'projectId'] as const) {
        const value = record[field];
        if (value === undefined) continue;
        if (typeof value !== 'string') {
          throw new BridgeRequestError(`host callback bridge: task/create ${field} must be a string`, 400);
        }
        input[field] = value;
      }
      for (const field of ['sources', 'skills'] as const) {
        const value = record[field];
        if (value === undefined) continue;
        if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
          throw new BridgeRequestError(`host callback bridge: task/create ${field} must be a list of strings`, 400);
        }
        input[field] = value as string[];
      }
      return requirePort(resolvePorts()?.createBoardTaskFn, 'create_board_task')(input);
    },
    /**
     * UA6.3 — the six page tools: the SAME grouped host closure Pi and Claude reach in process (the registry slot
     * `pages`, `SessionManager.pagesToolCallbacksForAgent`), bound to the CALLER's workspace — the body never names
     * one. Storage, the `pages:changed` push and `delete_page`'s one-shot card live in the closure; no second gate
     * here (property 3 above). Each payload is NARROWED to the tool's declared fields on `taskCreate`'s rule (a
     * missing slug or name, or a field of the wrong type, is MALFORMED: 400); a field the schema does not declare
     * (share state: output only) is dropped on the way in. UA8.2: `refresh` crosses as an OBJECT (or null on update);
     * its fields are validated by the host closure (`setPageRefresh`, strict), the one authority for all three runtimes.
     */
    [HOST_CALLBACK_BRIDGE_ROUTES.pageList]: async () =>
      requirePort(resolvePorts()?.pages, 'list_pages').listPages(),
    [HOST_CALLBACK_BRIDGE_ROUTES.pageGet]: async payload => {
      const record = asRecord(payload);
      const slug = requirePageSlug(record, 'page/get');
      if (record.includeContent !== undefined && typeof record.includeContent !== 'boolean') {
        throw new BridgeRequestError('host callback bridge: page/get includeContent must be a boolean', 400);
      }
      return requirePort(resolvePorts()?.pages, 'get_page').getPage(slug, { includeContent: record.includeContent === true });
    },
    [HOST_CALLBACK_BRIDGE_ROUTES.pageCreate]: async payload => {
      const record = asRecord(payload);
      if (typeof record.name !== 'string') {
        throw new BridgeRequestError('host callback bridge: page/create needs a name', 400);
      }
      const input: CreatePageToolInput = { name: record.name };
      for (const field of ['description', 'kind', 'projectId', 'content'] as const) {
        const value = record[field];
        if (value === undefined) continue;
        if (typeof value !== 'string') {
          throw new BridgeRequestError(`host callback bridge: page/create ${field} must be a string`, 400);
        }
        input[field] = value;
      }
      if (record.refresh !== undefined) input.refresh = requirePageRefreshObject(record.refresh, 'page/create'); // UA8.2
      return requirePort(resolvePorts()?.pages, 'create_page').createPage(input);
    },
    [HOST_CALLBACK_BRIDGE_ROUTES.pageUpdate]: async payload => {
      const record = asRecord(payload);
      const slug = requirePageSlug(record, 'page/update');
      const patch = asRecord(record.patch);
      const narrowed: UpdatePageToolPatch = {};
      for (const field of ['name', 'kind', 'content'] as const) {
        const value = patch[field];
        if (value === undefined) continue;
        if (typeof value !== 'string') {
          throw new BridgeRequestError(`host callback bridge: page/update ${field} must be a string`, 400);
        }
        narrowed[field] = value;
      }
      for (const field of ['description', 'projectId'] as const) {
        const value = patch[field];
        if (value === undefined) continue;
        if (value !== null && typeof value !== 'string') {
          throw new BridgeRequestError(`host callback bridge: page/update ${field} must be a string or null`, 400);
        }
        narrowed[field] = value;
      }
      if (patch.refresh !== undefined) narrowed.refresh = patch.refresh === null ? null : requirePageRefreshObject(patch.refresh, 'page/update'); // UA8.2
      return requirePort(resolvePorts()?.pages, 'update_page').updatePage(slug, narrowed);
    },
    [HOST_CALLBACK_BRIDGE_ROUTES.pageWriteData]: async payload => {
      const record = asRecord(payload);
      const slug = requirePageSlug(record, 'page/write-data');
      return requirePort(resolvePorts()?.pages, 'write_page_data').writePageData(slug, narrowPageDataPatch(record.patch));
    },
    [HOST_CALLBACK_BRIDGE_ROUTES.pageDelete]: async payload => {
      const slug = requirePageSlug(asRecord(payload), 'page/delete');
      return requirePort(resolvePorts()?.pages, 'delete_page').deletePage(slug);
    },
    /**
     * UB1.12 — `project_memory_append`: the SAME host closure Pi and Claude reach in process
     * (`appendProjectMemoryFn`), which reads the caller's project, builds the dated heading naming the session, and
     * does the ONE `appendFileSync` write. No second gate here (property 3 above). The payload is NARROWED to the
     * tool's one declared field on `taskCreate`'s rule: a missing or non-string `note` is MALFORMED (400) — the tool
     * schema cannot produce one. An empty string is not malformed: the closure refuses it with the sentence the
     * model reads, exactly as on Pi and Claude.
     */
    [HOST_CALLBACK_BRIDGE_ROUTES.projectMemoryAppend]: async payload => {
      const record = asRecord(payload);
      if (typeof record.note !== 'string') {
        throw new BridgeRequestError('host callback bridge: project-memory/append needs a note', 400);
      }
      const input: ProjectMemoryAppendInput = { note: record.note };
      return requirePort(resolvePorts()?.appendProjectMemoryFn, 'project_memory_append')(input);
    },
    /**
     * UB7.11 — `source_list_prompts` / `source_get_prompt`: the SAME grouped host
     * closure (`mcpSources`) Pi and Claude reach in process, which checks the
     * source is enabled and connected, reads the session's pool, renders the
     * prompt and runs the large-result guard. No second gate here (property 3
     * above). Payloads are NARROWED to the tools' declared fields on
     * `taskCreate`'s rule: a missing or non-string `sourceSlug` / `name` is
     * MALFORMED (400) — the tool schemas cannot produce one. The optional
     * `arguments` record keeps only its string values; anything else is
     * malformed, exactly what the schema refuses.
     */
    [HOST_CALLBACK_BRIDGE_ROUTES.sourceListPrompts]: async payload => {
      const record = asRecord(payload);
      if (typeof record.sourceSlug !== 'string') {
        throw new BridgeRequestError('host callback bridge: source/prompts/list needs a sourceSlug', 400);
      }
      return requirePort(resolvePorts()?.mcpSources, 'source_list_prompts').listPrompts(record.sourceSlug);
    },
    [HOST_CALLBACK_BRIDGE_ROUTES.sourceGetPrompt]: async payload => {
      const record = asRecord(payload);
      if (typeof record.sourceSlug !== 'string' || typeof record.name !== 'string') {
        throw new BridgeRequestError('host callback bridge: source/prompts/get needs a sourceSlug and a name', 400);
      }
      let args: Record<string, string> | undefined;
      if (record.arguments !== undefined) {
        const raw = asRecord(record.arguments);
        args = {};
        for (const [key, value] of Object.entries(raw)) {
          if (typeof value !== 'string') {
            throw new BridgeRequestError(`host callback bridge: source/prompts/get arguments.${key} must be a string`, 400);
          }
          args[key] = value;
        }
      }
      return requirePort(resolvePorts()?.mcpSources, 'source_get_prompt').getPrompt(record.sourceSlug, record.name, args);
    },
    /**
     * UB6.11 — `decide` (upstream v0.15.1; OQ-43.5 (a)). The body is the tool's
     * own request ({state | items, questions, deadlineMs}), never whose session
     * asks; the resolution, the fail-closed "not enabled" answer and the
     * decision record are the closure's. The payload is narrowed to a record —
     * the tool schema cannot produce anything else, and the closure validates
     * the rest before anything leaves the process.
     */
    [HOST_CALLBACK_BRIDGE_ROUTES.decide]: async payload => {
      const record = asRecord(payload);
      return requirePort(resolvePorts()?.decide, 'decide').decide(record as never);
    },
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const reply = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      const route = (req.url ?? '').split('?')[0] ?? '';
      const handler = req.method === 'POST' ? handlers[route] : undefined;
      if (!handler) {
        reply(404, { error: `host callback bridge: no route ${req.method} ${route}` });
        return;
      }

      let request: HostCallbackBridgeRequest;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > MAX_BODY_BYTES) throw new Error('request body too large');
          chunks.push(chunk as Buffer);
        }
        request = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as HostCallbackBridgeRequest;
      } catch (error) {
        reply(400, { error: `host callback bridge: unreadable request — ${error instanceof Error ? error.message : String(error)}` });
        return;
      }

      // Owner check FIRST, before a port is resolved let alone called.
      if (request?.sessionId !== options.sessionKey.sessionId) {
        options.onDiagnostic?.(
          `[codex-callback-bridge] rejected a request for a foreign session id on ${route}`,
        );
        reply(403, { error: HOST_CALLBACK_BRIDGE_SESSION_MISMATCH });
        return;
      }

      try {
        // F1.493 (2) — the handler runs as the codex tool call the body names (`origin`: codex's `_meta.callId` and
        // `_meta.threadId`), so a host card it raises is bound to the thread that raised it — a spawned subagent's
        // card to that subagent rather than to whichever parent turn happens to be running (F1.475's claude shape).
        // F1.631 — the origin's `turnId` (the `_meta["x-codex-turn-metadata"].turn_id` the body copies flat) rides
        // too, so the raise sites can refuse a main-thread card whose turn ended while the raise was in flight.
        // The origin is read only AFTER the owner check above, and only for this bridge's own session; a body that
        // names none runs with no scope at all, exactly as before.
        const origin = hostCallbackBridgeCallOriginOf(request.origin);
        const result = await runInSessionToolCall(
          origin
            ? {
                sessionId: options.sessionKey.sessionId,
                toolUseId: origin.callId,
                ...(origin.threadId ? { threadId: origin.threadId } : {}),
                ...(origin.turnId ? { turnId: origin.turnId } : {}),
              }
            : undefined,
          () => handler(request.payload),
        );
        reply(200, { result: result === undefined ? null : result });
      } catch (error) {
        // A malformed request carries its own status (400); a well-formed but
        // refused one stays 200 `{ error }` for the tool to re-throw as text.
        if (error instanceof BridgeRequestError) {
          reply(error.status, { error: error.message });
          return;
        }
        reply(200, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  const port = await listenOnLoopbackWithRetry(server, options.onDiagnostic);
  options.onDiagnostic?.(`[codex-callback-bridge] listening on 127.0.0.1:${port}`);

  return {
    port,
    close: () => new Promise<void>(resolveClose => {
      // `closeAllConnections` so a subprocess that died mid-request cannot hold
      // the session's teardown open; `close` alone waits for keep-alive sockets.
      server.closeAllConnections?.();
      server.close(() => resolveClose());
    }),
  };
}

// F1.493 (2) — appended so no cited line of this file moves; imports are hoisted.
import { runInSessionToolCall } from '../claude/session-tool-call-origin.ts';

/**
 * UA1.3 — the four registry slots `set_session_status` / `set_session_labels` resolve over the bridge, the SAME ones
 * the Pi and Claude in-process paths read (`resolveStatusFn`, `setSessionStatusFn`, `resolveLabelsFn`,
 * `setSessionLabelsFn`). Declared here and intersected into `resolvePorts` above so no cited line of this file moves.
 */
type SessionSelfManagementBridgePorts = Pick<
  SessionScopedToolCallbacks,
  'resolveStatusFn' | 'setSessionStatusFn' | 'resolveLabelsFn' | 'setSessionLabelsFn'
>;
import type { SessionScopedToolCallbacks } from '../../session-scoped-tool-callback-registry.ts';

/**
 * UA1.18 — the two registry slots `publish_artifact` / `list_artifacts` resolve over the bridge, the SAME ones the Pi
 * and Claude in-process paths read. Declared here and intersected into `resolvePorts` above so no cited line moves.
 */
type SessionArtifactBridgePorts = Pick<SessionScopedToolCallbacks, 'publishArtifactFn' | 'listArtifactsFn'>;
import type { PublishArtifactInput } from '@nessy-agent/session-tools-core'; // UA1.18 — appended, hoisted

/**
 * UA3.5 — the registry slot `create_board_task` resolves over the bridge, the SAME one the Pi and Claude in-process
 * paths read. Declared here and intersected into `resolvePorts` above so no cited line moves.
 */
type SessionBoardTaskBridgePorts = Pick<SessionScopedToolCallbacks, 'createBoardTaskFn'>;
import type { CreateBoardTaskInput } from '@nessy-agent/session-tools-core'; // UA3.5 — appended, hoisted

/**
 * UB1.12 — the registry slot `project_memory_append` resolves over the bridge, the SAME one the Pi and Claude
 * in-process paths read. Declared here and intersected into `resolvePorts` above so no cited line moves.
 */
type SessionProjectMemoryBridgePorts = Pick<SessionScopedToolCallbacks, 'appendProjectMemoryFn'>;
import type { ProjectMemoryAppendInput } from '@nessy-agent/session-tools-core'; // UB1.12 — appended, hoisted

/**
 * UB7.11 — the registry slot the MCP prompt pair resolves over the bridge
 * (`mcpSources`), the SAME one the Pi and Claude in-process paths read.
 * Declared here and intersected into `resolvePorts` above so no cited line moves.
 */
type SessionMcpSourcesBridgePorts = Pick<SessionScopedToolCallbacks, 'mcpSources'>;

/**
 * UB6.11 — the registry slot `decide` resolves over the bridge (`ctx.decide`),
 * the SAME one the Pi and Claude in-process paths read, bound by SessionManager
 * only when the decision layer is configured. Unbound ⇒ `requirePort` refuses
 * with the honest sentence — and the spawn's `--decide-port` offer flag keeps
 * the tool unadvertised in exactly that case, so the refusal is the second
 * belt, not the first.
 */
type SessionDecideBridgePorts = Pick<SessionScopedToolCallbacks, 'decide'>;

/**
 * UA6.3 — the registry slot the six page tools resolve over the bridge (`pages`), the SAME one the Pi and Claude
 * in-process paths read. Declared here and intersected into `resolvePorts` above so no cited line moves.
 */
type SessionPagesBridgePorts = Pick<SessionScopedToolCallbacks, 'pages'>;
import type { CreatePageToolInput, PageDataToolPatch, UpdatePageToolPatch, PageToolRefreshInput } from '@nessy-agent/session-tools-core'; // UA6.3 — appended, hoisted (UA8.2: PageToolRefreshInput)

/** UA6.3 — every page route names its page by `slug`; a missing or non-string one is MALFORMED (400). */
function requirePageSlug(record: Record<string, unknown>, route: string): string {
  if (typeof record.slug !== 'string') {
    throw new BridgeRequestError(`host callback bridge: ${route} needs a slug`, 400);
  }
  return record.slug;
}

/**
 * UA6.3 — `write_page_data`'s batch, narrowed to `PageDataToolPatch`'s four members with their declared shapes (the
 * tool schema cannot produce another). The values of `set` stay any JSON, as the schema declares; the host's
 * `writePageData` enforces the store's own limits (key count, sizes) with the sentence the model reads.
 */
function narrowPageDataPatch(value: unknown): PageDataToolPatch {
  const patch = asRecord(value);
  const out: PageDataToolPatch = {};
  const isPlainObject = (entry: unknown): entry is Record<string, unknown> =>
    Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry);
  const malformed = (field: string, shape: string): never => {
    throw new BridgeRequestError(`host callback bridge: page/write-data ${field} must be ${shape}`, 400);
  };
  if (patch.set !== undefined) {
    if (!isPlainObject(patch.set)) malformed('set', 'an object');
    out.set = patch.set as Record<string, unknown>;
  }
  if (patch.delete !== undefined) {
    if (!Array.isArray(patch.delete) || patch.delete.some(key => typeof key !== 'string')) malformed('delete', 'a list of strings');
    out.delete = patch.delete as string[];
  }
  if (patch.appendSeries !== undefined) {
    if (!isPlainObject(patch.appendSeries)) malformed('appendSeries', 'an object of point lists');
    const series: Record<string, Array<{ t?: number; v: number }>> = {};
    for (const [name, points] of Object.entries(patch.appendSeries as Record<string, unknown>)) {
      if (!Array.isArray(points)) malformed('appendSeries', 'an object of point lists');
      series[name] = (points as unknown[]).map(point => {
        if (!isPlainObject(point) || typeof point.v !== 'number' || (point.t !== undefined && typeof point.t !== 'number')) {
          return malformed('appendSeries', 'points of { t?: number, v: number }');
        }
        return point.t === undefined ? { v: point.v } : { t: point.t, v: point.v };
      });
    }
    out.appendSeries = series;
  }
  if (patch.pruneSeries !== undefined) {
    if (!isPlainObject(patch.pruneSeries) || Object.values(patch.pruneSeries).some(cutoff => typeof cutoff !== 'number')) {
      malformed('pruneSeries', 'an object of numbers');
    }
    out.pruneSeries = patch.pruneSeries as Record<string, number>;
  }
  return out;
}

/**
 * UA8.2 — a page `refresh` on the bridge must be a JSON object (its fields are the host closure's to validate, strict:
 * `setPageRefresh` refuses an upstream-shaped script PATH); anything else is MALFORMED (400), as the other fields.
 */
function requirePageRefreshObject(value: unknown, route: string): PageToolRefreshInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeRequestError(`host callback bridge: ${route} refresh must be an object`, 400);
  }
  return value as PageToolRefreshInput;
}

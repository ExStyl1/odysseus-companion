/**
 * UA4.1 — `SessionConductorHost`: the Tasks Conductor's host, built over OUR SessionManager (Nessy-only; upstream
 * v0.13.4 handed its SessionManager to `TaskRunner` structurally, which ours cannot satisfy — spec §5 "The Conductor
 * host adapter", §11 "Conductor").
 *
 * Native-first (plan UA4.1): Claude `Workflow`, codex `spawn_agent` and Pi `Workflow` each work inside ONE runtime
 * and one session; none is cross-session, durable and host-observable, so the host is the layer that runs a DAG
 * across all three. Each node is an ordinary session of the orchestrator's project on its own connection's runtime.
 *
 * What the adapter decides (each is one method below):
 *
 * - **Delivery, not the turn** ({@link createSessionConductorHost} `sendMessage`). Our `sendMessage` resolves when the
 *   turn is OVER (upstream's too), so awaiting it would serialise `max_parallel`. Every Conductor send is queue mode
 *   (`midStreamOverride: 'queue'`, P6.480 — no runtime steers a Conductor message into a live turn) and is raced on
 *   `onAck`, over the three arms `runWorktreeBatch` names (C3.328): the ack → delivered (resolve); the send RESOLVING
 *   with no ack (a slash-command arm that returned early) → "prompt not delivered" (reject); a rejection before the
 *   ack → reject with it; a rejection AFTER the ack is a turn that failed, whose outcome arrives through
 *   `onSessionComplete` — logged here and never reported twice. UA12.50: a rejection after the ack that never
 *   reaches `onProcessingStopped` (a throw in the window between the ack and the turn) emits no completion, and the
 *   node stayed `running` forever (upstream has no node timeout either). So the send watches its session's
 *   completions, and {@link AFTER_DELIVERY_FAILURE_GRACE_MS} after such a rejection re-reads it: no completion seen
 *   and the session idle (or gone) → the host reports ONE synthetic `reason: 'error'` completion to its own
 *   listeners. Not a node deadline — a healthy node may run for hours, and a running turn always ends in
 *   `onProcessingStopped`. Residue, stated: a rejection that leaves the session marked processing waits for that
 *   turn (Stop ends it).
 * - **The child's folder is the orchestrator's** (`getSessionProjectHandleId`): the orchestrator's stored working
 *   directory goes through `ProjectHandleService` (the sole raw-path ingress) and the child is created with that
 *   handle; `spec.cwd` never reaches `createSession`. A folder that no longer validates REFUSES the dispatch (the
 *   node fails with the reason) — it never falls back to another folder.
 * - **`session_created` for children** (`createSession`): our `createSession` does not announce (upstream's did), so
 *   the adapter calls `SessionManager.announceSessionCreated` once the child exists.
 * - **The settlement gate** (`isSessionSettled`): the runtime-neutral settlement `getPiHarnessRuntimeSnapshot` answers
 *   on all three runtimes (P2.2/P2.17: turn, supervised processes incl. `Monitor`, children, pending cards), no
 *   ACTIVE goal, and no cron or background task in `listSessionScheduledWork` (the registry the `Stop` hook's
 *   `background_tasks`/`session_crons` come from). A read that fails is NOT settled (fail-closed: the node waits for
 *   the next idle door). UA4.8 adds the backend's between-turns activity (`getBackendBackgroundActivity`: a Claude
 *   background task, a codex terminal) and reads a background shell from its producer, not from its registry entry
 *   (which latched until UA12.101); `TaskRunner` re-checks a deferred door (its header item 14), and a host delivery turn that is due
 *   or running (`hasHostTurnDueOrRunning`) defers it, so that re-check never lands between a Pi background task's end
 *   and the turn that delivers it. Follow-up 3: the turn a Claude CLI opens itself to deliver a task's end is
 *   counted too (`ClaudeAgent.backgroundActivityCount` adds its F1.509 marker), so dependents never run beside it.
 *   UA12.99: a codex `spawn_agent` child left running after its turn counts too (`CodexAgent.backgroundActivityCount`:
 *   codex queues its result for the parent's NEXT turn and starts none), but its report is not the node's output.
 *   UA12.100: that Claude reply IS the node's output — a settled re-check takes a final message written after the door
 *   (`getSessionFinalMessage`, `TaskRunner` header item 4). Stated, not measured: a codex
 *   terminal spawned in a node's last turn is counted once the turn-end `thread/backgroundTerminals/list` refresh
 *   lands (fire-and-forget, skipped within 30 s of the previous one), so a door read before it completes the node.
 * - **The running status** (`hasSessionStatus`): the workspace's own status list (`isValidStatusId`).
 *
 * Plugins (owner 2026-09-24): a node is created like any session of the orchestrator's project — no `plugins`
 * option, no plugin field — so its plugins, their MCP servers, skills, agents and hooks come from the host
 * capability snapshot exactly as for a new session there (workspace + project enablement); the orchestrator's
 * session-scoped plugins (D1.69) are keyed by ITS session id and do not pass. Node `sources` select WORKSPACE source
 * records only: plugin and native MCP servers are exempt from session selection and follow activation alone
 * (`bootstrap/storage-runtime.ts`, the `sessionSelection` block — measured 2026-10-02, UA4.1).
 */
import type { PermissionMode } from '@nessy-agent/shared/agent/mode-types'
import type { BackendHostRuntimeContext } from '@nessy-agent/shared/agent/backend'
import type { CreateSessionOptions } from '@nessy-agent/shared/protocol'
import { isValidStatusId } from '@nessy-agent/shared/statuses'
import type { TaskSpec } from '@nessy-agent/shared/tasks'
import { createLogger } from '@nessy-agent/shared/utils'
import type { ISessionManager } from '../handlers/session-manager-interface'
import type { SessionCompletionEvent } from '../sessions/SessionManager'
import { resolveTaskFolderHandle } from './create-task'
import { assertNodesHostable } from './node-hostability'
import { TaskRunner, type ConductorSessionHost, type TaskRunnerDeps } from './TaskRunner'

const log = createLogger('tasks-conductor')

/** The SessionManager surface the Conductor host reads — {@link ISessionManager} (and `SessionManager`) satisfy it. */
export type ConductorSessionManager = Pick<
  ISessionManager,
  | 'createSession'
  | 'sendMessage'
  | 'setSessionStatus'
  | 'setKanbanColumn'
  | 'cancelProcessing'
  | 'onSessionComplete'
  | 'getSessions'
  | 'getPiHarnessRuntimeSnapshot'
  | 'getProjectHandleService'
  | 'listSessionScheduledWork'
  | 'getBackendBackgroundActivity'
  | 'hasHostTurnDueOrRunning'
> & {
  /** UA3.1 `SessionManager.setTaskNodeCount`. */
  setTaskNodeCount(sessionId: string, count: number | null, workspaceId?: string): Promise<void>
  /** UA4.1 `SessionManager.announceSessionCreated` (`session_created` for a background-created session). */
  announceSessionCreated(sessionId: string, workspaceId: string): void
  /** UA12.75 `SessionManager.withdrawAbandonedTaskChildApproval` (TaskRunner header item 13). Absent → nothing withdrawn. */
  withdrawAbandonedTaskChildApproval?(sessionId: string, workspaceId: string): Promise<boolean>
  /** UA12.100 `SessionManager.getSessionFinalText` (the newest final message, NOT turn-scoped). Absent → no reader. */
  getSessionFinalText?(sessionId: string, workspaceId?: string): string | undefined
}

export interface SessionConductorHostOptions {
  workspaceId: string
  /** The workspace root (`rootPath`): where `tasks/` and `statuses/` live. */
  workspaceRoot: string
  /** UA12.50 test seam: the re-read delay after a post-ack rejection; default {@link AFTER_DELIVERY_FAILURE_GRACE_MS}. */
  afterDeliveryFailureGraceMs?: number
}

/** The error a send that resolved with no ack raises (the node fails "not delivered"). */
export const PROMPT_NOT_DELIVERED = 'prompt not delivered'

/**
 * UA12.50 (module header) — how long after a delivered send REJECTS the host waits for that turn's own completion
 * before reading the session: five seconds, the Conductor's existing re-read latency (`SETTLEMENT_RECHECK_MS`). The
 * completion is emitted by `onProcessingStopped`, which the chat loop awaits before its rejecting `finally`
 * (`flushBeforeTurnEndEvent`'s docblock), so it normally lands first; the grace covers only an emission racing it.
 */
export const AFTER_DELIVERY_FAILURE_GRACE_MS = 5_000

/** Build the {@link ConductorSessionHost} of one workspace over a SessionManager (module header). */
export function createSessionConductorHost(
  sessionManager: ConductorSessionManager,
  options: SessionConductorHostOptions,
): ConductorSessionHost {
  const { workspaceId, workspaceRoot } = options
  const session = (sessionId: string) => sessionManager.getSessions(workspaceId).find(s => s.id === sessionId)
  /** UA12.50 — the host's own listeners, which alone receive a synthetic completion (module header). */
  const syntheticListeners = new Set<(evt: SessionCompletionEvent) => void>()

  return {
    async createSession(_workspaceId: string, createOptions: CreateSessionOptions): Promise<{ id: string }> {
      // Always THIS workspace: the runner's own id is the same, and a child never lands in another one.
      const created = await sessionManager.createSession(workspaceId, createOptions)
      sessionManager.announceSessionCreated(created.id, workspaceId)
      return { id: created.id }
    },

    sendMessage(sessionId: string, message: string): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        let acked = false
        // UA12.50: whether this session reported a completion since the send began (the post-ack re-read below).
        let completed = false
        const offWatch = sessionManager.onSessionComplete(evt => {
          if (evt.sessionId === sessionId && evt.workspaceId === workspaceId) completed = true
        })
        sessionManager.sendMessage(
          sessionId,
          message,
          undefined,
          undefined,
          { midStreamOverride: 'queue' },
          undefined,
          undefined,
          () => {
            acked = true
            resolve()
          },
          { workspaceId },
        ).then(
          () => {
            offWatch()
            if (!acked) reject(new Error(PROMPT_NOT_DELIVERED))
          },
          (error: unknown) => {
            if (!acked) {
              offWatch()
              reject(error instanceof Error ? error : new Error(String(error)))
              return
            }
            // Delivered, then the turn failed: its completion reports it (once). Logged, never re-reported.
            log.warn('Conductor turn failed after delivery; its outcome arrives through onSessionComplete', {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            })
            // UA12.50: unless that completion arrives, or a turn is still running there, report the failure once.
            const timer = setTimeout(() => {
              offWatch()
              if (completed || session(sessionId)?.isProcessing) return
              log.warn('Conductor turn failed after delivery with no completion; reporting it as an error', { sessionId })
              const synthetic: SessionCompletionEvent = { sessionId, workspaceId, reason: 'error' }
              for (const listener of [...syntheticListeners]) {
                try {
                  listener(synthetic)
                } catch (err) {
                  log.warn('Conductor completion listener threw on a synthetic completion', { sessionId, error: String(err) })
                }
              }
            }, options.afterDeliveryFailureGraceMs ?? AFTER_DELIVERY_FAILURE_GRACE_MS)
            ;(timer as { unref?: () => void }).unref?.()
          },
        )
      })
    },

    setSessionStatus: (sessionId, status) => sessionManager.setSessionStatus(sessionId, status, workspaceId),
    setKanbanColumn: (sessionId, column) => sessionManager.setKanbanColumn(sessionId, column, workspaceId),
    setTaskNodeCount: (sessionId, count) => sessionManager.setTaskNodeCount(sessionId, count, workspaceId),
    cancelProcessing: (sessionId, silent) => sessionManager.cancelProcessing(sessionId, silent, workspaceId),

    onSessionComplete(listener) {
      syntheticListeners.add(listener)
      const off = sessionManager.onSessionComplete(evt => {
        if (evt.workspaceId !== workspaceId) return
        listener(evt)
      })
      return () => {
        syntheticListeners.delete(listener)
        off()
      }
    },

    async getSessionProjectHandleId(sessionId: string): Promise<string | undefined> {
      const orchestrator = session(sessionId)
      if (!orchestrator) throw new Error('task-orchestrator-missing')
      if (!orchestrator.workingDirectory) return undefined
      const handles = sessionManager.getProjectHandleService?.()
      if (!handles) throw new Error('project-handle-service-unavailable')
      const bound = await handles.resolveHandle({ workspaceId, sessionId })
      if (bound) return bound.id
      // The orchestrator's binding is gone (a restart, an expired handle): re-issue from its stored folder through
      // the one raw-path ingress. A folder that fails validation throws — the node fails, never runs elsewhere.
      const issued = await handles.validateProjectDirectory(workspaceId, orchestrator.workingDirectory)
      return issued.id
    },

    getSessionProjectId: (sessionId: string) => session(sessionId)?.projectId,
    // UA4.2: an orchestrator whose record carries no mode runs as `default` (the host reads an unset mode so
    // everywhere: `managed.permissionMode ?? 'default'`), so that is its nodes' ceiling — never no ceiling, which
    // let a task.yaml's `bypassPermissions` through unclamped. Undefined only when the session is not there.
    getSessionPermissionMode: (sessionId: string): PermissionMode | undefined => {
      const orchestrator = session(sessionId)
      return orchestrator ? (orchestrator.permissionMode ?? 'default') : undefined
    },

    async isSessionSettled(sessionId: string): Promise<boolean> {
      try {
        const runtime = await sessionManager.getPiHarnessRuntimeSnapshot({ workspaceId, sessionId })
        if (!runtime.settlement.settled) return false
        if (runtime.goal?.status === 'active') return false
        const work = sessionManager.listSessionScheduledWork?.(sessionId, workspaceId)
        if (!work) return false
        if (work.crons.length > 0) return false
        // UA4.8: a `shell` entry is read from its producer, never from the registry, where it LATCHED for every shell
        // no supervisor record proves ended (L7: a Claude SDK task id, a codex terminal id) — that kept a node
        // `running` for good; UA12.101 retires those on the runtime's own end, which can still trail the producer.
        // A supervised (Pi) shell is the settlement's running process above; a Claude or codex shell is the backend's
        // activity below.
        if (work.tasks.some(task => task.status === 'running' && task.type !== 'shell')) return false
        // UA4.8: the backend's own between-turns activity, which no host map records — a Claude background
        // `Agent`/`Workflow`/`Bash` (its SDK level, ambient tasks excluded) and a codex background terminal.
        // `undefined` = the host does not hold the session: not settled. A host without the method reads zero.
        if (sessionManager.getBackendBackgroundActivity) {
          const activity = sessionManager.getBackendBackgroundActivity(sessionId, workspaceId)
          if (activity === undefined || activity > 0) return false
        }
        // UA4.8 follow-up: a host delivery turn that is due but has not started (a Pi background task's R86 delivery:
        // its evaluator entry is gone before `setProcessing(true)`), or a turn that started while the snapshot above
        // was awaited. Read last, synchronously with the reads above, so a timer re-check never completes a node in
        // that window with its pre-background text.
        if (sessionManager.hasHostTurnDueOrRunning?.(sessionId, workspaceId)) return false
        return true
      } catch (error) {
        log.warn('Conductor settlement read failed; the node waits for the next idle door', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
        return false
      }
    },

    hasSessionStatus: (status: string) => isValidStatusId(workspaceRoot, status),

    // UA12.100 (TaskRunner header item 4): the newest final assistant message — its id from the session's
    // `lastFinalMessageId`, its text from `getSessionFinalText` — so a settled re-check can tell a reply written after
    // the door (the Claude CLI's own delivery turn) from the door's own text.
    getSessionFinalMessage(sessionId: string): { id: string; text: string } | undefined {
      const id = session(sessionId)?.lastFinalMessageId
      if (!id) return undefined
      const text = sessionManager.getSessionFinalText?.(sessionId, workspaceId)
      return text === undefined ? undefined : { id, text }
    },

    // UA12.75 (TaskRunner header item 13): an abandoned child's pending card is withdrawn (denied, nothing runs).
    async withdrawPendingApproval(sessionId: string): Promise<void> {
      try {
        const withdrawn = await sessionManager.withdrawAbandonedTaskChildApproval?.(sessionId, workspaceId)
        if (withdrawn) log.info('Conductor withdrew the pending card of an abandoned child', { sessionId })
      } catch (error) {
        log.warn('Conductor could not withdraw the pending card of an abandoned child', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}

export interface ConductorPreflightOptions {
  sessionManager: Pick<ISessionManager, 'getProjectHandleService'>
  workspaceId: string
  /** `buildBackendHostRuntimeContext(platform)` — what {@link assertNodesHostable} resolves binaries against. */
  hostRuntime: BackendHostRuntimeContext
  /** The workspace default connection slug (`defaults.defaultLlmConnection`). */
  workspaceDefaultConnection?: string
  /** Test seam; default UA1.7's {@link assertNodesHostable}. */
  assertHostable?: typeof assertNodesHostable
}

/**
 * The preflight every run and every resume passes before its first dispatch (TaskRunner header item 10):
 * (1) every node's connection can host it — UA1.7, a refusal names the node, the connection and the reason;
 * (2) `spec.cwd`, when the spec names one, still resolves through `ProjectHandleService` to a TRUSTED folder
 * (`resolveTaskFolderHandle`: `task-cwd-untrusted` / `project-handle-invalid`). The folder children run in is the
 * orchestrator's either way; this refuses a run whose saved yaml now points at a folder nobody trusted.
 */
export function createConductorPreflight(options: ConductorPreflightOptions): NonNullable<TaskRunnerDeps['preflight']> {
  const assertHostable = options.assertHostable ?? assertNodesHostable
  return async (spec: TaskSpec) => {
    await assertHostable(spec, {
      hostRuntime: options.hostRuntime,
      workspaceDefaultConnection: options.workspaceDefaultConnection,
    })
    if (spec.cwd) {
      await resolveTaskFolderHandle(options.sessionManager.getProjectHandleService?.(), options.workspaceId, { cwd: spec.cwd })
    }
  }
}

export interface ConductorRunnerOptions extends SessionConductorHostOptions {
  /** The preflight ({@link createConductorPreflight}); a runner without one dispatches unchecked (tests only). */
  preflight?: TaskRunnerDeps['preflight']
  /** UB6.6 — the decision-model verdict reader (`buildTaskVerdictDecider`); absent in tests → re-ask as before. */
  decide?: TaskRunnerDeps['decide']
  /** UB6.6 — the decision-model repair scoper (`buildRepairScopePicker`); absent → the whole frontier. */
  pickRepairNodes?: TaskRunnerDeps['pickRepairNodes']
  /** UB6.7 — the child-node outcome classifier (`buildNodeOutcomeClassifier`); absent → marked done as before. */
  classifyNodeOutcome?: TaskRunnerDeps['classifyNodeOutcome']
}

/** One runner per (SessionManager, workspace): an orchestrator's active-run guard lives in it. */
const runnersByManager = new WeakMap<object, Map<string, TaskRunner>>()

/**
 * The workspace's ONE {@link TaskRunner} over this SessionManager (plan UA4.1 "one runner per workspace"), created on
 * first use. Every caller (`tasks:run` / `resume` / `stop`, UA4.3) shares it, so "one active run per orchestrator" is
 * checked against every run of the workspace. Keyed by the manager object, so a test's manager never sees another's.
 */
export function getConductorRunner(sessionManager: ConductorSessionManager, options: ConductorRunnerOptions): TaskRunner {
  let byWorkspace = runnersByManager.get(sessionManager)
  if (!byWorkspace) {
    byWorkspace = new Map()
    runnersByManager.set(sessionManager, byWorkspace)
  }
  let runner = byWorkspace.get(options.workspaceId)
  if (!runner) {
    runner = new TaskRunner({
      host: createSessionConductorHost(sessionManager, options),
      workspaceId: options.workspaceId,
      workspaceRoot: options.workspaceRoot,
      ...(options.preflight ? { preflight: options.preflight } : {}),
      ...(options.decide ? { decide: options.decide } : {}),
      ...(options.pickRepairNodes ? { pickRepairNodes: options.pickRepairNodes } : {}),
      ...(options.classifyNodeOutcome ? { classifyNodeOutcome: options.classifyNodeOutcome } : {}),
    })
    byWorkspace.set(options.workspaceId, runner)
  }
  return runner
}

/**
 * UA3.4 — RPC handlers for durable Tasks. Adapted from craft-agents-oss
 * `v0.13.4:packages/server-core/src/handlers/rpc/tasks.ts` (Apache-2.0), rebranded (`@craft-agent` → `@nessy-agent`).
 *
 * Every v0.13.4 range is in (UA4.4 restored the last one, L313–L319, `tasks:run`, with the run confirmation below).
 *
 * Channels handled here (all REMOTE_ELIGIBLE — tasks are workspace content): `tasks:validate`, `create`, `generate`
 * (UA4.5, with its `tasks:generated` push), `run`,
 * `pause`, `resume`, `stop` (UA4.3), `get`, `list`, `getResults`, and our `delete`. The background-output read `tasks:getOutput` shares the namespace by
 * history only and stays in `rpc/sessions.ts` (spec §22 item 8).
 *
 * Stated divergences from v0.13.4 (spec §10, §19; plan UA3.4 "Adaptations"):
 * - Every handler runs `assertCallerWorkspace` (UA1.9) first, refusing `tasks-workspace-mismatch` (upstream: no
 *   caller check, spec §19 defect 4).
 * - A slug or run id from the wire is checked before it becomes a path (`task-slug-invalid`; an unknown run id
 *   reads as "no run").
 * - Folder ingress is a trusted project handle (`create-task.ts` header); `spec.cwd` that is not trusted is
 *   refused before anything is saved or created (`task-cwd-untrusted`).
 * - Create mode never overwrites another task (`task-slug-taken:<slug>`), on the fresh AND the adopt path, and two
 *   concurrent creates of one id cannot both pass: the slug is claimed until the create settles (`claimTaskSlug`).
 * - A REMOTE client may not create a task whose yaml mode is above the remote ceiling (F8, as `setPermissionMode`).
 * - Attach and adopt never move a session's folder (only `projects:setSessionProject` does), never RAISE its
 *   permission mode (clamped to the session's current one), and never switch the runtime of a session that has
 *   messages (`task-attach-connection-locked`) — `SessionManager.bindManagedSessionToTask`.
 * - `tasks:validate` also runs the Conductor's node-hostability preflight (UA1.7 `assertNodesHostable`); a node
 *   no connection can host is a validation ERROR naming it, not a thrown RPC error.
 * - `tasks:delete` is ours: it removes `tasks/<slug>/` only when no live (non-archived) session carries the slug
 *   (`task-slug-in-use`), through `deleteTaskFolder` — the path UA3.8's orchestrator delete cascade also takes.
 * - UA4.3 — the run controls use the workspace's ONE Conductor runner (`getConductorRunner`, upstream's per-handler
 *   `runners` map L94–L111 replaced), whose preflight reads the workspace's default connection on EVERY run and
 *   resume (the runner keeps the first preflight it is given). `tasks:run` requires the task's own orchestrator
 *   (`task-orchestrator-required` / `task-orchestrator-mismatch`: a live session carrying this slug that is not a
 *   node), so every child runs under an orchestrator's folder and mode ceiling (upstream: optional). A run id from the
 *   wire is a slug-shaped new id on `run` (`task-run-id-invalid`, `task-run-id-taken`) and one of the task's run ids
 *   on `pause` / `resume` / `stop` (`task-run-not-found`). `tasks:getResults`' `runStatus` is the live run's when the
 *   runner holds it, else the log's terminal one, else `interrupted` (spec §11 item 7: a restart is shown honestly,
 *   nothing is written at startup); `TaskRunner` header item 13 has the resume.
 * - UA4.5 — `tasks:generate` (spec §11 "Generate"; upstream's async shape, generate → one repair turn, nothing saved):
 *   the draft is `taskDraft: true` and NOT `hidden` (upstream: hidden — a hidden session's card has no window, and
 *   adopting a hidden draft would hide the task for good), so it is announced like a Conductor child. It authors in
 *   `dontAsk` whatever the request asks (`GENERATE_PERMISSION_MODE`, `@nessy-agent/shared/tasks/generate-limits`), and
 *   `tasks:create` gives an adopted draft the saved spec's mode — the editor's — as a fresh create would (the adopt
 *   lock clamps to the session's current mode, which for a draft is the host's authoring posture, not the user's;
 *   a spec with no mode leaves it in `dontAsk`). Its folder is a trusted project handle (`projectHandleId`, refused
 *   `task-cwd-untrusted` before any session exists; upstream: a raw `cwd`) — or, for an edit, the task orchestrator's
 *   (`orchestratorSessionId`, UA12.93: the folder its children run in, which a request handle cannot override; an unknown
 *   or archived orchestrator is refused `task-orchestrator-missing` before any session exists). Every send is the Conductor's queue-mode
 *   send raced on the ack (`createSessionConductorHost`), and an attempt reads THIS turn's `finalText` or nothing —
 *   no `getSessionFinalText` fallback (it answers with the previous turn's text). The limits are the shared constants
 *   the editor's fallback is derived from. On every runtime the draft's write is refused with no card (spec §11): on
 *   codex the `dontAsk` permission profile extends `:read-only` in both sandbox-switch positions (F1.1056), so a shell
 *   write is refused by the OS and a file change reaches our bridge and is declined; Pi and Claude refuse it in their
 *   gates (`tasks/__tests__/generate-dont-ask.test.ts`). The generator prompt asks for the YAML in the message only.
 * - UA4.4 — the HOST enforces the run confirmation (spec §10 "Run confirmation"; upstream has none): a run needs one
 *   whenever the `task.yaml` digest (`sha256:` of its bytes on disk) is not the last one a human saved or confirmed,
 *   as the MACed ledger (`approvals/host-approvals.ts`, kind `task-confirmation`, subject `task:<slug>`) records it.
 *   `tasks:create` records the saved bytes' digest on the editor's paths (a fresh create, an edit-mode attach); a save
 *   that carries a Generate draft (`orchestratorSessionId` set: an adoption, its fallback create, or an edit-mode
 *   attach, where attach wins and the draft is not adopted) records nothing, because an agent wrote its nodes, and
 *   `create_board_task` never reaches this handler. `tasks:get` returns
 *   `needsRunConfirmation` and, when it is true, `runConfirmation` (the digest to confirm and the plugins a node sees);
 *   `tasks:run` refuses `run-confirmation-required` unless the digest is confirmed or the request's `confirmedDigest`
 *   equals it, which it then records. A ledger key that cannot be read trusts no entry (every run asks) and records
 *   nothing. UA12.90 closed the residue: the digest this check read travels to `TaskRunner.run`
 *   (`RunOptions.confirmedDigest`), whose load hashes the bytes it reads and refuses the same
 *   `run-confirmation-required` on a mismatch — an edit landing between the check and the runner's read is refused
 *   and the task asks again (the run's spec snapshot still shows what ran).
 * - UA4.4 — `tasks:getResults` folds `node-scheduled` → running and `node-retry` → pending as `TaskRunner.hydrate`
 *   does (upstream read `node-finished` alone, so a node sent back showed its old state), and marks a node whose
 *   session worked again after it was done (`node-woke-after-done`, `wokeAfterDone`; `tasks:get` lists the latest
 *   run's such nodes for the tile badge).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { deleteTaskFolder } from '@nessy-agent/shared/tasks' // UA3.8 — the one task-folder removal path
import type { ISessionManager } from '../session-manager-interface'
import { findHostApproval, getHostApprovalsKeyProvider, recordHostApproval } from '@nessy-agent/shared/approvals/host-approvals'
import type { CapabilityContext } from '@nessy-agent/shared/capabilities/resolver'
import { withCapabilitySnapshot } from '@nessy-agent/shared/capabilities/resolver'
import { toUserCatalog } from '@nessy-agent/shared/capabilities/views'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type {
  CreateSessionOptions,
  TaskCreateRequest,
  TaskCreateResult,
  TaskDeleteResult,
  TaskGenerateAck,
  TaskGenerateRequest,
  TaskGetResult,
  TaskResultNodeDto,
  TaskResultsDto,
  TaskRunConfirmationDto,
  TaskRunRequest,
  TaskRunSnapshotDto,
  TaskValidationIssueDto,
  TaskValidationResultDto,
} from '@nessy-agent/shared/protocol'
import {
  DEFAULT_REPAIR_ATTEMPTS,
  GENERATE_PERMISSION_MODE,
  GENERATE_TIMEOUT_MS,
  GENERATE_IDLE_TIMEOUT_MS,
  GENERATE_ATTEMPT_MAX_MS,
  MAX_GENERATE_ATTEMPTS,
  MAX_REPAIR_ATTEMPTS_CAP,
  SLUG_RE,
  buildGeneratorPrompt,
  buildRepairPrompt,
  listRunIds,
  listTaskSlugs,
  loadTaskSpec,
  nodeTitle,
  parseTaskYaml,
  readNodeOutput,
  readRunLog,
  readRunSpecSnapshot,
  saveTaskSpec,
  taskYamlPath,
  type TaskSpec,
} from '@nessy-agent/shared/tasks'
import { pushTyped, type RpcServer } from '@nessy-agent/server-core/transport'
// UB6.6 — the decision-model hooks (each opens its own decision point per call, gated by the
// Settings switch + its feature toggle; `null` when the layer is off → today's behaviour).
import { buildTaskVerdictDecider } from '../../decisions/task-verdict'
import { buildRepairScopePicker } from '../../decisions/task-repairs'
import { buildNodeOutcomeClassifier } from '../../decisions/turn-outcome'
import { createLogger } from '@nessy-agent/shared/utils'
import { clampPermissionModeToParent, isPermissionModeAllowedForRemoteClient, REMOTE_CLIENT_PERMISSION_MODE_CEILING, type PermissionMode } from '@nessy-agent/shared/agent/mode-types'
import { isLocalClient } from '../../transport/capabilities'
import type { HandlerDeps } from '../handler-deps'
import { buildBackendHostRuntimeContext, getWorkspaceOrThrow } from '../utils'
import { assertCallerWorkspace } from './caller-workspace'
import {
  claimTaskSlug,
  createTaskFromSpec,
  finishTaskOrchestrator,
  resolveTaskFolderHandle,
} from '../../tasks/create-task'
import { assertNodesHostable } from '../../tasks/node-hostability'
import { resolveCapabilityContext } from '../../domain/capabilities/context'
import { createConductorPreflight, createSessionConductorHost, getConductorRunner } from '../../tasks/conductor-host'
import { isTerminalRunStatus, runStatusFromLog, type TaskRunner } from '../../tasks/TaskRunner'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.tasks.VALIDATE,
  RPC_CHANNELS.tasks.CREATE,
  RPC_CHANNELS.tasks.GENERATE,
  RPC_CHANNELS.tasks.RUN,
  RPC_CHANNELS.tasks.PAUSE,
  RPC_CHANNELS.tasks.RESUME,
  RPC_CHANNELS.tasks.STOP,
  RPC_CHANNELS.tasks.GET,
  RPC_CHANNELS.tasks.LIST,
  RPC_CHANNELS.tasks.GET_RESULTS,
  RPC_CHANNELS.tasks.DELETE,
] as const

/** The refusal every handler raises for a caller bound to another workspace (UA1.9). */
const WORKSPACE_MISMATCH = 'tasks-workspace-mismatch'

const generateLog = createLogger('tasks-generate')

/** Pull the YAML body out of an LLM reply (tolerate ```yaml fences or surrounding prose) — v0.13.4's, indexed safely. */
function extractYaml(text: string): string {
  const fenced = text.match(/```(?:ya?ml)?\s*\n?([\s\S]*?)```/i)
  return (fenced?.[1] ?? text).trim()
}

/** Map a shared ValidationResult (+ parsed spec) onto the wire DTO. */
function toValidationDto(result: ReturnType<typeof parseTaskYaml>): TaskValidationResultDto {
  const issue = (i: { path: string; message: string; severity: 'error' | 'warning'; suggestion?: string }) => ({
    path: i.path,
    message: i.message,
    severity: i.severity,
    ...(i.suggestion ? { suggestion: i.suggestion } : {}),
  })
  const sessionNodeCount = result.spec?.nodes.filter((n) => n.kind === 'session').length ?? 0
  return {
    valid: result.valid,
    errors: result.errors.map(issue),
    warnings: result.warnings.map(issue),
    estimate: result.spec ? { nodeCount: result.spec.nodes.length, sessionNodeCount } : undefined,
  }
}

function assertTaskSlug(slug: unknown): asserts slug is string {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new Error('task-slug-invalid')
}

/** UA4.3 — a run id from the wire names one of this task's runs before it becomes a path. */
function assertKnownRunId(root: string, slug: string, runId: unknown): asserts runId is string {
  if (typeof runId !== 'string' || !listRunIds(root, slug).includes(runId)) throw new Error(`task-run-not-found: ${String(runId)}`)
}

/** Test seam, as `registerProjectsHandlers` has one: the census tests register with two arguments. */
export interface TasksHandlerOptions {
  /** Default: UA1.7's `assertNodesHostable` against this host's runtime context. */
  assertNodesHostable?: typeof assertNodesHostable
  /** UA4.5 — one Generate attempt's wait; default {@link GENERATE_TIMEOUT_MS} (a test shortens it). Superseded by
   *  UB2.9's idle/cap pair below; kept for the option's shape until its last reader is gone. */
  generateTimeoutMs?: number
  /** UB2.9 (B4-14) — an authoring turn that shows no activity for this long fails as stalled. */
  generateIdleTimeoutMs?: number
  /** UB2.9 (B4-14) — one authoring turn's hard cap, activity or not. */
  generateAttemptMaxMs?: number
  /** UA4.4 — the host-approvals ledger key; default the installed provider's (`getHostApprovalsKeyProvider`). */
  hostApprovalsKey?: () => Promise<Buffer>
}

/** UA4.4 — the ledger subject of a task's last human-confirmed `task.yaml` digest. */
export function taskConfirmationSubject(slug: string): string {
  return `task:${slug}`
}

/** UA4.4 — `sha256:<hex>` of the task's `task.yaml` bytes on disk; null when there is none. */
export function taskYamlDigest(workspaceRoot: string, slug: string): string | null {
  const path = taskYamlPath(workspaceRoot, slug)
  if (!existsSync(path)) return null
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

/**
 * UA4.4 — each node of a run as the run confirmation names it: its model and connection as `TaskRunner.dispatch`
 * resolves them (node → spec default; no connection = the workspace default, which the renderer names), and its
 * EFFECTIVE mode — node → spec default → the orchestrator's, never above the orchestrator's (the same rule).
 */
function confirmationNodes(spec: TaskSpec, ceiling: PermissionMode | undefined): TaskRunConfirmationDto['nodes'] {
  return spec.nodes.map((node) => {
    const model = node.model ?? spec.defaults?.model
    const llmConnection = node.llmConnection ?? spec.defaults?.llmConnection
    const requested = node.permissionMode ?? spec.defaults?.permissionMode ?? ceiling
    const permissionMode = requested && ceiling ? clampPermissionModeToParent(requested, ceiling) : requested
    return {
      id: node.id,
      title: nodeTitle(node),
      ...(model ? { model } : {}),
      ...(llmConnection ? { llmConnection } : {}),
      ...(permissionMode ? { permissionMode } : {}),
    }
  })
}

/**
 * UB2.9 (B4-14; upstream `waitForTurnReply`, Apache-2.0) — send a turn and wait for its reply.
 * Subscribes BEFORE sending, so a fast turn can't complete before we listen. Fails a turn that
 * shows no activity for `idleMs` and any turn running past `maxMs`, and a stopped or failed turn
 * at once (resolving '' fed a repair turn a stopped authoring turn never owed). Resolves to that
 * turn's reply only, never an earlier one.
 */
export function waitForTurnReply(
  sessions: { onSessionComplete: ISessionManager['onSessionComplete']; onSessionActivity?: ISessionManager['onSessionActivity'] },
  sessionId: string,
  send: () => Promise<void> | void,
  opts: { idleMs?: number; maxMs?: number } = {},
): Promise<string> {
  const idleMs = opts.idleMs ?? GENERATE_IDLE_TIMEOUT_MS
  const maxMs = opts.maxMs ?? GENERATE_ATTEMPT_MAX_MS
  return new Promise<string>((resolve, reject) => {
    let settled = false
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const cleanups: Array<() => void> = []
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      for (const cleanup of cleanups) cleanup()
      clearTimeout(idleTimer)
      fn()
    }
    const armIdleTimer = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => finish(() => reject(new Error(`Task generation stalled (no progress for ${Math.round(idleMs / 1000)} s)`))), idleMs)
    }
    // Without the activity seam (an older host), the idle timer still bounds the wait.
    if (sessions.onSessionActivity) cleanups.push(sessions.onSessionActivity(sessionId, armIdleTimer))
    cleanups.push(sessions.onSessionComplete((evt) => {
      if (evt.sessionId !== sessionId) return
      // NESSY: no `?? getSessionFinalText(sessionId)` (upstream) — that is the previous turn's answer.
      if (evt.reason !== 'complete') {
        finish(() => reject(new Error(evt.reason === 'error' ? 'The authoring turn failed' : 'The authoring turn was stopped')))
        return
      }
      finish(() => resolve(evt.finalText ?? ''))
    }))
    armIdleTimer()
    const capTimer = setTimeout(() => finish(() => reject(new Error('Task generation timed out'))), maxMs)
    cleanups.push(() => clearTimeout(capTimer))
    void Promise.resolve()
      .then(send)
      .catch((err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))))
  })
}

// UB2.9 (B4-14; upstream GENERATE_THINKING_LEVEL): authoring a short YAML needs little thinking — the
// workspace default (often max) thought for minutes before its first token and hit the timeout.
const GENERATE_THINKING_LEVEL: NonNullable<CreateSessionOptions['thinkingLevel']> = 'medium'

export function registerTasksHandlers(server: RpcServer, deps: HandlerDeps, options: TasksHandlerOptions = {}): void {
  const assertHostable = options.assertNodesHostable ?? assertNodesHostable
  const generateTimeoutMs = options.generateTimeoutMs ?? GENERATE_TIMEOUT_MS
  // UB2.9 (B4-14): a turn fails when it shows no activity for this long, or runs past the cap —
  // a fixed 180 s cut off authoring turns that were slow but still writing.
  const generateIdleTimeoutMs = options.generateIdleTimeoutMs ?? GENERATE_IDLE_TIMEOUT_MS
  const generateAttemptMaxMs = options.generateAttemptMaxMs ?? GENERATE_ATTEMPT_MAX_MS
  const workspaceRootOf = (workspaceId: string): string =>
    getWorkspaceOrThrow(deps.workspaceService, workspaceId).workspaceRootPath
  const ledgerKey = options.hostApprovalsKey ?? (() => getHostApprovalsKeyProvider().getKey())

  /** UA4.4 — the task's last human-confirmed digest; undefined when none verifies or the key cannot be read (closed). */
  const confirmedTaskDigest = async (root: string, slug: string): Promise<string | undefined> => {
    try {
      return findHostApproval(root, await ledgerKey(), 'task-confirmation', taskConfirmationSubject(slug))?.digest
    } catch (error) {
      generateLog.warn('task confirmation unreadable', { slug, error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }

  /** UA4.4 — record `digest` as the task's human-confirmed one; a failure records nothing (the next run asks again). */
  const recordTaskConfirmation = async (root: string, slug: string, digest: string | null): Promise<void> => {
    if (!digest) return
    try {
      recordHostApproval(root, await ledgerKey(), { kind: 'task-confirmation', subject: taskConfirmationSubject(slug), digest })
    } catch (error) {
      generateLog.warn('task confirmation not recorded', { slug, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * UA4.4 — the plugins a node of this task sees, with their MCP server names: the capability snapshot of the
   * orchestrator's project WITHOUT its session (a node's context is a new session's in that project, UA4.1's parity pin,
   * so the orchestrator's session-scoped plugins are not in it) and with no runtime (each node's runtime is shown beside
   * it). Undefined when no capability runtime is wired or the read fails — the confirmation then says so.
   */
  const nodePlugins = async (workspaceId: string, orchestratorSessionId: string): Promise<TaskRunConfirmationDto['plugins']> => {
    const sessionManager = deps.sessionManager
    const resolver = sessionManager.getCapabilityResolver?.()
    const handleService = sessionManager.getProjectHandleService?.()
    if (!resolver || !handleService) return undefined
    try {
      const context = await resolveCapabilityContext({ workspaceId, sessionId: orchestratorSessionId }, {
        handleService,
        resolveSessionWorkingDirectory: (ws, sessionId) => sessionManager.getWorkingDirectory(sessionId, ws) ?? undefined,
      })
      const { sessionId: _session, provider: _provider, memorySessionId: _memory, ...nodeContext } = context
      const projectContext: CapabilityContext = nodeContext
      return await withCapabilitySnapshot(resolver, projectContext, (snapshot) => toUserCatalog(snapshot).installedPlugins
        .filter((plugin) => plugin.activation.effective === 'active')
        .map((plugin) => ({
          name: plugin.name,
          mcpServers: (plugin.components ?? []).filter((component) => component.kind === 'mcp').map((component) => component.name),
        })))
    } catch (error) {
      generateLog.warn('run confirmation plugins unreadable', { error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }

  /** The live orchestrator of a task: a non-archived session carrying the slug that is not a node. */
  const taskOrchestrator = (workspaceId: string, slug: string) =>
    deps.sessionManager.getSessions(workspaceId).find(session => session.taskSlug === slug && !session.taskNodeId && !session.isArchived)

  /**
   * UA4.3 — the workspace's one Conductor runner. Its preflight re-reads the workspace's default connection on every
   * call, because `getConductorRunner` keeps the preflight of the runner's first creation.
   */
  const runnerFor = (workspaceId: string): TaskRunner => getConductorRunner(deps.sessionManager, {
    workspaceId,
    workspaceRoot: workspaceRootOf(workspaceId),
    // UB6.6 — the decision model reads verdicts out of replies without a VERDICT line and
    // narrows a FAIL without named subtasks; gated per call, `null` when off → as before.
    decide: buildTaskVerdictDecider(),
    pickRepairNodes: buildRepairScopePicker(),
    // UB6.7 — a child that asked for input or gave up is failed instead of marked done.
    classifyNodeOutcome: buildNodeOutcomeClassifier(),
    preflight: (spec, ctx) => createConductorPreflight({
      sessionManager: deps.sessionManager,
      workspaceId,
      hostRuntime: buildBackendHostRuntimeContext(deps.platform),
      workspaceDefaultConnection: getWorkspaceOrThrow(deps.workspaceService, workspaceId).config.defaults?.defaultLlmConnection,
      assertHostable,
    })(spec, ctx),
  })

  /** UA1.7 — a node no connection can host becomes a validation error naming it (never a thrown RPC error). */
  const hostabilityIssue = async (workspaceId: string, spec: TaskSpec): Promise<TaskValidationIssueDto | null> => {
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)
    try {
      await assertHostable(spec, {
        hostRuntime: buildBackendHostRuntimeContext(deps.platform),
        workspaceDefaultConnection: workspace.config.defaults?.defaultLlmConnection,
      })
      return null
    } catch (error) {
      const data = (error as { code?: string; data?: { nodeId?: string } }).code === 'RUNTIME_UNHOSTABLE'
        ? (error as { data?: { nodeId?: string } }).data
        : undefined
      if (!data) throw error
      return {
        path: `nodes.${data.nodeId}.llmConnection`,
        message: error instanceof Error ? error.message : String(error),
        severity: 'error',
      }
    }
  }

  // tasks:validate — lint/dry-run; no side effects.
  server.handle(RPC_CHANNELS.tasks.VALIDATE, async (ctx, workspaceId: string, yaml: string): Promise<TaskValidationResultDto> => {
    assertCallerWorkspace(ctx, deps, workspaceId, WORKSPACE_MISMATCH)
    const parsed = parseTaskYaml(yaml)
    const validation = toValidationDto(parsed)
    if (!parsed.valid || !parsed.spec) return validation
    const unhostable = await hostabilityIssue(workspaceId, parsed.spec)
    return unhostable ? { ...validation, valid: false, errors: [...validation.errors, unhostable] } : validation
  })

  // tasks:create — write task.yaml + bind/adopt/create the orchestrator session.
  server.handle(RPC_CHANNELS.tasks.CREATE, async (ctx, workspaceId: string, req: TaskCreateRequest): Promise<TaskCreateResult> => {
    assertCallerWorkspace(ctx, deps, workspaceId, WORKSPACE_MISMATCH)
    const root = workspaceRootOf(workspaceId)
    const parsed = parseTaskYaml(req.yaml)
    const validation = toValidationDto(parsed)
    if (!parsed.valid || !parsed.spec) {
      return { slug: '', orchestratorSessionId: '', validation }
    }
    const spec = parsed.spec
    const sessionManager = deps.sessionManager
    const handles = sessionManager.getProjectHandleService?.()

    // Every refusal the handler owns runs before anything is saved and before any session is touched.
    // F8 — a remote client may not create a task whose mode is above the remote ceiling (the same server-side rule
    // `sessions:command setPermissionMode` enforces; a picker that hides the mode is only a suggestion).
    const specMode = spec.defaults?.permissionMode
    if (specMode && !isPermissionModeAllowedForRemoteClient(specMode) && !isLocalClient(server, ctx.clientId)) {
      throw new Error(`permission-mode-above-remote-ceiling: "${specMode}" (the highest a remote client may set is "${REMOTE_CLIENT_PERMISSION_MODE_CEILING}")`)
    }
    const owner = req.attachToExistingSession ?? req.orchestratorSessionId
    // Guard + claim in one synchronous step, before the first await (create-task.ts header item 5): a concurrent
    // create of the same id is `task-slug-taken` until this one has settled; released on every exit below (each
    // `return await` keeps the claim held until the yaml is saved — a bare `return` would release it first).
    const releaseSlug = claimTaskSlug(sessionManager, workspaceId, root, spec.id, owner)
    try {
      // spec.cwd is checked on EVERY path (the saved yaml is what a run reads); only a fresh orchestrator starts in
      // a folder — the editor's handle when it sent one, else spec.cwd. Attach/adopt never move a folder.
      const specFolder = spec.cwd ? await resolveTaskFolderHandle(handles, workspaceId, { cwd: spec.cwd }) : undefined
      const editorFolder = !req.attachToExistingSession && req.projectHandleId
        ? await resolveTaskFolderHandle(handles, workspaceId, { projectHandleId: req.projectHandleId })
        : undefined
      const freshFolder = editorFolder ?? specFolder

      const reconcile = {
        name: spec.title,
        ...(spec.project ? { projectId: spec.project } : {}),
        ...(spec.defaults?.model ? { model: spec.defaults.model } : {}),
        ...(spec.defaults?.llmConnection ? { llmConnection: spec.defaults.llmConnection } : {}),
        ...(spec.defaults?.permissionMode ? { permissionMode: spec.defaults.permissionMode } : {}),
      }
      // The yaml is saved only once the orchestrator is settled (bound, adopted or created), so a refused bind or
      // create leaves no task.yaml without an orchestrator (upstream saved first on every path).
      // UA4.4 — the editor's own save is a human confirmation of these bytes; a Generate adoption is not (header).
      const humanSaved = !req.orchestratorSessionId
      const finish = async (orchestratorSessionId: string): Promise<TaskCreateResult> => {
        saveTaskSpec(root, spec)
        if (humanSaved) await recordTaskConfirmation(root, spec.id, taskYamlDigest(root, spec.id))
        const setup = await finishTaskOrchestrator(sessionManager, workspaceId, orchestratorSessionId, spec)
        return { slug: spec.id, orchestratorSessionId, validation, taskLabelId: setup.taskLabelId }
      }

      // Edit-mode bind onto an existing, visible session: a failed bind is a HARD error, never a fresh create.
      if (req.attachToExistingSession) {
        const bound = await sessionManager.bindExistingSessionToTask(req.attachToExistingSession, spec.id, reconcile, workspaceId)
        if (!bound) {
          throw new Error(
            `Cannot attach task "${spec.id}" to session ${req.attachToExistingSession}: `
              + 'session is missing or already bound to a different task.',
          )
        }
        return await finish(req.attachToExistingSession)
      }

      // Adoption of a Generate draft; falls back to a fresh create when the draft is gone, adopted or rebound.
      if (req.orchestratorSessionId) {
        const draftId = req.orchestratorSessionId
        const wasDraft = sessionManager.getSessions(workspaceId).some(session => session.id === draftId && session.taskDraft && !session.taskSlug)
        const adopted = await sessionManager.adoptGeneratedTaskOrchestrator(draftId, spec.id, reconcile, workspaceId)
        if (adopted) {
          // UA4.5 — the draft authored in the host's `dontAsk` (header); adopted, it takes the editor's mode as a fresh
          // create would. The adopt lock's clamp stays for every non-draft (an idempotent re-adopt included).
          if (wasDraft && specMode) sessionManager.setSessionPermissionMode(draftId, specMode, workspaceId)
          return await finish(draftId)
        }
      }

      // Fresh create — the shared core creates the orchestrator, then saves the yaml (a refusal leaves no yaml).
      const created = await createTaskFromSpec(sessionManager, workspaceId, root, spec, {
        ...(freshFolder ? { projectHandleId: freshFolder } : {}),
      })
      if (humanSaved) await recordTaskConfirmation(root, created.slug, taskYamlDigest(root, created.slug))
      return { slug: created.slug, orchestratorSessionId: created.orchestratorSessionId, validation, taskLabelId: created.taskLabelId }
    } finally {
      releaseSlug()
    }
  })

  /**
   * UA4.5 + UB2.9 (B4-14) — one authoring turn of a Generate draft: {@link waitForTurnReply}
   * (upstream's shape) carries the wait; the SEND still rides the Conductor host's queue-mode
   * send raced on the ack.
   */
  const askDraft = (workspaceId: string, sessionId: string, prompt: string): Promise<string> => {
    const host = createSessionConductorHost(deps.sessionManager, { workspaceId, workspaceRoot: workspaceRootOf(workspaceId) })
    return waitForTurnReply(
      deps.sessionManager,
      sessionId,
      () => host.sendMessage(sessionId, prompt),
      { idleMs: generateIdleTimeoutMs, maxMs: generateAttemptMaxMs },
    )
  }

  // tasks:generate (UA4.5) — the draft orchestrator AUTHORS a task.yaml from a goal. Its id is acked at once and the
  // authored spec arrives on the `tasks:generated` push (upstream's async shape: the RPC never nears the client
  // timeout). Nothing is saved here — `tasks:create` is the only writer, and it adopts the draft (header).
  server.handle(RPC_CHANNELS.tasks.GENERATE, async (ctx, workspaceId: string, req: TaskGenerateRequest): Promise<TaskGenerateAck> => {
    assertCallerWorkspace(ctx, deps, workspaceId, WORKSPACE_MISMATCH)
    const goal = typeof req?.goal === 'string' ? req.goal.trim() : ''
    if (!goal) throw new Error('task-goal-required')
    const sessionManager = deps.sessionManager
    // UA12.93 — an edit names the task's orchestrator: the draft authors in ITS folder, read by the reader the run's
    // children use (conductor-host `getSessionProjectHandleId`), and a request handle cannot steer it elsewhere. An
    // unknown or archived orchestrator is refused before any session exists.
    const editOrchestrator = req.orchestratorSessionId
      ? sessionManager.getSessions(workspaceId).find(session => session.id === req.orchestratorSessionId && !session.isArchived)
      : undefined
    if (req.orchestratorSessionId && !editOrchestrator) throw new Error('task-orchestrator-missing')
    // The folder enters as a trusted handle only, refused before any session exists (as tasks:create).
    const folder = editOrchestrator
      ? await createSessionConductorHost(sessionManager, { workspaceId, workspaceRoot: workspaceRootOf(workspaceId) })
        .getSessionProjectHandleId(editOrchestrator.id)
      : req.projectHandleId
        ? await resolveTaskFolderHandle(sessionManager.getProjectHandleService?.(), workspaceId, { projectHandleId: req.projectHandleId })
        : undefined
    const draft = await sessionManager.createSession(workspaceId, {
      name: req.title?.trim() || 'New task',
      sessionStatus: 'todo',
      // Off the board until tasks:create adopts it — and NOT hidden (header).
      taskDraft: true,
      // NESSY: always `dontAsk`; `req.permissionMode` reaches the orchestrator on adoption, through the saved spec.
      permissionMode: GENERATE_PERMISSION_MODE,
      // UB2.9 (B4-14; upstream GENERATE_THINKING_LEVEL): authoring a short YAML needs little
      // thinking. Without this the turn ran at the workspace's default level (often max), thought
      // for minutes before its first token and hit the timeout. OUR take: the SESSION's level
      // (CreateSessionOptions), not upstream's per-send option — each runtime applies its own
      // effort knob (UB2.4's amendment names the per-turn shape a later row's).
      thinkingLevel: GENERATE_THINKING_LEVEL,
      // Bind the draft to the project so it authors against the project's context.
      ...(req.projectId ? { projectId: req.projectId } : {}),
      ...(folder ? { projectHandleId: folder } : {}),
      ...(req.model ? { model: req.model } : {}),
      // A non-default model needs its serving connection, or the authoring turn ends at once with no output.
      ...(req.llmConnection ? { llmConnection: req.llmConnection } : {}),
      ...(req.enabledSourceSlugs?.length ? { enabledSourceSlugs: req.enabledSourceSlugs } : {}),
    })
    const sessionId = draft.id
    // Our createSession does not announce (upstream's did); the draft is visible, so announce it as UA4.1 does a child.
    sessionManager.announceSessionCreated(sessionId, workspaceId)
    generateLog.info('generate started', {
      workspaceId,
      sessionId,
      hasFolder: Boolean(folder),
      model: req.model,
      projectId: req.projectId,
      hasConnection: Boolean(req.llmConnection),
    })

    // The generate → repair loop runs in the background and pushes its result (v0.13.4 L254–L309, adapted above).
    void (async () => {
      const startedAt = Date.now()
      try {
        let prompt = buildGeneratorPrompt(goal, req.title)
        let yaml = ''
        let parsed = parseTaskYaml(yaml)
        let attempts = 0
        for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++) {
          attempts = attempt + 1
          yaml = extractYaml(await askDraft(workspaceId, sessionId, prompt))
          parsed = parseTaskYaml(yaml)
          if (parsed.valid) break
          prompt = buildRepairPrompt(parsed.errors)
        }
        generateLog.info('generate finished', { sessionId, valid: parsed.valid, attempts, elapsedMs: Date.now() - startedAt, slug: parsed.spec?.id ?? '' })
        pushTyped(server, RPC_CHANNELS.tasks.GENERATED, { to: 'workspace', workspaceId }, workspaceId, {
          orchestratorSessionId: sessionId,
          slug: parsed.spec?.id ?? '',
          spec: parsed.spec,
          yaml,
          validation: toValidationDto(parsed),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        generateLog.error('generate failed', { sessionId, elapsedMs: Date.now() - startedAt, error: message })
        // The client stops its spinner, says why and discards the draft (it is never on the board).
        pushTyped(server, RPC_CHANNELS.tasks.GENERATED, { to: 'workspace', workspaceId }, workspaceId, {
          orchestratorSessionId: sessionId,
          slug: '',
          yaml: '',
          validation: { valid: false, errors: [], warnings: [] },
          error: message,
        })
      }
    })()

    return { orchestratorSessionId: sessionId }
  })

  // tasks:run — start a run (UA4.3), behind the host-enforced run confirmation (UA4.4, header).
  server.handle(RPC_CHANNELS.tasks.RUN, async (ctx, workspaceId: string, req: TaskRunRequest): Promise<TaskRunSnapshotDto> => {
    assertCallerWorkspace(ctx, deps, workspaceId, WORKSPACE_MISMATCH)
    assertTaskSlug(req?.slug)
    const root = workspaceRootOf(workspaceId)
    if (req.runId !== undefined) {
      if (typeof req.runId !== 'string' || !SLUG_RE.test(req.runId)) throw new Error('task-run-id-invalid')
      if (listRunIds(root, req.slug).includes(req.runId)) throw new Error(`task-run-id-taken: ${req.runId}`)
    }
    // NESSY: the task's own orchestrator, so children always run under its folder and its mode ceiling.
    if (!req.orchestratorSessionId) throw new Error('task-orchestrator-required')
    const orchestrator = deps.sessionManager.getSessions(workspaceId).find(session => session.id === req.orchestratorSessionId)
    if (!orchestrator || orchestrator.taskSlug !== req.slug || orchestrator.taskNodeId || orchestrator.isArchived) {
      throw new Error(`task-orchestrator-mismatch: ${req.orchestratorSessionId} is not the orchestrator of "${req.slug}"`)
    }
    // UA4.4 — no task.yaml is the runner's refusal; any other digest runs only once a human has confirmed it.
    const digest = taskYamlDigest(root, req.slug)
    if (digest && digest !== await confirmedTaskDigest(root, req.slug)) {
      if (req.confirmedDigest !== digest) throw new Error(`run-confirmation-required: ${req.slug}`)
      await recordTaskConfirmation(root, req.slug, digest)
    }
    return runnerFor(workspaceId).run(req.slug, {
      ...(req.runId ? { runId: req.runId } : {}),
      orchestratorSessionId: req.orchestratorSessionId,
      ...(req.params ? { params: req.params } : {}),
      // UA12.90 — the run runs the bytes THIS check read: the runner hashes its own load and refuses
      // `run-confirmation-required` on a difference, so an edit landing between the two reads cannot run unconfirmed.
      ...(digest ? { confirmedDigest: digest } : {}),
    })
  })

  server.handle(RPC_CHANNELS.tasks.PAUSE, async (ctx, workspaceId: string, slug: string, runId: string): Promise<void> => {
    assertCallerWorkspace(ctx, deps, workspaceId, WORKSPACE_MISMATCH)
    assertTaskSlug(slug)
    assertKnownRunId(workspaceRootOf(workspaceId), slug, runId)
    runnerFor(workspaceId).pause(slug, runId)
  })

  server.handle(RPC_CHANNELS.tasks.RESUME, async (ctx, workspaceId: string, slug: string, runId: string): Promise<void> => {
    assertCallerWorkspace(ctx, deps, workspaceId, WORKSPACE_MISMATCH)
    assertTaskSlug(slug)
    assertKnownRunId(workspaceRootOf(workspaceId), slug, runId)
    await runnerFor(workspaceId).resume(slug, runId)
  })

  server.handle(RPC_CHANNELS.tasks.STOP, async (ctx, workspaceId: string, slug: string, runId: string): Promise<void> => {
    assertCallerWorkspace(ctx, deps, workspaceId, WORKSPACE_MISMATCH)
    assertTaskSlug(slug)
    assertKnownRunId(workspaceRootOf(workspaceId), slug, runId)
    await runnerFor(workspaceId).stop(slug, runId)
  })

  // tasks:get — the spec + (optional) the live run snapshot (UA4.3).
  server.handle(RPC_CHANNELS.tasks.GET, async (ctx, workspaceId: string, slug: string, runId?: string): Promise<TaskGetResult> => {
    assertCallerWorkspace(ctx, deps, workspaceId, WORKSPACE_MISMATCH)
    assertTaskSlug(slug)
    const loaded = loadTaskSpec(workspaceRootOf(workspaceId), slug)
    if (!loaded) {
      return {
        slug,
        validation: { valid: false, errors: [{ path: 'root', message: `Task "${slug}" not found`, severity: 'error' }], warnings: [] },
        run: null,
      }
    }
    const root = workspaceRootOf(workspaceId)
    const runIds = listRunIds(root, slug)
    const known = typeof runId === 'string' && runIds.includes(runId)
    const run = known ? runnerFor(workspaceId).getRunState(slug, runId) : null
    // UA4.4 — the run confirmation (header) and the latest run's nodes that worked again after done (the tile badge).
    const digest = taskYamlDigest(root, slug)
    const needsRunConfirmation = digest !== null && digest !== await confirmedTaskDigest(root, slug)
    const latest = runIds.at(-1)
    const wokeAfterDone = latest
      ? [...new Set(readRunLog(root, slug, latest).flatMap((entry) => entry.kind === 'node-woke-after-done' ? [entry.nodeId] : []))]
      : []
    let runConfirmation: TaskRunConfirmationDto | undefined
    if (needsRunConfirmation && digest && loaded.spec) {
      const orchestrator = taskOrchestrator(workspaceId, slug)
      const ceiling = orchestrator?.permissionMode
      runConfirmation = {
        digest,
        nodeCount: loaded.spec.nodes.length,
        nodes: confirmationNodes(loaded.spec, ceiling),
        sources: loaded.spec.sources ?? [],
        ...(ceiling ? { orchestratorPermissionMode: ceiling } : {}),
        ...(orchestrator ? { plugins: await nodePlugins(workspaceId, orchestrator.id) } : {}),
      }
    }
    return {
      slug,
      validation: toValidationDto(loaded),
      spec: loaded.spec,
      run,
      needsRunConfirmation,
      ...(runConfirmation ? { runConfirmation } : {}),
      ...(wokeAfterDone.length ? { wokeAfterDone } : {}),
    }
  })

  // tasks:list — slugs with a task.yaml.
  server.handle(RPC_CHANNELS.tasks.LIST, async (ctx, workspaceId: string): Promise<string[]> => {
    assertCallerWorkspace(ctx, deps, workspaceId, WORKSPACE_MISMATCH)
    return listTaskSlugs(workspaceRootOf(workspaceId))
  })

  // tasks:getResults — storage-backed read of a run's outcome (verdict + per-node output); survives a restart.
  server.handle(RPC_CHANNELS.tasks.GET_RESULTS, async (ctx, workspaceId: string, slug: string, runId?: string): Promise<TaskResultsDto> => {
    assertCallerWorkspace(ctx, deps, workspaceId, WORKSPACE_MISMATCH)
    assertTaskSlug(slug)
    const root = workspaceRootOf(workspaceId)
    const runIds = listRunIds(root, slug)
    // A run id from the wire is only ever one this task has (it becomes a path below).
    const chosen = runId !== undefined ? (runIds.includes(runId) ? runId : null) : runIds.at(-1) ?? null
    if (!chosen) return { slug, runId: null, runIds, nodes: [] }

    const log = readRunLog(root, slug, chosen)

    // Node titles come from the run-time spec snapshot (so historical runs aren't relabeled by a later edit).
    const snapshot = readRunSpecSnapshot(root, slug, chosen)
    const titleById = new Map<string, string>()
    if (snapshot) for (const n of snapshot.nodes) titleById.set(n.id, nodeTitle(n))

    // Fold the append-only log into the latest per-node state + session id, preserving first-seen order.
    const byId = new Map<string, { id: string; state: string; sessionId?: string; wokeAfterDone?: boolean }>()
    const ensure = (id: string) => {
      let e = byId.get(id)
      if (!e) { e = { id, state: 'pending' }; byId.set(id, e) }
      return e
    }
    const verdicts: NonNullable<TaskResultsDto['verdicts']> = []
    let runStatus: string | undefined
    for (const entry of log) {
      if (entry.kind === 'node-scheduled') {
        // UA4.4 (as `TaskRunner.hydrate`): an attempt began — running until its `node-finished`, in the session the
        // next `node-spawned` names.
        const e = ensure(entry.nodeId)
        e.state = 'running'
        e.sessionId = undefined
        e.wokeAfterDone = undefined
      } else if (entry.kind === 'node-spawned') {
        ensure(entry.nodeId).sessionId = entry.sessionId
      } else if (entry.kind === 'node-retry') {
        ensure(entry.nodeId).state = 'pending' // UA4.4: sent back by a retry or a repair — not done any more
      } else if (entry.kind === 'node-woke-after-done') {
        ensure(entry.nodeId).wokeAfterDone = true
      } else if (entry.kind === 'node-finished') {
        const e = ensure(entry.nodeId)
        e.state = entry.state
        if (entry.sessionId) e.sessionId = entry.sessionId
      } else if (entry.kind === 'verdict') {
        verdicts.push({
          result: entry.result,
          ...(entry.reason ? { reason: entry.reason } : {}),
          ...(entry.nodes?.length ? { nodes: entry.nodes } : {}),
          // UB6.6 — the UI marks an inferred verdict (read from a reply without a VERDICT
          // line by the decision model) and shows its confidence.
          ...(entry.via ? { via: entry.via } : {}),
          ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
        })
      } else if (entry.kind === 'run-completed') {
        runStatus = 'completed'
      } else if (entry.kind === 'run-failed') {
        runStatus = 'failed'
      } else if (entry.kind === 'run-stopped') {
        runStatus = 'stopped'
      } else if (entry.kind === 'run-verifying') {
        runStatus = 'verifying'
      }
    }

    const nodes: TaskResultNodeDto[] = [...byId.values()].map((e) => {
      const out = readNodeOutput(root, slug, chosen, e.id)
      return {
        id: e.id,
        title: titleById.get(e.id) ?? e.id,
        state: e.state,
        ...(e.sessionId ? { sessionId: e.sessionId } : {}),
        ...(out?.text ? { output: out.text } : {}),
        ...(e.wokeAfterDone ? { wokeAfterDone: true } : {}),
      }
    })

    // UA4.3 — the live run's status when this process holds it; else the log's terminal one; else the run was
    // interrupted (a restart): never shown as running, and nothing is written to say so (spec §11 item 7).
    const live = runnerFor(workspaceId).getRunState(slug, chosen)
    const logged = runStatusFromLog(log)
    if (live) runStatus = live.status
    else if (logged && isTerminalRunStatus(logged)) runStatus = logged
    else if (logged) runStatus = 'interrupted'

    const repairUsed = verdicts.filter((v) => v.result === 'fail').length
    const repairMax = Math.min(snapshot?.max_iterations ?? DEFAULT_REPAIR_ATTEMPTS, MAX_REPAIR_ATTEMPTS_CAP)

    return {
      slug,
      runId: chosen,
      runIds,
      verdict: verdicts.at(-1),
      verdicts,
      repair: { used: repairUsed, max: repairMax },
      ...(runStatus ? { runStatus } : {}),
      ...(snapshot?.acceptance_criteria ? { acceptanceCriteria: snapshot.acceptance_criteria } : {}),
      nodes,
    }
  })

  // tasks:delete (NESSY) — remove a task spec no live session carries.
  server.handle(RPC_CHANNELS.tasks.DELETE, async (ctx, workspaceId: string, slug: string): Promise<TaskDeleteResult> => {
    assertCallerWorkspace(ctx, deps, workspaceId, WORKSPACE_MISMATCH)
    assertTaskSlug(slug)
    const root = workspaceRootOf(workspaceId)
    const carried = deps.sessionManager.getSessions(workspaceId).some(session => session.taskSlug === slug && !session.isArchived)
    if (carried) throw new Error(`task-slug-in-use:${slug}`)
    const existed = loadTaskSpec(root, slug) !== null || listRunIds(root, slug).length > 0
    deleteTaskFolder(root, slug) // UA3.8 — the one removal path (`tasks/storage.ts`), shared with the delete cascade
    return { slug, deleted: existed }
  })
}

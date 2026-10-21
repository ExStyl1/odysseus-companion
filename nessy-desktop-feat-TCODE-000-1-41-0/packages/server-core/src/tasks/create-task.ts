/**
 * UA3.4 — adapted from craft-agents-oss `v0.13.4:packages/server-core/src/tasks/create-task.ts` (Apache-2.0),
 * rebranded (`@craft-agent` → `@nessy-agent`).
 *
 * Task creation core — shared by the `tasks:create` RPC (fresh, attach and adopt paths) and, from UA3.5, the
 * agent's `create_board_task` session tool. Creates the task on the board only: `task.yaml` + the orchestrator
 * session + the reserved Task label + the spec's sources. Never starts a run — running is `tasks:run` (UA4.x).
 *
 * Stated divergences from v0.13.4 (spec §10 "Binding", "Folder ingress"; plan UA3.4 "Adaptations"):
 *
 * 1. **The folder is a project HANDLE, never a path.** Upstream handed `spec.cwd` (a raw absolute path from an
 *    agent- or user-written yaml) to `createSession({ workingDirectory })`. Ours: {@link resolveTaskFolderHandle}
 *    sends `spec.cwd` (or the editor's already-issued handle) through `ProjectHandleService` — the sole raw-path
 *    ingress — and REFUSES a folder that is not trusted (`task-cwd-untrusted`) before any session exists. The
 *    orchestrator is created with `projectHandleId` (our `CreateSessionOptions.workingDirectory` is
 *    `'user_default' | 'none'` only).
 * 2. **The slug is never overwritten in create mode** ({@link assertTaskSlugFree}): a `spec.id` that already has a
 *    `task.yaml`, or that a live (non-archived) session already carries, is refused with
 *    `task-slug-taken:<slug>` — unless the target session of an attach/adopt already carries exactly that slug
 *    (the edit flow). Upstream saved first and overwrote (spec §19 defect 13).
 * 3. **The orchestrator's mode** on a fresh create is `opts.permissionMode` when a caller passes one, else the
 *    yaml's `defaults.permissionMode` — as upstream; the editor's yaml is the human's choice. The only guard on it
 *    is the F8 remote ceiling in `rpc/tasks.ts` (a remote client may not create above it). Attach/adopt clamp the
 *    mode instead (`SessionManager.bindManagedSessionToTask`).
 * 4. **The orchestrator is created BEFORE `task.yaml` is saved** ({@link createTaskFromSpec}). Upstream saved
 *    first; under guard 2 a `createSession` refusal (a stale default-project pin, a handle that expired mid-call,
 *    the root-bypass refusal) would leave an orphan yaml that refuses the identical retry with
 *    `task-slug-taken:<slug>`.
 * 5. **The slug is CLAIMED, not only checked** ({@link claimTaskSlug}). Item 4 puts awaits between the guard and the
 *    save, so a bare check-then-act would let two concurrent creates of one id (two windows saving "Задача" —
 *    `uniqueTaskSlug` is deterministic) both pass, give two orchestrators one slug and overwrite the first yaml.
 *    The guard and an in-process reservation run in one synchronous step; the caller releases it once the create
 *    has settled or failed. Residue: the reservation is per process — two server processes on one workspace root
 *    are not serialised (one process owns a workspace).
 */
import type { TaskSpec } from '@nessy-agent/shared/tasks'
import { listTaskSlugs, saveTaskSpec } from '@nessy-agent/shared/tasks'
import type { PermissionMode } from '@nessy-agent/shared/agent/mode-types'
import type { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import { createLogger } from '@nessy-agent/shared/utils'
import type { ISessionManager } from '../handlers/session-manager-interface'

const log = createLogger('tasks-create')

export interface TaskOrchestratorSetupResult {
  taskLabelId?: string
  warnings: string[]
}

export interface CreateTaskFromSpecResult {
  slug: string
  orchestratorSessionId: string
  taskLabelId?: string
  warnings: string[]
}

/**
 * Agent-created Tasks follow the same project inheritance rule as spawned sessions: an explicit project wins;
 * otherwise keep work in the invoking session's project. An unbound invoking session leaves the Task unbound.
 */
export function resolveCreateTaskProjectId(
  requestedProjectId: string | undefined,
  currentProjectId: string | undefined,
): string | undefined {
  return requestedProjectId ?? currentProjectId
}

/** NESSY — slugs a create in this process holds between its guard and its end, per workspace root (header item 5). */
const claimedTaskSlugs = new Map<string, Set<string>>()

/**
 * NESSY — the slugs a create must not take: every `tasks/<slug>/task.yaml` on disk, every slug a live
 * (non-archived) session of the workspace carries (an orchestrator whose yaml was never saved, or was removed
 * by hand, still owns its slug), and every slug a create still in flight has claimed ({@link claimTaskSlug}).
 */
export function takenTaskSlugs(
  sessionManager: Pick<ISessionManager, 'getSessions'>,
  workspaceId: string,
  workspaceRoot: string,
): Set<string> {
  const taken = new Set([...listTaskSlugs(workspaceRoot), ...(claimedTaskSlugs.get(workspaceRoot) ?? [])])
  for (const session of sessionManager.getSessions(workspaceId)) {
    if (session.taskSlug && !session.isArchived) taken.add(session.taskSlug)
  }
  return taken
}

/**
 * NESSY — refuse a create that would overwrite another task's `task.yaml` (`task-slug-taken:<slug>`).
 * `ownerSessionId` is the session an attach/adopt targets: when IT already carries the slug, saving onto it is
 * the edit flow and is allowed.
 */
export function assertTaskSlugFree(
  sessionManager: Pick<ISessionManager, 'getSessions'>,
  workspaceId: string,
  workspaceRoot: string,
  slug: string,
  ownerSessionId?: string,
): void {
  if (ownerSessionId) {
    const owner = sessionManager.getSessions(workspaceId).find(session => session.id === ownerSessionId)
    if (owner?.taskSlug === slug) return
  }
  if (takenTaskSlugs(sessionManager, workspaceId, workspaceRoot).has(slug)) {
    throw new Error(`task-slug-taken:${slug}`)
  }
}

/**
 * NESSY — {@link assertTaskSlugFree} plus a reservation, in one synchronous step (header item 5): every create path
 * calls this BEFORE its first await and calls the returned release in a `finally` once the orchestrator is settled
 * and the yaml saved, or the create has failed. A second create of the same slug meanwhile is `task-slug-taken`.
 * The edit flow (the owner already carries the slug) is not refused by an in-flight claim — the carrier already
 * keeps every other create off the slug.
 */
export function claimTaskSlug(
  sessionManager: Pick<ISessionManager, 'getSessions'>,
  workspaceId: string,
  workspaceRoot: string,
  slug: string,
  ownerSessionId?: string,
): () => void {
  assertTaskSlugFree(sessionManager, workspaceId, workspaceRoot, slug, ownerSessionId)
  const held = claimedTaskSlugs.get(workspaceRoot) ?? new Set<string>()
  // Only the edit flow reaches here with the slug already held; the first claim's release ends it.
  if (held.has(slug)) return () => {}
  held.add(slug)
  claimedTaskSlugs.set(workspaceRoot, held)
  let released = false
  return () => {
    if (released) return
    released = true
    held.delete(slug)
    if (held.size === 0 && claimedTaskSlugs.get(workspaceRoot) === held) claimedTaskSlugs.delete(workspaceRoot)
  }
}

/**
 * NESSY — the orchestrator's folder: the editor's issued handle when the request carries one, else `spec.cwd`
 * through `validateProjectDirectory` (the sole raw-path ingress), else none (the workspace/project default).
 * Either way the folder must be TRUSTED, or the create is refused with `task-cwd-untrusted` before any session
 * exists; an unknown or expired handle is `project-handle-invalid`.
 */
export async function resolveTaskFolderHandle(
  handles: ProjectHandleService | undefined,
  workspaceId: string,
  input: { projectHandleId?: string; cwd?: string },
): Promise<string | undefined> {
  if (!input.projectHandleId && !input.cwd) return undefined
  if (!handles) throw new Error('project-handle-service-unavailable')
  const handle = input.projectHandleId
    ? await handles.resolveHandle({ workspaceId, projectHandleId: input.projectHandleId })
    : await handles.validateProjectDirectory(workspaceId, input.cwd!)
  if (!handle) throw new Error('project-handle-invalid')
  if (handle.trustState !== 'trusted') throw new Error('task-cwd-untrusted')
  return handle.id
}

/**
 * Post-create setup shared by ALL orchestrator paths (attach / adopt / fresh): apply the reserved Task label and
 * enable the spec's sources on the orchestrator session. Fail-soft — neither a label nor a sources problem may
 * fail task creation; problems surface as warnings instead.
 */
export async function finishTaskOrchestrator(
  sessionManager: ISessionManager,
  workspaceId: string,
  orchestratorSessionId: string,
  spec: TaskSpec,
): Promise<TaskOrchestratorSetupResult> {
  const warnings: string[] = []
  const applied = await sessionManager.applyTaskLabel(orchestratorSessionId, { workspaceId }).catch((err: unknown) => {
    log.warn('applyTaskLabel failed for orchestrator', { orchestratorSessionId, err })
    warnings.push('The reserved Task label could not be applied.')
    return undefined
  })
  if (spec.sources?.length) {
    await Promise.resolve(sessionManager.setSessionSources(orchestratorSessionId, spec.sources, workspaceId)).catch(
      (err: unknown) => {
        log.warn('setSessionSources failed for orchestrator', { orchestratorSessionId, err })
        warnings.push(`Sources could not be enabled on the orchestrator: ${spec.sources!.join(', ')}`)
      },
    )
  }
  return { taskLabelId: applied?.labelId, warnings }
}

/**
 * Fresh create: create the orchestrator session bound to the slug, then persist task.yaml (unless the caller saves
 * it itself). Creation only — no child sessions, no run log, no runner. The caller has already resolved the
 * folder handle ({@link resolveTaskFolderHandle}) and claimed the slug ({@link claimTaskSlug}), releasing it after.
 *
 * NESSY order (header item 4): a refused `createSession` leaves nothing on disk, so the same yaml can be retried.
 * Residue: a save that fails AFTER the session exists leaves an orchestrator that carries the slug without a
 * yaml — a visible tile the user can delete, and the error reaches the caller.
 */
export async function createTaskFromSpec(
  sessionManager: ISessionManager,
  workspaceId: string,
  workspaceRoot: string,
  spec: TaskSpec,
  opts?: { save?: boolean; projectHandleId?: string; permissionMode?: PermissionMode },
): Promise<CreateTaskFromSpecResult> {
  const permissionMode = opts?.permissionMode ?? spec.defaults?.permissionMode
  const orchestrator = await sessionManager.createSession(workspaceId, {
    name: spec.title,
    ...(spec.project ? { projectId: spec.project } : {}),
    sessionStatus: 'todo',
    // Stable linkage: this session orchestrates task `spec.id` across all of its runs.
    taskSlug: spec.id,
    // The folder enters as a handle only (see the module header); children inherit it at dispatch.
    ...(opts?.projectHandleId ? { projectHandleId: opts.projectHandleId } : {}),
    ...(spec.defaults?.model ? { model: spec.defaults.model } : {}),
    ...(spec.defaults?.llmConnection ? { llmConnection: spec.defaults.llmConnection } : {}),
    ...(permissionMode ? { permissionMode } : {}),
  })
  if (opts?.save !== false) saveTaskSpec(workspaceRoot, spec)
  const setup = await finishTaskOrchestrator(sessionManager, workspaceId, orchestrator.id, spec)
  // F1.873 — our createSession does not announce (upstream's did): every window lists the orchestrator now, with its
  // label, whether `tasks:create` or the agent's `create_board_task` made it (UA4.1 `announceSessionCreated`).
  sessionManager.announceSessionCreated(orchestrator.id, workspaceId)
  return { slug: spec.id, orchestratorSessionId: orchestrator.id, ...setup }
}

/**
 * UA3.5 — the host side of the agent's `create_board_task` session tool (OQ-8), adapted from craft-agents-oss
 * `v0.13.4:packages/server-core/src/sessions/SessionManager.ts` `createTaskFn` (L4286–L4330, Apache-2.0). The
 * session tool reaches it on all three runtimes through ONE closure (`SessionScopedToolCallbacks.createBoardTaskFn`,
 * bound by `SessionManager`): Pi and Claude in process, codex over `HOST_CALLBACK_BRIDGE_ROUTES.taskCreate`. Every
 * rule below is therefore the same on every runtime by construction (spec §4 reach matrix: UNIFORM).
 *
 * Creation only, as upstream: `task.yaml` + an orchestrator session in "todo" through the shared create core
 * ({@link createTaskFromSpec}, the one `tasks:create` uses); nothing runs, and no confirmed digest is recorded — a
 * spec an agent wrote needs the human run confirmation (spec §10 "Run confirmation", UA4.4).
 *
 * Stated divergences from v0.13.4 (spec §10 "`create_board_task`", security finding S19 "agent task escalates via
 * project, sources or connection"; reason (b) for each restriction):
 * 1. **The folder is the caller's own.** Upstream wrote `input.workingDirectory` (any absolute path) into
 *    `spec.cwd`. Ours resolves the CALLER's folder handle (spawn_session's rule, `SessionManager` `spawnSessionFn`)
 *    and refuses any other `workingDirectory` with `project-handle-required`; the orchestrator gets that handle
 *    (never a path), and an untrusted folder is `task-cwd-untrusted` before anything exists (UA3.4's rule).
 * 2. **The project is the caller's own, or one over the caller's own folder.** An explicit `projectId` other than the
 *    caller's is accepted only when that project (UA5.2's store, `loadProjectById`) has a folder whose persisted
 *    `projectKey` equals the caller's folder key from a STABLE identity (spec §10: "a project whose folder `projectKey`
 *    equals the caller's"); anything else — an unknown id, a folderless project, another folder, a caller with no
 *    folder or a process-only one (whose key is never persisted, so it can match nothing) — is
 *    `project-handle-required`. The task keeps the caller's folder handle either way.
 * 3. **Sources are a subset of the caller's enabled sources**; omitted means ALL of the caller's (spec: "unset
 *    `sources` inherits the caller's"; upstream: none). A workspace source the caller has not enabled is refused
 *    (`board-task-source-not-enabled`). An UNKNOWN slug is a warning as upstream, but it is NOT kept in the spec:
 *    a source created later under that name would be enabled by a spec the caller could never have enabled.
 * 4. **The connection is the caller's own**: another `llmConnection` is refused (`board-task-connection-refused`);
 *    omitted means the caller's (upstream: the workspace default), spawn_session's inheritance rule.
 * 5. **No permission mode from the agent**: the schema has none, the yaml gets none, and the orchestrator takes the
 *    caller's mode (spec §10 "Binding": "for agent creation, the invoking session's mode").
 * 6. **The slug is claimed** ({@link claimTaskSlug}) in the same synchronous step that derives it with
 *    `uniqueTaskSlug` against {@link takenTaskSlugs} (disk, live sessions and in-flight creates), so an existing slug
 *    yields `-2` and two concurrent calls with one title cannot take one slug (UA3.4 header item 5).
 * Every refusal runs before the slug is claimed and before any session or file exists.
 */
import { parseTaskSpec, uniqueTaskSlug } from '@nessy-agent/shared/tasks'
import type { PermissionMode } from '@nessy-agent/shared/agent/mode-types'
import type { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import { loadProjectById } from '@nessy-agent/shared/projects'
import type { CreateBoardTaskInput, CreateBoardTaskResult } from '@nessy-agent/session-tools-core'
import type { ISessionManager } from '../handlers/session-manager-interface'
import { claimTaskSlug, createTaskFromSpec, resolveCreateTaskProjectId, takenTaskSlugs } from './create-task'

/** The invoking session, as the restrictions read it. */
export interface BoardTaskCaller {
  sessionId: string
  workspaceId: string
  workspaceRoot: string
  projectId?: string
  llmConnection?: string
  permissionMode?: PermissionMode
  enabledSourceSlugs?: readonly string[]
}

export interface CreateBoardTaskPorts {
  sessionManager: ISessionManager
  /** The project handle service; the caller's own folder is resolved through it (`resolveHandle({ sessionId })`). */
  handles: Pick<ProjectHandleService, 'resolveHandle'> | undefined
  /** Slugs of the sources that exist in the caller's workspace. */
  workspaceSourceSlugs(): readonly string[]
  /** Slugs of the skills a dispatched prompt can resolve (global + workspace), as upstream's `loadAllSkills`. */
  workspaceSkillSlugs(): readonly string[]
}

function refuse(code: string, sentence: string): never {
  throw new Error(`${code}: ${sentence}`)
}

export async function createBoardTaskForCaller(
  ports: CreateBoardTaskPorts,
  caller: BoardTaskCaller,
  input: CreateBoardTaskInput,
): Promise<CreateBoardTaskResult> {
  const title = input.title?.trim()
  const description = input.description?.trim()
  if (!title) throw new Error('title is required.')
  if (!description) throw new Error('description is required.')

  // 4 — the connection.
  if (input.llmConnection !== undefined && input.llmConnection !== caller.llmConnection) {
    refuse('board-task-connection-refused', `a task created by an agent runs on the creating session's own connection`
      + `${caller.llmConnection ? ` ("${caller.llmConnection}")` : ''}; "${input.llmConnection}" is another connection. Omit llmConnection.`)
  }
  const llmConnection = input.llmConnection ?? caller.llmConnection

  // The caller's own folder handle (read by 1 and 2).
  const callerFolder = ports.handles
    ? await ports.handles.resolveHandle({ workspaceId: caller.workspaceId, sessionId: caller.sessionId })
    : null

  // 2 — the project: the caller's own, or one whose folder has the caller's stable projectKey.
  if (input.projectId !== undefined && input.projectId !== caller.projectId) {
    const targetKey = loadProjectById(caller.workspaceRoot, input.projectId)?.config.folder?.projectKey
    const sameFolder = targetKey !== undefined && callerFolder?.persistence === 'stable'
      && targetKey === callerFolder.projectKey
    if (!sameFolder) {
      refuse('project-handle-required', `a task created by an agent stays in the creating session's own project, or a `
        + `project bound to the session's own folder; "${input.projectId}" is neither. Omit projectId.`)
    }
  }
  // upstream's rule, through upstream's helper (UA5.10): an explicit project wins, else the caller's own.
  const projectId = resolveCreateTaskProjectId(input.projectId, caller.projectId)

  // 3 — sources: a subset of the caller's enabled ones; unknown ones warn and are dropped.
  const warnings: string[] = []
  const callerSources = [...(caller.enabledSourceSlugs ?? [])]
  let sources = callerSources
  if (input.sources !== undefined) {
    const existing = new Set(ports.workspaceSourceSlugs())
    const enabled = new Set(callerSources)
    const unknown = input.sources.filter(slug => !existing.has(slug))
    const notEnabled = input.sources.filter(slug => existing.has(slug) && !enabled.has(slug))
    if (notEnabled.length) {
      refuse('board-task-source-not-enabled', `a task created by an agent may use only sources enabled in the creating `
        + `session (${callerSources.length ? callerSources.join(', ') : 'none'}); not enabled here: ${notEnabled.join(', ')}.`)
    }
    if (unknown.length) {
      warnings.push(`Unknown sources (not added to the task: they don't exist in this workspace): ${unknown.join(', ')}`)
    }
    sources = [...new Set(input.sources.filter(slug => enabled.has(slug)))]
  }

  if (input.skills?.length) {
    const available = new Set(ports.workspaceSkillSlugs())
    const missing = input.skills.filter(slug => !available.has(slug))
    if (missing.length) warnings.push(`Unknown skills (kept in the spec, but they don't exist in this workspace): ${missing.join(', ')}`)
  }

  // 1 — the folder: the caller's own handle, trusted, or no folder at all.
  if (input.workingDirectory !== undefined
    && input.workingDirectory !== callerFolder?.canonicalPath
    && input.workingDirectory !== callerFolder?.displayPath) {
    refuse('project-handle-required', `a task created by an agent runs in the creating session's own working folder`
      + `${callerFolder ? ` (${callerFolder.displayPath})` : ' (this session has none)'}; another folder is refused. Omit workingDirectory.`)
  }
  if (callerFolder && callerFolder.trustState !== 'trusted') throw new Error('task-cwd-untrusted')

  // 6 — derive and claim the slug in one synchronous step (no await between), then create.
  const { sessionManager } = ports
  const slug = uniqueTaskSlug(title, takenTaskSlugs(sessionManager, caller.workspaceId, caller.workspaceRoot))
  const release = claimTaskSlug(sessionManager, caller.workspaceId, caller.workspaceRoot, slug)
  try {
    // A spec requires ≥1 node; the single executable node is synthesised from the description (upstream). Multi-node
    // authoring stays with the editor and Generate.
    const parsed = parseTaskSpec({
      id: slug,
      title,
      goal: description,
      ...(input.acceptanceCriteria?.trim() ? { acceptance_criteria: input.acceptanceCriteria } : {}),
      ...(projectId ? { project: projectId } : {}),
      ...(input.workingDirectory !== undefined && callerFolder ? { cwd: callerFolder.canonicalPath } : {}),
      ...(sources.length ? { sources } : {}),
      ...(input.skills?.length ? { skills: input.skills } : {}),
      ...(input.model || llmConnection
        ? { defaults: { ...(input.model ? { model: input.model } : {}), ...(llmConnection ? { llmConnection } : {}) } }
        : {}),
      nodes: [{ id: 'main', title, prompt: description }],
    })
    if (!parsed.success) {
      throw new Error(`Invalid task spec: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
    }
    const created = await createTaskFromSpec(sessionManager, caller.workspaceId, caller.workspaceRoot, parsed.data, {
      ...(callerFolder ? { projectHandleId: callerFolder.id } : {}),
      ...(caller.permissionMode ? { permissionMode: caller.permissionMode } : {}),
    })
    return {
      slug: created.slug,
      orchestratorSessionId: created.orchestratorSessionId,
      ...(created.taskLabelId ? { taskLabelId: created.taskLabelId } : {}),
      warnings: [...warnings, ...created.warnings],
    }
  } finally {
    release()
  }
}

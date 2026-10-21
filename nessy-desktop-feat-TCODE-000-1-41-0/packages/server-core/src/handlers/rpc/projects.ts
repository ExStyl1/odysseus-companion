/**
 * Project RPC: the FOLDER channels (ours — picker, validation, recents, trust, session folder, workspace default) and,
 * since UA5.3, the project ENTITY channels adapted from craft-agents-oss
 * `v0.13.4:packages/server-core/src/handlers/rpc/projects.ts` (Apache-2.0), merged into one `projects` block (spec §12
 * "RPC": the channel strings are disjoint).
 *
 * UA5.3 — `projects:get`, `getOne`, `create`, `update`, `delete`, the `projects:changed` push, and ours
 * `projects:setFolder`. Stated divergences from v0.13.4:
 * - Every handler runs `assertCallerWorkspace` (UA1.9) first, refusing `project-workspace-mismatch` (upstream: no
 *   caller check), and the workspace root comes from the workspace service, never from the wire.
 * - **A folder crosses only as a handle (spec §12 "Folder (adapt)", reason (b)).** `create` takes an issued handle id
 *   (`CreateProjectRequest.projectHandleId`) and hands the RESOLVED handle to `createProject` (upstream: a raw
 *   `workingDirectory`, now refused with `project-folder-handle-required`); `update` refuses a folder key (storage);
 *   `projects:setFolder` (ours — upstream changed the folder through `update`) is the folder's only other writer.
 *   Every read answers {@link toProjectView}: the stored folder re-validated through the handle service's raw-path
 *   ingress and its persisted `projectKey` compared (`resolveStoredProjectFolder`), as `{ handleId, displayPath,
 *   trusted, problem? }` — never the stored path record.
 * - `delete` unbinds the sessions through the host (`ISessionManager.unbindProjectFromSessions`: the live sessions
 *   first, then the ones only on disk — upstream rewrote disk alone, which a live session's next persist undoes),
 *   then the pages (`unbindProjectFromPages`, UA6.2's half — the pages unit is on this branch), then removes
 *   `projects/<slug>/`. The bound folder is never touched.
 * UA5.6 — v0.13.4 L12–L14, L99–L135: `listAssets`, `uploadAsset`, `deleteAsset` (a wire `sourcePath` refused).
 */
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type {
  CreateProjectRequest,
  LoadedProjectView,
  ProjectConfigView,
  ProjectFolderView,
  ProjectTrustSelection, SetProjectTrustInput,
  SetSessionProjectInput,
  SetWorkspaceDefaultProjectInput,
  UpdateProjectPatch,
} from '@nessy-agent/shared/protocol'
import type { LoadedProject, ProjectConfig } from '@nessy-agent/shared/projects/types'
import { ProjectDirectoryError, resolveStoredProjectFolder } from '@nessy-agent/shared/projects/project-handle-service'
import type {
  ProjectHandleRef,
  ProjectHandleService,
  ResolvedProjectHandle,
} from '@nessy-agent/shared/projects/project-handle-service'
import type { RecentProjectStore } from '@nessy-agent/shared/projects/recent-store'
import { pushTyped, requestClientOpenFileDialog, type RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { getWorkspaceOrThrow } from '../utils'
import { assertCallerWorkspace } from './caller-workspace'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.projects.PICK_LOCAL_DIRECTORY,
  RPC_CHANNELS.projects.VALIDATE_DIRECTORY,
  RPC_CHANNELS.projects.LIST_RECENT,
  RPC_CHANNELS.projects.ISSUE_RECENT_HANDLE,
  RPC_CHANNELS.projects.SET_TRUST,
  RPC_CHANNELS.projects.SET_SESSION_PROJECT,
  RPC_CHANNELS.projects.SET_WORKSPACE_DEFAULT,
  // UA5.3 — the project entity (v0.13.4) and ours, setFolder
  RPC_CHANNELS.projects.GET,
  RPC_CHANNELS.projects.GET_ONE,
  RPC_CHANNELS.projects.CREATE,
  RPC_CHANNELS.projects.UPDATE,
  RPC_CHANNELS.projects.DELETE,
  RPC_CHANNELS.projects.SET_FOLDER, RPC_CHANNELS.projects.LIST_ASSETS, RPC_CHANNELS.projects.UPLOAD_ASSET, RPC_CHANNELS.projects.DELETE_ASSET, // UA5.6 — the v0.13.4 asset channels, one line so no cited line moves
] as const

/** The refusal every handler raises for a caller bound to another workspace (UA1.9). */
const WORKSPACE_MISMATCH = 'project-workspace-mismatch'

export interface ProjectsHandlerOptions {
  handleService?: ProjectHandleService
  recentStore?: RecentProjectStore
}

export function registerProjectsHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  options: ProjectsHandlerOptions = {},
): void {
  const handles = options.handleService ?? deps.sessionManager.getProjectHandleService?.()
  const recents = options.recentStore ?? deps.sessionManager.getRecentProjectStore?.()

  const validateAndRecord = async (workspaceId: string, candidatePath: string) => {
    const service = requireHandles(handles)
    const issued = await service.validateProjectDirectory(workspaceId, candidatePath)
    if (recents) {
      const resolved = await service.resolveHandle({ workspaceId, projectHandleId: issued.id })
      if (resolved) recordRecentSafely(recents, resolved, deps)
    }
    return issued
  }

  server.handle(RPC_CHANNELS.projects.PICK_LOCAL_DIRECTORY, async (ctx, workspaceId: string) => {
    assertCallerWorkspace(ctx, deps, workspaceId, 'project-workspace-mismatch')
    const result = await requestClientOpenFileDialog(server, ctx.clientId, {
      properties: ['openDirectory'],
      title: 'Select working folder',
    })
    const candidatePath = result.canceled ? undefined : result.filePaths[0]
    return candidatePath ? validateAndRecord(workspaceId, candidatePath) : null
  })

  server.handle(
    RPC_CHANNELS.projects.VALIDATE_DIRECTORY,
    async (ctx, input: { workspaceId: string; candidatePath: string }) => {
      assertCallerWorkspace(ctx, deps, input.workspaceId, 'project-workspace-mismatch')
      return validateAndRecord(input.workspaceId, input.candidatePath)
    },
  )

  server.handle(RPC_CHANNELS.projects.LIST_RECENT, async (ctx, workspaceId: string) => {
    assertCallerWorkspace(ctx, deps, workspaceId, 'project-workspace-mismatch')
    return recents?.listRecentProjects(workspaceId) ?? []
  })

  server.handle(
    RPC_CHANNELS.projects.ISSUE_RECENT_HANDLE,
    async (ctx, input: { workspaceId: string; recentProjectId: string }) => {
      assertCallerWorkspace(ctx, deps, input.workspaceId, 'project-workspace-mismatch')
      if (!recents) throw new Error('recent-project-store-unavailable')
      return recents.issueRecentProjectHandle(input, requireHandles(handles))
    },
  )

  server.handle(RPC_CHANNELS.projects.SET_TRUST, async (ctx, input: SetProjectTrustInput) => {
    const workspaceId = 'session' in input ? input.session.workspaceId : input.workspaceId
    assertCallerWorkspace(ctx, deps, workspaceId, 'project-workspace-mismatch')
    const ref: ProjectHandleRef = 'session' in input
      ? { workspaceId, sessionId: input.session.sessionId }
      : { workspaceId, projectHandleId: input.projectHandleId }
    // D1.363 — awaited INSIDE the try on purpose: a bare `return promise` here
    // settles outside this frame and the catch below never runs.
    try {
      if (deps.sessionManager.setProjectTrust) return await deps.sessionManager.setProjectTrust(input)
      return await requireHandles(handles).setProjectTrust(ref, toStoredTrust(input.state))
    } catch (error) {
      throw asTerminalTrustFailure(error, handles, ref)
    }
  })

  server.handle(RPC_CHANNELS.projects.SET_SESSION_PROJECT, async (ctx, input: SetSessionProjectInput) => {
    assertCallerWorkspace(ctx, deps, input.session.workspaceId, 'project-workspace-mismatch')
    return deps.sessionManager.setSessionProject(input)
  })

  server.handle(
    RPC_CHANNELS.projects.SET_WORKSPACE_DEFAULT,
    async (ctx, input: SetWorkspaceDefaultProjectInput) => {
      assertCallerWorkspace(ctx, deps, input.workspaceId, 'project-workspace-mismatch')
      return deps.sessionManager.setWorkspaceDefaultProject(input)
    },
  )

  // ---------------------------------------------------------------------------
  // UA5.3 — the project ENTITY (v0.13.4 L17–L98, adapted: see the header)
  // ---------------------------------------------------------------------------

  const log = deps.platform.logger

  /** The caller's own workspace root, after the caller-workspace check. */
  const rootFor = (ctx: Parameters<typeof assertCallerWorkspace>[0], workspaceId: string): string => {
    assertCallerWorkspace(ctx, deps, workspaceId, WORKSPACE_MISMATCH)
    return getWorkspaceOrThrow(deps.workspaceService, workspaceId).workspaceRootPath
  }

  /** An issued handle of THIS workspace, resolved (re-validated) now — the only way a folder enters an entity. */
  const resolveFolderHandle = async (workspaceId: string, projectHandleId: string) => {
    const resolved = await requireHandles(handles).resolveHandle({ workspaceId, projectHandleId })
    if (!resolved) throw new Error('project-handle-invalid')
    return resolved
  }

  const viewsOf = async (workspaceId: string, workspaceRootPath: string): Promise<LoadedProjectView[]> => {
    const { loadWorkspaceProjects } = await import('@nessy-agent/shared/projects')
    return Promise.all(loadWorkspaceProjects(workspaceRootPath).map(project => toLoadedProjectView(handles, workspaceId, project)))
  }

  async function broadcastChanged(workspaceId: string, workspaceRootPath: string): Promise<void> {
    pushTyped(server, RPC_CHANNELS.projects.CHANGED, { to: 'workspace', workspaceId }, workspaceId, await viewsOf(workspaceId, workspaceRootPath))
  }

  // List all projects of the workspace
  server.handle(RPC_CHANNELS.projects.GET, async (ctx, workspaceId: string) => {
    return viewsOf(workspaceId, rootFor(ctx, workspaceId))
  })

  // One project, by slug or by id
  server.handle(RPC_CHANNELS.projects.GET_ONE, async (ctx, workspaceId: string, projectIdOrSlug: string) => {
    const root = rootFor(ctx, workspaceId)
    const { loadProject, loadProjectById } = await import('@nessy-agent/shared/projects')
    const project = loadProject(root, projectIdOrSlug) ?? loadProjectById(root, projectIdOrSlug)
    return project ? toLoadedProjectView(handles, workspaceId, project) : null
  })

  // Create a project; its folder, if any, is an issued handle of this workspace
  server.handle(RPC_CHANNELS.projects.CREATE, async (ctx, workspaceId: string, input: CreateProjectRequest) => {
    const root = rootFor(ctx, workspaceId)
    const { createProject, ProjectStorageError } = await import('@nessy-agent/shared/projects')
    // A raw path is refused as the storage refuses it; a wire key we do not forward never vanishes silently.
    if (input && ('workingDirectory' in input || 'folder' in input)) throw new ProjectStorageError('project-folder-handle-required')
    const folderHandle = input?.projectHandleId ? await resolveFolderHandle(workspaceId, input.projectHandleId) : undefined
    const project = createProject(root, {
      name: input?.name?.trim() || 'New Project',
      description: input?.description,
      details: input?.details,
      colorTheme: input?.colorTheme,
      color: input?.color,
    }, folderHandle)
    await broadcastChanged(workspaceId, root)
    log.info(`Created project: ${project.slug}`)
    return toProjectConfigView(handles, workspaceId, project)
  })

  // Update a project (partial patch). The slug stays stable; a folder key is refused (setFolder is its writer)
  server.handle(RPC_CHANNELS.projects.UPDATE, async (ctx, workspaceId: string, projectSlug: string, patch: UpdateProjectPatch) => {
    const root = rootFor(ctx, workspaceId)
    const { updateProject } = await import('@nessy-agent/shared/projects')
    const updated = updateProject(root, projectSlug, patch)
    await broadcastChanged(workspaceId, root)
    return toProjectConfigView(handles, workspaceId, updated)
  })

  // Ours: bind (an issued handle id) or unbind (null) the project's folder; never touches bound sessions (UA5.4)
  server.handle(RPC_CHANNELS.projects.SET_FOLDER, async (ctx, workspaceId: string, projectSlug: string, projectHandleId: string | null) => {
    const root = rootFor(ctx, workspaceId)
    const { setProjectFolderFromHandle } = await import('@nessy-agent/shared/projects')
    const folderHandle = projectHandleId === null ? null : await resolveFolderHandle(workspaceId, projectHandleId)
    const updated = setProjectFolderFromHandle(root, projectSlug, folderHandle)
    await broadcastChanged(workspaceId, root)
    return toProjectConfigView(handles, workspaceId, updated)
  })

  // Delete a project: unbind its sessions (live, then on disk), then its pages, then remove projects/<slug>/
  server.handle(RPC_CHANNELS.projects.DELETE, async (ctx, workspaceId: string, projectSlug: string) => {
    const root = rootFor(ctx, workspaceId)
    const { loadProject, deleteProject } = await import('@nessy-agent/shared/projects')
    const project = loadProject(root, projectSlug)
    if (!project) {
      log.warn(`PROJECTS_DELETE: project ${projectSlug} not found`)
      return
    }
    const touched = await deps.sessionManager.unbindProjectFromSessions(workspaceId, project.config.id)
    const { unbindProjectFromPages } = await import('@nessy-agent/shared/pages')
    const touchedPages = unbindProjectFromPages(root, project.config.id)
    deleteProject(root, projectSlug)
    // UA12.109 — the mirror's `project-context` ledger entry (subject `project:<id>`, recorded by
    // `writeProjectContextMirror`) must not outlive the project. The mirror queue is drained first — a queued
    // write for a project that is now gone skips itself on its `config.json` check, so nothing can re-record
    // after the revoke — then the entry is revoked BEST-EFFORT: an unavailable or sealed ledger key never
    // blocked a delete, and such a workspace never recorded an entry in the first place.
    const { projectContextMirrorIdle, projectContextSubject } = await import('@nessy-agent/shared/projects/project-context')
    const { getHostApprovalsKeyProvider, revokeHostApproval } = await import('@nessy-agent/shared/approvals/host-approvals')
    await projectContextMirrorIdle()
    try {
      revokeHostApproval(root, await getHostApprovalsKeyProvider().getKey(), 'project-context', projectContextSubject(project.config.id))
    } catch (error) {
      log.warn(`PROJECTS_DELETE: the project-context ledger entry was not revoked: ${error instanceof Error ? error.message : String(error)}`)
    }
    await broadcastChanged(workspaceId, root)
    log.info(`Deleted project ${projectSlug} (unbound ${touched} sessions, ${touchedPages} pages)`)
  })

  // ---------------------------------------------------------------------------
  // UA5.6 — the project ASSETS (v0.13.4 L99–L135). Divergences: every handler runs the caller-workspace check and takes
  // the root from the workspace service (as above); an upload's `sourcePath` is refused (reason (b): a path from the
  // wire would copy any file the server can read into `assets/`, where every runtime reads it — upstream's renderer
  // sends base64 alone). The storage sanitises the name (no separators, control characters or leading dots) and never
  // writes through a link planted in `assets/` (`projects/storage.ts` header item 7).
  // ---------------------------------------------------------------------------

  // List a project's assets (newest first)
  server.handle(RPC_CHANNELS.projects.LIST_ASSETS, async (ctx, workspaceId: string, projectSlug: string) => {
    const root = rootFor(ctx, workspaceId)
    const { listProjectAssets } = await import('@nessy-agent/shared/projects')
    return listProjectAssets(root, projectSlug)
  })

  // Upload an asset (base64 / text)
  server.handle(RPC_CHANNELS.projects.UPLOAD_ASSET, async (
    ctx,
    workspaceId: string,
    projectSlug: string,
    input: import('@nessy-agent/shared/projects').UploadProjectAssetInput,
  ) => {
    const root = rootFor(ctx, workspaceId)
    if (input && typeof input === 'object' && 'sourcePath' in input) throw new Error('project-asset-source-path-refused')
    const { uploadProjectAsset } = await import('@nessy-agent/shared/projects')
    const asset = uploadProjectAsset(root, projectSlug, { filename: input?.filename, base64: input?.base64, text: input?.text })
    await broadcastChanged(workspaceId, root)
    log.info(`Uploaded asset ${asset.filename} to project ${projectSlug}`)
    return asset
  })

  // Delete an asset by filename
  server.handle(RPC_CHANNELS.projects.DELETE_ASSET, async (ctx, workspaceId: string, projectSlug: string, filename: string) => {
    const root = rootFor(ctx, workspaceId)
    const { deleteProjectAsset } = await import('@nessy-agent/shared/projects')
    deleteProjectAsset(root, projectSlug, filename)
    await broadcastChanged(workspaceId, root)
  })
}

/**
 * UA5.3 — a project's folder as the renderer sees it (spec §12): the stored record re-validated now, never returned.
 * Without a handle service the folder is reported unavailable rather than guessed at.
 */
async function toProjectFolderView(
  handles: ProjectHandleService | undefined,
  workspaceId: string,
  folder: NonNullable<ProjectConfig['folder']>,
): Promise<ProjectFolderView> {
  if (!handles) return { handleId: null, displayPath: folder.workingDirectory, trusted: false, problem: 'project-folder-unavailable' }
  const resolution = await resolveStoredProjectFolder(handles, workspaceId, folder)
  if (!resolution.ok) return { handleId: null, displayPath: folder.workingDirectory, trusted: false, problem: resolution.problem }
  return { handleId: resolution.handle.id, displayPath: resolution.handle.displayPath, trusted: resolution.handle.trustState === 'trusted' }
}

/** UA5.3 — `ProjectConfig` → its renderer view (the folder replaced by {@link toProjectFolderView}). */
export async function toProjectConfigView(
  handles: ProjectHandleService | undefined,
  workspaceId: string,
  config: ProjectConfig,
): Promise<ProjectConfigView> {
  const { folder, ...rest } = config
  return folder ? { ...rest, folder: await toProjectFolderView(handles, workspaceId, folder) } : rest
}

/** UA5.3 — `LoadedProject` → its renderer view. */
async function toLoadedProjectView(
  handles: ProjectHandleService | undefined,
  workspaceId: string,
  project: LoadedProject,
): Promise<LoadedProjectView> {
  return { ...project, config: await toProjectConfigView(handles, workspaceId, project.config) }
}

/**
 * D1.363 — a trust answer for a folder that is GONE must reach the renderer as a
 * TERMINAL answer.
 *
 * Measured on the packaged 1.40.0 (measure sitting 5e, case `RS-80`): with the
 * "Trust this project?" modal up, the folder it named was deleted, and every
 * click from then on answered "Could not update project trust" — a dead end,
 * because no click could ever succeed. The dialog could not tell that from a
 * transient failure: both arrive as `project-handle-invalid`.
 *
 * TWO throw sites reach here and only one is the service's own. The dialog's
 * "Trust project" button goes through `SessionManager.setProjectTrust`'s
 * `handles.setProjectTrust` (already terminal after the service change), while
 * "Keep restricted" takes the revoke path, whose `if (!target) throw` is
 * SessionManager's own and knows nothing about why the handle died. So the
 * upgrade is applied HERE, once, where both land — and only when the service
 * itself says the handle's own folder is gone, so every other cause keeps the
 * word it had.
 *
 * `project-directory-invalid` is upgraded the same way: on this path it is
 * raised by a re-validation of a path that WAS valid when the handle was issued,
 * which is the same terminal fact spelled by the ingress error.
 */
function asTerminalTrustFailure(
  error: unknown,
  handles: ProjectHandleService | undefined,
  ref: ProjectHandleRef,
): unknown {
  if (error instanceof ProjectDirectoryError && error.code === 'project-directory-missing') return error
  const message = error instanceof Error ? error.message : String(error)
  if (message !== 'project-handle-invalid' && message !== 'project-directory-invalid') return error
  if (!handles) return error
  return handles.describeUnresolvableRef(ref) === 'project-directory-missing'
    ? new ProjectDirectoryError('project-directory-missing')
    : error
}

function requireHandles(handles: ProjectHandleService | undefined): ProjectHandleService {
  if (!handles) throw new Error('project-handle-service-unavailable')
  return handles
}

function toStoredTrust(state: ProjectTrustSelection): 'trusted' | 'blocked' {
  return state === 'trusted' ? 'trusted' : 'blocked'
}

function recordRecentSafely(
  recents: RecentProjectStore,
  project: ResolvedProjectHandle,
  deps: HandlerDeps,
): void {
  try {
    recents.recordValidatedProject(project)
  } catch {
    deps.platform.logger.warn('Recent project history update failed; selection remains valid')
  }
}

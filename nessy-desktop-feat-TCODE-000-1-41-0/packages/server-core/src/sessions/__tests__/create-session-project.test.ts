/**
 * UA5.4 — `createSession({ projectId })` and `spawn_session`'s `projectId` under the folder rule (craft-agents-oss
 * v0.13.4 `SessionManager.createSession`, `spawn-session-tool.ts`, `base-agent.ts`, Apache-2.0; spec §12 "Binding").
 *
 * Premise read (the row's): upstream `setSessionProjectId` does NOT move the cwd — its docblock says "The session's
 * working directory is NOT changed retroactively — the project binding is only used as a default for newly created
 * sessions"; UA5.3's `set-kanban-column.test.ts` pins ours.
 *
 * Positive: the project's folder becomes the session's folder (as an issued handle, bound to the session), and a
 * trusted folder brings its project defaults; a folderless project id binds through the spawn rule; the entity is
 * checked (an inherited id of a deleted project is dropped).
 * Negative: the folder replaced on disk (a new identity at the same path) → `project-folder-identity-changed`;
 * `config.json`'s `folder.workingDirectory` edited to another TRUSTED folder → `project-folder-identity-changed`, not
 * a session there; an untrusted folder binds untrusted (no project defaults) and the renderer's gate sees `unknown`,
 * i.e. the trust flow is raised; an explicit unknown project id is refused; `spawn_session` with a project bound to
 * another folder is refused; `setSessionProjectId` never moves the folder.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '@nessy-agent/shared/projects'
import { ProjectTrustStore } from '@nessy-agent/shared/capabilities/project-trust-store'
import { ProjectHandleService, type ResolvedProjectHandle } from '@nessy-agent/shared/projects/project-handle-service'
import { isErrorCode } from '@nessy-agent/shared/protocol'
import { SPAWN_SESSION_TOOL_INPUT_SCHEMA } from '../../../../shared/src/agent/spawn-session-tool.ts'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import { createManagedSession, type SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const stateRoot = mkdtempSync(join(tmpdir(), 'nessy-ua5-4-'))
const workspaceIds: string[] = []
afterAll(() => {
  rmSync(stateRoot, { recursive: true, force: true })
  for (const id of workspaceIds) rmSync(join(SESSIONS_DIR, id), { recursive: true, force: true })
})

let counter = 0
function setup() {
  const tag = `${Date.now()}-${++counter}`
  const workspaceId = `ws-ua5-4-${tag}`
  workspaceIds.push(workspaceId)
  const rootPath = join(stateRoot, `workspace-${tag}`)
  mkdirSync(rootPath, { recursive: true })
  const workspace = {
    id: workspaceId,
    workspaceRootPath: rootPath,
    sessionRootPath: join(rootPath, 'sessions'),
    config: { id: workspaceId, name: workspaceId, createdAt: 1, updatedAt: 1 },
    lastAccessedAt: 1,
  }
  const workspaceService = { resolve: () => workspace, listResolved: () => [workspace] } as unknown as WorkspaceService
  const handles = new ProjectHandleService({ trustStore: new ProjectTrustStore({ path: join(rootPath, 'trust.json') }) })
  const sm = createTestSessionManager({ workspaceService, projectHandleService: handles })
  const folder = (name: string, defaultsToml?: string): string => {
    const path = join(stateRoot, `folder-${tag}-${name}`)
    mkdirSync(path, { recursive: true })
    if (defaultsToml) {
      mkdirSync(join(path, '.nessy-agent'), { recursive: true })
      writeFileSync(join(path, '.nessy-agent', 'config.toml'), defaultsToml)
    }
    return path
  }
  const resolved = async (path: string): Promise<ResolvedProjectHandle> => {
    const issued = await handles.validateProjectDirectory(workspaceId, path)
    return (await handles.resolveHandle({ workspaceId, projectHandleId: issued.id }))!
  }
  const trust = async (path: string) => {
    await handles.setProjectTrust({ workspaceId, projectHandleId: (await resolved(path)).id }, 'trusted')
  }
  const sessionCount = () => {
    const dir = join(SESSIONS_DIR, workspaceId)
    return existsSync(dir) ? readdirSync(dir).length : 0
  }
  return { workspaceId, rootPath, handles, sm, folder, resolved, trust, sessionCount }
}

const PROJECT_DEFAULTS = '[defaults]\nmodel = "ua5-4-project-model"\n'

describe('UA5.4 — createSession({ projectId }) takes the project folder through a handle', () => {
  it('the project folder becomes the session folder, bound as a handle; a trusted folder brings its project defaults', async () => {
    const t = setup()
    try {
      const dir = t.folder('trusted', PROJECT_DEFAULTS)
      await t.trust(dir)
      const project = createProject(t.rootPath, { name: 'Alpha' }, await t.resolved(dir))

      const session = await t.sm.createSession(t.workspaceId, { projectId: project.id })

      expect(session.projectId).toBe(project.id)
      expect(session.workingDirectory).toBe(realpathSync(dir))
      expect(session.model).toBe('ua5-4-project-model')
      // Bound to the handle service like any explicit handle (the folder's trust and identity follow the session).
      const bound = await t.handles.resolveHandle({ workspaceId: t.workspaceId, sessionId: session.id })
      expect(bound?.canonicalPath).toBe(realpathSync(dir))
      expect(bound?.trustState).toBe('trusted')
    } finally {
      t.sm.cleanup()
    }
  })

  it('an untrusted folder binds untrusted — no project defaults — and the renderer gate reads unknown (the trust flow)', async () => {
    const t = setup()
    try {
      const dir = t.folder('untrusted', PROJECT_DEFAULTS)
      const project = createProject(t.rootPath, { name: 'Beta' }, await t.resolved(dir))

      const session = await t.sm.createSession(t.workspaceId, { projectId: project.id })

      expect(session.workingDirectory).toBe(realpathSync(dir))
      expect(session.model).not.toBe('ua5-4-project-model')
      // What ChatPage's gate (`resolveProjectTrustPrompt`) asks the host about this session's folder.
      expect((await t.handles.validateProjectDirectory(t.workspaceId, session.workingDirectory!)).trustState).toBe('unknown')
    } finally {
      t.sm.cleanup()
    }
  })

  it('NEGATIVE: the folder replaced on disk (same path, new identity) is project-folder-identity-changed, and nothing is created', async () => {
    const t = setup()
    try {
      const dir = t.folder('replaced')
      await t.trust(dir)
      const project = createProject(t.rootPath, { name: 'Gamma' }, await t.resolved(dir))
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir)
      const before = t.sessionCount()

      await expect(t.sm.createSession(t.workspaceId, { projectId: project.id })).rejects.toThrow('project-folder-identity-changed')
      expect(t.sessionCount()).toBe(before)
    } finally {
      t.sm.cleanup()
    }
  })

  it('NEGATIVE: config.json folder.workingDirectory edited to another TRUSTED folder is project-folder-identity-changed, not a session there', async () => {
    const t = setup()
    try {
      const bound = t.folder('bound')
      const other = t.folder('other-trusted', PROJECT_DEFAULTS)
      await t.trust(bound)
      await t.trust(other)
      const project = createProject(t.rootPath, { name: 'Delta' }, await t.resolved(bound))
      const configPath = join(t.rootPath, 'projects', project.slug, 'config.json')
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      writeFileSync(configPath, JSON.stringify({ ...config, folder: { ...config.folder, workingDirectory: other } }))
      const before = t.sessionCount()

      await expect(t.sm.createSession(t.workspaceId, { projectId: project.id })).rejects.toThrow('project-folder-identity-changed')
      // Deleting the key too does not skip the comparison.
      const { projectKey: _key, ...keyless } = config.folder
      writeFileSync(configPath, JSON.stringify({ ...config, folder: { ...keyless, workingDirectory: other } }))
      await expect(t.sm.createSession(t.workspaceId, { projectId: project.id })).rejects.toThrow('project-folder-identity-changed')
      expect(t.sessionCount()).toBe(before)

      // CONTROL: the untouched record creates the session in the bound folder.
      writeFileSync(configPath, JSON.stringify(config))
      expect((await t.sm.createSession(t.workspaceId, { projectId: project.id })).workingDirectory).toBe(realpathSync(bound))
    } finally {
      t.sm.cleanup()
    }
  })

  it('NEGATIVE (UA12.149): the identity-changed refusal carries its code for the wire — createSession({projectId})', async () => {
    // SIT-B X2 measured the refusal crossing as `code=HANDLER_ERROR` with the reason only in
    // `message`, because the raise was a plain Error (message-as-code). The fix is a CodedError:
    // the code rides `WireError.code`, the message keeps the exact spelling the project page's
    // toast renders (ProjectInfoPage shows `err.message`), and `isErrorCode` — the very predicate
    // the transport's dispatch catch applies (`transport/server.ts`) — must accept it, or the wire
    // would fold it straight back to HANDLER_ERROR. The transport's code preservation itself is
    // `transport/__tests__/error-codes.test.ts`'s own arm.
    const t = setup()
    try {
      const dir = t.folder('coded-replaced')
      await t.trust(dir)
      const project = createProject(t.rootPath, { name: 'Theta' }, await t.resolved(dir))
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir) // same path, NEW identity — the replaced folder

      let refused: unknown
      try { await t.sm.createSession(t.workspaceId, { projectId: project.id }) } catch (error) { refused = error }
      expect(refused).toBeInstanceOf(Error)
      expect((refused as { code?: string }).code).toBe('project-folder-identity-changed')
      expect((refused as Error).message).toBe('project-folder-identity-changed') // the toast's text, unchanged
      expect(isErrorCode((refused as { code?: string }).code)).toBe(true)

      // Boundary: the OTHER refusal at the same raise site — a folder that cannot be resolved
      // at all — deliberately stays a plain Error (UA12.149 codes the identity refusal only),
      // so it crosses as HANDLER_ERROR with `project-folder-unavailable: <cause>` in the message.
      rmSync(dir, { recursive: true, force: true })
      let unavailable: unknown
      try { await t.sm.createSession(t.workspaceId, { projectId: project.id }) } catch (error) { unavailable = error }
      expect(unavailable).toBeInstanceOf(Error)
      expect((unavailable as { code?: string }).code).toBeUndefined()
      expect((unavailable as Error).message).toStartWith('project-folder-unavailable')
    } finally {
      t.sm.cleanup()
    }
  })

  it('an explicit caller choice wins: a projectHandleId, or workingDirectory "none"', async () => {
    const t = setup()
    try {
      const projectDir = t.folder('project')
      const chosen = t.folder('chosen')
      const project = createProject(t.rootPath, { name: 'Epsilon' }, await t.resolved(projectDir))
      const viaHandle = await t.sm.createSession(t.workspaceId, { projectId: project.id, projectHandleId: (await t.resolved(chosen)).id })
      expect(viaHandle.workingDirectory).toBe(realpathSync(chosen))
      expect(viaHandle.projectId).toBe(project.id)
      const none = await t.sm.createSession(t.workspaceId, { projectId: project.id, workingDirectory: 'none' })
      expect(none.workingDirectory).not.toBe(realpathSync(projectDir))
      expect(none.projectId).toBe(project.id)
    } finally {
      t.sm.cleanup()
    }
  })

  it('the entity check: an explicit unknown id is refused; an inherited one (the parent\'s project deleted since) is dropped', async () => {
    const t = setup()
    try {
      const before = t.sessionCount()
      await expect(t.sm.createSession(t.workspaceId, { projectId: 'proj_00000000' })).rejects.toThrow('project-not-found')
      expect(t.sessionCount()).toBe(before)

      const project = createProject(t.rootPath, { name: 'Zeta' })
      const parent = await t.sm.createSession(t.workspaceId, { projectId: project.id })
      const child = await t.sm.createSession(t.workspaceId, { parentSessionId: parent.id })
      expect(child.projectId).toBe(project.id) // inherited while it exists
      rmSync(join(t.rootPath, 'projects', project.slug), { recursive: true, force: true })
      const orphan = await t.sm.createSession(t.workspaceId, { parentSessionId: parent.id })
      expect(orphan.projectId).toBeUndefined()
    } finally {
      t.sm.cleanup()
    }
  })

  it('setSessionProjectId never moves the folder', async () => {
    const t = setup()
    try {
      const sessionDir = t.folder('session')
      const projectDir = t.folder('elsewhere')
      const project = createProject(t.rootPath, { name: 'Eta' }, await t.resolved(projectDir))
      const session = await t.sm.createSession(t.workspaceId, { projectHandleId: (await t.resolved(sessionDir)).id })

      await t.sm.setSessionProjectId(session.id, project.id, t.workspaceId)

      const after = t.sm.getSessions(t.workspaceId).find(s => s.id === session.id)!
      expect(after.projectId).toBe(project.id)
      expect(after.workingDirectory).toBe(realpathSync(sessionDir))
    } finally {
      t.sm.cleanup()
    }
  })
})

describe('UA5.4 — spawn_session projectId under the folder rule', () => {
  type Internals = {
    spawnSessionProjectFields(caller: unknown, callerFolder: ResolvedProjectHandle | null, projectId: string | undefined): { projectId?: string }
  }
  const caller = (t: ReturnType<typeof setup>, projectId?: string) => createManagedSession(
    { id: 'caller', name: 'caller' } as never,
    { id: t.workspaceId, name: t.workspaceId, rootPath: t.rootPath, createdAt: 1 } as never,
    projectId !== undefined ? { projectId } : undefined,
  )

  it('a folderless project binds: the child is created in the caller\'s folder with that projectId', async () => {
    const t = setup()
    try {
      const callerDir = t.folder('caller')
      const callerFolder = await t.resolved(callerDir)
      const folderless = createProject(t.rootPath, { name: 'Loose' })
      const fields = (t.sm as unknown as Internals).spawnSessionProjectFields(caller(t), callerFolder, folderless.id)
      expect(fields).toEqual({ projectId: folderless.id })

      // What onSpawnSession then hands createSession: the caller's handle, plus these fields.
      const child = await t.sm.createSession(t.workspaceId, { projectHandleId: callerFolder.id, ...fields })
      expect(child.projectId).toBe(folderless.id)
      expect(child.workingDirectory).toBe(realpathSync(callerDir))
    } finally {
      t.sm.cleanup()
    }
  })

  it('a project bound to the caller\'s own folder binds; omitted inherits the caller\'s project (upstream)', async () => {
    const t = setup()
    try {
      const callerDir = t.folder('caller')
      const callerFolder = await t.resolved(callerDir)
      const same = createProject(t.rootPath, { name: 'Same' }, callerFolder)
      const internals = t.sm as unknown as Internals
      expect(internals.spawnSessionProjectFields(caller(t), callerFolder, same.id)).toEqual({ projectId: same.id })
      // v0.13.4 onSpawnSession: `projectId: request.projectId ?? managed.projectId`.
      expect(internals.spawnSessionProjectFields(caller(t, same.id), callerFolder, undefined)).toEqual({ projectId: same.id })
      // NEGATIVE: a caller with no project, omitted → nothing to inherit.
      expect(internals.spawnSessionProjectFields(caller(t), callerFolder, undefined)).toEqual({})
    } finally {
      t.sm.cleanup()
    }
  })

  it('the caller\'s own project binds even when its folder is not the caller\'s (setSessionProjectId never moves it); the child stays in the caller\'s folder', async () => {
    const t = setup()
    try {
      const callerDir = t.folder('caller')
      const callerFolder = await t.resolved(callerDir)
      const own = createProject(t.rootPath, { name: 'Own' }, await t.resolved(t.folder('own-elsewhere')))
      const internals = t.sm as unknown as Internals
      // create_board_task item 2's twin: the caller's own project is always accepted, explicit or inherited.
      expect(internals.spawnSessionProjectFields(caller(t, own.id), callerFolder, own.id)).toEqual({ projectId: own.id })
      const fields = internals.spawnSessionProjectFields(caller(t, own.id), callerFolder, undefined)
      expect(fields).toEqual({ projectId: own.id })
      const child = await t.sm.createSession(t.workspaceId, { projectHandleId: callerFolder.id, ...fields })
      expect(child.projectId).toBe(own.id)
      expect(child.workingDirectory).toBe(realpathSync(callerDir))
      // Another session's project on another folder is still refused (the rule is unchanged for a foreign id).
      const other = createProject(t.rootPath, { name: 'Foreign' }, await t.resolved(t.folder('foreign')))
      expect(() => internals.spawnSessionProjectFields(caller(t, own.id), callerFolder, other.id)).toThrow('project-handle-required')
    } finally {
      t.sm.cleanup()
    }
  })

  it('a project deleted since is project-not-found whether inherited or named (upstream passes the caller\'s id explicitly)', async () => {
    const t = setup()
    try {
      const callerFolder = await t.resolved(t.folder('caller'))
      const gone = createProject(t.rootPath, { name: 'Gone' })
      rmSync(join(t.rootPath, 'projects', gone.slug), { recursive: true, force: true })
      const internals = t.sm as unknown as Internals
      // v0.13.4 onSpawnSession hands createSession `projectId: request.projectId ?? managed.projectId` — an EXPLICIT
      // id — so createSession throws "Project … not found"; the parent-inheritance drop does not apply to a spawn.
      expect(() => internals.spawnSessionProjectFields(caller(t, gone.id), callerFolder, undefined)).toThrow('project-not-found')
      expect(() => internals.spawnSessionProjectFields(caller(t, gone.id), callerFolder, gone.id)).toThrow('project-not-found')
    } finally {
      t.sm.cleanup()
    }
  })

  it('NEGATIVE: a project bound to another folder is refused (project-handle-required), as is an unknown id', async () => {
    const t = setup()
    try {
      const callerFolder = await t.resolved(t.folder('caller'))
      const other = createProject(t.rootPath, { name: 'Other' }, await t.resolved(t.folder('other')))
      const internals = t.sm as unknown as Internals
      expect(() => internals.spawnSessionProjectFields(caller(t), callerFolder, other.id)).toThrow('project-handle-required')
      // A caller with no folder cannot match a foldered project either.
      expect(() => internals.spawnSessionProjectFields(caller(t), null, other.id)).toThrow('project-handle-required')
      expect(() => internals.spawnSessionProjectFields(caller(t), callerFolder, 'proj_00000000')).toThrow('project-not-found')
    } finally {
      t.sm.cleanup()
    }
  })

  it('the wiring: the schema accepts projectId, base-agent passes it, and onSpawnSession applies the rule before createSession', () => {
    expect(SPAWN_SESSION_TOOL_INPUT_SCHEMA.safeParse({ prompt: 'p', projectId: 'proj_1234abcd' }).success).toBe(true)
    expect(SPAWN_SESSION_TOOL_INPUT_SCHEMA.safeParse({ prompt: 'p', projectId: 7 }).success).toBe(false)
    const baseAgent = readFileSync(new URL('../../../../shared/src/agent/base-agent.ts', import.meta.url), 'utf8')
    const request = baseAgent.slice(baseAgent.indexOf('const request: SpawnSessionRequest = {'), baseAgent.indexOf('defer: input.defer === true'))
    expect(request).toContain("projectId: typeof input.projectId === 'string' && input.projectId ? input.projectId : undefined")
    const source = readFileSync(new URL('../SessionManager.ts', import.meta.url), 'utf8')
    const start = source.indexOf('managed.agent.onSpawnSession = async (request) =>')
    const end = source.indexOf('mergeSessionScopedToolCallbacks({ workspaceId: managed.workspace.id, sessionId: managed.id }', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const handler = source.slice(start, end)
    const create = handler.indexOf('await this.createSession(managed.workspace.id, {')
    const rule = handler.indexOf('...this.spawnSessionProjectFields(managed, inheritedProject, request.projectId)')
    expect(create).toBeGreaterThan(-1)
    expect(rule).toBeGreaterThan(create)
    // Inside the createSession options, after the caller's own handle (the child stays in the caller's folder).
    expect(rule).toBeGreaterThan(handler.indexOf('...(inheritedProject ? { projectHandleId: inheritedProject.id } : {})'))
    expect(rule).toBeLessThan(handler.indexOf('ephemeral: request.ephemeral', create))
  })
})

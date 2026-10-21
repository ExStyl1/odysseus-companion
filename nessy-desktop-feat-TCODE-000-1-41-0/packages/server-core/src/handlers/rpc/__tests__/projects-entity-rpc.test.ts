/**
 * UA5.3 — the project ENTITY channels of `rpc/projects.ts` (adapted from craft-agents-oss
 * `v0.13.4:packages/server-core/src/handlers/rpc/projects.ts`, Apache-2.0): get, getOne, create, update, delete,
 * ours setFolder, and the `projects:changed` push.
 *
 * Driven through the real storage (`@nessy-agent/shared/projects`, `@nessy-agent/shared/pages`) and a real
 * `ProjectHandleService` over temp folders; the host's session unbind is a recording port (its own arms are
 * `set-kanban-column.test.ts`'s UA5.3 block).
 *
 * Positive: CRUD round-trips with one `projects:changed` push per mutation to the workspace; a folder enters only as
 * an issued handle and every read shows `{ handleId, displayPath, trusted }`, never the stored record; delete unbinds
 * the project's sessions (through the host) and pages, removes `projects/<slug>/`, and leaves the folder alone.
 * Negative: a foreign workspace is refused on every entity channel with nothing written or pushed; a raw path (create)
 * or a folder key (update) is refused; an unknown handle id is refused; a `config.json` folder rewritten on disk to
 * another folder reads back as `project-folder-identity-changed` with no handle; pages of other projects are untouched.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectTrustStore } from '@nessy-agent/shared/capabilities/project-trust-store'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import { findHostApproval, setHostApprovalsKeyProvider } from '@nessy-agent/shared/approvals/host-approvals'
import { projectContextMirrorIdle, projectContextSubject, writeProjectContextMirror } from '@nessy-agent/shared/projects/project-context'
import { loadProject } from '@nessy-agent/shared/projects'
import { createPage, loadPage } from '@nessy-agent/shared/pages'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { LoadedProjectView, ProjectConfigView } from '@nessy-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { HANDLED_CHANNELS, registerProjectsHandlers } from '../projects'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function folder(name: string): string {
  const path = join(tempDir('nessy-ua5-3-folder-'), name)
  mkdirSync(path)
  return path
}

function ctx(workspaceId = 'ws-a'): RequestContext {
  return { clientId: 'client-a', workspaceId, webContentsId: null }
}

/** The ledger key the suite's provider answers with (an obviously fake test value, never a real one). */
const LEDGER_KEY = Buffer.alloc(32, 9)

const ENTITY_CHANNELS = [
  RPC_CHANNELS.projects.GET,
  RPC_CHANNELS.projects.GET_ONE,
  RPC_CHANNELS.projects.CREATE,
  RPC_CHANNELS.projects.UPDATE,
  RPC_CHANNELS.projects.DELETE,
  RPC_CHANNELS.projects.SET_FOLDER,
]

function harness() {
  const workspaceRoot = tempDir('nessy-ua5-3-ws-')
  const state = tempDir('nessy-ua5-3-state-')
  let nextId = 0
  const handles = new ProjectHandleService({
    trustStore: new ProjectTrustStore({ path: join(state, 'trust.json') }),
    newId: () => `handle-${++nextId}`,
  })
  const handlers = new Map<string, HandlerFn>()
  const pushes: Array<{ channel: string; target: unknown; args: unknown[] }> = []
  const unbound: Array<{ workspaceId: string; projectId: string }> = []
  const server: RpcServer = {
    handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
    push(channel: string, target: unknown, ...args: unknown[]) { pushes.push({ channel, target, args }) },
    async invokeClient() { return { canceled: true, filePaths: [] } },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as unknown as RpcServer
  const sessionManager = {
    getProjectHandleService: () => handles,
    getRecentProjectStore: () => undefined,
    async unbindProjectFromSessions(workspaceId: string, projectId: string) {
      unbound.push({ workspaceId, projectId })
      return 2
    },
  }
  const deps = {
    sessionManager,
    workspaceService: {
      resolve(workspaceId: string) {
        if (workspaceId !== 'ws-a') throw new Error(`Workspace not found: ${workspaceId}`)
        return { workspaceRootPath: workspaceRoot }
      },
    },
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerProjectsHandlers(server, deps, { handleService: handles })
  const call = <T>(channel: string, ...args: unknown[]): Promise<T> => handlers.get(channel)!(ctx(), ...args) as Promise<T>
  const handleFor = async (path: string) => (await handles.validateProjectDirectory('ws-a', path)).id
  const changed = () => pushes.filter(push => push.channel === RPC_CHANNELS.projects.CHANGED)
  return { workspaceRoot, handles, handlers, pushes, unbound, call, handleFor, changed }
}

describe('UA5.3 — project entity RPC', () => {
  it('declares the six entity channels beside the folder channels', () => {
    for (const channel of ENTITY_CHANNELS) expect(HANDLED_CHANNELS as readonly string[]).toContain(channel)
    const { handlers } = harness()
    for (const channel of ENTITY_CHANNELS) expect(handlers.has(channel)).toBe(true)
  })

  it('create → get → getOne → update → setFolder round-trip, one projects:changed push per mutation', async () => {
    const h = harness()
    const dir = folder('repo')
    const created = await h.call<ProjectConfigView>(RPC_CHANNELS.projects.CREATE, 'ws-a', {
      name: '  Alpha  ', description: 'd', projectHandleId: await h.handleFor(dir),
    })
    expect(created.name).toBe('Alpha')
    expect(created.id).toMatch(/^proj_[0-9a-f]{8}$/)
    expect(created.folder).toEqual({ handleId: expect.stringMatching(/^handle-/), displayPath: dir, trusted: false })
    // The stored folder record never crosses: no path record key, no identity key.
    expect(JSON.stringify(created)).not.toContain('projectKey')
    expect(JSON.stringify(created)).not.toContain('workingDirectory')
    // …while the storage did persist the stable key beside the folder.
    const onDisk = JSON.parse(readFileSync(join(h.workspaceRoot, 'projects', created.slug, 'config.json'), 'utf-8'))
    expect(onDisk.folder.projectKey).toMatch(/^p_[0-9a-f]{32}$/)

    const listed = await h.call<LoadedProjectView[]>(RPC_CHANNELS.projects.GET, 'ws-a')
    expect(listed.map(project => project.config.id)).toEqual([created.id])
    expect(listed[0]!.config.folder?.displayPath).toBe(dir)
    expect((await h.call<LoadedProjectView>(RPC_CHANNELS.projects.GET_ONE, 'ws-a', created.slug)).config.id).toBe(created.id)
    expect((await h.call<LoadedProjectView>(RPC_CHANNELS.projects.GET_ONE, 'ws-a', created.id)).config.slug).toBe(created.slug)
    expect(await h.call(RPC_CHANNELS.projects.GET_ONE, 'ws-a', 'no-such-project')).toBeNull()

    const renamed = await h.call<ProjectConfigView>(RPC_CHANNELS.projects.UPDATE, 'ws-a', created.slug, { name: 'Beta' })
    expect(renamed.name).toBe('Beta')
    expect(renamed.slug).toBe(created.slug)
    expect(renamed.folder?.displayPath).toBe(dir)

    // Trust is the handle's: a trusted folder reads back trusted.
    await h.handles.setProjectTrust({ workspaceId: 'ws-a', projectHandleId: renamed.folder!.handleId! }, 'trusted')
    expect((await h.call<LoadedProjectView[]>(RPC_CHANNELS.projects.GET, 'ws-a'))[0]!.config.folder?.trusted).toBe(true)

    const unfoldered = await h.call<ProjectConfigView>(RPC_CHANNELS.projects.SET_FOLDER, 'ws-a', created.slug, null)
    expect(unfoldered.folder).toBeUndefined()
    const other = folder('other')
    const refoldered = await h.call<ProjectConfigView>(RPC_CHANNELS.projects.SET_FOLDER, 'ws-a', created.slug, await h.handleFor(other))
    expect(refoldered.folder?.displayPath).toBe(other)

    const pushes = h.changed()
    expect(pushes).toHaveLength(4) // create, update, setFolder ×2
    for (const push of pushes) {
      expect(push.target).toEqual({ to: 'workspace', workspaceId: 'ws-a' })
      expect(push.args[0]).toBe('ws-a')
    }
    const last = pushes.at(-1)!.args[1] as LoadedProjectView[]
    expect(last.map(project => project.config.folder?.displayPath)).toEqual([other])
    expect(JSON.stringify(last)).not.toContain('projectKey')
  })

  it('delete unbinds the project\'s sessions (through the host) and pages, removes projects/<slug>/, and keeps the folder', async () => {
    const h = harness()
    const dir = folder('kept')
    const doomed = await h.call<ProjectConfigView>(RPC_CHANNELS.projects.CREATE, 'ws-a', { name: 'Doomed', projectHandleId: await h.handleFor(dir) })
    const kept = await h.call<ProjectConfigView>(RPC_CHANNELS.projects.CREATE, 'ws-a', { name: 'Kept' })
    const doomedPage = createPage(h.workspaceRoot, { name: 'Doomed page', projectId: doomed.id })
    const keptPage = createPage(h.workspaceRoot, { name: 'Kept page', projectId: kept.id })
    const loosePage = createPage(h.workspaceRoot, { name: 'Loose page' })
    h.pushes.length = 0

    await h.call(RPC_CHANNELS.projects.DELETE, 'ws-a', doomed.slug)

    // Deleting a project unbinds its sessions and its pages…
    expect(h.unbound).toEqual([{ workspaceId: 'ws-a', projectId: doomed.id }])
    expect(loadPage(h.workspaceRoot, doomedPage.slug)?.config.projectId).toBeUndefined()
    // …and the pages of other projects are untouched.
    expect(loadPage(h.workspaceRoot, keptPage.slug)?.config.projectId).toBe(kept.id)
    expect(loadPage(h.workspaceRoot, loosePage.slug)?.config.projectId).toBeUndefined()
    expect(existsSync(join(h.workspaceRoot, 'projects', doomed.slug))).toBe(false)
    expect(existsSync(join(h.workspaceRoot, 'projects', kept.slug, 'config.json'))).toBe(true)
    expect(existsSync(dir)).toBe(true)
    const [push] = h.changed()
    expect((push!.args[1] as LoadedProjectView[]).map(project => project.config.id)).toEqual([kept.id])

    // An unknown slug is a no-op: nothing unbound, nothing pushed.
    h.pushes.length = 0
    await h.call(RPC_CHANNELS.projects.DELETE, 'ws-a', 'no-such-project')
    expect(h.unbound).toHaveLength(1)
    expect(h.changed()).toEqual([])
  })

  /**
   * UA12.109 — the mirror's `project-context` ledger entry (subject `project:<id>`) must not outlive the project:
   * the DELETE handler revokes it, so the approvals ledger holds no orphan entry for a project that is gone.
   * The entries are recorded here through the mirror's own writer (what a config write does in the host); the
   * CONTROL is another project's entry surviving the same delete.
   */
  it('UA12.109: deleting a project revokes its project-context ledger entry; another project\'s survives', async () => {
    setHostApprovalsKeyProvider({ getKey: async () => LEDGER_KEY })
    try {
      const h = harness()
      const doomed = await h.call<ProjectConfigView>(RPC_CHANNELS.projects.CREATE, 'ws-a', { name: 'Doomed' })
      const kept = await h.call<ProjectConfigView>(RPC_CHANNELS.projects.CREATE, 'ws-a', { name: 'Kept' })
      writeProjectContextMirror(h.workspaceRoot, loadProject(h.workspaceRoot, doomed.slug)!.config, LEDGER_KEY)
      writeProjectContextMirror(h.workspaceRoot, loadProject(h.workspaceRoot, kept.slug)!.config, LEDGER_KEY)
      expect(findHostApproval(h.workspaceRoot, LEDGER_KEY, 'project-context', projectContextSubject(doomed.id))).toBeDefined()
      expect(findHostApproval(h.workspaceRoot, LEDGER_KEY, 'project-context', projectContextSubject(kept.id))).toBeDefined()

      await h.call(RPC_CHANNELS.projects.DELETE, 'ws-a', doomed.slug)
      await projectContextMirrorIdle()

      expect(findHostApproval(h.workspaceRoot, LEDGER_KEY, 'project-context', projectContextSubject(doomed.id))).toBeUndefined()
      // CONTROL: the sweep is by subject, not a wipe — the live project keeps its entry.
      expect(findHostApproval(h.workspaceRoot, LEDGER_KEY, 'project-context', projectContextSubject(kept.id))).toBeDefined()
      expect(existsSync(join(h.workspaceRoot, 'projects', doomed.slug))).toBe(false)
    } finally {
      setHostApprovalsKeyProvider(undefined)
    }
  })

  // Negative arm: a sealed or unavailable ledger key never blocked a delete (such a workspace never recorded a
  // mirror entry either) — the revoke is best-effort around it.
  it('UA12.109: with the ledger key unavailable the delete still succeeds and removes the project', async () => {
    setHostApprovalsKeyProvider({ getKey: async () => { throw new Error('sealed store') } })
    try {
      const h = harness()
      const project = await h.call<ProjectConfigView>(RPC_CHANNELS.projects.CREATE, 'ws-a', { name: 'Sealed' })
      await h.call(RPC_CHANNELS.projects.DELETE, 'ws-a', project.slug)
      expect(existsSync(join(h.workspaceRoot, 'projects', project.slug))).toBe(false)
      expect((await h.call<LoadedProjectView[]>(RPC_CHANNELS.projects.GET, 'ws-a')).map(view => view.config.id)).toEqual([])
    } finally {
      setHostApprovalsKeyProvider(undefined)
    }
  })

  it('refuses a foreign workspace on every entity channel, with nothing written or pushed', async () => {
    const h = harness()
    const seeded = await h.call<ProjectConfigView>(RPC_CHANNELS.projects.CREATE, 'ws-a', { name: 'Mine' })
    h.pushes.length = 0
    const argsFor: Record<string, unknown[]> = {
      [RPC_CHANNELS.projects.GET]: ['ws-a'],
      [RPC_CHANNELS.projects.GET_ONE]: ['ws-a', seeded.slug],
      [RPC_CHANNELS.projects.CREATE]: ['ws-a', { name: 'Intruder' }],
      [RPC_CHANNELS.projects.UPDATE]: ['ws-a', seeded.slug, { name: 'Hijacked' }],
      [RPC_CHANNELS.projects.DELETE]: ['ws-a', seeded.slug],
      [RPC_CHANNELS.projects.SET_FOLDER]: ['ws-a', seeded.slug, null],
    }
    for (const channel of ENTITY_CHANNELS) {
      await expect(h.handlers.get(channel)!(ctx('ws-b'), ...argsFor[channel]!)).rejects.toThrow('project-workspace-mismatch')
      await expect(h.handlers.get(channel)!({ clientId: 'c', workspaceId: undefined, webContentsId: null } as unknown as RequestContext, ...argsFor[channel]!))
        .rejects.toThrow('project-workspace-mismatch')
    }
    expect(h.pushes).toEqual([])
    expect(h.unbound).toEqual([])
    const listed = await h.call<LoadedProjectView[]>(RPC_CHANNELS.projects.GET, 'ws-a')
    expect(listed.map(project => project.config.name)).toEqual(['Mine'])
  })

  it('a folder enters only as an issued handle: raw paths, folder patches and unknown handles are refused', async () => {
    const h = harness()
    const dir = folder('raw')
    await expect(h.call(RPC_CHANNELS.projects.CREATE, 'ws-a', { name: 'Raw', workingDirectory: dir }))
      .rejects.toThrow('project-folder-handle-required')
    await expect(h.call(RPC_CHANNELS.projects.CREATE, 'ws-a', { name: 'Raw', folder: { workingDirectory: dir } }))
      .rejects.toThrow('project-folder-handle-required')
    await expect(h.call(RPC_CHANNELS.projects.CREATE, 'ws-a', { name: 'Ghost', projectHandleId: 'handle-404' }))
      .rejects.toThrow('project-handle-invalid')
    expect(await h.call<LoadedProjectView[]>(RPC_CHANNELS.projects.GET, 'ws-a')).toEqual([])

    const project = await h.call<ProjectConfigView>(RPC_CHANNELS.projects.CREATE, 'ws-a', { name: 'Plain' })
    await expect(h.call(RPC_CHANNELS.projects.UPDATE, 'ws-a', project.slug, { folder: { workingDirectory: dir } }))
      .rejects.toThrow('project-folder-handle-required')
    await expect(h.call(RPC_CHANNELS.projects.UPDATE, 'ws-a', project.slug, { workingDirectory: dir }))
      .rejects.toThrow('project-folder-handle-required')
    await expect(h.call(RPC_CHANNELS.projects.SET_FOLDER, 'ws-a', project.slug, 'handle-404'))
      .rejects.toThrow('project-handle-invalid')
    expect((await h.call<LoadedProjectView>(RPC_CHANNELS.projects.GET_ONE, 'ws-a', project.slug)).config.folder).toBeUndefined()
  })

  it('a config.json folder rewritten on disk to another folder reads back as project-folder-identity-changed, with no handle', async () => {
    const h = harness()
    const bound = folder('bound')
    const elsewhere = folder('elsewhere')
    const project = await h.call<ProjectConfigView>(RPC_CHANNELS.projects.CREATE, 'ws-a', { name: 'Edited', projectHandleId: await h.handleFor(bound) })
    // The elsewhere folder is even trusted: trust is not identity.
    await h.handles.setProjectTrust({ workspaceId: 'ws-a', projectHandleId: await h.handleFor(elsewhere) }, 'trusted')

    const configPath = join(h.workspaceRoot, 'projects', project.slug, 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    writeFileSync(configPath, JSON.stringify({ ...config, folder: { ...config.folder, workingDirectory: elsewhere } }))
    const [edited] = await h.call<LoadedProjectView[]>(RPC_CHANNELS.projects.GET, 'ws-a')
    expect(edited!.config.folder).toEqual({ handleId: null, displayPath: elsewhere, trusted: false, problem: 'project-folder-identity-changed' })

    // Deleting the key as well does not skip the comparison: a stable folder with no stored key is a mismatch too.
    const { projectKey: _dropped, ...keyless } = config.folder
    writeFileSync(configPath, JSON.stringify({ ...config, folder: { ...keyless, workingDirectory: elsewhere } }))
    const [keylessView] = await h.call<LoadedProjectView[]>(RPC_CHANNELS.projects.GET, 'ws-a')
    expect(keylessView!.config.folder?.problem).toBe('project-folder-identity-changed')
    expect(keylessView!.config.folder?.handleId).toBeNull()

    // Control: the untouched record resolves.
    writeFileSync(configPath, JSON.stringify(config))
    const [restored] = await h.call<LoadedProjectView[]>(RPC_CHANNELS.projects.GET, 'ws-a')
    expect(restored!.config.folder).toEqual({ handleId: expect.stringMatching(/^handle-/), displayPath: bound, trusted: false })

    // A bound folder that is gone reads back unavailable, never as a path the renderer could act on.
    rmSync(bound, { recursive: true, force: true })
    const [gone] = await h.call<LoadedProjectView[]>(RPC_CHANNELS.projects.GET, 'ws-a')
    expect(gone!.config.folder).toEqual({ handleId: null, displayPath: bound, trusted: false, problem: 'project-folder-unavailable' })
  })
})

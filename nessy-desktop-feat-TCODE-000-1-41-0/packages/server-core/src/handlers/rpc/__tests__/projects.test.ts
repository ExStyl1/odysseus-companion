import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectTrustStore } from '@nessy-agent/shared/capabilities/project-trust-store'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import { RecentProjectStore } from '@nessy-agent/shared/projects/recent-store'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerProjectsHandlers } from '../projects'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function projectDirectory(): string {
  const path = join(tempRoot('nessy-project-rpc-'), 'project')
  mkdirSync(path)
  return path
}

function ctx(workspaceId = 'ws-a'): RequestContext {
  return { clientId: 'client-a', workspaceId, webContentsId: null }
}

function harness(selectedPath = projectDirectory(), trustThrows?: Error) {
  const root = tempRoot('nessy-project-rpc-state-')
  let nextId = 0
  const handles = new ProjectHandleService({
    trustStore: new ProjectTrustStore({ path: join(root, 'trust.json') }),
    newId: () => `handle-${++nextId}`,
  })
  const recents = new RecentProjectStore(
    { storageLayoutVersion: 2, verificationId: 'projects-rpc-test' },
    { filePath: join(root, 'recent.json'), newId: () => 'recent-1' },
  )
  const handlers = new Map<string, HandlerFn>()
  const calls: Array<{ method: string; input: unknown }> = []
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return { canceled: false, filePaths: [selectedPath] } },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const sessionManager = {
    getProjectHandleService: () => handles,
    getRecentProjectStore: () => recents,
    async setProjectTrust(input: unknown) {
      calls.push({ method: 'trust', input })
      // D1.363 — the host's own refusal, which the handler must classify.
      if (trustThrows) throw trustThrows
      return { id: 'trusted', workspaceId: 'ws-a', displayPath: selectedPath, trustState: 'trusted', expiresAt: 1 }
    },
    async setSessionProject(input: unknown) {
      calls.push({ method: 'session', input })
      return { id: 'session-a', workspaceId: 'ws-a' }
    },
    async setWorkspaceDefaultProject(input: unknown) {
      calls.push({ method: 'default', input })
      return { id: 'ws-a', name: 'A', slug: 'a' }
    },
  }
  const deps = {
    sessionManager,
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerProjectsHandlers(server, deps, { handleService: handles, recentStore: recents })
  return { handlers, calls }
}

describe('project RPC', () => {
  it('registers the dedicated picker, validation, recent, trust and mutation channels', () => {
    const { handlers } = harness()
    expect([...handlers.keys()].sort()).toEqual([
      RPC_CHANNELS.projects.ISSUE_RECENT_HANDLE,
      RPC_CHANNELS.projects.LIST_RECENT,
      RPC_CHANNELS.projects.PICK_LOCAL_DIRECTORY,
      RPC_CHANNELS.projects.SET_SESSION_PROJECT,
      RPC_CHANNELS.projects.SET_TRUST,
      RPC_CHANNELS.projects.SET_WORKSPACE_DEFAULT,
      RPC_CHANNELS.projects.VALIDATE_DIRECTORY,
      // UA5.3 — the project entity channels (their arms: projects-entity-rpc.test.ts)
      RPC_CHANNELS.projects.GET,
      RPC_CHANNELS.projects.GET_ONE,
      RPC_CHANNELS.projects.CREATE,
      RPC_CHANNELS.projects.UPDATE,
      RPC_CHANNELS.projects.DELETE,
      RPC_CHANNELS.projects.SET_FOLDER,
      // UA5.6 — the project asset channels (their arms: projects-assets-rpc.test.ts)
      RPC_CHANNELS.projects.LIST_ASSETS,
      RPC_CHANNELS.projects.UPLOAD_ASSET,
      RPC_CHANNELS.projects.DELETE_ASSET,
    ].sort())
  })

  it('issues the same opaque handle contract for picker, manual validation and recent selection', async () => {
    const selectedPath = projectDirectory()
    const { handlers } = harness(selectedPath)

    const picked = await handlers.get(RPC_CHANNELS.projects.PICK_LOCAL_DIRECTORY)!(ctx(), 'ws-a')
    const validated = await handlers.get(RPC_CHANNELS.projects.VALIDATE_DIRECTORY)!(ctx(), {
      workspaceId: 'ws-a', candidatePath: selectedPath,
    })
    const recent = await handlers.get(RPC_CHANNELS.projects.LIST_RECENT)!(ctx(), 'ws-a')
    const reissued = await handlers.get(RPC_CHANNELS.projects.ISSUE_RECENT_HANDLE)!(ctx(), {
      workspaceId: 'ws-a', recentProjectId: recent[0].id,
    })

    for (const handle of [picked, validated, reissued]) {
      expect(handle.workspaceId).toBe('ws-a')
      expect(handle.id).toMatch(/^handle-/)
      expect(handle.displayPath).toBe(selectedPath)
      expect(handle.trustState).toBe('unknown')
      expect(JSON.stringify(handle)).not.toContain('canonicalPath')
      expect(JSON.stringify(handle)).not.toContain('identityFingerprint')
      expect(JSON.stringify(handle)).not.toContain('projectKey')
    }
    expect(recent).toEqual([{ id: 'recent-1', displayPath: selectedPath, lastUsedAt: expect.any(Number) }])
  })

  it('scope-checks the caller and forwards only handle/null project mutations', async () => {
    const { handlers, calls } = harness()
    const session = { workspaceId: 'ws-a', sessionId: 'session-a' }

    await expect(handlers.get(RPC_CHANNELS.projects.LIST_RECENT)!(ctx('ws-b'), 'ws-a'))
      .rejects.toThrow('project-workspace-mismatch')

    await handlers.get(RPC_CHANNELS.projects.SET_TRUST)!(ctx(), {
      session,
      state: 'trusted',
    })
    await handlers.get(RPC_CHANNELS.projects.SET_SESSION_PROJECT)!(ctx(), {
      session,
      projectHandleId: null,
    })
    await handlers.get(RPC_CHANNELS.projects.SET_WORKSPACE_DEFAULT)!(ctx(), {
      workspaceId: 'ws-a',
      projectHandleId: 'handle-1',
    })

    expect(calls).toEqual([
      { method: 'trust', input: { session, state: 'trusted' } },
      { method: 'session', input: { session, projectHandleId: null } },
      { method: 'default', input: { workspaceId: 'ws-a', projectHandleId: 'handle-1' } },
    ])
  })

  /**
   * D1.363 — a trust answer for a folder that is GONE reaches the renderer as a
   * TERMINAL answer, and every other failure keeps the word it had.
   *
   * Measured on the packaged 1.40.0 (measure sitting 5e, case `RS-80`): the
   * folder named by an open "Trust this project?" modal was deleted under it and
   * every click from then on answered "Could not update project trust", which the
   * user cannot get past. `SessionManager.setProjectTrust`'s revoke branch throws
   * a bare `project-handle-invalid` that carries no cause, so the classification
   * happens here, against the handle service's own reading of the path.
   *
   * The CONTROL is the same thrown error with the folder still on disk: it must
   * arrive unchanged, or this would be renaming every failure rather than the one.
   */
  it('reports a deleted project folder as terminal and leaves a live one unchanged', async () => {
    const path = projectDirectory()
    const { handlers } = harness(path, new Error('project-handle-invalid'))
    const handle = await handlers.get(RPC_CHANNELS.projects.VALIDATE_DIRECTORY)!(ctx(), {
      workspaceId: 'ws-a', candidatePath: path,
    })
    const answer = () => handlers.get(RPC_CHANNELS.projects.SET_TRUST)!(ctx(), {
      workspaceId: 'ws-a', projectHandleId: handle.id, state: 'untrusted',
    })

    // CONTROL: the folder is there, so the host's own word survives untouched.
    await expect(answer()).rejects.toThrow('project-handle-invalid')

    rmSync(path, { recursive: true, force: true })
    await expect(answer()).rejects.toThrow('project-directory-missing')
  })
})

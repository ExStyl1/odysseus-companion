/**
 * UA1.14 — the local-target arm of "Send to Workspace".
 *
 * Unit arms drive `session-transfer.ts` with fakes (which arm runs, the mode, the
 * progress frames). The real arm runs a REAL `SessionManager` over a REAL
 * workspace service in an isolated child (the harness of
 * `packages/server-core/src/sessions/__tests__/export-import-v2-portability.test.ts`):
 * two local workspaces, a session with messages in the first, and the handler's
 * own sequence — resolve the target, export from the source, import locally —
 * must land a session WITH its messages in the second. Its control is the
 * pre-UA1.14 resolution, `resolveRemoteWorkspaceConnection(localTarget)`, which
 * must still reject with `remote-not-configured`: that rejection is why a local
 * target could never be reached.
 *
 * The real arm re-runs the handler's sequence but never calls the handler, so
 * the last describe pins the HOST wiring as source text: the main handler and the
 * preload invoke the same channel, the handler resolves through
 * `resolveTransferTargetConnection` and returns the local import before
 * `connectToRemote`, and the pre-UA1.14 every-target-is-remote resolution is gone.
 * Budget: the real arm is ~52-54 s wall (the SessionManager module graph in the child),
 * hence its 180 s timeout; the source pins are milliseconds.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SessionBundle } from '@nessy-agent/shared/sessions'
import { REQUEST_TIMEOUT_MS } from '@nessy-agent/shared/protocol'
import {
  importTransferBundleLocally,
  resolveTransferTargetConnection,
  type TransferProgressFrame,
} from '../session-transfer'

const REPO_ROOT = resolve(import.meta.dir, '../../../../..')
const SERVER_CORE_SRC = join(REPO_ROOT, 'packages', 'server-core', 'src')
const SESSION_MANAGER_MODULE = pathToFileURL(join(SERVER_CORE_SRC, 'sessions', 'SessionManager.ts')).href
const WORKSPACE_QUIESCENCE_MODULE = pathToFileURL(join(SERVER_CORE_SRC, 'workspaces', 'workspace-quiescence.ts')).href
const SESSION_TRANSFER_MODULE = pathToFileURL(join(import.meta.dir, '..', 'session-transfer.ts')).href
const RESULT_PREFIX = 'UA114_RESULT='
const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspaceService(remote: Record<string, boolean>) {
  const resolvedRemote: string[] = []
  return {
    resolvedRemote,
    service: {
      resolve: (id: string) => {
        if (!(id in remote)) throw new Error('Workspace is not registered')
        return { config: remote[id] ? { remoteServer: { url: 'wss://remote.test', remoteWorkspaceId: `${id}-r` } } : {} } as never
      },
      resolveRemoteWorkspaceConnection: async (id: string) => {
        resolvedRemote.push(id)
        return { localWorkspaceId: id, url: 'wss://remote.test', remoteWorkspaceId: `${id}-r`, token: 'fake' }
      },
    },
  }
}

describe('resolveTransferTargetConnection', () => {
  it('a local target resolves to null and never reads a remote credential', async () => {
    const { service, resolvedRemote } = workspaceService({ 'local-b': false })
    expect(await resolveTransferTargetConnection(service, 'local-b')).toBeNull()
    expect(resolvedRemote).toEqual([])
  })

  it('a remote target still resolves its connection (the remote arm is unchanged)', async () => {
    const { service, resolvedRemote } = workspaceService({ 'remote-a': true })
    expect(await resolveTransferTargetConnection(service, 'remote-a')).toMatchObject({ remoteWorkspaceId: 'remote-a-r' })
    expect(resolvedRemote).toEqual(['remote-a'])
  })

  it('an unknown target throws before anything is exported', async () => {
    const { service } = workspaceService({})
    await expect(resolveTransferTargetConnection(service, 'gone')).rejects.toThrow('Workspace is not registered')
  })
})

describe('importTransferBundleLocally', () => {
  const bundle = { version: 1, session: { header: { id: 's1' }, messages: [] }, files: [] } as unknown as SessionBundle

  it('imports into the target as a fork and reports 0/1 then 1/1', async () => {
    const calls: unknown[][] = []
    const frames: TransferProgressFrame[] = []
    const result = await importTransferBundleLocally(
      { importSession: async (...args) => { calls.push(args); return { sessionId: 'new-1' } } },
      'local-b',
      bundle,
      { sessionIndex: 1, sessionCount: 3, send: frame => frames.push(frame) },
    )
    expect(result).toEqual({ sessionId: 'new-1' })
    expect(calls).toEqual([['local-b', bundle, 'fork']])
    expect(frames).toEqual([
      { sessionIndex: 1, sessionCount: 3, chunkSent: 0, chunkTotal: 1 },
      { sessionIndex: 1, sessionCount: 3, chunkSent: 1, chunkTotal: 1 },
    ])
  })

  it('a gone renderer does not fail the import; an import failure does', async () => {
    const send = () => { throw new Error('renderer destroyed') }
    await expect(importTransferBundleLocally(
      { importSession: async () => ({ sessionId: 'new-2' }) }, 'local-b', bundle, { sessionIndex: 0, sessionCount: 1, send },
    )).resolves.toEqual({ sessionId: 'new-2' })
    await expect(importTransferBundleLocally(
      { importSession: async () => { throw new Error('Invalid session bundle') } }, 'local-b', bundle, { sessionIndex: 0, sessionCount: 1, send: () => {} },
    )).rejects.toThrow('Invalid session bundle')
  })
})

function runChild(body: string): Record<string, unknown> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-ua114-')))
  tempRoots.push(root)
  const profile = join(root, 'profile')
  const childTmp = join(root, 'tmp')
  const bunfig = join(root, 'bunfig.toml')
  mkdirSync(profile, { recursive: true })
  mkdirSync(childTmp, { recursive: true })
  writeFileSync(bunfig, '# no test preloads\n')

  const result = Bun.spawnSync([process.execPath, `--config=${bunfig}`, '--eval', body], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: profile,
      USERPROFILE: profile,
      CFFIXED_USER_HOME: profile,
      TMPDIR: childTmp,
      NESSY_CONFIG_DIR: join(profile, '.nessy-agent'),
      NESSY_DP_AUTH_TOKEN: '',
      DP_AUTH_TOKEN: '',
      NESTOR_TOKEN: '',
      RUN_LIVE_TESTS: '0',
      NESSY_RUN_LIVE_TESTS: '0',
      LIVE_GATEWAY_TESTS: '0',
      NESSY_FEATURE_PROVIDER_CLAUDE: '0',
      NESSY_FEATURE_PROVIDER_CHATGPT: '0',
      NESSY_FEATURE_CODEX_RUNTIME: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || `UA1.14 child exited ${result.exitCode}`)
  }
  const line = result.stdout.toString().split('\n').find(entry => entry.startsWith(RESULT_PREFIX))
  if (!line) throw new Error(`UA1.14 child returned no result: ${result.stdout.toString()}`)
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as Record<string, unknown>
}

describe('Send to Workspace between two LOCAL workspaces (real SessionManager)', () => {
  it('lands the session with its messages in the other workspace; the source keeps its copy', () => {
    const out = runChild(`
      import { join } from 'node:path';
      import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service';
      import { RecentProjectStore } from '@nessy-agent/shared/projects/recent-store';
      import { createSessionStore, writeSessionJsonl } from '@nessy-agent/shared/sessions';
      import { CONFIG_DIR, createWorkspaceService, ensureStorageLayoutV2 } from '@nessy-agent/shared/workspaces';
      import { SessionManager } from '${SESSION_MANAGER_MODULE}';
      import { WorkspaceQuiescenceCoordinator } from '${WORKSPACE_QUIESCENCE_MODULE}';
      import { importTransferBundleLocally, resolveTransferTargetConnection } from '${SESSION_TRANSFER_MODULE}';

      const readiness = await ensureStorageLayoutV2({ assertHeld() {} });
      if (readiness.status === 'blocked') throw new Error(readiness.code);
      const workspaces = createWorkspaceService({ configDir: CONFIG_DIR, credentialManager: { list: async () => [] } });
      const source = await workspaces.create({ name: 'Local Source' });
      const target = await workspaces.create({ name: 'Local Target' });
      const store = createSessionStore(readiness.layout);
      const leases = new Set();
      let generation = 0;
      const manager = new SessionManager(store, {
        resolver: {
          resolve: async context => {
            const leaseId = 'ua114-lease-' + (++generation);
            leases.add(leaseId);
            return { context, generation: 'ua114-' + generation, leaseId, entries: [], installedPlugins: [], diagnostics: [] };
          },
          releaseSnapshot: leaseId => { leases.delete(leaseId); },
          invalidate() {},
          isLeaseActive: leaseId => leases.has(leaseId),
          referencedInstances: () => new Set(),
          leaseCount: () => leases.size,
        },
        workspaceService: workspaces,
        projectHandleService: new ProjectHandleService({ managedRootPaths: [CONFIG_DIR] }),
        recentProjectStore: new RecentProjectStore(readiness.layout, { filePath: join(CONFIG_DIR, 'recent-projects.json') }),
        workspaceQuiescence: new WorkspaceQuiescenceCoordinator(),
        resolveCredential: () => ({ ready: false, revision: 0 }),
        dpSessionBroker: {
          probe: async () => ({ state: 'needs-login', version: null, outdated: false }),
          subscribe: () => () => undefined,
        },
        subscribeInvalidation: () => () => undefined,
      });
      const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 };

      const created = await store.create(source.id, { name: 'Sent Session' });
      const messages = [
        { id: 'u-1', type: 'user', content: 'hello from the source workspace', timestamp: 1 },
        { id: 'a-1', type: 'assistant', content: 'an answer worth keeping', timestamp: 2 },
      ];
      writeSessionJsonl(store.getSessionFilePath({ workspaceId: source.id, sessionId: created.id }), {
        ...created, messages, tokenUsage: usage,
      });
      manager.reloadSessions();

      // The pre-UA1.14 resolution of the target (the control).
      let oldPathError = null;
      try { await workspaces.resolveRemoteWorkspaceConnection(target.id); } catch (error) { oldPathError = String(error?.code ?? error?.message ?? error); }

      // The handler's sequence after UA1.14.
      const targetConnection = await resolveTransferTargetConnection(workspaces, target.id);
      const bundle = await manager.exportSession(created.id, source.id);
      if (!bundle) throw new Error('export-failed');
      const frames = [];
      const imported = await importTransferBundleLocally(manager, target.id, bundle, { sessionIndex: 0, sessionCount: 1, send: f => frames.push(f) });

      const landed = await manager.getSession(imported.sessionId, target.id);
      const kept = await manager.getSession(created.id, source.id);
      manager.cleanup();
      console.log('${RESULT_PREFIX}' + JSON.stringify({
        sourceId: source.id,
        targetId: target.id,
        oldPathError,
        targetConnection,
        createdId: created.id,
        importedId: imported.sessionId,
        landedWorkspaceId: landed?.workspaceId ?? null,
        landedMessages: landed?.messages.map(({ id, role, content }) => ({ id, type: role, content })) ?? null,
        keptMessages: kept?.messages.map(({ id }) => id) ?? null,
        targetSessionIds: store.list(target.id).map(s => s.id),
        sourceSessionIds: store.list(source.id).map(s => s.id),
        frames,
        messages: messages.map(({ id, type, content }) => ({ id, type, content })),
      }));
    `)

    expect(out.targetId).not.toBe(out.sourceId)
    expect(String(out.oldPathError)).toContain('remote-not-configured')
    expect(out.targetConnection).toBeNull()
    expect(out.landedWorkspaceId).toBe(out.targetId)
    expect(out.landedMessages).toEqual(out.messages)
    expect(out.targetSessionIds).toEqual([out.importedId])
    expect(out.sourceSessionIds).toEqual([out.createdId])
    expect(out.keptMessages).toEqual(['u-1', 'a-1'])
    expect(out.frames).toEqual([
      { sessionIndex: 0, sessionCount: 1, chunkSent: 0, chunkTotal: 1 },
      { sessionIndex: 0, sessionCount: 1, chunkSent: 1, chunkTotal: 1 },
    ])
  }, 180_000)
})

describe('the host wiring of the local arm (main/index.ts + preload/bootstrap.ts, as source)', () => {
  const MAIN_INDEX = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf8')
  const PRELOAD = readFileSync(join(import.meta.dir, '..', '..', 'preload', 'bootstrap.ts'), 'utf8')
  const HANDLER_OPEN = "ipcMain.handle('session:transferToWorkspace'"
  const LOCAL_RETURN = 'if (!targetConnection) return await importTransferBundleLocally(sessionManager, targetWorkspaceId, bundle'
  const REMOTE_CONNECT = 'await connectToRemote(url, token, remoteWorkspaceId, { requestTimeout: TRANSFER_REQUEST_TIMEOUT_MS })'
  // The transfer handler under either channel name (the pre-UA1.14 one was
  // 'session:transferToRemoteWorkspace'), up to the next handler. Scoped because
  // another handler above it legitimately resolves a REMOTE target.
  const TRANSFER_OPEN = "ipcMain.handle('session:transferTo"
  const transferStart = MAIN_INDEX.indexOf(TRANSFER_OPEN)
  const handler = transferStart < 0 ? '' : MAIN_INDEX.slice(transferStart, MAIN_INDEX.indexOf('ipcMain.handle(', transferStart + TRANSFER_OPEN.length))

  it('main and preload use the same channel; the handler resolves the target and returns the local import before any remote connect', () => {
    expect(MAIN_INDEX).toContain(HANDLER_OPEN)
    expect(PRELOAD).toContain("ipcRenderer.invoke('session:transferToWorkspace'")
    expect(handler).toContain('await resolveTransferTargetConnection(runtime.workspaceService, targetWorkspaceId)')
    expect(handler).toContain(LOCAL_RETURN)
    expect(handler).toContain(REMOTE_CONNECT)
    expect(handler.indexOf(LOCAL_RETURN)).toBeLessThan(handler.indexOf(REMOTE_CONNECT))
  })

  it('the pre-UA1.14 wiring is gone: no every-target-is-remote resolution, no old channel on either side', () => {
    // Control: the scope is the transfer handler (its resolve line exists before and after UA1.14).
    expect(handler).toContain('const targetConnection = await ')
    expect(handler).not.toContain('await runtime.workspaceService.resolveRemoteWorkspaceConnection(targetWorkspaceId)')
    expect(MAIN_INDEX).not.toContain("'session:transferToRemoteWorkspace'")
    expect(PRELOAD).not.toContain("'session:transferToRemoteWorkspace'")
  })

  // UA12.17 — upstream v0.13.4 (main/index.ts:802) gives the two transfer
  // clients a 120 s request timeout: the pull side (`sessions:export`) returns
  // the whole bundle as one unchunked frame over WAN, so the 30 s default is
  // not enough. Ours declares the constant beside `connectToRemote` in
  // handlers/workspace.ts (main/index.ts is docs-cited by line and cannot grow
  // above its highest citation), and the wiring below pins the whole chain:
  // the handler passes the option at BOTH connects, `connectToRemote`
  // forwards it into the WsRpcClient options, and every OTHER caller keeps the
  // 30 s default — the negative arm is the default itself plus call-site
  // counts, so a second adoption site cannot slip in unreviewed.
  const WORKSPACE_HANDLER = readFileSync(join(import.meta.dir, '..', 'handlers', 'workspace.ts'), 'utf8')
  const CORE_CLIENT = readFileSync(
    join(import.meta.dir, '..', '..', '..', '..', '..', 'packages', 'server-core', 'src', 'transport', 'client.ts'),
    'utf8',
  )

  it('the timeout reaches the client: the transfer handler passes it at both connects and connectToRemote forwards it', () => {
    expect(WORKSPACE_HANDLER).toContain('export const TRANSFER_REQUEST_TIMEOUT_MS = 120_000')
    expect(WORKSPACE_HANDLER).toContain('requestTimeout: options?.requestTimeout')
    // Both transfer clients — the source-side export connect and the target-side
    // import connect — carry the option, and nothing else in the handler does.
    expect(handler.split('{ requestTimeout: TRANSFER_REQUEST_TIMEOUT_MS }').length - 1).toBe(2)
    expect(handler).toContain('const [{ connectToRemote, TRANSFER_REQUEST_TIMEOUT_MS }')
    expect(CORE_CLIENT).toContain('this.requestTimeout = opts?.requestTimeout ?? REQUEST_TIMEOUT_MS')
  })

  it('NEGATIVE — every other caller keeps the 30 s default: no other site passes the option', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(30_000)
    // The connect helper's own callers (verify, create, TEST_CONNECTION) pass no
    // option — the one `requestTimeout:` KEY is the forwarding expression's, and
    // main/index.ts names the option at exactly the two transfer connects.
    expect(WORKSPACE_HANDLER.split('requestTimeout:').length - 1).toBe(1)
    expect(MAIN_INDEX.split('requestTimeout:').length - 1).toBe(2)
    const resourcesStart = MAIN_INDEX.indexOf("'resources:importIntoRemoteWorkspace'")
    const resourcesHandler = MAIN_INDEX.slice(resourcesStart, MAIN_INDEX.indexOf('ipcMain.handle(', resourcesStart))
    expect(resourcesHandler).toContain('await connectToRemote(')
    expect(resourcesHandler).not.toContain('requestTimeout')
  })
})

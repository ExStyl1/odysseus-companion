/**
 * UA3.1 — the v0.13.4 task and project session fields (`projectId`, `parentSessionId`, `taskSlug`,
 * `taskRunId`, `taskNodeId`, `taskNodeCount`, `taskDraft`; ported from craft-agents-oss v0.13.4
 * `sessions/types.ts` + `SessionManager.ts`, Apache-2.0) on Nessy's REAL create path.
 *
 * Upstream persists them through `sessions/storage.ts` `createSession`. Ours does not take that path:
 * `SessionManager.createSession` persists through `this.sessionStore.create(...)` (`sessions/store-v2.ts`),
 * whose `create` copies each option BY NAME and whose listing (`headerToMetadata`) hand-copies each field —
 * so a field missing from either drops on the floor, the first at creation and the second at the next
 * restart (SessionManager hydrates from that listing). Every arm below drives the shipped `createSession`
 * and reads the result back from DISK and from a FRESH store's listing, never from the in-memory object
 * alone.
 *
 * Arms (positive first, each invariant with a negative):
 * - the fields passed to `createSession` are in the reloaded header, the listing and the DTO;
 * - `taskDraft: false` persists as `false` (never dropped as falsy), `true` as `true`;
 * - a child with a same-workspace `parentSessionId` inherits the parent's `projectId`;
 * - NEGATIVE: a parent from ANOTHER workspace is refused and nothing is created;
 * - NEGATIVE: a `taskSlug` that is not a task slug (`../x`) is refused and nothing is created;
 * - NEGATIVE: an old header (written before these fields existed) reads `undefined` for all seven;
 * - `setTaskNodeCount` persists, emits ONE `session_metadata_changed` that survives the JSON wire, and a
 *   `null` clear arrives as `null` (UA2.1's convention); an unknown session is a no-op;
 * - `applyTaskLabel: true` labels the new session with its task item label; without it, no label.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import {
  createSessionStore,
  getSessionFilePath,
  loadSession,
  writeSessionJsonl,
  type StoredSession,
} from '@nessy-agent/shared/sessions'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import { createTestSessionManager } from './test-session-manager.ts'
import { createProject } from '@nessy-agent/shared/projects'
import type { SessionManager } from '../SessionManager.ts'

/** UA5.4 — `createSession` checks the project entity, so a bound `projectId` names a REAL project of the workspace. */
function realProject(sm: SessionManager, workspaceId: string, name: string): string {
  const root = (sm as unknown as { resolveWorkspace(id: string): { rootPath: string } }).resolveWorkspace(workspaceId).rootPath
  return createProject(root, { name }).id
}

const TASK_FIELDS = ['projectId', 'parentSessionId', 'taskSlug', 'taskRunId', 'taskNodeId', 'taskNodeCount', 'taskDraft'] as const

const workspaces: string[] = []
function newWorkspaceId(tag: string): string {
  const id = `ws-ua3-1-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  workspaces.push(id)
  return id
}
afterAll(() => {
  for (const id of workspaces) rmSync(join(SESSIONS_DIR, id), { recursive: true, force: true })
})

function diskHeader(workspaceId: string, sessionId: string): Record<string, unknown> {
  const first = readFileSync(getSessionFilePath(workspaceId, sessionId), 'utf-8').split('\n')[0]
  if (!first) throw new Error('session file has no header line')
  return JSON.parse(first) as Record<string, unknown>
}

function listed(workspaceId: string, sessionId: string): Record<string, unknown> | undefined {
  // A fresh store is what the next process lists sessions through (store-v2 `list`).
  const layout = { storageLayoutVersion: 2 as const, verificationId: `test-${randomUUID()}` }
  return createSessionStore(layout).list(workspaceId).find(meta => meta.id === sessionId) as Record<string, unknown> | undefined
}

function sessionDirs(workspaceId: string): string[] {
  const root = join(SESSIONS_DIR, workspaceId)
  return existsSync(root) ? readdirSync(root) : []
}

describe('UA3.1 — task and project fields ride store-v2 create and its listing', () => {
  it('fields passed to createSession are in the reloaded header, the listing and the DTO', async () => {
    const workspaceId = newWorkspaceId('pos')
    const sm = createTestSessionManager()
    try {
      const projA = realProject(sm, workspaceId, 'A')
      const projB = realProject(sm, workspaceId, 'B')
      const parent = await sm.createSession(workspaceId, { name: 'orchestrator', taskSlug: 'ship-report', projectId: projA })
      const child = await sm.createSession(workspaceId, {
        name: 'node design',
        parentSessionId: parent.id,
        taskSlug: 'ship-report',
        taskRunId: 'run-1',
        taskNodeId: 'design',
        projectId: projB,
      })

      const expected = {
        projectId: projB,
        parentSessionId: parent.id,
        taskSlug: 'ship-report',
        taskRunId: 'run-1',
        taskNodeId: 'design',
      }
      const header = diskHeader(workspaceId, child.id)
      expect(Object.fromEntries(Object.keys(expected).map(key => [key, header[key]]))).toEqual(expected)
      expect(loadSession(workspaceId, child.id)).toMatchObject(expected)
      expect(listed(workspaceId, child.id)).toMatchObject(expected)
      expect(child).toMatchObject(expected)
      // The orchestrator kept its own, and nothing it was not given.
      expect(diskHeader(workspaceId, parent.id)).toMatchObject({ taskSlug: 'ship-report', projectId: projA })
      expect('parentSessionId' in diskHeader(workspaceId, parent.id)).toBe(false)
    } finally {
      sm.cleanup()
    }
  })

  it('taskDraft: false persists as false (not dropped as falsy), and true as true', async () => {
    const workspaceId = newWorkspaceId('draft')
    const sm = createTestSessionManager()
    try {
      const adopted = await sm.createSession(workspaceId, { taskSlug: 'a-task', taskDraft: false })
      const draft = await sm.createSession(workspaceId, { name: 'New task', taskDraft: true })

      expect(diskHeader(workspaceId, adopted.id).taskDraft).toBe(false)
      expect(listed(workspaceId, adopted.id)?.taskDraft).toBe(false)
      expect(adopted.taskDraft).toBe(false)
      expect(diskHeader(workspaceId, draft.id).taskDraft).toBe(true)
      expect(listed(workspaceId, draft.id)?.taskDraft).toBe(true)
    } finally {
      sm.cleanup()
    }
  })

  it('a child of a same-workspace parent inherits the parent projectId when it names none', async () => {
    const workspaceId = newWorkspaceId('inherit')
    const sm = createTestSessionManager()
    try {
      const family = realProject(sm, workspaceId, 'Family')
      const parent = await sm.createSession(workspaceId, { projectId: family })
      const child = await sm.createSession(workspaceId, { parentSessionId: parent.id })
      expect(diskHeader(workspaceId, child.id)).toMatchObject({ parentSessionId: parent.id, projectId: family })
      // Control: an unbound parent leaves the child unbound.
      const loose = await sm.createSession(workspaceId, {})
      const looseChild = await sm.createSession(workspaceId, { parentSessionId: loose.id })
      expect('projectId' in diskHeader(workspaceId, looseChild.id)).toBe(false)
    } finally {
      sm.cleanup()
    }
  })

  it('NEGATIVE: a parent from another workspace is refused, and nothing is created', async () => {
    const home = newWorkspaceId('home')
    const foreign = newWorkspaceId('foreign')
    const sm = createTestSessionManager()
    try {
      const foreignParent = await sm.createSession(foreign, { name: 'elsewhere', projectId: realProject(sm, foreign, 'X') })
      const before = sessionDirs(home)
      await expect(sm.createSession(home, { parentSessionId: foreignParent.id, taskSlug: 'steal' }))
        .rejects.toThrow('parent-session-not-in-workspace')
      expect(sessionDirs(home)).toEqual(before)
      // A parent that exists nowhere is refused the same way.
      await expect(sm.createSession(home, { parentSessionId: 'no-such-session' })).rejects.toThrow('parent-session-not-in-workspace')
      expect(sessionDirs(home)).toEqual(before)
    } finally {
      sm.cleanup()
    }
  })

  it('NEGATIVE: a taskSlug that is not a task slug is refused before anything is created', async () => {
    const workspaceId = newWorkspaceId('slug')
    const sm = createTestSessionManager()
    try {
      const before = sessionDirs(workspaceId)
      await expect(sm.createSession(workspaceId, { taskSlug: '../outside' })).rejects.toThrow('task-slug-invalid')
      expect(sessionDirs(workspaceId)).toEqual(before)
    } finally {
      sm.cleanup()
    }
  })

  it('NEGATIVE: an old header (written before these fields existed) reads undefined for all seven', () => {
    const workspaceId = newWorkspaceId('old')
    const file = getSessionFilePath(workspaceId, 'old-1')
    mkdirSync(dirname(file), { recursive: true })
    writeSessionJsonl(file, { id: 'old-1', workspaceId, createdAt: 1, lastUsedAt: 1, messages: [] } as unknown as StoredSession)

    const loaded = loadSession(workspaceId, 'old-1') as unknown as Record<string, unknown>
    const meta = listed(workspaceId, 'old-1')
    for (const field of TASK_FIELDS) {
      expect(loaded[field]).toBeUndefined()
      expect(meta?.[field]).toBeUndefined()
    }
  })
})

describe('UA3.1 — setTaskNodeCount (host setter, UA2.1 path and null-clear convention)', () => {
  it('persists, emits one session_metadata_changed that survives the JSON wire, and clears with null', async () => {
    const workspaceId = newWorkspaceId('count')
    const sm = createTestSessionManager()
    const events: SessionEvent[] = []
    const notified: string[] = []
    sm.setEventSink((_channel, _target, event) => { events.push(event as SessionEvent) })
    try {
      const orchestrator = await sm.createSession(workspaceId, { taskSlug: 'counted' })
      ;(sm as unknown as { configWatchers: Map<string, unknown> }).configWatchers.set(workspaceId, {
        notifySessionPartitionFileChange: (relativePath: string) => { notified.push(relativePath) },
      })
      const metadataEvents = () => events.filter(event => event.type === 'session_metadata_changed')

      await sm.setTaskNodeCount(orchestrator.id, 3, workspaceId)
      expect(diskHeader(workspaceId, orchestrator.id).taskNodeCount).toBe(3)
      expect(listed(workspaceId, orchestrator.id)?.taskNodeCount).toBe(3)
      expect(JSON.parse(JSON.stringify(metadataEvents()))).toEqual([
        { type: 'session_metadata_changed', sessionId: orchestrator.id, changes: { taskNodeCount: 3 } },
      ])
      expect(notified).toEqual([`${orchestrator.id}/session.jsonl`])

      await sm.setTaskNodeCount(orchestrator.id, null, workspaceId)
      expect('taskNodeCount' in diskHeader(workspaceId, orchestrator.id)).toBe(false)
      const cleared = JSON.parse(JSON.stringify(metadataEvents().at(-1)))
      expect(cleared).toEqual({ type: 'session_metadata_changed', sessionId: orchestrator.id, changes: { taskNodeCount: null } })
    } finally {
      sm.cleanup()
    }
  })

  it('NEGATIVE: an unknown session emits nothing and writes nothing', async () => {
    const workspaceId = newWorkspaceId('count-none')
    const sm = createTestSessionManager()
    const events: SessionEvent[] = []
    sm.setEventSink((_channel, _target, event) => { events.push(event as SessionEvent) })
    try {
      await sm.setTaskNodeCount('no-such-session', 2, workspaceId)
      expect(events).toEqual([])
      expect(existsSync(getSessionFilePath(workspaceId, 'no-such-session'))).toBe(false)
    } finally {
      sm.cleanup()
    }
  })
})

describe('UA3.1 — createSession({ applyTaskLabel })', () => {
  it('labels the new session with its own task item label; without the flag it gets none', async () => {
    const workspaceId = newWorkspaceId('label')
    const sm = createTestSessionManager()
    sm.setEventSink((() => undefined) as never)
    try {
      const labelled = await sm.createSession(workspaceId, { name: 'Quarterly report', applyTaskLabel: true })
      expect(labelled.labels).toEqual(['task-quarterly-report-1'])
      expect(diskHeader(workspaceId, labelled.id).labels).toEqual(['task-quarterly-report-1'])

      const plain = await sm.createSession(workspaceId, { name: 'Plain chat' })
      expect(plain.labels ?? []).toEqual([])
    } finally {
      sm.cleanup()
    }
  })
})

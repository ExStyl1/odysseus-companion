/**
 * UA1.6 — `SessionManager.applyTaskLabel`, ported from upstream craft-agents-oss
 * (`v0.13.4:packages/server-core/src/sessions/SessionManager.ts`, `applyTaskLabel`; Apache-2.0)
 * onto Nessy's composite session identity (W5): the parent is resolved in the CHILD's workspace.
 *
 * Every arm drives the SHIPPED method against a real label config in a temp workspace root
 * (`labels/crud.ts` writes it); only session persistence beneath `setSessionLabels` is stubbed.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { loadLabelConfig, saveLabelConfig } from '@nessy-agent/shared/labels/storage'
import { findLabelById } from '@nessy-agent/shared/labels'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

interface Managed { id: string; name?: string; labels?: string[] }

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function rig() {
  const sm = createTestSessionManager()
  sm.setEventSink((() => undefined) as never)
  const internals = sm as unknown as {
    sessions: Map<string, unknown>
    persistSession(managed: unknown): void
    flushSession(sessionId: string, workspaceId?: string): Promise<void>
  }
  internals.persistSession = () => undefined
  internals.flushSession = async () => undefined
  const workspaces = new Map<string, string>()
  const workspace = (id: string) => {
    let root = workspaces.get(id)
    if (!root) {
      root = mkdtempSync(join(tmpdir(), `ua1-6-${id}-`))
      roots.push(root)
      workspaces.set(id, root)
    }
    return { id, name: id, rootPath: root, createdAt: Date.now() }
  }
  const add = (workspaceId: string, sessionId: string, fields: { name?: string; labels?: string[] } = {}) => {
    const managed = createManagedSession(
      { id: sessionId, ...fields },
      workspace(workspaceId) as never,
      { messagesLoaded: true },
    ) as unknown as Managed
    internals.sessions.set(encodeSessionKey({ workspaceId, sessionId }), managed)
    return managed
  }
  const taskChildren = (workspaceId: string) => {
    const labels = loadLabelConfig(workspace(workspaceId).rootPath).labels
    return (findLabelById(labels, 'task')?.children ?? []).map(c => ({ id: c.id, name: c.name }))
  }
  return { sm, add, workspace, taskChildren }
}

describe('UA1.6 — applyTaskLabel', () => {
  it('a top-level session mints one TASK-<slug>-<N> item label under the Task root and carries the returned id', async () => {
    const { sm, add, taskChildren } = rig()
    const managed = add('ws-a', 's-top', { name: 'Fix login crash', labels: ['bug'] })
    const applied = await sm.applyTaskLabel('s-top', { workspaceId: 'ws-a' })
    expect(applied).toEqual({ labelId: 'task-fix-login-crash-1' })
    expect(taskChildren('ws-a')).toEqual([{ id: 'task-fix-login-crash-1', name: 'TASK-fix-login-crash-1' }])
    // The existing label survives; the item label is appended once.
    expect(managed.labels).toEqual(['bug', 'task-fix-login-crash-1'])
  })

  it('is idempotent: a second call returns the same id and mints nothing', async () => {
    const { sm, add, taskChildren } = rig()
    const managed = add('ws-a', 's-top', { name: 'Fix login crash' })
    const first = await sm.applyTaskLabel('s-top', { workspaceId: 'ws-a' })
    const second = await sm.applyTaskLabel('s-top', { workspaceId: 'ws-a' })
    expect(second).toEqual(first!)
    expect(taskChildren('ws-a')).toHaveLength(1)
    expect(managed.labels).toEqual([first!.labelId])
  })

  it('a child INHERITS its parent\'s item label and does not mint (negative: the counter does not move)', async () => {
    const { sm, add, taskChildren } = rig()
    add('ws-a', 's-parent', { name: 'Ship board' })
    const parentLabel = await sm.applyTaskLabel('s-parent', { workspaceId: 'ws-a' })
    const child = add('ws-a', 's-child', { name: 'Unrelated subtask title' })
    const childLabel = await sm.applyTaskLabel('s-child', { workspaceId: 'ws-a', parentSessionId: 's-parent' })
    expect(childLabel).toEqual(parentLabel!)
    expect(child.labels).toEqual([parentLabel!.labelId])
    expect(taskChildren('ws-a')).toEqual([{ id: 'task-ship-board-1', name: 'TASK-ship-board-1' }])
  })

  it('a plain parent gaining its first subtask is labelled in the same pass, from the PARENT\'s name, with one mint', async () => {
    const { sm, add, taskChildren } = rig()
    const parent = add('ws-a', 's-parent', { name: 'Plain chat', labels: ['area'] })
    const child = add('ws-a', 's-child', { name: 'Subtask' })
    const applied = await sm.applyTaskLabel('s-child', { workspaceId: 'ws-a', parentSessionId: 's-parent' })
    expect(applied).toEqual({ labelId: 'task-plain-chat-1' })
    expect(parent.labels).toEqual(['area', 'task-plain-chat-1'])
    expect(child.labels).toEqual(['task-plain-chat-1'])
    expect(taskChildren('ws-a')).toHaveLength(1)
  })

  it('callers must use the RETURNED id: a slug collision shifts it, and the session carries the shifted id', async () => {
    const { sm, add, workspace, taskChildren } = rig()
    const root = workspace('ws-a').rootPath
    // An unrelated user label already owns the slug the item label would take.
    saveLabelConfig(root, { version: 1, labels: [{ id: 'task-report-1', name: 'Report one' }] })
    const managed = add('ws-a', 's-top', { name: 'Report' })
    const applied = await sm.applyTaskLabel('s-top', { workspaceId: 'ws-a' })
    expect(applied!.labelId).not.toBe('task-report-1')
    expect(applied).toEqual({ labelId: 'task-report-1-2' })
    expect(managed.labels).toEqual(['task-report-1-2'])
    expect(taskChildren('ws-a')).toEqual([{ id: 'task-report-1-2', name: 'TASK-report-1' }])
  })

  it('composite identity: a parent id that lives only in ANOTHER workspace lends nothing — the child mints its own', async () => {
    const { sm, add, taskChildren } = rig()
    add('ws-b', 's-parent', { name: 'Other workspace parent' })
    await sm.applyTaskLabel('s-parent', { workspaceId: 'ws-b' })
    const child = add('ws-a', 's-child', { name: 'Own task' })
    const applied = await sm.applyTaskLabel('s-child', { workspaceId: 'ws-a', parentSessionId: 's-parent' })
    expect(applied).toEqual({ labelId: 'task-own-task-1' })
    expect(child.labels).toEqual(['task-own-task-1'])
    expect(taskChildren('ws-a')).toEqual([{ id: 'task-own-task-1', name: 'TASK-own-task-1' }])
  })

  it('an unknown session returns undefined and mints nothing', async () => {
    const { sm, add, taskChildren } = rig()
    add('ws-a', 's-known', { name: 'Known' })
    expect(await sm.applyTaskLabel('s-missing', { workspaceId: 'ws-a' })).toBeUndefined()
    expect(taskChildren('ws-a')).toEqual([])
  })
})

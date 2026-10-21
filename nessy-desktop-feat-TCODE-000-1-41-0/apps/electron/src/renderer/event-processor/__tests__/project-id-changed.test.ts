/**
 * UA5.3 — `project_id_changed` on the renderer (upstream craft-agents v0.13.4 `handleProjectIdChanged`, Apache-2.0):
 * the host's `setSessionProjectId` (and its external reconcile, and a project delete's unbind) reaches every window's
 * session atom and list meta, an IDLE session included. Same instrument as `session-metadata-changed.test.ts`: the
 * real processor and atoms, and `App.tsx`'s `handoffEventTypes` pinned from source (App.tsx cannot load under bun).
 *
 * Positive: a binding reaches the atom and the meta; App.tsx routes the event through the handoff path.
 * Negative: `null` (the host's unbind, which survives the JSON wire) removes the field; another session is untouched.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createStore } from 'jotai'
import type { Session } from '../../../shared/types'
import {
  initializeSessionsAtom,
  sessionAtomFamily,
  sessionMetaMapAtom,
  updateSessionAtom,
} from '../../atoms/sessions'
import { processEvent } from '../processor'
import type { AgentEvent } from '../types'

const RENDERER_DIR = join(import.meta.dir, '..', '..')
const WORKSPACE = 'workspace-ua5-3'

function idleSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    workspaceId: WORKSPACE,
    name: `chat ${id}`,
    sessionStatus: 'todo',
    messages: [],
    lastMessageAt: 0,
    isProcessing: false,
    ...overrides,
  } as Session
}

function deliver(store: ReturnType<typeof createStore>, event: AgentEvent): void {
  const current = store.get(sessionAtomFamily(event.sessionId))
  if (!current) throw new Error(`no atom for ${event.sessionId}`)
  const next = processEvent({ session: current, streaming: null }, event).state.session
  store.set(updateSessionAtom, event.sessionId, () => next)
}

function overTheWire(event: unknown): AgentEvent {
  return JSON.parse(JSON.stringify(event)) as AgentEvent
}

describe('UA5.3 — project_id_changed', () => {
  it('an IDLE session\'s binding reaches sessionAtomFamily and the list meta, nothing else moves', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [idleSession('a')])

    deliver(store, overTheWire({ type: 'project_id_changed', sessionId: 'a', projectId: 'proj_1234abcd' }))

    const atom = store.get(sessionAtomFamily('a'))
    expect(atom?.projectId).toBe('proj_1234abcd')
    expect(atom?.isProcessing).toBe(false)
    expect(atom?.sessionStatus).toBe('todo')
    expect(store.get(sessionMetaMapAtom).get('a')?.projectId).toBe('proj_1234abcd')
  })

  it('null unbinds, after the JSON wire', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [idleSession('b', { projectId: 'proj_1234abcd' } as Partial<Session>)])
    expect(store.get(sessionMetaMapAtom).get('b')?.projectId).toBe('proj_1234abcd')

    deliver(store, overTheWire({ type: 'project_id_changed', sessionId: 'b', projectId: null }))

    expect(store.get(sessionAtomFamily('b'))?.projectId).toBeUndefined()
    expect(store.get(sessionMetaMapAtom).get('b')?.projectId).toBeUndefined()
  })

  it('an event for one session leaves another untouched', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [idleSession('c', { projectId: 'proj_keep0000' } as Partial<Session>), idleSession('d')])

    deliver(store, overTheWire({ type: 'project_id_changed', sessionId: 'd', projectId: 'proj_1234abcd' }))

    expect(store.get(sessionAtomFamily('c'))?.projectId).toBe('proj_keep0000')
    expect(store.get(sessionMetaMapAtom).get('c')?.projectId).toBe('proj_keep0000')
  })

  it('App.tsx routes the event through the handoff (atom) path', () => {
    const app = readFileSync(join(RENDERER_DIR, 'App.tsx'), 'utf8')
    const line = app.split('\n').find(text => text.includes('const handoffEventTypes = new Set(['))
    expect(line).toBeDefined()
    expect(line).toContain("'project_id_changed'")
    // Beside labels_changed, as upstream placed it.
    expect(line).toContain("'labels_changed', 'project_id_changed'")
  })
})

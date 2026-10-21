/**
 * UA2.1 — `session_metadata_changed` on the renderer (upstream craft-agents v0.13.4
 * `handleSessionMetadataChanged`, Apache-2.0): the board column a drag wrote on the host reaches
 * every window's session atom and list meta, an IDLE session included.
 *
 * `App.tsx` pulls the whole renderer graph and cannot be loaded by the bun runner (the trade
 * `unknown-session-stays-hidden.test.ts` documents), so its half — the event joining
 * `handoffEventTypes`, which upstream needed so an idle session's change takes the atom path — is
 * pinned from source; the rest runs the real processor and the real atoms.
 *
 * NESSY DEVIATION pinned here: the host sends a clear as `null` (JSON drops an `undefined` key), and
 * the merge maps `null` to absent. Any other value — `false` included — is a value and survives
 * the merge (spec §7: UA3.1's `taskDraft` is sent as `false`, never `undefined`).
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
const WORKSPACE = 'workspace-ua2-1'

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

/** The handler's own sequence for one event, minus React (as `unknown-session-stays-hidden.test.ts`). */
function deliver(store: ReturnType<typeof createStore>, event: AgentEvent): void {
  const current = store.get(sessionAtomFamily(event.sessionId))
  if (!current) throw new Error(`no atom for ${event.sessionId}`)
  const next = processEvent({ session: current, streaming: null }, event).state.session
  store.set(updateSessionAtom, event.sessionId, () => next)
}

/** What a window receives: the WS codec is JSON, so the event is round-tripped through it. */
function overTheWire(event: unknown): AgentEvent {
  return JSON.parse(JSON.stringify(event)) as AgentEvent
}

describe('UA2.1 — session_metadata_changed', () => {
  it('an IDLE session\'s column change reaches sessionAtomFamily and the list meta', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [idleSession('a')])

    deliver(store, overTheWire({ type: 'session_metadata_changed', sessionId: 'a', changes: { kanbanColumn: 'done' } }))

    const atom = store.get(sessionAtomFamily('a'))
    expect(atom?.kanbanColumn).toBe('done')
    expect(atom?.isProcessing).toBe(false)
    // Fields the event does not name are untouched — the column is independent of the status.
    expect(atom?.sessionStatus).toBe('todo')
    expect(atom?.name).toBe('chat a')
    expect(store.get(sessionMetaMapAtom).get('a')?.kanbanColumn).toBe('done')
  })

  it('null clears the column, after the JSON wire', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [idleSession('b', { kanbanColumn: 'in-progress' } as Partial<Session>)])
    expect(store.get(sessionMetaMapAtom).get('b')?.kanbanColumn).toBe('in-progress')

    deliver(store, overTheWire({ type: 'session_metadata_changed', sessionId: 'b', changes: { kanbanColumn: null } }))

    expect(store.get(sessionAtomFamily('b'))?.kanbanColumn).toBeUndefined()
    expect(store.get(sessionMetaMapAtom).get('b')?.kanbanColumn).toBeUndefined()
  })

  it('false survives the merge (a value, not a clear)', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [idleSession('c', { taskDraft: true } as Partial<Session>)])

    // `taskDraft` joins the changes type in UA3.1; the merge is generic, so the cast stands in for it.
    deliver(store, overTheWire({ type: 'session_metadata_changed', sessionId: 'c', changes: { kanbanColumn: 'todo', taskDraft: false } }))

    const atom = store.get(sessionAtomFamily('c')) as (Session & { taskDraft?: boolean }) | null
    expect(atom?.taskDraft).toBe(false)
    expect(atom?.kanbanColumn).toBe('todo')
  })

  it('an event for one session leaves another untouched', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [idleSession('d', { kanbanColumn: 'todo' } as Partial<Session>), idleSession('e')])

    deliver(store, overTheWire({ type: 'session_metadata_changed', sessionId: 'e', changes: { kanbanColumn: 'done' } }))

    expect(store.get(sessionAtomFamily('d'))?.kanbanColumn).toBe('todo')
    expect(store.get(sessionMetaMapAtom).get('d')?.kanbanColumn).toBe('todo')
  })

  it('App.tsx routes the event through the handoff (atom) path', () => {
    const app = readFileSync(join(RENDERER_DIR, 'App.tsx'), 'utf8')
    const line = app.split('\n').find(text => text.includes('const handoffEventTypes = new Set(['))
    expect(line).toBeDefined()
    expect(line).toContain("'session_metadata_changed'")
    // Beside the status event it generalises, as upstream placed it.
    expect(line).toContain("'session_status_changed', 'session_metadata_changed'")
  })
})

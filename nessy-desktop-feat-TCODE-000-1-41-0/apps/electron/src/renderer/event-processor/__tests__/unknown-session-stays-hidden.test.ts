/**
 * F1.855 — a session this window was never told about must not reach a list
 * until the host has said what it is.
 *
 * ## The defect, measured at `e2997eaf3`
 *
 * A Pi guardian judge is a host-created child session:
 * `SessionManager.startPiChildRuntime` calls `createSession` with
 * `hidden: true`, so the flag is on the host from birth and `getSessions`
 * reports it. But nothing tells the renderer the child exists — `createSession`
 * emits no `session_created`, and neither does the child path — so the first
 * thing a window hears about it is the child's own turn: its `user_message`,
 * `text_delta`s and `complete`, broadcast to the workspace like any session's.
 *
 * `App.tsx`'s session-event handler finds no atom for that id, and
 * `useEventProcessor` falls back to `createEmptySession`, which minted
 * `{ id, workspaceId, isProcessing: true }` — no name, and no `hidden`. The
 * handler then wrote `extractSessionMeta(...)` into `sessionMetaMapAtom`, and
 * `AppShell`'s `workspaceSessionMetas` (`!s.hidden && s.workspaceId === …`)
 * kept it: one 'New chat' row per judged action, with the unread dot the
 * judge's `complete` (`hasUnread`) lit. Nothing ever re-read it from the host,
 * so it stayed until the next full `getSessions` — a reload or a workspace
 * switch. SIT-y on the RC: 8 consults, 8 'New chat' rows for 20+ minutes, while
 * `getSessions` reported all 8 `hidden: true`. The same fallback reaches the OS
 * notification (`event.type === 'complete' && !updatedSession.hidden`), so an
 * unfocused window could also be notified of a judge finishing.
 *
 * ## The fix, and why it lives where it does
 *
 * Two halves, both renderer-side, so every host-created session is covered
 * (judge, subagent, reviewer) without a wire change:
 *
 *  1. `createEmptySession` mints the provisional session `hidden: true`. It has
 *     exactly one caller — the `useEventProcessor` fallback for an id with no
 *     atom — so "hidden" means "not yet known", and every list plus the
 *     notification and `ReplyAnnouncer` skips, which all read `hidden`, honour
 *     it from the first event.
 *  2. The handler asks the host once, on that first event
 *     (`refreshSessionFromServer`, the same `getSessionMessages` →
 *     `replaceLoadedSessionAtom` path `/clear` already uses), so the host's own
 *     flags replace the provisional ones: a hidden child stays hidden and gains
 *     its name; a host-created VISIBLE session lists under its real name
 *     instead of as 'New chat'.
 *
 * `App.tsx` pulls the whole renderer graph and cannot be loaded by the bun
 * runner (the trade `ReplyAnnouncer.test.tsx` documents), so its half is pinned
 * from source; the list-facing half runs the real processor and the real atoms.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createStore } from 'jotai'
import type { Session } from '../../../shared/types'
import {
  initializeSessionsAtom,
  replaceLoadedSessionAtom,
  sessionAtomFamily,
  sessionMetaMapAtom,
  updateSessionAtom,
} from '../../atoms/sessions'
import { createEmptySession } from '../helpers'
import { processEvent } from '../processor'
import type { AgentEvent } from '../types'

const RENDERER_DIR = join(import.meta.dir, '..', '..')
const WORKSPACE = 'workspace-1'
const JUDGE = 'judge-child-1'

/** What a judge child's turn looks like on the wire, in order. */
function judgeTurn(sessionId: string): AgentEvent[] {
  return [
    {
      type: 'user_message',
      sessionId,
      message: { id: 'u1', role: 'user', content: 'Judge the following planned action', timestamp: 1 },
      status: 'processing',
    },
    { type: 'text_delta', sessionId, delta: '{"verdict":"no_objection"' },
    { type: 'text_complete', sessionId, text: '{"verdict":"no_objection"}' },
    { type: 'complete', sessionId, hasUnread: true },
  ] as AgentEvent[]
}

/**
 * The handler's own sequence for one event, minus React: the session atom (or,
 * for an id with none, `useEventProcessor`'s fallback — pinned verbatim below),
 * the pure processor, then `updateSessionAtom`, which is what writes the meta
 * map every list reads.
 */
function deliver(store: ReturnType<typeof createStore>, event: AgentEvent): void {
  const current = store.get(sessionAtomFamily(event.sessionId))
  const session = current ?? createEmptySession(event.sessionId, WORKSPACE)
  const next = processEvent({ session, streaming: null }, event).state.session
  store.set(updateSessionAtom, event.sessionId, () => next)
}

/** `AppShell`'s `workspaceSessionMetas` predicate — the All Sessions source. */
function listed(store: ReturnType<typeof createStore>): string[] {
  return Array.from(store.get(sessionMetaMapAtom).values())
    .filter(meta => !meta.hidden && meta.workspaceId === WORKSPACE)
    .map(meta => meta.id)
}

function ordinarySession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'ordinary-1',
    workspaceId: WORKSPACE,
    name: 'My chat',
    messages: [],
    lastMessageAt: 0,
    isProcessing: false,
    ...overrides,
  } as Session
}

describe('an event for a session this window was never told about', () => {
  it('THE DEFECT — a judge child\'s whole turn leaves no row in All Sessions', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [ordinarySession()])
    for (const event of judgeTurn(JUDGE)) deliver(store, event)

    // The session exists (the transcript accumulates) but is not listed.
    expect(store.get(sessionAtomFamily(JUDGE))).not.toBeNull()
    expect(store.get(sessionMetaMapAtom).get(JUDGE)?.hidden).toBe(true)
    expect(listed(store)).toEqual(['ordinary-1'])
    // The notification and ReplyAnnouncer read the ATOM, not the meta map.
    expect(store.get(sessionAtomFamily(JUDGE))?.hidden).toBe(true)
  })

  it('THE DEFECT — eight judged actions add no rows, not eight', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [ordinarySession()])
    for (let i = 1; i <= 8; i += 1) {
      for (const event of judgeTurn(`judge-child-${i}`)) deliver(store, event)
    }
    expect(listed(store)).toEqual(['ordinary-1'])
  })

  it('the handler asks the host about an unknown session on its first event', () => {
    const app = readFileSync(join(RENDERER_DIR, 'App.tsx'), 'utf8')
    const trigger = 'if (!atomSession) void refreshSessionFromServer(sessionId)'
    expect(app).toContain(trigger)
    expect(app.split(trigger).length - 1).toBe(1)
    // Before the event is processed: the refresh must be requested while the
    // atom is still absent, which is the only moment "unknown" is decidable.
    expect(app.indexOf(trigger)).toBeGreaterThan(app.indexOf('const atomSession = store.get(sessionAtomFamily(sessionId))'))
    expect(app.indexOf(trigger)).toBeLessThan(app.indexOf('const { session: updatedSession, effects } = processAgentEvent('))
  })

  it('the provisional session is the fallback `useEventProcessor` actually uses', () => {
    const hook = readFileSync(join(RENDERER_DIR, 'event-processor', 'useEventProcessor.ts'), 'utf8')
    expect(hook).toContain('currentSession ?? createEmptySession(event.sessionId, workspaceId)')
  })
})

describe('the host\'s answer replaces the provisional flags', () => {
  it('a hidden child the host confirms stays hidden, and gains its name', () => {
    const store = createStore()
    for (const event of judgeTurn(JUDGE)) deliver(store, event)
    store.set(replaceLoadedSessionAtom, ordinarySession({
      id: JUDGE,
      name: 'scout: Judge the following planned action',
      hidden: true,
    }))
    expect(store.get(sessionMetaMapAtom).get(JUDGE)?.name).toBe('scout: Judge the following planned action')
    expect(listed(store)).toEqual([])
  })

  it('CONTROL — a host-created VISIBLE session lists under its own name once the host answers', () => {
    // A session another client created, or any host path that sent no
    // `session_created`: hidden for the one round-trip, then listed — rather
    // than listed forever as 'New chat', which is what the old fallback did.
    const store = createStore()
    deliver(store, { type: 'text_delta', sessionId: 'cli-1', delta: 'hi' } as AgentEvent)
    expect(listed(store)).toEqual([])
    store.set(replaceLoadedSessionAtom, ordinarySession({ id: 'cli-1', name: 'From the CLI' }))
    expect(listed(store)).toEqual(['cli-1'])
    expect(store.get(sessionMetaMapAtom).get('cli-1')?.name).toBe('From the CLI')
  })
})

describe('controls — nothing a user can see changes for a session the window knows', () => {
  it('an ordinary session receiving the same turn still lists', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [ordinarySession()])
    for (const event of judgeTurn('ordinary-1')) deliver(store, event)
    expect(store.get(sessionMetaMapAtom).get('ordinary-1')?.hidden).toBeUndefined()
    expect(listed(store)).toEqual(['ordinary-1'])
  })

  it('a session the renderer itself created hidden (a mini-agent) stays hidden', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [ordinarySession(), ordinarySession({ id: 'mini-1', hidden: true })])
    for (const event of judgeTurn('mini-1')) deliver(store, event)
    expect(listed(store)).toEqual(['ordinary-1'])
  })

  it('the turn-completion notification and ReplyAnnouncer still skip a hidden session', () => {
    const app = readFileSync(join(RENDERER_DIR, 'App.tsx'), 'utf8')
    expect(app).toContain("if (event.type === 'complete' && !updatedSession.hidden) {")
    const announcer = readFileSync(join(RENDERER_DIR, 'components', 'ReplyAnnouncer.tsx'), 'utf8')
    expect(announcer).toContain('if (session.hidden) return')
    expect(announcer).toContain('store.get(sessionAtomFamily(activeSessionId))')
  })
})

/**
 * F1.807 (SIT-p, packaged 5896a66d2) — a session the harness's failed `freshSession` left behind (never sent a message,
 * host `isProcessing` false) showed 'Deep in thought… 28s' with a Stop button. MEASURED: the provisional session minted
 * `isProcessing: true` for ANY first event, so a non-turn event (a mode change, a usage update, a label) on a session
 * this window was never told about drew the ProcessingIndicator. F1.855's host refresh (57ec3783d, after that build)
 * replaces it — when the refresh lands; under SIT-p's load `sessions:*` calls timed out, and then nothing lowers it.
 * Minted idle, a running turn still raises it from its own events (D1.379: `text_delta`, `tool_start`, non-hook
 * `status`; `user_message`).
 */
describe('the provisional session is idle until a turn event says otherwise (F1.807)', () => {
  it('THE DEFECT — a non-turn first event leaves no spinner on an unknown session', () => {
    const store = createStore()
    deliver(store, { type: 'usage_update', sessionId: 'ghost-1', tokenUsage: { inputTokens: 0 } } as AgentEvent)
    expect(store.get(sessionAtomFamily('ghost-1'))?.isProcessing).toBe(false)
  })

  it('CONTROL — a turn event on an unknown session still shows it running', () => {
    const store = createStore()
    deliver(store, { type: 'text_delta', sessionId: 'live-1', delta: 'hi' } as AgentEvent)
    expect(store.get(sessionAtomFamily('live-1'))?.isProcessing).toBe(true)
  })
})

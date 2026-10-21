import { afterEach, describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import type { Message, Session } from '../../../shared/types'
import {
  sessionAtomFamily,
  sessionMetaMapAtom,
  sessionIdsAtom,
  loadedSessionsAtom,
  ensureSessionMessagesLoadedAtom,
  forceSessionMessagesReloadAtom,
  refreshSessionsMetadataAtom,
  initializeSessionsAtom,
  replaceLoadedSessionAtom,
  sessionAttentionPrompt,
  sessionAttentionState,
  sessionAwaitsApproval,
  extractSessionMeta,
} from '../sessions'

function msg(id: string, role: Message['role'] = 'user'): Message {
  return {
    id,
    role,
    content: `content:${id}`,
    timestamp: Date.now(),
  }
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id ?? 'session-1',
    workspaceId: overrides.workspaceId ?? 'workspace-1',
    messages: overrides.messages ?? [],
    permissionMode: overrides.permissionMode ?? 'ask',
    supportsBranching: overrides.supportsBranching ?? true,
    ...overrides,
  } as Session
}

describe('session message loading atoms', () => {
  const originalWindow = globalThis.window

  afterEach(() => {
    if (originalWindow) {
      globalThis.window = originalWindow
    } else {
      // @ts-expect-error test cleanup for window shim
      delete globalThis.window
    }
  })

  it('replaceLoadedSessionAtom marks authoritative full sessions as loaded', () => {
    const store = createStore()
    const sessionId = 'session-1'

    store.set(replaceLoadedSessionAtom, makeSession({
      id: sessionId,
      messages: [msg('m1'), msg('m2', 'assistant')],
    }))

    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(true)
    expect(store.get(sessionAtomFamily(sessionId))?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(sessionMetaMapAtom).get(sessionId)?.messageCount).toBe(2)
  })

  it('forceSessionMessagesReloadAtom reloads an empty-but-loaded session', async () => {
    const store = createStore()
    const sessionId = 'session-1'
    const calls: string[] = []

    globalThis.window = {
      electronAPI: {
        getSessionMessages: async (id: string) => {
          calls.push(id)
          return makeSession({
            id,
            messages: [msg('m1'), msg('m2', 'assistant')],
          })
        },
      },
    } as unknown as typeof window

    store.set(sessionAtomFamily(sessionId), makeSession({ id: sessionId, messages: [] }))
    store.set(loadedSessionsAtom, new Set([sessionId]))

    const normalResult = await store.set(ensureSessionMessagesLoadedAtom, sessionId)
    expect(calls).toEqual([])
    expect(normalResult?.messages).toHaveLength(0)

    const forcedResult = await store.set(forceSessionMessagesReloadAtom, sessionId)
    expect(calls).toEqual([sessionId])
    expect(forcedResult?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(sessionAtomFamily(sessionId))?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(true)
  })

  it('does not mark stale empty-response fallback as loaded', async () => {
    const store = createStore()
    const sessionId = 'session-1'
    const calls: string[] = []

    globalThis.window = {
      electronAPI: {
        getSessionMessages: async (id: string) => {
          calls.push(id)
          if (calls.length === 1) {
            return makeSession({ id, messages: [] })
          }
          return makeSession({
            id,
            messages: [msg('m1'), msg('m2', 'assistant')],
          })
        },
      },
    } as unknown as typeof window

    store.set(sessionAtomFamily(sessionId), makeSession({
      id: sessionId,
      messages: [msg('local-1'), msg('local-2', 'assistant')],
    }))

    const firstResult = await store.set(ensureSessionMessagesLoadedAtom, sessionId)
    expect(firstResult?.messages.map((message) => message.id)).toEqual(['local-1', 'local-2'])
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(false)

    const secondResult = await store.set(forceSessionMessagesReloadAtom, sessionId)
    expect(calls).toEqual([sessionId, sessionId])
    expect(secondResult?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(true)
  })
})

describe('refreshSessionsMetadataAtom', () => {
  it('preserves messages for already-loaded sessions', () => {
    const store = createStore()
    const existingMessages = [msg('m1'), msg('m2', 'assistant')]

    // Pre-populate: session has messages and is marked loaded
    store.set(sessionAtomFamily('s1'), makeSession({ id: 's1', messages: existingMessages }))
    store.set(loadedSessionsAtom, new Set(['s1']))

    // Refresh with metadata-only payload (empty messages, like getSessions returns)
    const freshSessions = [makeSession({ id: 's1', messages: [] })]
    store.set(refreshSessionsMetadataAtom, {
      sessions: freshSessions,
      loadedSessionIds: new Set(['s1']),
    })

    // Messages should be preserved from the existing atom
    const session = store.get(sessionAtomFamily('s1'))
    expect(session?.messages.map(m => m.id)).toEqual(['m1', 'm2'])
  })

  it('marks sessions as unloaded when atom was cleared but loadedSessionIds still tracked them', () => {
    const store = createStore()

    // Session was previously loaded, but its atom was cleared (e.g., by remove + re-add)
    // while loadedSessionsAtom still tracks it. The atom value is null.
    store.set(loadedSessionsAtom, new Set(['s1']))
    // sessionAtomFamily('s1') defaults to null — no store.set needed

    // Refresh — s1 is in loadedSessionIds but current atom is null,
    // so shouldPreserveMessages is false. Since it was in loadedSessionIds,
    // it should be removed so lazy-loading re-fetches messages.
    const freshSessions = [makeSession({ id: 's1', messages: [] })]
    store.set(refreshSessionsMetadataAtom, {
      sessions: freshSessions,
      loadedSessionIds: new Set(['s1']),
    })

    expect(store.get(loadedSessionsAtom).has('s1')).toBe(false)
  })

  it('removes stale sessions from all atoms', () => {
    const store = createStore()

    // Initialize with two sessions via initializeSessionsAtom
    store.set(initializeSessionsAtom, [
      makeSession({ id: 's1' }),
      makeSession({ id: 's2' }),
    ])
    expect(store.get(sessionMetaMapAtom).size).toBe(2)
    expect(store.get(sessionIdsAtom)).toContain('s2')

    // Refresh with only s1 — s2 should be removed
    store.set(refreshSessionsMetadataAtom, {
      sessions: [makeSession({ id: 's1' })],
      loadedSessionIds: new Set<string>(),
    })

    expect(store.get(sessionMetaMapAtom).has('s2')).toBe(false)
    expect(store.get(sessionIdsAtom)).not.toContain('s2')
    expect(store.get(sessionAtomFamily('s2'))).toBe(null)
  })

  it('preserves omitted sessions when removeMissing is false', () => {
    const store = createStore()

    store.set(initializeSessionsAtom, [
      makeSession({ id: 's1', name: 'First', lastMessageAt: 200 }),
      makeSession({ id: 's2', name: 'Second', lastMessageAt: 100 }),
    ])

    const result = store.set(refreshSessionsMetadataAtom, {
      sessions: [makeSession({ id: 's1', name: 'First refreshed', lastMessageAt: 300 })],
      loadedSessionIds: new Set<string>(),
      removeMissing: false,
    })

    expect(result.has('s1')).toBe(true)
    expect(result.has('s2')).toBe(true)
    expect(result.get('s1')?.name).toBe('First refreshed')
    expect(result.get('s2')?.name).toBe('Second')

    const storeMap = store.get(sessionMetaMapAtom)
    expect(storeMap.has('s2')).toBe(true)
    expect(store.get(sessionIdsAtom)).toEqual(['s1', 's2'])
    expect(store.get(sessionAtomFamily('s2'))?.name).toBe('Second')
  })

  it('non-destructive refresh still preserves loaded messages for returned sessions', () => {
    const store = createStore()
    const existingMessages = [msg('m1'), msg('m2', 'assistant')]

    store.set(initializeSessionsAtom, [
      makeSession({ id: 's1', name: 'First', messages: [] }),
      makeSession({ id: 's2', name: 'Second', messages: [] }),
    ])
    store.set(sessionAtomFamily('s1'), makeSession({ id: 's1', name: 'First', messages: existingMessages }))
    store.set(loadedSessionsAtom, new Set(['s1']))

    store.set(refreshSessionsMetadataAtom, {
      sessions: [makeSession({ id: 's1', name: 'First refreshed', messages: [] })],
      loadedSessionIds: new Set(['s1']),
      removeMissing: false,
    })

    expect(store.get(sessionAtomFamily('s1'))?.messages.map(m => m.id)).toEqual(['m1', 'm2'])
    expect(store.get(sessionMetaMapAtom).get('s1')?.name).toBe('First refreshed')
    expect(store.get(sessionMetaMapAtom).get('s2')?.name).toBe('Second')
  })

  it('updates metadata map and returns it', () => {
    const store = createStore()

    const sessions = [
      makeSession({ id: 's1', name: 'First' }),
      makeSession({ id: 's2', name: 'Second' }),
    ]

    const result = store.set(refreshSessionsMetadataAtom, {
      sessions,
      loadedSessionIds: new Set<string>(),
    })

    // Returned map matches store state
    expect(result.size).toBe(2)
    expect(result.get('s1')?.name).toBe('First')
    expect(result.get('s2')?.name).toBe('Second')

    // Store is consistent
    const storeMap = store.get(sessionMetaMapAtom)
    expect(storeMap.size).toBe(2)
    expect(storeMap.get('s1')?.name).toBe('First')

    // IDs are set
    expect(store.get(sessionIdsAtom)).toHaveLength(2)
  })

  /**
   * D1.380 — the ONE sync path that runs reconciles `isProcessing` from the
   * host, in BOTH directions, and must keep doing so.
   *
   * D1.380 was written about a guard in `syncSessionsToAtomsAtom`
   * (`if (atomSession?.isProcessing) continue`, plus a `meta.isProcessing = true`
   * force) that skipped the host's snapshot whenever the renderer believed a
   * turn was running. That atom had ZERO readers — one definition, no call site
   * anywhere in the tree — and it is deleted; the row's own question, *does the
   * sync path reconcile the flag from the host*, is answered **yes, already**,
   * here.
   *
   * Both directions are load-bearing and neither is incidental:
   *
   *  * host TRUE over renderer FALSE is what a window opened mid-turn needs, and
   *    it is the backstop behind D1.379's event-driven raise;
   *  * host FALSE over renderer TRUE is the one that keeps that raise from ever
   *    becoming permanent — the stranded-spinner case D1.379 priced.
   *
   * A reintroduced flag-keyed skip would break exactly one of these and pass the
   * other, which is why both are pinned rather than one.
   */
  it('adopts the host\'s isProcessing over the renderer\'s — in both directions', () => {
    const store = createStore()

    // Direction 1: the renderer believes idle, the host says the turn is running
    // (a window opened mid-turn, a dropped push, a reconnecting client).
    store.set(sessionAtomFamily('s1'), makeSession({ id: 's1', isProcessing: false }))
    store.set(loadedSessionsAtom, new Set(['s1']))
    store.set(refreshSessionsMetadataAtom, {
      sessions: [makeSession({ id: 's1', isProcessing: true })],
      loadedSessionIds: new Set(['s1']),
    })
    expect(store.get(sessionAtomFamily('s1'))?.isProcessing).toBe(true)
    expect(store.get(sessionMetaMapAtom).get('s1')?.isProcessing).toBe(true)

    // Direction 2: the renderer believes a turn is running, the host says it is
    // over. THIS is the one a flag-keyed guard would have skipped.
    store.set(sessionAtomFamily('s1'), makeSession({ id: 's1', isProcessing: true }))
    store.set(refreshSessionsMetadataAtom, {
      sessions: [makeSession({ id: 's1', isProcessing: false })],
      loadedSessionIds: new Set(['s1']),
    })
    expect(store.get(sessionAtomFamily('s1'))?.isProcessing).toBe(false)
    expect(store.get(sessionMetaMapAtom).get('s1')?.isProcessing).toBe(false)
  })

  it('adopting the host\'s flag does not cost the loaded messages', () => {
    // The control for the case above: if a future "reconcile the flag" change
    // were written as a whole-object overwrite that forgot `shouldPreserveMessages`,
    // direction 2 would still pass and the transcript would vanish.
    const store = createStore()
    store.set(sessionAtomFamily('s1'), makeSession({
      id: 's1',
      isProcessing: true,
      messages: [msg('m1'), msg('m2', 'assistant')],
    }))
    store.set(loadedSessionsAtom, new Set(['s1']))

    store.set(refreshSessionsMetadataAtom, {
      sessions: [makeSession({ id: 's1', isProcessing: false, messages: [] })],
      loadedSessionIds: new Set(['s1']),
    })

    const session = store.get(sessionAtomFamily('s1'))
    expect(session?.isProcessing).toBe(false)
    expect(session?.messages.map(m => m.id)).toEqual(['m1', 'm2'])
  })

  it('the dead sync atom is gone, and nothing re-exports it', async () => {
    // D1.380's subject. A source pin rather than a behaviour: the symbol had no
    // test of its own — which was part of the evidence that it had no readers —
    // so the only way to state "this is deleted on purpose" is to assert the
    // module does not carry it, and that the live path's guard-free write is
    // still spelled the way the note above describes.
    const atoms = await import('../sessions') as Record<string, unknown>
    expect('syncSessionsToAtomsAtom' in atoms).toBe(false)
    // The positive control on the same instrument: the neighbours are exported.
    expect('refreshSessionsMetadataAtom' in atoms).toBe(true)
    expect('sessionAtomFamily' in atoms).toBe(true)
  })
})

/**
 * P6.270 (denominator F14, F28) — one classifier decides what a session wants.
 *
 * The row's verdict was `absent` on all three runtimes and it is refuted: the
 * list already draws a spinner, an unread dot and a shield, all from host state.
 * What this function adds is a SINGLE answer, so the icon, its tooltip and its
 * accessible name cannot disagree — and the precedence, which is the only part a
 * reader could get wrong by looking at the render order.
 */
describe('sessionAttentionState', () => {
  it('names the three states from host state alone', () => {
    expect(sessionAttentionState({ isProcessing: true }, false)).toBe('running')
    expect(sessionAttentionState({ hasUnread: true }, false)).toBe('unread')
    expect(sessionAttentionState({}, true)).toBe('waiting')
  })

  it('a pending prompt OUTRANKS the run it is blocking', () => {
    // The realistic shape: a session holding a permission prompt is also
    // mid-turn. The prompt is the half only the user can clear, so it wins —
    // and reading the render order in `SessionItem` would suggest the opposite.
    expect(sessionAttentionState({ isProcessing: true, hasUnread: true }, true)).toBe('waiting')
    expect(sessionAttentionState({ isProcessing: true, hasUnread: true }, false)).toBe('running')
  })

  it('control — a session with nothing pending gains no state, and therefore no label', () => {
    expect(sessionAttentionState({}, false)).toBeUndefined()
    expect(sessionAttentionState({ isProcessing: false, hasUnread: false }, false)).toBeUndefined()
  })

  it('`hasUnread` is read as strictly true, matching `hasUnreadMeta`', () => {
    // The field is optional and the list's own reader compares against `true`;
    // a truthiness test here would disagree with it on `undefined`.
    expect(sessionAttentionState({ hasUnread: undefined }, false)).toBeUndefined()
  })
})

/**
 * P6.757 / P6.758 — the server's `awaitingApprovalCount` reaches the desktop.
 *
 * It has been on every Session DTO since F15 (`SessionManager.toSessionDto`,
 * derived from the live pending-request map) and iOS has read it since the same
 * row; the desktop read only its own per-window `pendingPermissions` map. These
 * assertions pin the union and both of its edges, plus the projection that used
 * to drop the field from the TYPE while carrying it at runtime.
 */
describe('sessionAwaitsApproval (P6.757)', () => {
  it('positive — the server count alone marks the session waiting, with no local prompt', () => {
    // The case the local map cannot see at all: a prompt raised before this
    // window connected, or against a session it never subscribed to.
    expect(sessionAwaitsApproval({ awaitingApprovalCount: 1 }, false)).toBe(true)
    expect(sessionAttentionState({ awaitingApprovalCount: 2 }, false)).toBe('waiting')
    // And it outranks a run, exactly as a local prompt does.
    expect(sessionAttentionState({ awaitingApprovalCount: 1, isProcessing: true }, false)).toBe('waiting')
  })

  it('negative — an absent or zero count with no local prompt is NOT waiting', () => {
    // Absent is the older-server case the DTO comment reserves: "not waiting",
    // never a decode failure and never a phantom shield.
    expect(sessionAwaitsApproval({}, false)).toBe(false)
    expect(sessionAwaitsApproval({ awaitingApprovalCount: 0 }, false)).toBe(false)
    expect(sessionAttentionState({ awaitingApprovalCount: 0, hasUnread: true }, false)).toBe('unread')
  })

  it('a present-but-stale zero does not blank a live local prompt', () => {
    // Nothing emits a Session DTO when a permission request is raised, so a meta
    // in hand can say 0 while this window holds the card. Treating the count as
    // strictly authoritative would drop the shield until the next list refresh.
    expect(sessionAwaitsApproval({ awaitingApprovalCount: 0 }, true)).toBe(true)
    expect(sessionAttentionState({ awaitingApprovalCount: 0 }, true)).toBe('waiting')
  })

  it('matches the iOS predicate exactly when this window holds nothing', () => {
    // `Session.isAwaitingApproval` on iOS is `(awaitingApprovalCount ?? 0) > 0`.
    for (const count of [undefined, 0, 1, 7]) {
      expect(sessionAwaitsApproval({ awaitingApprovalCount: count }, false))
        .toBe((count ?? 0) > 0)
    }
  })

  it('P6.758 — the projection carries the field, and the type now declares it', () => {
    // It always survived the spread; what it did not survive was `as SessionMeta`,
    // which hid it from every reader. No cast, so this line is type-checked.
    const meta = extractSessionMeta(makeSession({ awaitingApprovalCount: 3 }))
    expect(meta.awaitingApprovalCount).toBe(3)
    expect(extractSessionMeta(makeSession()).awaitingApprovalCount).toBeUndefined()
  })
})

/**
 * P6.764 — the waiting label's SUBJECT, and the one rule that makes it honest.
 *
 * The count says a session is waiting; these two DTO fields say on what. The
 * failing case the row was born from is a prompt only the server knows about —
 * raised before this window connected, or on another device — where the row
 * fell back to the bare `session.attention.waiting` while the server held the
 * answer all along.
 */
describe('sessionAttentionPrompt (P6.764)', () => {
  it('positive — the server fields name the subject when this window holds no card', () => {
    expect(sessionAttentionPrompt(
      { awaitingApprovalToolName: 'Bash', awaitingApprovalType: 'bash' },
      undefined,
    )).toEqual({ type: 'bash', toolName: 'Bash' })
    // The other branch the label distinguishes: a question, which is named by
    // its TYPE and never by a tool.
    expect(sessionAttentionPrompt(
      { awaitingApprovalToolName: 'ask_user', awaitingApprovalType: 'ask_user' },
      null,
    )?.type).toBe('ask_user')
  })

  it('the local card WINS, and the two sources are never mixed', () => {
    // The rule the function exists for. Both sources present and describing
    // DIFFERENT requests: taking `toolName` from one and `type` from the other
    // would label an ask_user question with a bash tool's name.
    const mixed = sessionAttentionPrompt(
      { awaitingApprovalToolName: 'Bash', awaitingApprovalType: 'bash' },
      { type: 'ask_user', toolName: 'ask_user' },
    )
    expect(mixed).toEqual({ type: 'ask_user', toolName: 'ask_user' })
    expect(mixed?.toolName).not.toBe('Bash')
    // …and a local card with no `type` does not borrow the server's.
    expect(sessionAttentionPrompt(
      { awaitingApprovalToolName: 'Bash', awaitingApprovalType: 'bash' },
      { toolName: 'Write' },
    )).toEqual({ toolName: 'Write' })
  })

  it('negative — neither field is "waiting, subject unknown", not an error', () => {
    // The older-server case and the count-without-subject case are the same
    // value here, and both keep the subjectless label the row already had.
    expect(sessionAttentionPrompt({}, undefined)).toBeUndefined()
    expect(sessionAttentionPrompt(
      { awaitingApprovalToolName: undefined, awaitingApprovalType: undefined },
      null,
    )).toBeUndefined()
    // One half alone is still honest — it says what it knows and omits the rest.
    expect(sessionAttentionPrompt({ awaitingApprovalToolName: 'Edit' }, undefined))
      .toEqual({ toolName: 'Edit' })
  })

  it('the projection carries both fields, and the type declares them', () => {
    // No cast, so this is type-checked: the fields ride the same spread the
    // count does, and a session without them projects to undefined.
    const meta = extractSessionMeta(makeSession({
      awaitingApprovalCount: 1,
      awaitingApprovalToolName: 'Bash',
      awaitingApprovalType: 'bash',
    }))
    expect(meta.awaitingApprovalToolName).toBe('Bash')
    expect(meta.awaitingApprovalType).toBe('bash')
    expect(extractSessionMeta(makeSession()).awaitingApprovalToolName).toBeUndefined()
    expect(extractSessionMeta(makeSession()).awaitingApprovalType).toBeUndefined()
  })
})

/**
 * F1.355 — `extractSessionMeta` preferred the host's header `messageCount`
 * through `??`, and nothing reassigns that count after load, so a session loaded
 * at startup reported its frozen header count to Views evaluation (`useViews`
 * → `buildViewContext`) for the whole run while its loaded transcript grew.
 * Upstream craft-agents-oss v0.11.0+ takes the larger of the two; adopted.
 * Residue, stated: after a TRUNCATING rewind `Math.max` keeps the higher stale
 * header count until the host's header catches up.
 */
describe('extractSessionMeta — F1.355 messageCount is the larger of header and loaded', () => {
  it('positive — a loaded transcript longer than the header count wins', () => {
    const meta = extractSessionMeta(makeSession({
      messageCount: 2,
      messages: [msg('m1'), msg('m2', 'assistant'), msg('m3'), msg('m4', 'assistant')],
    }))
    expect(meta.messageCount).toBe(4)
  })

  it('negative — an unloaded session (no messages) keeps its header count', () => {
    expect(extractSessionMeta(makeSession({ messageCount: 5, messages: [] })).messageCount).toBe(5)
  })
})

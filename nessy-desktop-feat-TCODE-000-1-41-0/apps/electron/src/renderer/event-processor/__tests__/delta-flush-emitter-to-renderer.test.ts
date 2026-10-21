/**
 * P3.16 · the join: the REAL emitter's wire, fed to the REAL renderer.
 *
 * The other two P3.16 files each prove one half. `delta-flush-before-turn-end`
 * drives `SessionManager` and asserts the wire ORDER; the renderer's
 * `late-delta-after-turn-end` asserts what an order RENDERS. Nothing asserted
 * that the two orders were the same order — they were connected by a hand-copied
 * event list, so `sendTurnEndEvent` could regress and the renderer file would
 * stay green while only the wire rows fired.
 *
 * This file removes the copy. One rig: a real `SessionManager` → the events it
 * actually put on the wire → the renderer's real `processEvent`. The assertion
 * is the user-visible one — how many bubbles, carrying what, still live — and it
 * is made about the bytes the emitter emitted, not about a list a human typed.
 *
 * The POSITIVE CONTROL is the same captured wire with `complete` moved one slot
 * earlier. It is not decoration: it is what proves the renderer half of the rig
 * can still see the break. If the control ever renders one clean bubble too, the
 * detector has stopped detecting and every row here is worthless.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { processEvent as renderEvent } from '../processor'
import type { SessionState } from '../types'
// The emitter lives in another package on purpose: reaching across for the REAL
// `SessionManager` is what makes this a join. It sits on THIS side of the fence
// because `apps/electron` already depends on `@nessy-agent/server-core` (the main
// process constructs a `SessionManager`), whereas the mirror-image placement
// drags the whole renderer subtree — and its `@config/*` alias — into
// server-core's `tsc` program, where it does not resolve.
import {
  createManagedSession,
  type SessionManager,
} from '../../../../../../packages/server-core/src/sessions/SessionManager'
import { createTestSessionManager } from '../../../../../../packages/server-core/src/sessions/__tests__/test-session-manager'

const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  rmSync(join(SESSIONS_DIR, 'ws_test'), { recursive: true, force: true })
})

type Internals = {
  processEvent(managed: unknown, event: Record<string, unknown>): Promise<void>
  beginAuthRequest(managed: unknown, request: Record<string, unknown>): Promise<void> | void
  onProcessingStopped(sessionId: string, reason: string, workspaceId?: string): Promise<void>
}

function setUp(sessionId: string) {
  const manager = createTestSessionManager()
  managers.push(manager)
  const sent: SessionEvent[] = []
  manager.setEventSink((_channel, _target, event) => { sent.push(event as SessionEvent) })
  const managed = createManagedSession({ id: sessionId }, {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: `/tmp/nessy-${sessionId}`,
    createdAt: 1,
  } as never, { messagesLoaded: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`ws_test:${sessionId}`, managed)
  ;(managed as { isProcessing: boolean }).isProcessing = true
  ;(managed as { agent: unknown }).agent = {
    interruptForHandoff: () => undefined,
    forceAbort: () => undefined,
    getSessionId: () => undefined,
  }
  return { manager, managed, sent, internals: manager as unknown as Internals }
}

/** Past `DELTA_BATCH_INTERVAL_MS` (50 ms): the batch timer has had its chance. */
const pastTheBatchTimer = () => new Promise(resolve => setTimeout(resolve, 80))

/**
 * The renderer's whole story about a session, reduced to what a human sees:
 * which bubbles exist, what each says, and which still claim to be live.
 */
function render(sessionId: string, wire: SessionEvent[]) {
  let state: SessionState = {
    session: { id: sessionId, messages: [], isProcessing: true } as never,
    streaming: null,
  }
  for (const event of wire) state = renderEvent(state, event as never).state
  const assistant = state.session.messages.filter(message => message.role === 'assistant')
  return {
    bubbles: assistant.map(message => message.content),
    live: assistant.filter(message => message.isStreaming || message.isPending).map(message => message.content),
  }
}

/** Only the events this proof is about — the renderer ignores the rest anyway. */
const streamShape = (wire: SessionEvent[]) => wire
  .map(event => event.type)
  .filter(type => type === 'text_delta' || type === 'text_complete' || type === 'complete' || type === 'interrupted')

/**
 * The positive control, built from the captured wire rather than typed out:
 * move the terminal event one slot earlier, so the last delta lands after it —
 * exactly what the 50 ms batch timer did before P3.16, and nothing else changed.
 */
function withTerminalOneSlotEarlier(wire: SessionEvent[]): SessionEvent[] {
  const reordered = [...wire]
  const terminal = reordered.findIndex(event => event.type === 'complete' || event.type === 'interrupted')
  expect(terminal).toBeGreaterThan(0)
  ;[reordered[terminal - 1], reordered[terminal]] = [reordered[terminal], reordered[terminal - 1]]
  return reordered
}

describe('P3.16 · the emitter’s own wire, rendered', () => {
  it('the auth handoff: a second delta still in the batcher reaches the renderer first', async () => {
    // The shape the bug needed: one delta already delivered by its timer, a
    // SECOND still sitting in the 50 ms batch when the turn ends.
    const { managed, sent, internals } = setUp('p316-join-auth')
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello ', turnId: 'X' })
    await pastTheBatchTimer()
    await internals.processEvent(managed, { type: 'text_delta', text: 'world', turnId: 'X' })

    await internals.beginAuthRequest(managed, {
      type: 'oauth',
      provider: 'github',
      requestId: 'req-join',
      sessionId: 'p316-join-auth',
      sourceSlug: 'github',
      sourceName: 'GitHub',
    })
    await pastTheBatchTimer()

    // What the emitter actually put on the wire.
    expect(streamShape(sent)).toEqual(['text_delta', 'text_delta', 'complete'])

    // What the renderer makes of it: one bubble, whole message, nothing live.
    expect(render('p316-join-auth', sent)).toEqual({ bubbles: ['Hello world'], live: [] })

    // POSITIVE CONTROL — same events, `complete` one slot earlier.
    expect(streamShape(withTerminalOneSlotEarlier(sent)))
      .toEqual(['text_delta', 'complete', 'text_delta'])
    expect(render('p316-join-auth', withTerminalOneSlotEarlier(sent)))
      .toEqual({ bubbles: ['Hello ', 'world'], live: ['world'] })
  })

  it('the ordinary turn end with no text_complete behind it (onProcessingStopped)', async () => {
    const { managed, sent, internals } = setUp('p316-join-stopped')
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello ', turnId: 'X' })
    await pastTheBatchTimer()
    await internals.processEvent(managed, { type: 'text_delta', text: 'world', turnId: 'X' })

    await internals.onProcessingStopped('p316-join-stopped', 'complete', 'ws_test')
    await pastTheBatchTimer()

    expect(streamShape(sent)).toEqual(['text_delta', 'text_delta', 'complete'])
    expect(render('p316-join-stopped', sent)).toEqual({ bubbles: ['Hello world'], live: [] })

    expect(render('p316-join-stopped', withTerminalOneSlotEarlier(sent)))
      .toEqual({ bubbles: ['Hello ', 'world'], live: ['world'] })
  })

  it('REGRESSED EMITTER: with `sendTurnEndEvent` reduced to a bare send, the rig goes red', async () => {
    // The control for the JOIN itself, and the reason this file exists.
    //
    // Every row above passed on its first run, which is precisely when a
    // detector has to be attacked: green proves nothing until the red case is
    // shown to be reachable. So this row restores the pre-P3.16 emitter — the
    // old code was `this.sendEvent({ type: 'complete', … })`, and overriding the
    // INSTANCE's `sendTurnEndEvent` to do exactly that reproduces it — and drives
    // the identical path. Nothing else differs between this row and the first
    // one: same events, same timings, same renderer. The only variable is
    // whether the real `sendTurnEndEvent` ran.
    //
    // Overriding the instance rather than editing `SessionManager.ts` for a
    // one-shot RED run is deliberate: this control ships, so it re-proves the
    // detector on every CI run instead of once on a laptop.
    const { manager, managed, sent, internals } = setUp('p316-join-regressed')
    const bypass = manager as unknown as {
      sendTurnEndEvent(event: SessionEvent, workspaceId: string): Promise<void>
      sendEvent(event: SessionEvent, workspaceId: string): void
    }
    bypass.sendTurnEndEvent = async (event, workspaceId) => { bypass.sendEvent(event, workspaceId) }

    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello ', turnId: 'X' })
    await pastTheBatchTimer()
    await internals.processEvent(managed, { type: 'text_delta', text: 'world', turnId: 'X' })

    await internals.beginAuthRequest(managed, {
      type: 'oauth',
      provider: 'github',
      requestId: 'req-regressed',
      sessionId: 'p316-join-regressed',
      sourceSlug: 'github',
      sourceName: 'GitHub',
    })
    await pastTheBatchTimer()

    // The batcher's 50 ms timer delivered the second delta AFTER the turn ended…
    expect(streamShape(sent)).toEqual(['text_delta', 'complete', 'text_delta'])
    // …and this is what the user reads: a second bubble, still spinning, after
    // the turn visibly finished.
    expect(render('p316-join-regressed', sent)).toEqual({ bubbles: ['Hello ', 'world'], live: ['world'] })
  })

  it('REGRESSED EMITTER: the same A/B on the ordinary turn end', async () => {
    // The auth handoff is a handoff; `onProcessingStopped` is how most turns
    // end, so it gets its own controlled pair rather than inheriting the other
    // row's result by analogy.
    const { manager, managed, sent, internals } = setUp('p316-join-regressed-stopped')
    const bypass = manager as unknown as {
      sendTurnEndEvent(event: SessionEvent, workspaceId: string): Promise<void>
      sendEvent(event: SessionEvent, workspaceId: string): void
    }
    bypass.sendTurnEndEvent = async (event, workspaceId) => { bypass.sendEvent(event, workspaceId) }

    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello ', turnId: 'X' })
    await pastTheBatchTimer()
    await internals.processEvent(managed, { type: 'text_delta', text: 'world', turnId: 'X' })

    await internals.onProcessingStopped('p316-join-regressed-stopped', 'complete', 'ws_test')
    await pastTheBatchTimer()

    expect(streamShape(sent)).toEqual(['text_delta', 'complete', 'text_delta'])
    expect(render('p316-join-regressed-stopped', sent))
      .toEqual({ bubbles: ['Hello ', 'world'], live: ['world'] })
  })

  it('the user-stop path, and the completion that follows it in a real turn', async () => {
    // `cancelProcessing` emits `interrupted`, and a turn that streamed a final
    // assistant message also carries its `text_complete`. Rendered together this
    // is the duplicated-prefix outcome P3.14's review recorded, so it is the
    // strongest control of the three: the break is not a stray bubble, it is the
    // user reading the beginning of the answer twice.
    const { manager, managed, sent, internals } = setUp('p316-join-cancel')
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello ', turnId: 'X' })
    await pastTheBatchTimer()
    await internals.processEvent(managed, { type: 'text_delta', text: 'world', turnId: 'X' })

    await manager.cancelProcessing('p316-join-cancel', false, 'ws_test')
    await internals.processEvent(managed, { type: 'text_complete', text: 'Hello world', turnId: 'X' })
    await pastTheBatchTimer()

    expect(streamShape(sent)).toEqual(['text_delta', 'text_delta', 'interrupted', 'text_complete'])
    expect(render('p316-join-cancel', sent)).toEqual({ bubbles: ['Hello world'], live: [] })

    expect(render('p316-join-cancel', withTerminalOneSlotEarlier(sent)))
      .toEqual({ bubbles: ['Hello ', 'Hello world'], live: [] })
  })
})

/**
 * P3.9 · a codex turn that produces BOTH prose and an image must keep both in
 * the LIVE renderer state.
 *
 * The test is live-shaped on purpose: it drives the real `CodexEventAdapter`
 * with app-server notifications and feeds what it emits through the real
 * `processEvent`, translating between the two exactly the way
 * `SessionManager`'s `text_delta` / `text_complete` cases do (it forwards
 * `text`/`delta`, `turnId`, `isIntermediate`, a monotonic `timestamp` and the
 * authoritative `messageId` it mints per completed message). Asserting on the
 * adapter's output alone would have proved nothing here — the collision this row
 * fixes lives in the renderer's lookup, and the adapter's events looked correct
 * on their own the whole time.
 *
 * Three orderings are covered, all measured against the pre-fix tree:
 * 1. the image completing MID-STREAM hijacked the prose bubble that was still
 *    streaming (its accumulated text was replaced by the image block);
 * 2. the same ordering with the message never completing — an interrupted or
 *    refused turn — lost the streamed prose PERMANENTLY;
 * 3. with a turn id in play (any call site that passes one to `startTurn`) the
 *    second non-intermediate `text_complete` REPLACED the first outright.
 */
import { describe, expect, it } from 'bun:test'
import { CodexEventAdapter } from '@nessy-agent/shared/agent/backend/codex/event-adapter'
import { processEvent } from '../processor'
import type { AgentEvent, SessionState } from '../types'

/** `{ type: 'imageGeneration' } & ImageGenerationItem`, generated/v2. */
const IMAGE_ITEM = {
  type: 'imageGeneration',
  id: 'ig1',
  status: 'completed',
  revisedPrompt: 'a cat on a windowsill',
  result: 'ok',
  failure: null,
  savedPath: '/tmp/cat.png',
}
/** `{ type: 'agentMessage', id, text }`, generated/v2. */
const MESSAGE_ITEM = { type: 'agentMessage', id: 'am1', text: 'Here is the image you asked for.' }
const PROSE_HEAD = 'Here is '
const PROSE_TAIL = 'the image you asked for.'

/** `AgentMessageDeltaNotification` = `{ threadId, turnId, itemId, delta }`. */
function delta(text: string) {
  return ['item/agentMessage/delta', { threadId: 'th1', turnId: 'cx-turn-1', itemId: 'am1', delta: text }] as const
}
/** `ItemCompletedNotification` = `{ item, threadId, turnId, completedAtMs }`. */
function completed(item: unknown) {
  return ['item/completed', { item, threadId: 'th1', turnId: 'cx-turn-1', completedAtMs: 1 }] as const
}
function started(item: unknown) {
  return ['item/started', { item, threadId: 'th1', turnId: 'cx-turn-1', startedAtMs: 1 }] as const
}

/**
 * Replay app-server notifications through the adapter and into renderer state,
 * mirroring SessionManager's forwarding of the two text events.
 */
function replay(notifications: ReadonlyArray<readonly [string, unknown]>, turnId?: string): SessionState {
  const adapter = new CodexEventAdapter()
  adapter.startTurn(turnId)
  let state: SessionState = {
    session: { id: 's1', messages: [] } as never,
    streaming: null,
  }
  let minted = 0
  for (const [method, params] of notifications) {
    for (const event of adapter.adapt(method, params) as Array<Record<string, unknown>>) {
      let rendererEvent: AgentEvent | null = null
      if (event.type === 'text_delta') {
        rendererEvent = { type: 'text_delta', sessionId: 's1', delta: event.text as string, turnId: event.turnId as string | undefined }
      } else if (event.type === 'text_complete') {
        minted += 1
        rendererEvent = {
          type: 'text_complete',
          sessionId: 's1',
          text: event.text as string,
          isIntermediate: event.isIntermediate as boolean | undefined,
          turnId: event.turnId as string | undefined,
          timestamp: minted,
          messageId: `server-message-${minted}`,
        }
      } else if (event.type === 'complete') {
        // SessionManager's `onProcessingStopped`, which forwards the backend's
        // turn end to the renderer as `complete` once nothing is queued.
        rendererEvent = { type: 'complete', sessionId: 's1' }
      }
      if (rendererEvent) state = processEvent(state, rendererEvent).state
    }
  }
  return state
}

const contents = (state: SessionState) => state.session.messages.map(m => m.content)

describe('codex prose + image in one turn (live event-processor state)', () => {
  it('keeps both when the image completes while the prose is still streaming', () => {
    const state = replay([
      delta(PROSE_HEAD),
      completed(IMAGE_ITEM),
      delta(PROSE_TAIL),
      completed(MESSAGE_ITEM),
    ])

    expect(state.session.messages).toHaveLength(2)
    // The image kept its own row instead of overwriting the streaming bubble…
    expect(contents(state).filter(c => c.includes('/tmp/cat.png'))).toHaveLength(1)
    // …and the prose bubble kept every delta it had accumulated, head included.
    const prose = state.session.messages.find(m => !m.content.includes('image-preview'))
    expect(prose?.content).toBe(`${PROSE_HEAD}${PROSE_TAIL}`)
    // Distinct identities are what makes that possible.
    expect(state.session.messages[0].turnId).not.toBe(state.session.messages[1].turnId)
  })

  it('does not lose the streamed prose when the turn never completes the message', () => {
    // An interrupt, an error or a refusal ends the turn with no
    // `item/completed` for the agentMessage. Before per-message identity the
    // image's completion had already overwritten the streamed text, and nothing
    // ever brought it back.
    const state = replay([
      delta('Here is the answer I was typing'),
      completed(IMAGE_ITEM),
    ])

    expect(contents(state)).toContain('Here is the answer I was typing')
    expect(contents(state).some(c => c.includes('/tmp/cat.png'))).toBe(true)
  })

  it('keeps two non-intermediate completions apart even when a turn id is in play', () => {
    // The id-keyed path: `findAssistantMessage` matches ANY assistant message
    // with the given turn id, so a shared turn id made the second completion
    // replace the first.
    const state = replay([completed(IMAGE_ITEM), completed(MESSAGE_ITEM)], 'turn-1')

    expect(state.session.messages).toHaveLength(2)
    expect(contents(state).some(c => c.includes('/tmp/cat.png'))).toBe(true)
    expect(contents(state)).toContain(MESSAGE_ITEM.text)
  })

  it('leaves no bubble marked streaming once the turn completes', () => {
    // P3.14 · the same live sequence, carried one event further. `turn/completed`
    // is what the adapter turns into the renderer's `complete`, and until P3.14
    // that handler cleared `isProcessing` without touching the per-message
    // flags — so the prose bubble, which never received a completion of its own,
    // stayed `isStreaming`/`isPending` after the turn had visibly ended.
    const state = replay([
      delta('Here is the answer I was typing'),
      completed(IMAGE_ITEM),
      ['turn/completed', { threadId: 'th1', turnId: 'cx-turn-1' }],
    ])

    // P3.9's guarantee holds: nothing was destroyed to resolve the flag.
    expect(contents(state)).toContain('Here is the answer I was typing')
    expect(contents(state).some(c => c.includes('/tmp/cat.png'))).toBe(true)
    // P3.14's: the turn is over, so no bubble still claims to be live.
    expect(state.session.messages.filter(m => m.isStreaming)).toEqual([])
    expect(state.session.messages.filter(m => m.isPending)).toEqual([])
  })

  it('renders an image whose started notification carried a blank path', () => {
    // The blank path at `started` used to close the item, so the `completed`
    // notification carrying the REAL path was dropped and the image never
    // rendered at all.
    const state = replay([
      started({ type: 'imageView', id: 'iv1', path: '' }),
      completed({ type: 'imageView', id: 'iv1', path: '/tmp/shot.png' }),
    ])

    expect(contents(state).some(c => c.includes('/tmp/shot.png'))).toBe(true)
  })
})

import { describe, expect, it } from 'bun:test'
import { handleTextDelta, handleTextComplete } from '../text'
import { groupMessagesByTurn } from '@nessy-agent/ui/chat/turn-utils'
import type { SessionState, TextCompleteEvent, TextDeltaEvent } from '../../types'

/**
 * R32 · the renderer half of `MessageDisplay`. hooks.md:1273 — "the replacement
 * text changes only what is rendered on screen. The transcript and what Claude
 * sees keep the original text" — so this reducer must land the override in a
 * SECOND field and leave `content`, which copy, export, branch-from-message and
 * persistence all read, untouched.
 */

function makeState(messages: unknown[], streaming: SessionState['streaming'] = null): SessionState {
  return {
    session: { id: 'session-1', messages, lastMessageAt: Date.now() } as never,
    streaming,
  }
}

const delta = (event: Partial<TextDeltaEvent>): TextDeltaEvent => ({
  type: 'text_delta',
  sessionId: 'session-1',
  delta: '',
  turnId: 'turn-1',
  ...event,
})

const complete = (event: Partial<TextCompleteEvent>): TextCompleteEvent => ({
  type: 'text_complete',
  sessionId: 'session-1',
  text: '',
  turnId: 'turn-1',
  ...event,
})

type Rendered = { content: string; displayContent?: string }

describe('R32 MessageDisplay override in the renderer', () => {
  it('renders the override while content keeps the original text', () => {
    let state = handleTextDelta(makeState([]), delta({
      delta: 'token is sk-secret\n',
      displayDelta: 'token is [redacted]\n',
    }))
    state = handleTextDelta(state, delta({ delta: 'and done', displayDelta: 'and done' }))

    const streamed = state.session.messages[0] as Rendered
    expect(streamed.content).toBe('token is sk-secret\nand done')
    expect(streamed.displayContent).toBe('token is [redacted]\nand done')

    state = handleTextComplete(state, complete({
      text: 'token is sk-secret\nand done',
      displayText: 'token is [redacted]\nand done',
      messageId: 'msg-main-1',
    }))

    const finished = state.session.messages[0] as Rendered
    expect(finished.content).toBe('token is sk-secret\nand done')
    expect(finished.displayContent).toBe('token is [redacted]\nand done')

    // And the display surface prefers it — while the markdown export, which reads
    // `content`, still carries the secret. That split IS the contract.
    const [turn] = groupMessagesByTurn(state.session.messages as never)
    expect(turn?.type).toBe('assistant')
    expect(turn && 'response' in turn ? turn.response?.displayText : undefined)
      .toBe('token is [redacted]\nand done')
    expect(turn && 'response' in turn ? turn.response?.text : undefined)
      .toBe('token is sk-secret\nand done')
  })

  it.each([
    ['no display fields at all', {}, {}],
    ['an override during streaming that the completed message withdraws', { displayDelta: 'shown' }, {}],
  ])('falls back to the original when there is %s', (_label, deltaFields, completeFields) => {
    // hooks.md:740 — "`MessageDisplay` | No | The original text is displayed". A
    // withdrawn override is the failing/timed-out hook seen from here: the emitter
    // omits `displayText`, and the message must not keep a stale replacement.
    let state = handleTextDelta(makeState([]), delta({ delta: 'plain', ...deltaFields }))
    state = handleTextComplete(state, complete({ text: 'plain', messageId: 'msg-main-2', ...completeFields }))

    const message = state.session.messages[0] as Rendered
    expect(message.content).toBe('plain')
    expect(message.displayContent).toBeUndefined()
    const [turn] = groupMessagesByTurn(state.session.messages as never)
    expect(turn && 'response' in turn ? turn.response?.displayText : undefined).toBeUndefined()
  })

  it('never sets the display field on a message that was never overridden', () => {
    // The old-payload path: a main process that does not emit the companion fields
    // must produce exactly the message shape it always did, so nothing downstream
    // has to special-case an `undefined` key that used to be absent.
    const state = handleTextDelta(makeState([]), delta({ delta: 'legacy' }))
    expect(Object.keys(state.session.messages[0] as object)).not.toContain('displayContent')
  })
})

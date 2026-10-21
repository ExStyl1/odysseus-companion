/**
 * U5 — a message queued mid-turn must not jump above the reply it interrupted.
 *
 * The two writes have different timing: a queued user message is appended the
 * instant it arrives, the in-flight turn's assistant message only at
 * `text_complete`. Appending both puts the answer to the earlier question under
 * the later question.
 */
import { describe, expect, it } from 'bun:test'
import { assistantInsertIndex, insertCompletedAssistantMessage } from '../transcript-order'

const user = (isQueued?: boolean) => ({ role: 'user', ...(isQueued === undefined ? {} : { isQueued }) })
const assistant = () => ({ role: 'assistant' })

describe('U5 transcript ordering', () => {
  it('appends normally when nothing is queued', () => {
    const messages = [user(), assistant(), user()]

    expect(assistantInsertIndex(messages)).toBe(3)
  })

  it('places the finished reply ABOVE a message queued while it streamed', () => {
    // "what does X do?" → the user queues "and Y?" mid-stream → X's answer lands.
    const messages = [user(), user(true)]
    const reply = assistant()

    insertCompletedAssistantMessage(messages, reply)

    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[1]).toBe(reply)
  })

  it('clears a whole run of queued messages, not just the last one', () => {
    const messages = [user(), user(true), user(true), user(true)]

    insertCompletedAssistantMessage(messages, assistant())

    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'user', 'user'])
  })

  it('leaves a queued message from an EARLIER exchange where it is', () => {
    // Only the TRAILING run may move. A queued message that has already been
    // answered belongs to its own place in history; hoisting the new reply above
    // it would rewrite an exchange that already read correctly.
    const messages = [user(), user(true), assistant(), user()]

    insertCompletedAssistantMessage(messages, assistant())

    expect(messages.map(m => m.role)).toEqual(['user', 'user', 'assistant', 'user', 'assistant'])
  })

  it('does not hoist above a queued message that is not the user’s', () => {
    // Defensive: only a queued USER message is something the person typed ahead.
    const messages = [user(), { role: 'assistant', isQueued: true }]

    expect(assistantInsertIndex(messages)).toBe(2)
  })

  it('treats an unqueued trailing user message as a normal boundary', () => {
    // `isQueued` absent or false means the message was delivered into the turn,
    // not held back, so the reply belongs after it.
    expect(assistantInsertIndex([user(), user(false)])).toBe(2)
    expect(assistantInsertIndex([user(), user()])).toBe(2)
  })
})

/**
 * P4.4 · a message flagged `isThinking` becomes a `thinking` activity, and a
 * `thinking` activity is never promoted into the response bubble.
 *
 * The second half is the one with teeth. Before P4.4 Pi's reasoning arrived as
 * plain `isIntermediate` text, so a turn that ended on a reasoning block with
 * no final answer promoted the REASONING into the response bubble — the bubble
 * that gets copied, branched from and read as the answer.
 */
import { describe, it, expect } from 'bun:test'
import type { Message } from '@nessy-agent/core'
import { groupMessagesByTurn, formatActivityAsMarkdown, formatTurnAsMarkdown } from '../turn-utils'
import type { AssistantTurn } from '../turn-utils'

let seq = 0

function assistantText(overrides: Partial<Message> = {}): Message {
  seq += 1
  return {
    id: `msg-${seq}`,
    role: 'assistant',
    content: 'body',
    timestamp: 1_000 + seq,
    turnId: 'turn-1',
    ...overrides,
  } as Message
}

/**
 * A standalone `warning` row, which is how a turn gets flushed COMPLETE without
 * a final assistant message — the state in which `groupMessagesByTurn` promotes
 * the last intermediate text into the response bubble.
 */
function warning(): Message {
  seq += 1
  return {
    id: `warn-${seq}`,
    role: 'warning',
    content: 'turn ended',
    timestamp: 1_000 + seq,
  } as Message
}

function firstAssistantTurn(messages: Message[]): AssistantTurn {
  const turn = groupMessagesByTurn(messages).find(t => t.type === 'assistant')
  if (!turn) throw new Error('no assistant turn produced')
  return turn as AssistantTurn
}

describe('thinking activities (P4.4)', () => {
  it('maps a completed isThinking message to a thinking activity', () => {
    const turn = firstAssistantTurn([
      assistantText({ content: 'reasoning here', isIntermediate: true, isThinking: true }),
      assistantText({ content: 'final answer', isIntermediate: false }),
    ])

    const reasoning = turn.activities.filter(a => a.type === 'thinking')
    expect(reasoning).toHaveLength(1)
    expect(reasoning[0]!.content).toBe('reasoning here')
  })

  it('leaves plain commentary as intermediate (negative control)', () => {
    const turn = firstAssistantTurn([
      assistantText({ content: 'just commentary', isIntermediate: true }),
      assistantText({ content: 'final answer', isIntermediate: false }),
    ])

    expect(turn.activities.filter(a => a.type === 'thinking')).toHaveLength(0)
    expect(turn.activities.filter(a => a.type === 'intermediate')).toHaveLength(1)
  })

  it('keeps a still-pending reasoning message as intermediate until it completes', () => {
    // `isThinking` only becomes authoritative at text_complete, exactly as
    // `isIntermediate` does — promoting it early would flicker the icon on
    // every streamed block.
    const turn = firstAssistantTurn([
      assistantText({ content: '', isPending: true, isThinking: true }),
    ])

    expect(turn.activities.map(a => a.type)).toEqual(['intermediate'])
  })

  it('never promotes reasoning into the response bubble', () => {
    const turn = firstAssistantTurn([
      assistantText({ content: 'secret reasoning', isIntermediate: true, isThinking: true }),
      // Closes the turn without an answer, which is what arms the promotion.
      warning(),
    ])

    expect(turn.activities.some(a => a.type === 'thinking')).toBe(true)
    expect(turn.response).toBeUndefined()
  })

  it('still promotes ordinary commentary into the response bubble (positive control)', () => {
    // Same shape as the assertion above, differing ONLY in the flag. Without
    // this control that assertion could be passing because the promotion path
    // never fires in this fixture at all.
    const turn = firstAssistantTurn([
      assistantText({ content: 'ordinary last words', isIntermediate: true }),
      warning(),
    ])

    expect(turn.response?.text).toBe('ordinary last words')
  })

  it('exports reasoning as its own markdown section rather than an empty tool', () => {
    const turn = firstAssistantTurn([
      assistantText({ content: 'why I did that', isIntermediate: true, isThinking: true }),
      assistantText({ content: 'final answer', isIntermediate: false }),
    ])
    const activity = turn.activities.find(a => a.type === 'thinking')!

    const single = formatActivityAsMarkdown(activity)
    expect(single).toContain('# Reasoning')
    expect(single).toContain('why I did that')
    // The bug this replaces: with no `toolName`, a thinking activity fell to the
    // tool branch and rendered a header with an empty body.
    expect(single).not.toContain('Tool')

    const whole = formatTurnAsMarkdown(turn)
    expect(whole).toContain('why I did that')
  })
})

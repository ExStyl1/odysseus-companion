/**
 * P6.48 · the assistant's streaming reply must reach a screen reader — once.
 *
 * Before this row the renderer had exactly one `aria-live` region repo-wide
 * (`packages/ui/src/components/chat/UserMessageBubble.tsx`, on the user's OWN
 * message), so the assistant's reply — the thing the user is actually waiting
 * for — was announced to nobody.
 *
 * The contract these tests encode is Claude's own, for the matching surface
 * (a graphical chat panel, not the terminal), `vs-code.md#use-a-screen-reader`:
 *
 *   "**Claude's replies**: the extension announces each reply once, when it's
 *   complete, and stays silent while text streams in."
 *
 *   "When you reopen a session or switch to another one, the extension
 *   announces nothing: restored history, pending permission prompts, and
 *   in-progress status stay silent until something new happens."
 *
 * Both halves are load-bearing. A region that fires per delta is worse than no
 * region at all — it interrupts itself and never finishes a sentence — and a
 * region that fires on session switch turns every navigation into a recital of
 * history the user did not ask for.
 */
import { describe, expect, it } from 'bun:test'
import {
  REPLY_ANNOUNCEMENT_MAX_CHARS,
  buildReplyAnnouncement,
  collapseCodeBlocks,
  initialReplyAnnouncerState,
  selectAnnouncableReply,
  stepReplyAnnouncer,
  type ReplyAnnouncerInput,
  type ReplyAnnouncerState,
} from '../reply-announcement'

/** Drive the announcer over a sequence of observations, collecting the edges. */
function drive(inputs: ReplyAnnouncerInput[]): boolean[] {
  let state: ReplyAnnouncerState = initialReplyAnnouncerState
  const spoken: boolean[] = []
  for (const input of inputs) {
    const step = stepReplyAnnouncer(state, input)
    state = step.state
    spoken.push(step.announce)
  }
  return spoken
}

const labels = {
  codeBlock: (lines: number) => `code block, ${lines} lines`,
  truncated: '[truncated]',
}

/** Stand-in for the renderer's remark-based stripper: enough to prove wiring. */
const stripInline = (text: string) =>
  text
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

describe('stepReplyAnnouncer — announces each reply once, when it is complete', () => {
  it('speaks on the falling edge of isProcessing, and only there', () => {
    // mount → turn starts → three streaming renders → turn ends → idle renders
    const spoken = drive([
      { sessionId: 's1', isProcessing: false },
      { sessionId: 's1', isProcessing: true },
      { sessionId: 's1', isProcessing: true },
      { sessionId: 's1', isProcessing: true },
      { sessionId: 's1', isProcessing: false },
      { sessionId: 's1', isProcessing: false },
    ])

    expect(spoken).toEqual([false, false, false, false, true, false])
    // Exactly one utterance for one turn — the whole point of the row.
    expect(spoken.filter(Boolean)).toHaveLength(1)
  })

  it('stays silent for every render while text streams in', () => {
    // A hundred deltas is a short reply. None of them may speak.
    const streaming: ReplyAnnouncerInput[] = [{ sessionId: 's1', isProcessing: false }]
    for (let i = 0; i < 100; i++) streaming.push({ sessionId: 's1', isProcessing: true })

    expect(drive(streaming).filter(Boolean)).toHaveLength(0)
  })

  it('announces a second turn too — the edge is not consumed once and disarmed', () => {
    const spoken = drive([
      { sessionId: 's1', isProcessing: true },
      { sessionId: 's1', isProcessing: false },
      { sessionId: 's1', isProcessing: true },
      { sessionId: 's1', isProcessing: false },
    ])

    expect(spoken).toEqual([false, true, false, true])
  })

  it('says nothing on the first observation, however the session is found', () => {
    // Mounting onto a session that already finished a turn (a reload, or a
    // resumed window) must not recite it.
    expect(drive([{ sessionId: 's1', isProcessing: false }])).toEqual([false])
  })

  it('says nothing when switching to a session whose turn already ended', () => {
    // s1 is streaming; the user switches to s2, which is idle with history.
    // The falling edge is an artefact of the switch, not of new activity.
    const spoken = drive([
      { sessionId: 's1', isProcessing: false },
      { sessionId: 's1', isProcessing: true },
      { sessionId: 's2', isProcessing: false },
    ])

    expect(spoken).toEqual([false, false, false])
  })

  it('says nothing when switching back to a session mid-turn', () => {
    const spoken = drive([
      { sessionId: 's1', isProcessing: true },
      { sessionId: 's2', isProcessing: false },
      { sessionId: 's1', isProcessing: true },
    ])

    expect(spoken).toEqual([false, false, false])
  })

  it('re-baselines on switch, so the NEXT turn on the new session does speak', () => {
    const spoken = drive([
      { sessionId: 's1', isProcessing: false },
      { sessionId: 's2', isProcessing: false },
      { sessionId: 's2', isProcessing: true },
      { sessionId: 's2', isProcessing: false },
    ])

    expect(spoken).toEqual([false, false, false, true])
  })

  it('handles no active session without speaking', () => {
    expect(drive([
      { sessionId: null, isProcessing: false },
      { sessionId: null, isProcessing: false },
    ])).toEqual([false, false])
  })
})

describe('selectAnnouncableReply', () => {
  it('picks the last final assistant message', () => {
    const reply = selectAnnouncableReply([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'more' },
      { role: 'assistant', content: 'second' },
    ])
    expect(reply?.content).toBe('second')
  })

  it('skips intermediate messages, which are not the reply', () => {
    const reply = selectAnnouncableReply([
      { role: 'assistant', content: 'the answer' },
      { role: 'assistant', content: 'thinking out loud', isIntermediate: true },
    ])
    expect(reply?.content).toBe('the answer')
  })

  it('announces an error rather than a stale earlier reply', () => {
    // Mirrors the OS-notification selector: after a failed retry the last
    // assistant message is a STALE success, and speaking it would report an
    // answer that never arrived.
    const reply = selectAnnouncableReply([
      { role: 'assistant', content: 'an earlier, successful answer' },
      { role: 'user', content: 'try again' },
      { role: 'error', content: 'request failed' },
    ])
    expect(reply?.role).toBe('error')
  })

  it('announces a plan', () => {
    expect(selectAnnouncableReply([{ role: 'plan', content: 'the plan' }])?.content).toBe('the plan')
  })

  it('returns null for a turn with nothing sayable', () => {
    expect(selectAnnouncableReply([{ role: 'user', content: 'hi' }, { role: 'tool', content: 'ran' }])).toBeNull()
    expect(selectAnnouncableReply([])).toBeNull()
    expect(selectAnnouncableReply(undefined)).toBeNull()
  })
})

describe('collapseCodeBlocks — a code block reads as a line count, not as characters', () => {
  it('replaces a fenced block with its line count', () => {
    const out = collapseCodeBlocks('before\n```ts\nconst a = 1\nconst b = 2\n```\nafter', labels.codeBlock)
    expect(out).toBe('before\ncode block, 2 lines\nafter')
  })

  it('summarizes an unterminated fence, which is what an interrupted turn leaves', () => {
    const out = collapseCodeBlocks('text\n```\nline one\nline two', labels.codeBlock)
    expect(out).toBe('text\ncode block, 2 lines')
  })

  it('collapses several blocks independently', () => {
    const out = collapseCodeBlocks('```\na\n```\nmid\n```\nb\nc\nd\n```', labels.codeBlock)
    expect(out).toBe('code block, 1 lines\nmid\ncode block, 3 lines')
  })

  it('leaves prose with no fences untouched', () => {
    expect(collapseCodeBlocks('just prose', labels.codeBlock)).toBe('just prose')
  })
})

describe('buildReplyAnnouncement', () => {
  it('collapses code and strips markdown into one spoken string', () => {
    const spoken = buildReplyAnnouncement(
      'Here is **the fix**:\n\n```ts\nconst a = 1\n```\n\nRun it.',
      labels,
      stripInline,
    )
    expect(spoken).toBe('Here is the fix: code block, 1 lines Run it.')
  })

  it('truncates a long reply and says so, rather than reciting it whole', () => {
    const spoken = buildReplyAnnouncement('x'.repeat(REPLY_ANNOUNCEMENT_MAX_CHARS + 500), labels, stripInline)
    expect(spoken.endsWith('[truncated]')).toBe(true)
    expect(spoken.length).toBeLessThan(REPLY_ANNOUNCEMENT_MAX_CHARS + labels.truncated.length + 4)
  })

  it('does not truncate a reply that just fits', () => {
    const spoken = buildReplyAnnouncement('y'.repeat(REPLY_ANNOUNCEMENT_MAX_CHARS), labels, stripInline)
    expect(spoken).toBe('y'.repeat(REPLY_ANNOUNCEMENT_MAX_CHARS))
    expect(spoken).not.toContain('[truncated]')
  })

  it('returns empty for content with nothing to say, so the caller can fall back', () => {
    expect(buildReplyAnnouncement(undefined, labels, stripInline)).toBe('')
    expect(buildReplyAnnouncement('', labels, stripInline)).toBe('')
    expect(buildReplyAnnouncement('   \n  ', labels, stripInline)).toBe('')
  })
})

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { appendRestoredInput, coerceInputText, isEmptyStateFiller, restoredPromptAfterStop, userMessageToRetry } from '../input-text'
import type { StoppedTurnMessage } from '../input-text'
import * as inputText from '../input-text'

describe('coerceInputText', () => {
  it('preserves plain strings', () => {
    expect(coerceInputText('hello')).toBe('hello')
  })

  it('treats nullish values as empty text', () => {
    expect(coerceInputText(undefined)).toBe('')
    expect(coerceInputText(null)).toBe('')
  })

  it('extracts text from draft-like objects', () => {
    expect(coerceInputText({ text: 'draft text', attachments: [] })).toBe('draft text')
  })

  it('drops malformed object values instead of returning [object Object]', () => {
    expect(coerceInputText({ text: { nested: true } })).toBe('')
    expect(coerceInputText({ value: 'not a supported shape' })).toBe('')
  })

  it('stringifies primitive scalar values', () => {
    expect(coerceInputText(42)).toBe('42')
    expect(coerceInputText(false)).toBe('false')
  })
})

describe('appendRestoredInput', () => {
  it('returns the restored text when there is no existing draft', () => {
    expect(appendRestoredInput('', 'hello')).toBe('hello')
    expect(appendRestoredInput(undefined, 'hello')).toBe('hello')
  })

  it('appends restored text below an existing draft with a blank line', () => {
    expect(appendRestoredInput('draft', 'restored')).toBe('draft\n\nrestored')
  })

  it('returns the existing draft unchanged when there is nothing to restore', () => {
    expect(appendRestoredInput('draft', '')).toBe('draft')
    expect(appendRestoredInput('draft', undefined)).toBe('draft')
  })

  it('returns empty string when both sides are empty', () => {
    expect(appendRestoredInput('', '')).toBe('')
    expect(appendRestoredInput(undefined, undefined)).toBe('')
  })

  it('coerces malformed (non-string) persisted draft values defensively', () => {
    expect(appendRestoredInput({ text: 'draft' } as unknown as string, 'msg')).toBe('draft\n\nmsg')
  })
})

/**
 * C3.363 — the empty-state filler is the exact inverse of one write, so the two
 * halves are pinned together: if `rich-text-input.tsx` ever stops writing
 * `'<br>'` for an empty value, or stops asking this predicate first, one of
 * these cases fails rather than the round trip silently regrowing its newline.
 */
describe('isEmptyStateFiller', () => {
  it('a lone BR is the filler this component writes for an empty value', () => {
    expect(isEmptyStateFiller({ childNodes: [{ nodeName: 'BR' }] })).toBe(true)
  })

  it("negative — two BRs are a user's own blank line and keep their newlines", () => {
    expect(isEmptyStateFiller({ childNodes: [{ nodeName: 'BR' }, { nodeName: 'BR' }] })).toBe(false)
  })

  it('negative — a BR after text is a real line break', () => {
    expect(isEmptyStateFiller({ childNodes: [{ nodeName: '#text' }, { nodeName: 'BR' }] })).toBe(false)
  })

  it('negative — a lone text node is content, not filler', () => {
    expect(isEmptyStateFiller({ childNodes: [{ nodeName: '#text' }] })).toBe(false)
  })

  it('negative — an element with no children at all is not the filler shape', () => {
    // Nothing was written yet; the reader returns '' for it anyway, so claiming
    // the filler here would make the predicate say more than it can prove.
    expect(isEmptyStateFiller({ childNodes: [] })).toBe(false)
  })
})

describe('the composer reader and the composer writer stay inverses', () => {
  const RICH_TEXT_INPUT = readFileSync(
    join(import.meta.dir, '..', '..', 'components', 'ui', 'rich-text-input.tsx'),
    'utf8',
  )

  it('the writer still stores an empty value as a lone BR', () => {
    const writes = RICH_TEXT_INPUT.split("innerHTML = html || '<br>'").length - 1
    expect(writes).toBe(3)
  })

  it('the reader asks the predicate before it maps any BR to a newline', () => {
    expect(RICH_TEXT_INPUT).toContain('if (isEmptyStateFiller(element)) return \'\'')
    expect(RICH_TEXT_INPUT.indexOf('if (isEmptyStateFiller(element))'))
      .toBeLessThan(RICH_TEXT_INPUT.indexOf("if (el.tagName === 'BR') {"))
  })
})


describe('restoredPromptAfterStop — F1.89 / D1.393', () => {
  const prompt = 'Using your shell tool, run these one at a time and report each result.'
  const running: StoppedTurnMessage[] = [
    { role: 'user', content: prompt },
    { role: 'assistant', content: 'on it' },
    { role: 'tool', content: 'probe-1' },
  ]
  const queued: StoppedTurnMessage[] = [...running, { role: 'user', content: 'and also check the lockfile', isQueued: true }]

  /**
   * The expression `ChatDisplay.handleStop` ran before this row, verbatim. It is
   * here so the DELTA is measured rather than asserted — and it cannot rot into
   * a tautology, because the wiring arm at the bottom fails if that expression
   * is still in the component.
   */
  const theOldRule = (messages: StoppedTurnMessage[]): string =>
    coerceInputText([...messages].reverse().find(m => m.role === 'user' && !m.isQueued)?.content)

  it('THE DEFECT — with a follow-up QUEUED, the old rule reached PAST it to the stopped prompt', () => {
    // SIT-7's arm A: this is the text that came back as a new user message
    // after `Response interrupted`, with the model saying "The user re-sent the
    // task". Nothing else in the product produces it after a Stop.
    expect(theOldRule(queued)).toBe(prompt)
    // …and what the composer is given now: nothing. The queued message is the
    // user's next intent, parked and visible; the composer belongs to it.
    expect(restoredPromptAfterStop(queued)).toBeUndefined()
  })

  it('THE CONTROL — the same Stop with NOTHING queued still restores, so tweak-and-resend is untouched', () => {
    // Arm B of the same case: the only difference between the arms is the
    // queued message, so the control has to move with it and this one does not.
    expect(theOldRule(running)).toBe(prompt)
    expect(restoredPromptAfterStop(running)).toBe(prompt)
  })

  it('CONTROL — with nothing queued it restores the LAST user turn, not the first', () => {
    expect(restoredPromptAfterStop([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'second' },
    ])).toBe('second')
  })

  it('CONTROL — only a QUEUED USER message declines; a queued flag elsewhere is not a follow-up', () => {
    // The flag belongs to the user's own parked message. An assistant or info
    // row carrying it (a replay artefact) must not silence the restore.
    expect(restoredPromptAfterStop([
      ...running,
      { role: 'assistant', content: 'partial', isQueued: true },
    ])).toBe(prompt)
    // …and `isQueued: false` is not "queued".
    expect(restoredPromptAfterStop([
      ...running,
      { role: 'user', content: 'already replayed', isQueued: false },
    ])).toBe('already replayed')
  })

  it('CONTROL (boundary) — nothing to restore answers undefined rather than an empty draft', () => {
    expect(restoredPromptAfterStop([])).toBeUndefined()
    expect(restoredPromptAfterStop(undefined)).toBeUndefined()
    expect(restoredPromptAfterStop([{ role: 'assistant', content: 'hi' }])).toBeUndefined()
    expect(restoredPromptAfterStop([{ role: 'user', content: '' }])).toBeUndefined()
  })

  // F1.732 — SIT-f C4: prompt, a steer, Stop. The host re-queues an undelivered steer into the
  // paused queue, so restoring it as well left two copies (Enter after Resume sent it twice).
  it('F1.732 — a STEER as the last user message is the host\'s: the restore declines it', () => {
    expect(restoredPromptAfterStop([...running, { role: 'user', content: 'Set it in winter.', steered: true }])).toBeUndefined()
  })

  it('F1.732 CONTROL — a steer earlier in the transcript does not silence the restore of a later prompt', () => {
    expect(restoredPromptAfterStop([
      { role: 'user', content: 'old steer', steered: true },
      { role: 'assistant', content: 'done' },
      ...running,
    ])).toBe(prompt)
  })

  it('CONTROL — a non-string content is coerced, which is why this lives in this module', () => {
    expect(restoredPromptAfterStop([{ role: 'user', content: { text: 'object draft' } }])).toBe('object draft')
  })

  it('THE WIRING — `handleStop` asks this module and no longer carries the rule itself', () => {
    const chatDisplay = readFileSync(
      join(import.meta.dir, '..', '..', 'components', 'app-shell', 'ChatDisplay.tsx'),
      'utf8',
    )
    const start = chatDisplay.indexOf('const handleStop = (silent = false) => {')
    expect(start).toBeGreaterThan(0)
    const region = chatDisplay.slice(start, chatDisplay.indexOf('\n  }', start))
    // POSITIVE CONTROLS on the slice: it is the right function, and it did not
    // run away past its own brace into the rest of a 3 892-line component.
    expect(region).toContain('window.electronAPI.cancelProcessing(session.id, silent)')
    expect(region.length).toBeLessThan(1_400)
    // The rule now lives here, and the component asks for it — through
    // `composerTextAfterStop` since F1.181, which carries the gate as well.
    expect(region).toContain('composerTextAfterStop({')
    // Reported as a needle rather than by printing the region.
    const staleRule = "m.role === 'user' && !m.isQueued"
    expect({ staleRule, stillInHandleStop: region.includes(staleRule) })
      .toEqual({ staleRule, stillInHandleStop: false })
  })
})

/**
 * F1.181 (origin WJ-g P-WJ-g-3) — `handleStop`'s restore seam, pinned BELOW the
 * source level.
 *
 * F1.89 put the queued-follow-up rule in `restoredPromptAfterStop` and tested
 * it, but the SEAM — the gate (`!silent && isProcessing`), the rule, and the join
 * with a half-typed draft — still lived inline in `ChatDisplay.handleStop`, where
 * the only instrument that reaches it is a rendered `ChatDisplay` (~136 s under
 * bun, the `pdfjs`/`DOMMatrix` trap) or a source slice. So the whole decision
 * moves here as `composerTextAfterStop`, and `handleStop` keeps one call: what
 * the composer holds after a Stop is now a function of four values, driven
 * directly. The sitting's arm pair (F1.89's live case) stays the live half.
 */
describe('composerTextAfterStop — F1.181, the whole restore decision', () => {
  const composerTextAfterStop = (inputText as Record<string, unknown>).composerTextAfterStop as (input: {
    silent: boolean
    isProcessing: boolean | undefined
    messages: readonly StoppedTurnMessage[] | undefined
    inputValue: string | undefined
  }) => string | undefined

  const prompt = 'Using your shell tool, run these one at a time and report each result.'
  const running: StoppedTurnMessage[] = [
    { role: 'user', content: prompt },
    { role: 'assistant', content: 'on it' },
  ]
  const queued: StoppedTurnMessage[] = [...running, { role: 'user', content: 'and also check the lockfile', isQueued: true }]

  it('ARM A — Stop with a follow-up QUEUED leaves the composer as it was (nothing restored)', () => {
    expect(composerTextAfterStop({ silent: false, isProcessing: true, messages: queued, inputValue: '' })).toBeUndefined()
  })

  it('ARM B — the same Stop with NOTHING queued refills the composer with the stopped prompt', () => {
    expect(composerTextAfterStop({ silent: false, isProcessing: true, messages: running, inputValue: '' })).toBe(prompt)
  })

  it('CONTROL — a half-typed draft is kept, with the prompt below it after a blank line', () => {
    expect(composerTextAfterStop({ silent: false, isProcessing: true, messages: running, inputValue: 'draft' }))
      .toBe(`draft\n\n${prompt}`)
  })

  it('CONTROL — a SILENT stop (a redirect: a new message is being sent) restores nothing', () => {
    expect(composerTextAfterStop({ silent: true, isProcessing: true, messages: running, inputValue: '' })).toBeUndefined()
  })

  it('CONTROL — no turn in flight, nothing to put back', () => {
    expect(composerTextAfterStop({ silent: false, isProcessing: false, messages: running, inputValue: '' })).toBeUndefined()
    expect(composerTextAfterStop({ silent: false, isProcessing: undefined, messages: running, inputValue: '' })).toBeUndefined()
  })

  it('THE WIRING — `handleStop` hands the result to the composer BEFORE it asks the host to cancel', () => {
    const chatDisplay = readFileSync(
      join(import.meta.dir, '..', '..', 'components', 'app-shell', 'ChatDisplay.tsx'),
      'utf8',
    )
    const start = chatDisplay.indexOf('const handleStop = (silent = false) => {')
    expect(start).toBeGreaterThan(0)
    const region = chatDisplay.slice(start, chatDisplay.indexOf('\n  }', start))
    expect(region.length).toBeLessThan(1_400)
    const decide = region.indexOf('composerTextAfterStop({')
    const apply = region.indexOf('onInputChange?.(restoredInput)')
    const cancel = region.indexOf('window.electronAPI.cancelProcessing(session.id, silent)')
    expect(decide).toBeGreaterThan(-1)
    expect(apply).toBeGreaterThan(decide)
    expect(cancel).toBeGreaterThan(apply)
    // No second copy of the gate or the join left beside the call.
    for (const stale of ['restoredPromptAfterStop(', 'appendRestoredInput(']) {
      expect({ stale, inHandleStop: region.includes(stale) }).toEqual({ stale, inHandleStop: false })
    }
  })
})

/**
 * UB12.45 — the two renderer readers of "the last user row" step over a HIDDEN
 * row (UB2.14). Today's one producer is the source-activation auto-retry, sent
 * hidden as `<original>\n\n[<slug> activated]`: the Stop restore put that
 * suffix in the composer, and the error row's Retry resent it as a VISIBLE
 * message. Both now land on the visible prompt the hidden row restates.
 */
describe('UB12.45 — the Stop restore and the error Retry skip hidden user rows', () => {
  const original = 'Find the open issues assigned to me.'
  const retryText = `${original}\n\n[linear activated]`
  const activated: StoppedTurnMessage[] = [
    { role: 'user', content: original },
    { role: 'assistant', content: 'Activating the linear source.' },
    { role: 'user', content: retryText, hidden: true },
    { role: 'assistant', content: 'Looking up your issues' },
  ]

  it('THE DEFECT — the newest user row is the hidden retry, so the old pick restored the suffix', () => {
    const oldPick = coerceInputText([...activated].reverse().find(m => m.role === 'user' && !m.isQueued)?.content)
    expect(oldPick).toBe(retryText)
  })

  it('POSITIVE — Stop during the hidden retry turn restores the visible original, without the suffix', () => {
    expect(restoredPromptAfterStop(activated)).toBe(original)
  })

  it('CONTROL — a VISIBLE last user row is still the one restored (hidden: false is not hidden)', () => {
    expect(restoredPromptAfterStop([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'second', hidden: false },
    ])).toBe('second')
  })

  it('BOUNDARY — a hidden row that is still QUEUED declines the restore (a parked send, not a second copy)', () => {
    expect(restoredPromptAfterStop([
      { role: 'user', content: original },
      { role: 'assistant', content: 'Activating the linear source.' },
      { role: 'user', content: retryText, hidden: true, isQueued: true },
    ])).toBeUndefined()
  })

  it('BOUNDARY — only hidden user rows answers undefined, never the hidden text', () => {
    expect(restoredPromptAfterStop([{ role: 'user', content: retryText, hidden: true }])).toBeUndefined()
  })

  const transcript = [
    { id: 'u1', role: 'user', content: original },
    { id: 'a1', role: 'assistant', content: 'Activating the linear source.' },
    { id: 'u2', role: 'user', content: retryText, hidden: true },
    { id: 'e1', role: 'error', content: 'The gateway answered 502.' },
  ]

  it('POSITIVE — Retry on an error after the hidden retry resends the visible original', () => {
    expect(userMessageToRetry(transcript, 'e1')?.id).toBe('u1')
  })

  it('CONTROL — a visible user row right before the error is the one resent', () => {
    expect(userMessageToRetry([
      { id: 'u1', role: 'user', content: 'first' },
      { id: 'a1', role: 'assistant', content: 'done' },
      { id: 'u2', role: 'user', content: 'second' },
      { id: 'e1', role: 'error', content: 'boom' },
      { id: 'u3', role: 'user', content: 'after the error' },
    ], 'e1')?.content).toBe('second')
  })

  it('BOUNDARY — with only a hidden user row before the error there is nothing to resend', () => {
    expect(userMessageToRetry([
      { id: 'u2', role: 'user', content: retryText, hidden: true },
      { id: 'e1', role: 'error', content: 'boom' },
    ], 'e1')).toBeUndefined()
  })

  it('THE WIRING — ChatDisplay\'s error Retry asks this module instead of its own unfiltered findLast', () => {
    const chatDisplay = readFileSync(
      join(import.meta.dir, '..', '..', 'components', 'app-shell', 'ChatDisplay.tsx'),
      'utf8',
    )
    const start = chatDisplay.indexOf("onRetry={turn.message.role === 'error' ? () => {")
    expect(start).toBeGreaterThan(0)
    const region = chatDisplay.slice(start, chatDisplay.indexOf('} : undefined}', start))
    // POSITIVE CONTROLS on the slice: the right handler, bounded to itself.
    expect(region).toContain('onSendMessage(')
    expect(region.length).toBeLessThan(600)
    expect(region).toContain('userMessageToRetry(')
    const staleRule = "findLast(m => m.role === 'user')"
    expect({ staleRule, stillInOnRetry: region.includes(staleRule) })
      .toEqual({ staleRule, stillInOnRetry: false })
  })
})

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import {
  shouldHandleScopedInputEvent,
  shouldRecallPromptOnArrowUp,
  stopTurnOnArrowUp,
  type RecallPromptArrowUpState,
} from '../input-event-guards'
import { pushComposerInputHistory, recallComposerInputHistory } from '../double-escape'
import { composerTextAfterStop, type StoppedTurnMessage } from '@/lib/input-text'

describe('shouldHandleScopedInputEvent', () => {
  it('handles targeted event only for matching session', () => {
    expect(shouldHandleScopedInputEvent({
      sessionId: 'session-a',
      isFocusedPanel: false,
      targetSessionId: 'session-a',
    })).toBe(true)

    expect(shouldHandleScopedInputEvent({
      sessionId: 'session-a',
      isFocusedPanel: true,
      targetSessionId: 'session-b',
    })).toBe(false)
  })

  it('handles untargeted events only for focused panel', () => {
    expect(shouldHandleScopedInputEvent({
      sessionId: 'session-a',
      isFocusedPanel: true,
    })).toBe(true)

    expect(shouldHandleScopedInputEvent({
      sessionId: 'session-a',
      isFocusedPanel: false,
    })).toBe(false)
  })
})

// ── UA1.13 — Up-arrow in an empty composer during a turn stops it and restores the prompt ──
//
// Upstream cases copied from v0.13.4:apps/electron/src/renderer/components/app-shell/input/__tests__/input-event-guards.test.ts
// (Apache-2.0), plus `stopAvailable` (Nessy: the Stop button's own gate) and the
// owner's condition of 2026-09-23 (OQ-20 item 1): a draft cleared by double-Esc
// that is waiting for `Up` keeps today's behaviour — it is restored and the turn
// is NOT stopped.

const EMPTY_RECALL_STATE: RecallPromptArrowUpState = {
  key: 'ArrowUp',
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  isComposing: false,
  isProcessing: true,
  input: '',
  attachmentCount: 0,
  loadingAttachmentCount: 0,
  followUpItemCount: 0,
  inlineMenuOpen: false,
  disabled: false,
  disableSend: false,
  stopAvailable: true,
}

function canRecall(overrides: Partial<RecallPromptArrowUpState> = {}): boolean {
  return shouldRecallPromptOnArrowUp({ ...EMPTY_RECALL_STATE, ...overrides })
}

describe('shouldRecallPromptOnArrowUp', () => {
  it('allows plain Arrow Up only for a truly empty draft during processing', () => {
    expect(canRecall()).toBe(true)
    expect(canRecall({ isProcessing: false })).toBe(false)
    expect(canRecall({ key: 'ArrowDown' })).toBe(false)
  })

  it('preserves text and whitespace-only editing', () => {
    expect(canRecall({ input: 'draft' })).toBe(false)
    expect(canRecall({ input: '   ' })).toBe(false)
    expect(canRecall({ input: '\n' })).toBe(false)
  })

  it('preserves non-text draft content and loading attachments', () => {
    expect(canRecall({ attachmentCount: 1 })).toBe(false)
    expect(canRecall({ loadingAttachmentCount: 1 })).toBe(false)
    expect(canRecall({ followUpItemCount: 1 })).toBe(false)
  })

  it('does not steal keys from menus, IME, modifiers, or disabled input', () => {
    expect(canRecall({ inlineMenuOpen: true })).toBe(false)
    expect(canRecall({ isComposing: true })).toBe(false)
    expect(canRecall({ shiftKey: true })).toBe(false)
    expect(canRecall({ metaKey: true })).toBe(false)
    expect(canRecall({ ctrlKey: true })).toBe(false)
    expect(canRecall({ altKey: true })).toBe(false)
    expect(canRecall({ disabled: true })).toBe(false)
    expect(canRecall({ disableSend: true })).toBe(false)
  })

  it('NESSY — never fires where the Stop button would not (a Stop already in flight, a renderer-minted chat)', () => {
    expect(canRecall({ stopAvailable: false })).toBe(false)
  })
})

/**
 * The composer's ArrowUp branch as `FreeFormInput.handleKeyDown` holds it: P2.447's
 * recall first, then the UA1.13 stop — each decision delegated to its module — and
 * the stop's effect as `ChatDisplay.handleStop` computes it (`composerTextAfterStop`,
 * F1.181). The source-read arm below pins that the component delegates the same way.
 */
function makeComposer(opts: { draft?: string; clearedDraft?: string; state?: Partial<RecallPromptArrowUpState> } = {}) {
  const prompt = 'Summarise the failing tests and propose a fix.'
  const messages: StoppedTurnMessage[] = [{ role: 'user', content: prompt }, { role: 'assistant', content: 'working' }]
  let draft = opts.draft ?? ''
  const history = opts.clearedDraft === undefined ? [] : pushComposerInputHistory([], opts.clearedDraft)
  const stops: boolean[] = []
  const recallClearedDraft = (): boolean => {
    const recalled = recallComposerInputHistory({ entries: history, draftText: draft })
    if (recalled === null) return false
    draft = recalled
    return true
  }
  const handleStop = (silent = false) => {
    stops.push(silent)
    const restored = composerTextAfterStop({ silent, isProcessing: opts.state?.isProcessing ?? true, messages, inputValue: draft })
    if (restored !== undefined) draft = restored
  }
  const pressUp = (): boolean =>
    recallClearedDraft() || stopTurnOnArrowUp({ ...EMPTY_RECALL_STATE, ...opts.state, input: draft }, () => handleStop(false))
  return { prompt, pressUp, get draft() { return draft }, stops }
}

describe('UA1.13 — Up in an empty composer mid-turn (the owner\'s condition)', () => {
  it('POSITIVE — processing + empty + no waiting draft: Stop runs ONCE and the stopped prompt is back in the input', () => {
    const composer = makeComposer()
    expect(composer.pressUp()).toBe(true)
    expect(composer.stops).toEqual([false])
    expect(composer.draft).toBe(composer.prompt)
    // The input is no longer empty, so the next Up is caret movement, not a second stop.
    expect(composer.pressUp()).toBe(false)
    expect(composer.stops).toHaveLength(1)
  })

  it('NEGATIVE — a draft cleared by double-Esc is waiting: Up restores the draft and does NOT stop', () => {
    const composer = makeComposer({ clearedDraft: 'half-typed follow-up' })
    expect(composer.pressUp()).toBe(true)
    expect(composer.draft).toBe('half-typed follow-up')
    expect(composer.stops).toEqual([])
  })

  it('NEGATIVE — not processing: nothing happens', () => {
    const composer = makeComposer({ state: { isProcessing: false } })
    expect(composer.pressUp()).toBe(false)
    expect(composer.stops).toEqual([])
    expect(composer.draft).toBe('')
  })

  it('NEGATIVE — a non-empty input, an open inline menu or an IME composition keeps normal caret movement', () => {
    for (const composer of [
      makeComposer({ draft: 'typing' }),
      makeComposer({ state: { inlineMenuOpen: true } }),
      makeComposer({ state: { isComposing: true } }),
    ]) {
      const before = composer.draft
      expect(composer.pressUp()).toBe(false)
      expect(composer.stops).toEqual([])
      expect(composer.draft).toBe(before)
    }
  })
})

describe('UA1.13 — the composer really ships this branch', () => {
  const source = readFileSync(fileURLToPath(new URL('../FreeFormInput.tsx', import.meta.url)), 'utf8')
  const present = (needle: string) => ({ needle, inSource: source.includes(needle) })
  const found = (needle: string) => ({ needle, inSource: true })

  it('runs the recall FIRST and the Stop button\'s own path second, gated as the button is', () => {
    for (const needle of [
      'if (recallClearedDraft() || stopTurnOnArrowUp({',
      '}, () => handleStop(false))) {',
      'stopAvailable: submitControl.mode === \'stop\' && !submitControl.inert',
      'input: inputRef.current,',
      'inlineMenuOpen: inlineMention.isOpen || inlineSlash.isOpen || inlineLabel.isOpen',
      // The Stop button — the path the key reuses (UB14.28: `SendButton` takes it
      // as `onStop`, gated on the same `inert`; its press rule is pinned in
      // `submit-control.test.ts` and pressed in `send-button.test.tsx`).
      'onStop={() => handleStop(false)}',
      'inert={submitControl.inert}',
    ]) {
      expect(present(needle)).toEqual(found(needle))
    }
  })
})

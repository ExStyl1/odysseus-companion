/**
 * P2.37 · a cap verdict must reach the user.
 *
 * `terminalReason` rode the `complete` event from the moment the cap work
 * landed and had ZERO consumers in `apps/`, `packages/ui` or `apps/webui` —
 * and the five `chat.terminalReason.*` keys (incl. "Stopped: reached the
 * spending limit") had zero callsites. A session that stopped because it hit
 * the spending limit was, to the user, a session that just stopped.
 *
 * What this pins:
 * - each of the five reasons that HAS copy produces exactly one transcript
 *   row, carrying the marker the renderer translates;
 * - the marker resolves to a key that exists in BOTH shipped locales — the
 *   half that makes the row a sentence rather than an enum value;
 * - `terminalIsError` picks the tone and nothing else;
 * - a turn that ends with no reason, or with one of the endings that owns a
 *   louder surface of its own, adds nothing (the control).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TERMINAL_REASON_NOTICE_VALUES, type AgentTerminalReason } from '@nessy-agent/core/types'
import { processEvent } from '../../processor'
import type { AgentEvent, CompleteEvent, SessionState } from '../../types'
import {
  TERMINAL_REASON_MARKER,
  parseTerminalReasonMarker,
  terminalReasonNoticeKey,
} from '../../../lib/terminal-reason-copy'

const LOCALE_DIR = join(import.meta.dir, '../../../../../../../packages/shared/src/i18n/locales')

function locale(name: 'en' | 'ru'): Record<string, string> {
  return JSON.parse(readFileSync(join(LOCALE_DIR, `${name}.json`), 'utf8')) as Record<string, string>
}

function emptyState(): SessionState {
  return { session: { id: 's1', messages: [], isProcessing: true } as never, streaming: null }
}

function drive(events: AgentEvent[]): SessionState {
  let state = emptyState()
  for (const event of events) state = processEvent(state, event).state
  return state
}

/** A turn that said something and then ended — the shape every case below shares. */
function turnEndingWith(complete: CompleteEvent): SessionState {
  return drive([
    { type: 'text_complete', sessionId: 's1', text: 'working on it', turnId: 'X', timestamp: 1, messageId: 'm-x' },
    complete,
  ])
}

/** reason → the i18n key its row must resolve to. */
const REASONS_WITH_COPY: Array<[AgentTerminalReason, string]> = [
  ['max_agent_turns', 'chat.terminalReason.maxAgentTurns'],
  ['max_budget_usd', 'chat.terminalReason.maxBudgetUsd'],
  // P6.645 — the token twin. Its own member rather than a mode of the USD one:
  // the USD cap can be unenforceable, this one never is.
  ['max_budget_tokens', 'chat.terminalReason.maxBudgetTokens'],
  ['structured_output_retry_exhausted', 'chat.terminalReason.maxStructuredOutputRetries'],
  ['provider_error', 'chat.terminalReason.providerError'],
  ['provider_refusal', 'chat.terminalReason.providerRefusal'],
  // P2.525 — the two deferral endings. They were listed among the reasons that
  // "reach the transcript as their own error or info notices" and neither did:
  // an ordinary `tool_deferred` is a SUCCESS result with `is_error: false`, so
  // the turn simply ended with the tool unrun and nothing on any surface said
  // so, and `tool_deferred_unavailable` sets only `terminalIsError`, which this
  // fork reads for cost accounting.
  ['tool_deferred', 'chat.terminalReason.toolDeferred'],
  ['tool_deferred_unavailable', 'chat.terminalReason.toolDeferredUnavailable'],
]

describe('a terminal verdict reaches the transcript', () => {
  const en = locale('en')
  const ru = locale('ru')

  it('covers every reason the two writers agree gets a row', () => {
    // The table above is hand-written because the i18n KEYS are the renderer's
    // own fact, and a hand-written table goes stale silently — which is exactly
    // what happened: `tool_deferred` sat in the shared tuple with no row here
    // and this suite stayed green. Membership is the SHARED fact, so it is read
    // rather than restated, and a reason added there without a row here now
    // fails instead of going unasserted.
    expect(REASONS_WITH_COPY.map(([reason]) => reason).sort())
      .toEqual([...TERMINAL_REASON_NOTICE_VALUES].sort())
  })

  for (const [reason, key] of REASONS_WITH_COPY) {
    it(`renders the mapped line for ${reason}`, () => {
      const state = turnEndingWith({ type: 'complete', sessionId: 's1', terminalReason: reason })
      const rows = state.session.messages.filter(m => m.role === 'info')

      expect(rows).toHaveLength(1)
      const row = rows[0]!
      // The row stores the MARKER, not a sentence — the copy is composed at
      // render time so the line follows the UI language.
      expect(row.content).toBe(`${TERMINAL_REASON_MARKER}${reason}`)
      // The structural parse (shared with packages/ui) yields the bare reason;
      // the i18n key is the renderer's separate concern.
      expect(parseTerminalReasonMarker(row.content)).toBe(reason)
      expect(terminalReasonNoticeKey(reason)).toBe(key)
      // …and the key is a real one in both shipped locales, so what the user
      // sees is a sentence and not the key itself.
      expect(en[key]).toBeTruthy()
      expect(ru[key]).toBeTruthy()
      // The turn's own output is untouched beside it.
      expect(state.session.messages.map(m => m.role)).toEqual(['assistant', 'info'])
      expect(state.session.isProcessing).toBe(false)
    })
  }

  it('names the spending limit in the copy the budget cap resolves to', () => {
    // The row that started P2.37: the one key whose sentence a user must be
    // able to act on. Pinned by CONTENT, not only by existence.
    expect(en['chat.terminalReason.maxBudgetUsd']).toBe('Stopped: reached the spending limit')
    expect(ru['chat.terminalReason.maxBudgetUsd']).toContain('лимит расходов')
  })

  it('tone follows terminalIsError and nothing else', () => {
    const cap = turnEndingWith({ type: 'complete', sessionId: 's1', terminalReason: 'max_budget_usd' })
    const failure = turnEndingWith({
      type: 'complete', sessionId: 's1', terminalReason: 'provider_error', terminalIsError: true,
    })

    expect(cap.session.messages.at(-1)!.infoLevel).toBe('warning')
    expect(failure.session.messages.at(-1)!.infoLevel).toBe('error')
  })

  it('adds nothing when the turn ends with no reason', () => {
    // The control: an ordinary completion is byte-for-byte what it always was.
    const state = turnEndingWith({ type: 'complete', sessionId: 's1' })

    expect(state.session.messages.map(m => m.role)).toEqual(['assistant'])
    expect(state.session.messages.some(m => m.content.startsWith(TERMINAL_REASON_MARKER))).toBe(false)
  })

  it('adds nothing for an ending that already owns a louder surface', () => {
    // `user_stop` renders the interrupt row and `plan_submitted` the plan card;
    // a verdict line beside either is a second sentence about one event.
    for (const reason of ['user_stop', 'plan_submitted', 'auth_request'] as AgentTerminalReason[]) {
      const state = turnEndingWith({ type: 'complete', sessionId: 's1', terminalReason: reason })
      expect(terminalReasonNoticeKey(reason)).toBeUndefined()
      expect(state.session.messages.map(m => m.role)).toEqual(['assistant'])
    }
  })

  it('a marker with no copy in this build renders nothing rather than the enum value', () => {
    // The renderer's guard for a reason a newer build might store: the marker
    // parses to a reason, but `terminalReasonNoticeKey` has no copy for it, so
    // `ChatDisplay` drops the row.
    const unknown = parseTerminalReasonMarker(`${TERMINAL_REASON_MARKER}something_new`)
    expect(unknown).toBe('something_new' as AgentTerminalReason)
    expect(terminalReasonNoticeKey(unknown ?? undefined)).toBeUndefined()
    // An ordinary notice is not a marker.
    expect(parseTerminalReasonMarker('Spending limit reached.')).toBeNull()
    expect(parseTerminalReasonMarker(TERMINAL_REASON_MARKER)).toBeNull()
  })
})

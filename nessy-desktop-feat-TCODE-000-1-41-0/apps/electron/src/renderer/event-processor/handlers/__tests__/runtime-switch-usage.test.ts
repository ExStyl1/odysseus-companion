/**
 * F1.439 — the renderer never mirrored the host's cross-runtime reset.
 *
 * At a cross-runtime switch the host's `clearRuntimeScopedSessionState`
 * clears `managed.contextUsage`, `tokenUsage.contextUsage` and
 * `tokenUsage.contextWindow`, then appends the `runtime_switched:<from>:<to>`
 * marker row (`message_added`) and sends `connection_changed`. The renderer's
 * `handleConnectionChanged` updated only the slug, so the OLD runtime's snapshot
 * and window survived: F1.248's window fallback kept `tokenUsage.contextWindow`
 * through the new runtime's first window-less update, and `handleComplete`'s
 * `?? session.contextUsage` brought the old snapshot back after the host had
 * sent none. The marker row is the machine-readable moment the host reset, so
 * the renderer resets the same three fields when it lands. A connection change
 * on the SAME runtime sends no marker and keeps them.
 */

import { describe, expect, it } from 'bun:test'
import { processEvent } from '../../processor'
import type { AgentEvent, SessionState } from '../../types'

const SID = 's-f1439'
const piSnapshot = { inputTokens: 100_000, contextWindow: 262_000, source: 'sdk_usage' as const }

function start(): SessionState {
  return { session: { id: SID, messages: [], isProcessing: false }, streaming: null } as unknown as SessionState
}

const apply = (state: SessionState, event: Record<string, unknown>) =>
  processEvent(state, { sessionId: SID, ...event } as unknown as AgentEvent).state

function withPiUsage(): SessionState {
  const state = apply(start(), {
    type: 'usage_update',
    tokenUsage: { inputTokens: 100_000, contextWindow: 262_000, contextUsage: piSnapshot },
    contextUsage: piSnapshot,
  })
  // Fixture positive control: the Pi reading really is on the session before the switch.
  expect(state.session.tokenUsage?.contextWindow).toBe(262_000)
  expect(state.session.contextUsage?.inputTokens).toBe(100_000)
  return state
}

const switchMarker = (content: string) => ({
  type: 'message_added',
  message: { id: 'm-switch', role: 'info', content, timestamp: 2 },
})

describe('F1.439 — a runtime switch resets the renderer\'s runtime-scoped usage', () => {
  it('positive — after the switch marker, a window-less update and a snapshot-less complete bring nothing of Pi back', () => {
    let state = withPiUsage()
    state = apply(state, switchMarker('runtime_switched:pi:anthropic:{"carry":"text"}'))
    state = apply(state, { type: 'connection_changed', connectionSlug: 'claude-gateway' })
    state = apply(state, { type: 'usage_update', tokenUsage: { inputTokens: 5_000 } })
    expect(state.session.tokenUsage?.contextWindow).toBeUndefined()
    state = apply(state, {
      type: 'complete',
      tokenUsage: { inputTokens: 5_000, outputTokens: 10, totalTokens: 5_010, contextTokens: 0, costUsd: 0 },
    })
    expect(state.session.contextUsage).toBeUndefined()
    expect(state.session.tokenUsage?.contextUsage).toBeUndefined()
  })

  it('negative — a connection change on the SAME runtime (no marker) keeps the snapshot and the window', () => {
    let state = withPiUsage()
    state = apply(state, { type: 'connection_changed', connectionSlug: 'pi-other-connection' })
    state = apply(state, { type: 'usage_update', tokenUsage: { inputTokens: 101_000 } })
    expect(state.session.tokenUsage?.contextWindow).toBe(262_000)
    expect(state.session.contextUsage?.inputTokens).toBe(100_000)
  })

  it('an ordinary info row is not a switch', () => {
    let state = withPiUsage()
    state = apply(state, switchMarker('the runtime_switched: word mid-sentence'))
    expect(state.session.contextUsage?.inputTokens).toBe(100_000)
    expect(state.session.tokenUsage?.contextWindow).toBe(262_000)
  })
})

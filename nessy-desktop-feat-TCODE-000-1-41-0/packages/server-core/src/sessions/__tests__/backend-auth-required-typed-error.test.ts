/**
 * D1.194 (Pi half) — an expired credential reaches the user as a CARD, not as a
 * sentence, on the runtimes that go through `onBackendAuthRequired`.
 *
 * ## The divergence this closes
 *
 * One expired credential had three shapes: claude yields a `typed_error` whose
 * code the renderer's sign-in card keys on; Pi handed `onBackendAuthRequired`
 * to this manager, which sent `{ type: 'info', level: 'error' }` — a transcript
 * line with no action at all; and the corporate credential gets
 * `AuthRequestCard`'s dp variant. A button on one runtime and a sentence on the
 * others is the silent-divergence class rather than a missing feature.
 *
 * ## What is asserted, and what deliberately is not
 *
 * The CODE, because that is the whole contract: the renderer decides by the
 * code (`CREDENTIAL_ERROR_CODES` in
 * `apps/electron/src/renderer/lib/credential-sign-in.ts`), once, for every
 * runtime — capability variance as DATA rather than as a renderer branch. That
 * list is in another package and cannot be imported from here, so the literal
 * is pinned on this side and the set is pinned on the renderer's own side; the
 * two meet at the `ErrorCode` union, which `typecheck` enforces.
 *
 * The empty `actions` array is asserted too, and it is the row rather than an
 * omission: a backend-supplied action is backend-English in every locale, which
 * is half of what D1.194 removes, and the card drops the backend's `settings`
 * action while it is shown.
 */
import { describe, expect, test } from 'bun:test'
import type { AgentEvent } from '@nessy-agent/core/types'
import { SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager.ts'

function rig() {
  const manager = createTestSessionManager() as any
  const sent: AgentEvent[] = []
  manager.sendEvent = (event: AgentEvent) => { sent.push(event) }
  const managed = { id: 'session-1', workspace: { id: 'workspace-1' } }
  return {
    announce: (reason: string) =>
      SessionManager.prototype['announceBackendAuthRequired'].call(manager, managed as never, reason),
    sent,
  }
}

describe('D1.194 · a backend auth failure is a typed credential error', () => {
  test('carries a credential-shaped code and the backend reason', () => {
    const h = rig()
    h.announce('Token refresh failed: 401')
    expect(h.sent).toHaveLength(1)
    const event = h.sent[0] as Extract<AgentEvent, { type: 'typed_error' }>
    expect(event.type).toBe('typed_error')
    // The contract: the renderer's card keys on this code and on nothing else.
    expect(event.error.code).toBe('invalid_credentials')
    // The reason the backend gave survives, because "sign in again" without it
    // is the same non-answer the info line was.
    expect(event.error.message).toContain('Token refresh failed: 401')
  })

  test('sends NO backend-English action, and no second channel — the two halves of the row', () => {
    const h = rig()
    h.announce('No refresh token — please sign in again')
    const event = h.sent[0] as Extract<AgentEvent, { type: 'typed_error' }>
    // A backend action would be English in every locale, which is what the card
    // exists to replace.
    expect(event.error.actions).toEqual([])
    expect(event.error.canRetry).toBe(false)
    // And the info line is GONE rather than kept beside it: two channels for one
    // fact is what this plan keeps removing, and a lingering `info` would put an
    // unactionable duplicate under the card.
    expect(h.sent.filter(sentEvent => sentEvent.type === 'info')).toEqual([])
  })
})

/**
 * P6.334 — a `defer: true` spawn must PROPOSE, and the danger is that it starts.
 *
 * The declaration (`SpawnSessionResult.status: 'proposed'`) and the chip that
 * renders a proposal both landed with no producer between them: the host read
 * the field, ignored it, and created the session anyway. So the model reported
 * that it had proposed work while the work was already running — the exact
 * outcome the row exists to stop, and invisible from either end.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTestSessionManager } from './test-session-manager.ts'

describe('a deferred spawn proposes and starts nothing', () => {
  test('the proposal carries a minted id, a derived name and no session', async () => {
    const manager = createTestSessionManager() as any
    try {
      const managed = {
        id: 'session-p6334',
        workspace: { id: 'workspace-p6334' },
        messages: [],
        messagesLoaded: true,
        ephemeral: true,
      }
      const before = manager.sessions.size
      const result = manager.recordDeferredSpawnProposal(managed, {
        prompt: 'Port the retry helper to the new client. Then delete the old one.',
      })

      expect(result.status).toBe('proposed')
      // Derived, because `name` is optional on the schema and REQUIRED by the
      // chip: a proposal with nothing to show is not an offer. First clause of
      // the prompt, not a summary — no model call is spent on a proposal.
      expect(result.name).toBe('Port the retry helper to the new client.')
      // Minted by the host: the schema has no id and the chip keys on one.
      expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/)
      // The whole point: nothing was created.
      expect(manager.sessions.size).toBe(before)
      // And the offer is visible without waiting for the structured chip wire:
      // the notice names the same proposal id.
      const notices = managed.messages as Array<{ content: string }>
      expect(notices).toHaveLength(1)
      expect(notices[0]!.content).toContain('Nothing has started')
      expect(notices[0]!.content).toContain(result.sessionId)
    } finally {
      await manager.cleanup()
    }
  })

  test('an unnameable prompt still gets a label a person can click', async () => {
    const manager = createTestSessionManager() as any
    try {
      const managed = {
        id: 'session-p6334-empty',
        workspace: { id: 'workspace-p6334-empty' },
        messages: [],
        messagesLoaded: true,
        ephemeral: true,
      }
      expect(manager.recordDeferredSpawnProposal(managed, { prompt: '   \n  ' }).name).toBe('Proposed chat')
      // A long single clause is trimmed rather than dropped.
      const long = manager.recordDeferredSpawnProposal(managed, {
        prompt: 'x'.repeat(200),
      }).name
      expect(long.endsWith('...')).toBe(true)
      expect(long.length).toBeLessThanOrEqual(60)
    } finally {
      await manager.cleanup()
    }
  })

  test('the branch is taken BEFORE anything is created', () => {
    // Structural, and deliberately so: the failure this row closes is an
    // ORDERING one — the handler read `defer` and created the session anyway —
    // and the only way to state "nothing ran" as an assertion is to pin that the
    // deferral returns before the first `createSession` in that handler.
    const source = readFileSync(fileURLToPath(new URL('../SessionManager.ts', import.meta.url)), 'utf8')
    const handler = source.slice(source.indexOf('managed.agent.onSpawnSession = async (request) =>'))
    const deferral = handler.indexOf('request.defer === true')
    const creation = handler.indexOf('await this.createSession(')
    expect(deferral).toBeGreaterThan(-1)
    expect(creation).toBeGreaterThan(-1)
    expect(deferral).toBeLessThan(creation)
    // `=== true`, never truthiness: both halves must agree before a deferral
    // reaches the host, and the safe direction of a disagreement is to start.
    expect(handler.slice(deferral - 40, deferral)).not.toContain('if (request.defer)')
  })
})

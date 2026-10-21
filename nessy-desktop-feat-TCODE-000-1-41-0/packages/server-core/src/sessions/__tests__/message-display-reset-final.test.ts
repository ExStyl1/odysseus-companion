/**
 * F1.499 (3) — rewind, `/clear` and a runtime switch close an open
 * `MessageDisplay` cursor with the message's ONE final batch.
 *
 * hooks.md#messagedisplay-input: "`final` | `true` on the message's last batch.
 * Each message has exactly one final batch". F1.473 closed a VOIDED message's
 * cursor that way (`closeVoidedMessageDisplay`) and named the residue: the three
 * session resets still set `messageDisplayCursor = undefined`, so a message the
 * hook had seen a batch of — one a Stop left open, say — never closed for a hook
 * that tracks it by `message_id`. Each reset now calls the same helper: an
 * EMPTY final batch with the next `index`, nothing displayed from it, and
 * nothing at all for a message the hook never saw.
 *
 * WHERE the close runs is the finding the first draft of this test measured:
 * rewind and the runtime switch DRAIN first (`strictDrainSessionForMutation`
 * disposes the agent runtime, and `agentAutomationSystem` with it), so a close
 * at their transcript reset fired into no hook system at all — the rewind arm
 * below was red with the helper at the reset line. Both now close BEFORE their
 * drain, while the system that saw the batches is alive; `/clear` runs inside a
 * live turn and closes in place.
 *
 * Rig as in `message-display-voided-final.test.ts` (F1.473). Rewind is driven
 * end to end (its drain included); the switch is driven in the switch harness
 * (`runtime-switch-session.test.ts`, F1.555) and its ORDER stays pinned here.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import type { AgentEvent, AgentEventExecutionResult, SdkAutomationInput } from '@nessy-agent/shared/automations'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const WS = 'ws_f1499'
const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  rmSync(join(SESSIONS_DIR, WS), { recursive: true, force: true })
})

type Internals = {
  processEvent(managed: unknown, event: Record<string, unknown>): Promise<void>
  flushDelta(sessionId: string, workspaceId: string): Promise<void>
}

function setUp(sessionId: string) {
  const inputs: SdkAutomationInput[] = []
  const system = {
    executeAgentEvent: async (event: AgentEvent, input: SdkAutomationInput): Promise<AgentEventExecutionResult> => {
      if (event === 'MessageDisplay') inputs.push(input)
      return { matchedCount: 1 } as AgentEventExecutionResult
    },
    hasAgentEventMatchers: (event: AgentEvent) => event === 'MessageDisplay',
  }
  const manager = createTestSessionManager()
  managers.push(manager)
  manager.setEventSink(() => {})
  const managed = createManagedSession({ id: sessionId }, {
    id: WS, name: 'F1.499', rootPath: `/tmp/nessy-${sessionId}`, createdAt: 1,
  } as never, { messagesLoaded: true })
  ;(managed as unknown as { agentAutomationSystem: unknown }).agentAutomationSystem = system
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${WS}:${sessionId}`, managed)
  return { manager, managed, inputs, internals: manager as unknown as Internals }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

/** Open a message the hook has SEEN one batch of, and leave it open (a Stop mid-message). */
async function openSeenMessage(internals: Internals, managed: unknown, sessionId: string) {
  await internals.processEvent(managed, { type: 'text_delta', text: 'Half a line\n', turnId: 'turn-1__m0' })
  await internals.flushDelta(sessionId, WS)
}

function finals(inputs: SdkAutomationInput[]) {
  return inputs.filter(input => input.final === true).map(input => ({ index: input.index, delta: input.delta }))
}

describe('F1.499 (3) · a session reset closes the open message with its one final batch', () => {
  it('rewindToMessage: one empty final batch at the next index', async () => {
    const { manager, managed, inputs, internals } = setUp('f1499-rewind')
    ;(managed as unknown as { messages: unknown[] }).messages.push({ id: 'u1', role: 'user', content: 'go', timestamp: 1 })
    await openSeenMessage(internals, managed, 'f1499-rewind')
    // Fixture control: the hook saw the message's first batch, not its end.
    expect(inputs.map(input => ({ index: input.index, final: input.final }))).toEqual([{ index: 0, final: false }])

    const result = await manager.rewindToMessage('f1499-rewind', 'u1', {}, WS)
    expect(result.success).toBe(true)
    await settle()

    expect(finals(inputs)).toEqual([{ index: 1, delta: '' }])
    expect(new Set(inputs.map(input => input.message_id)).size).toBe(1)
  })

  it('BOUNDARY: a rewind over a message the hook never saw fires nothing', async () => {
    const { manager, managed, inputs, internals } = setUp('f1499-unseen')
    ;(managed as unknown as { messages: unknown[] }).messages.push({ id: 'u1', role: 'user', content: 'go', timestamp: 1 })
    // No newline and no flush: the whole-lines hold keeps it back, so the hook saw nothing.
    await internals.processEvent(managed, { type: 'text_delta', text: 'Partial', turnId: 'turn-1__m0' })
    expect((await manager.rewindToMessage('f1499-unseen', 'u1', {}, WS)).success).toBe(true)
    await settle()
    expect(inputs).toEqual([])
  })

  it('the switch closes BEFORE its drain, and every reset site goes through the helper or says why not', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'SessionManager.ts'), 'utf-8')
    const tagged = /this\.closeVoidedMessageDisplay\(managed\) \/\/ F1\.499 \(3\)/g
    expect(source.match(tagged)?.length).toBe(3) // switch (pre-drain), rewind (pre-drain), /clear (in place)
    const switchStart = source.indexOf('  async switchSessionRuntime(')
    const switchDrain = source.indexOf('await this.strictDrainSessionForMutation(managed, `runtime switch (${kind})`, true)', switchStart)
    const switchClose = source.lastIndexOf('this.closeVoidedMessageDisplay(managed) // F1.499 (3)', switchDrain)
    expect(switchStart).toBeGreaterThan(0)
    expect(switchClose).toBeGreaterThan(switchStart)
    expect(switchClose).toBeLessThan(switchDrain)
    // The two post-drain resets stay bare and say where the close happened; the other two
    // bare resets are the helpers that own the cursor (finish, close).
    expect(source.match(/managed\.messageDisplayCursor = undefined \/\/ F1\.499 \(3\): closed before the drain/g)?.length).toBe(2)
    expect(source.match(/managed\.messageDisplayCursor = undefined/g)?.length).toBe(4)
  })
})

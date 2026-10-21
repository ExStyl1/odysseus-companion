/**
 * P2.484's owed half — the session is TOLD when its codex host-callback bridge
 * did not come up.
 *
 * `CodexAgent.startCallbackBridge` fails non-fatally: the session lives its whole
 * life on the bare 18-tool surface, without `CronCreate`/`CronDelete`/`CronList`,
 * `ScheduleWakeup`, `Monitor`, `ProcessStop`, the `Goal` pair or
 * `send_agent_message`. The switch dialog can only say those MAY be missing —
 * it is drawn before the target session exists, which is why `d0d710de6` gave
 * the cost table a `'conditional'` claim and recorded the resolution as owed.
 * This is the resolution.
 *
 * Two halves, and they fail differently:
 *
 * 1. **the rule** is driven for real on a prototype-only manager, because it is
 *    a small method with one collaborator;
 * 2. **the call site** is asserted against the source, the instrument
 *    `permission-policy-notice.test.ts` established — `withCapabilityRuntime` is
 *    a turn-lifecycle method with a capability resolver and a lease behind it,
 *    and constructing one would test the fixture rather than the wiring.
 */

import { describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTestSessionManager } from './test-session-manager.ts'

const source = readFileSync(
  fileURLToPath(new URL('../SessionManager.ts', import.meta.url)),
  'utf-8',
)

type Emitted = { event: Record<string, unknown>; workspaceId: string }

/** A manager whose only live collaborator is the event sink. */
function fixture(bridgeState?: string) {
  const emitted: Emitted[] = []
  const manager = createTestSessionManager() as any
  manager.sendEvent = mock((event: Record<string, unknown>, workspaceId: string) => {
    emitted.push({ event, workspaceId })
  })
  const managed: any = {
    id: 'session-bridge',
    workspace: { id: 'workspace-bridge', name: 'Bridge', rootPath: '/tmp/bridge' },
    // `undefined` stands for a runtime with no bridge at all — Pi and claude,
    // which answer the duck-typed probe by not carrying the method.
    agent: bridgeState === undefined ? {} : { getSchedulingBridgeState: () => bridgeState },
  }
  return { manager, managed, emitted }
}

describe('P2.484 · the session is told its codex bridge did not come up', () => {
  it('says it ONCE, on the user-visible channel, at warning level', () => {
    const { manager, managed, emitted } = fixture('unavailable')
    manager.reportCodexBridgeAbsence(managed)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.workspaceId).toBe('workspace-bridge')
    expect(emitted[0]!.event).toMatchObject({
      type: 'info',
      level: 'warning',
      sessionId: 'session-bridge',
    })
    // P2.196: an uninitialised i18next returns `undefined` rather than the key,
    // and a notice that renders empty is the same silence this row exists to
    // end. Asserted as NON-EMPTY and not-the-key, which is the strongest claim
    // available without asserting a shipped English string.
    const message = emitted[0]!.event.message
    expect(typeof message).toBe('string')
    expect((message as string).length).toBeGreaterThan(0)
    expect(message).not.toBe('chat.codexBridge.unavailable')

    // Every later turn of the same failed runtime is silent — a warning
    // repeated on every send is a warning people turn off.
    manager.reportCodexBridgeAbsence(managed)
    manager.reportCodexBridgeAbsence(managed)
    expect(emitted).toHaveLength(1)
  })

  it('says nothing while the bridge is up, or before a turn has started one', () => {
    for (const state of ['active', 'not-started']) {
      const { manager, managed, emitted } = fixture(state)
      manager.reportCodexBridgeAbsence(managed)
      expect(emitted, `spoke on ${state}`).toHaveLength(0)
      expect(managed.codexBridgeAbsenceReported).toBeUndefined()
    }
  })

  it('says nothing on a runtime that has no bridge to lose', () => {
    const { manager, managed, emitted } = fixture(undefined)
    manager.reportCodexBridgeAbsence(managed)
    expect(emitted).toHaveLength(0)
  })

  /**
   * The flag is about ONE runtime, not about the session's whole life. A codex
   * session whose bridge failed, was rebuilt, came up, and then failed again on
   * a third runtime has lost the tools twice and is owed two notices.
   */
  it('speaks again after a runtime that had the bridge', () => {
    const { manager, managed, emitted } = fixture('unavailable')
    manager.reportCodexBridgeAbsence(managed)
    expect(emitted).toHaveLength(1)
    managed.agent = { getSchedulingBridgeState: () => 'active' }
    manager.reportCodexBridgeAbsence(managed)
    expect(managed.codexBridgeAbsenceReported).toBeUndefined()
    managed.agent = { getSchedulingBridgeState: () => 'unavailable' }
    manager.reportCodexBridgeAbsence(managed)
    expect(emitted).toHaveLength(2)
  })

  it('a throwing probe is not evidence of absence', () => {
    const { manager, managed, emitted } = fixture('unavailable')
    managed.agent = { getSchedulingBridgeState: () => { throw new Error('agent disposed') } }
    manager.reportCodexBridgeAbsence(managed)
    expect(emitted).toHaveLength(0)
  })
})

describe('P2.484 · where the report is read', () => {
  /**
   * The bridge does not exist at the switch — the runtime is built lazily and
   * the bridge is started inside the chat generator's `ensureRuntime()` — so the
   * report has to sit at the first place the host can know, which is the turn's
   * own teardown. A call site anywhere earlier would read `undefined` for ever.
   */
  it('runs at the turn boundary, inside `withCapabilityRuntime`', () => {
    const method = source.slice(
      source.indexOf('  private async withCapabilityRuntime<T>('),
      source.indexOf('  private async withCapabilityRuntime<T>(') + 3000,
    )
    // Positive control for the slice: a wrong offset makes every `toContain`
    // below vacuous by searching an empty string.
    expect(method).toContain('withCapabilityRuntime')
    expect(method).toContain('this.reportCodexBridgeAbsence(managed)')
  })

  it('reads the shared predicate rather than a second copy of the state test', () => {
    const method = source.slice(
      source.indexOf('  private reportCodexBridgeAbsence('),
      source.indexOf('  private reportCodexBridgeAbsence(') + 2000,
    )
    expect(method).toContain('reportCodexBridgeAbsence')
    // `schedulingBridgeKnownAbsent` is the one place that says only
    // `'unavailable'` counts — `/loop`'s withholding reads it too, and two
    // copies of that rule is how the two surfaces come to disagree.
    expect(method).toContain('schedulingBridgeKnownAbsent(managed.agent)')
    expect(method).not.toContain("=== 'unavailable'")
  })
})

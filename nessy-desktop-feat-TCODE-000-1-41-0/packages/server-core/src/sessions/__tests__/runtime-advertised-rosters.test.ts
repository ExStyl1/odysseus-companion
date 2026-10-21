/**
 * D1.328 — the SDK's `system`/`init` rosters, from the adapter that captures
 * them to the session read the renderer already makes.
 *
 * SIT-5b measured the gap three ways on the packaged 1.40.0: `getSdkTools`
 * occurs ONCE in the whole tree (its own declaration) against the sibling
 * accessor `getModel()` at 41; the SDK's persisted session file carries no
 * `init` entry at all (`queue-operation`, `assistant`, `attachment`, `user`,
 * `file-history-snapshot`, `atis-latch`, `last-prompt` — the file is the right
 * one and is being written, which is the control); and the adapter's own
 * `SDK init: captured <n> tools` debug line occurs 0 times in the captured
 * output of that sitting while other claude debug lines from the same runs are
 * there. So all four rosters were captured and three were read by nothing.
 *
 * ONE path, end to end, and neither half is stubbed:
 *
 *  - a REAL `ClaudeEventAdapter` is fed a REAL `system`/`init` message, which is
 *    what makes the four captures and the one projection provably agree — a
 *    hand-written roster object would have proved only that a spread works;
 *  - the REAL `managedToSession` projection is driven through the REAL
 *    `SessionManager.getSessions()`, which is the read `scripts/cdp/lib/state.ts`
 *    takes and the one a live case can therefore ask.
 *
 * The one thing planted is the session's `agent`, and production has exactly
 * this shape at exactly this moment: `ManagedSession.agent` is an `AgentBackend`,
 * `ClaudeAgent.getRuntimeAdvertisedRosters()` is a one-line delegation to the
 * same adapter getter driven here, and the no-agent arm below is the case where
 * production has no collaborator at all.
 */
import { describe, expect, test } from 'bun:test'
import { ClaudeEventAdapter } from '@nessy-agent/shared/agent/backend/claude/event-adapter'
import { createTestSessionManager } from './test-session-manager.ts'

/**
 * The session's `agent`, carrying ONLY the method this row is about.
 *
 * It is DETACHED before `cleanup()` rather than grown into a lifecycle double:
 * `endManagedAgentLifecycle` calls a widening list of methods on every live
 * agent (`setAutomationSystem`, `setCapabilityTurnRuntime`, `endLifecycle`, …),
 * and answering them here would be a second, untested copy of `AgentBackend`
 * that drifts silently. Detaching is what production itself does when an agent
 * is disposed, and teardown is not this row's subject — the reading is taken
 * before it either way.
 */
function agentAdvertising(rosters: () => unknown): Record<string, unknown> {
  return { getRuntimeAdvertisedRosters: rosters }
}

/** A real adapter that has been told what the SDK offers. */
async function adapterAfterInit(overrides: Record<string, unknown> = {}): Promise<ClaudeEventAdapter> {
  const adapter = new ClaudeEventAdapter({} as never)
  await adapter.adapt({
    type: 'system',
    subtype: 'init',
    tools: ['Read', 'Write', 'Bash'],
    slash_commands: ['help', 'compact'],
    skills: ['pdf', 'xlsx'],
    agents: ['Explore', 'Plan'],
    uuid: 'u',
    session_id: 's',
    ...overrides,
  } as never)
  return adapter
}

describe('D1.328 — what the SDK advertised reaches the session read', () => {
  test('a real init travels to the DTO through the real projection', async () => {
    const adapter = await adapterAfterInit()
    const manager = createTestSessionManager() as any
    try {
      const session = await manager.createSession('workspace-d1328-carried', {})
      // The only plant, and the shape production has: an `AgentBackend` whose
      // `getRuntimeAdvertisedRosters` is `ClaudeAgent`'s one-line delegation to
      // this same adapter getter.
      const managed = manager.getManaged(session.id, 'workspace-d1328-carried')
      managed.agent = agentAdvertising(() => adapter.advertisedRosters)

      const listed = manager.getSessions('workspace-d1328-carried').find((row: any) => row.id === session.id)
      expect(listed?.runtimeAdvertisedRosters).toEqual({
        tools: ['Read', 'Write', 'Bash'],
        slashCommands: ['help', 'compact'],
        skills: ['pdf', 'xlsx'],
        agents: ['Explore', 'Plan'],
      })
    } finally {
      for (const managed of manager.sessions.values()) managed.agent = null
      await manager.cleanup()
    }
  })

  test('a session whose runtime has advertised nothing carries no field at all', async () => {
    const manager = createTestSessionManager() as any
    try {
      const session = await manager.createSession('workspace-d1328-silent', {})
      // No agent: the ordinary state of every session before its first turn, and
      // of every non-claude session forever. `undefined` is not enough — the key
      // must be ABSENT, because absent is what a client reads as "not told yet"
      // and a present-but-empty object would read as "told, and there is
      // nothing", which is a different and false claim.
      const listed = manager.getSessions('workspace-d1328-silent').find((row: any) => row.id === session.id)
      expect('runtimeAdvertisedRosters' in (listed ?? {})).toBe(false)

      // ...and the same is true of a runtime that HAS an agent which has not
      // been told anything: the adapter's own reading is `undefined`, not an
      // empty object, so the two silences stay one silence on the wire.
      const managed = manager.getManaged(session.id, 'workspace-d1328-silent')
      managed.agent = agentAdvertising(() => new ClaudeEventAdapter({} as never).advertisedRosters)
      const afterAgent = manager.getSessions('workspace-d1328-silent').find((row: any) => row.id === session.id)
      expect('runtimeAdvertisedRosters' in (afterAgent ?? {})).toBe(false)
    } finally {
      for (const managed of manager.sessions.values()) managed.agent = null
      await manager.cleanup()
    }
  })

  test('an init that names only tools still answers, with the other three empty', async () => {
    // The boundary the `undefined` rule turns on: one non-empty roster is enough
    // to make the whole reading real, and the three empties then MEAN "the SDK
    // offers none" rather than "nobody asked". Without this arm the projection
    // could require all four and nothing would say so.
    const adapter = await adapterAfterInit({ slash_commands: [], skills: [], agents: [] })
    expect(adapter.advertisedRosters).toEqual({
      tools: ['Read', 'Write', 'Bash'],
      slashCommands: [],
      skills: [],
      agents: [],
    })
  })

  test('the DTO holds a COPY, so a later commands_changed cannot rewrite a sent page', async () => {
    // `_sdkSlashCommands` is replaced wholesale by the `commands_changed` diff,
    // but the rosters are read at projection time and a live array handed to a
    // client would be a second reader of the adapter's own state. Asserted by
    // identity rather than by value: two equal arrays would pass a value check
    // while still being the same object.
    const adapter = await adapterAfterInit()
    const first = adapter.advertisedRosters!
    const second = adapter.advertisedRosters!
    expect(first.slashCommands).toEqual(second.slashCommands)
    expect(first.slashCommands).not.toBe(second.slashCommands)
    expect(first.slashCommands).not.toBe(adapter.sdkSlashCommands)
  })
})

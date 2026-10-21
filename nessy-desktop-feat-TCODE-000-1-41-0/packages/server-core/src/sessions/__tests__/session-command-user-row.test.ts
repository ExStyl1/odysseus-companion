/**
 * D1.341 — a session command the HOST consumes leaves its question in the
 * transcript, ahead of the host's answer.
 *
 * ## The reading
 *
 * RS-46 on the packaged 1.40.0 (SIT-5d): submitting `/tasks` and `/workflows`
 * left transcript roles `["info"]` — the answer alone — where `/help` and
 * `/status` in the same session in the same pass left `["user","info"]`. The two
 * halves of that control are the whole diagnosis: `/help` and `/status` are
 * answered inside the agent at the `BaseAgent.chat` seam, so they travel the
 * WHOLE of `sendMessage` and pick up the ordinary user-message append on the
 * way; `/tasks`, `/workflows`, `/cd` and `/branch` are answered by the manager
 * itself, from four arms that each RETURN before that append.
 *
 * ## What runs for real
 *
 * `SessionManager.prototype.sendMessage` itself, with only its leaf
 * collaborators supplied — the same rig shape
 * `tasks-workflows-session-command.test.ts` uses for the dispatch, because the
 * claim here is also about the SEAM and not about any executor. The four
 * executors are stubbed to a marker so a case can read the ORDER of the two rows
 * without depending on any command's wording, and the transcript is the real
 * `managed.messages` the real `appendManagedMessage` writes into.
 *
 * The negative arm is the one that would catch the obvious over-fix: a
 * model-bound message must still produce EXACTLY ONE user row, written by the
 * ordinary path and not a second one here.
 */
import { describe, expect, test } from 'bun:test'
import { SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager.ts'

/** Thrown where `sendMessage` first touches the turn machinery. */
const BOUNDARY = 'reached-the-turn-boundary'

function harness() {
  const manager = createTestSessionManager() as any
  const managed = {
    id: 'session-1',
    workspace: { id: 'workspace-1' },
    messages: [] as Array<{ id: string; role: string; content: string }>,
    messagesLoaded: true,
  }
  manager.getManaged = () => managed
  for (const announce of [
    'announcePermissionPolicyDiagnostics',
    'announceSettingsTiers',
    'announceChildCredentialSource',
    'announceChildTelemetryVerdict',
    'announceCompanyAnnouncement',
    'announcePluginSuggestion',
    'announcePluginSuggestionTip',
  ]) manager[announce] = () => {}
  // The four host-consumed arms, reduced to the one fact this file reads: an
  // answer row landed, and in which order relative to the question.
  manager.runCdSessionCommand = async () => { managed.messages.push({ id: 'answer', role: 'info', content: 'cd answered' }) }
  manager.runBranchSessionCommand = async () => { managed.messages.push({ id: 'answer', role: 'info', content: 'branch answered' }) }
  manager.runTasksSessionCommand = () => { managed.messages.push({ id: 'answer', role: 'info', content: 'tasks answered' }) }
  manager.runWorkflowsListSessionCommand = () => { managed.messages.push({ id: 'answer', role: 'info', content: 'workflows answered' }) }
  manager.runWorkflowsSessionCommand = async () => { managed.messages.push({ id: 'answer', role: 'info', content: 'workflows stopped' }) }
  const events: Array<Record<string, unknown>> = []
  manager.sendEvent = (event: Record<string, unknown>) => { events.push(event) }
  manager.persistSession = () => {}
  // The tripwire: the first thing `sendMessage` does once past the four arms.
  manager.managedKey = () => { throw new Error(BOUNDARY) }
  const send = (message: string) =>
    (SessionManager.prototype.sendMessage as any).call(manager, 'session-1', message)
  /**
   * The replay shape, spelled by NAME rather than by counting `undefined`s:
   * `sendMessage`'s positional tail is `(attachments, storedAttachments,
   * options, existingMessageId, _isAuthRetry, onAck)` and a miscount here reads
   * as the feature being broken — it did, once, in this file's first run.
   */
  const replay = (message: string, existingMessageId: string, onAck: (id: string) => void) =>
    (SessionManager.prototype.sendMessage as any).call(
      manager, 'session-1', message, undefined, undefined, undefined, existingMessageId, undefined, onAck,
    )
  const roles = () => managed.messages.map(entry => entry.role)
  return { manager, managed, send, replay, roles, events }
}

describe('D1.341 · a host-consumed session command leaves its question', () => {
  for (const [command, answer] of [
    ['/tasks', 'tasks answered'],
    ['/workflows', 'workflows answered'],
    ['/cd /tmp', 'cd answered'],
    ['/branch', 'branch answered'],
  ] as const) {
    test(`${command} writes the user row BEFORE the answer row`, async () => {
      const rig = harness()

      await rig.send(command)

      expect(rig.roles()).toEqual(['user', 'info'])
      // Verbatim, the way the model path records it: the transcript must show
      // what was typed, not a normalised or re-spelled form of it.
      expect(rig.managed.messages[0]!.content).toBe(command)
      expect(rig.managed.messages[1]!.content).toBe(answer)
      // And the renderer is told, exactly as it is for a model-bound send, so
      // the optimistic row it already drew is reconciled rather than duplicated.
      expect(rig.events.filter(event => event.type === 'user_message')).toHaveLength(1)
      expect(rig.events[0]).toMatchObject({ type: 'user_message', status: 'accepted' })
    })
  }

  test('`/workflows stop` — the ACTING form — keeps the same order', async () => {
    const rig = harness()
    await rig.send('/workflows stop')
    expect(rig.roles()).toEqual(['user', 'info'])
    expect(rig.managed.messages[1]!.content).toBe('workflows stopped')
  })

  test('a model-bound message still gets exactly ONE user row, from the ordinary path', async () => {
    // The over-fix this arm exists to catch: writing the row for every message
    // would double it for every real turn. This message must reach the turn
    // boundary with NOTHING appended by the new gate.
    const rig = harness()

    await expect(rig.send('summarise the build log')).rejects.toThrow(BOUNDARY)

    expect(rig.managed.messages).toHaveLength(0)
    expect(rig.events).toHaveLength(0)
  })

  test('a REPLAYED command reuses its id and never writes a second question', async () => {
    // `existingMessageId` means "reuse this id". The transcript already carrying
    // it is the queued-then-replayed case, and a second row for one answer is
    // the same defect this row fixes, mirrored.
    const rig = harness()
    rig.managed.messages.push({ id: 'queued-1', role: 'user', content: '/tasks' })
    const acked: string[] = []

    await rig.replay('/tasks', 'queued-1', (id: string) => acked.push(id))

    expect(rig.roles()).toEqual(['user', 'info'])
    expect(acked).toEqual(['queued-1'])
    expect(rig.events).toHaveLength(0)
  })

  test('an id nothing carries is ADOPTED rather than minted beside, as the model path does', async () => {
    const rig = harness()
    const acked: string[] = []

    await rig.replay('/tasks', 'phantom-1', (id: string) => acked.push(id))

    expect(rig.roles()).toEqual(['user', 'info'])
    expect(rig.managed.messages[0]!.id).toBe('phantom-1')
    expect(acked).toEqual(['phantom-1'])
  })
})

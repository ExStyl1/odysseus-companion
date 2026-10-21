/**
 * D1.14 + D1.37 — `/tasks` and `/workflows` are DISPATCHED, and the dispatch is
 * driven through the real `sendMessage` rather than by calling the executors.
 *
 * ## Why the routing is the case that matters
 *
 * A parser row with no consumer is the defect class this repo keeps meeting: a
 * kind that classifies, answers nothing, and falls through to the model exactly
 * as it did before the row existed. `RS-46` measured both tokens reaching the
 * model on the packaged 1.39.0, so "it parses" is not the claim — "it never
 * reaches a turn" is. So `SessionManager.prototype.sendMessage` runs for real
 * here, with only its leaf collaborators supplied, and the NEGATIVE arm is a
 * message that must get PAST both new arms and claim the turn boundary.
 *
 * ## What is stubbed, and why none of it is the thing under test
 *
 * `listSessionScheduledWork` and `stopAllBackgroundWork` have their own suites
 * (`session-scheduled-work-read.test.ts`, `stop-all-background-work.test.ts`);
 * `recordSessionInfoEntry` is the durable channel whose behaviour
 * `/cd` and `/branch` already pin. What runs for real here is the parse, both
 * arms, both executors and the shared formatter — which is the whole path from
 * a typed token to a transcript row.
 */
import { describe, expect, test } from 'bun:test'
import { SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager.ts'

const BOUNDARY = 'reached-the-turn-boundary'

function harness(options: {
  scheduled?: { crons: unknown[]; tasks: unknown[] }
  stopResult?: { stopped: number; failed: unknown[]; reason?: string }
} = {}) {
  const recorded: Array<{ content: string; level: string }> = []
  const manager = createTestSessionManager() as any
  // D1.341 — a loaded transcript, because the seam now writes the USER row for
  // a host-consumed command before the arm answers. Nothing else here changed:
  // `recordSessionInfoEntry` is still captured rather than run, so what these
  // cases read is still the dispatch and the formatter.
  const managed = { id: 'session-1', workspace: { id: 'workspace-1' }, messages: [], messagesLoaded: true }
  manager.getManaged = () => managed
  manager.sendEvent = () => {}
  manager.persistSession = () => {}
  for (const announce of [
    'announcePermissionPolicyDiagnostics',
    'announceSettingsTiers',
    'announceChildCredentialSource',
    'announceCompanyAnnouncement',
    'announcePluginSuggestion',
    'announcePluginSuggestionTip',
  ]) manager[announce] = () => {}
  manager.recordSessionInfoEntry = (_managed: unknown, content: string, level: string) => {
    recorded.push({ content, level })
  }
  manager.listSessionScheduledWork = () => options.scheduled ?? { crons: [], tasks: [] }
  let onStop: () => void = () => {}
  manager.stopAllBackgroundWork = async () => {
    onStop()
    return options.stopResult ?? { stopped: 0, failed: [], reason: 'nothing-to-stop' }
  }
  // The tripwire for the NEGATIVE arm: the first thing `sendMessage` does after
  // the session-command arms is claim the turn boundary through `managedKey`.
  manager.managedKey = () => { throw new Error(BOUNDARY) }
  const send = (message: string) => SessionManager.prototype.sendMessage.call(manager, 'session-1', message)
  // D1.247 — the listing form must not reach the aggregate, and an assertion on
  // the RECORDED sentence cannot see that: a stop that found nothing records a
  // sentence too. This counts the call itself.
  return { send, recorded, onStop: (fn: () => void) => { onStop = fn } }
}

describe('D1.14 · /tasks answers in the transcript and never becomes a turn', () => {
  test('records the session\'s own inventory, watches under `monitor`, as one durable row', async () => {
    const rig = harness({
      scheduled: {
        tasks: [{ id: 'mon_1', type: 'monitor', status: 'running', description: 'watch the build log' }],
        crons: [{ id: 'cron_1', schedule: '0 9 * * *', recurring: true, prompt: 'nightly review' }],
      },
    })

    await rig.send('/tasks')

    expect(rig.recorded).toHaveLength(1)
    expect(rig.recorded[0]!.level).toBe('info')
    expect(rig.recorded[0]!.content).toContain('monitor mon_1 — running — watch the build log')
    expect(rig.recorded[0]!.content).toContain('cron_1 — 0 9 * * * (repeats) — nightly review')
  })

  test('a session with nothing queued gets the honest sentence, not an empty row', async () => {
    const rig = harness()
    await rig.send('/tasks')
    expect(rig.recorded[0]!.content).toBe('This session is holding no background work and has nothing scheduled.')
  })
})

describe('D1.247 · the bare /workflows is the progress listing', () => {
  /**
   * The row this case exists for. `formatSessionScheduledWorkReport`'s own empty
   * line says "is holding no background work and has NOTHING SCHEDULED", which
   * is true of `/tasks`'s whole inventory and FALSE of this filtered one on
   * exactly this session — a cron queued, nothing running. So the bare form
   * writes its own sentence and points at `/tasks` for the half it dropped.
   */
  test('lists only what is RUNNING, and says so without claiming the scheduled half', async () => {
    const rig = harness({
      scheduled: {
        tasks: [
          { id: 'sub_1', type: 'subagent', status: 'running', description: 'review the diff' },
          { id: 'sub_0', type: 'subagent', status: 'completed', description: 'already finished' },
        ],
        crons: [{ id: 'cron_1', schedule: '0 9 * * *', recurring: true, prompt: 'nightly review' }],
      },
    })

    await rig.send('/workflows')

    expect(rig.recorded).toHaveLength(1)
    expect(rig.recorded[0]!.level).toBe('info')
    expect(rig.recorded[0]!.content).toContain('subagent sub_1 — running — review the diff')
    // The population is the one `stopAllBackgroundWork` acts on: a COMPLETED
    // entry is history and a cron has not started, so neither is progress.
    expect(rig.recorded[0]!.content).not.toContain('sub_0')
    expect(rig.recorded[0]!.content).not.toContain('cron_1')
    // And it names the form that acts, so the two are discoverable from each other.
    expect(rig.recorded[0]!.content).toContain('/workflows stop')
  })

  test('a session with a cron queued and nothing running is NOT told it has nothing scheduled', async () => {
    const rig = harness({
      scheduled: {
        tasks: [],
        crons: [{ id: 'cron_1', schedule: '0 9 * * *', recurring: true, prompt: 'nightly review' }],
      },
    })
    await rig.send('/workflows')
    expect(rig.recorded[0]!.content).toBe(
      'No background work is running in this session right now. `/tasks` lists everything this session has queued, scheduled records included.',
    )
    // The sentence the shared formatter would have produced, and the reason it
    // is not used here: it would have denied the cron this session is holding.
    expect(rig.recorded[0]!.content).not.toContain('has nothing scheduled')
  })

  test('the listing form never reaches the aggregate', async () => {
    let stopCalls = 0
    const rig = harness({ stopResult: { stopped: 0, failed: [], reason: 'nothing-to-stop' } })
    rig.onStop(() => { stopCalls += 1 })
    await rig.send('/workflows')
    expect(stopCalls).toBe(0)
    // The control on the instrument: the explicit form does call it.
    await rig.send('/workflows stop')
    expect(stopCalls).toBe(1)
  })
})

describe('D1.37 · /workflows stop is the all-stop, and its refusal is named', () => {
  test('reports what it stopped, and names each item that refused', async () => {
    const rig = harness({
      stopResult: {
        stopped: 2,
        failed: [{ id: 'task-9', type: 'subagent', reason: 'unknown-task-id' }],
      },
    })

    await rig.send('/workflows stop')

    expect(rig.recorded).toHaveLength(1)
    // A failure downgrades the level: the gesture did not fully do what it said.
    expect(rig.recorded[0]!.level).toBe('warning')
    expect(rig.recorded[0]!.content).toContain('Stopped 2 background items in this session.')
    // Named, not counted — a user told "one did not stop" has to guess which.
    expect(rig.recorded[0]!.content).toContain('subagent task-9 (unknown-task-id)')
  })

  test('a clean sweep is a success, and the singular is spelled', async () => {
    const rig = harness({ stopResult: { stopped: 1, failed: [] } })
    await rig.send('/workflows stop')
    expect(rig.recorded[0]).toEqual({ content: 'Stopped 1 background item in this session.', level: 'success' })
  })

  test('a session with nothing running is REFUSED by name rather than told it worked', async () => {
    const rig = harness({ stopResult: { stopped: 0, failed: [], reason: 'nothing-to-stop' } })
    await rig.send('/workflows stop')
    expect(rig.recorded[0]).toEqual({
      content: 'Nothing was stopped: this session is not running any background work.',
      level: 'warning',
    })
  })
})

describe('D1.14 · the arms do not swallow the messages beside them', () => {
  test('prose that starts with either token still reaches the turn boundary', async () => {
    for (const message of ['/tasks now', '/workflows for the release', 'what are my /tasks?']) {
      const rig = harness()
      // The tripwire: reaching `managedKey` means the arms returned nothing and
      // `sendMessage` went on to claim a turn, which is where a prompt belongs.
      await expect(rig.send(message)).rejects.toThrow(BOUNDARY)
      expect(rig.recorded).toEqual([])
    }
  })

  test('and the two commands themselves never reach it', async () => {
    for (const message of ['/tasks', '/workflows', '/workflows stop']) {
      const rig = harness()
      await rig.send(message)
      expect(rig.recorded).toHaveLength(1)
    }
  })
})

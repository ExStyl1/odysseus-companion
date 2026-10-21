/**
 * D1.269 — the host half: the two writers that can move
 * `sessions:listScheduledWork` say so on the session's own event stream.
 *
 * ## What the renderer half is waiting for
 *
 * `useSessionScheduledWork` used to re-read on ONE signal — the background-task
 * atom's row count — so a cron record written while the session was open and
 * nothing else happening stayed invisible until the panel was reopened. WI-ab
 * built the reader (`renderer/lib/scheduled-work-refresh.ts`, which declares the
 * wire name once so the halves cannot drift) and left it INERT: nothing emitted
 * `scheduled_work_changed`. This is the producer.
 *
 * ## Why the nudge carries no payload, and why `list` does not nudge
 *
 * The event says "read it again" and nothing else: the list is rebuilt from the
 * RPC, so records on the event would give one fact two producers. And `list` is
 * the read the nudge asks for — nudging from it would have the panel re-read its
 * own re-read.
 *
 * ## The refusals are arms of their own
 *
 * `remove`, `setPaused`, `runNow`, `acknowledgeRuns` and `stopWakeup` all answer
 * `false` for an id the store does not know. A nudge there would be a re-read
 * for a change that did not happen, so each is gated on its own answer — and
 * that gate is what the negative cases below drive.
 */
import { describe, expect, test } from 'bun:test'
import { createTestSessionManager } from './test-session-manager.ts'

interface Internals {
  sendEvent(event: { type: string; sessionId?: string }, workspaceId?: string): void
  sessionMonitors: unknown
  buildSessionCronPort(managed: unknown, service: unknown): {
    create(input: unknown): Promise<unknown>
    list(): Promise<unknown>
    remove(id: string): Promise<boolean>
    setPaused(id: string, paused: boolean): Promise<boolean>
    runNow(id: string): Promise<boolean>
    acknowledgeRuns(id: string): Promise<boolean>
    stopWakeup(): Promise<boolean>
  }
  buildSessionMonitorPort(managed: unknown): {
    start(input: unknown): Promise<{ taskId: string }>
    stop(taskId: string): Promise<boolean>
  }
}

const KNOWN = 'cron-1269'

const MANAGED = {
  id: 'session-1269',
  workspace: { id: 'workspace-1269', rootPath: '/tmp/workspace-1269' },
  workingDirectory: '/tmp/workspace-1269',
}

/** A manager whose event stream is recorded and whose store answers by id. */
function rig() {
  const manager = createTestSessionManager()
  const internals = manager as unknown as Internals
  const events: Array<{ type: string; sessionId?: string }> = []
  internals.sendEvent = event => { events.push(event) }

  const record = { id: KNOWN, schedule: '0 9 * * *', recurring: true, prompt: 'p', dynamic: true }
  const answer = (id: string): typeof record | undefined => (id === KNOWN ? record : undefined)
  const service = {
    create: () => record,
    startSelfPaced: () => record,
    list: () => [record],
    remove: answer,
    pause: answer,
    resume: answer,
    runNow: answer,
    acknowledgeRuns: async (id: string) => id === KNOWN,
    rearm: () => true,
    stopWakeup: (id: string) => id === KNOWN,
  }

  const nudges = (): number => events.filter(event => event.type === 'scheduled_work_changed').length
  return {
    events,
    nudges,
    internals,
    cron: internals.buildSessionCronPort(MANAGED, service),
    monitor: internals.buildSessionMonitorPort(MANAGED),
  }
}

describe('D1.269 · the scheduled-work nudge, from the two writers', () => {
  test('every cron MUTATION nudges once, and it names the session', async () => {
    const { cron, events, nudges } = rig()

    await cron.create({ schedule: '0 9 * * *', recurring: true, prompt: 'p' })
    expect(nudges()).toBe(1)
    expect(events[0]).toEqual({ type: 'scheduled_work_changed', sessionId: MANAGED.id })

    await cron.setPaused(KNOWN, true)
    await cron.setPaused(KNOWN, false)
    await cron.runNow(KNOWN)
    await cron.acknowledgeRuns(KNOWN)
    await cron.stopWakeup()
    await cron.remove(KNOWN)
    expect(nudges()).toBe(7)
  })

  test('the READ does not nudge, and neither does a refusal — the negatives', async () => {
    const { cron, nudges } = rig()

    // `list` is the read the nudge asks the renderer to repeat.
    await cron.list()
    await cron.list()
    expect(nudges()).toBe(0)

    // An id the store does not know changes nothing, so it says nothing.
    await cron.remove('no-such-task')
    await cron.setPaused('no-such-task', true)
    await cron.runNow('no-such-task')
    await cron.acknowledgeRuns('no-such-task')
    expect(nudges()).toBe(0)
  })

  test('a monitor start nudges, and a stop nudges only when it stopped something', async () => {
    const rigged = rig()
    rigged.internals.sessionMonitors = {
      start: async () => ({ taskId: 'task-1269' }),
      stop: async (_key: unknown, taskId: string) => taskId === 'task-1269',
    }

    const started = await rigged.monitor.start({ command: 'tail -f log', description: 'watch' })
    expect(started.taskId).toBe('task-1269')
    expect(rigged.nudges()).toBe(1)

    expect(await rigged.monitor.stop('task-1269')).toBe(true)
    expect(rigged.nudges()).toBe(2)

    // Not this session's monitor: nothing changed, nothing to re-read.
    expect(await rigged.monitor.stop('someone-elses-task')).toBe(false)
    expect(rigged.nudges()).toBe(2)
  })
})

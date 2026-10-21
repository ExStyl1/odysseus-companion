/**
 * D1.97 + D1.98 — the host read behind `sessions:listScheduledWork`, driven
 * through the REAL `buildHookTaskRegistryPort` rather than around it.
 *
 * The whole claim of this accessor is that it adds no inventory of its own: it
 * hands over exactly what the `background_tasks` / `session_crons` hook payload
 * reports, so the hook, the typed `/tasks` answer and the panel are one list. A
 * rig that stubbed the port would have proved the wrapper and not the claim —
 * so the port is real here, and only the two leaf sources under it (the session
 * maps and the cron service) are supplied.
 *
 * D1.98's assertion is deliberately a NEGATIVE beside a positive: the watch is
 * present, and it is present under `monitor`, the name `hooks.md`'s own
 * `background_tasks[]` contract uses and `BackgroundTaskType` already declares.
 * No `watch` type is minted.
 */
import { describe, expect, test } from 'bun:test'
import { createTestSessionManager } from './test-session-manager.ts'

type CronRecord = { id: string; schedule: string; recurring: boolean; prompt: string }

function harness(sources: {
  monitors?: Array<{ id: string; type: string; status: string; description: string; server?: string; tool?: string }>
  shells?: Array<[string, string]>
  crons?: CronRecord[]
  found?: boolean
}) {
  const manager = createTestSessionManager() as any
  const managed = { id: 'session-1', workspace: { id: 'workspace-1' } }
  manager.getManaged = () => (sources.found === false ? undefined : managed)
  manager.managedKey = () => 'workspace-1:session-1'
  manager.sessionMonitors = { list: () => sources.monitors ?? [] }
  manager.piChildSessionServices = new Map()
  manager.sessionCronServices = new Map([
    ['workspace-1:session-1', { list: () => sources.crons ?? [] }],
  ])
  // The two leaves `hookTaskRegistrySources` reads off the managed session.
  Object.assign(managed, {
    childSessionState: { children: [] },
    piBackgroundTaskKinds: [],
    backgroundTaskOutputs: new Map(),
    backgroundShellCommands: new Map(sources.shells ?? []),
  })
  return manager
}

describe('D1.97/D1.98 · listSessionScheduledWork', () => {
  test('hands over the hook payload\'s own two inventories, watches under `monitor`', () => {
    const manager = harness({
      monitors: [{ id: 'mon_1', type: 'monitor', status: 'running', description: 'watch the build log', server: 'example.test', tool: 'ws' }],
      shells: [['shell-1', 'npm run dev']],
      crons: [{ id: 'cron_1', schedule: '0 9 * * *', recurring: true, prompt: 'nightly review' }],
    })

    const result = manager.listSessionScheduledWork('session-1', 'workspace-1')

    // D1.98, positive: the watch is in the list.
    expect(result.tasks.map((task: { id: string }) => task.id)).toEqual(['mon_1', 'shell-1'])
    expect(result.tasks[0]).toMatchObject({ type: 'monitor', server: 'example.test', tool: 'ws' })
    // D1.98, negative: and it is not under a second name.
    expect(result.tasks.some((task: { type: string }) => task.type === 'watch')).toBe(false)
    // D1.97: the cron records come through the same call, capped prompt included.
    expect(result.crons).toEqual([{ id: 'cron_1', schedule: '0 9 * * *', recurring: true, prompt: 'nightly review' }])
  })

  test('a session with nothing queued answers two EMPTY arrays, not undefined', () => {
    const result = harness({}).listSessionScheduledWork('session-1', 'workspace-1')
    expect(result).toEqual({ crons: [], tasks: [] })
  })

  test('a session id nothing owns answers undefined, which is the other fact', () => {
    expect(harness({ found: false }).listSessionScheduledWork('ghost', 'workspace-1')).toBeUndefined()
    // The pair is the assertion: an empty session and an absent one must not be
    // the same value, or the RPC above cannot tell them apart either.
    expect(harness({}).listSessionScheduledWork('session-1', 'workspace-1')).not.toBeUndefined()
  })

  test('a session whose cron service has never been created still answers its background work', () => {
    // `sessionCronServices` is populated lazily; a lookup miss must be an empty
    // cron list rather than a throw that loses the tasks beside it.
    const manager = harness({ shells: [['shell-1', 'npm run dev']] })
    manager.sessionCronServices = new Map()
    const result = manager.listSessionScheduledWork('session-1', 'workspace-1')
    expect(result.crons).toEqual([])
    expect(result.tasks.map((task: { id: string }) => task.id)).toEqual(['shell-1'])
  })
})

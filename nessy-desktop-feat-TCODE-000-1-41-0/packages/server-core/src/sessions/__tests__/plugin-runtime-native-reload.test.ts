/**
 * P6.412 — the runtime's OWN plugin reload is tried before the teardown.
 *
 * `plugins/loading.md#check-which-stage-a-plugin-reached` is what this
 * buys: the session survives a plugin mutation instead of being thrown away to
 * pick up a path change. The seam shipped in the vendored SDK
 * (`sdk.d.ts:2544`) and this fork never called it — `git grep -a
 * '\.reloadPlugins('` scored 0 call sites — so every claude session paid a
 * teardown for a change the child could have absorbed.
 *
 * Native-first, and the host is the seam: only claude publishes the mechanism,
 * so codex and Pi fall through to the teardown they already had, and the
 * `reloaded` verdict is what makes that difference HONEST rather than silent —
 * it is the one outcome that costs the user tokens on the next request.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
})

type AgentStub = {
  isProcessing(): boolean
  reloadPlugins?: () => Promise<{ applied: boolean }>
}

let seq = 0

function fixture(agent: AgentStub | undefined, over: { isProcessing?: boolean } = {}) {
  const manager = createTestSessionManager()
  managers.push(manager)
  seq += 1
  const workspaceId = `workspace-reload-${seq}`
  const managed = createManagedSession({ id: `session-reload-${seq}` }, {
    id: workspaceId,
    name: 'Workspace Reload',
    rootPath: '/tmp/nessy-plugin-reload-workspace',
    createdAt: 1,
  }, { messagesLoaded: true, ephemeral: true })
  managed.agent = agent as never
  managed.isProcessing = over.isProcessing ?? false
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    `${workspaceId}:${managed.id}`,
    managed,
  )
  // The teardown the reload is supposed to AVOID. Replaced so its absence is a
  // fact this test can assert rather than an inference from a counter.
  const teardowns: string[] = []
  ;(manager as unknown as {
    disposeManagedAgentRuntime(m: { id: string }, reason: string): Promise<void>
  }).disposeManagedAgentRuntime = async (m, reason) => { teardowns.push(`${m.id}:${reason}`) }
  return { manager, workspaceId, teardowns }
}

describe('a plugin mutation asks the runtime to reload before it tears anything down (P6.412)', () => {
  test('an idle claude session reloads in place, counted apart from applied, with no teardown', async () => {
    // POSITIVE.
    let reloads = 0
    const { manager, workspaceId, teardowns } = fixture({
      isProcessing: () => false,
      reloadPlugins: async () => { reloads += 1; return { applied: true } },
    })

    const summary = await manager.refreshPluginRuntime(workspaceId, undefined, 'plugin installed')

    expect(reloads).toBe(1)
    expect(summary.reloaded).toBe(1)
    // NOT folded into `applied`: `describeRefreshSummary` reports it as its own
    // verdict so the install notice can name the token cost.
    expect(summary.applied).toBe(0)
    expect(summary.deferred).toBe(0)
    expect(summary.untouched).toBe(0)
    // The whole point of the row: the session survived.
    expect(teardowns).toEqual([])
  })

  test('a busy session is never asked, and a runtime without the seam still takes the teardown', async () => {
    // NEGATIVE 1: the reload is cheaper than a teardown but it is not free, and
    // doing it under a running turn is the mid-turn mutation the defer path
    // exists to prevent. Same guard pair as `invalidatePluginRuntimeForSession`.
    let busyReloads = 0
    const busy = fixture({
      isProcessing: () => true,
      reloadPlugins: async () => { busyReloads += 1; return { applied: true } },
    }, { isProcessing: true })
    const busySummary = await busy.manager.refreshPluginRuntime(busy.workspaceId, undefined, 'plugin installed')
    expect(busyReloads).toBe(0)
    expect(busySummary.deferred).toBe(1)
    expect(busySummary.reloaded).toBe(0)
    expect(busy.teardowns).toEqual([])

    // NEGATIVE 2: codex and Pi publish no such seam, so the structural check
    // finds nothing and the path they already had is byte-for-byte unchanged.
    const noSeam = fixture({ isProcessing: () => false })
    const noSeamSummary = await noSeam.manager.refreshPluginRuntime(noSeam.workspaceId, undefined, 'plugin installed')
    expect(noSeamSummary.applied).toBe(1)
    expect(noSeamSummary.reloaded).toBe(0)
    expect(noSeam.teardowns).toHaveLength(1)

    // NEGATIVE 3: a reload the runtime declined is not a failure — it routes
    // straight back to the teardown, which is what `applied: false` means.
    const declined = fixture({
      isProcessing: () => false,
      reloadPlugins: async () => ({ applied: false }),
    })
    const declinedSummary = await declined.manager.refreshPluginRuntime(declined.workspaceId, undefined, 'plugin installed')
    expect(declinedSummary.applied).toBe(1)
    expect(declinedSummary.reloaded).toBe(0)
    expect(declined.teardowns).toHaveLength(1)
  })
})

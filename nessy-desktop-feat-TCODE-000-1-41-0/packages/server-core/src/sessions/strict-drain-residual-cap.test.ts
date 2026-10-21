/**
 * P2.210 — the strict Pi drain's residual sweep counted with the same
 * `limit: 100` cap P2.143 removed from the busy read.
 *
 * `snapshot` is a renderer projection: it sorts `startedAt` DESC, slices, and
 * refuses any limit above 100, so the cap was not raisable. MEASURED by P2.143
 * on a real store — 121 records for one session whose OLDEST was the only
 * `running` one — the capped `running || lost` filter counted ZERO.
 *
 * On THIS path the under-count was benign, for exactly one reason:
 * `disposeManagedAgentRuntime` runs first, its `drainSession` reads the store
 * with no limit, and its failure is already inside this method's strict throw.
 * That is a DEPENDENCY ON AN ORDERING, and these tests pin it — the first two
 * pin the upstream (it runs first, and it really does fail closed over the
 * record the capped read missed); the third removes the upstream entirely and
 * shows the sweep answering completely on its own, which is what makes the
 * ordering safe to lose.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProcessStore } from '../pi-harness/process-store.ts'
import { ProcessSupervisor } from '../pi-harness/process-supervisor.ts'
import { createManagedSession } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

const RECORD_BASE = {
  executionId: 'e', semanticId: 'shell', pid: null, deadlineAt: 0,
  exitCode: null, signal: null, pidStartMarker: null,
  profile: 'workspace' as never, isolationProfile: 'none',
  environmentProfile: 'workspace' as never, environmentDigest: 'd', cwd: '/tmp',
}

/**
 * A real supervisor over a real store: the under-count lives inside `snapshot`'s
 * sort-then-slice and a mocked supervisor cannot reproduce it.
 */
async function realSupervisor(root: string): Promise<ProcessSupervisor> {
  const store = new ProcessStore({ root })
  return new ProcessSupervisor({
    store,
    graceMs: 20,
    resolveIsolation: (input: { command: string; args: readonly string[]; profile: string }) => ({
      command: input.command, args: input.args, backend: 'test', profile: input.profile,
    }) as never,
  })
}

async function seed121(supervisor: ProcessSupervisor, sessionKey: { workspaceId: string; sessionId: string }): Promise<void> {
  const store = (supervisor as unknown as { options: { store: ProcessStore } }).options.store
  // The OLDEST record is the only live one — the slice's blind spot.
  await store.create({ ...RECORD_BASE, sessionKey, startedAt: 1, status: 'running' })
  for (let index = 0; index < 120; index++) {
    await store.create({ ...RECORD_BASE, sessionKey, startedAt: 1000 + index, status: 'exited' })
  }
}

/**
 * A real manager reduced to what `strictDrainPiSessionOwned` actually reads —
 * this suite's established shape for exercising one private
 * (`SessionManager.live-agent-ceiling.test.ts` does the same).
 */
function drainManager(options: {
  supervisor: ProcessSupervisor
  dispose: (calls: string[]) => Promise<void>
}): { manager: any; calls: string[]; managed: ReturnType<typeof createManagedSession> } {
  const calls: string[] = []
  const manager = createTestSessionManager() as any
  manager.piProcessSupervisor = new Proxy(options.supervisor, {
    get(target, property, receiver) {
      if (property === 'countActive' || property === 'snapshot') {
        calls.push(String(property))
      }
      return Reflect.get(target, property, receiver)
    },
  })
  manager.piWorktreeLeaseServices = new Map()
  manager.piChildSessionServices = new Map()
  manager.piChildRuns = new Map()
  manager.piAskUserServices = new Map()
  manager.disposeManagedAgentRuntime = async () => {
    calls.push('dispose')
    await options.dispose(calls)
  }
  manager.disposePiLspServices = async () => { calls.push('lsp') }
  manager.setProcessing = () => { calls.push('setProcessing') }
  manager.persistSession = () => { calls.push('persist') }
  manager.flushSession = async () => { calls.push('flush') }
  manager.clearPendingPermissionRequestsForSession = () => { calls.push('clearPending') }
  const managed = createManagedSession(
    { id: 'busy', name: 'busy' },
    { id: 'ws', name: 'ws', rootPath: '/tmp', createdAt: 1 } as never,
    { messagesLoaded: true },
  )
  manager.sessions = new Map([['ws:busy', managed]])
  return { manager, calls, managed }
}

describe('P2.210 · the strict Pi drain residual sweep', () => {
  test('the upstream uncapped drain fails closed over the record a capped read misses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p210-upstream-'))
    try {
      const supervisor = await realSupervisor(root)
      const sessionKey = { workspaceId: 'ws', sessionId: 'busy' }
      await seed121(supervisor, sessionKey)

      // Positive control: the rig really holds the 121 records, and the capped
      // read really does miss the live one.
      const capped = (await supervisor.snapshot(sessionKey, { limit: 100 }))
        .filter(process => process.status === 'running' || process.status === 'lost').length
      expect(capped).toBe(0)
      expect(await supervisor.countActive(sessionKey)).toBe(1)

      // THE DEPENDENCY: `disposeManagedAgentRuntime`'s own drain reads the store
      // with no limit, so it sees what the slice cannot and refuses.
      await expect(supervisor.drainSession(sessionKey)).rejects.toThrow('process-session-drain-failed')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('runs the dispose BEFORE the residual sweep, and stops there when it throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p210-order-'))
    try {
      const supervisor = await realSupervisor(root)
      await seed121(supervisor, { workspaceId: 'ws', sessionId: 'busy' })
      const { manager, calls, managed } = drainManager({
        supervisor,
        dispose: async () => { throw new AggregateError([new Error('process-session-drain-failed:h1')], 'dispose-failed') },
      })

      const failure = await manager.strictDrainPiSessionOwned(managed, 'test', true)
        .then(() => undefined, (error: unknown) => error) as Error
      // Every failure leaves this method wrapped as `pi-session-drain-failed:<reason>`
      // with the real one on `cause`, so the assertion reads the cause: a test
      // that stopped at the wrapper would pass for the residual sweep too.
      expect(failure.message).toBe('pi-session-drain-failed:test')
      expect((failure.cause as Error).message).toBe('dispose-failed')
      // Order, and the consequence of it: the sweep never ran, because the
      // upstream had already failed the operation.
      expect(calls).toEqual(['dispose'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('names the residual the cap hid, with the upstream check removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p210-sweep-'))
    try {
      const supervisor = await realSupervisor(root)
      await seed121(supervisor, { workspaceId: 'ws', sessionId: 'busy' })
      // The upstream is neutralised — exactly the world P2.210 warns about, where
      // the ordering has moved or been relaxed. The sweep is now the only thing
      // between a live process and a "drained" session.
      const { manager, calls, managed } = drainManager({ supervisor, dispose: async () => {} })

      const failure = await manager.strictDrainPiSessionOwned(managed, 'test', true)
        .then(() => undefined, (error: unknown) => error)

      const aggregate = (failure as Error).cause as AggregateError
      expect(aggregate).toBeInstanceOf(AggregateError)
      expect(aggregate.message).toBe('pi-session-drain-failed')
      // The capped snapshot could name nothing, so the shortfall is named as a
      // shortfall instead of being dropped: one active record, zero named.
      expect((aggregate.errors as Error[]).map(error => error.message))
        .toEqual(['pi-session-process-residual:unnamed:1'])
      expect(calls).toContain('countActive')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('names a residual handle when the snapshot can see it, and stays silent on a clean store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p210-named-'))
    try {
      const supervisor = await realSupervisor(root)
      const store = (supervisor as unknown as { options: { store: ProcessStore } }).options.store
      const sessionKey = { workspaceId: 'ws', sessionId: 'busy' }
      const record = await store.create({ ...RECORD_BASE, sessionKey, startedAt: 1, status: 'running' })

      const dirty = drainManager({ supervisor, dispose: async () => {} })
      const failure = await dirty.manager.strictDrainPiSessionOwned(dirty.managed, 'test', true)
        .then(() => undefined, (error: unknown) => error)
      expect((((failure as Error).cause as AggregateError).errors as Error[]).map(error => error.message))
        .toEqual([`pi-session-process-residual:${record.handle}:running`])

      // Clean store, same rig: no residual, and the snapshot is not even taken.
      // `exited` is how a record leaves the active set — the store has no delete.
      await store.update(record.handle, { status: 'exited' })
      const clean = drainManager({ supervisor, dispose: async () => {} })
      await clean.manager.strictDrainPiSessionOwned(clean.managed, 'test', true)
      expect(clean.calls).toContain('countActive')
      expect(clean.calls).not.toContain('snapshot')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

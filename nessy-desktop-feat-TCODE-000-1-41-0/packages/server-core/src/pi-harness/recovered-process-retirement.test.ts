/**
 * D1.345 — the reaper's own read stops counting a process that is provably gone.
 *
 * ## The hole
 *
 * `countActive` counts `running || lost`, `SessionManager.liveAgentBusyDomainsFor`
 * reads that as the `process` domain, and nothing re-checked pid identity except
 * `read()` and `stopRecovered` — both of which need a USER to ask about that
 * handle. So a record a previous host process left `running` for a shell that
 * has since ended pinned its session busy for ever: the reaper never fired for
 * it, the ceiling never chose it, and no surface said why. D1.339's startup pass
 * retires one such record once per host process and no other time.
 *
 * ## Real pids, because that is the whole question
 *
 * The liveness arms use REAL children and the host's own `readPidStartMarker`,
 * so what is measured is the actual pid-identity comparison rather than a stub's
 * opinion of it. The two arms that cannot be produced with a real process — a
 * record with no marker stamped, and a handle this supervisor is holding right
 * now — are arranged directly, and each is a case the predicate must DECLINE.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProcessStore, type StoredProcess } from './process-store.ts'
import { ProcessSupervisor, readPidStartMarker } from './process-supervisor.ts'

const OWNER = { workspaceId: 'w-d1345', sessionId: 's-d1345' }
const roots: string[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) { try { child.kill('SIGKILL') } catch { /* already gone */ } }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function rig(): Promise<{ store: ProcessStore; supervisor: ProcessSupervisor; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'nessy-d1345-'))
  roots.push(root)
  const store = new ProcessStore({ root })
  return { store, supervisor: new ProcessSupervisor({ store }), root }
}

async function seed(
  store: ProcessStore,
  root: string,
  overrides: Partial<StoredProcess> & { status?: StoredProcess['status'] } = {},
): Promise<StoredProcess> {
  return await store.create({
    sessionKey: OWNER,
    executionId: `e-${Math.random().toString(36).slice(2)}`,
    semanticId: 'bash_background',
    command: 'sleep 900',
    pid: null,
    startedAt: 1,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    status: 'running',
    exitCode: null,
    signal: null,
    pidStartMarker: null,
    profile: 'workspace',
    isolationProfile: 'workspace:test',
    environmentProfile: 'restricted',
    environmentDigest: 'digest',
    cwd: root,
    ...overrides,
  } as Parameters<ProcessStore['create']>[0])
}

function startChild(): ChildProcess {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  children.push(child)
  return child
}

describe.skipIf(process.platform === 'win32')('D1.345 · a provably dead pid stops pinning the session busy', () => {
  test('a DEAD pid is retired on the next read, and the session reads idle', async () => {
    const { store, supervisor, root } = await rig()
    const child = startChild()
    const pid = child.pid!
    const marker = await readPidStartMarker(pid)
    child.kill('SIGKILL')
    await once(child, 'exit')
    const record = await seed(store, root, { pid, pidStartMarker: marker })

    // The state the row is about: before the read, the session is busy.
    expect((await store.get(record.handle)).status).toBe('running')

    expect(await supervisor.countActive(OWNER)).toBe(0)

    const retired = await store.get(record.handle)
    expect(retired.status).toBe('exited')
    // No code and no signal: this host did not observe the ending and must not
    // invent one. `lost` would have been the wrong word — `countActive` counts
    // it, which is the pin this row removes.
    expect([retired.exitCode, retired.signal]).toEqual([null, null])
    // And it stays retired: the second read costs no probe and answers the same.
    expect(await supervisor.countActive(OWNER)).toBe(0)
  })

  test('a LIVE pid is untouched — the direction that never evicts live work', async () => {
    const { store, supervisor, root } = await rig()
    const pid = startChild().pid!
    const record = await seed(store, root, { pid, pidStartMarker: await readPidStartMarker(pid) })

    expect(await supervisor.countActive(OWNER)).toBe(1)
    expect((await store.get(record.handle)).status).toBe('running')
  })

  test('a record with NO marker stamped is untouched — "could not find out" is not a yes', async () => {
    const { store, supervisor, root } = await rig()
    // A pid this host cannot vouch for: the window between spawn and the marker
    // write, a record written before the field existed, and every Windows
    // record. Rounding it down to gone is the direction that evicts live work.
    const record = await seed(store, root, { pid: startChild().pid!, pidStartMarker: null })

    expect(await supervisor.countActive(OWNER)).toBe(1)
    expect((await store.get(record.handle)).status).toBe('running')
  })

  test('a LOST record with a dead pid is retired too — that is the half `lost` could never answer', async () => {
    const { store, supervisor, root } = await rig()
    const child = startChild()
    const pid = child.pid!
    const marker = await readPidStartMarker(pid)
    child.kill('SIGKILL')
    await once(child, 'exit')
    const record = await seed(store, root, { pid, pidStartMarker: marker })
    await store.update(record.handle, { status: 'lost' })

    expect(await supervisor.countActive(OWNER)).toBe(0)
    expect((await store.get(record.handle)).status).toBe('exited')
  })

  test('a LOST record this host cannot ask about still counts, exactly as before', async () => {
    const { store, supervisor, root } = await rig()
    const record = await seed(store, root, { pid: null, pidStartMarker: null })
    await store.update(record.handle, { status: 'lost' })

    expect(await supervisor.countActive(OWNER)).toBe(1)
    expect((await store.get(record.handle)).status).toBe('lost')
  })

  test('a handle THIS supervisor is holding is never probed', async () => {
    // The skip is a cost decision with a correctness side: `countActive` runs on
    // the ceiling and reaper paths, and a live child's liveness is not a
    // question for `ps`. The probe is counted rather than inferred, and the
    // entry in `children` is the production state (a handle this supervisor
    // started and has not yet reaped), planted because starting a real child
    // through `start()` would measure the spawn path and not this one.
    const root = await mkdtemp(join(tmpdir(), 'nessy-d1345-owned-'))
    roots.push(root)
    const store = new ProcessStore({ root })
    const asked: number[] = []
    const supervisor = new ProcessSupervisor({
      store,
      readPidStartMarker: async (pid: number) => { asked.push(pid); return 'a different marker' },
    })
    const record = await seed(store, root, { pid: 424242, pidStartMarker: 'the stamped marker' })
    ;(supervisor as unknown as { children: Map<string, unknown> }).children.set(record.handle, {})

    expect(await supervisor.countActive(OWNER)).toBe(1)
    expect(asked).toEqual([])
    expect((await store.get(record.handle)).status).toBe('running')
  })

  test('another session\'s dead record is none of this session\'s business', async () => {
    const { store, supervisor, root } = await rig()
    const child = startChild()
    const pid = child.pid!
    const marker = await readPidStartMarker(pid)
    child.kill('SIGKILL')
    await once(child, 'exit')
    const foreign = await store.create({
      sessionKey: { workspaceId: 'w-other', sessionId: 's-other' },
      executionId: 'e-foreign', semanticId: 'bash_background', command: 'sleep 900',
      pid, startedAt: 1, deadlineAt: Number.MAX_SAFE_INTEGER, status: 'running',
      exitCode: null, signal: null, pidStartMarker: marker,
      profile: 'workspace', isolationProfile: 'workspace:test',
      environmentProfile: 'restricted', environmentDigest: 'digest', cwd: root,
    })

    expect(await supervisor.countActive(OWNER)).toBe(0)
    // `countActive` is scoped to one session and must not retire a record it was
    // never asked about; the owner's own read is what retires it.
    expect((await store.get(foreign.handle)).status).toBe('running')
  })
})

/**
 * D1.339 — a background shell a PREVIOUS host process left running is visible
 * to the product again after a restart.
 *
 * ## The reading this file exists for
 *
 * RS-61, on the packaged 1.40.0 (SIT-5d): a `bash_background` `sleep 900` was
 * planted through the Pi card and reported `running` in that host process; after
 * a `kill -9` and a relaunch on the same config dir, the store still read
 * `status: "running"` with a live pid, its `.running/` index entry present and
 * the process alive in `ps` — while `listSessionScheduledWork`, the one read
 * behind `ActiveTasksBar`, `useSessionScheduledWork` and the `/tasks` transcript
 * row, answered `[]` both cold and after the session had been opened.
 *
 * So the store half was never the defect. `backgroundShellCommands` is a RUNTIME
 * map, and the only thing that filled it from disk ran at cold AGENT start —
 * i.e. on the first turn of the session, long after the panel has drawn.
 *
 * ## What is real here and what is not
 *
 * Everything the row is about is real: a real `ProcessStore` under a real config
 * dir, real records written by `create` (so the real `.running` marker index is
 * built the way the supervisor builds it), REAL pids from real children, the
 * host's own `readPidStartMarker` stamping the records, the real
 * `adoptRestoredSupervisedShells` pass, and the real
 * `listSessionScheduledWork` → `buildHookTaskRegistryPort` →
 * `projectBackgroundTasks` chain for the answer. Nothing about the liveness
 * decision is stubbed, because a stub of it would measure the wiring and not the
 * posture — the shape AGENTS.md §Traps records as "a lever whose only test stubs
 * the path the lever changes".
 *
 * The BEFORE assertion in the first case is the mutant control that belongs in
 * the file: the same session, the same call, the same instrument, answering `[]`
 * until the pass runs. Removing the pass makes the AFTER assertion fail with the
 * before/after pair still visible — measured by reverting the one line in
 * `loadSessionsFromDisk` (see the report).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import type { ProcessStore, StoredProcess } from '../../pi-harness/process-store.ts'
import { readPidStartMarker } from '../../pi-harness/process-supervisor.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE = 'workspace-restored-shell'
/**
 * A FRESH session id per case. The process store is one directory for the whole
 * app — `listRunningRecords` walks it app-wide, which is the point — and this
 * file deliberately leaves `running` records behind (the "cannot ask" case must
 * not retire one). Reusing one id made each case read the previous case's
 * records as its own; a fresh id makes every leftover somebody else's, which is
 * also the state the foreign-owner case asserts on purpose.
 */
let SESSION = 'session-restored-shell'

/** Every child this file starts, so none outlives the run. */
const children: ChildProcess[] = []

function startChild(): ChildProcess {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  children.push(child)
  return child
}

describe.skipIf(process.platform === 'win32')('D1.339 · a restart does not hide a running background shell', () => {
  let root: string
  let manager: ReturnType<typeof createTestSessionManager>
  let store: ProcessStore
  let managed: any

  const seed = async (overrides: Partial<Parameters<ProcessStore['create']>[0]> = {}): Promise<StoredProcess> =>
    await store.create({
      sessionKey: { workspaceId: WORKSPACE, sessionId: SESSION },
      executionId: `exec-${Math.random().toString(36).slice(2)}`,
      semanticId: 'bash_background',
      command: 'sleep 900',
      pid: null,
      startedAt: Date.now(),
      deadlineAt: Number.MAX_SAFE_INTEGER,
      status: 'running',
      exitCode: null,
      signal: null,
      pidStartMarker: null,
      profile: 'workspace',
      isolationProfile: 'workspace:seatbelt',
      environmentProfile: 'restricted',
      environmentDigest: 'digest',
      cwd: root,
      ...overrides,
    } as Parameters<ProcessStore['create']>[0])

  /** The product's own read — the exact call RS-61 drove through the RPC. */
  const tasks = () =>
    (manager as any).listSessionScheduledWork(SESSION, WORKSPACE)?.tasks ?? []

  beforeEach(() => {
    SESSION = `session-restored-shell-${Math.random().toString(36).slice(2)}`
    root = mkdtempSync(join(tmpdir(), 'restored-shell-adoption-'))
    manager = createTestSessionManager()
    store = (manager as any).piProcessStore
    // A session restored by a NEW host process: metadata in the map, the
    // registry maps empty, no agent. Exactly `createManagedSession`'s shape for
    // a session loaded from disk.
    managed = {
      id: SESSION,
      workspace: { id: WORKSPACE, rootPath: root },
      messagesLoaded: true,
      messages: [],
      agent: null,
      backgroundShellCommands: new Map<string, string>(),
      backgroundTaskOutputs: new Map(),
      piBackgroundTaskKinds: new Map(),
      childSessionState: undefined,
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: WORKSPACE, sessionId: SESSION }), managed)
  })

  afterEach(() => {
    for (const child of children.splice(0)) { try { child.kill('SIGKILL') } catch { /* already gone */ } }
    rmSync(root, { recursive: true, force: true })
  })

  test('a record left `running` by a previous process, whose pid is ALIVE, is listed as running', async () => {
    const child = startChild()
    const pid = child.pid!
    const record = await seed({ pid, pidStartMarker: await readPidStartMarker(pid) })

    // The defect, in one line and through the product's own read.
    expect(tasks()).toEqual([])

    await (manager as any).adoptRestoredSupervisedShells()

    expect(tasks()).toEqual([{
      id: record.handle,
      type: 'shell',
      status: 'running',
      description: 'sleep 900',
      command: 'sleep 900',
    }])
  })

  test('a record left `running` whose process is GONE is never reported as running, and the store says lost', async () => {
    // The opposite lie, and the harder one to notice: nothing moves a record
    // when the shell exits while the app is not running, so `running` on disk is
    // only what the previous process last wrote.
    const child = startChild()
    const pid = child.pid!
    const marker = await readPidStartMarker(pid)
    child.kill('SIGKILL')
    await once(child, 'exit')
    const record = await seed({ pid, pidStartMarker: marker })

    await (manager as any).adoptRestoredSupervisedShells()

    expect(tasks()).toEqual([])
    // Reported as such rather than dropped in silence. D1.345 — and the word is
    // `exited` with NO code and NO signal, not `lost`: `lost` is the host's word
    // for "cannot say whether it is alive" and `countActive` counts it as active
    // for that reason, so writing it for something just PROVEN gone would leave
    // the session pinned busy on the strength of an answer we have. The write
    // also retires the `.running` marker, so the settlement stops counting it.
    const retired = await store.get(record.handle)
    expect(retired.status).toBe('exited')
    expect([retired.exitCode, retired.signal]).toEqual([null, null])
  })

  test('a record this host cannot ask about is adopted, not retired — "could not find out" is not a yes', async () => {
    // No pid and no marker is the pre-marker record shape and every Windows
    // record. Rounding it down to gone is the direction that hides live work.
    const record = await seed({ pid: null, pidStartMarker: null })

    await (manager as any).adoptRestoredSupervisedShells()

    expect(tasks().map((task: { id: string }) => task.id)).toEqual([record.handle])
    expect((await store.get(record.handle)).status).toBe('running')
  })

  test('a running record owned by a session this host did not restore is left alone', async () => {
    const child = startChild()
    const pid = child.pid!
    const foreign = await store.create({
      sessionKey: { workspaceId: 'workspace-somebody-else', sessionId: 'session-somebody-else' },
      executionId: 'exec-foreign', semanticId: 'bash_background', command: 'sleep 900',
      pid, startedAt: Date.now(), deadlineAt: Number.MAX_SAFE_INTEGER, status: 'running',
      exitCode: null, signal: null, pidStartMarker: await readPidStartMarker(pid),
      profile: 'workspace', isolationProfile: 'workspace:seatbelt',
      environmentProfile: 'restricted', environmentDigest: 'digest', cwd: root,
    })

    await (manager as any).adoptRestoredSupervisedShells()

    expect(tasks()).toEqual([])
    expect(managed.backgroundShellCommands.size).toBe(0)
    // And it is not retired either: another owner's live record is none of this
    // host's business, and inventing a home for it is how a phantom row appears.
    expect((await store.get(foreign.handle)).status).toBe('running')
  })

  test('an LSP record is not background work the session is waiting on', async () => {
    const child = startChild()
    const pid = child.pid!
    await seed({ semanticId: 'lsp', command: 'typescript-language-server --stdio', pid, pidStartMarker: await readPidStartMarker(pid) })

    await (manager as any).adoptRestoredSupervisedShells()

    expect(tasks()).toEqual([])
  })

  test('the pass runs from `loadSessionsFromDisk`, AFTER the session map is populated', async () => {
    // The whole of the defect was WHEN, not whether: the adopter existed and ran
    // at cold AGENT start, i.e. on the first turn. So this drives the real
    // startup path end to end and reads the ordering off it — a pass that ran
    // before the map was filled would find no owner for any record.
    const child = startChild()
    const pid = child.pid!
    const record = await seed({ pid, pidStartMarker: await readPidStartMarker(pid) })
    ;(manager as any).sessions.clear()
    ;(manager as any).sessionMonitors = { list: () => [], sweepRestoredMonitors: async () => [] }
    ;(manager as any).listRuntimeWorkspaces = () => [{ id: WORKSPACE, rootPath: root }]
    ;(manager as any).sessionStore.list = () => [{ id: SESSION, workingDirectory: root }]

    const real = (manager as any).adoptRestoredSupervisedShells.bind(manager)
    let sessionsWhenCalled = -1
    let pass: Promise<void> | undefined
    ;(manager as any).adoptRestoredSupervisedShells = () => {
      sessionsWhenCalled = (manager as any).sessions.size
      pass = real()
      return pass
    }

    ;(manager as any).loadSessionsFromDisk()
    await pass

    expect(sessionsWhenCalled).toBe(1)
    expect(tasks().map((task: { id: string }) => task.id)).toEqual([record.handle])
  })
})

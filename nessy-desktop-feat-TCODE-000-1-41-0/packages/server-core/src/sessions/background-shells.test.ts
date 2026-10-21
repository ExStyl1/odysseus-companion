import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession, SessionManager } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('background shell tracking', () => {
  let tmpRoot: string
  let sm: SessionManager
  let children: ChildProcess[]
  let childrenByHandle: Map<string, ChildProcess>
  let stopCalls: Array<{ sessionKey: { workspaceId: string; sessionId: string }; handle: string }>

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-bg-shell-'))
    sm = createTestSessionManager()
    children = []
    childrenByHandle = new Map()
    stopCalls = []
    ;(sm as unknown as {
      piProcessSupervisor: {
        stop(request: { sessionKey: { workspaceId: string; sessionId: string }; handle: string }): Promise<void>
        drainSession(sessionKey: { workspaceId: string; sessionId: string }): Promise<readonly string[]>
        snapshot(
          sessionKey: { workspaceId: string; sessionId: string },
          options?: { limit?: number },
        ): Promise<readonly unknown[]>
        countActive(sessionKey: { workspaceId: string; sessionId: string }): Promise<number>
      }
    }).piProcessSupervisor = {
      drainSession: async () => [],
      snapshot: async () => [],
      // P2.210 — the strict drain's residual sweep counts here now, uncapped;
      // a stub without it makes the drain throw a TypeError instead of
      // answering "nothing left".
      countActive: async () => 0,
      stop: async request => {
        stopCalls.push(request)
        const child = childrenByHandle.get(request.handle)
        if (!child) throw new Error(`unexpected process handle: ${request.handle}`)
        if (child.exitCode !== null || child.signalCode !== null) return
        const exited = new Promise<void>((resolve, reject) => {
          child.once('exit', () => resolve())
          child.once('error', reject)
        })
        child.kill('SIGTERM')
        await exited
      },
    }
  })

  afterEach(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
      }
    }
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('killShell terminates a registered background shell command', async () => {
    const sessionId = 'session-bg-shell'
    const shellId = 'shell_bg_test'
    const scriptPath = join(tmpRoot, 'background-shell.js')
    writeFileSync(scriptPath, 'setInterval(() => {}, 1000)\n', 'utf-8')
    const child = spawn(process.execPath, [scriptPath], {
      cwd: tmpRoot,
      stdio: 'ignore',
    })
    children.push(child)
    childrenByHandle.set(shellId, child)

    const managed = createManagedSession(
      { id: sessionId, name: 'background shell' },
      {
        id: 'ws-test',
        name: 'Test Workspace',
        rootPath: tmpRoot,
        createdAt: Date.now(),
      } as never,
      { messagesLoaded: true },
    )
    managed.backgroundShellCommands.set(shellId, shellId)
    ;(sm as unknown as { sessions: Map<string, typeof managed> }).sessions.set(`${managed.workspace.id}:${sessionId}`, managed)

    const result = await sm.killShell(sessionId, shellId)

    expect(result.success).toBe(true)
    expect(stopCalls).toEqual([{
      sessionKey: { workspaceId: managed.workspace.id, sessionId },
      handle: shellId,
    }])
    expect(managed.backgroundShellCommands.has(shellId)).toBe(false)
    await waitFor(() => child?.exitCode !== null || child?.signalCode !== null)
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true)
  })

  it('deleteSession kills every registered background shell before removing the session', async () => {
    const sessionId = 'session-delete-bg-shells'
    const workspace = {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    } as never
    const managed = createManagedSession(
      { id: sessionId, name: 'delete background shells' },
      workspace,
      { messagesLoaded: true },
    )

    for (const suffix of ['one', 'two']) {
      const scriptPath = join(tmpRoot, `background-shell-${suffix}.js`)
      writeFileSync(scriptPath, 'setInterval(() => {}, 1000)\n', 'utf-8')
      const handle = `shell_${suffix}`
      const child = spawn(process.execPath, [scriptPath], {
        cwd: tmpRoot,
        stdio: 'ignore',
      })
      children.push(child)
      childrenByHandle.set(handle, child)
      managed.backgroundShellCommands.set(handle, handle)
    }

    ;(sm as unknown as { sessions: Map<string, typeof managed> }).sessions.set(`${managed.workspace.id}:${sessionId}`, managed)

    await sm.deleteSession(sessionId)

    expect(stopCalls).toEqual(['shell_one', 'shell_two'].map(handle => ({
      sessionKey: { workspaceId: 'ws-test', sessionId },
      handle,
    })))
    expect(managed.backgroundShellCommands.size).toBe(0)
    await waitFor(() => children.every(child => child.exitCode !== null || child.signalCode !== null))
    expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true)
  })
})

/**
 * L7 — a backgrounded shell now HAS an exit signal.
 *
 * These run against the REAL `ProcessSupervisor` and `ProcessStore` the manager
 * constructs, deliberately: the whole defect was that nothing was wired to the
 * supervisor's own change notification, so a test that called the private
 * reconciler directly would pass with the wiring absent.
 */
describe('background shell exit reconciliation (L7)', () => {
  let tmpRoot: string
  let sm: SessionManager
  let events: Array<Record<string, unknown>>
  let workspaceId: string
  let registered: string[]

  function register(sessionId: string): ReturnType<typeof createManagedSession> {
    const workspace = {
      id: workspaceId, name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now(),
    } as never
    const managed = createManagedSession({ id: sessionId, name: sessionId }, workspace, { messagesLoaded: true })
    ;(sm as unknown as { sessions: Map<string, typeof managed> }).sessions
      .set(encodeSessionKey({ workspaceId, sessionId }), managed)
    registered.push(sessionId)
    return managed
  }

  function sessionKeyOf(sessionId: string): { workspaceId: string; sessionId: string } {
    return { workspaceId, sessionId }
  }

  function supervisorOf(): {
    start(request: Record<string, unknown>): Promise<{ handle: string }>
    stop(request: { sessionKey: { workspaceId: string; sessionId: string }; handle: string }): Promise<void>
  } {
    return (sm as unknown as { piProcessSupervisor: never }).piProcessSupervisor
  }

  function killedShellIds(): string[] {
    return events.filter(event => event.type === 'shell_killed').map(event => String(event.shellId))
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-l7-shell-'))
    sm = createTestSessionManager()
    // The durable process store is shared by every manager in this process, so
    // a per-test workspace id is what keeps one test's records out of the next
    // test's session key.
    workspaceId = `ws-l7-${Math.random().toString(36).slice(2)}`
    registered = []
    // Captured by VALUE, not through the `events` binding: a previous test's
    // manager can still deliver a late `shell_killed` from its teardown drain,
    // and a sink closing over the mutable binding would push it into this
    // test's list. That is what made this suite flake one run in eight.
    const sink: Array<Record<string, unknown>> = []
    events = sink
    sm.setEventSink((_channel, _target, event) => { sink.push(event as Record<string, unknown>) })
  })

  afterEach(async () => {
    const supervisor = (sm as unknown as {
      piProcessSupervisor: { drainSession(key: unknown): Promise<unknown> }
    }).piProcessSupervisor
    for (const sessionId of registered) {
      await supervisor.drainSession(sessionKeyOf(sessionId)).catch(() => undefined)
    }
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  /**
   * A supervised process whose exit this test DECIDES, rather than races.
   *
   * `sentinel` is a path the child polls for; touching it ends the process. A
   * timed `setTimeout` child made the whole test a race against `start()`
   * returning and the handle reaching the map, and it lost that race about one
   * run in eight — the reconciliation would fire before the entry existed and
   * the assertion would blame the production code.
   */
  async function startSupervisedShell(
    sessionId: string,
    options: { sentinel?: string } = {},
  ): Promise<string> {
    const script = options.sentinel
      ? `const fs = require('node:fs')\n`
        + `setInterval(() => { if (fs.existsSync(${JSON.stringify(options.sentinel)})) process.exit(0) }, 20)\n`
      : 'setInterval(() => {}, 1000)\n'
    const scriptPath = join(tmpRoot, `${sessionId}-${Math.random().toString(36).slice(2)}.js`)
    writeFileSync(scriptPath, script, 'utf-8')
    const started = await supervisorOf().start({
      sessionKey: sessionKeyOf(sessionId),
      executionId: `exec-${Math.random().toString(36).slice(2)}`,
      semanticId: 'bash_background',
      command: process.execPath,
      args: [scriptPath],
      cwd: tmpRoot,
      workspaceRoot: tmpRoot,
      profile: 'workspace',
      background: true,
      timeoutMs: 30_000,
    })
    return started.handle
  }

  it('retires a shell that exits on its own and tells the renderer, while a live shell stays', async () => {
    const sessionId = 'session-exit'
    const managed = register(sessionId)

    // Two supervised shells on ONE session: one that ends by itself, and one
    // that is still running. The second is the control — if the reconciliation
    // were "clear the map when anything changes" rather than "retire what the
    // record proves ended", this assertion is what fails.
    const sentinel = join(tmpRoot, 'end-now')
    const liveHandle = await startSupervisedShell(sessionId)
    const endingHandle = await startSupervisedShell(sessionId, { sentinel })
    managed.backgroundShellCommands.set(liveHandle, 'tail -f live.log')
    managed.backgroundShellCommands.set(endingHandle, 'sleep 999')
    expect(managed.backgroundShellCommands.size).toBe(2)

    writeFileSync(sentinel, '', 'utf-8')
    await waitFor(() => !managed.backgroundShellCommands.has(endingHandle))

    expect(managed.backgroundShellCommands.has(endingHandle)).toBe(false)
    expect(managed.backgroundShellCommands.has(liveHandle)).toBe(true)
    expect(killedShellIds()).toEqual([endingHandle])
  }, 15_000)

  it('leaves a handle the supervisor never issued standing, however often processes change', async () => {
    const sessionId = 'session-exit'
    const managed = register(sessionId)

    // A shell id from some other runtime: this store has no record for it, and
    // "no record" is not proof of an exit. It must survive an unrelated
    // process's whole start/exit cycle on the same session.
    const sentinel = join(tmpRoot, 'end-now')
    managed.backgroundShellCommands.set('claude-task-abc', 'npm run dev')
    const endingHandle = await startSupervisedShell(sessionId, { sentinel })
    managed.backgroundShellCommands.set(endingHandle, 'sleep 999')

    writeFileSync(sentinel, '', 'utf-8')
    await waitFor(() => !managed.backgroundShellCommands.has(endingHandle))

    expect(managed.backgroundShellCommands.has(endingHandle)).toBe(false)
    expect(managed.backgroundShellCommands.get('claude-task-abc')).toBe('npm run dev')
    expect(killedShellIds()).toEqual([endingHandle])
  }, 15_000)

  /** Answer `assertOwner` from a fixed status map; anything absent throws, as the real store does. */
  function stubStore(statusByHandle: Record<string, string>): void {
    ;(sm as unknown as { piProcessStore: { assertOwner(key: unknown, handle: string): Promise<unknown> } })
      .piProcessStore = {
        assertOwner: async (_key, handle) => {
          const status = statusByHandle[handle]
          if (!status) throw new Error('invalid-process-handle')
          return { handle, status, semanticId: 'bash_background' }
        },
      }
  }

  function reconcile(managed: unknown): Promise<void> {
    return (sm as unknown as { reconcileEndedBackgroundShells(m: unknown): Promise<void> })
      .reconcileEndedBackgroundShells(managed)
  }

  /**
   * THE FLOOR, one row per status the store can hold, plus the two non-answers.
   *
   * Table-driven because the constant IS this row's safety boundary and a
   * mutation shrinking it to `['exited']` left the first version of this suite
   * entirely green — `stopped` and `timed-out` were pinned by nothing, and both
   * are live production terminals (`requestTimeout` writes `timed-out` when a
   * background shell outlives its deadline; `stopWithTerminal`/`drainSession`
   * write `stopped`). An unpinned floor value silently re-latches the session
   * the day someone edits the constant.
   */
  it('retires only the statuses that PROVE an ending, and leaves every other standing', async () => {
    const managed = register('session-floor')
    const rows: Array<readonly [handle: string, status: string, retired: boolean]> = [
      ['process_exited', 'exited', true],
      ['process_stopped', 'stopped', true],
      ['process_timedout', 'timed-out', true],
      // Not gone.
      ['process_running', 'running', false],
      // The supervisor's own word for "this host cannot say" — and
      // `liveAgentBusyDomainsFor` already counts it as an active process.
      ['process_lost', 'lost', false],
    ]
    for (const [handle] of rows) managed.backgroundShellCommands.set(handle, `cmd-${handle}`)
    // A sixth entry with NO record at all: not proof of an exit, only of an id
    // this store never issued. It must survive a sweep that retires three others.
    managed.backgroundShellCommands.set('claude-task-xyz', 'npm run dev')
    stubStore(Object.fromEntries(rows.map(([handle, status]) => [handle, status])))

    await reconcile(managed)

    for (const [handle, status, retired] of rows) {
      expect([status, managed.backgroundShellCommands.has(handle)]).toEqual([status, !retired])
    }
    expect(managed.backgroundShellCommands.get('claude-task-xyz')).toBe('npm run dev')
    expect(killedShellIds().sort()).toEqual(['process_exited', 'process_stopped', 'process_timedout'])
  })

  /**
   * BOTH kill loops, because there are two and only one used to be tested.
   *
   * The key list each drain iterates is a snapshot, and L7 made the map able to
   * shrink asynchronously underneath it. Without the guard `killShell` answers
   * "Unknown supervised process handle" for the retired entry and the drain
   * turns a FINISHED shell into a failed drain. The Pi arm is the likelier of
   * the two by its own comment — `disposeManagedAgentRuntime` has just drained
   * the supervisor, so every shell in the map has just produced the exit
   * notification whose reconciliation may still be in flight — and it was the
   * arm with no test at all: deleting its guard left the suite green.
   */
  for (const provider of ['anthropic', 'pi'] as const) {
    it(`a ${provider} drain survives an exit reconciliation landing inside its own kill loop`, async () => {
      const managed = register(`session-drain-race-${provider}`)
      managed.backgroundShellCommands.set('process_first', 'first')
      managed.backgroundShellCommands.set('process_second', 'second')
      const killed: string[] = []
      const manager = sm as unknown as {
        resolveManagedProvider(m: unknown): string
        disposeManagedAgentRuntime(...args: unknown[]): Promise<void>
        disposePiLspServices(key: string): Promise<void>
        killShell(sessionId: string, shellId: string, workspaceId?: string): Promise<{ success: boolean; error?: string }>
        strictDrainSessionForMutation(m: unknown, reason: string): Promise<void>
      }
      manager.resolveManagedProvider = () => provider
      manager.disposeManagedAgentRuntime = async () => { managed.agent = null }
      // Only the Pi arm reaches these; harmless on the other.
      manager.disposePiLspServices = async () => {}
      manager.killShell = async (_sessionId, shellId) => {
        if (!managed.backgroundShellCommands.delete(shellId)) {
          return { success: false, error: 'Unknown supervised process handle' }
        }
        killed.push(shellId)
        // The reconciliation lands here: the second shell's exit record arrives
        // while the loop is still awaiting the first kill.
        managed.backgroundShellCommands.delete('process_second')
        return { success: true }
      }

      await manager.strictDrainSessionForMutation(managed, 'test-drain')

      expect(killed).toEqual(['process_first'])
      expect(managed.backgroundShellCommands.size).toBe(0)
    })
  }

  it('leaves every record standing when the store read fails', async () => {
    const sessionId = 'session-store-error'
    const managed = register(sessionId)
    managed.backgroundShellCommands.set('process_unknowable', 'long build')
    ;(sm as unknown as { piProcessStore: { assertOwner(key: unknown, handle: string): Promise<unknown> } })
      .piProcessStore = {
        assertOwner: async () => { throw new Error('process-store-unavailable') },
      }

    await reconcile(managed)

    expect(managed.backgroundShellCommands.has('process_unknowable')).toBe(true)
    expect(killedShellIds()).toEqual([])
  })

  it('never retires another session\'s handle, even when that process has ended', async () => {
    // `assertOwner` is what enforces this, and it is the reason the sweep reads
    // one record per key instead of listing the store: the ownership check is
    // the store's, not ours, and a handle we do not own is not ours to retire.
    const managed = register('session-owner')
    managed.backgroundShellCommands.set('process_someone_else', 'their build')
    ;(sm as unknown as { piProcessStore: { assertOwner(key: unknown, handle: string): Promise<unknown> } })
      .piProcessStore = {
        assertOwner: async () => { throw new Error('process-handle-owner-mismatch') },
      }

    await reconcile(managed)

    expect(managed.backgroundShellCommands.has('process_someone_else')).toBe(true)
    expect(killedShellIds()).toEqual([])
  })
})

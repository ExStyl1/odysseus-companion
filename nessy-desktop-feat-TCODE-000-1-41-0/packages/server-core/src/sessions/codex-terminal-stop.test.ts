import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession, SessionManager } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

/**
 * P3.26 — the background-task chip's Stop, pressed on a CODEX background
 * terminal.
 *
 * Against the REAL `ProcessSupervisor` and `ProcessStore` the manager
 * constructs, deliberately: the whole defect was that Pi's store REJECTS a
 * codex handle outright (`validateHandle` tests `/^process_[0-9a-f]{32}$/` and
 * throws `invalid-process-handle`), so a stubbed supervisor that accepts any
 * string would pass with the defect fully present.
 *
 * MEASURED before the fix, with this rig: `killShell('4242')` returned
 * `{success:false, error:'invalid-process-handle'}`, the handle stayed in
 * `backgroundShellCommands`, no `shell_killed` was emitted — the renderer
 * showed the generic "Could not stop the task" toast, kept the row, and the
 * terminal kept running.
 */
describe('P3.26 · killShell routes a non-Pi handle to the backend that owns it', () => {
  let tmpRoot: string
  let sm: SessionManager
  let events: Array<Record<string, unknown>>
  let workspaceId: string

  function register(
    sessionId: string,
    options: { stopBackgroundTask?: (taskId: string) => Promise<{ stopped: boolean; error?: string }> } = {},
  ): ReturnType<typeof createManagedSession> {
    const workspace = {
      id: workspaceId, name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now(),
    } as never
    const managed = createManagedSession({ id: sessionId, name: sessionId }, workspace, { messagesLoaded: true })
    if (options.stopBackgroundTask) {
      ;(managed as unknown as { agent: unknown }).agent = {
        stopBackgroundTask: options.stopBackgroundTask,
      }
    }
    ;(sm as unknown as { sessions: Map<string, typeof managed> }).sessions
      .set(encodeSessionKey({ workspaceId, sessionId }), managed)
    return managed
  }

  function killedShellIds(): string[] {
    return events.filter(event => event.type === 'shell_killed').map(event => String(event.shellId))
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-p326-'))
    sm = createTestSessionManager()
    workspaceId = `ws-p326-${Math.random().toString(36).slice(2)}`
    const sink: Array<Record<string, unknown>> = []
    events = sink
    sm.setEventSink((_channel, _target, event) => { sink.push(event as Record<string, unknown>) })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('stops a codex background terminal the Pi store refuses to even name', async () => {
    const asked: string[] = []
    const managed = register('session-codex-terminal', {
      stopBackgroundTask: async taskId => { asked.push(taskId); return { stopped: true } },
    })
    // The id P3.3's synthesised `shell_backgrounded` registers for a codex
    // terminal: the app-server's `processId`, which the binary requires to be
    // digit-parseable.
    managed.backgroundShellCommands.set('4242', 'sleep 900')

    const result = await sm.killShell('session-codex-terminal', '4242', workspaceId)

    expect(result).toEqual({ success: true })
    // Verbatim — the id the chip carries is the id the backend's own lever takes.
    expect(asked).toEqual(['4242'])
    expect(managed.backgroundShellCommands.has('4242')).toBe(false)
    expect(killedShellIds()).toEqual(['4242'])
  })

  it('keeps the row when the backend refuses, instead of asserting a stop it did not make', async () => {
    const managed = register('session-codex-refused', {
      stopBackgroundTask: async () => ({ stopped: false, error: 'terminated:false' }),
    })
    managed.backgroundShellCommands.set('4243', 'sleep 900')

    const result = await sm.killShell('session-codex-refused', '4243', workspaceId)

    expect(result.success).toBe(false)
    expect(result.error).toBe('terminated:false')
    expect(managed.backgroundShellCommands.has('4243')).toBe(true)
    expect(killedShellIds()).toEqual([])
  })

  it('reports a throwing backend lever rather than falling through to a second mechanism', async () => {
    const managed = register('session-codex-threw', {
      stopBackgroundTask: async () => { throw new Error('app-server gone') },
    })
    managed.backgroundShellCommands.set('4244', 'sleep 900')

    const result = await sm.killShell('session-codex-threw', '4244', workspaceId)

    expect(result).toEqual({ success: false, error: 'app-server gone' })
    expect(managed.backgroundShellCommands.has('4244')).toBe(true)
    expect(killedShellIds()).toEqual([])
  })

  it('never diverts a PI-shaped handle to the backend, even when the backend has the lever', async () => {
    const asked: string[] = []
    const managed = register('session-pi-shell', {
      stopBackgroundTask: async taskId => { asked.push(taskId); return { stopped: true } },
    })
    // A well-formed Pi handle that no live process backs: the supervisor's own
    // ownership check must be what answers, not the codex lever.
    const piHandle = `process_${'a'.repeat(32)}`
    managed.backgroundShellCommands.set(piHandle, 'sleep 900')

    const result = await sm.killShell('session-pi-shell', piHandle, workspaceId)

    expect(asked).toEqual([])
    expect(result.success).toBe(false)
    expect(result.error).not.toBe('invalid-process-handle')
    expect(managed.backgroundShellCommands.has(piHandle)).toBe(true)
  })

  it('leaves a backend with no lever on the Pi path, which reports rather than pretends', async () => {
    const managed = register('session-no-lever')
    managed.backgroundShellCommands.set('4245', 'sleep 900')

    const result = await sm.killShell('session-no-lever', '4245', workspaceId)

    expect(result).toEqual({ success: false, error: 'invalid-process-handle' })
    expect(managed.backgroundShellCommands.has('4245')).toBe(true)
    expect(killedShellIds()).toEqual([])
  })
})

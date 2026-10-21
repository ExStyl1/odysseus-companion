import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProcessStore } from './process-store.ts'
import { ProcessSupervisor } from './process-supervisor.ts'

/**
 * R10 Bash auto-background: on timeout expiry a request that opted in with
 * `onTimeout: 'background'` transitions the supervised process to a background
 * task instead of SIGTERM-killing it. These tests run the REAL supervisor with
 * REAL spawned processes — the recurring defect in this series is a detach that
 * a unit performs on a mock while the real SIGTERM path still kills.
 */
describe('ProcessSupervisor auto-background on timeout', () => {
  const owner = { workspaceId: 'w', sessionId: 's' }

  function createSupervisor(root: string) {
    const store = new ProcessStore({ root: join(root, 'store') })
    const supervisor = new ProcessSupervisor({
      store,
      resolveIsolation: input => ({
        command: input.command,
        args: input.args,
        backend: 'test',
        profile: input.profile as Exclude<typeof input.profile, 'none'>,
      }),
    })
    return { store, supervisor }
  }

  const tickerArgs = [
    '-e',
    'let i=0;const t=setInterval(()=>{process.stdout.write(`tick-${i++}\\n`);if(i>=25){clearInterval(t);process.stdout.write("bg-done\\n")}},100)',
  ]

  test('timeout expiry transitions to background and the process KEEPS RUNNING', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-r10-transition-'))
    try {
      const { store, supervisor } = createSupervisor(root)
      const startedAt = Date.now()
      const result = await supervisor.start({
        sessionKey: owner,
        executionId: 'exec-transition',
        semanticId: 'bash',
        command: process.execPath,
        args: tickerArgs,
        cwd: root,
        workspaceRoot: root,
        profile: 'workspace',
        background: false,
        timeoutMs: 600,
        onTimeout: 'background',
      })
      // The await resolved at the timeout, NOT after the ~2.6s process lifetime.
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      expect(result.movedToBackground).toBe(true)
      expect(result.isRunning).toBe(true)
      expect(result.outputFile).toBe(join(root, 'store', `${result.handle}.log`))

      const record = await store.get(result.handle)
      expect(record.status).toBe('running')

      // THE keeps-running proof: output grows AFTER the tool-call await returned.
      const cursorAtReturn = result.nextCursor
      let grown = false
      for (let attempt = 0; attempt < 40 && !grown; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 100))
        const read = await supervisor.read({ sessionKey: owner, handle: result.handle, cursor: cursorAtReturn })
        grown = read.nextCursor > cursorAtReturn && read.output.length > 0
      }
      expect(grown).toBe(true)

      // ... and the command runs to completion instead of being killed later.
      const final = await supervisor.waitAndRead(owner, result.handle)
      expect(final.isRunning).toBe(false)
      expect(final.exitCode).toBe(0)
      expect(final.signal).toBeNull()
      expect(final.output).toContain('bg-done')
      expect((await store.get(result.handle)).status).toBe('exited')
      // The log file on disk is the documented output handle.
      expect(await readFile(join(root, 'store', `${result.handle}.log`), 'utf8')).toContain('bg-done')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  test('without the opt-in, timeout expiry kills exactly as today', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-r10-kill-'))
    try {
      const { store, supervisor } = createSupervisor(root)
      const result = await supervisor.start({
        sessionKey: owner,
        executionId: 'exec-kill',
        semanticId: 'bash',
        command: process.execPath,
        args: ['-e', 'setTimeout(()=>{},60_000)'],
        cwd: root,
        workspaceRoot: root,
        profile: 'workspace',
        background: false,
        timeoutMs: 400,
      })
      expect(result.movedToBackground).toBeUndefined()
      expect(result.isRunning).toBe(false)
      expect(result.signal).toBe('SIGTERM')
      expect((await store.get(result.handle)).status).toBe('timed-out')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  test('session drain (dispose) reaps a transitioned background task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-r10-drain-'))
    try {
      const { store, supervisor } = createSupervisor(root)
      const result = await supervisor.start({
        sessionKey: owner,
        executionId: 'exec-drain',
        semanticId: 'bash',
        command: process.execPath,
        args: ['-e', 'setInterval(()=>process.stdout.write("alive\\n"),100)'],
        cwd: root,
        workspaceRoot: root,
        profile: 'workspace',
        background: false,
        timeoutMs: 400,
        onTimeout: 'background',
      })
      expect(result.movedToBackground).toBe(true)
      expect(result.isRunning).toBe(true)
      // Backgrounded tasks do not survive session exit: the session dispose
      // path (SessionManager -> piProcessSupervisor.drainSession) stops them.
      const drained = await supervisor.drainSession(owner)
      expect(drained).toContain(result.handle)
      expect((await store.get(result.handle)).status).toBe('stopped')
      expect((await store.list(owner)).filter(record => record.status === 'running')).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  test('stop() terminates a transitioned background task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-r10-stop-'))
    try {
      const { store, supervisor } = createSupervisor(root)
      const result = await supervisor.start({
        sessionKey: owner,
        executionId: 'exec-stop',
        semanticId: 'bash',
        command: process.execPath,
        args: ['-e', 'setInterval(()=>process.stdout.write("alive\\n"),100)'],
        cwd: root,
        workspaceRoot: root,
        profile: 'workspace',
        background: false,
        timeoutMs: 400,
        onTimeout: 'background',
      })
      expect(result.movedToBackground).toBe(true)
      expect(result.isRunning).toBe(true)
      await supervisor.stop({ sessionKey: owner, handle: result.handle })
      const record = await store.get(result.handle)
      expect(record.status).toBe('stopped')
      const final = await supervisor.read({ sessionKey: owner, handle: result.handle, cursor: 0 })
      expect(final.isRunning).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)
})

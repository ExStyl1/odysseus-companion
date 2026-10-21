import { describe, expect, test } from 'bun:test'
import type { SessionKey } from '@nessy-agent/shared/sessions/session-key'
import type { SupervisedProcessResult, SupervisedProcessStartRequest } from '@nessy-agent/shared/agent/pi-harness/process-supervisor-port'
import {
  BACKGROUND_TASK_DESCRIPTION_CAP,
  capBackgroundTaskDescription,
  MONITOR_MAX_WS_MESSAGE_BYTES,
  SessionMonitorService,
  type MonitorDelivery,
  type MonitorSocketHandlers,
} from './session-monitor-service.ts'

const sessionKey: SessionKey = { workspaceId: 'ws-1', sessionId: 'sess-1' }

interface FakeProcess {
  request: SupervisedProcessStartRequest
  emit(chunk: string): void
  close(exitCode: number | null, signal?: string | null): void
}

function fakeSupervisor() {
  const processes: FakeProcess[] = []
  const stopped: string[] = []
  let counter = 0
  return {
    processes,
    stopped,
    port: {
      async start(request: SupervisedProcessStartRequest): Promise<SupervisedProcessResult> {
        counter += 1
        const handle = `process_${counter}`
        processes.push({
          request,
          emit: chunk => request.onStdout?.(Buffer.from(chunk, 'utf8')),
          close: (exitCode, signal = null) => request.onClose?.(exitCode, signal),
        })
        return {
          handle,
          output: '',
          nextCursor: 0,
          isRunning: true,
          exitCode: null,
          signal: null,
          isolationProfile: 'workspace:test',
          environmentProfile: 'restricted' as const,
          environmentDigest: 'digest',
        }
      },
      async stop(request: { sessionKey: SessionKey; handle: string }) {
        stopped.push(request.handle)
      },
    },
  }
}

function service(overrides: Partial<ConstructorParameters<typeof SessionMonitorService>[0]> = {}) {
  const supervisor = fakeSupervisor()
  const delivered: MonitorDelivery[] = []
  const instance = new SessionMonitorService({
    processPort: supervisor.port,
    deliver: delivery => { delivered.push(delivery) },
    ...overrides,
  })
  return { instance, supervisor, delivered }
}

const start = (instance: SessionMonitorService, overrides: Record<string, unknown> = {}) => instance.start({
  sessionKey,
  cwd: '/tmp/workspace',
  workspaceRoot: '/tmp/workspace',
  description: 'watch the log',
  timeoutMs: 300_000,
  persistent: false,
  command: 'tail -f log',
  ...overrides,
})

describe('capBackgroundTaskDescription', () => {
  test('leaves a short description untouched', () => {
    expect(capBackgroundTaskDescription('short')).toBe('short')
  })

  test('caps at 1000 chars with an in-string dropped-count marker', () => {
    const capped = capBackgroundTaskDescription('x'.repeat(1500))
    expect(capped.length).toBe(BACKGROUND_TASK_DESCRIPTION_CAP)
    const match = capped.match(/… \[\+(\d+) chars\]$/)
    expect(match).not.toBeNull()
    const dropped = Number(match![1])
    expect(capped.length - match![0].length + dropped).toBe(1500)
  })
})

describe('the command source', () => {
  test('one event per stdout line, in order, and the registry entry is a monitor', async () => {
    const { instance, supervisor, delivered } = service()
    const result = await start(instance)

    expect(result.taskId).toBe('process_1')
    expect(result.timeoutMs).toBe(300_000)
    expect(supervisor.processes[0]?.request.semanticId).toBe('monitor')
    expect(supervisor.processes[0]?.request.background).toBe(true)
    // The script reaches a shell rather than becoming argv[0].
    expect(supervisor.processes[0]?.request.command).toBe('/bin/sh')
    expect(supervisor.processes[0]?.request.args).toEqual(['-lc', 'tail -f log'])

    const entries = instance.list(sessionKey)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: 'process_1', type: 'monitor', status: 'running', description: 'watch the log' })

    supervisor.processes[0]!.emit('first\nsecond\n')
    supervisor.processes[0]!.emit('thi')
    supervisor.processes[0]!.emit('rd\n')
    expect(delivered.map(event => event.text)).toEqual(['first', 'second', 'third'])
    expect(delivered.every(event => event.taskId === 'process_1')).toBe(true)
  })

  test('a partial final line still emits on exit, then the exit code ends the watch', async () => {
    const { instance, supervisor, delivered } = service()
    await start(instance)
    supervisor.processes[0]!.emit('done\npartial')
    supervisor.processes[0]!.close(3)

    expect(delivered.map(event => event.text)).toEqual(['done', 'partial', 'Monitor process_1 exited with code 3.'])
    expect(delivered.at(-1)?.terminal).toBe(true)
    expect(instance.list(sessionKey)).toEqual([])
  })

  test('events emitted before start resolves are delivered in order once the taskId is known', async () => {
    const supervisor = fakeSupervisor()
    const delivered: MonitorDelivery[] = []
    const instance = new SessionMonitorService({
      processPort: {
        async start(request) {
          request.onStdout?.(Buffer.from('early\n', 'utf8'))
          return supervisor.port.start(request)
        },
        stop: supervisor.port.stop,
      },
      deliver: delivery => { delivered.push(delivery) },
    })
    await start(instance)
    expect(delivered.map(event => event.text)).toEqual(['early'])
    expect(delivered[0]?.taskId).toBe('process_1')
  })

  test('a persistent watch asks the supervisor for no deadline and reports timeoutMs 0', async () => {
    const { instance, supervisor } = service()
    const result = await start(instance, { persistent: true })
    expect(result).toMatchObject({ timeoutMs: 0, persistent: true })
    expect(supervisor.processes[0]?.request.persistent).toBe(true)
  })

  test('the registry description is capped exactly once, where the entry is built', async () => {
    const { instance } = service()
    await start(instance, { description: 'y'.repeat(2000) })
    const entry = instance.list(sessionKey)[0]!
    expect(entry.description.length).toBe(BACKGROUND_TASK_DESCRIPTION_CAP)
    expect(capBackgroundTaskDescription(entry.description)).toBe(entry.description)
  })
})

describe('stopping', () => {
  test('stops an owned monitor through the owner-bound supervisor', async () => {
    const { instance, supervisor } = service()
    await start(instance)
    expect(await instance.stop(sessionKey, 'process_1')).toBe(true)
    expect(supervisor.stopped).toEqual(['process_1'])
    expect(instance.list(sessionKey)).toEqual([])
  })

  test('refuses a task owned by another session by not claiming it', async () => {
    const { instance, supervisor } = service()
    await start(instance)
    expect(await instance.stop({ workspaceId: 'ws-1', sessionId: 'other' }, 'process_1')).toBe(false)
    expect(supervisor.stopped).toEqual([])
    expect(instance.list(sessionKey)).toHaveLength(1)
  })
})

describe('resume', () => {
  test('never restores a monitor: a persisted running record is retired, not adopted', async () => {
    const updates: Array<{ handle: string; status: string }> = []
    const { instance } = service({
      processStore: {
        async list() {
          return [
            { handle: 'process_stale', semanticId: 'monitor', status: 'running' },
            { handle: 'process_shell', semanticId: 'bash_background', status: 'running' },
          ] as never
        },
        async update(handle: string, patch: { status?: string }) {
          updates.push({ handle, status: patch.status ?? '' })
          return undefined as never
        },
      },
    })

    const retired = await instance.sweepRestoredMonitors(sessionKey)
    // R10 extended the never-restore family: a running `bash_background`
    // record from a previous host is retired alongside the monitor instead of
    // being adopted (backgrounded tasks never survive session exit/resume).
    expect(retired).toEqual(['process_stale', 'process_shell'])
    expect(updates).toEqual([
      { handle: 'process_stale', status: 'stopped' },
      { handle: 'process_shell', status: 'stopped' },
    ])
    expect(instance.list(sessionKey)).toEqual([])
  })
})

describe('the ws source', () => {
  function wsService() {
    const supervisor = fakeSupervisor()
    const delivered: MonitorDelivery[] = []
    let captured: MonitorSocketHandlers | undefined
    let closed = 0
    const instance = new SessionMonitorService({
      processPort: supervisor.port,
      deliver: delivery => { delivered.push(delivery) },
      // Only the transport is faked. The frame handling under test is the
      // service's own, exactly as production hands it to a real socket.
      openSocket: async (_input, next) => {
        captured = next
        return { close: () => { closed += 1 } }
      },
    })
    const handlers = () => {
      if (!captured) throw new Error('no ws handlers captured')
      return captured
    }
    return { instance, delivered, handlers, closedCount: () => closed }
  }

  const startWs = (instance: SessionMonitorService, url = 'wss://events.example.test/s') => instance.start({
    sessionKey,
    cwd: '/tmp/workspace',
    workspaceRoot: '/tmp/workspace',
    description: 'watch the stream',
    timeoutMs: 300_000,
    persistent: false,
    ws: { url },
  })

  test('a text frame becomes one event and the entry names the server', async () => {
    const { instance, delivered, handlers } = wsService()
    const result = await startWs(instance)
    expect(result.taskId).toStartWith('monitor_ws_')
    expect(instance.list(sessionKey)[0]).toMatchObject({ type: 'monitor', server: 'events.example.test', tool: 'ws' })

    handlers().onText('one')
    handlers().onText('two')
    expect(delivered.map(event => event.text)).toEqual(['one', 'two'])
  })

  test('a binary frame becomes the documented placeholder with its byte count', async () => {
    const { instance, delivered, handlers } = wsService()
    await startWs(instance)
    handlers().onBinary(2048)
    expect(delivered.map(event => event.text)).toEqual(['[binary frame, 2048 bytes]'])
    expect(instance.list(sessionKey)).toHaveLength(1)
  })

  test('a message over 1 MiB ends the watch instead of being delivered', async () => {
    const { instance, delivered, handlers } = wsService()
    await startWs(instance)
    handlers().onText('x'.repeat(MONITOR_MAX_WS_MESSAGE_BYTES + 1))
    await Bun.sleep(0)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.text).toContain('exceeds')
    expect(delivered[0]?.terminal).toBe(true)
    expect(instance.list(sessionKey)).toEqual([])
  })

  test('an oversize BINARY frame ends the watch too, and delivers no placeholder', async () => {
    const { instance, delivered, handlers } = wsService()
    await startWs(instance)
    handlers().onBinary(MONITOR_MAX_WS_MESSAGE_BYTES + 1)
    await Bun.sleep(0)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.terminal).toBe(true)
    expect(instance.list(sessionKey)).toEqual([])
  })

  test('the close code is delivered and ends the watch, and an error surfaces before it', async () => {
    const { instance, delivered, handlers } = wsService()
    await startWs(instance)
    handlers().onError('connection reset')
    handlers().onClose(1006, 'abnormal')
    expect(delivered.map(event => event.text)).toEqual([
      expect.stringContaining('connection reset'),
      expect.stringContaining('1006'),
    ])
    expect(delivered.at(-1)?.terminal).toBe(true)
    expect(instance.list(sessionKey)).toEqual([])
  })

  test('stopping a ws watch closes the socket and does not touch the supervisor', async () => {
    const { instance, closedCount } = wsService()
    const { taskId } = await startWs(instance)
    expect(await instance.stop(sessionKey, taskId)).toBe(true)
    expect(closedCount()).toBe(1)
    expect(instance.list(sessionKey)).toEqual([])
  })

  test('the ws source is unavailable when the host injects no transport', async () => {
    const { instance } = service()
    await expect(startWs(instance)).rejects.toThrow('not available')
    expect(instance.list(sessionKey)).toEqual([])
  })
})

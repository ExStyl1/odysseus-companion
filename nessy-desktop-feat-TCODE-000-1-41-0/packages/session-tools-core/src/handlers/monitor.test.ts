import { describe, expect, test } from 'bun:test'
import type { MonitorStartInput, SessionMonitorPort, SessionToolContext } from '../context.ts'
import { handleMonitor, MONITOR_DEFAULT_TIMEOUT_MS, MONITOR_MAX_TIMEOUT_MS } from './monitor.ts'
import { handleProcessStop } from './process-stop.ts'

function context(overrides: Partial<SessionToolContext> = {}): SessionToolContext {
  return {
    configRoot: '/tmp/config',
    sessionId: 'session-1',
    workspacePath: '/tmp/workspace',
    sourcesPath: '/tmp/workspace/sources',
    skillsPath: '/tmp/workspace/skills',
    plansFolderPath: '/tmp/workspace/plans',
    callbacks: {} as SessionToolContext['callbacks'],
    fs: {} as SessionToolContext['fs'],
    loadSourceConfig: () => null,
    ...overrides,
  }
}

function recordingPort(): { port: SessionMonitorPort; started: MonitorStartInput[] } {
  const started: MonitorStartInput[] = []
  return {
    started,
    port: {
      async start(input) {
        started.push(input)
        return {
          taskId: `monitor_${started.length}`,
          timeoutMs: input.persistent ? 0 : input.timeoutMs,
          ...(input.persistent ? { persistent: true } : {}),
        }
      },
      async stop() {
        return false
      },
    },
  }
}

describe('handleMonitor input contract', () => {
  test('requires exactly one of command/ws', async () => {
    const { port, started } = recordingPort()
    const both = await handleMonitor(context({ monitor: port }), {
      command: 'tail -f log',
      ws: { url: 'wss://example.test' },
      description: 'both',
    })
    expect(both.isError).toBe(true)
    expect(both.content[0]?.text).toContain('exactly one')

    const neither = await handleMonitor(context({ monitor: port }), { description: 'neither' })
    expect(neither.isError).toBe(true)
    expect(neither.content[0]?.text).toContain('exactly one')
    expect(started).toEqual([])
  })

  test('requires a description', async () => {
    const { port, started } = recordingPort()
    const result = await handleMonitor(context({ monitor: port }), { command: 'tail -f log', description: '  ' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('description')
    expect(started).toEqual([])
  })

  test('defaults, clamps above the max, and reports 0 for a persistent watch', async () => {
    const { port, started } = recordingPort()

    const def = await handleMonitor(context({ monitor: port }), { command: 'a', description: 'd' })
    expect(started[0]?.timeoutMs).toBe(MONITOR_DEFAULT_TIMEOUT_MS)
    expect(def.structuredContent).toMatchObject({ taskId: 'monitor_1', timeoutMs: MONITOR_DEFAULT_TIMEOUT_MS })

    await handleMonitor(context({ monitor: port }), { command: 'a', description: 'd', timeout_ms: 9_999_999 })
    expect(started[1]?.timeoutMs).toBe(MONITOR_MAX_TIMEOUT_MS)

    const persistent = await handleMonitor(context({ monitor: port }), { command: 'a', description: 'd', persistent: true })
    expect(started[2]?.persistent).toBe(true)
    expect(persistent.structuredContent).toMatchObject({ taskId: 'monitor_3', timeoutMs: 0, persistent: true })
  })

  test('fails closed with no monitor port', async () => {
    const result = await handleMonitor(context(), { command: 'a', description: 'd' })
    expect(result.isError).toBe(true)
  })

  test('surfaces a denied start as an error with no partial success text', async () => {
    const port: SessionMonitorPort = {
      async start() { throw new Error('Monitor denied: deny Bash(curl *)') },
      async stop() { return false },
    }
    const result = await handleMonitor(context({ monitor: port }), { command: 'curl x', description: 'd' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('deny Bash(curl *)')
    expect(result.content[0]?.text).not.toContain('taskId')
  })
})

describe('ProcessStop is the one stop path for both producers', () => {
  test('stops a monitor by taskId on the same handler', async () => {
    const stopped: string[] = []
    const shells: string[] = []
    const result = await handleProcessStop(context({
      monitor: { async start() { throw new Error('unused') }, async stop(taskId) { stopped.push(taskId); return true } },
      stopBackgroundShell: async shellId => { shells.push(shellId) },
    }), { shell_id: ' monitor_1 ' })
    expect(stopped).toEqual(['monitor_1'])
    expect(shells).toEqual([])
    expect(result.isError).toBe(false)
  })

  test('falls through to the background shell when the id is not a monitor', async () => {
    const shells: string[] = []
    const result = await handleProcessStop(context({
      monitor: { async start() { throw new Error('unused') }, async stop() { return false } },
      stopBackgroundShell: async shellId => { shells.push(shellId) },
    }), { shell_id: 'process_1' })
    expect(shells).toEqual(['process_1'])
    expect(result.isError).toBe(false)
  })

  test('a cross-session handle is refused by the owner-bound host, not translated', async () => {
    const result = await handleProcessStop(context({
      monitor: { async start() { throw new Error('unused') }, async stop() { throw new Error('process-owner-mismatch') } },
      stopBackgroundShell: async () => { throw new Error('should not be reached') },
    }), { shell_id: 'monitor_other_session' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('process-owner-mismatch')
  })
})

import { describe, expect, test } from 'bun:test'
import type { SessionToolContext, SessionMonitorPort } from '../context.ts'
import { handleProcessStop } from './process-stop.ts'

function context(
  stopBackgroundShell?: SessionToolContext['stopBackgroundShell'],
  monitor?: SessionMonitorPort,
): SessionToolContext {
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
    stopBackgroundShell,
    monitor,
  }
}

describe('handleProcessStop', () => {
  test('stops only through the owner-bound host callback', async () => {
    const calls: string[] = []
    const result = await handleProcessStop(context(async shellId => { calls.push(shellId) }), {
      shell_id: ' process_123 ',
    })
    expect(calls).toEqual(['process_123'])
    expect(result.isError).toBe(false)
    expect(result.content[0]?.text).toContain('process_123')
  })

  test('fails closed when the callback or handle is unavailable', async () => {
    expect((await handleProcessStop(context(), { shell_id: 'process_123' })).isError).toBe(true)
    expect((await handleProcessStop(context(async () => {}), { shell_id: ' ' })).isError).toBe(true)
    expect((await handleProcessStop(context(async () => { throw new Error('unknown-process-handle') }), {
      shell_id: 'process_404',
    })).isError).toBe(true)
  })

  // P3.10 — the codex shape: the bridge binds `ctx.monitor` (so a persistent
  // watch is stoppable) but never `ctx.stopBackgroundShell` (a codex session
  // has no background-shell producer). The monitor half must work, and the
  // shell half must refuse recoverably rather than crash or pretend.
  describe('codex-shaped context (monitor bound, no background-shell binding)', () => {
    const monitorPort = (stoppable: Set<string>): SessionMonitorPort => ({
      start: async () => ({ taskId: 'unused', timeoutMs: 300_000 }),
      // A monitor taskId of this session stops; anything else is "not mine".
      stop: async taskId => stoppable.delete(taskId),
    })

    test('stops a monitor watch through the monitor half alone', async () => {
      const live = new Set(['monitor-9'])
      const result = await handleProcessStop(context(undefined, monitorPort(live)), {
        shell_id: ' monitor-9 ',
      })
      expect(result.isError).toBe(false)
      expect(result.content[0]?.text).toContain('Stopped monitor')
      expect(result.content[0]?.text).toContain('monitor-9')
      expect(live.size).toBe(0)
    })

    test('a non-monitor handle refuses recoverably — the shell half is not reachable', async () => {
      // `stopBackgroundShell` is undefined (codex), so a handle the monitor does
      // not own falls through to a recoverable "Unknown shell_id", never a crash
      // and never a false success.
      const result = await handleProcessStop(context(undefined, monitorPort(new Set())), {
        shell_id: 'shell_abc',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toContain('Unknown shell_id')
      expect(result.content[0]?.text).toContain('shell_abc')
    })
  })
})

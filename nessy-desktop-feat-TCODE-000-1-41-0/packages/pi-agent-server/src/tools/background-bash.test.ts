import { describe, expect, test } from 'bun:test'
import { createBackgroundBashTool } from './background-bash.ts'

describe('background bash tool', () => {
  test('uses the supervised host port and emits its opaque handle', async () => {
    const calls: unknown[] = []
    const events: unknown[] = []
    const tool = createBackgroundBashTool({
      emitEvent: event => events.push(event),
      async start(command, executionId) {
        calls.push({ command, executionId })
        // `environmentProfile`/`environmentDigest` became required on
        // `SupervisedProcessResult` and this fixture was never updated — the
        // sibling `harness/live-manifest-contract.test.ts` builds the same tool
        // with both, and stayed green because it was in the typecheck program.
        return { handle: 'process_0123456789abcdef0123456789abcdef', output: '', nextCursor: 0, isRunning: true, exitCode: null, signal: null, isolationProfile: 'workspace:test', environmentProfile: 'restricted', environmentDigest: 'digest' }
      },
    })
    const result = await tool.execute('tool-1', { command: 'printf ok' }, new AbortController().signal, undefined, {} as never)
    expect(calls).toEqual([{ command: 'printf ok', executionId: 'tool-1' }])
    expect(result.details?.shellId).toBe('process_0123456789abcdef0123456789abcdef')
    expect(result.details?.isolationProfile).toBe('workspace:test')
    expect(events).toHaveLength(1)
  })

  test('rejects empty and pre-aborted requests without reaching the host', async () => {
    let calls = 0
    const tool = createBackgroundBashTool({ emitEvent: () => {}, start: async () => { calls++; throw new Error('unreachable') } })
    expect((await tool.execute('a', { command: ' ' }, new AbortController().signal, undefined, {} as never)).details?.isError).toBe(true)
    const controller = new AbortController(); controller.abort()
    expect((await tool.execute('b', { command: 'echo' }, controller.signal, undefined, {} as never)).details?.isError).toBe(true)
    expect(calls).toBe(0)
  })
})

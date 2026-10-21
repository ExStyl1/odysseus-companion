import { describe, expect, jest, test } from 'bun:test'
import { BackgroundTaskRegistry } from './background-task-registry.ts'

describe('BackgroundTaskRegistry', () => {
  test('aborts evaluator before descendants and makes repeated stop idempotent', async () => {
    const registry = new BackgroundTaskRegistry()
    const controller = new AbortController()
    const order: string[] = []
    let settle!: () => void
    const settled = new Promise<void>(resolve => { settle = resolve })
    controller.signal.addEventListener('abort', () => order.push('evaluator'))
    registry.register({
      taskId: 'task-1',
      controller,
      stopDescendants: async () => { order.push('descendants') },
      settled: settled.then(() => { order.push('settled') }),
    })

    const firstStop = registry.stop('task-1')
    const concurrentStop = registry.stop('task-1')
    await Promise.resolve()
    expect(order).toEqual(['evaluator', 'descendants'])
    expect(registry.activeCount).toBe(1)
    settle()
    const [first, concurrent] = await Promise.all([firstStop, concurrentStop])
    expect(first).toBe(true)
    expect(concurrent).toBe(true)
    expect(order).toEqual(['evaluator', 'descendants', 'settled'])
    expect(registry.activeCount).toBe(0)
    expect(await registry.stop('task-1')).toBe(true)
  })

  test('drain awaits all evaluator settlements', async () => {
    const registry = new BackgroundTaskRegistry()
    const controllers = [new AbortController(), new AbortController()]
    const resolvers: Array<() => void> = []
    controllers.forEach((controller, index) => {
      const settled = new Promise<void>(resolve => { resolvers[index] = resolve })
      registry.register({ taskId: `task-${index}`, controller, settled })
    })

    let drained = false
    const drain = registry.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(controllers.every(controller => controller.signal.aborted)).toBe(true)
    expect(drained).toBe(false)
    resolvers.forEach(resolve => resolve())
    await drain
    expect(registry.activeCount).toBe(0)
  })

  test('retains a non-settling evaluator after stop timeout so a later stop can finish it', async () => {
    jest.useFakeTimers()
    const registry = new BackgroundTaskRegistry()
    let settle!: () => void
    const settled = new Promise<void>(resolve => { settle = resolve })
    let descendantStops = 0
    registry.register({
      taskId: 'task-timeout',
      controller: new AbortController(),
      stopDescendants: async () => { descendantStops += 1 },
      settled,
    })

    try {
      const firstStop = registry.stop('task-timeout')
      await Promise.resolve()
      await Promise.resolve()
      jest.advanceTimersByTime(10_000)
      await expect(firstStop).rejects.toThrow('background-task-stop-failed:task-timeout')
      expect(registry.activeCount).toBe(1)

      const retry = registry.stop('task-timeout')
      await Promise.resolve()
      expect(descendantStops).toBe(2)
      const drain = registry.drain()
      settle()
      await expect(Promise.all([retry, drain])).resolves.toEqual([true, undefined])
      expect(registry.activeCount).toBe(0)
    } finally {
      settle()
      jest.useRealTimers()
    }
  })

  test('cleans ownership when an evaluator settles without an explicit unregister', async () => {
    const registry = new BackgroundTaskRegistry()
    let settle!: () => void
    const settled = new Promise<void>(resolve => { settle = resolve })
    const unregister = registry.register({
      taskId: 'task-natural-settlement',
      controller: new AbortController(),
      settled,
    })
    expect(registry.activeCount).toBe(1)
    unregister()
    expect(registry.activeCount).toBe(1)

    settle()
    await settled
    await Promise.resolve()
    expect(registry.activeCount).toBe(0)
  })

  test('still awaits evaluator settlement when descendant stop fails', async () => {
    const registry = new BackgroundTaskRegistry()
    let settle!: () => void
    let settled = false
    const settlement = new Promise<void>(resolve => { settle = resolve }).then(() => { settled = true })
    registry.register({
      taskId: 'task-failure',
      controller: new AbortController(),
      stopDescendants: async () => { throw new Error('descendant-stop-failed') },
      settled: settlement,
    })
    const stopping = registry.stop('task-failure')
    await Promise.resolve()
    expect(settled).toBe(false)
    settle()
    await expect(stopping).rejects.toThrow('background-task-stop-failed:task-failure')
    expect(settled).toBe(true)
    expect(registry.activeCount).toBe(0)
  })

  test('aborts every evaluator during generation teardown', () => {
    const registry = new BackgroundTaskRegistry()
    const controllers = [new AbortController(), new AbortController()]
    controllers.forEach((controller, index) => registry.register({ taskId: `task-${index}`, controller }))
    registry.abortAll()
    expect(controllers.every(controller => controller.signal.aborted)).toBe(true)
  })
})

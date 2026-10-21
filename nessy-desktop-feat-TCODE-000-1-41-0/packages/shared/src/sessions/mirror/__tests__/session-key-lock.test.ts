/**
 * SessionKeyLock must be self-cleaning: a long-running host serializes mirror
 * work per session key, and settled tails must not accumulate one map entry
 * per historical session.
 */
import { describe, expect, it } from 'bun:test'

import { SessionKeyLock } from '../summary-fold.ts'

describe('SessionKeyLock', () => {
  it('a settled run leaves no tail entry', async () => {
    const lock = new SessionKeyLock()
    await lock.run('a', async () => 'done')
    // Cleanup rides the settle microtask; give it one tick.
    await Promise.resolve()
    expect(lock.size).toBe(0)

    // Rejected runs clean up the same way.
    await lock.run('a', async () => { throw new Error('boom') }).catch(() => {})
    await Promise.resolve()
    expect(lock.size).toBe(0)
  })

  it('keeps exactly the live tails while runs are pending and still serializes', async () => {
    const lock = new SessionKeyLock()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })

    const first = lock.run('a', async () => { await gate; order.push('first') })
    const second = lock.run('a', async () => { order.push('second') })
    expect(lock.size).toBe(1)

    release()
    await Promise.all([first, second])
    await Promise.resolve()
    expect(order).toEqual(['first', 'second'])
    expect(lock.size).toBe(0)
  })
})

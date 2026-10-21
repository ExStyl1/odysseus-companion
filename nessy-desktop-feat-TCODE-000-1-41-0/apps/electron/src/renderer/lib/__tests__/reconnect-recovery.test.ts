import { describe, it, expect } from 'bun:test'
import { createPiRuntimeInvalidationBuffer, getSessionsToRefreshAfterStaleReconnect } from '../reconnect-recovery'
import type { SessionMeta } from '@/atoms/sessions'

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: overrides.id ?? 'session',
    workspaceId: overrides.workspaceId ?? 'workspace',
    isProcessing: overrides.isProcessing ?? false,
    ...overrides,
  }
}

describe('getSessionsToRefreshAfterStaleReconnect', () => {
  it('includes the active session and all processing sessions', () => {
    const metaMap = new Map<string, SessionMeta>([
      ['active', meta({ id: 'active' })],
      ['processing', meta({ id: 'processing', isProcessing: true })],
      ['other', meta({ id: 'other' })],
    ])

    expect(getSessionsToRefreshAfterStaleReconnect(metaMap, 'active')).toEqual([
      'active',
      'processing',
    ])
  })

  it('deduplicates the active session when it is already processing', () => {
    const metaMap = new Map<string, SessionMeta>([
      ['active', meta({ id: 'active', isProcessing: true })],
    ])

    expect(getSessionsToRefreshAfterStaleReconnect(metaMap, 'active')).toEqual(['active'])
  })
})

describe('Pi runtime invalidation recovery', () => {
  it('coalesces invalidation during fetch and advances the returned barrier', async () => {
    let refetches = 0
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const buffer = createPiRuntimeInvalidationBuffer(async () => { refetches++; await pending; return 8 })
    buffer.push(3)
    buffer.push(6)
    buffer.installBarrier(4)
    await Promise.resolve()
    expect(refetches).toBe(1)
    buffer.push(7)
    release()
    await pending
    await Promise.resolve(); await Promise.resolve()
    expect(refetches).toBe(1)
  })

  it('does not loop after failure and retries only on a new invalidation', async () => {
    let refetches = 0
    const buffer = createPiRuntimeInvalidationBuffer(async () => { refetches++; throw new Error('offline') })
    buffer.installBarrier(1)
    buffer.push(2)
    await Promise.resolve(); await Promise.resolve()
    expect(refetches).toBe(1)
    await Promise.resolve(); expect(refetches).toBe(1)
    buffer.push(2)
    await Promise.resolve(); expect(refetches).toBe(1)
    buffer.push(3)
    await Promise.resolve(); await Promise.resolve()
    expect(refetches).toBe(2)
    buffer.dispose()
    buffer.push(4)
    await Promise.resolve()
    expect(refetches).toBe(2)
  })

  it('does not install a barrier when a stale reload returns no sequence', async () => {
    let refetches = 0
    const buffer = createPiRuntimeInvalidationBuffer(async () => { refetches++; return refetches === 1 ? undefined : 7 })
    buffer.installBarrier(4)
    buffer.push(5)
    await Promise.resolve(); await Promise.resolve()
    buffer.push(6)
    await Promise.resolve(); await Promise.resolve()
    expect(refetches).toBe(2)
  })

  it('starts a new sequence epoch and ignores the old in-flight completion', async () => {
    const releases: Array<(value: number) => void> = []
    let refetches = 0
    const buffer = createPiRuntimeInvalidationBuffer(() => {
      refetches++
      return new Promise<number>(resolve => releases.push(resolve))
    })
    buffer.installBarrier(100)
    buffer.push(101)
    await Promise.resolve()
    buffer.reset()
    buffer.installBarrier(1)
    buffer.push(2)
    await Promise.resolve()
    expect(refetches).toBe(2)
    releases[0]!(200)
    await Promise.resolve(); await Promise.resolve()
    releases[1]!(2)
    await Promise.resolve(); await Promise.resolve()
    buffer.push(3)
    await Promise.resolve()
    expect(refetches).toBe(3)
  })
})

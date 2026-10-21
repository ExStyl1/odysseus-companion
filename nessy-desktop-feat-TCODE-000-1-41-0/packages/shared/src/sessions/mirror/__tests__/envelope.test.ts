/**
 * The documented mirror failure envelope (agent-sdk/session-storage.md):
 * "If `append()` rejects, the SDK retries the batch up to two more times with
 * a short backoff, for at most three attempts in total. A call that times out
 * isn't retried, since the original call may still land. If the batch still
 * fails, the error is logged, a `{ type: "system", subtype: "mirror_error" }`
 * message is emitted into the iterator, the batch is dropped, and the query
 * continues."
 */
import { describe, expect, it } from 'bun:test'

import { appendWithEnvelope } from '../envelope.ts'
import type { MirrorEvent, MirrorSessionKey, SessionMirrorEntry } from '../types.ts'

const KEY: MirrorSessionKey = { workspaceId: 'ws-1', sessionId: 's-1' }
const ENTRIES: SessionMirrorEntry[] = [{ uuid: 'u-1', type: 'message' }]

function collector() {
  const events: MirrorEvent[] = []
  return { events, onEvent: (event: MirrorEvent) => { events.push(event) } }
}

describe('appendWithEnvelope', () => {
  it('retries a rejecting append with backoff, at most three attempts, then drops and emits mirror_error with the giving-up reason', async () => {
    let calls = 0
    const sleeps: number[] = []
    const { events, onEvent } = collector()
    const store = { append: async () => { calls++; throw new Error('mirror down') } }

    const delivered = await appendWithEnvelope(store, KEY, ENTRIES, {
      onEvent,
      backoffMs: 7,
      sleep: async ms => { sleeps.push(ms) },
    })

    expect(delivered).toBe(false)
    expect(calls).toBe(3)
    // "up to two more times with a short backoff"
    expect(sleeps).toEqual([7, 7])
    expect(events).toEqual([{
      type: 'system',
      subtype: 'mirror_error',
      key: KEY,
      reason: expect.stringContaining('mirror down') as unknown as string,
      attempts: 3,
      entryCount: 1,
    }])
  })

  it('a rejection that recovers within three attempts delivers silently', async () => {
    let calls = 0
    const { events, onEvent } = collector()
    const store = {
      append: async () => {
        calls++
        if (calls < 3) throw new Error('transient')
      },
    }

    const delivered = await appendWithEnvelope(store, KEY, ENTRIES, {
      onEvent,
      sleep: async () => {},
    })

    expect(delivered).toBe(true)
    expect(calls).toBe(3)
    expect(events).toEqual([])
  })

  it('a timed-out call is NOT retried: one attempt, drop, mirror_error', async () => {
    let calls = 0
    const { events, onEvent } = collector()
    // Never settles — the original call may still land, so no retry.
    const store = { append: () => { calls++; return new Promise<void>(() => {}) } }

    const delivered = await appendWithEnvelope(store, KEY, ENTRIES, {
      onEvent,
      timeoutMs: 5,
      sleep: async () => {},
    })

    expect(delivered).toBe(false)
    expect(calls).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0]!.attempts).toBe(1)
    expect(events[0]!.reason).toContain('timed out')
  })
})

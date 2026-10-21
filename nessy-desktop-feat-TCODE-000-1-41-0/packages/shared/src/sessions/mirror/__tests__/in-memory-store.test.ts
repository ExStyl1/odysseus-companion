/**
 * Store-side halves of the mirror contract (agent-sdk/session-storage.md):
 * uuid dedup ("Because a retried batch can re-deliver entries that already
 * landed, deduplicate by `entry.uuid` in your `append()` implementation"),
 * ordered deep-equal `load`, and the summary sidecar ("call `foldSessionSummary`
 * on each batch inside `append`. Skip batches whose key has a `subpath` …
 * The fold never sets `mtime`: stamp it at persist time … serialize the
 * read-fold-write with … a per-session lock; the fold itself is pure").
 */
import { describe, expect, it } from 'bun:test'

import { InMemorySessionMirrorStore } from '../in-memory.ts'
import { foldSessionSummary } from '../summary-fold.ts'
import type { MirrorSessionKey, SessionMirrorEntry } from '../types.ts'

const KEY: MirrorSessionKey = { workspaceId: 'ws-1', sessionId: 's-1' }
const SUB_KEY: MirrorSessionKey = { ...KEY, subpath: 'subagents/agent-7' }

function entry(uuid: string, extra: Record<string, unknown> = {}): SessionMirrorEntry {
  return { uuid, type: 'message', ...extra }
}

describe('InMemorySessionMirrorStore', () => {
  it('append dedupes by entry uuid when a retried batch re-delivers', async () => {
    const store = new InMemorySessionMirrorStore()
    await store.append(KEY, [entry('a', { n: 1 }), entry('b', { n: 2 })])
    // A retried batch re-delivers `b` alongside the new `c`.
    await store.append(KEY, [entry('b', { n: 2 }), entry('c', { n: 3 })])

    expect(await store.load(KEY)).toEqual([
      entry('a', { n: 1 }),
      entry('b', { n: 2 }),
      entry('c', { n: 3 }),
    ])
  })

  it('load returns ordered deep-equal entries and null for unknown sessions', async () => {
    const store = new InMemorySessionMirrorStore()
    const batch = [entry('a', { nested: { deep: [1, 2] } }), entry('b')]
    await store.append(KEY, batch)

    const loaded = await store.load(KEY)
    expect(loaded).toEqual(batch)
    // Deep-equal, not same-reference: the store must not hand out live objects.
    expect(loaded![0]).not.toBe(batch[0])

    expect(await store.load({ workspaceId: 'ws-1', sessionId: 'missing' })).toBeNull()
  })

  it('folds the summary sidecar for main-transcript batches only, stamping mtime at persist time', async () => {
    const store = new InMemorySessionMirrorStore({ now: () => 1234 })
    await store.append(KEY, [
      { uuid: 'header#1', type: 'session_header', data: { name: 'Chat' } },
      entry('a'),
    ])
    // Subagent transcripts must not contribute to the main session's summary.
    await store.append(SUB_KEY, [entry('sub-1'), entry('sub-2'), entry('sub-3')])

    expect(await store.listSessionSummaries!('ws-1')).toEqual([
      { sessionId: 's-1', mtime: 1234, data: { entryCount: 2, name: 'Chat' } },
    ])
  })

  it('the fold itself is pure and never sets mtime', () => {
    const folded = foldSessionSummary(null, 's-1', [entry('a'), entry('b')])
    expect(folded.mtime).toBe(0)
    expect(folded).toEqual({ sessionId: 's-1', mtime: 0, data: { entryCount: 2 } })

    const again = foldSessionSummary(folded, 's-1', [
      { uuid: 'header#2', type: 'session_header', data: { name: 'Renamed' } },
    ])
    expect(again.data).toEqual({ entryCount: 3, name: 'Renamed' })
    // Purity: the previous summary was not mutated.
    expect(folded.data).toEqual({ entryCount: 2 })
  })

  it('two concurrent appends for one session serialize the sidecar read-fold-write', async () => {
    const store = new InMemorySessionMirrorStore({ now: () => 99 })
    await Promise.all([
      store.append(KEY, [entry('a')]),
      store.append(KEY, [entry('b')]),
    ])

    const summaries = await store.listSessionSummaries!('ws-1')
    expect(summaries).toHaveLength(1)
    // A lost update would leave entryCount at 1.
    expect(summaries[0]!.data.entryCount).toBe(2)
  })
})

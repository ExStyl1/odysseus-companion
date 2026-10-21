/**
 * Summary sidecar fold (agent-sdk/session-storage.md, doc-verification § R6
 * fact 1): applied on each batch INSIDE `append`, skipping batches whose key
 * has a `subpath` (subagent transcripts must not contribute to the main
 * session's summary). "The fold never sets `mtime`: stamp it at persist time."
 * "Concurrent `append` calls for the same session can race on the sidecar, so
 * serialize the read-fold-write with … a per-session lock; the fold itself is
 * pure."
 */
import type { MirrorSessionSummaryEntry, SessionMirrorEntry } from './types.ts'

/**
 * Pure fold: accumulate the entry count and surface the latest header name.
 * `mtime` is always 0 — the store stamps the real write time at persist time,
 * from the same clock source its `listSessions` mtimes use.
 */
export function foldSessionSummary(
  previous: MirrorSessionSummaryEntry | null,
  sessionId: string,
  entries: readonly SessionMirrorEntry[],
): MirrorSessionSummaryEntry {
  const data: Record<string, unknown> = { ...(previous?.data ?? {}) }
  data.entryCount = Number(data.entryCount ?? 0) + entries.length
  for (const entry of entries) {
    if (entry.type !== 'session_header') continue
    const name = (entry.data as { name?: unknown } | undefined)?.name
    if (typeof name === 'string' && name.length > 0) data.name = name
  }
  return { sessionId, mtime: 0, data }
}

/**
 * Per-key promise-chain lock. Adapters wrap their sidecar read-fold-write in
 * `run(sessionId, …)` so two concurrent appends for one session serialize.
 *
 * Self-cleaning: when a chain settles and no later run has taken the tail
 * over, its map entry is deleted — a long-running host must not accumulate one
 * settled tail per historical session key.
 */
export class SessionKeyLock {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const tail: Promise<void> = next.then(() => undefined, () => undefined).then(() => {
      if (this.tails.get(id) === tail) this.tails.delete(id)
    })
    this.tails.set(id, tail)
    return next
  }

  /** Live (unsettled) tail count — the leak-test introspection seam. */
  get size(): number {
    return this.tails.size
  }
}

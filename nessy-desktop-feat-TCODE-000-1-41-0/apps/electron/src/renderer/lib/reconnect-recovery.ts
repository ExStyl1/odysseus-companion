import type { SessionMeta } from '@/atoms/sessions'

export function getSessionsToRefreshAfterStaleReconnect(
  metaMap: Map<string, SessionMeta>,
  activeSessionId: string | null
): string[] {
  const refreshIds = new Set<string>()

  if (activeSessionId) {
    refreshIds.add(activeSessionId)
  }

  for (const [sessionId, meta] of metaMap) {
    if (meta.isProcessing) {
      refreshIds.add(sessionId)
    }
  }

  return [...refreshIds]
}

export interface PiRuntimeInvalidationBuffer {
  push(seq: number): void
  installBarrier(seq: number): void
  reset(): void
  dispose(): void
}

export function createPiRuntimeInvalidationBuffer(refetch: () => Promise<number | void>): PiRuntimeInvalidationBuffer {
  let barrier: number | undefined
  let highest = 0
  let scheduled = false
  let invalidatedDuringFetch = false
  let disposed = false
  let epoch = 0
  const schedule = () => {
    if (disposed || scheduled || barrier === undefined || highest <= barrier) return
    scheduled = true
    const requestEpoch = epoch
    queueMicrotask(async () => {
      try {
        const nextBarrier = await refetch()
        if (disposed || requestEpoch !== epoch) return
        if (typeof nextBarrier === 'number' && Number.isSafeInteger(nextBarrier) && nextBarrier >= 0) barrier = Math.max(barrier!, nextBarrier)
      } catch {
        // The renderer owns the bounded error projection. Retry requires a new event.
      } finally {
        if (disposed || requestEpoch !== epoch) return
        scheduled = false
        const retry = invalidatedDuringFetch
        invalidatedDuringFetch = false
        if (retry) schedule()
      }
    })
  }
  return {
    push(seq) {
      if (!Number.isSafeInteger(seq) || seq < 0 || disposed) return
      const isNew = seq > highest
      highest = Math.max(highest, seq)
      if (scheduled && isNew) invalidatedDuringFetch = true
      if (isNew) schedule()
    },
    installBarrier(seq) {
      if (!Number.isSafeInteger(seq) || seq < 0 || disposed) return
      barrier = Math.max(barrier ?? 0, seq)
      schedule()
    },
    reset() {
      if (disposed) return
      epoch += 1
      barrier = undefined
      highest = 0
      scheduled = false
      invalidatedDuringFetch = false
    },
    dispose() { disposed = true },
  }
}

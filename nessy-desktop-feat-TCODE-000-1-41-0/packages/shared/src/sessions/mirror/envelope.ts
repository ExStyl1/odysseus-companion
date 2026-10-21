/**
 * The mirror failure envelope, exactly as documented
 * (agent-sdk/session-storage.md § Mirror writes are best-effort):
 *
 *  - on rejection, retry the batch up to two more times with a short backoff —
 *    at most three attempts in total;
 *  - a call that times out is NOT retried, since the original call may still
 *    land;
 *  - on giving up the batch is dropped, a `{ type: 'system', subtype:
 *    'mirror_error' }` event is emitted, and the session continues;
 *  - this function NEVER throws — a mirror failure must never fail, block, or
 *    reorder the local write it trails.
 */
import type { MirrorEvent, MirrorSessionKey, SessionMirrorEntry, SessionMirrorStore } from './types.ts'

export interface MirrorEnvelopeOptions {
  onEvent: (event: MirrorEvent) => void
  /** Per-attempt timeout. A timed-out attempt is terminal (no retry). */
  timeoutMs?: number
  /** The "short backoff" between rejection retries. */
  backoffMs?: number
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_BACKOFF_MS = 250
const MAX_ATTEMPTS = 3

const TIMEOUT = Symbol('mirror-append-timeout')

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Deliver one batch under the envelope. Resolves `true` when the store
 * accepted the batch, `false` when the batch was dropped (after emitting
 * `mirror_error`). Never rejects.
 */
export async function appendWithEnvelope(
  store: Pick<SessionMirrorStore, 'append'>,
  key: MirrorSessionKey,
  entries: SessionMirrorEntry[],
  options: MirrorEnvelopeOptions,
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS
  const sleep = options.sleep ?? defaultSleep

  const drop = (reason: string, attempts: number): false => {
    options.onEvent({
      type: 'system',
      subtype: 'mirror_error',
      key,
      reason,
      attempts,
      entryCount: entries.length,
    })
    return false
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(() => store.append(key, entries)),
        new Promise<typeof TIMEOUT>(resolve => {
          timer = setTimeout(() => resolve(TIMEOUT), timeoutMs)
        }),
      ])
      if (outcome === TIMEOUT) {
        // The original call may still land — retrying could double-deliver
        // outside the store's dedup window, so a timeout is terminal.
        return drop(`append timed out after ${timeoutMs}ms`, attempt)
      }
      return true
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) {
        return drop(reasonOf(error), attempt)
      }
      await sleep(backoffMs)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  // Unreachable: every path above returns.
  return false
}

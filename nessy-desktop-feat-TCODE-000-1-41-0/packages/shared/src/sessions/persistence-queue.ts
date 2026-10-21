// ID-first debounced session writer (W5). Pending writes are keyed by the composite
// SessionKey (encoded `workspaceId:sessionId`), and files are written to the global v2
// layout `SESSIONS_DIR/<workspaceId>/<sessionId>/session.jsonl`. No managed storage path
// is accepted or persisted.
import { writeFile, rename, unlink } from 'fs/promises'
import { dirname } from 'path'
import type { SessionKey, StoredSession, SessionHeader } from './types.js'
import { getSessionFilePath, ensureSessionsDir, ensureSessionDir } from './storage.js'
import { encodeSessionKey } from './session-key.js'
import { toPortablePath } from '../utils/paths.js'
import { createSessionHeader, makeSessionPathPortable, readSessionHeader } from './jsonl.js'
import { notifySessionMirrorFlush } from './mirror/host.js'
import { debug } from '../utils/debug.js'

interface PendingWrite {
  data: StoredSession
  timer: ReturnType<typeof setTimeout>
}

interface SessionPersistenceQueueHooks {
  beforeAtomicRename?: (key: SessionKey) => Promise<void>
}

interface HeaderMetadataSignature {
  name?: string
  labels?: string[]
  isFlagged?: boolean
  sessionStatus?: string
  permissionMode?: string
  hasUnread?: boolean
  lastReadMessageId?: string
}

function getHeaderMetadataSignature(header: SessionHeader): string {
  const signature: HeaderMetadataSignature = {
    name: header.name,
    labels: header.labels,
    isFlagged: header.isFlagged,
    sessionStatus: header.sessionStatus,
    permissionMode: header.permissionMode,
    hasUnread: header.hasUnread,
    lastReadMessageId: header.lastReadMessageId,
  }
  return JSON.stringify(signature)
}

function mergeHeaderWithExternalMetadata(localHeader: SessionHeader, diskHeader: SessionHeader): SessionHeader {
  return {
    ...localHeader,
    name: diskHeader.name,
    labels: diskHeader.labels,
    isFlagged: diskHeader.isFlagged,
    sessionStatus: diskHeader.sessionStatus,
    permissionMode: diskHeader.permissionMode,
    hasUnread: diskHeader.hasUnread,
    lastReadMessageId: diskHeader.lastReadMessageId,
  }
}

function keyOf(session: StoredSession): SessionKey {
  return { workspaceId: session.workspaceId, sessionId: session.id }
}

/**
 * Debounced async session persistence queue.
 * Prevents main thread blocking by using async writes and coalescing
 * rapid successive persist calls into a single write.
 *
 * IMPORTANT: Writes are serialized per-session to prevent race conditions
 * when rapid successive flushes (e.g., clearSessionForRecovery + onSdkSessionIdUpdate)
 * would otherwise write to the same .tmp file concurrently.
 *
 * All maps are keyed by the encoded composite SessionKey — two live Workspaces may
 * hold sessions with equal session IDs without clobbering each other's writes.
 */
/** What a listener is told when a transcript write fails (P6.267 (b)). */
export interface SessionWriteFailure {
  readonly key: SessionKey
  /** The filesystem error code, where the platform supplied one. */
  readonly code?: string
  readonly error: unknown
}

export type SessionWriteFailureListener = (failure: SessionWriteFailure) => void

class SessionPersistenceQueue {
  private pending = new Map<string, PendingWrite>()
  private writeInProgress = new Map<string, Promise<void>>()
  private lastWrittenHeaderSignature = new Map<string, string>()
  private deletionFences = new Set<string>()
  private writeFailureListeners = new Set<SessionWriteFailureListener>()
  private debounceMs: number
  private hooks: SessionPersistenceQueueHooks

  constructor(debounceMs = 500, hooks: SessionPersistenceQueueHooks = {}) {
    this.debounceMs = debounceMs
    this.hooks = hooks
  }

  /**
   * Queue a session for persistence. If a write is already pending for this
   * session, it will be replaced with the new data and the timer reset.
   */
  enqueue(session: StoredSession): void {
    const key = keyOf(session)
    const encoded = encodeSessionKey(key)
    if (this.deletionFences.has(encoded)) {
      debug(`[PersistenceQueue] Dropped write for deleting session ${encoded}`)
      return
    }
    const existing = this.pending.get(encoded)
    if (existing) {
      clearTimeout(existing.timer)
    }

    const timer = setTimeout(() => {
      void this.write(key)
    }, this.debounceMs)

    this.pending.set(encoded, { data: session, timer })
  }

  /**
   * Write a session to disk immediately in JSONL format.
   * Every entry point is serialized per session, including debounce timers.
   */
  private async write(key: SessionKey, strict = false): Promise<void> {
    const encoded = encodeSessionKey(key)
    const previous = this.writeInProgress.get(encoded)
    const current = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => this.writePending(key, strict))
    this.writeInProgress.set(encoded, current)

    try {
      await current
    } finally {
      if (this.writeInProgress.get(encoded) === current) {
        this.writeInProgress.delete(encoded)
      }
    }
  }

  /**
   * Consume and persist the latest pending snapshot.
   * Uses atomic write (write-to-temp-then-rename) to prevent corruption on crash.
   */
  private async writePending(key: SessionKey, strict: boolean): Promise<void> {
    const encoded = encodeSessionKey(key)
    const entry = this.pending.get(encoded)
    if (!entry) return

    this.pending.delete(encoded)

    try {
      const { data } = entry
      ensureSessionsDir(data.workspaceId)
      ensureSessionDir(data.workspaceId, key.sessionId)

      const filePath = getSessionFilePath(data.workspaceId, key.sessionId)

      // Prepare session with portable external paths for cross-machine compatibility
      const storageSession: StoredSession = {
        ...data,
        workingDirectory: data.workingDirectory ? toPortablePath(data.workingDirectory) : undefined,
        sdkCwd: data.sdkCwd ? toPortablePath(data.sdkCwd) : undefined,
        lastUsedAt: Date.now(),
      }

      // Create JSONL content: header + messages (one per line)
      // Filter out intermediate messages - they're transient streaming status updates
      const localHeader = createSessionHeader(storageSession)
      const localSig = getHeaderMetadataSignature(localHeader)
      const diskHeader = readSessionHeader(filePath)
      const previousSig = this.lastWrittenHeaderSignature.get(encoded)
      const diskSig = diskHeader ? getHeaderMetadataSignature(diskHeader) : undefined

      // Queue writes should never clobber session metadata changed externally
      // (watcher edits, direct header edits, other instances), but they must
      // still persist local metadata updates (e.g. generated title).
      //
      // Preserve disk metadata only when disk diverged from our last written
      // signature, which indicates an external mutation.
      const hasMetadataMismatch = !!diskHeader && !!diskSig && diskSig !== localSig
      const hasExternalMetadataChange = !!diskHeader && !!diskSig && !!previousSig && diskSig !== previousSig
      const header = hasExternalMetadataChange && diskHeader
        ? mergeHeaderWithExternalMetadata(localHeader, diskHeader)
        : localHeader

      if (hasMetadataMismatch) {
        const baseline = previousSig ? `, previousSig=${previousSig.slice(0, 12)}` : ', previousSig=<none>'
        const mode = hasExternalMetadataChange ? 'disk preserved' : 'local preserved'
        debug(`[PersistenceQueue] Session ${encoded} metadata mismatch detected (${mode}${baseline})`)
      }

      const persistableMessages = storageSession.messages
      // Use original absolute sessionDir (before toPortablePath) for path replacement
      const sessionDir = dirname(filePath)
      const lines = [
        makeSessionPathPortable(JSON.stringify(header), sessionDir),
        ...persistableMessages.map(m => makeSessionPathPortable(JSON.stringify(m), sessionDir)),
      ]

      // Atomic write: write to .tmp then rename over the real file.
      // If the process crashes mid-write, only the .tmp is corrupted —
      // the original session.jsonl remains intact.
      //
      // Update signature BEFORE the write so that fs.watch events fired
      // during unlink/rename are correctly identified as self-writes.
      // Without this, onSessionMetadataChange sees the stale signature
      // and reverts in-memory metadata on idle sessions.
      const finalSignature = getHeaderMetadataSignature(header)
      this.lastWrittenHeaderSignature.set(encoded, finalSignature)

      const tmpFile = filePath + '.tmp'
      await writeFile(tmpFile, lines.join('\n') + '\n', 'utf-8')
      await this.hooks.beforeAtomicRename?.(key)
      try {
        await rename(tmpFile, filePath)
      } catch (error) {
        if (process.platform !== 'win32' || (error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
          throw error
        }
        try {
          await unlink(filePath)
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException)?.code !== 'ENOENT') throw unlinkError
        }
        await rename(tmpFile, filePath)
      }
      debug(`[PersistenceQueue] Wrote session ${encoded}`)
      // Mirror tap — AFTER the atomic rename: the local write is already
      // durable and authoritative. Fire-and-forget; a mirror failure can
      // never fail, block, or reorder this write (sessions/mirror/host.ts).
      notifySessionMirrorFlush(key, lines)
    } catch (error) {
      console.error(`[PersistenceQueue] Failed to write session ${encoded}:`, error)
      // P6.267 (b) — a failing transcript write told NOBODY. `console.error`
      // reaches no user on a packaged build, and a debounced write is
      // fire-and-forget by construction, so the one class of failure that
      // silently loses a conversation was also the one class with no surface.
      //
      // A LISTENER rather than a throw: the whole point of the queue is that an
      // ordinary write cannot take a turn down with it, and `strict` already
      // covers the callers that do want to fail. The host subscribes and decides
      // what a user sees; this module keeps knowing nothing about sessions' UI.
      for (const listener of this.writeFailureListeners) {
        try {
          listener({ key, code: (error as NodeJS.ErrnoException)?.code, error })
        } catch {
          // A broken listener must not turn a reported failure into a second,
          // unreported one.
        }
      }
      if (strict) throw error
    }
  }

  /**
   * Be told when a session's transcript could NOT be written (P6.267 (b)).
   *
   * `code` is the filesystem error code where the platform supplied one
   * (`ENOSPC`, `EACCES`, `EROFS`…) and `undefined` otherwise — the host names it
   * to the user, because "could not save" without the code is unactionable.
   * Returns an unsubscribe.
   */
  onWriteFailure(listener: SessionWriteFailureListener): () => void {
    this.writeFailureListeners.add(listener)
    return () => { this.writeFailureListeners.delete(listener) }
  }

  /**
   * Immediately flush a specific session if pending.
   * Waits for any in-progress write to complete before starting a new one
   * to prevent race conditions on the shared .tmp file.
   */
  async flush(key: SessionKey, options: { strict?: boolean } = {}): Promise<void> {
    const encoded = encodeSessionKey(key)
    if (this.deletionFences.has(encoded)) {
      await this.writeInProgress.get(encoded)
      return
    }
    const entry = this.pending.get(encoded)
    if (entry) {
      clearTimeout(entry.timer)
    }
    await this.write(key, options.strict === true)
  }

  /**
   * Cancel a pending write for a session (e.g., when deleting the session).
   */
  cancel(key: SessionKey): void {
    const encoded = encodeSessionKey(key)
    const entry = this.pending.get(encoded)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(encoded)
      debug(`[PersistenceQueue] Cancelled pending write for session ${encoded}`)
    }
    this.lastWrittenHeaderSignature.delete(encoded)
  }

  /**
   * Cancel queued data and wait until the current writer no longer owns this
   * session path. Deletion callers must cross this barrier before removing the
   * directory so an already-started atomic rename cannot recreate it.
   */
  async cancelAndWait(key: SessionKey): Promise<void> {
    const encoded = encodeSessionKey(key)
    this.deletionFences.add(encoded)
    this.cancel(key)
    for (;;) {
      const active = this.writeInProgress.get(encoded)
      if (!active) return
      await active
      this.cancel(key)
    }
  }

  /**
   * Re-enable persistence after a failed deletion transaction. Successful
   * deletion keeps the fence so stale holders cannot resurrect the session.
   */
  clearDeleteFence(key: SessionKey): void {
    this.deletionFences.delete(encodeSessionKey(key))
  }

  isDeleteFenced(key: SessionKey): boolean {
    return this.deletionFences.has(encodeSessionKey(key))
  }

  /**
   * Flush all pending sessions. Call this on app quit.
   */
  async flushAll(): Promise<void> {
    const pendingKeys = [...this.pending.values()].map(entry => keyOf(entry.data))
    await Promise.all(pendingKeys.map(key => this.flush(key)))
    await Promise.allSettled([...this.writeInProgress.values()])
  }

  /**
   * Check if a session has a pending write.
   */
  hasPending(key: SessionKey): boolean {
    return this.pending.has(encodeSessionKey(key))
  }

  /**
   * Get the metadata signature of the last header we wrote for a session.
   * Used by ConfigWatcher to suppress self-triggered metadata change events.
   */
  getLastWrittenSignature(key: SessionKey): string | undefined {
    return this.lastWrittenHeaderSignature.get(encodeSessionKey(key))
  }

  /**
   * Get count of pending writes.
   */
  get pendingCount(): number {
    return this.pending.size
  }
}

// Singleton instance
export const sessionPersistenceQueue = new SessionPersistenceQueue()

// Named exports for testing/customization
export { SessionPersistenceQueue, getHeaderMetadataSignature, mergeHeaderWithExternalMetadata }

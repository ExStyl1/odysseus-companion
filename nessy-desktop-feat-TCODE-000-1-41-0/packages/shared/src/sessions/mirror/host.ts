/**
 * Host-side mirror wiring. The mirror consumes the persistence QUEUE's output:
 * `SessionPersistenceQueue.writePending` calls `notifySessionMirrorFlush` AFTER
 * the atomic rename succeeds, with the exact JSONL lines it wrote. Nothing here
 * can fail, delay-block, or reorder the local write — dispatch is
 * fire-and-forget, and every failure ends in the documented envelope
 * (≤3 attempts, timeout-no-retry, drop + `mirror_error` + continue).
 *
 * Batch diffing (plan Task 1 answer): the queue writes a WHOLE-SESSION snapshot
 * per flush, so the host diffs. Entry uuids are content-addressed —
 * `<messageId>#<hash8(line)>` for messages, `header#<hash8(header minus
 * volatile lastUsedAt)>` for the header — and a per-key cache of mirrored uuids
 * keeps batches to the delta. A `session_reset` marker entry records snapshots
 * that dropped previously-mirrored messages (clear/recovery), so a rebuild
 * never resurrects cleared content. After a dropped batch the cache is NOT
 * advanced: later flushes may re-deliver, and store-side uuid dedup keeps that
 * harmless — a deliberate superset of Claude's drop semantics.
 *
 * Checkpoint blobs are NOT mirrored: the mirror carries transcripts only.
 * File-history checkpoints are a separate digest-verified subsystem, and a
 * mirror restore does not restore checkpoint blobs (see the Task 4 log line).
 * We do not adopt Claude's throw-on-combination.
 */
import { createHash } from 'crypto'

import { DirectorySessionMirrorStore } from './directory.ts'
import { appendWithEnvelope } from './envelope.ts'
import { SessionKeyLock } from './summary-fold.ts'
import type { MirrorEvent, MirrorSessionKey, SessionMirrorEntry, SessionMirrorStore } from './types.ts'
import type { SessionMirrorSettingsV1 } from '../../config/session-mirror-settings.ts'
import type { SessionKey } from '../types.ts'
import { debug } from '../../utils/debug.ts'

type MirrorErrorSink = (event: MirrorEvent) => void

interface SessionMirrorState {
  mirroredUuids: Set<string>
  messageIds: Set<string>
  lastErrorReason?: string
  /**
   * The last unreadable-line reason surfaced for this key. Kept SEPARATE from
   * `lastErrorReason`, which a delivered batch clears: an unreadable line lives
   * in the file, so it is present on every later flush, and re-arming the notice
   * on each successful delivery would post a transcript message per flush
   * forever. Cleared only when the reason itself changes.
   */
  lastUnreadableReason?: string
}

const SETTINGS_TTL_MS = 5_000

let errorSink: MirrorErrorSink | null = null
let settingsCache: { at: number; value: SessionMirrorSettingsV1 | null } | null = null
let storeCache: { signature: string; store: SessionMirrorStore } | null = null
const sessionStates = new Map<string, SessionMirrorState>()
const dispatchLock = new SessionKeyLock()
const pending = new Set<Promise<void>>()

// Lazily imported to avoid a static config/storage ⇄ sessions module cycle
// (config/storage imports the sessions barrel, and the persistence queue
// imports this module).
let loadSettings: (() => SessionMirrorSettingsV1 | null) | undefined

async function resolveSettings(): Promise<SessionMirrorSettingsV1 | null> {
  const now = Date.now()
  if (settingsCache && now - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value
  if (!loadSettings) {
    loadSettings = (await import('../../config/storage.ts')).getUserSessionMirrorSettings
  }
  let value: SessionMirrorSettingsV1 | null
  try {
    value = loadSettings()
  } catch (error) {
    console.error('[SessionMirror] Failed to read sessionMirror settings — mirroring disabled:', error)
    value = null
  }
  settingsCache = { at: now, value }
  return value
}

function resolveStore(settings: SessionMirrorSettingsV1): SessionMirrorStore {
  const signature = `${settings.adapter}\u0000${settings.path}`
  if (storeCache?.signature === signature) return storeCache.store
  // The parser fails closed on unknown adapters, so 'directory' is the only
  // name that reaches here; the switch stays for the next built-in.
  const store: SessionMirrorStore = new DirectorySessionMirrorStore({ root: settings.path })
  storeCache = { signature, store }
  return store
}

function hash8(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8)
}

function encodeKey(key: SessionKey): string {
  return `${key.workspaceId}\u0000${key.sessionId}`
}

interface Snapshot {
  entries: SessionMirrorEntry[]
  messageIds: string[]
  /**
   * Lines this flush could not read, named by POSITION and counted — never by
   * content, because the reason reaches a transcript message and a renderer and
   * the line is session data.
   */
  unreadable: string[]
}

function readLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * Convert the flushed JSONL lines (header line 1, messages 2+) to mirror entries.
 *
 * P2.204 — A LINE THAT WILL NOT PARSE COSTS THAT LINE, NOT THE BATCH. Every line
 * used to go through a bare `JSON.parse`, so one unreadable line threw out of
 * `dispatch` and into `notifySessionMirrorFlush`'s `console.error` — which
 * bypasses `mirror_error`, the ONE channel this subsystem has for making mirror
 * data loss visible. Because the bad line stays in the file, every later flush
 * died the same way: the session stopped mirroring permanently and nothing said
 * so. The caller surfaces `unreadable` on that existing channel.
 *
 * The HEADER is the one line whose loss is still whole-flush: every message
 * entry is mirrored under a snapshot that the header identifies, and a
 * transcript with no header is not a session. That loss is named too.
 */
function snapshotFromLines(lines: readonly string[]): Snapshot | null {
  if (lines.length === 0) return null
  const unreadable: string[] = []
  const header = readLine(lines[0]!)
  if (!header) return { entries: [], messageIds: [], unreadable: ['the header line (line 1) could not be read as JSON'] }
  // Exclude the volatile write stamp so a metadata-stable flush re-mirrors nothing.
  const headerUuid = `header#${hash8(JSON.stringify({ ...header, lastUsedAt: 0 }))}`
  const entries: SessionMirrorEntry[] = [
    { uuid: headerUuid, type: 'session_header', data: header },
  ]
  const messageIds: string[] = []
  for (const [offset, line] of lines.slice(1).entries()) {
    const message = readLine(line)
    if (!message) {
      unreadable.push(`line ${offset + 2} could not be read as JSON (${line.length} bytes)`)
      continue
    }
    const id = typeof message.id === 'string' && message.id ? message.id : hash8(line)
    messageIds.push(id)
    entries.push({ uuid: `${id}#${hash8(line)}`, type: 'message', data: message })
  }
  return { entries, messageIds, unreadable }
}

async function dispatch(key: SessionKey, lines: readonly string[]): Promise<void> {
  // The WHOLE dispatch — including settings resolution — runs inside the
  // per-key lock, so lock-queue order equals notify order and an eviction
  // enqueued after the last flush of a deleted session can never be overtaken
  // by a still-starting dispatch that would resurrect its state.
  await dispatchLock.run(encodeKey(key), async () => {
    const settings = await resolveSettings()
    if (!settings) return
    const store = resolveStore(settings)

    const snapshot = snapshotFromLines(lines)
    if (!snapshot) return
    const encoded = encodeKey(key)
    const state = sessionStates.get(encoded) ?? { mirroredUuids: new Set<string>(), messageIds: new Set<string>() }

    // P2.204 — lines the flush could not read are named on `mirror_error`, the
    // channel that already exists for mirror data loss, BEFORE the append: the
    // append can fail on its own and this loss is real either way. Deduped on
    // its own field, because the bad line is in the file and a delivered batch
    // must not re-arm the notice (see `lastUnreadableReason`).
    if (snapshot.unreadable.length > 0) {
      const reason = `${snapshot.unreadable.length} line(s) of the flushed transcript could not be mirrored: `
        + snapshot.unreadable.join('; ')
      if (state.lastUnreadableReason !== reason) {
        state.lastUnreadableReason = reason
        sessionStates.set(encoded, state)
        console.error(`[SessionMirror] ${key.workspaceId}:${key.sessionId} — ${reason}`)
        errorSink?.({
          type: 'system',
          subtype: 'mirror_error',
          key: { workspaceId: key.workspaceId, sessionId: key.sessionId },
          reason,
          // No write was attempted for these lines: they never became entries.
          attempts: 0,
          entryCount: snapshot.unreadable.length,
        })
      }
    }

    const currentIds = new Set(snapshot.messageIds)
    const batch: SessionMirrorEntry[] = []
    // A previously-mirrored message id that vanished from the snapshot
    // (clear/recovery) resets the id baseline so rebuilds drop it.
    if ([...state.messageIds].some(id => !currentIds.has(id))) {
      batch.push({
        uuid: `reset#${hash8(JSON.stringify(snapshot.messageIds))}`,
        type: 'session_reset',
        data: { messageIds: snapshot.messageIds },
      })
    }
    for (const entry of snapshot.entries) {
      if (!state.mirroredUuids.has(entry.uuid)) batch.push(entry)
    }
    if (batch.length === 0) return

    const mirrorKey: MirrorSessionKey = { workspaceId: key.workspaceId, sessionId: key.sessionId }
    const delivered = await appendWithEnvelope(store, mirrorKey, batch, {
      onEvent: event => {
        console.error(`[SessionMirror] Dropped batch for ${key.workspaceId}:${key.sessionId} after ${event.attempts} attempt(s): ${event.reason}`)
        // Surface each distinct failure once; log-only until the reason changes
        // or a write lands. Also breaks the loop where surfacing the error
        // message itself triggers a flush that fails the same way.
        if (state.lastErrorReason !== event.reason) {
          state.lastErrorReason = event.reason
          sessionStates.set(encoded, state)
          errorSink?.(event)
        }
      },
    })

    if (delivered) {
      for (const entry of batch) state.mirroredUuids.add(entry.uuid)
      state.messageIds = currentIds
      state.lastErrorReason = undefined
      sessionStates.set(encoded, state)
      debug(`[SessionMirror] Mirrored ${batch.length} entr${batch.length === 1 ? 'y' : 'ies'} for ${key.workspaceId}:${key.sessionId}`)
    }
  })
}

/**
 * Queue tap. Called by `SessionPersistenceQueue.writePending` AFTER the atomic
 * rename succeeded — the local write is already durable. Synchronous, returns
 * immediately, never throws.
 */
export function notifySessionMirrorFlush(key: SessionKey, lines: readonly string[]): void {
  const task = dispatch(key, [...lines]).catch(error => {
    console.error('[SessionMirror] Dispatch failed:', error)
  })
  pending.add(task)
  void task.finally(() => pending.delete(task))
}

/** Whether the host holds diff state for a key — the leak-test introspection seam. */
export function hasSessionMirrorState(key: SessionKey): boolean {
  return sessionStates.has(encodeKey(key))
}

/**
 * Evict a session's mirror diff state when the session leaves the production
 * lifecycle (deletion/disposal). Serialized on the per-key dispatch lock so an
 * in-flight dispatch cannot resurrect the evicted entry; afterwards the lock
 * tail self-cleans, so neither map retains the key. Safe on ACTIVE sessions:
 * the next flush re-appends from scratch and the store's uuid dedup drops the
 * re-delivery.
 */
export function evictSessionMirrorState(key: SessionKey): Promise<void> {
  const encoded = encodeKey(key)
  const task = dispatchLock.run(encoded, async () => {
    sessionStates.delete(encoded)
  })
  pending.add(task)
  void task.finally(() => pending.delete(task))
  return task
}

/**
 * Host registration for surfacing `mirror_error` as a session system message.
 * Production registers SessionManager's handler; the default is log-only.
 */
export function setSessionMirrorErrorSink(sink: MirrorErrorSink | null): void {
  errorSink = sink
}

/** The configured mirror store, if any — the load-fallback entry point. */
export async function getConfiguredSessionMirrorStore(): Promise<SessionMirrorStore | null> {
  const settings = await resolveSettings()
  return settings ? resolveStore(settings) : null
}

/** Resolves once every in-flight mirror dispatch has settled. */
export async function sessionMirrorIdle(): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled([...pending])
  }
}

/** Test seam: drop caches, per-session diff state, and the error sink. */
export function resetSessionMirrorHostForTests(): void {
  settingsCache = null
  storeCache = null
  sessionStates.clear()
  errorSink = null
}

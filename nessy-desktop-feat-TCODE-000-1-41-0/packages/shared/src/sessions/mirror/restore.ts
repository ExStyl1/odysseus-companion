/**
 * Load-fallback before resume (agent-sdk/session-storage.md `load`;
 * agent-sdk/hosting.md hydrate pattern): when the local transcript is missing
 * or unreadable AND a mirror is configured, rebuild the local JSONL from
 * `store.load(key)` and let the ordinary open path proceed. The mirror stays
 * non-authoritative — the rebuild is a plain local file that the next local
 * write overwrites.
 *
 * File-history checkpoint blobs are NOT restored: the mirror carries
 * transcripts only (stated in the restore log line). Checkpoints are our
 * separate digest-verified subsystem; we do not adopt Claude's
 * throw-on-combination.
 */
import { existsSync, readdirSync } from 'fs'
import { mkdir, rename, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

import { getConfiguredSessionMirrorStore } from './host.ts'
import type { SessionMirrorEntry } from './types.ts'
import { readSessionHeader } from '../jsonl.ts'
import type { SessionKey } from '../types.ts'
import { SESSIONS_DIR } from '../../workspaces/paths.ts'

/**
 * Rebuild the local JSONL lines from ordered mirror entries: the LAST header
 * revision wins line 1; each message id keeps its first-occurrence position
 * with its LAST revision's content; a `session_reset` marker rebases the id
 * list so messages cleared before the reset are not resurrected. Returns null
 * when no header entry exists (nothing safe to rebuild).
 */
export function rebuildJsonlLines(entries: readonly SessionMirrorEntry[]): string[] | null {
  let header: Record<string, unknown> | undefined
  let order: string[] = []
  let seen = new Set<string>()
  const contents = new Map<string, Record<string, unknown>>()

  for (const entry of entries) {
    if (entry.type === 'session_header') {
      const data = entry.data
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        header = data as Record<string, unknown>
      }
      continue
    }
    if (entry.type === 'session_reset') {
      const ids = (entry.data as { messageIds?: unknown } | undefined)?.messageIds
      if (Array.isArray(ids)) {
        order = ids.filter((id): id is string => typeof id === 'string')
        seen = new Set(order)
      }
      continue
    }
    if (entry.type !== 'message') continue
    const data = entry.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    const message = data as Record<string, unknown>
    const id = typeof message.id === 'string' && message.id ? message.id : entry.uuid
    if (!seen.has(id)) {
      seen.add(id)
      order.push(id)
    }
    contents.set(id, message)
  }

  if (!header) return null
  return [
    JSON.stringify(header),
    ...order.filter(id => contents.has(id)).map(id => JSON.stringify(contents.get(id))),
  ]
}

/**
 * Rebuild `sessionFile` from the configured mirror. Returns true when a
 * rebuilt JSONL was written (atomically); false when no mirror is configured,
 * the mirror does not know the session, or the rebuild is impossible. Never
 * throws — a broken mirror must not break session open.
 */
/**
 * Pre-listing sweep (CDP pass 10 blocker): the session registry is built from
 * disk headers, so a session whose local `session.jsonl` is missing or
 * unreadable silently vanishes from the LIST before any open-path fallback can
 * run. Called by the production boot path BEFORE listing: for every session
 * DIRECTORY that still exists under a workspace, a missing/unreadable jsonl
 * with mirror content is rebuilt in place, and the ordinary listing then picks
 * it up unchanged. Restore-at-list-time was chosen over synthesizing list
 * entries because every downstream consumer (listing, open, renderer) works on
 * the ordinary local file afterwards. A fully DELETED session directory is
 * deliberately NOT resurrected — local deletion stays authoritative. With no
 * mirror configured this returns immediately (today's behavior, no phantoms).
 * Returns the number of restored sessions. Never throws.
 */
export async function restoreMissingMirroredSessions(
  workspaceIds: readonly string[],
): Promise<number> {
  let restored = 0
  try {
    const store = await getConfiguredSessionMirrorStore()
    if (!store) return 0
    for (const workspaceId of workspaceIds) {
      const root = join(SESSIONS_DIR, workspaceId)
      let entries: import('fs').Dirent[]
      try {
        entries = readdirSync(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const sessionId = entry.name
        const file = join(root, sessionId, 'session.jsonl')
        if (existsSync(file) && readSessionHeader(file) !== null) continue
        if (await restoreSessionFromMirror({ workspaceId, sessionId }, file)) restored++
      }
    }
  } catch (error) {
    console.error('[SessionMirror] Pre-listing restore sweep failed:', error)
  }
  return restored
}

export async function restoreSessionFromMirror(
  key: SessionKey,
  sessionFile: string,
): Promise<boolean> {
  try {
    const store = await getConfiguredSessionMirrorStore()
    if (!store) return false

    const entries = await store.load({ workspaceId: key.workspaceId, sessionId: key.sessionId })
    if (!entries || entries.length === 0) return false

    const lines = rebuildJsonlLines(entries)
    if (!lines) return false

    // Keep an unreadable original around rather than destroying evidence.
    if (existsSync(sessionFile)) {
      await rename(sessionFile, `${sessionFile}.corrupt`)
    }
    await mkdir(dirname(sessionFile), { recursive: true })
    const tmp = `${sessionFile}.mirror-restore.tmp`
    await writeFile(tmp, lines.join('\n') + '\n', 'utf-8')
    await rename(tmp, sessionFile)

    console.info(
      `[SessionMirror] Restored session ${key.workspaceId}:${key.sessionId} from the mirror `
      + `(${entries.length} entries -> ${lines.length - 1} messages). `
      + 'File-history checkpoint blobs are NOT restored - the mirror carries transcripts only.',
    )
    return true
  } catch (error) {
    console.error(
      `[SessionMirror] Load-fallback failed for ${key.workspaceId}:${key.sessionId} — opening without restore:`,
      error,
    )
    return false
  }
}

/**
 * In-memory mirror store for development and tests — the `InMemorySessionStore`
 * counterpart the docs ship (agent-sdk/session-storage.md § Quick start),
 * implementing all six methods of the contract: uuid dedup on append, ordered
 * deep-equal load, the summary sidecar folded under a per-session lock, and
 * cascade delete.
 */
import { foldSessionSummary, SessionKeyLock } from './summary-fold.ts'
import type {
  MirrorSessionKey,
  MirrorSessionSummaryEntry,
  SessionMirrorEntry,
  SessionMirrorStore,
} from './types.ts'

interface InMemoryOptions {
  /** Injectable clock for sidecar/listing mtimes. */
  now?: () => number
}

function transcriptId(key: MirrorSessionKey): string {
  return `${key.workspaceId}\u0000${key.sessionId}\u0000${key.subpath ?? ''}`
}

function sessionId(key: { workspaceId: string; sessionId: string }): string {
  return `${key.workspaceId}\u0000${key.sessionId}`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class InMemorySessionMirrorStore implements SessionMirrorStore {
  private readonly transcripts = new Map<string, SessionMirrorEntry[]>()
  private readonly summaries = new Map<string, MirrorSessionSummaryEntry>()
  private readonly mtimes = new Map<string, number>()
  private readonly lock = new SessionKeyLock()
  private readonly now: () => number

  constructor(options: InMemoryOptions = {}) {
    this.now = options.now ?? Date.now
  }

  async append(key: MirrorSessionKey, entries: SessionMirrorEntry[]): Promise<void> {
    const id = transcriptId(key)
    const existing = this.transcripts.get(id) ?? []
    const seen = new Set(existing.map(entry => entry.uuid))
    // A retried batch can re-deliver entries that already landed.
    const fresh = entries.filter(entry => !seen.has(entry.uuid))
    this.transcripts.set(id, [...existing, ...fresh.map(clone)])
    this.mtimes.set(sessionId(key), this.now())

    // Sidecar: main-transcript batches only, serialized per session.
    if (key.subpath !== undefined || fresh.length === 0) return
    await this.lock.run(sessionId(key), async () => {
      const previous = this.summaries.get(sessionId(key)) ?? null
      // Yield between read and write so an unserialized race actually loses
      // updates — keeps the lock behavior honest under test.
      await new Promise(resolve => setTimeout(resolve, 0))
      const folded = foldSessionSummary(previous, key.sessionId, fresh)
      this.summaries.set(sessionId(key), { ...folded, mtime: this.now() })
    })
  }

  async load(key: MirrorSessionKey): Promise<SessionMirrorEntry[] | null> {
    const entries = this.transcripts.get(transcriptId(key))
    return entries ? entries.map(clone) : null
  }

  async listSessions(workspaceId: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    const sessions: Array<{ sessionId: string; mtime: number }> = []
    for (const [id, mtime] of this.mtimes) {
      const [ws, session] = id.split('\u0000')
      if (ws === workspaceId) sessions.push({ sessionId: session!, mtime })
    }
    return sessions
  }

  async listSessionSummaries(workspaceId: string): Promise<MirrorSessionSummaryEntry[]> {
    const summaries: MirrorSessionSummaryEntry[] = []
    for (const [id, summary] of this.summaries) {
      if (id.startsWith(`${workspaceId}\u0000`)) summaries.push(clone(summary))
    }
    return summaries
  }

  async delete(key: MirrorSessionKey): Promise<void> {
    if (key.subpath !== undefined) {
      this.transcripts.delete(transcriptId(key))
      return
    }
    // Deleting the main key cascades to all subkeys and the summary entry.
    const prefix = `${sessionId(key)}\u0000`
    for (const id of [...this.transcripts.keys()]) {
      if (id.startsWith(prefix)) this.transcripts.delete(id)
    }
    this.summaries.delete(sessionId(key))
    this.mtimes.delete(sessionId(key))
  }

  async listSubkeys(key: { workspaceId: string; sessionId: string }): Promise<string[]> {
    const prefix = `${sessionId(key)}\u0000`
    const subkeys: string[] = []
    for (const id of this.transcripts.keys()) {
      if (!id.startsWith(prefix)) continue
      const subpath = id.slice(prefix.length)
      if (subpath) subkeys.push(subpath)
    }
    return subkeys
  }
}

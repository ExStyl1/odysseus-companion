/**
 * Built-in `directory` mirror adapter: mirrors transcripts into a second root
 * on the filesystem — enough to prove the mirror chain end-to-end without a
 * network dependency, and a working audit copy for a mounted volume.
 *
 * Layout (per key):
 *   <root>/<workspaceId>/<sessionId>/transcript.jsonl        main transcript
 *   <root>/<workspaceId>/<sessionId>/sub-<enc(subpath)>.jsonl subagent/sidecar
 *   <root>/<workspaceId>/<sessionId>/summary.json             summary sidecar
 *
 * Contract points (agent-sdk/session-storage.md): append dedupes by
 * `entry.uuid`; entries persist in order, one JSON line per entry, and `load`
 * returns them deep-equal; the summary sidecar folds inside `append` for
 * main-transcript batches only, under a per-session lock, with `mtime` stamped
 * at persist time; `delete` of the main key cascades to all subkeys and the
 * summary; retention is entirely this adapter's owner's business — the host
 * never deletes from a mirror on its sweep.
 */
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { foldSessionSummary, SessionKeyLock } from './summary-fold.ts'
import type {
  MirrorSessionKey,
  MirrorSessionSummaryEntry,
  SessionMirrorEntry,
  SessionMirrorStore,
} from './types.ts'

const MAIN_FILE = 'transcript.jsonl'
const SUMMARY_FILE = 'summary.json'
const SUB_PREFIX = 'sub-'
const SUB_SUFFIX = '.jsonl'

function assertSegment(kind: string, value: string): string {
  if (!value || value === '.' || value === '..' || /[/\\]/.test(value)) {
    throw new Error(`invalid mirror ${kind}: ${value}`)
  }
  return value
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

export class DirectorySessionMirrorStore implements SessionMirrorStore {
  private readonly root: string
  private readonly now: () => number
  private readonly lock = new SessionKeyLock()

  constructor(options: { root: string; now?: () => number }) {
    this.root = options.root
    this.now = options.now ?? Date.now
  }

  private sessionDir(key: { workspaceId: string; sessionId: string }): string {
    return join(
      this.root,
      assertSegment('workspaceId', key.workspaceId),
      assertSegment('sessionId', key.sessionId),
    )
  }

  private transcriptFile(key: MirrorSessionKey): string {
    const name = key.subpath === undefined
      ? MAIN_FILE
      : `${SUB_PREFIX}${encodeURIComponent(key.subpath)}${SUB_SUFFIX}`
    return join(this.sessionDir(key), name)
  }

  private async readEntries(file: string): Promise<SessionMirrorEntry[] | null> {
    let raw: string
    try {
      raw = await readFile(file, 'utf-8')
    } catch (error) {
      if (isEnoent(error)) return null
      throw error
    }
    return raw
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as SessionMirrorEntry)
  }

  async append(key: MirrorSessionKey, entries: SessionMirrorEntry[]): Promise<void> {
    const dir = this.sessionDir(key)
    const file = this.transcriptFile(key)
    await mkdir(dir, { recursive: true })

    const existing = (await this.readEntries(file)) ?? []
    const seen = new Set(existing.map(entry => entry.uuid))
    // A retried batch can re-deliver entries that already landed.
    const fresh = entries.filter(entry => !seen.has(entry.uuid))
    if (fresh.length === 0) return
    await appendFile(file, fresh.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf-8')

    // Summary sidecar: main-transcript batches only, read-fold-write serialized
    // per session, mtime stamped at persist time (same wall clock listSessions
    // falls back to).
    if (key.subpath !== undefined) return
    const summaryFile = join(dir, SUMMARY_FILE)
    await this.lock.run(`${key.workspaceId}/${key.sessionId}`, async () => {
      let previous: MirrorSessionSummaryEntry | null = null
      try {
        previous = JSON.parse(await readFile(summaryFile, 'utf-8')) as MirrorSessionSummaryEntry
      } catch (error) {
        if (!isEnoent(error)) throw error
      }
      const folded = foldSessionSummary(previous, key.sessionId, fresh)
      const stamped: MirrorSessionSummaryEntry = { ...folded, mtime: this.now() }
      const tmp = `${summaryFile}.tmp`
      await writeFile(tmp, JSON.stringify(stamped), 'utf-8')
      await rename(tmp, summaryFile)
    })
  }

  async load(key: MirrorSessionKey): Promise<SessionMirrorEntry[] | null> {
    return this.readEntries(this.transcriptFile(key))
  }

  async listSessions(workspaceId: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    const summaries = await this.listSessionSummaries(workspaceId)
    return summaries.map(summary => ({ sessionId: summary.sessionId, mtime: summary.mtime }))
  }

  async listSessionSummaries(workspaceId: string): Promise<MirrorSessionSummaryEntry[]> {
    const workspaceDir = join(this.root, assertSegment('workspaceId', workspaceId))
    let names: string[]
    try {
      names = await readdir(workspaceDir)
    } catch (error) {
      if (isEnoent(error)) return []
      throw error
    }
    const summaries: MirrorSessionSummaryEntry[] = []
    for (const sessionId of names) {
      try {
        summaries.push(JSON.parse(await readFile(join(workspaceDir, sessionId, SUMMARY_FILE), 'utf-8')))
      } catch (error) {
        if (!isEnoent(error)) throw error
      }
    }
    return summaries
  }

  async delete(key: MirrorSessionKey): Promise<void> {
    if (key.subpath !== undefined) {
      await rm(this.transcriptFile(key), { force: true })
      return
    }
    // Main-key delete cascades to all subkeys and the summary entry.
    await rm(this.sessionDir(key), { recursive: true, force: true })
  }

  async listSubkeys(key: { workspaceId: string; sessionId: string }): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(this.sessionDir(key))
    } catch (error) {
      if (isEnoent(error)) return []
      throw error
    }
    return names
      .filter(name => name.startsWith(SUB_PREFIX) && name.endsWith(SUB_SUFFIX))
      .map(name => decodeURIComponent(name.slice(SUB_PREFIX.length, -SUB_SUFFIX.length)))
  }
}

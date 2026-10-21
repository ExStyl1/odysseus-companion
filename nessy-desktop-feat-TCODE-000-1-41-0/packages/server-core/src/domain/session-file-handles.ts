/**
 * Backend-owned handles for files inside managed session storage (W9).
 * Absolute paths stay in this registry and never cross the RPC boundary.
 */

import { randomUUID } from 'node:crypto'
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { extname, join, relative } from 'node:path'
import { isPathWithin } from '@nessy-agent/shared/workspaces'
import type { SessionKey } from '@nessy-agent/shared/sessions'
import type { SessionFileHandle } from '@nessy-agent/shared/protocol'

export type SessionFileHandleErrorCode =
  | 'unknown-handle'
  | 'scope-mismatch'
  | 'stale-handle'
  | 'not-previewable'

export class SessionFileHandleError extends Error {
  override readonly name = 'SessionFileHandleError'
  constructor(readonly code: SessionFileHandleErrorCode) {
    super(code)
  }
}

interface SessionFileRecord {
  handleId: string
  clientId: string
  session: SessionKey
  rootRealPath: string
  absolutePath: string
  kind: SessionFileHandle['kind']
}

export interface SessionFileHandleRegistryOptions {
  newId?: () => string
  maxPreviewBytes?: number
}

const DEFAULT_MAX_PREVIEW_BYTES = 1024 * 1024
const PREVIEWABLE_EXTENSIONS = new Set([
  '.css', '.csv', '.html', '.ini', '.js', '.json', '.jsonl', '.jsx', '.log',
  '.md', '.mjs', '.sh', '.sql', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
])
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

function sameSession(a: SessionKey, b: SessionKey): boolean {
  return a.workspaceId === b.workspaceId && a.sessionId === b.sessionId
}

function displayPath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).replace(/\\/g, '/')
}

export class SessionFileHandleRegistry {
  private readonly records = new Map<string, SessionFileRecord>()
  private readonly newId: () => string
  private readonly maxPreviewBytes: number

  constructor(options: SessionFileHandleRegistryOptions = {}) {
    this.newId = options.newId ?? (() => randomUUID())
    this.maxPreviewBytes = options.maxPreviewBytes ?? DEFAULT_MAX_PREVIEW_BYTES
  }

  list(clientId: string, session: SessionKey, sessionRootPath: string): SessionFileHandle[] {
    this.clearSession(clientId, session)
    const rootRealPath = realpathSync(sessionRootPath)
    const handles: SessionFileHandle[] = []

    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'session.jsonl' || entry.name.startsWith('.')) continue
        const absolutePath = join(directory, entry.name)
        const lstat = lstatSync(absolutePath)
        if (lstat.isSymbolicLink()) continue
        const kind: SessionFileHandle['kind'] | null = lstat.isDirectory()
          ? 'directory'
          : lstat.isFile()
            ? 'file'
            : null
        if (!kind) continue

        const handleId = this.newId()
        this.records.set(handleId, {
          handleId,
          clientId,
          session: { ...session },
          rootRealPath,
          absolutePath,
          kind,
        })
        handles.push({
          handleId,
          name: entry.name,
          displayPath: displayPath(rootRealPath, absolutePath),
          kind,
          ...(kind === 'file' ? { size: lstat.size } : {}),
        })
        if (kind === 'directory') walk(absolutePath)
      }
    }

    walk(rootRealPath)
    return handles.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.displayPath.localeCompare(b.displayPath)
    })
  }

  resolve(clientId: string, session: SessionKey, handleId: string): string {
    const record = this.records.get(handleId)
    if (!record) throw new SessionFileHandleError('unknown-handle')
    if (record.clientId !== clientId || !sameSession(record.session, session)) {
      throw new SessionFileHandleError('scope-mismatch')
    }

    let currentPath: string
    try {
      currentPath = realpathSync(record.absolutePath)
      const currentStat = statSync(currentPath)
      if ((record.kind === 'file' && !currentStat.isFile())
        || (record.kind === 'directory' && !currentStat.isDirectory())) {
        throw new SessionFileHandleError('stale-handle')
      }
    } catch (error) {
      if (error instanceof SessionFileHandleError) throw error
      throw new SessionFileHandleError('stale-handle')
    }
    if (!isPathWithin(record.rootRealPath, currentPath)) {
      throw new SessionFileHandleError('stale-handle')
    }
    return currentPath
  }

  preview(clientId: string, session: SessionKey, handleId: string): string | null {
    const absolutePath = this.resolve(clientId, session, handleId)
    const record = this.records.get(handleId)!
    if (record.kind !== 'file') throw new SessionFileHandleError('not-previewable')
    if (statSync(absolutePath).size > this.maxPreviewBytes) return null
    const extension = extname(absolutePath).toLowerCase()
    const imageMime = IMAGE_MIME_BY_EXTENSION[extension]
    if (imageMime) {
      return `data:${imageMime};base64,${readFileSync(absolutePath).toString('base64')}`
    }
    if (!PREVIEWABLE_EXTENSIONS.has(extension)) return null
    return readFileSync(absolutePath, 'utf8')
  }

  clearClient(clientId: string): void {
    for (const [handleId, record] of this.records) {
      if (record.clientId === clientId) this.records.delete(handleId)
    }
  }

  private clearSession(clientId: string, session: SessionKey): void {
    for (const [handleId, record] of this.records) {
      if (record.clientId === clientId && sameSession(record.session, session)) {
        this.records.delete(handleId)
      }
    }
  }
}

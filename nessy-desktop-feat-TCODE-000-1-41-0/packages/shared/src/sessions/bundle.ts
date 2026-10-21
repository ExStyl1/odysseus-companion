/**
 * Session Bundle — Serialization Format for Session Export/Import
 *
 * A SessionBundle is the portable representation of a session directory,
 * used for transferring sessions between workspaces (same-server or cross-server).
 *
 * This is the foundation for session dispatch (move/fork), backup, and sharing.
 *
 * Bundles are addressed by composite `SessionKey` and never contain a managed
 * absolute storage path: the header's Workspace identity is stripped (the importing
 * server assigns its own target `workspaceId`) and embedded session-dir paths stay
 * tokenized as `{{SESSION_PATH}}`.
 */

import { existsSync, readFileSync } from 'fs'
import type { SessionHeader, SessionKey, StoredMessage } from './types.ts'
import { normalizeHeaderPermissionModes, readSessionJsonl, tokenizeSessionDir } from './jsonl.ts'
import { getSessionDirPath, getSessionFilePath } from './storage.ts'
import { CONFIG_DIR, isPathWithin } from '../workspaces/paths.ts'
import { debug } from '../utils/debug.ts'
import {
  type BundleFile,
  MAX_BUNDLE_SIZE_BYTES,
  collectDirectoryFiles,
} from '../utils/bundle-files.ts'

// Re-export BundleFile and MAX_BUNDLE_SIZE_BYTES for backward compatibility
export { type BundleFile, MAX_BUNDLE_SIZE_BYTES } from '../utils/bundle-files.ts'

/**
 * Directories to skip when collecting session files for export.
 * tmp/ is regenerable; dotfiles are typically internal state.
 */
const SKIP_DIRS = new Set(['tmp'])

/**
 * Files to skip when collecting session files for export.
 * session.jsonl is in the bundle as structured data.
 */
const SKIP_SESSION_FILES = new Set(['session.jsonl', 'session.jsonl.tmp'])

/**
 * Dispatch mode determines how the imported session relates to the original.
 */
export type DispatchMode = 'move' | 'fork'

/**
 * Branch info for fork operations.
 * Enables SDK-level conversation branching on the target server,
 * so the forked session has full context from the original.
 */
export interface BundleBranchInfo {
  /** SDK session ID to branch from */
  sdkSessionId: string
  /** SDK turn ID (branch point) */
  sdkTurnId: string
  /** Working directory for SDK session storage */
  sdkCwd: string
}

/**
 * Serialized representation of a session directory.
 * JSON envelope format — sessions are typically small (text + a few attachments).
 */
/**
 * Bundle header: a SessionHeader without server-local Workspace identity — the
 * importing server assigns the target `workspaceId`.
 */
export type BundleSessionHeader = Omit<SessionHeader, 'workspaceId'> & { workspaceId?: string }

export interface SessionBundle {
  /** Bundle format version */
  version: 1
  /** Session data (header metadata + full message history) */
  session: {
    /** Session metadata (id, name, timestamps, config) */
    header: BundleSessionHeader
    /** Full message history */
    messages: StoredMessage[]
  }
  /** All files from the session directory (attachments, plans, data, downloads, etc.) */
  files: BundleFile[]
  /** Branch info for fork operations (populated by the exporter when forking) */
  branchInfo?: BundleBranchInfo
}

/**
 * Serialize a session directory into a SessionBundle.
 *
 * Reads the session JSONL and all associated files (attachments, plans, data, downloads).
 * Skips tmp/ directory and dotfiles. Validates total size against MAX_BUNDLE_SIZE_BYTES.
 *
 * @param key - Composite Workspace ID + session ID of the session to serialize
 * @returns SessionBundle or null if session doesn't exist or exceeds size limit
 */
export function serializeSession(key: SessionKey): SessionBundle | null {
  const sessionDir = getSessionDirPath(key.workspaceId, key.sessionId)
  const sessionFile = getSessionFilePath(key.workspaceId, key.sessionId)

  if (!existsSync(sessionFile)) {
    debug('[bundle] Session file not found:', sessionFile)
    return null
  }

  // Read and parse session JSONL
  const stored = readSessionJsonl(sessionFile)
  if (!stored) {
    debug('[bundle] Failed to parse session JSONL:', sessionFile)
    return null
  }

  // Collect all files from session directory (except session.jsonl and tmp/)
  const files = collectDirectoryFiles(sessionDir, {
    skipDirs: SKIP_DIRS,
    skipFiles: SKIP_SESSION_FILES,
  })

  // Validate total bundle size
  const totalSize = files.reduce((sum, f) => sum + f.size, 0)
  if (totalSize > MAX_BUNDLE_SIZE_BYTES) {
    debug(`[bundle] Session exceeds max bundle size: ${totalSize} bytes > ${MAX_BUNDLE_SIZE_BYTES} bytes`)
    return null
  }

  // Build header from stored session (re-use the header creation from JSONL)
  // We read the raw header from the JSONL to preserve pre-computed fields
  const rawContent = readFileSync(sessionFile, 'utf-8')
  const firstLine = rawContent.split('\n')[0]
  if (!firstLine) return null

  // Strip server-internal fields that shouldn't travel with the bundle.
  // Defense-in-depth: re-tokenize any absolute session-dir path before parsing so a
  // managed storage path never leaves this server inside the envelope.
  //
  // P3.324 — `tokenizeSessionDir`, NOT `makeSessionPathPortable`. This line is
  // read back from disk, so its literal `{{SESSION_PATH}}` tokens were already
  // escaped when it was written; the full transform would add a second escape
  // marker and the importing server would read them one level short. The
  // idempotent half is exactly the defence this comment describes.
  const header = normalizeHeaderPermissionModes(JSON.parse(tokenizeSessionDir(firstLine, sessionDir)) as BundleSessionHeader) // F1.1234: never exports explore
  // The importing server assigns its own target workspaceId.
  delete header.workspaceId
  // A branch provider cwd can point at the source parent's managed session
  // directory, which is not portable and must never leave this server. The
  // importer rebases the parent identity without retaining the source-local cwd.
  if (header.branchFrom?.sdkCwd && isPathWithin(CONFIG_DIR, header.branchFrom.sdkCwd)) {
    header.branchFrom = { ...header.branchFrom }
    delete header.branchFrom.sdkCwd
  }

  return {
    version: 1,
    session: {
      header,
      messages: stored.messages,
    },
    files,
  }
}

/**
 * Validate a SessionBundle structure.
 * Checks version, required fields, and basic integrity.
 */
export function validateBundle(bundle: unknown): bundle is SessionBundle {
  if (!bundle || typeof bundle !== 'object') return false
  const b = bundle as Record<string, unknown>

  if (b.version !== 1) return false
  if (!b.session || typeof b.session !== 'object') return false

  const session = b.session as Record<string, unknown>
  if (!session.header || typeof session.header !== 'object') return false
  if (!Array.isArray(session.messages)) return false

  const header = session.header as Record<string, unknown>
  if (typeof header.id !== 'string') return false
  if (typeof header.createdAt !== 'number') return false

  if (header.branchFrom !== undefined) {
    if (!header.branchFrom || typeof header.branchFrom !== 'object' || Array.isArray(header.branchFrom)) return false
    const branchFrom = header.branchFrom as Record<string, unknown>
    if (!branchFrom.parent || typeof branchFrom.parent !== 'object' || Array.isArray(branchFrom.parent)) return false
    const parent = branchFrom.parent as Record<string, unknown>
    if (typeof parent.workspaceId !== 'string' || parent.workspaceId.length === 0) return false
    if (typeof parent.sessionId !== 'string' || parent.sessionId.length === 0) return false
    for (const field of ['messageId', 'sdkSessionId', 'sdkCwd', 'sdkTurnId'] as const) {
      if (branchFrom[field] !== undefined && typeof branchFrom[field] !== 'string') return false
    }
  }

  if (!Array.isArray(b.files)) return false

  return true
}

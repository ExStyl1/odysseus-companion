/**
 * Session Storage (ID-first, global v2 layout)
 *
 * Sessions are Nessy-owned and stored globally at
 * `SESSIONS_DIR/<workspaceId>/<sessionId>/`, partitioned by immutable Workspace ID.
 * Every helper here is addressed by `workspaceId` + `sessionId` — never by a managed
 * `workspaceRootPath`. Managed paths are derived only at the I/O boundary inside this
 * module (and `getWorkspaceRootPath(workspaceId)` for workspace-scoped status config).
 *
 * Each session folder contains:
 * - session.jsonl (main data in JSONL format: line 1 = header, lines 2+ = messages)
 * - attachments/ (file attachments)
 * - plans/ (plan files for Safe Mode)
 * - data/ (transform_data tool output: JSON files for datatable/spreadsheet blocks)
 * - long_responses/ (full tool results that were summarized due to size limits)
 * - downloads/ (binary files downloaded from API sources: PDFs, images, archives, etc.)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'fs';
import { join, basename } from 'path';
import {
  getSessionStoragePath,
  getWorkspaceRootPath,
  getWorkspaceSessionRootPath,
} from '../workspaces/paths.ts';
import { generateUniqueSessionId } from './slug-generator.ts';
import { expandPath } from '../utils/paths.ts';
import { sanitizeSessionId } from './validation.ts';
import { resolveWorktreeAwareWorkingDirectory } from './worktree-resume.ts';
import { perf } from '../utils/perf.ts';
import type {
  SessionConfig,
  SessionKey,
  StoredSession,
  SessionMetadata,
  SessionHeader,
  SessionStatus,
} from './types.ts';
import type { Plan } from '../agent/plan-types.ts';
import { validateSessionStatus } from '../statuses/validation.ts';
import { debug } from '../utils/debug.ts';
import { getStatusCategory } from '../statuses/storage.ts';
import { readSessionHeader, readSessionJsonl } from './jsonl.ts';
import { sessionPersistenceQueue } from './persistence-queue.ts';
import { removeLegacyWorkspaceSessionDir } from './store-v2.ts';
// Re-export types for convenience
export type { SessionConfig } from './types.ts';

// ============================================================
// Directory Utilities
// ============================================================

/**
 * Ensure the global sessions directory exists for a Workspace ID.
 */
export function ensureSessionsDir(workspaceId: string): string {
  const dir = getWorkspaceSessionRootPath(workspaceId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get path to a session's directory (global v2 layout).
 */
export function getSessionDirPath(workspaceId: string, sessionId: string): string {
  return getSessionStoragePath(workspaceId, sanitizeSessionId(sessionId));
}

/**
 * P6.535 — the page's `~/.claude/jobs/<id>` shape, on our own per-session
 * directory.
 *
 * `agent-view.md#where-state-is-stored`, verbatim: *"Each background session has
 * the `CLAUDE_JOB_DIR` environment variable set to its `~/.claude/jobs/<id>`
 * directory, so shell commands the session runs can write temporary files to
 * `$CLAUDE_JOB_DIR/tmp` without colliding with parallel sessions."* Owner D3 = B
 * puts that directory under OUR per-session root rather than in `~/.claude`, so
 * one session's scratch is one session's, it is outside the workspace, and it
 * dies with the session.
 *
 * SEPARATE from `plans/` and `data/` beside it, and that is the point rather
 * than an oversight: those two are semantic — the mode gate's own hint tells the
 * model *"For plans, write to: …"* — so neither is a scratch space, and a
 * throwaway file landing in `plans/` would be indistinguishable from a plan.
 *
 * A PATH only, and {@link ensureSessionJobDir} is the half that creates it —
 * because handing the model a path that does not exist is worse than not naming
 * one.
 */
export function getSessionJobDir(workspaceId: string, sessionId: string): string {
  return join(getSessionDirPath(workspaceId, sessionId), 'job');
}

/**
 * P6.535 — create the scratch directory, then return the name to write.
 *
 * ONE function for all three runtimes, and that is the point rather than tidying.
 * The claude arm landed with the create-then-name pair inline in `options.ts`;
 * the Pi and codex arms need the identical pair, and the defect two more copies
 * reproduce is a forgotten `mkdir` — an environment variable naming a directory
 * that does not exist turns the page's promise (*"shell commands the session
 * runs can write temporary files to `$CLAUDE_JOB_DIR/tmp`"*) into a failing
 * command with a confusing message. The row's own controller decision says the
 * env line must never land without the mkdir; this is the shape that makes that
 * unforgettable rather than remembered three times.
 *
 * `tmp/` is what is created, not the job directory itself: `tmp/` is the
 * subdirectory the page names, and creating the parent alone would satisfy an
 * `existsSync` while still failing the write the promise is about.
 *
 * Returns `undefined` for "no identity, or a directory we could not create" —
 * a scratch space we cannot make is one we must not name.
 */
export function ensureSessionJobDir(
  workspaceId: string | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (!workspaceId || !sessionId) return undefined;
  const jobDir = getSessionJobDir(workspaceId, sessionId);
  try {
    mkdirSync(join(jobDir, 'tmp'), { recursive: true });
  } catch {
    return undefined;
  }
  return jobDir;
}

/**
 * P6.535 — the host-supplied name for the scratch directory on the runtimes
 * that have none of their own.
 *
 * claude reads `CLAUDE_JOB_DIR`, which is why its arm was pure configuration
 * (native-first tier 1). Pi and codex read no name like it — measured, and
 * recorded on the switch report — so the host supplies one, spelled the way
 * every other host-owned variable in this fork is (`NESSY_SESSION_DIR`,
 * `NESSY_SESSION_ID`). It is a HOST-supplied equivalent and not a native
 * mechanism, and the switch report says so rather than letting the difference
 * be invisible.
 */
export const SESSION_JOB_DIR_ENV_VAR = 'NESSY_SESSION_JOB_DIR';

/**
 * Get path to a session's JSONL file (inside session folder)
 */
export function getSessionFilePath(workspaceId: string, sessionId: string): string {
  return join(getSessionDirPath(workspaceId, sessionId), 'session.jsonl');
}

/**
 * Ensure session directory exists with all subdirectories
 */
export function ensureSessionDir(workspaceId: string, sessionId: string): string {
  const sessionDir = getSessionDirPath(workspaceId, sessionId);
  for (const dir of [
    sessionDir,
    join(sessionDir, 'plans'),
    join(sessionDir, 'attachments'),
    join(sessionDir, 'long_responses'),
    // Data directory for transform_data tool output (JSON files for datatable/spreadsheet)
    join(sessionDir, 'data'),
    // Downloads directory for binary files from API responses (PDFs, images, etc.)
    join(sessionDir, 'downloads'),
  ]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  return sessionDir;
}

/**
 * Get the attachments directory for a session
 */
export function getSessionAttachmentsPath(workspaceId: string, sessionId: string): string {
  return join(getSessionDirPath(workspaceId, sessionId), 'attachments');
}

/**
 * Get the plans directory for a session (global v2 layout)
 */
export function getSessionPlansDir(workspaceId: string, sessionId: string): string {
  return join(getSessionDirPath(workspaceId, sessionId), 'plans');
}

/**
 * Get the data directory for a session (transform_data tool output)
 */
export function getSessionDataPath(workspaceId: string, sessionId: string): string {
  return join(getSessionDirPath(workspaceId, sessionId), 'data');
}

/**
 * Get the downloads directory for a session (binary files from API responses)
 */
export function getSessionDownloadsPath(workspaceId: string, sessionId: string): string {
  return join(getSessionDirPath(workspaceId, sessionId), 'downloads');
}

// ============================================================
// Session ID Generation
// ============================================================

/**
 * Get existing session IDs for collision detection
 */
function getExistingSessionIds(workspaceId: string): Set<string> {
  const sessionsDir = getWorkspaceSessionRootPath(workspaceId);
  if (!existsSync(sessionsDir)) {
    return new Set();
  }
  const entries = readdirSync(sessionsDir, { withFileTypes: true });
  return new Set(entries.filter(e => e.isDirectory()).map(e => e.name));
}

/**
 * Generate a human-readable session ID
 * Format: YYMMDD-adjective-noun (e.g., 260111-swift-river)
 */
export function generateSessionId(workspaceId: string): string {
  const existingIds = getExistingSessionIds(workspaceId);
  return generateUniqueSessionId(existingIds);
}

// ============================================================
// Session CRUD
// ============================================================

/**
 * Create a new session for a Workspace (by immutable Workspace ID)
 */
export async function createSession(
  workspaceId: string,
  options?: {
    name?: string;
    workingDirectory?: string;
    permissionMode?: SessionConfig['permissionMode'];
    enabledSourceSlugs?: string[];
    model?: string;
    llmConnection?: string;
    hidden?: boolean;
    sessionStatus?: SessionConfig['sessionStatus'];
    labels?: string[];
    isFlagged?: boolean;
    /**
     * In-memory only: no session record or metadata is written to disk; the
     * session vanishes on close/restart.
     */
    ephemeral?: boolean;
  }
): Promise<SessionConfig> {
  ensureSessionsDir(workspaceId);

  const now = Date.now();
  const sessionId = generateSessionId(workspaceId);

  // Create session directory with all subdirectories (plans, attachments)
  ensureSessionDir(workspaceId, sessionId);

  // Set sdkCwd to initial working directory or session path - this never changes
  // The SDK stores session transcripts at ~/.claude/projects/{cwd-slugified}/
  // If workingDirectory changes later, sdkCwd stays the same to preserve session resumption
  const sdkCwd = options?.workingDirectory ?? getSessionDirPath(workspaceId, sessionId);

  const session: SessionConfig = {
    id: sessionId,
    workspaceId,
    name: options?.name,
    createdAt: now,
    lastUsedAt: now,
    workingDirectory: options?.workingDirectory,
    sdkCwd,
    permissionMode: options?.permissionMode,
    enabledSourceSlugs: options?.enabledSourceSlugs,
    model: options?.model,
    llmConnection: options?.llmConnection,
    hidden: options?.hidden,
    sessionStatus: options?.sessionStatus,
    labels: options?.labels,
    isFlagged: options?.isFlagged,
  };

  if (!options?.ephemeral) {
    // Save empty session
    const storedSession: StoredSession = {
      ...session,
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    };
    await saveSession(storedSession);
  }

  return session;
}

/**
 * Get or create a session with a specific ID
 * Used for --session <id> flag to allow user-defined session IDs
 */
export async function getOrCreateSessionById(
  workspaceId: string,
  sessionId: string
): Promise<SessionConfig> {
  const existing = loadSession(workspaceId, sessionId);
  if (existing) {
    return {
      id: existing.id,
      sdkSessionId: existing.sdkSessionId,
      workspaceId: existing.workspaceId,
      name: existing.name,
      createdAt: existing.createdAt,
      lastUsedAt: existing.lastUsedAt,
      sdkCwd: existing.sdkCwd,
      workingDirectory: existing.workingDirectory,
    };
  }

  // Create new session with the specified ID
  ensureSessionsDir(workspaceId);

  // Create session directory with all subdirectories (plans, attachments)
  ensureSessionDir(workspaceId, sessionId);

  const now = Date.now();
  // Set sdkCwd to session path - this never changes (ensures SDK can find session transcripts)
  const sdkCwd = getSessionDirPath(workspaceId, sessionId);

  const session: SessionConfig = {
    id: sessionId,
    workspaceId,
    sdkCwd,
    createdAt: now,
    lastUsedAt: now,
  };

  const storedSession: StoredSession = {
    ...session,
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  };
  await saveSession(storedSession);

  return session;
}

/**
 * Save session immediately using the persistence queue.
 * Enqueues the session and flushes to ensure immediate write.
 *
 * This unified approach ensures all session writes go through the same
 * async code path, which is more reliable on Windows.
 *
 * Writes in JSONL format: line 1 = header, lines 2+ = messages
 */
export async function saveSession(session: StoredSession): Promise<void> {
  sessionPersistenceQueue.enqueue(session);
  await sessionPersistenceQueue.flush({ workspaceId: session.workspaceId, sessionId: session.id });
}

/**
 * Queue session for async persistence with debouncing.
 * Multiple rapid calls are coalesced into a single write.
 * Use this during active sessions to avoid blocking the main thread.
 */
export { sessionPersistenceQueue, getHeaderMetadataSignature } from './persistence-queue.js'

/**
 * Load session by ID
 * Loads session from folder structure in JSONL format.
 */
export function loadSession(workspaceId: string, sessionId: string): StoredSession | null {
  const end = perf.start('session.loadSession', { sessionId });

  const jsonlPath = getSessionFilePath(workspaceId, sessionId);
  if (existsSync(jsonlPath)) {
    const session = readSessionJsonl(jsonlPath);
    if (session) {
      end();
      return session;
    }
  }

  end();
  return null;
}

/**
 * List sessions for a Workspace (by immutable Workspace ID)
 * Lists sessions from the global v2 folder structure.
 *
 * Uses JSONL header for fast loading (only reads first line of each file).
 */
export function listSessions(workspaceId: string): SessionMetadata[] {
  const span = perf.span('session.listSessions');
  const sessionsDir = getWorkspaceSessionRootPath(workspaceId);
  if (!existsSync(sessionsDir)) {
    span.end();
    return [];
  }

  const entries = readdirSync(sessionsDir, { withFileTypes: true });
  span.mark('readdir');
  const sessions: SessionMetadata[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sessionId = entry.name;
      const sessionDir = join(sessionsDir, sessionId);
      const jsonlFile = join(sessionDir, 'session.jsonl');

      // Clean up orphaned .tmp files from crashed atomic writes.
      // These are harmless but waste disk space.
      const tmpFile = jsonlFile + '.tmp';
      if (existsSync(tmpFile)) {
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
      }

      if (existsSync(jsonlFile)) {
        const header = readSessionHeader(jsonlFile);
        if (header) {
          const metadata = headerToMetadata(header, workspaceId);
          if (metadata) sessions.push(metadata);
        }
      }
    }
  }
  span.mark('parsed');
  span.setMetadata('count', sessions.length);

  // Sort by lastUsedAt descending (most recent first)
  const sorted = sessions.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  span.end();
  return sorted;
}

/**
 * Convert SessionHeader to SessionMetadata
 * Used for fast session list loading from JSONL format.
 */
function headerToMetadata(header: SessionHeader, workspaceId: string): SessionMetadata | null {
  try {
    // Migration: accept old 'todoState' field from pre-rename session files
    const rawStatus = header.sessionStatus ?? (header as unknown as { todoState?: string }).todoState;
    // Validate sessionStatus against workspace status config.
    // Status config is workspace-scoped: derive the managed root at this I/O boundary only.
    const validatedStatus = validateSessionStatus(getWorkspaceRootPath(workspaceId), rawStatus);

    // Count plan files for this session
    const planCount = listPlanFiles(workspaceId, header.id).length;

    // Migration: For sessions created before sdkCwd was added, use workingDirectory as fallback.
    const recordedWorkingDir = header.workingDirectory ? expandPath(header.workingDirectory) : undefined;
    const sdkCwd = header.sdkCwd ? expandPath(header.sdkCwd) : recordedWorkingDir;
    // A session that entered a worktree is recorded under it, and reopening
    // must find it there — unless the worktree is gone, in which case the
    // documented behaviour is to land in the launch directory rather than fail
    // to open the session at all.
    const workingDir = resolveWorktreeAwareWorkingDirectory({
      workingDirectory: recordedWorkingDir,
      sdkCwd,
      exists: existsSync,
    });

    // Destructure fields that don't exist on SessionMetadata or need overrides
    const {
      enabledSourceSlugs: _es, pendingPlanExecution: _pp,
      sessionStatus: _ss, workingDirectory: _wd, sdkCwd: _sc,
      ...headerFields
    } = header;

    return {
      ...headerFields,
      workspaceId,
      sessionStatus: validatedStatus,
      planCount: planCount > 0 ? planCount : undefined,
      workingDirectory: workingDir,
      sdkCwd,
    } as SessionMetadata;
  } catch (error) {
    debug(`[sessions] Failed to convert header to metadata for session "${header?.id}" in workspace ${workspaceId}:`, error);
    return null;
  }
}

/**
 * Delete a session and its associated files
 * Deletes session folder and all associated files
 */
export function deleteSession(workspaceId: string, sessionId: string): boolean {
  try {
    // Delete session directory (includes session.jsonl, attachments, plans)
    const sessionDir = getSessionDirPath(workspaceId, sessionId);
    if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true });
    // F1.776 — and the pre-storage-v2 folder old codex builds wrote; never throws.
    removeLegacyWorkspaceSessionDir(workspaceId, sessionId);

    return true;
  } catch {
    return false;
  }
}

// NOTE: `clearSessionMessages` was deleted here (R36/f074). Its doc-comment
// claimed the /clear command as a caller, but no production caller ever
// existed (`grep -rna` finds only the definition and its re-export), and it
// wrote a StoredSession behind SessionManager's back — `enqueuePersist`
// rebuilds the snapshot from `managed.messages` on the next persist, silently
// undoing it. The /clear reset lives in `SessionManager.sendMessage`'s
// complete-event handling (copy-shaped from the rewind path) instead.

/**
 * Get or create the latest session for a Workspace
 * Uses listActiveSessions to exclude archived sessions
 */
export async function getOrCreateLatestSession(workspaceId: string): Promise<SessionConfig> {
  const sessions = listActiveSessions(workspaceId);
  if (sessions.length > 0 && sessions[0]) {
    const latest = sessions[0];
    return {
      id: latest.id,
      sdkSessionId: latest.sdkSessionId,
      workspaceId: latest.workspaceId,
      name: latest.name,
      createdAt: latest.createdAt,
      lastUsedAt: latest.lastUsedAt,
    };
  }
  return createSession(workspaceId);
}

// ============================================================
// Session Metadata Updates
// ============================================================

/**
 * Update SDK session ID for a session
 */
export async function updateSessionSdkId(
  workspaceId: string,
  sessionId: string,
  sdkSessionId: string
): Promise<void> {
  const session = loadSession(workspaceId, sessionId);
  if (session) {
    session.sdkSessionId = sdkSessionId;
    await saveSession(session);
  }
}

/**
 * Check if sdkCwd can be safely updated for a session.
 *
 * sdkCwd is normally immutable because the SDK stores session transcripts at
 * ~/.claude/projects/{cwd-slugified}/. However, it's safe to update sdkCwd if
 * no SDK interaction has occurred yet (no transcripts to preserve).
 *
 * @returns true if sdkCwd can be updated (no messages and no SDK session ID)
 */
export function canUpdateSdkCwd(session: StoredSession): boolean {
  // Safe to update if:
  // 1. No messages have been sent yet (no conversation to preserve)
  // 2. No SDK session ID (no transcript exists at the sdkCwd path)
  return session.messages.length === 0 && !session.sdkSessionId;
}

/**
 * Update session metadata
 */
export async function updateSessionMetadata(
  workspaceId: string,
  sessionId: string,
  updates: Partial<Pick<SessionConfig,
    | 'isFlagged'
    | 'name'
    | 'sessionStatus'
    | 'labels'
    | 'lastReadMessageId'
    | 'hasUnread'
    | 'enabledSourceSlugs'
    | 'workingDirectory'
    | 'sdkCwd'
    | 'permissionMode'
    | 'sharedUrl'
    | 'sharedId'
    | 'model'
    | 'llmConnection'
    | 'isArchived'
    | 'archivedAt' | 'kanbanColumn' | 'projectId' | 'taskNodeCount' | 'taskDraft' | 'taskSlug' // UA2.1; UA3.1 (v0.13.4's Pick)
  >>
): Promise<void> {
  const session = loadSession(workspaceId, sessionId);
  if (!session) return;

  if (updates.isFlagged !== undefined) session.isFlagged = updates.isFlagged;
  if (updates.name !== undefined) session.name = updates.name;
  if (updates.sessionStatus !== undefined) session.sessionStatus = updates.sessionStatus;
  if (updates.labels !== undefined) session.labels = updates.labels;
  if (updates.enabledSourceSlugs !== undefined) session.enabledSourceSlugs = updates.enabledSourceSlugs;
  if (updates.workingDirectory !== undefined) session.workingDirectory = updates.workingDirectory;
  if (updates.sdkCwd !== undefined) session.sdkCwd = updates.sdkCwd;
  if (updates.permissionMode !== undefined) session.permissionMode = updates.permissionMode;
  if ('lastReadMessageId' in updates) session.lastReadMessageId = updates.lastReadMessageId;
  if ('hasUnread' in updates) session.hasUnread = updates.hasUnread;
  if ('sharedUrl' in updates) session.sharedUrl = updates.sharedUrl;
  if ('sharedId' in updates) session.sharedId = updates.sharedId;
  if (updates.model !== undefined) session.model = updates.model;
  if (updates.llmConnection !== undefined) session.llmConnection = updates.llmConnection;
  if (updates.isArchived !== undefined) session.isArchived = updates.isArchived;
  if ('archivedAt' in updates) session.archivedAt = updates.archivedAt; if ('kanbanColumn' in updates) session.kanbanColumn = updates.kanbanColumn; if ('projectId' in updates) session.projectId = updates.projectId; if ('taskNodeCount' in updates) session.taskNodeCount = updates.taskNodeCount; if ('taskDraft' in updates) session.taskDraft = updates.taskDraft; if ('taskSlug' in updates) session.taskSlug = updates.taskSlug; // UA2.1, UA3.1 — `in`: a present undefined clears

  await saveSession(session);
}

/**
 * Flag a session
 */
export async function flagSession(workspaceId: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceId, sessionId, { isFlagged: true });
}

/**
 * Unflag a session
 */
export async function unflagSession(workspaceId: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceId, sessionId, { isFlagged: false });
}

/**
 * Set session status
 */
export async function setSessionStatus(
  workspaceId: string,
  sessionId: string,
  sessionStatus: SessionStatus
): Promise<void> {
  await updateSessionMetadata(workspaceId, sessionId, { sessionStatus });
}

/**
 * Set labels for a session
 */
export async function setSessionLabels(
  workspaceId: string,
  sessionId: string,
  labels: string[]
): Promise<void> {
  await updateSessionMetadata(workspaceId, sessionId, { labels });
}

/**
 * Archive a session
 */
export async function archiveSession(workspaceId: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceId, sessionId, {
    isArchived: true,
    archivedAt: Date.now(),
  });
}

/**
 * Unarchive a session
 */
export async function unarchiveSession(workspaceId: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceId, sessionId, {
    isArchived: false,
    archivedAt: undefined,
  });
}

// ============================================================
// Pending Plan Execution (Accept & Compact flow)
// ============================================================

/**
 * Set pending plan execution state.
 * Called when user clicks "Accept & Compact" - stores the plan path
 * so it can be executed after compaction, even if the page reloads.
 * F1.241 — held in process first ({@link pendingPlanRecords}), the session header second.
 */
export async function setPendingPlanExecution(
  workspaceId: string,
  sessionId: string,
  planPath: string,
  draftInputSnapshot?: string,
): Promise<void> {
  const session = loadSession(workspaceId, sessionId);
  if (!session) return;

  const record = { planPath, draftInputSnapshot, awaitingCompaction: true, executionDispatched: false };
  pendingPlanRecords.set(pendingPlanKey(workspaceId, sessionId), record);
  session.pendingPlanExecution = { ...record };
  await saveSession(session);
}

/**
 * Mark compaction as complete for pending plan execution.
 * Called when compaction_complete event fires - sets awaitingCompaction to false
 * so reload recovery knows compaction finished and can trigger execution.
 * F1.241 — the host calls it for a MANUAL compaction only (`SessionManager`'s `info` case).
 */
export async function markCompactionComplete(
  workspaceId: string,
  sessionId: string
): Promise<void> {
  const record = readPendingPlanRecord(workspaceId, sessionId);
  if (!record) return;
  pendingPlanRecords.set(pendingPlanKey(workspaceId, sessionId), { ...record, awaitingCompaction: false });
  await mirrorPendingPlanRecord(workspaceId, sessionId);
}

/**
 * F1.241 — THE claim an Accept & Compact plan is sent under: `true` for exactly ONE caller,
 * and only while a plan is pending, its compaction done and nobody has claimed it. It was
 * `Promise<void>` and could refuse nothing. The read and the set are one synchronous segment
 * on the in-process record, so a concurrent claim cannot slip between them.
 */
export async function markPendingPlanExecutionDispatched(
  workspaceId: string,
  sessionId: string
): Promise<boolean> {
  const record = readPendingPlanRecord(workspaceId, sessionId);
  if (!record || record.awaitingCompaction || record.executionDispatched) return false;
  pendingPlanRecords.set(pendingPlanKey(workspaceId, sessionId), { ...record, executionDispatched: true });
  await mirrorPendingPlanRecord(workspaceId, sessionId);
  return true;
}

/**
 * Clear pending plan execution state — after the plan is sent, on every new user message. UA12.35 (craft-agents-oss
 * v0.14.0, Apache-2.0): nothing pending on disk → no rewrite; a whole-file save here REPLACED a pending debounced
 * snapshot with the stale disk copy on every send. The in-process record is dropped first either way.
 */
export async function clearPendingPlanExecution(
  workspaceId: string,
  sessionId: string
): Promise<void> {
  pendingPlanRecords.delete(pendingPlanKey(workspaceId, sessionId));
  const session = loadSession(workspaceId, sessionId);
  if (!session?.pendingPlanExecution) return;

  delete session.pendingPlanExecution;
  await saveSession(session);
}

/**
 * Get pending plan execution state for a session.
 * Used on reload to check if we need to resume plan execution.
 */
export function getPendingPlanExecution(
  workspaceId: string,
  sessionId: string
): { planPath: string; draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null {
  const record = readPendingPlanRecord(workspaceId, sessionId);
  if (!record) return null;
  return {
    ...record,
    executionDispatched: record.executionDispatched === true,
  };
}

// ============================================================
// Session Filtering
// ============================================================

/**
 * List flagged sessions (excludes archived)
 */
export function listFlaggedSessions(workspaceId: string): SessionMetadata[] {
  return listActiveSessions(workspaceId).filter(s => s.isFlagged === true);
}

/**
 * List completed sessions (category: closed)
 * Includes done, cancelled, and any custom "closed" statuses
 * Excludes archived sessions
 */
export function listCompletedSessions(workspaceId: string): SessionMetadata[] {
  const workspaceRootPath = getWorkspaceRootPath(workspaceId);
  return listActiveSessions(workspaceId).filter(s => {
    const category = getStatusCategory(workspaceRootPath, s.sessionStatus || 'todo');
    return category === 'closed';
  });
}

/**
 * List inbox sessions (category: open)
 * Includes todo, in-progress, needs-review, and any custom "open" statuses
 * Excludes archived sessions
 */
export function listInboxSessions(workspaceId: string): SessionMetadata[] {
  const workspaceRootPath = getWorkspaceRootPath(workspaceId);
  return listActiveSessions(workspaceId).filter(s => {
    const category = getStatusCategory(workspaceRootPath, s.sessionStatus || 'todo');
    return category === 'open';
  });
}

/**
 * List archived sessions
 */
export function listArchivedSessions(workspaceId: string): SessionMetadata[] {
  return listSessions(workspaceId).filter(s => s.isArchived === true);
}

/**
 * List active (non-archived) sessions
 */
export function listActiveSessions(workspaceId: string): SessionMetadata[] {
  return listSessions(workspaceId).filter(s => s.isArchived !== true);
}

/**
 * `deleteOldArchivedSessions` used to live here. It was the ONLY retention sweep
 * and it was archived-only, which is the hole R12 exists to close: the documented
 * sweep "deletes session files and other application data older than this period
 * at startup" with no archive predicate, so a non-zero retention still retained
 * every unarchived transcript forever. It is fully subsumed by
 * `retention-sweep.ts` — an archived session past the cutoff is removed there on
 * the same `archivedAt ?? lastUsedAt` clock — and keeping a second deletion path
 * for user data would be one more place to get a boundary wrong.
 */

// ============================================================
// Plan Storage (Session-Scoped)
// ============================================================

/**
 * Slugify a string for file names
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
}

/**
 * Generate a unique, readable file name for a plan
 */
function generatePlanFileName(plan: Plan, plansDir: string): string {
  let name = plan.title || plan.context?.substring(0, 50) || 'untitled';
  let slug = slugify(name);

  if (slug.length > 40) {
    slug = slug.substring(0, 40).replace(/-$/, '');
  }

  const date = new Date().toISOString().split('T')[0];
  const baseName = `${date}-${slug}`;

  let fileName = baseName;
  let counter = 2;

  while (existsSync(join(plansDir, `${fileName}.md`))) {
    fileName = `${baseName}-${counter}`;
    counter++;
  }

  return fileName;
}

/**
 * Ensure the plans directory exists
 */
function ensurePlansDir(workspaceId: string, sessionId: string): string {
  const plansDir = getSessionPlansDir(workspaceId, sessionId);
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }
  return plansDir;
}

/**
 * Format a plan as markdown
 */
export function formatPlanAsMarkdown(plan: Plan): string {
  const lines: string[] = [];

  lines.push(`# ${plan.title}`);
  lines.push('');
  lines.push(`**Status:** ${plan.state}`);
  lines.push(`**Created:** ${new Date(plan.createdAt).toISOString()}`);
  if (plan.updatedAt !== plan.createdAt) {
    lines.push(`**Updated:** ${new Date(plan.updatedAt).toISOString()}`);
  }
  lines.push('');

  if (plan.context) {
    lines.push('## Summary');
    lines.push('');
    lines.push(plan.context);
    lines.push('');
  }

  lines.push('## Steps');
  lines.push('');
  for (const step of plan.steps) {
    const checkbox = step.status === 'completed' ? '[x]' : '[ ]';
    const status = step.status === 'in_progress' ? ' *(in progress)*' : '';
    lines.push(`- ${checkbox} ${step.description}${status}`);
    if (step.details) {
      lines.push(`  - Tools: ${step.details}`);
    }
  }
  lines.push('');

  if (plan.refinementHistory && plan.refinementHistory.length > 0) {
    lines.push('## Refinement History');
    lines.push('');
    for (const entry of plan.refinementHistory) {
      lines.push(`### Round ${entry.round}`);
      lines.push(`**Feedback:** ${entry.feedback}`);
      if (entry.questions && entry.questions.length > 0) {
        lines.push(`**Questions:** ${entry.questions.join(', ')}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Parse a markdown plan file back to a Plan object
 */
export function parsePlanFromMarkdown(content: string, planId: string): Plan | null {
  try {
    const lines = content.split('\n');

    const titleLine = lines.find(l => l.startsWith('# '));
    const title = titleLine ? titleLine.substring(2).trim() : 'Untitled Plan';

    const statusLine = lines.find(l => l.startsWith('**Status:**'));
    const stateStr = statusLine ? statusLine.replace('**Status:**', '').trim() : 'ready';
    const state = (['creating', 'refining', 'ready', 'executing', 'completed', 'cancelled'].includes(stateStr)
      ? stateStr
      : 'ready') as Plan['state'];

    const summaryIdx = lines.findIndex(l => l === '## Summary');
    const stepsIdx = lines.findIndex(l => l === '## Steps');
    let context = '';
    if (summaryIdx !== -1 && stepsIdx !== -1) {
      context = lines.slice(summaryIdx + 2, stepsIdx).join('\n').trim();
    }

    const steps: Plan['steps'] = [];
    if (stepsIdx !== -1) {
      for (let i = stepsIdx + 2; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.startsWith('##')) break;
        if (line.startsWith('- [')) {
          const isCompleted = line.startsWith('- [x]');
          const isInProgress = line.includes('*(in progress)*');
          const description = line
            .replace(/^- \[[ x]\] /, '')
            .replace(' *(in progress)*', '')
            .trim();
          steps.push({
            id: `step-${steps.length + 1}`,
            description,
            status: isCompleted ? 'completed' : isInProgress ? 'in_progress' : 'pending',
          });
        }
      }
    }

    return {
      id: planId,
      title,
      state,
      context,
      steps,
      refinementRound: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Save a plan to a markdown file
 */
export function savePlanToFile(
  workspaceId: string,
  sessionId: string,
  plan: Plan,
  fileName?: string
): string {
  const plansDir = ensurePlansDir(workspaceId, sessionId);
  const name = fileName || generatePlanFileName(plan, plansDir);
  const filePath = join(plansDir, `${name}.md`);
  const content = formatPlanAsMarkdown(plan);

  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Load a plan from a markdown file by name
 */
export function loadPlanFromFile(
  workspaceId: string,
  sessionId: string,
  fileName: string
): Plan | null {
  const plansDir = getSessionPlansDir(workspaceId, sessionId);
  const filePath = join(plansDir, `${fileName}.md`);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return parsePlanFromMarkdown(content, fileName);
  } catch {
    return null;
  }
}

/**
 * Load a plan from a full file path
 */
export function loadPlanFromPath(filePath: string): Plan | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const fileName = basename(filePath).replace('.md', '') || 'unknown';
    return parsePlanFromMarkdown(content, fileName);
  } catch {
    return null;
  }
}

/**
 * List all plan files in a session
 */
export function listPlanFiles(
  workspaceId: string,
  sessionId: string
): Array<{ name: string; path: string; modifiedAt: number }> {
  const plansDir = getSessionPlansDir(workspaceId, sessionId);
  if (!existsSync(plansDir)) {
    return [];
  }

  try {
    const files = readdirSync(plansDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const filePath = join(plansDir, f);
        const stats = existsSync(filePath) ? statSync(filePath) : null;
        return {
          name: f.replace('.md', ''),
          path: filePath,
          modifiedAt: stats?.mtimeMs || 0,
        };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);

    return files;
  } catch {
    return [];
  }
}

/**
 * Delete a plan file
 */
export function deletePlanFile(
  workspaceId: string,
  sessionId: string,
  fileName: string
): boolean {
  const plansDir = getSessionPlansDir(workspaceId, sessionId);
  const filePath = join(plansDir, `${fileName}.md`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    return true;
  }
  return false;
}

/**
 * Get the most recent plan file for a session
 */
export function getMostRecentPlanFile(
  workspaceId: string,
  sessionId: string
): { name: string; path: string } | null {
  const files = listPlanFiles(workspaceId, sessionId);
  return files.length > 0 ? files[0]! : null;
}

// ============================================================
// Attachments Directory
// ============================================================

/**
 * Ensure attachments directory exists
 */
export function ensureAttachmentsDir(workspaceId: string, sessionId: string): string {
  const dir = getSessionAttachmentsPath(workspaceId, sessionId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Re-export the composite key type for convenience of ID-first callers.
export type { SessionKey };

// ============================================================
// F1.241 — the pending plan's in-process record
// ============================================================

type PendingPlanRecord = NonNullable<StoredSession['pendingPlanExecution']>;

/**
 * F1.241 — the host process's copy of each session's pending Accept & Compact plan, keyed
 * `<workspaceId>/<sessionId>`; every reader above prefers it to the session header.
 *
 * WHY A SECOND COPY. Until this row the record lived only in the session file's header, and
 * `SessionManager.persistSession` rewrites that header from managed state — which never
 * carried the record (it is in `SESSION_PERSISTENT_FIELDS`, but no `ManagedSession` field
 * holds it, so `pickSessionFields` found nothing). The first persist after
 * `setPendingPlanExecution` — the `/compact` turn's own user message — therefore erased it,
 * and no reader could ever see the plan as ready (measured: `pending-plan-claim.test.ts`, with
 * the real `persistSession`). Upstream (craft-agents-oss v0.13.4) keeps the record on the
 * managed session; doing that here means new `ManagedSession` state threaded through load,
 * branch and runtime switch in a file cited by line hundreds of times, so this map is the
 * smaller honest thing.
 *
 * WHAT IT CANNOT DO: survive a HOST restart — the header copy is read then, and only if no
 * persist erased it first. A renderer reload (CMD+R), the case Accept & Compact's recovery
 * exists for, keeps the host process and so keeps the map. An entry of a session deleted
 * while its plan was pending stays until the process exits; nothing reads it (every host
 * reader resolves the managed session first).
 */
const pendingPlanRecords = new Map<string, PendingPlanRecord>();

function pendingPlanKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}/${sessionId}`;
}

/** The in-process record, else the header copy (the only one there is after a host restart). */
function readPendingPlanRecord(workspaceId: string, sessionId: string): PendingPlanRecord | undefined {
  return pendingPlanRecords.get(pendingPlanKey(workspaceId, sessionId))
    ?? loadSession(workspaceId, sessionId)?.pendingPlanExecution;
}

/** Write the in-process record into the session header — best effort, see the map's docblock. */
async function mirrorPendingPlanRecord(workspaceId: string, sessionId: string): Promise<void> {
  const session = loadSession(workspaceId, sessionId);
  if (!session) return;
  const record = pendingPlanRecords.get(pendingPlanKey(workspaceId, sessionId));
  if (record) session.pendingPlanExecution = { ...record };
  else delete session.pendingPlanExecution;
  await saveSession(session);
}

// ============================================================
// UA5.3 — the project unbind (v0.13.4)
// ============================================================

/**
 * UA5.3 — unbind every session of the workspace that referenced `projectId`, and return how many were touched
 * (craft-agents-oss v0.13.4 `unbindProjectFromSessions`, Apache-2.0): a deleted project's sessions are preserved,
 * just unlinked.
 *
 * Adapted: the candidates come from the header listing ({@link listSessions}, one header line per session, which
 * carries `projectId`) instead of a full `loadSession` of every session, and each write is
 * {@link updateSessionMetadata}'s present-undefined clear. This is the DISK pass only: a session live in the host is
 * unbound there first (`SessionManager.unbindProjectFromSessions`), because its next persist would otherwise write
 * the old binding back.
 */
export async function unbindProjectFromSessions(workspaceId: string, projectId: string): Promise<number> {
  let touched = 0;
  for (const meta of listSessions(workspaceId)) {
    if (meta.projectId !== projectId) continue;
    await updateSessionMetadata(workspaceId, meta.id, { projectId: undefined });
    touched++;
  }
  return touched;
}

/**
 * UA12.44 — the RAW stored sessionStatus per session, before
 * {@link headerToMetadata}'s validateSessionStatus maps an id the status config
 * no longer has to `todo` at read time. The status migrations
 * (statuses/crud.ts deleteStatus / resetToDefaults) must read THIS, not
 * {@link listSessions}: through listSessions a deleted status is never seen, so
 * no header was ever rewritten and the migrated count was always 0. The legacy
 * `todoState` name folds in exactly as headerToMetadata folds it.
 */
export interface RawSessionStatusEntry {
  sessionId: string;
  sessionStatus?: SessionStatus;
}

export function listRawSessionStatuses(workspaceId: string): RawSessionStatusEntry[] {
  const sessionsDir = getWorkspaceSessionRootPath(workspaceId);
  if (!existsSync(sessionsDir)) {
    return [];
  }

  const out: RawSessionStatusEntry[] = [];
  for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jsonlFile = join(sessionsDir, entry.name, 'session.jsonl');
    if (!existsSync(jsonlFile)) continue;
    const header = readSessionHeader(jsonlFile);
    if (!header) continue;
    const rawStatus = header.sessionStatus ?? (header as unknown as { todoState?: string }).todoState;
    out.push({ sessionId: header.id, sessionStatus: rawStatus as SessionStatus | undefined });
  }
  return out;
}
